-- The rest of the Invitation to Tender: returnable forms and the schedule of attendances.
--
-- The ITT built so far carries scope, the priced bill, the document schedule and Value
-- Engineering. The client's own ITT letter shows that is four sections of six, and that a
-- tender return is evaluated on six documents, not one. What was missing:
--
--   Section 1  Instructions to Tenderers, Form of Tender, Declaration of Non-Collusion,
--              Self-Billing Agreement
--   Section 3  Schedule of Attendances
--   Section 6  Draft pre-contract meeting minutes
--
-- Two of those — the Form of Tender and the Declaration — are instruments the subcontractor
-- signs and sends back. They are not reference documents to attach; they are a return that
-- has to be captured and checked in, which is why they get a table of their own rather than
-- being another row in the document schedule.
--
-- The Schedule of Attendances is the bigger commercial omission. It is the line-by-line
-- split of who provides what — scaffolding over 3.3m, 110V temporary power, craneage,
-- welfare, waste, testing — between the main contractor and the subcontractor. Issue an ITT
-- without it and every return comes back qualified, because no tenderer will price
-- attendances they have not been told they are carrying.

-- ── Returnable forms ────────────────────────────────────────────────────────────────
--
-- What a compliant tender must contain. Configured per organisation because the list is a
-- house standard: the client's letter names six, and evaluation is expressly based on them.

CREATE TABLE IF NOT EXISTS tps.itt_return_forms (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  seq             INTEGER NOT NULL CHECK (seq > 0),
  name            TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  description     TEXT,
  -- A tender missing a required form is not compliant; the ITT says so and the return
  -- check-in can refuse it.
  is_required     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, seq),
  UNIQUE (organization_id, name)
);

-- Which forms actually came back with a return, and whether they were accepted.
CREATE TABLE IF NOT EXISTS tps.tender_return_forms (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id    UUID NOT NULL REFERENCES tps.tender_returns (id) ON DELETE CASCADE,
  form_name    TEXT NOT NULL,
  received     BOOLEAN NOT NULL DEFAULT FALSE,
  received_at  TIMESTAMPTZ,
  accepted     BOOLEAN,
  notes        TEXT,
  UNIQUE (return_id, form_name)
);

-- ── Schedule of attendances ─────────────────────────────────────────────────────────
--
-- Owner codes are the client's own: SC subcontractor, H main contractor, J joint, N/A not
-- available on this project. Held per organisation as the house schedule, optionally
-- overridden per project, and optionally per package where a trade differs.

CREATE TABLE IF NOT EXISTS tps.attendance_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL,
  project_id        UUID,
  -- When set, this row overrides the general schedule for one package only.
  package_config_id UUID REFERENCES tps.package_config (id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL CHECK (seq > 0),
  group_name        TEXT NOT NULL,
  description       TEXT NOT NULL CHECK (length(btrim(description)) > 0),
  owner             TEXT NOT NULL CHECK (owner IN ('SC', 'H', 'J', 'N/A')),
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (organization_id, project_id, package_config_id, seq)
);

CREATE INDEX IF NOT EXISTS tpai_lookup_idx
  ON tps.attendance_items (organization_id, project_id, package_config_id, seq);

-- ── Pre-contract minutes ────────────────────────────────────────────────────────────
--
-- Issued as a draft with the ITT so a tenderer prices knowing the terms of employment, then
-- completed at award. Held per package because the form of subcontract and whether design
-- is included vary by trade.

CREATE TABLE IF NOT EXISTS tps.precontract_minutes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id         UUID NOT NULL REFERENCES tps.workflows (id) ON DELETE CASCADE,
  package_name        TEXT NOT NULL,
  form_of_subcontract TEXT,
  subcontract_type    TEXT,
  executed_as         TEXT,
  works_summary       TEXT,
  status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'issued_with_itt', 'agreed')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workflow_id, package_name)
);
