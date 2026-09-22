import { subjectMarker } from './inboundEmail.js';

/**
 * The three emails the RFI loop sends: a collated set of subcontractor queries put to
 * the Client, the Client's answer relayed back to the firms that asked, and — since
 * issue #48 — the app's own answer sent straight back to the firm that raised it.
 *
 * Pure functions returning `{ subject, html, text }`, with no I/O and no database — the
 * same split `ittEmail.ts` keeps, so all three are unit-tested in CI, which has neither.
 *
 * All three carry a `[TPS-<token>]` subject marker. It is not decoration: plus-addressing
 * does not survive every mail system, so the marker is the second of three ways a reply
 * finds its way back to the question it answers (see findReplyToken).
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
  tenderName: string | null;
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
  const tender = context.tenderName ?? 'the tender';
  const reference = context.tenderReference ? ` (${context.tenderReference})` : '';
  const count = queries.length;
  const subject = `${count} tender ${count === 1 ? 'query' : 'queries'} — ${tender}${reference} ${subjectMarker(context.replyToken)}`;

  const intro = count === 1
    ? `We have received the following query from a subcontractor pricing ${tender}${reference}, and would be grateful for your response.`
    : `We have received the following ${count} queries from subcontractors pricing ${tender}${reference}, and would be grateful for your responses.`;

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
  tenderName: string | null;
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
  const tender = context.tenderName ?? 'the tender';
  const subjectCore = context.originalSubject
    ? `Re: ${context.originalSubject}`
    : `Response to your tender query — ${tender}`;
  const subject = `${subjectCore} ${subjectMarker(context.replyToken)}`;

  const intro = `The client has responded to your query on ${tender}${context.packageName ? ` (${context.packageName})` : ''}.`;
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

/**
 * A citation as it may go in an EMAIL, not the full shape a citation carries in the app.
 *
 * Structurally, not just by convention: `RfiCitation` (rfiReview.ts) also carries
 * `passageId`, `documentId`, `quotedText` and `shareUrl`, and `shareUrl` in particular is
 * a BuildFlow link behind Cloudflare Access for OUR users — in a subcontractor's inbox it
 * is a dead link at best and a leak at worst. Narrowing the type here, rather than simply
 * not referencing the field, means a caller cannot pass it through by accident: there is
 * nowhere in this file's code for it to go even if one tried.
 */
export interface RfiAnswerCitation {
  filename: string;
  headingPath: string | null;
  pageHint: number | null;
}

export interface RfiAnswer {
  question: string;
  /** What the app is sending. Never empty — the caller refuses to send a question with
   *  nothing to say, the same rule `resolveAnswer` (rfiReview.ts) enforces before this is
   *  ever called. */
  answer: string;
  citations: RfiAnswerCitation[];
}

export interface RfiResponseEmailContext {
  tenderName: string | null;
  packageName: string | null;
  estimatorName: string | null;
  organizationName: string | null;
  /** The pricing portal, where the whole conversation lives — same field, same meaning,
   *  as RelayEmailContext's. Null when the firm has no live link; they still get the
   *  answer by email. */
  portalUrl: string | null;
  replyToken: string;
}

function citationLine(citation: RfiAnswerCitation): string {
  const heading = citation.headingPath ? ` — ${citation.headingPath}` : '';
  const page = citation.pageHint != null ? ` (p${citation.pageHint})` : '';
  return `Source: ${citation.filename}${heading}${page}`;
}

/**
 * The app's own answer, sent straight back to the firm that raised the question — the
 * SEND half of issue #48, as distinct from `renderRfiForwardEmail` above (which puts a
 * question TO the Client) and `renderClientAnswerRelayEmail` (which relays the Client's
 * OWN words back). Numbered for the same reason the forward is: several questions from
 * one firm answered in one email need something for a follow-up to refer back to.
 *
 * A citation is named — filename, section, page — so a subcontractor pricing from this
 * answer can check it against their own copy of the document, rather than having to
 * trust it. It is never a link (see RfiAnswerCitation's own doc comment).
 */
export function renderRfiResponseEmail(
  answers: RfiAnswer[], context: RfiResponseEmailContext
): RenderedEmail {
  const tender = context.tenderName ?? 'the tender';
  const packageSuffix = context.packageName ? ` (${context.packageName})` : '';
  const count = answers.length;
  const subject = `Response to your ${count === 1 ? 'query' : 'queries'} — ${tender} ${subjectMarker(context.replyToken)}`;

  const intro = count === 1
    ? `Here is the answer to your query on ${tender}${packageSuffix}.`
    : `Here are the answers to your ${count} queries on ${tender}${packageSuffix}.`;

  const signoff = context.estimatorName
    ? `${context.estimatorName}${context.organizationName ? `\n${context.organizationName}` : ''}`
    : context.organizationName ?? '';

  const textAnswers = answers.map((item, index) => [
    `${index + 1}. ${item.question}`,
    '',
    item.answer.split('\n').map((line) => `   ${line}`).join('\n'),
    ...item.citations.map((citation) => `   ${citationLine(citation)}`),
    ''
  ].join('\n')).join('\n');

  const text = [
    intro, '', textAnswers,
    context.portalUrl ? `The full conversation is on your pricing page:\n${context.portalUrl}\n` : '',
    'If anything is still unclear, reply to this email and we will look into it.',
    signoff ? `\n${signoff}` : ''
  ].join('\n');

  const htmlAnswers = answers.map((item) => `
    <li style="margin-bottom:18px">
      <div><strong>${escapeHtml(item.question)}</strong></div>
      <div style="white-space:pre-wrap;margin-top:8px">${escapeHtml(item.answer)}</div>
      ${item.citations.map((citation) =>
        `<div style="color:#6b7280;font-size:13px;margin-top:4px">${escapeHtml(citationLine(citation))}</div>`
      ).join('')}
    </li>`).join('');

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#111827">
      <p>${escapeHtml(intro)}</p>
      <ol style="padding-left:20px">${htmlAnswers}</ol>
      ${context.portalUrl ? `<p>The full conversation is on <a href="${escapeHtml(context.portalUrl)}">your pricing page</a>.</p>` : ''}
      <p>If anything is still unclear, reply to this email and we will look into it.</p>
      ${signoff ? `<p style="white-space:pre-wrap">${escapeHtml(signoff)}</p>` : ''}
    </div>`.trim();

  return { subject, html, text };
}
