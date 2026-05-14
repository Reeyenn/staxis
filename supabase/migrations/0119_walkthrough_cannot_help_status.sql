-- Migration 0119: walkthrough_runs — separate 'cannot_help' from 'errored'
--
-- Background. The Phase 1C walkthrough-health-alert cron (added 2026-05-14)
-- counts hit_step_cap + errored + timed_out as "bad outcomes" and pages on
-- Sentry when the rate crosses 25% (min 5 runs). After it landed, it fired
-- on 2/5 errored runs.
--
-- Root cause: the OVERLAY maps Sonnet's legitimate `cannot_help` action
-- (the AI honestly saying "I can't accomplish that from here") to status
-- 'errored'. See src/components/walkthrough/WalkthroughOverlay.tsx — the
-- "action.type === 'cannot_help'" branch called endRun('errored') because
-- the table's CHECK constraint had no fifth bucket. This conflates two
-- very different outcomes:
--   - actual exception inside the overlay loop (bug worth alerting on)
--   - AI correctly refusing an unreachable task (legitimate, NOT a bug)
--
-- The conflation will get worse as real users come in and ask Claude for
-- things that genuinely can't be done from the current page — those are
-- expected and shouldn't page anyone at 3am. The health-alert metric needs
-- to exclude them, same as user_stopped is excluded today.
--
-- This migration adds 'cannot_help' as a sixth terminal status. The
-- follow-up code change in WalkthroughOverlay.tsx maps the AI's
-- cannot_help action to this new status; the health-alert cron excludes
-- it from the bad-outcome rate (alongside user_stopped + still_active).

-- ─── 1. Update the CHECK constraint on walkthrough_runs.status ─────────
--
-- DROP + ADD is safe here because no existing rows have status =
-- 'cannot_help' yet (the value didn't exist before this migration).
-- The new constraint is a strict superset of the old one, so all
-- existing rows pass.

alter table public.walkthrough_runs
  drop constraint if exists walkthrough_runs_status_check;

alter table public.walkthrough_runs
  add constraint walkthrough_runs_status_check
    check (status in (
      'active',
      'done',
      'stopped',
      'capped',
      'errored',
      'timeout',
      'cannot_help'
    ));

-- ─── 2. Update staxis_walkthrough_end to accept the new status ─────────
--
-- Mirrors the table-level check. Function-body validation gives a
-- cleaner error message ("invalid terminal status: …") than the
-- raw check_violation that would otherwise bubble up.

create or replace function public.staxis_walkthrough_end(
  p_run_id uuid,
  p_status text
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_status not in ('done', 'stopped', 'capped', 'errored', 'timeout', 'cannot_help') then
    raise exception 'invalid terminal status: %', p_status;
  end if;
  update public.walkthrough_runs
    set status = p_status, ended_at = now()
    where id = p_run_id and status = 'active';
end;
$$;

comment on function public.staxis_walkthrough_end is
  'Close an active walkthrough run with a terminal status. Idempotent (no-op on a non-active run). Statuses: done|stopped|capped|errored|timeout|cannot_help. 2026-05-14 Phase 1D.';

-- ─── 3. Update walkthrough_runs_daily view to expose cannot_help count ─
--
-- The view drives both /admin/agent's walkthrough KPI tile AND the
-- walkthrough-health-alert cron. Adding the cannot_help column here so
-- both consumers see the breakdown without re-aggregating.
--
-- DROP + CREATE because postgres rejects CREATE OR REPLACE VIEW when
-- the column list reorders (inserting cannot_help before still_active
-- counts as a reorder). Consumers query by column name, not position,
-- so the drop is safe.

drop view if exists public.walkthrough_runs_daily;

create view public.walkthrough_runs_daily as
select
  date_trunc('day', started_at)::date as day,
  count(*) filter (where status = 'done')         as completed,
  count(*) filter (where status = 'stopped')      as user_stopped,
  count(*) filter (where status = 'capped')       as hit_step_cap,
  count(*) filter (where status = 'errored')      as errored,
  count(*) filter (where status = 'timeout')      as timed_out,
  count(*) filter (where status = 'cannot_help')  as cannot_help,
  count(*) filter (where status = 'active')       as still_active,
  count(*)                                        as total,
  avg(step_count) filter (where status = 'done')::numeric(5, 2) as avg_steps_to_done
from public.walkthrough_runs
group by 1
order by 1 desc;

comment on view public.walkthrough_runs_daily is
  'Per-day outcome breakdown for AI walkthroughs. cannot_help (added 2026-05-14 Phase 1D) is the AI honestly refusing — excluded from the bad-outcome rate, same as user_stopped.';

-- ─── 4. Track the migration ────────────────────────────────────────────

insert into public.applied_migrations (version, description)
values ('0119', 'walkthrough_runs: add cannot_help terminal status + view column + end RPC update')
on conflict (version) do nothing;

-- ─── 5. Reload PostgREST schema cache ──────────────────────────────────

notify pgrst, 'reload schema';
