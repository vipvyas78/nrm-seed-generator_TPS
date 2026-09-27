-- The levelled quote comparison (BuildFlow issue #100).
--
-- Migration 008 built the table for this and never got a reader: "tps.comparative holds
-- one lump sum per tenderer. That is enough to say who was cheapest and no more." The
-- pricing portal (019/020) has been the only writer of tender_returns/tender_return_lines
-- since, and nothing has ever read them back. This is the read side: a spine of bill
-- lines snapshotted once per package, a cell per (line x return) carrying both what was
-- quoted and what the comparison LEVELS it to, and a flag + a stated reason wherever the
-- two differ.
--
-- tps.comparative is left in place, unregistered by this migration and unread by the new
-- screen — dropping a table for a feature being replaced adds risk for no gain. A
-- separate, reviewable step if it is ever retired.

-- ── 1. What the portal already knew and the promotion dropped ──────────────────────────
--
-- pricing_portal_lines.seq/source_item_id/added_by_tenderer are exactly what a levelled
-- comparison needs — seq is the position in the ITT assembly every link for a package was
-- snapshotted from, so it is an EXACT cross-tenderer key needing no fuzzy matching, and
-- added_by_tenderer already marks a line the tenderer added themselves (the issue's "if
-- there is a slight discrepancy … create a separate item"). PricingPortalDatabase.submit
-- copied everything else and dropped these three; this repairs the promotion. NULL/FALSE
-- default so submissions already on file (there are none live, but the shape must hold
-- regardless) read as "not from a portal snapshot".
ALTER TABLE tps.tender_return_lines
  ADD COLUMN IF NOT EXISTS seq INTEGER,
  ADD COLUMN IF NOT EXISTS source_item_id UUID,
  ADD COLUMN IF NOT EXISTS added_by_tenderer BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS tprl_seq_idx ON tps.tender_return_lines (return_id, seq);

-- ── 2. The comparison itself ─────────────────────────────────────────────────────────
--
-- One per (workflow, package), opened once the estimator wants to compare what has come
-- back so far — not auto-created on ITT send, because most packages will not be ready to
-- compare on the day the ITT goes out.

CREATE TABLE IF NOT EXISTS tps.quote_comparisons (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id     UUID NOT NULL REFERENCES tps.workflows (id) ON DELETE CASCADE,
  package_name    TEXT NOT NULL,
  opened_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  opened_by       UUID,
  -- Computed at read time from expected_count/received_count and the deadline actually
  -- in force (knownReturnDeadlineSql, tenderReturnPeriod.ts) — stored so the grid and the
  -- approval gate agree on the SAME snapshot of "how many are in" rather than each
  -- re-deriving it a moment apart, and so a re-open shows what readiness was decided on.
  readiness       TEXT NOT NULL DEFAULT 'awaiting_returns'
                    CHECK (readiness IN ('awaiting_returns', 'quorum_met', 'deadline_passed')),
  expected_count  INTEGER NOT NULL DEFAULT 0,
  received_count  INTEGER NOT NULL DEFAULT 0,
  return_deadline DATE,
  -- Named rather than implied, so a later change to the substitution rule is a value that
  -- changes, not a silent behaviour change under an unchanged label. 'cheapest' is the
  -- issue's own instruction: "assuming the cheapest price among the different quotations".
  levelling_basis TEXT NOT NULL DEFAULT 'cheapest' CHECK (levelling_basis = 'cheapest'),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workflow_id, package_name)
);

-- The spine: one row per bill line, in the order the ITT bill reads. `seq` is unique
-- WITHIN a comparison, exactly as it is within a portal link (019) — the same convention,
-- one level up, because a comparison's spine is itself a snapshot of one assembly.
CREATE TABLE IF NOT EXISTS tps.quote_comparison_rows (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  comparison_id      UUID NOT NULL REFERENCES tps.quote_comparisons (id) ON DELETE CASCADE,
  seq                INTEGER NOT NULL,
  ge_code            TEXT,
  element_code       TEXT,
  description        TEXT NOT NULL,
  quantity           NUMERIC(14,3),
  unit               TEXT,
  is_priceable       BOOLEAN NOT NULL DEFAULT TRUE,
  -- 'itt_bill': the row came off the assembly every tenderer was sent, same as this
  -- workflow's own ITT bill. 'tenderer_added': one tenderer's own extra line (their
  -- pricing_portal_lines.added_by_tenderer row, or a manual return's own addition) —
  -- necessarily absent from every other tenderer's return, which cells.status = 'absent'
  -- states rather than hides. 'estimator_added': the estimator's own row, e.g. to price a
  -- discrepancy the issue anticipates ("create a separate item").
  origin             TEXT NOT NULL DEFAULT 'itt_bill'
                       CHECK (origin IN ('itt_bill', 'tenderer_added', 'estimator_added')),
  -- Set only for 'tenderer_added', naming whose return it came from — so the grid can
  -- still place it under the right tenderer's own column even though it has no cell
  -- there in the ordinary (matched-by-seq) sense.
  added_by_return_id UUID REFERENCES tps.tender_returns (id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (comparison_id, seq),
  CONSTRAINT qcr_added_by_return_matches_origin CHECK (
    (origin = 'tenderer_added') = (added_by_return_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS qcr_comparison_idx ON tps.quote_comparison_rows (comparison_id);

-- The grid: one cell per (row x return). A return with no cell for a row was never
-- compared against it at all — a return added to the comparison after the spine was
-- snapshotted, still pending its own cells — which `is_assumed`/`status` cannot express
-- and must not be asked to.
CREATE TABLE IF NOT EXISTS tps.quote_comparison_cells (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  row_id            UUID NOT NULL REFERENCES tps.quote_comparison_rows (id) ON DELETE CASCADE,
  return_id         UUID NOT NULL REFERENCES tps.tender_returns (id) ON DELETE CASCADE,
  -- Verbatim from tender_return_lines — never touched after the cell is built, so a
  -- reviewer can always see what was actually quoted beside what the comparison carries.
  quoted_rate       NUMERIC(14,4),
  quoted_total      NUMERIC(15,2),
  -- What THIS comparison carries for the tenderer's totals and the draft BoQ. Equal to
  -- quoted_rate/quoted_total when is_assumed is FALSE; a substitution otherwise.
  levelled_rate     NUMERIC(14,4),
  levelled_total    NUMERIC(15,2),
  status            TEXT NOT NULL DEFAULT 'not_addressed'
                      CHECK (status IN ('priced', 'included', 'excluded', 'not_addressed', 'absent')),
  -- Drives the highlight the issue asks for: "the assumed figures … should be
  -- highlighted so that the estimator knows these figures are the assumed figures".
  is_assumed        BOOLEAN NOT NULL DEFAULT FALSE,
  -- Generated, immutable, and always present when is_assumed is TRUE — the issue's "the
  -- comment section should state where the assumption is coming from" is a requirement on
  -- the DATA, not a UI nicety, so it is enforced here rather than trusted to the screen.
  assumption_basis  TEXT,
  -- The tenderer's own words for this line (tender_return_lines.note) — evidence,
  -- immutable from this side.
  tenderer_note     TEXT,
  -- The only field on a cell an estimator may edit.
  estimator_note    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (row_id, return_id),
  CONSTRAINT qcc_assumption_stated CHECK (NOT is_assumed OR assumption_basis IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS qcc_row_idx    ON tps.quote_comparison_cells (row_id);
CREATE INDEX IF NOT EXISTS qcc_return_idx ON tps.quote_comparison_cells (return_id);
