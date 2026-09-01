import Cloudflare from 'cloudflare';
import type { Database, Row } from './db.js';

/**
 * Free/public consumer email providers. Never eligible for a domain-wide Access include
 * rule — a firm's own business domain narrows the policy to that firm; gmail.com narrows
 * it to nobody. A recipient on one of these still gets a portal link (see
 * `cloudflareAccess.ts`'s caller in `tenderPrepDb.ts`), gated by an EXACT email rule
 * instead of a domain rule, which is strictly narrower and therefore safe.
 *
 * Deliberately a denylist of known free providers, not an allowlist of "real" clients —
 * an allowlist would refuse a legitimate small subcontractor on the first domain it had
 * never seen before.
 */
export const PUBLIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com',
  'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com', 'live.co.uk', 'msn.com',
  'yahoo.com', 'yahoo.co.uk', 'ymail.com',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'aol.co.uk',
  'gmx.com', 'gmx.co.uk',
  'protonmail.com', 'proton.me',
  'mail.com', 'zoho.com', 'yandex.com', 'qq.com', '163.com',
  // UK consumer ISPs — small subcontractors routinely use these as their only address.
  'btinternet.com', 'sky.com', 'virginmedia.com', 'talktalk.net', 'tiscali.co.uk'
]);

export function domainOf(email: string): string {
  return email.trim().toLowerCase().split('@')[1] ?? '';
}

export function isPublicEmailDomain(domain: string): boolean {
  return PUBLIC_EMAIL_DOMAINS.has(domain.toLowerCase());
}

const ACCESS_APP_NAME = 'TPS Subcontractor Pricing Portal';

export interface PortalRecipient {
  email: string;
  domain: string;
}

/**
 * Owns the ONE Cloudflare Zero Trust Access application and ONE reusable policy that
 * gates the subcontractor pricing portal, across every tender. See migration 019's header
 * comment for why this is one application rather than one per tender.
 *
 * Every method reads/writes `tps.cf_access_config`, a singleton row, so the application
 * and policy are created at most once and every later send updates the same objects.
 *
 * FAILS CLOSED, deliberately unlike every other outbound integration in this file
 * (`BuildflowDocumentBundlesClient` etc., which degrade to "no bundle" on any error). A
 * missing document link makes an email less useful and the recipient can see that
 * something is missing; a missing Access policy converts a gated portal into an open one
 * with nobody positioned to notice. See `syncFor`'s doc comment.
 */
export class CloudflareAccessAdmin {
  private readonly client: Cloudflare;

  constructor(
    private readonly db: Database,
    private readonly accountId: string,
    apiToken: string,
    /** Host only (no scheme/path) — the `domain` field on the Access application is
     * display-only in the dashboard; `destinations` below is what actually governs
     * matching, but Cloudflare still requires `domain` to be a real, stable value. */
    private readonly portalHost: string
  ) {
    // Passed explicitly rather than left to the SDK's own `process.env.CLOUDFLARE_API_TOKEN`
    // fallback — the same reasoning `emailService.ts` follows for its own client — so a
    // stray ambient variable can never make this class silently "configured" when the
    // caller believes it is not.
    this.client = new Cloudflare({ apiToken });
  }

