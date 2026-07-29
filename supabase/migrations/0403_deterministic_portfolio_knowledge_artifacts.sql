-- 0403_deterministic_portfolio_knowledge_artifacts.sql
--
-- Company/property knowledge answers are rendered deterministically and make
-- no provider request. They therefore must not forge a 0397 model-request
-- artifact. This migration gives those turns an exact, service-only artifact
-- of their own, binds it to the established portfolio_query_receipts and
-- portfolio_query_turn_commits chain, and preserves the same atomic replay and
-- authorization guarantees as metric/model turns.

begin;

do $$
begin
  if to_regclass('public.portfolio_query_receipts') is null
     or to_regclass('public.portfolio_model_request_artifacts') is null
     or to_regclass('public.portfolio_query_turn_commits') is null
     or to_regclass('public.authorization_scope_receipts') is null
  then
    raise exception '0403 requires the 0397 portfolio receipt/artifact/commit boundary';
  end if;
end
$$;

-- @rls: service-role-only. This is the deterministic equivalent of the 0397
-- model artifact and contains raw authorized company/property reference text.
create table public.portfolio_knowledge_request_artifacts (
  id                        uuid primary key default gen_random_uuid(),
  property_id               uuid not null references public.properties(id) on delete cascade,
  organization_id           uuid not null references public.organizations(id) on delete cascade,
  account_id                uuid not null references public.accounts(id) on delete cascade,
  conversation_id           uuid not null references public.agent_conversations(id) on delete cascade,
  scope_receipt_id          uuid not null,
  authorization_hash        text not null,
  scope_hash                text not null,
  artifact_version          text not null,
  normalized_question       text not null,
  question_hash             text not null,
  query_plan_version        text not null,
  plan                      jsonb not null,
  overlay_version           text not null,
  presentation_version      text not null,
  authorized_property_ids   uuid[] not null,
  selected_property_ids     uuid[] not null,
  selected_claim_ids        text[] not null,
  source_versions           jsonb not null,
  knowledge_versions        jsonb not null,
  finding_versions          jsonb not null,
  evidence                  jsonb not null,
  reproduction_input        jsonb not null,
  rendered_answer_text      text not null,
  rendered_answer_hash      text not null,
  duration_ms               integer not null,
  generated_at              timestamptz not null,
  created_at                timestamptz not null default clock_timestamp(),

  constraint portfolio_knowledge_artifacts_hash_check check (
    authorization_hash ~ '^[0-9a-f]{64}$'
    and scope_hash ~ '^[0-9a-f]{64}$'
    and question_hash ~ '^[0-9a-f]{64}$'
    and rendered_answer_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint portfolio_knowledge_artifacts_scope_check check (
    cardinality(authorized_property_ids) > 0
    and cardinality(selected_property_ids) > 0
    and selected_property_ids <@ authorized_property_ids
    and property_id = any(selected_property_ids)
  ),
  constraint portfolio_knowledge_artifacts_text_check check (
    artifact_version = 'portfolio-knowledge-artifact.v1'
    and char_length(normalized_question) between 1 and 16000
    and char_length(query_plan_version) between 1 and 120
    and char_length(overlay_version) between 1 and 120
    and presentation_version = 'portfolio-knowledge-presentation.v1'
    and octet_length(rendered_answer_text) <= 1048576
    and duration_ms >= 0
  ),
  constraint portfolio_knowledge_artifacts_json_check check (
    jsonb_typeof(plan) = 'object'
    and jsonb_typeof(source_versions) = 'array'
    and jsonb_typeof(knowledge_versions) = 'object'
    and jsonb_typeof(finding_versions) = 'object'
    and jsonb_typeof(evidence) = 'object'
    and jsonb_typeof(reproduction_input) = 'object'
    and octet_length(plan::text) <= 262144
    and octet_length(source_versions::text) <= 524288
    and octet_length(knowledge_versions::text) <= 1048576
    and octet_length(finding_versions::text) <= 65536
    and octet_length(evidence::text) <= 2097152
    and octet_length(reproduction_input::text) <= 4194304
  ),
  constraint portfolio_knowledge_artifacts_claim_ids_check check (
    cardinality(selected_claim_ids) <= 40
  )
);

create or replace function public._staxis_jsonb_exact_keys(
  p_value jsonb,
  p_keys text[]
)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  v_actual text[];
  v_expected text[];
begin
  if jsonb_typeof(p_value) is distinct from 'object' then return false; end if;
  select coalesce(array_agg(key order by key), array[]::text[])
    into v_actual from jsonb_object_keys(p_value) key;
  select coalesce(array_agg(key order by key), array[]::text[])
    into v_expected from unnest(p_keys) key;
  return v_actual = v_expected;
end
$$;

-- TypeScript signs finding receipts over recursively canonical JSON (sorted
-- object keys, compact separators, preserved array order). jsonb::text adds
-- whitespace, so reproduce that algorithm here before trusting receiptHash.
create or replace function public._staxis_jsonb_canonical_text(p_value jsonb)
returns text
language plpgsql
immutable
strict
set search_path = pg_catalog, public
as $$
declare
  v_result text;
begin
  case jsonb_typeof(p_value)
    when 'null', 'boolean', 'number', 'string' then
      return p_value::text;
    when 'array' then
      select '[' || coalesce(string_agg(
        public._staxis_jsonb_canonical_text(item.value), ',' order by item.position
      ), '') || ']'
        into v_result
        from jsonb_array_elements(p_value) with ordinality item(value, position);
      return v_result;
    when 'object' then
      select '{' || coalesce(string_agg(
        to_jsonb(item.key)::text || ':' ||
          public._staxis_jsonb_canonical_text(item.value),
        -- Node's default String.localeCompare orders ASCII contract keys
        -- case-insensitively before applying case as a tie-breaker. The DTOs
        -- use camelCase, so raw C collation would incorrectly place loadVersion
        -- before loadedAt and invalidate an otherwise authentic signature.
        ',' order by lower(item.key) collate "C", item.key collate "C"
      ), '') || '}'
        into v_result
        from jsonb_each(p_value) item;
      return v_result;
    else
      raise exception 'cannot canonicalize a non-JSON value';
  end case;
end
$$;

create or replace function public._staxis_jsonb_bounded_integer(
  p_value jsonb,
  p_min numeric,
  p_max numeric
)
returns boolean
language plpgsql
immutable
strict
set search_path = pg_catalog, public
as $$
declare
  v_text text;
  v_number numeric;
begin
  if jsonb_typeof(p_value) is distinct from 'number' then return false; end if;
  v_text := p_value #>> '{}';
  if v_text !~ '^-?(0|[1-9][0-9]*)$' then return false; end if;
  v_number := v_text::numeric;
  return v_number between p_min and p_max;
exception when others then
  return false;
end
$$;

create or replace function public._staxis_jsonb_identifier_or_null(
  p_value jsonb,
  p_fingerprint boolean default false
)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
begin
  if jsonb_typeof(p_value) = 'null' then return true; end if;
  if jsonb_typeof(p_value) is distinct from 'string' then return false; end if;
  if p_fingerprint then
    return length(p_value #>> '{}') between 8 and 200
      and (p_value #>> '{}') ~ '^[A-Za-z0-9._:-]+$';
  end if;
  return length(p_value #>> '{}') between 1 and 160
    and (p_value #>> '{}') ~ '^[A-Za-z0-9._:@/-]+$';
end
$$;

create or replace function public._staxis_portfolio_finding_claim_array_ok(
  p_value jsonb,
  p_max integer
)
returns boolean
language plpgsql
immutable
strict
set search_path = pg_catalog, public
as $$
begin
  if jsonb_typeof(p_value) is distinct from 'array'
     or jsonb_array_length(p_value) > p_max
     or exists (
       select 1
         from jsonb_array_elements(p_value) claim
        where jsonb_typeof(claim) is distinct from 'string'
           or coalesce(claim #>> '{}', '') !~ '^pc_[0-9a-f]{24}$'
     )
     or jsonb_array_length(p_value) is distinct from (
       select count(distinct claim #>> '{}')
         from jsonb_array_elements(p_value) claim
     )
  then
    return false;
  end if;
  return true;
end
$$;

-- Returns -1 for a malformed bounded summary; otherwise returns its total.
create or replace function public._staxis_portfolio_finding_summary_total(
  p_value jsonb,
  p_max_items integer default 8,
  p_max_count numeric default 9007199254740991
)
returns numeric
language plpgsql
immutable
strict
set search_path = pg_catalog, public
as $$
declare
  v_item jsonb;
  v_total numeric := 0;
begin
  if jsonb_typeof(p_value) is distinct from 'array'
     or jsonb_array_length(p_value) > p_max_items
  then
    return -1;
  end if;
  for v_item in select value from jsonb_array_elements(p_value) value loop
    if not public._staxis_jsonb_exact_keys(v_item, array['code', 'count'])
       or jsonb_typeof(v_item->'code') is distinct from 'string'
       or length(v_item->>'code') not between 1 and 160
       or v_item->>'code' !~ '^[A-Za-z0-9._:@/-]+$'
       or not public._staxis_jsonb_bounded_integer(v_item->'count', 1, p_max_count)
    then
      return -1;
    end if;
    v_total := v_total + (v_item->>'count')::numeric;
  end loop;
  return v_total;
exception when others then
  return -1;
end
$$;

create or replace function public._staxis_portfolio_finding_instant_ok(p_value jsonb)
returns boolean
language plpgsql
immutable
strict
set search_path = pg_catalog, public
as $$
declare
  v_text text;
  v_parsed timestamptz;
begin
  if jsonb_typeof(p_value) is distinct from 'string' then return false; end if;
  v_text := p_value #>> '{}';
  if length(v_text) not between 1 and 40 or position('T' in v_text) = 0 then
    return false;
  end if;
  v_parsed := v_text::timestamptz;
  return v_parsed is not null;
exception when others then
  return false;
end
$$;

-- Validate the compact, statement-free producer receipt emitted by
-- pattern-contract.ts. Counts use numeric because JavaScript's safe integer
-- ceiling is larger than PostgreSQL integer; property counts remain bounded.
create or replace function public._staxis_portfolio_finding_producer_ok(
  p_value jsonb,
  p_status text,
  p_account_id uuid,
  p_organization_id uuid,
  p_scope_receipt_id uuid,
  p_authorization_hash text,
  p_scope_hash text,
  p_authorized_count integer,
  p_selected_count integer
)
returns boolean
language plpgsql
immutable
strict
set search_path = pg_catalog, public
as $$
declare
  v_run jsonb;
  v_run_coverage jsonb;
  v_coverage jsonb;
  v_truncation jsonb;
  v_outage jsonb;
  v_row jsonb;
  v_exclusion_total numeric;
  v_rejected_total numeric;
  v_run_exclusion_total numeric := 0;
  v_expected_exclusion_total numeric;
  v_no_run boolean;
  v_nullable_binding boolean;
  v_present_binding boolean;
begin
  if not public._staxis_jsonb_exact_keys(p_value, array[
       'loadVersion', 'loadedAt', 'accountId', 'organizationId',
       'scopeReceiptId', 'authorizationHash', 'scopeHash', 'projectionMode',
       'status', 'contractVersion', 'run', 'sourceAvailableCandidateCount',
       'omittedByLimitCount', 'selectionWasTruncated', 'coverage',
       'truncation', 'outage', 'exclusionSummary',
       'exclusionSummaryOmittedCount', 'rejectedCandidateSummary',
       'rejectedCandidateSummaryOmittedCount', 'fingerprint'
     ])
     or p_value->>'loadVersion' is distinct from
          'management-pattern-portfolio-load.v1'
     or not public._staxis_portfolio_finding_instant_ok(p_value->'loadedAt')
     or jsonb_typeof(p_value->'accountId') is distinct from 'string'
     or jsonb_typeof(p_value->'scopeReceiptId') is distinct from 'string'
     or p_value->>'accountId' is distinct from p_account_id::text
     or p_value->>'scopeReceiptId' is distinct from p_scope_receipt_id::text
     or coalesce(jsonb_typeof(p_value->'organizationId'), 'missing')
          not in ('null', 'string')
     or coalesce(jsonb_typeof(p_value->'authorizationHash'), 'missing')
          not in ('null', 'string')
     or coalesce(jsonb_typeof(p_value->'scopeHash'), 'missing')
          not in ('null', 'string')
     or (
       jsonb_typeof(p_value->'authorizationHash') = 'string'
       and coalesce(p_value->>'authorizationHash', '') !~ '^[0-9a-f]{64}$'
     )
     or (
       jsonb_typeof(p_value->'scopeHash') = 'string'
       and coalesce(p_value->>'scopeHash', '') !~ '^[0-9a-f]{64}$'
     )
     or coalesce(jsonb_typeof(p_value->'projectionMode'), 'missing')
          not in ('null', 'string')
     or (
       jsonb_typeof(p_value->'projectionMode') = 'string'
       and coalesce(p_value->>'projectionMode', '') not in ('active', 'shadow')
     )
     or p_value->>'status' is distinct from p_status
     or p_value->>'contractVersion' is distinct from 'portfolio-finding.v1'
     or coalesce(jsonb_typeof(p_value->'run'), 'missing') not in ('null', 'object')
     or not public._staxis_jsonb_bounded_integer(
       p_value->'sourceAvailableCandidateCount', 0, 9007199254740991
     )
     or not public._staxis_jsonb_bounded_integer(
       p_value->'omittedByLimitCount', 0, 9007199254740991
     )
     or jsonb_typeof(p_value->'selectionWasTruncated') is distinct from 'boolean'
     or (p_value->>'selectionWasTruncated')::boolean is distinct from false
     or jsonb_typeof(p_value->'fingerprint') is distinct from 'string'
     or coalesce(p_value->>'fingerprint', '') !~ '^[0-9a-f]{64}$'
     or not public._staxis_jsonb_bounded_integer(
       p_value->'exclusionSummaryOmittedCount', 0, 9007199254740991
     )
     or not public._staxis_jsonb_bounded_integer(
       p_value->'rejectedCandidateSummaryOmittedCount', 0, 9007199254740991
     )
  then
    return false;
  end if;

  v_exclusion_total := public._staxis_portfolio_finding_summary_total(
    p_value->'exclusionSummary'
  );
  v_rejected_total := public._staxis_portfolio_finding_summary_total(
    p_value->'rejectedCandidateSummary'
  );
  if v_exclusion_total < 0 or v_rejected_total < 0 then return false; end if;
  v_rejected_total := v_rejected_total
    + (p_value->>'rejectedCandidateSummaryOmittedCount')::numeric;
  if p_status <> 'loaded'
     and v_exclusion_total
       + (p_value->>'exclusionSummaryOmittedCount')::numeric < 1
  then
    return false;
  end if;

  v_coverage := p_value->'coverage';
  if not public._staxis_jsonb_exact_keys(v_coverage, array[
       'authorizedPropertyCount', 'selectedPropertyCount',
       'evaluatedPropertyCount', 'affectedPropertyCount',
       'sourceCandidateCount', 'findingCount'
     ])
     or coalesce(jsonb_typeof(v_coverage->'authorizedPropertyCount'), 'missing')
          not in ('null', 'number')
     or (
       jsonb_typeof(v_coverage->'authorizedPropertyCount') = 'number'
       and not public._staxis_jsonb_bounded_integer(
         v_coverage->'authorizedPropertyCount', 0, 9007199254740991
       )
     )
     or not public._staxis_jsonb_bounded_integer(
       v_coverage->'selectedPropertyCount', 0, 250
     )
     or not public._staxis_jsonb_bounded_integer(
       v_coverage->'evaluatedPropertyCount', 0, 250
     )
     or not public._staxis_jsonb_bounded_integer(
       v_coverage->'affectedPropertyCount', 0, 250
     )
     or not public._staxis_jsonb_bounded_integer(
       v_coverage->'sourceCandidateCount', 0, 9007199254740991
     )
     or not public._staxis_jsonb_bounded_integer(v_coverage->'findingCount', 0, 100)
     or (v_coverage->>'selectedPropertyCount')::integer <> p_selected_count
     or (
       jsonb_typeof(v_coverage->'authorizedPropertyCount') = 'number'
       and (v_coverage->>'authorizedPropertyCount')::numeric <> p_authorized_count
     )
     or (v_coverage->>'affectedPropertyCount')::integer
          > (v_coverage->>'evaluatedPropertyCount')::integer
     or (v_coverage->>'evaluatedPropertyCount')::integer
          > (v_coverage->>'selectedPropertyCount')::integer
     or (p_value->>'sourceAvailableCandidateCount')::numeric
          <> (v_coverage->>'sourceCandidateCount')::numeric
  then
    return false;
  end if;

  v_truncation := p_value->'truncation';
  if not public._staxis_jsonb_exact_keys(v_truncation, array[
       'occurred', 'limit', 'omittedCount'
     ])
     or jsonb_typeof(v_truncation->'occurred') is distinct from 'boolean'
     or not public._staxis_jsonb_bounded_integer(
       v_truncation->'limit', 1, 40
     )
     or not public._staxis_jsonb_bounded_integer(
       v_truncation->'omittedCount', 0, 9007199254740991
     )
     or (v_truncation->>'occurred')::boolean is distinct from
          ((v_truncation->>'omittedCount')::numeric > 0)
     or (p_value->>'omittedByLimitCount')::numeric
          <> (v_truncation->>'omittedCount')::numeric
  then
    return false;
  end if;

  v_outage := p_value->'outage';
  if not public._staxis_jsonb_exact_keys(v_outage, array[
       'occurred', 'stage', 'reason'
     ])
     or jsonb_typeof(v_outage->'occurred') is distinct from 'boolean'
     or coalesce(jsonb_typeof(v_outage->'stage'), 'missing') not in ('null', 'string')
     or (
       jsonb_typeof(v_outage->'stage') = 'string'
       and coalesce(v_outage->>'stage', '') not in (
         'authorization_before_read', 'source_read', 'authorization_after_read'
       )
     )
     or not public._staxis_jsonb_identifier_or_null(v_outage->'reason')
     or (v_outage->>'occurred')::boolean is distinct from (
       jsonb_typeof(v_outage->'stage') = 'string'
       and jsonb_typeof(v_outage->'reason') = 'string'
     )
  then
    return false;
  end if;

  if (v_coverage->>'findingCount')::numeric + v_rejected_total
       + (p_value->>'omittedByLimitCount')::numeric
       <> (p_value->>'sourceAvailableCandidateCount')::numeric
     or (v_coverage->>'findingCount')::numeric + v_rejected_total
          > (v_truncation->>'limit')::numeric
  then
    return false;
  end if;

  v_nullable_binding := jsonb_typeof(p_value->'organizationId') = 'null'
    and jsonb_typeof(p_value->'authorizationHash') = 'null'
    and jsonb_typeof(p_value->'scopeHash') = 'null';
  v_present_binding := jsonb_typeof(p_value->'organizationId') = 'string'
    and jsonb_typeof(p_value->'authorizationHash') = 'string'
    and jsonb_typeof(p_value->'scopeHash') = 'string';
  if not v_nullable_binding and not v_present_binding then return false; end if;
  if (v_outage->>'occurred')::boolean is distinct from (p_status = 'unavailable')
     or (
       v_outage->>'stage' = 'authorization_before_read'
       and not v_nullable_binding
     )
  then
    return false;
  end if;
  if p_status = 'unavailable'
     and (
       jsonb_array_length(p_value->'exclusionSummary') <> 1
       or p_value->'exclusionSummary'->0->>'code'
            is distinct from v_outage->>'reason'
       or (p_value->'exclusionSummary'->0->>'count')::numeric <> 1
       or (p_value->>'exclusionSummaryOmittedCount')::numeric <> 0
     )
  then
    return false;
  end if;
  if v_present_binding then
    if p_value->>'organizationId' is distinct from p_organization_id::text
       or p_value->>'authorizationHash' is distinct from p_authorization_hash
       or p_value->>'scopeHash' is distinct from p_scope_hash
    then return false; end if;
  elsif not (
    (
      p_status = 'unavailable'
      and (v_outage->>'occurred')::boolean
      and v_outage->>'stage' = 'authorization_before_read'
    )
    or
    (
      p_status = 'scope_changed'
      and not (v_outage->>'occurred')::boolean
      and jsonb_typeof(v_outage->'stage') = 'null'
      and jsonb_typeof(v_outage->'reason') = 'null'
    )
  )
     or jsonb_typeof(v_coverage->'authorizedPropertyCount') <> 'null'
     or (p_value->>'sourceAvailableCandidateCount')::numeric <> 0
     or (p_value->>'omittedByLimitCount')::numeric <> 0
     or (v_coverage->>'evaluatedPropertyCount')::numeric <> 0
     or (v_coverage->>'affectedPropertyCount')::numeric <> 0
     or (v_coverage->>'sourceCandidateCount')::numeric <> 0
     or (v_coverage->>'findingCount')::numeric <> 0
     or (v_truncation->>'occurred')::boolean
     or (v_truncation->>'omittedCount')::numeric <> 0
     or v_rejected_total <> 0
     or jsonb_array_length(p_value->'exclusionSummary') <> 1
     or v_exclusion_total <> 1
     or (p_value->>'exclusionSummaryOmittedCount')::numeric <> 0
  then
    return false;
  end if;

  v_no_run := p_status in (
    'no_finalized_run', 'scope_too_large', 'scope_changed', 'unavailable'
  );
  v_run := p_value->'run';
  if v_no_run then
    if jsonb_typeof(v_run) <> 'null'
       or jsonb_typeof(p_value->'projectionMode') <> 'null'
    then return false; end if;
  else
    if jsonb_typeof(v_run) <> 'object'
       or jsonb_typeof(p_value->'projectionMode') <> 'string'
       or p_value->>'projectionMode' is distinct from v_run->>'projectionMode'
       or (p_status = 'shadow_only' and p_value->>'projectionMode' <> 'shadow')
       or (p_status <> 'shadow_only' and p_value->>'projectionMode' <> 'active')
    then return false; end if;

    if not public._staxis_jsonb_exact_keys(v_run, array[
         'runId', 'runFingerprint', 'portfolioSnapshotFingerprint',
         'projectionMode', 'engineVersion', 'evidenceSchemaVersion',
         'cohortPolicyVersion', 'normalizationPolicyVersion',
         'dedupePolicyVersion', 'scopePolicyVersion', 'sourceQueryId',
         'sourceQueryVersion', 'evaluationAt', 'sourceAsOf', 'windowStart',
         'windowEnd', 'completedAt', 'validThrough', 'terminalStatus', 'coverage'
       ])
       or coalesce(jsonb_typeof(v_run->'runId'), 'missing') not in ('null', 'string')
       or (
         jsonb_typeof(v_run->'runId') = 'string'
         and coalesce(v_run->>'runId', '') !~
           '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
       )
       or coalesce(jsonb_typeof(v_run->'runFingerprint'), 'missing')
            not in ('null', 'string')
       or (
         jsonb_typeof(v_run->'runFingerprint') = 'string'
         and coalesce(v_run->>'runFingerprint', '') !~ '^[0-9a-f]{64}$'
       )
       or coalesce(jsonb_typeof(v_run->'portfolioSnapshotFingerprint'), 'missing')
            not in ('null', 'string')
       or (
         jsonb_typeof(v_run->'portfolioSnapshotFingerprint') = 'string'
         and coalesce(v_run->>'portfolioSnapshotFingerprint', '') !~ '^[0-9a-f]{64}$'
       )
       or coalesce(v_run->>'projectionMode', '') not in ('active', 'shadow')
       or not public._staxis_jsonb_identifier_or_null(v_run->'engineVersion')
       or jsonb_typeof(v_run->'engineVersion') <> 'string'
       or not public._staxis_jsonb_bounded_integer(
         v_run->'evidenceSchemaVersion', 1, 1000000
       )
       or not public._staxis_jsonb_identifier_or_null(v_run->'cohortPolicyVersion')
       or jsonb_typeof(v_run->'cohortPolicyVersion') <> 'string'
       or not public._staxis_jsonb_identifier_or_null(v_run->'normalizationPolicyVersion')
       or jsonb_typeof(v_run->'normalizationPolicyVersion') <> 'string'
       or not public._staxis_jsonb_identifier_or_null(v_run->'dedupePolicyVersion')
       or jsonb_typeof(v_run->'dedupePolicyVersion') <> 'string'
       or not public._staxis_jsonb_identifier_or_null(v_run->'scopePolicyVersion')
       or jsonb_typeof(v_run->'scopePolicyVersion') <> 'string'
       or not public._staxis_jsonb_identifier_or_null(v_run->'sourceQueryId')
       or jsonb_typeof(v_run->'sourceQueryId') <> 'string'
       or not public._staxis_jsonb_identifier_or_null(v_run->'sourceQueryVersion')
       or jsonb_typeof(v_run->'sourceQueryVersion') <> 'string'
       or not public._staxis_portfolio_finding_instant_ok(v_run->'evaluationAt')
       or not public._staxis_portfolio_finding_instant_ok(v_run->'sourceAsOf')
       or not public._staxis_portfolio_finding_instant_ok(v_run->'windowStart')
       or not public._staxis_portfolio_finding_instant_ok(v_run->'windowEnd')
       or not public._staxis_portfolio_finding_instant_ok(v_run->'completedAt')
       or not public._staxis_portfolio_finding_instant_ok(v_run->'validThrough')
       or coalesce(v_run->>'terminalStatus', '') not in ('succeeded', 'abstained')
       or not (
         (
           p_status in ('loaded', 'no_applicable_findings', 'incomplete_scope')
           and v_run->>'terminalStatus' = 'succeeded'
         )
         or (
           p_status = 'abstained'
           and v_run->>'terminalStatus' = 'abstained'
         )
         or (
           p_status in ('shadow_only', 'stale')
           and v_run->>'terminalStatus' in ('succeeded', 'abstained')
         )
       )
       or ((jsonb_typeof(v_run->'runId') = 'null') is distinct from
           (jsonb_typeof(v_run->'runFingerprint') = 'null'))
       or (v_run->>'windowStart')::timestamptz > (v_run->>'windowEnd')::timestamptz
       or (v_run->>'sourceAsOf')::timestamptz > (v_run->>'completedAt')::timestamptz
       or (v_run->>'evaluationAt')::timestamptz > (v_run->>'completedAt')::timestamptz
       or (v_run->>'completedAt')::timestamptz > (v_run->>'validThrough')::timestamptz
    then
      return false;
    end if;

    if p_status = 'loaded' then
      if jsonb_typeof(v_run->'runId') <> 'string'
         or jsonb_typeof(v_run->'runFingerprint') <> 'string'
         or jsonb_typeof(v_run->'portfolioSnapshotFingerprint') <> 'string'
      then return false; end if;
    elsif jsonb_typeof(v_run->'runId') <> 'null'
       or jsonb_typeof(v_run->'runFingerprint') <> 'null'
       or jsonb_typeof(v_run->'portfolioSnapshotFingerprint') <> 'null'
    then
      return false;
    end if;

    v_run_coverage := v_run->'coverage';
    if not public._staxis_jsonb_exact_keys(v_run_coverage, array[
         'selectedPropertyCount', 'snapshotPropertyCount',
         'includedPropertyCount', 'excludedPropertyCount',
         'missingFromRunCount', 'exclusionReasons',
         'exclusionReasonCodeCount', 'exclusionReasonsTruncated'
       ])
       or not public._staxis_jsonb_bounded_integer(
         v_run_coverage->'selectedPropertyCount', 0, 250
       )
       or not public._staxis_jsonb_bounded_integer(
         v_run_coverage->'snapshotPropertyCount', 0, 250
       )
       or not public._staxis_jsonb_bounded_integer(
         v_run_coverage->'includedPropertyCount', 0, 250
       )
       or not public._staxis_jsonb_bounded_integer(
         v_run_coverage->'excludedPropertyCount', 0, 250
       )
       or not public._staxis_jsonb_bounded_integer(
         v_run_coverage->'missingFromRunCount', 0, 250
       )
       or not public._staxis_jsonb_bounded_integer(
         v_run_coverage->'exclusionReasonCodeCount', 0, 9007199254740991
       )
       or jsonb_typeof(v_run_coverage->'exclusionReasons') <> 'array'
       or jsonb_array_length(v_run_coverage->'exclusionReasons') > 50
       or jsonb_typeof(v_run_coverage->'exclusionReasonsTruncated') <> 'boolean'
       or jsonb_array_length(v_run_coverage->'exclusionReasons')::numeric
            <> least(
              (v_run_coverage->>'exclusionReasonCodeCount')::numeric,
              50::numeric
            )
       or jsonb_array_length(v_run_coverage->'exclusionReasons') is distinct from (
         select count(distinct reason->>'code')
           from jsonb_array_elements(v_run_coverage->'exclusionReasons') reason
       )
       or (v_run_coverage->>'selectedPropertyCount')::integer <> p_selected_count
       or (v_run_coverage->>'snapshotPropertyCount')::integer
            <> (v_run_coverage->>'includedPropertyCount')::integer
              + (v_run_coverage->>'excludedPropertyCount')::integer
       or (v_run_coverage->>'selectedPropertyCount')::integer
            <> (v_run_coverage->>'snapshotPropertyCount')::integer
              + (v_run_coverage->>'missingFromRunCount')::integer
       or (v_run_coverage->>'exclusionReasonsTruncated')::boolean is distinct from (
         (v_run_coverage->>'exclusionReasonCodeCount')::numeric > 50
       )
    then
      return false;
    end if;
    for v_row in
      select value from jsonb_array_elements(v_run_coverage->'exclusionReasons') value
    loop
      if not public._staxis_jsonb_exact_keys(v_row, array['code', 'count'])
         or jsonb_typeof(v_row->'code') <> 'string'
         or length(v_row->>'code') not between 1 and 160
         or btrim(v_row->>'code') <> v_row->>'code'
         or not public._staxis_jsonb_bounded_integer(
           v_row->'count', 1, 250
         )
      then return false; end if;
      v_run_exclusion_total := v_run_exclusion_total + (v_row->>'count')::numeric;
    end loop;

    if (v_run->>'validThrough')::timestamptz
         - (v_run->>'evaluationAt')::timestamptz
         <> interval '192 hours'
       or (
         p_status = 'loaded'
         and (
           (v_run_coverage->>'missingFromRunCount')::integer <> 0
           or (v_run->>'validThrough')::timestamptz
                <= (p_value->>'loadedAt')::timestamptz
           or (v_coverage->>'findingCount')::numeric + v_rejected_total <= 0
         )
       )
       or (
         p_status = 'stale'
         and (v_run->>'validThrough')::timestamptz
               > (p_value->>'loadedAt')::timestamptz
       )
       or (
         p_status in ('abstained', 'no_applicable_findings', 'incomplete_scope')
         and (v_run->>'validThrough')::timestamptz
               <= (p_value->>'loadedAt')::timestamptz
       )
       or (
         p_status = 'incomplete_scope'
         and (v_run_coverage->>'missingFromRunCount')::integer = 0
       )
       or (
         p_status = 'no_applicable_findings'
         and (v_run_coverage->>'missingFromRunCount')::integer <> 0
       )
    then
      return false;
    end if;
  end if;

  v_expected_exclusion_total := case when p_status = 'loaded' then 0 else 1 end
    + case
        when v_run_coverage is null then 0
        else (v_run_coverage->>'missingFromRunCount')::numeric
      end
    + v_run_exclusion_total
    + case
        when v_run_coverage is not null
         and (v_run_coverage->>'exclusionReasonsTruncated')::boolean
        then (v_run_coverage->>'exclusionReasonCodeCount')::numeric
          - jsonb_array_length(v_run_coverage->'exclusionReasons')::numeric
        else 0
      end
    + v_rejected_total
    + (p_value->>'omittedByLimitCount')::numeric;
  if v_exclusion_total
       + (p_value->>'exclusionSummaryOmittedCount')::numeric
       <> v_expected_exclusion_total
  then
    return false;
  end if;

  if p_status <> 'loaded'
     and (
       (p_value->>'sourceAvailableCandidateCount')::numeric <> 0
       or (p_value->>'omittedByLimitCount')::numeric <> 0
       or (v_coverage->>'sourceCandidateCount')::numeric <> 0
       or (v_coverage->>'findingCount')::numeric <> 0
       or v_rejected_total <> 0
     )
  then
    return false;
  end if;
  return true;
exception when others then
  return false;
end
$$;

-- Closed, compact Finding Patterns receipt wall. This deliberately accepts no
-- raw property-id set, candidate identity, statement, envelope, or prompt text:
-- only the signed bounded provenance DTO produced by pattern-contract.ts.
create or replace function public._staxis_portfolio_finding_receipt_ok(
  p_value jsonb,
  p_account_id uuid,
  p_organization_id uuid,
  p_scope_receipt_id uuid,
  p_authorization_hash text,
  p_scope_hash text,
  p_authorized_count integer,
  p_selected_count integer
)
returns boolean
language plpgsql
immutable
strict
set search_path = pg_catalog, public
as $$
declare
  v_status text;
  v_producer jsonb;
  v_source jsonb;
  v_counts jsonb;
  v_coverage jsonb;
  v_truncation jsonb;
  v_outage jsonb;
  v_prompt jsonb;
  v_accepted text[];
  v_projected text[];
  v_displayed text[];
  v_item_omitted text[];
  v_character_omitted text[];
  v_model_omitted text[];
  v_omitted text[];
  v_partition text[];
  v_projection_payload jsonb;
  v_loader_summary numeric;
  v_producer_rejected numeric;
  v_rejection_summary numeric;
  v_projection_exclusion_summary numeric;
  v_exclusion_summary numeric;
begin
  if p_authorized_count not between 1 and 5000
     or p_selected_count not between 1 and 250
     or p_selected_count > p_authorized_count
     or jsonb_typeof(p_value) is distinct from 'object'
     or octet_length(public._staxis_jsonb_canonical_text(p_value)) > 65536
     or jsonb_typeof(p_value->'receiptHash') is distinct from 'string'
     or coalesce(p_value->>'receiptHash', '') !~ '^[0-9a-f]{64}$'
     or p_value->>'receiptHash' is distinct from encode(
       extensions.digest(
         convert_to(public._staxis_jsonb_canonical_text(p_value - 'receiptHash'), 'UTF8'),
         'sha256'
       ),
       'hex'
     )
     or jsonb_typeof(p_value->'organizationId') is distinct from 'string'
     or jsonb_typeof(p_value->'scopeReceiptId') is distinct from 'string'
     or jsonb_typeof(p_value->'scopeHash') is distinct from 'string'
     or p_value->>'organizationId' is distinct from p_organization_id::text
     or p_value->>'scopeReceiptId' is distinct from p_scope_receipt_id::text
     or p_value->>'scopeHash' is distinct from p_scope_hash
     or p_value->>'scopeHash' !~ '^[0-9a-f]{64}$'
     or p_value->>'receiptVersion' is distinct from
          'portfolio-finding-projection-receipt.v1'
     or p_value->>'contractVersion' is distinct from 'portfolio-finding.v1'
     or p_value->>'projectionVersion' is distinct from
          'portfolio-finding-projection.v1'
     or p_value->>'presentationVersion' is distinct from
          'portfolio-finding-presentation.v1'
     or p_value->>'promptVersion' is distinct from 'portfolio-finding-prompt.v1'
  then
    return false;
  end if;

  v_status := p_value->>'status';
  if v_status = 'not_mounted' then
    return public._staxis_jsonb_exact_keys(p_value, array[
      'receiptVersion', 'status', 'contractVersion', 'projectionVersion',
      'presentationVersion', 'promptVersion', 'organizationId',
      'scopeReceiptId', 'scopeHash', 'receiptHash'
    ]);
  end if;

  if v_status not in (
       'loaded', 'shadow_only', 'stale', 'abstained', 'no_finalized_run',
       'no_applicable_findings', 'incomplete_scope', 'scope_too_large',
       'scope_changed', 'unavailable'
     )
     or not public._staxis_jsonb_exact_keys(p_value, array[
       'receiptVersion', 'status', 'contractVersion', 'projectionVersion',
       'presentationVersion', 'promptVersion', 'accountId', 'organizationId',
       'scopeReceiptId', 'authorizationHash', 'scopeHash', 'consumedAt',
       'projectionHash',
       'producer', 'source', 'acceptedClaimIds', 'projectedClaimIds',
       'displayedClaimIds', 'itemOmittedClaimIds',
       'characterOmittedClaimIds', 'modelOmittedClaimIds', 'omittedClaimIds',
       'counts', 'coverage', 'truncation', 'outage', 'rejectionSummary',
       'rejectionSummaryOmittedCount', 'projectionExclusionSummary',
       'projectionExclusionSummaryOmittedCount', 'exclusionSummary',
       'exclusionSummaryOmittedCount', 'prompt', 'receiptHash'
     ])
     or jsonb_typeof(p_value->'accountId') is distinct from 'string'
     or jsonb_typeof(p_value->'authorizationHash') is distinct from 'string'
     or p_value->>'accountId' is distinct from p_account_id::text
     or p_value->>'authorizationHash' is distinct from p_authorization_hash
     or coalesce(p_value->>'authorizationHash', '') !~ '^[0-9a-f]{64}$'
     or not public._staxis_portfolio_finding_instant_ok(p_value->'consumedAt')
     or jsonb_typeof(p_value->'projectionHash') is distinct from 'string'
     or coalesce(p_value->>'projectionHash', '') !~ '^[0-9a-f]{64}$'
  then
    return false;
  end if;

  v_producer := p_value->'producer';
  if not public._staxis_portfolio_finding_producer_ok(
       v_producer,
       v_status,
       p_account_id,
       p_organization_id,
       p_scope_receipt_id,
       p_authorization_hash,
       p_scope_hash,
       p_authorized_count,
       p_selected_count
     )
  then
    return false;
  end if;

  v_source := p_value->'source';
  if not public._staxis_jsonb_exact_keys(v_source, array[
       'availableCandidateCount', 'loadedFindingCount',
       'producerRejectedCandidateCount', 'limitOmittedCount',
       'loaderOmittedCount', 'loaderOmissionSummary',
       'loaderOmissionSummaryOmittedCount'
     ])
     or not public._staxis_jsonb_bounded_integer(
       v_source->'availableCandidateCount', 0, 9007199254740991
     )
     or not public._staxis_jsonb_bounded_integer(
       v_source->'loadedFindingCount', 0, 100
     )
     or not public._staxis_jsonb_bounded_integer(
       v_source->'producerRejectedCandidateCount', 0, 100
     )
     or not public._staxis_jsonb_bounded_integer(
       v_source->'limitOmittedCount', 0, 9007199254740991
     )
     or not public._staxis_jsonb_bounded_integer(
       v_source->'loaderOmittedCount', 0, 9007199254740991
     )
     or not public._staxis_jsonb_bounded_integer(
       v_source->'loaderOmissionSummaryOmittedCount', 0, 9007199254740991
     )
  then
    return false;
  end if;
  v_loader_summary := public._staxis_portfolio_finding_summary_total(
    v_source->'loaderOmissionSummary'
  );
  v_producer_rejected := public._staxis_portfolio_finding_summary_total(
    v_producer->'rejectedCandidateSummary'
  );
  if v_loader_summary < 0 or v_producer_rejected < 0 then return false; end if;
  v_producer_rejected := v_producer_rejected
    + (v_producer->>'rejectedCandidateSummaryOmittedCount')::numeric;
  if (v_source->>'availableCandidateCount')::numeric
       <> (v_source->>'loadedFindingCount')::numeric
         + (v_source->>'producerRejectedCandidateCount')::numeric
         + (v_source->>'limitOmittedCount')::numeric
     or (v_source->>'availableCandidateCount')::numeric
          <> (v_producer->>'sourceAvailableCandidateCount')::numeric
     or (v_source->>'loadedFindingCount')::numeric
          <> (v_producer->'coverage'->>'findingCount')::numeric
     or (v_source->>'producerRejectedCandidateCount')::numeric
          <> v_producer_rejected
     or (v_source->>'limitOmittedCount')::numeric
          <> (v_producer->>'omittedByLimitCount')::numeric
     or (v_source->>'loaderOmittedCount')::numeric
          <> (v_source->>'producerRejectedCandidateCount')::numeric
            + (v_source->>'limitOmittedCount')::numeric
     or v_loader_summary
          + (v_source->>'loaderOmissionSummaryOmittedCount')::numeric
          <> (v_source->>'loaderOmittedCount')::numeric
  then
    return false;
  end if;

  if not public._staxis_portfolio_finding_claim_array_ok(
       p_value->'acceptedClaimIds', 100
     )
     or not public._staxis_portfolio_finding_claim_array_ok(
       p_value->'projectedClaimIds', 40
     )
     or not public._staxis_portfolio_finding_claim_array_ok(
       p_value->'displayedClaimIds', 40
     )
     or not public._staxis_portfolio_finding_claim_array_ok(
       p_value->'itemOmittedClaimIds', 100
     )
     or not public._staxis_portfolio_finding_claim_array_ok(
       p_value->'characterOmittedClaimIds', 100
     )
     or not public._staxis_portfolio_finding_claim_array_ok(
       p_value->'modelOmittedClaimIds', 40
     )
     or not public._staxis_portfolio_finding_claim_array_ok(
       p_value->'omittedClaimIds', 100
     )
  then
    return false;
  end if;
  select coalesce(array_agg(value order by position), array[]::text[])
    into v_accepted
    from jsonb_array_elements_text(p_value->'acceptedClaimIds')
           with ordinality claim(value, position);
  select coalesce(array_agg(value order by position), array[]::text[])
    into v_projected
    from jsonb_array_elements_text(p_value->'projectedClaimIds')
           with ordinality claim(value, position);
  select coalesce(array_agg(value order by position), array[]::text[])
    into v_displayed
    from jsonb_array_elements_text(p_value->'displayedClaimIds')
           with ordinality claim(value, position);
  select coalesce(array_agg(value order by position), array[]::text[])
    into v_item_omitted
    from jsonb_array_elements_text(p_value->'itemOmittedClaimIds')
           with ordinality claim(value, position);
  select coalesce(array_agg(value order by position), array[]::text[])
    into v_character_omitted
    from jsonb_array_elements_text(p_value->'characterOmittedClaimIds')
           with ordinality claim(value, position);
  select coalesce(array_agg(value order by position), array[]::text[])
    into v_model_omitted
    from jsonb_array_elements_text(p_value->'modelOmittedClaimIds')
           with ordinality claim(value, position);
  select coalesce(array_agg(value order by position), array[]::text[])
    into v_omitted
    from jsonb_array_elements_text(p_value->'omittedClaimIds')
           with ordinality claim(value, position);

  select coalesce(array_agg(value order by value), array[]::text[])
    into v_partition
    from (
      select unnest(v_displayed) value
      union all
      select unnest(v_model_omitted) value
    ) partitioned;
  if not (v_projected <@ v_accepted)
     or not (v_displayed <@ v_projected)
     or v_partition is distinct from (
       select coalesce(array_agg(value order by value), array[]::text[])
         from unnest(v_projected) value
     )
  then
    return false;
  end if;
  select coalesce(array_agg(value order by value), array[]::text[])
    into v_partition
    from (
      select unnest(v_item_omitted) value
      union all
      select unnest(v_character_omitted) value
      union all
      select unnest(v_model_omitted) value
    ) partitioned;
  if v_partition is distinct from v_omitted then return false; end if;
  select coalesce(array_agg(value order by value), array[]::text[])
    into v_partition
    from (
      select unnest(v_displayed) value
      union all
      select unnest(v_omitted) value
    ) partitioned;
  if v_partition is distinct from v_accepted then return false; end if;

  v_counts := p_value->'counts';
  if not public._staxis_jsonb_exact_keys(v_counts, array[
       'input', 'accepted', 'projected', 'displayed', 'modelOmitted',
       'omitted', 'rejected', 'smallCohortSuppressed'
     ])
     or not public._staxis_jsonb_bounded_integer(v_counts->'input', 0, 100)
     or not public._staxis_jsonb_bounded_integer(v_counts->'accepted', 0, 100)
     or not public._staxis_jsonb_bounded_integer(v_counts->'projected', 0, 40)
     or not public._staxis_jsonb_bounded_integer(v_counts->'displayed', 0, 40)
     or not public._staxis_jsonb_bounded_integer(v_counts->'modelOmitted', 0, 40)
     or not public._staxis_jsonb_bounded_integer(v_counts->'omitted', 0, 100)
     or not public._staxis_jsonb_bounded_integer(v_counts->'rejected', 0, 100)
     or not public._staxis_jsonb_bounded_integer(
       v_counts->'smallCohortSuppressed', 0, 100
     )
     or (v_counts->>'input')::integer is distinct from
          (v_counts->>'accepted')::integer + (v_counts->>'rejected')::integer
     or (v_counts->>'accepted')::integer is distinct from cardinality(v_accepted)
     or (v_counts->>'projected')::integer is distinct from cardinality(v_projected)
     or (v_counts->>'displayed')::integer is distinct from cardinality(v_displayed)
     or (v_counts->>'modelOmitted')::integer is distinct from
          cardinality(v_model_omitted)
     or (v_counts->>'omitted')::integer is distinct from cardinality(v_omitted)
     or (v_producer->'coverage'->>'findingCount')::integer
          <> (v_counts->>'input')::integer
     or (
       v_status <> 'loaded'
       and (
         cardinality(v_accepted) <> 0
         or cardinality(v_projected) <> 0
         or cardinality(v_displayed) <> 0
       )
     )
  then
    return false;
  end if;

  v_coverage := p_value->'coverage';
  if not public._staxis_jsonb_exact_keys(v_coverage, array[
       'authorizedPropertyCount', 'selectedPropertyCount',
       'acceptedEvaluatedPropertyCount', 'acceptedAffectedPropertyCount'
     ])
     or not public._staxis_jsonb_bounded_integer(
       v_coverage->'authorizedPropertyCount', 1, 5000
     )
     or not public._staxis_jsonb_bounded_integer(
       v_coverage->'selectedPropertyCount', 1, 250
     )
     or not public._staxis_jsonb_bounded_integer(
       v_coverage->'acceptedEvaluatedPropertyCount', 0, 250
     )
     or not public._staxis_jsonb_bounded_integer(
       v_coverage->'acceptedAffectedPropertyCount', 0, 250
     )
     or (v_coverage->>'authorizedPropertyCount')::integer <> p_authorized_count
     or (v_coverage->>'selectedPropertyCount')::integer <> p_selected_count
     or (v_coverage->>'acceptedAffectedPropertyCount')::integer
          > (v_coverage->>'acceptedEvaluatedPropertyCount')::integer
     or (v_coverage->>'acceptedEvaluatedPropertyCount')::integer
          > (v_coverage->>'selectedPropertyCount')::integer
     or (v_producer->'coverage'->>'evaluatedPropertyCount')::integer
          < (v_coverage->>'acceptedEvaluatedPropertyCount')::integer
     or (v_producer->'coverage'->>'affectedPropertyCount')::integer
          < (v_coverage->>'acceptedAffectedPropertyCount')::integer
     or (
       (v_counts->>'rejected')::integer = 0
       and (
         (v_producer->'coverage'->>'evaluatedPropertyCount')::integer
           <> (v_coverage->>'acceptedEvaluatedPropertyCount')::integer
         or (v_producer->'coverage'->>'affectedPropertyCount')::integer
           <> (v_coverage->>'acceptedAffectedPropertyCount')::integer
       )
     )
  then
    return false;
  end if;

  v_truncation := p_value->'truncation';
  if not public._staxis_jsonb_exact_keys(v_truncation, array[
       'occurred', 'itemLimitOmittedCount', 'characterLimitOmittedCount'
     ])
     or jsonb_typeof(v_truncation->'occurred') is distinct from 'boolean'
     or not public._staxis_jsonb_bounded_integer(
       v_truncation->'itemLimitOmittedCount', 0, 100
     )
     or not public._staxis_jsonb_bounded_integer(
       v_truncation->'characterLimitOmittedCount', 0, 100
     )
     or (v_truncation->>'itemLimitOmittedCount')::integer
          <> cardinality(v_item_omitted)
     or (v_truncation->>'characterLimitOmittedCount')::integer
          <> cardinality(v_character_omitted)
     or (v_truncation->>'occurred')::boolean is distinct from (
       (v_truncation->>'itemLimitOmittedCount')::integer
         + (v_truncation->>'characterLimitOmittedCount')::integer > 0
     )
  then
    return false;
  end if;

  v_outage := p_value->'outage';
  if not public._staxis_jsonb_exact_keys(v_outage, array['status', 'code'])
     or coalesce(v_outage->>'status', '') not in ('none', 'partial', 'unavailable')
     or not public._staxis_jsonb_identifier_or_null(v_outage->'code')
     or ((v_outage->>'status' = 'none') is distinct from
         (jsonb_typeof(v_outage->'code') = 'null'))
     or ((v_status = 'unavailable') is distinct from
         (v_outage->>'status' = 'unavailable'))
     or (
       (v_producer->'outage'->>'occurred')::boolean
       and (
         v_outage->>'status' is distinct from case
           when v_status = 'unavailable' then 'unavailable' else 'partial'
         end
         or v_outage->>'code' is distinct from v_producer->'outage'->>'stage'
       )
     )
     or (
       not (v_producer->'outage'->>'occurred')::boolean
       and (
         v_outage->>'status' <> 'none'
         or jsonb_typeof(v_outage->'code') <> 'null'
       )
     )
  then
    return false;
  end if;

  v_prompt := p_value->'prompt';
  if not public._staxis_jsonb_exact_keys(v_prompt, array[
       'version', 'itemCount', 'byteCount'
     ])
     or v_prompt->>'version' <> 'portfolio-finding-prompt.v1'
     or not public._staxis_jsonb_bounded_integer(v_prompt->'itemCount', 0, 40)
     or not public._staxis_jsonb_bounded_integer(v_prompt->'byteCount', 0, 12000)
     or (v_prompt->>'itemCount')::integer <> cardinality(v_projected)
  then
    return false;
  end if;

  if not public._staxis_jsonb_bounded_integer(
       p_value->'rejectionSummaryOmittedCount', 0, 100
     )
     or not public._staxis_jsonb_bounded_integer(
       p_value->'projectionExclusionSummaryOmittedCount', 0, 100
     )
     or not public._staxis_jsonb_bounded_integer(
       p_value->'exclusionSummaryOmittedCount', 0, 100
     )
  then
    return false;
  end if;
  v_rejection_summary := public._staxis_portfolio_finding_summary_total(
    p_value->'rejectionSummary'
  );
  v_projection_exclusion_summary := public._staxis_portfolio_finding_summary_total(
    p_value->'projectionExclusionSummary'
  );
  v_exclusion_summary := public._staxis_portfolio_finding_summary_total(
    p_value->'exclusionSummary'
  );
  if v_rejection_summary < 0
     or v_projection_exclusion_summary < 0
     or v_exclusion_summary < 0
     or v_rejection_summary
          + (p_value->>'rejectionSummaryOmittedCount')::numeric
          <> (v_counts->>'rejected')::numeric
     or v_projection_exclusion_summary
          + (p_value->>'projectionExclusionSummaryOmittedCount')::numeric
          <> (v_truncation->>'itemLimitOmittedCount')::numeric
            + (v_truncation->>'characterLimitOmittedCount')::numeric
            + (v_counts->>'smallCohortSuppressed')::numeric
     or v_exclusion_summary
          + (p_value->>'exclusionSummaryOmittedCount')::numeric
          <> (v_truncation->>'itemLimitOmittedCount')::numeric
            + (v_truncation->>'characterLimitOmittedCount')::numeric
            + (v_counts->>'smallCohortSuppressed')::numeric
            + (v_counts->>'modelOmitted')::numeric
  then
    return false;
  end if;

  v_projection_payload := jsonb_build_object(
    'version', p_value->'projectionVersion',
    'status', p_value->'status',
    'accountId', p_value->'accountId',
    'organizationId', p_value->'organizationId',
    'scopeReceiptId', p_value->'scopeReceiptId',
    'authorizationHash', p_value->'authorizationHash',
    'scopeHash', p_value->'scopeHash',
    'consumedAt', p_value->'consumedAt',
    'producer', p_value->'producer',
    'source', p_value->'source',
    'acceptedClaimIds', p_value->'acceptedClaimIds',
    'projectedClaimIds', p_value->'projectedClaimIds',
    'itemOmittedClaimIds', p_value->'itemOmittedClaimIds',
    'characterOmittedClaimIds', p_value->'characterOmittedClaimIds',
    'counts', jsonb_build_object(
      'input', v_counts->'input',
      'accepted', v_counts->'accepted',
      'projected', v_counts->'projected',
      'rejected', v_counts->'rejected',
      'smallCohortSuppressed', v_counts->'smallCohortSuppressed'
    ),
    'coverage', p_value->'coverage',
    'truncation', p_value->'truncation',
    'outage', p_value->'outage',
    'rejectionSummary', p_value->'rejectionSummary',
    'rejectionSummaryOmittedCount', p_value->'rejectionSummaryOmittedCount',
    'exclusionSummary', p_value->'projectionExclusionSummary',
    'exclusionSummaryOmittedCount',
      p_value->'projectionExclusionSummaryOmittedCount',
    'prompt', p_value->'prompt'
  );
  if p_value->>'projectionHash' is distinct from encode(
       extensions.digest(
         convert_to(public._staxis_jsonb_canonical_text(v_projection_payload), 'UTF8'),
         'sha256'
       ),
       'hex'
     )
  then
    return false;
  end if;
  return true;
exception when others then
  return false;
end
$$;

-- Model receipts may report only claims actually selected by the immutable
-- presentation plan. This closes a gap where a correctly signed receipt could
-- otherwise be paired with a different persisted model plan.
create or replace function public._staxis_portfolio_finding_plan_matches(
  p_finding jsonb,
  p_presentation_plan jsonb
)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  v_projected text[] := array[]::text[];
  v_displayed text[] := array[]::text[];
  v_expected text[] := array[]::text[];
begin
  if p_finding->>'status' <> 'not_mounted' then
    if not public._staxis_portfolio_finding_claim_array_ok(
         p_finding->'projectedClaimIds', 40
       )
       or not public._staxis_portfolio_finding_claim_array_ok(
         p_finding->'displayedClaimIds', 40
       )
    then return false; end if;
    select coalesce(array_agg(value order by value), array[]::text[])
      into v_projected
      from jsonb_array_elements_text(p_finding->'projectedClaimIds') value;
    select coalesce(array_agg(value order by value), array[]::text[])
      into v_displayed
      from jsonb_array_elements_text(p_finding->'displayedClaimIds') value;
  end if;
  if p_presentation_plan is null then return cardinality(v_displayed) = 0; end if;
  if not public._staxis_jsonb_exact_keys(p_presentation_plan, array[
       'version', 'lead', 'orderedClaimIds'
     ])
     or p_presentation_plan->>'version' <> 'portfolio-presentation-plan.v1'
     or coalesce(p_presentation_plan->>'lead', '') not in (
       'scope_first', 'exceptions_first', 'coverage_first'
     )
     or jsonb_typeof(p_presentation_plan->'orderedClaimIds') <> 'array'
     or jsonb_array_length(p_presentation_plan->'orderedClaimIds') > 64
     or exists (
       select 1 from jsonb_array_elements(p_presentation_plan->'orderedClaimIds') item
        where jsonb_typeof(item) <> 'string'
           or coalesce(item #>> '{}', '') !~ '^pc_[0-9a-f]{24}$'
     )
     or jsonb_array_length(p_presentation_plan->'orderedClaimIds') is distinct from (
       select count(distinct item #>> '{}')
         from jsonb_array_elements(p_presentation_plan->'orderedClaimIds') item
     )
  then
    return false;
  end if;
  select coalesce(array_agg(item order by item), array[]::text[])
    into v_expected
    from jsonb_array_elements_text(p_presentation_plan->'orderedClaimIds') item
   where item = any(v_projected);
  return v_displayed is not distinct from v_expected;
exception when others then
  return false;
end
$$;

create or replace function public._staxis_portfolio_knowledge_claim_scope_ok(
  p_claim jsonb,
  p_organization_id uuid,
  p_expected_property_id uuid
)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  v_provenance jsonb;
begin
  if not public._staxis_jsonb_exact_keys(p_claim, array[
    'knowledgeKey', 'topic', 'content', 'category', 'policyKey',
    'policyValue', 'provenance'
  ]) then return false; end if;
  if jsonb_typeof(p_claim->'knowledgeKey') is distinct from 'string'
     or jsonb_typeof(p_claim->'topic') is distinct from 'string'
     or jsonb_typeof(p_claim->'content') is distinct from 'string'
     or jsonb_typeof(p_claim->'category') is distinct from 'string'
     or coalesce(jsonb_typeof(p_claim->'policyKey'), 'missing') not in ('null', 'string')
     or coalesce(jsonb_typeof(p_claim->'policyValue'), 'missing') not in ('null', 'string')
  then return false; end if;

  v_provenance := p_claim->'provenance';
  if not public._staxis_jsonb_exact_keys(v_provenance, array[
    'trust', 'sourceKind', 'recordId', 'organizationId', 'propertyId',
    'source', 'reviewState', 'updatedAt', 'effectiveFrom', 'expiresAt',
    'createdByName', 'createdByRole'
  ]) then return false; end if;
  if v_provenance->>'trust' is distinct from 'untrusted_reference_data'
     or coalesce(v_provenance->>'sourceKind', '') not in ('company_knowledge', 'property_memory')
     or coalesce(v_provenance->>'recordId', '') !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or v_provenance->>'organizationId' is distinct from p_organization_id::text
     or v_provenance->>'propertyId' is distinct from p_expected_property_id::text
     or jsonb_typeof(v_provenance->'source') is distinct from 'string'
     or v_provenance->>'reviewState' is distinct from 'confirmed'
     or jsonb_typeof(v_provenance->'updatedAt') is distinct from 'string'
     or coalesce(jsonb_typeof(v_provenance->'effectiveFrom'), 'missing') not in ('null', 'string')
     or coalesce(jsonb_typeof(v_provenance->'expiresAt'), 'missing') not in ('null', 'string')
     or coalesce(jsonb_typeof(v_provenance->'createdByName'), 'missing') not in ('null', 'string')
     or coalesce(jsonb_typeof(v_provenance->'createdByRole'), 'missing') not in ('null', 'string')
  then return false; end if;
  if p_expected_property_id is null
     and v_provenance->>'sourceKind' is distinct from 'company_knowledge'
  then return false; end if;
  if p_expected_property_id is not null
     and v_provenance->>'sourceKind' is distinct from 'property_memory'
  then return false; end if;
  return true;
end
$$;

revoke all on function public._staxis_jsonb_exact_keys(jsonb, text[])
  from public, anon, authenticated;
revoke all on function public._staxis_jsonb_canonical_text(jsonb)
  from public, anon, authenticated;
revoke all on function public._staxis_jsonb_bounded_integer(jsonb, numeric, numeric)
  from public, anon, authenticated;
revoke all on function public._staxis_jsonb_identifier_or_null(jsonb, boolean)
  from public, anon, authenticated;
revoke all on function public._staxis_portfolio_finding_claim_array_ok(jsonb, integer)
  from public, anon, authenticated;
revoke all on function public._staxis_portfolio_finding_summary_total(jsonb, integer, numeric)
  from public, anon, authenticated;
revoke all on function public._staxis_portfolio_finding_instant_ok(jsonb)
  from public, anon, authenticated;
revoke all on function public._staxis_portfolio_finding_producer_ok(
  jsonb, text, uuid, uuid, uuid, text, text, integer, integer
) from public, anon, authenticated;
revoke all on function public._staxis_portfolio_finding_receipt_ok(
  jsonb, uuid, uuid, uuid, text, text, integer, integer
) from public, anon, authenticated;
revoke all on function public._staxis_portfolio_finding_plan_matches(jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function public._staxis_portfolio_knowledge_claim_scope_ok(jsonb, uuid, uuid)
  from public, anon, authenticated;

create or replace function public.staxis_validate_portfolio_knowledge_artifact()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_authorized uuid[];
  v_selected uuid[];
  v_overlay_selected uuid[];
  v_evidence_authorized uuid[];
  v_evidence_selected uuid[];
  v_evidence_fact_ids uuid[];
  v_catalog_selected uuid[];
  v_plan_requested uuid[];
  v_claim_ids text[];
  v_claim jsonb;
  v_resolution jsonb;
  v_source jsonb;
  v_receipt public.authorization_scope_receipts%rowtype;
begin
  if not coalesce(public._staxis_portfolio_finding_receipt_ok(
       new.finding_versions,
       new.account_id,
       new.organization_id,
       new.scope_receipt_id,
       new.authorization_hash,
       new.scope_hash,
       cardinality(new.authorized_property_ids),
       cardinality(new.selected_property_ids)
     ), false)
  then
    raise exception 'portfolio knowledge artifact has an invalid or cross-scope finding receipt';
  end if;

  if btrim(new.normalized_question) <> new.normalized_question
     or new.question_hash <> encode(
       extensions.digest(convert_to(new.normalized_question, 'UTF8'), 'sha256'), 'hex'
     )
     or new.rendered_answer_hash <> encode(
       extensions.digest(convert_to(new.rendered_answer_text, 'UTF8'), 'sha256'), 'hex'
     )
  then
    raise exception 'portfolio knowledge artifact text/hash mismatch';
  end if;

  select coalesce(array_agg(value order by value), array[]::uuid[])
    into v_authorized from unnest(new.authorized_property_ids) value;
  select coalesce(array_agg(value order by value), array[]::uuid[])
    into v_selected from unnest(new.selected_property_ids) value;
  if cardinality(v_authorized) <> (
       select count(distinct value) from unnest(new.authorized_property_ids) value
     )
     or cardinality(v_selected) <> (
       select count(distinct value) from unnest(new.selected_property_ids) value
     )
  then
    raise exception 'portfolio knowledge artifact scope contains duplicate properties';
  end if;
  if new.authorized_property_ids is distinct from v_authorized
     or new.selected_property_ids is distinct from v_selected
  then
    raise exception 'portfolio knowledge artifact property arrays are not canonical';
  end if;

  select receipt.* into v_receipt
    from public.authorization_scope_receipts receipt
   where receipt.id = new.scope_receipt_id;
  if not found
     or v_receipt.expires_at <= clock_timestamp()
     or v_receipt.account_id is distinct from new.account_id
     or v_receipt.organization_id is distinct from new.organization_id
     or v_receipt.authorization_hash is distinct from new.authorization_hash
     or v_receipt.scope_hash is distinct from new.scope_hash
     or v_receipt.authorized_property_ids is distinct from new.authorized_property_ids
     or v_receipt.selected_property_ids is distinct from new.selected_property_ids
  then
    raise exception 'portfolio knowledge artifact does not match a live authorization receipt';
  end if;

  if not public._staxis_jsonb_exact_keys(new.plan, array[
       'version', 'intent', 'selector', 'metricIds', 'knowledgeQuery',
       'window', 'groupBy', 'comparison', 'detailLimit', 'defaultedScope'
     ])
     or not public._staxis_jsonb_exact_keys(
       new.plan->'knowledgeQuery', array['categories', 'terms']
     )
     or coalesce(jsonb_typeof(new.plan->'knowledgeQuery'->'categories'), 'missing') <> 'array'
     or coalesce(jsonb_typeof(new.plan->'knowledgeQuery'->'terms'), 'missing') <> 'array'
     or not coalesce((
       (
         new.plan->'selector'->>'kind' = 'all_authorized'
         and public._staxis_jsonb_exact_keys(new.plan->'selector', array['kind'])
       )
       or (
         new.plan->'selector'->>'kind' = 'portfolio'
         and public._staxis_jsonb_exact_keys(
           new.plan->'selector', array['kind', 'portfolioId']
         )
       )
       or (
         new.plan->'selector'->>'kind' = 'explicit_subset'
         and public._staxis_jsonb_exact_keys(
           new.plan->'selector', array['kind', 'propertyIds']
         )
       )
       or (
         new.plan->'selector'->>'kind' = 'hotel'
         and public._staxis_jsonb_exact_keys(
           new.plan->'selector', array['kind', 'propertyId']
         )
       )
     ), false)
     or not coalesce((
       (
         new.plan->'window'->>'kind' = 'hotel_business_today'
         and public._staxis_jsonb_exact_keys(new.plan->'window', array['kind'])
       )
       or (
         new.plan->'window'->>'kind' = 'trailing_complete_days'
         and public._staxis_jsonb_exact_keys(
           new.plan->'window', array['kind', 'days']
         )
       )
     ), false)
     or new.plan->>'version' is distinct from new.query_plan_version
     or new.plan->>'intent' is distinct from 'knowledge_lookup'
     or coalesce(jsonb_typeof(new.plan->'metricIds'), 'missing') <> 'array'
     or jsonb_array_length(new.plan->'metricIds') <> 0
     or coalesce(jsonb_typeof(new.plan->'knowledgeQuery'), 'missing') <> 'object'
  then
    raise exception 'portfolio knowledge artifact plan is not a metric-free knowledge lookup';
  end if;

  if new.plan->'selector'->>'kind' = 'all_authorized' then
    if v_receipt.selector_type <> 'all_authorized'
       or cardinality(v_receipt.requested_property_ids) <> 0
       or v_receipt.requested_portfolio_id is not null
    then
      raise exception 'portfolio knowledge artifact plan selector does not match scope receipt';
    end if;
  elsif new.plan->'selector'->>'kind' = 'portfolio' then
    if v_receipt.selector_type <> 'portfolio'
       or v_receipt.requested_portfolio_id is distinct from
            (new.plan->'selector'->>'portfolioId')::uuid
       or cardinality(v_receipt.requested_property_ids) <> 0
    then
      raise exception 'portfolio knowledge artifact plan selector does not match scope receipt';
    end if;
  elsif new.plan->'selector'->>'kind' = 'explicit_subset' then
    select coalesce(array_agg(value::uuid order by value::uuid), array[]::uuid[])
      into v_plan_requested
      from jsonb_array_elements_text(new.plan->'selector'->'propertyIds') value;
    if v_receipt.selector_type <> 'property_subset'
       or v_receipt.requested_property_ids is distinct from v_plan_requested
       or v_receipt.requested_portfolio_id is not null
    then
      raise exception 'portfolio knowledge artifact plan selector does not match scope receipt';
    end if;
  elsif new.plan->'selector'->>'kind' = 'hotel' then
    v_plan_requested := array[(new.plan->'selector'->>'propertyId')::uuid];
    if v_receipt.selector_type <> 'property_subset'
       or v_receipt.requested_property_ids is distinct from v_plan_requested
       or v_receipt.requested_portfolio_id is not null
    then
      raise exception 'portfolio knowledge artifact plan selector does not match scope receipt';
    end if;
  end if;

  if not public._staxis_jsonb_exact_keys(new.reproduction_input, array[
       'overlay', 'selectedHotels', 'selectorLabel', 'selection', 'totalMatched'
     ])
     or not public._staxis_jsonb_exact_keys(new.reproduction_input->'overlay', array[
       'version', 'organizationId', 'selectedPropertyIds', 'asOf',
       'companyDefaults', 'propertyResolutions', 'exclusions'
     ])
     or not public._staxis_jsonb_exact_keys(
       new.reproduction_input->'selection', array['version', 'orderedClaimIds']
     )
     or jsonb_typeof(new.reproduction_input->'selectorLabel') is distinct from 'string'
     or length(btrim(new.reproduction_input->>'selectorLabel')) not between 1 and 300
     or jsonb_typeof(new.reproduction_input->'totalMatched') is distinct from 'number'
     or (new.reproduction_input->>'totalMatched')::numeric < 0
     or (new.reproduction_input->>'totalMatched')::numeric > 2147483647
     or (new.reproduction_input->>'totalMatched')::numeric <>
          trunc((new.reproduction_input->>'totalMatched')::numeric)
     or (new.reproduction_input->>'totalMatched')::numeric < cardinality(new.selected_claim_ids)
     or new.reproduction_input->'overlay'->>'version' is distinct from new.overlay_version
     or new.reproduction_input->'overlay'->>'organizationId' is distinct from new.organization_id::text
     or new.reproduction_input->'selection'->>'version' is distinct from new.presentation_version
     or coalesce(jsonb_typeof(new.reproduction_input->'selection'->'orderedClaimIds'), 'missing') <> 'array'
     or coalesce(jsonb_typeof(new.reproduction_input->'selectedHotels'), 'missing') <> 'array'
     or coalesce(jsonb_typeof(new.reproduction_input->'overlay'->'companyDefaults'), 'missing') <> 'array'
     or coalesce(jsonb_typeof(new.reproduction_input->'overlay'->'propertyResolutions'), 'missing') <> 'array'
     or coalesce(jsonb_typeof(new.reproduction_input->'overlay'->'exclusions'), 'missing') <> 'array'
  then
    raise exception 'portfolio knowledge artifact reproduction envelope is inconsistent';
  end if;

  if not public._staxis_jsonb_exact_keys(new.knowledge_versions, array[
       'status', 'artifactVersion', 'overlayVersion', 'presentationVersion',
       'asOf', 'sources', 'exclusions'
     ])
     or new.knowledge_versions->>'status' is distinct from 'included'
     or new.knowledge_versions->>'artifactVersion' is distinct from new.artifact_version
     or new.knowledge_versions->>'overlayVersion' is distinct from new.overlay_version
     or new.knowledge_versions->>'presentationVersion' is distinct from new.presentation_version
     or coalesce(jsonb_typeof(new.knowledge_versions->'sources'), 'missing') <> 'array'
     or coalesce(jsonb_typeof(new.knowledge_versions->'exclusions'), 'missing') <> 'array'
  then
    raise exception 'portfolio knowledge artifact version envelope is inconsistent';
  end if;

  if not public._staxis_jsonb_exact_keys(new.evidence, array[
       'version', 'organizationId', 'organizationName', 'scopeReceiptId',
       'authorizationHash', 'scopeHash', 'authorizedPropertyIds',
       'selectedPropertyIds', 'generatedAt', 'coverage', 'facts', 'knowledge'
     ])
     or not public._staxis_jsonb_exact_keys(new.evidence->'coverage', array[
       'authorized', 'selected', 'reported', 'excluded', 'excludedHotels'
     ])
     or not public._staxis_jsonb_exact_keys(new.evidence->'knowledge', array[
       'versions', 'query', 'selection', 'totalMatched'
     ])
     or new.evidence->'knowledge'->'versions' is distinct from new.knowledge_versions
     or new.evidence->'knowledge'->'query' is distinct from new.plan->'knowledgeQuery'
     or new.evidence->'knowledge'->'selection' is distinct from new.reproduction_input->'selection'
     or new.evidence->'knowledge'->'totalMatched' is distinct from new.reproduction_input->'totalMatched'
     or jsonb_typeof(new.evidence->'coverage'->'authorized') is distinct from 'number'
     or jsonb_typeof(new.evidence->'coverage'->'selected') is distinct from 'number'
     or jsonb_typeof(new.evidence->'coverage'->'reported') is distinct from 'number'
     or jsonb_typeof(new.evidence->'coverage'->'excluded') is distinct from 'number'
     or new.evidence->'coverage'->>'authorized' is distinct from cardinality(new.authorized_property_ids)::text
     or new.evidence->'coverage'->>'selected' is distinct from cardinality(new.selected_property_ids)::text
     or new.evidence->'coverage'->>'reported' is distinct from cardinality(new.selected_property_ids)::text
     or new.evidence->'coverage'->>'excluded' is distinct from '0'
     or new.evidence->'coverage'->'excludedHotels' is distinct from '[]'::jsonb
     or (new.evidence->>'generatedAt')::timestamptz is distinct from new.generated_at
  then
    raise exception 'portfolio knowledge artifact evidence envelope is inconsistent';
  end if;

  select coalesce(array_agg(value::uuid order by value::uuid), array[]::uuid[])
    into v_overlay_selected
    from jsonb_array_elements_text(
      new.reproduction_input->'overlay'->'selectedPropertyIds'
    ) value;
  select coalesce(array_agg(value::uuid order by value::uuid), array[]::uuid[])
    into v_evidence_authorized
    from jsonb_array_elements_text(new.evidence->'authorizedPropertyIds') value;
  select coalesce(array_agg(value::uuid order by value::uuid), array[]::uuid[])
    into v_evidence_selected
    from jsonb_array_elements_text(new.evidence->'selectedPropertyIds') value;
  if v_overlay_selected is distinct from v_selected
     or v_evidence_authorized is distinct from v_authorized
     or v_evidence_selected is distinct from v_selected
     or new.evidence->>'organizationId' is distinct from new.organization_id::text
     or new.evidence->>'organizationName' is distinct from v_receipt.organization_name
     or new.evidence->>'scopeReceiptId' is distinct from new.scope_receipt_id::text
     or new.evidence->>'authorizationHash' is distinct from new.authorization_hash
     or new.evidence->>'scopeHash' is distinct from new.scope_hash
     or new.evidence->>'version' is distinct from 'portfolio-knowledge-evidence.v1'
  then
    raise exception 'portfolio knowledge artifact evidence scope mismatch';
  end if;

  -- A catalog/name row is raw tenant data even though the artifact is not
  -- browser-readable. Require one unique row for every selected hotel and no
  -- other property before accepting it into the service-only store.
  if exists (
    select 1
      from jsonb_array_elements(new.reproduction_input->'selectedHotels') hotel
     where not public._staxis_jsonb_exact_keys(
             hotel, array['propertyId', 'propertyName']
           )
        or coalesce(jsonb_typeof(hotel->'propertyId'), 'missing') <> 'string'
        or coalesce(jsonb_typeof(hotel->'propertyName'), 'missing') <> 'string'
        or length(btrim(hotel->>'propertyName')) not between 1 and 300
  ) then
    raise exception 'portfolio knowledge artifact contains malformed hotel metadata';
  end if;
  select coalesce(array_agg((hotel->>'propertyId')::uuid order by (hotel->>'propertyId')::uuid), array[]::uuid[])
    into v_catalog_selected
    from jsonb_array_elements(new.reproduction_input->'selectedHotels') hotel;
  if v_catalog_selected is distinct from v_selected
     or jsonb_array_length(new.reproduction_input->'selectedHotels') <> cardinality(v_selected)
     or exists (
       select 1
         from jsonb_array_elements(new.reproduction_input->'selectedHotels') hotel
         left join public.properties property
           on property.id = (hotel->>'propertyId')::uuid
        where property.id is null
           or btrim(property.name) <> btrim(hotel->>'propertyName')
     )
  then
    raise exception 'portfolio knowledge artifact hotel catalog exceeds selected scope';
  end if;

  if coalesce(jsonb_typeof(new.evidence->'facts'), 'missing') <> 'array' then
    raise exception 'portfolio knowledge artifact evidence hotel facts are malformed';
  end if;
  select coalesce(array_agg((fact->>'propertyId')::uuid order by (fact->>'propertyId')::uuid), array[]::uuid[])
    into v_evidence_fact_ids
    from jsonb_array_elements(new.evidence->'facts') fact;
  if v_evidence_fact_ids is distinct from v_selected
     or jsonb_array_length(new.evidence->'facts') <> cardinality(v_selected)
     or exists (
       select 1
        from jsonb_array_elements(new.evidence->'facts') fact
         left join public.properties property
           on property.id = (fact->>'propertyId')::uuid
        where not public._staxis_jsonb_exact_keys(
                fact, array['propertyId', 'propertyName']
              )
           or coalesce(jsonb_typeof(fact->'propertyId'), 'missing') <> 'string'
           or coalesce(jsonb_typeof(fact->'propertyName'), 'missing') <> 'string'
           or property.id is null
           or btrim(property.name) <> btrim(fact->>'propertyName')
     )
  then
    raise exception 'portfolio knowledge artifact evidence hotel facts exceed selected scope';
  end if;

  -- Validate every raw claim provenance, not only the selected source list.
  -- This prevents a service-layer bug from using the artifact as a sink for a
  -- different company's unselected reference text.
  for v_claim in
    select claim
      from jsonb_array_elements(
        new.reproduction_input->'overlay'->'companyDefaults'
      ) claim
  loop
    if not public._staxis_portfolio_knowledge_claim_scope_ok(
      v_claim, new.organization_id, null
    ) then
      raise exception 'portfolio knowledge artifact contains cross-scope company provenance';
    end if;
  end loop;

  for v_resolution in
    select resolution
      from jsonb_array_elements(
        new.reproduction_input->'overlay'->'propertyResolutions'
      ) resolution
  loop
    if not public._staxis_jsonb_exact_keys(v_resolution, array[
         'propertyId', 'knowledgeKey', 'state', 'companyClaim',
         'propertyClaims', 'effectiveClaim', 'conflict'
       ])
       or not coalesce((v_resolution->>'propertyId')::uuid = any(new.selected_property_ids), false)
       or coalesce(jsonb_typeof(v_resolution->'propertyClaims'), 'missing') <> 'array'
       or coalesce(jsonb_typeof(v_resolution->'companyClaim'), 'missing') not in ('null', 'object')
       or coalesce(jsonb_typeof(v_resolution->'effectiveClaim'), 'missing') not in ('null', 'object')
       or coalesce(jsonb_typeof(v_resolution->'conflict'), 'missing') not in ('null', 'object')
       or jsonb_typeof(v_resolution->'propertyId') is distinct from 'string'
       or jsonb_typeof(v_resolution->'knowledgeKey') is distinct from 'string'
       or jsonb_typeof(v_resolution->'state') is distinct from 'string'
       or coalesce(v_resolution->>'state', '') not in (
         'property_override', 'property_only', 'consistent_with_company',
         'unresolved_conflict', 'orphaned_override'
       )
    then
      raise exception 'portfolio knowledge artifact contains cross-scope resolution metadata';
    end if;
    if jsonb_typeof(v_resolution->'companyClaim') = 'object' then
      v_claim := v_resolution->'companyClaim';
      if not public._staxis_portfolio_knowledge_claim_scope_ok(
        v_claim, new.organization_id, null
      ) then
        raise exception 'portfolio knowledge artifact contains cross-scope company claim';
      end if;
    end if;
    for v_claim in
      select claim from jsonb_array_elements(v_resolution->'propertyClaims') claim
    loop
      if not public._staxis_portfolio_knowledge_claim_scope_ok(
        v_claim, new.organization_id, (v_resolution->>'propertyId')::uuid
      ) then
        raise exception 'portfolio knowledge artifact contains cross-scope property claim';
      end if;
    end loop;
    if jsonb_typeof(v_resolution->'effectiveClaim') = 'object' then
      v_claim := v_resolution->'effectiveClaim';
      if not (
        public._staxis_portfolio_knowledge_claim_scope_ok(
          v_claim, new.organization_id, null
        )
        or public._staxis_portfolio_knowledge_claim_scope_ok(
          v_claim, new.organization_id, (v_resolution->>'propertyId')::uuid
        )
      ) then
        raise exception 'portfolio knowledge artifact contains cross-scope effective claim';
      end if;
    end if;
    if jsonb_typeof(v_resolution->'conflict') = 'object'
       and (
         not public._staxis_jsonb_exact_keys(v_resolution->'conflict', array[
           'state', 'companyFactId', 'propertyFactIds'
         ])
         or coalesce(jsonb_typeof(v_resolution->'conflict'->'companyFactId'), 'missing')
              not in ('null', 'string')
         or (
           jsonb_typeof(v_resolution->'conflict'->'companyFactId') = 'string'
           and coalesce(v_resolution->'conflict'->>'companyFactId', '') !~
             '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         )
         or coalesce(jsonb_typeof(v_resolution->'conflict'->'propertyFactIds'), 'missing')
              <> 'array'
         or coalesce(v_resolution->'conflict'->>'state', '') not in (
           'resolved_by_property_override', 'unresolved',
           'override_target_unavailable'
         )
         or exists (
           select 1
             from jsonb_array_elements(
               v_resolution->'conflict'->'propertyFactIds'
             ) fact_id
            where jsonb_typeof(fact_id) is distinct from 'string'
               or coalesce(fact_id #>> '{}', '') !~
              '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         )
       )
    then
      raise exception 'portfolio knowledge artifact contains malformed conflict provenance';
    end if;
  end loop;

  for v_source in
    select source from jsonb_array_elements(new.source_versions) source
  loop
    if not public._staxis_jsonb_exact_keys(v_source, array[
         'sourceKind', 'recordId', 'organizationId', 'propertyId', 'source',
         'reviewState', 'updatedAt', 'effectiveFrom', 'expiresAt'
       ])
       or v_source->>'organizationId' is distinct from new.organization_id::text
       or coalesce(v_source->>'recordId', '') !~
         '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(v_source->>'sourceKind', '') not in ('company_knowledge', 'property_memory')
       or v_source->>'reviewState' is distinct from 'confirmed'
       or jsonb_typeof(v_source->'source') is distinct from 'string'
       or jsonb_typeof(v_source->'updatedAt') is distinct from 'string'
       or coalesce(jsonb_typeof(v_source->'effectiveFrom'), 'missing') not in ('null', 'string')
       or coalesce(jsonb_typeof(v_source->'expiresAt'), 'missing') not in ('null', 'string')
       or (
         v_source->>'sourceKind' = 'company_knowledge'
         and v_source->>'propertyId' is not null
       )
       or (
         v_source->>'sourceKind' = 'property_memory'
         and not coalesce((v_source->>'propertyId')::uuid = any(new.selected_property_ids), false)
       )
       or (
         v_source->>'propertyId' is not null
         and not coalesce((v_source->>'propertyId')::uuid = any(new.selected_property_ids), false)
       )
    then
      raise exception 'portfolio knowledge artifact contains cross-scope source provenance';
    end if;
  end loop;
  if new.knowledge_versions->'sources' is distinct from new.source_versions then
    raise exception 'portfolio knowledge artifact source-version envelope mismatch';
  end if;
  if new.knowledge_versions->'exclusions' is distinct from
       new.reproduction_input->'overlay'->'exclusions'
     or new.knowledge_versions->>'asOf' is distinct from
       new.reproduction_input->'overlay'->>'asOf'
  then
    raise exception 'portfolio knowledge artifact exclusion/version envelope mismatch';
  end if;
  for v_source in
    select exclusion
      from jsonb_array_elements(
        new.reproduction_input->'overlay'->'exclusions'
      ) exclusion
  loop
    if not public._staxis_jsonb_exact_keys(v_source, array[
         'sourceKind', 'recordId', 'propertyId', 'reason'
       ])
       or coalesce(v_source->>'recordId', '') !~
         '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(v_source->>'sourceKind', '') not in ('company', 'property')
       or jsonb_typeof(v_source->'reason') is distinct from 'string'
       or coalesce(v_source->>'reason', '') not in (
         'inactive', 'unconfirmed', 'not_yet_effective', 'expired',
         'future_revision', 'unsafe_prompt_content', 'ambiguous_duplicate_key'
       )
       or (
         v_source->>'sourceKind' = 'company'
         and jsonb_typeof(v_source->'propertyId') is distinct from 'null'
       )
       or (
         v_source->>'sourceKind' = 'property'
         and (
           jsonb_typeof(v_source->'propertyId') is distinct from 'string'
           or not coalesce(
             (v_source->>'propertyId')::uuid = any(new.selected_property_ids),
             false
           )
         )
       )
       or (
         v_source->>'propertyId' is not null
         and not coalesce((v_source->>'propertyId')::uuid = any(new.selected_property_ids), false)
       )
    then
      raise exception 'portfolio knowledge artifact contains cross-scope exclusion provenance';
    end if;
  end loop;

  select coalesce(array_agg(value order by position), array[]::text[])
    into v_claim_ids
    from jsonb_array_elements_text(
      new.reproduction_input->'selection'->'orderedClaimIds'
    ) with ordinality claim(value, position);
  if v_claim_ids is distinct from new.selected_claim_ids
     or exists (
       select 1 from unnest(new.selected_claim_ids) claim_id
        where claim_id !~ '^pk_[0-9a-f]{24}$'
     )
     or cardinality(new.selected_claim_ids) <> (
       select count(distinct claim_id) from unnest(new.selected_claim_ids) claim_id
     )
  then
    raise exception 'portfolio knowledge artifact claim selection mismatch';
  end if;
  return new;
exception
  when invalid_text_representation or data_exception then
    raise exception 'portfolio knowledge artifact contains malformed typed evidence';
end
$$;

revoke all on function public.staxis_validate_portfolio_knowledge_artifact()
  from public, anon, authenticated;

create trigger portfolio_knowledge_request_artifacts_validate
  before insert on public.portfolio_knowledge_request_artifacts
  for each row execute function public.staxis_validate_portfolio_knowledge_artifact();

create index portfolio_knowledge_request_artifacts_conversation_idx
  on public.portfolio_knowledge_request_artifacts(conversation_id, generated_at desc);
create index portfolio_knowledge_request_artifacts_account_idx
  on public.portfolio_knowledge_request_artifacts(account_id, generated_at desc);

alter table public.portfolio_knowledge_request_artifacts enable row level security;
create policy portfolio_knowledge_request_artifacts_deny_browser
  on public.portfolio_knowledge_request_artifacts for all to anon, authenticated
  using (false) with check (false);
revoke all on public.portfolio_knowledge_request_artifacts from public, anon, authenticated;
revoke all on public.portfolio_knowledge_request_artifacts from service_role;
grant select, insert on public.portfolio_knowledge_request_artifacts to service_role;

create trigger portfolio_knowledge_request_artifacts_immutable
  before update or delete on public.portfolio_knowledge_request_artifacts
  for each row execute function public.staxis_refuse_portfolio_receipt_mutation();

-- 0397 predates the closed Finding Patterns consumer receipt. Existing model
-- artifacts remain explicitly NULL; every artifact inserted after 0403 must
-- carry a signed receipt bound to this artifact's exact tenant/scope tuple.
alter table public.portfolio_model_request_artifacts
  add column finding_versions jsonb,
  add column authorized_property_ids uuid[],
  add column selected_property_ids uuid[];

alter table public.portfolio_model_request_artifacts
  add constraint portfolio_model_request_artifacts_finding_versions_check check (
    finding_versions is null
    or coalesce(
      jsonb_typeof(finding_versions) = 'object'
      and octet_length(finding_versions::text) <= 65536,
      false
    )
  );

alter table public.portfolio_model_request_artifacts
  add constraint portfolio_model_request_artifacts_scope_sets_check check (
    (
      authorized_property_ids is null
      and selected_property_ids is null
    )
    or
    (
      authorized_property_ids is not null
      and selected_property_ids is not null
      and cardinality(authorized_property_ids) > 0
      and cardinality(selected_property_ids) > 0
      and selected_property_ids <@ authorized_property_ids
      and property_id = any(selected_property_ids)
    )
  );

comment on column public.portfolio_model_request_artifacts.finding_versions is
  'Exact signed, scope-bound compact Finding Patterns projection receipt supplied to the model. NULL only identifies artifacts created before 0403.';
comment on column public.portfolio_model_request_artifacts.authorized_property_ids is
  'Exact all-authorized property set from the live scope receipt. NULL only on artifacts created before 0403.';
comment on column public.portfolio_model_request_artifacts.selected_property_ids is
  'Exact selected property set supplied to evidence/model synthesis. NULL only on artifacts created before 0403.';

create or replace function public.staxis_validate_portfolio_model_finding_receipt()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_receipt public.authorization_scope_receipts%rowtype;
  v_authorized uuid[];
  v_selected uuid[];
begin
  select receipt.* into v_receipt
    from public.authorization_scope_receipts receipt
   where receipt.id = new.scope_receipt_id;
  if not found
     or v_receipt.expires_at <= clock_timestamp()
     or v_receipt.account_id is distinct from new.account_id
     or v_receipt.organization_id is distinct from new.organization_id
     or v_receipt.authorization_hash is distinct from new.authorization_hash
     or v_receipt.scope_hash is distinct from new.scope_hash
  then
    raise exception 'portfolio model artifact does not match a live authorization receipt';
  end if;

  -- DB-first rolling compatibility is deliberately one-way: the prior writer
  -- already supplied a real signed finding receipt, but could not name the two
  -- new scope-array columns. Derive those arrays only. A missing receipt is not
  -- evidence and is never synthesized, repaired, or silently downgraded.
  if new.finding_versions is null then
    raise exception 'portfolio model artifact requires a finding receipt';
  elsif new.authorized_property_ids is null and new.selected_property_ids is null then
    new.authorized_property_ids := v_receipt.authorized_property_ids;
    new.selected_property_ids := v_receipt.selected_property_ids;
  elsif new.authorized_property_ids is null or new.selected_property_ids is null then
    raise exception 'portfolio model artifact scope arrays are incomplete';
  end if;

  select coalesce(array_agg(value order by value), array[]::uuid[])
    into v_authorized from unnest(new.authorized_property_ids) value;
  select coalesce(array_agg(value order by value), array[]::uuid[])
    into v_selected from unnest(new.selected_property_ids) value;
  if new.authorized_property_ids is distinct from v_authorized
     or new.selected_property_ids is distinct from v_selected
     or cardinality(v_authorized) is distinct from (
       select count(distinct value) from unnest(new.authorized_property_ids) value
     )
     or cardinality(v_selected) is distinct from (
       select count(distinct value) from unnest(new.selected_property_ids) value
     )
     or v_receipt.authorized_property_ids is distinct from new.authorized_property_ids
     or v_receipt.selected_property_ids is distinct from new.selected_property_ids
  then
    raise exception 'portfolio model artifact scope arrays do not match the live receipt';
  end if;
  if not coalesce(public._staxis_portfolio_finding_receipt_ok(
       new.finding_versions,
       new.account_id,
       new.organization_id,
       new.scope_receipt_id,
       new.authorization_hash,
       new.scope_hash,
       cardinality(new.authorized_property_ids),
       cardinality(new.selected_property_ids)
     ), false)
     or not coalesce(public._staxis_portfolio_finding_plan_matches(
       new.finding_versions,
       new.presentation_plan
     ), false)
  then
    raise exception 'portfolio model artifact has an invalid or cross-scope finding receipt';
  end if;
  return new;
end
$$;

revoke all on function public.staxis_validate_portfolio_model_finding_receipt()
  from public, anon, authenticated;

create trigger portfolio_model_request_artifacts_validate_finding_receipt
  before insert on public.portfolio_model_request_artifacts
  for each row execute function public.staxis_validate_portfolio_model_finding_receipt();

-- Do not rely on today's effective ACL state: remove any historical or manual
-- mutation grants before restoring the narrow immutable service contract.
revoke all on public.portfolio_model_request_artifacts from service_role;
grant select, insert on public.portfolio_model_request_artifacts to service_role;

-- A finding projection receipt is compact provenance, never a producer DTO or
-- prompt dump. Historical receipts were admitted under 0384's 256 KiB bound.
-- Classify every existing row explicitly before making 64 KiB the default for
-- new, validated rows; this preserves bytes and keeps deployment deterministic.
alter table public.portfolio_query_receipts
  add column finding_binding_status text not null default 'legacy_unbound';

alter table public.portfolio_query_receipts
  alter column finding_binding_status set default 'validated';

alter table public.portfolio_query_receipts
  drop constraint if exists portfolio_query_receipts_provenance_check;
alter table public.portfolio_query_receipts
  add constraint portfolio_query_receipts_provenance_check check (
    (prompt_hash is null or prompt_hash ~ '^[0-9a-f]{64}$')
    and jsonb_typeof(knowledge_versions) = 'object'
    and jsonb_typeof(finding_versions) = 'object'
    and octet_length(knowledge_versions::text) <= 262144
    and finding_binding_status in ('legacy_unbound', 'validated')
    and (
      (
        finding_binding_status = 'legacy_unbound'
        and octet_length(finding_versions::text) <= 262144
      )
      or
      (
        finding_binding_status = 'validated'
        and octet_length(finding_versions::text) <= 65536
      )
    )
  );

comment on column public.portfolio_query_receipts.finding_binding_status is
  'legacy_unbound marks every receipt predating 0403 without rewriting its finding bytes. New inserts default to and are trigger-enforced as validated.';

alter table public.portfolio_query_receipts
  add column receipt_kind text,
  add column knowledge_artifact_id uuid
    references public.portfolio_knowledge_request_artifacts(id) on delete restrict;

-- Rolling-safe classification: 0378–0396 receipts legitimately predate the
-- required 0397 model artifact. Label them explicitly instead of pretending
-- they are provider-backed or failing migration validation. The insert trigger
-- below never accepts this legacy state for a new row.
select set_config('staxis.portfolio_purge', 'on', true);
update public.portfolio_query_receipts
   set receipt_kind = case
     when request_artifact_id is null then 'legacy_unbound'
     else 'model_metric'
   end;
alter table public.portfolio_query_receipts
  alter column receipt_kind set not null,
  alter column receipt_kind set default 'model_metric';

alter table public.portfolio_query_receipts
  add constraint portfolio_query_receipts_artifact_kind_check check (
    (
      receipt_kind = 'model_metric'
      and request_artifact_id is not null
      and knowledge_artifact_id is null
    )
    or
    (
      receipt_kind = 'deterministic_knowledge'
      and request_artifact_id is null
      and knowledge_artifact_id is not null
    )
    or
    (
      receipt_kind = 'legacy_unbound'
      and request_artifact_id is null
      and knowledge_artifact_id is null
    )
  );

comment on column public.portfolio_query_receipts.receipt_kind is
  'Discriminates real provider-backed metric, no-provider deterministic knowledge, and read-only pre-0397 legacy receipts. New inserts cannot use legacy_unbound. Added 0403.';
comment on column public.portfolio_query_receipts.knowledge_artifact_id is
  'For deterministic_knowledge only: immutable exact knowledge input/selection/render artifact. XOR with 0397 request_artifact_id.';

drop trigger if exists portfolio_query_receipts_bind_request_artifact
  on public.portfolio_query_receipts;

create or replace function public.staxis_bind_portfolio_query_receipt_artifact()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_model public.portfolio_model_request_artifacts%rowtype;
  v_knowledge public.portfolio_knowledge_request_artifacts%rowtype;
begin
  if new.finding_binding_status is distinct from 'validated' then
    raise exception 'new portfolio receipts require validated finding provenance';
  end if;

  if new.receipt_kind = 'model_metric' then
    if new.request_artifact_id is null or new.knowledge_artifact_id is not null then
      raise exception 'model metric receipt requires exactly one model request artifact';
    end if;
    select * into v_model
      from public.portfolio_model_request_artifacts
     where id = new.request_artifact_id;
    if not found then raise exception 'portfolio request artifact not found'; end if;
    if new.finding_versions in ('{}'::jsonb, '{"status":"not_mounted"}'::jsonb)
       and v_model.finding_versions->>'status' = 'not_mounted'
    then
      -- DB-first old-writer compatibility. Copy the signed, scope-validated
      -- artifact receipt; never manufacture or repair a mounted projection.
      new.finding_versions := v_model.finding_versions;
    end if;
    if v_model.property_id is distinct from new.property_id
       or v_model.organization_id is distinct from new.organization_id
       or v_model.account_id is distinct from new.account_id
       or v_model.conversation_id is distinct from new.conversation_id
       or v_model.scope_receipt_id is distinct from new.scope_receipt_id
       or v_model.authorization_hash is distinct from new.authorization_hash
       or v_model.scope_hash is distinct from new.scope_hash
       or v_model.authorized_property_ids is distinct from new.authorized_property_ids
       or v_model.selected_property_ids is distinct from new.selected_property_ids
       or v_model.question_hash is distinct from new.question_hash
       or v_model.prompt_version is distinct from new.prompt_version
       or v_model.prompt_hash is distinct from new.prompt_hash
       or v_model.actual_model_id is distinct from new.model_id
       or v_model.actual_model_tier is distinct from new.model_tier
       or v_model.model_candidate_hash is distinct from new.model_candidate_hash
       or v_model.presentation_plan_version is distinct from new.presentation_plan_version
       or v_model.renderer_version is distinct from new.renderer_version
       or v_model.rendered_answer_hash is distinct from new.answer_hash
       or v_model.finding_versions is distinct from new.finding_versions
       or not coalesce(public._staxis_portfolio_finding_receipt_ok(
         new.finding_versions,
         new.account_id,
         new.organization_id,
         new.scope_receipt_id,
         new.authorization_hash,
         new.scope_hash,
         cardinality(new.authorized_property_ids),
         cardinality(new.selected_property_ids)
       ), false)
       or not coalesce(public._staxis_portfolio_finding_plan_matches(
         new.finding_versions,
         v_model.presentation_plan
       ), false)
    then
      raise exception 'portfolio request artifact does not match receipt';
    end if;
    return new;
  end if;

  if new.receipt_kind <> 'deterministic_knowledge'
     or new.knowledge_artifact_id is null
     or new.request_artifact_id is not null
  then
    raise exception 'unknown portfolio receipt/artifact kind';
  end if;
  select * into v_knowledge
    from public.portfolio_knowledge_request_artifacts
   where id = new.knowledge_artifact_id;
  if not found then raise exception 'portfolio knowledge artifact not found'; end if;

  if v_knowledge.property_id is distinct from new.property_id
     or v_knowledge.organization_id is distinct from new.organization_id
     or v_knowledge.account_id is distinct from new.account_id
     or v_knowledge.conversation_id is distinct from new.conversation_id
     or v_knowledge.scope_receipt_id is distinct from new.scope_receipt_id
     or v_knowledge.authorization_hash is distinct from new.authorization_hash
     or v_knowledge.scope_hash is distinct from new.scope_hash
     or v_knowledge.question_hash is distinct from new.question_hash
     or v_knowledge.query_plan_version is distinct from new.query_plan_version
     or v_knowledge.presentation_version is distinct from new.prompt_version
     or v_knowledge.presentation_version is distinct from new.renderer_version
     or v_knowledge.authorized_property_ids is distinct from new.authorized_property_ids
     or v_knowledge.selected_property_ids is distinct from new.selected_property_ids
     or v_knowledge.source_versions is distinct from new.source_versions
     or v_knowledge.knowledge_versions is distinct from new.knowledge_versions
     or v_knowledge.finding_versions is distinct from new.finding_versions
     or not coalesce(public._staxis_portfolio_finding_receipt_ok(
       new.finding_versions,
       new.account_id,
       new.organization_id,
       new.scope_receipt_id,
       new.authorization_hash,
       new.scope_hash,
       cardinality(new.authorized_property_ids),
       cardinality(new.selected_property_ids)
     ), false)
     or v_knowledge.plan is distinct from new.plan
     or v_knowledge.evidence is distinct from new.evidence
     or v_knowledge.rendered_answer_hash is distinct from new.answer_hash
     or v_knowledge.duration_ms is distinct from new.duration_ms
     or v_knowledge.generated_at is distinct from new.generated_at
     or new.evidence_version is distinct from 'portfolio-knowledge-evidence.v1'
     or new.prompt_hash is not null
     or new.model_id is not null
     or new.model_tier is not null
     or new.model_candidate_hash is not null
     or new.presentation_plan_version is not null
     or new.metric_versions is distinct from '{}'::jsonb
     or new.status is distinct from 'completed'
  then
    raise exception 'portfolio knowledge artifact does not match receipt';
  end if;
  return new;
end
$$;

revoke all on function public.staxis_bind_portfolio_query_receipt_artifact()
  from public, anon, authenticated;

create trigger portfolio_query_receipts_bind_request_artifact
  before insert on public.portfolio_query_receipts
  for each row execute function public.staxis_bind_portfolio_query_receipt_artifact();

-- Reassert the full immutable chain's least-privilege ACL. The purge function
-- remains the only retention delete path and executes under its pinned definer.
revoke all on public.portfolio_query_receipts from service_role;
grant select, insert on public.portfolio_query_receipts to service_role;
revoke all on public.portfolio_query_turn_commits from service_role;
grant select on public.portfolio_query_turn_commits to service_role;

-- Preserve the established two-count operations API. Receipts are deleted
-- first; unreferenced model and deterministic artifacts then age out under the
-- same >=90-day boundary.
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

  with doomed as (
    select id from public.portfolio_knowledge_request_artifacts
    where created_at < p_receipt_before
      and not exists (
        select 1 from public.portfolio_query_receipts receipt
         where receipt.knowledge_artifact_id = portfolio_knowledge_request_artifacts.id
      )
    order by created_at
    limit p_limit
  )
  delete from public.portfolio_knowledge_request_artifacts target
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
  '0403',
  'Immutable deterministic Portfolio Intelligence knowledge artifacts bound to exact scope, receipts, atomic conversation replay and retention without a fake model attempt.'
)
on conflict (version) do nothing;

commit;
