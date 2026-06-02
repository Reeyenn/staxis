-- Migration 0253: PMS write-back (Phase 3) — gates, signed write recipes,
-- sync state, and the atomic append-log + gated-enqueue RPC.
-- ════════════════════════════════════════════════════════════════════════════
-- Phase 3 lets the CUA robot push Staxis changes BACK into the hotel's PMS
-- (today: room status). This migration adds:
--   • properties.pms_writeback_enabled / pms_writeback_actions — the master
--     per-property gate (default OFF) + which action types are live.
--   • pms_writeback_recipes — signed write recipes, stored SEPARATELY from
--     pms_knowledge_files so a malformed write recipe can never break the
--     load-bearing READ pipeline.
--   • pms_sync_echo — what the robot just pushed, so the 30s reader doesn't
--     log its own write back as a fresh 'cua' change (Codex P1-5).
--   • pms_sync_alert_state — dedupe state for the stuck-sync Twilio watchdog
--     (one text per incident + one on recovery).
--   • staxis_enqueue_pms_write() — appends the manual status_log row AND, when
--     write-back is enabled for this property+action AND the caller's
--     rate-limit gate passed, enqueues ONE workflow_jobs push job — in a single
--     transaction so the mirror append and the job can never diverge (Codex P1-1).
--
-- All new tables are SERVICE-ROLE-ONLY (RLS on, browser denied), mirroring the
-- pms_* convention from 0202. The RPC is called only via supabaseAdmin.
-- ════════════════════════════════════════════════════════════════════════════

set search_path = public, pg_catalog;
set local lock_timeout = '10s';

-- ── Per-property write-back gates (default OFF) ──────────────────────────────
alter table public.properties
  add column if not exists pms_writeback_enabled boolean not null default false;
alter table public.properties
  add column if not exists pms_writeback_actions text[] not null default '{}'::text[];

comment on column public.properties.pms_writeback_enabled is
  'Phase 3 master gate: when true, manager changes are pushed into the PMS by the robot. Default OFF; flip per property only after reads are healthy.';
comment on column public.properties.pms_writeback_actions is
  'Phase 3: which write actions are live, e.g. {room_status}. Empty = none even when enabled.';

-- ── Signed write recipes (separate from pms_knowledge_files) ─────────────────
create table if not exists public.pms_writeback_recipes (
  id                 uuid primary key default gen_random_uuid(),
  pms_family         text not null,
  action_key         text not null,                 -- e.g. 'room_status'
  version            integer not null,
  status             text not null default 'draft'
                     check (status in ('draft','active','deprecated')),
  recipe             jsonb not null,                -- a WriteActionRecipe
  signature          bytea,
  signed_with_key_id text,
  signed_at          timestamptz,
  verified_against   text not null default 'mock'
                     check (verified_against in ('mock','practice_room','path_only')),
  notes              text,
  created_by         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint pms_writeback_recipes_version_unique unique (pms_family, action_key, version)
);
-- Exactly one active recipe per (family, action).
create unique index if not exists pms_writeback_recipes_one_active
  on public.pms_writeback_recipes (pms_family, action_key)
  where status = 'active';

-- ── Echo-suppression: what the robot just pushed ────────────────────────────
-- @rls: service-role-only — write-back internal sync state. Only the CUA worker
--   (service_role) reads/writes it; no browser/anon access. Deny-all RLS below.
create table if not exists public.pms_sync_echo (
  property_id   uuid not null references public.properties(id) on delete cascade,
  room_number   text not null,
  pushed_value  text not null,
  pushed_at     timestamptz not null default now(),
  primary key (property_id, room_number)
);

-- ── Stuck-sync alert dedupe state ───────────────────────────────────────────
-- @rls: service-role-only — write-back alert state machine. Only the watchdog
--   cron + worker (service_role) touch it; no browser/anon access. Deny-all below.
create table if not exists public.pms_sync_alert_state (
  property_id      uuid primary key references public.properties(id) on delete cascade,
  state            text not null default 'ok' check (state in ('ok','alerting')),
  last_alert_at    timestamptz,
  last_recovery_at timestamptz,
  last_reason      text,
  updated_at       timestamptz not null default now()
);

