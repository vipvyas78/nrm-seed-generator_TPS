/**
 * Renders the Invitation to Tender email body for one recipient.
 *
 * ONE EMAIL, ONE RECIPIENT, ONE OR MORE PACKAGES. A subcontractor shortlisted against three
 * packages gets a single invitation covering all three, not three separate emails — so this
 * takes an array. Everything that varies by package (scope, bill, forms, attendances, the
 * package's own document bundle) renders once per package; everything shared by the send
 * (the project, the complete document set, the greeting) renders once for the message.
 *
 * Pure function: every fact it prints comes from the packs passed in. It does not re-derive
 * scope, BoQ attribution or forms/attendances — that assembly already exists in
 * `getPackageItt` and stays there. The caller is responsible for filtering out anything
 * marked "Ignore for ITT" before this runs; this file has no notion of overrides.
 */
export interface IttEmailRecipient {
  name: string | null;
  email: string;
  /** scms.subcontractors.registered_address (fallback trading_address) — the cover letter's address block. */
  address: string | null;
}

/** The per-tender letter facts nothing else in either database modelled before this —
 * see tps.itt_letter_details. All nullable: the letter renders around a gap rather
 * than blocking a send on a field nobody has filled in yet. */
export interface IttEmailLetterContext {
  siteAddress: string | null;
  tenderReturnDeadline: string | null;
  clarificationsCloseDate: string | null;
  siteVisitPermitted: boolean | null;
  estimatorName: string | null;
  estimatorEmail: string | null;
  organizationName: string;
}

/** A work package's own document pack — BuildFlow's per-WP zip. */
export interface IttEmailBundle {
  url: string;
  documentCount: number;
  /**
   * True when the package cited no drawing sheet and was issued every sheet instead. Said
   * out loud in the email: a tenderer handed the whole drawing set should know that is what
   * they are holding, rather than assuming it has been narrowed to their trade.
   */
  allSheetsFallback: boolean;
}

export interface IttEmailBoqLine {
  geCode: string | null;
  elementCode: string | null;
  description: string;
  quantity: number | null;
  unit: string | null;
  isPriceable: boolean;
}

export interface IttEmailBillLine {
  ref: string | null;
  section: string | null;
  description: string;
  quantity: number | null;
  unit: string | null;
  requiredFor: string | null;
}

export interface IttEmailScopeItem {
  /** The subheading this clause prints under, e.g. "Health, Safety & Environmental". */
  section: string;
  description: string;
  procurementStage: string | null;
}

export interface IttEmailSpecClause {
  chunkId: string;
  geCode: string | null;
  elementCode: string | null;
  subElementCode: string | null;
  subsectionTitle: string | null;
  rawText: string;
  nbsCode: string | null;
}

export interface IttEmailPack {
  packageName: string;
  displayRef: string;
  routeOfProcurement: string | null;
  /**
   * This package's own return date, already resolved and formatted dd/mm/yyyy.
   *
   * Resolution (explicit workflow date > the date already issued for this package > this
   * package's return period counted from the dispatch date) happens in tenderPrepDb, not
   * here: this file states no policy about dates, it only prints them. Null falls back to
   * the letter-wide `letterContext.tenderReturnDeadline`, which is what a preview with no
   * workflow behind it, and every caller predating per-package periods, relies on.
   */
  tenderReturnDeadline: string | null;
  returnForms: Array<{ name: string; description: string | null; isRequired: boolean }>;
  boqSummary: { total: number; priceable: number; authored: number };
  boqLines: IttEmailBoqLine[];
  billLines: IttEmailBillLine[];
  scopeItems: IttEmailScopeItem[];
  specClauses: IttEmailSpecClause[];
  /**
   * The specification documents this package's own lines were read from, by name.
   *
   * Names, not links — which of the tender documents the take-off actually measured against,
   * and the ones a tenderer pricing this trade opens first inside the document pack.
   */
  specDocuments: string[];
  /**
   * This package's document pack, as one zip.
   *
   * THE ONLY DOCUMENT LINK AN ITT CARRIES. There was once a per-document fallback listing
   * every file in the project, and on a real pack it printed 140 links — issuing a flooring
   * subcontractor the drainage sheets and burying the ones that matter. A tenderer gets this
   * zip or, failing that, the complete set; never a file-by-file index.
   */
  bundle: IttEmailBundle | null;
  attendanceSummary: { subcontractor: number; mainContractor: number; joint: number };
  valueEngineeringRequired: boolean;
  /**
   * Which itt_attachment_types codes actually resolved for this package's trade
   * (itt_attachment_trades, resolved the same way listScopeItems resolves a trade —
   * see tenderPrepDb.ts's attachmentCodesFor). Drives both the cover letter's
   * required-returns list and its section index — generated from this, never
   * authored in a template, so a letter can never claim a document that isn't
   * actually attached.
   */
  attachmentCodes: string[];
}

