-- Tender Launch Pack becomes a numbered table of work packages.
--
-- Until now a shortlist was keyed by an SCMS trade_category picked ad hoc from the ~290
-- free-text values in that register. That is not how a project is actually broken down:
-- the client's package list and the procurement route for each package are agreed once,
-- at project configuration, and the tender launch works through that list in order.
--
-- So this migration adds:
--   1. tps.package_config  — the configured breakdown (number, name, route, trade terms)
--   2. tps.trade_tokens / tps.trades_match — token matching against SCMS's free text
--   3. columns on shortlists / shortlist_entries for route, selection and reasoning

-- ── 1. Trade matching ───────────────────────────────────────────────────────────────
--
-- SCMS stores one free-text trade per assignment, and 333 of 1,794 of them name more
-- than one trade: "Carpentry & Joinery", "Mechanical & Electrical", "Partitions &
-- Ceilings", "Fire Stopping / Fire Proofing". Equality matching throws every one of
-- those away — a firm that does drylining *and* carpentry would never be offered for a
-- drylining package, which is exactly backwards: it is more capable, not less.
--
-- trade_tokens reduces a trade string to comparable tokens:
--   - the WHOLE string, squashed. This is what keeps names whose separator is part of
--     the name intact: "FF&E" -> {ffe}. Splitting alone would yield {ff, e} and match
--     nothing sensible.
--   - each part after splitting on & / , + " and " " - ", squashed.
-- Squashing to [a-z0-9] makes "Dry Lining", "Drylining" and "DRY-LINING" the same token.
-- Tokens shorter than 3 characters are dropped: they come from acronym fragments and
-- would match far too much.

CREATE OR REPLACE FUNCTION tps.trade_tokens(raw TEXT)
RETURNS TEXT[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(ARRAY(
    SELECT DISTINCT tok FROM (
      SELECT regexp_replace(lower(COALESCE(raw, '')), '[^a-z0-9]', '', 'g') AS tok
      UNION ALL
      SELECT regexp_replace(part, '[^a-z0-9]', '', 'g')
        FROM regexp_split_to_table(
               lower(COALESCE(raw, '')),
               '\s*(?:&|/|,|\+|\sand\s|\s-\s)\s*'
             ) AS part
    ) t
    WHERE length(tok) >= 3
  ), '{}');
$$;

COMMENT ON FUNCTION tps.trade_tokens(TEXT) IS
  'Comparable tokens for a free-text trade string: the whole squashed string plus each squashed part.';

-- True when an SCMS trade string satisfies any of a package's configured trade terms.
--
-- Beyond token equality there is a prefix rule, which is what makes "Ceiling" match
-- "Ceilings" and "Joinery" match "Joinerywork". It is floored at 5 characters so short
-- tokens ("SFS", "Roof") still demand an exact hit and do not drag in half the register.
CREATE OR REPLACE FUNCTION tps.trades_match(trade_text TEXT, package_terms TEXT[])
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM unnest(tps.trade_tokens(trade_text)) AS a(tok)
      JOIN (
        SELECT DISTINCT u AS pkg
          FROM unnest(COALESCE(package_terms, '{}')) AS pt
          CROSS JOIN LATERAL unnest(tps.trade_tokens(pt)) AS u
      ) AS b ON TRUE
     WHERE a.tok = b.pkg
        OR (length(a.tok) >= 5 AND b.pkg LIKE a.tok || '%')
        OR (length(b.pkg) >= 5 AND a.tok LIKE b.pkg || '%')
  );
$$;

COMMENT ON FUNCTION tps.trades_match(TEXT, TEXT[]) IS
  'True when a free-text SCMS trade satisfies any configured package trade term.';

-- ── 2. Project configuration ────────────────────────────────────────────────────────
--
-- Agreed with the client when the project is set up, not chosen per tender. `seq` is the
-- number in the first column of the Tender Launch table and fixes the order of work.
--
-- project_id NULL means an organisation-wide default template, inherited by any project
-- with no list of its own. UNIQUE ... NULLS NOT DISTINCT (PostgreSQL 15+) is what makes
-- those NULL rows collide properly; without it every template row would be distinct and
-- duplicate sequence numbers would slip in.

CREATE TABLE IF NOT EXISTS tps.package_config (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL,
  project_id           UUID,
  seq                  INTEGER NOT NULL CHECK (seq > 0),
  name                 TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  -- The three agreed routes. Stored as stable snake_case keys, labelled in the UI.
  route_of_procurement TEXT NOT NULL CHECK (route_of_procurement IN (
                         'supply_and_install',
                         'design_supply_and_install',
                         'install_only')),
  -- Trade terms this package is procured against, matched into SCMS by tps.trades_match.
  -- Plural because one package routinely spans several ("Partitions", "Ceilings").
  -- Empty means the package name itself is the only term.
  trade_terms          TEXT[] NOT NULL DEFAULT '{}',
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (organization_id, project_id, seq),
  UNIQUE NULLS NOT DISTINCT (organization_id, project_id, name)
);

CREATE INDEX IF NOT EXISTS tppc_lookup_idx ON tps.package_config (organization_id, project_id, seq);

-- ── 3. Shortlists carry the package, its route, and the meeting's decisions ─────────
--
-- shortlists.trade_category held an SCMS trade; it now holds the configured package
-- name. Renamed rather than reused under the old name, because a column called
-- trade_category holding a package name is how the next person gets this wrong.

ALTER TABLE tps.shortlists RENAME COLUMN trade_category TO package_name;

ALTER TABLE tps.shortlists
  ADD COLUMN IF NOT EXISTS package_seq          INTEGER,
  ADD COLUMN IF NOT EXISTS route_of_procurement TEXT;

-- Every firm the software put in front of the meeting is kept, not just the chosen ones,
-- so the record shows who was considered and why — `selected` is the meeting's decision.
ALTER TABLE tps.shortlist_entries
  ADD COLUMN IF NOT EXISTS suggestion_reason TEXT,
  ADD COLUMN IF NOT EXISTS selected          BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS selected_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS selected_by       UUID;

-- rank was capped at 5 because it recorded a shortlist of five. It now orders every
-- suggestion shown at the meeting, so the ceiling has to go; the meeting picks the five.
DO $$
DECLARE
    cname TEXT;
BEGIN
    SELECT conname INTO cname
      FROM pg_constraint
     WHERE conrelid = 'tps.shortlist_entries'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%rank%';
    IF cname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE tps.shortlist_entries DROP CONSTRAINT %I', cname);
    END IF;
END $$;

ALTER TABLE tps.shortlist_entries
  ADD CONSTRAINT shortlist_entries_rank_check CHECK (rank > 0);

-- Rows created before this migration were a confirmed shortlist of five, so every one of
-- them was in effect already selected. Left unselected they would silently drop out of
-- ITT dispatch, which now sends to selected entries only.
UPDATE tps.shortlist_entries SET selected = TRUE WHERE selected = FALSE;
