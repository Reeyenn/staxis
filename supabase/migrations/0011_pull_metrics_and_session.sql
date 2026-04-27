-- ═══════════════════════════════════════════════════════════════════════════
-- 0011 — Pull metrics + scraper session storage
--
-- Two unrelated additions bundled because both came out of the 2026-04-27
-- audit and both write infrequently from the scraper.
--
-- 1. pull_metrics: per-pull latency tracking. Lets us detect "pulls take 45s
--    instead of 15s" before it becomes a reliability incident. Aggregates
--    can drive the weekly digest's "scraper_p95_latency" metric and a
--    future doctor check.
--
-- 2. scraper_session: persistent Playwright storage state (cookies +
--    localStorage). Currently scraper.js writes session.json to the Railway
--    container's filesystem; every redeploy loses it and forces a fresh
--    login. Storing the JSON blob in Postgres survives redeploys and saves
--    ~10s of cold-start per deploy. Keyed by property_id so multi-property
--    deployments work cleanly.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists pull_metrics (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid references properties(id) on delete cascade,
  pull_type       text not null check (pull_type in ('csv_morning','csv_evening','dashboard','ooo')),
  ok              boolean not null,
  error_code      text,                              -- ScraperError.code on failure
  total_ms        integer not null,                  -- wall-clock duration of the pull
  login_ms        integer,                           -- time spent in login() (null if not part of this pull)
  navigate_ms     integer,                           -- page.goto + settle
  download_ms     integer,                           -- CSV download / response read
  parse_ms        integer,                           -- post-fetch parse / row mapping
  rows            integer,                           -- rows produced (CSV parsed count, dashboard fields, OOO orders)
  pulled_at       timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create index if not exists pull_metrics_pulled_at_idx on pull_metrics (pulled_at desc);
create index if not exists pull_metrics_pull_type_idx on pull_metrics (pull_type, pulled_at desc);

comment on table pull_metrics is
  'One row per scraper pull (CSV morning/evening, dashboard, OOO). Aggregates power the weekly digest and the doctor''s pull-latency-spike check. Old rows are retained for trend analysis; nightly cron may prune past 90 days.';

-- Scraper session: single row per property holding Playwright storageState.
create table if not exists scraper_session (
  property_id     uuid primary key references properties(id) on delete cascade,
  state           jsonb not null,                    -- Playwright storageState() output
  refreshed_at    timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

comment on table scraper_session is
  'Persisted Playwright storageState (cookies + localStorage) so Railway redeploys do not force a fresh CA login. Refreshed on every successful login by the scraper. Read at startup and used as the initial context state.';
