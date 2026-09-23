import { subjectMarker } from './inboundEmail.js';

/**
 * Renders one tender addendum email from the organisation's own wording.
 *
 * Pure, with no I/O — the same split `reminderEmail.ts` and `commsEmail.ts` keep, so it is
 * unit-tested in CI, which has neither a database nor a mail provider. Every value it prints
 * is passed in; it computes nothing.
 *
 * THE WORDING IS CONFIGURATION. The subject and body are the `itt_addendum_templates` row
 * the organisation (or the seeded default) holds, edited in BuildFlow. This file only fills
 * {{placeholders}} into them. The placeholder set is the contract with BuildFlow's
 * `ittAddendumTemplates.ts` (`ADDENDUM_TOKENS`), and the two lists must agree.
 *
 * A PLACEHOLDER IT CANNOT FILL IS LEFT VISIBLE, as `[[missing:name]]`, never dropped —
 * `reminderEmail.ts`'s own reasoning: a silently blank field in a real email reads as a
 * system failure nobody saw, where a visible marker is caught in the test-inbox run.
 *
 * TEXT IS THE SOURCE, HTML IS DERIVED, and a `https://` link in the text becomes a clickable
 * one in the HTML — exactly `reminderEmail.ts`'s `linkify`, duplicated rather than imported
 * because these are two independently edited emails and the two must not drift into one
 * accidentally-shared module.
 */

export interface AddendumEmailContext {
  firmName: string;
  contactName: string | null;
  packageName: string;
  tenderName: string | null;
  addendumNumber: number;
  /** What changed for THIS package, already worded — see summariseChanges. */
  changeSummary: string;
  /** Already formatted for a reader (dd/mm/yyyy). */
  tenderReturnDeadline: string;
  /** This package's document bundle, or the complete set if none was cited — see
   *  documentsUrlFor. Null only when BuildFlow's bundles are unreachable; the email still
   *  goes, and says where else to look. */
  documentsUrl: string | null;
  estimatorName: string | null;
  organizationName: string | null;
  /** The outbound message's own id, so a reply lands back on the same conversation — the
   *  same mechanism `reminderEmail.ts` uses, carried in the subject because plus-addressing
   *  does not survive every mail system. */
  replyToken: string;
}

export interface AddendumTemplateText {
  subject: string;
  bodyText: string;
}

export interface RenderedAddendumEmail {
  /** With the reply marker — what is actually sent. */
  subject: string;
  /** Without it — what the timeline records. The marker is routing, not wording. */
  subjectCore: string;
  html: string;
  text: string;
  /** Placeholders the template used that could not be filled. Non-empty means the wording
   *  and this file have drifted apart; the caller should log it. */
  unresolved: string[];
}

const TOKEN_RE = /\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g;

/** Shown in place of a documents link the bundles could not supply. Naming the gap rather
 *  than leaving a blank line — the same reasoning as reminderEmail's NO_PORTAL_TEXT. */
const NO_DOCUMENTS_TEXT = 'the documents attached to your original invitation to tender';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The values a template may reference, as plain strings. */
export function tokenValues(context: AddendumEmailContext): Record<string, string> {
  return {
    firmName: context.firmName,
    contactName: context.contactName?.trim() || 'Sir or Madam',
    packageName: context.packageName,
    tenderName: context.tenderName ?? 'the tender',
    addendumNumber: String(context.addendumNumber),
    changeSummary: context.changeSummary,
    tenderReturnDeadline: context.tenderReturnDeadline,
    documentsUrl: context.documentsUrl ?? NO_DOCUMENTS_TEXT,
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

export function renderAddendumEmail(
  template: AddendumTemplateText, context: AddendumEmailContext
): RenderedAddendumEmail {
  const values = tokenValues(context);
  const unresolved = new Set<string>();

  const subjectCore = fill(template.subject, values, unresolved).replace(/\s+/g, ' ').trim();
  const bodyRaw = fill(template.bodyText, values, unresolved);
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

/**
 * One package's worth of `changeSummary`, from BuildFlow's `addendum_packages` row.
 *
 * Plain English over raw counts on purpose: a subcontractor reading "3 items added, 1
 * removed" has to translate that themselves, and a client-facing email is not the place to
 * ask them to. The unattributed bucket never reaches this function — see issueAddendum's own
 * comment on why it is excluded from what actually gets emailed.
 */
export function summariseChanges(pkg: { itemsAdded: number; itemsRemoved: number; itemsChanged: number }): string {
  const parts: string[] = [];
  if (pkg.itemsAdded > 0) parts.push(`${pkg.itemsAdded} new item${pkg.itemsAdded === 1 ? '' : 's'}`);
  if (pkg.itemsChanged > 0) parts.push(`${pkg.itemsChanged} item${pkg.itemsChanged === 1 ? '' : 's'} with a revised quantity`);
  if (pkg.itemsRemoved > 0) parts.push(`${pkg.itemsRemoved} item${pkg.itemsRemoved === 1 ? '' : 's'} no longer required`);
  if (parts.length === 0) return 'The revised documents affect this package.';
  return `${parts.join(', ')}.`;
}
