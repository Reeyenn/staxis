-- ═══════════════════════════════════════════════════════════════════════════
-- 0016 — Per-property operational config (timezone, staleness, scraper window)
--
-- From the 2026-04-28 founder-perspective audit. The app currently hardcodes:
--   - Timezone:                   'America/Chicago'  (in db.ts dashboardFreshness, doctor's pull-latency check, scraper.js localHour)
--   - Dashboard staleness:        25 minutes         (db.ts DASHBOARD_STALE_MINUTES)
--   - Scraper operating window:   5am–11pm CT        (scraper.js, doctor)
--
-- These are right for Comfort Suites Beaumont. They will be wrong for hotel
-- #2 in any other timezone, with different shift hours, or with a different
-- PMS-update cadence.
--
-- This migration adds the columns to the `properties` table with defaults
-- that match today's hardcoded values, so behavior is unchanged. The code
-- continues to use the hardcoded constants until each call site is updated
-- to read from the property — that's a follow-up commit per call site,
-- mechanical, no schema changes needed.
--
-- Schema-first lets us onboard property #2 by setting these columns and
-- not waiting for a coordinated multi-file refactor.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.properties
  add column if not exists timezone text not null default 'America/Chicago',
  add column if not exists dashboard_stale_minutes integer not null default 25,
  add column if not exists scraper_window_start_hour integer not null default 5,
  add column if not exists scraper_window_end_hour integer not null default 23;

-- Constraints are LENIENT so we don't break a future hotel that wants
-- 24h operations or a custom staleness window. Just keep them sane.
alter table public.properties
  drop constraint if exists properties_dashboard_stale_minutes_check;
alter table public.properties
  add constraint properties_dashboard_stale_minutes_check
  check (dashboard_stale_minutes >= 0 and dashboard_stale_minutes <= 1440);

alter table public.properties
  drop constraint if exists properties_scraper_window_check;
alter table public.properties
  add constraint properties_scraper_window_check
  check (
    scraper_window_start_hour >= 0 and scraper_window_start_hour <= 23
    and scraper_window_end_hour >= 1 and scraper_window_end_hour <= 24
    and scraper_window_start_hour < scraper_window_end_hour
  );

comment on column public.properties.timezone is
  'IANA timezone (e.g. America/Chicago, America/New_York). Used for: shift bucketing, dashboard staleness windows, scraper operating-hour gates. Must be a valid IANA name; the app will Intl.DateTimeFormat against it.';

comment on column public.properties.dashboard_stale_minutes is
  'How long before PMS data is considered stale enough to warn Mario. Default 25 — about one and a half scraper ticks at 15-min cadence. Set higher for properties with slower PMS updates.';

comment on column public.properties.scraper_window_start_hour is
  'Local hour (0-23) at which the scraper begins its daily operating window. Matches scraper.js localHour gate; the scraper idles outside this window so Mario does not get false-alarm "PMS stale" banners overnight.';

comment on column public.properties.scraper_window_end_hour is
  'Local hour (0-24, exclusive) at which the scraper ends its daily operating window. e.g. 23 means "active 5am-11pm, idle 11pm-5am". Use 24 for 24/7 operation.';

-- Self-register in applied_migrations so the doctor's drift check stays green.
insert into public.applied_migrations (version, description)
values ('0016', 'Per-property operational config (timezone, staleness, scraper window)')
on conflict (version) do nothing;
