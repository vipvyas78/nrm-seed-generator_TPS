-- The package-specific scope of works matrix.
--
-- The client's Appendix 1 is 890 scope items against 63 packages, each cell saying whether
-- that item falls in that package's scope. Groundwork alone carries 208 of them.
--
-- This is the document that makes the pricing coordinate. The bill says what is measured;
-- the scope matrix and the schedule of attendances say what the subcontractor is carrying
-- around it — traffic slingers, step-down transformers, temporary ramps, apprentice
-- allowances, fire proofing to steel connections. Price a bill without them and the tender
-- is neither complete nor comparable, because each tenderer guesses differently.
--
-- `designation` separates the two kinds of item:
--   Package — specific to certain trades (Pile probing, WES Fire Alarm system)
--   General — carried by nearly every package (apprentice allowance, temporary fencing)
--
-- `procurement_stage` marks where the cost sits: Contract items are priced into the
-- subcontract, Profit Plan items are carried by the main contractor's own budget. A
-- tenderer must not price a Profit Plan item, so the distinction has to travel with the ITT.

CREATE TABLE IF NOT EXISTS tps.scope_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL,
  project_id        UUID,
  ref               INTEGER NOT NULL,
  description       TEXT NOT NULL CHECK (length(btrim(description)) > 0),
  procurement_stage TEXT,
  designation       TEXT,
  -- Package names as written in the client's matrix. Held as an array rather than a join
  -- table because the matrix is authored and replaced wholesale, never edited cell by cell,
  -- and because the names are the client's own vocabulary — they do not all correspond to a
  -- configured package, and the ones that do not must stay visible rather than being
  -- silently dropped on import.
  packages          TEXT[] NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (organization_id, project_id, ref)
);

CREATE INDEX IF NOT EXISTS tpsi_lookup_idx ON tps.scope_items (organization_id, project_id, ref);
-- GIN so "every scope item for this package" is an index lookup rather than a scan of 890
-- rows per package, on a screen that renders every package at once.
CREATE INDEX IF NOT EXISTS tpsi_packages_idx ON tps.scope_items USING GIN (packages);
