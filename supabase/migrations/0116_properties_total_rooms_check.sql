-- Phase K (2026-05-13): properties.total_rooms must be > 0.
--
-- Why this exists:
--   The column was created in migration 0001 with `not null default 0`.
--   Zero is a structurally-invalid hotel size — no rooms = no work to do
--   = nothing to predict. The default silently created misconfigured
--   properties whenever a new row was inserted without specifying it,
--   and the ML stack would then log+skip every prediction call for that
--   property (PropertyMisconfiguredError caught at the cron boundary).
--
--   The previous design relied on log+skip to keep one bad property
--   from taking down the fleet. That's still the right *runtime*
--   behavior. But the root cause — letting `total_rooms = 0` exist at
--   all — never had to ship in the first place.
--
-- What this does:
--   1. Safety check: if any row currently violates the constraint,
--      RAISE EXCEPTION with the count so the operator knows what to
--      backfill before retrying. Beaumont (the only live property as
--      of 2026-05-13) has total_rooms set, so this should pass clean.
--   2. DROP the bogus DEFAULT 0 — future inserts must explicitly say.
--   3. ADD CHECK (total_rooms > 0) — Postgres enforces it from now on.
--      Catches API insert paths, manual SQL inserts via the Supabase
--      dashboard, seed scripts — any path. Unbypassable.
--
-- timezone IANA validation stays at runtime (require_property_timezone
-- in ml-service/src/errors.py — Phase K bug 3 fix). SQL can't validate
-- IANA names without an extension and the runtime guard is already
-- placed at every ML entry point.

do $$
begin
  if exists (select 1 from public.properties where total_rooms <= 0) then
    raise exception 'Cannot apply CHECK (total_rooms > 0): % rows violate it. Set a real total_rooms for those properties before retrying.',
      (select count(*) from public.properties where total_rooms <= 0);
  end if;
end $$;

alter table public.properties
  alter column total_rooms drop default;

alter table public.properties
  add constraint properties_total_rooms_positive check (total_rooms > 0);

INSERT INTO public.applied_migrations (version, description)
VALUES ('0116', 'Phase K: properties.total_rooms must be > 0 (CHECK constraint + drop bogus DEFAULT 0)')
ON CONFLICT (version) DO NOTHING;
