import { subjectMarker } from './inboundEmail.js';

/**
 * Renders one ITT reminder email from the organisation's own wording.
 *
 * Pure, with no I/O - the split `ittEmail.ts` and `commsEmail.ts` keep, so it is unit-tested
 * in CI, which has neither a database nor a mail provider. Every value it prints is passed
 * in; it computes nothing.
 *
 * THE WORDING IS CONFIGURATION. The subject and body are the `itt_reminder_templates` row the
 * organisation (or the seeded default) holds, edited in BuildFlow. This file only fills
 * {{placeholders}} into them. The placeholder set is the contract with BuildFlow's
 * ittReminderTemplates.ts (REMINDER_TOKENS) and the two lists must agree.
 *
 * A PLACEHOLDER IT CANNOT FILL IS LEFT VISIBLE, as `[[missing:name]]`, never dropped. A
 * silently blank field in an email to a real subcontractor ("the return date is  (  remaining)")
 * reads as a system failure the sender never saw, whereas a visible marker is caught in the
 * test-inbox run. BuildFlow already refuses to SAVE an unknown placeholder, so this only fires
 * if something slipped past that.
 *
 * TEXT IS THE SOURCE, HTML IS DERIVED. There is one body to edit and nothing that can disagree
 * with it: paragraphs are blank-line separated, and single newlines inside one become <br>.
 */

export interface ReminderContext {
  firmName: string;
  contactName: string | null;
  packageName: string;
  projectName: string | null;
  /** Already formatted for a reader (dd/mm/yyyy). */
  tenderReturnDeadline: string;
  /** Null when the package has no return date (a manual reminder can still go out). */
  daysRemaining: number | null;
  /** Their pricing page. Null when they have no live link; the email says where else to look. */
  portalUrl: string | null;
  estimatorName: string | null;
  organizationName: string | null;
  /** The outbound message's own id, so a reply lands back on the same conversation - see
   *  findReplyToken. Carried in the subject because plus-addressing does not survive every
   *  mail system. */
  replyToken: string;
}

export interface ReminderTemplateText {
  subject: string;
  bodyText: string;
}

export interface RenderedReminder {
  /** With the reply marker - what is actually sent. */
  subject: string;
  /** Without it - what the timeline records. The marker is routing, not wording. */
  subjectCore: string;
  html: string;
  text: string;
  /** Placeholders the template used that could not be filled. Non-empty means the wording
   *  and this file have drifted apart; the caller should log it. */
  unresolved: string[];
}

const TOKEN_RE = /\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g;

/** Shown in place of a portal link the firm does not have. A reminder that says "reply here:"
 *  and then nothing is worse than one that says where to look instead. */
const NO_PORTAL_TEXT = 'the link in your original invitation email';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The values a template may reference, as plain strings. */
export function tokenValues(context: ReminderContext): Record<string, string> {
  return {
    firmName: context.firmName,
    // A greeting with no name reads better as "Dear Sir or Madam" than "Dear ,".
    contactName: context.contactName?.trim() || 'Sir or Madam',
    packageName: context.packageName,
    projectName: context.projectName ?? 'the project',
    tenderReturnDeadline: context.tenderReturnDeadline,
    // With no return date there is no honest number to print.
    daysRemaining: context.daysRemaining === null
      ? 'limited time'
      : `${context.daysRemaining} day${context.daysRemaining === 1 ? '' : 's'}`,
    portalUrl: context.portalUrl ?? NO_PORTAL_TEXT,
    estimatorName: context.estimatorName ?? '',
    organizationName: context.organizationName ?? ''
  };
}

function fill(text: string, values: Record<string, string>, unresolved: Set<string>): string {
  return text.replace(TOKEN_RE, (_match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(values, key)) return values[key]!;
    unresolved.add(key);
    return `[[missing:${key}]]`;
  });
}

/** Turns a URL in already-escaped text into a link. Only http(s), so nothing a firm or an
 *  editor typed can become a `javascript:` href. */
function linkify(escaped: string): string {
  return escaped.replace(/(https?:\/\/[^\s<]+)/g, (url) => `<a href="${url}">${url}</a>`);
}

export function renderReminderEmail(
  template: ReminderTemplateText, context: ReminderContext
): RenderedReminder {
  const values = tokenValues(context);
  const unresolved = new Set<string>();

  const subjectCore = fill(template.subject, values, unresolved).replace(/\s+/g, ' ').trim();
  const bodyRaw = fill(template.bodyText, values, unresolved);
  // Trailing spaces and a signature left empty (no estimator on file) would otherwise leave
  // ragged blank lines at the foot of the message.
  const text = bodyRaw.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#111827">
      ${text.split(/\n{2,}/).map((paragraph) =>
        `<p>${linkify(escapeHtml(paragraph)).replace(/\n/g, '<br>')}</p>`).join('\n      ')}
    </div>`.trim();

  return {
    subject: `${subjectCore} ${subjectMarker(context.replyToken)}`,
    subjectCore,
    html,
    text,
    unresolved: [...unresolved]
  };
}
