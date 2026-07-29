-- 0401_portfolio_conversation_archive_boundary.sql
--
-- Portfolio turns are replayable only through the immutable
-- query-receipt -> turn-commit -> message proof added in 0399. The legacy
-- physical archive function deletes live messages and conversations; its
-- cascades consequently delete turn commits and null the immutable receipt /
-- request-artifact conversation bindings. Restoring only the message rows
-- would therefore create an apparently valid but unreceipted transcript.
--
-- Until archive storage has a first-class immutable portfolio provenance
-- graph, fail closed before changing any portfolio row. Property conversation
-- archive/restore behavior remains byte-for-byte equivalent to 0379.

begin;

do $$
begin
  if to_regclass('public.portfolio_query_turn_commits') is null
     or to_regclass('public.agent_conversations_archived') is null
     or to_regprocedure('public.staxis_archive_conversation(uuid,integer)') is null
     or to_regprocedure('public.staxis_restore_conversation(uuid)') is null
  then
    raise exception '0401 requires 0379 conversation archive and 0399 portfolio turn commits';
  end if;
end
$$;

-- Conversation history is always served through the authorization-aware API.
-- The original 0079 ownership-only browser policies predate company scope,
-- active-account checks and receipt-gated portfolio replay; keeping them would
-- let a stale authenticated session bypass every newer boundary and read the
-- internal authorization receipt/hash columns directly through PostgREST.
drop policy if exists "agent_conversations_select_own"
  on public.agent_conversations;
drop policy if exists "agent_messages_select_own"
  on public.agent_messages;
drop policy if exists agent_conversations_deny_browser_select
  on public.agent_conversations;
create policy agent_conversations_deny_browser_select
  on public.agent_conversations for select to anon, authenticated
  using (false);
drop policy if exists agent_messages_deny_browser_select
  on public.agent_messages;
create policy agent_messages_deny_browser_select
  on public.agent_messages for select to anon, authenticated
  using (false);
revoke select on public.agent_conversations from anon, authenticated;
revoke select on public.agent_messages from anon, authenticated;
grant select, insert, update, delete on public.agent_conversations to service_role;
grant select, insert, update, delete on public.agent_messages to service_role;

-- No generic DELETE (including a service-role bug or an ownership-only API)
-- may physically remove a portfolio conversation. Its message and turn-commit
-- cascades are part of the immutable receipt replay graph.
create or replace function public.staxis_refuse_portfolio_conversation_delete()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.conversation_kind = 'portfolio' then
    raise exception 'portfolio conversations require a receipt-preserving lifecycle'
      using errcode = '55000';
  end if;
  return old;
end;
$$;

revoke all on function public.staxis_refuse_portfolio_conversation_delete()
  from public, anon, authenticated;

drop trigger if exists agent_conversations_refuse_portfolio_delete
  on public.agent_conversations;
create trigger agent_conversations_refuse_portfolio_delete
  before delete on public.agent_conversations
  for each row execute function public.staxis_refuse_portfolio_conversation_delete();

