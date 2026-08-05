-- TPS — Tender Preparation & Submission
-- 8 tables scoped to organization_id, in the `tps` schema of the shared buildflow
-- database. The parent platform (nrm-seed-generator) owns `public`; links to its
-- identity and takeoff tables (organization_id, package_id, created_by, ...) and to
-- SCMS (subcontractor_id -> scms.subcontractors) are bare UUIDs by design, with no
-- cross-schema foreign keys.
--
-- All DDL below is schema-qualified. A wrong search_path here would fail silently by
-- creating objects in `public` and polluting the parent's namespace, so nothing is
-- left to resolution order.
--
-- gen_random_uuid() comes from pgcrypto, which the parent's 001_bff_core.sql already
-- installs on this database.

CREATE SCHEMA IF NOT EXISTS tps;

-- 1. Workflow per package (one-to-one with public.bf_takeoff_packages)

CREATE TABLE IF NOT EXISTS tps.workflows (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id      UUID NOT NULL,
  organization_id UUID NOT NULL,
  current_step    INTEGER NOT NULL DEFAULT 1 CHECK (current_step BETWEEN 1 AND 7),
  step_data       JSONB NOT NULL DEFAULT '{}',
  locked_at       TIMESTAMPTZ,
  archived_at     TIMESTAMPTZ,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (package_id)
);

CREATE INDEX IF NOT EXISTS tpw_package_idx ON tps.workflows (package_id);
CREATE INDEX IF NOT EXISTS tpw_org_idx ON tps.workflows (organization_id);

-- 2. Step 2 — Employer RFIs (conflict items)

CREATE TABLE IF NOT EXISTS tps.rfis (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id  UUID NOT NULL REFERENCES tps.workflows (id) ON DELETE CASCADE,
  description  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'responded', 'closed')),
  employer_response TEXT,
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tpr_workflow_idx ON tps.rfis (workflow_id);

-- 3. Step 3 — SoA RAG rows

CREATE TABLE IF NOT EXISTS tps.soa_rag (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id  UUID NOT NULL REFERENCES tps.workflows (id) ON DELETE CASCADE,
  clause_ref   TEXT NOT NULL,
  amendment_text TEXT,
  rag_status   TEXT NOT NULL DEFAULT 'green' CHECK (rag_status IN ('red', 'amber', 'green')),
  jct_nec4_ref TEXT,
  commentary   TEXT,
  reviewed_by  UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workflow_id, clause_ref)
);

CREATE INDEX IF NOT EXISTS tpsr_workflow_idx ON tps.soa_rag (workflow_id);

-- 4. Step 4 — Shortlist header (one per trade per workflow)

CREATE TABLE IF NOT EXISTS tps.shortlists (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id         UUID NOT NULL REFERENCES tps.workflows (id) ON DELETE CASCADE,
  trade_category      TEXT NOT NULL,
  confirmed_at        TIMESTAMPTZ,
  board_override_notes TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workflow_id, trade_category)
);

CREATE INDEX IF NOT EXISTS tpsl_workflow_idx ON tps.shortlists (workflow_id);

-- 5. Step 4 — Shortlist entries (up to 5 per trade)
-- subcontractor_id points at scms.subcontractors, owned by the SCMS module.

CREATE TABLE IF NOT EXISTS tps.shortlist_entries (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shortlist_id       UUID NOT NULL REFERENCES tps.shortlists (id) ON DELETE CASCADE,
  subcontractor_id   UUID NOT NULL,
  rank               INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 5),
  performance_score  NUMERIC(5,2),
  compliance_flags   JSONB,
  board_approved     BOOLEAN NOT NULL DEFAULT FALSE,
  substituted_by     UUID REFERENCES tps.shortlist_entries (id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shortlist_id, rank)
);

CREATE INDEX IF NOT EXISTS tpse_shortlist_idx ON tps.shortlist_entries (shortlist_id);

-- 6. Step 5 — ITT dispatch tracking

CREATE TABLE IF NOT EXISTS tps.itt_dispatch (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shortlist_entry_id   UUID NOT NULL REFERENCES tps.shortlist_entries (id) ON DELETE CASCADE,
  dispatched_at        TIMESTAMPTZ,
  response             TEXT CHECK (response IN ('will_tender', 'decline', 'considering', 'no_response')),
  responded_at         TIMESTAMPTZ,
  reminder_sent_at     TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shortlist_entry_id)
);

CREATE INDEX IF NOT EXISTS tpid_entry_idx ON tps.itt_dispatch (shortlist_entry_id);

-- 7. Step 6 — Comparative analysis (one row per tenderer per workflow)

CREATE TABLE IF NOT EXISTS tps.comparative (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id       UUID NOT NULL REFERENCES tps.workflows (id) ON DELETE CASCADE,
  tenderer_name     TEXT NOT NULL,
  tendered_sum      NUMERIC(15,2),
  estimate_sum      NUMERIC(15,2),
  scope_compliance  JSONB,
  qualifications    TEXT,
  recommendation    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tpc_workflow_idx ON tps.comparative (workflow_id);

-- 8. Step 7 — Tender submission (draft + board approval)

CREATE TABLE IF NOT EXISTS tps.submission (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id         UUID NOT NULL REFERENCES tps.workflows (id) ON DELETE CASCADE,
  packages            JSONB NOT NULL DEFAULT '[]',
  aggregate_total     NUMERIC(15,2),
  board_approved_at   TIMESTAMPTZ,
  board_approved_by   UUID,
  dispatched_at       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workflow_id)
);

CREATE INDEX IF NOT EXISTS tpsub_workflow_idx ON tps.submission (workflow_id);
