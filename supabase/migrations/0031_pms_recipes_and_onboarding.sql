-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0031: Multi-PMS support + CUA-learned recipes + onboarding jobs
--
-- Why this exists:
--   To grow past 1 hotel (Comfort Suites Beaumont, Choice Advantage) we need
--   to support every PMS our prospects use without hand-coding a scraper for
--   each one. The unlock is computer-use agents (CUA): give Claude a vision
--   model + browser, point it at a PMS login URL with creds, and it figures
--   out where the arrivals/departures/room-status pages are. The output of
--   that learning run is a "recipe" — an ordered sequence of actions/URL
--   patterns that a cheap headless Playwright fleet can replay every 15 min
--   from then on, with no Claude calls in the steady state.
--
--   This migration is the storage layer for that pattern. Three changes:
--
--   1. scraper_credentials.pms_type — drop the choice_advantage-only check,
--      accept the full PMS family list (matching the dropdown in
--      src/app/settings/pms/page.tsx). Existing rows are unaffected.
--
--   2. pms_recipes — one row per (pms_type, version). Stores the JSONB
--      recipe Claude produced when it explored the PMS. Versioned because
--      a PMS UI change will make us re-learn; we keep old recipes around so
--      we can roll back instantly. Service-role only — these contain
--      navigation hints but no secrets.
--
--   3. onboarding_jobs — a queue/state row per onboarding attempt. The
--      Next.js /api/pms/map route inserts a row, the CUA worker on Fly.io
--      picks it up, runs the mapping + initial extraction, and writes
--      progress back so the /settings/pms UI can poll. After the job
--      completes the recipe is saved to pms_recipes (if new) and the
--      property's rooms/staff/history are populated.
--
-- Re-runnable: every CREATE/ALTER is guarded with IF NOT EXISTS / DROP
-- POLICY IF EXISTS / etc. so re-applying does nothing destructive.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Expand scraper_credentials.pms_type ────────────────────────────────
-- Drop the old choice_advantage-only constraint and replace with a wider
-- enumeration. The list mirrors the PMS_SYSTEMS dropdown in
-- src/app/settings/pms/page.tsx — keep them in sync. New types added there
-- must also be added here, otherwise the DB rejects new credentials with a
-- check-constraint error.

alter table public.scraper_credentials
  drop constraint if exists scraper_credentials_pms_type_check;

alter table public.scraper_credentials
  add constraint scraper_credentials_pms_type_check
  check (pms_type in (
    'choice_advantage',
    'opera_cloud',
    'cloudbeds',
    'roomkey',
    'skytouch',
    'webrezpro',
    'hotelogix',
    'other'
  ));

comment on column public.scraper_credentials.pms_type is
  'Property management system family. Maps to a PMS adapter in src/lib/pms/registry.ts. The CUA service learns a recipe per-pms_type (not per-property), so the second hotel on the same PMS gets the existing recipe and onboards in seconds.';

-- ─── 2. pms_recipes ────────────────────────────────────────────────────────
-- A "recipe" is the structured output of one CUA mapping run. It tells the
-- Playwright fleet, for a given PMS, how to:
--   - log in (URL, username/password selectors, post-login validation)
--   - reach each report (arrivals, departures, room status, staff list)
--   - parse the resulting page into our canonical types (PMSArrival[],
--     PMSDeparture[], PMSRoomStatus[], PMSStaffMember[])
--
-- Recipes are immutable once `status='active'`. To update one, the CUA
-- service inserts a new row with the next version number; we point new
-- pulls at the new version while old version stays around for rollback.

create table if not exists public.pms_recipes (
  id                       uuid primary key default gen_random_uuid(),
  pms_type                 text not null,
  version                  int  not null default 1,
  -- The actual recipe. Shape defined in src/lib/pms/recipe.ts (Recipe type).
  -- Roughly: { login: {...}, actions: { getArrivals: [...], getDepartures: [...], ... } }
  recipe                   jsonb not null,
  -- 'draft' = CUA wrote it but it hasn't been validated against a live PMS
  -- 'active' = at least one successful end-to-end pull has run on it
  -- 'deprecated' = superseded by a newer version, kept for rollback
  status                   text  not null default 'draft' check (status in ('draft','active','deprecated')),
  -- Which property's onboarding produced this recipe. Useful for debugging
  -- ("when this recipe broke, what did the original property look like?").
  learned_by_property_id   uuid references public.properties(id) on delete set null,
  -- Free-form notes from the CUA run — what edge cases did Claude trip on,
  -- what manual review is recommended, etc. Not user-facing.
  notes                    text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  -- One active recipe per (pms_type, version). Multiple drafts allowed
  -- (CUA might run twice on different properties before either is promoted).
  unique (pms_type, version, status)
);

-- Lookup pattern: "give me the active recipe for pms_type=X" — used on every
-- pull. Index for that path.
create index if not exists pms_recipes_active_lookup_idx
  on public.pms_recipes (pms_type, status, version desc)
  where status = 'active';

