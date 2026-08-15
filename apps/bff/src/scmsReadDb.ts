import type { Database, Row } from './db.js';
import { AppError } from './errors.js';

/**
 * The eligibility gate, shared by both queries so the picker's counts cannot drift from the
 * candidate list. Excludes firms explicitly marked do-not-invite, plus the statuses that
 * mean the company is off the table entirely. Everything else — PQQ state, lapsed
 * insurance, at-risk — is surfaced as a flag for the buyer rather than filtered out.
 */
const ELIGIBILITY = `s.do_not_invite = false
          AND s.status NOT IN ('REJECTED', 'DISSOLVED', 'VERY_LOW_RATING', 'DELETED')`;

/**
 * Read-only window onto the SCMS module's schema, which lives in the same database.
 *
 * Every TPS query that touches `scms` lives in this file and nowhere else. Reading another
 * module's physical tables buys us Step 4 without an HTTP hop, but there is no contract and
 * no compile-time signal — a column renamed in SCMS breaks TPS at runtime. Keeping the
 * blast radius to one file is the mitigation.
 *
 * SELECT only. TPS must never write here: `nominations`, `gap_fill_queue` and
 * `pqq_submissions` are outbound-correspondence paths where a row can trigger real contact
 * with a subcontractor, and `pqq_tokens` holds credential hashes and is never read either.
 *
 * TPS connects with `search_path=tps,public`, so every table below is schema-qualified —
 * an unqualified `subcontractors` would resolve inside `tps` and fail (or worse, one day
 * succeed against something unrelated).
 *
 * **Not org-scoped, on purpose.** The subcontractor register is shared reference data: the
 * same firms are available whichever tender is being priced, so a buyer's own organisation
 * has no bearing on who is capable of the work. TPS's own tables are a different matter and
 * stay scoped — every workflow, shortlist and submission is filtered by organization_id in
 * tenderPrepDb, and the candidate route runs assertWorkflowAccess before reaching here.
 *
 * Note this is a deliberate divergence from SCMS, which scopes its own register by
 * organization_id throughout. TPS will therefore offer firms that SCMS's UI hides.
 */
export class ScmsReadDatabase {
  /** Interpolated into SQL; validated as a bare SQL identifier by the config schema. */
  private readonly schema: string;

  constructor(private readonly db: Database, schema: string) {
    this.schema = schema;
  }

  /**
   * Trades that actually have selectable firms behind them, with the count of firms passing
   * the same eligibility gate the candidate query applies — so the number on the picker is
   * the number of rows you get when you click it.
   */
  async listTradeCategories(search?: string): Promise<Row[]> {
    const s = this.schema;
    const values: unknown[] = [];
    let searchClause = '';
    if (search) {
      values.push(`%${search}%`);
      searchClause = `AND ta.trade_category ILIKE $${values.length}`;
    }
    return this.run(() => this.db.query(
      `SELECT ta.trade_category, COUNT(DISTINCT s.id)::int AS candidate_count
         FROM ${s}.trade_assignments ta
         JOIN ${s}.subcontractors s ON s.id = ta.subcontractor_id
        WHERE ${ELIGIBILITY}
          ${searchClause}
        GROUP BY ta.trade_category
        ORDER BY ta.trade_category`,
      values
    ));
  }

