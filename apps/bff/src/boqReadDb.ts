import type { Database, Row } from './db.js';
import { AppError } from './errors.js';

/**
 * Read-only window onto the take-off module's Bill of Quantities, which the parent platform
 * owns in `public`.
 *
 * Same arrangement as ScmsReadDatabase: one file, SELECT only, schema-qualified. TPS already
 * reads the parent's `public.bf_*` identity tables, so this is the established pattern
 * rather than a new one.
 *
 * The whole point of this module is picking the *right* BoQ. A session accumulates several:
 * abandoned `initialising` rows with no take-off behind them, plus one completed BoQ per
 * take-off run. Querying by session_id alone returns all of them at once, which is what made
 * every line of the first ITT appear twice — it was two BoQ runs superimposed, not duplicate
 * data. `boq_sessions.source_takeoff_id` is the authoritative link back to the take-off a
 * workflow was launched from, and it is the only safe way in.
 */
/**
 * How a package claims BoQ lines: NRM codes first, with named description overrides for the
 * lines the take-off filed under the wrong element. See migration 014.
 */
export interface Attribution {
  ge_codes: string[];
  element_prefixes: string[];
  trade_terms: string[];
  include_terms?: string[];
  exclude_terms?: string[];
}

export class BoqReadDatabase {
  constructor(private readonly db: Database) {}

  /**
   * The completed BoQ produced from a given take-off, or null.
   *
   * `status = 'completed'` excludes the initialising rows, which carry no source_takeoff_id
   * and no items. Ordered newest-first and limited to one so a re-run of the same take-off
   * resolves to its latest BoQ rather than erroring.
   */
  async findBoqForTakeoff(takeoffId: string): Promise<Row | null> {
    const rows = await this.run(() => this.db.query(
      `SELECT boq_id, session_id, created_at
         FROM public.boq_sessions
        WHERE source_takeoff_id = $1 AND status = 'completed'
        ORDER BY created_at DESC
        LIMIT 1`,
      [takeoffId]
    ));
    return rows[0] ?? null;
  }

  /**
   * The measured lines belonging to one package.
   *
   * `unit_rate` and `total_cost` are deliberately not selected. They are the take-off's own
   * cost-plan rates; an ITT asks the subcontractor to price the work, and issuing a bill
   * with our rates already in it would both anchor the tender and leak the estimate.
   *
   * Zero-quantity lines are kept. They are real items the take-off could not measure, and a
   * tenderer needs to see them — silently dropping them is how scope goes missing and comes
   * back later as a variation. `is_priceable` marks which ones can actually carry a rate.
   */
  async linesForPackage(boqId: string, pkg: Attribution): Promise<Row[]> {
    return this.run(() => this.db.query(
      `SELECT id, element_code, ge_code, description, quantity, unit, sort_order,
              (quantity IS NOT NULL AND quantity > 0) AS is_priceable
         FROM public.boq_items
        WHERE boq_id = $1
          AND tps.boq_line_in_package(ge_code, element_code, description, $2, $3, $4, $5, $6)
        ORDER BY ge_code, element_code NULLS LAST, sort_order NULLS LAST, description`,
      [boqId, pkg.ge_codes, pkg.element_prefixes, pkg.trade_terms,
       pkg.include_terms ?? [], pkg.exclude_terms ?? []]
    ));
  }

  /**
   * The tender documents issued with this project, grouped for the ITT's document schedule.
   *
   * Everything is listed, not a trade-filtered subset: an Employer's Requirement or a
   * specification binds the subcontractor whether or not its filename mentions their trade,
   * and a tenderer who was not given a document will qualify their bid around it. The
   * `ignore` and `unknown` classifications are dropped because they are the classifier's
   * leftovers rather than contract documents.
   */
  async documentsForSession(sessionId: string): Promise<Row[]> {
    return this.run(() => this.db.query(
      `SELECT id, doc_type, filename, COALESCE(page_count, 0) AS page_count
         FROM public.tender_documents
        WHERE session_id = $1
          AND doc_type NOT IN ('ignore', 'unknown')
        ORDER BY doc_type, filename`,
      [sessionId]
    ));
  }

  /** Line and quantity counts per package, for the launch table without shipping every row. */
  async lineCountForPackage(boqId: string, pkg: Attribution): Promise<{ lines: number; priceable: number }> {
    const rows = await this.run(() => this.db.query<{ lines: string; priceable: string }>(
      `SELECT count(*) AS lines,
              count(*) FILTER (WHERE quantity IS NOT NULL AND quantity > 0) AS priceable
         FROM public.boq_items
        WHERE boq_id = $1
          AND tps.boq_line_in_package(ge_code, element_code, description, $2, $3, $4, $5, $6)`,
      [boqId, pkg.ge_codes, pkg.element_prefixes, pkg.trade_terms,
       pkg.include_terms ?? [], pkg.exclude_terms ?? []]
    ));
    return { lines: Number(rows[0]?.lines ?? 0), priceable: Number(rows[0]?.priceable ?? 0) };
  }

  /**
   * Lines in the BoQ that no configured package claims.
   *
   * The number that matters before an ITT goes out: work measured in the take-off but not
   * procured by any package is work nobody has been asked to price.
   */
  async unattributedLines(boqId: string, packages: Attribution[]): Promise<Row[]> {
    if (packages.length === 0) {
      return this.run(() => this.db.query(
        `SELECT ge_code, element_code, description, quantity, unit
           FROM public.boq_items WHERE boq_id = $1 ORDER BY ge_code, element_code`, [boqId]));
    }
    const clauses = packages.map((_, i) =>
      `tps.boq_line_in_package(ge_code, element_code, description, ` +
      `$${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5}, $${i * 5 + 6})`
    ).join(' OR ');
    const values: unknown[] = [boqId];
    for (const p of packages) {
      values.push(p.ge_codes ?? [], p.element_prefixes ?? [], p.trade_terms ?? [],
                  p.include_terms ?? [], p.exclude_terms ?? []);
    }
    return this.run(() => this.db.query(
      `SELECT ge_code, element_code, description, quantity, unit
         FROM public.boq_items
        WHERE boq_id = $1 AND NOT (${clauses})
        ORDER BY ge_code, element_code NULLS LAST`,
      values
    ));
  }

  private async run<T>(query: () => Promise<T>): Promise<T> {
    try {
      return await query();
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === '42P01' || code === '3F000') {
        throw new AppError(503,
          'The take-off Bill of Quantities tables are not present in this database.',
          'BOQ_UNAVAILABLE');
      }
      throw error;
    }
  }
}
