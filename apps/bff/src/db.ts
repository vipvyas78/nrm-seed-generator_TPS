import { createHash } from 'node:crypto';
import pg from 'pg';
import type { Config } from './config.js';
import { AppError, notFound } from './errors.js';
import type { Actor, AuthorisationLevel } from './types.js';

type DbClient = pg.Pool | pg.PoolClient;
export type Row = Record<string, unknown>;

export class Database {
  readonly pool: pg.Pool;

  constructor(config: Pick<Config, 'DATABASE_URL' | 'DATABASE_SCHEMA'>) {
    // TPS owns the `tps` schema inside the parent platform's shared database. The
    // search_path is set on the startup packet (not in DATABASE_URL) so a mis-set env
    // var cannot silently relocate our tables. `public` stays on the path because the
    // extensions and the parent's bf_* identity tables live there; anything in public
    // that we depend on is qualified explicitly regardless.
    this.pool = new pg.Pool({
      connectionString: config.DATABASE_URL,
      options: `-c search_path=${config.DATABASE_SCHEMA},public`
    });
  }

  async close(): Promise<void> { await this.pool.end(); }

  async query<T extends Row = Row>(sql: string, values: unknown[] = [], client: DbClient = this.pool): Promise<T[]> {
    return (await client.query<T>(sql, values)).rows;
  }

  async one<T extends Row = Row>(sql: string, values: unknown[] = [], client: DbClient = this.pool): Promise<T> {
    const rows = await this.query<T>(sql, values, client);
    if (rows.length !== 1) throw notFound();
    return rows[0];
  }

