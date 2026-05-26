-- ═══════════════════════════════════════════════════════════════════════════
-- 0229 — Cost-per-job + live labor cost tracking + Staff directory wage data
--
-- What this adds:
--   • staff.hourly_wage_cents          (int8, NULL = "wage not set yet")
--   • properties.daily_labor_budget_cents   (int8, NULL = no daily budget)
--   • properties.weekly_labor_budget_cents  (int8, NULL = no weekly budget)
--   • properties.overtime_threshold_hours   (numeric, default 40)
--   • wage_changes                     (audit table, every wage edit logged)
--   • staff_weekly_hours_view          (view: hours worked per ISO week)
--
-- Why the cents columns are new (not "convert in place"):
--   Existing schema:
--     staff.hourly_wage       numeric not null default 15      (since 0001)
--     properties.weekly_budget numeric                          (since 0001)
--   The legacy dollar-stored hourly_wage is NOT NULL with a $15 default,
--   so we can't distinguish "owner explicitly set $15" from "wage was
--   never set." The new cents columns are nullable so null carries the
--   "not set yet" semantics the cost-tracking module needs to show "—"
--   instead of falling back to a misleading default.
--
--   The old columns stay in place for back-compat with the existing
--   daily-report engine; cost-tracking writes only the new cents columns
--   and the cost-tracking-aware report code reads cents first, falling
--   back to dollars only when the cents column is null. A later cleanup
--   migration can drop the old columns after the report engine flips
--   over.
--
-- Backfill behavior:
--   We copy existing hourly_wage * 100 into hourly_wage_cents for every
--   existing row. Existing rows therefore appear "set" with whatever
--   value the legacy column carried — historically that is $15 for any
--   row where the owner never touched the field, which we accept as the
--   pragmatic floor (nothing better available; cost numbers stay close
--   to reality while owners can re-set with the new audit-logged path).
--
--   weekly_budget → weekly_labor_budget_cents the same way. daily_labor_
--   budget_cents stays NULL until the manager sets it in the settings UI
--   (no legacy daily-budget column to copy from).
--
-- Manual prod apply: per project_migration_application_manual.md.
-- Idempotent: every DDL is "if not exists" / "do $$ … exception …" guarded
-- so re-running is safe.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. staff.hourly_wage_cents ──────────────────────────────────────────

alter table public.staff
  add column if not exists hourly_wage_cents bigint;

-- Sanity check: a wage in cents is an integer, but in case a typo lands a
-- floating-point number through some future path, the CHECK keeps the
-- column whole. We also bound the high end at $10,000/hr (1,000,000 cents)
-- — anything above that is a data-entry mistake (an owner typed dollars
-- where cents was expected) and we'd rather refuse than charge $X * 100
-- against a labor budget. Negative wages are not allowed.
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'staff_hourly_wage_cents_sane'
      and conrelid = 'public.staff'::regclass
  ) then
    alter table public.staff
      add constraint staff_hourly_wage_cents_sane
      check (
        hourly_wage_cents is null
        or (hourly_wage_cents >= 0 and hourly_wage_cents <= 1000000)
      );
  end if;
end $$;

-- Backfill from the legacy dollar column. Idempotent: only updates rows
-- that don't already have a cents value (so re-running this migration
-- after an owner has explicitly set a wage doesn't clobber it).
update public.staff
   set hourly_wage_cents = round(hourly_wage * 100)::bigint
 where hourly_wage_cents is null
   and hourly_wage is not null;

comment on column public.staff.hourly_wage_cents is
  'Hourly wage in cents. NULL means owner has not set a wage yet — cost displays show "—". Source of truth as of migration 0229; the legacy numeric `hourly_wage` column is kept for the daily-report engine until it migrates to cents.';

-- ─── 2. properties.daily/weekly_labor_budget_cents + OT threshold ────────

alter table public.properties
  add column if not exists daily_labor_budget_cents bigint;

alter table public.properties
  add column if not exists weekly_labor_budget_cents bigint;

alter table public.properties
  add column if not exists overtime_threshold_hours numeric;

-- Backfill weekly_labor_budget_cents from the legacy `weekly_budget`
-- dollar column. Only fills rows that don't already have a cents value.
update public.properties
   set weekly_labor_budget_cents = round(weekly_budget * 100)::bigint
 where weekly_labor_budget_cents is null
   and weekly_budget is not null;

-- Default OT threshold = 40h (federal FLSA rule). Make existing rows
-- explicit, then enforce NOT NULL going forward.
update public.properties
   set overtime_threshold_hours = 40
 where overtime_threshold_hours is null;

do $$ begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'properties'
      and column_name = 'overtime_threshold_hours'
      and is_nullable = 'NO'
  ) then
    alter table public.properties
      alter column overtime_threshold_hours set not null,
      alter column overtime_threshold_hours set default 40;
  end if;
end $$;

