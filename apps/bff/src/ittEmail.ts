/**
 * Renders the Invitation to Tender email body for one recipient of one package.
 *
 * Pure function: every fact it prints comes from the pack passed in. It does not re-derive
 * scope, BoQ attribution or forms/attendances — that assembly already exists in
 * `getPackageItt` and stays there. The caller is responsible for filtering out anything
 * marked "Ignore for ITT" before this runs; this file has no notion of overrides.
 */
export interface IttEmailRecipient {
  name: string | null;
  email: string;
}

export interface IttEmailDocumentLink {
  displayName: string;
  url: string;
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
  projectName: string;
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
   * Distinct from `documentLinks`, which is every tender document issued with the project.
   * This says which of them the take-off actually measured against, and it is the one a
   * tenderer pricing this trade opens first.
   */
  specDocuments: string[];
  attendanceSummary: { subcontractor: number; mainContractor: number; joint: number };
  valueEngineeringRequired: boolean;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const stageLabel = (stage: string | null): string => {
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

export function renderIttEmail(
  pack: IttEmailPack,
  recipient: IttEmailRecipient,
  documentLinks: IttEmailDocumentLink[]
): { subject: string; html: string; text: string } {
  const subject = `Invitation to Tender — ${pack.packageName} — ${pack.projectName}`;
  const greeting = recipient.name ? `Dear ${recipient.name},` : 'Dear Sir/Madam,';

  const requiredForms = pack.returnForms.filter((f) => f.isRequired);
  const optionalForms = pack.returnForms.filter((f) => !f.isRequired);

  // The scope of works prints exactly as the client's own trade scope sheets do: grouped
  // under subheadings, in the order the library gives them, numbered straight through.
  //
  // The caller supplies the items ALREADY ORDERED by section — this only has to detect
  // where one section ends and the next begins. Re-sorting here would need this file to
  // hold a second opinion about section order, and the two would drift the first time a
  // client reordered their sections in the config editor.
  //
  // The number is assigned HERE, per package, not carried from the library. A clause's
  // number is a position in one document: the same clause is item 29 in one trade's scope
  // and item 43 in another's, and a bill referring to "item 29" has to mean the 29th line
  // of the scope the tenderer was actually sent.
  let scopeNumber = 0;
  const scopeSections: Array<{ section: string; lines: Array<{ number: number; text: string }> }> = [];
  for (const item of pack.scopeItems) {
    scopeNumber += 1;
    const text = `${item.description}${item.procurementStage ? ` (${stageLabel(item.procurementStage)})` : ''}`;
    const current = scopeSections[scopeSections.length - 1];
    if (current && current.section === item.section) current.lines.push({ number: scopeNumber, text });
    else scopeSections.push({ section: item.section, lines: [{ number: scopeNumber, text }] });
  }

  const scopeText = scopeSections
    .map((group) => `${group.section}\n${group.lines.map((l) => `  ${String(l.number).padStart(3)}  ${l.text}`).join('\n')}`)
    .join('\n\n');

  const scopeHtml = scopeSections.map((group) => `
  <h3 style="font-size: 13px; margin: 14px 0 4px;">${esc(group.section)}</h3>
  <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
    <tbody>${group.lines.map((l) => `<tr>
      <td style="width: 34px; vertical-align: top; padding: 2px 6px 2px 0; color: #888;">${l.number}</td>
      <td style="vertical-align: top; padding: 2px 0;">${esc(l.text)}</td>
    </tr>`).join('')}</tbody>
  </table>`).join('');

  const boqHeaders = ['GE Code', 'Element', 'Description', 'Qty', 'Unit'];
  const boqRows = pack.boqLines.map((l) => [l.geCode ?? '—', l.elementCode ?? '—', l.description, qty(l.quantity), l.unit ?? '—']);
  const boqHtmlRows = boqRows.map((r) => r.map(esc));

  const billHeaders = ['Ref', 'Section', 'Description', 'Qty', 'Unit', 'Required for'];
  const billRows = pack.billLines.map((l) => [l.ref ?? '—', l.section ?? '—', l.description, qty(l.quantity), l.unit ?? '—', l.requiredFor ?? '—']);
  const billHtmlRows = billRows.map((r) => r.map(esc));

  const specHeaders = ['GE Code', 'Element / Sub-element', 'Clause'];
  const specRows = pack.specClauses.map((c) => [c.geCode ?? '—', [c.elementCode, c.subElementCode].filter(Boolean).join(' / ') || '—', c.rawText]);
  const specHtmlRows = specRows.map((r) => r.map(esc));

  const text = `INVITATION TO TENDER

Project:  ${pack.projectName}
Package:  ${pack.packageName} (ref ${pack.displayRef})
Route:    ${pack.routeOfProcurement ?? 'Not stated'}

${greeting}

You are invited to tender for the above package. Please find below the scope of works,
the bill of quantities coverage, the documents this invitation carries and what a
compliant return must contain.

SCOPE OF WORKS
${scopeSections.length > 0 ? scopeText : ' - See attached scope of works matrix.'}

BILL OF QUANTITIES
${pack.boqSummary.total} measured lines attributed to this package (${pack.boqSummary.priceable} carrying a quantity), plus ${pack.boqSummary.authored} authored line${pack.boqSummary.authored === 1 ? '' : 's'}. Rates are not shown — please price independently.

${boqRows.length > 0 ? textTable(boqHeaders, boqRows) : 'See attached bill of quantities.'}
${billRows.length > 0 ? `\nBILL OF QUANTITIES — AUTHORED ITEMS\n${textTable(billHeaders, billRows)}\n` : ''}
${specRows.length > 0 ? `\nSPECIFICATION CLAUSES\n${textTable(specHeaders, specRows)}\n` : ''}
${pack.specDocuments.length > 0 ? `SPECIFICATION REFERENCED BY THIS PACKAGE
${pack.specDocuments.map((d) => ` - ${d}`).join('\n')}

` : ''}TENDER DOCUMENTS
${documentLinks.length > 0
  ? documentLinks.map((d) => ` - ${d.displayName}: ${d.url}`).join('\n')
  : ' - No documents are available to link at this time.'}

TENDER RETURN — a compliant submission must contain
${requiredForms.length > 0 ? requiredForms.map((f) => ` - ${f.name}${f.description ? ` — ${f.description}` : ''}`).join('\n') : ' - See attached return forms.'}
${optionalForms.length > 0 ? `\nOptional:\n${optionalForms.map((f) => ` - ${f.name}`).join('\n')}` : ''}

SCHEDULE OF ATTENDANCES
${pack.attendanceSummary.subcontractor} item${pack.attendanceSummary.subcontractor === 1 ? '' : 's'} carried by the subcontractor, ${pack.attendanceSummary.mainContractor} by the main contractor${pack.attendanceSummary.joint > 0 ? `, ${pack.attendanceSummary.joint} joint` : ''}.

${pack.valueEngineeringRequired ? 'VALUE ENGINEERING\nEvery tenderer must submit at least one Value Engineering proposal stating the saving, the programme effect, any departure from the specification and the clause affected. A return without one is not compliant.\n' : ''}
Please raise all technical and commercial queries in writing before the return date.
`;

  const html = `
<div style="font-family: Arial, Helvetica, sans-serif; max-width: 640px; margin: 0 auto; color: #1a1a1a;">
  <h1 style="font-size: 20px; margin-bottom: 4px;">Invitation to Tender</h1>
  <p style="color: #555; margin-top: 0;">${esc(pack.packageName)} — ${esc(pack.projectName)}</p>

  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
    <tr><td style="padding: 4px 0; color: #555;">Project</td><td style="padding: 4px 0;">${esc(pack.projectName)}</td></tr>
    <tr><td style="padding: 4px 0; color: #555;">Package</td><td style="padding: 4px 0;">${esc(pack.packageName)} (ref ${esc(pack.displayRef)})</td></tr>
    <tr><td style="padding: 4px 0; color: #555;">Route</td><td style="padding: 4px 0;">${esc(pack.routeOfProcurement ?? 'Not stated')}</td></tr>
  </table>

  <p>${esc(greeting)}</p>

  <p>You are invited to tender for the above package. Please find below the scope of works,
  the bill of quantities coverage, the documents this invitation carries and what a
  compliant return must contain.</p>

  <h2 style="font-size: 15px;">Scope of works</h2>
  ${scopeSections.length > 0 ? scopeHtml : '<p>See attached scope of works matrix.</p>'}

  <h2 style="font-size: 15px;">Bill of quantities</h2>
  <p>${pack.boqSummary.total} measured lines attributed to this package (${pack.boqSummary.priceable} carrying a quantity), plus
  ${pack.boqSummary.authored} authored line${pack.boqSummary.authored === 1 ? '' : 's'}. Rates are not shown — please price independently.</p>
  ${boqHtmlRows.length > 0 ? htmlTable(boqHeaders, boqHtmlRows) : '<p>See attached bill of quantities.</p>'}

  ${billHtmlRows.length > 0 ? `
  <h2 style="font-size: 15px;">Bill of quantities — authored items</h2>
  ${htmlTable(billHeaders, billHtmlRows)}` : ''}

  ${specHtmlRows.length > 0 ? `
  <h2 style="font-size: 15px;">Specification clauses</h2>
  ${htmlTable(specHeaders, specHtmlRows)}` : ''}

  ${pack.specDocuments.length > 0 ? `
  <h2 style="font-size: 15px;">Specification referenced by this package</h2>
  <p style="font-size: 13px;">The measured lines above were read from these documents. They are issued with the full document schedule below.</p>
  <ul>${pack.specDocuments.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}

  <h2 style="font-size: 15px;">Tender documents</h2>
  ${documentLinks.length > 0
    ? `<ul>${documentLinks.map((d) => `<li><a href="${esc(d.url)}">${esc(d.displayName)}</a></li>`).join('')}</ul>`
    : '<p>No documents are available to link at this time.</p>'}

  <h2 style="font-size: 15px;">Tender return — a compliant submission must contain</h2>
  ${requiredForms.length > 0
    ? `<ul>${requiredForms.map((f) => `<li><strong>${esc(f.name)}</strong>${f.description ? ` — ${esc(f.description)}` : ''}</li>`).join('')}</ul>`
    : '<p>See attached return forms.</p>'}
  ${optionalForms.length > 0 ? `<p style="color:#555;">Optional: ${optionalForms.map((f) => esc(f.name)).join(', ')}</p>` : ''}

  <h2 style="font-size: 15px;">Schedule of attendances</h2>
  <p>${pack.attendanceSummary.subcontractor} item${pack.attendanceSummary.subcontractor === 1 ? '' : 's'} carried by the subcontractor,
  ${pack.attendanceSummary.mainContractor} by the main contractor${pack.attendanceSummary.joint > 0 ? `, ${pack.attendanceSummary.joint} joint` : ''}.</p>

  ${pack.valueEngineeringRequired ? `
  <h2 style="font-size: 15px;">Value Engineering</h2>
  <p><strong>Mandatory.</strong> Every tenderer must submit at least one Value Engineering proposal stating the
  saving, the programme effect, any departure from the specification and the clause affected. A return without
  one is not compliant.</p>` : ''}

  <p style="color: #888; font-size: 12px;">Please raise all technical and commercial queries in writing before the return date.</p>
</div>
`;

  return { subject, html, text };
}