  async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async provisionActor(input: {
    issuer: string; subject: string; organizationExternalId: string;
    organizationName?: string; email?: string; displayName?: string;
  }): Promise<Actor> {
    // The identity tables belong to the parent platform, so they are hard-qualified to
    // `public` rather than left to resolve through search_path.
    return this.transaction(async (client) => {
      const organization = await this.one<{ id: string }>(
        `INSERT INTO public.bf_organizations (oidc_issuer, external_id, name)
         VALUES ($1, $2, $3) ON CONFLICT (oidc_issuer, external_id) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [input.issuer, input.organizationExternalId, input.organizationName ?? input.organizationExternalId], client
      );
      const user = await this.one<{ id: string }>(
        `INSERT INTO public.bf_users (oidc_issuer, oidc_subject, email, display_name)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (oidc_issuer, oidc_subject) DO UPDATE
           SET email = COALESCE(EXCLUDED.email, bf_users.email),
               display_name = COALESCE(EXCLUDED.display_name, bf_users.display_name)
         RETURNING id`,
        [input.issuer, input.subject, input.email ?? null, input.displayName ?? null], client
      );
      await client.query(
        `INSERT INTO public.bf_organization_memberships (organization_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [organization.id, user.id]
      );
      // Issue #37. Read back rather than assumed: the INSERT above does nothing for an
      // existing membership, so the column DEFAULT only describes a brand-new one.
      const level = await this.one<{ code: string; can_approve: boolean; sees_all_tenders: boolean }>(
        `SELECT l.code, l.can_approve, l.sees_all_tenders
         FROM public.bf_organization_memberships m
         JOIN public.bf_authorisation_levels l ON l.code = m.authorisation_level
         WHERE m.organization_id = $1 AND m.user_id = $2`,
        [organization.id, user.id], client
      );
      return {
        userId: user.id, organizationId: organization.id, subject: input.subject,
        email: input.email, displayName: input.displayName,
        authorisationLevel: level.code as AuthorisationLevel,
        canApprove: level.can_approve, seesAllTenders: level.sees_all_tenders
      };
    });
  }

  // ───────────────────────────────────────────── issue #37: the shared session
  //
  // TPS VERIFIES sessions; it never mints one. There is no login route here on purpose —
  // two applications creating sessions against one table would mean two password
  // policies, two lockout counters and two chances to get the hashing wrong. BuildFlow
  // owns `POST /api/auth/login` and this reads the row it wrote.

  /**
   * Resolve a bearer token to an actor, and slide the idle window.
   *
   * Identical semantics to BuildFlow's `actorForSession`, against the identical row. The
   * level is re-read here rather than carried in the token so that a level the Board
   * revokes bites on the revoked user's next call in BOTH applications, not whenever
   * each one's session happens to lapse.
   */
  async actorForSession(token: string): Promise<Actor & { mustChangePassword: boolean }> {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const rows = await this.query<Row>(
      `SELECT s.id, s.user_id, s.organization_id, u.email, u.display_name, u.oidc_subject,
              c.must_change_password, c.disabled_at,
              l.code AS level, l.can_approve, l.sees_all_tenders
       FROM public.bf_user_sessions s
       JOIN public.bf_users u ON u.id = s.user_id
       JOIN public.bf_user_credentials c ON c.user_id = s.user_id
       JOIN public.bf_organization_memberships m
         ON m.user_id = s.user_id AND m.organization_id = s.organization_id
       JOIN public.bf_authorisation_levels l ON l.code = m.authorisation_level
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL
         AND s.expires_at > NOW() AND s.idle_expires_at > NOW()`,
      [tokenHash]
    );
    const row = rows[0];
    if (!row) throw new AppError(401, 'Your session has expired. Sign in again.', 'SESSION_EXPIRED');
    if (row.disabled_at) throw new AppError(403, 'This account has been deactivated', 'ACCOUNT_DISABLED');
    // The idle window is slid from here too: somebody who spends an afternoon in TPS is
    // working, and a session that expires because they were not in BuildFlow would be
    // measuring the wrong thing.
    await this.query(
      `UPDATE public.bf_user_sessions SET last_seen_at = NOW(), idle_expires_at = NOW() + INTERVAL '2 hours' WHERE id = $1`,
      [row.id]
    );
    return {
      userId: String(row.user_id), organizationId: String(row.organization_id),
      subject: String(row.oidc_subject), email: row.email ? String(row.email) : undefined,
      displayName: row.display_name ? String(row.display_name) : undefined,
      authorisationLevel: String(row.level) as AuthorisationLevel,
      canApprove: Boolean(row.can_approve), seesAllTenders: Boolean(row.sees_all_tenders),
      sessionId: String(row.id), mustChangePassword: Boolean(row.must_change_password)
    };
  }

  /**
   * May this person see this tender, and as what?
   *
   * One call into the function BuildFlow's eleven read joins use. It is SQL in `public`
   * precisely so this repository can ask the same question and get the same answer —
   * a second implementation here would be a second opinion about who is allowed where.
   */
  async effectiveTenderRole(tenderId: string, userId: string): Promise<string | null> {
    const rows = await this.query<{ role: string | null }>(
      `SELECT public.bf_effective_tender_role($1, $2) AS role`, [tenderId, userId]
    );
    return rows[0]?.role ?? null;
  }

  /**
   * Append one activity row to the shared trail.
   *
   * `public.bf_audit_events`, the same table BuildFlow writes — one tender's history
   * should read as one sequence whichever application the act happened in, and an
   * estimator moving between the two does not become two people.
   */
  async recordAuditEvent(input: {
    actorUserId: string | null; actorEmail: string | null; organizationId: string | null;
    tenderId: string | null; actorKind: string; authorisationLevel: string | null;
    action: string; routeTemplate: string | null; method: string; statusCode: number;
    outcome: string; requestId: string | null; ip: string | null; userAgent: string | null;
    detail: Record<string, unknown>;
  }): Promise<void> {
    await this.query(
      `INSERT INTO public.bf_audit_events
         (actor_user_id, actor_email, organization_id, tender_id, actor_kind, authorisation_level,
          action, route_template, method, status_code, outcome, request_id, ip, user_agent, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [input.actorUserId, input.actorEmail, input.organizationId, input.tenderId, input.actorKind,
        input.authorisationLevel, input.action, input.routeTemplate, input.method, input.statusCode,
        input.outcome, input.requestId, input.ip, input.userAgent, JSON.stringify(input.detail)]
    );
  }
}
