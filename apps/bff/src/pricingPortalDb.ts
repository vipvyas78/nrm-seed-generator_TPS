import { randomBytes } from 'node:crypto';
import type { Database, Row } from './db.js';
import { conflict, notFound } from './errors.js';

/** One line as it is snapshotted from an ITT assembly at send time. Never re-read from
 * public.takeoff_items after that — see migration 019's header comment. */
export interface PortalLineInput {
  sourceItemId: string | null;
  geCode: string | null;
  elementCode: string | null;
  description: string;
  quantity: number | null;
  unit: string | null;
  isPriceable: boolean;
}

export type PortalLineStatus = 'priced' | 'included' | 'excluded' | 'not_addressed';

export interface PortalLineDraftInput {
  id: string;
  quantity: number | null;
  rate: number | null;
  status: PortalLineStatus;
  note: string | null;
}

/**
 * Raw storage for the subcontractor pricing portal — one row per (package x firm) link,
 * its priced-line snapshot, and the promotion of a submission into `tps.tender_returns`.
 *
 * Standalone, taking the `Database` explicitly, the same separation `boqReadDb.ts` and
 * `scmsReadDb.ts` already keep from `tenderPrepDb.ts`. It knows nothing about actors,
 * workflows-as-authorization, or how a bill is assembled — `tenderPrepDb.ts` owns that,
 * because it already owns `getPackageItt`/`assemblePackageForEmail`, and duplicating that
 * assembly here would let the two disagree about what a package's bill contains.
 */
export class PricingPortalDatabase {
  constructor(private readonly db: Database) {}

  /**
   * Mints a link on first send, or refreshes an existing one on resend.
   *
   * NEVER rotates a live token — a tenderer already pricing from the first email must not
   * be locked out by a buyer re-clicking "Confirm ITT". Only identity, expiry (extended,
   * never shortened) and the test flag are refreshed.
   */
  async mintOrRefreshLink(input: {
    shortlistEntryId: string; workflowId: string; packageName: string;
    subcontractorId: string | null; tendererName: string;
    recipientEmail: string; isTest: boolean; ttlDays: number;
  }): Promise<{ id: string; token: string; isNewLink: boolean }> {
    const email = input.recipientEmail.trim().toLowerCase();
    const domain = email.split('@')[1] ?? '';
    const [existing] = await this.db.query<{ id: string; token: string | null }>(
      `SELECT id, token FROM tps.pricing_portal_links WHERE shortlist_entry_id = $1`,
      [input.shortlistEntryId]
    );
    if (existing?.token) {
      await this.db.query(
        `UPDATE tps.pricing_portal_links
            SET recipient_email = $2, recipient_domain = $3, is_test = $4, tenderer_name = $5,
                expires_at = GREATEST(expires_at, NOW() + ($6 || ' days')::interval)
          WHERE id = $1`,
        [existing.id, email, domain, input.isTest, input.tendererName, input.ttlDays]
      );
      return { id: existing.id, token: existing.token, isNewLink: false };
    }
    const token = randomBytes(32).toString('base64url');
    if (existing) {
      // A row already exists at this grain but was previously blocked (e.g. Access was
      // unconfigured on an earlier send) — unblock it in place rather than violating the
      // UNIQUE(shortlist_entry_id) constraint with a second INSERT. Still a NEW link as
      // far as the caller is concerned: nothing has ever been snapshotted for it.
      await this.db.query(
        `UPDATE tps.pricing_portal_links
            SET token = $2, recipient_email = $3, recipient_domain = $4, is_test = $5,
                tenderer_name = $6, expires_at = NOW() + ($7 || ' days')::interval, blocked_reason = NULL
          WHERE id = $1`,
        [existing.id, token, email, domain, input.isTest, input.tendererName, input.ttlDays]
      );
      return { id: existing.id, token, isNewLink: true };
    }
    const [row] = await this.db.query<{ id: string }>(
      `INSERT INTO tps.pricing_portal_links
         (shortlist_entry_id, workflow_id, package_name, subcontractor_id, tenderer_name,
          token, recipient_email, recipient_domain, expires_at, is_test)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW() + ($9 || ' days')::interval, $10)
       RETURNING id`,
      [input.shortlistEntryId, input.workflowId, input.packageName, input.subcontractorId,
       input.tendererName, token, email, domain, input.ttlDays, input.isTest]
    );
    return { id: row.id, token, isNewLink: true };
  }

