import { subjectMarker } from './inboundEmail.js';

/**
 * Renders one email bundling every open query an estimator has raised against ONE
 * subcontractor's return — the issue's own closing step: "the estimator should ... get in
 * touch with the respective subcontractors to raise any queries he may have on the quotes
 * or on the pricing."
 *
 * Pure, with no I/O — the same split reminderEmail.ts and addendumEmail.ts keep, so this is
 * unit-tested without a database or a mail provider. Bundled rather than one email per
 * question: a subcontractor gets one message listing everything outstanding against their
 * quote, not a flood of single-line emails for one return.
 */

export interface QuoteQueryEmailContext {
  firmName: string;
  packageName: string;
  tenderName: string | null;
  estimatorName: string | null;
  /** In the order they should read, newest last. At least one — an email with nothing to
   *  ask is never sent (the caller's job to ensure). */
  questions: string[];
  /** The outbound message's own id, so a reply lands back on this conversation — the same
   *  convention reminderEmail.ts and addendumEmail.ts already use. */
  replyToken: string;
}

export interface RenderedQuoteQueryEmail {
  /** With the reply marker — what is actually sent. */
  subject: string;
  /** Without it — what the timeline records. */
  subjectCore: string;
  html: string;
  text: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function renderQuoteQueryEmail(context: QuoteQueryEmailContext, opts: { testMode?: boolean } = {}): RenderedQuoteQueryEmail {
  const tender = context.tenderName ? ` — ${context.tenderName}` : '';
  const subjectCore = `Query on your ${context.packageName} quote${tender}`;
  const greeting = `Dear ${context.firmName},`;
  const intro = context.questions.length === 1
    ? `We have a query on your quote for ${context.packageName}:`
    : `We have ${context.questions.length} queries on your quote for ${context.packageName}:`;
  const list = context.questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
  const closing = 'Please reply to this email, or get in touch directly, with your response.';
  const sign = context.estimatorName ? `\n\nRegards,\n${context.estimatorName}` : '';

  const text = `${greeting}\n\n${intro}\n\n${list}\n\n${closing}${sign}`.trim();

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#111827">
      <p>${escapeHtml(greeting)}</p>
      <p>${escapeHtml(intro)}</p>
      <ol>${context.questions.map((q) => `<li>${escapeHtml(q)}</li>`).join('')}</ol>
      <p>${escapeHtml(closing)}</p>
      ${context.estimatorName ? `<p>Regards,<br>${escapeHtml(context.estimatorName)}</p>` : ''}
    </div>`.trim();

  const subject = `${opts.testMode ? '[TEST] ' : ''}${subjectCore} ${subjectMarker(context.replyToken)}`;
  return { subject, subjectCore, html, text };
}
