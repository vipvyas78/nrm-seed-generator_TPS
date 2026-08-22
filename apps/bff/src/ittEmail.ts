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
}

export interface IttEmailOptions {
  projectName: string;
  /** Everything the tender pack contains, as one zip. The safety net beside each package pack. */
  completeBundleUrl: string | null;
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

const RULE = '='.repeat(78);

const packageTextBlock = (pack: IttEmailPack, completeBundleUrl: string | null): string => {
  const boqRows = boqRowsFor(pack);
  const billRows = billRowsFor(pack);
  const specRows = specRowsFor(pack);
  const requiredForms = pack.returnForms.filter((f) => f.isRequired);
  const optionalForms = pack.returnForms.filter((f) => !f.isRequired);

  return `${RULE}
PACKAGE: ${pack.packageName} (ref ${pack.displayRef})
Route:   ${pack.routeOfProcurement ?? 'Not stated'}
${RULE}

SCOPE OF WORKS
${scopeSentence(pack)}

BILL OF QUANTITIES
${boqIntro(pack)}

${boqRows.length > 0 ? textTable(BOQ_HEADERS, boqRows) : 'No measured lines are attributed to this package.'}
${billRows.length > 0 ? `\nBILL OF QUANTITIES — AUTHORED ITEMS\n${textTable(BILL_HEADERS, billRows)}\n` : ''}
${specRows.length > 0 ? `\nSPECIFICATION CLAUSES\n${textTable(SPEC_HEADERS, specRows)}\n` : ''}
${pack.specDocuments.length > 0 ? `SPECIFICATION REFERENCED BY THIS PACKAGE
${pack.specDocuments.map((d) => ` - ${d}`).join('\n')}

` : ''}DOCUMENTS FOR THIS PACKAGE
${pack.bundle
  ? ` - ${documentsSentence(pack, completeBundleUrl)}: ${pack.bundle.url}`
  : documentsSentence(pack, completeBundleUrl)}

TENDER RETURN — a compliant submission must contain
${requiredForms.length > 0 ? requiredForms.map((f) => ` - ${f.name}${f.description ? ` — ${f.description}` : ''}`).join('\n') : ' - See attached return forms.'}
${optionalForms.length > 0 ? `\nOptional:\n${optionalForms.map((f) => ` - ${f.name}`).join('\n')}` : ''}

SCHEDULE OF ATTENDANCES
${attendanceSentence(pack)}
${pack.valueEngineeringRequired ? `\nVALUE ENGINEERING\n${VALUE_ENGINEERING_SENTENCE}\n` : ''}`;
};

const packageHtmlBlock = (pack: IttEmailPack, completeBundleUrl: string | null): string => {
  const boqHtmlRows = boqRowsFor(pack).map((r) => r.map(esc));
  const billHtmlRows = billRowsFor(pack).map((r) => r.map(esc));
  const specHtmlRows = specRowsFor(pack).map((r) => r.map(esc));
  const requiredForms = pack.returnForms.filter((f) => f.isRequired);
  const optionalForms = pack.returnForms.filter((f) => !f.isRequired);

  return `
  <div style="border-top: 3px solid #1a1a1a; margin-top: 28px; padding-top: 8px;">
  <h2 style="font-size: 17px; margin-bottom: 2px;">${esc(pack.packageName)} <span style="color:#888; font-weight: normal;">(ref ${esc(pack.displayRef)})</span></h2>
  <p style="color: #555; margin-top: 0; font-size: 13px;">Route: ${esc(pack.routeOfProcurement ?? 'Not stated')}</p>

  <h3 style="font-size: 15px;">Scope of works</h3>
  <p>${esc(scopeSentence(pack))}</p>

  <h3 style="font-size: 15px;">Bill of quantities</h3>
  <p>${esc(boqIntro(pack))}</p>
  ${boqHtmlRows.length > 0 ? htmlTable(BOQ_HEADERS, boqHtmlRows) : '<p>No measured lines are attributed to this package.</p>'}

  ${billHtmlRows.length > 0 ? `
  <h3 style="font-size: 15px;">Bill of quantities — authored items</h3>
  ${htmlTable(BILL_HEADERS, billHtmlRows)}` : ''}

  ${specHtmlRows.length > 0 ? `
  <h3 style="font-size: 15px;">Specification clauses</h3>
  ${htmlTable(SPEC_HEADERS, specHtmlRows)}` : ''}

  ${pack.specDocuments.length > 0 ? `
  <h3 style="font-size: 15px;">Specification referenced by this package</h3>
  <p style="font-size: 13px;">The measured lines above were read from these documents. They are issued with the document pack below.</p>
  <ul>${pack.specDocuments.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}

  <h3 style="font-size: 15px;">Documents for this package</h3>
  ${pack.bundle
    ? `<p><a href="${esc(pack.bundle.url)}"><strong>Download the ${esc(pack.packageName)} document pack</strong></a><br>
       <span style="color:#555; font-size: 13px;">${esc(bundleSentence(pack.bundle))}.</span></p>`
    : `<p>${esc(documentsSentence(pack, completeBundleUrl))}</p>`}

  <h3 style="font-size: 15px;">Tender return — a compliant submission must contain</h3>
  ${requiredForms.length > 0
    ? `<ul>${requiredForms.map((f) => `<li><strong>${esc(f.name)}</strong>${f.description ? ` — ${esc(f.description)}` : ''}</li>`).join('')}</ul>`
    : '<p>See attached return forms.</p>'}
  ${optionalForms.length > 0 ? `<p style="color:#555;">Optional: ${optionalForms.map((f) => esc(f.name)).join(', ')}</p>` : ''}

  <h3 style="font-size: 15px;">Schedule of attendances</h3>
  <p>${esc(attendanceSentence(pack))}</p>

  ${pack.valueEngineeringRequired ? `
  <h3 style="font-size: 15px;">Value Engineering</h3>
  <p><strong>Mandatory.</strong> ${esc(VALUE_ENGINEERING_SENTENCE)}</p>` : ''}
  </div>`;
};

export function renderIttEmail(
  packages: IttEmailPack[],
  recipient: IttEmailRecipient,
  options: IttEmailOptions
): { subject: string; html: string; text: string } {
  const { projectName, completeBundleUrl } = options;
  const many = packages.length > 1;
  const subject = many
    ? `Invitation to Tender — ${packages.length} packages — ${projectName}`
    : `Invitation to Tender — ${packages[0]?.packageName ?? 'Tender'} — ${projectName}`;
  const greeting = recipient.name ? `Dear ${recipient.name},` : 'Dear Sir/Madam,';
  const packageList = packages.map((p) => `${p.packageName} (ref ${p.displayRef})`);

  const intro = many
    ? `You are invited to tender for the ${packages.length} packages listed below. Each package is set out in full — its scope of works, bill of quantities, document pack and return requirements — and each carries its own attached scope of works and pricing schedule. Please price each package separately.`
    : 'You are invited to tender for the package below. Please find its scope of works, bill of quantities, the documents this invitation carries and what a compliant return must contain. The scope of works and a pricing schedule are attached.';

  const completeTextBlock = completeBundleUrl
    ? `\nCOMPLETE TENDER DOCUMENT SET\nEverything issued with this tender, as a single download. Your package pack${many ? 's' : ''} above ${many ? 'are' : 'is'} a narrowed selection of it.\n - ${completeBundleUrl}\n`
    : '';

  const text = `INVITATION TO TENDER

Project:  ${projectName}
Package${many ? 's' : ''}: ${packageList.join('\n          ')}

${greeting}

${intro}

${packages.map((p) => packageTextBlock(p, completeBundleUrl)).join('\n')}
${completeTextBlock}
Please raise all technical and commercial queries in writing before the return date.
`;

  const html = `
<div style="font-family: Arial, Helvetica, sans-serif; max-width: 640px; margin: 0 auto; color: #1a1a1a;">
  <h1 style="font-size: 20px; margin-bottom: 4px;">Invitation to Tender</h1>
  <p style="color: #555; margin-top: 0;">${esc(projectName)}</p>

  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
    <tr><td style="padding: 4px 0; color: #555; vertical-align: top;">Project</td><td style="padding: 4px 0;">${esc(projectName)}</td></tr>
    <tr><td style="padding: 4px 0; color: #555; vertical-align: top;">Package${many ? 's' : ''}</td><td style="padding: 4px 0;">${packageList.map(esc).join('<br>')}</td></tr>
  </table>

  <p>${esc(greeting)}</p>

  <p>${esc(intro)}</p>

  ${packages.map((p) => packageHtmlBlock(p, completeBundleUrl)).join('')}

  ${completeBundleUrl ? `
  <div style="border-top: 3px solid #1a1a1a; margin-top: 28px; padding-top: 8px;">
  <h2 style="font-size: 17px;">Complete tender document set</h2>
  <p>Everything issued with this tender, as a single download. Your package pack${many ? 's' : ''} above ${many ? 'are' : 'is'} a narrowed selection of it.</p>
  <p><a href="${esc(completeBundleUrl)}"><strong>Download the complete tender document set</strong></a></p>
  </div>` : ''}

  <p style="color: #888; font-size: 12px; margin-top: 24px;">Please raise all technical and commercial queries in writing before the return date.</p>
</div>
`;

  return { subject, html, text };
}
