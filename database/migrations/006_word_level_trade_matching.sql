-- Word-level trade matching, added alongside the existing squashed-token rules.
--
-- 003 compared squashed whole phrases; 005 capped its prefix rule at +2 characters to stop
-- an "Architect" package matching Architectural Metalwork. That cap was right for Architect
-- and wrong for everything phrased differently at the far end:
--
--   Catering Kitchen        vs  Catering / Professional Kitchen        (+7)
--   CCTV Drainage Survey    vs  Surveys & Testing - CCTV Drainage      (+6)
--   Civil Engineer          vs  Civil Engineering - Surfacing          (+3)
--   Site security (CCTV..)  vs  Security - CCTV                        no shared phrase
--
-- No threshold on whole-phrase prefixes satisfies both ends: the problem is comparing
-- phrases at all. Words are the right unit — "Catering Kitchen" and "Catering /
-- Professional Kitchen" share both of the package's words, while "Fire Stopping" and
-- "Fire Alarms" share only one and must not match.
--
-- Three word rules, any of which is enough:
--   1. every package word is present in the trade   (Carpentry ⊆ Carpentry & Joinery)
--   2. every trade word is present in the package   (Security - CCTV ⊆ Site security (CCTV…))
--   3. the two share at least two words             (Surveys…Asbestos ∩ Surveys & Testing - Asbestos)
--
-- Rule 3 is what stops rule 1 and 2 being the whole story for noisy names, and the
-- two-word floor is what keeps "Fire Stopping" away from "Fire Alarms".
--
-- This is UNIONed with the existing rules rather than replacing them, so it can only add
-- matches. Everything working today keeps working; in particular "Dry Lining & Partitions"
-- still reaches "Drylining" through the old separator-split token, which word rules miss
-- because "dry" is too short to prefix-match.
--
-- Known and accepted: rule 1 lets a single-word package into any longer trade containing
-- it, so an "Electrical" package reaches "Electrical Wholesalers" — a merchant, not an
-- installer. That is the same rule that recovers Carpentry (56 firms) and Painting (38),
-- so it earns its keep. The matched trade is shown in the reasoning column, which is how a
-- reviewer sees it and declines.

-- Squash to comparable form: lowercase, alphanumerics only.
CREATE OR REPLACE FUNCTION tps.squash(raw TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT regexp_replace(lower(COALESCE(raw, '')), '[^a-z0-9]', '', 'g');
$$;

-- Individual significant words. Splits on every non-alphanumeric, so "&", "/", "-", "(" and
-- "," all separate. Words under 3 characters go — they are the "e"/"g" of "e.g." and the
-- fragments of acronyms — as do joining words that carry no trade meaning.
CREATE OR REPLACE FUNCTION tps.trade_words(raw TEXT)
RETURNS TEXT[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(ARRAY(
    SELECT DISTINCT w
      FROM regexp_split_to_table(lower(COALESCE(raw, '')), '[^a-z0-9]+') AS w
     WHERE length(w) >= 3
       AND w NOT IN ('and','the','for','all','etc','inc','ltd','only','plc','out')
  ), '{}');
$$;

-- Two words mean the same trade. Prefix tolerance of 3 covers plurals and the endings that
-- matter (engineer→engineering, roof→roofing, electric→electrical) while still refusing
-- architect→architectural, which is +4 and was the original false positive.
CREATE OR REPLACE FUNCTION tps.word_equiv(w TEXT, x TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT w = x
      OR (length(w) >= 4 AND x LIKE w || '%' AND length(x) - length(w) <= 3)
      OR (length(x) >= 4 AND w LIKE x || '%' AND length(w) - length(x) <= 3);
$$;

-- Every word of `a` has a counterpart in `b`. Empty `a` returns false: an empty set is
-- vacuously a subset of anything, which would match the entire register.
CREATE OR REPLACE FUNCTION tps.words_covered(a TEXT[], b TEXT[])
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT cardinality(a) > 0 AND cardinality(b) > 0 AND NOT EXISTS (
    SELECT 1 FROM unnest(a) AS w
     WHERE NOT EXISTS (SELECT 1 FROM unnest(b) AS x WHERE tps.word_equiv(w, x))
  );
$$;

CREATE OR REPLACE FUNCTION tps.shared_words(a TEXT[], b TEXT[])
RETURNS INTEGER LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT count(DISTINCT w)::int FROM unnest(a) AS w
   WHERE EXISTS (SELECT 1 FROM unnest(b) AS x WHERE tps.word_equiv(w, x));
$$;

CREATE OR REPLACE FUNCTION tps.trades_match(trade_text TEXT, package_terms TEXT[])
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT
    -- Existing squashed-token rules, unchanged (005).
    EXISTS (
      SELECT 1
        FROM unnest(tps.trade_tokens(trade_text)) AS a(tok)
        JOIN (
          SELECT DISTINCT u AS pkg
            FROM unnest(COALESCE(package_terms, '{}')) AS pt
            CROSS JOIN LATERAL unnest(tps.trade_tokens(pt)) AS u
        ) AS b ON TRUE
       WHERE a.tok = b.pkg
          OR (length(a.tok) >= 5 AND b.pkg LIKE a.tok || '%' AND length(b.pkg) - length(a.tok) <= 2)
          OR (length(b.pkg) >= 5 AND a.tok LIKE b.pkg || '%' AND length(a.tok) - length(b.pkg) <= 2)
    )
    OR
    -- Word-level rules, per package term.
    EXISTS (
      SELECT 1
        FROM unnest(COALESCE(package_terms, '{}')) AS pt
       WHERE tps.words_covered(tps.trade_words(pt), tps.trade_words(trade_text))
          OR tps.words_covered(tps.trade_words(trade_text), tps.trade_words(pt))
          OR tps.shared_words(tps.trade_words(pt), tps.trade_words(trade_text)) >= 2
    );
$$;
