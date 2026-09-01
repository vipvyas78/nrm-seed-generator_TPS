import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import type { Database, Row } from './db.js';
import { AppError } from './errors.js';

export interface AccessIdentity {
  email: string;
}

/**
 * Verifies the caller's Cloudflare Access identity for the subcontractor pricing portal.
 *
 * A second, independent mechanism from `auth.ts`'s OIDC authenticator — this proves who a
 * PUBLIC visitor is, not a BuildFlow user. `Cf-Access-Jwt-Assertion` (set by the edge on
 * every request that passed Access) is preferred; the `CF_Authorization` cookie is the
 * fallback for a same-origin fetch that did not carry the header for some reason. Keys
 * rotate every ~6 weeks with a 7-day overlap, which `createRemoteJWKSet` — the same
 * primitive `auth.ts:21` already uses — handles by caching and refetching on an unknown
 * `kid`.
 *
 * The audience is read from `tps.cf_access_config` on every call, NOT a config var — it
 * is whichever Access application `cloudflareAccess.ts` created or found on this account,
 * and reading it from the same row that write avoids the two ever silently drifting apart
 * (see config.ts's comment on why `CF_ACCESS_AUD` was deliberately not added). One extra
 * single-row lookup per portal request is a cost worth paying for that guarantee — this
 * page's request volume is a handful of subcontractors filling in a form, not a hot path.
 *
 * Three failure shapes are kept distinct on purpose, unlike auth.ts's single
 * INVALID_TOKEN: "no token presented" and "server not configured" both mean the
 * DEPLOYMENT is wrong, while a bad signature means the CALLER is. Collapsing them would
 * make a misconfigured tunnel indistinguishable from an attacker.
 */
export function buildAccessVerifier(config: Config, db: Database) {
  const team = config.CF_ACCESS_TEAM_NAME;
  const issuer = team ? `https://${team}.cloudflareaccess.com` : undefined;
  const jwks = issuer ? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)) : undefined;

  return async function verifyAccessIdentity(request: FastifyRequest): Promise<AccessIdentity | null> {
    const header = request.headers['cf-access-jwt-assertion'];
    const token = typeof header === 'string' && header ? header : readCfAuthorizationCookie(request.headers.cookie);

    if (!token) {
      if (config.PORTAL_ACCESS_REQUIRED) {
        throw new AppError(401, 'Open this link from the email address it was sent to.', 'ACCESS_REQUIRED');
      }
      request.log.warn('portal opened without a Cloudflare Access identity (PORTAL_ACCESS_REQUIRED=false)');
      return null;
    }
    if (!jwks) {
      throw new AppError(503, 'Online pricing is not available: Access verification is not configured on this server.', 'ACCESS_MISCONFIGURED');
    }
    const [row] = await db.query<Row>(`SELECT cf_aud FROM tps.cf_access_config WHERE id = TRUE`);
    const aud = row?.cf_aud ? String(row.cf_aud) : undefined;
    if (!aud) {
      throw new AppError(503, 'Online pricing is not available: no Cloudflare Access application has been set up for this account yet.', 'ACCESS_MISCONFIGURED');
    }
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, jwks, { issuer, audience: aud }));
    } catch {
      throw new AppError(401, 'Your sign-in could not be verified. Request a new code and try again.', 'ACCESS_INVALID_TOKEN');
    }
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    if (!email) throw new AppError(401, 'Your sign-in carries no email address.', 'ACCESS_NO_EMAIL');
    return { email };
  };
}

export type AccessVerifier = ReturnType<typeof buildAccessVerifier>;

function readCfAuthorizationCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'CF_Authorization') return decodeURIComponent(rest.join('='));
  }
  return undefined;
}