-- Sanity bounds: budgets are non-negative; OT threshold is a positive
-- number of hours below the 168h/week ceiling.
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'properties_labor_budget_cents_sane'
      and conrelid = 'public.properties'::regclass
  ) then
    alter table public.properties
      add constraint properties_labor_budget_cents_sane
      check (
        (daily_labor_budget_cents is null or daily_labor_budget_cents >= 0)
        and
        (weekly_labor_budget_cents is null or weekly_labor_budget_cents >= 0)
      );
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'properties_ot_threshold_sane'
      and conrelid = 'public.properties'::regclass
  ) then
    alter table public.properties
      add constraint properties_ot_threshold_sane
      check (overtime_threshold_hours > 0 and overtime_threshold_hours <= 168);
  end if;
end $$;

comment on column public.properties.daily_labor_budget_cents is
  'Optional daily labor budget in cents. NULL → banner shows live cost without budget comparison.';
comment on column public.properties.weekly_labor_budget_cents is
  'Optional weekly labor budget in cents. NULL → reports skip the budget-delta line.';
comment on column public.properties.overtime_threshold_hours is
  'Hours per ISO week before an OT badge fires. Federal FLSA default is 40. Approaching-OT badge fires at 35; red badge at threshold.';

-- ─── 3. wage_changes audit table ─────────────────────────────────────────
-- @rls: service-role-only — append-only audit table; written + read by
-- /api/staff/wage (PATCH/GET) via supabaseAdmin. Owners + GMs read history
-- through the API surface, not via direct table access from the browser.

