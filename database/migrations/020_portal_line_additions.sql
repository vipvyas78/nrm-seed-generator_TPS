-- Two additions to the subcontractor pricing portal (019): a tenderer may now enter their
-- own quantity on any line (previously fixed from the ITT snapshot), and may add wholly new
-- lines to their response. `added_by_tenderer` distinguishes those from the ITT-assembly
-- snapshot — needed because source_item_id alone can't: it's already nullable for ordinary
-- snapshotted lines sourced from package_bill_lines rather than takeoff_items. The web UI
-- uses this flag to decide which rows may show a delete button (only these) and which must
-- stay immutable (everything snapshotted at send time).

BEGIN;

ALTER TABLE tps.pricing_portal_lines
  ADD COLUMN IF NOT EXISTS added_by_tenderer BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
