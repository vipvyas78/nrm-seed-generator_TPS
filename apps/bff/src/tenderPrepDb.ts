import type { Database, Row } from './db.js';
import { conflict, notFound } from './errors.js';
import type { ScmsReadDatabase } from './scmsReadDb.js';
import type { TakeoffCompletion } from './takeoffCompletion.js';
import type { Actor } from './types.js';

export class TenderPrepDatabase {
  constructor(private readonly db: Database, private readonly scms: ScmsReadDatabase) {}

  // ── Workflows ─────────────────────────────────────────────────────────────

  async createWorkflow(actor: Actor, packageId: string): Promise<Row> {
    const existing = await this.db.query(
      `SELECT id FROM workflows WHERE package_id = $1 AND organization_id = $2`,
      [packageId, actor.organizationId]
    );
    if (existing.length > 0) return this.db.one(`SELECT * FROM workflows WHERE id = $1`, [existing[0].id]);
    return this.db.one(
      `INSERT INTO workflows (package_id, organization_id, created_by) VALUES ($1, $2, $3) RETURNING *`,
      [packageId, actor.organizationId, actor.userId]
    );
  }

  async getWorkflow(actor: Actor, workflowId: string): Promise<Row> {
    return this.db.one(
      `SELECT * FROM workflows WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL`,
      [workflowId, actor.organizationId]
    );
  }

