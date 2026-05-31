-- 0244_hk_clean_time_standards.sql
--
-- "Clean Times" (Layer 1 — standard table). A per-property, manager-editable
-- table of standard cleaning minutes by cleaning_type (optionally per
-- room_type). It drives the existing housekeeping workload estimates:
--   * the rules-engine BASE minutes at task-creation time
--     (src/lib/rules-engine/merger.ts), and
--   * the board / timeline / auto-assign fallback base durations
--     (src/lib/assignment-engine resolveDurationMinutes).
--
-- Seeded with the EXISTING rules-engine standard-room defaults
-- (= src/lib/rules-engine/constants.ts BASE_DURATION_MIN[*].standard) so
-- day-one behaviour is byte-identical to before this feature shipped — the
-- table just makes those numbers editable. Managers change them via
-- Settings → Clean Times.
--
-- NOTE: `no_clean` is intentionally NOT in this table. It is, by definition,
-- 0 minutes, which the base_minutes CHECK (> 0) forbids; the resolvers fall
-- back to the static 0 for it. The 7 rows below are the real, editable
-- cleaning-work types from the cleaning_tasks CHECK constraint (0210).
--
-- RLS: service-role only + deny-all browser, mirroring 0240
-- (self_serve_reports). Every read/write goes through
-- /api/settings/clean-times (supabaseAdmin) and the server-side
-- engine/cron — browser clients never touch this table directly, which
-- eliminates the RLS-bug-class silent-empty-state risk by construction.

-- @rls: service-role-only — all access via /api/settings/clean-times
-- (supabaseAdmin, requireSession + management role) and the housekeeping
-- rules-engine / auto-assign cron. No anon/authenticated browser reads.
create table if not exists public.hk_clean_time_standards (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references public.properties(id) on delete cascade,
  cleaning_type text not null check (cleaning_type in (
    'departure', 'departure_deep', 'stayover', 'refresh',
    'deep', 'room_check', 'inspection_only'
  )),
  room_type     text,                                          -- NULL = applies to all room types
  base_minutes  integer not null check (base_minutes > 0 and base_minutes <= 240),
  updated_by    uuid references public.accounts(id) on delete set null,
  updated_at    timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

-- One standard per (property, cleaning_type, room_type). NULL room_type
-- collapses to '*' so the "applies to all room types" row is unique per
-- type — a plain UNIQUE would treat each NULL as distinct and let duplicate
-- all-rooms rows in. ON CONFLICT below infers this expression index.
create unique index if not exists hk_clean_time_standards_uq
  on public.hk_clean_time_standards (property_id, cleaning_type, coalesce(room_type, '*'));

-- ── RLS: service-role only; browser clients denied. (Pattern: 0240.) ──
alter table public.hk_clean_time_standards enable row level security;
revoke all on public.hk_clean_time_standards from public, anon, authenticated;
grant select, insert, update, delete on public.hk_clean_time_standards to service_role;
drop policy if exists hk_clean_time_standards_deny_browser on public.hk_clean_time_standards;
create policy hk_clean_time_standards_deny_browser on public.hk_clean_time_standards
  for all to anon, authenticated using (false) with check (false);
comment on policy hk_clean_time_standards_deny_browser on public.hk_clean_time_standards is
  'Service-role only. Reads/writes go through /api/settings/clean-times (supabaseAdmin) and the housekeeping rules-engine/auto-assign cron. Browser clients never touch this table directly (RLS-bug-class avoidance).';

comment on table public.hk_clean_time_standards is
  'Manager-editable standard cleaning minutes per cleaning_type (optionally per room_type; NULL room_type = all rooms). Drives rules-engine base minutes + assignment fallback durations. Seeded from the rules-engine standard-room defaults; edit via Settings -> Clean Times.';

-- ── Seed every existing property with the standard-room defaults ──
-- base_minutes values mirror BASE_DURATION_MIN[*].standard so that, until a
-- manager edits a value, the resolved minutes are identical to the
-- pre-feature behaviour. Idempotent via ON CONFLICT on the unique
-- expression index, so re-running this migration is a no-op.
insert into public.hk_clean_time_standards (property_id, cleaning_type, room_type, base_minutes)
select p.id, d.cleaning_type, null::text, d.base_minutes
from public.properties p
cross join (values
  ('departure',       35),
  ('departure_deep',  50),
  ('stayover',        18),
  ('refresh',         15),
  ('deep',            90),
  ('room_check',       5),
  ('inspection_only',  5)
) as d(cleaning_type, base_minutes)
on conflict (property_id, cleaning_type, coalesce(room_type, '*')) do nothing;

insert into public.applied_migrations (version, description)
values ('0244', 'Manager-editable standard cleaning-time table (hk_clean_time_standards) for housekeeping workload estimates')
on conflict (version) do nothing;

notify pgrst, 'reload schema';
