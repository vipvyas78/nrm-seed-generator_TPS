-- Per-workflow facts the cover letter and Form 1A need that nothing in either
-- database models yet: site address, the tender return deadline, the
-- clarifications-close date, whether a site visit is permitted, and who the
-- estimator is. One row per workflow (not per package, unlike precontract_minutes) —
-- these are the same across every package in one tender exercise.

CREATE TABLE IF NOT EXISTS tps.itt_letter_details (
  workflow_id               UUID PRIMARY KEY REFERENCES tps.workflows (id) ON DELETE CASCADE,
  site_address               TEXT,
  tender_return_deadline     DATE,
  clarifications_close_date  DATE,
  site_visit_permitted       BOOLEAN,
  estimator_name             TEXT,
  estimator_email            TEXT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
