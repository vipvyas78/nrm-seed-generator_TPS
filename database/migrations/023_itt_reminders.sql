-- ITT reminders (BuildFlow issue #36): what was sent to whom, who said a firm accepted or
-- declined, and which inbound emails have already been read for that.
--
-- 022 IS RETIRED. It was the comms schema before that moved to novamerx-comms-worker, and the
-- row it left in tps.schema_migrations is kept on purpose, so this is 023.
--
-- Everything here is TPS's own, in the `tps` schema. The wording and timing of a reminder are
-- BuildFlow configuration (public.itt_comms_config, public.itt_reminder_templates, migration
-- 089) and are only read.

-- ─────────────────────────────────────────────── the send log
--
-- ONE ROW PER REMINDER SENT, at the grain of tps.itt_dispatch and tps.pricing_portal_links:
-- a shortlist entry, i.e. package x firm. `kind` is which of the two emails it was.
--
-- The partial unique index is the idempotency guarantee and the reason this is a table rather
-- than the reminder_sent_at column 001 left on itt_dispatch: re-running the daily task, a
-- retry after a timeout, or two runs racing cannot send the same AUTOMATIC reminder twice,
-- because the second INSERT is refused by the database rather than avoided by a SELECT that
-- both runs could have passed. Manual sends are deliberately outside it - an estimator
-- chasing a firm a second time has decided to, which is not a duplicate.
CREATE TABLE IF NOT EXISTS tps.itt_reminders (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shortlist_entry_id UUID NOT NULL REFERENCES tps.shortlist_entries (id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN ('confirm_interest', 'submit_tender')),
  trigger            TEXT NOT NULL CHECK (trigger IN ('automatic', 'manual')),
  -- 'pending' is the claim, written BEFORE the email leaves, and is what makes a crash between
  -- "decided to send" and "sent" visible instead of silently re-sending or silently losing.
  email_status       TEXT NOT NULL DEFAULT 'pending'
                       CHECK (email_status IN ('pending', 'sent', 'failed', 'skipped_no_email')),
  email_error        TEXT,
  email_message_id   TEXT,
  -- The comms.messages row this became, so the timeline and this log can be joined. A bare
  -- UUID: comms is owned by another repository and carries no cross-schema foreign keys.
  comms_message_id   UUID,
  sent_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NULL for an automatic send, the estimator for a manual one.
  created_by         UUID,
  -- Sent while TEST_EMAIL_FLAG redirected every email to a test inbox. Kept apart from real
  -- sends so a simulated timeline run against real data (sendTestReminders.ts) can neither use
  -- up a real firm's once-only reminder nor be mistaken for one, and can be wound back.
  is_test            BOOLEAN NOT NULL DEFAULT FALSE
);

-- is_test is IN the key: a test run is idempotent against itself, and never blocks a real one.
CREATE UNIQUE INDEX IF NOT EXISTS itt_reminders_auto_once_idx
  ON tps.itt_reminders (shortlist_entry_id, kind, is_test) WHERE trigger = 'automatic';
CREATE INDEX IF NOT EXISTS itt_reminders_entry_idx
  ON tps.itt_reminders (shortlist_entry_id, sent_at DESC);

COMMENT ON TABLE tps.itt_reminders IS
  'Every reminder emailed to a subcontractor about one package. Automatic sends are unique per (entry, kind); manual sends are not.';

-- ─────────────────────────────────────────────── who said a firm accepted or declined
--
-- itt_dispatch.response has only ever been a buyer's manual mark. It can now also be read off
-- a subcontractor's own email, and "who says so" has to stay answerable: a declined firm
-- marked as tendering is a hole in the bid that nobody sees until the return date.
--
-- response_source IS NULL means "predates this column", and is treated as manual: nobody ever
-- wrote it any other way, and a human's mark must never be overwritten by a classifier.
ALTER TABLE tps.itt_dispatch
  ADD COLUMN IF NOT EXISTS response_source     TEXT CHECK (response_source IN ('manual', 'email_llm')),
  ADD COLUMN IF NOT EXISTS response_message_id UUID,
  ADD COLUMN IF NOT EXISTS response_confidence NUMERIC(3,2);

COMMENT ON COLUMN tps.itt_dispatch.response_source IS
  'manual = a person set it; email_llm = read from a subcontractor reply by the scheduled classifier. NULL predates the column and is treated as manual.';
COMMENT ON COLUMN tps.itt_dispatch.response_message_id IS
  'The comms.messages row the response was read from, when response_source = email_llm.';
COMMENT ON COLUMN tps.itt_dispatch.reminder_sent_at IS
  'SUPERSEDED by tps.itt_reminders and no longer written. Kept, not dropped, because nothing reads it and removing a column is a separate decision.';

-- ─────────────────────────────────────────────── the "already read this email" ledger
--
-- Lives here and not as a column on comms.messages because TPS may not alter comms - that
-- schema's DDL belongs to novamerx-comms-worker - and because commsDb.ts must stay the only
-- file that queries it. One row per inbound message ever classified, applied or not: a
-- verdict below the confidence floor, or one that could not be pinned to a single package,
-- is recorded too, so the message is not sent to the model again every night.
CREATE TABLE IF NOT EXISTS tps.itt_reply_classifications (
  message_id    UUID PRIMARY KEY,
  verdict       TEXT NOT NULL CHECK (verdict IN ('will_tender', 'decline', 'considering', 'unclear')),
  confidence    NUMERIC(3,2) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  model         TEXT,
  -- The sentence the model relied on, so a wrong mark is diagnosable rather than mysterious.
  evidence      TEXT,
  applied       BOOLEAN NOT NULL,
  -- Why it was NOT applied (below_confidence, ambiguous_package, already_manual, no_change...),
  -- NULL when it was.
  not_applied_reason TEXT,
  shortlist_entry_id UUID,
  classified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE tps.itt_reply_classifications IS
  'Inbound subcontractor emails already read for an accept/decline. message_id is a bare comms.messages id (no cross-schema FK).';