  /**
   * Ranked candidates for one trade, shaped to drop straight into
   * `POST /shortlist/confirm` — `subcontractor_id`, `performance_score`, `compliance_flags`.
   *
   * Deliberate departures from SCMS's own shortlist query (scmsDb.ts getShortlistForTrade):
   *
   * - PQQ status and insurance are reported, not enforced. SCMS gates on
   *   `pqq_status = 'approved'` plus in-date PL and EL cover; against real data that is zero
   *   firms out of 1,319, so the gate would hand the buyer an empty screen. The facts ride
   *   along in `compliance_flags` and the buyer decides.
   * - Eligibility keys off `status`, not `do_not_invite` alone. SCMS recomputes
   *   `do_not_invite` from performance ratings on every write and clears it for any firm
   *   with no ratings — which is currently all of them. `status` is the durable signal.
   * - `performance_score` stays NULL when a firm has never been rated, and sorts last.
   *   SCMS's `COALESCE(AVG(...), 0)` would score every unrated firm a hard zero, which reads
   *   as "terrible" rather than "unknown". `ratings_count` lets the UI say which it is.
   * - Trades are matched by token, not string equality (tps.trades_match). A firm tagged
   *   "Carpentry & Joinery" is more capable than one tagged "Carpentry", not less, and
   *   equality threw all 333 multi-trade rows away — "Painting" and "Fire Stopping"
   *   matched literally nothing before this.
   *
   * `matched_trades` returns the SCMS strings that actually satisfied the package, so a
   * loose match ("Electrical Wholesalers" against an Electrical package) is visible in the
   * reasoning column rather than buried.
   */
  async getCandidatesForPackage(packageTerms: string[], limit: number): Promise<Row[]> {
    const s = this.schema;
    // UNIQUE (subcontractor_id, insurance_type) guarantees at most one PL and one EL row
    // per firm, so these joins cannot multiply the result.
    return this.run(() => this.db.query(
      `SELECT s.id AS subcontractor_id,
              s.name,
              s.trading_as,
              s.status,
              s.profile_completeness_pct,
              ROUND(AVG(r.total_score), 2) AS performance_score,
              COUNT(r.id)::int AS ratings_count,
              ARRAY(SELECT DISTINCT ta2.trade_category
                      FROM ${s}.trade_assignments ta2
                     WHERE ta2.subcontractor_id = s.id
                       AND tps.trades_match(ta2.trade_category, $1)
                     ORDER BY ta2.trade_category) AS matched_trades,
              -- Everything the USP is built from. Facts off the register, not marketing.
              s.regional_coverage,
              s.value_bands,
              s.website,
              (SELECT count(*) FROM ${s}.trade_assignments ta3
                WHERE ta3.subcontractor_id = s.id)::int AS trade_count,
              ct.full_name AS contact_name,
              ct.role      AS contact_role,
              ct.email     AS contact_email,
              ct.phone     AS contact_phone,
              jsonb_build_object(
                'pqq_status',               s.pqq_status::text,
                'cis_status',               s.cis_status::text,
                'at_risk',                  s.at_risk,
                'profile_completeness_pct', s.profile_completeness_pct,
                'pl_expiry',                pl.expiry_date,
                'pl_active',                (pl.expiry_date IS NOT NULL AND pl.expiry_date > NOW()),
                'el_expiry',                el.expiry_date,
                'el_active',                (el.expiry_date IS NOT NULL AND el.expiry_date > NOW()),
                'accreditations',           to_jsonb(ARRAY(
                  SELECT a.scheme FROM ${s}.accreditations a
                   WHERE a.subcontractor_id = s.id ORDER BY a.scheme))
              ) AS compliance_flags
         FROM ${s}.subcontractors s
         LEFT JOIN ${s}.performance_ratings r ON r.subcontractor_id = s.id
         LEFT JOIN ${s}.insurance_policies pl
           ON pl.subcontractor_id = s.id AND pl.insurance_type = 'pl'
         LEFT JOIN ${s}.insurance_policies el
           ON el.subcontractor_id = s.id AND el.insurance_type = 'el'
         -- One contact, chosen by who you would actually send an ITT to: the estimator
         -- first, then pre-construction, then the MD, and the general office last.
         -- Contactable beats senior, so a row with an email outranks one without.
         LEFT JOIN LATERAL (
           SELECT c.full_name, c.role, c.email, c.phone
             FROM ${s}.contacts c
            WHERE c.subcontractor_id = s.id
            ORDER BY CASE c.role WHEN 'estimator' THEN 1 WHEN 'pre_con' THEN 2
                                 WHEN 'md' THEN 3 WHEN 'office' THEN 4 ELSE 5 END,
                     (c.email IS NULL), (c.phone IS NULL), c.full_name
            LIMIT 1
         ) ct ON TRUE
        WHERE ${ELIGIBILITY}
          -- EXISTS, not a JOIN: a firm can carry several assignments that all satisfy the
          -- package ("Carpentry" and "Carpentry & Joinery"), and joining would multiply
          -- the ratings rows and inflate ratings_count.
          AND EXISTS (SELECT 1 FROM ${s}.trade_assignments ta
                       WHERE ta.subcontractor_id = s.id
                         AND tps.trades_match(ta.trade_category, $1))
        GROUP BY s.id, pl.expiry_date, el.expiry_date,
                 ct.full_name, ct.role, ct.email, ct.phone
        ORDER BY AVG(r.total_score) DESC NULLS LAST, s.profile_completeness_pct DESC, s.name
        LIMIT $2`,
      [packageTerms, limit]
    ));
  }

  /**
   * The one contact to email for each of a fixed set of firms — the recipient lookup an ITT
   * send needs. Same ranked contact as `getCandidatesForPackage` (estimator > pre_con > md >
   * office, contactable beats senior); the only difference is the WHERE clause, which is
   * `s.id = ANY(...)` here instead of a trade match, because by this point the meeting has
   * already picked the firms and there is nothing left to search for.
   *
   * No eligibility filter: a firm selected at the tender launch meeting is being emailed
   * because it was chosen, not re-screened against do-not-invite/status at send time.
   */
  async getContactsForSubcontractors(subcontractorIds: string[]): Promise<Row[]> {
    if (subcontractorIds.length === 0) return [];
    const s = this.schema;
    return this.run(() => this.db.query(
      `SELECT s.id AS subcontractor_id,
              s.name,
              ct.full_name AS contact_name,
              ct.email     AS contact_email
         FROM ${s}.subcontractors s
         LEFT JOIN LATERAL (
           SELECT c.full_name, c.email
             FROM ${s}.contacts c
            WHERE c.subcontractor_id = s.id
            ORDER BY CASE c.role WHEN 'estimator' THEN 1 WHEN 'pre_con' THEN 2
                                 WHEN 'md' THEN 3 WHEN 'office' THEN 4 ELSE 5 END,
                     (c.email IS NULL), (c.phone IS NULL), c.full_name
            LIMIT 1
         ) ct ON TRUE
        WHERE s.id = ANY($1)`,
      [subcontractorIds]
    ));
  }

  /**
   * TPS can be deployed without SCMS. Postgres reports that as `undefined_table` /
   * `undefined_schema`, which would otherwise surface as an opaque 500 — say what is
   * actually wrong instead.
   */
  private async run<T>(query: () => Promise<T>): Promise<T> {
    try {
      return await query();
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === '42P01' || code === '3F000') {
        throw new AppError(
          503,
          `The SCMS schema "${this.schema}" is not present in this database, so shortlist candidates are unavailable.`,
          'SCMS_UNAVAILABLE'
        );
      }
      throw error;
    }
  }
}
