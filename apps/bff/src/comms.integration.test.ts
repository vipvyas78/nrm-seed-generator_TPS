/**
 * The subcontractor-query store (schema `comms`, migration 022) — real PostgreSQL.
 *
 *   pnpm --filter @tps/bff exec vitest run src/comms.integration.test.ts
 *
 * What is worth exercising against a live database, and cannot be exercised anywhere else:
 *
 *  - the thread upsert infers the RIGHT partial unique index. 022 declares two, and which
 *    one applies turns on whether the message could be attributed to a tender. Inferring
 *    the wrong one either fails outright or — far worse — matches across tenders;
 *  - a NULL workflow_id really does behave as "distinct" to Postgres, which is why the
 *    untriaged index is keyed on organization_id instead. A single combined constraint
 *    would admit duplicate triage threads silently, and that is the one case where
 *    duplicates are most likely because nothing there has an id to key on;
 *  - the future-timestamp clamp holds at the CHECK, not merely in TypeScript.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { CommsDatabase } from './commsDb.js';
import { loadWorkerConfig } from './config.js';
import { Database } from './db.js';

const { DATABASE_URL } = process.env;

/**
 * Milliseconds off a timestamptz that `pg` has already parsed into a Date.
 *
 * NOT `new Date(String(value))`. `Row` values are typed `unknown`, so reaching for
 * String() is the obvious move — and Date.prototype.toString() has SECOND precision, so
 * it silently rounds away the milliseconds and makes an exact comparison fail against
 * code that is perfectly correct. The column itself round-trips milliseconds exactly.
 */
const at = (value: unknown): number => (value as Date).getTime();

