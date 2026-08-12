-- Scope item references are the client's labels, not keys.
--
-- 012 made (organization_id, project_id, ref) unique, assuming Appendix 1's Ref column
-- identified a row. It does not: three items at the end of the matrix all carry ref 888.
-- That is normal in an authored spreadsheet — the reference is a human label, maintained by
-- hand, and nothing in Excel enforces it.
--
-- So ordering moves to a surrogate `seq` assigned on import, and `ref` stays as the client's
-- own label, displayed but not relied upon.

ALTER TABLE tps.scope_items DROP CONSTRAINT IF EXISTS scope_items_organization_id_project_id_ref_key;

ALTER TABLE tps.scope_items
  ADD COLUMN IF NOT EXISTS seq INTEGER;

-- Position existing rows by ref, then id, so any already-imported set keeps a stable order.
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY organization_id, project_id ORDER BY ref, id) AS rn
    FROM tps.scope_items
)
UPDATE tps.scope_items s SET seq = o.rn FROM ordered o WHERE o.id = s.id AND s.seq IS NULL;

ALTER TABLE tps.scope_items ALTER COLUMN seq SET NOT NULL;

ALTER TABLE tps.scope_items
  ADD CONSTRAINT scope_items_seq_key UNIQUE NULLS NOT DISTINCT (organization_id, project_id, seq);

COMMENT ON COLUMN tps.scope_items.ref IS
  'The client''s own reference from Appendix 1. A label, not a key — duplicates occur.';
