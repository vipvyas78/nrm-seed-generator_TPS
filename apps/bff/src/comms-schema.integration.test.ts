/**
 * The `comms` schema is the shape this code is compiled against — real PostgreSQL.
 *
 *   pnpm --filter @tps/bff exec vitest run src/comms-schema.integration.test.ts
 *
 * WHY THIS TEST EXISTS, AND WHY IT IS NOT PARANOIA.
 *
 * The DDL lives in the `novamerx-comms-worker` repository, which holds no code that reads
 * or writes these tables. A column renamed there breaks nothing there: no test, no type
 * and no query in that repository can notice. It breaks HERE, at runtime, in front of a
 * subcontractor.
 *
 * So this asserts the shape rather than trusting it. An ADDITIVE change over there — a new
 * column, a new index — leaves this green, which is the point: the rule that repository
 * states is additive-only, and this test is what makes the rule enforceable rather than
 * aspirational. A rename or a drop turns it red the next time it runs against a migrated
 * database.
 *
 * Self-skips without DATABASE_URL, the same convention as every other integration test
 * here, so CI (which has no database) stays green.
 */

import { describe, expect, it } from 'vitest';
import { assertCommsSchema, REQUIRED_COMMS_MIGRATION } from './commsDb.js';
import { loadWorkerConfig } from './config.js';
import { Database } from './db.js';

const { DATABASE_URL } = process.env;

/**
 * Every column this codebase actually reads or writes, by table.
 *
 * Deliberately NOT the full schema. Listing columns nothing uses would make the test fail
 * on a change that could not possibly affect TPS, and a test that cries wolf gets deleted.
 * These are the ones `commsDb.ts` names.
 */
const REQUIRED_COLUMNS: Record<string, string[]> = {
  threads: [
    'id', 'organization_id', 'workflow_id', 'counterparty_kind', 'subcontractor_id',
    'counterparty_email', 'counterparty_domain', 'counterparty_name', 'subject', 'status',
    'last_message_at', 'created_at'
  ],
  messages: [
    'id', 'thread_id', 'organization_id', 'workflow_id', 'shortlist_entry_id', 'direction',
    'channel', 'kind', 'author_name', 'author_email', 'subject', 'body_text', 'occurred_at',
    'received_at', 'in_reply_to_message_id', 'external_message_id', 'external_in_reply_to',
    'external_references', 'attribution_method', 'dkim_result', 'spf_result', 'dmarc_result',
    'raw_object_key', 'attachments_truncated', 'idempotency_key', 'created_by', 'created_at'
  ],
  attachments: [
    'id', 'message_id', 'seq', 'filename', 'content_type', 'byte_size', 'sha256',
    'object_key', 'share_url', 'share_token', 'share_expires_at'
  ],
  forward_items: ['forward_message_id', 'source_message_id', 'seq'],
  client_reply_links: [
    'id', 'forward_message_id', 'thread_id', 'organization_id', 'workflow_id', 'token',
    'recipient_email', 'recipient_domain', 'expires_at', 'blocked_reason',
    'first_opened_at', 'last_opened_at', 'last_opened_email',
    'denied_attempts', 'last_denied_email', 'last_denied_at'
  ],
  notifications: [
    'id', 'organization_id', 'kind', 'thread_id', 'message_id', 'workflow_id',
    'subcontractor_id', 'title', 'body', 'deep_link_path', 'created_at'
  ],
  notification_reads: ['notification_id', 'user_id', 'read_at']
};

/**
 * The indexes the WRITE PATH depends on, not merely the ones that exist.
 *
 * `findOrCreateThread` infers these two by name in its ON CONFLICT. Drop or rename either
 * and the upsert stops matching — which does not raise an error, it silently creates a
 * second thread for a firm that already had one. That is the failure this list exists for.
 */
const REQUIRED_INDEXES = ['threads_wf_party_idx', 'threads_untriaged_party_idx'];

