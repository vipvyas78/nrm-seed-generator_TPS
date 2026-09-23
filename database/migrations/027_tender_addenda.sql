-- Tender addenda (BuildFlow issue #68, part of #42).
--
-- The client sends revised documents, the re-import re-measures the pack, and the
-- subcontractors who already hold the ITT are pricing a document set that no longer
-- describes the job. An addendum is the record of putting that right: which packages are
-- affected, who approved it, what the new return date is, and who it went to.
--
-- BuildFlow computes WHAT CHANGED (bf_takeoff_deltas, its migration 096) because the two
-- take-offs are its own. TPS owns every DECISION about it, which is the split
-- `itt_comms_config` states for the whole feature family: configuration and documents
-- there, decisions here.

-- ────────────────────────────────────────────────────────────── the addendum
--
-- delta is SNAPSHOTTED at creation and never re-read, the rule IttEmailPack already
-- follows ("never re-read from public.takeoff_items afterwards"). BuildFlow's row is
-- already immutable per takeoff_id, so this guards the narrower case: what an approver
-- read must not change under them because the delta was recomputed against a different
-- baseline.
CREATE TABLE IF NOT EXISTS tps.addenda (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id          UUID NOT NULL REFERENCES tps.workflows (id) ON DELETE CASCADE,
  -- "Addendum 2", numbered per tender. Assigned at creation, never reused.
  seq                  INTEGER NOT NULL,

  -- The two sides of the comparison, as BuildFlow resolved them.
  takeoff_id           TEXT NOT NULL,
  baseline_takeoff_id  TEXT,
  package_version_id   UUID,

  status               TEXT NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'awaiting_approval', 'approved',
                                           'issued', 'cancelled')),
  delta                JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_by           UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by          UUID,
  approved_at          TIMESTAMPTZ,
  issued_at            TIMESTAMPTZ,
  cancelled_at         TIMESTAMPTZ,

  UNIQUE (workflow_id, seq),
  -- One addendum per take-off: a re-run mints a new takeoff_id, so a second addendum
  -- against the same one would be the same change proposed twice.
  UNIQUE (workflow_id, takeoff_id)
);

CREATE INDEX IF NOT EXISTS addenda_workflow_idx ON tps.addenda (workflow_id, created_at DESC);

COMMENT ON COLUMN tps.addenda.delta IS
  'BuildFlow''s bf_takeoff_deltas row as it stood when this addendum was raised. '
  'Snapshotted, never re-read: what an approver read must not change under them.';

-- ──────────────────────────────────────────────────── the packages it goes to
--
-- `proposed` is what BuildFlow's delta derived; `included` is what the estimator decided.
-- Both are kept, because the derivation is a proposal and the approval is the decision,
-- and a reviewer looking at this later needs to see where they differed.
CREATE TABLE IF NOT EXISTS tps.addendum_packages (
  addendum_id             UUID NOT NULL REFERENCES tps.addenda (id) ON DELETE CASCADE,
  package_name            TEXT NOT NULL,
  wp_code                 TEXT,

  proposed                BOOLEAN NOT NULL DEFAULT FALSE,
  included                BOOLEAN NOT NULL DEFAULT FALSE,
  -- Why the delta proposed it: the counts, and whether the items carried no work package
  -- at all (BuildFlow's 'unattributed' bucket, which is a thing to decide, not to drop).
  items_added             INTEGER NOT NULL DEFAULT 0,
  items_removed           INTEGER NOT NULL DEFAULT 0,
  items_changed           INTEGER NOT NULL DEFAULT 0,
  unattributed            BOOLEAN NOT NULL DEFAULT FALSE,

  -- The revised date for THIS package. Per package because tender windows already are:
  -- ittEmail.ts renders differing return dates on one letter today.
  revised_return_deadline DATE,

  PRIMARY KEY (addendum_id, package_name)
);

-- ─────────────────────────────────────────────────── who it was actually sent to
--
-- A per-send ledger, deliberately unlike tps.itt_dispatch, which is
-- UNIQUE (shortlist_entry_id) with one overwritten dispatched_at and therefore keeps no
-- history at all. Claim-before-send: the row is written 'pending' BEFORE the email leaves,
-- the same pattern tps.itt_reminders and tps.rfi_responses use, so a crash mid-send leaves
-- evidence rather than silence.
CREATE TABLE IF NOT EXISTS tps.addendum_dispatch (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  addendum_id        UUID NOT NULL REFERENCES tps.addenda (id) ON DELETE CASCADE,
  shortlist_entry_id UUID NOT NULL REFERENCES tps.shortlist_entries (id) ON DELETE CASCADE,

  email_status       TEXT NOT NULL DEFAULT 'pending'
                       CHECK (email_status IN ('pending', 'sent', 'failed', 'skipped_no_email')),
  email_error        TEXT,
  email_message_id   TEXT,
  sent_at            TIMESTAMPTZ,
  is_test            BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (addendum_id, shortlist_entry_id)
);

-- ───────────────────────────────────────────────── the revised return date
--
-- tps.shortlists.tender_return_deadline is WRITE-ONCE by contract (migration 021: "a
-- resend must not move a date a tenderer already holds"), and stampTenderReturnDeadlines'
-- `WHERE ... IS NULL` is what enforces it. That rule is NOT relaxed here.
--
-- Instead the revision gets its own columns, so what each tenderer was originally told
-- stays on the record and the reason it moved is a row id rather than a memory. An
-- addendum extending the window is a decision somebody made and signed; overwriting the
-- original would erase both halves of that.
ALTER TABLE tps.shortlists
  ADD COLUMN IF NOT EXISTS revised_tender_return_deadline DATE,
  ADD COLUMN IF NOT EXISTS revised_by_addendum_id UUID REFERENCES tps.addenda (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS revised_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shortlists_revised_return_check'
  ) THEN
    ALTER TABLE tps.shortlists ADD CONSTRAINT shortlists_revised_return_check
      -- A revised date and the addendum that moved it are one fact. Either both or
      -- neither: a date with no addendum behind it is exactly the untraceable overwrite
      -- this design exists to avoid.
      CHECK ((revised_tender_return_deadline IS NULL) = (revised_by_addendum_id IS NULL));
  END IF;
END $$;

COMMENT ON COLUMN tps.shortlists.revised_tender_return_deadline IS
  'An approved addendum''s extended return date. Beats tender_return_deadline at rung 0 of '
  'resolveReturnDeadline; the original is deliberately left intact so what the tenderer was '
  'first told is still on the record.';
