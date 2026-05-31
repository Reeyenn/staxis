-- ═══════════════════════════════════════════════════════════════════════════
-- 0239 — Self-serve reports: report_favorites + report_schedules
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Powers the Reports hub at /settings/reports. Managers browse a catalog of
-- reports (built on data we already have — housekeeping, inspections, work
-- orders, inventory, occupancy, activity, compliance, lost & found), run any
-- on demand, export it, FAVORITE it, and SCHEDULE it to auto-email.
--
--   1. report_favorites  — which catalog reports a user has starred, per
--      property. Favorites pin to the top of the library.
--   2. report_schedules  — a catalog report set to auto-email on a cadence
--      (daily / weekly / monthly) to chosen recipients. A new cron
--      (/api/cron/run-scheduled-reports) runs due schedules and emails them
--      through the existing Resend report-email infra.
--
-- The report CATALOG itself is code (src/lib/reports/catalog/*), not data —
-- these tables only store user preferences (favorites) and scheduling config.
--
-- Security model mirrors report_runs / report_preferences (0220) and
-- lost_and_found_items (0230): RLS enabled, browser roles denied outright,
-- service_role is the only reader/writer. Every read/write goes through
-- /api/settings/reports/* with supabaseAdmin (CLAUDE.md "RLS bug class").
-- report_schedules.recipients can hold arbitrary emails (like report
-- CC lists), so service-role-only keeps that config server-gated.
--
-- @rls: service-role-only — all access via /api/settings/reports/* with
-- supabaseAdmin + a manager/owner/admin capability check + property scoping.

-- ─── report_favorites ────────────────────────────────────────────────────────
-- @rls: service-role-only — all access via /api/settings/reports/* with
-- supabaseAdmin (manager gate + per-account/property scoping in the route
-- layer); browser/anon denied by the policy below.
create table if not exists public.report_favorites (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references public.accounts(id) on delete cascade,
  property_id   uuid not null references public.properties(id) on delete cascade,
  -- Catalog report identifier (e.g. 'hk-leaderboard'). Code-defined; no FK.
  report_key    text not null,
  created_at    timestamptz not null default now(),
  -- A user can favorite a given report once per property.
  unique (account_id, property_id, report_key)
);

comment on table public.report_favorites is
  'Per-user starred catalog reports, scoped to a property. Favorites pin to the '
  'top of the Reports library. Service-role only; access via /api/settings/reports/*. '
  'Created 0239.';

create index if not exists report_favorites_account_property_idx
  on public.report_favorites (account_id, property_id);

-- ─── report_schedules ────────────────────────────────────────────────────────
-- @rls: service-role-only — all access via /api/settings/reports/* and the
-- run-scheduled-reports cron with supabaseAdmin (manager gate + property
-- scoping in the route layer); browser/anon denied by the policy below.
create table if not exists public.report_schedules (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references public.properties(id) on delete cascade,
  -- Catalog report identifier (code-defined; no FK).
  report_key            text not null,

  cadence               text not null
                        check (cadence in ('daily','weekly','monthly')),

  -- Delivery window, property-local. hour_local is the hour-of-day to send.
  hour_local            int not null default 8 check (hour_local between 0 and 23),
  -- weekly: 0=Sunday … 6=Saturday. NULL for daily/monthly.
  day_of_week           int check (day_of_week is null or day_of_week between 0 and 6),
  -- monthly: 1..28 (capped at 28 so every month has the day). NULL otherwise.
  day_of_month          int check (day_of_month is null or day_of_month between 1 and 28),

  -- Which date window each run covers, relative to "now":
  --   last7      — trailing 7 days
  --   last30     — trailing 30 days
  --   mtd        — month-to-date
  --   prev_month — the previous calendar month
  range_kind            text not null default 'last7'
                        check (range_kind in ('last7','last30','mtd','prev_month')),

  -- Array of recipient email strings (validated app-side, capped count).
  recipients            jsonb not null default '[]'::jsonb,

  enabled               boolean not null default true,

  created_by_account_id uuid references public.accounts(id) on delete set null,

  -- Idempotency: the property-local date this schedule last fired on, so a
  -- 30-min cron tick can't double-send within the same delivery day.
  last_run_date         date,
  last_run_status       text,                       -- 'sent' | 'failed' | 'skipped_no_recipients'

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table public.report_schedules is
  'Catalog reports set to auto-email on a cadence to chosen recipients. The '
  'run-scheduled-reports cron fires due schedules through the Resend report-email '
  'infra. Service-role only; access via /api/settings/reports/*. Created 0239.';

-- Cron sweep scans enabled schedules per property.
create index if not exists report_schedules_enabled_idx
  on public.report_schedules (property_id)
  where enabled;

-- ─── RLS — deny-all-browser, service-role only (matches 0220 / 0230) ─────────
alter table public.report_favorites enable row level security;
revoke all on public.report_favorites from public, anon, authenticated;
grant select, insert, update, delete on public.report_favorites to service_role;
drop policy if exists report_favorites_deny_browser on public.report_favorites;
create policy report_favorites_deny_browser on public.report_favorites
  for all to anon, authenticated using (false) with check (false);
comment on policy report_favorites_deny_browser on public.report_favorites is
  'Service-role only. Managers star reports via /api/settings/reports/favorite '
  'with supabaseAdmin. Created 0239.';

alter table public.report_schedules enable row level security;
revoke all on public.report_schedules from public, anon, authenticated;
grant select, insert, update, delete on public.report_schedules to service_role;
drop policy if exists report_schedules_deny_browser on public.report_schedules;
create policy report_schedules_deny_browser on public.report_schedules
  for all to anon, authenticated using (false) with check (false);
comment on policy report_schedules_deny_browser on public.report_schedules is
  'Service-role only. Managers manage schedules via /api/settings/reports/schedules '
  'with supabaseAdmin; the run-scheduled-reports cron reads with supabaseAdmin. '
  'Created 0239.';

-- ─── updated_at trigger (reuse the shared pms helper from 0202) ──────────────
drop trigger if exists set_updated_at on public.report_schedules;
create trigger set_updated_at before update on public.report_schedules
  for each row execute function public._pms_set_updated_at();

-- ─── Track the migration ─────────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0239',
  'Self-serve reports: report_favorites + report_schedules (favorites + scheduled '
  'auto-email of catalog reports). Service-role only.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
