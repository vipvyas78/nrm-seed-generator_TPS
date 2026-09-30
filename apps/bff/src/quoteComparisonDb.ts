import type { PoolClient } from 'pg';
import type { Database, Row } from './db.js';
import { conflict, notFound } from './errors.js';
import { knownReturnDeadlineSql } from './tenderReturnPeriod.js';

/**
 * The levelled quote comparison (BuildFlow issue #100) — read side, levelling and
 * approval for `tps.quote_comparisons` / `_rows` / `_cells` (migration 028).
 *
 * Standalone, taking the `Database` explicitly — the same separation `pricingPortalDb.ts`
 * and `boqReadDb.ts` already keep from `tenderPrepDb.ts`, which is 5,000+ lines. It knows
 * nothing about actors or workflow authorisation; `tenderPrepDb.ts` wraps every method
 * here with `assertWorkflowAccess` first, the same convention it already uses for
 * `PricingPortalDatabase`.
 *
 * THE SPINE. A comparison's spine is the bill every tenderer was actually sent, and the
 * one place that bill already lives, line for line with a stable `seq`, is
 * `tps.pricing_portal_lines` — every invited firm gets one at MINT time
 * (`PricingPortalDatabase.snapshotLines`), whether or not they ever open the link. Reading
 * it here rather than re-deriving the bill from `getPackageItt`/`assemblePackageForEmail`
 * is deliberate: `tenderPrepDb.ts` already owns that assembly, and a second implementation
 * of it here would be a second opinion about what a package's bill contains.
 *
 * TWO CAVEATS THAT SHAPE `buildSpine`. First, not every firm invited to one package is
 * necessarily looking at the same snapshot — `mintOrRefreshLink` never touches an
 * existing link's lines, so a firm invited after a bill change is pricing a different
 * bill from one invited before it, and `seq` is only a safe cross-tenderer key within ONE
 * snapshot. Second, a firm's own added lines (`added_by_tenderer`) get a `seq` too — the
 * next number after their snapshot ends — so two different firms' additions can collide
 * on the same `seq` while being two unrelated lines. `buildSpine` picks the LARGEST
 * snapshot (the fullest one — the same "fullest ladder wins" rule this codebase's
 * take-off pipeline uses for storey height) as the reference, and any OTHER return's line
 * is matched to it by `seq` only among that return's non-added lines, with description and
 * unit required to agree — a mismatch is reported on the cell (see `upsertCell`) rather
 * than silently mis-paired.
 */

// ─────────────────────────────────────────────────────────────── pure levelling rules

export type ReturnLineStatus = 'priced' | 'included' | 'excluded' | 'not_addressed';
export type CellStatus = ReturnLineStatus | 'absent';
export type ComparisonReadiness = 'awaiting_returns' | 'quorum_met' | 'deadline_passed';

/** The issue's own number: "app should expect at least three quotes." */
export const QUOTE_QUORUM = 3;

/**
 * Whether the comparison is ready to approve — never whether it may be VIEWED. An
 * estimator will open this long before it is ready, and a screen that refuses to render
 * early is not what was asked for; only the approve action reads this.
 *
 * `quorum_met` outranks a passed deadline in the other direction too: three returns in
 * hand is ready regardless of what the calendar says. Reaching either condition is enough
 * — the issue's "expect at least three … however, if the time has passed, consider
 * whatever it has" describes two independent ways to become ready, not a sequence.
 */
export function computeReadiness(receivedCount: number, deadline: Date | null, now: Date): ComparisonReadiness {
  if (receivedCount >= QUOTE_QUORUM) return 'quorum_met';
  if (deadline && now.getTime() > deadline.getTime()) return 'deadline_passed';
  return 'awaiting_returns';
}

