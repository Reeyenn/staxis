-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0042: pull_jobs queue (CUA-driven steady-state data pulls)
--
-- Why this exists:
--   Today the Railway scraper polls Mario's PMS every 15 min via a single-
--   property env-var deployment. To scale to 100-500 hotels we're moving
--   the steady-state pulls onto the same Fly.io CUA worker fleet that
--   handles onboarding — one runtime instead of two, recipes-as-engine
--   instead of hardcoded scrapers, simple horizontal scale via flyctl.
--
--   The onboarding_jobs queue (migration 0031/0039) is one-shot per hotel.
--   pull_jobs is parallel to it but for RECURRING work:
--     - shorter lifecycle (no mapping/extracting phases — recipe already
--       exists; we always go straight to extract+save)
--     - per-tick cadence (cron enqueues a pull_job per active property
--       every 15 min, with idempotency so a stuck previous pull doesn't
--       cause double-enqueue)
--     - separate cleanup / retention rules (old completed pulls aged out
--       after ~7 days; onboarding jobs kept for audit indefinitely)
--
-- Why a separate table (not job_type column on onboarding_jobs):
--   The lifecycle, status enum, and cleanup are different enough that
--   sharing a table would force every consumer to filter by type. The
--   one-line cost of duplication is paid once; the readability win is
--   permanent.
--
-- Why this lands NOW (before any code uses it):
--   Additive-only migration — CREATE TABLE IF NOT EXISTS, new functions.
--   Applying to production is safe; nothing reads or writes this table
--   yet. The CUA worker code on the fleet-cua-everything branch will
--   start using it after canary testing proves the pull→save shape works.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. pull_jobs ──────────────────────────────────────────────────────────

