-- ═══════════════════════════════════════════════════════════════════════════
-- 0230 — Schedule reactivity (PMS-change → gap alerts) + cross-department
--
-- What this adds:
--   • schedule_alerts table — one row per detected gap (under- or over-
--     staffed) on a given date. Manager dismisses, applies, or ignores.
--   • Cross-department support: extends the dept check constraints on
--     staff.department, scheduled_shifts.department, and
--     property_shift_presets.department from {housekeeping, front_desk,
--     maintenance, other} to add {breakfast, houseman}. Existing 'other'
--     stays.
--   • Property-level coverage config columns:
--       properties.front_desk_coverage_hours       — total daily hours of
--         FD coverage the rule-based demand model expects. 0 = "no FD demand"
--         (small properties with no FD desk).
--       properties.maintenance_shifts_per_day      — count of MT shifts.
--       properties.houseman_shifts_per_day         — count of houseman shifts.
--       properties.breakfast_window_start          — local time the breakfast
--         shift expects coverage from. NULL = no breakfast dept demand.
--       properties.breakfast_window_end            — local time it ends.
--       properties.gap_alert_threshold_minutes     — minimum demand-vs-scheduled
--         gap before an alert is created. Default 60.
--       properties.gap_alert_red_pct               — % of demand the gap must
--         exceed to be 'red' severity (SMS-firing). Default 0.20 (20%).
--       properties.release_shift_strategy          — 'lowest_seniority' or
--         'latest_added'. Default 'latest_added'.
--
-- Why a separate alerts table (not events in app_events):
--   - The alerts UI banner needs a "dismissed" state per alert. app_events
--     is append-only.
--   - Manager-side acks update dismissed_at/by; the same row applies/
--     unapplies actions. Lookup by (property, date, undismissed) needs an
--     index that doesn't make sense on a generic events table.
--
-- Why we extend dept constraints in place (not add a new column):
--   The existing scheduled_shifts.department + property_shift_presets.department
--   + staff.department already drive the manager schedule UI. Adding a parallel
--   column would mean four code paths drifting. We bump the check.
--
-- Manual prod apply: per project_migration_application_manual.md.
-- Idempotent: every DDL is "if not exists" / "do $$ ... exception ..."
-- guarded so re-running is safe.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '10s';

-- ─── 1. Extend department check constraints ───────────────────────────────
--
-- Postgres CHECK constraints can't be modified in place; we drop and re-add
-- them. Each table's constraint has an anonymous name (the SQL didn't
-- name it), so we look it up and drop by name. If the previously expected
-- values weren't found, we proceed — fresh DBs running this migration
-- after 0001+0147 already have the wider set in their initial check.

do $$
declare
  cname text;
begin
  -- staff.department
  for cname in
    select conname from pg_constraint
    where conrelid = 'public.staff'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%department%'
  loop
    execute format('alter table public.staff drop constraint %I', cname);
  end loop;
  alter table public.staff
    add constraint staff_department_check
    check (department in ('housekeeping','front_desk','maintenance','breakfast','houseman','other'));

  -- scheduled_shifts.department
  for cname in
    select conname from pg_constraint
    where conrelid = 'public.scheduled_shifts'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%department%'
  loop
    execute format('alter table public.scheduled_shifts drop constraint %I', cname);
  end loop;
  alter table public.scheduled_shifts
    add constraint scheduled_shifts_department_check
    check (department in ('housekeeping','front_desk','maintenance','breakfast','houseman','other'));

  -- property_shift_presets.department
  for cname in
    select conname from pg_constraint
    where conrelid = 'public.property_shift_presets'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%department%'
  loop
    execute format('alter table public.property_shift_presets drop constraint %I', cname);
  end loop;
  alter table public.property_shift_presets
    add constraint property_shift_presets_department_check
    check (department in ('housekeeping','front_desk','maintenance','breakfast','houseman','other'));
end $$;


-- ─── 2. Property-level cross-department coverage config ───────────────────

alter table public.properties
  add column if not exists front_desk_coverage_hours numeric;
alter table public.properties
  add column if not exists maintenance_shifts_per_day int;
alter table public.properties
  add column if not exists houseman_shifts_per_day int;