describe('the comms schema', () => {
  if (!DATABASE_URL) {
    it.skip('skipped - DATABASE_URL not set', () => {});
    return;
  }

  const db = new Database(loadWorkerConfig({ ...process.env, REDIS_URL: 'redis://unused:6379' }));

  it('is present and at least at the migration this build needs', async () => {
    // The same check server.ts runs before it serves anything.
    await expect(assertCommsSchema(db)).resolves.toBeUndefined();
    const [row] = await db.query<{ name: string }>(
      `SELECT name FROM comms.schema_migrations ORDER BY name DESC LIMIT 1`
    );
    expect(row?.name, 'comms.schema_migrations is empty').toBeDefined();
    expect(row!.name >= REQUIRED_COMMS_MIGRATION).toBe(true);
  });

  it('REFUSES when the schema is behind, which is the whole point of the guard', async () => {
    // The positive case above only proves the check passes on a good database. What the
    // boot guard is actually for is the bad one — and an assertion that can only ever
    // succeed is not an assertion.
    //
    // Emptying the ledger inside a transaction and rolling back is how this stays safe on
    // a live dev database: assertCommsSchema reads through the same pool, so it sees the
    // uncommitted state, and nothing survives the rollback.
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM comms.schema_migrations');
      await expect(assertCommsSchema({
        query: async (sql: string, values?: unknown[]) => (await client.query(sql, values)).rows
      } as unknown as Database)).rejects.toThrow(/needs 003_rfi_kinds\.sql|nothing applied/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }

    // And it still passes afterwards, so the rollback really did restore things.
    await expect(assertCommsSchema(db)).resolves.toBeUndefined();
  });

  it('carries every column this codebase reads or writes', async () => {
    const rows = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'comms'`
    );
    const present = new Map<string, Set<string>>();
    for (const row of rows) {
      if (!present.has(row.table_name)) present.set(row.table_name, new Set());
      present.get(row.table_name)!.add(row.column_name);
    }

    const missing: string[] = [];
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      const found = present.get(table);
      if (!found) { missing.push(`${table} (whole table)`); continue; }
      for (const column of columns) if (!found.has(column)) missing.push(`${table}.${column}`);
    }
    expect(
      missing,
      'the comms schema is missing columns this code uses. It is owned by novamerx-comms-worker, '
      + 'where changes are additive-only — a rename there is a two-phase change, not one migration.'
    ).toEqual([]);
  });

  it('carries the two partial indexes the thread upsert infers by name', async () => {
    const rows = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'comms'`
    );
    const names = new Set(rows.map((row) => row.indexname));
    const missing = REQUIRED_INDEXES.filter((index) => !names.has(index));
    expect(
      missing,
      'findOrCreateThread infers these in its ON CONFLICT. Without them the upsert silently '
      + 'creates a second thread for a firm that already had one.'
    ).toEqual([]);
  });

  it('still refuses to let a message claim a time in the future', async () => {
    // The clamp is enforced by a CHECK rather than only by recordMessage, and a CHECK
    // dropped in the owning repository would be invisible there.
    const [row] = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conname = 'ck_messages_occurred_not_future'
            AND conrelid = 'comms.messages'::regclass
       ) AS exists`
    );
    expect(row?.exists).toBe(true);
  });

  it('accepts the two kinds the ITT reminders write, and the two RFI drafting writes', async () => {
    // 002 and 003 each WIDENED two CHECKs. This is the assertion that would notice a
    // later migration in the owning repository narrowing them again - which would
    // surface here as a reminder or an RFI response that fails to record, in front of
    // a subcontractor, rather than at deploy.
    const rows = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE contype = 'c' AND pg_get_constraintdef(oid) LIKE '%kind%'
          AND conrelid IN ('comms.messages'::regclass, 'comms.notifications'::regclass)`
    );
    const all = rows.map((row) => row.def).join(' ');
    expect(all).toContain('itt_reminder');
    expect(all).toContain('itt_response_detected');
    expect(all).toContain('rfi_response');
    expect(all).toContain('rfi_review_required');
  });

  it('keeps notifications one-per-message', async () => {
    // comms.notifications.message_id UNIQUE is what makes "two notifications for one
    // message" unrepresentable. Nothing writes these rows yet, so only this would notice.
    //
    // Checked by COLUMN rather than by matching pg_get_constraintdef against the literal
    // 'UNIQUE (message_id)': that string is a formatting detail of the server version, so
    // an exact match would be a test that fails on a Postgres upgrade and tells you
    // nothing about the constraint.
    const rows = await db.query<{ column_name: string }>(
      `SELECT a.attname AS column_name
         FROM pg_constraint c
         JOIN unnest(c.conkey) AS k(attnum) ON TRUE
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.contype = 'u' AND c.conrelid = 'comms.notifications'::regclass
        GROUP BY c.oid, a.attname`
    );
    expect(rows.map((row) => row.column_name)).toContain('message_id');
  });
});
