import { z } from 'zod';

const optionalUrl = z.string().url().optional();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3200),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1),
  // Interpolated into a connection startup string and into CREATE SCHEMA, so it is
  // constrained to a bare SQL identifier rather than accepting arbitrary text.
  DATABASE_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/, 'DATABASE_SCHEMA must be a bare SQL identifier').default('tps'),
  // SCMS owns this schema in the same database. TPS reads it directly (Step 4 shortlist
  // candidates) rather than calling the SCMS BFF, so the name is interpolated into SQL
  // and carries the same bare-identifier constraint as DATABASE_SCHEMA above.
  SCMS_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/, 'SCMS_SCHEMA must be a bare SQL identifier').default('scms'),
  // One or more comma-separated origins. A list rather than a single value because the
  // same deployment is reached by more than one name: http://localhost:5175 from the
  // machine running it, and http://<lan-ip>:5175 from a phone or tablet on the same
  // network. An origin missing from here fails CORS, which in a browser looks like the
  // API being down rather than a configuration problem.
  WEB_ORIGIN: z.string().default('http://localhost:5175').transform((v) =>
    v.split(',').map((o) => o.trim()).filter(Boolean)
  ).refine((origins) => origins.length > 0 && origins.every((o) => URL.canParse(o)),
    { message: 'WEB_ORIGIN must be a comma-separated list of absolute URLs' }),
  OIDC_ISSUER: optionalUrl,
  OIDC_AUDIENCE: z.string().optional(),
  OIDC_JWKS_URI: optionalUrl,
  OIDC_ORGANIZATION_CLAIM: z.string().default('organization_id'),
  AUTH_DISABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  TOKEN_ENCRYPTION_KEY: z.string().min(1),
  ENGINE_INTERNAL_URL: optionalUrl,
  ENGINE_INTERNAL_TOKEN: z.string().optional(),
  // Cloudflare Email Sending. Optional: nothing in the BFF sends email yet, so a
  // deployment without these configured should not fail to boot.
  CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
  CLOUDFLARE_EMAIL_TOKEN: z.string().optional(),
  // Resolves ITT document filenames to shareable links. Optional: without it, ITT
  // documents still list, just with no link.
  DROPBOX_ACCESS_TOKEN: z.string().optional(),
  // BuildFlow's own document-links contract: resolves a take-off package version to
  // long-lived, email-safe document links. Optional: without both set, "Confirm ITT"
  // emails still send, just without document links.
  BUILDFLOW_BASE_URL: optionalUrl,
  BUILDFLOW_DOCUMENT_LINKS_TOKEN: z.string().optional(),
  // Redirects every outbound ITT email to TEST_TO_EMAIL_ACCOUNT instead of the recipient's
  // real SCMS contact address, so "Confirm ITT" can be exercised against real packages
  // without emailing real subcontractors. Off by default.
  TEST_EMAIL_FLAG: z.enum(['Y', 'N']).default('N').transform((v) => v === 'Y'),
  TEST_FROM_EMAIL_ACCOUNT: z.string().email().optional(),
  TEST_TO_EMAIL_ACCOUNT: z.string().email().optional(),

  // Cloudflare Zero Trust Access — gates the subcontractor pricing portal at the edge.
  // Separate token from CLOUDFLARE_EMAIL_TOKEN: this one needs "Access: Apps and
  // Policies — Edit" and nothing else, and the two must never be confused for one
  // another's scope. Optional: without it, no portal link is ever issued (see
  // cloudflareAccess.ts) and the ITT still sends with its workbook attachment, exactly
  // as before this feature existed.
  CLOUDFLARE_API_TOKEN: z.string().optional(),
  // "<team>.cloudflareaccess.com" — derives both the Access login domain and the JWKS
  // issuer the portal verifies every request's Cf-Access-Jwt-Assertion against. The
  // audience ("aud") side of verification is deliberately NOT a config var: it is
  // whichever Access application cloudflareAccess.ts created or found on this account,
  // read from tps.cf_access_config at verify time — the same row that write it. A
  // separately configured CF_ACCESS_AUD could drift from the application actually in use
  // the moment either one changed without the other, and JWT verification would fail
  // for every visitor with no obvious cause.
  CF_ACCESS_TEAM_NAME: z.string().optional(),
  // What the emailed link is built from, e.g. "https://dev.novamerx.ai/tps". Falls back
  // to WEB_ORIGIN's first entry so a local run needs no extra configuration.
  PORTAL_BASE_URL: optionalUrl,
  // 'false' only for local development with no Cloudflare Access in front of anything —
  // the portal then accepts the URL token alone and logs a warning on every open.
  // loadConfig refuses this in production, below.
  PORTAL_ACCESS_REQUIRED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  PORTAL_LINK_TTL_DAYS: z.coerce.number().int().positive().default(90),

  // ── Inbound email (BuildFlow issue #34) ──────────────────────────────────────
  //
  // POST /internal/email/inbound is registered ONLY when BOTH of these are set. Unset,
  // the route does not exist and the feature is in-app only — a subcontractor can still
  // raise a query from their pricing link, and nothing silently accepts unauthenticated
  // mail.
  //
  // TWO secrets, not one, and this is the only endpoint in either repo that needs both.
  // Every other /internal/* route is reached over the shared Docker network; this one is
  // reachable from the public internet, because the Cloudflare Email Worker
  // (`novamerx-comms-worker`, its own repository) runs at the edge. A leaked bearer alone
  // would let anyone forge the Client's answer to a tender query, so the body is signed
  // as well. See TPS_INBOUND_EMAIL_API.md.
  INBOUND_EMAIL_TOKEN: z.string().min(16).optional(),
  INBOUND_EMAIL_SIGNING_SECRET: z.string().min(32).optional(),

  // The bearer BuildFlow's own BFF presents on /internal/notifications, so the same bell
  // can appear in both shells. Unset, those routes do not exist and BuildFlow shows no
  // bell — the same all-or-nothing gating the inbound email route uses.
  //
  // Only a bearer, deliberately: unlike the inbound email route this one is reached over
  // the shared Docker network and is not exposed by nginx, so there is no leaked-token
  // path from the internet for a signature to defend against.
  BUILDFLOW_NOTIFICATIONS_TOKEN: z.string().min(16).optional(),
  // How long a Client's reply link stays live. Shorter than a portal link by default: a
  // tender query is answered in days, and the link is a bearer capability in an inbox.
  CLIENT_LINK_TTL_DAYS: z.coerce.number().int().positive().default(30),
  // Optional here on purpose: migrate.ts calls loadConfig() and migrate-tps has no Redis.
  // The worker requires it through loadWorkerConfig below.
  REDIS_URL: z.string().min(1).optional(),
  LOG_LEVEL: z.string().default('info')
});

