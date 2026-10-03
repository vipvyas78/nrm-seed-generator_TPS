-- Quote comparison: a tenderer's own wording for an item, kept rather than reconciled by
-- hand (BuildFlow issue #100's own example: "if there is a slight discrepancy within the
-- description of the items in the subcontractor's quotes, then the app should create a
-- separate item describing the pricing sent by the subcontractors").
--
-- Today (1cfac0b) a drifted line — a return whose description or unit does not match the
-- reference bill line at the same position — is turned into a `not_addressed` cell with
-- its quoted rate and total both set to NULL. The tenderer's own figure is thrown away,
-- and `computeGrid` finds this state again only by matching the string "reconcile by
-- hand" inside `assumption_basis`, which is what this migration and its BFF counterpart
-- replace with a real status.
--
-- 'tenderer_variant': a new row origin, structurally identical to 'tenderer_added' (absent
-- for every tenderer but the one who filed it — see quoteComparisonDb.ts's own
-- `computeGrid`) except that it also names the spine row it is a variant OF
-- (`variant_of_row_id`), so it renders directly under that row rather than as an unrelated
-- extra line, and the spine row's own cell for that tenderer reads `priced_as_variant`
-- rather than competing for the same money twice.

DO $$
DECLARE cname TEXT;
BEGIN
    SELECT conname INTO cname FROM pg_constraint
     WHERE conrelid = 'tps.quote_comparison_rows'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%origin%itt_bill%';
    IF cname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE tps.quote_comparison_rows DROP CONSTRAINT %I', cname);
    END IF;
END $$;

ALTER TABLE tps.quote_comparison_rows
  ADD CONSTRAINT quote_comparison_rows_origin_check
    CHECK (origin IN ('itt_bill', 'tenderer_added', 'tenderer_variant', 'estimator_added')),
  ADD COLUMN IF NOT EXISTS variant_of_row_id UUID REFERENCES tps.quote_comparison_rows (id) ON DELETE CASCADE;

-- Already named in 028, so no lookup is needed to replace it.
ALTER TABLE tps.quote_comparison_rows
  DROP CONSTRAINT IF EXISTS qcr_added_by_return_matches_origin,
  ADD CONSTRAINT qcr_added_by_return_matches_origin CHECK (
    (origin IN ('tenderer_added', 'tenderer_variant')) = (added_by_return_id IS NOT NULL)),
  ADD CONSTRAINT qcr_variant_has_parent CHECK (
    (origin = 'tenderer_variant') = (variant_of_row_id IS NOT NULL));

-- One variant per (spine row, return) — a resubmission updates its own variant rather
-- than piling up another every time the estimator presses Refresh.
CREATE UNIQUE INDEX IF NOT EXISTS qcr_one_variant_per_return
  ON tps.quote_comparison_rows (variant_of_row_id, added_by_return_id)
  WHERE origin = 'tenderer_variant';

DO $$
DECLARE cname TEXT;
BEGIN
    SELECT conname INTO cname FROM pg_constraint
     WHERE conrelid = 'tps.quote_comparison_cells'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%status%priced%';
    IF cname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE tps.quote_comparison_cells DROP CONSTRAINT %I', cname);
    END IF;
END $$;

ALTER TABLE tps.quote_comparison_cells
  ADD CONSTRAINT quote_comparison_cells_status_check
    CHECK (status IN ('priced', 'included', 'excluded', 'not_addressed', 'absent', 'priced_as_variant')),
  -- Points at the variant row carrying this tenderer's own figure for the item — set only
  -- when status = 'priced_as_variant', so the spine cell's zero is never mistaken for a
  -- real price.
  ADD COLUMN IF NOT EXISTS priced_as_variant_row_id UUID REFERENCES tps.quote_comparison_rows (id) ON DELETE SET NULL,
  -- The tenderer's own wording for this line, kept for display even when it never carried
  -- a figure (excluded/not addressed under a different description still says so plainly).
  ADD COLUMN IF NOT EXISTS tenderer_description TEXT,
  ADD CONSTRAINT qcc_variant_link CHECK ((status = 'priced_as_variant') = (priced_as_variant_row_id IS NOT NULL));
