-- Tender Preparation & Submission (TPS) — 8 tables
-- Links to existing bf_takeoff_packages and scms_subcontractors tables.

-- 1. Workflow per package (one-to-one with bf_takeoff_packages)

CREATE TABLE IF NOT EXISTS tender_prep_workflows (
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

CREATE INDEX IF NOT EXISTS tpw_package_idx ON tender_prep_workflows (package_id);
CREATE INDEX IF NOT EXISTS tpw_org_idx ON tender_prep_workflows (organization_id);

-- 2. Step 2 — Employer RFIs (conflict items)

CREATE TABLE IF NOT EXISTS tender_prep_rfis (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id  UUID NOT NULL REFERENCES tender_prep_workflows (id) ON DELETE CASCADE,
  description  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'responded', 'closed')),
  employer_response TEXT,
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tpr_workflow_idx ON tender_prep_rfis (workflow_id);

-- 3. Step 3 — SoA RAG rows

CREATE TABLE IF NOT EXISTS tender_prep_soa_rag (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id  UUID NOT NULL REFERENCES tender_prep_workflows (id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS tpsr_workflow_idx ON tender_prep_soa_rag (workflow_id);

-- 4. Step 4 — Shortlist header (one per trade per workflow)

CREATE TABLE IF NOT EXISTS tender_prep_shortlists (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id         UUID NOT NULL REFERENCES tender_prep_workflows (id) ON DELETE CASCADE,
  trade_category      TEXT NOT NULL,
  confirmed_at        TIMESTAMPTZ,
  board_override_notes TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workflow_id, trade_category)
);

CREATE INDEX IF NOT EXISTS tpsl_workflow_idx ON tender_prep_shortlists (workflow_id);

-- 5. Step 4 — Shortlist entries (up to 5 per trade)

CREATE TABLE IF NOT EXISTS tender_prep_shortlist_entries (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shortlist_id       UUID NOT NULL REFERENCES tender_prep_shortlists (id) ON DELETE CASCADE,
  subcontractor_id   UUID NOT NULL,
  rank               INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 5),
  performance_score  NUMERIC(5,2),
  compliance_flags   JSONB,
  board_approved     BOOLEAN NOT NULL DEFAULT FALSE,
  substituted_by     UUID REFERENCES tender_prep_shortlist_entries (id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shortlist_id, rank)
);

CREATE INDEX IF NOT EXISTS tpse_shortlist_idx ON tender_prep_shortlist_entries (shortlist_id);

-- 6. Step 5 — ITT dispatch tracking

CREATE TABLE IF NOT EXISTS tender_prep_itt_dispatch (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shortlist_entry_id   UUID NOT NULL REFERENCES tender_prep_shortlist_entries (id) ON DELETE CASCADE,
  dispatched_at        TIMESTAMPTZ,
  response             TEXT CHECK (response IN ('will_tender', 'decline', 'considering', 'no_response')),
  responded_at         TIMESTAMPTZ,
  reminder_sent_at     TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shortlist_entry_id)
);

CREATE INDEX IF NOT EXISTS tpid_entry_idx ON tender_prep_itt_dispatch (shortlist_entry_id);

-- 7. Step 6 — Comparative analysis (one row per tenderer per workflow)

CREATE TABLE IF NOT EXISTS tender_prep_comparative (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id       UUID NOT NULL REFERENCES tender_prep_workflows (id) ON DELETE CASCADE,
  tenderer_name     TEXT NOT NULL,
  tendered_sum      NUMERIC(15,2),
  estimate_sum      NUMERIC(15,2),
  scope_compliance  JSONB,
  qualifications    TEXT,
  recommendation    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tpc_workflow_idx ON tender_prep_comparative (workflow_id);

-- 8. Step 7 — Tender submission (draft + board approval)

CREATE TABLE IF NOT EXISTS tender_prep_submission (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id         UUID NOT NULL REFERENCES tender_prep_workflows (id) ON DELETE CASCADE,
  packages            JSONB NOT NULL DEFAULT '[]',
  aggregate_total     NUMERIC(15,2),
  board_approved_at   TIMESTAMPTZ,
  board_approved_by   UUID,
  dispatched_at       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workflow_id)
);

CREATE INDEX IF NOT EXISTS tpsub_workflow_idx ON tender_prep_submission (workflow_id);
