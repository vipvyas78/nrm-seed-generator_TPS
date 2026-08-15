import { EmailService } from './emailService.js';

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

const to = arg('to');
const from = arg('from') ?? 'tenders@novamerx.ai';

if (!to) {
  console.error('Usage: pnpm --filter @tps/bff send-sample-itt --to=you@example.com [--from=tenders@novamerx.ai]');
  process.exit(1);
}

const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_EMAIL_TOKEN } = process.env;
if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_EMAIL_TOKEN) {
  console.error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_EMAIL_TOKEN must be set in .env — see .env.example.');
  process.exit(1);
}

const subject = 'Invitation to Tender — Drylining Package — [Project Name]';

const text = `INVITATION TO TENDER

Project:      [Project Name]
Package:      Drylining
Route:        Subcontract — Design & Build
Tender return: [Return Date], 12:00 noon

You are invited to tender for the Drylining package on the above project. Please find
enclosed the tender documents referenced below. Tenders must be returned by the date and
time stated above; late submissions will not be considered.

SCOPE OF WORKS (SUMMARY)
 - Metal stud partitions, including fire-rated and acoustic-rated systems
 - Plasterboard linings to walls and soffits, including moisture-resistant boards to wet areas
 - Suspended and fixed ceilings, including bulkheads and access panel coordination
 - Taping, jointing and finishing to Level 5 in client-facing areas
 - Insulation and fire-stopping associated with drylining elements
 - Attendance on M&E first and second fix as detailed in the attendance schedule

TENDER DOCUMENTS ENCLOSED
 - Bill of quantities (drylining package)
 - Drawings register and current issue drawings
 - Preliminaries and specification
 - Attendance schedule
 - Return form — house standard

SITE VISIT
A site visit can be arranged on request — contact the person below to book a slot.

RETURN INSTRUCTIONS
Please return your priced bill of quantities and completed return form by email to the
address this invitation was sent from, quoting the project reference in the subject line.

QUERIES
All technical and commercial queries should be raised in writing before the return date.

This is a sample Invitation to Tender for testing purposes. Figures, dates and project
details above are placeholders.

[Sender Name]
[Company Name]
`;

const html = `
<div style="font-family: Arial, Helvetica, sans-serif; max-width: 640px; margin: 0 auto; color: #1a1a1a;">
  <h1 style="font-size: 20px; margin-bottom: 4px;">Invitation to Tender</h1>
  <p style="color: #555; margin-top: 0;">Drylining Package — [Project Name]</p>

  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
    <tr><td style="padding: 4px 0; color: #555;">Project</td><td style="padding: 4px 0;">[Project Name]</td></tr>
    <tr><td style="padding: 4px 0; color: #555;">Package</td><td style="padding: 4px 0;">Drylining</td></tr>
    <tr><td style="padding: 4px 0; color: #555;">Route</td><td style="padding: 4px 0;">Subcontract — Design &amp; Build</td></tr>
    <tr><td style="padding: 4px 0; color: #555;">Tender return</td><td style="padding: 4px 0;"><strong>[Return Date], 12:00 noon</strong></td></tr>
  </table>

  <p>You are invited to tender for the Drylining package on the above project. Please find
  enclosed the tender documents referenced below. Tenders must be returned by the date and
  time stated above; late submissions will not be considered.</p>

  <h2 style="font-size: 15px;">Scope of works (summary)</h2>
  <ul>
    <li>Metal stud partitions, including fire-rated and acoustic-rated systems</li>
    <li>Plasterboard linings to walls and soffits, including moisture-resistant boards to wet areas</li>
    <li>Suspended and fixed ceilings, including bulkheads and access panel coordination</li>
    <li>Taping, jointing and finishing to Level 5 in client-facing areas</li>
    <li>Insulation and fire-stopping associated with drylining elements</li>
    <li>Attendance on M&amp;E first and second fix as detailed in the attendance schedule</li>
  </ul>

  <h2 style="font-size: 15px;">Tender documents enclosed</h2>
  <ul>
    <li>Bill of quantities (drylining package)</li>
    <li>Drawings register and current issue drawings</li>
    <li>Preliminaries and specification</li>
    <li>Attendance schedule</li>
    <li>Return form — house standard</li>
  </ul>

  <h2 style="font-size: 15px;">Site visit</h2>
  <p>A site visit can be arranged on request — contact the person below to book a slot.</p>

  <h2 style="font-size: 15px;">Return instructions</h2>
  <p>Please return your priced bill of quantities and completed return form by email to the
  address this invitation was sent from, quoting the project reference in the subject line.</p>

  <h2 style="font-size: 15px;">Queries</h2>
  <p>All technical and commercial queries should be raised in writing before the return date.</p>

  <p style="color: #888; font-size: 12px;">This is a sample Invitation to Tender for testing purposes. Figures, dates and
  project details above are placeholders.</p>

  <p>[Sender Name]<br>[Company Name]</p>
</div>
`;

const emailService = new EmailService({
  cloudflareApiToken: CLOUDFLARE_EMAIL_TOKEN,
  cloudflareAccountId: CLOUDFLARE_ACCOUNT_ID
});

const result = await emailService.send({ from, to, subject, html, text });
console.log('Sent:', result);