  /**
   * Records that a recipient gets no portal link at all — a public/free email domain, or
   * Cloudflare Access unconfigured on this deployment — WITHOUT touching a row that
   * already carries a live token. A row exists at this grain either way: the dispatch
   * page shows a stated reason rather than the recipient simply being absent, the same
   * "named, not silent" rule `bf_takeoff_wp_bundles.all_sheets_fallback` follows.
   */
  async recordBlocked(input: {
    shortlistEntryId: string; workflowId: string; packageName: string;
    subcontractorId: string | null; tendererName: string; recipientEmail: string; reason: string;
  }): Promise<void> {
    const email = input.recipientEmail.trim().toLowerCase();
    const domain = email.split('@')[1] ?? '';
    await this.db.query(
      `INSERT INTO tps.pricing_portal_links
         (shortlist_entry_id, workflow_id, package_name, subcontractor_id, tenderer_name,
          recipient_email, recipient_domain, blocked_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (shortlist_entry_id) DO UPDATE
         SET blocked_reason = EXCLUDED.blocked_reason, recipient_email = EXCLUDED.recipient_email,
             recipient_domain = EXCLUDED.recipient_domain
       WHERE tps.pricing_portal_links.token IS NULL`,
      [input.shortlistEntryId, input.workflowId, input.packageName, input.subcontractorId,
       input.tendererName, email, domain, input.reason]
    );
  }

  /** Replaces this link's priced-line snapshot wholesale. Called once, right after
   * `mintOrRefreshLink` on a NEW link only — an existing link's snapshot is never
   * replaced, or a tenderer's in-progress rates would be discarded under them. */
  async snapshotLines(linkId: string, lines: PortalLineInput[]): Promise<void> {
    await this.db.query(`DELETE FROM tps.pricing_portal_lines WHERE link_id = $1`, [linkId]);
    if (lines.length === 0) return;
    await this.db.query(
      `INSERT INTO tps.pricing_portal_lines
         (link_id, seq, source_item_id, ge_code, element_code, description, quantity, unit, is_priceable)
       SELECT $1, s, item, ge, el, descr, qty, unit, priceable
         FROM unnest($2::int[], $3::uuid[], $4::text[], $5::text[], $6::text[], $7::numeric[], $8::text[], $9::boolean[])
           AS t(s, item, ge, el, descr, qty, unit, priceable)`,
      [linkId, lines.map((_, i) => i + 1), lines.map((l) => l.sourceItemId), lines.map((l) => l.geCode),
       lines.map((l) => l.elementCode), lines.map((l) => l.description), lines.map((l) => l.quantity),
       lines.map((l) => l.unit), lines.map((l) => l.isPriceable)]
    );
  }

  async getByToken(token: string): Promise<Row | null> {
    const [row] = await this.db.query<Row>(
      `SELECT * FROM tps.pricing_portal_links WHERE token = $1 AND expires_at > NOW()`, [token]
    );
    return row ?? null;
  }

  async getById(linkId: string): Promise<Row | null> {
    const [row] = await this.db.query<Row>(`SELECT * FROM tps.pricing_portal_links WHERE id = $1`, [linkId]);
    return row ?? null;
  }

  async getLines(linkId: string): Promise<Row[]> {
    return this.db.query<Row>(`SELECT * FROM tps.pricing_portal_lines WHERE link_id = $1 ORDER BY seq`, [linkId]);
  }

  async recordOpen(linkId: string, email: string | null): Promise<void> {
    await this.db.query(
      `UPDATE tps.pricing_portal_links
          SET first_opened_at = COALESCE(first_opened_at, NOW()), last_opened_at = NOW(), last_opened_email = $2
        WHERE id = $1`,
      [linkId, email]
    );
  }

  /** A viewer authenticated fine (a valid Access identity) but did not match this link's
   * recipient — surfaced on the dispatch page, not left in a log nobody would check. */
  async recordDenial(linkId: string, email: string): Promise<void> {
    await this.db.query(
      `UPDATE tps.pricing_portal_links
          SET denied_attempts = denied_attempts + 1, last_denied_email = $2, last_denied_at = NOW()
        WHERE id = $1`,
      [linkId, email]
    );
  }

