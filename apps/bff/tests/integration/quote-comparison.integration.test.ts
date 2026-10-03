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

  it('aligns two real portal snapshots on seq, and keeps a drifted line’s own figure as a variant rather than discarding it', async () => {
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
      const rows = detail.rows as Array<Row & { description: string; origin: string; cells: Array<Row & { returnId: string; status: string; quotedTotal: number | null; levelledTotal: number | null; isAssumed: boolean; assumptionBasis: string | null }> }>;
      expect(rows).toHaveLength(4); // B's three-line bill, plus A's own variant of the roofing line

      const returns = detail.returns as Array<{ id: string; tenderer_name: string }>;
      const firmA = returns.find((r) => r.tenderer_name.startsWith('Firm A'))!;
      const firmB = returns.find((r) => r.tenderer_name.startsWith('Firm B'))!;

      const excavation = rows.find((r) => r.description === 'Excavate trial pits')!;
      const aOnExcavation = excavation.cells.find((c) => c.returnId === firmA.id)!;
      expect(aOnExcavation.status).toBe('priced');
      expect(aOnExcavation.quotedTotal).toBe(180); // matched cleanly by seq — 10 x 18

      const roofing = rows.find((r) => r.description === 'Supply and fix roof tiles')!;
      const aOnRoofing = roofing.cells.find((c) => c.returnId === firmA.id)!;
      // The drifted line — priced under A's own wording rather than discarded. The spine
      // cell says so and points at the variant row below it; nothing was guessed.
      expect(aOnRoofing.status).toBe('priced_as_variant');
      expect(aOnRoofing.quotedTotal).toBeNull();
      expect(aOnRoofing.levelledTotal).toBe(0); // the variant row below carries the real figure
      expect(aOnRoofing.isAssumed).toBe(true);
      expect(aOnRoofing.assumptionBasis).toContain('own wording');
      expect(aOnRoofing.assumptionBasis).toContain('roof SLATES');

      const bOnRoofing = roofing.cells.find((c) => c.returnId === firmB.id)!;
      expect(bOnRoofing.status).toBe('priced');
      expect(bOnRoofing.quotedTotal).toBe(6000); // 500 x 12, untouched by A's own wording

      const slateVariant = rows.find((r) => r.description === 'Supply and fix roof SLATES')!;
      expect(slateVariant.origin).toBe('tenderer_variant');
      const aOnVariant = slateVariant.cells.find((c) => c.returnId === firmA.id)!;
      expect(aOnVariant.status).toBe('priced');
      expect(aOnVariant.quotedTotal).toBe(7500); // 500 x 15 — A's own figure, finally counted
      const bOnVariant = slateVariant.cells.find((c) => c.returnId === firmB.id)!;
      expect(bOnVariant.status).toBe('absent'); // not theirs to have priced

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

  it('keeps exactly one variant across repeated refreshes, and carries it as the awarded tenderer’s own BoQ line', async () => {
    const { db, portalDb, tpDb } = connect();
    const f = await fixture(db, tpDb);
    try {
      // A real deadline, stamped and past — readiness only needs to allow approve() to run
      // at all; the variant behaviour is the same with 2 returns or 3.
      await db.query(`INSERT INTO itt_letter_details (workflow_id, tender_return_deadline) VALUES ($1, '2020-01-01')`, [f.workflowId]);

      const linkB = await portalDb.mintOrRefreshLink({
        shortlistEntryId: f.entryIds[0]!, workflowId: f.workflowId, packageName: f.packageName,
        subcontractorId: null, tendererName: 'Firm B (reference)', recipientEmail: 'b@example.com', isTest: true, ttlDays: 30
      });
      await portalDb.snapshotLines(linkB.id, [
        { sourceItemId: null, geCode: null, elementCode: null, description: 'Mobilisation', quantity: 1, unit: 'item', isPriceable: true },
        { sourceItemId: null, geCode: null, elementCode: null, description: 'Supply and fix roof tiles', quantity: 500, unit: 'm2', isPriceable: true },
        { sourceItemId: null, geCode: null, elementCode: null, description: 'Testing and commissioning', quantity: 1, unit: 'item', isPriceable: true }
      ]);
      await portalDb.saveDraft(linkB.id, {
        header: { programmeWeeks: null, qualifications: null, exclusions: null },
        lines: (await portalDb.getLines(linkB.id)).map((l, i) => ({ id: String(l.id), quantity: Number(l.quantity), rate: [200, 12, 1000][i]!, status: 'priced', note: null }))
      });
      await portalDb.submit(linkB.id);

      const linkA = await portalDb.mintOrRefreshLink({
        shortlistEntryId: f.entryIds[1]!, workflowId: f.workflowId, packageName: f.packageName,
        subcontractorId: null, tendererName: 'Firm A (older bill)', recipientEmail: 'a@example.com', isTest: true, ttlDays: 30
      });
      await portalDb.snapshotLines(linkA.id, [
        { sourceItemId: null, geCode: null, elementCode: null, description: 'Mobilisation', quantity: 1, unit: 'item', isPriceable: true },
        { sourceItemId: null, geCode: null, elementCode: null, description: 'Supply and fix roof SLATES', quantity: 500, unit: 'm2', isPriceable: true }
      ]);
      await portalDb.saveDraft(linkA.id, {
        header: { programmeWeeks: null, qualifications: null, exclusions: null },
        lines: (await portalDb.getLines(linkA.id)).map((l, i) => ({ id: String(l.id), quantity: Number(l.quantity), rate: [200, 10][i]!, status: 'priced', note: null }))
      });
      await portalDb.submit(linkA.id);

      await tpDb.openQuoteComparison(f.actor, f.workflowId, f.packageName);
      await tpDb.openQuoteComparison(f.actor, f.workflowId, f.packageName); // "Refresh", pressed twice more
      await tpDb.openQuoteComparison(f.actor, f.workflowId, f.packageName);

      const variantRows = await db.query<{ id: string }>(
        `SELECT r.id FROM tps.quote_comparison_rows r
           JOIN tps.quote_comparisons c ON c.id = r.comparison_id
          WHERE c.workflow_id = $1 AND c.package_name = $2 AND r.origin = 'tenderer_variant'`,
        [f.workflowId, f.packageName]
      );
      expect(variantRows).toHaveLength(1); // three refreshes of the same data, still exactly one variant

      const detail = await tpDb.getQuoteComparison(f.actor, f.workflowId, f.packageName);
      expect(detail.scopeNotes).toBeDefined(); // wired through getQuoteComparison, not just computed and dropped

      const returns = await db.query<{ id: string; tenderer_name: string }>(`SELECT id, tenderer_name FROM tender_returns WHERE workflow_id = $1`, [f.workflowId]);
      const firmA = returns.find((r) => r.tenderer_name.startsWith('Firm A'))!;

      // Firm A is cheaper on the roofing line (10 vs 12) but priced it under their own
      // wording — awarding them must carry THAT line, not a zero-value duplicate of the
      // spine's own wording for the same item.
      await tpDb.approveQuoteComparison(f.actor, f.workflowId, f.packageName, firmA.id, null);

      const boqLines = await db.query<{ description: string; approved_total: string | null }>(
        `SELECT description, approved_total FROM tender_boq_lines WHERE workflow_id = $1 AND package_name = $2 ORDER BY description`,
        [f.workflowId, f.packageName]
      );
      const descriptions = boqLines.map((l) => l.description);
      expect(descriptions).not.toContain('Supply and fix roof tiles'); // the spine line — skipped, the variant below carries the item
      expect(descriptions).toContain('Supply and fix roof SLATES');
      const roofingLine = boqLines.find((l) => l.description === 'Supply and fix roof SLATES')!;
      expect(Number(roofingLine.approved_total)).toBe(5000); // 500 x 10, Firm A's own figure
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
      // Firm A's own line was priced cleanly — no assumption, and no estimator override
      // (that is PR4's own addition) — so this reads 'approved', not '_with_adjustments'.
      expect(tradeAnalysis.status).toBe('approved');
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

  // ── Estimator rows (BuildFlow #100 follow-up: they never got cells at all) ───────────

  const mkPricedReturn = async (
    portalDb: PricingPortalDatabase, entryId: string, workflowId: string, packageName: string, name: string, email: string, rate: number
  ) => {
    const link = await portalDb.mintOrRefreshLink({
      shortlistEntryId: entryId, workflowId, packageName, subcontractorId: null,
      tendererName: name, recipientEmail: email, isTest: true, ttlDays: 30
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

  it('attaches a manual return keyed against an estimator-added row — the issue’s own example, "create a separate item"', async () => {
    const { db, portalDb, tpDb } = connect();
    const f = await fixture(db, tpDb);
    try {
      await mkPricedReturn(portalDb, f.entryIds[0]!, f.workflowId, f.packageName, 'Firm B', 'b@example.com', 100);
      const comparison = await tpDb.openQuoteComparison(f.actor, f.workflowId, f.packageName);
      const comparisonId = String(comparison.id);
      const estimatorRowResult = await tpDb.addQuoteComparisonRow(f.actor, f.workflowId, comparisonId, {
        description: 'Reconcile — Firm E’s own wording for the access scaffold', unit: 'item', quantity: 1
      });
      const estimatorRowId = String(estimatorRowResult.id);

      // A quote that arrived by email, keyed against the reconciliation row the estimator
      // is already looking at on screen — Firm E never used the portal at all.
      await tpDb.recordManualQuoteReturn(f.actor, f.workflowId, f.packageName, {
        tendererName: 'Firm E', subcontractorId: null, receivedAt: null, programmeWeeks: null, qualifications: null, exclusions: null,
        cells: [{ rowId: estimatorRowId, quantity: 1, rate: 300, status: 'priced', note: 'Confirmed by phone' }],
        extraLines: []
      });
      await tpDb.openQuoteComparison(f.actor, f.workflowId, f.packageName); // re-run refreshCells

      const detail = await tpDb.getQuoteComparison(f.actor, f.workflowId, f.packageName);
      const returns = detail.returns as Array<{ id: string; tenderer_name: string }>;
      const firmE = returns.find((r) => r.tenderer_name === 'Firm E')!;
      const rows = detail.rows as Array<Row & { id: string; cells: Array<{ returnId: string; status: string; quotedTotal: number | null }> }>;
      const row = rows.find((r) => String(r.id) === estimatorRowId)!;
      const cell = row.cells.find((c) => c.returnId === firmE.id)!;

      // Before the fix this line was silently dropped — its `seq` (assigned after the
      // whole ITT bill) never matched anything in the itt_bill-only lookup.
      expect(cell.status).toBe('priced');
      expect(cell.quotedTotal).toBe(300);
    } finally {
      await cleanup(db, f);
    }
  });

  it('awards a package carrying an estimator-added row nobody priced, without the tender_boq_lines CHECK rejecting "absent"', async () => {
    const { db, portalDb, tpDb } = connect();
    const f = await fixture(db, tpDb);
    try {
      await mkPricedReturn(portalDb, f.entryIds[0]!, f.workflowId, f.packageName, 'Firm B', 'b@example.com', 100);
      await mkPricedReturn(portalDb, f.entryIds[1]!, f.workflowId, f.packageName, 'Firm C', 'c@example.com', 110);
      await mkPricedReturn(portalDb, f.entryIds[2]!, f.workflowId, f.packageName, 'Firm D', 'd@example.com', 120);

      const comparison = await tpDb.openQuoteComparison(f.actor, f.workflowId, f.packageName);
      expect(comparison.readiness).toBe('quorum_met');

      // The issue's own example: a reconciliation item for a discrepancy — added, but
      // never priced by anyone. Every cell on this row reads `absent`, the awarded
      // tenderer's included, which is exactly what used to throw on award.
      await tpDb.addQuoteComparisonRow(f.actor, f.workflowId, String(comparison.id), {
        description: 'Reconcile — discrepancy on item 4', unit: 'item', quantity: 1
      });

      const returns = await db.query<{ id: string; tenderer_name: string }>(`SELECT id, tenderer_name FROM tender_returns WHERE workflow_id = $1`, [f.workflowId]);
      const firmB = returns.find((r) => r.tenderer_name === 'Firm B')!;

      const tradeAnalysis = await tpDb.approveQuoteComparison(f.actor, f.workflowId, f.packageName, firmB.id, null);
      // Automatic levelling filled the gap on the Reconcile row — that is the comparison
      // working as designed, not an estimator override (PR4's own addition), so this
      // reads 'approved'.
      expect(tradeAnalysis.status).toBe('approved');

      const boqLines = await db.query<{ description: string; status: string; adjusted: boolean }>(
        `SELECT description, status, adjusted FROM tender_boq_lines WHERE workflow_id = $1 AND package_name = $2`,
        [f.workflowId, f.packageName]
      );
      const reconcileLine = boqLines.find((l) => l.description.startsWith('Reconcile'))!;
      expect(reconcileLine.status).toBe('not_addressed'); // translated from 'absent' — the CHECK does not know that status
      expect(reconcileLine.adjusted).toBe(true);
    } finally {
      await cleanup(db, f);
    }
  });

  // ── A comparisonId is attacker-controlled input, not derived from workflowId ─────────

  it('refuses to touch a comparison, row or cell from another workflow, even by real ids', async () => {
    const { db, portalDb, tpDb } = connect();
    const f1 = await fixture(db, tpDb);
    const f2 = await fixture(db, tpDb);
    try {
      await mkPricedReturn(portalDb, f1.entryIds[0]!, f1.workflowId, f1.packageName, 'Firm B', 'b@example.com', 100);
      const comparison1 = await tpDb.openQuoteComparison(f1.actor, f1.workflowId, f1.packageName);
      const comparisonId1 = String(comparison1.id);
      const estimatorRowResult = await tpDb.addQuoteComparisonRow(f1.actor, f1.workflowId, comparisonId1, {
        description: 'Reconcile item', unit: 'item', quantity: 1
      });
      const estimatorRowId = String(estimatorRowResult.id);
      // Give it a real cell to try to reach, not just a row.
      await tpDb.recordManualQuoteReturn(f1.actor, f1.workflowId, f1.packageName, {
        tendererName: 'Firm E', subcontractorId: null, receivedAt: null, programmeWeeks: null, qualifications: null, exclusions: null,
        cells: [{ rowId: estimatorRowId, quantity: 1, rate: 300, status: 'priced', note: null }], extraLines: []
      });
      const detail1 = await tpDb.getQuoteComparison(f1.actor, f1.workflowId, f1.packageName);
      const row = (detail1.rows as Array<{ id: string; cells: Array<{ cellId: string | null }> }>).find((r) => r.id === estimatorRowId)!;
      const cellId = row.cells.find((c) => c.cellId)!.cellId!;

      // f2's actor has ordinary access to ITS OWN workflow — never to f1's — and tries
      // f1's comparison/row/cell ids under that cover.
      await expect(tpDb.addQuoteComparisonRow(f2.actor, f2.workflowId, comparisonId1, { description: 'x', unit: null, quantity: null }))
        .rejects.toThrow(/does not belong/);
      await expect(tpDb.deleteQuoteComparisonRow(f2.actor, f2.workflowId, comparisonId1, estimatorRowId)).rejects.toThrow();
      await expect(tpDb.updateQuoteComparisonCellNote(f2.actor, f2.workflowId, comparisonId1, cellId, 'hijacked note')).rejects.toThrow();

      // f1's own data is exactly as it was.
      const stillThere = await tpDb.getQuoteComparison(f1.actor, f1.workflowId, f1.packageName);
      const stillRow = (stillThere.rows as Array<{ id: string; cells: Array<{ estimatorNote: string | null }> }>).find((r) => r.id === estimatorRowId)!;
      expect(stillRow).toBeDefined();
      expect(stillRow.cells.every((c) => c.estimatorNote !== 'hijacked note')).toBe(true);
    } finally {
      await db.query(`DELETE FROM workflows WHERE id = ANY($1::uuid[])`, [[f1.workflowId, f2.workflowId]]);
      await db.close();
    }
  });

  // ── Final adjustments (BuildFlow #100's own closing step) ────────────────────────────

  it('sets, clears, and keeps a full history of an adjustment', async () => {
    const { db, portalDb, tpDb } = connect();
    const f = await fixture(db, tpDb);
    try {
      await mkPricedReturn(portalDb, f.entryIds[0]!, f.workflowId, f.packageName, 'Firm B', 'b@example.com', 100);
      await tpDb.openQuoteComparison(f.actor, f.workflowId, f.packageName);
      const detail = await tpDb.getQuoteComparison(f.actor, f.workflowId, f.packageName);
      const comparisonId = String((detail.comparison as Row).id);
      const cellId = (detail.rows as Array<{ cells: Array<{ cellId: string | null }> }>)[0]!.cells[0]!.cellId!;

      const set = await tpDb.setQuoteComparisonAdjustment(f.actor, f.workflowId, comparisonId, cellId, {
        rate: 90, total: null, reason: 'Confirmed by phone — firm will match 90/item.', queryId: null
      });
      expect(Number(set.adjusted_total)).toBe(90); // derived from rate x the row's own quantity (1)
      expect(Number(set.adjusted_rate)).toBe(90);

      const afterSet = await tpDb.getQuoteComparison(f.actor, f.workflowId, f.packageName);
      const cellAfterSet = (afterSet.rows as Array<{ cells: Array<{ levelledTotal: number | null; hasOverride: boolean; autoLevelledTotal: number | null }> }>)[0]!.cells[0]!;
      expect(cellAfterSet.levelledTotal).toBe(90); // the override, not the quoted 100
      expect(cellAfterSet.hasOverride).toBe(true);
      expect(cellAfterSet.autoLevelledTotal).toBe(100); // what it would have read without it

      const cleared = await tpDb.clearQuoteComparisonAdjustment(f.actor, f.workflowId, comparisonId, cellId, 'Reconsidered — their quote stands.');
      expect(cleared.adjusted_total).toBeNull();

      const history = await tpDb.quoteComparisonAdjustmentHistory(f.actor, f.workflowId, comparisonId, cellId);
      expect(history).toHaveLength(2);
      expect(history[0]!.action).toBe('cleared'); // newest first
      expect(history[1]!.action).toBe('set');
      expect(Number(history[1]!.new_total)).toBe(90);
      expect(Number(history[0]!.previous_total)).toBe(90);
    } finally {
      await cleanup(db, f);
    }
  });

  it('rejects an override with no stated reason, at the database itself', async () => {
    const { db, portalDb, tpDb } = connect();
    const f = await fixture(db, tpDb);
    try {
      await mkPricedReturn(portalDb, f.entryIds[0]!, f.workflowId, f.packageName, 'Firm B', 'b@example.com', 100);
      await tpDb.openQuoteComparison(f.actor, f.workflowId, f.packageName);
      const detail = await tpDb.getQuoteComparison(f.actor, f.workflowId, f.packageName);
      const cellId = (detail.rows as Array<{ cells: Array<{ cellId: string | null }> }>)[0]!.cells[0]!.cellId!;

      // Bypasses the route's own zod validation deliberately — the guarantee being
      // tested is the database's, not the application's.
      await expect(tpDb.setQuoteComparisonAdjustment(f.actor, f.workflowId, String((detail.comparison as Row).id), cellId, {
        rate: 90, total: null, reason: '', queryId: null
      })).rejects.toThrow();
    } finally {
      await cleanup(db, f);
    }
  });

  it('refuses an override on a spine cell priced under the tenderer’s own wording — adjust the variant row instead', async () => {
    const { db, portalDb, tpDb } = connect();
    const f = await fixture(db, tpDb);
    try {
      const linkB = await portalDb.mintOrRefreshLink({
        shortlistEntryId: f.entryIds[0]!, workflowId: f.workflowId, packageName: f.packageName,
        subcontractorId: null, tendererName: 'Firm B', recipientEmail: 'b@example.com', isTest: true, ttlDays: 30
      });
      await portalDb.snapshotLines(linkB.id, [
        { sourceItemId: null, geCode: null, elementCode: null, description: 'Mobilisation', quantity: 1, unit: 'item', isPriceable: true },
        { sourceItemId: null, geCode: null, elementCode: null, description: 'Supply and fix roof tiles', quantity: 500, unit: 'm2', isPriceable: true }
      ]);
      await portalDb.saveDraft(linkB.id, {
        header: { programmeWeeks: null, qualifications: null, exclusions: null },
        lines: (await portalDb.getLines(linkB.id)).map((l, i) => ({ id: String(l.id), quantity: Number(l.quantity), rate: [200, 12][i]!, status: 'priced', note: null }))
      });
      await portalDb.submit(linkB.id);

      const linkA = await portalDb.mintOrRefreshLink({
        shortlistEntryId: f.entryIds[1]!, workflowId: f.workflowId, packageName: f.packageName,
        subcontractorId: null, tendererName: 'Firm A', recipientEmail: 'a@example.com', isTest: true, ttlDays: 30
      });
      await portalDb.snapshotLines(linkA.id, [
        { sourceItemId: null, geCode: null, elementCode: null, description: 'Mobilisation', quantity: 1, unit: 'item', isPriceable: true },
        { sourceItemId: null, geCode: null, elementCode: null, description: 'Supply and fix roof SLATES', quantity: 500, unit: 'm2', isPriceable: true }
      ]);
      await portalDb.saveDraft(linkA.id, {
        header: { programmeWeeks: null, qualifications: null, exclusions: null },
        lines: (await portalDb.getLines(linkA.id)).map((l, i) => ({ id: String(l.id), quantity: Number(l.quantity), rate: [200, 10][i]!, status: 'priced', note: null }))
      });
      await portalDb.submit(linkA.id);

      await tpDb.openQuoteComparison(f.actor, f.workflowId, f.packageName);
      const detail = await tpDb.getQuoteComparison(f.actor, f.workflowId, f.packageName);
      const returns = detail.returns as Array<{ id: string; tenderer_name: string }>;
      const firmA = returns.find((r) => r.tenderer_name === 'Firm A')!;
      const spineRow = (detail.rows as Array<{ description: string; cells: Array<{ returnId: string; status: string; cellId: string | null }> }>)
        .find((r) => r.description === 'Supply and fix roof tiles')!;
      const spineCell = spineRow.cells.find((c) => c.returnId === firmA.id)!;
      expect(spineCell.status).toBe('priced_as_variant');

      await expect(tpDb.setQuoteComparisonAdjustment(f.actor, f.workflowId, String((detail.comparison as Row).id), spineCell.cellId!, {
        rate: null, total: 999, reason: 'x', queryId: null
      })).rejects.toThrow(/own wording/);
    } finally {
      await cleanup(db, f);
    }
  });

  it('refuses an award once an override has gone stale, and succeeds again once re-saved against the new quote', async () => {
    const { db, portalDb, tpDb } = connect();
    const f = await fixture(db, tpDb);
    try {
      await db.query(`INSERT INTO itt_letter_details (workflow_id, tender_return_deadline) VALUES ($1, '2020-01-01')`, [f.workflowId]);
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

      await tpDb.openQuoteComparison(f.actor, f.workflowId, f.packageName);
      const detail = await tpDb.getQuoteComparison(f.actor, f.workflowId, f.packageName);
      const comparisonId = String((detail.comparison as Row).id);
      const cellId = (detail.rows as Array<{ cells: Array<{ cellId: string | null }> }>)[0]!.cells[0]!.cellId!;
      const [ret] = await db.query<{ id: string }>(`SELECT id FROM tender_returns WHERE workflow_id = $1`, [f.workflowId]);

      await tpDb.setQuoteComparisonAdjustment(f.actor, f.workflowId, comparisonId, cellId, {
        rate: 90, total: null, reason: 'Confirmed by phone.', queryId: null
      });

      // The subcontractor resubmits at a different rate — refreshCells (run by the next
      // open()) updates quoted_rate/quoted_total, but never the adjusted_* columns, so
      // the override now disagrees with the figure it was set against.
      await db.query(`UPDATE tender_return_lines SET rate = 150, total = 150 WHERE return_id = $1`, [ret!.id]);
      await tpDb.openQuoteComparison(f.actor, f.workflowId, f.packageName);

      await expect(tpDb.approveQuoteComparison(f.actor, f.workflowId, f.packageName, String(ret!.id), null))
        .rejects.toThrow(/has since changed/);

      // Re-saving re-snapshots the current quote — that save IS the re-confirmation;
      // there is no separate "acknowledge" step.
      await tpDb.setQuoteComparisonAdjustment(f.actor, f.workflowId, comparisonId, cellId, {
        rate: 95, total: null, reason: 'Re-confirmed after resubmission.', queryId: null
      });

      const tradeAnalysis = await tpDb.approveQuoteComparison(f.actor, f.workflowId, f.packageName, String(ret!.id), null);
      expect(tradeAnalysis.status).toBe('approved_with_adjustments'); // the override, not automatic levelling, earns this

      const [boqLine] = await db.query<{ approved_rate: string; adjustment_note: string }>(
        `SELECT approved_rate, adjustment_note FROM tender_boq_lines WHERE workflow_id = $1 AND package_name = $2`,
        [f.workflowId, f.packageName]
      );
      expect(Number(boqLine!.approved_rate)).toBe(95);
      expect(boqLine!.adjustment_note).toContain('Adjusted: Re-confirmed after resubmission.');
    } finally {
      await cleanup(db, f);
    }
  });

  it('refuses to delete an estimator row while it still carries an adjustment', async () => {
    const { db, portalDb, tpDb } = connect();
    const f = await fixture(db, tpDb);
    try {
      await mkPricedReturn(portalDb, f.entryIds[0]!, f.workflowId, f.packageName, 'Firm B', 'b@example.com', 100);
      const comparison = await tpDb.openQuoteComparison(f.actor, f.workflowId, f.packageName);
      const comparisonId = String(comparison.id);
      const estimatorRow = await tpDb.addQuoteComparisonRow(f.actor, f.workflowId, comparisonId, {
        description: 'Reconcile item', unit: 'item', quantity: 1
      });
      const estimatorRowId = String(estimatorRow.id);

      await tpDb.recordManualQuoteReturn(f.actor, f.workflowId, f.packageName, {
        tendererName: 'Firm E', subcontractorId: null, receivedAt: null, programmeWeeks: null, qualifications: null, exclusions: null,
        cells: [{ rowId: estimatorRowId, quantity: 1, rate: 300, status: 'priced', note: null }], extraLines: []
      });
      const detail = await tpDb.getQuoteComparison(f.actor, f.workflowId, f.packageName);
      const row = (detail.rows as Array<{ id: string; cells: Array<{ cellId: string | null }> }>).find((r) => r.id === estimatorRowId)!;
      const cellId = row.cells.find((c) => c.cellId)!.cellId!;

      await tpDb.setQuoteComparisonAdjustment(f.actor, f.workflowId, comparisonId, cellId, {
        rate: 280, total: null, reason: 'Negotiated down.', queryId: null
      });

      await expect(tpDb.deleteQuoteComparisonRow(f.actor, f.workflowId, comparisonId, estimatorRowId)).rejects.toThrow(/adjustment/);
    } finally {
      await cleanup(db, f);
    }
  });

  it('refuses to set, clear or read adjustment history for a cell from another workflow', async () => {
    const { db, portalDb, tpDb } = connect();
    const f1 = await fixture(db, tpDb);
    const f2 = await fixture(db, tpDb);
    try {
      await mkPricedReturn(portalDb, f1.entryIds[0]!, f1.workflowId, f1.packageName, 'Firm B', 'b@example.com', 100);
      const comparison1 = await tpDb.openQuoteComparison(f1.actor, f1.workflowId, f1.packageName);
      const detail1 = await tpDb.getQuoteComparison(f1.actor, f1.workflowId, f1.packageName);
      const cellId1 = (detail1.rows as Array<{ cells: Array<{ cellId: string | null }> }>)[0]!.cells[0]!.cellId!;

      await expect(tpDb.setQuoteComparisonAdjustment(f2.actor, f2.workflowId, String(comparison1.id), cellId1, {
        rate: 1, total: null, reason: 'x', queryId: null
      })).rejects.toThrow();
      await expect(tpDb.clearQuoteComparisonAdjustment(f2.actor, f2.workflowId, String(comparison1.id), cellId1, 'x')).rejects.toThrow();
      const history = await tpDb.quoteComparisonAdjustmentHistory(f2.actor, f2.workflowId, String(comparison1.id), cellId1);
      expect(history).toHaveLength(0);
    } finally {
      await db.query(`DELETE FROM workflows WHERE id = ANY($1::uuid[])`, [[f1.workflowId, f2.workflowId]]);
      await db.close();
    }
  });
});

