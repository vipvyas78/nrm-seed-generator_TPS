-- Attribute BoQ lines to packages by NRM code, not by matching prose.
--
-- The first ITT drew four priceable lines for Groundwork out of a take-off of 848, because
-- lines were attributed by running the trade matcher over boq_items.description. That
-- matcher exists to compare a package name against a supply-chain register's free text; a
-- BoQ description is a measured item ("Basement excavation — ground-floor area"), not a
-- trade name, so it only ever hit by accident.
--
-- boq_items already carries the right key. Every row has ge_code — the NRM group element —
-- and most carry element_code beneath it:
--
--   GE0 Facilitating works    19    GE4 Fittings and furnishings   16
--   GE1 Substructure          13    GE5 Services                  154
--   GE2 Superstructure       123    GE7 Work to existing            1
--   GE3 Internal finishes     49    GE8 External works             45
--
-- So a package says which NRM codes it is procured against, the same way it already says
-- which trade terms it is matched on. Two columns because the two grain sizes are both
-- needed: GE1 takes the whole of substructure, while a prefix like '8.5' takes just the
-- drainage channel out of external works without dragging in bollards and tarmac.
--
-- Where a package configures neither, attribution falls back to the description matcher, so
-- nothing that works today stops working.

ALTER TABLE tps.package_config
  ADD COLUMN IF NOT EXISTS boq_ge_codes         TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS boq_element_prefixes TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN tps.package_config.boq_ge_codes IS
  'NRM group elements procured under this package, e.g. {GE1,GE0}. Empty means fall back to description matching.';
COMMENT ON COLUMN tps.package_config.boq_element_prefixes IS
  'Element code prefixes for finer attribution, e.g. {1A,8.5}. Matched as element_code LIKE prefix || ''%''.';

-- True when a BoQ line belongs to a package.
--
-- Codes win outright when configured: they are exact, auditable, and a quantity surveyor
-- can check them against the NRM. The description fallback is deliberately only reachable
-- when no codes are set, rather than being OR-ed in — mixing a precise rule with a fuzzy one
-- means the fuzzy one silently widens every package that also has codes.
CREATE OR REPLACE FUNCTION tps.boq_line_in_package(
  line_ge_code      TEXT,
  line_element_code TEXT,
  line_description  TEXT,
  ge_codes          TEXT[],
  element_prefixes  TEXT[],
  trade_terms       TEXT[]
) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
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
  END;
$$;
