-- The estimator's half of the RFI loop (issue #48). Two additions, no new tables — 024
-- already carries the send ledger, the response items and the client-forward items; none
-- of them had a caller until now.

-- ── 1. the disposition the vocabulary could not express ────────────────────────────────
--
-- "the estimator has decided this one needs the Client" is a state a question sits in for
-- hours or days BEFORE a forward is sent — approve -> 'approved', dismiss -> 'dismissed',
-- and the forward itself -> 'sent_to_client', but nothing named the decision. Derived
-- instead of stored, the client-forward list would be the MODEL's rfi_drafts.needs_client
-- opinion rather than a person's, which is the one substitution this whole loop exists to
-- prevent.
--
-- The constraint is found by definition rather than by name: 024 declared it inline, so its
-- name is whatever Postgres auto-generated. Same idiom migration 002 established.
DO $$
DECLARE cname TEXT;
BEGIN
    SELECT conname INTO cname
      FROM pg_constraint
     WHERE conrelid = 'tps.rfi_questions'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%status%';

    IF cname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE tps.rfi_questions DROP CONSTRAINT %I', cname);
    END IF;
END $$;

ALTER TABLE tps.rfi_questions
  ADD CONSTRAINT rfi_questions_status_check CHECK (status IN (
    'new', 'drafted', 'awaiting_review', 'for_client', 'approved',
    'sent_to_client', 'answered_by_client', 'sent', 'dismissed'
  ));

-- ── 2. the answer a person wrote ─────────────────────────────────────────────────────────
--
-- NOT a tps.rfi_drafts row. That table is "an append-only ledger of what the drafting
-- MODEL said about one question" — its own words — and its status vocabulary (proposed /
-- insufficient_evidence / rejected_ungrounded / error) has no value that means "a human
-- typed this". Writing an estimator's prose in as 'proposed' would make
-- rfi_response_items.source, the only honest measure of whether drafting earns its cost,
-- unrecoverable from the ledger it is supposed to be measured against.
--
-- Nullable and overwritable, unlike a draft: this is a working edit, not evidence. The
-- evidence of what was actually sent is rfi_response_items.answer_text, snapshotted at
-- send time.
ALTER TABLE tps.rfi_questions
  ADD COLUMN IF NOT EXISTS estimator_answer_text TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_by  UUID,
  ADD COLUMN IF NOT EXISTS reviewed_at  TIMESTAMPTZ;

COMMENT ON COLUMN tps.rfi_questions.estimator_answer_text IS
  'What the estimator wrote instead of, or in place of, the app draft. Decides rfi_response_items.source at send time (app_draft_edited when a live draft existed, estimator when it did not) — the source is DERIVED from what is stored here, never asserted by the caller.';
COMMENT ON COLUMN tps.rfi_questions.reviewed_by IS
  'Who last approved, sent-to-client or dismissed this question. NULL until a human acts on it.';
COMMENT ON COLUMN tps.rfi_questions.reviewed_at IS
  'When reviewed_by last acted. Set alongside reviewed_by on every disposition, including a re-approval after an edit.';
