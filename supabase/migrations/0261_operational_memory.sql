-- ═══════════════════════════════════════════════════════════════════════════
-- 0261 — Operational learning ("learn from every single thing")
--
-- Adds a second auto-learning source to agent_memory: source='operational' —
-- durable patterns Staxis detects from the hotel's OWN operational data
-- (recurring maintenance, complaint clusters, weekend noise, out-of-range
-- compliance, repeat inspection fails, slow-clean rooms). Phrased by the nightly
-- consolidation engine (memory-consolidate.ts → consolidateOperationalSignals),
-- surfaced on the dashboard "What Staxis noticed" card, and used by the copilot.
--
-- This migration:
--   1. Widens agent_memory.source CHECK to allow 'operational'.
--   2. Extends staxis_store_memory's human-fact protection (added 0260) so an
--      'operational' write — like a 'consolidation' write — NEVER overwrites or
--      expires an active human-authored fact (explicit_user / correction) for the
--      same topic (returns action='skipped'). A human write still UPGRADES an
--      operational/consolidation row. THIS IS THE KEY CORRECTNESS EDIT.
--   3. Adds operational_* columns to agent_memory_consolidations so the operational
--      pass records its counts/recap on the same per-(property,run_date) row
--      without clobbering the conversation pass's columns.
--
-- Manual prod apply (project_migration_application_manual.md). Idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Widen the source CHECK ────────────────────────────────────────────────
alter table public.agent_memory drop constraint if exists agent_memory_source_check;
alter table public.agent_memory add constraint agent_memory_source_check
  check (source in ('explicit_user','inferred','correction','consolidation','operational'));

-- ── 2. Run-log columns for the operational pass ──────────────────────────────
alter table public.agent_memory_consolidations
  add column if not exists operational_learned_count integer not null default 0;
alter table public.agent_memory_consolidations
  add column if not exists operational_updated_count integer not null default 0;
alter table public.agent_memory_consolidations
  add column if not exists operational_recap text;

-- ── 3. Widen the human-fact protection in staxis_store_memory ────────────────
-- Identical to the 0260 body except the two guard predicates now cover BOTH
-- auto-learned sources ('consolidation','operational'). CREATE OR REPLACE keeps
-- grants. (search_path pinned per audit-security-definer-search-path lint.)
create or replace function public.staxis_store_memory(
  p_property_id uuid,
  p_scope text,
  p_subject_account_id uuid,
  p_topic text,
  p_content text,
  p_source text default 'explicit_user',
  p_confidence text default 'normal',
  p_created_by_account_id uuid default null,
  p_created_by_name text default null,
  p_created_by_role text default null,
  p_source_conversation_id uuid default null,
  p_expires_at timestamptz default null,
  p_property_cap int default 200,
  p_user_cap int default 50
)
returns table(memory_id uuid, action text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_lock_key bigint;
  v_sentinel uuid := '00000000-0000-0000-0000-000000000000';
  v_id uuid;
  v_count int;
begin
  if p_scope = 'property' and p_subject_account_id is not null then
    raise exception 'property scope must have null subject' using errcode = '22023';
  elsif p_scope = 'user' and p_subject_account_id is null then
    raise exception 'user scope requires a subject' using errcode = '22023';
  end if;

  v_lock_key := ('x' || substr(md5('agent_memory:' || p_property_id::text), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

  -- Protect human-authored facts: an AUTO-LEARNED write ('consolidation' or
  -- 'operational') must never overwrite or expire an active fact a human set
  -- (explicit_user / correction). The human's fact wins; the auto write defers.
  if p_source in ('consolidation','operational') then
    select id into v_id from public.agent_memory
      where property_id = p_property_id
        and scope = p_scope
        and coalesce(subject_account_id, v_sentinel) = coalesce(p_subject_account_id, v_sentinel)
        and topic = p_topic
        and is_active
        and source not in ('consolidation','operational')
      limit 1;
    if found then
      return query select v_id, 'skipped'::text;
      return;
    end if;
  end if;

  -- Upsert in place when an active row for this (scope, subject, topic) exists.
  -- (For an auto-learned write we only reach here if no human row exists, so this
  --  updates a prior auto-learned row; for a human write this may upgrade one.)
  update public.agent_memory
     set content = p_content,
         source = p_source,
         confidence = p_confidence,
         source_conversation_id = coalesce(p_source_conversation_id, source_conversation_id),
         expires_at = p_expires_at,
         updated_at = now()
   where property_id = p_property_id
     and scope = p_scope
     and coalesce(subject_account_id, v_sentinel) = coalesce(p_subject_account_id, v_sentinel)
     and topic = p_topic
     and is_active
   returning id into v_id;

  if found then
    return query select v_id, 'updated'::text;
    return;
  end if;

  if p_scope = 'property' then
    select count(*) into v_count from public.agent_memory
      where property_id = p_property_id and scope = 'property' and is_active;
    if v_count >= p_property_cap then
      return query select null::uuid, 'property_full'::text;
      return;
    end if;
  else
    select count(*) into v_count from public.agent_memory
      where property_id = p_property_id and scope = 'user'
        and subject_account_id = p_subject_account_id and is_active;
    if v_count >= p_user_cap then
      return query select null::uuid, 'user_full'::text;
      return;
    end if;
  end if;

  insert into public.agent_memory (
    property_id, scope, subject_account_id, topic, content, source, confidence,
    created_by_account_id, created_by_name, created_by_role, source_conversation_id, expires_at
  ) values (
    p_property_id, p_scope, p_subject_account_id, p_topic, p_content, p_source, p_confidence,
    p_created_by_account_id, p_created_by_name, p_created_by_role, p_source_conversation_id, p_expires_at
  )
  returning id into v_id;

  return query select v_id, 'inserted'::text;
end;
$$;

comment on function public.staxis_store_memory(uuid, text, uuid, text, text, text, text, uuid, text, text, uuid, timestamptz, int, int) is
  'Atomic upsert-by-topic + per-property/per-user active-row cap for agent memory, under a per-property advisory lock. An auto-learned write (consolidation OR operational) defers to an active human-authored fact for the same topic (action=skipped). Returns (memory_id, action) in (inserted|updated|skipped|property_full|user_full). Added 0256, hardened 0260, operational source added 0261.';

insert into public.applied_migrations (version, description)
values (
  '0261',
  'Operational learning: allow agent_memory.source=operational; extend staxis_store_memory human-fact protection to operational writes; add operational_* columns to agent_memory_consolidations.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
