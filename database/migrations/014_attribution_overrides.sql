-- Let a package claim, or disown, a named line the NRM code puts in the wrong trade.
--
-- Codes are the right primary key for attribution and migration 007 was correct to make them
-- win outright. But a code is only as good as the take-off that wrote it, and this take-off
-- has miscoded lines that no code map can separate:
--
--   element 5.3 is NRM "Disposal installations" — drainage — yet holds
--     "LUMINAIRE SCHEDULE" and "EMERGENCY EXIT SIGN", which are electrical
--   element 5.11 is "Fire and lightning protection" yet holds
--     "FD30 Fire Door" and "Fire Alarm Tray", which are joinery and electrical containment
--
-- Those lines share their element_code with lines that are correctly coded, so no prefix can
-- reach one without taking the other. The only distinguishing information is the description.
--
-- This is deliberately NOT the description matcher from 003. That matcher compares a package
-- name against free text and guesses; these are exact, hand-written phrases naming one line
-- each, recorded so a QS can see precisely which line was moved and why. Two arrays:
--
--   boq_include_terms  pull a line in even though its code says otherwise
--   boq_exclude_terms  push a line out even though its code says it belongs
--
-- Exclusion is applied last and beats everything, so a line moved out of one package cannot
-- also stay in it. Both are matched case-insensitively as substrings of the description.

ALTER TABLE tps.package_config
  ADD COLUMN IF NOT EXISTS boq_include_terms TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS boq_exclude_terms TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN tps.package_config.boq_include_terms IS
  'Description phrases claimed by this package regardless of NRM code, for lines the take-off miscoded.';
COMMENT ON COLUMN tps.package_config.boq_exclude_terms IS
  'Description phrases this package disowns regardless of NRM code. Applied last: exclusion always wins.';

-- Replaces the 6-argument form from migration 007. Dropped rather than overloaded, because
-- two functions of the same name differing only in trailing arrays is exactly the kind of
-- ambiguity that silently resolves to the wrong one.
DROP FUNCTION IF EXISTS tps.boq_line_in_package(TEXT, TEXT, TEXT, TEXT[], TEXT[], TEXT[]);

CREATE OR REPLACE FUNCTION tps.boq_line_in_package(
  line_ge_code      TEXT,
  line_element_code TEXT,
  line_description  TEXT,
  ge_codes          TEXT[],
  element_prefixes  TEXT[],
  trade_terms       TEXT[],
  include_terms     TEXT[] DEFAULT '{}',
  exclude_terms     TEXT[] DEFAULT '{}'
) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT
    -- Exclusion first and unconditionally: a package that has disowned a line is out,
    -- whatever its codes say.
    NOT EXISTS (SELECT 1 FROM unnest(COALESCE(exclude_terms, '{}')) AS x
                 WHERE line_description ILIKE '%' || x || '%')
    AND (
      EXISTS (SELECT 1 FROM unnest(COALESCE(include_terms, '{}')) AS n
               WHERE line_description ILIKE '%' || n || '%')
      OR CASE
        WHEN cardinality(COALESCE(ge_codes, '{}')) > 0
          OR cardinality(COALESCE(element_prefixes, '{}')) > 0
        THEN
          -- GE codes are hierarchical: GE5 owns GE5.4, GE5.8 and the rest of its subdivisions.
          EXISTS (SELECT 1 FROM unnest(COALESCE(ge_codes, '{}')) AS g
                   WHERE line_ge_code = g OR line_ge_code LIKE g || '.%')
          OR EXISTS (SELECT 1 FROM unnest(COALESCE(element_prefixes, '{}')) AS p
                      WHERE line_element_code LIKE p || '%')
        ELSE
          tps.trades_match(line_description, trade_terms)
      END
    );
$$;
