-- 0397_portfolio_model_request_artifacts.sql
--
-- Retention-governed, service-only reproduction artifacts for portfolio model
-- calls. A digest proves equality only when somebody already has the original;
-- it cannot reconstruct a disputed request. This table preserves the exact
-- provider-facing system/messages payload, applied parameters, configured and
-- actual model identities, raw model candidate, validated ID-only presentation
-- plan, and deterministic rendered answer. The immutable query receipt binds
-- to the artifact before any answer reaches the browser.

begin;

do $$
begin
  if to_regclass('public.portfolio_query_receipts') is null
     or to_regclass('public.authorization_scope_receipts') is null
     or to_regclass('public.agent_conversations') is null
  then
    raise exception '0397 requires portfolio receipts, authorization receipts and agent conversations';
  end if;
end
$$;

-- @rls: service-role-only — contains exact user questions, provider messages,
-- reference payloads and model candidates. It must never be browser-readable.
create table public.portfolio_model_request_artifacts (
  id                       uuid primary key default gen_random_uuid(),
  property_id              uuid not null references public.properties(id) on delete cascade,
  organization_id          uuid not null references public.organizations(id) on delete cascade,
  account_id               uuid not null references public.accounts(id) on delete cascade,
  conversation_id          uuid references public.agent_conversations(id) on delete set null,
  scope_receipt_id         uuid not null,
  authorization_hash       text not null,
  scope_hash               text not null,
  artifact_version         text not null,
  normalized_question      text not null,
  question_hash            text not null,
  prompt_version           text not null,
  prompt_hash              text not null,
  provider_request         jsonb not null,
  provider_request_hash    text not null,
  configured_execution     jsonb not null,
  applied_parameters       jsonb not null,
  actual_model_id          text not null,
  actual_model_tier        text not null,
  model_candidate_text     text not null,
  model_candidate_hash     text not null,
  presentation_plan        jsonb,
  presentation_plan_version text,
  renderer_version         text not null,
  rendered_answer_text     text,
  rendered_answer_hash     text,
  created_at               timestamptz not null default now(),

  constraint portfolio_model_request_artifacts_hash_check check (
    question_hash ~ '^[0-9a-f]{64}$'
    and prompt_hash ~ '^[0-9a-f]{64}$'
    and provider_request_hash ~ '^[0-9a-f]{64}$'
    and model_candidate_hash ~ '^[0-9a-f]{64}$'
    and (rendered_answer_hash is null or rendered_answer_hash ~ '^[0-9a-f]{64}$')
  ),
  constraint portfolio_model_request_artifacts_scope_check check (
    authorization_hash ~ '^[0-9a-f]{64}$'
    and scope_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint portfolio_model_request_artifacts_text_check check (
    artifact_version = 'portfolio-model-request.v1'
    and char_length(normalized_question) between 1 and 16000
    and char_length(prompt_version) between 1 and 2000
    and char_length(actual_model_id) between 1 and 300
    and char_length(actual_model_tier) between 1 and 80
    and char_length(renderer_version) between 1 and 120
    and octet_length(model_candidate_text) <= 1048576
    and (rendered_answer_text is null or octet_length(rendered_answer_text) <= 1048576)
  ),
  constraint portfolio_model_request_artifacts_json_check check (
    jsonb_typeof(provider_request) = 'object'
    and jsonb_typeof(configured_execution) = 'object'
    and jsonb_typeof(applied_parameters) = 'object'
    and (presentation_plan is null or jsonb_typeof(presentation_plan) = 'object')
    and octet_length(provider_request::text) <= 8388608
    and octet_length(configured_execution::text) <= 262144
    and octet_length(applied_parameters::text) <= 262144
    and (presentation_plan is null or octet_length(presentation_plan::text) <= 65536)
  ),
  constraint portfolio_model_request_artifacts_answer_pair_check check (
    (rendered_answer_text is null) = (rendered_answer_hash is null)
    and (presentation_plan is null) = (presentation_plan_version is null)
  )
);

-- The service role is the only writer, but a bug in that writer must not be
-- able to produce an apparently reproducible receipt whose attempt evidence is
-- internally contradictory. Validate the v1 envelope at the durable boundary:
-- a network failure has no response/usage, while rejected and successful 200s
-- retain both. Exactly one terminal response succeeds and its text is the raw
-- candidate fingerprinted below.
create or replace function public.staxis_validate_portfolio_model_request_artifact()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_attempt jsonb;
  v_response jsonb;
  v_usage jsonb;
  v_billable jsonb;
  v_outcome text;
  v_key text;
  v_index integer := 0;
  v_successes integer := 0;
  v_success_model text;
  v_success_text text;
  v_uncached numeric;
  v_output numeric;
  v_cached numeric;
  v_creation_reported numeric;
  v_creation_5m numeric;
  v_creation_1h numeric;
  v_creation numeric;
  v_candidate_plan jsonb;
begin
  if new.artifact_version <> 'portfolio-model-request.v1'
     or jsonb_typeof(new.provider_request) <> 'object'
     or new.provider_request->>'version' <> new.artifact_version
     or new.provider_request->>'runtime' <> 'messages.create'
     or jsonb_typeof(new.provider_request->'attempts') <> 'array'
     or jsonb_array_length(new.provider_request->'attempts') not between 1 and 2
  then
    raise exception 'invalid portfolio provider request envelope';
  end if;

  for v_attempt in
    select attempt.value
      from jsonb_array_elements(new.provider_request->'attempts')
             with ordinality as attempt(value, position)
     order by attempt.position
  loop
    if jsonb_typeof(v_attempt) <> 'object'
       or not (v_attempt ?& array[
         'ordinal', 'provider', 'requestedModelId', 'request', 'outcome',
         'response', 'responseModelId', 'billableUsage', 'failureName'
       ])
       or jsonb_typeof(v_attempt->'ordinal') <> 'number'
       or (v_attempt->>'ordinal')::integer <> v_index
       or coalesce(v_attempt->>'provider', '') = ''
       or coalesce(v_attempt->>'requestedModelId', '') = ''
       or jsonb_typeof(v_attempt->'request') <> 'object'
       or v_attempt->'request'->>'model' <> v_attempt->>'requestedModelId'
    then
      raise exception 'invalid portfolio provider attempt identity at ordinal %', v_index;
    end if;

    v_outcome := v_attempt->>'outcome';
    if v_outcome not in ('failed', 'rejected', 'succeeded') then
      raise exception 'invalid portfolio provider attempt outcome at ordinal %', v_index;
    end if;

    if v_outcome = 'failed' then
      if jsonb_typeof(v_attempt->'response') <> 'null'
         or jsonb_typeof(v_attempt->'responseModelId') <> 'null'
         or jsonb_typeof(v_attempt->'billableUsage') <> 'null'
         or jsonb_typeof(v_attempt->'failureName') <> 'string'
         or coalesce(v_attempt->>'failureName', '') = ''
      then
        raise exception 'failed portfolio provider attempt has response evidence at ordinal %', v_index;
      end if;
      v_index := v_index + 1;
      continue;
    end if;

    v_response := v_attempt->'response';
    v_usage := v_response->'usage';
    v_billable := v_attempt->'billableUsage';
    if jsonb_typeof(v_response) <> 'object'
       or jsonb_typeof(v_response->'content') <> 'array'
       or coalesce(v_response->>'model', '') = ''
       or v_attempt->>'responseModelId' <> v_response->>'model'
       or jsonb_typeof(v_usage) <> 'object'
       or jsonb_typeof(v_billable) <> 'object'
    then
      raise exception 'invalid portfolio provider response snapshot at ordinal %', v_index;
    end if;

    foreach v_key in array array[
      'inputTokens', 'uncachedInputTokens', 'outputTokens', 'cachedInputTokens',
      'cacheCreationInputTokens', 'cacheCreation5mInputTokens',
      'cacheCreation1hInputTokens'
    ]
    loop
      if jsonb_typeof(v_billable->v_key) <> 'number'
         or (v_billable->>v_key)::numeric < 0
      then
        raise exception 'invalid portfolio billable usage % at ordinal %', v_key, v_index;
      end if;
    end loop;

    foreach v_key in array array[
      'input_tokens', 'output_tokens', 'cache_read_input_tokens',
      'cache_creation_input_tokens'
    ]
    loop
      if v_usage ? v_key and jsonb_typeof(v_usage->v_key) <> 'number' then
        raise exception 'invalid provider usage % at ordinal %', v_key, v_index;
      end if;
    end loop;
    if not (v_usage ? 'input_tokens') or not (v_usage ? 'output_tokens') then
      raise exception 'provider usage is missing required counters at ordinal %', v_index;
    end if;
    if v_usage ? 'cache_creation'
       and jsonb_typeof(v_usage->'cache_creation') not in ('null', 'object')
    then
      raise exception 'invalid provider cache creation usage at ordinal %', v_index;
    end if;

    v_uncached := greatest(coalesce((v_usage->>'input_tokens')::numeric, 0), 0);
    v_output := greatest(coalesce((v_usage->>'output_tokens')::numeric, 0), 0);
    v_cached := greatest(coalesce((v_usage->>'cache_read_input_tokens')::numeric, 0), 0);
    v_creation_reported := greatest(
      coalesce((v_usage->>'cache_creation_input_tokens')::numeric, 0), 0
    );
    if jsonb_typeof(v_usage->'cache_creation'->'ephemeral_5m_input_tokens') = 'number' then
      v_creation_5m := greatest(
        (v_usage->'cache_creation'->>'ephemeral_5m_input_tokens')::numeric, 0
      );
    else
      v_creation_5m := 0;
    end if;
    if jsonb_typeof(v_usage->'cache_creation'->'ephemeral_1h_input_tokens') = 'number' then
      v_creation_1h := greatest(
        (v_usage->'cache_creation'->>'ephemeral_1h_input_tokens')::numeric, 0
      );
    else
      v_creation_1h := 0;
    end if;
    v_creation := greatest(v_creation_reported, v_creation_5m + v_creation_1h);

    if (v_billable->>'uncachedInputTokens')::numeric <> v_uncached
       or (v_billable->>'outputTokens')::numeric <> v_output
       or (v_billable->>'cachedInputTokens')::numeric <> v_cached
       or (v_billable->>'cacheCreationInputTokens')::numeric <> v_creation
       or (v_billable->>'cacheCreation5mInputTokens')::numeric <> v_creation_5m
       or (v_billable->>'cacheCreation1hInputTokens')::numeric <> v_creation_1h
       or (v_billable->>'inputTokens')::numeric <> v_uncached + v_cached + v_creation
    then
      raise exception 'portfolio billable usage does not match provider response at ordinal %', v_index;
    end if;

    if v_outcome = 'rejected' then
      if jsonb_typeof(v_attempt->'failureName') <> 'string'
         or coalesce(v_attempt->>'failureName', '') = ''
      then
        raise exception 'rejected portfolio response lacks validation failure at ordinal %', v_index;
      end if;
    else
      if jsonb_typeof(v_attempt->'failureName') <> 'null' then
        raise exception 'successful portfolio response carries a failure at ordinal %', v_index;
      end if;
      v_successes := v_successes + 1;
      v_success_model := v_response->>'model';
      select string_agg(block.value->>'text', E'\n' order by block.position)
        into v_success_text
        from jsonb_array_elements(v_response->'content')
               with ordinality as block(value, position)
       where block.value->>'type' = 'text';
      if v_index <> jsonb_array_length(new.provider_request->'attempts') - 1 then
        raise exception 'successful portfolio response is not terminal';
      end if;
    end if;
    v_index := v_index + 1;
  end loop;

  if v_successes <> 1
     or v_success_model <> new.actual_model_id
     or v_success_text is distinct from new.model_candidate_text
  then
    raise exception 'portfolio provider attempts do not reproduce the selected candidate';
  end if;
  if btrim(new.normalized_question) <> new.normalized_question
     or new.question_hash <> encode(
       extensions.digest(convert_to(new.normalized_question, 'UTF8'), 'sha256'), 'hex'
     )
     or new.model_candidate_hash <> encode(
       extensions.digest(convert_to(new.model_candidate_text, 'UTF8'), 'sha256'), 'hex'
     )
     or (
       new.rendered_answer_text is not null
       and new.rendered_answer_hash <> encode(
         extensions.digest(convert_to(new.rendered_answer_text, 'UTF8'), 'sha256'), 'hex'
       )
     )
  then
    raise exception 'portfolio artifact text/hash mismatch';
  end if;
  if new.presentation_plan is not null then
    begin
      v_candidate_plan := new.model_candidate_text::jsonb;
    exception when others then
      raise exception 'portfolio presentation plan is not the model candidate';
    end;
    if v_candidate_plan is distinct from new.presentation_plan
       or new.presentation_plan_version <> new.presentation_plan->>'version'
    then
      raise exception 'portfolio presentation plan is not the model candidate';
    end if;
  end if;
  return new;
end
$$;

revoke all on function public.staxis_validate_portfolio_model_request_artifact()
  from public, anon, authenticated;

create trigger portfolio_model_request_artifacts_validate
  before insert on public.portfolio_model_request_artifacts
  for each row execute function public.staxis_validate_portfolio_model_request_artifact();

create index portfolio_model_request_artifacts_conversation_idx
  on public.portfolio_model_request_artifacts(conversation_id, created_at desc)
  where conversation_id is not null;
create index portfolio_model_request_artifacts_account_idx
  on public.portfolio_model_request_artifacts(account_id, created_at desc);

comment on table public.portfolio_model_request_artifacts is
  'Immutable service-only exact model-request/reply artifacts for Portfolio Intelligence. Retained for incident replay under the same >=90-day receipt policy; never exposed in browser APIs. Created 0397.';
comment on column public.portfolio_model_request_artifacts.provider_request is
  'Exact ordered provider-facing Messages attempts, including requested alias/provider, body, outcome and response snapshot; preserves a rejected/failed primary before successful fallback. Contains raw authorized content.';
comment on column public.portfolio_model_request_artifacts.model_candidate_text is
  'Exact raw provider candidate. Portfolio v1 requires an ID-only JSON plan; this text is never released directly.';
comment on column public.portfolio_model_request_artifacts.rendered_answer_text is
  'Exact deterministic answer candidate rendered from immutable evidence. NULL when the model plan failed closed.';

alter table public.portfolio_model_request_artifacts enable row level security;
create policy portfolio_model_request_artifacts_deny_browser
  on public.portfolio_model_request_artifacts for all to anon, authenticated
  using (false) with check (false);
revoke all on public.portfolio_model_request_artifacts from public, anon, authenticated;
grant select, insert on public.portfolio_model_request_artifacts to service_role;

create trigger portfolio_model_request_artifacts_immutable
  before update or delete on public.portfolio_model_request_artifacts
  for each row execute function public.staxis_refuse_portfolio_receipt_mutation();

alter table public.portfolio_query_receipts
  add column request_artifact_id uuid
    references public.portfolio_model_request_artifacts(id) on delete restrict,
  add column model_candidate_hash text,
  add column presentation_plan_version text,
  add column renderer_version text;

alter table public.portfolio_query_receipts
  add constraint portfolio_query_receipts_model_candidate_hash_check check (
    model_candidate_hash is null or model_candidate_hash ~ '^[0-9a-f]{64}$'
  );

comment on column public.portfolio_query_receipts.request_artifact_id is
  'Required on every post-0397 insert by trigger. Binds this receipt to the exact immutable provider request/candidate artifact.';
comment on column public.portfolio_query_receipts.model_candidate_hash is
  'SHA-256 of the raw provider presentation-plan candidate; distinct from answer_hash, which fingerprints deterministic rendered text.';

create or replace function public.staxis_bind_portfolio_query_receipt_artifact()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_artifact public.portfolio_model_request_artifacts%rowtype;
begin
  if new.request_artifact_id is null then
    raise exception 'post-0397 portfolio receipts require an immutable request artifact';
  end if;
  select * into v_artifact
    from public.portfolio_model_request_artifacts
   where id = new.request_artifact_id;
  if not found then
    raise exception 'portfolio request artifact not found';
  end if;
  if v_artifact.property_id <> new.property_id
     or v_artifact.organization_id <> new.organization_id
     or v_artifact.account_id <> new.account_id
     or v_artifact.conversation_id is distinct from new.conversation_id
     or v_artifact.scope_receipt_id <> new.scope_receipt_id
     or v_artifact.authorization_hash <> new.authorization_hash
     or v_artifact.scope_hash <> new.scope_hash
     or v_artifact.question_hash <> new.question_hash
     or v_artifact.prompt_version <> new.prompt_version
     or v_artifact.prompt_hash <> new.prompt_hash
     or v_artifact.actual_model_id <> new.model_id
     or v_artifact.actual_model_tier <> new.model_tier
     or v_artifact.model_candidate_hash <> new.model_candidate_hash
     or v_artifact.presentation_plan_version is distinct from new.presentation_plan_version
     or v_artifact.renderer_version <> new.renderer_version
     or v_artifact.rendered_answer_hash is distinct from new.answer_hash
  then
    raise exception 'portfolio request artifact does not match receipt';
  end if;
  return new;
end
$$;

revoke all on function public.staxis_bind_portfolio_query_receipt_artifact()
  from public, anon, authenticated;

create trigger portfolio_query_receipts_bind_request_artifact
  before insert on public.portfolio_query_receipts
  for each row execute function public.staxis_bind_portfolio_query_receipt_artifact();

-- A conversation turn becomes replayable only when its question and rendered
-- answer are committed together against a completed/partial immutable receipt.
-- Failed provider calls, withheld plans, receipt failures and mid-turn
-- revocations therefore cannot leave a trailing user message in future model
-- context or browser history.
create table public.portfolio_query_turn_commits (
  query_receipt_id     uuid primary key
    references public.portfolio_query_receipts(id) on delete cascade,
  conversation_id     uuid not null
    references public.agent_conversations(id) on delete cascade,
  user_message_id     uuid not null unique
    references public.agent_messages(id) on delete cascade,
  assistant_message_id uuid not null unique
    references public.agent_messages(id) on delete cascade,
  replay_utf8_bytes    integer not null,
  committed_at        timestamptz not null default now(),
  constraint portfolio_query_turn_commits_distinct_messages_check
    check (user_message_id <> assistant_message_id),
  constraint portfolio_query_turn_commits_replay_bytes_check
    check (replay_utf8_bytes between 130 and 65128)
);

create index portfolio_query_turn_commits_conversation_idx
  on public.portfolio_query_turn_commits(
    conversation_id, committed_at desc, query_receipt_id desc
  );

alter table public.portfolio_query_turn_commits enable row level security;
create policy portfolio_query_turn_commits_deny_browser
  on public.portfolio_query_turn_commits for all to anon, authenticated
  using (false) with check (false);
revoke all on public.portfolio_query_turn_commits from public, anon, authenticated;
grant select on public.portfolio_query_turn_commits to service_role;

-- Exact currently retained totals let prep disclose omissions without
-- scanning every historical message. The insert/delete trigger below owns the
-- ledger so receipt retention updates the totals atomically; the application
-- service role has no direct privileges on it.
create table public.portfolio_conversation_replay_counters (
  conversation_id   uuid primary key
    references public.agent_conversations(id) on delete cascade,
  committed_turn_count bigint not null default 0
    check (committed_turn_count >= 0),
  committed_replay_utf8_bytes bigint not null default 0
    check (committed_replay_utf8_bytes >= 0),
  updated_at        timestamptz not null default now()
);

-- A fresh 0397 install has no committed rows yet. Keep an exact idempotent
-- backfill in the schema contract so a rehearsed/staged rollout cannot create
-- a counter gap if receipt-backed rows were populated earlier in the same
-- transaction by deployment tooling.
insert into public.portfolio_conversation_replay_counters (
  conversation_id, committed_turn_count, committed_replay_utf8_bytes, updated_at
)
select conversation_id,
       count(*)::bigint,
       coalesce(sum(replay_utf8_bytes), 0)::bigint,
       clock_timestamp()
  from public.portfolio_query_turn_commits
 group by conversation_id
on conflict (conversation_id) do update
  set committed_turn_count = excluded.committed_turn_count,
      committed_replay_utf8_bytes = excluded.committed_replay_utf8_bytes,
      updated_at = excluded.updated_at;

alter table public.portfolio_conversation_replay_counters enable row level security;
create policy portfolio_conversation_replay_counters_deny_browser
  on public.portfolio_conversation_replay_counters for all to anon, authenticated
  using (false) with check (false);
revoke all on public.portfolio_conversation_replay_counters
  from public, anon, authenticated, service_role;

comment on table public.portfolio_conversation_replay_counters is
  'Trigger-maintained exact complete-turn/replay-byte totals. Prep reads this constant-size ledger and at most 24 newest commit rows; no request rescans historical message text.';

create or replace function public.staxis_bind_portfolio_turn_replay_counter()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_conversation_kind text;
  v_user_conversation_id uuid;
  v_user_role text;
  v_user_content text;
  v_assistant_conversation_id uuid;
  v_assistant_role text;
  v_assistant_content text;
begin
  if tg_op = 'DELETE' then
    -- Parent-conversation deletion cascades both this row and its counter in an
    -- unspecified FK-trigger order. If the parent is already absent, no
    -- decrement is needed; its counter is being removed by the same cascade.
    if not exists (
      select 1 from public.agent_conversations
       where id = old.conversation_id
    ) then
      return old;
    end if;
    update public.portfolio_conversation_replay_counters
       set committed_turn_count = committed_turn_count - 1,
           committed_replay_utf8_bytes = committed_replay_utf8_bytes - old.replay_utf8_bytes,
           updated_at = clock_timestamp()
     where conversation_id = old.conversation_id
       and committed_turn_count >= 1
       and committed_replay_utf8_bytes >= old.replay_utf8_bytes;
    if not found then
      raise exception 'portfolio replay counter is missing or inconsistent';
    end if;
    return old;
  end if;

  select conversation_kind
    into v_conversation_kind
    from public.agent_conversations
   where id = new.conversation_id;
  select conversation_id, role, content
    into v_user_conversation_id, v_user_role, v_user_content
    from public.agent_messages
   where id = new.user_message_id;
  select conversation_id, role, content
    into v_assistant_conversation_id, v_assistant_role, v_assistant_content
    from public.agent_messages
   where id = new.assistant_message_id;

  if v_conversation_kind is distinct from 'portfolio'
     or v_user_conversation_id is distinct from new.conversation_id
     or v_assistant_conversation_id is distinct from new.conversation_id
     or v_user_role is distinct from 'user'
     or v_assistant_role is distinct from 'assistant'
     or v_user_content is null
     or length(btrim(v_user_content)) = 0
     or char_length(v_user_content) > 4000
     or octet_length(convert_to(v_user_content, 'UTF8')) > 16000
     or v_assistant_content is null
     or length(btrim(v_assistant_content)) = 0
     or octet_length(convert_to(v_assistant_content, 'UTF8')) > 49000
  then
    raise exception 'invalid portfolio complete turn';
  end if;

  new.replay_utf8_bytes :=
    octet_length(convert_to(v_user_content, 'UTF8'))
    + octet_length(convert_to(v_assistant_content, 'UTF8'))
    + 128;

  insert into public.portfolio_conversation_replay_counters (
    conversation_id, committed_turn_count, committed_replay_utf8_bytes, updated_at
  ) values (
    new.conversation_id, 1, new.replay_utf8_bytes, clock_timestamp()
  )
  on conflict (conversation_id) do update
    set committed_turn_count =
          public.portfolio_conversation_replay_counters.committed_turn_count + 1,
        committed_replay_utf8_bytes =
          public.portfolio_conversation_replay_counters.committed_replay_utf8_bytes
          + excluded.committed_replay_utf8_bytes,
        updated_at = clock_timestamp();
  return new;
end
$$;

revoke all on function public.staxis_bind_portfolio_turn_replay_counter()
  from public, anon, authenticated, service_role;

create trigger portfolio_query_turn_commits_bind_replay_counter
  before insert or delete on public.portfolio_query_turn_commits
  for each row execute function public.staxis_bind_portfolio_turn_replay_counter();

create trigger portfolio_query_turn_commits_immutable
  before update or delete on public.portfolio_query_turn_commits
  for each row execute function public.staxis_refuse_portfolio_receipt_mutation();

-- Same rolling-compatible signature as 0377, but the first user message is no
-- longer inserted here. p_user_message stays in the signature so an app and DB
-- can roll together; the receipt-bound commit RPC below is the only writer.
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
  if p_user_message is null
     or length(btrim(p_user_message)) = 0
     or char_length(p_user_message) > 4000
     or octet_length(convert_to(p_user_message, 'UTF8')) > 16000
  then
    return query select false, 'invalid_scope_receipt'::text, null::uuid;
    return;
  end if;
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
     or v_current_hash is null
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
  return query select true, null::text, v_conversation_id;
end
$$;

-- Continuation prep asserts current scope and returns committed history only.
-- It deliberately does not append p_user_message; that happens atomically with
-- the rendered assistant text after receipt persistence. Drop/recreate is
-- necessary because 0377's rolling-compatible precursor returned three table
-- columns; this final contract adds a closed, independently checked window
-- receipt. The function signature remains stable for PostgREST callers.
drop function if exists public.staxis_lock_load_and_record_portfolio_user_turn(
  uuid, uuid, uuid, text, uuid, text
);
create or replace function public.staxis_lock_load_and_record_portfolio_user_turn(
  p_conversation_id uuid,
  p_user_account_id uuid,
  p_organization_id uuid,
  p_authorization_hash text,
  p_scope_receipt_id uuid,
  p_user_message text
)
returns table(ok boolean, reason text, history_rows jsonb, history_meta jsonb)
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
  v_history_meta jsonb;
  v_total_turn_count bigint := 0;
  v_total_utf8_bytes bigint := 0;
  v_included_turn_count bigint := 0;
  v_included_utf8_bytes bigint := 0;
begin
  if p_user_message is null
     or length(btrim(p_user_message)) = 0
     or char_length(p_user_message) > 4000
     or octet_length(convert_to(p_user_message, 'UTF8')) > 16000
  then
    return query select false, 'invalid_scope_receipt'::text, null::jsonb, null::jsonb;
    return;
  end if;
  v_lock_key := ('x' || substr(md5('agent_conv:' || p_conversation_id::text), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);
  select id, user_id, property_id, conversation_kind, organization_id, authorization_hash
    into v_convo
    from public.agent_conversations
   where id = p_conversation_id;
  if not found then return query select false, 'not_found'::text, null::jsonb, null::jsonb; return; end if;
  if v_convo.user_id <> p_user_account_id then return query select false, 'wrong_owner'::text, null::jsonb, null::jsonb; return; end if;
  if v_convo.conversation_kind <> 'portfolio' then return query select false, 'wrong_kind'::text, null::jsonb, null::jsonb; return; end if;
  if v_convo.organization_id <> p_organization_id then return query select false, 'wrong_organization'::text, null::jsonb, null::jsonb; return; end if;
  begin
    v_assertion := public.staxis_assert_authorization_scope_receipt(p_scope_receipt_id, p_user_account_id);
  exception when others then
    return query select false, 'scope_unavailable'::text, null::jsonb, null::jsonb; return;
  end;
  if not coalesce((v_assertion->>'ok')::boolean, false) then
    v_reason := v_assertion->>'reason';
    return query select false,
      case when v_reason in ('revoked_or_changed', 'scope_changed') then 'scope_changed'
           when v_reason = 'store_unavailable' then 'scope_unavailable'
           else 'invalid_scope_receipt' end::text,
      null::jsonb,
      null::jsonb;
    return;
  end if;
  v_receipt := v_assertion->'receipt';
  v_current_hash := v_receipt->>'authorizationHash';
  if v_receipt->>'accountId' <> p_user_account_id::text
     or v_receipt->>'organizationId' <> p_organization_id::text
     or v_current_hash is null
     or v_current_hash !~ '^[0-9a-f]{64}$'
     or v_current_hash <> p_authorization_hash
     or v_convo.authorization_hash is null
     or v_convo.authorization_hash <> v_current_hash
  then
    return query select false, 'scope_changed'::text, null::jsonb, null::jsonb; return;
  end if;
  if not exists (
    select 1 from jsonb_array_elements_text(
      coalesce(v_receipt->'authorizedPropertyIds', '[]'::jsonb)
    ) authorized(property_id)
    where authorized.property_id = v_convo.property_id::text
  ) then
    return query select false, 'scope_changed'::text, null::jsonb, null::jsonb; return;
  end if;

  select committed_turn_count, committed_replay_utf8_bytes
    into v_total_turn_count, v_total_utf8_bytes
    from public.portfolio_conversation_replay_counters
   where conversation_id = p_conversation_id
   for share;
  if not found then
    v_total_turn_count := 0;
    v_total_utf8_bytes := 0;
  end if;

  -- The indexed candidate CTE limits first, so joins, cumulative accounting,
  -- and model-facing JSON aggregation each touch at most 24 complete turns.
  -- Exact retained omission totals come from the insert/delete trigger ledger.
  with candidate_commits as materialized (
    select commit.query_receipt_id,
           commit.committed_at,
           commit.user_message_id,
           commit.assistant_message_id,
           commit.replay_utf8_bytes
      from public.portfolio_query_turn_commits commit
     where commit.conversation_id = p_conversation_id
     order by commit.committed_at desc, commit.query_receipt_id desc
     limit 24
  ), complete_turns as materialized (
    select candidate.query_receipt_id,
           candidate.committed_at,
           user_message.role as user_role,
           user_message.content as user_content,
           assistant_message.role as assistant_role,
           assistant_message.content as assistant_content,
           candidate.replay_utf8_bytes::bigint as replay_utf8_bytes
      from candidate_commits candidate
      join public.agent_messages user_message
        on user_message.id = candidate.user_message_id
      join public.agent_messages assistant_message
        on assistant_message.id = candidate.assistant_message_id
  ), ranked_turns as materialized (
    select complete_turns.*,
           row_number() over (
             order by committed_at desc, query_receipt_id desc
           ) as newest_rank,
           sum(replay_utf8_bytes) over (
             order by committed_at desc, query_receipt_id desc
             rows between unbounded preceding and current row
           ) as cumulative_replay_utf8_bytes
      from complete_turns
  ), selected_turns as materialized (
    select *
      from ranked_turns
     where newest_rank <= 24
       and cumulative_replay_utf8_bytes <= 65536
  ), history_stats as (
    select count(*) filter (
             where newest_rank <= 24
               and cumulative_replay_utf8_bytes <= 65536
           )::bigint as included_turn_count,
           coalesce(sum(replay_utf8_bytes) filter (
             where newest_rank <= 24
               and cumulative_replay_utf8_bytes <= 65536
           ), 0)::bigint as included_utf8_bytes
      from ranked_turns
  )
  select coalesce((
           select jsonb_agg(row_payload order by committed_at, query_receipt_id, ordinal)
             from (
               select selected_turns.committed_at,
                      selected_turns.query_receipt_id,
                      1 as ordinal,
                      jsonb_build_object(
                        'role', selected_turns.user_role,
                        'content', selected_turns.user_content,
                        'tool_call_id', null,
                        'tool_name', null,
                        'tool_args', null,
                        'tool_result', null,
                        'is_summary', false
                      ) as row_payload
                 from selected_turns
               union all
               select selected_turns.committed_at,
                      selected_turns.query_receipt_id,
                      2 as ordinal,
                      jsonb_build_object(
                        'role', selected_turns.assistant_role,
                        'content', selected_turns.assistant_content,
                        'tool_call_id', null,
                        'tool_name', null,
                        'tool_args', null,
                        'tool_result', null,
                        'is_summary', false
                      ) as row_payload
                 from selected_turns
             ) committed_rows
         ), '[]'::jsonb),
         history_stats.included_turn_count,
         history_stats.included_utf8_bytes
    into v_history, v_included_turn_count, v_included_utf8_bytes
    from history_stats;

  if v_total_turn_count < v_included_turn_count
     or v_total_utf8_bytes < v_included_utf8_bytes
     or (v_total_turn_count = 0) <> (v_total_utf8_bytes = 0)
     or (v_total_turn_count > 0 and v_included_turn_count = 0)
  then
    raise exception 'portfolio replay counters are inconsistent';
  end if;
  v_history_meta := jsonb_build_object(
    'version', 'portfolio-history-window.v1',
    'maxTurns', 24,
    'maxUtf8Bytes', 65536,
    'turnOverheadUtf8Bytes', 128,
    'totalTurnCount', v_total_turn_count,
    'includedTurnCount', v_included_turn_count,
    'omittedTurnCount', v_total_turn_count - v_included_turn_count,
    'totalUtf8Bytes', v_total_utf8_bytes,
    'includedUtf8Bytes', v_included_utf8_bytes,
    'omittedUtf8Bytes', v_total_utf8_bytes - v_included_utf8_bytes
  );

  update public.agent_conversations
     set scope_receipt_id = p_scope_receipt_id,
         scope_verified_at = clock_timestamp()
   where id = p_conversation_id;
  return query select true, null::text, v_history, v_history_meta;
end
$$;

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
     or v_receipt.status not in ('completed', 'partial')
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

revoke execute on function public.staxis_create_portfolio_conversation(uuid, uuid, text, text, text, uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.staxis_create_portfolio_conversation(uuid, uuid, text, text, text, uuid, text, uuid, text)
  to service_role;
revoke execute on function public.staxis_lock_load_and_record_portfolio_user_turn(uuid, uuid, uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.staxis_lock_load_and_record_portfolio_user_turn(uuid, uuid, uuid, text, uuid, text)
  to service_role;
revoke all on function public.staxis_commit_portfolio_conversation_turn(uuid, uuid, uuid, text, uuid, uuid, text, text, integer, integer, text, text, numeric, text)
  from public, anon, authenticated;
grant execute on function public.staxis_commit_portfolio_conversation_turn(uuid, uuid, uuid, text, uuid, uuid, text, text, integer, integer, text, text, numeric, text)
  to service_role;

-- Preserve the existing public purge signature. Receipts are removed first so
-- their RESTRICT binding releases the exact artifacts; artifacts then follow
-- the same minimum retention boundary. The two reported counts stay backward
-- compatible for existing operations dashboards.
create or replace function public.staxis_purge_expired_portfolio_records(
  p_snapshot_before timestamptz,
  p_receipt_before timestamptz,
  p_limit integer default 5000
)
returns table(snapshots_deleted bigint, receipts_deleted bigint)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_snapshots bigint := 0;
  v_receipts bigint := 0;
begin
  if p_limit < 1 or p_limit > 50000 then
    raise exception 'p_limit must be between 1 and 50000';
  end if;
  if p_snapshot_before > now() - interval '1 day' then
    raise exception 'snapshot retention must be at least one day';
  end if;
  if p_receipt_before > now() - interval '90 days' then
    raise exception 'query receipt and request-artifact retention must be at least ninety days';
  end if;

  perform set_config('staxis.portfolio_purge', 'on', true);
  with doomed as (
    select id from public.portfolio_metric_snapshots
    where expires_at < p_snapshot_before
    order by expires_at
    limit p_limit
  )
  delete from public.portfolio_metric_snapshots target
  using doomed where target.id = doomed.id;
  get diagnostics v_snapshots = row_count;

  with doomed as (
    select id from public.portfolio_query_receipts
    where generated_at < p_receipt_before
    order by generated_at
    limit p_limit
  )
  delete from public.portfolio_query_receipts target
  using doomed where target.id = doomed.id;
  get diagnostics v_receipts = row_count;

  with doomed as (
    select id from public.portfolio_model_request_artifacts
    where created_at < p_receipt_before
      and not exists (
        select 1 from public.portfolio_query_receipts receipt
         where receipt.request_artifact_id = portfolio_model_request_artifacts.id
      )
    order by created_at
    limit p_limit
  )
  delete from public.portfolio_model_request_artifacts target
  using doomed where target.id = doomed.id;

  return query select v_snapshots, v_receipts;
end
$$;

revoke all on function public.staxis_purge_expired_portfolio_records(timestamptz, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.staxis_purge_expired_portfolio_records(timestamptz, timestamptz, integer)
  to service_role;

insert into public.applied_migrations(version, description)
values (
  '0397',
  'Immutable service-only exact Portfolio Intelligence provider request/candidate artifacts, receipt binding, and retention-governed replay evidence.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
