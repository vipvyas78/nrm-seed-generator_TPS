import type { Attribution, BoqReadDatabase } from './boqReadDb.js';
import type { Database, Row } from './db.js';
import type { DocumentLinkProvider } from './documentLinkProvider.js';
import { conflict, notFound } from './errors.js';
import type { ScmsReadDatabase } from './scmsReadDb.js';
import type { TakeoffCompletion } from './takeoffCompletion.js';
import type { Actor } from './types.js';

/**
 * The one-line "why was this firm suggested" shown beside each name at the tender launch
 * meeting.
 *
 * Composed from the signals the ranking actually used — nothing is inferred or invented.
 * The matched trade leads because it is what makes a loose match visible: a firm reached
 * through "Electrical Wholesalers" for an Electrical package should be obvious at a glance,
 * not buried. "No performance history" is stated outright rather than shown as a zero,
 * because unrated and bad are not the same thing.
 */
function describeSuggestion(c: Row): string {
  const parts: string[] = [];
  const trades = (c.matched_trades as string[] | null) ?? [];
  if (trades.length > 0) {
    const shown = trades.slice(0, 2).join(', ');
    parts.push(`Listed for ${shown}${trades.length > 2 ? ` +${trades.length - 2} more` : ''}`);
  }
  const ratings = Number(c.ratings_count ?? 0);
  parts.push(c.performance_score != null && ratings > 0
    ? `scored ${Number(c.performance_score).toFixed(0)}/100 over ${ratings} job${ratings === 1 ? '' : 's'}`
    : 'no performance history');
  parts.push(`profile ${Number(c.profile_completeness_pct ?? 0)}% complete`);

  const flags = (c.compliance_flags ?? {}) as Record<string, unknown>;
  const lapsed = [flags.pl_active ? null : 'PL', flags.el_active ? null : 'EL'].filter(Boolean);
  if (lapsed.length > 0) parts.push(`${lapsed.join('/')} insurance lapsed`);
  if (flags.pqq_status === 'approved') parts.push('PQQ approved');
  if (flags.at_risk) parts.push('flagged at risk');
  return parts.join(' · ');
}

/**
 * What distinguishes this firm, in one line.
 *
 * Assembled strictly from what the register records — value bands, regional coverage,
 * accreditations, breadth of trades, rating history. Nothing is inferred and nothing is
 * phrased as a claim the register does not make: a firm with none of these fields filled
 * in gets "no distinguishing detail on file", not an invented strength.
 */
