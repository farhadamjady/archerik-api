-- Retire the deploy-identity / host-resolution feature (service-catalog pivot).
-- The identity map (deploy-repo host -> service_name/namespace facts) is no longer produced by the
-- extractor or consumed by the projector, so drop its table. FK to accounts drops with the table.
DROP TABLE IF EXISTS "identity_map_entries";
