-- Auto-drafted RFI responses (BuildFlow issue #41): collating a subcontractor's queries
-- per tender, drafting an answer grounded in what they were actually sent, letting the
-- estimator review and approve, and sending the response back through the app.
--
-- None of this belongs on comms.* — the argument 023 already makes for
-- tps.itt_reply_classifications applies here word for word: TPS may not alter the comms
-- schema (owned by novamerx-comms-worker), commsDb.ts must stay the only file that
-- queries it, and none of this is a record of WHAT WAS COMMUNICATED — it is TPS's own
-- workflow state about a message comms already holds.

-- ─────────────────────────────────────────────── 1. the "already looked at this message" ledger
--
-- Same shape as itt_reply_classifications: one row per inbound message ever considered
-- for question extraction, INCLUDING the refusals, so a message is never re-read every
-- tick. A STATE rather than a boolean, because two of the refusals are recoverable
-- (attachment text can arrive on a later retry; a human can pick the tender) and the
-- eligibility gate's whole point is to make refusal a visible, actionable task rather
-- than a silent skip.
CREATE TABLE IF NOT EXISTS tps.rfi_message_reviews (
  message_id          UUID PRIMARY KEY,
  workflow_id         UUID,
  shortlist_entry_id  UUID,
  state               TEXT NOT NULL CHECK (state IN (
                        'pending', 'extracted', 'no_questions',
                        'blocked_ambiguous_tender', 'blocked_no_readable_text',
                        'blocked_cross_tender_suspected', 'failed'
                      )),
  state_reason        TEXT,
  questions_found      INTEGER NOT NULL DEFAULT 0,
  -- Ungrounded extractions the model produced and the groundSpans check dropped — see
  -- CLAUDE.md's account of the groundEvidence doctrine. A message where most of its
  -- questions were dropped is a bug report about the extractor, not a quiet success,
  -- so the count is kept rather than discarded with the questions themselves.
  questions_dropped    INTEGER NOT NULL DEFAULT 0,
  model                TEXT,
  attempts             INTEGER NOT NULL DEFAULT 0,
  last_attempt_at      TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS rfi_message_reviews_state_idx
  ON tps.rfi_message_reviews (state, last_attempt_at NULLS FIRST);

COMMENT ON TABLE tps.rfi_message_reviews IS
  'One row per inbound comms.messages id ever considered for RFI question extraction, including refusals. message_id is a bare comms id, no cross-schema FK.';

-- ─────────────────────────────────────────────── 2. attachment text
--
-- GRAIN: one row per comms.attachments id, not per message. One email routinely carries
-- the RFI schedule AND a marked-up drawing, and their fates differ — the first is read,
-- the second is not. A per-message blob could not say that.
CREATE TABLE IF NOT EXISTS tps.rfi_attachment_extracts (
  attachment_id  UUID PRIMARY KEY,
  message_id     UUID NOT NULL,
  filename       TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN (
                   'extracted', 'unsupported_pdf', 'unsupported_type',
                   'too_large', 'empty', 'failed'
                 )),
  extractor      TEXT,
  text           TEXT,
  char_count     INTEGER,
  truncated      BOOLEAN NOT NULL DEFAULT FALSE,
  error          TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  extracted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS rfi_attachment_extracts_message_idx
  ON tps.rfi_attachment_extracts (message_id);

COMMENT ON TABLE tps.rfi_attachment_extracts IS
  'BuildFlow POST /internal/comms/attachments/text results, one row per comms.attachments id. status=unsupported_pdf is a stated refusal, not a silent skip.';

-- ─────────────────────────────────────────────── 3. the questions
--
-- THE GRAIN THE ISSUE ASKS FOR. "Collated for the respective project" is only
-- expressible if a question is a row: one spreadsheet holds forty, and the estimator
-- answers, forwards and sends them individually. workflow_id is NOT NULL — a question
-- with no tender is unrepresentable, which is the eligibility gate's whole point.
CREATE TABLE IF NOT EXISTS tps.rfi_questions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id            UUID NOT NULL,
  workflow_id           UUID NOT NULL,
  shortlist_entry_id    UUID,
  subcontractor_id      UUID,
  thread_id             UUID NOT NULL,
  seq                   INTEGER NOT NULL,
  -- Where in the source it came from: 'body', or an .xlsx cell ref ("Sheet1!C14") /
  -- .docx paragraph ("para 37") — what officeTextExtract.ts emits, and what lets an
  -- estimator check a drafted question against the firm's own file.
  source_kind           TEXT NOT NULL CHECK (source_kind IN ('body', 'attachment')),
  source_attachment_id  UUID,
  source_ref            TEXT,
  question_text         TEXT NOT NULL,
  -- Emitted by the SAME extraction call, each term verbatim from the source. Free
  -- retrieval quality: no second model call to turn a question into a search query.
  search_terms          TEXT[] NOT NULL DEFAULT '{}',
  asked_by_name         TEXT,
  asked_by_email        TEXT,
  raised_at             TIMESTAMPTZ NOT NULL,
  status                TEXT NOT NULL DEFAULT 'new' CHECK (status IN (
                          'new', 'drafted', 'awaiting_review', 'approved',
                          'sent_to_client', 'answered_by_client', 'sent', 'dismissed'
                        )),
  -- Collation across firms — a LINK, never a merge: two firms asking the same thing
  -- each get their own answer, but the estimator answers once and it fans out.
  canonical_question_id UUID REFERENCES tps.rfi_questions (id) ON DELETE SET NULL,
  dedupe_hash           TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (message_id, seq)
);
CREATE INDEX IF NOT EXISTS rfi_questions_workflow_idx
  ON tps.rfi_questions (workflow_id, status, raised_at DESC);
CREATE INDEX IF NOT EXISTS rfi_questions_dedupe_idx
  ON tps.rfi_questions (workflow_id, dedupe_hash);
CREATE INDEX IF NOT EXISTS rfi_questions_canonical_idx
  ON tps.rfi_questions (canonical_question_id) WHERE canonical_question_id IS NOT NULL;

COMMENT ON TABLE tps.rfi_questions IS
  'One row per subcontractor RFI question, extracted from a comms.messages body or attachment. workflow_id NOT NULL is the eligibility gate''s guarantee: a question is never drafted for without a deterministic tender.';

-- ─────────────────────────────────────────────── 4. the drafts
--
-- An APPEND-ONLY LEDGER, not a mutable field — same doctrine as
-- itt_reply_classifications: what the model said is evidence, never overwritten,
-- including when it said nothing usable. The live draft for a question is the newest
-- row with superseded_at IS NULL, enforced by the partial unique index.
CREATE TABLE IF NOT EXISTS tps.rfi_drafts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id        UUID NOT NULL REFERENCES tps.rfi_questions (id) ON DELETE CASCADE,
  status             TEXT NOT NULL CHECK (status IN (
                       'proposed', 'insufficient_evidence', 'rejected_ungrounded', 'error'
                     )),
  -- NULL unless status = 'proposed'. An estimator sees "the app could not answer
  -- this" and writes it themselves — the safe direction: an absent line gets priced
  -- (or here, answered) by a human, a wrong one gets trusted.
  answer_text        TEXT,
  confidence         NUMERIC(3,2) CHECK (confidence BETWEEN 0 AND 1),
  needs_client       BOOLEAN NOT NULL DEFAULT FALSE,
  -- JSONB, not a table: citations are only ever read alongside their own draft, carry
  -- no referential integrity available to THIS database (passage ids live in
  -- BuildFlow), and a table would buy a join for nothing. Shape:
  -- [{passageId, documentId, filename, headingPath, pageHint, quotedText, shareUrl}]
  citations          JSONB NOT NULL DEFAULT '[]'::jsonb,
  corpus_session_ref TEXT,
  passages_offered   INTEGER NOT NULL DEFAULT 0,
  model              TEXT,
  prompt_version     TEXT,
  reject_reason      TEXT,
  superseded_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS rfi_drafts_live_idx
  ON tps.rfi_drafts (question_id) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS rfi_drafts_question_idx
  ON tps.rfi_drafts (question_id, created_at DESC);

COMMENT ON TABLE tps.rfi_drafts IS
  'Append-only ledger of what the drafting model said about one question. The live draft is the row with superseded_at IS NULL (rfi_drafts_live_idx enforces exactly one).';

-- ─────────────────────────────────────────────── 5. the send
--
-- Modelled on tps.itt_reminders line for line, including the CLAIM-BEFORE-SEND
-- ('pending' written before the email leaves, so a crash between "decided to send"
-- and "sent" is visible rather than silently re-sent) and is_test.
CREATE TABLE IF NOT EXISTS tps.rfi_responses (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id        UUID NOT NULL,
  thread_id          UUID NOT NULL,
  shortlist_entry_id UUID,
  comms_message_id   UUID,
  to_email           TEXT NOT NULL,
  from_email         TEXT NOT NULL,
  from_fallback_used BOOLEAN NOT NULL DEFAULT FALSE,
  reply_to_email     TEXT NOT NULL,
  email_status       TEXT NOT NULL DEFAULT 'pending'
                       CHECK (email_status IN ('pending', 'sent', 'failed')),
  email_error        TEXT,
  email_message_id   TEXT,
  created_by         UUID NOT NULL,
  is_test            BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS rfi_responses_workflow_idx ON tps.rfi_responses (workflow_id, sent_at DESC);

COMMENT ON TABLE tps.rfi_responses IS
  'One row per RFI-response email sent to a subcontractor. Mirrors tps.itt_reminders: pending is written before the send, exactly as that table''s claim-before-send guarantee.';

-- The mirror of comms.forward_items, and it exists for the same reason: without it,
-- "which of the seven questions did that one email answer, and who wrote each answer"
-- is unrecoverable. answer_text is snapshotted AS SENT — the live draft may change
-- later, the sent email must not appear to.
CREATE TABLE IF NOT EXISTS tps.rfi_response_items (
  response_id       UUID NOT NULL REFERENCES tps.rfi_responses (id) ON DELETE CASCADE,
  question_id       UUID NOT NULL REFERENCES tps.rfi_questions (id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  answer_text       TEXT NOT NULL,
  source            TEXT NOT NULL CHECK (source IN ('app_draft', 'app_draft_edited', 'estimator', 'client')),
  draft_id          UUID REFERENCES tps.rfi_drafts (id) ON DELETE SET NULL,
  client_message_id UUID,
  PRIMARY KEY (response_id, question_id)
);

COMMENT ON TABLE tps.rfi_response_items IS
  'Which questions one rfi_responses email answered, and with what — snapshotted as sent, never re-derived from the live draft. source distinguishes an unedited app draft from an estimator-edited or estimator-written one, the only honest measure of whether drafting earns its cost.';

-- ─────────────────────────────────────────────── 6. the client leg
--
-- comms.forward_items is at MESSAGE grain and cannot express "three of the seven
-- questions in that email". This can, alongside the existing forward machinery
-- forwardQueriesToClient already uses.
CREATE TABLE IF NOT EXISTS tps.rfi_client_forward_items (
  forward_message_id UUID NOT NULL,
  question_id        UUID NOT NULL REFERENCES tps.rfi_questions (id) ON DELETE CASCADE,
  seq                INTEGER NOT NULL,
  PRIMARY KEY (forward_message_id, question_id)
);

COMMENT ON TABLE tps.rfi_client_forward_items IS
  'Which questions one client_forward comms message carried, alongside comms.forward_items'' message-grain record of the same forward.';
