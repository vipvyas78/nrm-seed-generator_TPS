import type { Database, Row } from './db.js';
import { AppError } from './errors.js';
import type { Actor } from './types.js';

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
  async listTradeCategories(actor: Actor, search?: string): Promise<Row[]> {
    const s = this.schema;
    const values: unknown[] = [actor.organizationId];
    let searchClause = '';
    if (search) {
      values.push(`%${search}%`);
      searchClause = `AND ta.trade_category ILIKE $${values.length}`;
    }
    return this.run(() => this.db.query(
      `SELECT ta.trade_category, COUNT(DISTINCT s.id)::int AS candidate_count
         FROM ${s}.trade_assignments ta
         JOIN ${s}.subcontractors s ON s.id = ta.subcontractor_id
        WHERE s.organization_id = $1
          AND ${ELIGIBILITY}
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
   */
  async getCandidatesForTrade(actor: Actor, tradeCategory: string, limit: number): Promise<Row[]> {
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
         JOIN ${s}.trade_assignments ta
           ON ta.subcontractor_id = s.id AND ta.trade_category = $2
         LEFT JOIN ${s}.performance_ratings r ON r.subcontractor_id = s.id
         LEFT JOIN ${s}.insurance_policies pl
           ON pl.subcontractor_id = s.id AND pl.insurance_type = 'pl'
         LEFT JOIN ${s}.insurance_policies el
           ON el.subcontractor_id = s.id AND el.insurance_type = 'el'
        WHERE s.organization_id = $1
          AND ${ELIGIBILITY}
        GROUP BY s.id, pl.expiry_date, el.expiry_date
        ORDER BY AVG(r.total_score) DESC NULLS LAST, s.profile_completeness_pct DESC, s.name
        LIMIT $3`,
      [actor.organizationId, tradeCategory, limit]
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
