-- 0313 — Fleet-wide AI model control plane.
--
-- Adds a provider model catalog and immutable, versioned per-feature runtime
-- configuration. No row is seeded active: until an admin explicitly creates,
-- validates, and activates a version, application code continues to use the
-- exact model defaults baked into src/lib/ai/feature-registry.ts.

begin;

-- @rls: service-role-only — provider metadata and fleet-wide AI configuration.
create table if not exists public.ai_model_catalog (
  provider             text not null check (provider in ('anthropic', 'openai')),
  model_id              text not null check (char_length(model_id) between 1 and 200),
  display_name          text not null check (char_length(display_name) between 1 and 300),
  status                text not null default 'available'
                        check (status in ('available', 'unavailable')),
  available             boolean not null default true,
  capabilities          text[] not null default '{}'::text[],
  max_input_tokens      integer check (max_input_tokens is null or max_input_tokens > 0),
  max_output_tokens     integer check (max_output_tokens is null or max_output_tokens > 0),
  released_at           timestamptz,
  pricing               jsonb,
  source                text not null default 'provider'
                        check (source in ('provider', 'registry', 'provider+registry')),
  raw_metadata          jsonb not null default '{}'::jsonb
                        check (jsonb_typeof(raw_metadata) = 'object'),
  first_seen_at         timestamptz not null default now(),
  last_seen_at          timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  primary key (provider, model_id),
  constraint ai_model_catalog_pricing_object
    check (pricing is null or jsonb_typeof(pricing) = 'object')
);

create index if not exists ai_model_catalog_provider_available_idx
  on public.ai_model_catalog(provider, available, display_name);

alter table public.ai_model_catalog enable row level security;
drop policy if exists ai_model_catalog_deny_browser on public.ai_model_catalog;
create policy ai_model_catalog_deny_browser on public.ai_model_catalog
  for all to anon, authenticated using (false) with check (false);
revoke all on public.ai_model_catalog from public, anon, authenticated;
-- All mutations must pass through the audited SECURITY DEFINER refresh RPC.
-- The application service role only needs direct reads.
revoke all on public.ai_model_catalog from service_role;
grant select on public.ai_model_catalog to service_role;

-- Seed only models already configured in application code. Discovery can add
-- rows, but never creates or activates an ai_feature_config_versions row.
insert into public.ai_model_catalog
  (provider, model_id, display_name, capabilities, pricing, source, raw_metadata)
values
  (
    'anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5',
    array['text', 'image_input', 'pdf_input', 'tool_use'],
    '{"inputUsdPerMillionTokens":1,"outputUsdPerMillionTokens":5,"cachedInputUsdPerMillionTokens":0.1,"cacheCreation5mInputUsdPerMillionTokens":1.25,"cacheCreation1hInputUsdPerMillionTokens":2,"source":"official-list-price","asOf":"2026-07-15"}'::jsonb,
    'registry', '{"seededFrom":"application-defaults"}'::jsonb
  ),
  (
    'anthropic', 'claude-haiku-4-5-20251001', 'Claude Haiku 4.5 (2025-10-01)',
    array['text', 'image_input', 'pdf_input', 'tool_use'],
    '{"inputUsdPerMillionTokens":1,"outputUsdPerMillionTokens":5,"cachedInputUsdPerMillionTokens":0.1,"cacheCreation5mInputUsdPerMillionTokens":1.25,"cacheCreation1hInputUsdPerMillionTokens":2,"source":"official-list-price","asOf":"2026-07-15"}'::jsonb,
    'registry', '{"seededFrom":"application-defaults"}'::jsonb
  ),
  (
    'anthropic', 'claude-sonnet-4-6', 'Claude Sonnet 4.6',
    array['text', 'image_input', 'pdf_input', 'tool_use'],
    '{"inputUsdPerMillionTokens":3,"outputUsdPerMillionTokens":15,"cachedInputUsdPerMillionTokens":0.3,"cacheCreation5mInputUsdPerMillionTokens":3.75,"cacheCreation1hInputUsdPerMillionTokens":6,"source":"official-list-price","asOf":"2026-07-15"}'::jsonb,
    'registry', '{"seededFrom":"application-defaults"}'::jsonb
  ),
  (
    'anthropic', 'claude-sonnet-5', 'Claude Sonnet 5',
    array['text', 'image_input', 'pdf_input', 'tool_use'],
    '{"inputUsdPerMillionTokens":3,"outputUsdPerMillionTokens":15,"cachedInputUsdPerMillionTokens":0.3,"cacheCreation5mInputUsdPerMillionTokens":3.75,"cacheCreation1hInputUsdPerMillionTokens":6,"source":"official-list-price","asOf":"2026-07-15"}'::jsonb,
    'registry', '{"seededFrom":"official-model-catalog","maxInputTokens":1000000,"maxOutputTokens":128000}'::jsonb
  ),
  (
    'anthropic', 'claude-opus-4-7', 'Claude Opus 4.7',
    array['text', 'image_input', 'pdf_input', 'tool_use'],
    '{"inputUsdPerMillionTokens":5,"outputUsdPerMillionTokens":25,"cachedInputUsdPerMillionTokens":0.5,"cacheCreation5mInputUsdPerMillionTokens":6.25,"cacheCreation1hInputUsdPerMillionTokens":10,"source":"official-list-price","asOf":"2026-07-15"}'::jsonb,
    'registry', '{"seededFrom":"application-defaults"}'::jsonb
  ),
  (
    'openai', 'whisper-1', 'Whisper 1', array['audio_transcription'],
    '{"usdPerAudioMinute":0.006,"source":"code-default","asOf":"2026-05"}'::jsonb,
    'registry', '{"seededFrom":"application-defaults"}'::jsonb
  ),
  (
    'openai', 'text-embedding-3-small', 'Text Embedding 3 Small', array['embeddings'],
    '{"inputUsdPerMillionTokens":0.02,"source":"code-default","asOf":"2026-05"}'::jsonb,
    'registry', '{"seededFrom":"application-defaults"}'::jsonb
  )
