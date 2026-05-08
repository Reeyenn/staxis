-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0037: lock down SECURITY DEFINER RPCs + preserve reaper diagnostics
--
-- Three findings from review pass 3 — all CRITICAL or HIGH:
--
--   1. CRITICAL — staxis_merge_services and staxis_reap_stale_jobs were
--      callable by any authenticated user (or even anon, depending on
--      schema exposure) via PostgREST RPC. Default Postgres GRANTs
--      EXECUTE on functions to PUBLIC, and Supabase exposes every
--      public.* function as an RPC reachable from the browser. RLS
--      doesn't help — these functions run SECURITY DEFINER as the
--      migration role and bypass it. A logged-in user at Hotel A
--      could disable services or re-queue onboarding jobs at Hotel B.
--      Fix: REVOKE EXECUTE from public/anon/authenticated, GRANT to
--      service_role only. The /api routes use service_role; legitimate
--      callers are unaffected.
--
--   2. CRITICAL — staxis_merge_services had no internal authorization
--      check. Defense-in-depth: even after the REVOKE above, add an
--      auth.uid() ownership check inside the function so a future
--      mis-grant (or a service-role caller that forgets to validate
--      property_id) can't silently cross-tenant.
--
--   3. HIGH — staxis_reap_stale_jobs cleared error/error_detail to
--      NULL when reaping. That destroys the forensic trail any time a
--      worker crashed mid-job. Re-create the function preserving those
--      columns so post-mortem debugging works.
--
-- All three fixes use CREATE OR REPLACE — no schema changes, no data
-- migration. Safe to apply on a live DB.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Re-create staxis_reap_stale_jobs preserving error fields ────────

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
      and started_at < now() - interval '5 minutes'
    returning id
  )
  select count(*) into v_reaped from reaped;
  return v_reaped;
end;
$$;

comment on function public.staxis_reap_stale_jobs() is
  'Resets onboarding_jobs rows whose worker died mid-job (started_at older than 5 min). Preserves error/error_detail for forensics. search_path hardened against schema-shadowing attacks.';

-- ─── 2. Re-create staxis_merge_services with auth.uid() check ──────────

create or replace function public.staxis_merge_services(
  p_property_id uuid,
  p_patch       jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_new    jsonb;
  v_caller uuid := auth.uid();
begin
  -- service_role calls have auth.uid() = NULL and bypass this check
  -- (the /api/onboarding/complete route already validates ownership
  -- before calling this function). Non-service-role callers must own
  -- the property they're modifying. Defense-in-depth — the EXECUTE
  -- revoke below is the primary gate.
  if v_caller is not null and not exists (
    select 1 from public.properties p
    where p.id = p_property_id and p.owner_id = v_caller
  ) then
    raise exception 'not authorized for property %', p_property_id
      using errcode = '42501';  -- insufficient_privilege
  end if;

  update public.properties
  set services_enabled = services_enabled || p_patch
  where id = p_property_id
  returning services_enabled into v_new;

  return v_new;
end;
$$;

comment on function public.staxis_merge_services is
  'Atomically merges a patch into properties.services_enabled. Use from /api/onboarding/complete via service_role. Internal auth.uid() check blocks cross-tenant calls if EXECUTE is ever mis-granted.';

-- ─── 3. Revoke EXECUTE from default-PUBLIC; grant only to service_role ──

revoke execute on function public.staxis_reap_stale_jobs()       from public;
revoke execute on function public.staxis_reap_stale_jobs()       from anon, authenticated;
grant  execute on function public.staxis_reap_stale_jobs()       to   service_role;

revoke execute on function public.staxis_merge_services(uuid, jsonb) from public;
revoke execute on function public.staxis_merge_services(uuid, jsonb) from anon, authenticated;
grant  execute on function public.staxis_merge_services(uuid, jsonb) to   service_role;

-- pg_cron runs as the function owner (postgres) and retains EXECUTE
-- via ownership — no explicit grant needed. The /api/onboarding/complete
-- route uses the service-role client (supabaseAdmin) and is covered by
-- the grant above.

-- ─── Record migration ───────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values ('0037', 'lock down SECURITY DEFINER RPCs + preserve reaper diagnostics')
on conflict (version) do nothing;