describe('the communications store', () => {
  if (!DATABASE_URL) {
    it.skip('skipped - DATABASE_URL not set', () => {});
    return;
  }

  const config = loadWorkerConfig({ ...process.env, REDIS_URL: 'redis://unused:6379' });
  const db = new Database(config);
  const comms = new CommsDatabase(db);
  const organizationId = randomUUID();

  afterAll(async () => {
    // Threads cascade to messages and attachments, so one delete is enough.
    await db.query(`DELETE FROM comms.threads WHERE organization_id = $1`, [organizationId]);
    await db.close();
  });

  const workflowId = randomUUID();

  it('gives one firm on one tender exactly one thread, however often it writes', async () => {
    const email = `estimator@${randomUUID().slice(0, 8)}.test`;
    const first = await comms.findOrCreateThread({
      organizationId, workflowId, counterpartyKind: 'subcontractor',
      counterpartyEmail: email, counterpartyName: 'Acme Drylining',
      subcontractorId: null, subject: 'Ceiling grid'
    });
    const second = await comms.findOrCreateThread({
      organizationId, workflowId, counterpartyKind: 'subcontractor',
      // Case and surrounding space are normalised, because an email address is not
      // case-sensitive and a second thread for "Estimator@" would be invisible.
      counterpartyEmail: `  ${email.toUpperCase()} `, counterpartyName: null,
      subcontractorId: null, subject: null
    });
    expect(second.id).toBe(first.id);
    // A later message carrying neither must not blank out what the first established.
    expect(second.counterparty_name).toBe('Acme Drylining');
    expect(second.subject).toBe('Ceiling grid');
  });

  it('keeps the same firm apart on two different tenders', async () => {
    // The whole reason the triaged index is keyed on workflow_id: a firm invited to two
    // tenders is having two unrelated conversations.
    const email = `shared@${randomUUID().slice(0, 8)}.test`;
    const a = await comms.findOrCreateThread({
      organizationId, workflowId: randomUUID(), counterpartyKind: 'subcontractor',
      counterpartyEmail: email, counterpartyName: null, subcontractorId: null, subject: null
    });
    const b = await comms.findOrCreateThread({
      organizationId, workflowId: randomUUID(), counterpartyKind: 'subcontractor',
      counterpartyEmail: email, counterpartyName: null, subcontractorId: null, subject: null
    });
    expect(b.id).not.toBe(a.id);
  });

  it('gives an untriaged sender one thread per organisation, not one per message', async () => {
    // Postgres treats every NULL as distinct, so a single combined unique constraint
    // would let this insert a second row every time. The separate partial index keyed on
    // organization_id is what makes the upsert land.
    const email = `stranger@${randomUUID().slice(0, 8)}.test`;
    const first = await comms.findOrCreateThread({
      organizationId, workflowId: null, counterpartyKind: 'subcontractor',
      counterpartyEmail: email, counterpartyName: null, subcontractorId: null, subject: null
    });
    const second = await comms.findOrCreateThread({
      organizationId, workflowId: null, counterpartyKind: 'subcontractor',
      counterpartyEmail: email, counterpartyName: null, subcontractorId: null, subject: null
    });
    expect(second.id).toBe(first.id);
    const rows = await db.query(
      `SELECT id FROM comms.threads WHERE organization_id = $1 AND counterparty_email = $2`,
      [organizationId, email]
    );
    expect(rows).toHaveLength(1);
  });

  it('separates a subcontractor thread from a client thread at the same address', async () => {
    const email = `both@${randomUUID().slice(0, 8)}.test`;
    const sub = await comms.findOrCreateThread({
      organizationId, workflowId, counterpartyKind: 'subcontractor',
      counterpartyEmail: email, counterpartyName: null, subcontractorId: null, subject: null
    });
    const client = await comms.findOrCreateThread({
      organizationId, workflowId, counterpartyKind: 'client',
      counterpartyEmail: email, counterpartyName: null, subcontractorId: null, subject: null
    });
    expect(client.id).not.toBe(sub.id);
  });

  it('records a message with its attachments and moves the thread forward', async () => {
    const thread = await comms.findOrCreateThread({
      organizationId, workflowId, counterpartyKind: 'subcontractor',
      counterpartyEmail: `msg@${randomUUID().slice(0, 8)}.test`, counterpartyName: 'Acme',
      subcontractorId: null, subject: null
    });
    const message = await comms.recordMessage({
      threadId: String(thread.id), organizationId, workflowId, shortlistEntryId: null,
      direction: 'inbound', channel: 'portal', kind: 'subcontractor_rfi',
      // The person who typed it, NOT the firm the link was issued to. That distinction is
      // the reason the form collects a name and email at all.
      authorName: 'Sam Colleague', authorEmail: 'sam@acme.test',
      subject: 'Ceiling grid', bodyText: 'Is the grid included?',
      attachments: [{
        id: randomUUID(), filename: 'sketch.pdf', contentType: 'application/pdf',
        byteSize: 1234, sha256: 'a'.repeat(64), objectKey: 'comms/x/y/sketch.pdf',
        shareUrl: 'http://buildflow.test/links/tok', shareToken: 'tok', shareExpiresAt: null
      }]
    });
    expect(message).not.toBeNull();

    const loaded = await comms.getThread(String(thread.id));
    expect(loaded.messages).toHaveLength(1);
    expect(loaded.messages[0].author_email).toBe('sam@acme.test');
    expect(loaded.thread.counterparty_email).not.toBe('sam@acme.test');
    const attachments = loaded.messages[0].attachments as Array<Record<string, unknown>>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe('sketch.pdf');

    const [after] = await db.query(`SELECT last_message_at FROM comms.threads WHERE id = $1`, [thread.id]);
    expect(at(after.last_message_at)).toBeGreaterThanOrEqual(at(thread.last_message_at));
  });

  it('clamps a sender claiming a time in the future', async () => {
    // An uncorrected future Date: header pins a message to the top of the timeline for
    // ever. The CHECK in 022 is what makes this a guarantee rather than an intention.
    const thread = await comms.findOrCreateThread({
      organizationId, workflowId, counterpartyKind: 'subcontractor',
      counterpartyEmail: `future@${randomUUID().slice(0, 8)}.test`, counterpartyName: null,
      subcontractorId: null, subject: null
    });
    const message = await comms.recordMessage({
      threadId: String(thread.id), organizationId, workflowId, shortlistEntryId: null,
      direction: 'inbound', channel: 'email', kind: 'subcontractor_rfi',
      authorName: null, authorEmail: null, subject: null, bodyText: 'from the future',
      occurredAt: new Date(Date.now() + 5 * 365 * 24 * 3600 * 1000)
    });
    expect(at(message!.occurred_at)).toBeLessThanOrEqual(at(message!.received_at));
  });

  it('keeps a past timestamp as it was, rather than clamping everything to now', async () => {
    const thread = await comms.findOrCreateThread({
      organizationId, workflowId, counterpartyKind: 'subcontractor',
      counterpartyEmail: `past@${randomUUID().slice(0, 8)}.test`, counterpartyName: null,
      subcontractorId: null, subject: null
    });
    const sent = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    const message = await comms.recordMessage({
      threadId: String(thread.id), organizationId, workflowId, shortlistEntryId: null,
      direction: 'inbound', channel: 'email', kind: 'subcontractor_rfi',
      authorName: null, authorEmail: null, subject: null, bodyText: 'delayed in a queue',
      occurredAt: sent
    });
    expect(at(message!.occurred_at)).toBe(sent.getTime());
  });

  it('treats a redelivered message as a duplicate rather than an error', async () => {
    // An Email Worker delivers at least once by design, so this is normal traffic.
    const thread = await comms.findOrCreateThread({
      organizationId, workflowId, counterpartyKind: 'subcontractor',
      counterpartyEmail: `dupe@${randomUUID().slice(0, 8)}.test`, counterpartyName: null,
      subcontractorId: null, subject: null
    });
    const key = `<${randomUUID()}@mail.test>`;
    const base = {
      threadId: String(thread.id), organizationId, workflowId, shortlistEntryId: null,
      direction: 'inbound' as const, channel: 'email' as const, kind: 'subcontractor_rfi' as const,
      authorName: null, authorEmail: null, subject: null, bodyText: 'once', idempotencyKey: key
    };
    expect(await comms.recordMessage(base)).not.toBeNull();
    expect(await comms.recordMessage(base)).toBeNull();
    const loaded = await comms.getThread(String(thread.id));
    expect(loaded.messages).toHaveLength(1);
  });

  it('summarises a tender’s threads without a query per thread', async () => {
    const threads = await comms.listThreadsForWorkflow(workflowId);
    expect(threads.length).toBeGreaterThan(0);
    for (const thread of threads) {
      expect(thread).toHaveProperty('message_count');
      expect(thread).toHaveProperty('inbound_count');
      expect(thread).toHaveProperty('attachment_count');
    }
    // Most recently active first, which is the order the modal lists them in.
    const times = threads.map((t) => at(t.last_message_at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});
