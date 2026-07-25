-- ═══════════════════════════════════════════════════════════════════════════
-- 0357 — "Delete means gone": a topic a human deleted is never re-learned
--
-- BUG: the product promise is that when a manager tells the copilot to forget
-- something (or removes it from the dashboard), it stays gone. In practice that
-- promise held for THIRTY DAYS and only as a POLITE REQUEST to a language model:
--   • memory-consolidate.ts read is_active=false rows from the last 30 days and
--     pasted them into the extraction prompt as a "do NOT re-learn" list;
--   • the operational pass filtered its signals against the same 30-day set.
-- So on day 31 the nightly consolidator was free to re-propose the exact topic
-- the manager deleted, and staxis_store_memory happily INSERTED it — the fact
-- silently came back. And even inside the 30 days the only thing stopping it
-- was the model choosing to obey a prompt line, which per src/lib/agent/
-- INVARIANTS.md doctrine counts as NOT ENFORCED.
--
-- FIX (in the database, where it cannot drift): an AUTO-LEARNED write
-- ('consolidation' / 'operational') is REFUSED FOREVER — no time window — for a
-- (property, scope, subject, topic) that has ANY is_active=false row. It returns
-- the new action code 'refused_forgotten' with the tombstone's id.
--
-- Why is_active=false is a safe signal for "a human deleted this": only two code
-- paths ever set it — staxis_forget_memory (0256; the manager tells the copilot
-- to forget a topic) and deactivateMemoryById (the dashboard Remove button).
-- Expiry does NOT deactivate: expires_at is filtered at READ time only
-- (src/lib/db/agent-memory.ts). So a tombstone unambiguously means a human
-- deleted the topic.
--
-- Rules this preserves:
--   • A HUMAN write (explicit_user / correction / inferred) is NEVER refused —
--     a manager must always be able to deliberately re-add a topic they once
--     deleted. Only the two automatic sources are refused.
--   • ORDER MATTERS: the existing 0260/0261 human-fact guard runs FIRST, so once
--     a manager HAS re-added the topic, a later auto write returns the familiar
--     'skipped' (a human fact won) rather than 'refused_forgotten'. The
--     tombstone refusal is for topics that are gone and stayed gone.
--   • Refusal happens BEFORE the cap check, so a forgotten topic never consumes
--     per-property/per-user cap budget or masquerades as 'property_full'.
--   • Everything else — dedup upsert, caps, scope/subject guard, advisory lock —
--     is byte-identical to 0261 (the live version).
--
-- Manual prod apply (project_migration_application_manual.md). Idempotent.
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

  if p_source in ('consolidation','operational') then
    -- (a) Protect human-authored facts (0260/0261): an auto-learned write must
    -- never overwrite or expire an active fact a human set. Checked first so a
    -- topic a manager DELETED and then deliberately RE-ADDED behaves like any
    -- other manager fact ('skipped'), not like a tombstone.
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

    -- (b) Delete means gone, permanently (0357): if a human ever deactivated
    -- this topic and has not re-added it, no automatic writer may bring it back
    -- — regardless of how long ago that was. Before the cap check on purpose.
    select id into v_id from public.agent_memory
      where property_id = p_property_id
        and scope = p_scope
        and coalesce(subject_account_id, v_sentinel) = coalesce(p_subject_account_id, v_sentinel)
        and topic = p_topic
        and not is_active
      order by updated_at desc
      limit 1;
    if found then
      return query select v_id, 'refused_forgotten'::text;
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
  'Atomic upsert-by-topic + per-property/per-user active-row cap for agent memory, under a per-property advisory lock. An auto-learned write (consolidation OR operational) defers to an active human-authored fact for the same topic (action=skipped), and is refused FOREVER for a topic a human deactivated and has not re-added (action=refused_forgotten). Human writes are never refused. Returns (memory_id, action) in (inserted|updated|skipped|refused_forgotten|property_full|user_full). Added 0256, hardened 0260, operational source added 0261, permanent forget added 0357.';

revoke execute on function public.staxis_store_memory(uuid, text, uuid, text, text, text, text, uuid, text, text, uuid, timestamptz, int, int) from public, anon, authenticated;
grant  execute on function public.staxis_store_memory(uuid, text, uuid, text, text, text, text, uuid, text, text, uuid, timestamptz, int, int) to service_role;

insert into public.applied_migrations (version, description)
values (
  '0357',
  'Delete means gone: staxis_store_memory refuses an auto-learned (consolidation/operational) write forever for a topic a human deactivated (returns refused_forgotten), replacing the 30-day prompt-hint window.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
