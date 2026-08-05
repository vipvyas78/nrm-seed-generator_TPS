-- TPS becomes a 4-step wizard.
--
-- Steps 1-3 (Parsed Outputs, Employer RFIs, SoA RAG) belong to the take-off module and
-- are removed from here. Tender Launch Pack — old step 4 — becomes step 1, which is what
-- a workflow created by the take-off completion consumer lands on: `current_step` keeps
-- its DEFAULT 1 and the consumer never sets the column.
--
--   old 1 Parsed Outputs      -> gone
--   old 2 Employer RFIs       -> gone
--   old 3 SoA RAG             -> gone
--   old 4 Tender Launch Pack  -> new 1
--   old 5 ITT Dispatch        -> new 2
--   old 6 Comparative         -> new 3
--   old 7 Submission          -> new 4

-- The CHECK is looked up rather than named: `workflows_current_step_check` is
-- PostgreSQL's generated name and nothing in this repo pins it, so a database whose
-- constraint was created under a different name would silently keep the 1..7 range.
DO $$
DECLARE
    cname TEXT;
BEGIN
    SELECT conname INTO cname
    FROM pg_constraint
    WHERE conrelid = 'tps.workflows'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%current_step%';

    IF cname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE tps.workflows DROP CONSTRAINT %I', cname);
    END IF;
END $$;

-- A workflow parked on one of the removed steps has nothing left to do there, so it
-- lands on Tender Launch Pack. Nobody parked on a surviving step loses their place, and
-- shortlists / shortlist_entries / itt_dispatch / comparative / submission are keyed by
-- workflow_id and untouched.
UPDATE tps.workflows SET current_step = GREATEST(1, current_step - 3), updated_at = NOW();

ALTER TABLE tps.workflows
    ADD CONSTRAINT workflows_current_step_check CHECK (current_step BETWEEN 1 AND 4);

-- Irreversible. There is no down-migration and these rows are not recoverable.
DROP TABLE IF EXISTS tps.rfis;
DROP TABLE IF EXISTS tps.soa_rag;
