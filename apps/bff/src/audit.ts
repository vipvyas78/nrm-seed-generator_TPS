import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from './db.js';
import { AUDITED_READS, accessFor, routeKey } from './routeAccess.js';

/**
 * Issue #37's audit trail, TPS half.
 *
 * Writes to `public.bf_audit_events` — the SAME table BuildFlow writes, not a `tps` one.
 * A tender's history should read as one sequence whichever application the act happened
 * in: the classification was approved in BuildFlow, the ITT went out from TPS, the
 * addendum was issued from TPS and the take-off was re-run in BuildFlow. Two tables
 * would mean interleaving them by hand for ever, and an estimator who works in both
 * would appear as two people.
 *
 * Same four rules as BuildFlow's `audit.ts`: every mutation, every authentication event,
 * every denial including the 404 a scope refusal returns, and the named sensitive reads.
 * Request bodies are never recorded — a route opts into a small structured `detail`.
 */

declare module 'fastify' {
  interface FastifyRequest {
    auditDetail?: Record<string, unknown>;
    auditAction?: string;
  }
}

export function recordAuditDetail(request: FastifyRequest, detail: Record<string, unknown>): void {
  request.auditDetail = { ...(request.auditDetail ?? {}), ...detail };
}

function clientIp(request: FastifyRequest): string | null {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  return request.ip ?? null;
}

function outcomeFor(statusCode: number): 'allowed' | 'denied' | 'failed' {
  if (statusCode === 401 || statusCode === 403 || statusCode === 429) return 'denied';
  if (statusCode >= 400) return 'failed';
  return 'allowed';
}

export function shouldAudit(method: string, url: string | undefined, statusCode: number): boolean {
  if (statusCode === 401 || statusCode === 403 || statusCode === 429) return true;
  if (method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD') return true;
  return url ? AUDITED_READS.has(routeKey(method, url)) : false;
}

export function registerAudit(app: FastifyInstance, db: Database): void {
  app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    const url = request.routeOptions?.url;
    const method = request.method;
    if (!shouldAudit(method, url, reply.statusCode)) return;

    const actor = request.actor;
    // The portal and the client-reply routes are a subcontractor or an employer on a
    // capability link, not a member of the firm. They are recorded — those are real
    // activities on a real tender — but as `anonymous`, so they never sit in the same
    // bucket as a failed staff login.
    const actorKind = actor
      ? 'user'
      : (url?.startsWith('/internal/') || url?.startsWith('/scheduled/') ? 'system' : 'anonymous');

    try {
      await db.recordAuditEvent({
        actorUserId: actor?.userId ?? null,
        actorEmail: actor?.email ?? null,
        organizationId: actor?.organizationId ?? null,
        // Resolved once by the access gate, so this costs nothing here — and it is what
        // makes a TPS row appear on the right tender's history in BuildFlow's viewer.
        tenderId: request.tenderId ?? null,
        actorKind,
        authorisationLevel: actor?.authorisationLevel ?? null,
        action: request.auditAction ?? routeKey(method, url ?? request.url),
        routeTemplate: url ?? null,
        method,
        statusCode: reply.statusCode,
        outcome: outcomeFor(reply.statusCode),
        requestId: String(request.id),
        ip: clientIp(request),
        userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
        detail: { ...(request.auditDetail ?? {}), access: accessFor(method, url), app: 'tps' }
      });
    } catch (error) {
      // Never fail the request this row describes. An ITT that sent and then reported a
      // 500 would be sent again.
      app.log.error({ err: error, route: url, method }, 'Audit event could not be recorded');
    }
  });
}
