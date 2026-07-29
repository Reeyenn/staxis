-- 0377_agent_portfolio_conversation_scope.sql
--
-- A conversation's security domain is durable data, not prompt text.
-- `prompt_version + '+org:<uuid>'` was a temporary compatibility stamp; it
-- cannot safely distinguish property and portfolio replay, nor can it prove
-- that the caller's complete authorization universe is unchanged.
--
-- This migration adds an explicit, immutable conversation kind and company,
-- binds new portfolio conversations to the selector-independent
-- authorization hash from 0376, and adds atomic DB preparation functions.
-- The hotel FK remains NOT NULL: for a portfolio row it is a DERIVATION
-- ANCHOR for agent_messages.property_id, never the portfolio's scope.

begin;

do $$
begin
  if to_regclass('public.agent_conversations') is null
     or to_regclass('public.agent_conversations_archived') is null
     or to_regclass('public.agent_messages') is null
     or to_regclass('public.authorization_scope_receipts') is null
     or to_regprocedure(
       'public.staxis_assert_authorization_scope_receipt(uuid,uuid)'
     ) is null
  then
    raise exception
      '0377 requires agent conversation migrations 0079/0105/0113 and authorization migration 0376';
  end if;
end
$$;

-- ── Explicit scope columns ───────────────────────────────────────────────

alter table public.agent_conversations
  add column if not exists conversation_kind text,
  add column if not exists organization_id uuid,
  add column if not exists authorization_hash text,
  add column if not exists scope_receipt_id uuid,
  add column if not exists scope_verified_at timestamptz;

-- LIKE is a one-time copy. Columns added to the hot table after 0105 do not
-- appear in the archive automatically, so add every new field explicitly.
alter table public.agent_conversations_archived
  -- Same 0105 LIKE-order bug: these conversation columns were added to the
  -- hot table only after the archive table had already been copied.
  add column if not exists unsummarized_message_count integer not null default 0,
  add column if not exists last_summarized_at timestamptz,
  add column if not exists conversation_kind text,
  add column if not exists organization_id uuid,
  add column if not exists authorization_hash text,
  add column if not exists scope_receipt_id uuid,
  add column if not exists scope_verified_at timestamptz;

-- 0105 created agent_messages_archived with LIKE *before* adding these two
-- columns to agent_messages later in the same migration. LIKE is not live, so
-- the archive RPC subsequently named columns that never existed. Repair that
-- latent mismatch before replacing the explicit archive/restore functions.
alter table public.agent_messages_archived
  add column if not exists is_summarized boolean not null default false,
  add column if not exists is_summary boolean not null default false;

-- Legacy compatibility: recover the company marker once, into typed columns.
-- The stamp is intentionally retained for prompt-version audit history, but no
-- post-migration authorization decision reads it when explicit columns exist.
update public.agent_conversations conversation
   set conversation_kind = 'portfolio',
       organization_id = substring(
         conversation.prompt_version from
         '[+]org:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
       )::uuid
 where conversation.conversation_kind is null
   and conversation.prompt_version ~*
       '[+]org:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}([+]|$)';

update public.agent_conversations
   set conversation_kind = 'property'
 where conversation_kind is null;

update public.agent_conversations_archived conversation
   set conversation_kind = 'portfolio',
       organization_id = substring(
         conversation.prompt_version from
         '[+]org:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
       )::uuid
 where conversation.conversation_kind is null
   and conversation.prompt_version ~*
       '[+]org:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}([+]|$)';

update public.agent_conversations_archived
   set conversation_kind = 'property'
 where conversation_kind is null;

alter table public.agent_conversations
  alter column conversation_kind set default 'property',
  alter column conversation_kind set not null;

alter table public.agent_conversations_archived
  alter column conversation_kind set default 'property',
  alter column conversation_kind set not null;

alter table public.agent_conversations
  drop constraint if exists agent_conversations_kind_check,
  drop constraint if exists agent_conversations_scope_shape_check,
  drop constraint if exists agent_conversations_authorization_hash_check;

