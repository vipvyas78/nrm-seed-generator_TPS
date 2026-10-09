-- Self Pricing becomes its own wizard step (BuildFlow issue #144).
--
-- 1 Tender Launch Pack -> 2 ITT Dispatch -> 3 Comparative Analysis -> 4 Self Pricing
-- -> 5 Tender Submission. The CHECK is looked up rather than named, as in migration 002.

DO $$
DECLARE c TEXT;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'tps.workflows'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%current_step%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE tps.workflows DROP CONSTRAINT %I', c); END IF;
END $$;

-- A workflow already on Tender Submission (old step 4) moves with it to step 5.
UPDATE tps.workflows SET current_step = 5 WHERE current_step = 4;

ALTER TABLE tps.workflows
  ADD CONSTRAINT workflows_current_step_check CHECK (current_step BETWEEN 1 AND 5);

-- The self-priced BoQ is worked in batches and stays editable after "Save as draft".
--   version          guards autosave against a second tab or an overtaken retry
--   status           in_progress until the QS saves it as a draft, then complete
--   transferred_hash the figures as last handed on; a different hash means "changed since transfer"
ALTER TABLE tps.self_pricing_drafts
  ADD COLUMN IF NOT EXISTS version          INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS status           TEXT NOT NULL DEFAULT 'in_progress'
                                             CHECK (status IN ('in_progress', 'complete')),
  ADD COLUMN IF NOT EXISTS completed_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS transferred_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS transferred_hash TEXT;

-- Anything already submitted under #143 counts as completed and transferred as it stands.
UPDATE tps.self_pricing_drafts
   SET status = 'complete', completed_at = submitted_at, transferred_at = submitted_at
 WHERE submitted_at IS NOT NULL;