function describeUsp(c: Row): string {
  const parts: string[] = [];
  const bands = (c.value_bands as string[] | null) ?? [];
  const regions = (c.regional_coverage as string[] | null) ?? [];
  const flags = (c.compliance_flags ?? {}) as Record<string, unknown>;
  const accreditations = (flags.accreditations as string[] | null) ?? [];
  const trades = Number(c.trade_count ?? 0);
  const ratings = Number(c.ratings_count ?? 0);

  if (bands.length > 0) parts.push(`Works ${bands.join(', ')}`);
  if (regions.length > 0) {
    parts.push(regions.length > 3 ? `${regions.length} regions` : regions.join('/'));
  }
  if (accreditations.length > 0) parts.push(accreditations.join(', '));
  if (trades > 1) parts.push(`${trades} trades`);
  if (c.performance_score != null && ratings > 0) {
    parts.push(`rated ${Number(c.performance_score).toFixed(0)}/100`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'No distinguishing detail on file';
}

/**
 * Stands in for a subcontractor on packages where the supply chain has not been built.
 *
 * A fixed sentinel rather than a random id so it is recognisable wherever it appears, and so
 * a stray row can never be mistaken for a real register entry. It corresponds to no firm in
 * SCMS, which is the point — the nil UUID makes an accidental insert fail its foreign-key
 * intent loudly rather than quietly creating a shortlist against nothing.
 */
const PLACEHOLDER_SUBCONTRACTOR_ID = '00000000-0000-0000-0000-000000000000';

/**
 * How a package's share of the measured BoQ is decided.
 *
 * NRM codes are precise and used whenever present. The description fallback exists for
 * packages nobody has coded yet, and it is withheld from consultant appointments: an
 * Acoustics package matched eighteen construction lines — acoustic floating floors, acoustic
 * wall linings — purely because their descriptions contain the word "acoustic". The
 * acoustician designs those; they do not install them. A package carrying an authored bill
 * is priced from that bill, so guessing at measured lines for it can only be wrong.
 */
function attributionFor(pkg: Row): Attribution {
  return {
    ge_codes: (pkg.boq_ge_codes as string[]) ?? [],
    element_prefixes: (pkg.boq_element_prefixes as string[]) ?? [],
    // Named lines this package claims or disowns despite its code — see migration 014.
    include_terms: (pkg.boq_include_terms as string[]) ?? [],
    exclude_terms: (pkg.boq_exclude_terms as string[]) ?? [],
    // Never fall back to the description matcher. It was a stopgap for packages nobody had
    // coded, and it cannot work: a BoQ description is a measured item, not a trade name, so
    // matching prose picks up whatever shares a word. "External FF&E" claimed every line
    // containing "external" — soffits, drainage, condensers, site clearance — and Acoustics
    // claimed acoustic floors it would never install. That was the source of most of the
    // double-counting, and no threshold fixes it.
    //
    // A package with no NRM codes therefore gets an empty bill, which states plainly that
    // its attribution has not been set. That is the honest answer, and a QS can see it.
    trade_terms: []
  };
}

export class TenderPrepDatabase {
  constructor(
    private readonly db: Database,
    private readonly scms: ScmsReadDatabase,
    private readonly boq: BoqReadDatabase,
    // Optional: without one configured, documents are still listed, just with url: null.
    private readonly documentLinks?: DocumentLinkProvider
  ) {}

  /**
   * The BoQ this workflow's tender is priced from, resolved through the take-off that
   * launched it. Null when the workflow was started by hand and carries no take-off, or
   * when the take-off produced no completed BoQ.
   */
  private async boqIdFor(workflowId: string): Promise<string | null> {
    const wf = await this.db.one<{ step_data: { takeoff?: { takeoffId?: string } } }>(
      `SELECT step_data FROM workflows WHERE id = $1`, [workflowId]
    );
    const takeoffId = wf.step_data?.takeoff?.takeoffId;
    if (!takeoffId) return null;
    const boq = await this.boq.findBoqForTakeoff(takeoffId);
    return boq ? String(boq.boq_id) : null;
  }

  /**
   * The Invitation to Tender for one package, assembled from live project data.
   *
   * Everything a tenderer is being asked to price and everything they are bound by:
   * the scope, the measured bill, the full document schedule, and the recipients. Held as
   * structured data rather than a rendered document so the same assembly can drive the
   * screen, an export and, later, the email — and so the review notes below can be
   * computed rather than written by hand.
   *
   * Rates are never included. The take-off carries the cost-plan estimate; issuing it would
   * anchor the tender and disclose our own number.
   */
  async getPackageItt(actor: Actor, workflowId: string, packageName: string): Promise<Row> {
    await this.assertWorkflowAccess(actor, workflowId);
    const wf = await this.db.one<{ step_data: { takeoff?: Record<string, unknown> } }>(
      `SELECT step_data FROM workflows WHERE id = $1`, [workflowId]
    );
    const takeoff = wf.step_data?.takeoff ?? {};
    const takeoffId = takeoff.takeoffId ? String(takeoff.takeoffId) : null;

    const [pkg] = await this.db.query<Row>(
      `SELECT pc.*,
              EXISTS (SELECT 1 FROM package_bill_lines bl WHERE bl.package_config_id = pc.id) AS has_authored_bill
         FROM package_config pc WHERE pc.organization_id = $1 AND pc.name = $2
        ORDER BY pc.project_id NULLS LAST LIMIT 1`,
      [actor.organizationId, packageName]
    );
    if (!pkg) throw notFound('Package is not configured');

    // Recipients are the firms the tender launch meeting actually selected — not everyone
    // considered. An ITT to a declined firm is the failure this whole step exists to avoid.
    const recipients = await this.db.query(
      `SELECT se.subcontractor_id, se.rank, se.suggestion_reason
         FROM shortlist_entries se
         JOIN shortlists sl ON sl.id = se.shortlist_id
        WHERE sl.workflow_id = $1 AND sl.package_name = $2 AND se.selected = TRUE
        ORDER BY se.rank`,
      [workflowId, packageName]
    );
    const [shortlist] = await this.db.query<Row>(
      `SELECT route_of_procurement, confirmed_at FROM shortlists
        WHERE workflow_id = $1 AND package_name = $2`,
      [workflowId, packageName]
    );

    const boqSession = takeoffId ? await this.boq.findBoqForTakeoff(takeoffId) : null;
    const boqLines = boqSession
      ? await this.boq.linesForPackage(String(boqSession.boq_id), attributionFor(pkg))
      : [];
    const rawDocuments = boqSession
      ? await this.boq.documentsForSession(String(boqSession.session_id))
      : [];
    // Best-effort: a document TPS can't resolve a link for still appears, just with
    // url: null — a broken lookup should never block issuing the ITT itself.
    const documents = this.documentLinks
      ? await Promise.all(rawDocuments.map(async (d) => ({
          ...d, url: await this.documentLinks!.linkFor(String(d.filename))
        })))
      : rawDocuments.map((d) => ({ ...d, url: null }));

    // Authored lines: surveys, staged fees — anything the take-off cannot measure. A package
    // may carry both, so they are appended rather than substituted, and each line says which
    // source it came from so a measured quantity is never confused with an authored item.
    const billLines = await this.db.query<Row>(
      `SELECT seq, section, ref, description, unit, quantity, required_for, notes
         FROM package_bill_lines WHERE package_config_id = $1 ORDER BY seq`,
      [pkg.id]
    );

    // Sections 1, 3 and 6 of the client's ITT structure: what must come back, who provides
    // what, and the terms of employment the tenderer is pricing against.
    const returnForms = await this.listReturnForms(actor);
    const attendances = await this.listAttendances(actor, String(pkg.id));
    const scopeItems = await this.listScopeItems(actor, packageName);
    const [minutes] = await this.db.query<Row>(
      `SELECT form_of_subcontract, subcontract_type, executed_as, works_summary, status
         FROM precontract_minutes WHERE workflow_id = $1 AND package_name = $2`,
      [workflowId, packageName]
    );

    const priceable = boqLines.filter((l) => l.is_priceable).length;
    return {
      package_name: pkg.name,
      display_ref: pkg.sub_seq == null ? String(pkg.seq) : `${pkg.seq}.${pkg.sub_seq}`,
      // The route in force for this tender, not merely what the client's list specifies.
      route_of_procurement: shortlist?.route_of_procurement ?? pkg.route_of_procurement,
      takeoff: takeoff,
      boq_id: boqSession?.boq_id ?? null,
      confirmed_at: shortlist?.confirmed_at ?? null,
      recipients,
      boq_lines: boqLines,
      bill_lines: billLines,
      boq_summary: {
        total: boqLines.length, priceable, scope_only: boqLines.length - priceable,
        authored: billLines.length
      },
      documents,
      return_forms: returnForms,
      scope_items: scopeItems,
      scope_summary: {
        total: scopeItems.length,
        package_specific: scopeItems.filter((s) => s.designation === 'Package').length,
        general: scopeItems.filter((s) => s.designation === 'General').length,
        // Priced into the subcontract vs carried by the main contractor's own budget.
        contract: scopeItems.filter((s) => s.procurement_stage === 'Contract').length,
        profit_plan: scopeItems.filter((s) => s.procurement_stage === 'Profit Plan').length
      },
      attendances,
      attendance_summary: {
        total: attendances.length,
        subcontractor: attendances.filter((a) => a.owner === 'SC').length,
        main_contractor: attendances.filter((a) => a.owner === 'H').length,
        joint: attendances.filter((a) => a.owner === 'J').length,
        not_available: attendances.filter((a) => a.owner === 'N/A').length
      },
      precontract_minutes: minutes ?? null,
      // Value engineering is a condition of a compliant tender, carried on every ITT.
      value_engineering_required: true,
      // Computed rather than authored, so an ITT cannot look complete when it is not.
      review_notes: [
        boqLines.length === 0 && billLines.length === 0 &&
          'Nothing to price: no measured lines are attributed to this package and no bill has been written for it.',
        boqLines.length > 0 && priceable === 0 && billLines.length === 0 &&
          'Every attributed line has zero quantity; the tenderer has scope but no quantities.',
        recipients.length === 0 && 'No subcontractors have been selected for this package at the tender launch meeting.',
        !boqSession && 'No completed take-off BoQ is linked to this workflow.',
        documents.length === 0 && 'No tender documents are attached to this project.',
        // Scope and attendances are what make the pricing document coordinate: they define
        // everything the subcontractor carries around the measured bill. Missing either and
        // every tenderer guesses differently, so neither the price nor the comparison holds.
        scopeItems.length === 0 &&
          'No scope of works items for this package. The bill states what is measured but not what the subcontractor carries around it, so returns will not be comparable.',
        attendances.length === 0 &&
          'No schedule of attendances. Every return will be qualified — no tenderer prices attendances they have not been told they carry.',
        returnForms.length === 0 &&
          'No returnable forms configured, so the ITT does not state what a compliant tender must contain.'
        // The form of subcontract and pre-contract minutes are issued for information only:
        // they tell a tenderer what they would be signing up to, and are not priced against.
        // Their absence is therefore not a blocker on issue.
      ].filter(Boolean)
    };
  }

  /**
   * Scope items falling to one package.
   *
   * Matched on the package name as the client's matrix writes it. Their vocabulary and the
   * configured package list do not fully agree — the matrix has "Mechanical & Plumbing"
   * where the configuration has "MEP" — so an unmatched package returns nothing rather than
   * guessing, and the gap is reported by scopeMatrixCoverage below.
   */
  async listScopeItems(actor: Actor, packageName: string): Promise<Row[]> {
    return this.db.query(
      `SELECT ref, description, procurement_stage, designation
         FROM scope_items
        WHERE organization_id = $1 AND $2 = ANY (packages)
        ORDER BY seq`,
      [actor.organizationId, packageName]
    );
  }

  async replaceScopeItems(actor: Actor, items: Array<{
    ref: number; description: string; procurementStage?: string | null;
    designation?: string | null; packages: string[];
  }>): Promise<{ inserted: number }> {
    await this.db.transaction(async (client) => {
      await client.query(
        `DELETE FROM scope_items WHERE organization_id = $1 AND project_id IS NULL`,
        [actor.organizationId]
      );
      // seq is assigned on import: the client's `ref` is a hand-maintained label and is not
      // unique — three items in Appendix 1 share ref 888.
      let seq = 0;
      for (const i of items) {
        seq += 1;
        await client.query(
          `INSERT INTO scope_items (organization_id, seq, ref, description, procurement_stage, designation, packages)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [actor.organizationId, seq, i.ref, i.description,
           i.procurementStage ?? null, i.designation ?? null, i.packages]
        );
      }
    });
    return { inserted: items.length };
  }

  /**
   * Which package names in the scope matrix correspond to a configured package.
   *
   * A matrix name with no configured package means scope nobody will be asked to price; a
   * configured package absent from the matrix means a tenderer receives no scope items.
   * Both are worth seeing before an ITT goes out.
   */
  async scopeMatrixCoverage(actor: Actor): Promise<Row> {
    const rows = await this.db.query<{ pkg: string }>(
      `SELECT DISTINCT unnest(packages) AS pkg FROM scope_items WHERE organization_id = $1`,
      [actor.organizationId]
    );
    const configured = await this.db.query<{ name: string }>(
      `SELECT name FROM package_config WHERE organization_id = $1`, [actor.organizationId]
    );
    const matrixNames = new Set(rows.map((r) => String(r.pkg)));
    const configuredNames = new Set(configured.map((c) => String(c.name)));
    return {
      matrix_packages: matrixNames.size,
      configured_packages: configuredNames.size,
      matched: [...matrixNames].filter((n) => configuredNames.has(n)).sort(),
      in_matrix_only: [...matrixNames].filter((n) => !configuredNames.has(n)).sort(),
      configured_only: [...configuredNames].filter((n) => !matrixNames.has(n)).sort()
    };
  }

  /** What a compliant tender return must contain. The house standard, per organisation. */
  async listReturnForms(actor: Actor): Promise<Row[]> {
    return this.db.query(
      `SELECT seq, name, description, is_required FROM itt_return_forms
        WHERE organization_id = $1 ORDER BY seq`, [actor.organizationId]
    );
  }

  async replaceReturnForms(actor: Actor, forms: Array<{
    seq: number; name: string; description?: string; isRequired?: boolean;
  }>): Promise<Row[]> {
    await this.db.transaction(async (client) => {
      await client.query(`DELETE FROM itt_return_forms WHERE organization_id = $1`, [actor.organizationId]);
      for (const f of forms) {
        await client.query(
          `INSERT INTO itt_return_forms (organization_id, seq, name, description, is_required)
           VALUES ($1,$2,$3,$4,$5)`,
          [actor.organizationId, f.seq, f.name, f.description ?? null, f.isRequired ?? true]
        );
      }
    });
    return this.listReturnForms(actor);
  }

  /**
   * The schedule of attendances — who provides what, line by line.
   *
   * A package-specific override wins over the general schedule where one exists, so a trade
   * that carries its own craneage can say so without a second copy of all 64 rows.
   */
  async listAttendances(actor: Actor, packageConfigId?: string | null): Promise<Row[]> {
    if (packageConfigId) {
      const specific = await this.db.query(
        `SELECT seq, group_name, description, owner, notes FROM attendance_items
          WHERE organization_id = $1 AND package_config_id = $2 ORDER BY seq`,
        [actor.organizationId, packageConfigId]
      );
      if (specific.length > 0) return specific;
    }
    return this.db.query(
      `SELECT seq, group_name, description, owner, notes FROM attendance_items
        WHERE organization_id = $1 AND package_config_id IS NULL ORDER BY seq`,
      [actor.organizationId]
    );
  }

  async replaceAttendances(actor: Actor, items: Array<{
    group: string; description: string; owner: string; notes?: string;
  }>): Promise<Row[]> {
    await this.db.transaction(async (client) => {
      await client.query(
        `DELETE FROM attendance_items WHERE organization_id = $1 AND package_config_id IS NULL`,
        [actor.organizationId]
      );
      let seq = 0;
      for (const i of items) {
        seq += 1;
        await client.query(
          `INSERT INTO attendance_items (organization_id, seq, group_name, description, owner, notes)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [actor.organizationId, seq, i.group, i.description, i.owner, i.notes ?? null]
        );
      }
    });
    return this.listAttendances(actor, null);
  }

  /** The authored bill for a package — surveys, staged fees, anything a take-off cannot measure. */
  async getPackageBill(actor: Actor, packageName: string): Promise<Row[]> {
    return this.db.query(
      `SELECT bl.* FROM package_bill_lines bl
         JOIN package_config pc ON pc.id = bl.package_config_id
        WHERE pc.organization_id = $1 AND pc.name = $2
        ORDER BY bl.seq`,
      [actor.organizationId, packageName]
    );
  }

  /**
   * Replaces a package's authored bill wholesale.
   *
   * A bill is a document, not a set of independent rows: a line removed from the client's
   * schedule has to disappear, and the numbering has to stay contiguous.
   */
  async replacePackageBill(actor: Actor, packageName: string, lines: Array<{
    section?: string; ref?: string; description: string; unit?: string;
    quantity?: number; requiredFor?: string; notes?: string;
  }>): Promise<Row[]> {
    const [pkg] = await this.db.query<Row>(
      `SELECT id FROM package_config WHERE organization_id = $1 AND name = $2
        ORDER BY project_id NULLS LAST LIMIT 1`,
      [actor.organizationId, packageName]
    );
    if (!pkg) throw notFound('Package is not configured');
    await this.db.transaction(async (client) => {
      await client.query(`DELETE FROM package_bill_lines WHERE package_config_id = $1`, [pkg.id]);
      let seq = 0;
      for (const l of lines) {
        seq += 1;
        await client.query(
          `INSERT INTO package_bill_lines (package_config_id, seq, section, ref, description, unit, quantity, required_for, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [pkg.id, seq, l.section ?? null, l.ref ?? null, l.description,
           l.unit ?? 'sum', l.quantity ?? null, l.requiredFor ?? null, l.notes ?? null]
        );
      }
    });
    return this.getPackageBill(actor, packageName);
  }

  /** The measured lines a package's ITT is priced against. */
  async getPackageBoq(actor: Actor, workflowId: string, packageName: string): Promise<Row> {
    await this.assertWorkflowAccess(actor, workflowId);
    const boqId = await this.boqIdFor(workflowId);
    if (!boqId) return { boq_id: null, lines: [], note: 'No completed take-off BoQ for this workflow' };
    const [pkg] = await this.db.query<Row>(
      `SELECT name, trade_terms, boq_ge_codes, boq_element_prefixes,
              boq_include_terms, boq_exclude_terms
         FROM package_config
        WHERE organization_id = $1 AND name = $2 ORDER BY project_id NULLS LAST LIMIT 1`,
      [actor.organizationId, packageName]
    );
    if (!pkg) throw notFound('Package is not configured');
    const lines = await this.boq.linesForPackage(boqId, attributionFor(pkg));
    return { boq_id: boqId, package_name: pkg.name, lines };
  }

  /**
   * Measured work that no configured package claims — the check to run before any ITT goes
   * out, because an unattributed line is work nobody has been asked to price.
   */
  async getUnattributedBoq(actor: Actor, workflowId: string): Promise<Row> {
    await this.assertWorkflowAccess(actor, workflowId);
    const boqId = await this.boqIdFor(workflowId);
    if (!boqId) return { boq_id: null, lines: [] };
    const packages = await this.db.query<Row>(
      `SELECT trade_terms, boq_ge_codes, boq_element_prefixes,
              boq_include_terms, boq_exclude_terms
         FROM package_config WHERE organization_id = $1`, [actor.organizationId]
    );
    const lines = await this.boq.unattributedLines(boqId, packages.map(attributionFor));
    return { boq_id: boqId, lines };
  }

  // ── Workflows ─────────────────────────────────────────────────────────────

  /** Every workflow the caller's organization can see, most recently updated first. */
  async listWorkflows(actor: Actor): Promise<Row[]> {
    return this.db.query(
      `SELECT * FROM workflows WHERE organization_id = $1 AND archived_at IS NULL ORDER BY updated_at DESC`,
      [actor.organizationId]
    );
  }

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
   * Move to any step, forwards or back.
   *
   * advanceStep only ever increments, which left the wizard one-way: having reached
   * Comparative Analysis there was no route back to the Tender Launch Pack to revise a
   * shortlist. Nothing about these steps is irreversible — the data for each is kept
   * independently — so going back is ordinary navigation, not a rollback. A locked
   * workflow still refuses, as it does for advance.
   */
  async setStep(actor: Actor, workflowId: string, step: number): Promise<Row> {
    const wf = await this.db.one<{ locked_at: string | null }>(
      `SELECT locked_at FROM workflows WHERE id = $1 AND organization_id = $2`,
      [workflowId, actor.organizationId]
    );
    if (wf.locked_at) throw conflict('Workflow is locked');
    return this.db.one(
      `UPDATE workflows SET current_step = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [workflowId, step]
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

  // ── Project configuration: the client's package breakdown ─────────────────

  /**
   * The configured package list for a project, falling back to the organisation's default
   * template (project_id IS NULL) when the project has no list of its own. Agreed with the
   * client at project set-up, not chosen per tender.
   */
  async listPackageConfig(actor: Actor, projectId: string | null): Promise<Row[]> {
    // Ordered (seq, sub_seq) so a breakdown sits directly under its parent: 42, 42.1, 42.2.
    // `is_heading` marks a parent that has been broken down — it is not tendered itself, its
    // children are, and every consumer needs to know not to shortlist against it.
    const select = `
      SELECT p.*,
             EXISTS (SELECT 1 FROM package_config c WHERE c.parent_id = p.id) AS is_heading,
             CASE WHEN p.sub_seq IS NULL THEN p.seq::text
                  ELSE p.seq || '.' || p.sub_seq END AS display_ref
        FROM package_config p
       WHERE p.organization_id = $1`;
    if (projectId) {
      const scoped = await this.db.query(
        `${select} AND p.project_id = $2 ORDER BY p.seq, p.sub_seq NULLS FIRST`,
        [actor.organizationId, projectId]
      );
      if (scoped.length > 0) return scoped;
    }
    return this.db.query(
      `${select} AND p.project_id IS NULL ORDER BY p.seq, p.sub_seq NULLS FIRST`,
      [actor.organizationId]
    );
  }

  /**
   * Replaces the configured list wholesale. Configuration is a list, not a set of
   * independent rows — a package dropped from the client's breakdown has to disappear, and
   * `seq` has to stay contiguous — so this deletes and reinserts inside one transaction
   * rather than upserting row by row.
   */
  async replacePackageConfig(actor: Actor, projectId: string | null, packages: Array<{
    seq: number; name: string; routeOfProcurement: string; tradeTerms?: string[];
    boqGeCodes?: string[]; boqElementPrefixes?: string[];
    boqIncludeTerms?: string[]; boqExcludeTerms?: string[]; notes?: string;
  }>): Promise<Row[]> {
    await this.db.transaction(async (client) => {
      // Upsert on name, rather than delete-then-reinsert.
      //
      // Deleting first destroyed every authored bill: package_bill_lines cascades off
      // package_config_id, so re-uploading the client's own package list silently wiped 890
      // lines of survey schedule and consultant fee schedules. Keeping the row — and
      // therefore its id — means the bills, breakdowns and attendance overrides hanging off
      // a package survive a re-import of the same list.
      //
      // Packages genuinely dropped from the list are removed, and their bills go with them,
      // which is right: a package that no longer exists should not keep a bill. Only
      // top-level rows are touched; a breakdown is removed by its parent's cascade.
      const names = packages.map((p) => p.name);
      await client.query(
        projectId
          ? `DELETE FROM package_config WHERE organization_id = $1 AND project_id = $2
               AND parent_id IS NULL AND NOT (name = ANY($3))`
          : `DELETE FROM package_config WHERE organization_id = $1 AND project_id IS NULL
               AND parent_id IS NULL AND NOT (name = ANY($2))`,
        projectId ? [actor.organizationId, projectId, names] : [actor.organizationId, names]
      );
      // seq is bumped out of the way first: the unique index on (org, project, seq, sub_seq)
      // would otherwise collide mid-update when the client reorders their list.
      await client.query(
        projectId
          ? `UPDATE package_config SET seq = seq + 100000
               WHERE organization_id = $1 AND project_id = $2 AND parent_id IS NULL`
          : `UPDATE package_config SET seq = seq + 100000
               WHERE organization_id = $1 AND project_id IS NULL AND parent_id IS NULL`,
        projectId ? [actor.organizationId, projectId] : [actor.organizationId]
      );
      for (const p of packages) {
        await client.query(
          `INSERT INTO package_config (organization_id, project_id, seq, name, route_of_procurement,
                                      trade_terms, boq_ge_codes, boq_element_prefixes,
                                      boq_include_terms, boq_exclude_terms, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (organization_id, project_id, name) DO UPDATE SET
             seq = EXCLUDED.seq,
             route_of_procurement = EXCLUDED.route_of_procurement,
             trade_terms = EXCLUDED.trade_terms,
             boq_ge_codes = EXCLUDED.boq_ge_codes,
             boq_element_prefixes = EXCLUDED.boq_element_prefixes,
             boq_include_terms = EXCLUDED.boq_include_terms,
             boq_exclude_terms = EXCLUDED.boq_exclude_terms,
             notes = EXCLUDED.notes,
             updated_at = NOW()`,
          [actor.organizationId, projectId, p.seq, p.name, p.routeOfProcurement,
           // No terms means the package name is the term — the common case where the
           // client's wording already matches how the register describes the trade.
           p.tradeTerms?.length ? p.tradeTerms : [p.name],
           p.boqGeCodes ?? [], p.boqElementPrefixes ?? [],
           p.boqIncludeTerms ?? [], p.boqExcludeTerms ?? [], p.notes ?? null]
        );
      }
      // Children follow their parent's number so 42.1 stays under 42 after a reorder.
      await client.query(
        `UPDATE package_config c SET seq = p.seq
           FROM package_config p WHERE c.parent_id = p.id AND c.seq <> p.seq`
      );
    });
    // Read back after the commit, not inside it: listPackageConfig goes through the pool,
    // so in-transaction it lands on a different connection and sees none of the new rows.
    return this.listPackageConfig(actor, projectId);
  }

  /** Routes offered in the picker, in the client's own wording. */
  async listRouteOptions(actor: Actor): Promise<Row[]> {
    return this.db.query(
      `SELECT label FROM route_options WHERE organization_id = $1 AND is_active ORDER BY sort_order, label`,
      [actor.organizationId]
    );
  }

  /**
   * Break a package into sub-packages — MEP into mechanical, electrical and plumbing, say.
   *
   * The parent stays as a heading and is no longer tendered itself; its children are. Each
   * child inherits the parent's route and trade terms unless given its own, because the
   * common case is splitting the lot without changing how it is bought.
   *
   * Replaces any existing breakdown wholesale. A breakdown is a shape, not a set of
   * independent rows: re-splitting three ways after a four-way split must leave three.
   */
  async splitPackage(actor: Actor, packageId: string, children: Array<{
    name: string; routeOfProcurement?: string; tradeTerms?: string[];
    boqGeCodes?: string[]; boqElementPrefixes?: string[];
    boqIncludeTerms?: string[]; boqExcludeTerms?: string[];
  }>): Promise<Row[]> {
    const parent = await this.db.one<Row>(
      `SELECT * FROM package_config WHERE id = $1 AND organization_id = $2`,
      [packageId, actor.organizationId]
    );
    if (parent.parent_id) throw conflict('This package is already a breakdown of another package');

    await this.db.transaction(async (client) => {
      await client.query(`DELETE FROM package_config WHERE parent_id = $1`, [packageId]);
      let i = 0;
      for (const c of children) {
        i += 1;
        await client.query(
          `INSERT INTO package_config (organization_id, project_id, parent_id, seq, sub_seq, name,
                                       route_of_procurement, trade_terms, boq_ge_codes,
                                       boq_element_prefixes, boq_include_terms, boq_exclude_terms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [actor.organizationId, parent.project_id, packageId, parent.seq, i, c.name,
           c.routeOfProcurement ?? parent.route_of_procurement,
           c.tradeTerms?.length ? c.tradeTerms : [c.name],
           c.boqGeCodes ?? [], c.boqElementPrefixes ?? [],
           c.boqIncludeTerms ?? [], c.boqExcludeTerms ?? []]
        );
      }
    });
    return this.db.query(
      `SELECT * FROM package_config WHERE parent_id = $1 ORDER BY sub_seq`, [packageId]
    );
  }

  /** Removes a breakdown, returning the package to a single tendered lot. */
  async unsplitPackage(actor: Actor, packageId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM package_config WHERE parent_id = $1
        AND organization_id = $2`, [packageId, actor.organizationId]
    );
  }

  // ── Step 1: Tender Launch Pack ────────────────────────────────────────────

  /**
   * The tender launch table: one row per configured package, in the client's own order,
   * each carrying its procurement route and the firms the software suggests for it.
   *
   * Suggestions are recomputed from SCMS on every read so the register stays live, then
   * merged with whatever the meeting has already decided — `selected` and any notes are
   * persisted and win. A firm previously selected but no longer suggested (its SCMS
   * record changed) is still returned, flagged `off_register`, rather than vanishing from
   * a decision the meeting already took.
   */
  async getTenderLaunchTable(actor: Actor, workflowId: string, perPackage: number): Promise<Row[]> {
    await this.assertWorkflowAccess(actor, workflowId);
    const workflow = await this.db.one<{ step_data: { takeoff?: { projectId?: string | null } } }>(
      `SELECT step_data FROM workflows WHERE id = $1`, [workflowId]
    );
    const projectId = workflow.step_data?.takeoff?.projectId ?? null;
    const packages = await this.listPackageConfig(actor, projectId);

    const shortlists = await this.db.query<{ id: string; package_name: string; confirmed_at: string | null; board_override_notes: string | null; route_of_procurement: string | null }>(
      `SELECT id, package_name, confirmed_at, board_override_notes, route_of_procurement
         FROM shortlists WHERE workflow_id = $1`,
      [workflowId]
    );
    const routeOptions = (await this.listRouteOptions(actor)).map((r) => String(r.label));

    return Promise.all(packages.map(async (pkg) => {
      const terms = (pkg.trade_terms as string[] | null) ?? [];
      // A heading is not tendered — its breakdown is — so no candidates are fetched for it.
      const suggested = pkg.is_heading
        ? []
        : await this.scms.getCandidatesForPackage(terms.length ? terms : [String(pkg.name)], perPackage);
      const shortlist = shortlists.find((s) => s.package_name === pkg.name);
      // An authored bill on a package that has since been broken down is stranded: the
      // heading is not tendered, so nobody is asked to price those lines. Which line belongs
      // to which sub-package is a commercial decision, so this is surfaced rather than guessed.
      const [billCount] = await this.db.query<{ n: string }>(
        `SELECT count(*) AS n FROM package_bill_lines WHERE package_config_id = $1`, [pkg.id]
      );
      const strandedBill = pkg.is_heading ? Number(billCount?.n ?? 0) : 0;
      const decided = shortlist
        ? await this.db.query<Row>(
            `SELECT subcontractor_id, selected, suggestion_reason, rank FROM shortlist_entries
              WHERE shortlist_id = $1 ORDER BY rank`, [shortlist.id])
        : [];
      const selectedIds = new Set(decided.filter((d) => d.selected).map((d) => String(d.subcontractor_id)));
      const suggestedIds = new Set(suggested.map((c) => String(c.subcontractor_id)));

      // A package with no firms in the register is a supply chain that has not been built
      // yet, not an error. Surfacing a named placeholder makes that visible on the tender
      // launch table instead of an empty cell that reads like a bug. It is deliberately not
      // selectable: it has no register entry, so it cannot be shortlisted or issued an ITT.
      const withPlaceholder = (!pkg.is_heading && suggested.length === 0)
        ? [{
            subcontractor_id: PLACEHOLDER_SUBCONTRACTOR_ID,
            name: 'Rancon Group',
            status: 'PLACEHOLDER',
            profile_completeness_pct: 0,
            performance_score: null,
            ratings_count: 0,
            matched_trades: [],
            selected: false,
            usp: 'Placeholder — no supply chain built for this package yet',
            suggestion_reason: 'No firm in the register carries this trade. Build the supply chain for this package before it can be tendered.',
            compliance_flags: {},
            is_placeholder: true,
            off_register: false
          }]
        : [];

      return {
        package_config_id: pkg.id,
        seq: pkg.seq,
        sub_seq: pkg.sub_seq,
        display_ref: pkg.display_ref,
        is_heading: pkg.is_heading,
        is_sub_package: pkg.parent_id != null,
        package_name: pkg.name,
        // What the client's list says, versus what this tender actually chose. The picker
        // shows the configured route until the meeting decides otherwise.
        configured_route: pkg.route_of_procurement,
        route_of_procurement: shortlist?.route_of_procurement ?? pkg.route_of_procurement,
        route_options: routeOptions,
        trade_terms: terms,
        stranded_bill_lines: strandedBill,
        notes: pkg.notes,
        confirmed_at: shortlist?.confirmed_at ?? null,
        board_override_notes: shortlist?.board_override_notes ?? null,
        subcontractors: [
          ...withPlaceholder,
          ...suggested.map((c) => ({
            ...c,
            selected: selectedIds.has(String(c.subcontractor_id)),
            suggestion_reason: describeSuggestion(c),
            usp: describeUsp(c),
            off_register: false
          })),
          // Decided-but-no-longer-suggested: keep the meeting's record visible.
          ...decided
            .filter((d) => d.selected && !suggestedIds.has(String(d.subcontractor_id)))
            .map((d) => ({
              subcontractor_id: d.subcontractor_id,
              name: '(no longer in the register for this package)',
              selected: true,
              suggestion_reason: d.suggestion_reason,
              off_register: true
            }))
        ]
      } as Row;
    }));
  }

  /**
   * Records what the tender launch meeting decided for one package.
   *
   * Every firm put in front of the meeting is stored, not just the chosen ones, with the
   * reasoning it was shown against — so the record answers "who was considered, and why"
   * months later, not merely "who won". `rank` is the order they were presented in.
   */
  async savePackageSelection(actor: Actor, workflowId: string, input: {
    packageName: string;
    packageSeq?: number;
    routeOfProcurement?: string;
    boardOverrideNotes?: string;
    entries: Array<{
      subcontractorId: string; rank: number; selected: boolean; suggestionReason?: string;
      performanceScore?: number; complianceFlags?: Record<string, unknown>;
    }>;
  }): Promise<Row> {
    await this.assertWorkflowAccess(actor, workflowId);
    return this.db.transaction(async (client) => {
      const shortlist = await this.db.one(
        `INSERT INTO shortlists (workflow_id, package_name, package_seq, route_of_procurement, confirmed_at, board_override_notes)
         VALUES ($1,$2,$3,$4,NOW(),$5)
         ON CONFLICT (workflow_id, package_name) DO UPDATE SET
           package_seq = EXCLUDED.package_seq,
           route_of_procurement = EXCLUDED.route_of_procurement,
           confirmed_at = NOW(),
           board_override_notes = EXCLUDED.board_override_notes
         RETURNING *`,
        [workflowId, input.packageName, input.packageSeq ?? null,
         input.routeOfProcurement ?? null, input.boardOverrideNotes ?? null], client
      );
      await client.query(`DELETE FROM shortlist_entries WHERE shortlist_id = $1`, [shortlist.id]);
      for (const entry of input.entries) {
        await client.query(
          `INSERT INTO shortlist_entries
             (shortlist_id, subcontractor_id, rank, performance_score, compliance_flags,
              suggestion_reason, selected, selected_at, selected_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,
                   CASE WHEN $7 THEN NOW() END,
                   CASE WHEN $7 THEN $8::uuid END)`,
          [shortlist.id, entry.subcontractorId, entry.rank, entry.performanceScore ?? null,
           entry.complianceFlags ? JSON.stringify(entry.complianceFlags) : null,
           entry.suggestionReason ?? null, entry.selected, actor.userId]
        );
      }
      return shortlist;
    });
  }

  /**
   * Every package with an ITT to show: those the meeting confirmed and selected firms for.
   * The index behind Step 2 — one line per package, without assembling every pack.
   */
  async listItts(actor: Actor, workflowId: string): Promise<Row[]> {
    await this.assertWorkflowAccess(actor, workflowId);
    return this.db.query(
      `SELECT sl.package_name,
              sl.package_seq,
              sl.route_of_procurement,
              sl.confirmed_at,
              count(*) FILTER (WHERE se.selected) AS recipients,
              count(d.id) FILTER (WHERE d.dispatched_at IS NOT NULL) AS dispatched,
              count(*) FILTER (WHERE se.selected AND d.response IS NOT NULL) AS responded
         FROM shortlists sl
         LEFT JOIN shortlist_entries se ON se.shortlist_id = sl.id
         LEFT JOIN itt_dispatch d ON d.shortlist_entry_id = se.id
        WHERE sl.workflow_id = $1
        GROUP BY sl.package_name, sl.package_seq, sl.route_of_procurement, sl.confirmed_at
        HAVING count(*) FILTER (WHERE se.selected) > 0
        ORDER BY sl.package_seq NULLS LAST, sl.package_name`,
      [workflowId]
    );
  }

  // ── Step 2: ITT Dispatch ──────────────────────────────────────────────────

  async dispatchItt(actor: Actor, workflowId: string): Promise<Row[]> {
    await this.assertWorkflowAccess(actor, workflowId);
    // `selected` only. Every firm considered at the tender launch meeting is stored, so
    // without this filter an ITT would go to the ones management deliberately declined.
    const entries = await this.db.query<{ id: string }>(
      `SELECT se.id FROM shortlist_entries se
       JOIN shortlists sl ON sl.id = se.shortlist_id
       WHERE sl.workflow_id = $1 AND sl.confirmed_at IS NOT NULL AND se.selected = TRUE`,
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