alter table public.agent_conversations
  add constraint agent_conversations_kind_check
    check (conversation_kind in ('property', 'portfolio')) not valid,
  add constraint agent_conversations_scope_shape_check
    check (
      (conversation_kind = 'property'
        and organization_id is null
        and authorization_hash is null
        and scope_receipt_id is null
        and scope_verified_at is null)
      or
      (conversation_kind = 'portfolio' and organization_id is not null)
    ) not valid,
  add constraint agent_conversations_authorization_hash_check
    check (
      authorization_hash is null
      or authorization_hash ~ '^[0-9a-f]{64}$'
    ) not valid;

alter table public.agent_conversations
  validate constraint agent_conversations_kind_check,
  validate constraint agent_conversations_scope_shape_check,
  validate constraint agent_conversations_authorization_hash_check;

alter table public.agent_conversations_archived
  drop constraint if exists agent_conversations_archived_kind_check,
  drop constraint if exists agent_conversations_archived_scope_shape_check,
  drop constraint if exists agent_conversations_archived_authorization_hash_check;

alter table public.agent_conversations_archived
  add constraint agent_conversations_archived_kind_check
    check (conversation_kind in ('property', 'portfolio')) not valid,
  add constraint agent_conversations_archived_scope_shape_check
    check (
      (conversation_kind = 'property'
        and organization_id is null
        and authorization_hash is null
        and scope_receipt_id is null
        and scope_verified_at is null)
      or
      (conversation_kind = 'portfolio' and organization_id is not null)
    ) not valid,
  add constraint agent_conversations_archived_authorization_hash_check
    check (
      authorization_hash is null
      or authorization_hash ~ '^[0-9a-f]{64}$'
    ) not valid;

alter table public.agent_conversations_archived
  validate constraint agent_conversations_archived_kind_check,
  validate constraint agent_conversations_archived_scope_shape_check,
  validate constraint agent_conversations_archived_authorization_hash_check;

comment on column public.agent_conversations.conversation_kind is
  'Security domain for replay: property or portfolio. Immutable after insert.';
comment on column public.agent_conversations.organization_id is
  'Portfolio company authority. NULL for property conversations. The NOT NULL property_id remains only the message-derivation anchor for portfolio rows.';
comment on column public.agent_conversations.authorization_hash is
  'Immutable selector-independent hash of the caller complete current authorization universe at portfolio conversation creation. NULL on property and unbound legacy portfolio rows.';
comment on column public.agent_conversations.scope_receipt_id is
  'Most recent asserted 0376 receipt. Provenance only; receipt expiry/deletion never changes the immutable authorization_hash.';
comment on column public.agent_conversations.scope_verified_at is
  'When scope_receipt_id was asserted inside an atomic create/prep transaction.';

create index if not exists agent_conversations_user_kind_updated_idx
  on public.agent_conversations (user_id, conversation_kind, updated_at desc);
create index if not exists agent_conversations_portfolio_org_updated_idx
  on public.agent_conversations (organization_id, updated_at desc)
  where conversation_kind = 'portfolio';

-- Old application instances may briefly continue writing the legacy prompt
-- stamp during a rolling deploy. Normalize those INSERTs into an explicit,
-- unbound portfolio row; the NULL hash deliberately makes reuse fail with
-- scope_changed instead of accidentally treating it as property history.
-- Once inserted, kind/company/hash are immutable. Only the asserted receipt
-- provenance fields may advance on a portfolio turn.
create or replace function public.staxis_guard_agent_conversation_scope()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_legacy_organization_id text;
begin
  if tg_op = 'INSERT' then
    if coalesce(new.conversation_kind, 'property') = 'property'
       and new.organization_id is null
       and new.prompt_version ~*
           '[+]org:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}([+]|$)'
    then
      v_legacy_organization_id := substring(
        new.prompt_version from
        '[+]org:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
      );
      new.conversation_kind := 'portfolio';
      new.organization_id := v_legacy_organization_id::uuid;
      new.authorization_hash := null;
      new.scope_receipt_id := null;
      new.scope_verified_at := null;
    end if;
    return new;
  end if;

  if old.conversation_kind is distinct from new.conversation_kind
     or old.organization_id is distinct from new.organization_id
     or old.authorization_hash is distinct from new.authorization_hash
  then
    raise exception 'conversation security scope is immutable'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.staxis_guard_agent_conversation_scope()
  from public, anon, authenticated;

