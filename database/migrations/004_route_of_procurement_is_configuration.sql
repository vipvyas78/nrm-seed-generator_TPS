-- The route of procurement is client configuration, not a fixed vocabulary.
--
-- 003 constrained it to three values (supply_and_install, design_supply_and_install,
-- install_only). The first real client package list disproves that: it carries eight
-- distinct routes across 68 packages, and does not use "install only" at all —
--
--   Supply and install                              40
--   Design, Supply and install                      14
--   Full scope to completion                         6   (consultant appointments)
--   Full scope including cart away                   3
--   Full scope including providing report            2
--   Design and undertake                             2
--   Full scope including cart away and certificate   1
--   Design (connection only), supply and install     1
--
-- Several are scope statements rather than routes in the textbook sense, which is the
-- point: this is the client's own language, agreed with them at project set-up, and the
-- next client will phrase it differently again. A CHECK here would mean a migration
-- every time we onboard someone.
--
-- Stored verbatim as entered so it reads back exactly as the client wrote it. The API
-- exposes the distinct configured values so the UI can offer them as a closed list,
-- which is what catches a typo — validation by what is already configured, not by a
-- vocabulary baked into the schema.

DO $$
DECLARE
    cname TEXT;
BEGIN
    SELECT conname INTO cname
      FROM pg_constraint
     WHERE conrelid = 'tps.package_config'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%route_of_procurement%';
    IF cname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE tps.package_config DROP CONSTRAINT %I', cname);
    END IF;
END $$;

-- Still required, still non-empty — every package must say how it is being procured.
ALTER TABLE tps.package_config
  ADD CONSTRAINT package_config_route_not_blank CHECK (length(btrim(route_of_procurement)) > 0);
