-- Final adjustments to the comparison (BuildFlow issue #100): "subject to the response
-- from the subcontractor, he can make the final adjustments in the final comparison of
-- that respective trade." Until now the only thing an estimator could change on a cell
-- was its free-text note — never the figure itself.
--
-- An override sits ALONGSIDE the automatic levelling (`levelCell`), never replacing it in
-- the data: `adjusted_rate`/`adjusted_total` are the estimator's own figure, kept beside
-- the quoted one and the automatically-levelled one so all three remain visible. The
-- all-or-nothing CHECK is the same guarantee 028 already enforces for `assumption_basis`
-- — an override with no stated reason is not a thing the database will hold, enforced
-- here rather than trusted to the screen.
ALTER TABLE tps.quote_comparison_cells
  ADD COLUMN IF NOT EXISTS adjusted_rate NUMERIC(14,4),
  ADD COLUMN IF NOT EXISTS adjusted_total NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS adjustment_reason TEXT,
  ADD COLUMN IF NOT EXISTS adjusted_by UUID,
  ADD COLUMN IF NOT EXISTS adjusted_at TIMESTAMPTZ,
  -- The query this override was the answer to, where there was one — not required, since
  -- not every adjustment follows a formal query.
  ADD COLUMN IF NOT EXISTS adjustment_query_id UUID REFERENCES tps.quote_queries (id) ON DELETE SET NULL,
  -- Snapshotted at the moment the override was set, so a later resubmission that changes
  -- the tenderer's own quoted figure can be told apart from one that did not — see
  -- quoteComparisonDb.ts's own applyOverride for what "stale" means here.
  ADD COLUMN IF NOT EXISTS adjusted_against_quoted_total NUMERIC(15,2);

DO $$
DECLARE cname TEXT;
BEGIN
    SELECT conname INTO cname FROM pg_constraint
     WHERE conrelid = 'tps.quote_comparison_cells'::regclass AND contype = 'c' AND conname = 'qcc_adjustment_stated';
    IF cname IS NULL THEN
        ALTER TABLE tps.quote_comparison_cells ADD CONSTRAINT qcc_adjustment_stated CHECK (
          (adjusted_total IS NULL AND adjusted_rate IS NULL AND adjustment_reason IS NULL AND adjusted_by IS NULL AND adjusted_at IS NULL)
          OR (adjusted_total IS NOT NULL AND btrim(COALESCE(adjustment_reason, '')) <> '' AND adjusted_by IS NOT NULL AND adjusted_at IS NOT NULL)
        );
    END IF;
END $$;

-- The history an override leaves behind — set, then cleared, then set again differently —
-- is itself part of the record an estimator may need to account for later. A snapshot of
-- the row (seq/description) is kept alongside the ids so the history still reads once a
-- row has since been deleted (an estimator-added row an estimator later removed).
CREATE TABLE IF NOT EXISTS tps.quote_comparison_adjustments (
  id               BIGSERIAL PRIMARY KEY,
  comparison_id    UUID NOT NULL REFERENCES tps.quote_comparisons (id) ON DELETE CASCADE,
  cell_id          UUID REFERENCES tps.quote_comparison_cells (id) ON DELETE SET NULL,
  return_id        UUID NOT NULL,
  row_seq          INTEGER NOT NULL,
  row_description  TEXT NOT NULL,
  action           TEXT NOT NULL CHECK (action IN ('set', 'cleared')),
  previous_rate    NUMERIC(14,4),
  previous_total   NUMERIC(15,2),
  new_rate         NUMERIC(14,4),
  new_total        NUMERIC(15,2),
  reason           TEXT NOT NULL CHECK (btrim(reason) <> ''),
  query_id         UUID,
  actor            UUID NOT NULL,
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS qca_comparison_idx ON tps.quote_comparison_adjustments (comparison_id);
CREATE INDEX IF NOT EXISTS qca_cell_idx ON tps.quote_comparison_adjustments (cell_id);

-- Append-only, the same guarantee comms.messages' own immutability already relies on at
-- the application level — enforced here in the database instead, since history that can
-- be rewritten is not history.
CREATE OR REPLACE FUNCTION tps.quote_comparison_adjustments_no_update() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'tps.quote_comparison_adjustments is append-only; it cannot be updated, only added to'
    USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS qca_no_update ON tps.quote_comparison_adjustments;
CREATE TRIGGER qca_no_update
  BEFORE UPDATE ON tps.quote_comparison_adjustments
  FOR EACH ROW EXECUTE FUNCTION tps.quote_comparison_adjustments_no_update();

-- Recorded at the moment of award — see the same column on trade_analysis added in 031
-- for open queries, and for the same reason: a later change must not rewrite what the
-- estimator actually knew when they awarded.
ALTER TABLE tps.trade_analysis
  ADD COLUMN IF NOT EXISTS overrides_at_award INTEGER;