  /**
   * Reconciles the Access application + policy against the CURRENT live set of portal
   * recipients across every unexpired link, then persists the result.
   *
   * Called once per ITT send, BEFORE any email leaves — never after, and never
   * best-effort. If this throws, the caller must refuse the whole send: an emailed link
   * nobody has gated yet is a worse outcome than a send that failed and can be retried.
   *
   * Recomputed rather than appended: the include list is idempotent from the database's
   * own state, converges after any partial failure, and gives revocation for free — an
   * expired link's domain simply stops appearing next sync. The cost, stated once here
   * rather than left implicit: a send for tender B rewrites the policy that also governs
   * tender A. That is acceptable only because Access is the coarse gate ("a human at an
   * invited company") and the per-link token + email binding (see `accessJwt.ts` and its
   * caller) is the fine one that actually separates one firm's bill from another's.
   */
  async syncFor(recipients: PortalRecipient[]): Promise<void> {
    const businessDomains = [...new Set(
      recipients.filter((r) => !isPublicEmailDomain(r.domain)).map((r) => r.domain)
    )].sort();
    const exactEmails = [...new Set(
      recipients.filter((r) => isPublicEmailDomain(r.domain)).map((r) => r.email.toLowerCase())
    )].sort();

    try {
      const otpIdpId = await this.resolveOtpIdp();
      const { appId, aud } = await this.ensureApplication(otpIdpId);
      const policyId = await this.syncPolicy(appId, otpIdpId, businessDomains, exactEmails);
      await this.persist({ appId, aud, policyId, otpIdpId, businessDomains, exactEmails, error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Cloudflare Access error';
      await this.persist({ appId: null, aud: null, policyId: null, otpIdpId: null, businessDomains, exactEmails, error: message });
      throw new Error(`Cloudflare Access could not be reconciled, so no portal links were issued: ${message}`);
    }
  }

  /** The account's One-Time PIN identity provider id, required and never created here —
   * OTP is a documented dashboard prerequisite, not something this code should silently
   * provision, so an account that never enabled it fails loudly instead of an unnoticed
   * new IdP appearing in Zero Trust. */
  private async resolveOtpIdp(): Promise<string> {
    const cached = await this.currentConfig();
    if (cached?.cf_otp_idp_id) return String(cached.cf_otp_idp_id);
    for await (const idp of this.client.zeroTrust.identityProviders.list({ account_id: this.accountId })) {
      if (idp.type === 'onetimepin' && idp.id) return idp.id;
    }
    throw new Error('No One-Time PIN identity provider is enabled on this Cloudflare account. Enable it in Zero Trust → Settings → Authentication first.');
  }

  private async ensureApplication(otpIdpId: string): Promise<{ appId: string; aud: string }> {
    const cached = await this.currentConfig();
    if (cached?.cf_application_id && cached?.cf_aud) {
      return { appId: String(cached.cf_application_id), aud: String(cached.cf_aud) };
    }
    // Look for one already created out-of-band (a prior deploy, a dashboard edit) before
    // creating a second — `exact: true` on `name` is the only reliable de-dupe key the
    // list endpoint offers.
    for await (const existing of this.client.zeroTrust.access.applications.list({
      account_id: this.accountId, name: ACCESS_APP_NAME, exact: true
    })) {
      if ('aud' in existing && existing.aud) return { appId: String(existing.id), aud: existing.aud };
    }
    const created = await this.client.zeroTrust.access.applications.create({
      account_id: this.accountId,
      name: ACCESS_APP_NAME,
      type: 'self_hosted',
      // Required even though `destinations` is what actually governs matching — but must
      // be byte-identical to one of `destinations`' entries, wildcard included, or Cloudflare
      // rejects the request outright ("domain not included in destinations", API code 12130).
      domain: this.destinations()[0].uri,
      destinations: this.destinations(),
      allowed_idps: [otpIdpId],
      auto_redirect_to_identity: true,
      // Host-scoped, not path-scoped: the same cookie must ride along on /tps-api/portal/*
      // fetches from a page served at /tps/respond/*, or an authenticated tenderer's API
      // calls would carry no identity at all.
      path_cookie_attribute: false,
      session_duration: '24h'
    });
    if (!('aud' in created) || !created.aud || !created.id) {
      throw new Error('Cloudflare did not return an aud/id for the created Access application');
    }
    return { appId: String(created.id), aud: created.aud };
  }

  private async syncPolicy(
    appId: string, otpIdpId: string, businessDomains: string[], exactEmails: string[]
  ): Promise<string> {
    const include = [
      ...businessDomains.map((domain) => ({ email_domain: { domain } })),
      ...exactEmails.map((email) => ({ email: { email } }))
    ];
    // An Access policy with no include rules matches nobody — safe, but Cloudflare
    // rejects an empty `include` array outright, so a tender with zero recipients (should
    // not happen — the send loop only calls this when there is at least one) is guarded
    // explicitly rather than surfacing as an opaque 400 from the API.
    if (include.length === 0) throw new Error('No recipient domains or addresses to gate — nothing to sync');

    const cached = await this.currentConfig();
    const body = {
      account_id: this.accountId,
      decision: 'allow' as const,
      name: 'TPS pricing portal — invited tender recipients',
      include
    };
    if (cached?.cf_policy_id) {
      const updated = await this.client.zeroTrust.access.policies.update(String(cached.cf_policy_id), body);
      if (!updated.id) throw new Error('Cloudflare did not return an id for the updated Access policy');
      return updated.id;
    }
    const created = await this.client.zeroTrust.access.policies.create(body);
    if (!created.id) throw new Error('Cloudflare did not return an id for the created Access policy');
    // First creation only: attach the new reusable policy to the application. A
    // subsequent `policies.update` above changes the policy's own `include` in place, so
    // the application's `policies` link never needs touching again.
    await this.client.zeroTrust.access.applications.update(appId, {
      account_id: this.accountId,
      // Must match ensureApplication's create call — see its comment on why this has to be
      // one of `destinations`' entries verbatim, wildcard included.
      domain: this.destinations()[0].uri,
      type: 'self_hosted',
      policies: [{ id: created.id, precedence: 1 }]
    });
    return created.id;
  }

  /** Both paths the one Access application must cover — the SPA entry and every portal
   * API call. `/tps/assets/*` is deliberately left uncovered: it is the hashed, public
   * JS/CSS bundle the whole app already serves, and gating it would break the
   * authenticated app too. nginx forwards `/tps-api/` to bff-tps with the prefix
   * stripped, so a request that reaches the BOQ data never touches `/tps/respond/*` at
   * all — both destinations are required together, on one application, so one Access
   * cookie covers both. */
  private destinations() {
    return [`${this.portalHost}/tps/respond/*`, `${this.portalHost}/tps-api/portal/*`]
      .map((uri) => ({ type: 'public' as const, uri }));
  }

  private async currentConfig(): Promise<Row | undefined> {
    const rows = await this.db.query<Row>(`SELECT * FROM tps.cf_access_config WHERE id = TRUE`);
    return rows[0];
  }

  private async persist(input: {
    appId: string | null; aud: string | null; policyId: string | null; otpIdpId: string | null;
    businessDomains: string[]; exactEmails: string[]; error: string | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO tps.cf_access_config (id, cf_application_id, cf_aud, cf_policy_id, cf_otp_idp_id, synced_domains, synced_emails, synced_at, last_error, updated_at)
       VALUES (TRUE, $1, $2, $3, $4, $5, $6, CASE WHEN $7::text IS NULL THEN NOW() ELSE NULL END, $7, NOW())
       ON CONFLICT (id) DO UPDATE SET
         cf_application_id = COALESCE(EXCLUDED.cf_application_id, tps.cf_access_config.cf_application_id),
         cf_aud            = COALESCE(EXCLUDED.cf_aud, tps.cf_access_config.cf_aud),
         cf_policy_id      = COALESCE(EXCLUDED.cf_policy_id, tps.cf_access_config.cf_policy_id),
         cf_otp_idp_id     = COALESCE(EXCLUDED.cf_otp_idp_id, tps.cf_access_config.cf_otp_idp_id),
         synced_domains    = EXCLUDED.synced_domains,
         synced_emails     = EXCLUDED.synced_emails,
         synced_at         = COALESCE(EXCLUDED.synced_at, tps.cf_access_config.synced_at),
         last_error        = EXCLUDED.last_error,
         updated_at        = NOW()`,
      [input.appId, input.aud, input.policyId, input.otpIdpId, input.businessDomains, input.exactEmails, input.error]
    );
  }
}
