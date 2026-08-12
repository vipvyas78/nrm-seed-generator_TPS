-- Tighten the prefix rule in tps.trades_match.
--
-- 003 allowed a prefix match whenever the shorter token was 5+ characters, to catch
-- singular/plural and adjectival endings: Ceiling→Ceilings, Electric→Electrical.
--
-- Against the first real package list that proved far too loose. An "Architect" package
-- (a consultant appointment) pulled in 54 firms, because "architect" is a prefix of
-- "architectural" and so it matched Architectural Metalwork, Architectural Metalwork &
-- Stairs and Architectural Glazing — metalwork fabricators and glaziers, not architects.
-- "Electrical" likewise reached "Electrical Wholesalers", a merchant rather than an
-- installer.
--
-- The endings actually worth catching are short: +1 for a plural (Ceiling→Ceilings), +2
-- for an adjective (Electric→Electrical). The ones causing damage are longer:
-- architect→architectural is +4, electrical→electricalwholesalers is +11. Capping the
-- difference at 2 characters keeps every intended match and drops the rest.
--
-- Longer variants are still reachable, but must be asked for explicitly as a package
-- trade term — which is the point of the mapping being configuration.

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
        OR (length(a.tok) >= 5 AND b.pkg LIKE a.tok || '%' AND length(b.pkg) - length(a.tok) <= 2)
        OR (length(b.pkg) >= 5 AND a.tok LIKE b.pkg || '%' AND length(a.tok) - length(b.pkg) <= 2)
  );
$$;
