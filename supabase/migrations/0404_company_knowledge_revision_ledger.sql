-- ═══════════════════════════════════════════════════════════════════════════
-- 0404 — COMPANY KNOWLEDGE REVISION LEDGER
--
-- `company_knowledge` remains the current, read-compatible projection. This
-- migration adds the immutable history and the one authorized CAS writer that
-- make every company policy change attributable and concurrency-safe.
--
-- ROLLING DEPLOYMENT
--   compat   (the migration's initial state)
--     * old service-role writers still work;
--     * projection/authority triggers journal those legacy writes;
--     * the v1 RPC is available to the new app.
--   enforced (one-way, via staxis_finalize_company_knowledge_revision_ledger)
--     * direct service-role projection/authority DML and the 0365 legacy RPC
--       are revoked;
--     * only the receipt-bound v1 mutation RPC may write.
--   Cutover runbook:
--     1. apply 0404 and verify staxis_company_knowledge_ledger_capability();
--     2. deploy the 0404-aware app and smoke intake/confirm/edit/remove/merge;
--     3. call staxis_finalize_company_knowledge_revision_ledger() with the exact
--        schema version, then verify legacy DML is denied;
--     4. after finalization, roll back only to another 0404-aware app build.
--
-- Browser roles never see the ledger. Revision/head/context rows are never
-- updateable or deletable by ordinary service paths.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.company_knowledge
  add column if not exists current_revision bigint not null default 1;

alter table public.company_knowledge
  drop constraint if exists company_knowledge_current_revision_ck;
alter table public.company_knowledge
  add constraint company_knowledge_current_revision_ck
  check (current_revision > 0);

comment on column public.company_knowledge.current_revision is
  'DB-owned optimistic concurrency token. Clients must echo it for confirm/edit/remove/merge.';

create table if not exists public.company_knowledge_revision_ledger_state (
  singleton boolean primary key default true check (singleton),
  schema_version text not null,
  rollout_mode text not null,
  enforced_at timestamptz,
  constraint company_knowledge_revision_ledger_state_mode_ck
    check (rollout_mode in ('compat', 'enforced')),
  constraint company_knowledge_revision_ledger_state_enforced_ck
    check ((rollout_mode = 'compat' and enforced_at is null)
        or (rollout_mode = 'enforced' and enforced_at is not null))
);

insert into public.company_knowledge_revision_ledger_state (
  singleton, schema_version, rollout_mode, enforced_at
) values (
  true, 'company_knowledge_revision_ledger_v1', 'compat', null
) on conflict (singleton) do update
  set schema_version = excluded.schema_version;

-- @rls: service-role-only — private per-company hash-chain cursor; no browser reads.
create table if not exists public.company_knowledge_revision_heads (
  organization_id uuid primary key,
  last_organization_revision bigint not null default 0
    check (last_organization_revision >= 0),
  last_revision_hash text,
  updated_at timestamptz not null default now(),
  constraint company_knowledge_revision_heads_hash_ck
    check (last_revision_hash is null or last_revision_hash ~ '^[0-9a-f]{64}$')
);

create table if not exists public.company_knowledge_revision_context (
  backend_pid integer not null,
  fact_id uuid not null,
  operation_id uuid not null,
  action text not null,
  actor_account_id uuid,
  actor_kind text not null,
  source text not null,
  request_id text,
  suppress_automatic_revision boolean not null default true,
  allow_revision_bump boolean not null default false,
  primary key (backend_pid, fact_id)
);

-- @rls: service-role-only — immutable organization-scoped audit history.
create table if not exists public.company_knowledge_revisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  organization_revision bigint not null check (organization_revision > 0),
  fact_id uuid not null,
  fact_revision bigint not null check (fact_revision > 0),
  operation_id uuid not null,
  action text not null,
  merge_role text,
  related_fact_id uuid,
  before_snapshot jsonb,
  after_snapshot jsonb,
  before_snapshot_hash text,
  after_snapshot_hash text,
  previous_revision_hash text,
  revision_hash text not null,
  actor_account_id uuid,
  actor_kind text not null,
  source text not null,
  request_id text,
  occurred_at timestamptz not null,
  constraint company_knowledge_revisions_action_ck check (action in (
    'genesis', 'insert', 'intake', 'confirm', 'edit', 'remove', 'merge',
    'structured_reading_change', 'legacy_update'
  )),
  constraint company_knowledge_revisions_merge_ck check (
    (action = 'merge' and merge_role in ('keep', 'drop') and related_fact_id is not null)
    or (action <> 'merge' and merge_role is null and related_fact_id is null)
  ),
  constraint company_knowledge_revisions_snapshot_ck check (
    (before_snapshot is null or jsonb_typeof(before_snapshot) = 'object')
    and (after_snapshot is null or jsonb_typeof(after_snapshot) = 'object')
    and (before_snapshot is not null or after_snapshot is not null)
  ),
  constraint company_knowledge_revisions_hash_ck check (
    revision_hash ~ '^[0-9a-f]{64}$'
    and ((before_snapshot is null) = (before_snapshot_hash is null))
    and ((after_snapshot is null) = (after_snapshot_hash is null))
    and (before_snapshot_hash is null or before_snapshot_hash ~ '^[0-9a-f]{64}$')
    and (after_snapshot_hash is null or after_snapshot_hash ~ '^[0-9a-f]{64}$')
    and (previous_revision_hash is null or previous_revision_hash ~ '^[0-9a-f]{64}$')
  ),
  constraint company_knowledge_revisions_actor_ck check (
    actor_kind in ('account', 'legacy_service', 'backfill')
    and (actor_kind <> 'account' or actor_account_id is not null)
    and (actor_kind <> 'backfill' or actor_account_id is null)
  ),
  constraint company_knowledge_revisions_text_ck check (
    char_length(source) between 1 and 80
    and (request_id is null or char_length(request_id) between 1 and 200)
  ),
  unique (organization_id, organization_revision),
  unique (organization_id, fact_id, fact_revision)
);

