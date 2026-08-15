-- "Ignore for ITT" line overrides, and outcome tracking for the emails Step 2 now sends.
--
-- The ITT preview assembles return forms, BoQ lines, authored bill lines, scope items and
-- documents straight from live project data (getPackageItt). Not everything assembled
-- belongs in every email — a line can be wrong for this particular tender without being
-- wrong in the source data itself, so exclusion is recorded here rather than by editing the
-- underlying table. Row presence is the flag: a row in itt_line_overrides means that item is
-- left out of this package's ITT emails. Scoped per (workflow_id, package_name) because the
-- same package can be re-tendered in a different workflow with a different exclusion set.
--
-- itt_dispatch already exists (migration 001) and already gets one row per selected
-- shortlist_entry when an ITT is issued; it only ever recorded a bare dispatched_at
-- timestamp. The columns below add the outcome of the send itself.

CREATE TABLE IF NOT EXISTS tps.itt_line_overrides (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id  UUID NOT NULL REFERENCES tps.workflows (id) ON DELETE CASCADE,
  package_name TEXT NOT NULL,
  section      TEXT NOT NULL CHECK (section IN ('return_form', 'boq_line', 'bill_line', 'scope_item', 'document')),
  item_id      UUID NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by   UUID,
  UNIQUE (workflow_id, package_name, section, item_id)
);

CREATE INDEX IF NOT EXISTS tpilo_lookup_idx
  ON tps.itt_line_overrides (workflow_id, package_name);

ALTER TABLE tps.itt_dispatch
  ADD COLUMN IF NOT EXISTS email_status     TEXT CHECK (email_status IN ('sent', 'failed', 'skipped_no_email')),
  ADD COLUMN IF NOT EXISTS email_error      TEXT,
  ADD COLUMN IF NOT EXISTS email_sent_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS email_message_id TEXT;
