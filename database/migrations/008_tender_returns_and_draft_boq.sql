-- Priced returns, per-trade approval, and the draft tender BoQ.
--
-- tps.comparative holds one lump sum per tenderer. That is enough to say who was cheapest
-- and no more. The tender BoQ needs a rate against every measured line, carried through
-- from whichever return the estimator approved — so pricing has to be captured at line
-- level, and the approved rate has to be a separate value from the submitted one because
-- the approver may adjust it.
--
-- The chain this builds, and the reason each table exists:
--
--   tender_returns        one per tenderer per package   — the header: sum, programme, quals
--   tender_return_lines   one per BoQ line per return    — the rates being compared
--   ve_proposals          value engineering, mandatory   — assessed alongside, never instead
--   trade_analysis        the estimator's approval gate  — one per package
--   tender_boq_lines      the draft tender BoQ           — approved rate + where it came from
--
-- 20 trades at 3-4 returns each is 60-80 headers and, at this project's 420 measured lines,
-- tens of thousands of line rates. Everything below is indexed for that.

-- ── 1. Returns ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tps.tender_returns (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id      UUID NOT NULL REFERENCES tps.workflows (id) ON DELETE CASCADE,
  package_name     TEXT NOT NULL,
  subcontractor_id UUID,
  tenderer_name    TEXT NOT NULL,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tendered_sum     NUMERIC(15,2),
  programme_weeks  INTEGER,
  qualifications   TEXT,
  exclusions       TEXT,
  -- Test data must be able to travel through the same tables as real returns without ever
  -- being mistaken for a real bid. Every read that reaches a human has to surface this.
  is_fabricated    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workflow_id, package_name, tenderer_name)
);

CREATE INDEX IF NOT EXISTS tpret_pkg_idx ON tps.tender_returns (workflow_id, package_name);

CREATE TABLE IF NOT EXISTS tps.tender_return_lines (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id    UUID NOT NULL REFERENCES tps.tender_returns (id) ON DELETE CASCADE,
  -- Denormalised from the take-off BoQ, deliberately: the bill a subcontractor priced is
  -- evidence and must not change under them if the take-off is re-run.
  ge_code      TEXT,
  element_code TEXT,
  description  TEXT NOT NULL,
  quantity     NUMERIC(14,3),
  unit         TEXT,
  rate         NUMERIC(14,4),
  total        NUMERIC(15,2),
  -- 'included' covers the zero-quantity scope lines: the tenderer confirms the work is in
  -- their price without a measured quantity to rate. 'excluded' must carry a note.
  status       TEXT NOT NULL DEFAULT 'priced'
                 CHECK (status IN ('priced', 'included', 'excluded', 'not_addressed')),
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tprl_return_idx ON tps.tender_return_lines (return_id);
CREATE INDEX IF NOT EXISTS tprl_line_idx   ON tps.tender_return_lines (element_code, ge_code);

-- Value engineering is a condition of a compliant tender, so it is its own table rather
-- than a column: a return can carry several, and each needs assessing on its own merits.
CREATE TABLE IF NOT EXISTS tps.ve_proposals (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id          UUID NOT NULL REFERENCES tps.tender_returns (id) ON DELETE CASCADE,
  description        TEXT NOT NULL,
  saving             NUMERIC(15,2),
  programme_weeks    INTEGER,
  spec_effect        TEXT,
  risk               TEXT,
  er_clause_affected TEXT,
  -- Accepted VE changes the approved rates; it is the estimator's call, not the bidder's.
  accepted           BOOLEAN,
  decided_at         TIMESTAMPTZ,
  decided_by         UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tpve_return_idx ON tps.ve_proposals (return_id);

-- ── 2. The per-trade approval gate ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tps.trade_analysis (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id     UUID NOT NULL REFERENCES tps.workflows (id) ON DELETE CASCADE,
  package_name    TEXT NOT NULL,
  -- The return whose rates are carried into the BoQ. Nullable while under review.
  awarded_return_id UUID REFERENCES tps.tender_returns (id),
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'approved_with_adjustments', 'rejected')),
  approved_at     TIMESTAMPTZ,
  approved_by     UUID,
  approval_notes  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workflow_id, package_name)
);

-- ── 3. The draft tender BoQ ─────────────────────────────────────────────────────────
--
-- One row per measured line, carrying the rate the estimator approved and where it came
-- from. `submitted_rate` is kept beside `approved_rate` so an adjustment stays visible:
-- what the subcontractor offered, what we are carrying, and why they differ.

CREATE TABLE IF NOT EXISTS tps.tender_boq_lines (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id     UUID NOT NULL REFERENCES tps.workflows (id) ON DELETE CASCADE,
  package_name    TEXT NOT NULL,
  ge_code         TEXT,
  element_code    TEXT,
  description     TEXT NOT NULL,
  quantity        NUMERIC(14,3),
  unit            TEXT,
  submitted_rate  NUMERIC(14,4),
  approved_rate   NUMERIC(14,4),
  approved_total  NUMERIC(15,2),
  status          TEXT NOT NULL DEFAULT 'priced'
                    CHECK (status IN ('priced', 'included', 'excluded', 'not_addressed')),
  source_return_id UUID REFERENCES tps.tender_returns (id),
  adjusted        BOOLEAN NOT NULL DEFAULT FALSE,
  adjustment_note TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tpbl_workflow_idx ON tps.tender_boq_lines (workflow_id, package_name);

-- The second gate. The per-trade analyses approve rates one package at a time; this is the
-- whole bill going to the tender manager and the team before it reaches the client.
CREATE TABLE IF NOT EXISTS tps.draft_tender_boq (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id    UUID NOT NULL REFERENCES tps.workflows (id) ON DELETE CASCADE,
  generated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  aggregate_total NUMERIC(15,2),
  packages_included INTEGER,
  packages_outstanding INTEGER,
  status         TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'approved', 'issued_to_client', 'rejected')),
  approved_at    TIMESTAMPTZ,
  approved_by    UUID,
  approval_notes TEXT,
  issued_at      TIMESTAMPTZ,
  UNIQUE (workflow_id)
);

-- A package's rates may only enter the draft BoQ once its own analysis is approved. Enforced
-- here rather than in application code because it is the commercial rule the whole flow
-- exists to protect: nothing unapproved reaches the client.
CREATE OR REPLACE FUNCTION tps.assert_trade_approved() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE st TEXT;
BEGIN
  SELECT status INTO st FROM tps.trade_analysis
   WHERE workflow_id = NEW.workflow_id AND package_name = NEW.package_name;
  IF st IS NULL OR st NOT IN ('approved', 'approved_with_adjustments') THEN
    RAISE EXCEPTION 'Package "%" has no approved trade analysis; its rates cannot enter the draft tender BoQ', NEW.package_name
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tpbl_requires_approval ON tps.tender_boq_lines;
CREATE TRIGGER tpbl_requires_approval
  BEFORE INSERT OR UPDATE ON tps.tender_boq_lines
  FOR EACH ROW EXECUTE FUNCTION tps.assert_trade_approved();