/** Whether, and why, a subcontractor pricing portal link exists for one package on THIS
 * send. Keyed by package name on `IttEmailOptions`, not stored on `IttEmailPack` itself —
 * `sendIttsForWorkflow` assembles one `IttEmailPack` per package and shares that same
 * object across every firm invited to it, so a per-recipient URL living on the pack would
 * leak firm A's token into firm B's rendered email the moment both share a package. */
export interface IttEmailPortalStatus {
  url: string | null;
  /** Why no link exists, e.g. "this recipient's email domain is a public/free provider".
   * Null when `url` is set. */
  unavailableReason: string | null;
}

export interface IttEmailOptions {
  tenderName: string;
  /** Everything the tender pack contains, as one zip. The safety net beside each package pack. */
  completeBundleUrl: string | null;
  letterContext: IttEmailLetterContext;
  /** THIS RECIPIENT's portal status per package name. Absent entirely (undefined) omits
   * the online-pricing section altogether, which is also what every existing caller and
   * test that predates this feature gets automatically. */
  portalStatusByPackage?: Record<string, IttEmailPortalStatus>;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const stageLabel = (stage: string | null): string => {
  if (stage === 'Contract') return 'Contract — must be priced';
  if (stage === 'Profit Plan') return 'Profit Plan — not priced';
  return stage ?? '';
};

const qty = (n: number | null): string => (n === null ? '—' : String(n));

/** Plain-text pipe table, header row plus one row per record. */
const textTable = (headers: string[], rows: string[][]): string =>
  [headers.join(' | '), ...rows.map((r) => r.join(' | '))].join('\n');

const htmlTable = (headers: string[], rows: string[][]): string => `
  <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
    <thead><tr>${headers.map((h) => `<th style="text-align:left; border-bottom: 2px solid #ccc; padding: 4px 6px;">${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td style="border-bottom: 1px solid #eee; padding: 4px 6px;">${c}</td>`).join('')}</tr>`).join('')}</tbody>
  </table>`;

export interface IttScopeSection {
  section: string;
  lines: Array<{ number: number; text: string }>;
}

/**
 * Group a package's scope clauses under their subheadings and number them straight through.
 *
 * The items arrive ALREADY ORDERED by section — this only has to detect where one section
 * ends and the next begins. Re-sorting here would need this file to hold a second opinion
 * about section order, and the two would drift the first time a client reordered their
 * sections in the config editor.
 *
 * The number is assigned HERE, per package, not carried from the library. A clause's number
 * is a position in one document: the same clause is item 29 in one trade's scope and item 43
 * in another's, and a bill referring to "item 29" has to mean the 29th line of the scope the
 * tenderer was actually sent.
 *
 * Exported for the scope-of-works PDF, which is now the ONLY place the clauses are numbered:
 * the email body carries a sentence pointing at the attachment rather than a second copy of
 * it. The grouping and numbering live here because the types they read do.
 */
export function groupScopeSections(scopeItems: IttEmailScopeItem[]): IttScopeSection[] {
  let scopeNumber = 0;
  const sections: IttScopeSection[] = [];
  for (const item of scopeItems) {
    scopeNumber += 1;
    const text = `${item.description}${item.procurementStage ? ` (${stageLabel(item.procurementStage)})` : ''}`;
    const current = sections[sections.length - 1];
    if (current && current.section === item.section) current.lines.push({ number: scopeNumber, text });
    else sections.push({ section: item.section, lines: [{ number: scopeNumber, text }] });
  }
  return sections;
}

export const BOQ_HEADERS = ['GE Code', 'Element', 'Description', 'Qty', 'Unit'];
export const BILL_HEADERS = ['Ref', 'Section', 'Description', 'Qty', 'Unit', 'Required for'];
const SPEC_HEADERS = ['GE Code', 'Element / Sub-element', 'Clause'];

export const boqRowsFor = (pack: IttEmailPack): string[][] =>
  pack.boqLines.map((l) => [l.geCode ?? '—', l.elementCode ?? '—', l.description, qty(l.quantity), l.unit ?? '—']);

export const billRowsFor = (pack: IttEmailPack): string[][] =>
  pack.billLines.map((l) => [l.ref ?? '—', l.section ?? '—', l.description, qty(l.quantity), l.unit ?? '—', l.requiredFor ?? '—']);

const specRowsFor = (pack: IttEmailPack): string[][] =>
  pack.specClauses.map((c) => [c.geCode ?? '—', [c.elementCode, c.subElementCode].filter(Boolean).join(' / ') || '—', c.rawText]);

const boqIntro = (pack: IttEmailPack): string =>
  `${pack.boqSummary.total} measured lines attributed to this package (${pack.boqSummary.priceable} carrying a quantity), plus ${pack.boqSummary.authored} authored line${pack.boqSummary.authored === 1 ? '' : 's'}. Rates are not shown — please price independently. A pricing schedule is attached for you to complete.`;

/** Stated identically in the text body, the HTML body and the compose-link body. */
const VALUE_ENGINEERING_SENTENCE =
  'Every tenderer must submit at least one Value Engineering proposal stating the saving, the '
  + 'programme effect, any departure from the specification and the clause affected. A return '
  + 'without one is not compliant.';

const attendanceSentence = (pack: IttEmailPack): string =>
  `${pack.attendanceSummary.subcontractor} item${pack.attendanceSummary.subcontractor === 1 ? '' : 's'} carried by the subcontractor, ${pack.attendanceSummary.mainContractor} by the main contractor${pack.attendanceSummary.joint > 0 ? `, ${pack.attendanceSummary.joint} joint` : ''}.`;

const bundleSentence = (bundle: IttEmailBundle): string =>
  `${bundle.documentCount} document${bundle.documentCount === 1 ? '' : 's'}${bundle.allSheetsFallback ? '. No drawing sheet was cited against this package, so the complete drawing set is included rather than a narrowed selection' : ''}`;

/** The name of the file the scope of works travels as. Matches `ittAttachments.safeName`. */
const scopePdfName = (pack: IttEmailPack): string =>
  `Scope of Works - ${pack.packageName.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Package'}.pdf`;

/**
 * The scope of works, BY REFERENCE.
 *
 * The clauses themselves are NOT printed here. They run to 171 lines on a real package, and
 * printing them below an attachment carrying the identical text gave a tenderer two copies of
 * the same document and no way to know which one governed. The PDF is the issued document;
 * this is the pointer to it.
 */
const scopeSentence = (pack: IttEmailPack): string => {
  const count = pack.scopeItems.length;
  return count === 0
    ? 'No scope of works is configured for this package.'
    : `${count} clause${count === 1 ? '' : 's'}, issued in full as the attached "${scopePdfName(pack)}". Price the works in accordance with it.`;
};

/**
 * Where this package's documents are, in one link or one sentence.
 *
 * ONE ZIP OR A STATEMENT — never a file-by-file list. A tenderer needs the pack their trade was
 * issued, and if that pack does not exist they need to be told so plainly and pointed at the
 * complete set, not handed every document in the project to sort through themselves.
 */
const documentsSentence = (pack: IttEmailPack, completeBundleUrl: string | null): string => {
  if (pack.bundle) return `Package document pack (${bundleSentence(pack.bundle)})`;
  return completeBundleUrl
    ? 'No document pack has been produced for this package. Refer to the complete tender document set below, which carries every document issued with this tender.'
    : 'The tender documents for this package will be issued separately.';
};

/**
 * One line about the online pricing portal, or nothing at all — never a heading with
 * nothing under it. `status` is undefined for every caller that predates this feature
 * (previews, and any test not passing `portalStatusByPackage`), which must render
 * exactly as it did before this section existed.
 */
const portalSentence = (status: IttEmailPortalStatus | undefined): string | null => {
  if (!status) return null;
  if (status.url) return `Price and submit this package's bill online: ${status.url}`;
  return status.unavailableReason
    ? `Online pricing is not available for this recipient (${status.unavailableReason}) — please price using the attached workbook instead.`
    : null;
};

const ATTACHMENT_LABELS: Record<string, string> = {
  cover_letter: 'Cover Letter',
  form_1a: '1A Instructions to Tenderers',
  form_1b: '1B Form of Tender for Sub Contractor',
  form_1c: '1C Sub-Contractor Declaration of Non-Collusion',
  schedule_of_attendances: 'Schedule of Attendances',
  scope_of_works: 'Scope of Works',
  boq_pricing_workbook: 'Pricing Document BOQ'
};

const RETURNS_LABELS: Record<string, string> = {
  form_1b: 'Form of Tender',
  form_1c: 'Declaration of Non Collusion',
  schedule_of_attendances: 'Schedule of Attendances',
  boq_pricing_workbook: 'Pricing Document (BOQ or Activity Schedule)'
};

/**
 * The cover letter's plain "please return the following" bullet list — generated
 * from whichever attachments actually resolved for this send, never authored in a
 * template, so it can never ask for something that isn't actually attached.
 * `{{requiredReturnsList}}` in a template resolves to this.
 */
export function requiredReturnsList(attachmentCodes: string[], valueEngineeringRequired: boolean): string {
  const lines = attachmentCodes
    .map((c) => RETURNS_LABELS[c])
    .filter((l): l is string => Boolean(l))
    .map((l) => `- ${l}`);
  if (valueEngineeringRequired) lines.push('- Value Engineering Options');
  return lines.length > 0 ? lines.join('\n') : '- As set out in the attached documents.';
}

/**
 * The cover letter's numbered Section 1-5 index — generated from the attachments
 * that actually resolved for this pack, never authored in a template, so a letter
 * can never claim a section for a document that isn't actually attached. Section 4
 * (Tender Documents) is unconditional: it points at the document pack link, which
 * every ITT carries regardless of which PDFs are configured in. `{{sectionIndex}}`
 * in a template resolves to this.
 */
export function sectionIndex(attachmentCodes: string[]): string {
  const has = (c: string) => attachmentCodes.includes(c);
  const lines: string[] = [];
  const section1 = (['form_1a', 'form_1b', 'form_1c'] as const).filter(has).map((c) => ATTACHMENT_LABELS[c]);
  if (section1.length > 0) lines.push(`Section 1: ${section1.join('\n         ')}`);
  if (has('scope_of_works')) lines.push('Section 2: Scope of Works');
  if (has('schedule_of_attendances')) lines.push('Section 3: Schedule of Attendances');
  lines.push('Section 4: Tender Documents (Drawings, Spec & Contract conditions)');
  if (has('boq_pricing_workbook')) lines.push('Section 5: Pricing Document BOQ');
  return lines.join('\n');
}

const dateOrTbc = (s: string | null): string => s ?? 'to be confirmed';

const RULE = '='.repeat(78);

const packageTextBlock = (pack: IttEmailPack, completeBundleUrl: string | null, portalStatus: IttEmailPortalStatus | undefined, returnBy: string | null): string => {
  const boqRows = boqRowsFor(pack);
  const billRows = billRowsFor(pack);
  const specRows = specRowsFor(pack);
  const requiredForms = pack.returnForms.filter((f) => f.isRequired);
  const optionalForms = pack.returnForms.filter((f) => !f.isRequired);
  const portalLine = portalSentence(portalStatus);

  return `${RULE}
WORK PACKAGE: ${pack.packageName} (ref ${pack.displayRef})
Route:     ${pack.routeOfProcurement ?? 'Not stated'}${returnBy ? `\nReturn by: ${returnBy}` : ''}
${RULE}

SECTION 1 — TENDER RETURN: a compliant submission must contain
${requiredForms.length > 0 ? requiredForms.map((f) => ` - ${f.name}${f.description ? ` — ${f.description}` : ''}`).join('\n') : ' - See attached return forms.'}
${optionalForms.length > 0 ? `\nOptional:\n${optionalForms.map((f) => ` - ${f.name}`).join('\n')}` : ''}

SECTION 2 — SCOPE OF WORKS
${scopeSentence(pack)}

${pack.specDocuments.length > 0 ? `SPECIFICATION REFERENCED BY THIS PACKAGE
${pack.specDocuments.map((d) => ` - ${d}`).join('\n')}

` : ''}SECTION 3 — SCHEDULE OF ATTENDANCES
${attendanceSentence(pack)}

SECTION 4 — TENDER DOCUMENTS
${pack.bundle
  ? ` - ${documentsSentence(pack, completeBundleUrl)}: ${pack.bundle.url}`
  : documentsSentence(pack, completeBundleUrl)}

SECTION 5 — PRICING DOCUMENT BOQ
${boqIntro(pack)}

${boqRows.length > 0 ? textTable(BOQ_HEADERS, boqRows) : 'No measured lines are attributed to this package.'}
${billRows.length > 0 ? `\nBILL OF QUANTITIES — AUTHORED ITEMS\n${textTable(BILL_HEADERS, billRows)}\n` : ''}
${specRows.length > 0 ? `\nSPECIFICATION CLAUSES\n${textTable(SPEC_HEADERS, specRows)}\n` : ''}
${pack.valueEngineeringRequired ? `\nVALUE ENGINEERING\n${VALUE_ENGINEERING_SENTENCE}\n` : ''}
${portalLine ? `\nSECTION 6 — PRICE THIS PACKAGE ONLINE\n${portalLine}\n` : ''}`;
};

const packageHtmlBlock = (pack: IttEmailPack, completeBundleUrl: string | null, portalStatus: IttEmailPortalStatus | undefined, returnBy: string | null): string => {
  const boqHtmlRows = boqRowsFor(pack).map((r) => r.map(esc));
  const billHtmlRows = billRowsFor(pack).map((r) => r.map(esc));
  const specHtmlRows = specRowsFor(pack).map((r) => r.map(esc));
  const requiredForms = pack.returnForms.filter((f) => f.isRequired);
  const optionalForms = pack.returnForms.filter((f) => !f.isRequired);

  return `
  <div style="border-top: 3px solid #1a1a1a; margin-top: 28px; padding-top: 8px;">
  <h2 style="font-size: 17px; margin-bottom: 2px;">Work Package: ${esc(pack.packageName)} <span style="color:#888; font-weight: normal;">(ref ${esc(pack.displayRef)})</span></h2>
  <p style="color: #555; margin-top: 0; font-size: 13px;">Route: ${esc(pack.routeOfProcurement ?? 'Not stated')}${
    returnBy ? `<br>Return by: <strong>${esc(returnBy)}</strong>` : ''}</p>

  <h3 style="font-size: 15px;">Section 1 — Tender return: a compliant submission must contain</h3>
  ${requiredForms.length > 0
    ? `<ul>${requiredForms.map((f) => `<li><strong>${esc(f.name)}</strong>${f.description ? ` — ${esc(f.description)}` : ''}</li>`).join('')}</ul>`
    : '<p>See attached return forms.</p>'}
  ${optionalForms.length > 0 ? `<p style="color:#555;">Optional: ${optionalForms.map((f) => esc(f.name)).join(', ')}</p>` : ''}

  <h3 style="font-size: 15px;">Section 2 — Scope of works</h3>
  <p>${esc(scopeSentence(pack))}</p>

  ${pack.specDocuments.length > 0 ? `
  <h3 style="font-size: 15px;">Specification referenced by this package</h3>
  <p style="font-size: 13px;">The measured lines below were read from these documents. They are issued with the document pack below.</p>
  <ul>${pack.specDocuments.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}

  <h3 style="font-size: 15px;">Section 3 — Schedule of attendances</h3>
  <p>${esc(attendanceSentence(pack))}</p>

  <h3 style="font-size: 15px;">Section 4 — Tender documents</h3>
  ${pack.bundle
    ? `<p><a href="${esc(pack.bundle.url)}"><strong>Download the ${esc(pack.packageName)} document pack</strong></a><br>
       <span style="color:#555; font-size: 13px;">${esc(bundleSentence(pack.bundle))}.</span></p>`
    : `<p>${esc(documentsSentence(pack, completeBundleUrl))}</p>`}

  <h3 style="font-size: 15px;">Section 5 — Pricing document BOQ</h3>
  <p>${esc(boqIntro(pack))}</p>
  ${boqHtmlRows.length > 0 ? htmlTable(BOQ_HEADERS, boqHtmlRows) : '<p>No measured lines are attributed to this package.</p>'}

  ${billHtmlRows.length > 0 ? `
  <h3 style="font-size: 15px;">Bill of quantities — authored items</h3>
  ${htmlTable(BILL_HEADERS, billHtmlRows)}` : ''}

  ${specHtmlRows.length > 0 ? `
  <h3 style="font-size: 15px;">Specification clauses</h3>
  ${htmlTable(SPEC_HEADERS, specHtmlRows)}` : ''}

  ${pack.valueEngineeringRequired ? `
  <h3 style="font-size: 15px;">Value Engineering</h3>
  <p><strong>Mandatory.</strong> ${esc(VALUE_ENGINEERING_SENTENCE)}</p>` : ''}

  ${portalSentence(portalStatus) ? `
  <h3 style="font-size: 15px;">Section 6 — Price this package online</h3>
  ${portalStatus?.url
    ? `<p><a href="${esc(portalStatus.url)}"><strong>Price and submit this package's bill online</strong></a></p>`
    : `<p>${esc(portalSentence(portalStatus) ?? '')}</p>`}` : ''}
  </div>`;
};

/**
 * Renders in the shape of the reference cover letter (ref line, address block, date,
 * FAO, ITT/site/work-package header, intro, required-returns list, deadline sentence,
 * boilerplate Contractor's-Requirements paragraph, numbered section index, sign-off)
 * — but keeps the existing per-package rich content (BoQ table, bill lines, spec
 * clauses, documents, attendances) beneath it, under the letter's own numbered
 * sections, rather than dropping it: the codebase's own rule elsewhere is "pointer in
 * the email, full detail in the PDF," not replacing useful detail with a bare letter.
 *
 * The required-returns list and section index are unioned across every package on
 * the send (one recipient can be invited to several) and generated from each
 * package's own resolved `attachmentCodes` — never hand-authored, so the letter can
 * never claim a document that isn't actually attached.
 */
export function renderIttEmail(
  packages: IttEmailPack[],
  recipient: IttEmailRecipient,
  options: IttEmailOptions
): { subject: string; html: string; text: string } {
  const { tenderName, completeBundleUrl, letterContext } = options;
  const many = packages.length > 1;
  const subject = many
    ? `Invitation to Tender — ${packages.length} packages — ${tenderName}`
    : `Invitation to Tender — ${packages[0]?.packageName ?? 'Tender'} — ${tenderName}`;
  const greeting = recipient.name ? `Dear ${recipient.name},` : 'Dear Sir/Madam,';
  const packageList = packages.map((p) => `${p.packageName} (ref ${p.displayRef})`);
  const workPackageLine = many ? 'Multiple packages — see below' : (packages[0]?.packageName ?? 'Tender');

  const unionCodes = [...new Set(packages.flatMap((p) => p.attachmentCodes))];
  const anyVE = packages.some((p) => p.valueEngineeringRequired);
  const returnsList = requiredReturnsList(unionCodes, anyVE);
  const sections = sectionIndex(unionCodes);
  const today = new Date().toLocaleDateString('en-GB');

  // A per-firm send puts several packages in one letter, and those packages can now carry
  // different return dates. The letter's single "return by" sentence can only speak for all
  // of them when they agree; where they do not it says so, and each package block states its
  // own. The `?? letterContext` fallback is what keeps every pre-existing caller — and a
  // preview with no workflow behind it — rendering exactly as before.
  const returnDateFor = (p: IttEmailPack) => p.tenderReturnDeadline ?? letterContext.tenderReturnDeadline;
  const distinctReturnDates = [...new Set(packages.map(returnDateFor))];
  const oneReturnDate = distinctReturnDates.length <= 1;
  const returnTo = letterContext.estimatorEmail ?? 'the address below';
  const returnLead = 'Your completed Form of Tender, together with all necessary supporting information,';
  // A block prints its own date whenever the shared sentence above cannot speak for it. In
  // the single-date case the line is omitted when there is no date at all, so today's
  // ordinary letter does not gain a second "to be confirmed"; in the mixed case every block
  // states something, because a silently missing date is the failure that matters there.
  const returnByFor = (p: IttEmailPack): string | null =>
    oneReturnDate ? returnDateFor(p) : dateOrTbc(returnDateFor(p));

  const intro = many
    ? `You are invited to tender for the ${packages.length} packages listed below. Each package is set out in full — its scope of works, bill of quantities, document pack and return requirements — and each carries its own attached scope of works and pricing schedule. Please price each package separately.`
    : 'You are invited to tender for the package below. Please find its scope of works, bill of quantities, the documents this invitation carries and what a compliant return must contain. The scope of works and a pricing schedule are attached.';

  const completeTextBlock = completeBundleUrl
    ? `\nCOMPLETE TENDER DOCUMENT SET\nEverything issued with this tender, as a single download. Your package pack${many ? 's' : ''} above ${many ? 'are' : 'is'} a narrowed selection of it.\n - ${completeBundleUrl}\n`
    : '';

  const text = `Our Ref: ${tenderName} / ${workPackageLine}

${recipient.name ?? ''}${recipient.address ? `\n${recipient.address}` : ''}

Date: ${today}
FAO: ${recipient.name ?? 'Sir/Madam'}

INVITATION TO TENDER: ${tenderName}
SITE ADDRESS: ${letterContext.siteAddress ?? 'To be confirmed'}
WORK PACKAGE: ${workPackageLine}

${greeting}

${intro}

You are required to submit a fully priced Lump Sum tender return in support of your quotation. This must include:
${returnsList}

${oneReturnDate
  ? `${returnLead} should be returned to ${returnTo}, no later than ${dateOrTbc(distinctReturnDates[0] ?? null)}.`
  : `${returnLead} should be returned to ${returnTo}. These packages have different return dates — each one is stated against its package below.`}

The below information forms the basis of the ITT and are our Employer's Contractor's Requirements which will be included within the Sub-Contract. Your price should reflect this and any omissions should be clarified clearly within your submission.

${sections}

${packages.map((p) => packageTextBlock(p, completeBundleUrl, options.portalStatusByPackage?.[p.packageName], returnByFor(p))).join('\n')}
${completeTextBlock}
Please raise all technical and commercial queries in writing before the return date.

Yours faithfully,
${letterContext.estimatorName ?? ''}
On behalf of ${letterContext.organizationName}
`;

  const html = `
<div style="font-family: Arial, Helvetica, sans-serif; max-width: 640px; margin: 0 auto; color: #1a1a1a;">
  <p style="margin-bottom: 2px;"><em>Our Ref: ${esc(tenderName)} / ${esc(workPackageLine)}</em></p>
  <p style="margin: 12px 0 2px;">${recipient.name ? esc(recipient.name) : ''}${recipient.address ? `<br>${esc(recipient.address)}` : ''}</p>
  <p style="margin: 12px 0 2px;">Date: ${esc(today)}</p>
  <p style="margin: 2px 0 12px;">FAO: ${esc(recipient.name ?? 'Sir/Madam')}</p>

  <h1 style="font-size: 18px; margin-bottom: 2px;">Invitation to Tender: ${esc(tenderName)}</h1>
  <p style="font-weight: bold; margin: 2px 0;">Site Address: ${esc(letterContext.siteAddress ?? 'To be confirmed')}</p>
  <p style="font-weight: bold; margin: 2px 0 16px;">Work Package: ${esc(workPackageLine)}</p>

  <p>${esc(greeting)}</p>

  <p>${esc(intro)}</p>

  <p>You are required to submit a fully priced Lump Sum tender return in support of your quotation. This must include:</p>
  <ul>${returnsList.split('\n').map((l) => `<li>${esc(l.replace(/^- /, ''))}</li>`).join('')}</ul>

  <p>${oneReturnDate
    ? `${esc(returnLead)} should be returned to ${esc(returnTo)}, no later than <strong>${esc(dateOrTbc(distinctReturnDates[0] ?? null))}</strong>.`
    : `${esc(returnLead)} should be returned to ${esc(returnTo)}. <strong>These packages have different return dates</strong> — each one is stated against its package below.`}</p>

  <p style="font-size: 13px; color: #555;">The below information forms the basis of the ITT and are our Employer's Contractor's Requirements which will be included within the Sub-Contract. Your price should reflect this and any omissions should be clarified clearly within your submission.</p>

  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
    <tr><td style="padding: 4px 0; color: #555; vertical-align: top;">Tender</td><td style="padding: 4px 0;">${esc(tenderName)}</td></tr>
    <tr><td style="padding: 4px 0; color: #555; vertical-align: top;">Package${many ? 's' : ''}</td><td style="padding: 4px 0;">${packageList.map(esc).join('<br>')}</td></tr>
  </table>
  <pre style="font-family: inherit; white-space: pre-wrap; font-size: 13px; color: #333;">${esc(sections)}</pre>

  ${packages.map((p) => packageHtmlBlock(p, completeBundleUrl, options.portalStatusByPackage?.[p.packageName], returnByFor(p))).join('')}

  ${completeBundleUrl ? `
  <div style="border-top: 3px solid #1a1a1a; margin-top: 28px; padding-top: 8px;">
  <h2 style="font-size: 17px;">Complete tender document set</h2>
  <p>Everything issued with this tender, as a single download. Your package pack${many ? 's' : ''} above ${many ? 'are' : 'is'} a narrowed selection of it.</p>
  <p><a href="${esc(completeBundleUrl)}"><strong>Download the complete tender document set</strong></a></p>
  </div>` : ''}

  <p style="color: #888; font-size: 12px; margin-top: 24px;">Please raise all technical and commercial queries in writing before the return date.</p>

  <p style="margin-top: 24px;">Should you require any further information or clarifications, please do not hesitate to contact me.</p>
  <p>Yours faithfully,</p>
  <p><strong>${esc(letterContext.estimatorName ?? '')}</strong><br>On behalf of ${esc(letterContext.organizationName)}</p>
</div>
`;

  return { subject, html, text };
}
