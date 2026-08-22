import type { Attribution, BoqReadDatabase } from './boqReadDb.js';
import type { BuildflowBundle, BuildflowDocumentBundlesClient } from './buildflowDocumentBundlesClient.js';
import type { BuildflowDocumentLinksClient } from './buildflowDocumentLinksClient.js';
import type { BuildflowSpecClauseClient } from './buildflowSpecClauseClient.js';
import type { Database, Row } from './db.js';
import type { DocumentLinkProvider } from './documentLinkProvider.js';
import type { EmailAttachment, EmailService } from './emailService.js';
import { conflict, notFound } from './errors.js';
import { ittAttachmentsFor, type IttAttachment } from './ittAttachments.js';
import { renderIttEmail, type IttEmailDocumentLink, type IttEmailPack } from './ittEmail.js';
import type { ScmsReadDatabase } from './scmsReadDb.js';
import type { TakeoffCompletion, TakeoffTendered } from './takeoffCompletion.js';
import type { Actor } from './types.js';

/** Every ITT email is sent from this address, regardless of who confirms it in the UI. */
const ITT_FROM_ADDRESS = 'tenders@novamerx.ai';

/**
 * Total base64 attachment budget for one ITT email.
 *
 * A scope PDF and a pricing workbook run to tens of KB each, so even a firm invited to ten
 * packages sits far under this — it exists so a pathological package (a bill of tens of
 * thousands of lines) degrades to a link-only email instead of the provider rejecting the
 * message outright. Base64 costs ~33% over raw bytes, and this is measured on the encoded
 * string, which is what actually travels.
 */
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

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
    private readonly documentLinks?: DocumentLinkProvider,
    // Optional: without one configured, ITT emails send without document links.
    private readonly buildflowLinks?: BuildflowDocumentLinksClient,
    // Optional: without one configured, ITT emails send without a specification clauses section.
    private readonly specClauses?: BuildflowSpecClauseClient,
    // Optional: without one configured, ITT emails fall back to the flat per-document link
    // list — every document in the project, unnarrowed — instead of a per-package zip.
    private readonly bundles?: BuildflowDocumentBundlesClient,
    // Optional: without one configured, confirmAndSendItt records what it would have sent
    // instead of actually sending — see confirmAndSendItt.
    private readonly emailService?: EmailService,
    // When set, every ITT email is redirected to `to` (from `from`) instead of the
    // recipient's real SCMS contact address — lets "Confirm ITT" be exercised against real
    // packages without emailing real subcontractors.
    private readonly testEmailOverride?: { from: string; to: string } | null
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
   * Renders the ITT email for one package straight from a BoQ id, a take-off id and a
   * package name — no workflow, shortlist or confirmation required.
   *
   * For previewing what an ITT would look like ahead of, or independent of, the Step 2
   * dispatch flow that `getPackageItt`/`confirmAndSendItt` drive. It reuses the same
   * attribution logic those two use (`attributionFor`, `linesForPackage` /
   * `takeoffLinesForWorkPackage` / `takeoffLinesUnattributed`) so the BoQ lines it shows can
   * never disagree with what a real dispatch would carry — only recipients, documents and
   * spec clauses are omitted, since none of those depend on a workflow existing.
   */
  async previewIttEmail(actor: Actor, input: {
    boqId: string; takeoffId: string; packageName: string;
  }): Promise<{ subject: string; html: string; text: string; attachments: IttAttachment[] }> {
    const [pkg] = await this.db.query<Row>(
      `SELECT pc.* FROM package_config pc WHERE pc.organization_id = $1 AND pc.name = $2
        ORDER BY pc.project_id NULLS LAST LIMIT 1`,
      [actor.organizationId, input.packageName]
    );
    if (!pkg) throw notFound('Package is not configured');

    const boqLines = pkg.wp_code
      ? [
          ...await this.boq.takeoffLinesForWorkPackage(input.takeoffId, String(pkg.wp_code)),
          ...await this.boq.takeoffLinesUnattributed(input.takeoffId, attributionFor(pkg))
        ]
      : await this.boq.linesForPackage(input.boqId, attributionFor(pkg));

    const billLines = await this.db.query<Row>(
      `SELECT id, seq, section, ref, description, unit, quantity, required_for, notes
         FROM package_bill_lines WHERE package_config_id = $1 ORDER BY seq`,
      [pkg.id]
    );
    const returnForms = await this.listReturnForms(actor);
    const attendances = await this.listAttendances(actor, String(pkg.id));
    const scopeItems = await this.listScopeItems({ name: input.packageName, wp_code: pkg.wp_code });

    const previewSession = await this.boq.findBoqForTakeoff(input.takeoffId);
    const previewSpecDocuments = previewSession
      ? (await this.boq.specDocumentsForFilenames(
          String(previewSession.session_id),
          [...new Set(boqLines.flatMap((l) => (l.spec_source_files as string[] | null) ?? []))]
        )).map((d) => String(d.filename))
      : [];

    const priceable = boqLines.filter((l) => l.is_priceable).length;
    const emailPack: IttEmailPack = {
      packageName: pkg.name as string,
      displayRef: pkg.sub_seq == null ? String(pkg.seq) : `${pkg.seq}.${pkg.sub_seq}`,
      routeOfProcurement: (pkg.route_of_procurement as string | null) ?? null,
      returnForms: returnForms.map((f) => ({
        name: String(f.name), description: (f.description as string | null) ?? null, isRequired: Boolean(f.is_required)
      })),
      boqSummary: { total: boqLines.length, priceable, authored: billLines.length },
      boqLines: boqLines.map((l) => ({
        geCode: (l.ge_code as string | null) ?? null, elementCode: (l.element_code as string | null) ?? null,
        description: String(l.description), quantity: (l.quantity as number | null) ?? null,
        unit: (l.unit as string | null) ?? null, isPriceable: Boolean(l.is_priceable)
      })),
      billLines: billLines.map((l) => ({
        ref: (l.ref as string | null) ?? null, section: (l.section as string | null) ?? null,
        description: String(l.description), quantity: (l.quantity as number | null) ?? null,
        unit: (l.unit as string | null) ?? null, requiredFor: (l.required_for as string | null) ?? null
      })),
      scopeItems: scopeItems.map((s) => ({
        section: String(s.section), description: String(s.description),
        procurementStage: (s.procurement_stage as string | null) ?? null
      })),
      specClauses: [],
      // Resolved the same way getPackageItt does, off the same lines — the preview has to
      // show what would actually be sent, and this needs no workflow, only the session the
      // take-off's BoQ belongs to.
      specDocuments: previewSpecDocuments,
      // A preview has no workflow, so it has no take-off release to read bundles from and no
      // packageVersionId to resolve links against. The documents section renders its
      // "nothing to link" branch rather than inventing a link that would not be sent.
      documentLinks: [],
      bundle: null,
      attendanceSummary: {
        subcontractor: attendances.filter((a) => a.owner === 'SC').length,
        mainContractor: attendances.filter((a) => a.owner === 'H').length,
        joint: attendances.filter((a) => a.owner === 'J').length
      },
      valueEngineeringRequired: true
    };

    const projectName = 'the project';
    return {
      ...renderIttEmail([emailPack], { name: null, email: '' }, { projectName, completeBundleUrl: null }),
      // The real attachments, byte for byte — so a preview can be opened and checked without
      // anything being sent. Returned unencoded; only the send path base64s them.
      attachments: await ittAttachmentsFor(emailPack, projectName)
    };
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
      `SELECT se.id AS shortlist_entry_id, se.subcontractor_id, se.rank, se.suggestion_reason
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
    // A derived package claims its lines by the work package the take-off resolved; a legacy
    // hand-loaded one still claims them by NRM code off the aggregated boq_items. Which
    // applies is decided by the row, not by a flag anyone sets: pc.wp_code is present only
    // on a row generated from a released take-off.
    //
    // The two are never OR-ed. The work-package pass sees only items that HAVE one and the
    // NRM-code pass only items that do not, so a line cannot be claimed twice, and each
    // carries `attributed_by` so a surveyor can see which mechanism put it there.
    const boqLines = pkg.wp_code && takeoffId
      ? [
          ...await this.boq.takeoffLinesForWorkPackage(takeoffId, String(pkg.wp_code)),
          ...await this.boq.takeoffLinesUnattributed(takeoffId, attributionFor(pkg))
        ]
      : boqSession
        ? await this.boq.linesForPackage(String(boqSession.boq_id), attributionFor(pkg))
        : [];
    // The pipeline session, not the BoQ session. A derived package's lines come from
    // takeoff_items and need no boq_sessions row at all, so gating the documents on one made
    // a package show a full bill and no documents whenever the BoQ run had not been written.
    const sessionId = boqSession?.session_id
      ?? (typeof takeoff.pipelineSessionId === 'string' ? takeoff.pipelineSessionId : null);
    const rawDocuments = sessionId
      ? await this.boq.documentsForSession(String(sessionId))
      : [];

    // The specification THIS package's own lines were read from.
    //
    // spec_source_files holds tender_documents.filename verbatim, so this is an exact join.
    // It is deliberately not spec_chunk_ids: a chunk id cannot name a document at all —
    // nrm_chunks keeps no path — and on Reading it is set on zero items of every work
    // package, which is exactly why Flooring's specification section came back empty while
    // its 17 clause-derived lines all named an Employer's Requirements PDF.
    const citedSpecFiles = [...new Set(
      boqLines.flatMap((l) => (l.spec_source_files as string[] | null) ?? [])
    )];
    const citingLines = boqLines.filter(
      (l) => ((l.spec_source_files as string[] | null) ?? []).length > 0
    ).length;
    const specDocuments = sessionId
      ? await this.boq.specDocumentsForFilenames(String(sessionId), citedSpecFiles)
      : [];
    // Counted over the names asked for, not the documents returned: a name matching no
    // document means the take-off cited a document this tender pack does not contain, and
    // that is a finding rather than something to round down to zero.
    const resolvedNames = new Set(specDocuments.map((d) => String(d.filename).toLowerCase()));
    const basename = (name: string) => name.split(/[\\/]/).pop() ?? name;
    const unresolvedSpecFiles = citedSpecFiles.filter(
      (name) => !resolvedNames.has(name.toLowerCase())
             && !resolvedNames.has(basename(name).toLowerCase())
    );
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
      `SELECT id, seq, section, ref, description, unit, quantity, required_for, notes
         FROM package_bill_lines WHERE package_config_id = $1 ORDER BY seq`,
      [pkg.id]
    );

    // Sections 1, 3 and 6 of the client's ITT structure: what must come back, who provides
    // what, and the terms of employment the tenderer is pricing against.
    const returnForms = await this.listReturnForms(actor);
    const attendances = await this.listAttendances(actor, String(pkg.id));
    const scopeItems = await this.listScopeItems({ name: packageName, wp_code: pkg.wp_code });
    const [minutes] = await this.db.query<Row>(
      `SELECT form_of_subcontract, subcontract_type, executed_as, works_summary, status
         FROM precontract_minutes WHERE workflow_id = $1 AND package_name = $2`,
      [workflowId, packageName]
    );

    // "Ignore for ITT": sections 1, 2 and 3 only (return forms, BoQ/bill/scope, documents).
    // Recipients, attendances, minutes and Value Engineering are not overridable — a
    // recipient is a selection made at Step 1, and the rest is boilerplate every tenderer
    // needs regardless of what else is trimmed from a given package's pack.
    const overrides = await this.listIttLineOverrides(workflowId, packageName);
    const withIgnored = <T extends Row>(items: T[], section: string): T[] =>
      items.map((item) => ({ ...item, ignored: overrides.get(section)?.has(String(item.id)) ?? false }));

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
      boq_lines: withIgnored(boqLines, 'boq_line'),
      bill_lines: withIgnored(billLines, 'bill_line'),
      boq_summary: {
        total: boqLines.length, priceable, scope_only: boqLines.length - priceable,
        authored: billLines.length,
        // Reported separately so "this package's bill is thin" and "a third of the take-off
        // resolved no work package" cannot be mistaken for each other.
        by_work_package: boqLines.filter((l) => l.attributed_by === 'work_package').length,
        by_nrm_code: boqLines.filter((l) => l.attributed_by !== 'work_package').length
      },
      attributed_by_work_package: Boolean(pkg.wp_code),
      wp_code: pkg.wp_code ?? null,
      wp_scope_condition: pkg.wp_scope_condition ?? null,
      documents: withIgnored(documents, 'document'),
      // Marked with the SAME 'document' override section, not a new one: a spec document IS
      // a tender_documents row with the same id, so ignoring it in the schedule below has to
      // ignore it here too. That falls out of reusing the section key, and needs no migration.
      spec_documents: withIgnored(specDocuments, 'document'),
      spec_summary: {
        cited_lines: citingLines, total_lines: boqLines.length,
        resolved: specDocuments.length,
        unresolved: unresolvedSpecFiles.length, unresolved_names: unresolvedSpecFiles,
        // A hand-loaded package reads boq_items, which has no spec_source_files column at
        // all, so it cannot answer this question. Saying so beats reporting a bare zero.
        available: Boolean(pkg.wp_code)
      },
      return_forms: withIgnored(returnForms, 'return_form'),
      scope_items: withIgnored(scopeItems, 'scope_item'),
      scope_summary: {
        total: scopeItems.length,
        // Derived, not stored: the library answers this directly. A clause carried by every
        // trade is general; one naming trades is specific to them.
        package_specific: scopeItems.filter((s) => !s.applies_to_all_trades).length,
        general: scopeItems.filter((s) => s.applies_to_all_trades).length,
        // Priced into the subcontract vs carried by the main contractor's own budget. Both
        // read 0 until procurement_stage is set in Configuration → Tenders: the trade scope
        // PDFs the library was seeded from state neither.
        contract: scopeItems.filter((s) => s.procurement_stage === 'Contract').length,
        profit_plan: scopeItems.filter((s) => s.procurement_stage === 'Profit Plan').length,
        // The subheadings this package's scope actually spans, in print order, so the
        // reviewer sees the shape of the document before it is sent.
        by_section: scopeItems.reduce<Array<{ section: string; total: number }>>((acc, item) => {
          const section = String(item.section);
          const last = acc[acc.length - 1];
          if (last && last.section === section) last.total += 1;
          else acc.push({ section, total: 1 });
          return acc;
        }, [])
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
        !takeoffId && 'No take-off is linked to this workflow.',
        !pkg.wp_code && !boqSession && 'No completed take-off BoQ is linked to this workflow.',
        documents.length === 0 && 'No tender documents are attached to this project.',
        // The specification the take-off actually read, and the three ways it can be absent —
        // kept apart, because they call for different things. Cited-but-unresolved means the
        // pipeline named a document this pack does not contain; cited-nothing means the lines
        // were measured off drawings rather than a clause, which is normal for some trades and
        // worth knowing for others.
        Boolean(pkg.wp_code) && citingLines > 0 && specDocuments.length === 0 &&
          `${citingLines} line${citingLines === 1 ? '' : 's'} cite a specification (${unresolvedSpecFiles.join(', ')}), but no matching tender document was found for it.`,
        Boolean(pkg.wp_code) && specDocuments.length > 0 && unresolvedSpecFiles.length > 0 &&
          `Cited but not in the tender pack: ${unresolvedSpecFiles.join(', ')}.`,
        Boolean(pkg.wp_code) && boqLines.length > 0 && citingLines === 0 &&
          'No line in this package cites a specification, so the ITT names none. These lines were measured without a clause reference.',
        // An unconfigured integration and an empty one are different facts, and both clients
        // return [] either way. Without this the ITT emails with no document links at all and
        // reads exactly as though the project had none.
        !this.buildflowLinks &&
          'Document links unavailable: BUILDFLOW_BASE_URL and BUILDFLOW_DOCUMENT_LINKS_TOKEN are not configured, so this ITT would be emailed with no document links.',
        // Scope and attendances are what make the pricing document coordinate: they define
        // everything the subcontractor carries around the measured bill. Missing either and
        // every tenderer guesses differently, so neither the price nor the comparison holds.
        //
        // A derived package carries its scope in section 2 — the take-off's unmeasured items
        // ARE scope — so an empty legacy matrix is not a gap for it. Keeping the note would
        // mark every derived package "not ready to issue" for the absence of a spreadsheet
        // this project was never going to have.
        !pkg.wp_code && scopeItems.length === 0 &&
          'No scope of works items for this package. The bill states what is measured but not what the subcontractor carries around it, so returns will not be comparable.',
        Boolean(pkg.wp_code) && boqLines.length > 0 && boqLines.length === priceable &&
          'Every attributed line carries a quantity, so this package states no unmeasured scope. Check nothing has been left out.',
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
   * Which lines under sections 1, 2 and 3 of this package's ITT are marked "Ignore for
   * ITT" — excluded from what gets emailed, without touching the underlying source data.
   * Keyed by section so `getPackageItt` can annotate each list independently.
   */
  private async listIttLineOverrides(workflowId: string, packageName: string): Promise<Map<string, Set<string>>> {
    const rows = await this.db.query<{ section: string; item_id: string }>(
      `SELECT section, item_id FROM itt_line_overrides WHERE workflow_id = $1 AND package_name = $2`,
      [workflowId, packageName]
    );
    const bySection = new Map<string, Set<string>>();
    for (const row of rows) {
      const set = bySection.get(row.section) ?? new Set<string>();
      set.add(row.item_id);
      bySection.set(row.section, set);
    }
    return bySection;
  }

  /** Marks (or unmarks) one ITT line as excluded from this package's ITT emails. */
  async setIttLineIgnored(actor: Actor, workflowId: string, input: {
    packageName: string;
    section: 'return_form' | 'boq_line' | 'bill_line' | 'scope_item' | 'document';
    itemId: string;
    ignored: boolean;
  }): Promise<{ ignored: boolean }> {
    await this.assertWorkflowAccess(actor, workflowId);
    if (input.ignored) {
      await this.db.query(
        `INSERT INTO itt_line_overrides (workflow_id, package_name, section, item_id, created_by)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (workflow_id, package_name, section, item_id) DO NOTHING`,
        [workflowId, input.packageName, input.section, input.itemId, actor.userId]
      );
    } else {
      await this.db.query(
        `DELETE FROM itt_line_overrides WHERE workflow_id = $1 AND package_name = $2 AND section = $3 AND item_id = $4`,
        [workflowId, input.packageName, input.section, input.itemId]
      );
    }
    return { ignored: input.ignored };
  }

  /**
   * The scope of works falling to one package, in the order an ITT prints it.
   *
   * Reads the ITT scope library — public.tender_scope_sections / _trades / _items,
   * migration 077 — which is CONFIGURATION, owned by BuildFlow's Configuration → Tenders
   * screen and reached here through this connection's `tps,public` search path, exactly
   * as work_package_config already is. Nothing in TPS writes it.
   *
   * It replaces tps.scope_items as the ITT's scope source. That table held the client's
   * Appendix 1 matrix: 890 rows keyed by package NAME, with no sections and no editing
   * surface anywhere in the product. It is left in place (replaceScopeItems still writes
   * it) but no longer feeds an ITT.
   *
   * A PACKAGE REACHES ITS SCOPE THROUGH A TRADE, and the trade is found two ways:
   *
   *   wp_code   a package derived from a released take-off carries one, and
   *             tender_scope_trades.wp_code names the trade answering for it. A key, so
   *             it is tried first.
   *   label     the legacy hand-loaded packages carry no wp_code at all, so the package
   *             name is matched against the trade's own label. A name is not a key and
   *             routinely finds nothing, which is the whole reason the mapping exists.
   *
   * A PACKAGE THAT RESOLVES TO NO TRADE GETS NOTHING — not the general clauses, which is
   * what dropping the guard below would silently produce. Issuing a partial scope of works
   * reads as a complete one: a tenderer prices what they are sent and qualifies nothing,
   * because nothing on the page says a section is missing. An empty scope section is
   * visible; scopeTradeCoverage reports exactly which packages are in that state.
   */
  async listScopeItems(pkg: { name: string; wp_code?: unknown }): Promise<Row[]> {
    const wpCode = typeof pkg.wp_code === 'string' && pkg.wp_code ? pkg.wp_code : null;
    return this.db.query(
      `WITH by_wp AS (
         SELECT trade_code FROM tender_scope_trades
          WHERE is_active AND $1::TEXT IS NOT NULL AND wp_code = $1
       ),
       by_label AS (
         SELECT trade_code FROM tender_scope_trades
          WHERE is_active AND lower(btrim(label)) = lower(btrim($2))
            AND NOT EXISTS (SELECT 1 FROM by_wp)
       ),
       trade AS (SELECT trade_code FROM by_wp UNION ALL SELECT trade_code FROM by_label)
       SELECT DISTINCT
              i.id,
              i.description,
              i.procurement_stage,
              s.section_code,
              s.label AS section,
              s.sort_order AS section_sort,
              i.seq
         FROM tender_scope_items i
         -- No trade, no scope: this inner join yields nothing when the package resolved to no
         -- trade. Widening it to a LEFT JOIN would hand an unmapped package the whole library
         -- and make an ITT with no scope of works look like a working one.
         JOIN tender_scope_item_trades it ON it.item_id = i.id
         JOIN trade t ON t.trade_code = it.trade_code
         JOIN tender_scope_sections s ON s.section_code = i.section_code
        WHERE i.is_active AND s.is_active
        ORDER BY s.sort_order, i.seq`,
      [wpCode, pkg.name]
    );
  }

  /**
   * Replace the legacy Appendix 1 scope matrix.
   *
   * LEFT IN PLACE, BUT NO LONGER READ BY AN ITT. listScopeItems now reads the configurable
   * scope library instead (see above). This still writes tps.scope_items so an existing
   * import of the client's matrix is not destroyed, and so the rows remain available to
   * carry procurement_stage across — the PDFs the library was seeded from state neither
   * Contract nor Profit Plan.
   */
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
   * Which packages will actually receive a scope of works, and which will not.
   *
   * The same question the old scope-matrix coverage answered, asked of the scope library:
   * a package resolves to a trade or it does not, and one that does not issues an ITT with
   * an empty scope section. Both halves are worth seeing BEFORE an ITT goes out, which is
   * why this reports the two gaps separately rather than a single percentage:
   *
   *   unresolved_packages   a package nothing maps to a trade — a tenderer gets no scope
   *   unclaimed_trades      a trade no package reaches — scope nobody will be asked to price
   *
   * `unmapped_trades` is the actionable one on a fresh install: 43 of the 59 seeded trades
   * carry no wp_code, because only 16 correspond to a work package by name and the rest
   * were left blank rather than guessed. They are filled in from Configuration → Tenders.
   */
  async scopeTradeCoverage(actor: Actor): Promise<Row> {
    const trades = await this.db.query<{ trade_code: string; label: string; wp_code: string | null }>(
      `SELECT trade_code, label, wp_code FROM tender_scope_trades WHERE is_active ORDER BY sort_order`
    );
    const packages = await this.db.query<{ name: string; wp_code: string | null }>(
      `SELECT name, wp_code FROM package_config
        WHERE organization_id = $1 AND is_active ORDER BY seq`,
      [actor.organizationId]
    );

    const byWpCode = new Map(trades.filter((t) => t.wp_code).map((t) => [t.wp_code as string, t]));
    const byLabel = new Map(trades.map((t) => [t.label.trim().toLowerCase(), t]));
    // The same two rungs listScopeItems resolves on, in the same order, so this report
    // cannot claim coverage the ITT does not actually have.
    const tradeFor = (pkg: { name: string; wp_code: string | null }) =>
      (pkg.wp_code ? byWpCode.get(pkg.wp_code) : undefined) ?? byLabel.get(pkg.name.trim().toLowerCase());

    const resolved = packages.map((pkg) => ({ pkg, trade: tradeFor(pkg) }));
    const claimed = new Set(resolved.map((r) => r.trade?.trade_code).filter(Boolean));

    return {
      packages: packages.length,
      trades: trades.length,
      unmapped_trades: trades.filter((t) => !t.wp_code).map((t) => t.label).sort(),
      resolved_packages: resolved.filter((r) => r.trade).map((r) => r.pkg.name).sort(),
      unresolved_packages: resolved.filter((r) => !r.trade).map((r) => r.pkg.name).sort(),
      unclaimed_trades: trades.filter((t) => !claimed.has(t.trade_code)).map((t) => t.label).sort()
    };
  }

  /** What a compliant tender return must contain. The house standard, per organisation. */
  async listReturnForms(actor: Actor): Promise<Row[]> {
    return this.db.query(
      `SELECT id, seq, name, description, is_required FROM itt_return_forms
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

  /**
   * Build this project's package list from a released take-off.
   *
   * The list used to be configuration — 144 rows loaded once from the client's spreadsheet,
   * org-wide, identical for every project. It is now derived, from three facts the parent
   * platform already holds:
   *
   *   what the take-off measured   message.workPackages, as at the moment of release
   *   what the appointment covers  message.projectScope (bf_projects.project_scope)
   *   when a package is required   public.nrm_sub_element_work_package.wp_scope_condition
   *
   * ONE ROW PER CODE, AT THE WIDEST CONDITION IT CARRIES. A work package maps to many NRM1
   * sub-elements and they need not agree: WP-GRND is `TOQ` under one and `All` under
   * another. `All` is the wider claim — a package that is unconditionally required under any
   * sub-element is unconditionally required — so the conditions are ranked and the widest
   * wins. Taking an arbitrary row instead would make the list depend on NRM1 code order,
   * which is not a fact about anything.
   *
   * DEACTIVATE, NEVER DELETE. package_bill_lines and attendance_items cascade off
   * package_config.id; replacePackageConfig's own comment records a delete-then-reinsert
   * that "silently wiped 890 lines of survey schedule". A package falling out of scope is
   * not a reason to destroy an authored bill, and a later re-run may well bring it back.
   *
   * Called by the queue consumer, so the actor is built from the message and this bypasses
   * the HTTP authenticator by design — same as launchFromTakeoff.
   */
  async buildPackagesFromTakeoff(
    actor: Actor, message: TakeoffTendered
  ): Promise<{ selected: number; deactivated: number; byCondition: Record<string, number> }> {
    const projectId = message.projectId ?? null;
    const measured = message.workPackages.map((entry) => entry.wpCode);
    const isDnB = message.projectScope === 'design_and_build';
    // Registered per organization because route_options is org-scoped. A reviewer changes it
    // in Step 1 either way; this only has to satisfy package_config_route_not_blank.
    const defaultRoute = isDnB ? 'Design, Supply and install' : 'Supply and install';

    return this.db.transaction(async (client) => {
      await client.query(
        `INSERT INTO route_options (organization_id, label, sort_order) VALUES ($1, $2, 10)
         ON CONFLICT (organization_id, label) DO NOTHING`,
        [actor.organizationId, defaultRoute]
      );

      // The rule, in SQL, over the parent's public schema. `strictness` ranks the conditions
      // so DISTINCT ON keeps the widest; the WHERE then applies each one's meaning.
      const selected = await this.db.query<{
        wp_code: string; label: string; sort_order: number; wp_scope_condition: string;
      }>(
        `WITH ranked AS (
           SELECT DISTINCT ON (m.wp_code)
                  m.wp_code, w.label, w.sort_order, m.wp_scope_condition
             FROM public.nrm_sub_element_work_package m
             JOIN public.work_package_config w ON w.wp_code = m.wp_code AND w.is_active
            WHERE m.wp_code IS NOT NULL
            ORDER BY m.wp_code,
                     CASE m.wp_scope_condition
                       WHEN 'All' THEN 0 WHEN 'D&B' THEN 1
                       WHEN 'TOQ' THEN 2 WHEN 'Manual' THEN 3 ELSE 4 END
         )
         SELECT * FROM ranked
          WHERE wp_scope_condition = 'All'
             OR (wp_scope_condition = 'D&B'    AND $2::boolean)
             OR (wp_scope_condition = 'TOQ'    AND wp_code = ANY($1::text[]))
             OR  wp_scope_condition = 'Manual'
          ORDER BY sort_order, wp_code`,
        [measured, isDnB], client
      );

      // Push the existing derived rows out of the numbering before renumbering them.
      //
      // package_config_seq_key is UNIQUE (organization_id, project_id, seq, sub_seq), and
      // seq is assigned here by position in the selected list. So the moment the SET of
      // packages changes -- a project switched to design and build gains its D&B package
      // and everything after it shifts by one -- the upsert tries to give a code a seq that
      // another code still holds, and the whole rebuild aborts on a duplicate key.
      //
      // Same +100000 idiom replacePackageConfig uses for the same constraint, and it works
      // for the same reason: inside one transaction, so nothing ever observes the gap.
      await client.query(
        `UPDATE package_config SET seq = seq + 100000
          WHERE organization_id = $1 AND project_id IS NOT DISTINCT FROM $2
            AND wp_code IS NOT NULL`,
        [actor.organizationId, projectId]
      );

      for (const [index, row] of selected.entries()) {
        await client.query(
          `INSERT INTO package_config
             (organization_id, project_id, seq, name, route_of_procurement, trade_terms,
              wp_code, wp_scope_condition, derived_from_takeoff, is_active, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,$10)
           ON CONFLICT (organization_id, project_id, wp_code) WHERE wp_code IS NOT NULL
           DO UPDATE SET seq = EXCLUDED.seq, name = EXCLUDED.name,
                         trade_terms = EXCLUDED.trade_terms,
                         wp_scope_condition = EXCLUDED.wp_scope_condition,
                         derived_from_takeoff = EXCLUDED.derived_from_takeoff,
                         is_active = TRUE, notes = EXCLUDED.notes, updated_at = NOW()`,
          [
            actor.organizationId, projectId, index + 1, row.label, defaultRoute,
            // The label IS a trade name ("Dry lining & partitions"), which is what
            // scmsReadDb's word-level matcher wants, so Step 1's shortlist column keeps
            // working without a second vocabulary to maintain. route_of_procurement is
            // deliberately NOT in the DO UPDATE set: a reviewer's choice survives a rebuild.
            [row.label],
            row.wp_code, row.wp_scope_condition, message.takeoffId,
            row.wp_scope_condition === 'Manual'
              ? 'Added manually — no take-off measures this work.'
              : null
          ]
        );
      }

      const keep = selected.map((row) => row.wp_code);
      const deactivated = await this.db.query<{ id: string }>(
        `UPDATE package_config SET is_active = FALSE, updated_at = NOW()
          WHERE organization_id = $1 AND project_id IS NOT DISTINCT FROM $2
            AND wp_code IS NOT NULL AND NOT (wp_code = ANY($3::text[])) AND is_active
          RETURNING id`,
        [actor.organizationId, projectId, keep], client
      );

      const byCondition: Record<string, number> = {};
      for (const row of selected) {
        byCondition[row.wp_scope_condition] = (byCondition[row.wp_scope_condition] ?? 0) + 1;
      }
      return { selected: selected.length, deactivated: deactivated.length, byCondition };
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
       WHERE p.organization_id = $1 AND p.is_active`;
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
        // Present only on a row derived from a released take-off. Step 1 uses the condition
        // to mark a Manual package -- work no take-off measures, offered rather than found.
        wp_code: pkg.wp_code ?? null,
        wp_scope_condition: pkg.wp_scope_condition ?? null,
        derived_from_takeoff: pkg.derived_from_takeoff ?? null,
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
              count(d.id) FILTER (WHERE d.email_status = 'sent') AS sent,
              count(d.id) FILTER (WHERE d.email_status = 'failed') AS failed,
              count(d.id) FILTER (WHERE d.email_status = 'skipped_no_email') AS skipped_no_email,
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

  /**
   * The per-work-package document zips BuildFlow built for this workflow's take-off.
   *
   * Keyed on takeoffId, not packageVersionId: a take-off re-run mints a new takeoffId, so
   * this can never hand out documents belonging to a superseded run. Fetched ONCE per send
   * and passed down, because one call answers for every package in the workflow.
   *
   * Best-effort, like every other BuildFlow call here — an unconfigured client, an
   * unreachable BuildFlow, or a take-off whose bundles have not been built yet all mean
   * "no bundles this time", never a failed ITT.
   */
  private async bundlesForWorkflow(workflowId: string): Promise<BuildflowBundle[]> {
    if (!this.bundles) return [];
    const wf = await this.db.one<{ step_data: { takeoff?: { takeoffId?: string } } }>(
      `SELECT step_data FROM workflows WHERE id = $1`, [workflowId]
    );
    const takeoffId = wf.step_data?.takeoff?.takeoffId;
    if (!takeoffId) return [];
    return this.bundles.bundlesFor(takeoffId);
  }

  /**
   * Turn one package's full ITT assembly into the shape the email renderer reads.
   *
   * Shared by both send paths — the per-package Confirm ITT button and the workflow-level
   * per-subcontractor send — so the two can never disagree about what a package contains.
   * Everything marked "Ignore for ITT" is dropped here, once.
   */
  private async assemblePackageForEmail(
    actor: Actor,
    workflowId: string,
    packageName: string,
    bundles: BuildflowBundle[]
  ): Promise<{ emailPack: IttEmailPack; recipients: Row[]; projectName: string }> {
    const pack = await this.getPackageItt(actor, workflowId, packageName);
    const notIgnored = (items: Row[]) => items.filter((i) => i.ignored !== true);

    const returnForms = notIgnored(pack.return_forms as Row[]);
    const boqLines = notIgnored(pack.boq_lines as Row[]);
    const billLines = notIgnored(pack.bill_lines as Row[]);
    const scopeItems = notIgnored(pack.scope_items as Row[]);
    const documents = pack.documents as Row[];
    const ignoredDocuments = documents.filter((d) => d.ignored === true);
    const ignoredDocIds = new Set(ignoredDocuments.map((d) => String(d.id)));
    const ignoredFilenames = new Set(ignoredDocuments.map((d) => String(d.filename)));

    const takeoff = pack.takeoff as Record<string, unknown>;

    // The package's own document zip. Matched on the wp_code the package was derived from;
    // a legacy hand-loaded package carries none and simply gets no bundle, falling back to
    // the flat link list below.
    const wpCode = typeof pack.wp_code === 'string' ? pack.wp_code : null;
    const packageBundle = wpCode ? bundles.find((b) => b.wpCode === wpCode) : undefined;

    // BuildFlow's document-links contract is keyed by packageVersionId, carried verbatim on
    // the workflow since the take-off completed. A workflow started by hand, or one where
    // BuildFlow can't be reached, sends without links rather than blocking the ITT.
    //
    // Only fetched when there is no bundle: a bundle supersedes this list entirely, and
    // fetching a list nothing will print is a wasted round trip per package.
    const packageVersionId = typeof takeoff?.packageVersionId === 'string' ? takeoff.packageVersionId : null;
    let documentLinks: IttEmailDocumentLink[] = [];
    if (!packageBundle && packageVersionId && this.buildflowLinks) {
      documentLinks = (await this.buildflowLinks.linksFor(packageVersionId))
        .filter((l) => !ignoredDocIds.has(l.fileId) && !ignoredFilenames.has(l.displayName))
        .map((l) => ({ displayName: l.displayName, url: l.url }));
    }

    const priceable = boqLines.filter((l) => l.is_priceable).length;

    // Best-effort: an id BuildFlow can't resolve, or BuildFlow being unreachable, should
    // never block the ITT — the email just sends with no spec clauses section.
    const chunkIds = [...new Set(boqLines.flatMap((l) => (l.spec_chunk_ids as string[] | null) ?? []))];
    const specClauses = this.specClauses ? await this.specClauses.clausesFor(chunkIds) : [];

    const emailPack: IttEmailPack = {
      packageName: pack.package_name as string,
      displayRef: pack.display_ref as string,
      routeOfProcurement: (pack.route_of_procurement as string | null) ?? null,
      returnForms: returnForms.map((f) => ({
        name: String(f.name), description: (f.description as string | null) ?? null, isRequired: Boolean(f.is_required)
      })),
      boqSummary: { total: boqLines.length, priceable, authored: billLines.length },
      boqLines: boqLines.map((l) => ({
        geCode: (l.ge_code as string | null) ?? null, elementCode: (l.element_code as string | null) ?? null,
        description: String(l.description), quantity: (l.quantity as number | null) ?? null,
        unit: (l.unit as string | null) ?? null, isPriceable: Boolean(l.is_priceable)
      })),
      billLines: billLines.map((l) => ({
        ref: (l.ref as string | null) ?? null, section: (l.section as string | null) ?? null,
        description: String(l.description), quantity: (l.quantity as number | null) ?? null,
        unit: (l.unit as string | null) ?? null, requiredFor: (l.required_for as string | null) ?? null
      })),
      scopeItems: scopeItems.map((s) => ({
        section: String(s.section), description: String(s.description),
        procurementStage: (s.procurement_stage as string | null) ?? null
      })),
      specClauses: specClauses.map((c) => ({
        chunkId: c.chunkId, geCode: c.geCode, elementCode: c.elementCode, subElementCode: c.subElementCode,
        subsectionTitle: c.subsectionTitle, rawText: c.rawText, nbsCode: c.nbsCode
      })),
      // Ignored spec documents are dropped here, like every other section: getPackageItt
      // stamps them from the SAME 'document' override key as the schedule, so unticking a
      // document in the UI removes it from both lists at once.
      specDocuments: ((pack.spec_documents as Row[]) ?? [])
        .filter((d) => d.ignored !== true)
        .map((d) => String(d.filename)),
      documentLinks,
      bundle: packageBundle
        ? {
            url: packageBundle.url,
            documentCount: packageBundle.documentCount,
            allSheetsFallback: packageBundle.allSheetsFallback
          }
        : null,
      attendanceSummary: {
        subcontractor: Number((pack.attendance_summary as Row).subcontractor ?? 0),
        mainContractor: Number((pack.attendance_summary as Row).main_contractor ?? 0),
        joint: Number((pack.attendance_summary as Row).joint ?? 0)
      },
      valueEngineeringRequired: Boolean(pack.value_engineering_required)
    };

    return {
      emailPack,
      recipients: pack.recipients as Row[],
      projectName: (takeoff?.projectName as string | undefined) ?? 'the project'
    };
  }

  /**
   * The scope-of-works PDF and BoQ pricing schedule for each package on the message.
   *
   * Generated once per send, not once per recipient — the files are identical for every firm
   * invited to the same package, and rebuilding them per recipient would be pure waste.
   *
   * Oversized sends drop their attachments rather than failing: the email still carries the
   * inline tables and the document-pack links, which is far better than a provider rejecting
   * the whole message and the subcontractor receiving nothing.
   */
  private async attachmentsFor(packs: IttEmailPack[], projectName: string): Promise<EmailAttachment[]> {
    const built: EmailAttachment[] = [];
    for (const pack of packs) {
      for (const file of await ittAttachmentsFor(pack, projectName)) {
        built.push({
          content: file.content.toString('base64'),
          filename: file.filename,
          type: file.contentType,
          disposition: 'attachment'
        });
      }
    }
    const totalBytes = built.reduce((sum, a) => sum + a.content.length, 0);
    return totalBytes > MAX_ATTACHMENT_BYTES ? [] : built;
  }

  /**
   * Send one Invitation to Tender per SUBCONTRACTOR, covering every confirmed package that
   * firm was shortlisted against.
   *
   * The per-package Confirm ITT button sends one email per package, so a firm shortlisted
   * against Flooring, Carpentry and Dry Lining receives three separate invitations naming
   * three separate scopes. This sends one, listing all three — which is what a tenderer
   * expects and what makes the "price each package separately" instruction legible.
   *
   * Grouping is only correct with every package in view at once, which is why this is a
   * workflow-level action rather than something the per-package route could do: confirming
   * Flooring cannot know whether Carpentry is about to be confirmed too.
   *
   * Only CONFIRMED packages are included — the same precondition confirmAndSendItt enforces
   * per package, applied across the workflow. A firm whose packages are all still unconfirmed
   * is not emailed at all rather than emailed a partial invitation.
   *
   * Audit rows keep their existing grain: itt_dispatch is one row per (package ×
   * subcontractor), so an email covering three packages writes three rows sharing one
   * email_message_id. A per-firm failure never stops the others.
   */
  async sendIttsForWorkflow(actor: Actor, workflowId: string): Promise<Row> {
    await this.assertWorkflowAccess(actor, workflowId);

    const entries = await this.db.query<{
      subcontractor_id: string; shortlist_entry_id: string; package_name: string;
    }>(
      `SELECT se.subcontractor_id, se.id AS shortlist_entry_id, sl.package_name
         FROM shortlist_entries se
         JOIN shortlists sl ON sl.id = se.shortlist_id
        WHERE sl.workflow_id = $1
          AND se.selected = TRUE
          AND sl.confirmed_at IS NOT NULL
          -- The launch table injects this sentinel for packages with no supply chain. It is
          -- never selectable, so it should not reach here; excluded anyway rather than
          -- risking an email addressed to a firm that does not exist.
          AND se.subcontractor_id <> $2
        ORDER BY se.subcontractor_id, sl.package_seq NULLS LAST, sl.package_name`,
      [workflowId, PLACEHOLDER_SUBCONTRACTOR_ID]
    );

    if (entries.length === 0) {
      throw conflict('No confirmed packages with selected subcontractors to send. Confirm the packages at the Tender Launch Pack step first.');
    }

    const bundles = await this.bundlesForWorkflow(workflowId);
    const completeBundleUrl = bundles.find((b) => b.wpCode === null)?.url ?? null;

    // One assembly per package, shared across every firm invited to it. getPackageItt is the
    // expensive call in this flow and most packages have several recipients.
    //
    // A package that cannot be assembled — deactivated by a take-off rebuild, missing its
    // configuration — is dropped rather than allowed to abort the send. One broken package
    // out of forty must not stop the other thirty-nine going out, which is the same reason
    // the send loop below isolates per-firm failures.
    const assembled = new Map<string, { emailPack: IttEmailPack; projectName: string }>();
    const unassembled: Array<{ packageName: string; error: string }> = [];
    const requestedPackages = [...new Set(entries.map((e) => e.package_name))];
    for (const name of requestedPackages) {
      try {
        const { emailPack, projectName } = await this.assemblePackageForEmail(actor, workflowId, name, bundles);
        assembled.set(name, { emailPack, projectName });
      } catch (error) {
        unassembled.push({ packageName: name, error: error instanceof Error ? error.message : 'Could not assemble this package' });
      }
    }
    if (assembled.size === 0) {
      throw conflict(`No package could be assembled for sending. First error: ${unassembled[0]?.error ?? 'unknown'}`);
    }
    const packageNames = [...assembled.keys()];
    const projectName = assembled.get(packageNames[0])!.projectName;

    // Nothing stops a firm appearing twice on one package's shortlist, so dedupe by package.
    // A firm left with no assembled package is simply not emailed — better than sending an
    // invitation naming no scope at all.
    const byFirm = new Map<string, Map<string, string>>();
    for (const entry of entries) {
      if (!assembled.has(entry.package_name)) continue;
      const firm = String(entry.subcontractor_id);
      if (!byFirm.has(firm)) byFirm.set(firm, new Map());
      const packages = byFirm.get(firm)!;
      if (!packages.has(entry.package_name)) packages.set(entry.package_name, String(entry.shortlist_entry_id));
    }

    const contacts = new Map(
      (await this.scms.getContactsForSubcontractors([...byFirm.keys()]))
        .map((c) => [String(c.subcontractor_id), c])
    );

    let sent = 0, failed = 0, skippedNoEmail = 0;
    const detail: Array<{ subcontractorId: string; packages: string[]; status: string; error?: string }> = [];
    const from = this.testEmailOverride?.from ?? ITT_FROM_ADDRESS;

    for (const [subcontractorId, packages] of byFirm) {
      const packageNamesForFirm = [...packages.keys()];
      const entryIds = [...packages.values()];
      const contact = contacts.get(subcontractorId);
      const realEmail = contact?.contact_email ? String(contact.contact_email) : null;
      const email = this.testEmailOverride?.to ?? realEmail;

      const record = async (status: string, error: string | null, messageId: string | null) => {
        for (const entryId of entryIds) {
          await this.db.query(
            `INSERT INTO itt_dispatch (shortlist_entry_id, dispatched_at, email_status, email_error, email_sent_at, email_message_id)
             VALUES ($1, NOW(), $2, $3, CASE WHEN $2 = 'sent' THEN NOW() ELSE NULL END, $4)
             ON CONFLICT (shortlist_entry_id) DO UPDATE
               SET dispatched_at = NOW(), email_status = $2, email_error = $3,
                   email_sent_at = CASE WHEN $2 = 'sent' THEN NOW() ELSE NULL END,
                   email_message_id = $4`,
            [entryId, status, error, messageId]
          );
        }
      };

      if (!email) {
        skippedNoEmail += 1;
        detail.push({ subcontractorId, packages: packageNamesForFirm, status: 'skipped_no_email' });
        await record('skipped_no_email', null, null);
        continue;
      }

      const packs = packageNamesForFirm.map((name) => assembled.get(name)!.emailPack);
      const rendered = renderIttEmail(
        packs,
        { name: contact?.contact_name ? String(contact.contact_name) : null, email },
        { projectName, completeBundleUrl }
      );
      const subject = this.testEmailOverride
        ? `[TEST → ${contact?.contact_name ? String(contact.contact_name) : 'unknown'} <${realEmail ?? 'no email on file'}>] ${rendered.subject}`
        : rendered.subject;

      try {
        if (!this.emailService) throw new Error('EmailService not configured in this environment');
        const attachments = await this.attachmentsFor(packs, projectName);
        const result = await this.emailService.send({
          from, to: email, subject, html: rendered.html, text: rendered.text, attachments
        });
        const messageId = (result as { message_id?: string } | null)?.message_id ?? null;
        await record('sent', null, messageId);
        sent += 1;
        detail.push({ subcontractorId, packages: packageNamesForFirm, status: 'sent' });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error sending email';
        await record('failed', message, null);
        failed += 1;
        detail.push({ subcontractorId, packages: packageNamesForFirm, status: 'failed', error: message });
      }
    }

    return {
      packages: packageNames.length,
      subcontractors: byFirm.size,
      sent,
      failed,
      skipped_no_email: skippedNoEmail,
      // Named rather than silently absent: a package that dropped out here was shortlisted
      // and confirmed, so somebody expects it to have gone out.
      unassembled_packages: unassembled,
      recipients: detail
    };
  }

  /**
   * Sends the Invitation to Tender for one package to every subcontractor selected at the
   * tender launch meeting, once the package itself is confirmed there. Replaces the old
   * dispatchItt, which only stamped a timestamp — this builds the same content the "View
   * ITT" preview shows (via getPackageItt), drops anything marked "Ignore for ITT", resolves
   * document links and recipient emails, and actually sends.
   *
   * A per-recipient failure — no email on file, BuildFlow unreachable for one firm, a
   * Cloudflare error — never stops the others: every outcome is recorded on itt_dispatch and
   * rolled up into the summary this returns. Re-running this (the button is re-clickable)
   * resends to everyone currently selected; it does not skip firms already marked sent.
   *
   * ONE PACKAGE PER EMAIL. A firm shortlisted against three packages receives three separate
   * invitations from this route — see sendIttsForWorkflow for the per-subcontractor send that
   * covers all of a firm's packages in one message. Both build their content the same way,
   * through assemblePackageForEmail, so the two can never describe a package differently.
   */
  async confirmAndSendItt(actor: Actor, workflowId: string, packageName: string): Promise<Row> {
    await this.assertWorkflowAccess(actor, workflowId);

    const [shortlist] = await this.db.query<{ confirmed_at: string | null }>(
      `SELECT confirmed_at FROM shortlists WHERE workflow_id = $1 AND package_name = $2`,
      [workflowId, packageName]
    );
    if (!shortlist?.confirmed_at) {
      throw conflict('This package has not been confirmed at the Tender Launch Pack step yet.');
    }

    const bundles = await this.bundlesForWorkflow(workflowId);
    const assembled = await this.assemblePackageForEmail(actor, workflowId, packageName, bundles);
    const { emailPack, projectName } = assembled;
    const completeBundleUrl = bundles.find((b) => b.wpCode === null)?.url ?? null;
    const attachments = await this.attachmentsFor([emailPack], projectName);

    const recipients = assembled.recipients;
    const subcontractorIds = recipients.map((r) => String(r.subcontractor_id));
    const contacts = new Map(
      (await this.scms.getContactsForSubcontractors(subcontractorIds))
        .map((c) => [String(c.subcontractor_id), c])
    );

    let sent = 0, failed = 0, skippedNoEmail = 0;
    const detail: Array<{ subcontractorId: string; status: string; error?: string }> = [];

    const from = this.testEmailOverride?.from ?? ITT_FROM_ADDRESS;

    for (const recipient of recipients) {
      const subcontractorId = String(recipient.subcontractor_id);
      const shortlistEntryId = String(recipient.shortlist_entry_id);
      const contact = contacts.get(subcontractorId);
      const realEmail = contact?.contact_email ? String(contact.contact_email) : null;
      // Test mode redirects every send to a fixed inbox, including recipients with no real
      // SCMS contact email on file, so the whole recipient list is exercised end-to-end.
      const email = this.testEmailOverride?.to ?? realEmail;

      if (!email) {
        skippedNoEmail += 1;
        detail.push({ subcontractorId, status: 'skipped_no_email' });
        await this.db.query(
          `INSERT INTO itt_dispatch (shortlist_entry_id, dispatched_at, email_status)
           VALUES ($1, NOW(), 'skipped_no_email')
           ON CONFLICT (shortlist_entry_id) DO UPDATE
             SET dispatched_at = NOW(), email_status = 'skipped_no_email', email_error = NULL`,
          [shortlistEntryId]
        );
        continue;
      }

      const rendered = renderIttEmail(
        [emailPack],
        { name: contact?.contact_name ? String(contact.contact_name) : null, email },
        { projectName, completeBundleUrl }
      );
      // Keeps test-inbox messages distinguishable across packages/recipients when every
      // send lands in the same TEST_TO_EMAIL_ACCOUNT.
      const subject = this.testEmailOverride
        ? `[TEST → ${contact?.contact_name ? String(contact.contact_name) : 'unknown'} <${realEmail ?? 'no email on file'}>] ${rendered.subject}`
        : rendered.subject;
      const { html, text } = rendered;

      try {
        if (this.emailService) {
          const result = await this.emailService.send({ from, to: email, subject, html, text, attachments });
          const messageId = (result as { message_id?: string } | null)?.message_id ?? null;
          await this.db.query(
            `INSERT INTO itt_dispatch (shortlist_entry_id, dispatched_at, email_status, email_sent_at, email_message_id, email_error)
             VALUES ($1, NOW(), 'sent', NOW(), $2, NULL)
             ON CONFLICT (shortlist_entry_id) DO UPDATE
               SET dispatched_at = NOW(), email_status = 'sent', email_sent_at = NOW(),
                   email_message_id = $2, email_error = NULL`,
            [shortlistEntryId, messageId]
          );
          sent += 1;
          detail.push({ subcontractorId, status: 'sent' });
        } else {
          // No Cloudflare config in this environment: record what would have been sent so
          // the flow is exercisable end-to-end without a real email provider.
          await this.db.query(
            `INSERT INTO itt_dispatch (shortlist_entry_id, dispatched_at, email_status, email_error)
             VALUES ($1, NOW(), 'failed', 'EmailService not configured in this environment')
             ON CONFLICT (shortlist_entry_id) DO UPDATE
               SET dispatched_at = NOW(), email_status = 'failed',
                   email_error = 'EmailService not configured in this environment'`,
            [shortlistEntryId]
          );
          failed += 1;
          detail.push({ subcontractorId, status: 'failed', error: 'EmailService not configured in this environment' });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error sending email';
        await this.db.query(
          `INSERT INTO itt_dispatch (shortlist_entry_id, dispatched_at, email_status, email_error)
           VALUES ($1, NOW(), 'failed', $2)
           ON CONFLICT (shortlist_entry_id) DO UPDATE
             SET dispatched_at = NOW(), email_status = 'failed', email_error = $2`,
          [shortlistEntryId, message]
        );
        failed += 1;
        detail.push({ subcontractorId, status: 'failed', error: message });
      }
    }

    return { package_name: packageName, sent, failed, skipped_no_email: skippedNoEmail, recipients: detail };
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
      `SELECT d.*, se.rank, se.subcontractor_id, sl.package_name
       FROM itt_dispatch d
       JOIN shortlist_entries se ON se.id = d.shortlist_entry_id
       JOIN shortlists sl ON sl.id = se.shortlist_id
       WHERE sl.workflow_id = $1 ORDER BY sl.package_name, se.rank`,
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