-- Ordinary property-conversation deletion is a single database assertion:
-- exact owner, exact property, active account and the current authoritative
-- hotel resolver must all still agree immediately before the delete.
create or replace function public.staxis_delete_property_conversation(
  p_conversation_id uuid,
  p_user_account_id uuid,
  p_property_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_conversation public.agent_conversations%rowtype;
  v_data_user_id uuid;
begin
  if p_conversation_id is null
     or p_user_account_id is null
     or p_property_id is null
  then
    return false;
  end if;

  select conversation.* into v_conversation
    from public.agent_conversations conversation
   where conversation.id = p_conversation_id
     and conversation.user_id = p_user_account_id
     and conversation.property_id = p_property_id
     and conversation.conversation_kind = 'property'
   for update;
  if not found then return false; end if;

  -- The shared authorization-state lock serializes this assertion with the
  -- lifecycle triggers that make account deactivation/revocation immediate.
  select account.data_user_id into v_data_user_id
    from public.accounts account
    join public.account_authorization_state state
      on state.account_id = account.id
   where account.id = p_user_account_id
     and account.active is true
   for share of account, state;
  if not found
     or not public.staxis_account_reaches_property(v_data_user_id, p_property_id)
  then
    return false;
  end if;

  delete from public.agent_conversations conversation
   where conversation.id = p_conversation_id
     and conversation.user_id = p_user_account_id
     and conversation.property_id = p_property_id
     and conversation.conversation_kind = 'property';
  return found;
end;
$$;

revoke all on function public.staxis_delete_property_conversation(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_delete_property_conversation(uuid, uuid, uuid)
  to service_role;

create or replace function public.staxis_archive_conversation(
  p_conversation_id uuid,
  p_min_age_days integer default 90
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_lock_key bigint;
  v_message_count integer;
  v_updated_at timestamptz;
  v_conversation_kind text;
begin
  v_lock_key := ('x' || substr(md5('agent_conv:' || p_conversation_id::text), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

  select updated_at, conversation_kind
    into v_updated_at, v_conversation_kind
    from public.agent_conversations
   where id = p_conversation_id;
  if not found
     or v_conversation_kind = 'portfolio'
     or v_updated_at >= now() - make_interval(days => p_min_age_days)
  then
    return -1;
  end if;

  insert into public.agent_messages_archived
    (id, conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result,
     is_error, tokens_in, tokens_out, model_used, model_id, cost_usd, prompt_version,
     is_summarized, is_summary, created_at)
  select id, conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result,
         is_error, tokens_in, tokens_out, model_used, model_id, cost_usd, prompt_version,
         is_summarized, is_summary, created_at
    from public.agent_messages
   where conversation_id = p_conversation_id;
  get diagnostics v_message_count = row_count;

  insert into public.agent_conversations_archived
    (id, user_id, property_id, title, role, prompt_version, created_at, updated_at,
     message_count, unsummarized_message_count, last_summarized_at,
     conversation_kind, organization_id, authorization_hash,
     scope_receipt_id, scope_verified_at)
  select id, user_id, property_id, title, role, prompt_version, created_at, updated_at,
         message_count, unsummarized_message_count, last_summarized_at,
         conversation_kind, organization_id, authorization_hash,
         scope_receipt_id, scope_verified_at
    from public.agent_conversations
   where id = p_conversation_id;

  delete from public.agent_messages where conversation_id = p_conversation_id;
  delete from public.agent_conversations where id = p_conversation_id;
  return v_message_count;
end;
$$;

create or replace function public.staxis_restore_conversation(
  p_conversation_id uuid
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_lock_key bigint;
  v_message_count integer;
  v_conversation_kind text;
begin
  v_lock_key := ('x' || substr(md5('agent_conv:' || p_conversation_id::text), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

  select conversation_kind
    into v_conversation_kind
    from public.agent_conversations_archived
   where id = p_conversation_id;
  if not found or v_conversation_kind = 'portfolio' then
    return -1;
  end if;

  insert into public.agent_conversations
    (id, user_id, property_id, title, role, prompt_version,
     created_at, updated_at, message_count, unsummarized_message_count,
     last_summarized_at, conversation_kind, organization_id,
     authorization_hash, scope_receipt_id, scope_verified_at)
  select id, user_id, property_id, title, role, prompt_version,
         created_at, updated_at,
         0, 0, last_summarized_at, conversation_kind, organization_id,
         authorization_hash, scope_receipt_id, scope_verified_at
    from public.agent_conversations_archived
   where id = p_conversation_id;

  insert into public.agent_messages
    (id, conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result,
     is_error, tokens_in, tokens_out, model_used, model_id, cost_usd, prompt_version,
     is_summarized, is_summary, created_at)
  select id, conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result,
         is_error, tokens_in, tokens_out, model_used, model_id, cost_usd, prompt_version,
         is_summarized, is_summary, created_at
    from public.agent_messages_archived
   where conversation_id = p_conversation_id;
  get diagnostics v_message_count = row_count;

  update public.agent_conversations
     set message_count = (
           select count(*) from public.agent_messages
            where conversation_id = p_conversation_id
         ),
         unsummarized_message_count = (
           select count(*) from public.agent_messages
            where conversation_id = p_conversation_id
              and is_summarized = false
              and is_summary = false
         )
   where id = p_conversation_id;

  delete from public.agent_messages_archived where conversation_id = p_conversation_id;
  delete from public.agent_conversations_archived where id = p_conversation_id;
  return v_message_count;
end;
$$;

revoke execute on function public.staxis_archive_conversation(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.staxis_archive_conversation(uuid, integer)
  to service_role;
revoke execute on function public.staxis_restore_conversation(uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_restore_conversation(uuid)
  to service_role;

comment on function public.staxis_archive_conversation(uuid, integer) is
  'Archives property conversations only. Portfolio conversations fail closed because physical archive would destroy immutable receipt/turn-commit replay provenance. Hardened 0401.';
comment on function public.staxis_restore_conversation(uuid) is
  'Restores property conversations only. Legacy archived portfolio rows fail closed until receipt-bound archived provenance exists. Hardened 0401.';
comment on function public.staxis_delete_property_conversation(uuid, uuid, uuid) is
  'Deletes only an owned PROPERTY conversation after an atomic active-account and current authoritative hotel-reach assertion. Portfolio rows always fail closed. Added 0401.';

insert into public.applied_migrations(version, description)
values (
  '0401',
  'Fail-closed browser read/delete/archive boundary for receipt-bound portfolio conversations; atomic current-authority deletion remains available for property chat only.'
)
on conflict (version) do nothing;

commit;