alter table public.properties
  add column if not exists breakfast_window_start time;
alter table public.properties
  add column if not exists breakfast_window_end time;
alter table public.properties
  add column if not exists gap_alert_threshold_minutes int;
alter table public.properties
  add column if not exists gap_alert_red_pct numeric;
alter table public.properties
  add column if not exists release_shift_strategy text;

-- Sane defaults — applied only when the column hasn't been set. NULL stays
-- as "no demand from this dept" for the breakfast window pair (the manager
-- has to opt in by setting both times). For the others, defaults mean "on
-- demand, with a small footprint", matching today's limited-service hotels.
update public.properties
   set front_desk_coverage_hours = 24
 where front_desk_coverage_hours is null;
update public.properties
   set maintenance_shifts_per_day = 1
 where maintenance_shifts_per_day is null;
update public.properties
   set houseman_shifts_per_day = 1
 where houseman_shifts_per_day is null;
update public.properties
   set gap_alert_threshold_minutes = 60
 where gap_alert_threshold_minutes is null;
update public.properties
   set gap_alert_red_pct = 0.20
 where gap_alert_red_pct is null;
update public.properties
   set release_shift_strategy = 'latest_added'
 where release_shift_strategy is null;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'properties_release_shift_strategy_check'
      and conrelid = 'public.properties'::regclass
  ) then
    alter table public.properties
      add constraint properties_release_shift_strategy_check
      check (
        release_shift_strategy is null
        or release_shift_strategy in ('latest_added','lowest_seniority')
      );
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'properties_front_desk_coverage_hours_sane'
      and conrelid = 'public.properties'::regclass
  ) then
    alter table public.properties
      add constraint properties_front_desk_coverage_hours_sane
      check (
        front_desk_coverage_hours is null
        or (front_desk_coverage_hours >= 0 and front_desk_coverage_hours <= 24)
      );
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'properties_gap_alert_red_pct_sane'
      and conrelid = 'public.properties'::regclass
  ) then
    alter table public.properties
      add constraint properties_gap_alert_red_pct_sane
      check (
        gap_alert_red_pct is null
        or (gap_alert_red_pct >= 0 and gap_alert_red_pct <= 1)
      );
  end if;
end $$;

comment on column public.properties.front_desk_coverage_hours is
  'Total daily hours of front-desk coverage the rule-based demand model expects. 24 = 24/7 desk. 0 = no FD demand (small property). Default 24.';
comment on column public.properties.breakfast_window_start is
  'Local clock time the breakfast shift expects coverage from. NULL = no breakfast dept demand. Pair with breakfast_window_end.';
comment on column public.properties.gap_alert_threshold_minutes is
  'Minimum |demand - scheduled| in minutes before a schedule_alerts row is created. Default 60.';
comment on column public.properties.release_shift_strategy is
  'When demand drops, which staff to suggest releasing first. latest_added = the most-recently-created shift on that day. lowest_seniority = the staff member with the smallest weekly_hours / shortest tenure.';


-- ─── 3. schedule_alerts table ─────────────────────────────────────────────
-- @rls: service-role-only — read/written by the manager-facing API routes
--   (/api/staff-schedule/alerts + .../alerts/[id]/dismiss + .../alerts/[id]/apply)
--   using supabaseAdmin. The banner reads via that GET endpoint; no
--   browser-direct subscribe to this table. We deny all browser-role
--   traffic (deny-all policy below) mirroring the report_runs /
--   report_preferences pattern from 0220.

