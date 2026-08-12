-- Bills written in TPS, for packages a take-off cannot measure.
--
-- Everything priced so far comes from the take-off: a measured line, attributed to a package
-- by NRM code. That works for construction packages and cannot work for consultants. There
-- is no quantity behind "Acoustic Survey" or "Stage 3 — Spatial Coordination"; they are
-- instructed commissions and staged fees. Seven of the client's 68 packages are of this kind
-- (Architect, Structural Engineer, Civil Engineer, Acoustics, Services Engineer, Specialist
-- Consultant, Surveys), and every one of them returns an empty bill today.
--
-- So a package can carry authored lines as well as measured ones. Attached to the package
-- configuration rather than the workflow, because a survey schedule and a fee schedule are
-- agreed with the client for the project and are re-used by every tender on it — the same
-- reason the package list itself lives there.
--
-- Both sources feed the same ITT. A package may legitimately have both: measured work plus a
-- provisional sum or a stage fee. `source` on the ITT line says which it came from, so a
-- tenderer and an estimator can always tell a measured quantity from an authored item.

CREATE TABLE IF NOT EXISTS tps.package_bill_lines (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_config_id UUID NOT NULL REFERENCES tps.package_config (id) ON DELETE CASCADE,
  -- Position in the bill. Contiguous within a package; the client's own numbering, where
  -- they have one, goes in `ref`.
  seq               INTEGER NOT NULL CHECK (seq > 0),
  -- Groups lines under a heading: "Priority A", "Stage fees", "Meetings and attendances".
  section           TEXT,
  -- The client's reference for the line — survey item number, fee schedule ref such as 4.3.
  ref               TEXT,
  description       TEXT NOT NULL CHECK (length(btrim(description)) > 0),
  -- 'sum' for a lump sum, 'nr' for a counted item, 'hour'/'day' for a rate, 'item' otherwise.
  unit              TEXT NOT NULL DEFAULT 'sum',
  -- Present where the item is countable — the number of design team meetings assumed, say.
  -- NULL is normal here and does not mean the same as it does on a measured line.
  quantity          NUMERIC(14,3),
  -- Why the item is needed: Planning, BREEAM, Code. Carried onto the ITT so a tenderer knows
  -- what standard the deliverable has to meet.
  required_for      TEXT,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (package_config_id, seq)
);

CREATE INDEX IF NOT EXISTS tppbl_package_idx ON tps.package_bill_lines (package_config_id, seq);