-- Service-role only. Recipes don't contain credentials but they DO contain
-- enough navigation detail that we don't want to leak them — adversaries
-- could use them to study a PMS attack surface.
alter table public.pms_recipes enable row level security;

drop policy if exists pms_recipes_deny_browser on public.pms_recipes;
create policy pms_recipes_deny_browser on public.pms_recipes
  for all
  to anon, authenticated
  using (false)
  with check (false);

comment on table public.pms_recipes is
  'CUA-learned recipes for navigating each PMS family. One per (pms_type, version, status). The Playwright fleet looks up the active recipe by pms_type on every pull. Service-role only.';

-- updated_at trigger
create or replace function public.touch_pms_recipes_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists pms_recipes_touch_updated_at on public.pms_recipes;
create trigger pms_recipes_touch_updated_at
  before update on public.pms_recipes
  for each row
  execute function public.touch_pms_recipes_updated_at();

-- ─── 3. onboarding_jobs ────────────────────────────────────────────────────
-- Job queue row for "GM just hit Save on /settings/pms — go map their PMS
-- and pull initial data." The Fly.io CUA worker polls for queued jobs
-- (no SKIP LOCKED race because we expect <100 concurrent onboardings even
-- at 300 hotels), takes one, and updates status + step + progress_pct as
-- it works. The /settings/pms UI polls /api/pms/job-status/[id] every few
-- seconds and shows a progress bar.

create table if not exists public.onboarding_jobs (
  id                  uuid primary key default gen_random_uuid(),
  property_id         uuid not null references public.properties(id) on delete cascade,
  pms_type            text not null,

  -- Lifecycle:
  --   queued     → just inserted, waiting for a worker to pick up
  --   running    → worker has started, doing setup
  --   mapping    → CUA is exploring the PMS (only when pms_type has no active recipe)
  --   extracting → recipe in hand, pulling rooms/staff/history
  --   complete   → done, property is live
  --   failed     → unrecoverable error, see error column
  status              text not null default 'queued'
                      check (status in ('queued','running','mapping','extracting','complete','failed')),

  -- Human-readable current step. Shown to the GM as "Mapping arrivals page…",
  -- "Pulling staff roster…", etc. Updated by the worker frequently.
  step                text,

  -- 0-100 estimate. Worker updates whenever it crosses a phase boundary.
  -- Coarse-grained on purpose; precise % is rarely accurate during agent runs.
  progress_pct        int not null default 0 check (progress_pct between 0 and 100),

  -- On success: { rooms_count, staff_count, history_days_pulled, recipe_id }
  -- On failure: null (see error column instead)
  result              jsonb,

  -- Populated when status='failed'. One-line human-readable explanation for
  -- the GM ("Could not log in — please check your username/password") plus
  -- a developer trace under .trace for debugging without leaking creds.
  error               text,
  error_detail        jsonb,

  -- Which CUA recipe was used (if extracted) or produced (if mapped).
  -- Null until the recipe phase completes.
  recipe_id           uuid references public.pms_recipes(id) on delete set null,

  -- Worker that claimed the job. Lets us see "is this stuck, or is no
  -- worker alive?" at a glance.
  worker_id           text,

  started_at          timestamptz,
  completed_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- "Find me the next queued job" — the worker's hot path.
create index if not exists onboarding_jobs_queue_idx
  on public.onboarding_jobs (created_at)
  where status = 'queued';

-- "Show me this property's most recent job" — the UI polling path.
create index if not exists onboarding_jobs_property_recent_idx
  on public.onboarding_jobs (property_id, created_at desc);

alter table public.onboarding_jobs enable row level security;

-- The /settings/pms UI calls /api/pms/job-status/[id] which uses
-- supabase-admin (service-role) — same pattern as the housekeeper public
-- pages (see CLAUDE.md "RLS bug class — public pages MUST go through /api
-- routes"). So browser clients don't need direct access.
drop policy if exists onboarding_jobs_deny_browser on public.onboarding_jobs;
create policy onboarding_jobs_deny_browser on public.onboarding_jobs
  for all
  to anon, authenticated
  using (false)
  with check (false);

comment on table public.onboarding_jobs is
  'Job queue + state for PMS onboarding. Inserted by /api/pms/map, picked up by the Fly.io CUA worker, polled by the /settings/pms UI via /api/pms/job-status/[id]. Service-role only.';

-- updated_at trigger
create or replace function public.touch_onboarding_jobs_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists onboarding_jobs_touch_updated_at on public.onboarding_jobs;
create trigger onboarding_jobs_touch_updated_at
  before update on public.onboarding_jobs
  for each row
  execute function public.touch_onboarding_jobs_updated_at();

-- ─── 4. Record migration ───────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values ('0031', 'Multi-PMS support + CUA-learned recipes + onboarding jobs')
on conflict (version) do nothing;
