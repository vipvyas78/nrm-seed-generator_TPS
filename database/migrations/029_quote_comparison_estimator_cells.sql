-- Quote comparison: a manual return keyed against an estimator's own row never attached
-- (BuildFlow issue #100 follow-up).
--
-- 028 gave the estimator their own row origin ("create a separate item describing the
-- pricing") and the "enter a return by hand" screen already lists it alongside the ITT
-- bill's own rows — but `recordManualReturn` wrote the keyed-in line with only the spine
-- row's `seq`, and `refreshCells` looks that seq up ONLY among `itt_bill` rows (see this
-- file's header in 028: seq is a safe cross-tenderer key only within the ORIGINAL bill).
-- An estimator-added row's seq is assigned after every bill row, so the lookup always
-- misses and the line — and the money on it — is silently dropped. Worse, with no cell at
-- all for that row, `computeGrid` reads it as `absent` for every tenderer, and `approve()`
-- then tries to carry that literal status into `tender_boq_lines`, whose own CHECK (008)
-- does not recognise it — awarding a package with an estimator row on it throws.
--
-- The fix is a stable link from a manually keyed-in line to the exact comparison row it
-- was typed against — set once, by the same code that already has that row in hand
-- because the estimator is looking at it on screen (no fuzzy matching, same as every
-- other write path here). `refreshCells` then matches on this link FIRST, falling back to
-- `seq` among `itt_bill` rows only for lines that never went through manual entry.
ALTER TABLE tps.tender_return_lines
  ADD COLUMN IF NOT EXISTS comparison_row_id UUID REFERENCES tps.quote_comparison_rows (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS tprl_comparison_row_idx ON tps.tender_return_lines (comparison_row_id);