create index if not exists company_knowledge_revisions_fact_idx
  on public.company_knowledge_revisions (
    organization_id, fact_id, fact_revision desc
  );
create index if not exists company_knowledge_revisions_operation_idx
  on public.company_knowledge_revisions (organization_id, operation_id);

comment on table public.company_knowledge_revisions is
  'Append-only, hash-chained company rulebook history. No FK intentionally: removing a current projection must never erase its proof.';

create or replace function public._staxis_company_authority_rule_snapshot(
  p_fact_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'id', rule.id,
    'actionKind', rule.action_kind,
    'thresholdCents', rule.threshold_cents,
    'thresholdInclusive', rule.threshold_inclusive,
    'approverRole', rule.approver_role,
    'createdByAccountId', rule.created_by_account_id,
    'createdAt', rule.created_at,
    'updatedAt', rule.updated_at
  )
  from public.company_authority_rules rule
  where rule.source_fact_id = p_fact_id
    and rule.is_active
  order by rule.created_at desc, rule.id desc
  limit 1;
$$;

revoke all on function public._staxis_company_authority_rule_snapshot(uuid)
  from public, anon, authenticated, service_role;

create or replace function public._staxis_company_authority_row_snapshot(
  p_rule public.company_authority_rules
)
returns jsonb
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case when p_rule is null or p_rule.is_active is not true then null
    else jsonb_build_object(
      'id', p_rule.id,
      'actionKind', p_rule.action_kind,
      'thresholdCents', p_rule.threshold_cents,
      'thresholdInclusive', p_rule.threshold_inclusive,
      'approverRole', p_rule.approver_role,
      'createdByAccountId', p_rule.created_by_account_id,
      'createdAt', p_rule.created_at,
      'updatedAt', p_rule.updated_at
    ) end;
$$;

revoke all on function public._staxis_company_authority_row_snapshot(
  public.company_authority_rules
) from public, anon, authenticated, service_role;

create or replace function public._staxis_company_knowledge_snapshot_from_row(
  p_fact public.company_knowledge,
  p_authority jsonb
)
returns jsonb
language sql
immutable
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'version', 'company_knowledge_snapshot_v1',
    'factId', p_fact.id,
    'organizationId', p_fact.organization_id,
    'topic', p_fact.topic,
    'content', p_fact.content,
    'category', p_fact.category,
    'source', p_fact.source,
    'reviewState', p_fact.review_state,
    'isActive', p_fact.is_active,
    'policyKey', p_fact.policy_key,
    'policyValue', p_fact.policy_value,
    'createdByAccountId', p_fact.created_by_account_id,
    'createdByName', p_fact.created_by_name,
    'createdByRole', p_fact.created_by_role,
    'createdAt', p_fact.created_at,
    'updatedAt', p_fact.updated_at,
    'currentRevision', p_fact.current_revision,
    'authorityRule', p_authority
  );
$$;

revoke all on function public._staxis_company_knowledge_snapshot_from_row(
  public.company_knowledge, jsonb
) from public, anon, authenticated, service_role;