  async advanceStep(actor: Actor, workflowId: string): Promise<Row> {
    const wf = await this.db.one<{ current_step: number; locked_at: string | null }>(
      `SELECT current_step, locked_at FROM workflows WHERE id = $1 AND organization_id = $2`,
      [workflowId, actor.organizationId]
    );
    if (wf.locked_at) throw conflict('Workflow is locked');
    if (Number(wf.current_step) >= 4) throw conflict('Already at final step');
    return this.db.one(
      `UPDATE workflows SET current_step = current_step + 1, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [workflowId]
    );
  }

  /**
   * The workflow for a package, or null. The take-off consumer creates workflows without
   * anyone visiting the app, so the UI has to be able to find one it never started.
   */
  async findWorkflowByPackage(actor: Actor, packageId: string): Promise<Row | null> {
    const rows = await this.db.query(
      `SELECT * FROM workflows WHERE package_id = $1 AND organization_id = $2 AND archived_at IS NULL`,
      [packageId, actor.organizationId]
    );
    return rows[0] ?? null;
  }

  /**
   * Launch tender preparation from a completed BuildFlow take-off.
   *
   * Called by the queue consumer, never from an HTTP route — the actor is built from the
   * message, so this bypasses the request authenticator by design.
   *
   * Three things are deliberate:
   *
   *  - `ON CONFLICT (package_id)` rather than createWorkflow's read-then-insert, which
   *    races against the unique index under at-least-once delivery.
   *  - **`current_step` is never written.** A new row takes DEFAULT 1 — Tender Launch
   *    Pack. A workflow already at step 3 stays at step 3: a take-off re-run refreshes
   *    the data it carries, it does not rewind whoever is working through the wizard.
   *  - `step_data` is merged, not replaced, so a redelivery is a no-op in effect.
   */
  async launchFromTakeoff(actor: Actor, message: TakeoffCompletion): Promise<Row> {
    return this.db.transaction(async (client) => {
      const workflow = await this.db.one<{ id: string; organization_id: string }>(
        `INSERT INTO workflows (package_id, organization_id, created_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (package_id) DO UPDATE SET updated_at = NOW()
         RETURNING *`,
        [message.packageId, actor.organizationId, actor.userId], client
      );
      // The package already belongs to someone else's workflow. Refuse rather than
      // quietly writing another organisation's take-off into it.
      if (String(workflow.organization_id) !== actor.organizationId) {
        throw conflict('A workflow for this package belongs to another organization');
      }
      return this.db.one(
        `UPDATE workflows
         SET step_data = COALESCE(step_data, '{}'::jsonb)
                         || jsonb_build_object('takeoff', $2::jsonb, 'takeoffReceivedAt', to_jsonb(NOW())),
             updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [workflow.id, JSON.stringify(message)], client
      );
    });
  }

  // ── Step 1: Shortlist (Tender Launch Pack) ────────────────────────────────

  async getShortlists(actor: Actor, workflowId: string): Promise<Row[]> {
    await this.assertWorkflowAccess(actor, workflowId);
    const shortlists = await this.db.query(
      `SELECT sl.*, ARRAY(
        SELECT json_build_object('id', se.id, 'subcontractor_id', se.subcontractor_id, 'rank', se.rank,
          'performance_score', se.performance_score, 'compliance_flags', se.compliance_flags,
          'board_approved', se.board_approved)
        FROM shortlist_entries se WHERE se.shortlist_id = sl.id ORDER BY se.rank
      ) AS entries
       FROM shortlists sl WHERE sl.workflow_id = $1 ORDER BY sl.trade_category`,
      [workflowId]
    );
    return shortlists;
  }

  /**
   * Candidates from SCMS for one trade. Routed through here rather than straight to
   * ScmsReadDatabase so the workflow access check stays in one place — the SCMS module has
   * no idea what a TPS workflow is.
   */
  async listShortlistCandidates(actor: Actor, workflowId: string, tradeCategory: string, limit: number): Promise<Row[]> {
    await this.assertWorkflowAccess(actor, workflowId);
    return this.scms.getCandidatesForTrade(actor, tradeCategory, limit);
  }

  async confirmShortlist(actor: Actor, workflowId: string, input: {
    tradeCategory: string;
    boardOverrideNotes?: string;
    entries: Array<{ subcontractorId: string; rank: number; performanceScore?: number; complianceFlags?: Record<string, unknown> }>;
  }): Promise<Row> {
    await this.assertWorkflowAccess(actor, workflowId);
    return this.db.transaction(async (client) => {
      const shortlist = await this.db.one(
        `INSERT INTO shortlists (workflow_id, trade_category, confirmed_at, board_override_notes)
         VALUES ($1,$2,NOW(),$3)
         ON CONFLICT (workflow_id, trade_category) DO UPDATE SET
           confirmed_at = NOW(), board_override_notes = EXCLUDED.board_override_notes RETURNING *`,
        [workflowId, input.tradeCategory, input.boardOverrideNotes ?? null], client
      );
      await client.query(`DELETE FROM shortlist_entries WHERE shortlist_id = $1`, [shortlist.id]);
      for (const entry of input.entries) {
        await client.query(
          `INSERT INTO shortlist_entries (shortlist_id, subcontractor_id, rank, performance_score, compliance_flags)
           VALUES ($1,$2,$3,$4,$5)`,
          [shortlist.id, entry.subcontractorId, entry.rank, entry.performanceScore ?? null,
           entry.complianceFlags ? JSON.stringify(entry.complianceFlags) : null]
        );
      }
      return shortlist;
    });
  }

  // ── Step 2: ITT Dispatch ──────────────────────────────────────────────────

  async dispatchItt(actor: Actor, workflowId: string): Promise<Row[]> {
    await this.assertWorkflowAccess(actor, workflowId);
    const entries = await this.db.query<{ id: string }>(
      `SELECT se.id FROM shortlist_entries se
       JOIN shortlists sl ON sl.id = se.shortlist_id
       WHERE sl.workflow_id = $1 AND sl.confirmed_at IS NOT NULL`,
      [workflowId]
    );
    return Promise.all(entries.map((e) => this.db.one(
      `INSERT INTO itt_dispatch (shortlist_entry_id, dispatched_at)
       VALUES ($1, NOW()) ON CONFLICT (shortlist_entry_id) DO UPDATE SET dispatched_at = NOW() RETURNING *`,
      [e.id]
    )));
  }

  async recordIttResponse(actor: Actor, dispatchId: string, response: string): Promise<Row> {
    const dispatch = await this.db.one<{ shortlist_entry_id: string }>(
      `SELECT shortlist_entry_id FROM itt_dispatch WHERE id = $1`, [dispatchId]
    );
    const entry = await this.db.one<{ shortlist_id: string }>(
      `SELECT shortlist_id FROM shortlist_entries WHERE id = $1`, [String(dispatch.shortlist_entry_id)]
    );
    const shortlist = await this.db.one<{ workflow_id: string }>(
      `SELECT workflow_id FROM shortlists WHERE id = $1`, [String(entry.shortlist_id)]
    );
    await this.assertWorkflowAccess(actor, String(shortlist.workflow_id));
    return this.db.one(
      `UPDATE itt_dispatch SET response = $1, responded_at = NOW() WHERE id = $2 RETURNING *`,
      [response, dispatchId]
    );
  }

  async listIttDispatch(actor: Actor, workflowId: string): Promise<Row[]> {
    await this.assertWorkflowAccess(actor, workflowId);
    return this.db.query(
      `SELECT d.*, se.rank, se.subcontractor_id, sl.trade_category
       FROM itt_dispatch d
       JOIN shortlist_entries se ON se.id = d.shortlist_entry_id
       JOIN shortlists sl ON sl.id = se.shortlist_id
       WHERE sl.workflow_id = $1 ORDER BY sl.trade_category, se.rank`,
      [workflowId]
    );
  }

  // ── Step 3: Comparative ───────────────────────────────────────────────────

  async listComparative(actor: Actor, workflowId: string): Promise<Row[]> {
    await this.assertWorkflowAccess(actor, workflowId);
    return this.db.query(`SELECT * FROM comparative WHERE workflow_id = $1 ORDER BY tenderer_name`, [workflowId]);
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
      `INSERT INTO comparative (workflow_id, tenderer_name, tendered_sum, estimate_sum, scope_compliance, qualifications, recommendation)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT DO NOTHING RETURNING *`,
      [workflowId, input.tendererName, input.tenderedSum ?? null, input.estimateSum ?? null,
       input.scopeCompliance ? JSON.stringify(input.scopeCompliance) : null,
       input.qualifications ?? null, input.recommendation ?? null]
    );
  }

  // ── Step 4: Submission ────────────────────────────────────────────────────

  async getSubmission(actor: Actor, workflowId: string): Promise<Row | null> {
    await this.assertWorkflowAccess(actor, workflowId);
    const rows = await this.db.query(`SELECT * FROM submission WHERE workflow_id = $1`, [workflowId]);
    return rows[0] ?? null;
  }

  async saveSubmission(actor: Actor, workflowId: string, input: {
    packages: unknown[];
    aggregateTotal?: number;
  }): Promise<Row> {
    await this.assertWorkflowAccess(actor, workflowId);
    return this.db.one(
      `INSERT INTO submission (workflow_id, packages, aggregate_total)
       VALUES ($1,$2,$3)
       ON CONFLICT (workflow_id) DO UPDATE SET packages = EXCLUDED.packages, aggregate_total = EXCLUDED.aggregate_total, updated_at = NOW()
       RETURNING *`,
      [workflowId, JSON.stringify(input.packages), input.aggregateTotal ?? null]
    );
  }

  async boardApproveSubmission(actor: Actor, workflowId: string): Promise<Row> {
    await this.assertWorkflowAccess(actor, workflowId);
    return this.db.one(
      `UPDATE submission SET board_approved_at = NOW(), board_approved_by = $1
       WHERE workflow_id = $2 AND board_approved_at IS NULL RETURNING *`,
      [actor.userId, workflowId]
    );
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async assertWorkflowAccess(actor: Actor, workflowId: string): Promise<void> {
    const rows = await this.db.query(
      `SELECT id FROM workflows WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL`,
      [workflowId, actor.organizationId]
    );
    if (rows.length === 0) throw notFound('Workflow not found or access denied');
  }
}