on conflict (provider, model_id) do nothing;

-- @rls: service-role-only — immutable fleet-wide AI configuration history.
create table if not exists public.ai_feature_config_versions (
  id                    uuid primary key default gen_random_uuid(),
  feature_key           text not null check (
                          char_length(feature_key) between 3 and 120
                          and feature_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
                        ),
  version               integer not null check (version > 0),
  enabled               boolean not null default true,
  primary_provider      text not null check (primary_provider in ('anthropic', 'openai')),
  primary_model_id      text not null check (char_length(primary_model_id) between 1 and 200),
  fallback_provider     text check (fallback_provider in ('anthropic', 'openai')),
  fallback_model_id     text check (fallback_model_id is null or char_length(fallback_model_id) between 1 and 200),
  parameters            jsonb not null default '{}'::jsonb
                        check (jsonb_typeof(parameters) = 'object'),
  validation_status     text not null default 'pending'
                        check (validation_status in ('pending', 'passed', 'failed')),
  validation_report     jsonb not null default '{}'::jsonb
                        check (jsonb_typeof(validation_report) = 'object'),
  validated_at          timestamptz,
  validated_by          uuid references public.accounts(id) on delete set null,
  validated_by_email    text check (validated_by_email is null or char_length(validated_by_email) <= 320),
  is_active             boolean not null default false,
  parent_id             uuid references public.ai_feature_config_versions(id) on delete restrict,
  change_reason         text check (change_reason is null or char_length(change_reason) <= 1000),
  created_at            timestamptz not null default now(),
  created_by            uuid references public.accounts(id) on delete set null,
  created_by_email      text check (created_by_email is null or char_length(created_by_email) <= 320),
  activated_at          timestamptz,
  activated_by          uuid references public.accounts(id) on delete set null,
  activated_by_email    text check (activated_by_email is null or char_length(activated_by_email) <= 320),
  unique (feature_key, version),
  constraint ai_feature_config_fallback_pair check (
    (fallback_provider is null and fallback_model_id is null)
    or (fallback_provider is not null and fallback_model_id is not null)
  ),
  constraint ai_feature_config_distinct_fallback check (
    fallback_model_id is null
    or (fallback_provider, fallback_model_id) is distinct from (primary_provider, primary_model_id)
  ),
  constraint ai_feature_config_validation_fields check (
    (validation_status = 'pending' and validated_at is null and validated_by is null)
    or (validation_status in ('passed', 'failed') and validated_at is not null)
  ),
  constraint ai_feature_config_active_must_be_valid check (
    not is_active or validation_status = 'passed'
  )
);

create unique index if not exists ai_feature_config_one_active_uq
  on public.ai_feature_config_versions(feature_key) where is_active = true;
create index if not exists ai_feature_config_history_idx
  on public.ai_feature_config_versions(feature_key, created_at desc);
create index if not exists ai_feature_config_global_history_idx
  on public.ai_feature_config_versions(created_at desc);