-- ── RLS: service-role only (browser denied) ─────────────────────────────────
-- Explicit per-table statements (mirrors 0245) so the rls-policy-coverage audit
-- can statically see RLS is enabled on the tenant-scoped tables. Service-role
-- bypasses RLS; anon + authenticated get a deny-all policy + revoked grants.
alter table public.pms_writeback_recipes enable row level security;
revoke all on public.pms_writeback_recipes from public, anon, authenticated;
grant select, insert, update, delete on public.pms_writeback_recipes to service_role;
drop policy if exists pms_writeback_recipes_deny_all_browser on public.pms_writeback_recipes;
create policy pms_writeback_recipes_deny_all_browser on public.pms_writeback_recipes
  for all to anon, authenticated using (false) with check (false);

alter table public.pms_sync_echo enable row level security;
revoke all on public.pms_sync_echo from public, anon, authenticated;
grant select, insert, update, delete on public.pms_sync_echo to service_role;
drop policy if exists pms_sync_echo_deny_all_browser on public.pms_sync_echo;
create policy pms_sync_echo_deny_all_browser on public.pms_sync_echo
  for all to anon, authenticated using (false) with check (false);

alter table public.pms_sync_alert_state enable row level security;
revoke all on public.pms_sync_alert_state from public, anon, authenticated;
grant select, insert, update, delete on public.pms_sync_alert_state to service_role;
drop policy if exists pms_sync_alert_state_deny_all_browser on public.pms_sync_alert_state;
create policy pms_sync_alert_state_deny_all_browser on public.pms_sync_alert_state
  for all to anon, authenticated using (false) with check (false);

-- ── Atomic append-log + gated enqueue (Codex P1-1) ──────────────────────────
-- Called (service-role) from src/lib/pms-rooms-writes.ts in place of a bare
-- status-log insert. Always appends the manual status row; enqueues exactly one
-- push job ONLY when write-back is enabled for this property+action AND the
-- caller passed p_allow_enqueue=true (its per-property rate-limit gate). The
-- idempotency_key is keyed on the brand-new log id, so every distinct change
-- enqueues exactly once (most-recent-wins cancels superseded jobs at run time;
-- nothing is silently dropped). max_attempts=1: a write never silently retries.
create or replace function public.staxis_enqueue_pms_write(
  p_property_id   uuid,
  p_room_number   text,
  p_status        text,    -- mirror enum value to append to pms_room_status_log
  p_changed_by    text,
  p_action_key    text,    -- e.g. 'room_status'
  p_payload       jsonb,   -- write payload (e.g. {"target_status":"vacant_clean"})
  p_allow_enqueue boolean
) returns uuid
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  v_log_id  uuid;
  v_enabled boolean;
  v_actions text[];
begin
  insert into public.pms_room_status_log
    (property_id, room_number, status, changed_at, changed_by, source)
  values
    (p_property_id, p_room_number, p_status, now(), p_changed_by, 'manual')
  returning id into v_log_id;

  if p_allow_enqueue then
    select pms_writeback_enabled, pms_writeback_actions
      into v_enabled, v_actions
      from public.properties
      where id = p_property_id;

    if coalesce(v_enabled, false)
       and p_action_key = any(coalesce(v_actions, '{}'::text[])) then
      insert into public.workflow_jobs
        (property_id, kind, payload, idempotency_key, max_attempts, triggered_by)
      values (
        p_property_id,
        'pms.write',
        coalesce(p_payload, '{}'::jsonb) || jsonb_build_object(
          'action_key',    p_action_key,
          'room_number',   p_room_number,
          'origin_log_id', v_log_id
        ),
        'pms.write:' || p_property_id::text || ':' || p_room_number || ':' || v_log_id::text,
        1,
        'pms-writeback'
      )
      on conflict (property_id, idempotency_key) do nothing;
    end if;
  end if;

  return v_log_id;
end;
$$;

-- Strip the default PUBLIC execute grant (Postgres grants EXECUTE to PUBLIC on
-- new functions) AND the browser roles, then grant execute back to service_role
-- only. All access is via supabaseAdmin (service_role). (Codex P2.)
revoke all on function public.staxis_enqueue_pms_write(uuid, text, text, text, text, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.staxis_enqueue_pms_write(uuid, text, text, text, text, jsonb, boolean) to service_role;

-- PostgREST caches the schema; reload so the new table/columns/RPC are visible.
notify pgrst, 'reload schema';

-- Self-register for the doctor's applied-migrations check + drift test.
insert into public.applied_migrations (version, description)
values ('0253', 'pms write-back (phase 3): properties.pms_writeback_enabled/_actions, pms_writeback_recipes, pms_sync_echo, pms_sync_alert_state, staxis_enqueue_pms_write RPC (atomic append-log + gated enqueue)')
on conflict (version) do nothing;
