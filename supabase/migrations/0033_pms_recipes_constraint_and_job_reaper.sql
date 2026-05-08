-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0033: Tighten pms_recipes uniqueness + stale-job reaper
--
-- Two fixes from the second-pass deep review:
--
--   1. pms_recipes unique constraint was too loose. 0031 added
--      `unique (pms_type, version, status)` — but that allowed two
--      DRAFT rows with the same (pms_type, version) since status differed
--      from any active row. The intent is "one row per (pms_type,
--      version), period". Fix: drop the 3-column unique, add a 2-column
--      unique. The "at most one active per pms_type" rule is already
--      enforced by the partial unique index from 0032 — that part stays.
--
--   2. Stale jobs in `running` status. If a Fly machine crashes mid-job
--      (OOM, restart, network blip) the onboarding_jobs row stays
--      `running` forever. The next worker won't pick it up because it
--      only claims `queued` rows, and the GM's UI polls forever showing
--      stale progress. Fix: a Postgres function `staxis_reap_stale_jobs`
--      that resets any `running`/`mapping`/`extracting` row whose
--      started_at is older than the configurable threshold (default 5m,
--      well past JOB_TIMEOUT_MS=4m). Wire it into pg_cron to run every
--      minute. The CUA worker also calls it opportunistically on each
--      poll cycle as a defense-in-depth measure (no cron dependency).
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Tighten pms_recipes uniqueness ──────────────────────────────────
-- Drop the loose 3-column constraint from 0031, replace with 2-column.
-- pms_recipes is brand new, no data depends on the old constraint, so
-- this is safe. (If we ever DO need multiple rows per version with
-- different statuses, that's a sign we should be using a separate audit
-- table for promotion history, not stacking statuses on the canonical
-- recipe row.)

alter table public.pms_recipes
  drop constraint if exists pms_recipes_pms_type_version_status_key;

alter table public.pms_recipes
  add constraint pms_recipes_pms_type_version_key
  unique (pms_type, version);

comment on constraint pms_recipes_pms_type_version_key on public.pms_recipes is
  'One row per (pms_type, version). Status (draft/active/deprecated) is a state on that row, not part of its identity. The "one active per pms_type" rule lives in pms_recipes_one_active_per_type_idx (migration 0032).';

-- ─── 2. Stale-job reaper function ───────────────────────────────────────
-- Resets any onboarding_jobs row whose worker has clearly died.
--
-- Threshold: 5 minutes since started_at. JOB_TIMEOUT_MS in the worker
-- is 4 minutes, so a 5-minute threshold gives the worker's own internal
-- timeout a chance to fire first (it will try to mark the job 'failed'
-- with kind='timeout' before this reaper runs). The reaper is the
-- last-resort fallback for the case where the WORKER ITSELF crashed
-- between starting the job and being able to write status updates.
--
-- Returns the number of rows reset, for observability. Caller can log it.
--
-- Idempotent + safe to call on every poll cycle — only matches rows
-- with started_at < now() - 5m, so a fresh job won't get pinged.

create or replace function public.staxis_reap_stale_jobs()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reaped int;
begin
  with reaped as (
    update public.onboarding_jobs
    set
      status        = 'queued',
      worker_id     = null,
      started_at    = null,
      step          = 'Recovering from crashed worker — re-queued',
      progress_pct  = 0,
      error         = null,
      error_detail  = null
    where status in ('running', 'mapping', 'extracting')
      and started_at is not null
      and started_at < now() - interval '5 minutes'
    returning id
  )
  select count(*) into v_reaped from reaped;
  return v_reaped;
end;
$$;

comment on function public.staxis_reap_stale_jobs() is
  'Resets onboarding_jobs rows whose worker died mid-job (started_at older than 5 min). Returns count of reaped rows. Called by the CUA worker on every poll cycle and (optionally) by pg_cron every minute.';

-- ─── 3. Schedule the reaper via pg_cron (best-effort) ───────────────────
-- pg_cron may not be enabled on this Supabase project. If it isn't,
-- the cron.schedule call below errors out — we wrap it in a DO block
-- with exception handling so the migration succeeds either way. The
-- worker also calls staxis_reap_stale_jobs() on each poll cycle as
-- defense in depth (see cua-service/src/index.ts), so missing pg_cron
-- doesn't break the safety net — it just means the reaper runs only
-- when at least one worker is alive.

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- Unschedule any prior version (idempotent re-run safety).
    perform cron.unschedule('staxis-reap-stale-jobs')
      where exists (select 1 from cron.job where jobname = 'staxis-reap-stale-jobs');
    perform cron.schedule(
      'staxis-reap-stale-jobs',
      '* * * * *',
      $cron$select public.staxis_reap_stale_jobs();$cron$
    );
  end if;
exception when others then
  raise notice 'pg_cron schedule skipped (extension not available): %', sqlerrm;
end;
$$;

-- ─── Record migration ───────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values ('0033', 'pms_recipes constraint tightening + onboarding_jobs stale reaper')
on conflict (version) do nothing;