drop trigger if exists agent_conversations_scope_guard
  on public.agent_conversations;
create trigger agent_conversations_scope_guard
  before insert or update on public.agent_conversations
  for each row execute function public.staxis_guard_agent_conversation_scope();

-- ── Archive/restore: explicit columns, including the new scope fields ─────

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
begin
  v_lock_key := ('x' || substr(md5('agent_conv:' || p_conversation_id::text), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

  select updated_at into v_updated_at
    from public.agent_conversations
    where id = p_conversation_id;
  if not found or v_updated_at >= now() - make_interval(days => p_min_age_days) then
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
  v_exists boolean;
begin
  v_lock_key := ('x' || substr(md5('agent_conv:' || p_conversation_id::text), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

  select exists (
    select 1 from public.agent_conversations_archived where id = p_conversation_id
  ) into v_exists;
  if not v_exists then return -1; end if;

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

-- ── Property prep: reject portfolio rows before replay or append ──────────

create or replace function public.staxis_lock_load_and_record_user_turn(
  p_conversation_id uuid,
  p_user_account_id uuid,
  p_property_id uuid,
  p_user_message text
)
returns table(ok boolean, reason text, history_rows jsonb)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_lock_key bigint;
  v_convo record;
  v_history jsonb;
begin
  v_lock_key := ('x' || substr(md5('agent_conv:' || p_conversation_id::text), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

  select id, user_id, property_id, conversation_kind into v_convo
    from public.agent_conversations
    where id = p_conversation_id;
  if not found then
    return query select false, 'not_found'::text, null::jsonb;
    return;
  end if;
  if v_convo.user_id <> p_user_account_id then
    return query select false, 'wrong_owner'::text, null::jsonb;
    return;
  end if;
  if v_convo.conversation_kind <> 'property' then
    return query select false, 'wrong_kind'::text, null::jsonb;
    return;
  end if;
  if v_convo.property_id <> p_property_id then
    return query select false, 'wrong_property'::text, null::jsonb;
    return;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'role', m.role,
        'content', m.content,
        'tool_call_id', m.tool_call_id,
        'tool_name', m.tool_name,
        'tool_args', m.tool_args,
        'tool_result', m.tool_result,
        'is_summary', m.is_summary
      ) order by m.created_at asc
    ),
    '[]'::jsonb
  ) into v_history
  from public.agent_messages m
  where m.conversation_id = p_conversation_id
    and m.is_summarized = false;

  insert into public.agent_messages (conversation_id, role, content)
  values (p_conversation_id, 'user', p_user_message);

  return query select true, null::text, v_history;
end;
$$;

-- ── Portfolio create/prep: assert receipt in the same transaction ────────

create or replace function public.staxis_create_portfolio_conversation(
  p_user_account_id uuid,
  p_property_anchor_id uuid,
  p_role text,
  p_prompt_version text,
  p_title text,
  p_organization_id uuid,
  p_authorization_hash text,
  p_scope_receipt_id uuid,
  p_user_message text
)
returns table(ok boolean, reason text, conversation_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_assertion jsonb;
  v_receipt jsonb;
  v_reason text;
  v_current_hash text;
  v_conversation_id uuid;
begin
  begin
    v_assertion := public.staxis_assert_authorization_scope_receipt(
      p_scope_receipt_id, p_user_account_id
    );
  exception when others then
    return query select false, 'scope_unavailable'::text, null::uuid;
    return;
  end;

  if not coalesce((v_assertion->>'ok')::boolean, false) then
    v_reason := v_assertion->>'reason';
    return query select false,
      case
        when v_reason in ('revoked_or_changed', 'scope_changed') then 'scope_changed'
        when v_reason = 'store_unavailable' then 'scope_unavailable'
        else 'invalid_scope_receipt'
      end::text,
      null::uuid;
    return;
  end if;

  v_receipt := v_assertion->'receipt';
  v_current_hash := v_receipt->>'authorizationHash';
  if v_receipt->>'accountId' <> p_user_account_id::text
     or v_receipt->>'organizationId' <> p_organization_id::text
  then
    return query select false, 'invalid_scope_receipt'::text, null::uuid;
    return;
  end if;
  if v_current_hash is null
     or v_current_hash !~ '^[0-9a-f]{64}$'
     or v_current_hash <> p_authorization_hash
  then
    return query select false, 'scope_changed'::text, null::uuid;
    return;
  end if;
  if not exists (
    select 1
      from jsonb_array_elements_text(
        coalesce(v_receipt->'authorizedPropertyIds', '[]'::jsonb)
      ) authorized(property_id)
      where authorized.property_id = p_property_anchor_id::text
  ) then
    return query select false, 'scope_changed'::text, null::uuid;
    return;
  end if;

  insert into public.agent_conversations (
    user_id, property_id, role, title, prompt_version,
    conversation_kind, organization_id, authorization_hash,
    scope_receipt_id, scope_verified_at
  ) values (
    p_user_account_id, p_property_anchor_id, p_role, p_title, p_prompt_version,
    'portfolio', p_organization_id, v_current_hash,
    p_scope_receipt_id, clock_timestamp()
  ) returning id into v_conversation_id;

  insert into public.agent_messages (conversation_id, role, content)
  values (v_conversation_id, 'user', p_user_message);

  return query select true, null::text, v_conversation_id;
end;
$$;

create or replace function public.staxis_lock_load_and_record_portfolio_user_turn(
  p_conversation_id uuid,
  p_user_account_id uuid,
  p_organization_id uuid,
  p_authorization_hash text,
  p_scope_receipt_id uuid,
  p_user_message text
)
returns table(ok boolean, reason text, history_rows jsonb)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_lock_key bigint;
  v_convo record;
  v_assertion jsonb;
  v_receipt jsonb;
  v_reason text;
  v_current_hash text;
  v_history jsonb;
begin
  v_lock_key := ('x' || substr(md5('agent_conv:' || p_conversation_id::text), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

  select id, user_id, property_id, conversation_kind, organization_id,
         authorization_hash
    into v_convo
    from public.agent_conversations
    where id = p_conversation_id;
  if not found then
    return query select false, 'not_found'::text, null::jsonb;
    return;
  end if;
  if v_convo.user_id <> p_user_account_id then
    return query select false, 'wrong_owner'::text, null::jsonb;
    return;
  end if;
  if v_convo.conversation_kind <> 'portfolio' then
    return query select false, 'wrong_kind'::text, null::jsonb;
    return;
  end if;
  if v_convo.organization_id <> p_organization_id then
    return query select false, 'wrong_organization'::text, null::jsonb;
    return;
  end if;

  begin
    v_assertion := public.staxis_assert_authorization_scope_receipt(
      p_scope_receipt_id, p_user_account_id
    );
  exception when others then
    return query select false, 'scope_unavailable'::text, null::jsonb;
    return;
  end;

  if not coalesce((v_assertion->>'ok')::boolean, false) then
    v_reason := v_assertion->>'reason';
    return query select false,
      case
        when v_reason in ('revoked_or_changed', 'scope_changed') then 'scope_changed'
        when v_reason = 'store_unavailable' then 'scope_unavailable'
        else 'invalid_scope_receipt'
      end::text,
      null::jsonb;
    return;
  end if;

  v_receipt := v_assertion->'receipt';
  v_current_hash := v_receipt->>'authorizationHash';
  if v_receipt->>'accountId' <> p_user_account_id::text
     or v_receipt->>'organizationId' <> p_organization_id::text
  then
    return query select false, 'invalid_scope_receipt'::text, null::jsonb;
    return;
  end if;

  -- The selected property grain and scopeHash are intentionally absent here.
  -- A user may narrow/widen their question inside the SAME still-authorized
  -- universe. Only a change to the full selector-independent hash resets chat.
  if v_current_hash is null
     or v_current_hash !~ '^[0-9a-f]{64}$'
     or v_current_hash <> p_authorization_hash
     or v_convo.authorization_hash is null
     or v_convo.authorization_hash <> v_current_hash
  then
    return query select false, 'scope_changed'::text, null::jsonb;
    return;
  end if;
  if not exists (
    select 1
      from jsonb_array_elements_text(
        coalesce(v_receipt->'authorizedPropertyIds', '[]'::jsonb)
      ) authorized(property_id)
      where authorized.property_id = v_convo.property_id::text
  ) then
    return query select false, 'scope_changed'::text, null::jsonb;
    return;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'role', m.role,
        'content', m.content,
        'tool_call_id', m.tool_call_id,
        'tool_name', m.tool_name,
        'tool_args', m.tool_args,
        'tool_result', m.tool_result,
        'is_summary', m.is_summary
      ) order by m.created_at asc
    ),
    '[]'::jsonb
  ) into v_history
  from public.agent_messages m
  where m.conversation_id = p_conversation_id
    and m.is_summarized = false;

  insert into public.agent_messages (conversation_id, role, content)
  values (p_conversation_id, 'user', p_user_message);

  update public.agent_conversations
     set scope_receipt_id = p_scope_receipt_id,
         scope_verified_at = clock_timestamp()
   where id = p_conversation_id;

  return query select true, null::text, v_history;
end;
$$;

comment on function public.staxis_lock_load_and_record_user_turn(uuid, uuid, uuid, text) is
  'Atomic PROPERTY prep. Verifies owner + conversation_kind=property + exact property before replay/append; a portfolio row returns wrong_kind.';
comment on function public.staxis_create_portfolio_conversation(uuid, uuid, text, text, text, uuid, text, uuid, text) is
  'Atomic PORTFOLIO creation. Asserts a fresh 0376 receipt and anchor membership, stores its selector-independent authorizationHash, then writes the first user turn.';
comment on function public.staxis_lock_load_and_record_portfolio_user_turn(uuid, uuid, uuid, text, uuid, text) is
  'Atomic PORTFOLIO prep. Under one conversation lock: owner/kind/company check, fresh receipt assertion, stored selector-independent authorizationHash comparison, anchor authorization, replay, append.';

revoke execute on function public.staxis_archive_conversation(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.staxis_archive_conversation(uuid, integer)
  to service_role;

revoke execute on function public.staxis_restore_conversation(uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_restore_conversation(uuid)
  to service_role;

revoke execute on function public.staxis_lock_load_and_record_user_turn(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.staxis_lock_load_and_record_user_turn(uuid, uuid, uuid, text)
  to service_role;

revoke execute on function public.staxis_create_portfolio_conversation(uuid, uuid, text, text, text, uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.staxis_create_portfolio_conversation(uuid, uuid, text, text, text, uuid, text, uuid, text)
  to service_role;

revoke execute on function public.staxis_lock_load_and_record_portfolio_user_turn(uuid, uuid, uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.staxis_lock_load_and_record_portfolio_user_turn(uuid, uuid, uuid, text, uuid, text)
  to service_role;

insert into public.applied_migrations (version, description) values (
  '0377',
  'Explicit property/portfolio conversation scope, immutable company+authorization hash, receipt-asserted atomic portfolio create/prep, kind-safe property replay, and archive/restore parity'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
