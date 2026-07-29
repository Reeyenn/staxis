-- ═══════════════════════════════════════════════════════════════════════════
-- 0409 — Persist honest no-data Portfolio Ask turns.
--
-- A fully bound portfolio query receipt uses `abstained` when none of the
-- selected hotels can report evidence. The deterministic answer is still a
-- useful, honest empty state, but the 0399 turn-commit RPC accepted only
-- completed/partial receipts. That left the immutable receipt and model
-- artifact behind while returning a 503 and losing the conversation turn.
--
-- Admit `abstained` at the same final transaction boundary. All existing
-- account, company, authorization, scope-receipt, question-hash, answer-hash,
-- idempotency, size, and ACL checks remain unchanged. Error states such as
-- `authorization_changed` remain ineligible and commit no messages.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create or replace function public.staxis_commit_portfolio_conversation_turn(
  p_conversation_id uuid,
  p_user_account_id uuid,
  p_organization_id uuid,
  p_authorization_hash text,
  p_scope_receipt_id uuid,
  p_query_receipt_id uuid,
  p_user_message text,
  p_assistant_text text,
  p_tokens_in integer,
  p_tokens_out integer,
  p_model text,
  p_model_id text,
  p_cost_usd numeric,
  p_prompt_version text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_lock_key bigint;
  v_convo record;
  v_receipt record;
  v_assertion jsonb;
  v_current_receipt jsonb;
  v_existing record;
  v_user_message_id uuid;
  v_assistant_message_id uuid;
  v_question_hash text;
  v_answer_hash text;
begin
  if p_user_message is null or length(btrim(p_user_message)) = 0
     or p_assistant_text is null or length(btrim(p_assistant_text)) = 0
     or char_length(p_user_message) > 4000
     or octet_length(convert_to(p_user_message, 'UTF8')) > 16000
     or octet_length(convert_to(p_assistant_text, 'UTF8')) > 49000
     or p_tokens_in < 0 or p_tokens_out < 0 or p_cost_usd < 0
  then
    return jsonb_build_object('ok', false, 'reason', 'invalid_turn');
  end if;
  v_lock_key := ('x' || substr(md5('agent_conv:' || p_conversation_id::text), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);
  select id, user_id, property_id, conversation_kind, organization_id, authorization_hash
    into v_convo from public.agent_conversations where id = p_conversation_id for update;
  if not found or v_convo.user_id <> p_user_account_id then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_convo.conversation_kind <> 'portfolio'
     or v_convo.organization_id <> p_organization_id
     or v_convo.authorization_hash <> p_authorization_hash
  then
    return jsonb_build_object('ok', false, 'reason', 'scope_changed');
  end if;
  begin
    v_assertion := public.staxis_assert_authorization_scope_receipt(p_scope_receipt_id, p_user_account_id);
  exception when others then
    return jsonb_build_object('ok', false, 'reason', 'scope_unavailable');
  end;
  if not coalesce((v_assertion->>'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'reason', 'scope_changed');
  end if;
  v_current_receipt := v_assertion->'receipt';
  if v_current_receipt->>'accountId' <> p_user_account_id::text
     or v_current_receipt->>'organizationId' <> p_organization_id::text
     or v_current_receipt->>'authorizationHash' <> p_authorization_hash
     or not exists (
       select 1 from jsonb_array_elements_text(
         coalesce(v_current_receipt->'authorizedPropertyIds', '[]'::jsonb)
       ) authorized(property_id)
       where authorized.property_id = v_convo.property_id::text
     )
  then
    return jsonb_build_object('ok', false, 'reason', 'scope_changed');
  end if;

  select id, account_id, organization_id, conversation_id, authorization_hash,
         scope_receipt_id, question_hash, answer_hash, status
    into v_receipt
    from public.portfolio_query_receipts
   where id = p_query_receipt_id;
  if not found
     or v_receipt.account_id <> p_user_account_id
     or v_receipt.organization_id <> p_organization_id
     or v_receipt.conversation_id <> p_conversation_id
     or v_receipt.authorization_hash <> p_authorization_hash
     or v_receipt.scope_receipt_id <> p_scope_receipt_id
     or v_receipt.status not in ('completed', 'partial', 'abstained')
  then
    return jsonb_build_object('ok', false, 'reason', 'invalid_receipt');
  end if;
  v_question_hash := encode(
    extensions.digest(convert_to(btrim(p_user_message), 'UTF8'), 'sha256'),
    'hex'
  );
  if v_receipt.question_hash <> v_question_hash then
    return jsonb_build_object('ok', false, 'reason', 'question_mismatch');
  end if;
  v_answer_hash := encode(extensions.digest(convert_to(p_assistant_text, 'UTF8'), 'sha256'), 'hex');
  if v_receipt.answer_hash is null or v_receipt.answer_hash <> v_answer_hash then
    return jsonb_build_object('ok', false, 'reason', 'answer_mismatch');
  end if;

  select commit.user_message_id, commit.assistant_message_id
    into v_existing
    from public.portfolio_query_turn_commits commit
   where commit.query_receipt_id = p_query_receipt_id;
  if found then
    if exists (
      select 1 from public.agent_messages user_message
      join public.agent_messages assistant_message on assistant_message.id = v_existing.assistant_message_id
      where user_message.id = v_existing.user_message_id
        and user_message.content = p_user_message
        and assistant_message.content = p_assistant_text
    ) then
      return jsonb_build_object(
        'ok', true, 'reason', 'already_committed',
        'userMessageId', v_existing.user_message_id,
        'assistantMessageId', v_existing.assistant_message_id
      );
    end if;
    return jsonb_build_object('ok', false, 'reason', 'idempotency_conflict');
  end if;

  insert into public.agent_messages(conversation_id, role, content)
  values (p_conversation_id, 'user', p_user_message)
  returning id into v_user_message_id;
  insert into public.agent_messages(
    conversation_id, role, content, tokens_in, tokens_out,
    model_used, model_id, cost_usd, prompt_version
  ) values (
    p_conversation_id, 'assistant', p_assistant_text, p_tokens_in, p_tokens_out,
    p_model, p_model_id, p_cost_usd, p_prompt_version
  ) returning id into v_assistant_message_id;
  insert into public.portfolio_query_turn_commits(
    query_receipt_id, conversation_id, user_message_id, assistant_message_id
  ) values (
    p_query_receipt_id, p_conversation_id, v_user_message_id, v_assistant_message_id
  );
  update public.agent_conversations
     set scope_receipt_id = p_scope_receipt_id,
         scope_verified_at = clock_timestamp(),
         updated_at = clock_timestamp()
   where id = p_conversation_id;
  return jsonb_build_object(
    'ok', true, 'reason', 'committed',
    'userMessageId', v_user_message_id,
    'assistantMessageId', v_assistant_message_id
  );
end
$$;

revoke all on function public.staxis_commit_portfolio_conversation_turn(
  uuid, uuid, uuid, text, uuid, uuid, text, text,
  integer, integer, text, text, numeric, text
) from public, anon, authenticated;
grant execute on function public.staxis_commit_portfolio_conversation_turn(
  uuid, uuid, uuid, text, uuid, uuid, text, text,
  integer, integer, text, text, numeric, text
) to service_role;

comment on function public.staxis_commit_portfolio_conversation_turn(
  uuid, uuid, uuid, text, uuid, uuid, text, text,
  integer, integer, text, text, numeric, text
) is
  'Atomically commits a receipt-bound Portfolio Ask turn after fresh scope reassertion. Completed, partial, and honest abstained receipts are eligible; error receipts remain denied.';

insert into public.applied_migrations (version, description)
values (
  '0409',
  'Allow fully bound abstained Portfolio Ask receipts to commit and replay honest no-data conversation turns.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
