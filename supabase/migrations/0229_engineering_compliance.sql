-- ═══════════════════════════════════════════════════════════════════════════
-- 0229 — Engineering Compliance (feature #19)
--
-- An AI-native engineering/compliance system: recurring READINGS (pool
-- chemistry, utility meters, boiler, area temperatures) and preventive-
-- maintenance COMPLIANCE LOGS (life-safety equipment checks). Four tables —
-- two "definition" tables (the recurring obligations / schedule) and two
-- "history" tables (the timestamped, attributed log of what was actually
-- done). A rolling audit trail an inspector can read.
--
--   compliance_reading_types  — definitions: one row per recurring metric
--                               (pH, free chlorine, electric meter, walk-in
--                               fridge temp …). cadence + assigned dept +
--                               min/max safe thresholds + unit.
--   compliance_readings       — history: one row per logged value. value +
--                               timestamp + who + source (manual/voice/photo)
--                               + out-of-range flag + optional photo + the
--                               auto-created work order, if any.
--   compliance_pm_tasks       — definitions: one row per recurring equipment
--                               check (15 fire extinguishers, 18 emergency
--                               lights …). unit_count + cadence + template.
--   compliance_pm_checks      — history: one per-period check-off. period_key
--                               + pass/fail + who + when. UNIQUE per
--                               (task, period) so a period can't be double-
--                               logged.
--
-- RLS posture — SERVICE-ROLE ONLY (mirrors inspections 0212 / activity_log
-- 0228). Every read/write goes through /api/* routes using supabaseAdmin:
--   * the engineer mobile page (/engineer/[id]) is a PUBLIC page reached by
--     SMS magic-link — it MUST NOT touch these tables via the browser anon
--     client (CLAUDE.md "RLS bug class"). It uses /api/engineer/* with a
--     pid+staffId capability check.
--   * the manager Compliance tab + owner Dashboard read through
--     /api/compliance/* (requireSession + userHasPropertyAccess).
-- anon + authenticated roles are deny-all. Liveness on the manager surface is
-- refetch-on-write + poll, exactly like the laundry page and activity_log.
--
-- v2 SEAM — leak/spike anomaly detection on reading trends is explicitly OUT
-- of v1. The extension point is the per-reading insert in
-- src/lib/compliance/store.ts (clearly-marked TODO). No anomaly columns or
-- logic are added here; a future migration can add a derived `anomaly_*`
-- column without touching the v1 write path.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. compliance_reading_types — recurring measurement definitions ─────────
-- @rls: service-role-only — all UI access mediated by /api/compliance/* + /api/engineer/* via supabaseAdmin (engineer page is a public SMS-link page; matches pms_* + inspections + activity_log).
create table if not exists public.compliance_reading_types (
  id                  uuid primary key default gen_random_uuid(),
  property_id         uuid not null references public.properties(id) on delete cascade,

  category            text not null
                      check (category in ('pool','utility_meter','boiler','area_temp','other')),
  name                text not null,                 -- "Pool pH", "Electric meter", "Walk-in fridge #1"
  unit                text not null default '',       -- "pH", "ppm", "PSI", "GPM", "°F", "kWh"
  cadence             text not null default 'daily'
                      check (cadence in ('per_shift','daily','weekly','monthly')),
  assigned_department text not null default 'maintenance',  -- which dept/role logs it
  min_value           numeric,                        -- safe-range floor (null = no floor)
  max_value           numeric,                        -- safe-range ceiling (null = no ceiling)
  template_key        text,                           -- starter-template provenance, if any
  sort_order          integer not null default 0,
  active              boolean not null default true,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.compliance_reading_types is
  'Definitions for recurring engineering readings (pool chem, meters, boiler, area temps). One row per metric. property_id scoped. Created 0229.';
comment on column public.compliance_reading_types.min_value is
  'Safe-range floor. A logged value below this auto-creates a work order + SMS. NULL = no floor.';
comment on column public.compliance_reading_types.max_value is
  'Safe-range ceiling. A logged value above this auto-creates a work order + SMS. NULL = no ceiling.';

create index if not exists compliance_reading_types_prop_active_idx
  on public.compliance_reading_types (property_id, active, sort_order);

-- ── 2. compliance_readings — logged measurement history ─────────────────────
-- @rls: service-role-only — all UI access mediated by /api/compliance/* + /api/engineer/* via supabaseAdmin (engineer page is a public SMS-link page; matches pms_* + inspections + activity_log).
create table if not exists public.compliance_readings (
  id                  uuid primary key default gen_random_uuid(),
  property_id         uuid not null references public.properties(id) on delete cascade,
  reading_type_id     uuid not null references public.compliance_reading_types(id) on delete cascade,

  value               numeric,                        -- numeric reading; null if text-only / unreadable
  text_value          text,                           -- free-text fallback (e.g. "cloudy")
  unit                text not null default '',        -- unit snapshot at log time

  reading_date        date not null,                  -- property-local date (America/Chicago)
  period_key          text not null,                  -- cadence bucket: 2026-05-30 / 2026-W22 / 2026-05 / 2026-05-30:AM

  out_of_range        boolean not null default false,
  source              text not null default 'manual'
                      check (source in ('manual','voice','photo')),
  note                text,
  photo_path          text,                           -- storage path in maintenance-photos bucket

  logged_by_staff_id  uuid references public.staff(id) on delete set null,
  logged_by_name      text,                           -- name snapshot (survives staff deletion)
  logged_at           timestamptz not null default now(),

  work_order_id       uuid references public.work_orders(id) on delete set null,  -- auto-act link
  idempotency_key     text,                           -- dedupe retried voice/agent logs

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.compliance_readings is
  'Timestamped, attributed log of engineering readings. Append-mostly audit trail. property_id scoped. Created 0229.';
comment on column public.compliance_readings.period_key is
  'Cadence bucket the reading satisfies. Completion = a reading exists for the current period. Computed in src/lib/compliance/periods.ts.';
comment on column public.compliance_readings.idempotency_key is
  'Optional dedupe key for retried voice/agent logs. Partial-unique below so a retried tool call cannot double-insert.';

create index if not exists compliance_readings_type_logged_idx
  on public.compliance_readings (reading_type_id, logged_at desc);
create index if not exists compliance_readings_prop_date_idx
  on public.compliance_readings (property_id, reading_date desc);
create unique index if not exists compliance_readings_idem_uq
  on public.compliance_readings (property_id, idempotency_key)
  where idempotency_key is not null;

-- ── 3. compliance_pm_tasks — recurring equipment-check definitions ──────────
-- @rls: service-role-only — all UI access mediated by /api/compliance/* + /api/engineer/* via supabaseAdmin (engineer page is a public SMS-link page; matches pms_* + inspections + activity_log).
create table if not exists public.compliance_pm_tasks (
  id                  uuid primary key default gen_random_uuid(),
  property_id         uuid not null references public.properties(id) on delete cascade,

  category            text not null default 'life_safety'
                      check (category in ('life_safety','other')),
  name                text not null,                  -- "Fire extinguishers", "Emergency lighting"
  equipment_type      text,                           -- canonical key: 'fire_extinguisher', 'aed' …
  unit_count          integer not null default 1
                      check (unit_count >= 0),         -- "15 fire extinguishers"
  cadence             text not null default 'monthly'
                      check (cadence in ('monthly','quarterly','annual')),
  assigned_department text not null default 'maintenance',
  template_key        text,
  sort_order          integer not null default 0,
  active              boolean not null default true,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.compliance_pm_tasks is
  'Definitions for recurring preventive-maintenance / life-safety equipment checks. One row per equipment group. property_id scoped. Created 0229.';

create index if not exists compliance_pm_tasks_prop_active_idx
  on public.compliance_pm_tasks (property_id, active, sort_order);

-- ── 4. compliance_pm_checks — per-period check-off history ──────────────────
-- @rls: service-role-only — all UI access mediated by /api/compliance/* + /api/engineer/* via supabaseAdmin (engineer page is a public SMS-link page; matches pms_* + inspections + activity_log).
create table if not exists public.compliance_pm_checks (
  id                  uuid primary key default gen_random_uuid(),
  property_id         uuid not null references public.properties(id) on delete cascade,
  pm_task_id          uuid not null references public.compliance_pm_tasks(id) on delete cascade,

  period_key          text not null,                  -- 2026-05 / 2026-Q2 / 2026
  status              text not null default 'pass'
                      check (status in ('pass','fail')),
  units_checked       integer,
  note                text,
  photo_path          text,

  checked_by_staff_id uuid references public.staff(id) on delete set null,
  checked_by_name     text,
  checked_at          timestamptz not null default now(),

  work_order_id       uuid references public.work_orders(id) on delete set null,  -- auto-act on fail

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- APPEND-ONLY audit log. Every check attempt is a new immutable row — a later
-- pass NEVER overwrites an earlier fail (Codex adversarial review: a
-- last-writer-wins upsert would erase a failed life-safety check from history).
-- Current-period completion is DERIVED ("a pass exists for the period") in
-- src/lib/compliance/store.ts, not enforced by a unique constraint. The
-- original UNIQUE(task, period) is dropped below so corrections/re-checks
-- accumulate as history rather than mutating the record.
alter table public.compliance_pm_checks drop constraint if exists compliance_pm_checks_task_period_uq;

comment on table public.compliance_pm_checks is
  'Append-only per-period preventive-maintenance check-off log. Every check is an immutable row (no overwrite). Current-period completion is derived (a pass exists). Rolling 12-month+ audit history. Created 0229.';

create index if not exists compliance_pm_checks_prop_checked_idx
  on public.compliance_pm_checks (property_id, checked_at desc);
create index if not exists compliance_pm_checks_task_idx
  on public.compliance_pm_checks (pm_task_id, checked_at desc);
create index if not exists compliance_pm_checks_task_period_idx
  on public.compliance_pm_checks (pm_task_id, period_key);

-- ── 5. RLS — service-role only; anon + authenticated deny-all ───────────────
alter table public.compliance_reading_types enable row level security;
alter table public.compliance_readings      enable row level security;
alter table public.compliance_pm_tasks      enable row level security;
alter table public.compliance_pm_checks     enable row level security;

revoke all on public.compliance_reading_types from public, anon, authenticated;
revoke all on public.compliance_readings      from public, anon, authenticated;
revoke all on public.compliance_pm_tasks      from public, anon, authenticated;
revoke all on public.compliance_pm_checks     from public, anon, authenticated;

grant select, insert, update, delete on public.compliance_reading_types to service_role;
grant select, insert, update, delete on public.compliance_readings      to service_role;
grant select, insert, update, delete on public.compliance_pm_tasks      to service_role;
grant select, insert, update, delete on public.compliance_pm_checks     to service_role;

drop policy if exists compliance_reading_types_deny_all on public.compliance_reading_types;
create policy compliance_reading_types_deny_all on public.compliance_reading_types
  for all to anon, authenticated using (false) with check (false);

drop policy if exists compliance_readings_deny_all on public.compliance_readings;
create policy compliance_readings_deny_all on public.compliance_readings
  for all to anon, authenticated using (false) with check (false);

drop policy if exists compliance_pm_tasks_deny_all on public.compliance_pm_tasks;
create policy compliance_pm_tasks_deny_all on public.compliance_pm_tasks
  for all to anon, authenticated using (false) with check (false);

drop policy if exists compliance_pm_checks_deny_all on public.compliance_pm_checks;
create policy compliance_pm_checks_deny_all on public.compliance_pm_checks
  for all to anon, authenticated using (false) with check (false);

-- ── 6. updated_at triggers (shared function from 0202) ──────────────────────
drop trigger if exists set_updated_at on public.compliance_reading_types;
create trigger set_updated_at before update on public.compliance_reading_types
  for each row execute function public._pms_set_updated_at();

drop trigger if exists set_updated_at on public.compliance_readings;
create trigger set_updated_at before update on public.compliance_readings
  for each row execute function public._pms_set_updated_at();

drop trigger if exists set_updated_at on public.compliance_pm_tasks;
create trigger set_updated_at before update on public.compliance_pm_tasks
  for each row execute function public._pms_set_updated_at();

drop trigger if exists set_updated_at on public.compliance_pm_checks;
create trigger set_updated_at before update on public.compliance_pm_checks
  for each row execute function public._pms_set_updated_at();

-- ── 6b. Voice mode — allow a 'compliance' voice session ─────────────────────
-- The agent tools log_reading / log_pm_check (src/lib/agent/tools/compliance.ts)
-- opt into surfaces:['chat','voice'] + voiceModes:['compliance'] so they reach
-- voice WITHOUT polluting the secure empty default of the general voice catalog
-- (the housekeeper_issue pattern). Widen the agent_voice_sessions mode CHECK so
-- a compliance-mode session can mint; the route gates the mode to manager /
-- maintenance roles.
alter table public.agent_voice_sessions drop constraint if exists agent_voice_sessions_mode_check;
alter table public.agent_voice_sessions add constraint agent_voice_sessions_mode_check
  check (mode is null or mode in ('general', 'housekeeper_issue', 'compliance'));

-- ── 7. Bookkeeping + schema reload ──────────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0229',
  'Engineering Compliance (feature #19): compliance_reading_types + compliance_readings + compliance_pm_tasks + compliance_pm_checks. Service-role-only RLS. Engineer mobile page /engineer/[id] reads/writes via /api/engineer/*; manager Compliance tab + Dashboard tile via /api/compliance/*. AI: snap-to-log vision, voice/agent log_reading + log_pm_check tools, auto-act work order + SMS on out-of-range, never-miss nudges + GM escalation, one-line AI setup + brand template library, inspector-ready report. v2 anomaly seam left in src/lib/compliance/store.ts.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