alter table public.ai_feature_config_versions enable row level security;
drop policy if exists ai_feature_config_versions_deny_browser on public.ai_feature_config_versions;
create policy ai_feature_config_versions_deny_browser on public.ai_feature_config_versions
  for all to anon, authenticated using (false) with check (false);
revoke all on public.ai_feature_config_versions from public, anon, authenticated;
-- Config creation/validation/activation are intentionally RPC-only so no
-- service-role callsite can bypass actor snapshots or admin_audit_log writes.
revoke all on public.ai_feature_config_versions from service_role;
grant select on public.ai_feature_config_versions to service_role;

-- Configuration payloads are immutable after INSERT. Validation and activation
-- lifecycle fields may change, but edits create a new version rather than
-- rewriting history.
create or replace function public.staxis_guard_ai_feature_config_immutable()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.feature_key is distinct from old.feature_key
     or new.version is distinct from old.version
     or new.enabled is distinct from old.enabled
     or new.primary_provider is distinct from old.primary_provider
     or new.primary_model_id is distinct from old.primary_model_id
     or new.fallback_provider is distinct from old.fallback_provider
     or new.fallback_model_id is distinct from old.fallback_model_id
     or new.parameters is distinct from old.parameters
     or new.parent_id is distinct from old.parent_id
     or new.change_reason is distinct from old.change_reason
     or new.created_at is distinct from old.created_at
     or new.created_by_email is distinct from old.created_by_email then
    raise exception 'ai_feature_config_payload_is_immutable'
      using errcode = '22000';
  end if;
  return new;
end
$$;

comment on function public.staxis_guard_ai_feature_config_immutable() is
  'Blocks config payload/history rewrites. created_by may be nulled only by its accounts ON DELETE SET NULL foreign key; the immutable created_by_email snapshot preserves attribution.';

drop trigger if exists ai_feature_config_immutable_guard on public.ai_feature_config_versions;
create trigger ai_feature_config_immutable_guard
  before update on public.ai_feature_config_versions
  for each row execute function public.staxis_guard_ai_feature_config_immutable();

create or replace function public.staxis_block_ai_feature_config_delete()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'ai_feature_config_history_is_append_only'
    using errcode = '22000';
end
$$;

drop trigger if exists ai_feature_config_no_delete on public.ai_feature_config_versions;
create trigger ai_feature_config_no_delete
  before delete on public.ai_feature_config_versions
  for each row execute function public.staxis_block_ai_feature_config_delete();

-- Create a config version and its admin audit row in one transaction. The
-- advisory lock makes version allocation deterministic under concurrent admin
-- requests; an audit failure rolls the config insert back as well.
create or replace function public.staxis_create_ai_feature_config(
  p_feature_key text,
  p_enabled boolean,
  p_primary_provider text,
  p_primary_model_id text,
  p_fallback_provider text,
  p_fallback_model_id text,
  p_parameters jsonb,
  p_parent_id uuid,
  p_change_reason text,
  p_actor_account_id uuid,
  p_actor_user_id uuid,
  p_actor_email text,
  p_request_id text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_config_id uuid;
  v_version integer;
begin
  if p_actor_account_id is null or p_actor_user_id is null then
    raise exception 'ai_config_actor_required' using errcode = '22023';
  end if;
  if p_request_id is null or char_length(p_request_id) not between 1 and 200 then
    raise exception 'ai_config_request_id_required' using errcode = '22023';
  end if;
  if p_parameters is null or jsonb_typeof(p_parameters) <> 'object' then
    raise exception 'ai_config_parameters_must_be_object' using errcode = '22023';
  end if;
  if p_parent_id is not null and not exists (
    select 1
    from public.ai_feature_config_versions
    where id = p_parent_id and feature_key = p_feature_key
  ) then
    raise exception 'ai_config_parent_feature_mismatch' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('ai-config-version:' || p_feature_key, 0));
  select coalesce(max(version), 0) + 1
    into v_version
  from public.ai_feature_config_versions
  where feature_key = p_feature_key;

  insert into public.ai_feature_config_versions (
    feature_key, version, enabled,
    primary_provider, primary_model_id,
    fallback_provider, fallback_model_id,
    parameters, parent_id, change_reason, created_by, created_by_email
  ) values (
    p_feature_key, v_version, p_enabled,
    p_primary_provider, p_primary_model_id,
    p_fallback_provider, p_fallback_model_id,
    p_parameters, p_parent_id, nullif(trim(p_change_reason), ''), p_actor_account_id,
    nullif(trim(p_actor_email), '')
  )
  returning id into v_config_id;

  insert into public.admin_audit_log
    (actor_user_id, actor_email, action, target_type, target_id, metadata)
  values (
    p_actor_user_id,
    nullif(trim(p_actor_email), ''),
    'ai.config.create',
    'ai_feature_config',
    v_config_id::text,
    jsonb_build_object(
      'feature_key', p_feature_key,
      'version', v_version,
      'enabled', p_enabled,
      'primary_provider', p_primary_provider,
      'primary_model_id', p_primary_model_id,
      'fallback_provider', p_fallback_provider,
      'fallback_model_id', p_fallback_model_id,
      'parent_id', p_parent_id,
      'change_reason', nullif(trim(p_change_reason), ''),
      'actor_account_id', p_actor_account_id,
      'request_id', p_request_id
    )
  );

  return v_config_id;
