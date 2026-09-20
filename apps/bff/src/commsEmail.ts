import { subjectMarker } from './inboundEmail.js';

/**
 * The two emails the RFI loop sends: a collated set of subcontractor queries put to the
 * Client, and the Client's answer relayed back to the firms that asked.
 *
 * Pure functions returning `{ subject, html, text }`, with no I/O and no database — the
 * same split `ittEmail.ts` keeps, so both are unit-tested in CI, which has neither.
 *
 * Both carry a `[TPS-<token>]` subject marker. It is not decoration: plus-addressing does
 * not survive every mail system, so the marker is the second of three ways a reply finds
 * its way back to the question it answers (see findReplyToken).
 */

export interface ForwardedQuery {
  /** The firm the query belongs to. */
  firmName: string;
  /** Who actually wrote it, which is routinely not the firm's named estimator. */
  authorName: string | null;
  authorEmail: string | null;
  packageName: string | null;
  subject: string | null;
  body: string;
  raisedAt: Date;
  attachmentCount: number;
}

export interface ForwardEmailContext {
  projectName: string | null;
  tenderReference: string | null;
  /** Who is asking, so the Client knows who to answer. */
  estimatorName: string | null;
  estimatorEmail: string | null;
  organizationName: string | null;
  /** The bearer token on the Client's in-app reply link, and the marker in the subject. */
  replyToken: string;
  /** Absolute URL of the in-app reply page. Null when no link could be issued — the email
   *  still goes, and says so, rather than silently offering only one route back. */
  replyUrl: string | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** Escapes text destined for an HTML body. Every value here came from outside the
 *  organisation — a subcontractor typed it, or a mail client sent it — so none of it is
 *  trusted markup. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function authorLine(query: ForwardedQuery): string {
  const who = query.authorName ?? query.authorEmail ?? 'a member of their team';
  const address = query.authorName && query.authorEmail ? ` (${query.authorEmail})` : '';
  return `${query.firmName} — ${who}${address}`;
}

/**
 * A collated set of queries put to the Client.
 *
 * Numbered, because the answer that comes back refers to them by number and there is
 * otherwise nothing to refer to. The firm and the person are both named: the Client is
 * being asked to answer a question, and who asked it changes how much context they need.
 *
 * The queries are NOT merged or summarised. What the subcontractor wrote is what the
 * Client sees, because a paraphrase that loses a qualification is exactly the failure
 * this whole loop exists to prevent.
 */
export function renderRfiForwardEmail(
  queries: ForwardedQuery[], context: ForwardEmailContext
): RenderedEmail {
  const project = context.projectName ?? 'the project';
  const reference = context.tenderReference ? ` (${context.tenderReference})` : '';
  const count = queries.length;
  const subject = `${count} tender ${count === 1 ? 'query' : 'queries'} — ${project}${reference} ${subjectMarker(context.replyToken)}`;

  const intro = count === 1
    ? `We have received the following query from a subcontractor pricing ${project}${reference}, and would be grateful for your response.`
    : `We have received the following ${count} queries from subcontractors pricing ${project}${reference}, and would be grateful for your responses.`;

  const replyInstruction = context.replyUrl
    ? 'You can answer by replying to this email, or by opening the link below.'
    // Named, not silent: the recipient should know there is only one route back rather
    // than wonder where the link went.
    : 'Please answer by replying to this email. (No in-app link could be issued for this message.)';

  const signoff = context.estimatorName
    ? `${context.estimatorName}${context.organizationName ? `\n${context.organizationName}` : ''}`
    : context.organizationName ?? '';

  const textQueries = queries.map((query, index) => [
    `${index + 1}. ${authorLine(query)}`,
    query.packageName ? `   Package: ${query.packageName}` : null,
    query.subject ? `   Subject: ${query.subject}` : null,
    `   Raised: ${formatDate(query.raisedAt)}`,
    query.attachmentCount > 0
      ? `   Attachments: ${query.attachmentCount} (available in the tender system)`
      : null,
    '',
    query.body.split('\n').map((line) => `   ${line}`).join('\n'),
    ''
  ].filter((line) => line !== null).join('\n')).join('\n');

  const text = [
    intro, '', textQueries, replyInstruction,
    context.replyUrl ? `\n${context.replyUrl}\n` : '',
    signoff ? `\n${signoff}` : ''
  ].join('\n');

  const htmlQueries = queries.map((query, index) => `
    <li style="margin-bottom:18px">
      <div><strong>${escapeHtml(authorLine(query))}</strong></div>
      ${query.packageName ? `<div style="color:#6b7280;font-size:13px">Package: ${escapeHtml(query.packageName)}</div>` : ''}
      ${query.subject ? `<div style="color:#6b7280;font-size:13px">Subject: ${escapeHtml(query.subject)}</div>` : ''}
      <div style="color:#6b7280;font-size:13px">Raised: ${formatDate(query.raisedAt)}</div>
      ${query.attachmentCount > 0 ? `<div style="color:#6b7280;font-size:13px">${query.attachmentCount} attachment${query.attachmentCount === 1 ? '' : 's'} (available in the tender system)</div>` : ''}
      <div style="white-space:pre-wrap;margin-top:8px">${escapeHtml(query.body)}</div>
    </li>`).join('');

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#111827">
      <p>${escapeHtml(intro)}</p>
      <ol style="padding-left:20px">${htmlQueries}</ol>
      <p>${escapeHtml(replyInstruction)}</p>
      ${context.replyUrl ? `<p><a href="${escapeHtml(context.replyUrl)}">Answer these queries</a></p>` : ''}
      ${signoff ? `<p style="white-space:pre-wrap">${escapeHtml(signoff)}</p>` : ''}
    </div>`.trim();

  return { subject, html, text };
}

export interface RelayEmailContext {
  projectName: string | null;
  packageName: string | null;
  /** The question this answers, quoted back so the recipient does not have to remember. */
  originalQuery: string;
  originalSubject: string | null;
  clientAnswer: string;
  answeredOn: Date;
  estimatorName: string | null;
  organizationName: string | null;
  /** The pricing portal, where the whole conversation lives. Null when the firm has no
   *  live link — they still get the answer. */
  portalUrl: string | null;
  /** Lets a further question from this firm come back to the same conversation. */
  replyToken: string;
}

/**
 * The Client's answer relayed back to the firm that asked.
 *
 * The original question is quoted above the answer. The firm asked it weeks ago and is
 * pricing several packages; an answer with no question attached is one more thing for
 * them to work out, and a tender query answered ambiguously is a variation later.
 */
export function renderClientAnswerRelayEmail(context: RelayEmailContext): RenderedEmail {
  const project = context.projectName ?? 'the project';
  const subjectCore = context.originalSubject
    ? `Re: ${context.originalSubject}`
    : `Response to your tender query — ${project}`;
  const subject = `${subjectCore} ${subjectMarker(context.replyToken)}`;

  const intro = `The client has responded to your query on ${project}${context.packageName ? ` (${context.packageName})` : ''}.`;
  const signoff = context.estimatorName
    ? `${context.estimatorName}${context.organizationName ? `\n${context.organizationName}` : ''}`
    : context.organizationName ?? '';

  const text = [
    intro, '',
    'Your query:',
    context.originalQuery.split('\n').map((line) => `   ${line}`).join('\n'), '',
    `Client response (${formatDate(context.answeredOn)}):`,
    context.clientAnswer.split('\n').map((line) => `   ${line}`).join('\n'), '',
    context.portalUrl ? `The full conversation is on your pricing page:\n${context.portalUrl}\n` : '',
    'If anything is still unclear, reply to this email and we will put it back to the client.',
    signoff ? `\n${signoff}` : ''
  ].join('\n');

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#111827">
      <p>${escapeHtml(intro)}</p>
      <div style="border-left:3px solid #e5e7eb;padding-left:12px;color:#6b7280;white-space:pre-wrap">${escapeHtml(context.originalQuery)}</div>
      <p style="margin-top:16px"><strong>Client response (${formatDate(context.answeredOn)}):</strong></p>
      <div style="white-space:pre-wrap">${escapeHtml(context.clientAnswer)}</div>
      ${context.portalUrl ? `<p style="margin-top:16px">The full conversation is on <a href="${escapeHtml(context.portalUrl)}">your pricing page</a>.</p>` : ''}
      <p>If anything is still unclear, reply to this email and we will put it back to the client.</p>
      ${signoff ? `<p style="white-space:pre-wrap">${escapeHtml(signoff)}</p>` : ''}
    </div>`.trim();

  return { subject, html, text };
}
