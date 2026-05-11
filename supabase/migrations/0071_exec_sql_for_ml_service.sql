-- 0071_exec_sql_for_ml_service.sql
-- A `public.exec_sql(text)` SECURITY DEFINER function used by the ML
-- service's training and inference paths to run aggregation/JOIN queries
-- that the supabase-py PostgREST builder can't express cleanly.
--
-- WHY THIS MIGRATION EXISTS
--
-- The ML service in `ml-service/src/supabase_client.py::execute_sql()`
-- was originally written to call `client.postgrest.request("GET",
-- "/rpc/exec_sql", json={"sql": ...})` — i.e. it ALREADY assumed this
-- function existed. But the migration was never written, so every
-- training run that needs a complex SELECT (demand training, demand
-- inference's plan-snapshot fetch, supply training's cleaning-events
-- pull) has been silently failing with "Could not find the function
-- public.exec_sql(sql) in the schema cache" since the ML service first
-- shipped.
--
-- Discovered during the Tier 2 triple-check pass when I ran the weekly
-- ML training cron manually and saw every demand/supply training call
-- return `{"error":"Failed to fetch training data: 'SyncPostgrestClient'
-- object has no attribute 'request'"}` (the SDK API surface has also
-- shifted; the wrapper fix lives in the same commit).
--
-- SECURITY MODEL
--
-- This function takes ARBITRARY SQL and executes it. That sounds scary
-- but the security boundary doesn't actually change:
--
--   - service_role already has full read/write/DDL access to every table
--     via the supabase-js / supabase-py service-role JWT — it's the
--     master key, RLS-bypass.
--   - Anyone holding that JWT can already exfiltrate or mutate anything
--     via straightforward .from(table).select(...) calls.
--
-- So restricting EXECUTE to service_role only is equivalent to today's
-- baseline. anon and authenticated have no access at all.
--
-- The function is SECURITY DEFINER (runs as the function owner, which
-- becomes postgres on Supabase since migrations apply as postgres) so
-- that callers without direct table SELECT grants can still read across
-- tables — but the EXECUTE grant is the gate, and only service_role
-- gets it.
--
-- We return jsonb (an array of rows) rather than a generic refcursor or
-- record so the supabase-py client can deserialize via `.rpc()` cleanly.

create or replace function public.exec_sql(sql text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  -- Wrap the caller's SQL as a subquery and aggregate into jsonb. Empty
  -- result set returns '[]' rather than null so PostgREST can return a
  -- valid JSON body without special-casing.
  execute format(
    'select coalesce(jsonb_agg(row_to_json(t)), ''[]''::jsonb) from (%s) t',
    sql
  ) into result;
  return result;
end;
$$;

comment on function public.exec_sql(text) is
  'ML service helper: execute an arbitrary SELECT and return the result as a jsonb array of rows. Called from ml-service/src/supabase_client.py::execute_sql() via supabase-py .rpc(). EXECUTE grant restricted to service_role — anon and authenticated have no access. The supabase service-role JWT already has full DB access, so this function adds no new attack surface; it just packages an aggregation pattern PostgREST can return.';

-- Lock it down: no public/anon/authenticated execution.
revoke all on function public.exec_sql(text) from public, anon, authenticated;
grant execute on function public.exec_sql(text) to service_role;

-- Bookkeeping
insert into public.applied_migrations (version, description)
values ('0071', 'public.exec_sql(text) for the ML service training + inference SQL paths')
on conflict (version) do nothing;
