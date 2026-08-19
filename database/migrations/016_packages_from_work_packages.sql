-- The package list stops being configuration and becomes a projection of the take-off.
--
-- Until now tps.package_config WAS the answer to "which packages is this project tendering":
-- 144 rows loaded once from the client's spreadsheet through PUT /api/tender-prep/config/
-- packages, with no UI, org-wide (project_id IS NULL), the same list for every project.
-- Alongside it, tps.scope_items holds 890 rows of scope-of-works matrix keyed by package
-- NAME.
--
-- The parent platform now answers the same question from the take-off's own NRM codes.
-- public.nrm_sub_element_work_package maps every NRM1 sub-element to a work package and
-- says, in wp_scope_condition, when that package is required:
--
--   All      always
--   TOQ      only when the take-off actually measured work under it
--   D&B      only on a design-and-build appointment (bf_projects.project_scope)
--   Manual   never from the take-off -- prelims, staff, insurances, added by hand
--
-- So the list is derived, once per release, from the take-off + the project scope.
--
-- WHY THIS TABLE IS NOT DROPPED, which is the load-bearing decision here. Package identity
-- in this schema is a bare string, not a key:
--
--   package_bill_lines.package_config_id   FK   -> a delete CASCADES
--   attendance_items.package_config_id     FK   -> a delete CASCADES
--   shortlists.package_name                TEXT
--   itt_line_overrides.package_name        TEXT
--   tender_returns.package_name            TEXT
--   precontract_minutes.package_name       TEXT
--
-- Replacing the table would take Step 1's confirm flow, the ITT's sections 2b and 4, and
-- every per-line ITT override with it. replacePackageConfig already learned this the hard
-- way -- its own comment records a delete-then-reinsert that "silently wiped 890 lines of
-- survey schedule". So the rows become derived and the table stays.
--
-- The 144 existing org-wide rows are UNTOUCHED. listPackageConfig already prefers rows
-- carrying this project's project_id and falls back to the org default only when there are
-- none, so a project that has never been tendered keeps behaving exactly as it does today.

-- ---------------------------------------------------------------------------
-- 1. Where a derived row came from
-- ---------------------------------------------------------------------------
ALTER TABLE tps.package_config
  ADD COLUMN IF NOT EXISTS wp_code              TEXT,
  ADD COLUMN IF NOT EXISTS wp_scope_condition   TEXT,
  ADD COLUMN IF NOT EXISTS derived_from_takeoff TEXT,
  ADD COLUMN IF NOT EXISTS is_active            BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN tps.package_config.wp_code IS
  'public.work_package_config.wp_code this row was generated from. NULL for a hand-loaded '
  'row. Rows carrying one are rebuilt on every takeoff.tendered and must not be hand-edited.';

COMMENT ON COLUMN tps.package_config.wp_scope_condition IS
  'Why this package is in the list: All | TOQ | D&B | Manual, copied from '
  'public.nrm_sub_element_work_package. A Manual row is offered, never auto-selected -- it '
  'is work no take-off measures.';

COMMENT ON COLUMN tps.package_config.derived_from_takeoff IS
  'The takeoff_id whose release generated this row. A re-run mints a new takeoff_id, so this '
  'also says how stale the list is.';

COMMENT ON COLUMN tps.package_config.is_active IS
  'FALSE where a rebuild no longer selects this package. Deactivated rather than deleted: '
  'package_bill_lines and attendance_items cascade, and a package dropping out of scope is '
  'not a reason to destroy the bill someone authored against it.';

-- One work package is one package row per project. Partial, because the 144 hand-loaded
-- rows all carry NULL and Postgres would otherwise treat them as one colliding value.
CREATE UNIQUE INDEX IF NOT EXISTS tppc_wp_code_idx
  ON tps.package_config (organization_id, project_id, wp_code)
  WHERE wp_code IS NOT NULL;

-- Step 1 lists one project's derived packages in order on every load.
CREATE INDEX IF NOT EXISTS tppc_derived_idx
  ON tps.package_config (organization_id, project_id, is_active, seq)
  WHERE wp_code IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. A derived package's route is chosen, not blank
-- ---------------------------------------------------------------------------
-- package_config_route_not_blank (migration 004) still applies, and a generated row has to
-- satisfy it. The generator picks a default from the project scope, and the reviewer changes
-- it in Step 1 exactly as they do for a hand-loaded package -- the route was always a choice
-- offered from tps.route_options rather than a fixed vocabulary, and that does not change.
--
-- The default is registered in route_options by the generator, not here: route_options is
-- ORGANIZATION-scoped and a migration has no organization to register it against. Seeding it
-- for every org that happens to exist would put rows in tenants that never tender.

COMMENT ON TABLE tps.package_config IS
  'The packages a project is tendering. Rows with wp_code are DERIVED from a released '
  'take-off (BuildFlow topic takeoff.tendered) and are rebuilt on each release; rows without '
  'one are the legacy hand-loaded list, still served to any project that has never been '
  'tendered. PUT /api/tender-prep/config/packages writes only the latter.';
