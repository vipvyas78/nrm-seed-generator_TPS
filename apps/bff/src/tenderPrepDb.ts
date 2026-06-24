import type { Database, Row } from './db.js';
import { conflict, notFound } from './errors.js';
import type { Actor } from './types.js';

export class TenderPrepDatabase {
  constructor(private readonly db: Database) {}

  // ── Workflows ─────────────────────────────────────────────────────────────

  async createWorkflow(actor: Actor, packageId: string): Promise<Row> {
    const existing = await this.db.query(
      `SELECT id FROM tender_prep_workflows WHERE package_id = $1 AND organization_id = $2`,
      [packageId, actor.organizationId]
    );
    if (existing.length > 0) return this.db.one(`SELECT * FROM tender_prep_workflows WHERE id = $1`, [existing[0].id]);
    return this.db.one(
      `INSERT INTO tender_prep_workflows (package_id, organization_id, created_by) VALUES ($1, $2, $3) RETURNING *`,
      [packageId, actor.organizationId, actor.userId]
    );
  }

  async getWorkflow(actor: Actor, workflowId: string): Promise<Row> {
    return this.db.one(
      `SELECT * FROM tender_prep_workflows WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL`,
      [workflowId, actor.organizationId]
    );
  }

  async advanceStep(actor: Actor, workflowId: string): Promise<Row> {
    const wf = await this.db.one<{ current_step: number; locked_at: string | null }>(
      `SELECT current_step, locked_at FROM tender_prep_workflows WHERE id = $1 AND organization_id = $2`,
      [workflowId, actor.organizationId]
    );
    if (wf.locked_at) throw conflict('Workflow is locked');
    if (Number(wf.current_step) >= 7) throw conflict('Already at final step');
    return this.db.one(
      `UPDATE tender_prep_workflows SET current_step = current_step + 1, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [workflowId]
    );
  }

  // ── Step 2: RFIs ──────────────────────────────────────────────────────────

  async listRfis(actor: Actor, workflowId: string): Promise<Row[]> {
    await this.assertWorkflowAccess(actor, workflowId);
    return this.db.query(`SELECT * FROM tender_prep_rfis WHERE workflow_id = $1 ORDER BY created_at`, [workflowId]);
  }

  async createRfi(actor: Actor, workflowId: string, input: { description: string }): Promise<Row> {
    await this.assertWorkflowAccess(actor, workflowId);
    return this.db.one(
      `INSERT INTO tender_prep_rfis (workflow_id, description) VALUES ($1, $2) RETURNING *`,
      [workflowId, input.description]
    );
  }

  async updateRfi(actor: Actor, rfiId: string, patch: { status?: string; employerResponse?: string }): Promise<Row> {
    const rfi = await this.db.one<{ workflow_id: string }>(
      `SELECT workflow_id FROM tender_prep_rfis WHERE id = $1`, [rfiId]
    );
    await this.assertWorkflowAccess(actor, String(rfi.workflow_id));
    const sets: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let idx = 1;
    if (patch.status) { sets.push(`status = $${idx++}`); values.push(patch.status); }
    if (patch.employerResponse !== undefined) { sets.push(`employer_response = $${idx++}`); values.push(patch.employerResponse); }
    if (patch.status === 'closed') { sets.push(`resolved_at = NOW()`); }
    values.push(rfiId);
    return this.db.one(`UPDATE tender_prep_rfis SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`, values);
  }

  // ── Step 3: SoA RAG ───────────────────────────────────────────────────────

  async getSoaRag(actor: Actor, workflowId: string): Promise<Row[]> {
    await this.assertWorkflowAccess(actor, workflowId);
    return this.db.query(`SELECT * FROM tender_prep_soa_rag WHERE workflow_id = $1 ORDER BY clause_ref`, [workflowId]);
  }

  async upsertSoaRag(actor: Actor, workflowId: string, rows: Array<{
    clauseRef: string;
    amendmentText?: string;
    ragStatus: 'red' | 'amber' | 'green';
    jctNec4Ref?: string;
    commentary?: string;
  }>): Promise<Row[]> {
    await this.assertWorkflowAccess(actor, workflowId);
    return Promise.all(rows.map((row) => this.db.one(
      `INSERT INTO tender_prep_soa_rag (workflow_id, clause_ref, amendment_text, rag_status, jct_nec4_ref, commentary, reviewed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (workflow_id, clause_ref) DO UPDATE SET
         amendment_text = EXCLUDED.amendment_text, rag_status = EXCLUDED.rag_status,
         jct_nec4_ref = EXCLUDED.jct_nec4_ref, commentary = EXCLUDED.commentary,
         reviewed_by = EXCLUDED.reviewed_by, updated_at = NOW()
       RETURNING *`,
      [workflowId, row.clauseRef, row.amendmentText ?? null, row.ragStatus,
       row.jctNec4Ref ?? null, row.commentary ?? null, actor.userId]
    )));
  }

  // ── Step 4: Shortlist ─────────────────────────────────────────────────────

  async getShortlists(actor: Actor, workflowId: string): Promise<Row[]> {
    await this.assertWorkflowAccess(actor, workflowId);
    const shortlists = await this.db.query(
      `SELECT sl.*, ARRAY(
        SELECT json_build_object('id', se.id, 'subcontractor_id', se.subcontractor_id, 'rank', se.rank,
          'performance_score', se.performance_score, 'compliance_flags', se.compliance_flags,
          'board_approved', se.board_approved)
        FROM tender_prep_shortlist_entries se WHERE se.shortlist_id = sl.id ORDER BY se.rank
      ) AS entries
       FROM tender_prep_shortlists sl WHERE sl.workflow_id = $1 ORDER BY sl.trade_category`,
      [workflowId]
    );
    return shortlists;
  }

  async confirmShortlist(actor: Actor, workflowId: string, input: {
    tradeCategory: string;
    boardOverrideNotes?: string;
    entries: Array<{ subcontractorId: string; rank: number; performanceScore?: number; complianceFlags?: Record<string, unknown> }>;
  }): Promise<Row> {
    await this.assertWorkflowAccess(actor, workflowId);
    return this.db.transaction(async (client) => {
      const shortlist = await this.db.one(
        `INSERT INTO tender_prep_shortlists (workflow_id, trade_category, confirmed_at, board_override_notes)
         VALUES ($1,$2,NOW(),$3)
         ON CONFLICT (workflow_id, trade_category) DO UPDATE SET
           confirmed_at = NOW(), board_override_notes = EXCLUDED.board_override_notes RETURNING *`,
        [workflowId, input.tradeCategory, input.boardOverrideNotes ?? null], client
      );
      await client.query(`DELETE FROM tender_prep_shortlist_entries WHERE shortlist_id = $1`, [shortlist.id]);
      for (const entry of input.entries) {
        await client.query(
          `INSERT INTO tender_prep_shortlist_entries (shortlist_id, subcontractor_id, rank, performance_score, compliance_flags)
           VALUES ($1,$2,$3,$4,$5)`,
          [shortlist.id, entry.subcontractorId, entry.rank, entry.performanceScore ?? null,
           entry.complianceFlags ? JSON.stringify(entry.complianceFlags) : null]
        );
      }
      return shortlist;
    });
  }

  // ── Step 5: ITT Dispatch ──────────────────────────────────────────────────

  async dispatchItt(actor: Actor, workflowId: string): Promise<Row[]> {
    await this.assertWorkflowAccess(actor, workflowId);
    const entries = await this.db.query<{ id: string }>(
      `SELECT se.id FROM tender_prep_shortlist_entries se
       JOIN tender_prep_shortlists sl ON sl.id = se.shortlist_id
       WHERE sl.workflow_id = $1 AND sl.confirmed_at IS NOT NULL`,
      [workflowId]
    );
    return Promise.all(entries.map((e) => this.db.one(
      `INSERT INTO tender_prep_itt_dispatch (shortlist_entry_id, dispatched_at)
       VALUES ($1, NOW()) ON CONFLICT (shortlist_entry_id) DO UPDATE SET dispatched_at = NOW() RETURNING *`,
      [e.id]
    )));
  }

  async recordIttResponse(actor: Actor, dispatchId: string, response: string): Promise<Row> {
    const dispatch = await this.db.one<{ shortlist_entry_id: string }>(
      `SELECT shortlist_entry_id FROM tender_prep_itt_dispatch WHERE id = $1`, [dispatchId]
    );
    const entry = await this.db.one<{ shortlist_id: string }>(
      `SELECT shortlist_id FROM tender_prep_shortlist_entries WHERE id = $1`, [String(dispatch.shortlist_entry_id)]
    );
    const shortlist = await this.db.one<{ workflow_id: string }>(
      `SELECT workflow_id FROM tender_prep_shortlists WHERE id = $1`, [String(entry.shortlist_id)]
    );
    await this.assertWorkflowAccess(actor, String(shortlist.workflow_id));
    return this.db.one(
      `UPDATE tender_prep_itt_dispatch SET response = $1, responded_at = NOW() WHERE id = $2 RETURNING *`,
      [response, dispatchId]
    );
  }

  async listIttDispatch(actor: Actor, workflowId: string): Promise<Row[]> {
    await this.assertWorkflowAccess(actor, workflowId);
    return this.db.query(
      `SELECT d.*, se.rank, se.subcontractor_id, sl.trade_category
       FROM tender_prep_itt_dispatch d
       JOIN tender_prep_shortlist_entries se ON se.id = d.shortlist_entry_id
       JOIN tender_prep_shortlists sl ON sl.id = se.shortlist_id
       WHERE sl.workflow_id = $1 ORDER BY sl.trade_category, se.rank`,
      [workflowId]
    );
  }

  // ── Step 6: Comparative ───────────────────────────────────────────────────

  async listComparative(actor: Actor, workflowId: string): Promise<Row[]> {
    await this.assertWorkflowAccess(actor, workflowId);
    return this.db.query(`SELECT * FROM tender_prep_comparative WHERE workflow_id = $1 ORDER BY tenderer_name`, [workflowId]);
  }

  async upsertComparative(actor: Actor, workflowId: string, input: {
    tendererName: string;
    tenderedSum?: number;
    estimateSum?: number;
    scopeCompliance?: Record<string, unknown>;
    qualifications?: string;
    recommendation?: string;
  }): Promise<Row> {
    await this.assertWorkflowAccess(actor, workflowId);
    return this.db.one(
      `INSERT INTO tender_prep_comparative (workflow_id, tenderer_name, tendered_sum, estimate_sum, scope_compliance, qualifications, recommendation)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT DO NOTHING RETURNING *`,
      [workflowId, input.tendererName, input.tenderedSum ?? null, input.estimateSum ?? null,
       input.scopeCompliance ? JSON.stringify(input.scopeCompliance) : null,
       input.qualifications ?? null, input.recommendation ?? null]
    );
  }

  // ── Step 7: Submission ────────────────────────────────────────────────────

  async getSubmission(actor: Actor, workflowId: string): Promise<Row | null> {
    await this.assertWorkflowAccess(actor, workflowId);
    const rows = await this.db.query(`SELECT * FROM tender_prep_submission WHERE workflow_id = $1`, [workflowId]);
    return rows[0] ?? null;
  }

  async saveSubmission(actor: Actor, workflowId: string, input: {
    packages: unknown[];
    aggregateTotal?: number;
  }): Promise<Row> {
    await this.assertWorkflowAccess(actor, workflowId);
    return this.db.one(
      `INSERT INTO tender_prep_submission (workflow_id, packages, aggregate_total)
       VALUES ($1,$2,$3)
       ON CONFLICT (workflow_id) DO UPDATE SET packages = EXCLUDED.packages, aggregate_total = EXCLUDED.aggregate_total, updated_at = NOW()
       RETURNING *`,
      [workflowId, JSON.stringify(input.packages), input.aggregateTotal ?? null]
    );
  }

  async boardApproveSubmission(actor: Actor, workflowId: string): Promise<Row> {
    await this.assertWorkflowAccess(actor, workflowId);
    return this.db.one(
      `UPDATE tender_prep_submission SET board_approved_at = NOW(), board_approved_by = $1
       WHERE workflow_id = $2 AND board_approved_at IS NULL RETURNING *`,
      [actor.userId, workflowId]
    );
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async assertWorkflowAccess(actor: Actor, workflowId: string): Promise<void> {
    const rows = await this.db.query(
      `SELECT id FROM tender_prep_workflows WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL`,
      [workflowId, actor.organizationId]
    );
    if (rows.length === 0) throw notFound('Workflow not found or access denied');
  }
}
