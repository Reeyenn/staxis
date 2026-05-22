-- 0167_walkthrough_step_user_id_check.sql
--
-- 2026-05-22 audit (Codex finding [HIGH]) — defense-in-depth follow-up to
-- the route-layer run-owner check shipped in claude/ai-endpoints-*.
--
-- Background: the original staxis_walkthrough_step (migration 0118)
-- locked + verified (run_id, property_id) but did NOT verify user_id.
-- Any authenticated user on the same property who learned another user's
-- runId could advance that user's run, consume the 12-step cap, and
-- pull the narration to their own screen.
--
-- The route at src/app/api/walkthrough/step/route.ts now SELECTs the
-- run row and rejects on user_id mismatch before this RPC runs. This
-- migration adds the same check INSIDE the RPC so the user_id and
-- step_count update are guarded atomically under the same row lock —
-- closing the gap even against future bugs or non-route callers.
--
-- Backward compatibility: the new parameter has a default of null,
-- which preserves old behavior. Existing callers that don't pass
-- p_expected_user_id continue to work unchanged. The route is updated
-- in the same branch to pass it.
--
-- Return-code expansion:
--   1..12  — new step count
--   -1     — run not active / not found / cap hit
--   -2     — property mismatch
--   -3     — user_id mismatch (NEW)

-- Drop the old 2-arg signature first. Postgres treats functions with
-- different parameter counts as separate overloads, so a plain
-- `create or replace function` with a new argument would leave the old
-- 2-arg version alive alongside the new 3-arg one. PostgREST would
-- still call the right one (it matches by parameter name), but the
-- `comment on function` below would be ambiguous, and a future caller
-- that drops a positional argument could resolve to the dead overload.
drop function if exists public.staxis_walkthrough_step(uuid, uuid);

create or replace function public.staxis_walkthrough_step(
  p_run_id uuid,
  p_expected_property_id uuid default null,
  p_expected_user_id uuid default null
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_count integer;
        v_property uuid;
        v_user uuid;
begin
  -- Fetch + lock the row. Both property_id and user_id come back in the
  -- same locked SELECT so any subsequent UPDATE is consistent with the
  -- ownership check.
  select property_id, user_id into v_property, v_user
    from public.walkthrough_runs
    where id = p_run_id and status = 'active'
    for update;

  if v_property is null then
    return -1;
  end if;

  if p_expected_property_id is not null and v_property != p_expected_property_id then
    -- Property mismatch — return a distinct sentinel so the route can render
    -- a "you switched properties; restarting" message.
    return -2;
  end if;

  if p_expected_user_id is not null and v_user != p_expected_user_id then
    -- User mismatch — same-tenant hijack attempt. The route-layer check
    -- normally catches this before we get here; reaching this branch
    -- means either a non-route caller or a future logic bug. Return -3
    -- so the route can log it distinctly. Step count is NOT incremented.
    return -3;
  end if;

  update public.walkthrough_runs
    set step_count = step_count + 1
    where id = p_run_id and status = 'active' and step_count < 12
    returning step_count into v_count;

  return coalesce(v_count, -1);
end;
$$;

comment on function public.staxis_walkthrough_step(uuid, uuid, uuid) is
  'Atomically increment step_count under the MAX_STEPS=12 cap. Returns the new count, -1 if capped/not-found, -2 if property mismatch, or -3 if user_id mismatch. 2026-05-14 RC2 + 2026-05-22 user_id check (audit).';

-- PostgREST schema-cache reload so the new parameter is recognized on
-- the next API call without waiting for the periodic refresh.
notify pgrst, 'reload schema';

insert into public.applied_migrations (version, description)
values (
  '0167',
  'Audit 2026-05-22: staxis_walkthrough_step now accepts p_expected_user_id and returns -3 on mismatch — defense-in-depth for the same-tenant walkthrough-hijack gap closed at the route layer in the same audit.'
)
on conflict (version) do nothing;
