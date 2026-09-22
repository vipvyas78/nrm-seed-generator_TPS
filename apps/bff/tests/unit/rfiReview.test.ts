import { describe, expect, it } from 'vitest';
import { groupBy, normaliseCitations, resolveAnswer } from '../../src/rfiReview.js';

describe('resolveAnswer', () => {
  it('uses the live draft as-is when nothing was edited', () => {
    const result = resolveAnswer({
      estimatorAnswerText: null,
      liveDraft: { id: 'draft-1', status: 'proposed', answerText: 'The spec states 12mm ply.' }
    });
    expect(result).toEqual({ answerText: 'The spec states 12mm ply.', source: 'app_draft', draftId: 'draft-1' });
  });

  it('credits the draft when the estimator edited its text', () => {
    const result = resolveAnswer({
      estimatorAnswerText: 'The spec states 15mm ply, not 12mm.',
      liveDraft: { id: 'draft-1', status: 'proposed', answerText: 'The spec states 12mm ply.' }
    });
    expect(result).toEqual({
      answerText: 'The spec states 15mm ply, not 12mm.', source: 'app_draft_edited', draftId: 'draft-1'
    });
  });

  it('credits the estimator alone when there is no draft at all', () => {
    const result = resolveAnswer({ estimatorAnswerText: 'Yes, that is correct.', liveDraft: null });
    expect(result).toEqual({ answerText: 'Yes, that is correct.', source: 'estimator', draftId: null });
  });

  it('credits the estimator, not the draft, when the draft never proposed an answer', () => {
    const result = resolveAnswer({
      estimatorAnswerText: 'Yes, that is correct.',
      liveDraft: { id: 'draft-1', status: 'insufficient_evidence', answerText: null }
    });
    expect(result).toEqual({ answerText: 'Yes, that is correct.', source: 'estimator', draftId: null });
  });

  it('credits the estimator when the draft was rejected as ungrounded', () => {
    const result = resolveAnswer({
      estimatorAnswerText: 'It is 3 metres.',
      liveDraft: { id: 'draft-1', status: 'rejected_ungrounded', answerText: 'It might be 3 metres.' }
    });
    expect(result).toEqual({ answerText: 'It is 3 metres.', source: 'estimator', draftId: null });
  });

  it('refuses when there is neither an edit nor a usable draft', () => {
    expect(resolveAnswer({ estimatorAnswerText: null, liveDraft: null })).toBeNull();
    expect(resolveAnswer({
      estimatorAnswerText: null,
      liveDraft: { id: 'draft-1', status: 'error', answerText: null }
    })).toBeNull();
  });

  it('treats an all-whitespace estimator edit as no edit at all', () => {
    const result = resolveAnswer({
      estimatorAnswerText: '   \n  ',
      liveDraft: { id: 'draft-1', status: 'proposed', answerText: 'The spec states 12mm ply.' }
    });
    expect(result).toEqual({ answerText: 'The spec states 12mm ply.', source: 'app_draft', draftId: 'draft-1' });
  });

  it('trims the estimator text before it is stored', () => {
    const result = resolveAnswer({ estimatorAnswerText: '  Yes.  ', liveDraft: null });
    expect(result?.answerText).toBe('Yes.');
  });
});

describe('groupBy', () => {
  it('groups items under their key, preserving relative order within each group', () => {
    const items = [
      { thread: 'a', seq: 1 }, { thread: 'b', seq: 1 }, { thread: 'a', seq: 2 }, { thread: 'a', seq: 3 }
    ];
    const grouped = groupBy(items, (item) => item.thread);
    expect([...grouped.keys()]).toEqual(['a', 'b']);
    expect(grouped.get('a')).toEqual([{ thread: 'a', seq: 1 }, { thread: 'a', seq: 2 }, { thread: 'a', seq: 3 }]);
    expect(grouped.get('b')).toEqual([{ thread: 'b', seq: 1 }]);
  });

  it('returns an empty map for an empty list', () => {
    expect(groupBy([], (item: never) => item).size).toBe(0);
  });
});

describe('normaliseCitations', () => {
  it('passes a well-formed citation through unchanged', () => {
    const raw = [{
      passageId: 'p1', documentId: 'd1', filename: 'Spec.pdf',
      headingPath: '2E Walls', pageHint: 12, quotedText: 'Boarded both sides.',
      shareUrl: 'https://example.com/doc'
    }];
    expect(normaliseCitations(raw)).toEqual(raw);
  });

  it('gives a null shareUrl for a citation with no live link, rather than dropping it', () => {
    const raw = [{
      passageId: 'p1', documentId: 'd1', filename: 'Spec.pdf',
      headingPath: null, pageHint: null, quotedText: 'Boarded both sides.', shareUrl: null
    }];
    expect(normaliseCitations(raw)[0].shareUrl).toBeNull();
  });

  it('fills in safe defaults for a citation missing fields, rather than throwing', () => {
    const raw = [{ passageId: 'p1' }];
    expect(normaliseCitations(raw)).toEqual([{
      passageId: 'p1', documentId: '', filename: '', headingPath: null, pageHint: null,
      quotedText: '', shareUrl: null
    }]);
  });

  it('returns an empty array for anything that is not an array', () => {
    expect(normaliseCitations(null)).toEqual([]);
    expect(normaliseCitations(undefined)).toEqual([]);
    expect(normaliseCitations('not an array')).toEqual([]);
    expect(normaliseCitations({})).toEqual([]);
  });

  it('drops non-object entries rather than letting one bad entry throw', () => {
    expect(normaliseCitations([null, 'x', 42, { passageId: 'p1' }])).toEqual([{
      passageId: 'p1', documentId: '', filename: '', headingPath: null, pageHint: null,
      quotedText: '', shareUrl: null
    }]);
  });
});
