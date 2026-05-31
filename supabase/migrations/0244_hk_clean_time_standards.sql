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
-- NOT pre-seeded, on purpose. The table starts EMPTY for every property and
-- every read path falls back to the existing static defaults until a manager
-- saves a value — so applying this migration changes NOTHING about the
-- estimates (the rules-engine base, incl. its standard/suite split, and the
-- board/timeline DEFAULT_BASE_DURATIONS fallback are all untouched). It also
-- works on day one with zero data: GET /api/settings/clean-times returns the
-- industry defaults (src/lib/clean-time-standards.ts CLEAN_TIME_DEFAULT_MINUTES,
-- = BASE_DURATION_MIN[*].standard) so the Settings page shows real, editable
-- numbers. The first time a manager saves, rows are created and that
-- property's edited types switch to the manager-set value (which applies to
-- all room types, per the single-value-per-type UI). Pre-seeding instead
-- would have silently flipped suites off their premium and shifted the board
-- fallback the moment the migration ran — an unwanted on-deploy behaviour
-- change (flagged in review).
--
-- NOTE: `no_clean` is intentionally NOT allowed in this table. It is, by
-- definition, 0 minutes, which the base_minutes CHECK (> 0) forbids; the
-- resolvers fall back to the static 0 for it. The 7 allowed values are the
-- real, editable cleaning-work types from the cleaning_tasks CHECK (0210).
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

-- One standard per (property, cleaning_type, room_type). NULLS NOT DISTINCT
-- (PG15+; prod is PG17) makes the all-rooms row (room_type NULL) unique per
-- (property, cleaning_type) — a plain UNIQUE treats each NULL as distinct and
-- would let duplicate all-rooms rows in. A plain column list (not a
-- coalesce(...) expression) lets PostgREST infer this index for the atomic
-- bulk upsert the settings API uses (clean-time-standards-server.ts).
create unique index if not exists hk_clean_time_standards_uq
  on public.hk_clean_time_standards (property_id, cleaning_type, room_type) nulls not distinct;

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

-- No seed rows — see the header. The table starts empty; GET falls back to
-- the industry defaults and the engine/board fall back to their static maps
-- until a manager saves, keeping this migration behaviour-neutral on apply.

insert into public.applied_migrations (version, description)
values ('0244', 'Manager-editable standard cleaning-time table (hk_clean_time_standards) for housekeeping workload estimates')
on conflict (version) do nothing;

notify pgrst, 'reload schema';
