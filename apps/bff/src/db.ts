import pg from 'pg';
import type { Config } from './config.js';
import { notFound } from './errors.js';
import type { Actor } from './types.js';

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
      return { userId: user.id, organizationId: organization.id, subject: input.subject, email: input.email, displayName: input.displayName };
    });
  }
}
