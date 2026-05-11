-- 0068_properties_is_test.sql
-- Replace the name-based test-property heuristic with an explicit column.
--
-- BEFORE: two admin ML cockpit routes used /\b(test|canary)\b/i to
-- decide whether a property's data should pollute fleet rollups. This
-- relied on naming convention — if Reeyen ever onboards a real hotel
-- named "Test Hotel & Suites" it'd silently be excluded; conversely
-- a test property named "Sandbox" would silently pollute the averages.
--
-- AFTER: properties.is_test boolean (default false). Admin UI sets the
-- flag explicitly; cockpit routes filter on the column.
--
-- The deleted CANARY fleet-cua test property would have set this to
-- true. Comfort Suites Beaumont (the live customer) stays false.

alter table public.properties
  add column if not exists is_test boolean not null default false;

comment on column public.properties.is_test is
  'When true, this property is a test/sandbox and is excluded from network-level fleet aggregates in admin ML cockpits. Admin UI sets this explicitly. Replaces the previous /\b(test|canary)\b/i name regex which was prone to false positives (real hotel named "Test Inn") and false negatives (test property named "Sandbox").';

create index if not exists properties_is_test_idx
  on public.properties (is_test) where is_test = true;

-- Bookkeeping
insert into public.applied_migrations (version, description)
values ('0068', 'properties.is_test boolean replaces the name-based test-property regex')
on conflict (version) do nothing;
