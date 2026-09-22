/**
 * The estimator's half of the RFI loop (issue #48) — pure, no I/O, unit-tested without a
 * database, the same separation `rfiEligibility.ts` keeps for issue #41's eligibility
 * gate. Two questions live here because getting them wrong is invisible in an
 * integration test that only ever exercises the happy path once:
 *
 *   - what does a question's SEND actually say, and who gets credited for it — the
 *     measurement `rfi_response_items.source` exists for (migration 024's own words:
 *     "the only honest measure of whether drafting earns its cost").
 *   - how is a flat list of questions actually grouped into the emails and panels the
 *     rest of this feature is built from.
 */

export interface RfiCitation {
  passageId: string;
  documentId: string;
  filename: string;
  headingPath: string | null;
  pageHint: number | null;
  quotedText: string;
  shareUrl: string | null;
}

export interface LiveDraftForResolution {
  id: string;
  status: 'proposed' | 'insufficient_evidence' | 'rejected_ungrounded' | 'error';
  answerText: string | null;
}

export type ResponseSource = 'app_draft' | 'app_draft_edited' | 'estimator';

export interface ResolvedAnswer {
  answerText: string;
  source: ResponseSource;
  /** The draft this answer is credited to — set only when that draft actually proposed
   *  usable text. A draft that exists but never answered (insufficient_evidence /
   *  rejected_ungrounded / error) has nothing to be "edited from", so an estimator's own
   *  answer beside one of those is credited to them alone, not to a draft that gave them
   *  nothing to start from. */
  draftId: string | null;
}

/**
 * What a question's SEND will actually say, and who wrote it — derived from what is
 * stored, never asserted by a caller. A live draft only counts as a starting point when
 * it is `status === 'proposed'` AND actually carries text; every other draft state means
 * "the app could not answer this", so an estimator's answer beside one is their own work,
 * not an edit of the model's.
 *
 * Returns null when there is nothing to send — an empty draft and no estimator text —
 * which the caller turns into a refusal (`conflict`) naming the question, never a blank
 * email.
 */
export function resolveAnswer(input: {
  estimatorAnswerText: string | null;
  liveDraft: LiveDraftForResolution | null;
}): ResolvedAnswer | null {
  const usableDraft = input.liveDraft && input.liveDraft.status === 'proposed' && input.liveDraft.answerText
    ? input.liveDraft
    : null;
  const edited = input.estimatorAnswerText != null && input.estimatorAnswerText.trim().length > 0
    ? input.estimatorAnswerText.trim()
    : null;

  if (edited !== null) {
    return usableDraft
      ? { answerText: edited, source: 'app_draft_edited', draftId: usableDraft.id }
      : { answerText: edited, source: 'estimator', draftId: null };
  }
  if (usableDraft) {
    // usableDraft.answerText is non-null by the ternary above, but TS cannot see that
    // through the intermediate variable — asserted rather than re-checked.
    return { answerText: usableDraft.answerText as string, source: 'app_draft', draftId: usableDraft.id };
  }
  return null;
}

/**
 * Groups a flat, already-ordered list into a Map keyed by `keyFn`, preserving each
 * group's relative order — the shape the send (one email per thread) and the review
 * screen (one panel per firm) both need, from the one query that returns questions in
 * `raised_at` order.
 */
export function groupBy<T, K>(items: T[], keyFn: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const existing = groups.get(key);
    if (existing) existing.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

/**
 * `tps.rfi_drafts.citations` normalised off whatever `pg` handed back for the jsonb
 * column — parsed into a JS array already, but never trusted to have every field: a row
 * written before a future field existed, or a malformed one the worker never should have
 * sent, must render as "no citation" rather than throw the whole question's card away.
 */
export function normaliseCitations(raw: unknown): RfiCitation[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      passageId: typeof entry.passageId === 'string' ? entry.passageId : '',
      documentId: typeof entry.documentId === 'string' ? entry.documentId : '',
      filename: typeof entry.filename === 'string' ? entry.filename : '',
      headingPath: typeof entry.headingPath === 'string' ? entry.headingPath : null,
      pageHint: typeof entry.pageHint === 'number' ? entry.pageHint : null,
      quotedText: typeof entry.quotedText === 'string' ? entry.quotedText : '',
      shareUrl: typeof entry.shareUrl === 'string' ? entry.shareUrl : null
    }));
}
