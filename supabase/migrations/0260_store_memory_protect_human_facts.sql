-- ═══════════════════════════════════════════════════════════════════════════
-- 0260 — staxis_store_memory: protect human-authored facts from auto-downgrade
--
-- Pre-merge hardening (senior + Codex review of the copilot-memory branch).
-- BUG: the 0256 upsert overwrote the active row for a topic UNCONDITIONALLY —
-- so a nightly 'consolidation' (auto-learned, low-confidence, expiring) write
-- that re-stated a topic a MANAGER had explicitly set would overwrite the
-- manager's fact: downgrade source explicit_user→consolidation, confidence
-- normal/high→low, and set an expiry on a previously-permanent fact. That
-- undercuts the product promise that managers control what the copilot knows.
--
-- FIX: a 'consolidation' write never touches an active row authored by a human
-- (source <> 'consolidation') — it returns action='skipped' and the human's
-- fact wins. Human writes (explicit_user / correction) are unchanged: they
-- still UPDATE — and may UPGRADE a consolidation row — via the existing path.
-- Idempotent CREATE OR REPLACE; grants are preserved across replace.
-- ═══════════════════════════════════════════════════════════════════════════

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

  -- Protect human-authored facts: an auto-learned ('consolidation') write must
  -- never overwrite or expire an active fact a human set (explicit_user /
  -- correction). The human's fact wins; consolidation defers.
  if p_source = 'consolidation' then
    select id into v_id from public.agent_memory
      where property_id = p_property_id
        and scope = p_scope
        and coalesce(subject_account_id, v_sentinel) = coalesce(p_subject_account_id, v_sentinel)
        and topic = p_topic
        and is_active
        and source <> 'consolidation'
      limit 1;
    if found then
      return query select v_id, 'skipped'::text;
      return;
    end if;
  end if;

  -- Upsert in place when an active row for this (scope, subject, topic) exists.
  -- (For a consolidation write we only reach here if no human row exists, so
  --  this updates a prior consolidation row; for a human write this may upgrade
  --  a consolidation row.)
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
  'Atomic upsert-by-topic + per-property/per-user active-row cap for agent memory, under a per-property advisory lock. A consolidation (auto-learned) write defers to an active human-authored fact for the same topic (action=skipped). Returns (memory_id, action) in (inserted|updated|skipped|property_full|user_full). Added 0256, hardened 0260.';

insert into public.applied_migrations (version, description)
values (
  '0260',
  'staxis_store_memory: protect human-authored facts — a consolidation (auto-learned) write never overwrites/expires an active explicit_user/correction fact for the same topic (returns skipped).'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
