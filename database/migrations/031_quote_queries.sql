-- Queries to subcontractors about their quote (BuildFlow issue #100): "once this
-- comparison is done, then the estimator should ... get in touch with the respective
-- subcontractors to raise any queries he may have on the quotes or on the pricing."
--
-- One row per question, scoped to a return (always) and optionally to the exact row or
-- cell it is about, so a query can point at "this line" rather than only "this firm". An
-- "open" query is derived — no response and not withdrawn — rather than stored as a
-- separate status, so there is only ever one place that can disagree with itself about
-- whether a query is still outstanding.
--
-- DEPENDS ON A SISTER MIGRATION in novamerx-comms-worker adding 'quote_query' to
-- comms.messages' own kind CHECK — that schema's DDL is owned there, not here (see
-- commsDb.ts's own header). Until that lands, `recordMessage({kind: 'quote_query', ...})`
-- fails its CHECK at the moment a query is actually SENT — every other operation here
-- (drafting, logging a response by hand) is unaffected, because none of them touch
-- `comms.messages` at all.

CREATE TABLE IF NOT EXISTS tps.quote_queries (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  comparison_id    UUID NOT NULL REFERENCES tps.quote_comparisons (id) ON DELETE CASCADE,
  return_id        UUID NOT NULL REFERENCES tps.tender_returns (id) ON DELETE CASCADE,
  row_id           UUID REFERENCES tps.quote_comparison_rows (id) ON DELETE SET NULL,
  cell_id          UUID REFERENCES tps.quote_comparison_cells (id) ON DELETE SET NULL,
  question         TEXT NOT NULL CHECK (btrim(question) <> ''),
  raised_by        UUID,
  raised_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Claim-before-send, the same convention itt_reminders/addendum_dispatch already use —
  -- see ittRemindersDb.ts's own sendOne for why the order (claim, record, send, settle)
  -- is the actual guard against sending the same query twice.
  email_status     TEXT NOT NULL DEFAULT 'draft'
                     CHECK (email_status IN ('draft', 'pending', 'sent', 'failed', 'skipped_no_email')),
  recipient_email   TEXT,
  email_error       TEXT,
  email_message_id  TEXT,
  comms_message_id  UUID,
  sent_at           TIMESTAMPTZ,
  sent_by           UUID,
  is_test           BOOLEAN NOT NULL DEFAULT FALSE,

  -- The estimator's own record of what the subcontractor said — never assumed to arrive
  -- by email; the issue says "get in touch", not "email and wait for a reply".
  response            TEXT,
  response_source      TEXT CHECK (response_source IN ('email', 'phone', 'meeting', 'other')),
  responded_at         TIMESTAMPTZ,
  response_logged_by   UUID,

  withdrawn_at      TIMESTAMPTZ,
  withdrawn_by      UUID,

  CONSTRAINT qq_response_complete CHECK (
    (response IS NULL) = (responded_at IS NULL) AND (response IS NULL) = (response_source IS NULL)),
  CONSTRAINT qq_not_both_answered_and_withdrawn CHECK (NOT (response IS NOT NULL AND withdrawn_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS qq_comparison_idx ON tps.quote_queries (comparison_id);
CREATE INDEX IF NOT EXISTS qq_return_idx ON tps.quote_queries (return_id);
-- "Open" is never stored, so there is nothing here to keep in sync — this indexes the
-- derivation itself (no response, not withdrawn) for the count every screen asks for.
CREATE INDEX IF NOT EXISTS qq_open_idx ON tps.quote_queries (comparison_id, return_id)
  WHERE response IS NULL AND withdrawn_at IS NULL;

-- Recorded at the moment of award, so a later response or withdrawal can never rewrite
-- what the estimator actually knew when they made the call.
ALTER TABLE tps.trade_analysis
  ADD COLUMN IF NOT EXISTS open_queries_at_award INTEGER;