create table if not exists public.schedule_alerts (
  id                       uuid primary key default gen_random_uuid(),
  property_id              uuid not null references public.properties(id) on delete cascade,
  -- The local-date the alert refers to. Stored as date (no tz) because
  -- the manager UI talks in calendar days, not instants.
  alert_date               date not null,
  department               text not null
                           check (department in ('housekeeping','front_desk','maintenance','breakfast','houseman','other')),
  severity                 text not null check (severity in ('yellow','red')),
  -- Positive when understaffed (suggested_action='add_shift'), negative
  -- when overstaffed (suggested_action='release_shift'). Always the
  -- demand_minutes - scheduled_minutes delta the engine measured.
  gap_minutes              numeric not null,
  demand_minutes           numeric not null,
  scheduled_minutes        numeric not null,
  suggested_action         text not null check (suggested_action in ('add_shift','release_shift')),
  -- For release_shift only — estimated savings in cents using
  -- staff.hourly_wage_cents (when 0229 has shipped) or the legacy
  -- hourly_wage * 100 fallback. NULL when not applicable.
  suggested_savings_cents  bigint,
  -- The trigger that produced this alert. Lets us A/B which signals are
  -- actually useful and lets a future cron suppress alerts produced by
  -- noisy triggers without nuking the whole table.
  trigger_kind             text not null
                           check (trigger_kind in (
                             'arrival_surge', 'cancellation_wave', 'vip_added',
                             'status_flip', 'manual_recompute', 'cron_recompute'
                           )),
  -- Free-form context the UI can render alongside the banner (e.g. "demand
  -- jumped 30%" — pre-computed so the UI doesn't have to recompute).
  context                  jsonb not null default '{}'::jsonb,
  -- When applied=true, the manager clicked "Add shift" / "Release shift"
  -- and the resulting action lives in applied_payload (a scheduled_shifts
  -- id, or a row delta — depends on suggested_action).
  applied_at               timestamptz,
  applied_by_account_id    uuid references public.accounts(id) on delete set null,
  applied_payload          jsonb,
  -- When dismissed_at is set, the alert is hidden from the banner stack.
  -- A future identical signal can produce a new row; we don't reuse
  -- dismissed alerts.
  dismissed_at             timestamptz,
  dismissed_by_account_id  uuid references public.accounts(id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- Active-alert dedup: at most one open (not-dismissed, not-applied) alert
-- per (property, date, dept, suggested_action) at any time. Lets the
-- recompute loop fire repeatedly without spamming the banner stack — when
-- it finds an existing matching open alert, it updates that row in place
-- instead of inserting a duplicate.
create unique index if not exists schedule_alerts_active_unique
  on public.schedule_alerts(property_id, alert_date, department, suggested_action)
  where dismissed_at is null and applied_at is null;

-- Manager UI reads: "show all open alerts for this property in date order"
create index if not exists schedule_alerts_property_date
  on public.schedule_alerts(property_id, alert_date)
  where dismissed_at is null;

-- History/audit reads.
create index if not exists schedule_alerts_property_created
  on public.schedule_alerts(property_id, created_at desc);

alter table public.schedule_alerts enable row level security;

-- @rls: service-role-only — read and written via the API routes
-- (/api/staff-schedule/alerts, .../alerts/[id]/dismiss, .../alerts/[id]/apply)
-- using supabaseAdmin. The manager banner reads via that GET endpoint;
-- there is no browser-direct subscribe to this table. We deny all
-- browser-role traffic, mirroring the report_runs / report_preferences
-- pattern. The audit-mfa-gate-policies check accepts deny-all (using false)
-- policies as exempt — no gate needed.
revoke all on public.schedule_alerts from public, anon, authenticated;
grant select, insert, update, delete on public.schedule_alerts to service_role;

create policy schedule_alerts_deny_browser
  on public.schedule_alerts for all to anon, authenticated
  using (false) with check (false);

comment on table public.schedule_alerts is
  'Schedule gap alerts. One row per detected under/over-staffing. Surfaced as banners on the Manager Schedule page. Dismissed-or-applied rows stay for audit; the unique index dedupes open alerts per (property, date, dept, action). Created 0230.';

comment on column public.schedule_alerts.gap_minutes is
  'Positive = understaffed (add_shift). Negative = overstaffed (release_shift). Always demand_minutes - scheduled_minutes.';

comment on column public.schedule_alerts.suggested_savings_cents is
  'Estimated $/day saved if release_shift is applied. NULL for add_shift alerts.';

-- Notify PostgREST so the schema cache picks up the new table immediately.
do $$ begin
  perform pg_notify('pgrst', 'reload schema');
exception when others then null;
end $$;

insert into public.applied_migrations (version, description) values
  (
    '0230',
    'Schedule reactivity (PMS-change → gap alerts) + cross-department '
      || '(extends dept check constraints + adds property coverage config + '
      || 'schedule_alerts table).'
  )
on conflict (version) do nothing;
