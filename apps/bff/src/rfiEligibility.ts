/**
 * The no-tender-mixup guarantee (issue #41) — pure, no I/O, unit-tested without a
 * database. This is deliberately NOT an attempt to improve the sender-address
 * attribution heuristic (`portalRecipientFor` in tenderPrepDb.ts, "most recently
 * dispatched wins where a firm is live on several tenders"). Improving a heuristic
 * yields a better heuristic. Instead: drafting refuses to run on anything not
 * deterministically attributed, and the refusal becomes a visible task for a human.
 *
 * Two of the gate's four mechanisms live here (the eligibility rule and the
 * cross-tender name check); the other two — deriving BuildFlow's scope from
 * workflow_id server-side, and re-validating at send — are structural, enforced by
 * what data a caller is allowed to pass, not by a function that could be unit tested
 * in isolation.
 */

export type AttributionMethod =
  | 'reply_token' | 'subject_marker' | 'in_reply_to' | 'sender_email' | 'sender_domain' | 'manual';

/**
 * Whether a message's ATTRIBUTION METHOD alone is strong enough to draft against,
 * before even checking for ambiguity. A portal RFI is attributed by construction (the
 * link is per package x firm); reply_token / subject_marker / in_reply_to / manual are
 * all exact matches against something WE sent or a human decided. sender_email /
 * sender_domain are heuristics and need the caller to separately confirm they resolved
 * to exactly one live workflow (see isAmbiguous below) before they count as eligible.
 */
export function isDeterministicAttribution(channel: string, method: AttributionMethod | null): boolean {
  if (channel === 'portal') return true;
  return method === 'reply_token' || method === 'subject_marker' || method === 'in_reply_to' || method === 'manual';
}

export function isHeuristicAttribution(method: AttributionMethod | null): boolean {
  return method === 'sender_email' || method === 'sender_domain';
}

const MIN_TOKEN_LENGTH = 4;

/** Lowercased, punctuation folded to spaces, split on whitespace, short tokens (which
 *  match too much — "Phase 2", "The") dropped. */
function significantTokens(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
      .filter((token) => token.length >= MIN_TOKEN_LENGTH)
  );
}

/** True if EVERY significant token of `name` appears somewhere in the message text —
 *  a whole-name match, not a single shared word, so "Riverside" alone does not flag
 *  "Reading Riverside" against "Riverside Depot". */
function nameAppearsIn(name: string, messageTokens: Set<string>): boolean {
  const nameTokens = significantTokens(name);
  if (nameTokens.size === 0) return false;
  for (const token of nameTokens) if (!messageTokens.has(token)) return false;
  return true;
}

export interface OtherWorkflow {
  projectName: string | null;
  tenderReference: string | null;
}

/**
 * A deterministic, no-answer-key check: does this message look like it is about a
 * DIFFERENT live tender than the one it was attributed to? Flagged, never
 * auto-corrected — the app is not entitled to re-file a customer's email on a string
 * match, only to say "this looks wrong, please check".
 *
 * True only when another workflow's name/reference is fully present AND the
 * attributed workflow's own name/reference is fully ABSENT — a message naming both
 * (a firm CC'ing a general update, or one that happens to share vocabulary) is not
 * flagged, because that is not evidence of misattribution.
 */
export function suspectsCrossTenderMisattribution(input: {
  messageText: string;
  attributedWorkflow: OtherWorkflow;
  otherLiveWorkflows: OtherWorkflow[];
}): boolean {
  const tokens = significantTokens(input.messageText);
  const attributedNames = [input.attributedWorkflow.projectName, input.attributedWorkflow.tenderReference]
    .filter((n): n is string => Boolean(n));
  const attributedNamePresent = attributedNames.some((name) => nameAppearsIn(name, tokens));
  if (attributedNamePresent) return false; // the attributed tender is named too — not suspicious

  return input.otherLiveWorkflows.some((other) => {
    const names = [other.projectName, other.tenderReference].filter((n): n is string => Boolean(n));
    return names.some((name) => nameAppearsIn(name, tokens));
  });
}

/** Normalises question text into a dedupe key: lowercased, whitespace collapsed,
 *  trailing punctuation stripped — close enough that two firms asking "Will you
 *  supply the ironmongery?" and "will you supply the ironmongery" collide, not so
 *  loose that two different questions collapse together. */
export function normaliseForDedupe(questionText: string): string {
  return questionText.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.?!]+$/, '');
}
