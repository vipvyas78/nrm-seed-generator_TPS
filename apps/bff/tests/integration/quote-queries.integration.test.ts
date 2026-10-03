/**
 * Queries to subcontractors about their quote (BuildFlow issue #100) — real PostgreSQL,
 * the real `comms` schema, a fake mail provider.
 *
 *   pnpm --filter @tps/bff exec vitest run tests/integration/quote-queries.integration.test.ts
 *
 * DEPENDS ON A SISTER MIGRATION in novamerx-comms-worker adding 'quote_query' to
 * comms.messages' own kind CHECK — see migration 031's own header and commsDb.ts's
 * MessageKind. Every test that actually SENDS an email needs it; the CRUD tests
 * (draft/update/withdraw/response) do not touch `comms.messages` at all and will pass
 * regardless.
 *
 * Mail is captured, never sent — the same convention itt-reminders.integration.test.ts
 * keeps. Nothing here can email anybody real.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BoqReadDatabase } from '../../src/boqReadDb.js';
import { CommsDatabase } from '../../src/commsDb.js';
import { loadWorkerConfig } from '../../src/config.js';
import { Database } from '../../src/db.js';
import type { EmailService } from '../../src/emailService.js';
import { PricingPortalDatabase } from '../../src/pricingPortalDb.js';
import { QuoteComparisonDatabase } from '../../src/quoteComparisonDb.js';
import { QuoteQueriesDatabase } from '../../src/quoteQueriesDb.js';
import { ScmsReadDatabase } from '../../src/scmsReadDb.js';
import { TenderPrepDatabase } from '../../src/tenderPrepDb.js';
import { testActor } from '../testActor.js';

const { DATABASE_URL } = process.env;
type Row = Record<string, unknown>;
type Sent = { to: string | string[]; subject: string; text: string; html: string };

describe('queries to subcontractors about their quote', () => {
  if (!DATABASE_URL) {
    it.skip('skipped - DATABASE_URL not set', () => {});
    return;
  }

  const connect = (options: { failSends?: boolean } = {}) => {
    const config = loadWorkerConfig({ ...process.env, REDIS_URL: 'redis://unused:6379' });
    const db = new Database(config);
    const portalDb = new PricingPortalDatabase(db);
    const quoteDb = new QuoteComparisonDatabase(db);
    const commsDb = new CommsDatabase(db);
    const scms = new ScmsReadDatabase(db, config.SCMS_SCHEMA);
    const boq = new BoqReadDatabase(db);

    const sent: Sent[] = [];
    const email = {
      send: async (message: Sent) => {
        if (options.failSends) throw new Error('provider unavailable');
        sent.push(message);
        return { id: `msg-${sent.length}` };
      }
    } as unknown as EmailService;

    const quoteQueriesDb = new QuoteQueriesDatabase(db, commsDb, scms, email, null, 'tenders@novamerx.ai');
    // Positional constructor, matching app.ts's own call — every optional collaborator
    // before portalDb left undefined, then portalDb, quoteDb and quoteQueriesDb at their
    // real positions.
    const tpDb = new TenderPrepDatabase(
      db, scms, boq, undefined, undefined, undefined, undefined, undefined, undefined,
      portalDb, undefined, undefined, 90, undefined, undefined, undefined, 30, undefined, undefined,
      quoteDb, quoteQueriesDb
    );
    return { db, portalDb, quoteDb, quoteQueriesDb, commsDb, tpDb, sent };
  };

  const fixture = async (db: Database, tpDb: TenderPrepDatabase) => {
    const organizationId = randomUUID();
    const userId = randomUUID();
    const packageId = randomUUID();
    const packageName = `Quote query test ${randomUUID().slice(0, 8)}`;
    const actor = testActor({ userId, organizationId, subject: 'estimator', email: 'estimator@example.test' });

    await db.query(
      `INSERT INTO public.bf_organizations (id, oidc_issuer, external_id, name) VALUES ($1, $2, $3, $4)`,
      [organizationId, `https://issuer.test/${organizationId}`, organizationId, 'Test Org']
    );
    const [workflow] = await db.query<{ id: string }>(
      `INSERT INTO workflows (package_id, organization_id, created_by, step_data) VALUES ($1,$2,$3,$4) RETURNING id`,
      [packageId, organizationId, userId, JSON.stringify({})]
    );
    const workflowId = String(workflow.id);

    await tpDb.savePackageSelection(actor, workflowId, {
      packageName,
      entries: [{ subcontractorId: randomUUID(), rank: 1, selected: true }]
    });
    const [entry] = await db.query<{ id: string }>(
      `SELECT se.id FROM shortlist_entries se JOIN shortlists sl ON sl.id = se.shortlist_id WHERE sl.workflow_id = $1`,
      [workflowId]
    );

    return { organizationId, userId, workflowId, packageName, actor, entryId: entry!.id };
  };

  const cleanup = async (db: Database, f: { workflowId: string; organizationId: string }) => {
    await db.query(`DELETE FROM comms.threads WHERE workflow_id = $1`, [f.workflowId]);
    await db.query(`DELETE FROM workflows WHERE id = $1`, [f.workflowId]); // cascades to shortlists, quote_comparisons, tender_returns, quote_queries
    await db.query(`DELETE FROM public.bf_organizations WHERE id = $1`, [f.organizationId]);
    await db.close();
  };

  /** One priced return, so there is something to open a comparison against and a return
   *  to raise a query on. */
  const seedReturn = async (portalDb: PricingPortalDatabase, f: { entryId: string; workflowId: string; packageName: string }, tendererName: string, rate: number) => {
    const link = await portalDb.mintOrRefreshLink({
      shortlistEntryId: f.entryId, workflowId: f.workflowId, packageName: f.packageName,
      subcontractorId: null, tendererName, recipientEmail: `${tendererName.toLowerCase().replace(/\s+/g, '')}@example.com`,
      isTest: true, ttlDays: 30
    });
    await portalDb.snapshotLines(link.id, [
      { sourceItemId: null, geCode: null, elementCode: null, description: 'Mobilisation', quantity: 1, unit: 'item', isPriceable: true }
    ]);
    await portalDb.saveDraft(link.id, {
      header: { programmeWeeks: null, qualifications: null, exclusions: null },
      lines: [{ id: String((await portalDb.getLines(link.id))[0]!.id), quantity: 1, rate, status: 'priced', note: null }]
    });
    await portalDb.submit(link.id);
    return link;
  };

  it('drafts, edits, withdraws and logs a response — the whole lifecycle with no email involved', async () => {
    const { db, portalDb, quoteDb, quoteQueriesDb, tpDb } = connect();
    const f = await fixture(db, tpDb);
    try {
      await seedReturn(portalDb, f, 'Firm B', 100);
      const comparison = await quoteDb.open(f.workflowId, f.packageName, f.userId);
      const [ret] = await db.query<{ id: string }>(`SELECT id FROM tender_returns WHERE workflow_id = $1`, [f.workflowId]);

      const draft = await quoteQueriesDb.createDraft(
        f.workflowId, String(comparison.id), { returnId: String(ret!.id), rowId: null, cellId: null, question: 'Does your rate include scaffold access?' },
        f.userId
      );
      expect(draft.email_status).toBe('draft');

      const edited = await quoteQueriesDb.updateDraft(f.workflowId, String(comparison.id), String(draft.id), 'Does your rate include scaffold access and welfare facilities?');
      expect(edited.question).toContain('welfare facilities');

      const list = await quoteQueriesDb.list(f.workflowId, String(comparison.id));
      expect(list).toHaveLength(1);

      expect(await quoteQueriesDb.openCountForReturn(f.workflowId, String(ret!.id))).toBe(1);

      const responded = await quoteQueriesDb.logResponse(
        f.workflowId, String(comparison.id), String(draft.id),
        { response: 'Yes, both are included.', responseSource: 'phone', respondedAt: null }, f.userId
      );
      expect(responded.response).toBe('Yes, both are included.');
      expect(await quoteQueriesDb.openCountForReturn(f.workflowId, String(ret!.id))).toBe(0); // answered, no longer open
    } finally {
      await cleanup(db, f);
    }
  });

  it('refuses to edit, withdraw or respond to a query from another workflow, even by a real id', async () => {
    const { db, portalDb, quoteDb, quoteQueriesDb, tpDb } = connect();
    const f1 = await fixture(db, tpDb);
    const f2 = await fixture(db, tpDb);
    try {
      await seedReturn(portalDb, f1, 'Firm B', 100);
      const comparison1 = await quoteDb.open(f1.workflowId, f1.packageName, f1.userId);
      const [ret1] = await db.query<{ id: string }>(`SELECT id FROM tender_returns WHERE workflow_id = $1`, [f1.workflowId]);
      const draft = await quoteQueriesDb.createDraft(
        f1.workflowId, String(comparison1.id), { returnId: String(ret1!.id), rowId: null, cellId: null, question: 'A question for firm B.' }, f1.userId
      );

      await expect(quoteQueriesDb.updateDraft(f2.workflowId, String(comparison1.id), String(draft.id), 'hijacked')).rejects.toThrow();
      await expect(quoteQueriesDb.withdraw(f2.workflowId, String(comparison1.id), String(draft.id), f2.userId)).rejects.toThrow();
      await expect(quoteQueriesDb.logResponse(f2.workflowId, String(comparison1.id), String(draft.id), { response: 'x', responseSource: 'email', respondedAt: null }, f2.userId)).rejects.toThrow();

      const stillDraft = await quoteQueriesDb.list(f1.workflowId, String(comparison1.id));
      expect(stillDraft[0]!.question).toBe('A question for firm B.'); // untouched
    } finally {
      await cleanup(db, f1);
      await cleanup(db, f2);
    }
  });

  it('bundles every draft against one return into a single email, recorded on the firm’s own comms thread', async () => {
    const { db, portalDb, quoteDb, quoteQueriesDb, tpDb, sent } = connect();
    const f = await fixture(db, tpDb);
    try {
      await seedReturn(portalDb, f, 'Firm B', 100);
      const comparison = await quoteDb.open(f.workflowId, f.packageName, f.userId);
      const [ret] = await db.query<{ id: string }>(`SELECT id, tenderer_name FROM tender_returns WHERE workflow_id = $1`, [f.workflowId]);

      await quoteQueriesDb.createDraft(f.workflowId, String(comparison.id), { returnId: String(ret!.id), rowId: null, cellId: null, question: 'Question one.' }, f.userId);
      await quoteQueriesDb.createDraft(f.workflowId, String(comparison.id), { returnId: String(ret!.id), rowId: null, cellId: null, question: 'Question two.' }, f.userId);

      const result = await quoteQueriesDb.sendDrafts(f.workflowId, String(comparison.id), String(ret!.id), { userId: f.userId, displayName: 'Priya Shah' });
      expect(result.sent).toBe(2);
      expect(sent).toHaveLength(1); // ONE email for both questions, not two
      expect(sent[0]!.text).toContain('Question one.');
      expect(sent[0]!.text).toContain('Question two.');
      expect(sent[0]!.text).toContain('2 queries');

      const list = await quoteQueriesDb.list(f.workflowId, String(comparison.id));
      expect(list.every((q) => q.email_status === 'sent')).toBe(true);
      expect(list[0]!.comms_message_id).not.toBeNull();

      // A second send, with nothing left in draft, sends nothing more.
      const again = await quoteQueriesDb.sendDrafts(f.workflowId, String(comparison.id), String(ret!.id), { userId: f.userId, displayName: 'Priya Shah' });
      expect(again.sent).toBe(0);
      expect(sent).toHaveLength(1);
    } finally {
      await cleanup(db, f);
    }
  });

  it('settles as failed, and discards the recorded message, when the mail provider itself fails', async () => {
    const { db, portalDb, quoteDb, quoteQueriesDb, tpDb, commsDb } = connect({ failSends: true });
    const f = await fixture(db, tpDb);
    try {
      await seedReturn(portalDb, f, 'Firm B', 100);
      const comparison = await quoteDb.open(f.workflowId, f.packageName, f.userId);
      const [ret] = await db.query<{ id: string }>(`SELECT id FROM tender_returns WHERE workflow_id = $1`, [f.workflowId]);
      const draft = await quoteQueriesDb.createDraft(f.workflowId, String(comparison.id), { returnId: String(ret!.id), rowId: null, cellId: null, question: 'A question.' }, f.userId);

      const result = await quoteQueriesDb.sendDrafts(f.workflowId, String(comparison.id), String(ret!.id), { userId: f.userId, displayName: null });
      expect(result.sent).toBe(0);
      expect(result.error).toBe('provider unavailable');

      const [reread] = await db.query<Row>(`SELECT email_status, comms_message_id FROM tps.quote_queries WHERE id = $1`, [draft.id]);
      expect(reread!.email_status).toBe('failed');
      expect(reread!.comms_message_id).toBeNull();

      // Nothing was left on the firm's timeline — a failed send must not look like a sent one.
      const found = await commsDb.messageIdByIdempotencyKey(`quote-query:${draft.id}`);
      expect(found).toBeNull();
    } finally {
      await cleanup(db, f);
    }
  });

  it('warns rather than blocks an award with an open query against the winning tenderer, and proceeds once acknowledged', async () => {
    const { db, portalDb, quoteDb, quoteQueriesDb, tpDb } = connect();
    const f = await fixture(db, tpDb);
    try {
      await db.query(`INSERT INTO itt_letter_details (workflow_id, tender_return_deadline) VALUES ($1, '2020-01-01')`, [f.workflowId]);
      await seedReturn(portalDb, f, 'Firm B', 100);
      const comparison = await tpDb.openQuoteComparison(f.actor, f.workflowId, f.packageName);
      const [ret] = await db.query<{ id: string }>(`SELECT id FROM tender_returns WHERE workflow_id = $1`, [f.workflowId]);

      await quoteQueriesDb.createDraft(f.workflowId, String(comparison.id), { returnId: String(ret!.id), rowId: null, cellId: null, question: 'Open question.' }, f.userId);

      await expect(tpDb.approveQuoteComparison(f.actor, f.workflowId, f.packageName, String(ret!.id), null))
        .rejects.toThrow(/1 open query/);

      const [beforeAward] = await db.query(`SELECT id FROM tps.trade_analysis WHERE workflow_id = $1`, [f.workflowId]);
      expect(beforeAward).toBeUndefined(); // the refusal is not a partial approval

      const tradeAnalysis = await tpDb.approveQuoteComparison(f.actor, f.workflowId, f.packageName, String(ret!.id), null, true);
      expect(tradeAnalysis.status).toBe('approved_with_adjustments');
    } finally {
      await cleanup(db, f);
    }
  });
});