create or replace function public._staxis_company_knowledge_snapshot(
  p_fact_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public._staxis_company_knowledge_snapshot_from_row(
    fact,
    public._staxis_company_authority_rule_snapshot(fact.id)
  )
  from public.company_knowledge fact
  where fact.id = p_fact_id;
$$;

revoke all on function public._staxis_company_knowledge_snapshot(uuid)
  from public, anon, authenticated, service_role;

create or replace function public._staxis_company_knowledge_snapshot_ok(
  p_snapshot jsonb,
  p_organization_id uuid,
  p_fact_id uuid,
  p_fact_revision bigint
)
returns boolean
language sql
immutable
set search_path = pg_catalog, public
as $$
  select p_snapshot is null or (
    jsonb_typeof(p_snapshot) = 'object'
    and (select count(*) from jsonb_object_keys(p_snapshot)) = 18
    and p_snapshot ?& array[
      'version', 'factId', 'organizationId', 'topic', 'content', 'category',
      'source', 'reviewState', 'isActive', 'policyKey', 'policyValue',
      'createdByAccountId', 'createdByName', 'createdByRole', 'createdAt',
      'updatedAt', 'currentRevision', 'authorityRule'
    ]
    and p_snapshot->>'version' = 'company_knowledge_snapshot_v1'
    and p_snapshot->>'factId' = p_fact_id::text
    and p_snapshot->>'organizationId' = p_organization_id::text
    and p_snapshot->>'currentRevision' = p_fact_revision::text
    and jsonb_typeof(p_snapshot->'isActive') = 'boolean'
    and jsonb_typeof(p_snapshot->'authorityRule') in ('null', 'object')
  );
$$;

revoke all on function public._staxis_company_knowledge_snapshot_ok(
  jsonb, uuid, uuid, bigint
) from public, anon, authenticated, service_role;

create or replace function public._staxis_append_company_knowledge_revision(
  p_organization_id uuid,
  p_fact_id uuid,
  p_fact_revision bigint,
  p_operation_id uuid,
  p_action text,
  p_merge_role text,
  p_related_fact_id uuid,
  p_before_snapshot jsonb,
  p_after_snapshot jsonb,
  p_actor_account_id uuid,
  p_actor_kind text,
  p_source text,
  p_request_id text,
  p_occurred_at timestamptz default clock_timestamp()
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_head public.company_knowledge_revision_heads%rowtype;
  v_organization_revision bigint;
  v_before_hash text;
  v_after_hash text;
  v_expected_before_hash text;
  v_revision_hash text;
  v_revision_id uuid;
begin
  if p_organization_id is null or p_fact_id is null or p_fact_revision is null
     or p_fact_revision < 1 or p_operation_id is null or p_action is null
     or p_actor_kind not in ('account', 'legacy_service', 'backfill')
     or coalesce(char_length(p_source), 0) not between 1 and 80
     or (p_request_id is not null and char_length(p_request_id) not between 1 and 200)
     or p_after_snapshot is null
     or (p_action in ('genesis', 'insert', 'intake') and p_before_snapshot is not null)
     or (p_action not in ('genesis', 'insert', 'intake') and p_before_snapshot is null)
     or not public._staxis_company_knowledge_snapshot_ok(
       p_before_snapshot, p_organization_id, p_fact_id, p_fact_revision - 1
     )
     or not public._staxis_company_knowledge_snapshot_ok(
       p_after_snapshot, p_organization_id, p_fact_id, p_fact_revision
     ) then
    raise exception 'invalid company knowledge revision'
      using errcode = '22023';
  end if;

  insert into public.company_knowledge_revision_heads (
    organization_id, last_organization_revision, last_revision_hash
  ) values (p_organization_id, 0, null)
  on conflict (organization_id) do nothing;

  select * into v_head
  from public.company_knowledge_revision_heads head
  where head.organization_id = p_organization_id
  for update;

  v_organization_revision := v_head.last_organization_revision + 1;
  v_before_hash := case when p_before_snapshot is null then null else
    encode(sha256(convert_to(p_before_snapshot::text, 'UTF8')), 'hex') end;
  v_after_hash := case when p_after_snapshot is null then null else
    encode(sha256(convert_to(p_after_snapshot::text, 'UTF8')), 'hex') end;

  if p_before_snapshot is null then
    if exists (
      select 1 from public.company_knowledge_revisions revision
      where revision.organization_id = p_organization_id
        and revision.fact_id = p_fact_id
    ) then
      raise exception 'company knowledge revision history is discontinuous'
        using errcode = '22023';
    end if;
  else
    select revision.after_snapshot_hash into v_expected_before_hash
    from public.company_knowledge_revisions revision
    where revision.organization_id = p_organization_id
      and revision.fact_id = p_fact_id
      and revision.fact_revision = p_fact_revision - 1;
    if not found or v_expected_before_hash is distinct from v_before_hash then
      raise exception 'company knowledge revision history is discontinuous'
        using errcode = '22023';
    end if;
  end if;

  v_revision_hash := encode(sha256(convert_to(jsonb_build_object(
    'version', 'company_knowledge_revision_v1',
    'organizationId', p_organization_id,
    'organizationRevision', v_organization_revision,
    'factId', p_fact_id,
    'factRevision', p_fact_revision,
    'operationId', p_operation_id,
    'action', p_action,
    'mergeRole', p_merge_role,
    'relatedFactId', p_related_fact_id,
    'beforeSnapshotHash', v_before_hash,
    'afterSnapshotHash', v_after_hash,
    'previousRevisionHash', v_head.last_revision_hash,
    'actorAccountId', p_actor_account_id,
    'actorKind', p_actor_kind,
    'source', p_source,
    'requestId', p_request_id,
    'occurredAt', p_occurred_at
  )::text, 'UTF8')), 'hex');

  insert into public.company_knowledge_revisions (
    organization_id, organization_revision, fact_id, fact_revision,
    operation_id, action, merge_role, related_fact_id,
    before_snapshot, after_snapshot, before_snapshot_hash,
    after_snapshot_hash, previous_revision_hash, revision_hash,
    actor_account_id, actor_kind, source, request_id, occurred_at
  ) values (
    p_organization_id, v_organization_revision, p_fact_id, p_fact_revision,
    p_operation_id, p_action, p_merge_role, p_related_fact_id,
    p_before_snapshot, p_after_snapshot, v_before_hash,
    v_after_hash, v_head.last_revision_hash, v_revision_hash,
    p_actor_account_id, p_actor_kind, p_source, p_request_id, p_occurred_at
  ) returning id into v_revision_id;

  update public.company_knowledge_revision_heads
     set last_organization_revision = v_organization_revision,
         last_revision_hash = v_revision_hash,
         updated_at = clock_timestamp()
   where organization_id = p_organization_id;

  return v_revision_id;
end;
$$;

revoke all on function public._staxis_append_company_knowledge_revision(
  uuid, uuid, bigint, uuid, text, text, uuid, jsonb, jsonb,
  uuid, text, text, text, timestamptz
) from public, anon, authenticated, service_role;

-- Backfill one genesis event for every existing projection without rewriting
-- its content, timestamps, review state, or structured reading.
do $$
declare
  v_fact public.company_knowledge%rowtype;
begin
  for v_fact in
    select fact.*
    from public.company_knowledge fact
    where not exists (
      select 1 from public.company_knowledge_revisions revision
      where revision.organization_id = fact.organization_id
        and revision.fact_id = fact.id
    )
    order by fact.organization_id, fact.created_at, fact.id
  loop
    perform public._staxis_append_company_knowledge_revision(
      v_fact.organization_id,
      v_fact.id,
      v_fact.current_revision,
      gen_random_uuid(),
      'genesis',
      null,
      null,
      null,
      public._staxis_company_knowledge_snapshot(v_fact.id),
      null,
      'backfill',
      'migration_0404',
      null,
      v_fact.updated_at
    );
  end loop;
end;
$$;

create or replace function public._staxis_company_knowledge_revision_number()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_context public.company_knowledge_revision_context%rowtype;
  v_changed boolean;
begin
  if tg_op = 'INSERT' then
    new.current_revision := 1;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.organization_id is distinct from old.organization_id then
    raise exception 'company knowledge identity is immutable'
      using errcode = '42501';
  end if;

  select * into v_context
  from public.company_knowledge_revision_context context
  where context.backend_pid = pg_backend_pid()
    and context.fact_id = new.id;

  if new.current_revision is distinct from old.current_revision
     and not (found and v_context.allow_revision_bump
              and new.current_revision = old.current_revision + 1) then
    raise exception 'company knowledge revision token is immutable'
      using errcode = '42501';
  end if;

  v_changed := row(
    new.organization_id, new.topic, new.content, new.category, new.source,
    new.review_state, new.is_active, new.policy_key, new.policy_value,
    new.created_by_account_id, new.created_by_name, new.created_by_role,
    new.created_at, new.updated_at
  ) is distinct from row(
    old.organization_id, old.topic, old.content, old.category, old.source,
    old.review_state, old.is_active, old.policy_key, old.policy_value,
    old.created_by_account_id, old.created_by_name, old.created_by_role,
    old.created_at, old.updated_at
  );

  if v_changed then
    new.current_revision := old.current_revision + 1;
  elsif found and v_context.allow_revision_bump
        and new.current_revision = old.current_revision + 1 then
    new.current_revision := old.current_revision + 1;
  else
    -- current_revision is DB-owned. A direct caller cannot forge it.
    new.current_revision := old.current_revision;
  end if;
  return new;
end;
$$;

revoke all on function public._staxis_company_knowledge_revision_number()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_company_knowledge_revision_number
  on public.company_knowledge;
create trigger trg_company_knowledge_revision_number
  before insert or update on public.company_knowledge
  for each row execute function public._staxis_company_knowledge_revision_number();

create or replace function public._staxis_company_knowledge_legacy_revision()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_context public.company_knowledge_revision_context%rowtype;
  v_action text;
begin
  select * into v_context
  from public.company_knowledge_revision_context context
  where context.backend_pid = pg_backend_pid()
    and context.fact_id = new.id;
  if found and v_context.suppress_automatic_revision then
    return new;
  end if;

  if tg_op = 'UPDATE' and new.current_revision = old.current_revision then
    return new;
  end if;
  v_action := case
    when tg_op = 'INSERT' and new.source = 'inferred' then 'intake'
    when tg_op = 'INSERT' then 'insert'
    when old.is_active and not new.is_active then 'remove'
    when old.review_state = 'unreviewed' and new.review_state = 'confirmed' then 'confirm'
    when old.content is distinct from new.content then 'edit'
    else 'legacy_update'
  end;

  perform public._staxis_append_company_knowledge_revision(
    new.organization_id,
    new.id,
    new.current_revision,
    gen_random_uuid(),
    v_action,
    null,
    null,
    case when tg_op = 'INSERT' then null else
      public._staxis_company_knowledge_snapshot_from_row(
        old, public._staxis_company_authority_rule_snapshot(old.id)
      ) end,
    public._staxis_company_knowledge_snapshot_from_row(
      new, public._staxis_company_authority_rule_snapshot(new.id)
    ),
    new.created_by_account_id,
    'legacy_service',
    left(coalesce(new.source, 'legacy_service'), 80),
    null
  );
  return new;
end;
$$;

revoke all on function public._staxis_company_knowledge_legacy_revision()
  from public, anon, authenticated, service_role;

-- Name sorts before the 0365 retire-rules trigger, so a legacy remove records
-- the projection transition first; the authority trigger records retirement
-- as the next, separately hash-chained structured-reading transition.
drop trigger if exists trg_company_knowledge_ledger on public.company_knowledge;
create trigger trg_company_knowledge_ledger
  after insert or update on public.company_knowledge
  for each row execute function public._staxis_company_knowledge_legacy_revision();

create or replace function public._staxis_company_authority_legacy_revision()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fact public.company_knowledge%rowtype;
  v_context public.company_knowledge_revision_context%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_operation_id uuid := gen_random_uuid();
  v_actor uuid;
  v_old_authority jsonb;
  v_source_fact_id uuid;
begin
  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id
    or new.source_fact_id is distinct from old.source_fact_id
  ) then
    raise exception 'company authority identity is immutable'
      using errcode = '42501';
  end if;
  v_source_fact_id := case when tg_op = 'DELETE'
    then old.source_fact_id else new.source_fact_id end;
  select * into v_fact
  from public.company_knowledge fact
  where fact.id = v_source_fact_id
  for update;
  if not found then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  if (case when tg_op = 'DELETE' then old.organization_id else new.organization_id end)
       is distinct from v_fact.organization_id then
    raise exception 'company authority organization does not match its fact'
      using errcode = '23514';
  end if;

  select * into v_context
  from public.company_knowledge_revision_context context
  where context.backend_pid = pg_backend_pid()
    and context.fact_id = v_fact.id;
  if found and v_context.suppress_automatic_revision then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  if tg_op = 'UPDATE' and row(
    old.organization_id, old.action_kind, old.threshold_cents,
    old.threshold_inclusive, old.approver_role, old.is_active,
    old.created_by_account_id, old.created_at, old.updated_at
  ) is not distinct from row(
    new.organization_id, new.action_kind, new.threshold_cents,
    new.threshold_inclusive, new.approver_role, new.is_active,
    new.created_by_account_id, new.created_at, new.updated_at
  ) then
    return new;
  end if;

  v_old_authority := case
    when tg_op = 'INSERT' then null
    else public._staxis_company_authority_row_snapshot(old) end;
  v_before := jsonb_set(
    public._staxis_company_knowledge_snapshot(v_fact.id),
    '{authorityRule}',
    coalesce(v_old_authority, 'null'::jsonb),
    true
  );
  v_actor := case when tg_op = 'DELETE' then old.created_by_account_id
    else new.created_by_account_id end;
  v_actor := coalesce(v_actor, v_fact.created_by_account_id);

  insert into public.company_knowledge_revision_context (
    backend_pid, fact_id, operation_id, action, actor_account_id,
    actor_kind, source, suppress_automatic_revision, allow_revision_bump
  ) values (
    pg_backend_pid(), v_fact.id, v_operation_id,
    'structured_reading_change', v_actor,
    'legacy_service', 'structured_reading_change', true, true
  );

  update public.company_knowledge fact
     set current_revision = fact.current_revision + 1
   where fact.id = v_fact.id
  returning * into v_fact;

  v_after := public._staxis_company_knowledge_snapshot(v_fact.id);
  perform public._staxis_append_company_knowledge_revision(
    v_fact.organization_id, v_fact.id, v_fact.current_revision,
    v_operation_id, 'structured_reading_change', null, null,
    v_before, v_after, v_actor, 'legacy_service',
    'structured_reading_change', null
  );
  delete from public.company_knowledge_revision_context context
  where context.backend_pid = pg_backend_pid() and context.fact_id = v_fact.id;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

revoke all on function public._staxis_company_authority_legacy_revision()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_company_authority_knowledge_ledger
  on public.company_authority_rules;
create trigger trg_company_authority_knowledge_ledger
  after insert or update or delete on public.company_authority_rules
  for each row execute function public._staxis_company_authority_legacy_revision();

-- Editor-policy changes and fact mutations share one organization transaction
-- lock. A revocation therefore either commits before the mutation re-check (and
-- denies it) or waits until that already-authorized mutation commits; it cannot
-- slip between the role read and the CAS write.
create or replace function public._staxis_company_access_setting_serialize()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_organization_id uuid;
begin
  if tg_op = 'UPDATE' and new.organization_id is distinct from old.organization_id then
    raise exception 'company access setting organization is immutable'
      using errcode = '42501';
  end if;
  v_organization_id := case when tg_op = 'DELETE'
    then old.organization_id else new.organization_id end;
  perform public._staxis_lock_organization(v_organization_id);
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

revoke all on function public._staxis_company_access_setting_serialize()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_company_access_settings_knowledge_serialization
  on public.company_access_settings;
create trigger trg_company_access_settings_knowledge_serialization
  before insert or update or delete on public.company_access_settings
  for each row execute function public._staxis_company_access_setting_serialize();

-- Resolve editor authority from a freshly reasserted all-authorized receipt.
-- A broad company/organization entitlement must cover every exact hotel in the
-- receipt. Property/portfolio grants cannot rewrite organization-wide policy.
create or replace function public._staxis_company_knowledge_editor_role(
  p_receipt_id uuid,
  p_actor_account_id uuid,
  p_organization_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_assertion jsonb;
  v_receipt public.authorization_scope_receipts%rowtype;
  v_role text;
  v_choice text;
begin
  v_assertion := public.staxis_assert_authorization_scope_receipt(
    p_receipt_id, p_actor_account_id
  );
  if coalesce((v_assertion->>'ok')::boolean, false) is not true then
    return null;
  end if;

  select * into v_receipt
  from public.authorization_scope_receipts receipt
  where receipt.id = p_receipt_id
    and receipt.account_id = p_actor_account_id
    and receipt.organization_id = p_organization_id
  for share;
  if not found or v_receipt.selector_type <> 'all_authorized'
     or v_receipt.selected_property_ids is distinct from v_receipt.authorized_property_ids then
    return null;
  end if;

  with candidates as (
    select entitlement->>'entitlementId' as entitlement_id,
      case
        when entitlement->>'scopeType' = 'company'
         and entitlement->>'staxisRole' in ('owner', 'vp', 'finance')
          then entitlement->>'staxisRole'
        when entitlement->>'scopeType' = 'organization'
         and entitlement->>'accessProfile' = 'organization_owner' then 'owner'
        when entitlement->>'scopeType' = 'organization'
         and entitlement->>'accessProfile' = 'organization_admin' then 'vp'
        else null
      end as role,
      entitlement->>'propertyId' as property_id
    from jsonb_array_elements(v_receipt.provenance->'entitlements') entitlement
  ), complete as (
    select candidate.entitlement_id, candidate.role
    from candidates candidate
    where candidate.role is not null
    group by candidate.entitlement_id, candidate.role
    having count(distinct candidate.property_id)
      = cardinality(v_receipt.authorized_property_ids)
  )
  select complete.role into v_role
  from complete
  order by case complete.role when 'owner' then 1 when 'vp' then 2 else 3 end
  limit 1;
  if v_role is null then return null; end if;

  select setting.setting_value into v_choice
  from public.company_access_settings setting
  where setting.organization_id = p_organization_id
    and setting.setting_key = 'rulebook_editors';
  v_choice := coalesce(v_choice, 'owner_and_vp');

  if v_role = 'owner'
     or (v_role = 'vp' and v_choice in ('owner_and_vp', 'company_scope'))
     or (v_role = 'finance' and v_choice = 'company_scope') then
    return v_role;
  end if;
  return null;
exception when others then
  return null;
end;
$$;

revoke all on function public._staxis_company_knowledge_editor_role(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.staxis_apply_company_knowledge_mutation_v1(
  p_actor_account_id uuid,
  p_scope_receipt_id uuid,
  p_organization_id uuid,
  p_action text,
  p_fact_id uuid default null,
  p_expected_revision bigint default null,
  p_related_fact_id uuid default null,
  p_related_expected_revision bigint default null,
  p_topic text default null,
  p_content text default null,
  p_category text default null,
  p_source text default null,
  p_created_by_name text default null,
  p_created_by_role text default null,
  p_policy_key text default null,
  p_policy_value text default null,
  p_authority_action_kind text default null,
  p_authority_threshold_cents bigint default null,
  p_authority_threshold_inclusive boolean default null,
  p_authority_approver_role text default null,
  p_request_id text default null,
  p_cap integer default 150
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text;
  v_operation_id uuid := gen_random_uuid();
  v_fact public.company_knowledge%rowtype;
  v_related public.company_knowledge%rowtype;
  v_before jsonb;
  v_related_before jsonb;
  v_after jsonb;
  v_related_after jsonb;
  v_fact_id uuid;
  v_live_count integer;
  v_has_authority boolean;
begin
  if p_actor_account_id is null or p_scope_receipt_id is null
     or p_organization_id is null
     or p_action is null
     or p_action not in ('intake', 'upsert_confirmed', 'confirm', 'edit', 'remove', 'merge')
     or (p_request_id is not null and char_length(p_request_id) not between 1 and 200)
     or p_cap not between 1 and 500 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_request');
  end if;
  if (p_policy_key is null) <> (p_policy_value is null) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_request');
  end if;
  v_has_authority := p_authority_action_kind is not null
    or p_authority_threshold_cents is not null
    or p_authority_threshold_inclusive is not null
    or p_authority_approver_role is not null;
  if v_has_authority and (
    p_authority_action_kind is null or p_authority_threshold_cents is null
    or p_authority_threshold_inclusive is null or p_authority_approver_role is null
  ) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_request');
  end if;

  perform public._staxis_lock_organization(p_organization_id);
  v_role := public._staxis_company_knowledge_editor_role(
    p_scope_receipt_id, p_actor_account_id, p_organization_id
  );
  if v_role is null then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;

  if p_action in ('intake', 'upsert_confirmed') then
    if coalesce(btrim(p_topic), '') = '' or coalesce(btrim(p_content), '') = ''
       or p_category not in ('standards', 'money', 'vendors', 'people', 'guests')
       or (p_action = 'intake' and p_source <> 'inferred')
       or (p_action = 'upsert_confirmed' and p_source <> 'explicit_user') then
      return jsonb_build_object('ok', false, 'reason', 'invalid_request');
    end if;

    select * into v_fact
    from public.company_knowledge fact
    where fact.organization_id = p_organization_id
      and fact.topic = p_topic
      and fact.is_active
    for update;

    if found then
      if p_action = 'upsert_confirmed' then
        return jsonb_build_object(
          'ok', false, 'reason', 'conflict', 'factId', v_fact.id,
          'actualRevision', v_fact.current_revision
        );
      end if;
      if v_fact.review_state = 'confirmed' then
        return jsonb_build_object(
          'ok', true, 'action', 'skipped', 'factId', v_fact.id,
          'currentRevision', v_fact.current_revision
        );
      end if;
      if v_fact.content = p_content and v_fact.category = p_category
         and v_fact.source = 'inferred'
         and v_fact.created_by_account_id is not distinct from p_actor_account_id
         and v_fact.created_by_name is not distinct from p_created_by_name
         and v_fact.created_by_role is not distinct from p_created_by_role then
        return jsonb_build_object(
          'ok', true, 'action', 'skipped', 'factId', v_fact.id,
          'currentRevision', v_fact.current_revision
        );
      end if;
      return jsonb_build_object(
        'ok', false, 'reason', 'conflict', 'factId', v_fact.id,
        'actualRevision', v_fact.current_revision
      );
    end if;

    select count(*) into v_live_count
    from public.company_knowledge fact
    where fact.organization_id = p_organization_id and fact.is_active;
    if v_live_count >= p_cap then
      return jsonb_build_object('ok', true, 'action', 'company_full');
    end if;

    v_fact_id := gen_random_uuid();
    insert into public.company_knowledge_revision_context (
      backend_pid, fact_id, operation_id, action, actor_account_id,
      actor_kind, source, request_id, suppress_automatic_revision
    ) values (
      pg_backend_pid(), v_fact_id, v_operation_id,
      case when p_action = 'intake' then 'intake' else 'insert' end,
      p_actor_account_id, 'account', p_source, p_request_id, true
    );
    insert into public.company_knowledge (
      id, organization_id, topic, content, category, source, review_state,
      policy_key, policy_value, created_by_account_id, created_by_name,
      created_by_role
    ) values (
      v_fact_id, p_organization_id, p_topic, p_content, p_category, p_source,
      case when p_action = 'intake' then 'unreviewed' else 'confirmed' end,
      case when p_action = 'intake' then null else p_policy_key end,
      case when p_action = 'intake' then null else p_policy_value end,
      p_actor_account_id, p_created_by_name, p_created_by_role
    ) returning * into v_fact;

    if p_action = 'upsert_confirmed' and v_has_authority then
      insert into public.company_authority_rules (
        organization_id, action_kind, threshold_cents, threshold_inclusive,
        approver_role, source_fact_id, created_by_account_id
      ) values (
        p_organization_id, p_authority_action_kind,
        p_authority_threshold_cents, p_authority_threshold_inclusive,
        p_authority_approver_role, v_fact.id, p_actor_account_id
      );
    end if;
    v_after := public._staxis_company_knowledge_snapshot(v_fact.id);
    perform public._staxis_append_company_knowledge_revision(
      p_organization_id, v_fact.id, v_fact.current_revision,
      v_operation_id,
      case when p_action = 'intake' then 'intake' else 'insert' end,
      null, null, null, v_after, p_actor_account_id, 'account',
      p_source, p_request_id
    );
    delete from public.company_knowledge_revision_context context
     where context.backend_pid = pg_backend_pid() and context.fact_id = v_fact.id;
    return jsonb_build_object(
      'ok', true, 'action', 'inserted', 'operationId', v_operation_id,
      'factId', v_fact.id, 'currentRevision', v_fact.current_revision
    );
  end if;

  -- Authorization was established before the first fact lookup. Missing and
  -- foreign IDs therefore share the same non-enumerating outcome.
  if p_fact_id is null or p_expected_revision is null or p_expected_revision < 1 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_request');
  end if;

  if p_action = 'merge' then
    if p_related_fact_id is null or p_related_fact_id = p_fact_id
       or p_related_expected_revision is null or p_related_expected_revision < 1 then
      return jsonb_build_object('ok', false, 'reason', 'invalid_request');
    end if;
    perform 1 from public.company_knowledge fact
      where fact.organization_id = p_organization_id
        and fact.id in (p_fact_id, p_related_fact_id)
      order by fact.id for update;
  end if;

  select * into v_fact
  from public.company_knowledge fact
  where fact.organization_id = p_organization_id
    and fact.id = p_fact_id and fact.is_active
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_fact.current_revision <> p_expected_revision then
    return jsonb_build_object(
      'ok', false, 'reason', 'conflict', 'factId', v_fact.id,
      'actualRevision', v_fact.current_revision
    );
  end if;

  if p_action = 'merge' then
    select * into v_related
    from public.company_knowledge fact
    where fact.organization_id = p_organization_id
      and fact.id = p_related_fact_id and fact.is_active;
    if not found then
      return jsonb_build_object('ok', false, 'reason', 'not_found');
    end if;
    if v_related.current_revision <> p_related_expected_revision then
      return jsonb_build_object(
        'ok', false, 'reason', 'conflict', 'factId', v_related.id,
        'actualRevision', v_related.current_revision
      );
    end if;
    if v_fact.review_state <> 'confirmed' then
      return jsonb_build_object('ok', false, 'reason', 'invalid_request');
    end if;
  end if;

  if p_action in ('confirm', 'edit', 'merge') then
    if p_action <> 'merge' and coalesce(btrim(p_content), '') = '' then
      return jsonb_build_object('ok', false, 'reason', 'invalid_request');
    end if;
    if p_category is not null
       and p_category not in ('standards', 'money', 'vendors', 'people', 'guests') then
      return jsonb_build_object('ok', false, 'reason', 'invalid_request');
    end if;
  end if;

  v_before := public._staxis_company_knowledge_snapshot(v_fact.id);
  insert into public.company_knowledge_revision_context (
    backend_pid, fact_id, operation_id, action, actor_account_id,
    actor_kind, source, request_id, suppress_automatic_revision,
    allow_revision_bump
  ) values (
    pg_backend_pid(), v_fact.id, v_operation_id, p_action,
    p_actor_account_id, 'account',
    case when p_action = 'edit' or p_action = 'merge' then 'correction'
         else 'explicit_user' end,
    p_request_id, true, true
  );

  if p_action = 'remove' then
    update public.company_knowledge fact
       set is_active = false,
           created_by_account_id = p_actor_account_id,
           created_by_name = coalesce(p_created_by_name, fact.created_by_name),
           created_by_role = coalesce(p_created_by_role, fact.created_by_role),
           current_revision = fact.current_revision + 1
     where fact.id = v_fact.id
    returning * into v_fact;
  elsif p_action = 'merge' then
    v_related_before := public._staxis_company_knowledge_snapshot(v_related.id);
    insert into public.company_knowledge_revision_context (
      backend_pid, fact_id, operation_id, action, actor_account_id,
      actor_kind, source, request_id, suppress_automatic_revision,
      allow_revision_bump
    ) values (
      pg_backend_pid(), v_related.id, v_operation_id, 'merge',
      p_actor_account_id, 'account', 'correction', p_request_id, true, true
    );
    update public.company_knowledge fact
       set content = v_related.content,
           category = v_related.category,
           source = 'correction',
           review_state = 'confirmed',
           policy_key = p_policy_key,
           policy_value = p_policy_value,
           created_by_account_id = p_actor_account_id,
           created_by_name = p_created_by_name,
           created_by_role = p_created_by_role,
           current_revision = fact.current_revision + 1
     where fact.id = v_fact.id
    returning * into v_fact;
    update public.company_knowledge fact
       set is_active = false,
           created_by_account_id = p_actor_account_id,
           created_by_name = coalesce(p_created_by_name, fact.created_by_name),
           created_by_role = coalesce(p_created_by_role, fact.created_by_role),
           current_revision = fact.current_revision + 1
     where fact.id = v_related.id
    returning * into v_related;
  else
    update public.company_knowledge fact
       set content = p_content,
           category = coalesce(p_category, fact.category),
           source = case when p_action = 'edit' then 'correction' else 'explicit_user' end,
           review_state = 'confirmed',
           policy_key = p_policy_key,
           policy_value = p_policy_value,
           created_by_account_id = p_actor_account_id,
           created_by_name = p_created_by_name,
           created_by_role = p_created_by_role,
           current_revision = fact.current_revision + 1
     where fact.id = v_fact.id
    returning * into v_fact;
  end if;

  if p_action in ('confirm', 'edit', 'merge') then
    update public.company_authority_rules rule
       set is_active = false, updated_at = clock_timestamp()
     where rule.organization_id = p_organization_id
       and rule.source_fact_id = v_fact.id and rule.is_active;
    if v_has_authority then
      insert into public.company_authority_rules (
        organization_id, action_kind, threshold_cents, threshold_inclusive,
        approver_role, source_fact_id, created_by_account_id
      ) values (
        p_organization_id, p_authority_action_kind,
        p_authority_threshold_cents, p_authority_threshold_inclusive,
        p_authority_approver_role, v_fact.id, p_actor_account_id
      );
    end if;
  end if;

  v_after := public._staxis_company_knowledge_snapshot(v_fact.id);
  perform public._staxis_append_company_knowledge_revision(
    p_organization_id, v_fact.id, v_fact.current_revision,
    v_operation_id, p_action,
    case when p_action = 'merge' then 'keep' else null end,
    case when p_action = 'merge' then v_related.id else null end,
    v_before, v_after, p_actor_account_id, 'account',
    case when p_action = 'edit' or p_action = 'merge' then 'correction'
         else 'explicit_user' end,
    p_request_id
  );

  if p_action = 'merge' then
    v_related_after := public._staxis_company_knowledge_snapshot(v_related.id);
    perform public._staxis_append_company_knowledge_revision(
      p_organization_id, v_related.id, v_related.current_revision,
      v_operation_id, 'merge', 'drop', v_fact.id,
      v_related_before, v_related_after, p_actor_account_id, 'account',
      'correction', p_request_id
    );
    delete from public.company_knowledge_revision_context context
     where context.backend_pid = pg_backend_pid()
       and context.fact_id = v_related.id;
  end if;
  delete from public.company_knowledge_revision_context context
   where context.backend_pid = pg_backend_pid() and context.fact_id = v_fact.id;

  return jsonb_build_object(
    'ok', true, 'action', p_action, 'operationId', v_operation_id,
    'factId', v_fact.id, 'currentRevision', v_fact.current_revision,
    'relatedFactId', case when p_action = 'merge' then v_related.id else null end,
    'relatedCurrentRevision', case when p_action = 'merge'
      then v_related.current_revision else null end
  );
exception when unique_violation then
  return jsonb_build_object('ok', false, 'reason', 'conflict');
when others then
  raise;
end;
$$;

revoke all on function public.staxis_apply_company_knowledge_mutation_v1(
  uuid, uuid, uuid, text, uuid, bigint, uuid, bigint, text, text, text, text,
  text, text, text, text, text, bigint, boolean, text, text, integer
) from public, anon, authenticated;
grant execute on function public.staxis_apply_company_knowledge_mutation_v1(
  uuid, uuid, uuid, text, uuid, bigint, uuid, bigint, text, text, text, text,
  text, text, text, text, text, bigint, boolean, text, text, integer
) to service_role;

create or replace function public.staxis_company_knowledge_ledger_capability()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'ok', true,
    'schemaVersion', state.schema_version,
    'rolloutMode', state.rollout_mode
  )
  from public.company_knowledge_revision_ledger_state state
  where state.singleton;
$$;

revoke all on function public.staxis_company_knowledge_ledger_capability()
  from public, anon, authenticated;
grant execute on function public.staxis_company_knowledge_ledger_capability()
  to service_role;

create or replace function public.staxis_finalize_company_knowledge_revision_ledger(
  p_expected_schema_version text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_state public.company_knowledge_revision_ledger_state%rowtype;
begin
  select * into v_state
  from public.company_knowledge_revision_ledger_state state
  where state.singleton
  for update;
  if p_expected_schema_version is distinct from v_state.schema_version then
    return jsonb_build_object('ok', false, 'reason', 'version_mismatch');
  end if;
  if v_state.rollout_mode = 'enforced' then
    return jsonb_build_object(
      'ok', true, 'schemaVersion', v_state.schema_version,
      'rolloutMode', v_state.rollout_mode, 'alreadyFinalized', true
    );
  end if;

  update public.company_knowledge_revision_ledger_state
     set rollout_mode = 'enforced', enforced_at = clock_timestamp()
   where singleton;
  execute 'revoke insert, update, delete on public.company_knowledge from service_role';
  execute 'revoke insert, update, delete on public.company_authority_rules from service_role';
  execute 'revoke execute on function public.staxis_store_company_fact(uuid, text, text, text, text, uuid, text, text, int) from service_role';
  return jsonb_build_object(
    'ok', true, 'schemaVersion', v_state.schema_version,
    'rolloutMode', 'enforced', 'alreadyFinalized', false
  );
end;
$$;

revoke all on function public.staxis_finalize_company_knowledge_revision_ledger(text)
  from public, anon, authenticated;
grant execute on function public.staxis_finalize_company_knowledge_revision_ledger(text)
  to service_role;

create or replace function public._staxis_company_knowledge_revision_immutable()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  raise exception 'company knowledge revisions are immutable'
    using errcode = '42501';
end;
$$;

revoke all on function public._staxis_company_knowledge_revision_immutable()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_company_knowledge_revisions_immutable
  on public.company_knowledge_revisions;
create trigger trg_company_knowledge_revisions_immutable
  before update or delete on public.company_knowledge_revisions
  for each row execute function public._staxis_company_knowledge_revision_immutable();

alter table public.company_knowledge_revisions enable row level security;
alter table public.company_knowledge_revision_heads enable row level security;
alter table public.company_knowledge_revision_context enable row level security;
alter table public.company_knowledge_revision_ledger_state enable row level security;

revoke all on public.company_knowledge_revisions
  from public, anon, authenticated, service_role;
revoke all on public.company_knowledge_revision_heads
  from public, anon, authenticated, service_role;
revoke all on public.company_knowledge_revision_context
  from public, anon, authenticated, service_role;
revoke all on public.company_knowledge_revision_ledger_state
  from public, anon, authenticated, service_role;
grant select on public.company_knowledge_revisions to service_role;

drop policy if exists company_knowledge_revisions_deny_browser
  on public.company_knowledge_revisions;
create policy company_knowledge_revisions_deny_browser
  on public.company_knowledge_revisions
  for all to anon, authenticated using (false) with check (false);

-- Reassert explicit least privilege without reopening a previously finalized
-- environment when an idempotent migration runner executes 0404 again.
revoke all on public.company_knowledge from service_role;
grant select on public.company_knowledge to service_role;
revoke all on public.company_authority_rules from service_role;
grant select on public.company_authority_rules to service_role;
do $$
begin
  if exists (
    select 1 from public.company_knowledge_revision_ledger_state state
    where state.singleton and state.rollout_mode = 'compat'
  ) then
    -- Legacy application paths insert and soft-delete with UPDATE. Physical
    -- DELETE was never a supported rulebook operation and cannot be journaled as
    -- a live projection, so do not carry 0365's over-broad grant into rollout.
    execute 'grant insert, update on public.company_knowledge to service_role';
    execute 'grant insert, update, delete on public.company_authority_rules to service_role';
    execute 'grant execute on function public.staxis_store_company_fact(uuid, text, text, text, text, uuid, text, text, integer) to service_role';
  else
    execute 'revoke execute on function public.staxis_store_company_fact(uuid, text, text, text, text, uuid, text, text, integer) from service_role';
  end if;
end;
$$;

insert into public.applied_migrations (version, description)
values ('0404', 'append-only company knowledge revision ledger and CAS writer')
on conflict (version) do nothing;

notify pgrst, 'reload schema';
