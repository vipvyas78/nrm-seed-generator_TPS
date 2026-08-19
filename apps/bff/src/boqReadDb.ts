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
              (quantity IS NOT NULL AND quantity > 0) AS is_priceable, spec_chunk_ids
         FROM public.boq_items
        WHERE boq_id = $1
          AND tps.boq_line_in_package(ge_code, element_code, description, $2, $3, $4, $5, $6)
        ORDER BY ge_code, element_code NULLS LAST, sort_order NULLS LAST, description`,
      [boqId, pkg.ge_codes, pkg.element_prefixes, pkg.trade_terms,
       pkg.include_terms ?? [], pkg.exclude_terms ?? []]
    ));
  }

  /**
   * One work package's scope and bill, straight off the take-off.
   *
   * This is the replacement for attributing boq_items by NRM group-element prefix. That was
   * always an approximation of a question the take-off answers outright — takeoff_items
   * carries `work_package`, resolved from the NRM1 sub-element through
   * nrm_sub_element_work_package — and it was configured per package by hand, so a package
   * with no codes configured got an empty bill and nobody could tell that from a package
   * with no work.
   *
   * Three properties, all of which matter:
   *
   *   THE REVIEWED QUANTITY, NOT THE GENERATED ONE. The whole point of the approval gate is
   *   that what goes out to a subcontractor is what a surveyor signed off. The LATERAL is
   *   the same one reaggregateReviewedBoq uses on the parent's side, so the ITT and the
   *   parent's own aggregated BOQ cannot disagree about a number.
   *
   *   IGNORED ITEMS ARE GONE. is_ignored means excluded from the bill; issuing it to a
   *   tenderer would ask for a price on work the reviewer struck out.
   *
   *   ZERO AND NULL QUANTITIES STAY. They are the scope half of "Scope and Bill of
   *   Quantities" — real items the take-off could not measure. Dropping them silently is how
   *   scope goes missing and comes back as a variation. `is_priceable` marks which can carry
   *   a rate.
   *
   * Rates are still never selected, for the reason linesForPackage gives.
   */
  async takeoffLinesForWorkPackage(takeoffId: string, wpCode: string): Promise<Row[]> {
    return this.run(() => this.db.query(
      `SELECT ti.id, ti.ge_code, ti.element_code, ti.description, ti.unit,
              COALESCE(latest.effective_quantity, ti.quantity) AS quantity,
              (COALESCE(latest.effective_quantity, ti.quantity) > 0) AS is_priceable,
              ti.sort_order, 'work_package' AS attributed_by,
              ti.spec_chunk_ids, ti.spec_source_files
         FROM public.takeoff_items ti
         LEFT JOIN LATERAL (
           SELECT effective_quantity FROM public.takeoff_item_review_events e
            WHERE e.takeoff_item_id = ti.id ORDER BY e.created_at DESC, e.id DESC LIMIT 1
         ) latest ON TRUE
        WHERE ti.takeoff_id = $1 AND NOT ti.is_ignored AND ti.work_package = $2
        ORDER BY ti.ge_code, ti.element_code NULLS LAST, ti.sort_order NULLS LAST, ti.description`,
      [takeoffId, wpCode]
    ));
  }

  /**
   * The same take-off's items that resolved to NO work package, matched by the package's
   * configured NRM codes instead.
   *
   * 196 of Reading's 525 items carry no work package, so without this a third of a real
   * take-off would be in no ITT at all. It is a SECOND mechanism, not a widening of the
   * first: it only ever sees rows the first cannot claim, so a line can never be claimed by
   * both, and every row says which mechanism claimed it. Mixing a precise rule with a fuzzy
   * one silently widens the precise one — the reasoning migration 007 gives for keeping the
   * description matcher unreachable whenever codes are configured.
   *
   * A RETIRED CODE COUNTS AS NO CODE. An item can name a work package that the vocabulary
   * no longer holds — BuildFlow's migration 075 split WP-MEP into trade-level codes and
   * retired WP-FIN, and Reading's take-off predates it, so 24 of its items still carry the
   * old names. No package is ever derived for a code work_package_config does not have, so
   * without this those items would be claimed by nobody and silently priced by nobody. A
   * code nothing recognises tells us as little as no code at all, which is exactly the case
   * this fallback exists for. There is still no overlap: an unrecognised code cannot equal
   * an active one, so the first mechanism never sees these rows.
   *
   * A package with no codes configured gets nothing here, which is correct: the alternative
   * is guessing.
   */
  async takeoffLinesUnattributed(takeoffId: string, pkg: Attribution): Promise<Row[]> {
    if ((pkg.ge_codes?.length ?? 0) === 0 && (pkg.element_prefixes?.length ?? 0) === 0) return [];
    return this.run(() => this.db.query(
      `SELECT ti.id, ti.ge_code, ti.element_code, ti.description, ti.unit,
              COALESCE(latest.effective_quantity, ti.quantity) AS quantity,
              (COALESCE(latest.effective_quantity, ti.quantity) > 0) AS is_priceable,
              ti.sort_order, 'nrm_code' AS attributed_by,
              ti.spec_chunk_ids, ti.spec_source_files
         FROM public.takeoff_items ti
         LEFT JOIN LATERAL (
           SELECT effective_quantity FROM public.takeoff_item_review_events e
            WHERE e.takeoff_item_id = ti.id ORDER BY e.created_at DESC, e.id DESC LIMIT 1
         ) latest ON TRUE
        WHERE ti.takeoff_id = $1 AND NOT ti.is_ignored
          AND (ti.work_package IS NULL OR NOT EXISTS (
                SELECT 1 FROM public.work_package_config w
                 WHERE w.wp_code = ti.work_package AND w.is_active))
          AND tps.boq_line_in_package(ti.ge_code, ti.element_code, ti.description, $2, $3, $4, $5, $6)
        ORDER BY ti.ge_code, ti.element_code NULLS LAST, ti.sort_order NULLS LAST, ti.description`,
      [takeoffId, pkg.ge_codes, pkg.element_prefixes, pkg.trade_terms,
       pkg.include_terms ?? [], pkg.exclude_terms ?? []]
    ));
  }

  /**
   * The specification documents a package's own lines were read from.
   *
   * A take-off line derived from a spec clause records the document it came from in
   * `takeoff_items.spec_source_files`, and that column holds `tender_documents.filename`
   * VERBATIM — elemental_lines reads the filenames out of tender_documents itself before it
   * parses a clause out of each one. So this is an exact join, not a guess.
   *
   * IT HAS TO BE THIS COLUMN, not spec_chunk_ids. A chunk id can never name a document:
   * nrm_chunks has no source_path, no filename and no usable document_id for a tender_spec
   * row — embed_chunks.py carries the path in memory and drops it from the INSERT. So
   * BuildFlow's /internal/spec-clauses answers "which clause", correctly, and cannot answer
   * "which document" however it is called. On Reading's take-off spec_chunk_ids is set on 25
   * of 525 items and on ZERO items of every work package, while spec_source_files is set on
   * 213 — including 17 of Flooring's 18. Keying the ITT on the chunk ids is why Flooring's
   * specification section came back empty.
   *
   * The two tolerant arms are copied from BuildFlow's own resolveSpecSourceFiles, whose
   * comment records that the pipeline writes "sometimes a full path and sometimes a bare
   * name". Reading's values are all bare and match on the first arm; the others cost nothing
   * and stop the next pack reading empty for a reason nobody would look for.
   *
   * Returns one row per document, not per citation — a caller wanting the citation count
   * should count the filenames it passed in. A name matching nothing is simply absent, which
   * is what lets getPackageItt report it as unresolved rather than lose it.
   */
  async specDocumentsForFilenames(sessionId: string, names: string[]): Promise<Row[]> {
    if (names.length === 0) return [];
    return this.run(() => this.db.query(
      `SELECT DISTINCT td.id, td.doc_type, td.filename, COALESCE(td.page_count, 0) AS page_count
         FROM unnest($2::text[]) AS wanted(name)
         -- chr(92) rather than a backslash literal. One would have to survive a TS template
         -- literal AND Postgres's bracket-expression rules, and a bracketed separator class
         -- is rejected outright there as an unbalanced bracket (tested). Normalising the
         -- separator with a plain replace() needs no escaping in either layer.
         CROSS JOIN LATERAL (
           SELECT regexp_replace(replace(wanted.name, chr(92), '/'), '^.*/', '') AS value
         ) basename
         JOIN public.tender_documents td
           ON td.session_id = $1
          AND (LOWER(td.filename)    = LOWER(wanted.name)
            OR LOWER(td.source_path) = LOWER(wanted.name)
            OR LOWER(td.filename)    = LOWER(basename.value))
        ORDER BY td.doc_type, td.filename`,
      [sessionId, names]
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