  /** Header + line quantities/rates/status/notes. `total` is derived here, server-side,
   * from quantity x rate — never accepted from the browser, so a tampered total can never
   * reach `tender_return_lines` on submit. Quantity itself IS accepted from the browser
   * (unlike total): the tenderer may enter their own figure on any line, snapshotted or
   * added — see `addLine` for how a new line is created in the first place. */
  async saveDraft(linkId: string, input: {
    header: { programmeWeeks: number | null; qualifications: string | null; exclusions: string | null };
    lines: PortalLineDraftInput[];
  }): Promise<void> {
    await this.db.query(
      `UPDATE tps.pricing_portal_links
          SET programme_weeks = $2, qualifications = $3, exclusions = $4, draft_saved_at = NOW()
        WHERE id = $1`,
      [linkId, input.header.programmeWeeks, input.header.qualifications, input.header.exclusions]
    );
    if (input.lines.length === 0) return;
    await this.db.query(
      `UPDATE tps.pricing_portal_lines AS l
          SET quantity = u.quantity, rate = u.rate, status = u.status, note = u.note,
              total = CASE WHEN u.rate IS NOT NULL AND u.quantity IS NOT NULL THEN u.quantity * u.rate ELSE NULL END
         FROM unnest($2::uuid[], $3::numeric[], $4::numeric[], $5::text[], $6::text[]) AS u(id, quantity, rate, status, note)
        WHERE l.id = u.id AND l.link_id = $1`,
      [linkId, input.lines.map((l) => l.id), input.lines.map((l) => l.quantity), input.lines.map((l) => l.rate),
       input.lines.map((l) => l.status), input.lines.map((l) => l.note)]
    );
  }

  /** Adds a wholly new line to a tenderer's response — one the ITT assembly never
   * snapshotted, e.g. an item the buyer's BOQ omitted. `seq` continues the existing
   * numbering so it sorts after the snapshot; `is_priceable` is always true since this is
   * the tenderer's own line. `added_by_tenderer` is what lets the UI (and `deleteLine`)
   * tell this apart from a snapshotted line later. */
  async addLine(linkId: string, input: {
    description: string; quantity: number | null; unit: string | null;
  }): Promise<Row> {
    const [row] = await this.db.query<Row>(
      `INSERT INTO tps.pricing_portal_lines (link_id, seq, description, quantity, unit, is_priceable, added_by_tenderer)
       VALUES ($1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM tps.pricing_portal_lines WHERE link_id = $1), $2, $3, $4, TRUE, TRUE)
       RETURNING *`,
      [linkId, input.description, input.quantity, input.unit]
    );
    return row;
  }

