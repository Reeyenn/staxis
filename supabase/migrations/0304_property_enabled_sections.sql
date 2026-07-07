-- 0304 — properties.enabled_sections: per-hotel on/off for the 8 app sections.
--
-- feature/section-toggles (2026-07-07). The founder's rule: a hotel only uses
-- some of the app. An admin (Live Hotels card) or the owner (onboarding wizard)
-- turns a whole nav section off for a hotel; it then disappears for EVERYONE at
-- that hotel and its section-specific background compute (housekeeping ML,
-- inventory ML, …) pauses. It NEVER touches the PMS robot ingestion or the SMS
-- worker — those are app-wide infrastructure, not a section.
--
-- SEMANTICS (the whole safety mechanism):
--   NULL, a missing key, or any non-false value  = section ON (the default).
--   ONLY an explicit boolean `false` turns a section off.
-- => Every EXISTING hotel is NULL = all 8 sections on, untouched by this change.
--    There is deliberately NO backfill and NO all-false default: the reader
--    (isSectionEnabled in src/lib/sections/registry.ts) supplies the default-ON.
--
-- The 8 keys: staxis, dashboard, housekeeping, communications, maintenance,
-- inventory, staff, financials. Written by the admin Sections modal and the
-- onboarding apps step (same column = one source of truth). This SUPERSEDES the
-- never-implemented "dashboard hides nav items" intent of the legacy
-- services_enabled column, which is left untouched.

BEGIN;

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS enabled_sections jsonb;

COMMENT ON COLUMN public.properties.enabled_sections IS
  'Per-hotel on/off map for the 8 app sections (staxis,dashboard,housekeeping,communications,maintenance,inventory,staff,financials). NULL / missing key / any non-false value = section ON (default). ONLY explicit boolean false disables. NULL = all-on so existing hotels are unaffected (no backfill). Resolved by isSectionEnabled() in src/lib/sections/registry.ts; written by the admin Sections modal and the onboarding apps step. Never gates PMS ingestion or the SMS worker.';

INSERT INTO public.applied_migrations (version, description)
VALUES (
  '0304',
  'properties.enabled_sections — per-hotel on/off for the 8 app sections; NULL=all-on (no backfill); default-ON resolver in src/lib/sections/registry.ts; never gates PMS ingestion or SMS.'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
