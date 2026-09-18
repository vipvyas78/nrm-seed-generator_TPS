-- How long a subcontractor gets to price, decided per package at the tender launch meeting.
--
-- Until now the only return date in TPS was tps.itt_letter_details.tender_return_deadline —
-- one DATE for the whole tender exercise, typed by hand at Step 2 and, in practice, usually
-- left blank, so every cover letter printed "to be confirmed". What a launch meeting actually
-- decides is not a date but a DURATION, and it decides it per package: a large MEP package
-- gets four weeks where a small enabling package gets five days. The date follows from the
-- duration and the day the ITT goes out, which nobody knows while the meeting is sitting.
--
-- So three columns on tps.shortlists — the row that already records what this workflow chose
-- for this package (its route of procurement, its firms, its override notes):
--
--   tender_return_period_value / _unit   the decision. 1-5 days or 1-8 weeks.
--   tender_return_deadline               what that resolved to when the ITT was issued.
--
-- The stamped date is written ONCE, at first dispatch, and never rewritten. A resend, a
-- re-confirmation of the shortlist, or simply opening the pricing portal a week later must
-- not move a date a tenderer is already working to. savePackageSelection therefore writes
-- the two period columns and deliberately never the third; only stampTenderReturnDeadlines
-- writes that, and its WHERE clause carries the guarantee.
--
-- "days" means WORKING days (see apps/bff/src/tenderReturnPeriod.ts): five days is a working
-- week, consistent with "1 week", where five calendar days issued on a Thursday would hand a
-- tenderer three working days. Weeks are calendar weeks.

ALTER TABLE tps.shortlists
  ADD COLUMN IF NOT EXISTS tender_return_period_value INTEGER,
  ADD COLUMN IF NOT EXISTS tender_return_period_unit  TEXT,
  ADD COLUMN IF NOT EXISTS tender_return_deadline     DATE;

-- One constraint carries both the pairing rule and the unit-dependent range: first that the
-- two columns are set together or not at all, then — only where they are set — that the value
-- is in range for its own unit.
--
-- The pairing is stated as `(a IS NULL) = (b IS NULL)` rather than left to fall out of the
-- range branches, because A CHECK CONSTRAINT PASSES WHEN ITS EXPRESSION IS NULL, not only
-- when it is TRUE. Writing it the obvious way —
--
--   (value IS NULL AND unit IS NULL) OR (unit = 'days' AND value BETWEEN 1 AND 5) OR ...
--
-- — evaluates to FALSE OR NULL OR NULL = NULL for (3, NULL), so a value with no unit is
-- ACCEPTED. `IS NULL` always yields a boolean, so the form below cannot be NULL.
--
-- Named and guarded rather than added bare, the idiom migration 002 established, so
-- re-running this file is safe.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'tps.shortlists'::regclass
       AND conname  = 'shortlists_tender_return_period_check'
  ) THEN
    ALTER TABLE tps.shortlists
      ADD CONSTRAINT shortlists_tender_return_period_check CHECK (
        (tender_return_period_value IS NULL) = (tender_return_period_unit IS NULL)
        AND (
          tender_return_period_unit IS NULL
          OR (tender_return_period_unit = 'days'  AND tender_return_period_value BETWEEN 1 AND 5)
          OR (tender_return_period_unit = 'weeks' AND tender_return_period_value BETWEEN 1 AND 8)
        )
      );
  END IF;
END $$;

COMMENT ON COLUMN tps.shortlists.tender_return_period_value IS
  'How long this package is tendered for, in the unit beside it. 1-5 days or 1-8 weeks; NULL together with the unit when the meeting has not decided.';
COMMENT ON COLUMN tps.shortlists.tender_return_period_unit IS
  '"days" (WORKING days — weekends skipped) or "weeks" (calendar weeks). NULL together with the value.';
COMMENT ON COLUMN tps.shortlists.tender_return_deadline IS
  'The return date actually issued for this package, stamped at first dispatch from the period above. NEVER overwritten: a resend must not move a date a tenderer already holds. Written only by stampTenderReturnDeadlines, never by savePackageSelection.';
