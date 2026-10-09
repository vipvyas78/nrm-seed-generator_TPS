-- Self-priced work packages (BuildFlow issue #143).
--
-- A main contractor may price a package itself instead of tendering it to subcontractors. That
-- is a ROUTE OF PROCUREMENT, and routes are client configuration with free-text labels — so a
-- client renaming "Self priced" must not change behaviour. The behaviour hangs off a flag on the
-- route option, and the shortlist carries its own copy stamped at save time, so renaming or
-- deactivating the route later cannot rewrite what a tender decided.

ALTER TABLE tps.route_options
  ADD COLUMN IF NOT EXISTS is_self_priced BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE tps.shortlists
  ADD COLUMN IF NOT EXISTS is_self_priced BOOLEAN NOT NULL DEFAULT FALSE;

-- Every organisation that already has a route list gets the option.
INSERT INTO tps.route_options (organization_id, label, sort_order, is_self_priced)
SELECT DISTINCT organization_id, 'Self priced', 90, TRUE
  FROM tps.route_options
ON CONFLICT (organization_id, label) DO UPDATE SET is_self_priced = TRUE;

-- A self-priced return has no subcontractor behind it.
ALTER TABLE tps.tender_returns
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'subcontractor';

-- The main contractor's own pricing of a self-priced package. A draft lives here — NOT in
-- tender_returns — because everything that reads tender_returns (quote comparison, award)
-- treats a row as a received bid. Submission promotes the draft into a return, the same
-- move pricing_portal_links makes for a subcontractor.
CREATE TABLE IF NOT EXISTS tps.self_pricing_drafts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id     UUID NOT NULL REFERENCES tps.workflows (id) ON DELETE CASCADE,
  package_name    TEXT NOT NULL,
  programme_weeks INTEGER,
  qualifications  TEXT,
  exclusions      TEXT,
  -- Snapshotted from the ITT assembly on first open, so the bill priced cannot change under
  -- the estimator if the take-off is re-run. Same reasoning as pricing_portal_lines.
  lines           JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_by      UUID,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at    TIMESTAMPTZ,
  tender_return_id UUID,
  UNIQUE (workflow_id, package_name)
);