create table if not exists public.wage_changes (
  id                 uuid primary key default gen_random_uuid(),
  property_id        uuid not null references public.properties(id) on delete cascade,
  -- Don't cascade staff deletion — wage history is a permanent audit
  -- trail (we may need to defend against "you docked my pay last
  -- month"). ON DELETE SET NULL keeps the row, drops the FK to a
  -- deleted staff record.
  staff_id           uuid references public.staff(id) on delete set null,
  -- Denormalize the staff display name at the time of change. If the
  -- staff row is later deleted, the audit still answers "whose wage
  -- did this manager change?"
  staff_name_at_change text,
  -- Actor (the manager who performed the edit). FK is best-effort —
  -- if the account is deleted, keep the audit row with NULL.
  actor_account_id   uuid references public.accounts(id) on delete set null,
  actor_email        text,
  actor_role         text,
  -- Values. Either side may be NULL ("set for the first time" or
  -- "cleared back to unset").
  old_wage_cents     bigint,
  new_wage_cents     bigint,
  -- Free-text reason (optional). Capped at 500 chars by the API; column
  -- type is unconstrained to allow future structured reasons.
  reason             text,
  changed_at         timestamptz not null default now(),
  -- Sanity: at least one of old/new must be non-null (otherwise the
  -- row carries no information). Both equal is also useless but we
  -- don't enforce that — a no-op write is recoverable noise, but a
  -- both-null row is a bug.
  constraint wage_changes_at_least_one_value
    check (old_wage_cents is not null or new_wage_cents is not null)
);

create index if not exists wage_changes_property_changed_idx
  on public.wage_changes (property_id, changed_at desc);
create index if not exists wage_changes_staff_changed_idx
  on public.wage_changes (staff_id, changed_at desc);

-- RLS posture: service-role only. The API routes that read/write this
-- table go through supabaseAdmin; no anon/authenticated access path.
alter table public.wage_changes enable row level security;
revoke all on public.wage_changes from public, anon, authenticated;
grant select, insert on public.wage_changes to service_role;
drop policy if exists wage_changes_deny_all_browser on public.wage_changes;
create policy wage_changes_deny_all_browser on public.wage_changes
  for all to anon, authenticated using (false) with check (false);

comment on table public.wage_changes is
  'Append-only audit log of staff wage changes. Every PATCH /api/staff/wage writes one row. Created 0229.';

-- ─── 4. staff_weekly_hours_view ──────────────────────────────────────────
--
-- Goal: answer "how many hours has this housekeeper worked this ISO week,
-- net of lunch breaks?" cheaply for the OT-badge code path.
--
-- Sources:
--   cleaning_events.duration_minutes  — minutes per clean (already pause-
--                                       adjusted at write time; flagged/
--                                       discarded rows excluded).
--   staff_breaks (break_type='lunch') — completed lunch breaks; subtract
--                                       from gross billable.
--
-- Caveats:
--   • Counts only cleaning_events rows in {recorded, approved} status
--     (excludes discarded <3min taps and pending-review flagged rows).
--   • Open (ended_at is null) lunch breaks are ignored — we credit lunch
--     only once it's closed.
--   • ISO week: Mon=1, Sun=7. EXTRACT(ISOYEAR, ISOWEEK) gives a stable
--     (year, week) pair that respects year boundaries (e.g. Dec 31 2025
--     may belong to 2026-W01).
--
-- The view is a regular (non-materialized) view because:
--   • OT-badge reads are at-most one-per-housekeeper-per-page-render;
--     scan cost on a single property's week is small.
--   • A materialized view would need a refresh trigger on every
--     cleaning_events insert, which is hot-path code we don't want to
--     touch in this migration.

create or replace view public.staff_weekly_hours_view as
with cleaning_minutes as (
  select
    ce.property_id,
    ce.staff_id,
    extract(isoyear from ce.date)::int as iso_year,
    extract(week    from ce.date)::int as iso_week,
    sum(ce.duration_minutes)           as cleaning_minutes
  from public.cleaning_events ce
  where ce.staff_id is not null
    and ce.status in ('recorded', 'approved')
    and ce.duration_minutes is not null
  group by ce.property_id, ce.staff_id, iso_year, iso_week
),
lunch_minutes as (
  select
    sb.property_id,
    sb.staff_id,
    extract(isoyear from sb.business_date)::int as iso_year,
    extract(week    from sb.business_date)::int as iso_week,
    -- Closed lunch breaks only. Sum minutes between start and end.
    sum(extract(epoch from (sb.ended_at - sb.started_at)) / 60.0) as lunch_minutes
  from public.staff_breaks sb
  where sb.break_type = 'lunch'
    and sb.ended_at is not null
  group by sb.property_id, sb.staff_id, iso_year, iso_week
)
select
  coalesce(cm.property_id, lm.property_id) as property_id,
  coalesce(cm.staff_id, lm.staff_id)       as staff_id,
  coalesce(cm.iso_year, lm.iso_year)       as iso_year,
  coalesce(cm.iso_week, lm.iso_week)       as iso_week,
  coalesce(cm.cleaning_minutes, 0)         as cleaning_minutes,
  coalesce(lm.lunch_minutes, 0)            as lunch_minutes,
  greatest(
    coalesce(cm.cleaning_minutes, 0) - coalesce(lm.lunch_minutes, 0),
    0
  ) / 60.0                                  as net_hours
from cleaning_minutes cm
full outer join lunch_minutes lm
  on cm.property_id = lm.property_id
 and cm.staff_id    = lm.staff_id
 and cm.iso_year    = lm.iso_year
 and cm.iso_week    = lm.iso_week;

comment on view public.staff_weekly_hours_view is
  'Per-housekeeper ISO-week net billable hours: SUM(cleaning_events.duration_minutes) - SUM(staff_breaks.lunch_minutes) / 60. Used by overtime-status API. Created 0229.';

-- View permissions: matching the underlying tables — service-role only.
revoke all on public.staff_weekly_hours_view from public, anon, authenticated;
grant select on public.staff_weekly_hours_view to service_role;

-- ─── 5. overtime_alerts (dedupe + audit for the OT crossing flow) ──────
-- @rls: service-role-only — written by /api/housekeeping/overtime-status
-- via supabaseAdmin. Unique constraint on (property_id, staff_id,
-- iso_year, iso_week, level) is what dedupes concurrent OT polls so
-- two managers polling at the same second can't fire two SMSes.
-- Race window: an ON CONFLICT DO NOTHING insert lands once; the
-- second insert returns nothing and the SMS step skips.

create table if not exists public.overtime_alerts (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references public.properties(id) on delete cascade,
  staff_id        uuid references public.staff(id) on delete set null,
  staff_name_at_alert text,
  iso_year        integer not null,
  iso_week        integer not null,
  level           text not null check (level in ('approaching', 'over')),
  net_hours       numeric not null,
  threshold_hours numeric not null,
  -- Dispatch outcome — null until the SMS fan-out resolves; only
  -- populated when we actually try to send (`level='over'` and a
  -- scheduling manager exists).
  sms_status      text check (sms_status in ('sent', 'failed', 'skipped', null)),
  sms_error       text,
  created_at      timestamptz not null default now(),
  constraint overtime_alerts_dedupe_unique unique (property_id, staff_id, iso_year, iso_week, level)
);

create index if not exists overtime_alerts_property_created_idx
  on public.overtime_alerts (property_id, created_at desc);

alter table public.overtime_alerts enable row level security;
revoke all on public.overtime_alerts from public, anon, authenticated;
grant select, insert, update on public.overtime_alerts to service_role;
drop policy if exists overtime_alerts_deny_all_browser on public.overtime_alerts;
create policy overtime_alerts_deny_all_browser on public.overtime_alerts
  for all to anon, authenticated using (false) with check (false);

comment on table public.overtime_alerts is
  'One row per (staff, ISO week, level) overtime crossing. The UNIQUE constraint dedupes concurrent polls so the SMS only fires once per crossing. Created 0229.';

-- ─── 6. Postgrest schema reload ──────────────────────────────────────────
notify pgrst, 'reload schema';

-- ─── 7. Self-register in applied_migrations ──────────────────────────────
insert into public.applied_migrations (version, description) values
  ('0229', 'cost-per-job + labor budget — staff.hourly_wage_cents, properties.daily/weekly_labor_budget_cents, properties.overtime_threshold_hours, wage_changes audit, overtime_alerts, staff_weekly_hours_view')
on conflict (version) do nothing;