end
$$;

-- Persist a synthetic validation result and its audit row atomically. Active
-- versions cannot be mutated; callers must create a new version to retest.
create or replace function public.staxis_record_ai_feature_validation(
  p_config_id uuid,
  p_validation_status text,
  p_validation_report jsonb,
  p_checked_at timestamptz,
  p_actor_account_id uuid,
  p_actor_user_id uuid,
  p_actor_email text,
  p_request_id text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_feature_key text;
  v_version integer;
  v_is_active boolean;
begin
  if p_validation_status not in ('passed', 'failed') then
    raise exception 'invalid_ai_validation_status' using errcode = '22023';
  end if;
  if p_validation_report is null or jsonb_typeof(p_validation_report) <> 'object' then
    raise exception 'ai_validation_report_must_be_object' using errcode = '22023';
  end if;
  if (p_validation_report ->> 'valid')::boolean
       is distinct from (p_validation_status = 'passed') then
    raise exception 'ai_validation_report_status_mismatch' using errcode = '22023';
  end if;
  if p_checked_at is null or p_actor_account_id is null or p_actor_user_id is null then
    raise exception 'ai_validation_actor_and_time_required' using errcode = '22023';
  end if;
  if p_request_id is null or char_length(p_request_id) not between 1 and 200 then
    raise exception 'ai_validation_request_id_required' using errcode = '22023';
  end if;

  select feature_key, version, is_active
    into v_feature_key, v_version, v_is_active
  from public.ai_feature_config_versions
  where id = p_config_id
  for update;
  if not found then
    raise exception 'ai_feature_config_not_found' using errcode = 'P0002';
  end if;
  if v_is_active then
    raise exception 'active_ai_config_cannot_be_revalidated' using errcode = '22000';
  end if;

  update public.ai_feature_config_versions
    set validation_status = p_validation_status,
        validation_report = p_validation_report,
        validated_at = p_checked_at,
        validated_by = p_actor_account_id,
        validated_by_email = nullif(trim(p_actor_email), '')
  where id = p_config_id;

  insert into public.admin_audit_log
    (actor_user_id, actor_email, action, target_type, target_id, metadata)
  values (
    p_actor_user_id,
    nullif(trim(p_actor_email), ''),
    'ai.config.validate',
    'ai_feature_config',
    p_config_id::text,
    jsonb_build_object(
      'feature_key', v_feature_key,
      'version', v_version,
      'valid', p_validation_status = 'passed',
      'errors', coalesce(p_validation_report -> 'errors', '[]'::jsonb),
      'warnings', coalesce(p_validation_report -> 'warnings', '[]'::jsonb),
      'actor_account_id', p_actor_account_id,
      'request_id', p_request_id
    )
  );
end
$$;

-- Replace one provider's cached catalog snapshot and record the successful
-- refresh atomically. Discovery happens outside the transaction; no model is
-- ever selected or activated by this function.
create or replace function public.staxis_refresh_ai_model_catalog(
  p_provider text,
  p_models jsonb,
  p_missing_model_ids text[],
  p_refreshed_at timestamptz,
  p_actor_account_id uuid,
  p_actor_user_id uuid,
  p_actor_email text,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_discovered integer;
  v_available integer;
begin
  if p_provider not in ('anthropic', 'openai') then
    raise exception 'invalid_ai_provider' using errcode = '22023';
  end if;
  if p_models is null or jsonb_typeof(p_models) <> 'array' or jsonb_array_length(p_models) = 0 then
    raise exception 'ai_provider_catalog_must_be_nonempty' using errcode = '22023';
  end if;
  if p_refreshed_at is null or p_actor_account_id is null or p_actor_user_id is null then
    raise exception 'ai_catalog_actor_and_time_required' using errcode = '22023';
  end if;
  if p_request_id is null or char_length(p_request_id) not between 1 and 200 then
    raise exception 'ai_catalog_request_id_required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('ai-model-catalog:' || p_provider, 0));

  insert into public.ai_model_catalog (
    provider, model_id, display_name, status, available, capabilities,
    max_input_tokens, max_output_tokens, released_at, pricing, source,
    raw_metadata, first_seen_at, last_seen_at, updated_at
  )
  select
    p_provider, model_id, display_name, 'available', true, capabilities,
    max_input_tokens, max_output_tokens, released_at, pricing, source,
    raw_metadata, coalesce(first_seen_at, p_refreshed_at),
    p_refreshed_at, p_refreshed_at
  from jsonb_to_recordset(p_models) as model(
    model_id text,
    display_name text,
    capabilities text[],
    max_input_tokens integer,
    max_output_tokens integer,
    released_at timestamptz,
    pricing jsonb,
    source text,
    raw_metadata jsonb,
    first_seen_at timestamptz
  )
  on conflict (provider, model_id) do update set
    display_name = excluded.display_name,
    status = 'available',
    available = true,
    capabilities = excluded.capabilities,
    max_input_tokens = excluded.max_input_tokens,
    max_output_tokens = excluded.max_output_tokens,
    released_at = excluded.released_at,
    pricing = excluded.pricing,
    source = excluded.source,
    raw_metadata = excluded.raw_metadata,
    last_seen_at = excluded.last_seen_at,
    updated_at = excluded.updated_at;

  -- Derive removals from the submitted snapshot *inside* the provider lock.
  -- p_missing_model_ids remains in the signature for API compatibility, but a
  -- caller-side preflight can be stale when two refreshes overlap and must not
  -- decide the final availability state.
  update public.ai_model_catalog as catalog
    set status = 'unavailable',
        available = false,
        updated_at = p_refreshed_at
  where catalog.provider = p_provider
    and not exists (
      select 1
      from jsonb_array_elements(p_models) as discovered(model)
      where discovered.model ->> 'model_id' = catalog.model_id
    );

  select jsonb_array_length(p_models) into v_discovered;
  select count(*)::integer into v_available
  from public.ai_model_catalog
  where provider = p_provider and available = true;

  insert into public.admin_audit_log
    (actor_user_id, actor_email, action, target_type, target_id, metadata)
  values (
    p_actor_user_id,
    nullif(trim(p_actor_email), ''),
    'ai.provider.refresh',
    'ai_provider',
    p_provider,
    jsonb_build_object(
      'provider', p_provider,
      'discovered', v_discovered,
      'available', v_available,
      'actor_account_id', p_actor_account_id,
      'request_id', p_request_id,
      'refreshed_at', p_refreshed_at
    )
  );

  return jsonb_build_object(
    'discovered', v_discovered,
    'available', v_available,
    'refreshedAt', p_refreshed_at
  );
end
$$;

-- Atomically activate (or reactivate for rollback) a validated version and
-- write the corresponding admin audit record. expected_active_id is an
-- optimistic-concurrency token; NULL means the caller expects code defaults
-- with no DB-backed active row.
create or replace function public.staxis_activate_ai_feature_config(
  p_config_id uuid,
  p_expected_active_id uuid,
  p_actor_account_id uuid,
  p_actor_user_id uuid,
  p_actor_email text,
  p_action text,
  p_reason text,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_feature_key text;
  v_previous_id uuid;
  v_previous_model text;
  v_target_model text;
  v_target_version integer;
begin
  if p_action not in ('ai.config.activate', 'ai.config.rollback') then
    raise exception 'invalid_ai_config_action' using errcode = '22023';
  end if;
  if p_actor_account_id is null or p_actor_user_id is null then
    raise exception 'ai_config_activation_actor_required' using errcode = '22023';
  end if;
  if p_request_id is null or char_length(p_request_id) not between 1 and 200 then
    raise exception 'ai_config_activation_request_id_required' using errcode = '22023';
  end if;
  if p_reason is null or char_length(trim(p_reason)) < 3 or char_length(p_reason) > 1000 then
    raise exception 'activation_reason_required' using errcode = '22023';
  end if;

  select feature_key into v_feature_key
  from public.ai_feature_config_versions
  where id = p_config_id;
  if not found then
    raise exception 'ai_feature_config_not_found' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_feature_key, 0));

  select feature_key, primary_model_id, version
    into v_feature_key, v_target_model, v_target_version
  from public.ai_feature_config_versions
  where id = p_config_id and validation_status = 'passed'
  for update;
  if not found then
    raise exception 'ai_feature_config_not_validated' using errcode = '22000';
  end if;

  select id, primary_model_id into v_previous_id, v_previous_model
  from public.ai_feature_config_versions
  where feature_key = v_feature_key and is_active = true
  for update;

  if p_expected_active_id is distinct from v_previous_id then
    raise exception 'ai_feature_config_conflict expected=% actual=%',
      p_expected_active_id, v_previous_id
      using errcode = '40001';
  end if;

  update public.ai_feature_config_versions
    set is_active = false
  where feature_key = v_feature_key and is_active = true and id <> p_config_id;

  update public.ai_feature_config_versions
    set is_active = true,
        activated_at = now(),
        activated_by = p_actor_account_id,
        activated_by_email = nullif(trim(p_actor_email), '')
  where id = p_config_id;

  insert into public.admin_audit_log
    (actor_user_id, actor_email, action, target_type, target_id, metadata)
  values (
    p_actor_user_id,
    nullif(trim(p_actor_email), ''),
    p_action,
    'ai_feature_config',
    p_config_id::text,
    jsonb_build_object(
      'feature_key', v_feature_key,
      'previous_config_id', v_previous_id,
      'previous_model_id', v_previous_model,
      'new_config_id', p_config_id,
      'new_model_id', v_target_model,
      'new_version', v_target_version,
      'reason', trim(p_reason),
      'request_id', p_request_id
    )
  );

  return jsonb_build_object(
    'featureKey', v_feature_key,
    'previousConfigId', v_previous_id,
    'activeConfigId', p_config_id,
    'version', v_target_version
  );
end
$$;

revoke all on function public.staxis_activate_ai_feature_config(
  uuid, uuid, uuid, uuid, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.staxis_activate_ai_feature_config(
  uuid, uuid, uuid, uuid, text, text, text, text
) to service_role;

revoke all on function public.staxis_create_ai_feature_config(
  text, boolean, text, text, text, text, jsonb, uuid, text, uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.staxis_create_ai_feature_config(
  text, boolean, text, text, text, text, jsonb, uuid, text, uuid, uuid, text, text
) to service_role;

revoke all on function public.staxis_record_ai_feature_validation(
  uuid, text, jsonb, timestamptz, uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.staxis_record_ai_feature_validation(
  uuid, text, jsonb, timestamptz, uuid, uuid, text, text
) to service_role;

revoke all on function public.staxis_refresh_ai_model_catalog(
  text, jsonb, text[], timestamptz, uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.staxis_refresh_ai_model_catalog(
  text, jsonb, text[], timestamptz, uuid, uuid, text, text
) to service_role;

revoke all on function public.staxis_guard_ai_feature_config_immutable() from public, anon, authenticated;
revoke all on function public.staxis_block_ai_feature_config_delete() from public, anon, authenticated;

comment on table public.ai_model_catalog is
  'Cached, sanitized provider model metadata plus curated capabilities/pricing. Discovery is informational and never activates a model.';
comment on table public.ai_feature_config_versions is
  'Append-only, immutable per-feature AI runtime configuration. One validated active row per feature; code defaults remain the fail-safe baseline.';
comment on function public.staxis_activate_ai_feature_config(uuid, uuid, uuid, uuid, text, text, text, text) is
  'Optimistic, atomic AI config activation/rollback with audit insertion in the same transaction. Service-role only.';
comment on function public.staxis_create_ai_feature_config(text, boolean, text, text, text, text, jsonb, uuid, text, uuid, uuid, text, text) is
  'Atomically allocates and creates an immutable AI config version with its admin audit row. Service-role only.';
comment on function public.staxis_record_ai_feature_validation(uuid, text, jsonb, timestamptz, uuid, uuid, text, text) is
  'Atomically records an inactive AI config validation result with its admin audit row. Service-role only.';
comment on function public.staxis_refresh_ai_model_catalog(text, jsonb, text[], timestamptz, uuid, uuid, text, text) is
  'Atomically replaces one discovered provider catalog snapshot and writes its admin audit row. Service-role only.';

insert into public.applied_migrations (version, description)
values ('0313', 'AI control center: provider catalog, immutable per-feature config versions, and atomic audited activation/rollback')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
