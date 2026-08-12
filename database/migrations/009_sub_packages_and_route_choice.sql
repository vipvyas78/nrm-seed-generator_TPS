-- Sub-packages, and the route of procurement as a choice rather than a fixture.
--
-- Two changes, both making the configured breakdown something the tender launch meeting can
-- work with rather than only read.
--
-- 1. A package can be broken down. "MEP" is procured as mechanical, electrical and plumbing
--    far more often than as one lot, and which way round it goes is a decision taken per
--    project — sometimes per tender — not something to be fixed when the client's package
--    list is first loaded. A parent that has children becomes a heading: it is not tendered
--    itself, its children are.
--
-- 2. The route of procurement is picked per package at launch. It stays configured, because
--    the client's list carries a default for every package, but the meeting can override it
--    — a package the list says is "Supply and install" may go out "Design, Supply and
--    install" on a particular job. tps.shortlists already has route_of_procurement, so the
--    override has somewhere to live: config holds the default, the shortlist holds what was
--    actually chosen.

-- ── Sub-packages ────────────────────────────────────────────────────────────────────

ALTER TABLE tps.package_config
  ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES tps.package_config (id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS sub_seq   INTEGER CHECK (sub_seq IS NULL OR sub_seq > 0);

COMMENT ON COLUMN tps.package_config.parent_id IS
  'Set when this row is a breakdown of another package. Cascades: removing a parent removes its breakdown.';
COMMENT ON COLUMN tps.package_config.sub_seq IS
  'Position within the parent. NULL for a top-level package. Displayed as parent.seq "." sub_seq, e.g. 42.2.';

-- A child carries its parent's seq and is distinguished by sub_seq, so the numbering reads
-- 42, 42.1, 42.2 and the ordering falls out of (seq, sub_seq) with no renumbering of the
-- client's list. The old constraint allowed only one row per seq, which forbade exactly that.
ALTER TABLE tps.package_config
  DROP CONSTRAINT IF EXISTS package_config_organization_id_project_id_seq_key;

ALTER TABLE tps.package_config
  ADD CONSTRAINT package_config_seq_key
  UNIQUE NULLS NOT DISTINCT (organization_id, project_id, seq, sub_seq);

CREATE INDEX IF NOT EXISTS tppc_parent_idx ON tps.package_config (parent_id);

-- A breakdown must sit under a top-level package. Without this a child could be given its
-- own children, and the launch table is a two-level list, not a tree.
CREATE OR REPLACE FUNCTION tps.assert_package_parent_is_top_level() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE grandparent UUID;
BEGIN
  IF NEW.parent_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.sub_seq IS NULL THEN
    RAISE EXCEPTION 'A breakdown of a package must have a sub_seq' USING ERRCODE = 'check_violation';
  END IF;
  SELECT parent_id INTO grandparent FROM tps.package_config WHERE id = NEW.parent_id;
  IF grandparent IS NOT NULL THEN
    RAISE EXCEPTION 'A package breakdown cannot itself be broken down' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tppc_parent_is_top_level ON tps.package_config;
CREATE TRIGGER tppc_parent_is_top_level
  BEFORE INSERT OR UPDATE ON tps.package_config
  FOR EACH ROW EXECUTE FUNCTION tps.assert_package_parent_is_top_level();

-- ── Route options ───────────────────────────────────────────────────────────────────
--
-- The routes offered in the picker. Seeded from what the client's own package list already
-- uses, so the vocabulary is theirs rather than one imposed by the software; a new route can
-- be added per organisation without a migration.

CREATE TABLE IF NOT EXISTS tps.route_options (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  label           TEXT NOT NULL CHECK (length(btrim(label)) > 0),
  sort_order      INTEGER NOT NULL DEFAULT 100,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, label)
);

-- Seed each organisation's options from the routes its packages already carry, most-used
-- first so the common choice sits at the top of the list.
INSERT INTO tps.route_options (organization_id, label, sort_order)
SELECT organization_id, route_of_procurement,
       ROW_NUMBER() OVER (PARTITION BY organization_id ORDER BY count(*) DESC, route_of_procurement)
  FROM tps.package_config
 GROUP BY organization_id, route_of_procurement
ON CONFLICT (organization_id, label) DO NOTHING;