create table if not exists public.pull_jobs (
  id                  uuid primary key default gen_random_uuid(),
  property_id         uuid not null references public.properties(id) on delete cascade,
  pms_type            text not null,

  -- Lifecycle (simpler than onboarding_jobs — recipes always exist):
  --   queued     → enqueued by cron, waiting for a worker
  --   running    → worker has claimed and started extraction
  --   complete   → recipe replay + save finished
  --   failed     → unrecoverable, see error/error_detail
  status              text not null default 'queued'
                      check (status in ('queued','running','complete','failed')),

  -- Which recipe the worker should use. NULL means "look up the active
  -- recipe for pms_type at run time." Pinning a specific recipe_id is
  -- useful for canary runs that want a known-good version.
  recipe_id           uuid references public.pms_recipes(id) on delete set null,

  -- Human-readable current step. Shown in the admin fleet dashboard.
  step                text,
  -- 0-100. Pulls are coarsely segmented (login → extract → save).
  progress_pct        int not null default 0 check (progress_pct between 0 and 100),

  -- The "tick" this pull was scheduled for. Lets us spot lag like "this
  -- pull was supposed to run at 09:00 but didn't claim until 09:23".
  -- Set by the cron when enqueueing.
  scheduled_for       timestamptz not null default now(),

  -- On success: { in_house, arrivals, departures, rooms_count, staff_count,
  --                history_days, pulled_at }
  -- On failure: null (see error column)
  result              jsonb,

  -- One-line user-facing message ("PMS login rejected — please verify
  -- credentials"). The full trace is in error_detail.
  error               text,
  error_detail        jsonb,

  worker_id           text,
  started_at          timestamptz,
  completed_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- "Find me the next queued pull" — the worker's hot path. Partial index
-- on status='queued' keeps it tiny no matter how many completed jobs pile up.
create index if not exists pull_jobs_queue_idx
  on public.pull_jobs (created_at)
  where status = 'queued';

-- "Show me this property's recent pulls" — admin dashboard / debugging path.
create index if not exists pull_jobs_property_recent_idx
  on public.pull_jobs (property_id, created_at desc);

-- "What's lagging right now?" — find pulls whose scheduled tick is in the
-- past but they still haven't completed. Used by the doctor endpoint.
create index if not exists pull_jobs_running_status_idx
  on public.pull_jobs (status, started_at)
  where status in ('queued','running');

alter table public.pull_jobs enable row level security;

drop policy if exists pull_jobs_deny_browser on public.pull_jobs;
create policy pull_jobs_deny_browser on public.pull_jobs
  for all
  to anon, authenticated
  using (false)
  with check (false);

comment on table public.pull_jobs is
  'Recurring data-pull jobs. Cron enqueues one per active property per 15-min tick; CUA workers claim via staxis_claim_next_pull_job() and run recipe-replay + save. Service-role only. Cleaned up after ~7 days by staxis_purge_old_pull_jobs().';

-- updated_at trigger (mirror of onboarding_jobs trigger)
create or replace function public.touch_pull_jobs_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists pull_jobs_touch_updated_at on public.pull_jobs;
create trigger pull_jobs_touch_updated_at
  before update on public.pull_jobs
  for each row
  execute function public.touch_pull_jobs_updated_at();


-- ─── 2. staxis_claim_next_pull_job ─────────────────────────────────────────
-- Same atomic FOR UPDATE SKIP LOCKED pattern as staxis_claim_next_job (0039).
-- Separate function so the worker can poll either queue independently and
-- prioritize onboarding (which is user-facing and time-sensitive) over
-- pulls (which are background and can wait a tick).

create or replace function public.staxis_claim_next_pull_job(
  p_worker_id text
)
returns table (
  id            uuid,
  property_id   uuid,
  pms_type      text,
  recipe_id     uuid,
  scheduled_for timestamptz,
  worker_id     text,
  started_at    timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  return query
  with picked as (
    select j.id
    from public.pull_jobs j
    where j.status = 'queued'
    order by j.created_at
    limit 1
    for update skip locked
  )
  update public.pull_jobs j
  set
    status       = 'running',
    worker_id    = p_worker_id,
    started_at   = now(),
    step         = 'starting',
    progress_pct = 5
  from picked
  where j.id = picked.id
  returning j.id, j.property_id, j.pms_type, j.recipe_id,
            j.scheduled_for, j.worker_id, j.started_at;
end;
$$;

comment on function public.staxis_claim_next_pull_job is
  'Atomically claims the next queued pull_job for the given worker (FOR UPDATE SKIP LOCKED). Returns the row if claimed, empty if nothing queued.';


-- ─── 3. staxis_reap_stale_pull_jobs ────────────────────────────────────────
-- Mirror of staxis_reap_stale_jobs (0033/0036). Re-queues pull_jobs whose
-- worker died mid-flight. Threshold is tighter (3 min vs 5 min for onboarding)
-- because pulls are typically <2 min wall-clock and a 3-min wedge is a
-- strong signal something's wrong.

create or replace function public.staxis_reap_stale_pull_jobs()
returns int
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_reaped int;
begin
  with reaped as (
    update public.pull_jobs
    set
      status        = 'queued',
      worker_id     = null,
      started_at    = null,
      step          = 'Recovering from crashed worker — re-queued',
      progress_pct  = 0
      -- Intentionally NOT clearing error / error_detail. If the worker
      -- wrote a diagnostic before dying, keep it for forensics.
    where status = 'running'
      and started_at is not null
      and started_at < now() - interval '3 minutes'
    returning id
  )
  select count(*) into v_reaped from reaped;
  return v_reaped;
end;
$$;

comment on function public.staxis_reap_stale_pull_jobs is
  'Re-queues pull_jobs whose worker has been holding them for >3 min — typically means the worker died. Idempotent. Returns reaped count.';


-- ─── 4. staxis_enqueue_property_pull ───────────────────────────────────────
-- Idempotent enqueue helper called by /api/cron/enqueue-property-pulls.
-- Skips inserting a new row if a pull_job for this property is already
-- queued OR running (regardless of how recently). This means:
--   - cron run twice (e.g., 14:00 + 14:00:01 retry) → only one job inserted
--   - cron runs at 14:15 while previous 14:00 pull is still running → no
--     new job; previous one will finish, the next 14:30 cron will enqueue
--     fresh. We DON'T queue up backlog — if a property's pulls are
--     consistently slow, the doctor endpoint surfaces that, not a queue
--     of stale work.
--
-- Returns the (possibly existing) job id — caller logs it for traceability.

create or replace function public.staxis_enqueue_property_pull(
  p_property_id   uuid,
  p_pms_type      text,
  p_scheduled_for timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_existing_id uuid;
  v_new_id      uuid;
begin
  -- Look for an outstanding job (queued or running) for this property.
  -- If one exists, return its id; do not insert.
  select id into v_existing_id
    from public.pull_jobs
   where property_id = p_property_id
     and status in ('queued','running')
   order by created_at desc
   limit 1;

  if v_existing_id is not null then
    return v_existing_id;
  end if;

  insert into public.pull_jobs (property_id, pms_type, scheduled_for)
  values (p_property_id, p_pms_type, p_scheduled_for)
  returning id into v_new_id;

  return v_new_id;
end;
$$;

comment on function public.staxis_enqueue_property_pull is
  'Idempotent: enqueues a pull_job for this property unless one is already queued or running. Returns the existing or new job id.';


-- ─── 5. staxis_purge_old_pull_jobs ─────────────────────────────────────────
-- Retention: pull_jobs grow at 96 jobs/property/day (one per 15-min tick).
-- At 500 hotels that's 48k rows/day, 17.5M/year. Keep 7 days of history
-- (3.4M rows) — enough for "what happened last week?" debugging, plenty
-- of headroom on indexes, but doesn't grow forever.

create or replace function public.staxis_purge_old_pull_jobs()
returns int
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_deleted int;
begin
  with deleted as (
    delete from public.pull_jobs
    where status in ('complete','failed')
      and completed_at is not null
      and completed_at < now() - interval '7 days'
    returning id
  )
  select count(*) into v_deleted from deleted;
  return v_deleted;
end;
$$;

comment on function public.staxis_purge_old_pull_jobs is
  'Deletes completed/failed pull_jobs older than 7 days. Run nightly by a cron. Returns deleted-row count.';


-- ─── 6. Lock down — service_role only (matches 0037 pattern) ──────────────

revoke execute on function public.staxis_claim_next_pull_job(text) from public;
revoke execute on function public.staxis_claim_next_pull_job(text) from anon, authenticated;
grant  execute on function public.staxis_claim_next_pull_job(text) to   service_role;

revoke execute on function public.staxis_reap_stale_pull_jobs() from public;
revoke execute on function public.staxis_reap_stale_pull_jobs() from anon, authenticated;
grant  execute on function public.staxis_reap_stale_pull_jobs() to   service_role;

revoke execute on function public.staxis_enqueue_property_pull(uuid, text, timestamptz) from public;
revoke execute on function public.staxis_enqueue_property_pull(uuid, text, timestamptz) from anon, authenticated;
grant  execute on function public.staxis_enqueue_property_pull(uuid, text, timestamptz) to   service_role;

revoke execute on function public.staxis_purge_old_pull_jobs() from public;
revoke execute on function public.staxis_purge_old_pull_jobs() from anon, authenticated;
grant  execute on function public.staxis_purge_old_pull_jobs() to   service_role;


-- ─── 7. Record migration ───────────────────────────────────────────────────

insert into public.applied_migrations (version, description)
values ('0042', 'pull_jobs queue (CUA-driven steady-state data pulls)')
on conflict (version) do nothing;
