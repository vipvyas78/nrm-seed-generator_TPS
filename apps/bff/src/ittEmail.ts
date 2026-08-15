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

export interface IttEmailPack {
  packageName: string;
  displayRef: string;
  projectName: string;
  routeOfProcurement: string | null;
  returnForms: Array<{ name: string; description: string | null; isRequired: boolean }>;
  boqSummary: { total: number; priceable: number; authored: number };
  scopeItems: Array<{ description: string }>;
  attendanceSummary: { subcontractor: number; mainContractor: number; joint: number };
  valueEngineeringRequired: boolean;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderIttEmail(
  pack: IttEmailPack,
  recipient: IttEmailRecipient,
  documentLinks: IttEmailDocumentLink[]
): { subject: string; html: string; text: string } {
  const subject = `Invitation to Tender — ${pack.packageName} — ${pack.projectName}`;
  const greeting = recipient.name ? `Dear ${recipient.name},` : 'Dear Sir/Madam,';

  const requiredForms = pack.returnForms.filter((f) => f.isRequired);
  const optionalForms = pack.returnForms.filter((f) => !f.isRequired);

  const scopeLines = pack.scopeItems.slice(0, 20).map((s) => s.description);
  const scopeOverflow = pack.scopeItems.length - scopeLines.length;

  const text = `INVITATION TO TENDER

Project:  ${pack.projectName}
Package:  ${pack.packageName} (ref ${pack.displayRef})
Route:    ${pack.routeOfProcurement ?? 'Not stated'}

${greeting}

You are invited to tender for the above package. Please find below the scope of works
summary, the bill of quantities coverage, the documents this invitation carries and what a
compliant return must contain.

SCOPE OF WORKS (SUMMARY)
${scopeLines.length > 0 ? scopeLines.map((s) => ` - ${s}`).join('\n') : ' - See attached scope of works matrix.'}
${scopeOverflow > 0 ? ` ...and ${scopeOverflow} more item${scopeOverflow === 1 ? '' : 's'}.\n` : ''}
BILL OF QUANTITIES
${pack.boqSummary.total} measured lines attributed to this package (${pack.boqSummary.priceable} carrying a quantity), plus ${pack.boqSummary.authored} authored line${pack.boqSummary.authored === 1 ? '' : 's'}. Rates are not shown — please price independently.

TENDER DOCUMENTS
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

  <p>You are invited to tender for the above package. Please find below the scope of works
  summary, the bill of quantities coverage, the documents this invitation carries and what a
  compliant return must contain.</p>

  <h2 style="font-size: 15px;">Scope of works (summary)</h2>
  ${scopeLines.length > 0
    ? `<ul>${scopeLines.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>${scopeOverflow > 0 ? `<p style="color:#888;font-size:12px;">...and ${scopeOverflow} more item${scopeOverflow === 1 ? '' : 's'}.</p>` : ''}`
    : '<p>See attached scope of works matrix.</p>'}

  <h2 style="font-size: 15px;">Bill of quantities</h2>
  <p>${pack.boqSummary.total} measured lines attributed to this package (${pack.boqSummary.priceable} carrying a quantity), plus
  ${pack.boqSummary.authored} authored line${pack.boqSummary.authored === 1 ? '' : 's'}. Rates are not shown — please price independently.</p>

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
