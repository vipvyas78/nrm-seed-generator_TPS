import { randomUUID } from 'node:crypto';
import type { Attribution, BoqReadDatabase } from './boqReadDb.js';
import type { BuildflowCommsAttachmentsClient } from './buildflowCommsAttachmentsClient.js';
import type { AttributionMethod, CommsAttachmentInput, CommsDatabase } from './commsDb.js';
import {
  renderClientAnswerRelayEmail, renderRfiForwardEmail, renderRfiResponseEmail,
  type ForwardedQuery, type RfiAnswerCitation
} from './commsEmail.js';
import {
  findReplyToken, isVerified, referencedMessageIds, replyAddressFor, type InboundEmail
} from './inboundEmail.js';
import type { BuildflowBundle, BuildflowDocumentBundlesClient } from './buildflowDocumentBundlesClient.js';
import type { BuildflowDocumentLinksClient } from './buildflowDocumentLinksClient.js';
import { templateLinesAsBoqRows, type BuildflowMepBoqClient } from './buildflowMepBoqClient.js';
import type { BuildflowSpecClauseClient } from './buildflowSpecClauseClient.js';
import { domainOf, isPublicEmailDomain, type CloudflareAccessAdmin } from './cloudflareAccess.js';
import type { Database, Row } from './db.js';
import type { DocumentLinkProvider } from './documentLinkProvider.js';
import type { EmailAttachment, EmailService } from './emailService.js';
import { AppError, conflict, forbidden, notFound } from './errors.js';
import { ittAttachmentsFor, type AttendanceRow, type IttAttachment, type ResolvedAttachmentTemplate } from './ittAttachments.js';
import { renderIttEmail, requiredReturnsList, sectionIndex, type IttEmailLetterContext, type IttEmailPack, type IttEmailPortalStatus } from './ittEmail.js';
import type { Block, RenderContext } from './blockPdfRenderer.js';
import type { PortalLineDraftInput, PortalLineInput, PricingPortalDatabase } from './pricingPortalDb.js';
import type { ScmsReadDatabase } from './scmsReadDb.js';
import type { TakeoffCompletion, TakeoffTendered } from './takeoffCompletion.js';
import { deriveReturnDate, isTenderReturnUnit } from './tenderReturnPeriod.js';
import { manualReminderKind, type IttResponse } from './ittReminders.js';
import type { RfiDatabase } from './rfiDb.js';
import { groupBy, normaliseCitations, resolveAnswer } from './rfiReview.js';
import type { Actor } from './types.js';

/**
 * What every ITT was sent from before BuildFlow issue #34 made it configurable, and still
 * the fallback for an organisation that has not configured anything.
 *
 * The configured value lives in `public.itt_comms_config` (BuildFlow migration 088), which
 * this module reads UNQUALIFIED through its own `search_path=tps,public` — the same way it
 * already reads work_package_config and itt_attachment_templates. There is no second copy
 * and no HTTP call, so a change on BuildFlow's Configuration page applies to the very next
 * ITT sent from here.
 *
 * This literal is duplicated on the BuildFlow side (apps/bff/src/ittComms.ts). That is
 * unavoidable — the two processes share a database, not a module — and it is safe because
 * it is a FALLBACK on both sides rather than a value either of them writes.
 */
export const ITT_FROM_ADDRESS = 'tenders@novamerx.ai';

/** Where a Client's answer comes back to when the organisation has configured nothing.
 *  Duplicated from BuildFlow's ittComms.ts for the same reason ITT_FROM_ADDRESS is: the
 *  two processes share a database, not a module, and this is a fallback on both sides
 *  rather than a value either writes. */
const DEFAULT_CLIENT_REPLY_ADDRESS = 'itt-reply@novamerx.co.uk';

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
/**
 * A one-line preview of a message, for a notification that has no subject.
 *
 * Truncated on a character count rather than a word boundary: the text came from outside
 * the organisation, and a "smart" summariser is one more thing that can be wrong about
 * somebody else's words. Whitespace is collapsed so a pasted email body does not render
 * as a blank line in the bell.
 */