export function moneyGBP(amount: number): string {
  return `£${amount.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The cheapest QUOTED figure for one spine row, across every return being compared. Keyed
 * on TOTAL rather than rate: a tenderer may price their own quantity on a line (the portal
 * allows it), so two tenderers' rates for the same row are not always for the same
 * quantity, and total is the number that actually costs money. */
export interface LowestQuote {
  rate: number | null;
  total: number;
  tendererName: string;
}

export interface LevelledCell {
  status: CellStatus;
  levelledRate: number | null;
  levelledTotal: number | null;
  isAssumed: boolean;
  assumptionBasis: string | null;
}

/**
 * One cell of the grid — what a single tenderer's return says (or does not say) about one
 * spine row, turned into what the comparison carries.
 *
 * `lineStatus: null` means this return has no line at all for this row — never submitted
 * one, or submitted after the row was added to the spine as another tenderer's addition.
 * That is `absent`, not `not_addressed`: the tenderer never had the chance to address it.
 */
export function levelCell(input: {
  lineStatus: ReturnLineStatus | null;
  quotedRate: number | null;
  quotedTotal: number | null;
  lowest: LowestQuote | null;
}): LevelledCell {
  const substitute = (reason: string, status: CellStatus): LevelledCell => {
    if (!input.lowest) {
      return { status, levelledRate: null, levelledTotal: null, isAssumed: true, assumptionBasis: `${reason} No tenderer priced this item.` };
    }
    return {
      status, levelledRate: input.lowest.rate, levelledTotal: input.lowest.total, isAssumed: true,
      assumptionBasis: `${reason} Levelled at the lowest quoted price (${input.lowest.tendererName}, ${moneyGBP(input.lowest.total)}).`
    };
  };

  if (input.lineStatus === null) return substitute('Not in this tenderer’s return.', 'absent');
  if (input.lineStatus === 'included') {
    return { status: 'included', levelledRate: 0, levelledTotal: 0, isAssumed: true,
             assumptionBasis: 'Stated included in the price, with no separate rate given.' };
  }
  if (input.lineStatus === 'excluded') return substitute('Excluded by this tenderer.', 'excluded');
  if (input.lineStatus === 'not_addressed') return substitute('Not addressed by this tenderer.', 'not_addressed');

  // 'priced'. A status the tenderer chose but backed with no figure carries no more
  // evidence than not addressing it — the substitution applies, but `status` still
  // reports what they actually said, which is why it is not folded into the branch above.
  if (input.quotedTotal == null) return substitute('Marked priced but no rate was given.', 'priced');
  return { status: 'priced', levelledRate: input.quotedRate, levelledTotal: input.quotedTotal, isAssumed: false, assumptionBasis: null };
}

/** The cheapest priced figure for one row, or null where nobody priced it at all. */
export function findLowestQuote(quotes: Array<{ total: number | null; rate: number | null; tendererName: string }>): LowestQuote | null {
  let lowest: LowestQuote | null = null;
  for (const q of quotes) {
    if (q.total == null) continue;
    if (!lowest || q.total < lowest.total) lowest = { rate: q.rate, total: q.total, tendererName: q.tendererName };
  }
  return lowest;
}

/**
 * `tender_boq_lines.status` (008) only ever allowed the four statuses a tenderer can
 * actually choose — it predates `absent`, which `quote_comparison_cells` added for a row
 * a tenderer never had the chance to address at all (an estimator's own reconciliation
 * row, or a short return). Awarding such a row is not a status the CHECK recognises, so
 * this is the one place `absent` must be translated rather than carried through verbatim
 * — into `not_addressed`, which is what it is from the awarded firm's own bill's point of
 * view: a line they did not price, for whatever reason.
 */
export function boqStatusFor(status: CellStatus): ReturnLineStatus {
  return status === 'absent' ? 'not_addressed' : status;
}

/** One tenderer's two totals — what they actually quoted, and what the comparison
 * carries once every gap is levelled. The gap between them IS the point of the stage:
 * the cheapest substitution flatters whoever omitted the most, so the two must both be
 * visible rather than blended into one number. */
export function sumTotals(cells: Array<{ status: CellStatus; quotedTotal: number | null; levelledTotal: number | null }>): {
  quotedSum: number; levelledSum: number; pricedCount: number; assumedCount: number;
} {
  let quotedSum = 0, levelledSum = 0, pricedCount = 0, assumedCount = 0;
  for (const cell of cells) {
    if (cell.status === 'priced' && cell.quotedTotal != null) { quotedSum += cell.quotedTotal; pricedCount += 1; }
    else assumedCount += 1;
    if (cell.levelledTotal != null) levelledSum += cell.levelledTotal;
  }
  return { quotedSum, levelledSum, pricedCount, assumedCount };
}

// ──────────────────────────────────────────────────────────────────── the database

export interface ManualReturnInput {
  tendererName: string;
  subcontractorId: string | null;
  receivedAt: string | null;
  programmeWeeks: number | null;
  qualifications: string | null;
  exclusions: string | null;
  cells: Array<{ rowId: string; quantity: number | null; rate: number | null; status: ReturnLineStatus; note: string | null }>;
  extraLines: Array<{ description: string; unit: string | null; quantity: number | null; rate: number | null; status: ReturnLineStatus; note: string | null }>;
}

export class QuoteComparisonDatabase {
  constructor(private readonly db: Database) {}

  /** Every package this workflow has shortlisted, with live counts and readiness — before
   * any comparison has been opened, so an estimator can see which packages are worth
   * opening without pressing into each one first. */
  async summariesForWorkflow(workflowId: string): Promise<Row[]> {
    const rows = await this.db.query<Row>(
      `SELECT sl.package_name,
              qc.id AS comparison_id, qc.opened_at,
              (SELECT COUNT(*)::int FROM shortlist_entries se WHERE se.shortlist_id = sl.id AND se.selected) AS expected_count,
              (SELECT COUNT(*)::int FROM tender_returns tr WHERE tr.workflow_id = sl.workflow_id AND tr.package_name = sl.package_name) AS received_count,
              ${knownReturnDeadlineSql('sl', 'ld')} AS return_deadline
         FROM shortlists sl
         LEFT JOIN itt_letter_details ld ON ld.workflow_id = sl.workflow_id
         LEFT JOIN tps.quote_comparisons qc ON qc.workflow_id = sl.workflow_id AND qc.package_name = sl.package_name
        WHERE sl.workflow_id = $1 AND sl.confirmed_at IS NOT NULL
        ORDER BY sl.package_name`,
      [workflowId]
    );
    const now = new Date();
    return rows.map((row) => {
      const deadline = row.return_deadline ? new Date(String(row.return_deadline)) : null;
      return { ...row, readiness: computeReadiness(Number(row.received_count), deadline, now) };
    });
  }

  /**
   * Opens a package's comparison, or refreshes one already opened.
   *
   * The spine is built ONCE, the first time — see `buildSpine`. Every call after that
   * only adds cells for returns not yet reflected and upserts the rest, so a repeat call
   * ("Refresh" on the screen, or a re-open days later) never destroys an estimator's own
   * added rows or their notes. Readiness and the counts on the header row are recomputed
   * every time, since those are meant to move as returns come in.
   */
  async open(workflowId: string, packageName: string, openedBy: string | null): Promise<Row> {
    return this.db.transaction(async (client) => {
      const [existing] = await this.db.query<Row>(
        `SELECT * FROM tps.quote_comparisons WHERE workflow_id = $1 AND package_name = $2 FOR UPDATE`,
        [workflowId, packageName], client
      );
      const returns = await this.db.query<Row>(
        `SELECT * FROM tender_returns WHERE workflow_id = $1 AND package_name = $2 ORDER BY received_at`,
        [workflowId, packageName], client
      );
      const comparisonId = existing ? String(existing.id) : await this.create(client, workflowId, packageName, openedBy);

      const [{ n: spineCount }] = await this.db.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM tps.quote_comparison_rows WHERE comparison_id = $1`, [comparisonId], client
      );
      if (spineCount === '0') await this.buildSpine(client, comparisonId, workflowId, packageName, returns);
      await this.refreshCells(client, comparisonId, returns);
      await this.updateReadiness(client, comparisonId, workflowId, packageName);

      const [row] = await this.db.query<Row>(`SELECT * FROM tps.quote_comparisons WHERE id = $1`, [comparisonId], client);
      return row!;
    });
  }

  private async create(client: PoolClient, workflowId: string, packageName: string, openedBy: string | null): Promise<string> {
    const [row] = await this.db.query<{ id: string }>(
      `INSERT INTO tps.quote_comparisons (workflow_id, package_name, opened_by) VALUES ($1, $2, $3) RETURNING id`,
      [workflowId, packageName, openedBy], client
    );
    return row!.id;
  }

  /**
   * The spine, built once from the fullest snapshot on file — see this file's header for
   * why `pricing_portal_lines` is the source and why "fullest" is the tie-break. Falls
   * back to the fullest MANUAL return's lines when no portal snapshot exists for this
   * package at all (the portal was never used, or every send was blocked).
   */
  private async buildSpine(client: PoolClient, comparisonId: string, workflowId: string, packageName: string, returns: Row[]): Promise<void> {
    const portalLines = await this.db.query<Row>(
      `SELECT pl.link_id, pl.seq, pl.ge_code, pl.element_code, pl.description, pl.quantity, pl.unit, pl.is_priceable
         FROM tps.pricing_portal_lines pl
         JOIN tps.pricing_portal_links lk ON lk.id = pl.link_id
        WHERE lk.workflow_id = $1 AND lk.package_name = $2 AND NOT pl.added_by_tenderer
        ORDER BY pl.link_id, pl.seq`,
      [workflowId, packageName], client
    );

    let source: Row[] | null = null;
    if (portalLines.length > 0) {
      const byLink = new Map<string, Row[]>();
      for (const line of portalLines) {
        const key = String(line.link_id);
        const list = byLink.get(key) ?? [];
        list.push(line);
        byLink.set(key, list);
      }
      for (const list of byLink.values()) if (!source || list.length > source.length) source = list;
    }

    if (!source) {
      const [fullest] = await this.db.query<{ return_id: string }>(
        `SELECT return_id FROM tender_return_lines
          WHERE return_id = ANY($1::uuid[]) AND NOT added_by_tenderer
          GROUP BY return_id ORDER BY COUNT(*) DESC LIMIT 1`,
        [returns.map((r) => r.id)], client
      );
      if (!fullest) {
        throw conflict('No returns have been submitted or entered for this package yet — there is nothing to build a comparison from.');
      }
      const manualLines = await this.db.query<Row>(
        `SELECT seq, ge_code, element_code, description, quantity, unit
           FROM tender_return_lines WHERE return_id = $1 AND NOT added_by_tenderer ORDER BY seq NULLS LAST, created_at`,
        [fullest.return_id], client
      );
      // A manual return's lines may carry no seq at all (the estimator keys them straight
      // against spine rows once one exists — see recordManualReturn); assign one here so
      // the spine still has a stable, gapless ordering.
      source = manualLines.map((row, index) => ({ ...row, seq: row.seq ?? index + 1, is_priceable: true }));
    }

    if (source.length === 0) throw conflict('The bill on file for this package has no lines to compare.');

    await this.db.query(
      `INSERT INTO tps.quote_comparison_rows
         (comparison_id, seq, ge_code, element_code, description, quantity, unit, is_priceable, origin)
       SELECT $1, s, ge, el, descr, qty, unit, priceable, 'itt_bill'
         FROM unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::numeric[], $7::text[], $8::boolean[])
           AS t(s, ge, el, descr, qty, unit, priceable)`,
      [comparisonId, source.map((l) => l.seq), source.map((l) => l.ge_code), source.map((l) => l.element_code),
       source.map((l) => l.description), source.map((l) => l.quantity), source.map((l) => l.unit),
       source.map((l) => l.is_priceable ?? true)],
      client
    );
  }

  /** Adds a spine row for any return's own extra line not already reflected, and
   * upserts every cell — never touching `estimator_note`, the one field a human owns. */
  private async refreshCells(client: PoolClient, comparisonId: string, returns: Row[]): Promise<void> {
    const spineRows = await this.db.query<Row>(
      `SELECT * FROM tps.quote_comparison_rows WHERE comparison_id = $1 ORDER BY seq`, [comparisonId], client
    );
    const byId = new Map(spineRows.map((r) => [String(r.id), r]));
    // `seq` is only a safe key among the ORIGINAL bill rows (see this file's header) — a
    // row added after the fact (tenderer- or estimator-added) is assigned the next free
    // seq once, which a later addition can reuse no differently from any other integer.
    // A manual return keyed in by hand instead carries `comparison_row_id` (see
    // `recordManualReturn`), pointing at the exact row the estimator typed the figure
    // against; `seq` remains the fallback for lines that never went through that path
    // (a portal submission, or data written before this column existed).
    const bySeq = new Map(spineRows.filter((r) => r.origin === 'itt_bill').map((r) => [Number(r.seq), r]));

    for (const ret of returns) {
      const lines = await this.db.query<Row>(
        `SELECT * FROM tender_return_lines WHERE return_id = $1 ORDER BY seq NULLS LAST, created_at`, [ret.id], client
      );
      for (const line of lines) {
        if (line.added_by_tenderer) {
          // This tenderer's own extra line. Dedup on content within this return, since a
          // synthetic identity would need a column this table does not carry (see this
          // file's header) — a genuine duplicate description just costs one spare row.
          const [existingRow] = await this.db.query<{ id: string }>(
            `SELECT id FROM tps.quote_comparison_rows
              WHERE comparison_id = $1 AND added_by_return_id = $2 AND description = $3 AND COALESCE(unit,'') = COALESCE($4,'')`,
            [comparisonId, ret.id, line.description, line.unit], client
          );
          let rowId = existingRow?.id;
          if (!rowId) {
            const [{ n: maxSeq }] = await this.db.query<{ n: string }>(
              `SELECT COALESCE(MAX(seq), 0)::text AS n FROM tps.quote_comparison_rows WHERE comparison_id = $1`, [comparisonId], client
            );
            const [created] = await this.db.query<{ id: string }>(
              `INSERT INTO tps.quote_comparison_rows
                 (comparison_id, seq, ge_code, element_code, description, quantity, unit, is_priceable, origin, added_by_return_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, 'tenderer_added', $8) RETURNING id`,
              [comparisonId, Number(maxSeq) + 1, line.ge_code, line.element_code, line.description, line.quantity, line.unit, ret.id],
              client
            );
            rowId = created!.id;
          }
          await this.upsertCell(client, rowId, String(ret.id), line);
          continue;
        }

        const row = (line.comparison_row_id ? byId.get(String(line.comparison_row_id)) : undefined)
          ?? (line.seq != null ? bySeq.get(Number(line.seq)) : undefined);
        if (!row) continue; // No seq, or beyond the reference bill's own length — nothing to attach to.
        const mismatched = row.description !== line.description || (row.unit ?? null) !== (line.unit ?? null);
        await this.upsertCell(client, String(row.id), String(ret.id), line, mismatched
          ? `This tenderer’s own line here (“${line.description}”) does not match the reference bill line (“${row.description}”) — reconcile by hand.`
          : null);
      }
      // A return with fewer lines than the spine has rows it never even listed — those
      // stay `absent` at read time (getComparison) rather than a manufactured row here;
      // there is nothing to upsert for a line that does not exist.
    }
  }

  private async upsertCell(client: PoolClient, rowId: string, returnId: string, line: Row, mismatchNote: string | null = null): Promise<void> {
    if (mismatchNote) {
      await this.db.query(
        `INSERT INTO tps.quote_comparison_cells (row_id, return_id, quoted_rate, quoted_total, status, is_assumed, assumption_basis, tenderer_note)
         VALUES ($1, $2, NULL, NULL, 'not_addressed', TRUE, $3, $4)
         ON CONFLICT (row_id, return_id) DO UPDATE SET
           quoted_rate = NULL, quoted_total = NULL, status = 'not_addressed', is_assumed = TRUE,
           assumption_basis = EXCLUDED.assumption_basis, tenderer_note = EXCLUDED.tenderer_note, updated_at = NOW()`,
        [rowId, returnId, mismatchNote, line.note], client
      );
      return;
    }
    await this.db.query(
      `INSERT INTO tps.quote_comparison_cells (row_id, return_id, quoted_rate, quoted_total, status, is_assumed, assumption_basis, tenderer_note)
       VALUES ($1, $2, $3, $4, $5, FALSE, NULL, $6)
       ON CONFLICT (row_id, return_id) DO UPDATE SET
         quoted_rate = EXCLUDED.quoted_rate, quoted_total = EXCLUDED.quoted_total, status = EXCLUDED.status,
         is_assumed = FALSE, assumption_basis = NULL, tenderer_note = EXCLUDED.tenderer_note, updated_at = NOW()`,
      [rowId, returnId, line.rate, line.total, line.status, line.note], client
    );
  }

  private async updateReadiness(client: PoolClient, comparisonId: string, workflowId: string, packageName: string): Promise<void> {
    const [counts] = await this.db.query<Row>(
      `SELECT (SELECT COUNT(*)::int FROM shortlists sl JOIN shortlist_entries se ON se.shortlist_id = sl.id AND se.selected
                WHERE sl.workflow_id = $1 AND sl.package_name = $2) AS expected_count,
              (SELECT COUNT(*)::int FROM tender_returns tr WHERE tr.workflow_id = $1 AND tr.package_name = $2) AS received_count,
              ${knownReturnDeadlineSql('sl', 'ld')} AS return_deadline
         FROM shortlists sl LEFT JOIN itt_letter_details ld ON ld.workflow_id = sl.workflow_id
        WHERE sl.workflow_id = $1 AND sl.package_name = $2`,
      [workflowId, packageName], client
    );
    const deadline = counts?.return_deadline ? new Date(String(counts.return_deadline)) : null;
    const received = Number(counts?.received_count ?? 0);
    const readiness = computeReadiness(received, deadline, new Date());
    await this.db.query(
      `UPDATE tps.quote_comparisons
          SET expected_count = $2, received_count = $3, return_deadline = $4, readiness = $5, updated_at = NOW()
        WHERE id = $1`,
      [comparisonId, Number(counts?.expected_count ?? 0), received, deadline ? deadline.toISOString().slice(0, 10) : null, readiness],
      client
    );
  }

  /** The full grid: every spine row, every return's cell for it (or `absent`, for none),
   * the Lowest column, and each tenderer's two totals. */
  async getComparison(workflowId: string, packageName: string): Promise<Row> {
    return this.computeGrid(workflowId, packageName);
  }

  /**
   * The actual grid-building logic, shared by `getComparison` (reads the live pool) and
   * `approve` (reads inside its own transaction, so what is approved cannot be a moment
   * behind what was on screen). `levelled_rate`/`levelled_total` are NEVER persisted on
   * `quote_comparison_cells` — they depend on the LOWEST quote across every OTHER return
   * for the same row, which is not known until every return is read together, so this is
   * the one and only place that computation happens. `approve` reading the raw table
   * directly, rather than through here, is exactly the bug this shape exists to prevent.
   */
  private async computeGrid(workflowId: string, packageName: string, client?: PoolClient): Promise<Row> {
    const [comparison] = await this.db.query<Row>(
      `SELECT * FROM tps.quote_comparisons WHERE workflow_id = $1 AND package_name = $2`, [workflowId, packageName], client
    );
    if (!comparison) throw notFound('This package’s comparison has not been opened yet.');

    const returns = await this.db.query<Row>(
      `SELECT * FROM tender_returns WHERE workflow_id = $1 AND package_name = $2 ORDER BY received_at`,
      [workflowId, packageName], client
    );
    const rows = await this.db.query<Row>(`SELECT * FROM tps.quote_comparison_rows WHERE comparison_id = $1 ORDER BY seq`, [comparison.id], client);
    const cells = await this.db.query<Row>(
      `SELECT c.* FROM tps.quote_comparison_cells c
         JOIN tps.quote_comparison_rows r ON r.id = c.row_id
        WHERE r.comparison_id = $1`,
      [comparison.id], client
    );
    const cellsByRow = new Map<string, Row[]>();
    for (const cell of cells) {
      const list = cellsByRow.get(String(cell.row_id)) ?? [];
      list.push(cell);
      cellsByRow.set(String(cell.row_id), list);
    }

    type GridCell = {
      returnId: string; status: CellStatus; levelledRate: number | null; levelledTotal: number | null;
      isAssumed: boolean; assumptionBasis: string | null; tendererNote: string | null; estimatorNote: string | null;
      cellId: string | null; quotedRate: number | null; quotedTotal: number | null;
    };

    const grid = rows.map((row) => {
      const present = cellsByRow.get(String(row.id)) ?? [];
      const byReturn = new Map(present.map((c) => [String(c.return_id), c]));
      const lowest = findLowestQuote(
        present.filter((c) => c.status === 'priced' && c.quoted_total != null)
          .map((c) => ({
            total: Number(c.quoted_total), rate: c.quoted_rate != null ? Number(c.quoted_rate) : null,
            tendererName: String(returns.find((r) => String(r.id) === String(c.return_id))?.tenderer_name ?? '')
          }))
      );

      const levelledCells: GridCell[] = returns.map((ret) => {
        const returnId = String(ret.id);
        // A tenderer-added row is, by construction, absent for every OTHER tenderer.
        if (row.origin === 'tenderer_added' && String(row.added_by_return_id) !== returnId) {
          const l = levelCell({ lineStatus: null, quotedRate: null, quotedTotal: null, lowest: null });
          return { returnId, ...l, tendererNote: null, estimatorNote: null, cellId: null, quotedRate: null, quotedTotal: null };
        }
        const existing = byReturn.get(returnId);
        if (existing && typeof existing.assumption_basis === 'string' && existing.assumption_basis.includes('reconcile by hand')) {
          // A seq collision the reference bill did not expect — surfaced as-is, not
          // re-levelled, since there is nothing safe to substitute for a line that may not
          // even be the same item.
          return {
            returnId, status: 'not_addressed', levelledRate: null, levelledTotal: null,
            isAssumed: true, assumptionBasis: existing.assumption_basis,
            tendererNote: (existing.tenderer_note as string | null) ?? null, estimatorNote: (existing.estimator_note as string | null) ?? null,
            cellId: String(existing.id), quotedRate: null, quotedTotal: null
          };
        }
        const levelled = levelCell({
          lineStatus: (existing?.status as ReturnLineStatus | undefined) ?? null,
          quotedRate: existing?.quoted_rate != null ? Number(existing.quoted_rate) : null,
          quotedTotal: existing?.quoted_total != null ? Number(existing.quoted_total) : null,
          lowest
        });
        return {
          returnId, ...levelled,
          tendererNote: (existing?.tenderer_note as string | null) ?? null, estimatorNote: (existing?.estimator_note as string | null) ?? null,
          cellId: existing?.id ? String(existing.id) : null,
          quotedRate: existing?.quoted_rate != null ? Number(existing.quoted_rate) : null,
          quotedTotal: existing?.quoted_total != null ? Number(existing.quoted_total) : null
        };
      });
      return { ...row, lowest, cells: levelledCells };
    });

    const totals = returns.map((ret) => {
      const returnId = String(ret.id);
      const summed = sumTotals(grid.map((row) => {
        const cell = row.cells.find((c) => c.returnId === returnId)!;
        return { status: cell.status, quotedTotal: cell.quotedTotal, levelledTotal: cell.levelledTotal };
      }));
      return { returnId, tendererName: ret.tenderer_name, ...summed };
    });

    return { comparison, returns, rows: grid, totals };
  }

  /**
   * A `comparisonId` arrives from the request body, not derived from `workflowId` the way
   * `packageName` is on every other route here — so every method taking one must confirm
   * it actually belongs to that workflow before touching it, or a caller with access to
   * one tender could reach another's comparison by id alone. Folded into each statement's
   * own WHERE/EXISTS below rather than a separate round trip.
   */
  async updateCellNote(workflowId: string, comparisonId: string, cellId: string, estimatorNote: string | null): Promise<Row> {
    const [row] = await this.db.query<Row>(
      `UPDATE tps.quote_comparison_cells c SET estimator_note = $4, updated_at = NOW()
         FROM tps.quote_comparison_rows r, tps.quote_comparisons qc
        WHERE c.id = $3 AND c.row_id = r.id AND r.comparison_id = $2 AND qc.id = r.comparison_id AND qc.workflow_id = $1
        RETURNING c.*`,
      [workflowId, comparisonId, cellId, estimatorNote]
    );
    if (!row) throw notFound('Comparison cell not found');
    return row;
  }

  /** An estimator's own line — e.g. to price a discrepancy the issue names directly:
   * "if there is a slight discrepancy … create a separate item describing the pricing." */
  async addEstimatorRow(workflowId: string, comparisonId: string, input: { description: string; unit: string | null; quantity: number | null }): Promise<Row> {
    const [row] = await this.db.query<Row>(
      `INSERT INTO tps.quote_comparison_rows (comparison_id, seq, description, unit, quantity, is_priceable, origin)
       SELECT $2, COALESCE((SELECT MAX(seq) FROM tps.quote_comparison_rows WHERE comparison_id = $2), 0) + 1,
              $3, $4, $5, TRUE, 'estimator_added'
        WHERE EXISTS (SELECT 1 FROM tps.quote_comparisons WHERE id = $2 AND workflow_id = $1)
       RETURNING *`,
      [workflowId, comparisonId, input.description, input.unit, input.quantity]
    );
    if (!row) throw notFound('This comparison does not belong to that tender.');
    return row;
  }

  async deleteEstimatorRow(workflowId: string, comparisonId: string, rowId: string): Promise<void> {
    const deleted = await this.db.query(
      `DELETE FROM tps.quote_comparison_rows r USING tps.quote_comparisons qc
        WHERE r.id = $3 AND r.comparison_id = $2 AND r.origin = 'estimator_added'
          AND qc.id = r.comparison_id AND qc.workflow_id = $1
        RETURNING r.id`,
      [workflowId, comparisonId, rowId]
    );
    if (deleted.length === 0) throw notFound('No estimator-added row to delete with that id.');
  }

  /**
   * A return keyed in by hand — a quote that arrived as an emailed spreadsheet rather
   * than through the portal. Written against the SPINE directly (`cells[].rowId`), which
   * is what makes this safe with no fuzzy matching: the estimator is looking at the grid
   * and typing figures against rows they can already see, not asking the app to guess
   * which bill line a typed description means.
   *
   * Promotes into `tender_returns`/`tender_return_lines` too, so this return is
   * indistinguishable from a portal one to every downstream reader — the draft BoQ
   * trigger, the launch table, a future re-open of this same comparison.
   */
  async recordManualReturn(workflowId: string, packageName: string, comparisonId: string, input: ManualReturnInput): Promise<Row> {
    return this.db.transaction(async (client) => {
      const [ret] = await this.db.query<{ id: string }>(
        `INSERT INTO tender_returns
           (workflow_id, package_name, subcontractor_id, tenderer_name, received_at,
            programme_weeks, qualifications, exclusions, is_fabricated)
         VALUES ($1,$2,$3,$4, COALESCE($5::timestamptz, NOW()), $6,$7,$8, FALSE)
         ON CONFLICT (workflow_id, package_name, tenderer_name) DO UPDATE
           SET received_at = EXCLUDED.received_at, programme_weeks = EXCLUDED.programme_weeks,
               qualifications = EXCLUDED.qualifications, exclusions = EXCLUDED.exclusions, is_fabricated = FALSE
         RETURNING id`,
        [workflowId, packageName, input.subcontractorId, input.tendererName, input.receivedAt,
         input.programmeWeeks, input.qualifications, input.exclusions],
        client
      );

      await this.db.query(`DELETE FROM tender_return_lines WHERE return_id = $1`, [ret!.id], client);

      const spineRows = await this.db.query<Row>(`SELECT * FROM tps.quote_comparison_rows WHERE comparison_id = $1`, [comparisonId], client);
      const bySpineId = new Map(spineRows.map((r) => [String(r.id), r]));

      const lineValues: { seq: number; ge: string | null; el: string | null; descr: string; qty: number | null;
        unit: string | null; rate: number | null; total: number | null; status: string; note: string | null;
        added: boolean; rowId: string | null }[] = [];

      for (const cell of input.cells) {
        const spine = bySpineId.get(cell.rowId);
        if (!spine) throw notFound(`No comparison row with id ${cell.rowId}`);
        const total = cell.rate != null && cell.quantity != null ? cell.rate * cell.quantity : null;
        lineValues.push({
          seq: Number(spine.seq), ge: spine.ge_code as string | null, el: spine.element_code as string | null,
          descr: String(spine.description), qty: cell.quantity, unit: spine.unit as string | null,
          rate: cell.rate, total, status: cell.status, note: cell.note, added: false, rowId: String(spine.id)
        });
      }
      let nextSeq = Math.max(0, ...spineRows.map((r) => Number(r.seq))) + 1;
      for (const extra of input.extraLines) {
        const total = extra.rate != null && extra.quantity != null ? extra.rate * extra.quantity : null;
        lineValues.push({
          seq: nextSeq++, ge: null, el: null, descr: extra.description, qty: extra.quantity, unit: extra.unit,
          rate: extra.rate, total, status: extra.status, note: extra.note, added: true, rowId: null
        });
      }

      if (lineValues.length > 0) {
        await this.db.query(
          `INSERT INTO tender_return_lines (return_id, seq, ge_code, element_code, description, quantity, unit, rate, total, status, note, added_by_tenderer, comparison_row_id)
           SELECT $1, s, ge, el, descr, qty, unit, rate, total, status, note, added, row_id
             FROM unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::numeric[], $7::text[], $8::numeric[], $9::numeric[], $10::text[], $11::text[], $12::boolean[], $13::uuid[])
               AS t(s, ge, el, descr, qty, unit, rate, total, status, note, added, row_id)`,
          [ret!.id, lineValues.map((l) => l.seq), lineValues.map((l) => l.ge), lineValues.map((l) => l.el),
           lineValues.map((l) => l.descr), lineValues.map((l) => l.qty), lineValues.map((l) => l.unit),
           lineValues.map((l) => l.rate), lineValues.map((l) => l.total), lineValues.map((l) => l.status),
           lineValues.map((l) => l.note), lineValues.map((l) => l.added), lineValues.map((l) => l.rowId)],
          client
        );
        const tenderedSum = lineValues.filter((l) => l.status === 'priced' && l.total != null)
          .reduce((sum, l) => sum + Number(l.total), 0);
        await this.db.query(`UPDATE tender_returns SET tendered_sum = $2 WHERE id = $1`, [ret!.id, tenderedSum], client);
      }

      return { id: ret!.id };
    });
  }

  /**
   * Awards the package: upserts `trade_analysis` (approved_with_adjustments, since a
   * levelled figure is by definition an adjustment the moment any cell is assumed) with
   * the awarded return, then inserts `tender_boq_lines` from the comparison's LEVELLED
   * figures. The order is not a style choice — `assert_trade_approved` (008) refuses the
   * insert unless the trade analysis row already reads approved, so reversing these two
   * statements is not an option the database will accept.
   */
  async approve(workflowId: string, packageName: string, awardedReturnId: string, approvedBy: string, notes: string | null): Promise<Row> {
    return this.db.transaction(async (client) => {
      const [comparison] = await this.db.query<Row>(
        `SELECT * FROM tps.quote_comparisons WHERE workflow_id = $1 AND package_name = $2 FOR UPDATE`,
        [workflowId, packageName], client
      );
      if (!comparison) throw notFound('This package’s comparison has not been opened yet.');
      // Readiness gates approval, never viewing (see computeReadiness's own doc comment).
      // The screen's disabled button is a courtesy; this is the actual guard, and it is
      // recomputed here rather than trusted from whenever the comparison was last opened
      // — a return that arrived since must count, the same reason the release gate in
      // BuildFlow re-counts inside its own transaction rather than trusting a stale page.
      await this.updateReadiness(client, String(comparison.id), workflowId, packageName);
      const [refreshed] = await this.db.query<Row>(`SELECT readiness, expected_count, received_count FROM tps.quote_comparisons WHERE id = $1`, [comparison.id], client);
      if (refreshed!.readiness === 'awaiting_returns') {
        throw conflict(`Only ${refreshed!.received_count} of the expected ${refreshed!.expected_count} returns are in, and the return date has not passed. Wait for at least ${QUOTE_QUORUM}, or for the deadline.`);
      }
      const [awarded] = await this.db.query<Row>(
        `SELECT * FROM tender_returns WHERE id = $1 AND workflow_id = $2 AND package_name = $3`,
        [awardedReturnId, workflowId, packageName], client
      );
      if (!awarded) throw notFound('That return does not belong to this package.');

      // The SAME levelling `getComparison` shows on screen, computed inside this
      // transaction — never the raw `quote_comparison_cells` row, whose `levelled_rate`/
      // `levelled_total` are never persisted (they depend on every OTHER return's cells
      // for the row, not knowable until they are all read together — see computeGrid).
      const detail = await this.computeGrid(workflowId, packageName, client);
      const rows = detail.rows as Array<Row & { cells: Array<{ returnId: string; status: CellStatus; levelledRate: number | null; levelledTotal: number | null; isAssumed: boolean; assumptionBasis: string | null; quotedRate: number | null }> }>;
      const cellByRow = new Map(rows.map((row) => [String(row.id), row.cells.find((c) => c.returnId === awardedReturnId)]));

      await this.db.query(
        `INSERT INTO tps.trade_analysis (workflow_id, package_name, awarded_return_id, status, approved_at, approved_by, approval_notes)
         VALUES ($1, $2, $3, 'approved_with_adjustments', NOW(), $4, $5)
         ON CONFLICT (workflow_id, package_name) DO UPDATE
           SET awarded_return_id = EXCLUDED.awarded_return_id, status = EXCLUDED.status,
               approved_at = NOW(), approved_by = EXCLUDED.approved_by, approval_notes = EXCLUDED.approval_notes,
               updated_at = NOW()`,
        [workflowId, packageName, awardedReturnId, approvedBy, notes], client
      );

      await this.db.query(`DELETE FROM tender_boq_lines WHERE workflow_id = $1 AND package_name = $2`, [workflowId, packageName], client);

      const values = rows
        .filter((r) => r.origin !== 'tenderer_added' || String(r.added_by_return_id) === awardedReturnId)
        .map((row) => {
          const cell = cellByRow.get(String(row.id));
          const adjusted = cell ? cell.isAssumed : true;
          return {
            ge: row.ge_code, el: row.element_code, descr: row.description, qty: row.quantity, unit: row.unit,
            submittedRate: cell?.quotedRate ?? null, approvedRate: cell?.levelledRate ?? null, approvedTotal: cell?.levelledTotal ?? null,
            status: boqStatusFor(cell?.status ?? 'absent'), adjusted,
            adjustmentNote: adjusted ? (cell?.assumptionBasis ?? 'No return on file for this line; no substitution was available.') : null
          };
        });

      if (values.length > 0) {
        await this.db.query(
          `INSERT INTO tender_boq_lines
             (workflow_id, package_name, ge_code, element_code, description, quantity, unit,
              submitted_rate, approved_rate, approved_total, status, source_return_id, adjusted, adjustment_note)
           SELECT $1, $2, ge, el, descr, qty, unit, srate, arate, atotal, st, $3, adj, note
             FROM unnest($4::text[], $5::text[], $6::text[], $7::numeric[], $8::text[], $9::numeric[], $10::numeric[],
                         $11::numeric[], $12::text[], $13::boolean[], $14::text[])
               AS t(ge, el, descr, qty, unit, srate, arate, atotal, st, adj, note)`,
          [workflowId, packageName, awardedReturnId,
           values.map((v) => v.ge), values.map((v) => v.el), values.map((v) => v.descr), values.map((v) => v.qty),
           values.map((v) => v.unit), values.map((v) => v.submittedRate), values.map((v) => v.approvedRate),
           values.map((v) => v.approvedTotal), values.map((v) => v.status), values.map((v) => v.adjusted),
           values.map((v) => v.adjustmentNote)],
          client
        );
      }

      const [tradeAnalysis] = await this.db.query<Row>(`SELECT * FROM tps.trade_analysis WHERE workflow_id = $1 AND package_name = $2`, [workflowId, packageName], client);
      return tradeAnalysis!;
    });
  }
}