  /** Removes a line the tenderer added — never a snapshotted BOQ line, which stays
   * immutable evidence of what the ITT actually asked for. Guarded in SQL (not just by the
   * caller) with `added_by_tenderer = TRUE` so this can never delete a snapshotted line even
   * if called incorrectly. */
  async deleteLine(linkId: string, lineId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM tps.pricing_portal_lines WHERE id = $1 AND link_id = $2 AND added_by_tenderer = TRUE`,
      [lineId, linkId]
    );
  }

  /**
   * Finalises a submission: promotes the snapshot into `tps.tender_returns` +
   * `tender_return_lines` (untouched by any trigger — `assert_trade_approved` (008) is
   * scoped to `tender_boq_lines` only) and locks the link.
   *
   * `tendered_sum` is computed here from priced lines, never accepted from the browser —
   * the same rule `total` follows on each line. `is_fabricated` is carried from the
   * link's own `is_test`, set at mint time from `TEST_EMAIL_FLAG`: a submission arriving
   * through a test-mode send is by definition not a real bid (008's own reasoning for
   * that column).
   */
  async submit(linkId: string): Promise<{ tenderReturnId: string; tenderedSum: number }> {
    return this.db.transaction(async (client) => {
      const [link] = await this.db.query<Row>(
        `SELECT * FROM tps.pricing_portal_links WHERE id = $1 FOR UPDATE`, [linkId], client
      );
      if (!link) throw notFound('Pricing portal link not found');
      if (link.submitted_at) throw conflict('This return has already been submitted.');

      const lines = await this.db.query<Row>(
        `SELECT * FROM tps.pricing_portal_lines WHERE link_id = $1 ORDER BY seq`, [linkId], client
      );
      const tenderedSum = lines
        .filter((l) => l.status === 'priced' && l.total != null)
        .reduce((sum, l) => sum + Number(l.total), 0);

      const [ret] = await this.db.query<{ id: string }>(
        `INSERT INTO tps.tender_returns
           (workflow_id, package_name, subcontractor_id, tenderer_name, received_at,
            tendered_sum, programme_weeks, qualifications, exclusions, is_fabricated)
         VALUES ($1,$2,$3,$4,NOW(),$5,$6,$7,$8,$9)
         ON CONFLICT (workflow_id, package_name, tenderer_name) DO UPDATE
           SET received_at = NOW(), tendered_sum = EXCLUDED.tendered_sum,
               programme_weeks = EXCLUDED.programme_weeks, qualifications = EXCLUDED.qualifications,
               exclusions = EXCLUDED.exclusions, is_fabricated = EXCLUDED.is_fabricated
         RETURNING id`,
        [link.workflow_id, link.package_name, link.subcontractor_id, link.tenderer_name,
         tenderedSum, link.programme_weeks, link.qualifications, link.exclusions, link.is_test],
        client
      );

      await this.db.query(`DELETE FROM tps.tender_return_lines WHERE return_id = $1`, [ret.id], client);
      if (lines.length > 0) {
        await this.db.query(
          `INSERT INTO tps.tender_return_lines
             (return_id, ge_code, element_code, description, quantity, unit, rate, total, status, note)
           SELECT $1, ge, el, descr, qty, unit, rate, total, status, note
             FROM unnest($2::text[], $3::text[], $4::text[], $5::numeric[], $6::text[], $7::numeric[], $8::numeric[], $9::text[], $10::text[])
               AS t(ge, el, descr, qty, unit, rate, total, status, note)`,
          [ret.id, lines.map((l) => l.ge_code), lines.map((l) => l.element_code), lines.map((l) => l.description),
           lines.map((l) => l.quantity), lines.map((l) => l.unit), lines.map((l) => l.rate), lines.map((l) => l.total),
           lines.map((l) => l.status), lines.map((l) => l.note)],
          client
        );
      }

      await this.db.query(
        `UPDATE tps.pricing_portal_links SET submitted_at = NOW(), tender_return_id = $2 WHERE id = $1`,
        [linkId, ret.id], client
      );

      return { tenderReturnId: ret.id, tenderedSum };
    });
  }

  /** A buyer's decision, not a tenderer action — the caller (`tenderPrepDb.ts`) is
   * responsible for the workflow-access check before this runs. The prior submission's
   * `tender_returns`/`tender_return_lines` rows are left as-is; a fresh submit overwrites
   * them via the same ON CONFLICT `submit` already uses. */
  async reopen(linkId: string, reopenedBy: string): Promise<void> {
    await this.db.query(
      `UPDATE tps.pricing_portal_links SET submitted_at = NULL, reopened_at = NOW(), reopened_by = $2 WHERE id = $1`,
      [linkId, reopenedBy]
    );
  }

  async listForPackage(workflowId: string, packageName: string): Promise<Row[]> {
    return this.db.query<Row>(
      `SELECT l.*, se.rank
         FROM tps.pricing_portal_links l
         JOIN tps.shortlist_entries se ON se.id = l.shortlist_entry_id
        WHERE l.workflow_id = $1 AND l.package_name = $2
        ORDER BY se.rank`,
      [workflowId, packageName]
    );
  }

  /** The live recipient set the Cloudflare Access policy is reconciled against — every
   * unexpired link, across every tender. An expired link's domain simply stops appearing
   * here, which is how revocation happens with no explicit "remove from policy" step. */
  async liveRecipients(): Promise<Array<{ email: string; domain: string }>> {
    const rows = await this.db.query<{ recipient_email: string; recipient_domain: string }>(
      `SELECT DISTINCT recipient_email, recipient_domain
         FROM tps.pricing_portal_links WHERE token IS NOT NULL AND expires_at > NOW()`
    );
    return rows.map((r) => ({ email: r.recipient_email, domain: r.recipient_domain }));
  }
}