function firstLine(body: string | null, limit = 140): string | null {
  const text = body?.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

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

/**
 * The lines a pricing-portal link snapshots at mint time, off an already-assembled
 * `IttEmailPack` — never re-read from `public.takeoff_items` afterwards, so a take-off
 * re-run mid-tender cannot alter a bill a subcontractor has already started pricing (see
 * migration 019's header comment).
 *
 * Authored bill lines have no NRM ge/element code of their own, and `tender_return_lines`
 * (008) has no ref/section columns to promote them into either — the closest analog
 * available is the line's own `ref`, carried in `elementCode` so it survives promotion.
 */
function linesFromEmailPack(pack: IttEmailPack): PortalLineInput[] {
  const boq: PortalLineInput[] = pack.boqLines.map((l) => ({
    sourceItemId: null, geCode: l.geCode, elementCode: l.elementCode,
    description: l.description, quantity: l.quantity, unit: l.unit, isPriceable: l.isPriceable
  }));
  const bill: PortalLineInput[] = pack.billLines.map((l) => ({
    sourceItemId: null, geCode: null, elementCode: l.ref,
    description: l.description, quantity: l.quantity, unit: l.unit,
    isPriceable: l.quantity != null && l.quantity > 0
  }));
  return [...boq, ...bill];
}

/** One firm shortlisted for the package, as the compose box offers it. */
export interface IttDraftRecipient {
  shortlistEntryId: string;
  subcontractorId: string;
  /** The firm. Null only if SCMS no longer holds the subcontractor at all. */
  name: string | null;
  /** The individual the address belongs to, for showing beside it. */
  contactName: string | null;
  /** Null when SCMS holds no contact email — shown as unreachable, never silently dropped. */
  email: string | null;
}

/**
 * One package's ITT as the compose modal shows it, before anything is sent.
 *
 * `html` and `text` are a PREVIEW: the modal displays them read-only and never sends them back.
 * `sendIttDraft` rebuilds both from the same assembly, so the body cannot be edited in transit.
 */
export interface IttDraft {
  packageName: string;
  subject: string;
  html: string;
  text: string;
  recipients: IttDraftRecipient[];
  bundleUrl: string | null;
  completeBundleUrl: string | null;
  /** TEMPORARY (testing the pricing-portal link) — see draftPortalStatus. Null outside test mode. */
  portalUrl: string | null;
  attachments: Array<{ filename: string; contentType: string; bytes: number }>;
  /** The files were dropped for exceeding what a send would carry — see MAX_ATTACHMENT_BYTES. */
  attachmentsOmittedOversize: boolean;
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
    private readonly testEmailOverride?: { from: string; to: string } | null,
    // Optional: without one configured, no pricing-portal link is ever minted or read —
    // the ITT sends exactly as it did before this feature existed.
    private readonly portalDb?: PricingPortalDatabase,
    // Optional: without one configured, no portal link is ever issued (see
    // mintPortalLinksFor) — a link with nothing gating it at the edge is a worse outcome
    // than a send with no online-pricing section.
    private readonly accessAdmin?: CloudflareAccessAdmin,
    private readonly portalBaseUrl?: string,
    private readonly portalLinkTtlDays: number = 90,
    // Optional: without one configured, a WP-MEP-* package's bill is the measured
    // take-off lines exactly as it was before BuildFlow issue #28 — see mepTemplateLines.
    private readonly mepBoq?: BuildflowMepBoqClient,
    // Optional: without one configured, no subcontractor query can be raised or read and
    // the portal shows no query form at all — the tender behaves exactly as it did before
    // BuildFlow issue #34.
    private readonly commsDb?: CommsDatabase,
    // Optional: without one configured, a query can still be raised but NOT with a file
    // attached. Refused outright rather than accepted and dropped — see
    // storeCommsAttachments.
    private readonly commsAttachments?: BuildflowCommsAttachmentsClient,
    // Shorter than a portal link by default: a tender query is answered in days, and the
    // link is a bearer capability sitting in somebody's inbox.
    private readonly clientLinkTtlDays: number = 30,
    // Optional: without one configured, the RFI send/forward/re-attribute methods below
    // throw notFound the same way every other optional-collaborator method here does.
    // Unlike commsDb above, its absence has nothing to do with BuildFlow being
    // configured — see rfiDb.ts's own header for why it is unconditionally constructed.
    private readonly rfiDb?: RfiDatabase
  ) {}

  /**
   * A WP-MEP-* package's bill as BuildFlow's own configured MEP template states it, or
   * null to say "use the measured take-off lines, as before".
   *
   * WHY IT REPLACES RATHER THAN JOINS THE MEASURED LINES. The two are two answers to one
   * question — what does this subcontractor price? — and printing both would ask for the
   * same work twice under two different wordings. The template is the client's own house
   * sequence and the document they expect back; the take-off's role here is to have
   * decided which of its sections this project carries. What the measured lines are still
   * read for is the specification documents they cite, which the template cannot name.
   *
   * NULL IN FOUR CASES, and all four mean the same thing to the caller: no client bill
   * has displaced the template (`source: 'client_boq'` — that bill is authoritative for
   * MEP and the measured lines are reconciled against it); the client's template
   * produced nothing for this trade; BuildFlow could not be reached; or the integration
   * is not configured at all.
   */
  private async mepTemplateLines(takeoffId: string | null, wpCode: unknown): Promise<Row[] | null> {
    const code = typeof wpCode === 'string' ? wpCode : '';
    if (!this.mepBoq || !takeoffId || !code.startsWith('WP-MEP-')) return null;
    const bill = await this.mepBoq.billFor(takeoffId);
    if (!bill || bill.source !== 'template') return null;
    const forPackage = bill.packages.find((entry) => entry.wpCode === code);
    if (!forPackage || forPackage.lines.length === 0) return null;
    return templateLinesAsBoqRows(forPackage.lines) as Row[];
  }

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

    const measuredLines = pkg.wp_code
      ? [
          ...await this.boq.takeoffLinesForWorkPackage(input.takeoffId, String(pkg.wp_code)),
          ...await this.boq.takeoffLinesUnattributed(input.takeoffId, attributionFor(pkg))
        ]
      : await this.boq.linesForPackage(input.boqId, attributionFor(pkg));
    // Asked first, and the measured lines are the fallback — see mepTemplateLines.
    const boqLines = (await this.mepTemplateLines(input.takeoffId, pkg.wp_code)) ?? measuredLines;

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
      // A preview has no workflow, so no shortlist, so no return period to resolve. The
      // letter falls back to letterContext, which for a preview is empty too.
      tenderReturnDeadline: null,
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
      // A preview has no workflow, so it has no take-off release to read bundles from. The
      // documents section states that they will be issued separately rather than inventing a
      // link that would not be sent.
      bundle: null,
      attendanceSummary: {
        subcontractor: attendances.filter((a) => a.owner === 'SC').length,
        mainContractor: attendances.filter((a) => a.owner === 'H').length,
        joint: attendances.filter((a) => a.owner === 'J').length
      },
      valueEngineeringRequired: true,
      attachmentCodes: await this.attachmentCodesFor({ name: input.packageName, wp_code: pkg.wp_code })
    };

    const projectName = 'the project';
    // No workflow exists yet for a preview, so there is no itt_letter_details row to
    // read — the letter context falls back to the confirming actor's own identity only.
    const letterContext: IttEmailLetterContext = {
      siteAddress: null, tenderReturnDeadline: null, clarificationsCloseDate: null, siteVisitPermitted: null,
      estimatorName: actor.displayName ?? null, estimatorEmail: actor.email ?? null,
      organizationName: await this.organizationName(actor)
    };
    const recipient = { name: null as string | null, email: '', address: null as string | null };
    const { renderKinds, templates } = await this.resolvedTemplatesFor(actor, emailPack.attachmentCodes);
    void renderKinds;
    const context = await this.buildRenderContext(actor, emailPack, projectName, letterContext, recipient);
    const attendanceRows = await this.attendanceRowsFor(actor, pkg);
    return {
      ...renderIttEmail([emailPack], recipient, { projectName, completeBundleUrl: null, letterContext }),
      // The real attachments, byte for byte — so a preview can be opened and checked without
      // anything being sent. Returned unencoded; only the send path base64s them.
      attachments: await ittAttachmentsFor(emailPack, projectName, context, templates, attendanceRows)
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
      `SELECT route_of_procurement, confirmed_at,
              tender_return_period_value, tender_return_period_unit, tender_return_deadline
         FROM shortlists
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
    const measuredLines = pkg.wp_code && takeoffId
      ? [
          ...await this.boq.takeoffLinesForWorkPackage(takeoffId, String(pkg.wp_code)),
          ...await this.boq.takeoffLinesUnattributed(takeoffId, attributionFor(pkg))
        ]
      : boqSession
        ? await this.boq.linesForPackage(String(boqSession.boq_id), attributionFor(pkg))
        : [];
    // A WP-MEP-* package bills the client's own configured template where there is one,
    // and the measured lines otherwise — see mepTemplateLines. Kept as two names rather
    // than one because the measured lines are still read below for the specification
    // documents they cite, and the review note has to be able to say what was set aside.
    const templateLines = await this.mepTemplateLines(takeoffId, pkg.wp_code);
    const boqLines = templateLines ?? measuredLines;
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
    //
    // Read off the MEASURED lines, not off boqLines, because a template-billed MEP package
    // has none of its own: the template states the client's house sequence and cannot name
    // a document. Which specification the take-off actually read is still true, and still
    // the first thing a tenderer pricing this trade opens.
    const citedSpecFiles = [...new Set(
      measuredLines.flatMap((l) => (l.spec_source_files as string[] | null) ?? [])
    )];
    const citingLines = measuredLines.filter(
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
      // The decision (how long this package is tendered for) and, once an ITT has gone out,
      // what it resolved to. assemblePackageForEmail turns the pair into a date.
      tender_return_period_value: shortlist?.tender_return_period_value ?? null,
      tender_return_period_unit: shortlist?.tender_return_period_unit ?? null,
      tender_return_deadline: shortlist?.tender_return_deadline ?? null,
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
        // The substitution says so on the pack rather than happening quietly. A bill that
        // silently stopped showing measured quantities would read exactly like a bill that
        // never had any, and the count is the only thing that tells the two apart.
        templateLines !== null &&
          `Billed from the configured MEP BoQ template: ${templateLines.length} line${templateLines.length === 1 ? '' : 's'} in the client's own house sequence, unquantified for the tenderer to measure. ${measuredLines.length} measured take-off line${measuredLines.length === 1 ? '' : 's'} decided which sections appear and are not themselves billed.`,
        // Not the same as "no template configured": without the integration a WP-MEP-*
        // package silently bills the take-off's own working descriptions instead.
        Boolean(pkg.wp_code) && String(pkg.wp_code).startsWith('WP-MEP-') && !this.mepBoq &&
          "The MEP BoQ template is unavailable: BUILDFLOW_BASE_URL and BUILDFLOW_DOCUMENT_LINKS_TOKEN are not configured, so this bill is the raw measured take-off lines rather than the client's own house sequence.",
        // An unconfigured integration and an empty one are different facts, and the client
        // returns [] either way. Without this the ITT emails with no document link at all and
        // reads exactly as though the project had none.
        //
        // Tests the BUNDLES client, not the per-document one: the email links a work package's
        // zip and nothing else, so that is the integration whose absence would leave a tenderer
        // with no documents.
        !this.bundles &&
          'Document packs unavailable: BUILDFLOW_BASE_URL and BUILDFLOW_DOCUMENT_LINKS_TOKEN are not configured, so this ITT would be emailed with no link to its documents.',
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
   * Which ITT attachment codes this package's trade should receive, in the order
   * they should appear — same trade resolution as listScopeItems (wp_code first,
   * label fallback), reading the parent repo's public-schema itt_attachment_trades
   * / itt_attachment_types (migration 083) cross-schema, exactly as tender_scope_*
   * already is. A trade with no rows here gets no attachments at all — the same
   * "never a silent full-set fallback" rule as the scope-of-works library.
   */
  async attachmentCodesFor(pkg: { name: string; wp_code?: unknown }): Promise<string[]> {
    const wpCode = typeof pkg.wp_code === 'string' && pkg.wp_code ? pkg.wp_code : null;
    const rows = await this.db.query<Row>(
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
       SELECT DISTINCT at.attachment_code, t.sort_order
         FROM itt_attachment_trades at
         JOIN trade tr ON tr.trade_code = at.trade_code
         JOIN itt_attachment_types t ON t.attachment_code = at.attachment_code
        WHERE t.is_active
        ORDER BY t.sort_order`,
      [wpCode, pkg.name]
    );
    return rows.map((r) => String(r.attachment_code));
  }

  /**
   * The resolved (org override if present, else global default) template for each
   * of `codes`, plus each code's render_kind — everything ittAttachmentsFor needs
   * to dispatch, pre-fetched here so that file stays a pure function of its inputs.
   */
  private async resolvedTemplatesFor(
    actor: Actor, codes: string[]
  ): Promise<{ renderKinds: Map<string, string>; templates: Map<string, ResolvedAttachmentTemplate> }> {
    const renderKinds = new Map<string, string>();
    if (codes.length > 0) {
      const types = await this.db.query<Row>(
        `SELECT attachment_code, render_kind FROM itt_attachment_types WHERE attachment_code = ANY($1)`,
        [codes]
      );
      for (const t of types) renderKinds.set(String(t.attachment_code), String(t.render_kind));
    }
    const templates = new Map<string, ResolvedAttachmentTemplate>();
    if (codes.length > 0) {
      const rows = await this.db.query<Row>(
        `SELECT DISTINCT ON (attachment_code) attachment_code, title, filename_pattern, blocks
           FROM itt_attachment_templates
          WHERE attachment_code = ANY($1) AND (organization_id = $2 OR organization_id IS NULL)
          ORDER BY attachment_code, organization_id NULLS LAST`,
        [codes, actor.organizationId]
      );
      for (const r of rows) {
        templates.set(String(r.attachment_code), {
          attachmentCode: String(r.attachment_code),
          filenamePattern: String(r.filename_pattern),
          blocks: r.blocks as Block[]
        });
      }
    }
    return { renderKinds, templates };
  }

  /** scms.attendance_items rows for one package, shaped for scheduleOfAttendancesPdf. */
  private async attendanceRowsFor(actor: Actor, pkg: Row): Promise<AttendanceRow[]> {
    const rows = await this.listAttendances(actor, String(pkg.id));
    return rows.map((r) => ({
      groupName: String(r.group_name), description: String(r.description),
      owner: r.owner as AttendanceRow['owner'], notes: (r.notes as string | null) ?? null
    }));
  }

  /** bf_organizations.name for the letter's "On behalf of {org}" sign-off — read
   * cross-schema from the parent repo's public schema, same as everything else here. */
  private async organizationName(actor: Actor): Promise<string> {
    const [row] = await this.db.query<Row>(`SELECT name FROM bf_organizations WHERE id = $1`, [actor.organizationId]);
    return row ? String(row.name) : 'the Contractor';
  }

  async getIttLetterDetails(actor: Actor, workflowId: string): Promise<Row | null> {
    await this.assertWorkflowAccess(actor, workflowId);
    const [row] = await this.db.query<Row>(`SELECT * FROM itt_letter_details WHERE workflow_id = $1`, [workflowId]);
    return row ?? null;
  }

  async saveIttLetterDetails(actor: Actor, workflowId: string, input: {
    siteAddress?: string | null; tenderReturnDeadline?: string | null; clarificationsCloseDate?: string | null;
    siteVisitPermitted?: boolean | null; estimatorName?: string | null; estimatorEmail?: string | null;
  }): Promise<Row> {
    await this.assertWorkflowAccess(actor, workflowId);
    const [row] = await this.db.query<Row>(
      `INSERT INTO itt_letter_details
         (workflow_id, site_address, tender_return_deadline, clarifications_close_date, site_visit_permitted, estimator_name, estimator_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (workflow_id) DO UPDATE SET
         site_address = EXCLUDED.site_address, tender_return_deadline = EXCLUDED.tender_return_deadline,
         clarifications_close_date = EXCLUDED.clarifications_close_date, site_visit_permitted = EXCLUDED.site_visit_permitted,
         estimator_name = EXCLUDED.estimator_name, estimator_email = EXCLUDED.estimator_email, updated_at = NOW()
       RETURNING *`,
      [workflowId, input.siteAddress ?? null, input.tenderReturnDeadline ?? null, input.clarificationsCloseDate ?? null,
        input.siteVisitPermitted ?? null, input.estimatorName ?? null, input.estimatorEmail ?? null]
    );
    return row;
  }

  private formatDate = (d: unknown): string | null => {
    if (!d) return null;
    const date = d instanceof Date ? d : new Date(String(d));
    return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString('en-GB');
  };

  /**
   * The return date in force for one package, and whether it is new enough to record.
   *
   * Precedence, highest first:
   *   1. the workflow's own explicit date (itt_letter_details) — a human said so;
   *   2. the date already ISSUED for this package — whatever else has changed since, that
   *      is the date a tenderer is holding;
   *   3. this package's return period, counted from `asOf`;
   *   4. nothing, which the letter prints as "to be confirmed".
   *
   * `asOf` OMITTED means never derive. A read-only surface — the launch table, a pricing
   * portal opened a week after the ITT went out — must not show a date that slides forward
   * every day it is looked at; it shows what was issued, or nothing.
   *
   * `toStamp` is non-null only on rung 3, so a date that came from a human is never written
   * into the package's own column and rung 1 stays reversible.
   */
  private resolveReturnDeadline(
    pkg: { tender_return_period_value?: unknown; tender_return_period_unit?: unknown; tender_return_deadline?: unknown },
    explicit: unknown,
    asOf?: Date
  ): { display: string | null; toStamp: string | null } {
    if (explicit) return { display: this.formatDate(explicit), toStamp: null };
    if (pkg.tender_return_deadline) return { display: this.formatDate(pkg.tender_return_deadline), toStamp: null };

    const unit = pkg.tender_return_period_unit;
    const value = Number(pkg.tender_return_period_value);
    if (!asOf || !isTenderReturnUnit(unit) || !Number.isInteger(value)) return { display: null, toStamp: null };

    const derived = deriveReturnDate(asOf, value, unit);
    return { display: this.formatDate(derived), toStamp: derived };
  }

  /**
   * Records the return date an ITT actually went out with, once.
   *
   * `AND tender_return_deadline IS NULL` is the whole guarantee, and it is deliberately in
   * the WHERE rather than folded into the SET as a COALESCE: a resend, a re-confirmation of
   * the shortlist or a second reviewer racing the first cannot move a date a tenderer is
   * already working to, and the invariant is checkable by reading one line.
   */
  async stampTenderReturnDeadlines(workflowId: string, stamps: Array<{ packageName: string; date: string }>): Promise<void> {
    for (const stamp of stamps) {
      await this.db.query(
        `UPDATE shortlists SET tender_return_deadline = $3::date
          WHERE workflow_id = $1 AND package_name = $2 AND tender_return_deadline IS NULL`,
        [workflowId, stamp.packageName, stamp.date]
      );
    }
  }

  /** The workflow-wide date a human typed at Step 2, raw. Read once per send and threaded
   *  into each package's assembly, rather than re-queried per package. */
  private async explicitReturnDeadlineFor(workflowId: string): Promise<unknown> {
    const [row] = await this.db.query<Row>(
      `SELECT tender_return_deadline FROM itt_letter_details WHERE workflow_id = $1`, [workflowId]
    );
    return row?.tender_return_deadline ?? null;
  }

  /** Builds an IttEmailLetterContext for a workflow, pre-filling estimator name/email
   * from the confirming actor's own account when no itt_letter_details row (or no
   * value in it) has been saved yet — see GET /api/tender-prep/:workflowId/itt-letter-details. */
  async letterContextFor(actor: Actor, workflowId: string): Promise<IttEmailLetterContext> {
    const details = await this.getIttLetterDetails(actor, workflowId);
    const orgName = await this.organizationName(actor);
    const projectEstimator = (details?.estimator_name || details?.estimator_email) ? null : await this.defaultProjectEstimator(workflowId);
    return {
      siteAddress: (details?.site_address as string | null) ?? null,
      tenderReturnDeadline: this.formatDate(details?.tender_return_deadline),
      clarificationsCloseDate: this.formatDate(details?.clarifications_close_date),
      siteVisitPermitted: (details?.site_visit_permitted as boolean | null) ?? null,
      estimatorName: (details?.estimator_name as string | null) ?? projectEstimator?.name ?? actor.displayName ?? null,
      estimatorEmail: (details?.estimator_email as string | null) ?? projectEstimator?.email ?? actor.email ?? null,
      organizationName: orgName
    };
  }

  /**
   * The project's DEFAULT signatory (issue #41, bf_project_estimators.seq = 1) —
   * the middle rung between a saved itt_letter_details row (a human deliberately
   * set one, for this workflow) and the confirming actor's own account (the last
   * resort, always available). A project names its estimators once at creation;
   * this is what lets every package under it default to that name without asking
   * again.
   *
   * workflows carries no project_id column directly — it is only ever reachable
   * through step_data.takeoff.projectId (the same trap db.ts's own comment on
   * bf_takeoff_package_versions warns about), so a workflow with no take-off
   * launched yet (the ITT preview path) correctly resolves to no project estimator.
   */
  private async defaultProjectEstimator(workflowId: string): Promise<{ name: string; email: string } | null> {
    const [row] = await this.db.query<Row>(
      `SELECT e.name, e.email
         FROM workflows w
         JOIN public.bf_project_estimators e
           ON e.project_id = (w.step_data -> 'takeoff' ->> 'projectId')::uuid
        WHERE w.id = $1
        ORDER BY e.seq
        LIMIT 1`,
      [workflowId]
    );
    if (!row) return null;
    return { name: String(row.name), email: String(row.email) };
  }

  /** The {{token}} -> value map every template (email body and PDF alike) resolves
   * against — system fields from send-time data, plus this org's custom variables
   * (itt_template_variables, also read cross-schema from the parent's public schema). */
  private async buildRenderContext(
    actor: Actor, pack: IttEmailPack, projectName: string, letterContext: IttEmailLetterContext, recipient: { name: string | null; email: string; address: string | null }
  ): Promise<RenderContext> {
    const customRows = await this.db.query<Row>(
      `SELECT DISTINCT ON (key) key, default_value FROM itt_template_variables
        WHERE organization_id = $1 OR organization_id IS NULL
        ORDER BY key, organization_id NULLS LAST`,
      [actor.organizationId]
    );
    const context: RenderContext = {
      projectName,
      tradeName: pack.packageName,
      siteAddress: letterContext.siteAddress ?? '',
      recipientName: recipient.name ?? '',
      recipientAddress: recipient.address ?? '',
      todayDate: new Date().toLocaleDateString('en-GB'),
      // Per-package, because attachmentsFor builds one render context per pack: a firm
      // invited to three packages gets three cover letters, each stating its own date.
      tenderReturnDeadline: pack.tenderReturnDeadline ?? letterContext.tenderReturnDeadline ?? 'to be confirmed',
      clarificationsCloseDate: letterContext.clarificationsCloseDate ?? 'to be confirmed',
      siteVisitPermitted: letterContext.siteVisitPermitted === null ? 'To be confirmed' : letterContext.siteVisitPermitted ? 'Yes' : 'No',
      estimatorName: letterContext.estimatorName ?? '',
      estimatorEmail: letterContext.estimatorEmail ?? '',
      organizationName: letterContext.organizationName,
      sectionIndex: sectionIndex(pack.attachmentCodes),
      requiredReturnsList: requiredReturnsList(pack.attachmentCodes, pack.valueEngineeringRequired)
    };
    for (const r of customRows) context[String(r.key)] = String(r.default_value);
    return context;
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
  async getTenderLaunchTable(
    actor: Actor, workflowId: string, perPackage: number, packageConfigId?: string
  ): Promise<Row[]> {
    await this.assertWorkflowAccess(actor, workflowId);
    const workflow = await this.db.one<{ step_data: { takeoff?: { projectId?: string | null } } }>(
      `SELECT step_data FROM workflows WHERE id = $1`, [workflowId]
    );
    const projectId = workflow.step_data?.takeoff?.projectId ?? null;
    const all = await this.listPackageConfig(actor, projectId);
    // Narrowed BEFORE the loop below, which is the whole point: each package costs an SCMS
    // candidate search, so asking for one package costs one search rather than thirty-five.
    // The dashboard's approval modal edits a single package and needs nothing else.
    const packages = packageConfigId ? all.filter((pkg) => String(pkg.id) === packageConfigId) : all;

    const shortlists = await this.db.query<{
      id: string; package_name: string; confirmed_at: string | null; board_override_notes: string | null;
      route_of_procurement: string | null; tender_return_period_value: number | null;
      tender_return_period_unit: string | null; tender_return_deadline: string | null;
    }>(
      // The issued date is formatted in SQL rather than returned raw. The BFF installs no pg
      // type parser, so a DATE comes back as a Date at LOCAL midnight and serialises to the
      // PREVIOUS day under a positive UTC offset — a launch table reporting a date one day
      // earlier than the letter a tenderer holds would be worse than reporting none.
      `SELECT id, package_name, confirmed_at, board_override_notes, route_of_procurement,
              tender_return_period_value, tender_return_period_unit,
              to_char(tender_return_deadline, 'DD/MM/YYYY') AS tender_return_deadline
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
        // How long this package is tendered for, and — once an ITT has gone out — the date
        // that resolved to. The date is shown, never re-derived here: a read of the launch
        // table must not invent a deadline that moves every day it is opened.
        tender_return_period_value: shortlist?.tender_return_period_value ?? null,
        tender_return_period_unit: shortlist?.tender_return_period_unit ?? null,
        tender_return_deadline: shortlist?.tender_return_deadline ?? null,
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
   * The tender dashboard: one row per trade package, carrying the firms it went to and what
   * came back from them.
   *
   * It used to be built on `getTenderLaunchTable`, and that was the wrong shape. The launch
   * table SEARCHES the register for candidates — a `tps.trades_match` evaluation per (package x
   * trade category), about 10,000 of them, 17 seconds for one page — and this dashboard then
   * discarded every candidate except the ones a meeting had already picked. It was paying to
   * answer a question it never asks. The firms it shows are in `shortlist_entries` (11 rows,
   * 2 ms on the pack that took 17 s), and their details come from an indexed lookup by id.
   *
   * Every read below is keyed or indexed. Nothing here matches trades.
   *
   * The figures still come from the same rows Step 1 shows, so the two pages cannot disagree
   * about a package: its confirmation, route and return period are the shortlist's own, and
   * `suggestion_reason` is the wording the meeting was shown, persisted at the time.
   */
  async dashboardRows(actor: Actor, workflowId: string): Promise<Row[]> {
    await this.assertWorkflowAccess(actor, workflowId);
    const workflow = await this.db.one<{ step_data: { takeoff?: { projectId?: string | null } } }>(
      `SELECT step_data FROM workflows WHERE id = $1`, [workflowId]
    );
    const packages = await this.listPackageConfig(actor, workflow.step_data?.takeoff?.projectId ?? null);

    const shortlists = await this.db.query<{
      package_name: string; confirmed_at: string | null; board_override_notes: string | null;
      route_of_procurement: string | null; tender_return_period_value: number | null;
      tender_return_period_unit: string | null; tender_return_deadline: string | null;
    }>(
      // The issued date is formatted in SQL for the reason getTenderLaunchTable states: the BFF
      // installs no pg type parser, so a DATE returns at LOCAL midnight and serialises to the
      // previous day under a positive UTC offset.
      `SELECT package_name, confirmed_at, board_override_notes, route_of_procurement,
              tender_return_period_value, tender_return_period_unit,
              to_char(tender_return_deadline, 'DD/MM/YYYY') AS tender_return_deadline
         FROM shortlists WHERE workflow_id = $1`,
      [workflowId]
    );

    // Only what a meeting picked, and never the placeholder — it is an affordance meaning
    // "no firm in the register carries this trade", not a firm anybody chose.
    const chosen = await this.db.query<{
      package_name: string; subcontractor_id: string; rank: number; suggestion_reason: string | null;
    }>(
      `SELECT sl.package_name, se.subcontractor_id::text AS subcontractor_id, se.rank,
              se.suggestion_reason
         FROM shortlists sl
         JOIN shortlist_entries se ON se.shortlist_id = sl.id
        WHERE sl.workflow_id = $1 AND se.selected AND se.subcontractor_id <> $2::uuid
        ORDER BY sl.package_name, se.rank`,
      [workflowId, PLACEHOLDER_SUBCONTRACTOR_ID]
    );

    const firms = new Map((await this.scms.getFirmsByIds(
      [...new Set(chosen.map((row) => String(row.subcontractor_id)))]
    )).map((firm) => [String(firm.subcontractor_id), firm]));

    const dispatches = await this.db.query<{
      package_name: string; subcontractor_id: string; response: string | null; dispatched_at: string | null;
      entry_id: string; dispatch_id: string | null; response_source: string | null; email_status: string | null;
    }>(
      `SELECT sl.package_name, se.subcontractor_id::text AS subcontractor_id,
              d.response, d.dispatched_at,
              se.id::text AS entry_id, d.id::text AS dispatch_id, d.response_source, d.email_status
         FROM shortlists sl
         JOIN shortlist_entries se ON se.shortlist_id = sl.id
         LEFT JOIN itt_dispatch d ON d.shortlist_entry_id = se.id
        WHERE sl.workflow_id = $1 AND se.selected`,
      [workflowId]
    );
    const returns = await this.db.query<{
      package_name: string; subcontractor_id: string | null; tendered_sum: string | null; is_fabricated: boolean;
    }>(
      `SELECT package_name, subcontractor_id::text AS subcontractor_id, tendered_sum, is_fabricated
         FROM tender_returns WHERE workflow_id = $1 AND subcontractor_id IS NOT NULL`,
      [workflowId]
    );

    // Reminders already sent, per invitation, so ITT Dispatch can show the history beside the
    // "Send reminder" button. 'sent' only: a failed or still-pending attempt reached nobody.
    const reminderRows = await this.db.query<{
      shortlist_entry_id: string; n: string; last_sent_at: string; last_kind: string;
    }>(
      `SELECT r.shortlist_entry_id::text AS shortlist_entry_id, count(*)::text AS n,
              max(r.sent_at) AS last_sent_at,
              (array_agg(r.kind ORDER BY r.sent_at DESC))[1] AS last_kind
         FROM itt_reminders r
         JOIN shortlist_entries se ON se.id = r.shortlist_entry_id
         JOIN shortlists sl ON sl.id = se.shortlist_id
        WHERE sl.workflow_id = $1 AND r.email_status = 'sent' AND r.is_test = $2
        GROUP BY r.shortlist_entry_id`,
      // In test mode the dashboard shows the test reminders, and only those, so a simulated
      // run is visible where it was made and a real one is never confused with it.
      [workflowId, Boolean(this.testEmailOverride)]
    );
    const remindersBy = new Map(reminderRows.map((row) => [row.shortlist_entry_id, row]));

    // Which firms have asked for clarification, so the dashboard can put the icon the
    // issue asks for against them. Its own round trip rather than a join into the query
    // above, because `comms` is owned by another repository and `commsDb.ts` is the only
    // file here allowed to name it — one indexed read is a cheaper price than a second
    // file in that blast radius. Absent comms, every firm simply has no icon.
    const queryThreads = this.commsDb ? await this.commsDb.threadQueryCountsForWorkflow(workflowId) : [];
    // Ordered most-recent-first by the query, so the first thread seen for a firm is the
    // one to open. A firm writing from two addresses genuinely has two conversations —
    // the counts add up, the deep link goes to the live one.
    const commsBy = new Map<string, { thread_id: string; queries: number; outstanding: number }>();
    for (const thread of queryThreads) {
      if (thread.subcontractor_id == null) continue;
      const key = String(thread.subcontractor_id);
      const existing = commsBy.get(key);
      if (existing) {
        existing.queries += Number(thread.query_count ?? 0);
        existing.outstanding += Number(thread.outstanding_count ?? 0);
      } else {
        commsBy.set(key, {
          thread_id: String(thread.thread_id),
          queries: Number(thread.query_count ?? 0),
          outstanding: Number(thread.outstanding_count ?? 0)
        });
      }
    }

    // Keyed as a JSON pair rather than a joined string: a package name is free text, so any
    // separator picked here is one a client could put in a package name.
    const key = (packageName: unknown, subcontractorId: unknown) =>
      JSON.stringify([String(packageName), String(subcontractorId)]);
    const shortlistBy = new Map(shortlists.map((row) => [String(row.package_name), row]));
    const dispatchBy = new Map(dispatches.map((row) => [key(row.package_name, row.subcontractor_id), row]));
    const returnBy = new Map(returns.map((row) => [key(row.package_name, row.subcontractor_id), row]));

    return packages.map((pkg) => {
      const shortlist = shortlistBy.get(String(pkg.name));
      return {
        package_config_id: pkg.id,
        seq: pkg.seq,
        sub_seq: pkg.sub_seq,
        display_ref: pkg.display_ref,
        is_heading: pkg.is_heading,
        is_sub_package: pkg.parent_id != null,
        package_name: pkg.name,
        configured_route: pkg.route_of_procurement,
        route_of_procurement: shortlist?.route_of_procurement ?? pkg.route_of_procurement,
        trade_terms: (pkg.trade_terms as string[] | null) ?? [],
        wp_code: pkg.wp_code ?? null,
        wp_scope_condition: pkg.wp_scope_condition ?? null,
        derived_from_takeoff: pkg.derived_from_takeoff ?? null,
        notes: pkg.notes,
        confirmed_at: shortlist?.confirmed_at ?? null,
        board_override_notes: shortlist?.board_override_notes ?? null,
        tender_return_period_value: shortlist?.tender_return_period_value ?? null,
        tender_return_period_unit: shortlist?.tender_return_period_unit ?? null,
        tender_return_deadline: shortlist?.tender_return_deadline ?? null,
        subcontractors: chosen
          .filter((row) => String(row.package_name) === String(pkg.name))
          .map((row) => {
            const firm = firms.get(String(row.subcontractor_id));
            const dispatch = dispatchBy.get(key(pkg.name, row.subcontractor_id));
            const tenderReturn = returnBy.get(key(pkg.name, row.subcontractor_id));
            return {
              ...(firm ?? {}),
              subcontractor_id: row.subcontractor_id,
              // A firm can be picked and later leave the register. Step 1 keeps the meeting's
              // record visible in that case and so does this.
              name: firm?.name ?? '(no longer in the register)',
              selected: true,
              // The wording the meeting was actually shown, persisted at the time — not
              // recomputed now against a register that has since moved.
              suggestion_reason: row.suggestion_reason ?? '',
              usp: firm ? describeUsp(firm) : '',
              off_register: !firm,
              dispatched_at: dispatch?.dispatched_at ?? null,
              response: dispatch?.response ?? null,
              // Spelled out rather than left to the reader: 'no_response' and "never asked"
              // are both "not accepted", and only one of them is a firm declining.
              accepted: dispatch?.response === 'will_tender',
              declined: dispatch?.response === 'decline',
              // What "Send reminder" would send, decided by the same pure rule the server
              // applies when the button is clicked - so the label can never promise one email
              // and deliver the other. Null (with no button) for a firm that declined or has
              // already returned a price, and for one whose invitation never went out.
              dispatch_id: dispatch?.dispatch_id ?? null,
              response_source: dispatch?.response_source ?? null,
              reminder_kind: dispatch?.dispatch_id && dispatch.email_status === 'sent'
                ? (manualReminderKind((dispatch.response as IttResponse) ?? null, Boolean(tenderReturn)).kind)
                : null,
              reminders_sent: Number(remindersBy.get(dispatch?.entry_id ?? '')?.n ?? 0),
              last_reminder_at: remindersBy.get(dispatch?.entry_id ?? '')?.last_sent_at ?? null,
              last_reminder_kind: remindersBy.get(dispatch?.entry_id ?? '')?.last_kind ?? null,
              tendered_sum: tenderReturn?.tendered_sum ?? null,
              // Test data travels through the same tables as a real bid, and every read that
              // reaches a human has to say which it is looking at.
              is_fabricated: tenderReturn?.is_fabricated ?? false,
              // Per FIRM, not per package: a thread is one conversation with one firm
              // across this tender, so the same icon appears on each package that firm
              // is pricing. That is the truth — the query was asked once.
              query_count: commsBy.get(String(row.subcontractor_id))?.queries ?? 0,
              outstanding_queries: commsBy.get(String(row.subcontractor_id))?.outstanding ?? 0,
              comms_thread_id: commsBy.get(String(row.subcontractor_id))?.thread_id ?? null
            };
          })
      } as Row;
    });
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
    /** How long this package is tendered for. Null clears it. Validated in app.ts against
     *  the same 1-5 days / 1-8 weeks rule as shortlists_tender_return_period_check. */
    tenderReturnPeriod?: { value: number; unit: 'days' | 'weeks' } | null;
    entries: Array<{
      subcontractorId: string; rank: number; selected: boolean; suggestionReason?: string;
      performanceScore?: number; complianceFlags?: Record<string, unknown>;
    }>;
  }): Promise<Row> {
    await this.assertWorkflowAccess(actor, workflowId);
    return this.db.transaction(async (client) => {
      // tender_return_deadline is deliberately absent from both the column list and the
      // DO UPDATE SET. Re-confirming a shortlist must not move a date already issued — only
      // stampTenderReturnDeadlines writes that column, and only where it is still NULL.
      const shortlist = await this.db.one(
        `INSERT INTO shortlists (workflow_id, package_name, package_seq, route_of_procurement, confirmed_at, board_override_notes,
                                 tender_return_period_value, tender_return_period_unit)
         VALUES ($1,$2,$3,$4,NOW(),$5,$6,$7)
         ON CONFLICT (workflow_id, package_name) DO UPDATE SET
           package_seq = EXCLUDED.package_seq,
           route_of_procurement = EXCLUDED.route_of_procurement,
           confirmed_at = NOW(),
           board_override_notes = EXCLUDED.board_override_notes,
           tender_return_period_value = EXCLUDED.tender_return_period_value,
           tender_return_period_unit = EXCLUDED.tender_return_period_unit
         RETURNING *`,
        [workflowId, input.packageName, input.packageSeq ?? null,
         input.routeOfProcurement ?? null, input.boardOverrideNotes ?? null,
         input.tenderReturnPeriod?.value ?? null, input.tenderReturnPeriod?.unit ?? null], client
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
  /**
   * Every package the tender launch meeting has confirmed, with what has happened to its ITT.
   *
   * It used to end `HAVING count(*) FILTER (WHERE se.selected) > 0`, which dropped a confirmed
   * package that had nobody to invite — silently, with no row and nothing anywhere to explain the
   * gap. `savePackageSelection` stamps `confirmed_at` whether or not a firm was ticked, so a
   * shortlist row existing IS the buyer having signed the package off, and it belongs on this
   * page whatever state it is in. Reading had eight confirmed packages and showed six.
   *
   * `candidates` is what tells the two causes apart, and they need different answers:
   *   recipients > 0                  — ready to send;
   *   recipients = 0, candidates = 0  — no firm in the register carries this trade, so nothing
   *                                     was selectable. The remedy is to build the supply chain.
   *   recipients = 0, candidates > 0  — firms were offered and none was picked. The remedy is to
   *                                     reopen the package and choose.
   * The placeholder firm is excluded from `candidates` for exactly that reason: it is an
   * affordance saying "nobody here", not a firm somebody declined to pick.
   */
  async listItts(actor: Actor, workflowId: string): Promise<Row[]> {
    await this.assertWorkflowAccess(actor, workflowId);
    return this.db.query(
      `SELECT sl.package_name,
              sl.package_seq,
              sl.route_of_procurement,
              sl.confirmed_at,
              count(*) FILTER (WHERE se.selected) AS recipients,
              count(*) FILTER (WHERE se.id IS NOT NULL AND se.subcontractor_id <> $2::uuid) AS candidates,
              count(d.id) FILTER (WHERE d.dispatched_at IS NOT NULL) AS dispatched,
              count(d.id) FILTER (WHERE d.email_status = 'sent') AS sent,
              count(d.id) FILTER (WHERE d.email_status = 'failed') AS failed,
              count(d.id) FILTER (WHERE d.email_status = 'skipped_no_email') AS skipped_no_email,
              count(*) FILTER (WHERE se.selected AND d.response IS NOT NULL) AS responded,
              -- A SUBMITTED priced bill, not a buyer's manual "will_tender" mark — a
              -- different fact with different provenance, so it is not folded into
              -- the responded column above. Drives the "response received" status and
              -- the "Open responses" button on the dispatch page.
              count(ppl.id) FILTER (WHERE ppl.submitted_at IS NOT NULL) AS responses_received,
              count(ppl.id) FILTER (WHERE ppl.token IS NOT NULL) AS portal_links,
              count(ppl.id) FILTER (WHERE ppl.denied_attempts > 0) AS portal_denials
         FROM shortlists sl
         LEFT JOIN shortlist_entries se ON se.shortlist_id = sl.id
         LEFT JOIN itt_dispatch d ON d.shortlist_entry_id = se.id
         LEFT JOIN pricing_portal_links ppl ON ppl.shortlist_entry_id = se.id
        WHERE sl.workflow_id = $1
        GROUP BY sl.package_name, sl.package_seq, sl.route_of_procurement, sl.confirmed_at
        ORDER BY sl.package_seq NULLS LAST, sl.package_name`,
      [workflowId, PLACEHOLDER_SUBCONTRACTOR_ID]
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
    bundles: BuildflowBundle[],
    /** The workflow's explicit Step 2 date, raw, from explicitReturnDeadlineFor. Read once
     *  per send by the caller rather than re-queried for every package. */
    explicitReturnDeadline?: unknown
  ): Promise<{ emailPack: IttEmailPack; recipients: Row[]; projectName: string; returnDeadlineToStamp: string | null }> {
    const pack = await this.getPackageItt(actor, workflowId, packageName);
    const notIgnored = (items: Row[]) => items.filter((i) => i.ignored !== true);

    const returnForms = notIgnored(pack.return_forms as Row[]);
    const boqLines = notIgnored(pack.boq_lines as Row[]);
    const billLines = notIgnored(pack.bill_lines as Row[]);
    const scopeItems = notIgnored(pack.scope_items as Row[]);

    const takeoff = pack.takeoff as Record<string, unknown>;

    // The package's own document zip, matched on the wp_code the package was derived from.
    //
    // THE ONLY DOCUMENT LINK THE EMAIL CARRIES. There was a fallback here that fetched
    // BuildFlow's flat per-document list when no bundle existed, and on the first real send it
    // printed all 140 documents in the project into the email — the drainage sheets to the
    // flooring subcontractor, and the four drawings that mattered lost among them. A package
    // with no bundle now says so and points at the complete set; see `documentsSentence`.
    const wpCode = typeof pack.wp_code === 'string' ? pack.wp_code : null;
    const packageBundle = wpCode ? bundles.find((b) => b.wpCode === wpCode) : undefined;

    const priceable = boqLines.filter((l) => l.is_priceable).length;

    // Resolved here, not in the send paths: the preview and the real send both come through
    // this method, so what the modal shows and what the email carries are the same value by
    // construction. Resolving is not recording — `returnDeadlineToStamp` is handed back and
    // only a path that actually sends writes it.
    const returnDeadline = this.resolveReturnDeadline(pack, explicitReturnDeadline, new Date());

    // Best-effort: an id BuildFlow can't resolve, or BuildFlow being unreachable, should
    // never block the ITT — the email just sends with no spec clauses section.
    const chunkIds = [...new Set(boqLines.flatMap((l) => (l.spec_chunk_ids as string[] | null) ?? []))];
    const specClauses = this.specClauses ? await this.specClauses.clausesFor(chunkIds) : [];

    const emailPack: IttEmailPack = {
      packageName: pack.package_name as string,
      displayRef: pack.display_ref as string,
      routeOfProcurement: (pack.route_of_procurement as string | null) ?? null,
      tenderReturnDeadline: returnDeadline.display,
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
      valueEngineeringRequired: Boolean(pack.value_engineering_required),
      attachmentCodes: await this.attachmentCodesFor({ name: pack.package_name as string, wp_code: pack.wp_code })
    };

    return {
      emailPack,
      recipients: pack.recipients as Row[],
      projectName: (takeoff?.projectName as string | undefined) ?? 'the project',
      returnDeadlineToStamp: returnDeadline.toStamp
    };
  }

  /**
   * Mints (or refreshes) a subcontractor pricing-portal link for every recipient about to
   * be emailed, snapshots a NEW link's bill from the already-assembled `emailPack`, then
   * reconciles the ONE Cloudflare Access application/policy against the resulting live
   * recipient set — ALL of it BEFORE the caller sends a single email.
   *
   * Unconfigured (no `portalDb`) — every request is skipped with no reason recorded and
   * the send proceeds exactly as it did before this feature existed; there is nowhere to
   * record a reason without a portal table to write to.
   *
   * Configured, but this recipient's domain is public/free, or `accessAdmin` itself is
   * unconfigured — no link is issued, but a row IS written (`recordBlocked`) so the
   * dispatch page can say why rather than the recipient simply having nothing.
   *
   * Configured, and the Cloudflare API call fails — THROWS, and the caller MUST refuse
   * the whole send. Every other BuildFlow integration in this file degrades silently
   * (`bundlesForWorkflow` returns `[]`, a broken document link becomes `url: null`)
   * because its absence only makes an email less useful. A missing Access policy
   * converts a gated portal into an open one with nobody positioned to notice, which is
   * why this is the one integration that is not best-effort.
   */
  private async mintPortalLinksFor(requests: Array<{
    shortlistEntryId: string; workflowId: string; packageName: string;
    subcontractorId: string | null; tendererName: string; recipientEmail: string | null;
    emailPack: IttEmailPack;
  }>): Promise<Map<string, IttEmailPortalStatus>> {
    const statuses = new Map<string, IttEmailPortalStatus>();
    const key = (shortlistEntryId: string, packageName: string) => `${shortlistEntryId}::${packageName}`;
    if (!this.portalDb) return statuses;

    for (const r of requests) {
      if (!r.recipientEmail) continue;
      const domain = domainOf(r.recipientEmail);
      if (isPublicEmailDomain(domain)) {
        await this.portalDb.recordBlocked({
          shortlistEntryId: r.shortlistEntryId, workflowId: r.workflowId, packageName: r.packageName,
          subcontractorId: r.subcontractorId, tendererName: r.tendererName, recipientEmail: r.recipientEmail,
          reason: 'public_email_domain'
        });
        statuses.set(key(r.shortlistEntryId, r.packageName), {
          url: null, unavailableReason: "this recipient's email domain is a public/free provider"
        });
        continue;
      }
      if (!this.accessAdmin) {
        await this.portalDb.recordBlocked({
          shortlistEntryId: r.shortlistEntryId, workflowId: r.workflowId, packageName: r.packageName,
          subcontractorId: r.subcontractorId, tendererName: r.tendererName, recipientEmail: r.recipientEmail,
          reason: 'access_unconfigured'
        });
        // No inline reason printed to the email here — an unconfigured deployment is a
        // fact for us to fix, not something a real subcontractor needs to read.
        continue;
      }
      const { id, token, isNewLink } = await this.portalDb.mintOrRefreshLink({
        shortlistEntryId: r.shortlistEntryId, workflowId: r.workflowId, packageName: r.packageName,
        subcontractorId: r.subcontractorId, tendererName: r.tendererName, recipientEmail: r.recipientEmail,
        isTest: Boolean(this.testEmailOverride), ttlDays: this.portalLinkTtlDays
      });
      if (isNewLink) await this.portalDb.snapshotLines(id, linesFromEmailPack(r.emailPack));
      statuses.set(key(r.shortlistEntryId, r.packageName), {
        url: `${(this.portalBaseUrl ?? '').replace(/\/$/, '')}/respond/${token}`, unavailableReason: null
      });
    }

    if (this.accessAdmin) {
      // Recomputed from the FULL live set already in the database, not just this send's
      // requests — see CloudflareAccessAdmin.syncFor's doc comment for why that matters.
      await this.accessAdmin.syncFor(await this.portalDb.liveRecipients());
    }

    return statuses;
  }

  /**
   * TEMPORARY (testing the pricing-portal link through the compose box) — revert once
   * verified. A real per-recipient link is otherwise only ever rendered from
   * confirmAndSendItt / sendIttsForWorkflow — see sendIttDraft's comment on why a shared
   * compose-box message never carries one. This narrows that to the one case safe to test:
   * the first real shortlisted recipient, minted against the TEST override address so no
   * real subcontractor's inbox is ever the one bound to the link. Only runs at all when
   * TEST_EMAIL_FLAG is on, so it is inert (and safe to leave in place) once that's unset.
   */
  private async draftPortalStatus(
    workflowId: string, packageName: string, emailPack: IttEmailPack, recipients: IttDraftRecipient[]
  ): Promise<IttEmailPortalStatus | null> {
    if (!this.testEmailOverride) return null;
    const recipient = recipients[0];
    if (!recipient) return null;
    const statuses = await this.mintPortalLinksFor([{
      shortlistEntryId: recipient.shortlistEntryId, workflowId, packageName,
      subcontractorId: recipient.subcontractorId, tendererName: recipient.name ?? 'Unknown firm',
      recipientEmail: this.testEmailOverride.to, emailPack
    }]);
    return statuses.get(`${recipient.shortlistEntryId}::${packageName}`) ?? null;
  }

  /**
   * The configured attachment set (cover letter, forms, scope PDF, pricing workbook,
   * schedule of attendances — see itt_attachment_trades) for each package on the
   * message, addressed to one recipient — the cover letter and forms carry that
   * recipient's own name/address, so unlike the old scope/BoQ-only pair these are
   * NOT identical for every firm invited to the same package and must be rebuilt per
   * recipient (still once per package within that recipient's own send, not once
   * per package across every recipient).
   *
   * Oversized sends drop their attachments rather than failing: the email still carries the
   * inline tables and the document-pack links, which is far better than a provider rejecting
   * the whole message and the subcontractor receiving nothing.
   */
  private async attachmentsFor(
    actor: Actor, packs: IttEmailPack[], projectName: string,
    letterContext: IttEmailLetterContext, recipient: { name: string | null; email: string; address: string | null }
  ): Promise<EmailAttachment[]> {
    const built: EmailAttachment[] = [];
    for (const pack of packs) {
      const { templates } = await this.resolvedTemplatesFor(actor, pack.attachmentCodes);
      const context = await this.buildRenderContext(actor, pack, projectName, letterContext, recipient);
      const packageRow = await this.db.query<Row>(`SELECT id FROM package_config WHERE organization_id = $1 AND name = $2 LIMIT 1`, [actor.organizationId, pack.packageName]);
      const attendanceRows = packageRow[0] ? await this.attendanceRowsFor(actor, packageRow[0]) : [];
      for (const file of await ittAttachmentsFor(pack, projectName, context, templates, attendanceRows)) {
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
   * Everything the in-app compose box needs to show one package's ITT before it is sent.
   *
   * Step 2 otherwise offers only "read it on screen" or "it has gone". This is the step in
   * between: the exact email Confirm ITT would send, opened in a modal with To, Cc and Subject
   * so it can be addressed by hand, copied to a colleague, and sent when the sender is ready.
   *
   * SAME CONTENT AS A REAL SEND. It goes through bundlesForWorkflow → assemblePackageForEmail →
   * renderIttEmail → ittAttachmentsFor, exactly as confirmAndSendItt does. The body is shown
   * read-only and `sendIttDraft` rebuilds it from this same assembly rather than accepting it
   * back from the browser, so what a tenderer is bound by has exactly one origin.
   *
   * The greeting stays "Dear Sir/Madam,": one message may be addressed to several firms, so it
   * cannot open with any one recipient's name.
   *
   * No confirmation is required. Reviewing the email BEFORE confirming the package is most of
   * the point, and getPackageItt imposes no such precondition either.
   */
  async draftIttEmail(actor: Actor, workflowId: string, packageName: string): Promise<IttDraft> {
    await this.assertWorkflowAccess(actor, workflowId);

    const { emailPack, projectName, completeBundleUrl, letterContext, attachments, attachmentsOmittedOversize, recipients } =
      await this.buildIttDraft(actor, workflowId, packageName);
    const portalStatus = await this.draftPortalStatus(workflowId, packageName, emailPack, recipients);
    const rendered = renderIttEmail([emailPack], { name: null, email: '', address: null }, {
      projectName, completeBundleUrl, letterContext,
      portalStatusByPackage: portalStatus ? { [packageName]: portalStatus } : undefined
    });

    return {
      packageName: emailPack.packageName,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      recipients,
      bundleUrl: emailPack.bundle?.url ?? null,
      completeBundleUrl,
      portalUrl: portalStatus?.url ?? null,
      attachments: attachments.map((f) => ({
        filename: f.filename, contentType: f.contentType, bytes: f.content.length
      })),
      attachmentsOmittedOversize
    };
  }

  /**
   * The assembly `draftIttEmail` and `sendIttDraft` share.
   *
   * Both must see the same package, the same attachments and the same shortlist, or the modal
   * would preview one email and send another.
   */
  private async buildIttDraft(actor: Actor, workflowId: string, packageName: string): Promise<{
    emailPack: IttEmailPack;
    projectName: string;
    completeBundleUrl: string | null;
    letterContext: IttEmailLetterContext;
    attachments: IttAttachment[];
    attachmentsOmittedOversize: boolean;
    recipients: IttDraftRecipient[];
    /** Non-null when this draft's date came from the package's return period and has not
     *  been issued yet. draftIttEmail ignores it — a preview records nothing. */
    returnDeadlineToStamp: string | null;
  }> {
    const bundles = await this.bundlesForWorkflow(workflowId);
    const completeBundleUrl = bundles.find((b) => b.wpCode === null)?.url ?? null;
    const letterContext = await this.letterContextFor(actor, workflowId);
    const explicitReturnDeadline = await this.explicitReturnDeadlineFor(workflowId);
    const assembled = await this.assemblePackageForEmail(actor, workflowId, packageName, bundles, explicitReturnDeadline);
    // The compose box addresses whoever the sender types in, not one named firm, so
    // there is no single recipient to personalise the letter/forms to yet.
    const draftRecipient = { name: null as string | null, email: '', address: null as string | null };

    // The same budget a real send applies, measured the same way (on the encoded length, which
    // is what actually travels) — so a package that would send without its attachments previews
    // without them too, rather than promising files the send would drop.
    const { templates } = await this.resolvedTemplatesFor(actor, assembled.emailPack.attachmentCodes);
    const context = await this.buildRenderContext(actor, assembled.emailPack, assembled.projectName, letterContext, draftRecipient);
    const packageRow = await this.db.query<Row>(`SELECT id FROM package_config WHERE organization_id = $1 AND name = $2 LIMIT 1`, [actor.organizationId, packageName]);
    const attendanceRows = packageRow[0] ? await this.attendanceRowsFor(actor, packageRow[0]) : [];
    const files = await ittAttachmentsFor(assembled.emailPack, assembled.projectName, context, templates, attendanceRows);
    const encodedBytes = files.reduce((sum, f) => sum + Math.ceil(f.content.length / 3) * 4, 0);
    const attachmentsOmittedOversize = encodedBytes > MAX_ATTACHMENT_BYTES;

    // Every firm the tender launch meeting selected for this package, with whatever contact
    // SCMS holds. A firm with no email on file is returned with email: null rather than dropped
    // — "there is nobody to write to at this firm" is a fact the sender needs to see.
    const contacts = new Map(
      (await this.scms.getContactsForSubcontractors(assembled.recipients.map((r) => String(r.subcontractor_id))))
        .map((c) => [String(c.subcontractor_id), c])
    );
    const recipients: IttDraftRecipient[] = assembled.recipients.map((r) => {
      const contact = contacts.get(String(r.subcontractor_id));
      return {
        shortlistEntryId: String(r.shortlist_entry_id),
        subcontractorId: String(r.subcontractor_id),
        name: contact?.name ? String(contact.name) : null,
        contactName: contact?.contact_name ? String(contact.contact_name) : null,
        email: contact?.contact_email ? String(contact.contact_email) : null
      };
    });

    return {
      emailPack: assembled.emailPack,
      projectName: assembled.projectName,
      completeBundleUrl,
      letterContext,
      attachments: attachmentsOmittedOversize ? [] : files,
      attachmentsOmittedOversize,
      returnDeadlineToStamp: assembled.returnDeadlineToStamp,
      recipients
    };
  }

  /**
   * Send the ITT the compose modal is showing, to the addresses typed into it.
   *
   * THE BODY IS NOT ACCEPTED FROM THE CLIENT. Only To, Cc and Subject cross the wire; the
   * scope, bill, document links and attachments are rebuilt here from the same assembly the
   * preview was rendered from. A tenderer's obligations must not be editable in a browser on
   * their way out, and re-deriving them is what guarantees that rather than trusting the UI.
   *
   * ONE MESSAGE, however many recipients — that is what a compose box means. It differs
   * deliberately from confirmAndSendItt, which addresses each firm separately so that no firm
   * ever sees a competitor's address; here the sender chose who shares the message.
   *
   * Recorded where it can be. An address matching a shortlisted firm's SCMS contact gets an
   * itt_dispatch row so the Status column tells the truth about what has gone out; a hand-typed
   * address matching nobody is still sent to, and the result says how many did not record.
   */
  async sendIttDraft(actor: Actor, workflowId: string, packageName: string, input: {
    to: string[]; cc: string[]; subject: string;
  }): Promise<Row> {
    await this.assertWorkflowAccess(actor, workflowId);
    if (!this.emailService) {
      throw conflict('Email is not configured in this environment, so this ITT cannot be sent from here.');
    }

    const { emailPack, projectName, completeBundleUrl, letterContext, attachments, recipients, returnDeadlineToStamp } =
      await this.buildIttDraft(actor, workflowId, packageName);
    const portalStatus = await this.draftPortalStatus(workflowId, packageName, emailPack, recipients);
    const rendered = renderIttEmail([emailPack], { name: null, email: '', address: null }, {
      projectName, completeBundleUrl, letterContext,
      portalStatusByPackage: portalStatus ? { [packageName]: portalStatus } : undefined
    });

    const normalise = (address: string) => address.trim().toLowerCase();
    const to = [...new Set(input.to.map((a) => a.trim()).filter(Boolean))];
    const cc = [...new Set(input.cc.map((a) => a.trim()).filter(Boolean))]
      .filter((address) => !to.some((t) => normalise(t) === normalise(address)));
    if (to.length === 0) throw conflict('Add at least one recipient before sending.');

    // Past the point of no return, and before the message leaves: the letter rendered below
    // carries this date, so the column has to agree with it. draftIttEmail runs the same
    // assembly and records nothing — a preview is not an issue.
    if (returnDeadlineToStamp) {
      await this.stampTenderReturnDeadlines(workflowId, [{ packageName, date: returnDeadlineToStamp }]);
    }

    const addressed = new Set([...to, ...cc].map(normalise));
    const matched = recipients.filter((r) => r.email && addressed.has(normalise(r.email)));
    const notRecorded = addressed.size - new Set(matched.map((r) => normalise(r.email!))).size;

    // Recorded for the audit trail (so the dispatch page has something to show for these
    // firms), but deliberately NEVER rendered into this email: ONE MESSAGE goes to every
    // matched address at once here, and a portal URL embedded in a shared message would
    // hand firm A's pricing capability to every other addressee on it. Online pricing
    // links are only ever rendered from confirmAndSendItt / sendIttsForWorkflow, which
    // address one firm per message.
    if (matched.length > 0) {
      await this.mintPortalLinksFor(matched.map((r) => ({
        shortlistEntryId: r.shortlistEntryId, workflowId, packageName,
        subcontractorId: r.subcontractorId, tendererName: r.name ?? 'Unknown firm',
        recipientEmail: r.email, emailPack
      })));
    }

    // Test mode redirects the whole message to one inbox and drops the cc list, so exercising
    // this against a real package cannot reach a real subcontractor. The subject names who it
    // was meant for, since every test send lands in the same place.
    const from = this.testEmailOverride?.from ?? await this.ittFromAddress(actor.organizationId);
    const subject = this.testEmailOverride
      ? `[TEST → ${[...to, ...cc].join(', ')}] ${input.subject}`
      : input.subject;

    const encoded: EmailAttachment[] = attachments.map((file) => ({
      content: file.content.toString('base64'),
      filename: file.filename,
      type: file.contentType,
      disposition: 'attachment'
    }));

    let messageId: string | null = null;
    let failure: string | null = null;
    try {
      const result = await this.emailService.send({
        from,
        to: this.testEmailOverride ? this.testEmailOverride.to : to,
        cc: this.testEmailOverride ? [] : cc,
        // A subcontractor replying to a message a person composed should reach that person, not
        // the shared service mailbox every automated ITT is sent from.
        replyTo: actor.email,
        subject,
        html: rendered.html,
        text: rendered.text,
        attachments: encoded
      });
      messageId = (result as { message_id?: string } | null)?.message_id ?? null;
    } catch (error) {
      failure = error instanceof Error ? error.message : 'Unknown error sending email';
    }

    // A failure is recorded too. A firm that did not receive its ITT because the provider
    // rejected the message must not keep showing as "not sent" with no explanation.
    for (const recipient of matched) {
      await this.db.query(
        `INSERT INTO itt_dispatch (shortlist_entry_id, dispatched_at, email_status, email_error, email_sent_at, email_message_id)
         VALUES ($1, NOW(), $2, $3, CASE WHEN $2 = 'sent' THEN NOW() ELSE NULL END, $4)
         ON CONFLICT (shortlist_entry_id) DO UPDATE
           SET dispatched_at = NOW(), email_status = $2, email_error = $3,
               email_sent_at = CASE WHEN $2 = 'sent' THEN NOW() ELSE NULL END,
               email_message_id = $4`,
        [recipient.shortlistEntryId, failure ? 'failed' : 'sent', failure, messageId]
      );
    }

    if (failure) throw conflict(`The email could not be sent: ${failure}`);

    return {
      package_name: emailPack.packageName,
      to,
      cc,
      recipients: to.length + cc.length,
      recorded: matched.length,
      // Named rather than hidden: an address nobody on the shortlist owns is a perfectly good
      // thing to send to, but it leaves no trace on this ITT's dispatch record.
      not_recorded: notRecorded,
      attachments: encoded.length,
      email_message_id: messageId
    };
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
    const letterContext = await this.letterContextFor(actor, workflowId);
    const explicitReturnDeadline = await this.explicitReturnDeadlineFor(workflowId);

    // One assembly per package, shared across every firm invited to it. getPackageItt is the
    // expensive call in this flow and most packages have several recipients.
    //
    // A package that cannot be assembled — deactivated by a take-off rebuild, missing its
    // configuration — is dropped rather than allowed to abort the send. One broken package
    // out of forty must not stop the other thirty-nine going out, which is the same reason
    // the send loop below isolates per-firm failures.
    const assembled = new Map<string, { emailPack: IttEmailPack; projectName: string }>();
    const unassembled: Array<{ packageName: string; error: string }> = [];
    const returnDeadlineStamps: Array<{ packageName: string; date: string }> = [];
    const requestedPackages = [...new Set(entries.map((e) => e.package_name))];
    for (const name of requestedPackages) {
      try {
        const { emailPack, projectName, returnDeadlineToStamp } =
          await this.assemblePackageForEmail(actor, workflowId, name, bundles, explicitReturnDeadline);
        assembled.set(name, { emailPack, projectName });
        if (returnDeadlineToStamp) returnDeadlineStamps.push({ packageName: name, date: returnDeadlineToStamp });
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

    // Every link across every firm x package on this send, minted and Access-synced
    // BEFORE any email leaves — see mintPortalLinksFor's doc comment.
    const portalRequests: Array<Parameters<typeof this.mintPortalLinksFor>[0][number]> = [];
    for (const [subcontractorId, packages] of byFirm) {
      const contact = contacts.get(subcontractorId);
      const email = this.testEmailOverride?.to ?? (contact?.contact_email ? String(contact.contact_email) : null);
      for (const [packageName, shortlistEntryId] of packages) {
        portalRequests.push({
          shortlistEntryId, workflowId, packageName, subcontractorId,
          tendererName: contact?.name ? String(contact.name) : 'Unknown firm',
          recipientEmail: email, emailPack: assembled.get(packageName)!.emailPack
        });
      }
    }
    const portalStatuses = await this.mintPortalLinksFor(portalRequests);

    // Past everything that could still abort the send, and before the first message leaves.
    // Only packages that assembled are in the list: the letters below carry these dates, so
    // the column has to agree with them even if a particular firm's email then fails —
    // while a package that dropped out is not issued anything, so it is not dated.
    await this.stampTenderReturnDeadlines(workflowId, returnDeadlineStamps);

    let sent = 0, failed = 0, skippedNoEmail = 0;
    const detail: Array<{ subcontractorId: string; packages: string[]; status: string; error?: string }> = [];
    const from = this.testEmailOverride?.from ?? await this.ittFromAddress(actor.organizationId);

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
      const recipient = {
        name: contact?.contact_name ? String(contact.contact_name) : null,
        email,
        address: contact?.contact_address ? String(contact.contact_address) : null
      };
      const portalStatusByPackage: Record<string, IttEmailPortalStatus> = {};
      for (const [packageName, shortlistEntryId] of packages) {
        const status = portalStatuses.get(`${shortlistEntryId}::${packageName}`);
        if (status) portalStatusByPackage[packageName] = status;
      }
      const rendered = renderIttEmail(packs, recipient, { projectName, completeBundleUrl, letterContext, portalStatusByPackage });
      const subject = this.testEmailOverride
        ? `[TEST → ${contact?.contact_name ? String(contact.contact_name) : 'unknown'} <${realEmail ?? 'no email on file'}>] ${rendered.subject}`
        : rendered.subject;

      try {
        if (!this.emailService) throw new Error('EmailService not configured in this environment');
        const attachments = await this.attachmentsFor(actor, packs, projectName, letterContext, recipient);
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
    const letterContext = await this.letterContextFor(actor, workflowId);
    const explicitReturnDeadline = await this.explicitReturnDeadlineFor(workflowId);
    const assembled = await this.assemblePackageForEmail(actor, workflowId, packageName, bundles, explicitReturnDeadline);
    const { emailPack, projectName } = assembled;
    const completeBundleUrl = bundles.find((b) => b.wpCode === null)?.url ?? null;

    const recipients = assembled.recipients;
    const subcontractorIds = recipients.map((r) => String(r.subcontractor_id));
    const contacts = new Map(
      (await this.scms.getContactsForSubcontractors(subcontractorIds))
        .map((c) => [String(c.subcontractor_id), c])
    );

    // Every link for this send, minted and Access-synced BEFORE any email leaves — see
    // mintPortalLinksFor's doc comment for why this is not best-effort like everything
    // else in this method.
    const portalStatuses = await this.mintPortalLinksFor(recipients.map((recipient) => {
      const contact = contacts.get(String(recipient.subcontractor_id));
      const email = this.testEmailOverride?.to ?? (contact?.contact_email ? String(contact.contact_email) : null);
      return {
        shortlistEntryId: String(recipient.shortlist_entry_id), workflowId, packageName,
        subcontractorId: String(recipient.subcontractor_id),
        tendererName: contact?.name ? String(contact.name) : 'Unknown firm',
        recipientEmail: email, emailPack
      };
    }));

    // Past everything that could still abort the send, and before the first message leaves:
    // the letters below carry this date, so the column has to agree with them even if a
    // particular firm's email then fails. Stamping earlier would record a date for a send
    // that never happened, and the next attempt would reuse it — handing the tenderer less
    // time than the period promises.
    if (assembled.returnDeadlineToStamp) {
      await this.stampTenderReturnDeadlines(workflowId, [{ packageName, date: assembled.returnDeadlineToStamp }]);
    }

    let sent = 0, failed = 0, skippedNoEmail = 0;
    const detail: Array<{ subcontractorId: string; status: string; error?: string }> = [];

    const from = this.testEmailOverride?.from ?? await this.ittFromAddress(actor.organizationId);

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

      const recipientInfo = {
        name: contact?.contact_name ? String(contact.contact_name) : null,
        email,
        address: contact?.contact_address ? String(contact.contact_address) : null
      };
      const portalStatus = portalStatuses.get(`${shortlistEntryId}::${packageName}`);
      const rendered = renderIttEmail([emailPack], recipientInfo, {
        projectName, completeBundleUrl, letterContext,
        portalStatusByPackage: portalStatus ? { [packageName]: portalStatus } : undefined
      });
      // Keeps test-inbox messages distinguishable across packages/recipients when every
      // send lands in the same TEST_TO_EMAIL_ACCOUNT.
      const subject = this.testEmailOverride
        ? `[TEST → ${contact?.contact_name ? String(contact.contact_name) : 'unknown'} <${realEmail ?? 'no email on file'}>] ${rendered.subject}`
        : rendered.subject;
      const { html, text } = rendered;
      // The cover letter and forms carry this recipient's own name/address, so —
      // unlike the old scope/BoQ-only pair — attachments are rebuilt per recipient,
      // not hoisted above the loop.
      const attachments = await this.attachmentsFor(actor, [emailPack], projectName, letterContext, recipientInfo);

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
      // A person setting the mark is what 'manual' means, and it is what stops the email
      // classifier ever overwriting it. Confirming a mark the classifier read (the "read from
      // their email, confirm" button) goes through here too, and correctly becomes manual.
      `UPDATE itt_dispatch SET response = $1, responded_at = NOW(), response_source = 'manual',
              response_message_id = NULL, response_confidence = NULL
        WHERE id = $2 RETURNING *`,
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

  // ── Subcontractor pricing portal — the buyer-facing side (an Actor, a workflow) ─────

  /** Every firm this package's ITT went to, with their portal status — the "Open
   * responses" modal's list. */
  async listPortalResponses(actor: Actor, workflowId: string, packageName: string): Promise<Row[]> {
    await this.assertWorkflowAccess(actor, workflowId);
    if (!this.portalDb) return [];
    const links = await this.portalDb.listForPackage(workflowId, packageName);
    const subcontractorIds = [...new Set(links.map((l) => String(l.subcontractor_id)).filter(Boolean))];
    const contacts = new Map(
      (await this.scms.getContactsForSubcontractors(subcontractorIds))
        .map((c) => [String(c.subcontractor_id), c])
    );
    return links.map((l) => ({ ...l, firm_name: contacts.get(String(l.subcontractor_id))?.name ?? l.tenderer_name }));
  }

  /** One firm's priced bill, read-only — what "Open response" in that modal opens. */
  async getPortalResponse(actor: Actor, workflowId: string, linkId: string): Promise<Row> {
    await this.assertWorkflowAccess(actor, workflowId);
    if (!this.portalDb) throw notFound('The subcontractor pricing portal is not configured in this environment.');
    const link = await this.portalDb.getById(linkId);
    if (!link || String(link.workflow_id) !== workflowId) throw notFound('Pricing portal link not found');
    const lines = await this.portalDb.getLines(linkId);
    return { ...link, lines };
  }

  /**
   * A buyer reopens a submitted return for the tenderer to revise — a decision, so it is
   * recorded (`reopened_at`/`reopened_by`) rather than silently clearing `submitted_at`.
   * The prior submission's `tender_returns` row is left as-is; a fresh submit overwrites
   * it via the same ON CONFLICT `PricingPortalDatabase.submit` already uses.
   */
  async reopenPortalResponse(actor: Actor, workflowId: string, linkId: string): Promise<Row> {
    await this.assertWorkflowAccess(actor, workflowId);
    if (!this.portalDb) throw notFound('The subcontractor pricing portal is not configured in this environment.');
    const link = await this.portalDb.getById(linkId);
    if (!link || String(link.workflow_id) !== workflowId) throw notFound('Pricing portal link not found');
    if (!link.submitted_at) throw conflict('This return has not been submitted, so there is nothing to reopen.');
    await this.portalDb.reopen(linkId, actor.userId);
    return this.getPortalResponse(actor, workflowId, linkId);
  }

  // ── Subcontractor pricing portal — the public-facing side (a token, no Actor) ───────

  /**
   * Resolves a portal token to its link row, binding the caller's VERIFIED Cloudflare
   * Access identity to the recipient the link was issued to. THE TOKEN says WHICH
   * dispatch; THIS BINDING says WHO is allowed to see it — neither alone is enough, and
   * this is what stops one invited firm opening another's rates once both satisfy the
   * same Access policy.
   *
   * `accessEmail` is null only when PORTAL_ACCESS_REQUIRED=false (local development with
   * no Cloudflare Access in front of anything, forbidden in production by `loadConfig`)
   * — the binding check is skipped and the token is trusted alone, matching the warning
   * `accessJwt.ts` already logs for that case.
   *
   * A same-domain match is accepted alongside an exact address match — a colleague at the
   * same firm picking up the tender from the named estimator is an ordinary event, not a
   * breach — but public/free domains never qualify for it: two people at gmail.com are
   * unrelated strangers. In the approved design no link is ever minted for a public-domain
   * recipient in the first place (see mintPortalLinksFor), so this is belt-and-braces
   * against a link somehow existing for one anyway.
   */
  private async resolvePortalToken(token: string, accessEmail: string | null): Promise<Row> {
    if (!this.portalDb) throw notFound('Online pricing is not available.');
    const link = await this.portalDb.getByToken(token);
    if (!link) throw notFound('This link has expired or is no longer valid.');
    if (accessEmail) {
      const linkEmail = String(link.recipient_email).toLowerCase();
      const linkDomain = String(link.recipient_domain).toLowerCase();
      const matches = accessEmail === linkEmail
        || (!isPublicEmailDomain(linkDomain) && domainOf(accessEmail) === linkDomain);
      if (!matches) {
        await this.portalDb.recordDenial(String(link.id), accessEmail);
        throw forbidden('This link was not issued to your address. If you believe this is a mistake, ask whoever sent it to resend it to you directly.');
      }
    }
    await this.portalDb.recordOpen(String(link.id), accessEmail);
    return link;
  }

  async getPortalPackage(token: string, accessEmail: string | null): Promise<Row> {
    const link = await this.resolvePortalToken(token, accessEmail);
    const lines = await this.portalDb!.getLines(String(link.id));
    // Both sides of the precedence, for THIS link's own package — pricing_portal_links
    // carries package_name, so the join is exact.
    const [deadline] = await this.db.query<Row>(
      `SELECT ild.tender_return_deadline AS explicit_deadline,
              sl.tender_return_deadline  AS issued_deadline
         FROM workflows w
         LEFT JOIN itt_letter_details ild ON ild.workflow_id = w.id
         LEFT JOIN shortlists sl ON sl.workflow_id = w.id AND sl.package_name = $2
        WHERE w.id = $1`,
      [link.workflow_id, link.package_name]
    );
    // No `asOf`: a portal link exists only after a send, so the date was stamped then.
    // Deriving here instead would slide the deadline forward every day the tenderer opened
    // the page. Formatted, never raw — see getTenderLaunchTable for why.
    const resolved = this.resolveReturnDeadline(
      { tender_return_deadline: deadline?.issued_deadline }, deadline?.explicit_deadline
    );
    return { ...link, lines, tender_return_deadline: resolved.display };
  }

  async savePortalDraft(token: string, accessEmail: string | null, input: {
    header: { programmeWeeks: number | null; qualifications: string | null; exclusions: string | null };
    lines: PortalLineDraftInput[];
  }): Promise<Row> {
    const link = await this.resolvePortalToken(token, accessEmail);
    if (link.submitted_at) throw conflict('This return has already been submitted and can no longer be edited.');
    await this.portalDb!.saveDraft(String(link.id), input);
    return this.getPortalPackage(token, accessEmail);
  }

  async submitPortalResponse(token: string, accessEmail: string | null): Promise<Row> {
    const link = await this.resolvePortalToken(token, accessEmail);
    if (link.submitted_at) throw conflict('This return has already been submitted.');
    await this.portalDb!.submit(String(link.id));
    return this.getPortalPackage(token, accessEmail);
  }

  async addPortalLine(token: string, accessEmail: string | null, input: {
    description: string; quantity: number | null; unit: string | null;
  }): Promise<Row> {
    const link = await this.resolvePortalToken(token, accessEmail);
    if (link.submitted_at) throw conflict('This return has already been submitted and can no longer be edited.');
    await this.portalDb!.addLine(String(link.id), input);
    return this.getPortalPackage(token, accessEmail);
  }

  async deletePortalLine(token: string, accessEmail: string | null, lineId: string): Promise<Row> {
    const link = await this.resolvePortalToken(token, accessEmail);
    if (link.submitted_at) throw conflict('This return has already been submitted and can no longer be edited.');
    await this.portalDb!.deleteLine(String(link.id), lineId);
    return this.getPortalPackage(token, accessEmail);
  }

  // ── Subcontractor queries (RFIs) ──────────────────────────────────────────
  //
  // BuildFlow issue #34. The store is the `comms` schema and lives behind commsDb;
  // everything about WHO may read or write is decided here, exactly as it is for the
  // pricing portal above.

  /**
   * The address this organisation sends ITTs from.
   *
   * Read unqualified-except-for-`public` from BuildFlow's own configuration table, so a
   * change on their Configuration page takes effect on the next send with no deploy and
   * no second copy. Falls back to the literal every ITT used before it was configurable —
   * an organisation that has never opened that page must keep sending exactly as it did.
   */
  private async ittFromAddress(organizationId: string): Promise<string> {
    const [row] = await this.db.query<Row>(
      `SELECT itt_from_address FROM public.itt_comms_config
        WHERE organization_id = $1 AND tender_id IS NULL`,
      [organizationId]
    );
    return row?.itt_from_address ? String(row.itt_from_address) : ITT_FROM_ADDRESS;
  }

  /**
   * The project a workflow belongs to, for naming it in an email.
   *
   * Read off `workflows.step_data.takeoff`, where the launch message was stashed whole —
   * `IttEmailLetterContext` does not carry it, and re-deriving it from BuildFlow would be
   * an HTTP call for a string this row already holds. Null is fine: the emails say "the
   * project" rather than refusing to send.
   */
  private async projectNameForWorkflow(workflowId: string): Promise<string | null> {
    const [row] = await this.db.query<Row>(
      `SELECT step_data -> 'takeoff' ->> 'projectName' AS project_name FROM workflows WHERE id = $1`,
      [workflowId]
    );
    return row?.project_name != null ? String(row.project_name) : null;
  }

  /**
   * Where a notification about this conversation should send its reader.
   *
   * Stored on the notification at write time, so it says where the event MEANT rather
   * than where that tender has got to by the time anyone clicks.
   *
   * A thread attributed to a tender opens that tender's Communications modal, on the firm
   * in question — which is the ITT Dispatch step, exactly as the issue asks. A thread
   * with no workflow has no such page: nobody could work out which tender it belongs to,
   * so it opens the cross-tender timeline instead, which is the only place an untriaged
   * conversation is reachable at all.
   */
  private async commsDeepLink(workflowId: string | null, threadId: string): Promise<string> {
    if (workflowId) {
      const [row] = await this.db.query<Row>(
        `SELECT package_id FROM workflows WHERE id = $1`, [workflowId]
      );
      if (row?.package_id) {
        return `/packages/${String(row.package_id)}/tender-prep?thread=${threadId}`;
      }
    }
    return `/communications?thread=${threadId}`;
  }

  /** The organisation a workflow belongs to. Needed because `comms` carries no
   *  cross-schema foreign keys, so it stores the id rather than joining for it. */
  private async organizationForWorkflow(workflowId: string): Promise<string> {
    const [row] = await this.db.query<Row>(`SELECT organization_id FROM workflows WHERE id = $1`, [workflowId]);
    if (!row) throw notFound('This tender no longer exists.');
    return String(row.organization_id);
  }

  /**
   * A subcontractor raising a query from their own pricing-portal link.
   *
   * The THREAD is keyed on the firm — the portal link's recipient — while the MESSAGE
   * records whoever actually typed it. That distinction is the point of the form asking
   * for a name and email at all: the person raising a query is routinely a colleague of
   * the estimator the ITT was addressed to, and filing their query under their own
   * address would give one firm several unrelated conversations.
   *
   * The package IS known here, because the link is per (package x firm), so the message
   * carries `shortlist_entry_id` and the form needs no package selector.
   *
   * Attachments are stored BEFORE the message is recorded, and a storage failure aborts
   * the whole thing. The other order would leave a row promising a file that does not
   * exist, which nobody could diagnose months later.
   */
  async raisePortalRfi(token: string, accessEmail: string | null, input: {
    authorName: string; authorEmail: string; subject: string | null; body: string;
    attachments: Array<{ filename: string; content: Uint8Array<ArrayBuffer> }>;
  }): Promise<{ thread: Row; messages: Row[] }> {
    if (!this.commsDb) throw notFound('Queries are not available for this tender.');
    const link = await this.resolvePortalToken(token, accessEmail);
    const workflowId = String(link.workflow_id);
    const organizationId = await this.organizationForWorkflow(workflowId);

    const stored = await this.storeCommsAttachments(organizationId, input.attachments);

    const thread = await this.commsDb.findOrCreateThread({
      organizationId,
      workflowId,
      counterpartyKind: 'subcontractor',
      counterpartyEmail: String(link.recipient_email),
      counterpartyName: link.tenderer_name != null ? String(link.tenderer_name) : null,
      subcontractorId: link.subcontractor_id != null ? String(link.subcontractor_id) : null,
      subject: input.subject
    });

    await this.commsDb.recordMessage({
      threadId: String(thread.id),
      organizationId,
      workflowId,
      shortlistEntryId: String(link.shortlist_entry_id),
      direction: 'inbound',
      channel: 'portal',
      kind: 'subcontractor_rfi',
      authorName: input.authorName,
      authorEmail: input.authorEmail,
      subject: input.subject,
      bodyText: input.body,
      attachments: stored,
      // The firm is the thread's counterparty; the person is whoever filled the form in.
      // Both are named, because "Acme Drylining" is what a buyer recognises and
      // "Sam Patel" is who they reply to.
      notify: {
        kind: 'subcontractor_rfi',
        title: `${thread.counterparty_name ?? thread.counterparty_email} raised a query`,
        body: input.subject ?? firstLine(input.body),
        deepLinkPath: await this.commsDeepLink(workflowId, String(thread.id)),
        subcontractorId: link.subcontractor_id != null ? String(link.subcontractor_id) : null
      }
    });

    return this.commsDb.getThread(String(thread.id));
  }

  /** What a subcontractor sees of their own conversation — one thread, never a list, and
   *  only the one their link belongs to. */
  async getPortalThread(token: string, accessEmail: string | null): Promise<{ thread: Row; messages: Row[] } | null> {
    if (!this.commsDb) return null;
    const link = await this.resolvePortalToken(token, accessEmail);
    const thread = await this.commsDb.threadForCounterparty({
      workflowId: String(link.workflow_id),
      counterpartyKind: 'subcontractor',
      counterpartyEmail: String(link.recipient_email)
    });
    if (!thread) return null;
    return this.commsDb.getThread(String(thread.id));
  }

  /** Every query raised on this tender, across firms — the list the forward selects from. */
  async listCommsQueries(actor: Actor, workflowId: string): Promise<Row[]> {
    if (!this.commsDb) return [];
    await this.assertWorkflowAccess(actor, workflowId);
    return this.commsDb.listQueriesForWorkflow(workflowId);
  }

  /** Client answers on this tender, and whether each has been passed back yet. */
  async listClientAnswers(actor: Actor, workflowId: string): Promise<Row[]> {
    if (!this.commsDb) return [];
    await this.assertWorkflowAccess(actor, workflowId);
    return this.commsDb.listClientAnswersForWorkflow(workflowId);
  }

  /** Every conversation on one tender, for the Communications modal on ITT Dispatch. */
  async listCommsThreads(actor: Actor, workflowId: string): Promise<Row[]> {
    if (!this.commsDb) return [];
    await this.assertWorkflowAccess(actor, workflowId);
    return this.commsDb.listThreadsForWorkflow(workflowId);
  }

  /**
   * One conversation in full.
   *
   * Authorised through the thread's WORKFLOW where it has one, so this inherits exactly
   * the same rule as every other read on this tender. A thread with no workflow is an
   * untriaged inbound message that could not be attributed to a tender at all; there is
   * no workflow to check, so it falls back to the organisation — which is the only
   * boundary such a message actually has.
   */
  async getCommsThread(actor: Actor, threadId: string): Promise<{ thread: Row; messages: Row[] }> {
    if (!this.commsDb) throw notFound('Queries are not available.');
    const result = await this.commsDb.getThread(threadId);
    if (result.thread.workflow_id) {
      await this.assertWorkflowAccess(actor, String(result.thread.workflow_id));
    } else if (String(result.thread.organization_id) !== actor.organizationId) {
      throw notFound('This conversation no longer exists.');
    }
    return result;
  }

  // ── Notifications, and the cross-tender timeline ──────────────────────────

  /**
   * What the bell shows: this organisation's communications events, newest first, each
   * carrying whether THIS reader has seen it.
   *
   * Scoped by the actor's own organisation and never by a parameter — a notification list
   * is the one read where "show me another organisation's" has no legitimate caller, and
   * every id it hands out is a thread somebody can then open.
   *
   * Degrades to an empty list rather than throwing when comms is not configured, exactly
   * as `listCommsThreads` does: a shell that renders a bell on every page must not be able
   * to break every page.
   */
  async listNotifications(actor: Actor, options: { limit?: number; unreadOnly?: boolean } = {}): Promise<Row> {
    if (!this.commsDb) return { items: [], unread: 0 };
    const [items, unread] = await Promise.all([
      this.commsDb.listNotifications({
        organizationId: actor.organizationId, userId: actor.userId,
        limit: options.limit, unreadOnly: options.unreadOnly
      }),
      this.commsDb.unreadNotificationCount(actor.organizationId, actor.userId)
    ]);
    return { items, unread };
  }

  /** Marks notifications read for this reader. An empty list means everything — which is
   *  what "mark all as read" sends, rather than the client enumerating 200 ids. */
  async markNotificationsRead(actor: Actor, notificationIds: string[]): Promise<Row> {
    if (!this.commsDb) return { marked: 0, unread: 0 };
    const marked = await this.commsDb.markNotificationsRead({
      organizationId: actor.organizationId, userId: actor.userId,
      notificationIds: notificationIds.length > 0 ? notificationIds : null
    });
    return { marked, unread: await this.commsDb.unreadNotificationCount(actor.organizationId, actor.userId) };
  }

  /**
   * Every conversation this organisation has, across every tender — the timeline behind
   * the bell, and the only view in which "filter by tender" is a question with more than
   * one answer.
   *
   * The tender name is resolved HERE rather than in `comms`, which holds no cross-schema
   * foreign keys by design. A thread whose workflow has since been deleted keeps its id
   * and reads as an unknown tender rather than vanishing: the conversation happened.
   */
  async commsTimeline(actor: Actor): Promise<Row> {
    if (!this.commsDb) return { threads: [], tenders: [] };
    const threads = await this.commsDb.listThreadsForOrganisation(actor.organizationId);
    const workflowIds = [...new Set(threads
      .map((thread) => (thread.workflow_id != null ? String(thread.workflow_id) : null))
      .filter((id): id is string => id != null))];
    const workflows = workflowIds.length === 0 ? [] : await this.db.query<Row>(
      // Package name first, project name second: the rest of this app labels a workflow
      // by its package (PackagesListPage, the dashboard picker), and the project is what
      // a workflow started before the take-off landed has instead. Either is a name
      // somebody recognises; the id is not, so it is the last resort and lives in the UI.
      `SELECT id::text AS id, package_id::text AS package_id,
              COALESCE(step_data -> 'takeoff' ->> 'packageName',
                       step_data -> 'takeoff' ->> 'projectName') AS package_name
         FROM workflows WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
      [workflowIds, actor.organizationId]
    );
    const byId = new Map(workflows.map((row) => [String(row.id), row]));
    return {
      threads: threads.map((thread) => {
        const workflow = thread.workflow_id != null ? byId.get(String(thread.workflow_id)) : undefined;
        return {
          ...thread,
          package_id: workflow?.package_id ?? null,
          tender_name: workflow?.package_name ?? null
        };
      }),
      // The filter's options, derived from the threads that exist rather than from every
      // tender: a filter offering fifty tenders with no conversation on them is a list to
      // scroll past, not a filter.
      tenders: [...byId.values()].map((workflow) => ({
        workflow_id: workflow.id, package_id: workflow.package_id, name: workflow.package_name
      }))
    };
  }

  // ── The Client's own reply page ───────────────────────────────────────────

  /**
   * Resolves a Client's reply token to its link, binding it to a verified identity.
   *
   * A structural copy of `resolvePortalToken`, and deliberately so: it is the same problem
   * with a different counterparty. The URL token says WHICH forward; the verified Access
   * email says WHO is asking; both have to agree. A same-domain match is accepted because
   * a colleague answering on the Client's behalf is an ordinary event, but never for a
   * public domain, where two addresses are unrelated strangers.
   */
  private async resolveClientToken(token: string, accessEmail: string | null): Promise<Row> {
    if (!this.commsDb) throw notFound('This link is no longer valid.');
    const link = await this.commsDb.clientLinkByToken(token);
    if (!link) throw notFound('This link has expired or is no longer valid.');
    if (accessEmail) {
      const linkEmail = String(link.recipient_email).toLowerCase();
      const linkDomain = String(link.recipient_domain).toLowerCase();
      const matches = accessEmail === linkEmail
        || (!isPublicEmailDomain(linkDomain) && domainOf(accessEmail) === linkDomain);
      if (!matches) {
        await this.commsDb.recordClientDenial(String(link.id), accessEmail);
        throw forbidden('This link was not issued to your address. If you believe this is a mistake, ask whoever sent it to resend it to you directly.');
      }
    }
    await this.commsDb.recordClientOpen(String(link.id), accessEmail);
    return link;
  }

  /** What the Client sees: the queries this forward put to them, and anything already
   *  said. Never the rest of the tender. */
  async getClientReplyPage(token: string, accessEmail: string | null): Promise<Row> {
    const link = await this.resolveClientToken(token, accessEmail);
    const queries = await this.commsDb!.forwardedQueries(String(link.forward_message_id));
    const { messages } = await this.commsDb!.getThread(String(link.thread_id));
    const projectName = link.workflow_id != null
      ? await this.projectNameForWorkflow(String(link.workflow_id)) : null;
    return {
      project_name: projectName,
      recipient_email: link.recipient_email,
      // The firm is deliberately NOT named to the Client. They are answering a question
      // about the works; which subcontractor asked is commercially theirs, not the
      // Client's, and naming it would leak the shortlist.
      queries: queries.map((query) => ({
        id: query.id,
        subject: query.subject,
        body_text: query.body_text,
        raised_at: query.occurred_at
      })),
      messages: messages.filter((message) => message.kind !== 'subcontractor_rfi')
    };
  }

  /** The Client answering in the app rather than by email. Recorded exactly as an emailed
   *  answer would be, so the relay downstream cannot tell them apart. */
  async submitClientReply(token: string, accessEmail: string | null, input: {
    body: string;
  }): Promise<Row> {
    const link = await this.resolveClientToken(token, accessEmail);
    const message = await this.commsDb!.recordMessage({
      threadId: String(link.thread_id),
      organizationId: String(link.organization_id),
      workflowId: link.workflow_id != null ? String(link.workflow_id) : null,
      shortlistEntryId: null,
      direction: 'inbound', channel: 'portal', kind: 'client_reply',
      authorName: null, authorEmail: accessEmail ?? String(link.recipient_email),
      subject: null, bodyText: input.body,
      inReplyToMessageId: String(link.forward_message_id),
      // In-app, so the identity is the Access one rather than anything a mail header
      // claimed. Recorded as such so a reviewer can tell the two apart later.
      attributionMethod: 'reply_token',
      notify: {
        kind: 'client_reply',
        title: 'The client answered your queries',
        body: firstLine(input.body),
        deepLinkPath: await this.commsDeepLink(
          link.workflow_id != null ? String(link.workflow_id) : null, String(link.thread_id))
      }
    });
    await this.commsDb!.setThreadStatus(String(link.thread_id), 'answered');
    return { recorded: message != null };
  }

  // ── Inbound email ─────────────────────────────────────────────────────────

  /**
   * Files a message the Cloudflare Email Worker forwarded here.
   *
   * Attribution is tried in a fixed order, strongest first, and the route that answered is
   * recorded on the message so a misrouting is diagnosable rather than mysterious:
   *
   *   1. a reply token (plus-address, then subject marker) -> the Client's own forward;
   *   2. In-Reply-To / References against a message we actually sent;
   *   3. the ITT comms address -> the organisation, then the sender -> a portal recipient.
   *
   * A message that matches none of these is still FILED, in an untriaged thread. Dropping
   * a customer's email because we could not work out who they were is never the right
   * answer — and `workflow_id IS NULL` is exactly what makes it findable later.
   *
   * Returns `duplicate` rather than throwing when the message has been seen: an Email
   * Worker delivers at least once by design, so that is normal traffic.
   */
  async ingestInboundEmail(payload: InboundEmail, idempotencyKey: string): Promise<Row> {
    if (!this.commsDb) throw notFound('Inbound email is not available.');
    const verified = isVerified(payload);
    const sender = payload.from.address.trim().toLowerCase();

    const resolved = await this.resolveInbound(payload, verified);
    const occurredAt = payload.date ? new Date(payload.date) : null;

    const stored = await this.storeInboundAttachments(resolved.organizationId, payload);

    const message = await this.commsDb.recordMessage({
      threadId: resolved.threadId,
      organizationId: resolved.organizationId,
      workflowId: resolved.workflowId,
      shortlistEntryId: resolved.shortlistEntryId,
      direction: 'inbound', channel: 'email', kind: resolved.kind,
      authorName: payload.from.name ?? null,
      authorEmail: sender,
      subject: payload.subject ?? null,
      bodyText: payload.textBody ?? null,
      occurredAt: occurredAt && !Number.isNaN(occurredAt.getTime()) ? occurredAt : null,
      idempotencyKey,
      attributionMethod: resolved.method,
      dkimResult: payload.auth.dkim ?? null,
      spfResult: payload.auth.spf ?? null,
      dmarcResult: payload.auth.dmarc ?? null,
      externalMessageId: payload.messageId ?? null,
      externalInReplyTo: payload.headers.inReplyTo ?? null,
      externalReferences: payload.headers.references,
      inReplyToMessageId: resolved.inReplyToMessageId,
      rawObjectKey: stored.rawObjectKey,
      attachmentsTruncated: payload.attachmentsTruncated,
      attachments: stored.attachments,
      // A message nobody could attribute gets its OWN notification kind rather than
      // being announced as a query on a tender it was never placed on. It is the one
      // most worth a human's attention and the one a buyer is least likely to find by
      // looking — the bell is the only route to it.
      notify: resolved.workflowId == null
        ? {
            kind: 'unattributed_email',
            title: `Unattributed email from ${payload.from.name ?? sender}`,
            body: payload.subject ?? firstLine(payload.textBody ?? null),
            deepLinkPath: await this.commsDeepLink(null, resolved.threadId)
          }
        : {
            kind: resolved.kind === 'client_reply' ? 'client_reply' : 'subcontractor_rfi',
            title: resolved.kind === 'client_reply'
              ? 'The client answered your queries'
              : `${payload.from.name ?? sender} raised a query`,
            body: payload.subject ?? firstLine(payload.textBody ?? null),
            deepLinkPath: await this.commsDeepLink(resolved.workflowId, resolved.threadId)
          }
    });

    if (!message) return { status: 'duplicate', thread_id: resolved.threadId, attributed: resolved.workflowId != null };
    if (resolved.kind === 'client_reply') await this.commsDb.setThreadStatus(resolved.threadId, 'answered');

    return {
      status: 'recorded',
      message_id: message.id,
      thread_id: resolved.threadId,
      attributed: resolved.workflowId != null,
      attribution_method: resolved.method
    };
  }

  /** Which thread an inbound message belongs to, and how we decided. */
  private async resolveInbound(payload: InboundEmail, verified: boolean): Promise<{
    organizationId: string; workflowId: string | null; threadId: string;
    shortlistEntryId: string | null; kind: 'subcontractor_rfi' | 'client_reply';
    method: AttributionMethod | null; inReplyToMessageId: string | null;
  }> {
    const commsDb = this.commsDb!;
    const sender = payload.from.address.trim().toLowerCase();

    // 1. A reply token. Strongest, and the only route that identifies a Client answer
    //    outright — but ONLY on a DKIM-verified message: the whole value of a token is
    //    that it is unguessable, and a forged message quoting one back is not evidence.
    const tokenMatch = findReplyToken(payload);
    if (tokenMatch && verified) {
      const link = await commsDb.clientLinkByToken(tokenMatch.token);
      if (link) {
        return {
          organizationId: String(link.organization_id),
          workflowId: link.workflow_id != null ? String(link.workflow_id) : null,
          threadId: String(link.thread_id), shortlistEntryId: null, kind: 'client_reply',
          method: tokenMatch.method, inReplyToMessageId: String(link.forward_message_id)
        };
      }
    }

    // 2. What it says it answers, matched against what we actually sent.
    if (verified) {
      const answered = await commsDb.messageByExternalIds(referencedMessageIds(payload));
      if (answered) {
        return {
          organizationId: String(answered.organization_id),
          workflowId: answered.workflow_id != null ? String(answered.workflow_id) : null,
          threadId: String(answered.thread_id),
          shortlistEntryId: answered.shortlist_entry_id != null ? String(answered.shortlist_entry_id) : null,
          kind: answered.kind === 'client_forward' ? 'client_reply' : 'subcontractor_rfi',
          method: 'in_reply_to',
          inReplyToMessageId: String(answered.id)
        };
      }
    }

    // 3. The address it arrived on names the organisation; the sender names the firm.
    const organizationId = await this.organizationForInboundAddress(payload.recipient);
    if (!organizationId) {
      throw new AppError(
        422,
        `No organisation is configured to receive mail at ${payload.recipient}.`,
        'UNKNOWN_RECIPIENT'
      );
    }

    const firm = await this.portalRecipientFor(organizationId, sender);
    const thread = await commsDb.findOrCreateThread({
      organizationId,
      workflowId: firm?.workflowId ?? null,
      counterpartyKind: 'subcontractor',
      counterpartyEmail: sender,
      counterpartyName: payload.from.name ?? firm?.tendererName ?? null,
      subcontractorId: firm?.subcontractorId ?? null,
      subject: payload.subject ?? null
    });
    return {
      organizationId, workflowId: firm?.workflowId ?? null, threadId: String(thread.id),
      shortlistEntryId: firm?.shortlistEntryId ?? null, kind: 'subcontractor_rfi',
      method: firm?.method ?? null, inReplyToMessageId: null
    };
  }

  /** The organisation that receives mail at this address. Matched on the ITT comms
   *  address, which is per-organisation; the Client reply address is shared, so a message
   *  arriving there is attributed by its token rather than by the mailbox. */
  private async organizationForInboundAddress(recipient: string): Promise<string | null> {
    const address = recipient.trim().toLowerCase();
    // Strips any plus-suffix, so `<org>-ittcomms+anything@` still resolves.
    const [local, domain] = address.split('@');
    const bare = domain ? `${local.split('+')[0]}@${domain}` : address;
    const [row] = await this.db.query<Row>(
      `SELECT organization_id FROM public.itt_comms_config
        WHERE LOWER(itt_comms_address) = $1 AND tender_id IS NULL
        LIMIT 1`,
      [bare]
    );
    return row?.organization_id != null ? String(row.organization_id) : null;
  }

  /**
   * The firm behind a sender address, from the portal links already issued.
   *
   * Exact address first, then a non-public domain. Never a public domain: two people at
   * gmail.com are unrelated strangers, and filing one's query under the other's tender is
   * both wrong and a disclosure. Most recently dispatched wins where a firm is live on
   * several tenders — and that ambiguity is real, which is why the method is recorded.
   */
  private async portalRecipientFor(organizationId: string, sender: string): Promise<{
    workflowId: string; shortlistEntryId: string; subcontractorId: string | null;
    tendererName: string | null; method: AttributionMethod;
  } | null> {
    const domain = domainOf(sender);
    const [row] = await this.db.query<Row>(
      `SELECT l.workflow_id, l.shortlist_entry_id, l.subcontractor_id, l.tenderer_name,
              (LOWER(l.recipient_email) = $2) AS exact
         FROM pricing_portal_links l
         JOIN workflows w ON w.id = l.workflow_id
        WHERE w.organization_id = $1
          AND (LOWER(l.recipient_email) = $2 OR ($3 <> '' AND LOWER(l.recipient_domain) = $3))
        ORDER BY exact DESC, l.created_at DESC
        LIMIT 1`,
      [organizationId, sender, isPublicEmailDomain(domain) ? '' : domain]
    );
    if (!row) return null;
    return {
      workflowId: String(row.workflow_id),
      shortlistEntryId: String(row.shortlist_entry_id),
      subcontractorId: row.subcontractor_id != null ? String(row.subcontractor_id) : null,
      tendererName: row.tenderer_name != null ? String(row.tenderer_name) : null,
      method: row.exact === true ? 'sender_email' : 'sender_domain'
    };
  }

  /**
   * Puts an inbound message's files, and the raw .eml, into BuildFlow's object store.
   *
   * Lenient where the portal path is strict, and the difference is deliberate: a portal
   * query can be refused and retyped, while an email has already been sent and there is
   * nobody to tell. So a file that will not store is dropped with the message marked
   * truncated rather than losing the message with it. The archival .eml is best-effort
   * for the same reason.
   */
  private async storeInboundAttachments(organizationId: string, payload: InboundEmail): Promise<{
    attachments: CommsAttachmentInput[]; rawObjectKey: string | null;
  }> {
    if (!this.commsAttachments) return { attachments: [], rawObjectKey: null };
    const attachments: CommsAttachmentInput[] = [];
    for (const attachment of payload.attachments) {
      const id = randomUUID();
      try {
        const result = await this.commsAttachments.store({
          organizationId, attachmentId: id, filename: attachment.filename,
          content: Uint8Array.from(Buffer.from(attachment.contentBase64, 'base64'))
        });
        attachments.push({
          id, filename: attachment.filename, contentType: result.contentType,
          byteSize: result.byteSize, sha256: result.sha256, objectKey: result.objectKey,
          shareUrl: result.url, shareToken: result.token, shareExpiresAt: result.expiresAt
        });
      } catch {
        // Swallowed on purpose — see the doc comment. The message still lands.
      }
    }
    let rawObjectKey: string | null = null;
    if (payload.rawBase64) {
      try {
        const result = await this.commsAttachments.store({
          organizationId, attachmentId: randomUUID(), filename: 'message.eml',
          content: Uint8Array.from(Buffer.from(payload.rawBase64, 'base64'))
        });
        rawObjectKey = result.objectKey;
      } catch {
        // The archive is a convenience; the message is the record.
      }
    }
    return { attachments, rawObjectKey };
  }

  // ── Forwarding queries to the Client, and relaying the answer back ────────

  /**
   * Everything about putting something to the Client EXCEPT deciding what — extracted
   * from `forwardQueriesToClient` (issue #48) so a second caller (`forwardRfiQuestionsToClient`,
   * putting individual RFI QUESTIONS to the Client rather than whole messages) can reuse
   * the ordering rules rather than restate them. Every one of those rules is load-bearing:
   * the message is recorded BEFORE the send; the Access include list is reconciled BEFORE
   * the send (the same rule `confirmAndSendItt` follows — a Client link minted after the
   * email has gone is refused at the edge with no signal anywhere in this application);
   * the notification is written AFTER, because whether it sent is not knowable inside the
   * transaction that recorded it.
   *
   * `input.recordItems` is the one thing that differs between callers: what ledger, at
   * what grain, records what this forward carried. It runs BEFORE the send, in the same
   * place `recordForwardItems` always has.
   */
  private async sendClientForward(actor: Actor, workflowId: string, input: {
    items: ForwardedQuery[];
    recordItems: (forwardMessageId: string) => Promise<void>;
    clientEmail: string; clientName: string | null; note: string | null;
  }): Promise<Row> {
    if (!this.commsDb) throw notFound('Queries are not available for this tender.');

    const organizationId = await this.organizationForWorkflow(workflowId);
    const config = await this.commsConfig(organizationId);
    const context = await this.letterContextFor(actor, workflowId).catch(() => null);
    const projectName = await this.projectNameForWorkflow(workflowId);

    const thread = await this.commsDb.findOrCreateThread({
      organizationId, workflowId, counterpartyKind: 'client',
      counterpartyEmail: input.clientEmail, counterpartyName: input.clientName,
      subcontractorId: null, subject: null
    });

    const forward = await this.commsDb.recordMessage({
      threadId: String(thread.id), organizationId, workflowId, shortlistEntryId: null,
      direction: 'outbound', channel: 'email', kind: 'client_forward',
      authorName: context?.estimatorName ?? actor.email ?? null,
      authorEmail: context?.estimatorEmail ?? actor.email ?? null,
      subject: null, bodyText: input.note,
      createdBy: actor.userId
    });
    if (!forward) throw conflict('That forward has already been sent.');
    await input.recordItems(String(forward.id));

    // A public/free domain never gets a link, the same rule mintPortalLinksFor applies to
    // a subcontractor: a domain-wide Access include for gmail.com would admit strangers.
    const domain = domainOf(input.clientEmail);
    const blockedReason = !this.accessAdmin ? 'access_unconfigured'
      : isPublicEmailDomain(domain) ? 'public_email_domain'
      : null;
    const link = await this.commsDb.mintClientReplyLink({
      forwardMessageId: String(forward.id), threadId: String(thread.id), organizationId,
      workflowId, recipientEmail: input.clientEmail,
      ttlDays: this.clientLinkTtlDays, blockedReason
    });

    // The reply token is the forward's own id when no link could be issued — the subject
    // marker and the plus-address still work, so an emailed answer finds its way home even
    // where the in-app route is closed.
    const replyToken = link.token != null ? String(link.token) : String(forward.id);
    const replyUrl = link.token != null && this.portalBaseUrl
      ? `${this.portalBaseUrl.replace(/\/$/, '')}/client/${link.token}`
      : null;

    if (this.accessAdmin && link.token != null) {
      // Unioned at the CALL SITE rather than inside either method, so each stays honest
      // about its own table. Miss this and the link 403s at the edge, silently.
      const recipients = [
        ...(this.portalDb ? await this.portalDb.liveRecipients() : []),
        ...await this.commsDb.liveClientRecipients()
      ];
      await this.accessAdmin.syncFor(recipients).catch(() => undefined);
    }

    const email = renderRfiForwardEmail(input.items, {
      projectName,
      tenderReference: null,
      estimatorName: context?.estimatorName ?? null,
      estimatorEmail: context?.estimatorEmail ?? null,
      organizationName: context?.organizationName ?? null,
      replyToken, replyUrl
    });

    const sent = await this.sendCommsEmail({
      organizationId,
      to: this.testEmailOverride?.to ?? input.clientEmail,
      replyTo: replyAddressFor(config.clientReplyAddress, replyToken),
      email
    });
    await this.commsDb.setExternalMessageId(String(forward.id), sent.externalMessageId);
    await this.commsDb.setThreadStatus(String(thread.id), 'awaiting_client');

    // A forward that did not send is the one failure here nobody sees. The caller is
    // told in its response, but that response is gone the moment the page is closed,
    // while the thread now says "awaiting client" of an employer who was never asked.
    // Raised AFTER the send rather than with the message, because whether it sent is not
    // knowable inside the transaction that recorded it.
    if (!sent.ok) {
      await this.commsDb.recordNotification({
        kind: 'forward_failed',
        organizationId,
        workflowId,
        threadId: String(thread.id),
        messageId: String(forward.id),
        title: `Queries to ${input.clientEmail} did not send`,
        body: sent.error ?? 'The email was recorded but the provider rejected it.',
        deepLinkPath: await this.commsDeepLink(workflowId, String(thread.id))
      });
    }

    return {
      forward_message_id: forward.id, thread_id: thread.id,
      forwarded: input.items.length, sent: sent.ok, error: sent.error,
      link_blocked_reason: link.blocked_reason, reply_url: replyUrl
    };
  }

  /**
   * Several subcontractor queries put to the Client as ONE message.
   *
   * One message rather than one per query, because that is what the issue asks for and
   * what a Client can actually answer: six separate emails get one reply between them and
   * nobody can tell which question it covered. `comms.forward_items` records which queries
   * this forward carried, which is what later answers exactly that.
   */
  async forwardQueriesToClient(actor: Actor, workflowId: string, input: {
    messageIds: string[]; clientEmail: string; clientName: string | null; note: string | null;
  }): Promise<Row> {
    if (!this.commsDb) throw notFound('Queries are not available for this tender.');
    await this.assertWorkflowAccess(actor, workflowId);

    const sources = await this.commsDb.messagesByIds(input.messageIds);
    if (sources.length === 0) throw conflict('Select at least one query to forward.');
    // Every selected query must belong to THIS tender. Without the check a caller could
    // forward another organisation's queries by id — the ids are the only thing the
    // request carries, and assertWorkflowAccess has only vouched for the workflow.
    const foreign = sources.filter((message) => String(message.workflow_id) !== workflowId);
    if (foreign.length > 0) throw conflict('Those queries do not all belong to this tender.');

    const items: ForwardedQuery[] = sources.map((message) => ({
      firmName: message.counterparty_name != null ? String(message.counterparty_name) : String(message.counterparty_email),
      authorName: message.author_name != null ? String(message.author_name) : null,
      authorEmail: message.author_email != null ? String(message.author_email) : null,
      packageName: null,
      subject: message.subject != null ? String(message.subject) : null,
      body: message.body_text != null ? String(message.body_text) : '',
      raisedAt: message.occurred_at as Date,
      attachmentCount: Number(message.attachment_count ?? 0)
    }));

    return this.sendClientForward(actor, workflowId, {
      items,
      recordItems: (forwardMessageId) =>
        this.commsDb!.recordForwardItems(forwardMessageId, sources.map((m) => String(m.id))),
      clientEmail: input.clientEmail, clientName: input.clientName, note: input.note
    });
  }

  /**
   * The Client's answer passed back to the firms whose queries it covered.
   *
   * The recipients are DERIVED from `comms.forward_items` rather than chosen: the answer
   * belongs to the firms that asked, and letting a caller pick would let it reach a
   * competitor pricing the same package.
   */
  async relayClientAnswer(actor: Actor, clientMessageId: string, input: {
    note: string | null;
  }): Promise<Row> {
    if (!this.commsDb) throw notFound('Queries are not available.');
    const [clientMessage] = await this.commsDb.messagesByIds([clientMessageId]);
    if (!clientMessage) throw notFound('That response no longer exists.');
    if (clientMessage.kind !== 'client_reply') throw conflict('Only a client response can be relayed.');
    const workflowId = clientMessage.workflow_id != null ? String(clientMessage.workflow_id) : null;
    if (!workflowId) throw conflict('That response is not attached to a tender yet.');
    await this.assertWorkflowAccess(actor, workflowId);

    const organizationId = await this.organizationForWorkflow(workflowId);
    const config = await this.commsConfig(organizationId);
    const context = await this.letterContextFor(actor, workflowId).catch(() => null);
    const projectName = await this.projectNameForWorkflow(workflowId);

    // Which forward this answers, and therefore which queries it covers.
    const forwardId = clientMessage.in_reply_to_message_id != null
      ? String(clientMessage.in_reply_to_message_id) : null;
    const queries = forwardId ? await this.commsDb.forwardedQueries(forwardId) : [];
    if (queries.length === 0) {
      throw conflict('That response is not linked to any query, so there is nobody to relay it to.');
    }

    const answer = clientMessage.body_text != null ? String(clientMessage.body_text) : '';
    const results: Array<{ thread_id: string; to: string; status: string; error?: string }> = [];

    for (const query of queries) {
      const threadId = String(query.source_thread_id);
      const to = String(query.counterparty_email);
      const relay = await this.commsDb.recordMessage({
        threadId, organizationId, workflowId,
        shortlistEntryId: query.shortlist_entry_id != null ? String(query.shortlist_entry_id) : null,
        direction: 'outbound', channel: 'email', kind: 'relay_to_subcontractor',
        authorName: context?.estimatorName ?? null,
        authorEmail: context?.estimatorEmail ?? null,
        subject: query.subject != null ? `Re: ${String(query.subject)}` : null,
        bodyText: [answer, input.note].filter(Boolean).join('\n\n'),
        createdBy: actor.userId
      });
      if (!relay) continue;

      const email = renderClientAnswerRelayEmail({
        projectName,
        packageName: null,
        originalQuery: query.body_text != null ? String(query.body_text) : '',
        originalSubject: query.subject != null ? String(query.subject) : null,
        clientAnswer: answer,
        answeredOn: clientMessage.occurred_at as Date,
        estimatorName: context?.estimatorName ?? null,
        organizationName: context?.organizationName ?? null,
        portalUrl: null,
        replyToken: String(relay.id)
      });
      const sent = await this.sendCommsEmail({
        organizationId,
        to: this.testEmailOverride?.to ?? to,
        replyTo: config.ittCommsAddress,
        email
      });
      await this.commsDb.setExternalMessageId(String(relay.id), sent.externalMessageId);
      await this.commsDb.setThreadStatus(threadId, 'answered');
      results.push({ thread_id: threadId, to, status: sent.ok ? 'sent' : 'failed', error: sent.error });
    }

    return { relayed: results.length, recipients: results };
  }

  // ── The estimator's RFI review: sending, putting to the Client, re-attribution (issue #48) ──

  /**
   * The unanswered questions put to the Client as ONE email — the same machinery as
   * `forwardQueriesToClient` above, at QUESTION grain rather than message grain, so
   * `tps.rfi_client_forward_items` can say WHICH questions (not just which message) went.
   *
   * `rfiDb.questionsForClientForward` already refuses any question whose OWN workflow_id
   * disagrees with this one; the check on `threads` below is the second, independent one
   * — a question's thread may since have moved under a re-attribution while the question
   * row itself, a snapshot taken at extraction, still says the old tender.
   */
  async forwardRfiQuestionsToClient(actor: Actor, workflowId: string, input: {
    questionIds: string[]; clientEmail: string; clientName: string | null; note: string | null;
  }): Promise<Row> {
    if (!this.commsDb || !this.rfiDb) throw notFound('Queries are not available for this tender.');
    await this.assertWorkflowAccess(actor, workflowId);

    const questions = await this.rfiDb.questionsForClientForward(actor, workflowId, input.questionIds);
    const threadIds = [...new Set(questions.map((question) => String(question.thread_id)))];
    const threads = await this.commsDb.threadsByIds(threadIds);
    if (threads.length !== threadIds.length || threads.some((thread) => String(thread.workflow_id) !== workflowId)) {
      throw conflict('Those questions do not all belong to this tender.');
    }
    const threadById = new Map(threads.map((thread) => [String(thread.id), thread]));

    const messageIds = [...new Set(questions.map((question) => String(question.message_id)))];
    const sourceMessages = await this.commsDb.messagesByIds(messageIds);
    const messageById = new Map(sourceMessages.map((message) => [String(message.id), message]));

    const items: ForwardedQuery[] = questions.map((question) => {
      const thread = threadById.get(String(question.thread_id));
      const message = messageById.get(String(question.message_id));
      return {
        firmName: thread
          ? String(thread.counterparty_name ?? thread.counterparty_email)
          : String(question.asked_by_email ?? ''),
        authorName: question.asked_by_name != null ? String(question.asked_by_name) : null,
        authorEmail: question.asked_by_email != null ? String(question.asked_by_email) : null,
        packageName: question.package_name != null ? String(question.package_name) : null,
        subject: null,
        body: String(question.question_text),
        raisedAt: question.raised_at as Date,
        // Named ("available in the tender system") rather than silently dropped —
        // renderRfiForwardEmail carries no attachment, only its count.
        attachmentCount: message ? Number(message.attachment_count ?? 0) : 0
      };
    });

    const result = await this.sendClientForward(actor, workflowId, {
      items,
      recordItems: async (forwardMessageId) => {
        // Both ledgers, before the send: comms.forward_items at MESSAGE grain (so the
        // Client's reply still resolves through commsDb.forwardedQueries) and
        // tps.rfi_client_forward_items at QUESTION grain — the only one that can say
        // WHICH three of the seven questions on a message actually went.
        await this.commsDb!.recordForwardItems(forwardMessageId, messageIds);
        await this.rfiDb!.recordClientForwardItems(forwardMessageId, questions.map((question) => String(question.id)));
      },
      clientEmail: input.clientEmail, clientName: input.clientName, note: input.note
    });

    await this.rfiDb.markQuestionsSentToClient(questions.map((question) => String(question.id)));
    return { ...result, questions_forwarded: questions.length };
  }

  /**
   * The approved answers sent back to each firm — one email per THREAD (a firm's
   * conversation on this tender, whatever package each question belongs to), covering
   * every approved question on it. Follows `forwardQueriesToClient` step for step:
   * claim-before-send, the message recorded before the send, and a notification only
   * after — but the recipient here comes from the THREAD, never the request body, and
   * neither the recipient nor the answer text is ever supplied by the caller.
   *
   * THE SECOND, INDEPENDENT TENDER CHECK. `rfiDb.questionsForSend` already refuses a
   * question whose own `workflow_id` disagrees with this one — but that column is a
   * snapshot taken at extraction, and `commsDb.reattributeMessage` moves the THREAD, not
   * this row. So every thread these questions actually belong to is re-checked here,
   * independently, which is the check this whole issue is really asking for.
   */
  async sendRfiResponses(actor: Actor, workflowId: string, questionIds: string[]): Promise<Row> {
    if (!this.commsDb || !this.rfiDb) throw notFound('Queries are not available for this tender.');
    await this.assertWorkflowAccess(actor, workflowId);

    const questions = await this.rfiDb.questionsForSend(actor, workflowId, questionIds);
    const threadIds = [...new Set(questions.map((question) => String(question.thread_id)))];
    const threads = await this.commsDb.threadsByIds(threadIds);
    if (threads.length !== threadIds.length || threads.some((thread) => String(thread.workflow_id) !== workflowId)) {
      throw conflict('Those questions do not all belong to this tender.');
    }
    const threadById = new Map(threads.map((thread) => [String(thread.id), thread]));

    const resolved = questions.map((question) => {
      const label = `"${String(question.question_text).slice(0, 60)}"`;
      if (String(question.status) === 'sent') throw conflict(`${label} has already been sent.`);
      if (String(question.status) !== 'approved') throw conflict(`${label} has not been approved yet.`);

      const draftId = question.draft_id != null ? String(question.draft_id) : null;
      const answer = resolveAnswer({
        estimatorAnswerText: question.estimator_answer_text != null ? String(question.estimator_answer_text) : null,
        liveDraft: draftId ? {
          id: draftId,
          status: question.draft_status as 'proposed' | 'insufficient_evidence' | 'rejected_ungrounded' | 'error',
          answerText: question.draft_answer_text != null ? String(question.draft_answer_text) : null
        } : null
      });
      if (!answer) throw conflict(`${label} has no answer to send.`);

      // Citations travel with the answer only when it actually came from (or was edited
      // from) that draft — an estimator's own answer beside an unusable draft carries no
      // citation, because resolveAnswer already refused to credit that draft for it.
      const citations: RfiAnswerCitation[] = answer.draftId
        ? normaliseCitations(question.citations).map((citation) => ({
            filename: citation.filename, headingPath: citation.headingPath, pageHint: citation.pageHint
          }))
        : [];

      return { question, answer, citations };
    });

    const organizationId = await this.organizationForWorkflow(workflowId);
    const config = await this.commsConfig(organizationId);
    const context = await this.letterContextFor(actor, workflowId).catch(() => null);
    const projectName = await this.projectNameForWorkflow(workflowId);

    const results: Array<{ thread_id: string; to: string; status: string; error?: string }> = [];

    for (const [threadId, items] of groupBy(resolved, (item) => String(item.question.thread_id))) {
      const thread = threadById.get(threadId);
      if (!thread) continue; // ruled out above; never trusted twice
      const to = String(thread.counterparty_email);
      const shortlistEntryId = items.find((item) => item.question.shortlist_entry_id != null)?.question.shortlist_entry_id;

      const responseId = await this.rfiDb.claimResponse({
        workflowId, threadId, shortlistEntryId: shortlistEntryId != null ? String(shortlistEntryId) : null,
        toEmail: to, fromEmail: this.testEmailOverride?.from ?? config.ittFromAddress,
        fromFallbackUsed: false, replyToEmail: config.ittCommsAddress,
        createdBy: actor.userId, isTest: Boolean(this.testEmailOverride)
      });

      const message = await this.commsDb.recordMessage({
        threadId, organizationId, workflowId,
        shortlistEntryId: shortlistEntryId != null ? String(shortlistEntryId) : null,
        direction: 'outbound', channel: 'email', kind: 'rfi_response',
        authorName: context?.estimatorName ?? actor.email ?? null,
        authorEmail: context?.estimatorEmail ?? actor.email ?? null,
        subject: null,
        bodyText: items.map((item) => item.answer.answerText).join('\n\n'),
        idempotencyKey: `rfi-response:${responseId}`,
        createdBy: actor.userId
      });
      if (!message) {
        await this.rfiDb.settleResponse(responseId, { status: 'failed', error: 'already sent' });
        results.push({ thread_id: threadId, to, status: 'failed', error: 'already sent' });
        continue;
      }

      // Snapshotted BEFORE the send, exactly as recordForwardItems is written before the
      // forward's send — this is what the sent email actually said, and must never be
      // re-derived from a draft that may since have changed.
      await this.rfiDb.recordResponseItems(responseId, items.map((item, index) => ({
        questionId: String(item.question.id), seq: index + 1,
        answerText: item.answer.answerText, source: item.answer.source, draftId: item.answer.draftId
      })));

      const email = renderRfiResponseEmail(
        items.map((item) => ({
          question: String(item.question.question_text),
          answer: item.answer.answerText,
          citations: item.citations
        })),
        {
          projectName, packageName: null,
          estimatorName: context?.estimatorName ?? null,
          organizationName: context?.organizationName ?? null,
          portalUrl: null,
          replyToken: String(message.id)
        }
      );

      const sent = await this.sendCommsEmail({
        organizationId, to: this.testEmailOverride?.to ?? to,
        replyTo: config.ittCommsAddress, email
      });
      await this.commsDb.setExternalMessageId(String(message.id), sent.externalMessageId);
      await this.commsDb.setThreadStatus(threadId, 'answered');
      await this.rfiDb.settleResponse(responseId, {
        status: sent.ok ? 'sent' : 'failed', error: sent.error,
        emailMessageId: sent.externalMessageId, commsMessageId: String(message.id)
      });

      if (sent.ok) {
        await this.rfiDb.markQuestionsSent(items.map((item) => String(item.question.id)));
      } else {
        // The one failure here nobody sees otherwise: the caller's response is gone the
        // moment the page closes, and the questions stay 'approved' (never 'sent') so
        // they are still visible in the review queue — but nothing else says WHY they
        // did not go. Raised after the send, for the same reason forwardQueriesToClient's
        // does: whether it sent is not knowable inside the transaction that recorded it.
        await this.commsDb.recordNotification({
          kind: 'rfi_review_required',
          organizationId, workflowId, threadId,
          messageId: String(message.id),
          title: `The answer to ${thread.counterparty_name ?? to} did not send`,
          body: sent.error ?? 'The email was recorded but the provider rejected it.',
          deepLinkPath: await this.commsDeepLink(workflowId, threadId)
        });
      }

      results.push({ thread_id: threadId, to, status: sent.ok ? 'sent' : 'failed', error: sent.error });
    }

    return { sent: results.filter((result) => result.status === 'sent').length, responses: results };
  }

  /**
   * A human re-files a subcontractor query onto the tender it actually belongs to — the
   * one place that closes the eligibility gate's blocked_ambiguous_tender /
   * blocked_cross_tender_suspected loop (see `rfiEligibility.ts`'s own doctrine).
   *
   * BOTH ends are authorised: the TARGET workflow through the ordinary
   * `assertWorkflowAccess`, and the SOURCE message's organisation directly —
   * `blocked_ambiguous_tender` routinely carries no workflow_id at all ("no tender
   * matched this sender at all"), so the organisation is the only boundary it has, the
   * same rule `getCommsThread` above already applies.
   */
  async reattributeCommsMessage(actor: Actor, messageId: string, workflowId: string): Promise<Row> {
    if (!this.commsDb || !this.rfiDb) throw notFound('Queries are not available.');
    await this.assertWorkflowAccess(actor, workflowId);

    const [message] = await this.commsDb.messagesByIds([messageId]);
    if (!message) throw notFound('This message no longer exists.');
    if (String(message.organization_id) !== actor.organizationId) {
      throw notFound('This message no longer exists.');
    }
    if (message.workflow_id) {
      await this.assertWorkflowAccess(actor, String(message.workflow_id));
    }
    if (message.kind !== 'subcontractor_rfi') {
      throw conflict('Only a subcontractor query can be re-filed.');
    }
    if (String(message.workflow_id) === workflowId) {
      throw conflict('That message is already filed under this tender.');
    }

    // The guard that prevents data loss. Both tps.rfi_response_items and
    // tps.rfi_client_forward_items cascade from tps.rfi_questions, so discarding the
    // questions once either exists would silently erase real, already-sent history.
    const committed = await this.rfiDb.committedQuestionsFor(messageId);
    if (committed > 0) {
      throw conflict('Answers to this query have already been sent or put to the client, so it cannot be re-filed.');
    }

    // tps FIRST, comms SECOND, and the order is the design — see discardExtraction's own
    // doc comment for why the other order leaves the message unreadable rather than
    // merely re-reading it once more.
    const questionsDiscarded = await this.rfiDb.discardExtraction(messageId);
    const moved = await this.commsDb.reattributeMessage(messageId, workflowId);

    return {
      message_id: messageId, workflow_id: workflowId,
      thread_id: moved.thread_id, questions_discarded: questionsDiscarded
    };
  }

  /** The addresses this organisation uses, with the built-in defaults where it has saved
   *  nothing. One read, shared by every comms path. */
  private async commsConfig(organizationId: string): Promise<{
    ittFromAddress: string; ittCommsAddress: string; clientReplyAddress: string;
    clientContactName: string | null; clientContactEmail: string | null;
  }> {
    const [row] = await this.db.query<Row>(
      `SELECT * FROM public.itt_comms_config WHERE organization_id = $1 AND tender_id IS NULL`,
      [organizationId]
    );
    return {
      ittFromAddress: row?.itt_from_address ? String(row.itt_from_address) : ITT_FROM_ADDRESS,
      ittCommsAddress: row?.itt_comms_address ? String(row.itt_comms_address) : ITT_FROM_ADDRESS,
      clientReplyAddress: row?.client_reply_address ? String(row.client_reply_address) : DEFAULT_CLIENT_REPLY_ADDRESS,
      clientContactName: row?.client_contact_name != null ? String(row.client_contact_name) : null,
      clientContactEmail: row?.client_contact_email != null ? String(row.client_contact_email) : null
    };
  }

  /** The Client contact this organisation configured, for pre-filling the forward form. */
  async commsDefaults(actor: Actor, workflowId: string): Promise<Row> {
    await this.assertWorkflowAccess(actor, workflowId);
    const config = await this.commsConfig(await this.organizationForWorkflow(workflowId));
    return {
      client_contact_name: config.clientContactName,
      client_contact_email: config.clientContactEmail,
      itt_comms_address: config.ittCommsAddress
    };
  }

  /**
   * Sends one comms email, and never throws.
   *
   * A send that fails must not lose the message that was already recorded — the
   * conversation is the record, and an email is a delivery of it. The failure is returned
   * so the caller can show it, the same way confirmAndSendItt reports a failed ITT.
   */
  private async sendCommsEmail(input: {
    organizationId: string; to: string; replyTo: string;
    email: { subject: string; html: string; text: string };
  }): Promise<{ ok: boolean; error?: string; externalMessageId: string | null }> {
    if (!this.emailService) return { ok: false, error: 'Email is not configured', externalMessageId: null };
    const config = await this.commsConfig(input.organizationId);
    try {
      const result = await this.emailService.send({
        from: this.testEmailOverride?.from ?? config.ittFromAddress,
        to: input.to,
        replyTo: input.replyTo,
        subject: input.email.subject,
        html: input.email.html,
        text: input.email.text
      }) as { id?: string } | undefined;
      return { ok: true, externalMessageId: result?.id ?? null };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Send failed',
        externalMessageId: null
      };
    }
  }

  /**
   * Puts each attachment in BuildFlow's object store and returns what to record.
   *
   * The attachment id is minted HERE, before the upload, because it is what the object
   * key is built from — never the filename, which on an inbound email is chosen by
   * whoever sent it.
   *
   * Throws if storage is unavailable, and the caller lets that fail the whole message.
   * Unlike the ITT's document links, which degrade to an email without them, a query with
   * its drawing silently missing is worse than a query that visibly failed to send.
   */
  private async storeCommsAttachments(
    organizationId: string, attachments: Array<{ filename: string; content: Uint8Array<ArrayBuffer> }>
  ): Promise<CommsAttachmentInput[]> {
    if (attachments.length === 0) return [];
    if (!this.commsAttachments) {
      throw conflict('Attachments cannot be accepted at the moment. Send your query without one, or email it.');
    }
    const stored: CommsAttachmentInput[] = [];
    for (const attachment of attachments) {
      const id = randomUUID();
      const result = await this.commsAttachments.store({
        organizationId, attachmentId: id, filename: attachment.filename, content: attachment.content
      });
      stored.push({
        id,
        filename: attachment.filename,
        contentType: result.contentType,
        byteSize: result.byteSize,
        sha256: result.sha256,
        objectKey: result.objectKey,
        // Stored verbatim. BUILDFLOW_COMMS_ATTACHMENTS_API.md: embed `url`, never
        // construct it — the base we hold is the internal one, unreachable from a browser.
        shareUrl: result.url,
        shareToken: result.token,
        shareExpiresAt: result.expiresAt
      });
    }
    return stored;
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
