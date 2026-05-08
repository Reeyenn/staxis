-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0036: search_path hardening + atomic services_enabled merge
--
-- Two findings from review pass 2:
--
--   1. staxis_reap_stale_jobs() in 0033 declared `set search_path = public`.
--      That's a Postgres privilege-escalation pattern (CVE-2018-1058 family):
--      a malicious schema owner could shadow `public.onboarding_jobs` with
--      a malicious table and trick the SECURITY DEFINER function into
--      writing to it. Re-create the function with `set search_path =
--      pg_catalog, public` so pg_catalog wins and the public reference
--      is unambiguous.
--
--   2. /api/onboarding/complete merges services_enabled with read-modify-
--      write SQL — racy if two requests arrive close together. Add a
--      Postgres function staxis_merge_services(pid uuid, patch jsonb)
--      that uses the JSONB || operator for an atomic single-statement
--      update. The route swaps to this RPC.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Re-create staxis_reap_stale_jobs with hardened search_path ──────
-- The body is identical; only the search_path changes.

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
  'Resets onboarding_jobs rows whose worker died mid-job (started_at older than 5 min). search_path hardened against schema-shadowing attacks (review pass 2 fix).';

-- ─── 2. Atomic services_enabled merge ───────────────────────────────────
-- Replaces the read-modify-write pattern in /api/onboarding/complete with
-- a single statement. The JSONB `||` operator merges objects key-by-key,
-- with the right side winning on conflict — exactly the semantics we want
-- ("apply patch on top of existing services_enabled").

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
  v_new jsonb;
begin
  update public.properties
  set services_enabled = services_enabled || p_patch
  where id = p_property_id
  returning services_enabled into v_new;
  return v_new;
end;
$$;

comment on function public.staxis_merge_services is
  'Atomically merges a patch into properties.services_enabled. Use from /api/onboarding/complete instead of read-modify-write to avoid losing concurrent toggles.';

-- ─── Record migration ───────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values ('0036', 'search_path hardening + staxis_merge_services')
on conflict (version) do nothing;
