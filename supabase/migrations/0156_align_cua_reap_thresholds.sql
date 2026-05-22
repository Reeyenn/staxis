-- Migration 0156: align CUA stale-job reap thresholds with job timeouts
--
-- The reapers (staxis_reap_stale_jobs / staxis_reap_stale_pull_jobs) were
-- last set in 0037 / 0042 at 5 min (onboarding) and 3 min (pulls). The
-- CUA worker's effective timeouts have since shifted:
--
--   onboarding (cua-service/src/env.ts JOB_TIMEOUT_MS) → 15 min default
--   pull        (cua-service/src/env.ts PULL_TIMEOUT_MS) → 3 min default
--
-- Result: a legitimate 6-minute mapping run is reaped + re-queued by
-- staxis_reap_stale_jobs() while still in flight, which causes the
-- original worker to keep spending Anthropic tokens AND a sibling worker
-- to claim the re-queued row and start a duplicate. The first writer to
-- 'complete' wins via the worker_id guard, so data isn't corrupted, but
-- the duplicate spend and confused audit trail are real.
--
-- Fix: bump each reaper threshold to (worker_timeout + 1 min grace).
-- That gives a legitimate long-running job the full timeout window
-- BEFORE the reaper steals it. A truly dead worker is still detected
-- within ~16 min (onboarding) or ~4 min (pull) — quick enough for
-- onboarding UX (the UI's own 15-min stall banner fires first anyway)
-- and acceptable for pulls (next cron tick at +15 min covers the gap).
--
-- This is NOT a heartbeat-based reaper (workers writing last_heartbeat_at
-- every 30s, reaper only firing on missing heartbeats). That is the more
-- correct design but lands in its own PR after this one proves
-- behaviour-neutral.
--
-- Reapers preserve all the existing properties:
--   - SECURITY DEFINER with hardened search_path (audit fix from 0037)
--   - Preserve error / error_detail on reap (Pass-3 fix from 0037)
--   - service_role-only execute privilege (lock-down from 0037)
--
-- Idempotent (`create or replace function`); safe to re-apply.

-- ─── 1. staxis_reap_stale_jobs — 5 min → 16 min (JOB_TIMEOUT_MS + grace) ──

create or replace function public.staxis_reap_stale_jobs()
returns int
language plpgsql
security definer
set search_path = pg_catalog, public
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
      progress_pct  = 0
      -- Intentionally NOT clearing error / error_detail. If the worker
      -- wrote a diagnostic before dying, we want to keep it. Operators
      -- inspecting onboarding_jobs after a reap need to see what the
      -- worker last reported, not a NULL'd-out row. (Pass-3 fix.)
    where status in ('running', 'mapping', 'extracting')
      and started_at is not null
      -- Threshold must stay > JOB_TIMEOUT_MS (cua-service/src/env.ts,
      -- default 15 min) + a small grace window so legitimate long jobs
      -- aren't reaped mid-flight. Keep them in lockstep when either
      -- changes.
      and started_at < now() - interval '16 minutes'
    returning id
  )
  select count(*) into v_reaped from reaped;
  return v_reaped;
end;
$$;

comment on function public.staxis_reap_stale_jobs() is
  'Resets onboarding_jobs rows whose worker died mid-job. Threshold = JOB_TIMEOUT_MS (15 min) + 1 min grace (migration 0152). Preserves error/error_detail for forensics. search_path hardened against schema-shadowing attacks.';

-- ─── 2. staxis_reap_stale_pull_jobs — 3 min → 4 min (PULL_TIMEOUT_MS + grace) ──

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
      -- Same forensics preservation as the onboarding reaper.
    where status = 'running'
      and started_at is not null
      -- Threshold must stay > PULL_TIMEOUT_MS (cua-service/src/env.ts,
      -- default 3 min) + a small grace window so legitimate pulls near
      -- the timeout aren't reaped mid-flight. Keep them in lockstep
      -- when either changes.
      and started_at < now() - interval '4 minutes'
    returning id
  )
  select count(*) into v_reaped from reaped;
  return v_reaped;
end;
$$;

comment on function public.staxis_reap_stale_pull_jobs() is
  'Re-queues pull_jobs whose worker died mid-flight. Threshold = PULL_TIMEOUT_MS (3 min) + 1 min grace (migration 0152). Idempotent. Returns reaped count.';

-- ─── 3. Re-assert grants (idempotent — matches 0037 lock-down) ────────────

revoke execute on function public.staxis_reap_stale_jobs()       from public;
revoke execute on function public.staxis_reap_stale_jobs()       from anon, authenticated;
grant  execute on function public.staxis_reap_stale_jobs()       to   service_role;

revoke execute on function public.staxis_reap_stale_pull_jobs()  from public;
revoke execute on function public.staxis_reap_stale_pull_jobs()  from anon, authenticated;
grant  execute on function public.staxis_reap_stale_pull_jobs()  to   service_role;

insert into applied_migrations (version, description)
values (
  '0156',
  'CUA reaper thresholds aligned to worker timeouts: onboarding 5→16 min, pull 3→4 min. Prevents reaper from stealing legitimate long-running jobs.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