export type Config = z.infer<typeof schema>;

/**
 * The worker's own config.
 *
 * Not a subset of loadConfig() — that one requires TOKEN_ENCRYPTION_KEY and throws
 * unless OIDC is configured or AUTH_DISABLED is set, which is itself illegal in
 * production. A headless queue consumer serves no requests and authenticates nobody, so
 * none of that applies to it. What it does need, REDIS_URL, is required here and
 * optional there.
 */
const workerSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/, 'DATABASE_SCHEMA must be a bare SQL identifier').default('tps'),
  SCMS_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/, 'SCMS_SCHEMA must be a bare SQL identifier').default('scms'),
  REDIS_URL: z.string().min(1),
  LOG_LEVEL: z.string().default('info')
});

export type WorkerConfig = z.infer<typeof workerSchema>;

export function loadWorkerConfig(input: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return workerSchema.parse(input);
}

export function loadConfig(input: NodeJS.ProcessEnv = process.env): Config {
  const config = schema.parse(input);
  if (!config.AUTH_DISABLED && (!config.OIDC_ISSUER || !config.OIDC_AUDIENCE || !config.OIDC_JWKS_URI)) {
    throw new Error('OIDC_ISSUER, OIDC_AUDIENCE, and OIDC_JWKS_URI are required when authentication is enabled');
  }
  if (config.TEST_EMAIL_FLAG && (!config.TEST_FROM_EMAIL_ACCOUNT || !config.TEST_TO_EMAIL_ACCOUNT)) {
    throw new Error('TEST_FROM_EMAIL_ACCOUNT and TEST_TO_EMAIL_ACCOUNT are required when TEST_EMAIL_FLAG=Y');
  }
  if (config.NODE_ENV === 'production' && config.AUTH_DISABLED) {
    throw new Error('AUTH_DISABLED must not be enabled in production');
  }
  if (config.NODE_ENV === 'production' && !config.PORTAL_ACCESS_REQUIRED) {
    throw new Error('PORTAL_ACCESS_REQUIRED must not be disabled in production');
  }
  // Half-configured is the dangerous state, not unconfigured. With a token and no signing
  // secret the route would still exist, and would accept anything presenting the bearer —
  // from anywhere on the internet. Refused at boot rather than discovered later.
  if (Boolean(config.INBOUND_EMAIL_TOKEN) !== Boolean(config.INBOUND_EMAIL_SIGNING_SECRET)) {
    throw new Error(
      'INBOUND_EMAIL_TOKEN and INBOUND_EMAIL_SIGNING_SECRET must be set together. '
      + 'The inbound email route is reachable from the public internet and requires both.'
    );
  }
  return config;
}
