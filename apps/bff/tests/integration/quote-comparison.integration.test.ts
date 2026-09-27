/**
 * The levelled quote comparison (BuildFlow issue #100) — real PostgreSQL.
 *
 *   pnpm --filter @tps/bff exec vitest run tests/integration/quote-comparison.integration.test.ts
 *
 * The unit tests (tests/unit/quoteComparisonDb.test.ts) already cover every branch of the
 * levelling table itself; nothing here re-proves that arithmetic. What only a real
 * database can decide is covered instead: that the spine aligns two real portal snapshots
 * on `seq`, that a snapshot which has genuinely drifted (a firm invited after the bill
 * changed) is reported rather than silently mis-paired, that a manual return slots into
 * the same spine, that readiness moves against a real deadline, and — the one worth
 * writing first — that the database itself refuses `tender_boq_lines` before the trade
 * analysis it depends on is approved.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { BoqReadDatabase } from '../../src/boqReadDb.js';
import { loadWorkerConfig } from '../../src/config.js';
import { Database } from '../../src/db.js';
import { PricingPortalDatabase } from '../../src/pricingPortalDb.js';
import { QuoteComparisonDatabase } from '../../src/quoteComparisonDb.js';
import { ScmsReadDatabase } from '../../src/scmsReadDb.js';
import { TenderPrepDatabase } from '../../src/tenderPrepDb.js';
import { testActor } from '../testActor.js';

const { DATABASE_URL } = process.env;
type Row = Record<string, unknown>;

describe('the levelled quote comparison', () => {
  if (!DATABASE_URL) {
    it.skip('skipped - DATABASE_URL not set', () => {});
    return;
  }

  const connect = () => {
    const config = loadWorkerConfig({ ...process.env, REDIS_URL: 'redis://unused:6379' });
    const db = new Database(config);
    const portalDb = new PricingPortalDatabase(db);
    const quoteDb = new QuoteComparisonDatabase(db);
    const scms = new ScmsReadDatabase(db, config.SCMS_SCHEMA);
    const boq = new BoqReadDatabase(db);
    // Positional constructor, matching app.ts's own call — every optional collaborator
    // before portalDb left undefined, then portalDb at its real position, then the rest
    // undefined up to quoteDb at the end.
    const tpDb = new TenderPrepDatabase(
      db, scms, boq, undefined, undefined, undefined, undefined, undefined, undefined,
      portalDb, undefined, undefined, 90, undefined, undefined, undefined, 30, undefined, undefined, quoteDb
    );
    return { db, portalDb, quoteDb, tpDb };
  };

  const fixture = async (db: Database, tpDb: TenderPrepDatabase) => {
    const organizationId = randomUUID();
    const userId = randomUUID();
    const packageId = randomUUID();
    const packageName = `Quote comparison test ${randomUUID().slice(0, 8)}`;
    const actor = testActor({ userId, organizationId, subject: 'test' });

    const [workflow] = await db.query<{ id: string }>(
      `INSERT INTO workflows (package_id, organization_id, created_by, step_data) VALUES ($1,$2,$3,$4) RETURNING id`,
      [packageId, organizationId, userId, JSON.stringify({})]
    );
    const workflowId = String(workflow.id);

    await tpDb.savePackageSelection(actor, workflowId, {
      packageName,
      entries: [
        { subcontractorId: randomUUID(), rank: 1, selected: true },
        { subcontractorId: randomUUID(), rank: 2, selected: true },
        { subcontractorId: randomUUID(), rank: 3, selected: true }
      ]
    });
    const entries = await db.query<{ id: string }>(
      `SELECT se.id FROM shortlist_entries se JOIN shortlists sl ON sl.id = se.shortlist_id
        WHERE sl.workflow_id = $1 ORDER BY se.rank`,
      [workflowId]
    );

    return { organizationId, userId, workflowId, packageName, actor, entryIds: entries.map((e) => e.id) };
  };

  const cleanup = async (db: Database, f: { workflowId: string }) => {
    await db.query(`DELETE FROM workflows WHERE id = $1`, [f.workflowId]); // cascades to shortlists, quote_comparisons, tender_returns
    await db.close();
  };

  it('refuses a draft BoQ line until the package’s trade analysis is approved', async () => {
    const { db } = connect();
    const workflowId = randomUUID();
    try {
      await db.query(`INSERT INTO workflows (id, package_id, organization_id) VALUES ($1,$2,$3)`, [workflowId, randomUUID(), randomUUID()]);
      await expect(
        db.query(
          `INSERT INTO tender_boq_lines (workflow_id, package_name, description) VALUES ($1, 'Unapproved package', 'Some line')`,
          [workflowId]
        )
      ).rejects.toThrow(/no approved trade analysis/);
    } finally {
      await db.query(`DELETE FROM workflows WHERE id = $1`, [workflowId]);
      await db.close();
    }
  });

  it('aligns two real portal snapshots on seq, and reports a snapshot that has drifted', async () => {
    const { db, portalDb, tpDb } = connect();
    const f = await fixture(db, tpDb);
    try {
      // Firm B is invited first, with the fuller (later) bill — three lines. `buildSpine`
      // picks the FULLEST snapshot as the reference, so B becomes it deterministically.
      const linkB = await portalDb.mintOrRefreshLink({
        shortlistEntryId: f.entryIds[0]!, workflowId: f.workflowId, packageName: f.packageName,
        subcontractorId: null, tendererName: 'Firm B (reference)', recipientEmail: 'b@example.com', isTest: true, ttlDays: 30
      });
      await portalDb.snapshotLines(linkB.id, [
        { sourceItemId: null, geCode: 'GE1', elementCode: '1.1', description: 'Excavate trial pits', quantity: 10, unit: 'nr', isPriceable: true },
        { sourceItemId: null, geCode: 'GE2', elementCode: '2.5', description: 'Supply and fix roof tiles', quantity: 500, unit: 'm2', isPriceable: true },
        { sourceItemId: null, geCode: 'GE9', elementCode: null, description: 'Testing and commissioning', quantity: 1, unit: 'item', isPriceable: true }
      ]);
      await portalDb.saveDraft(linkB.id, {
        header: { programmeWeeks: 10, qualifications: 'Standard hours only', exclusions: 'Excludes out-of-hours working' },
        lines: (await portalDb.getLines(linkB.id)).map((l, i) => ({
          id: String(l.id), quantity: Number(l.quantity),
          rate: [20, 12, 1000][i]!, status: 'priced', note: null
        }))
      });
      await portalDb.submit(linkB.id);

      // Firm A was invited BEFORE a bill change — an OLDER, two-line snapshot, and its
      // second line names a different roofing material entirely. It must never be paired
      // with B's "roof tiles" line as if they were the same item.
      const linkA = await portalDb.mintOrRefreshLink({
        shortlistEntryId: f.entryIds[1]!, workflowId: f.workflowId, packageName: f.packageName,
        subcontractorId: null, tendererName: 'Firm A (older bill)', recipientEmail: 'a@example.com', isTest: true, ttlDays: 30
      });
      await portalDb.snapshotLines(linkA.id, [
        { sourceItemId: null, geCode: 'GE1', elementCode: '1.1', description: 'Excavate trial pits', quantity: 10, unit: 'nr', isPriceable: true },
        { sourceItemId: null, geCode: 'GE2', elementCode: '2.5', description: 'Supply and fix roof SLATES', quantity: 500, unit: 'm2', isPriceable: true }
      ]);
      await portalDb.saveDraft(linkA.id, {
        header: { programmeWeeks: 8, qualifications: null, exclusions: null },
        lines: (await portalDb.getLines(linkA.id)).map((l, i) => ({
          id: String(l.id), quantity: Number(l.quantity), rate: [18, 15][i]!, status: 'priced', note: null
        }))
      });
      await portalDb.submit(linkA.id);

      const comparison = await tpDb.openQuoteComparison(f.actor, f.workflowId, f.packageName);
      expect(comparison.readiness).toBe('awaiting_returns'); // 2 of 3 expected, no deadline set

      const detail = await tpDb.getQuoteComparison(f.actor, f.workflowId, f.packageName);
      const rows = detail.rows as Array<Row & { description: string; cells: Array<Row & { returnId: string; status: string; quotedTotal: number | null; isAssumed: boolean; assumptionBasis: string | null }> }>;
      expect(rows).toHaveLength(3); // B's bill (the reference) is the whole spine

      const returns = detail.returns as Array<{ id: string; tenderer_name: string }>;
      const firmA = returns.find((r) => r.tenderer_name.startsWith('Firm A'))!;
      const firmB = returns.find((r) => r.tenderer_name.startsWith('Firm B'))!;

      const excavation = rows.find((r) => r.description === 'Excavate trial pits')!;
      const aOnExcavation = excavation.cells.find((c) => c.returnId === firmA.id)!;
      expect(aOnExcavation.status).toBe('priced');
      expect(aOnExcavation.quotedTotal).toBe(180); // matched cleanly by seq — 10 x 18

      const roofing = rows.find((r) => r.description === 'Supply and fix roof tiles')!;
      const aOnRoofing = roofing.cells.find((c) => c.returnId === firmA.id)!;
      // The drifted line: not paired as a priced quote, and said so rather than guessed.
      expect(aOnRoofing.status).toBe('not_addressed');
      expect(aOnRoofing.quotedTotal).toBeNull();
      expect(aOnRoofing.isAssumed).toBe(true);
      expect(aOnRoofing.assumptionBasis).toContain('reconcile by hand');
      expect(aOnRoofing.assumptionBasis).toContain('roof SLATES');

      const bOnRoofing = roofing.cells.find((c) => c.returnId === firmB.id)!;
      expect(bOnRoofing.status).toBe('priced');
      expect(bOnRoofing.quotedTotal).toBe(6000); // 500 x 12, untouched by A's mismatch

      const testing = rows.find((r) => r.description === 'Testing and commissioning')!;
      const aOnTesting = testing.cells.find((c) => c.returnId === firmA.id)!;
      // A's snapshot never had this line at all — absent, not not_addressed.
      expect(aOnTesting.status).toBe('absent');
      expect(aOnTesting.assumptionBasis).toContain('Not in this tenderer’s return');
      expect(aOnTesting.quotedTotal).toBeNull();
      expect(aOnTesting.levelledTotal).toBe(1000); // substituted from B, the only priced quote
    } finally {
      await cleanup(db, f);
    }
  });

  it('slots a manual return into the same spine, and moves readiness to quorum once it arrives', async () => {
    const { db, portalDb, tpDb, quoteDb } = connect();
    const f = await fixture(db, tpDb);
    try {
      const link = await portalDb.mintOrRefreshLink({
        shortlistEntryId: f.entryIds[0]!, workflowId: f.workflowId, packageName: f.packageName,
        subcontractorId: null, tendererName: 'Firm B', recipientEmail: 'b@example.com', isTest: true, ttlDays: 30
      });
      await portalDb.snapshotLines(link.id, [
        { sourceItemId: null, geCode: 'GE1', elementCode: null, description: 'Site clearance', quantity: 1, unit: 'item', isPriceable: true }
      ]);
      await portalDb.saveDraft(link.id, {
        header: { programmeWeeks: null, qualifications: null, exclusions: null },
        lines: [{ id: String((await portalDb.getLines(link.id))[0]!.id), quantity: 1, rate: 5000, status: 'priced', note: null }]
      });
      await portalDb.submit(link.id);

      const secondLink = await portalDb.mintOrRefreshLink({
        shortlistEntryId: f.entryIds[1]!, workflowId: f.workflowId, packageName: f.packageName,
        subcontractorId: null, tendererName: 'Firm C', recipientEmail: 'c@example.com', isTest: true, ttlDays: 30
      });
      await portalDb.snapshotLines(secondLink.id, [
        { sourceItemId: null, geCode: 'GE1', elementCode: null, description: 'Site clearance', quantity: 1, unit: 'item', isPriceable: true }
      ]);
      await portalDb.saveDraft(secondLink.id, {
        header: { programmeWeeks: null, qualifications: null, exclusions: null },
        lines: [{ id: String((await portalDb.getLines(secondLink.id))[0]!.id), quantity: 1, rate: 4500, status: 'priced', note: null }]
      });
      await portalDb.submit(secondLink.id);

      let comparison = await tpDb.openQuoteComparison(f.actor, f.workflowId, f.packageName);
      expect(comparison.readiness).toBe('awaiting_returns'); // 2 of 3

      const detail = await tpDb.getQuoteComparison(f.actor, f.workflowId, f.packageName);
      const spineRowId = String((detail.rows as Array<{ id: string }>)[0]!.id);

      // Firm A's quote arrived as an emailed spreadsheet — keyed in by hand against the
      // spine row the estimator is already looking at.
      await tpDb.recordManualQuoteReturn(f.actor, f.workflowId, f.packageName, {
        tendererName: 'Firm A (by email)', subcontractorId: null, receivedAt: null,
        programmeWeeks: 6, qualifications: 'Price valid for 30 days', exclusions: null,
        cells: [{ rowId: spineRowId, quantity: 1, rate: 4000, status: 'priced', note: 'Confirmed by phone' }],
        extraLines: []
      });

      comparison = await tpDb.openQuoteComparison(f.actor, f.workflowId, f.packageName);
      expect(comparison.readiness).toBe('quorum_met'); // 3 of 3, the issue's own number

      const refreshed = await tpDb.getQuoteComparison(f.actor, f.workflowId, f.packageName);
      const returns = refreshed.returns as Array<{ id: string; tenderer_name: string }>;
      const firmA = returns.find((r) => r.tenderer_name.includes('Firm A'))!;
      const row = (refreshed.rows as Array<{ cells: Array<{ returnId: string; status: string; quotedTotal: number | null; tendererNote: string | null }> }>)[0]!;
      const aCell = row.cells.find((c) => c.returnId === firmA.id)!;
      expect(aCell.status).toBe('priced');
      expect(aCell.quotedTotal).toBe(4000);
      expect(aCell.tendererNote).toBe('Confirmed by phone');

      // Awarding the CHEAPEST of the three — Firm A at 4000 — writes the draft BoQ, which
      // the trigger above refuses without an approved trade analysis first.
      const tradeAnalysis = await tpDb.approveQuoteComparison(f.actor, f.workflowId, f.packageName, firmA.id, 'Cheapest compliant bid');
      expect(tradeAnalysis.status).toBe('approved_with_adjustments');
      expect(String(tradeAnalysis.awarded_return_id)).toBe(firmA.id);

      const boqLines = await db.query<{ description: string; submitted_rate: string; approved_rate: string; adjusted: boolean }>(
        `SELECT description, submitted_rate, approved_rate, adjusted FROM tender_boq_lines WHERE workflow_id = $1 AND package_name = $2`,
        [f.workflowId, f.packageName]
      );
      expect(boqLines).toHaveLength(1);
      expect(Number(boqLines[0]!.submitted_rate)).toBe(4000);
      expect(Number(boqLines[0]!.approved_rate)).toBe(4000);
      expect(boqLines[0]!.adjusted).toBe(false); // Firm A's own line, priced cleanly — no substitution involved
    } finally {
      await cleanup(db, f);
    }
  });

  it('refuses to approve while awaiting_returns, the actual guard behind the screen’s disabled button', async () => {
    const { db, portalDb, tpDb } = connect();
    const f = await fixture(db, tpDb);
    try {
      const link = await portalDb.mintOrRefreshLink({
        shortlistEntryId: f.entryIds[0]!, workflowId: f.workflowId, packageName: f.packageName,
        subcontractorId: null, tendererName: 'Firm B', recipientEmail: 'b@example.com', isTest: true, ttlDays: 30
      });
      await portalDb.snapshotLines(link.id, [
        { sourceItemId: null, geCode: null, elementCode: null, description: 'Mobilisation', quantity: 1, unit: 'item', isPriceable: true }
      ]);
      await portalDb.saveDraft(link.id, {
        header: { programmeWeeks: null, qualifications: null, exclusions: null },
        lines: [{ id: String((await portalDb.getLines(link.id))[0]!.id), quantity: 1, rate: 100, status: 'priced', note: null }]
      });
      await portalDb.submit(link.id);

      const comparison = await tpDb.openQuoteComparison(f.actor, f.workflowId, f.packageName);
      expect(comparison.readiness).toBe('awaiting_returns'); // 1 of 3, no deadline stamped

      const returns = await db.query<{ id: string }>(`SELECT id FROM tender_returns WHERE workflow_id = $1`, [f.workflowId]);
      await expect(tpDb.approveQuoteComparison(f.actor, f.workflowId, f.packageName, returns[0]!.id, null))
        .rejects.toThrow(/Only 1 of the expected 3 returns/);

      // Nothing was written — the refusal is not a partial approval.
      const [tradeAnalysis] = await db.query(`SELECT id FROM tps.trade_analysis WHERE workflow_id = $1 AND package_name = $2`, [f.workflowId, f.packageName]);
      expect(tradeAnalysis).toBeUndefined();
    } finally {
      await cleanup(db, f);
    }
  });

  it('reads deadline_passed once the stamped return date has gone, however few returns are in', async () => {
    const { db, portalDb, tpDb } = connect();
    const f = await fixture(db, tpDb);
    try {
      await db.query(
        `INSERT INTO itt_letter_details (workflow_id, tender_return_deadline) VALUES ($1, '2020-01-01')`,
        [f.workflowId]
      );
      const link = await portalDb.mintOrRefreshLink({
        shortlistEntryId: f.entryIds[0]!, workflowId: f.workflowId, packageName: f.packageName,
        subcontractorId: null, tendererName: 'Firm B', recipientEmail: 'b@example.com', isTest: true, ttlDays: 30
      });
      await portalDb.snapshotLines(link.id, [
        { sourceItemId: null, geCode: null, elementCode: null, description: 'Mobilisation', quantity: 1, unit: 'item', isPriceable: true }
      ]);
      await portalDb.saveDraft(link.id, {
        header: { programmeWeeks: null, qualifications: null, exclusions: null },
        lines: [{ id: String((await portalDb.getLines(link.id))[0]!.id), quantity: 1, rate: 100, status: 'priced', note: null }]
      });
      await portalDb.submit(link.id);

      // The issue's own instruction: "if the time has passed, the app should consider
      // whatever the number of quotes it has received" — one return, long past deadline.
      const comparison = await tpDb.openQuoteComparison(f.actor, f.workflowId, f.packageName);
      expect(comparison.readiness).toBe('deadline_passed');
    } finally {
      await cleanup(db, f);
    }
  });
});

