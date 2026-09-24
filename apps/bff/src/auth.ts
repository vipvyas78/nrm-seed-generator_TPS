import type { FastifyReply, FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Config } from './config.js';
import type { Database } from './db.js';
import { AppError } from './errors.js';
import type { CommsDatabase } from './commsDb.js';
import { COMMS_TENDER_PARAMS, TENDER_FROM_PARAM, accessFor } from './routeAccess.js';
import type { Actor } from './types.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
    mustChangePassword?: boolean;
    /** The tender this request is about, resolved once by the scope gate (issue #37). */
    tenderId?: string;
  }
}

function stringClaim(payload: JWTPayload, claim: string): string | undefined {
  const value = payload[claim];
  if (typeof value === 'string' && value.trim()) return value;
  return undefined;
}

/**
 * A local session token, or an OIDC bearer? Told apart by SHAPE, not by configuration —
 * the same rule and the same token format BuildFlow's `auth.ts` uses, because they are
 * the same sessions: `public.bf_user_sessions` is one table read by both applications.
 */
function looksLikeLocalSessionToken(token: string): boolean {
  const parts = token.split('.');
  return parts.length === 2 && /^[0-9a-f]{32}$/.test(parts[0]);
}

export function buildAuthenticator(config: Config, db: Database) {
  const jwks = config.OIDC_JWKS_URI ? createRemoteJWKSet(new URL(config.OIDC_JWKS_URI)) : undefined;

  return async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;

    // ── local accounts (issue #37). BuildFlow mints these sessions; TPS only verifies
    // them. There is deliberately no login route here: two applications minting sessions
    // against one table would be two password policies, two lockout counters and two
    // places to get the hashing wrong.
    if (header?.startsWith('Bearer ')) {
      const token = header.slice('Bearer '.length);
      if (looksLikeLocalSessionToken(token)) {
        const resolved = await db.actorForSession(token);
        const { mustChangePassword, ...actor } = resolved;
        request.actor = actor;
        request.mustChangePassword = mustChangePassword;
        return;
      }
    }

    if (config.AUTH_DISABLED) {
      const subject = request.headers['x-buildflow-dev-subject'];
      const organization = request.headers['x-buildflow-dev-organization'];
      if (typeof subject !== 'string' || typeof organization !== 'string') {
        throw new AppError(401, 'Development authentication requires x-buildflow-dev-subject and x-buildflow-dev-organization', 'UNAUTHENTICATED');
      }
      request.actor = await db.provisionActor({ issuer: 'buildflow-dev', subject, organizationExternalId: organization, email: request.headers['x-buildflow-dev-email'] as string | undefined });
      return;
    }
    if (!header?.startsWith('Bearer ')) throw new AppError(401, 'Bearer token is required', 'UNAUTHENTICATED');
    const token = header.slice('Bearer '.length);
    try {
      const { payload } = await jwtVerify(token, jwks!, { issuer: config.OIDC_ISSUER, audience: config.OIDC_AUDIENCE });
      const subject = payload.sub;
      const organization = stringClaim(payload, config.OIDC_ORGANIZATION_CLAIM);
      if (!subject || !organization) throw new AppError(401, 'Token is missing its subject or organization claim', 'INVALID_TOKEN');
      request.actor = await db.provisionActor({
        issuer: config.OIDC_ISSUER!, subject, organizationExternalId: organization,
        organizationName: stringClaim(payload, 'organization_name'),
        email: stringClaim(payload, 'email'), displayName: stringClaim(payload, 'name')
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(401, 'Token verification failed', 'INVALID_TOKEN');
    }
  };
}

/**
 * Issue #37, both axes, in one hook.
 *
 * SCOPE first, then APPROVAL, because they refuse for different reasons and the scope
 * refusal is the more informative one: being told your level is too low for a tender you
 * were never assigned to would send you to the wrong person.
 *
 * The scope half is new to TPS. Every query in `tenderPrepDb` is scoped by organisation
 * alone, so until now an L2 could open, price and issue a tender nobody assigned them
 * to. Resolving the tender here rather than inside each query is what makes it cover
 * routes nobody has written yet — and the resolved id is left on the request, so the
 * audit row gets it for free.
 */
export function buildAccessGate(db: Database, commsDb: CommsDatabase) {
  return async function enforceAccess(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const actor = requireActor(request);
    const url = request.routeOptions?.url;

    if (request.mustChangePassword) {
      // BuildFlow owns the password change, so there is nothing here for such a session
      // to do but read its own identity. Anything else waits until the password is set.
      if (url !== '/api/auth/me') {
        throw new AppError(403, 'Your password must be changed before you can continue', 'PASSWORD_CHANGE_REQUIRED');
      }
      return;
    }

    const tenderId = await resolveTenderId(db, commsDb, request);
    if (tenderId) {
      request.tenderId = tenderId;
      const role = await db.effectiveTenderRole(tenderId, actor.userId);
      if (!role) {
        // "Not found", not "forbidden": a tender somebody was never assigned to should
        // not be confirmed to exist by the error it returns. The same answer BuildFlow's
        // getTender gives.
        throw new AppError(404, 'Tender not found', 'NOT_FOUND');
      }
    }

    if (accessFor(request.method, url) === 'approval' && !actor.canApprove) {
      throw new AppError(
        403,
        `Your authorisation level (${actor.authorisationLevel}) does not permit this action. Approvals require L3 or above.`,
        'APPROVAL_LEVEL_REQUIRED'
      );
    }
  };
}

/**
 * The tender a request is about, from whichever of its parameters names one.
 *
 * At most one lookup: the parameters are tried in the order `TENDER_FROM_PARAM` declares
 * and the first that is present wins, because a route carrying two of them (there are
 * none today) would be carrying the same tender twice.
 */
async function resolveTenderId(
  db: Database, commsDb: CommsDatabase, request: FastifyRequest
): Promise<string | undefined> {
  const params = request.params as Record<string, unknown> | undefined;
  if (!params) return undefined;
  // A malformed id would make a query throw on the uuid cast, turning a 404 into a 500.
  // The handler's own zod validation reports it properly, so the gate steps aside.
  const usable = (value: unknown): value is string =>
    typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);

  for (const [name, sql] of Object.entries(TENDER_FROM_PARAM)) {
    if (!(name in params)) continue;
    if (!usable(params[name])) return undefined;
    const rows = await db.query<{ tender_id: string | null }>(sql, [params[name]]);
    return rows[0]?.tender_id ?? undefined;
  }
  // The two the comms boundary keeps in commsDb.ts — `comms.*` may be named in SQL by
  // that file and no other (commsBoundary.test.ts).
  for (const name of COMMS_TENDER_PARAMS) {
    if (!(name in params)) continue;
    if (!usable(params[name])) return undefined;
    const tenderId = name === 'messageId'
      ? await commsDb.tenderIdForMessage(params[name] as string)
      : await commsDb.tenderIdForThread(params[name] as string);
    return tenderId ?? undefined;
  }
  return undefined;
}

export function requireActor(request: FastifyRequest): Actor {
  if (!request.actor) throw new AppError(401, 'Authentication is required', 'UNAUTHENTICATED');
  return request.actor;
}
