-- 0469 — Staxis shared source, admission, and lifecycle foundation.
--
-- This is an additive, service-written ledger. It does not seed source
-- categories, copy a PMS payload, or create a second task/work-order system.
-- Existing findings/actions/conversations remain authoritative; this migration
-- only adds nullable links and immutable proof around newly admitted rows.
--
-- The only trusted top-level source classes are app_owned and pms_report. A
-- definition owns its claim scope, owner snapshot, authority, precedence, and
-- quality requirements. There is deliberately no global "human > PMS" order.
-- If two facts overlap without an explicit definition/claim scope, admission
-- cannot succeed.

begin;

-- The composite references below make a property mismatch a database error,
-- rather than an application convention. Existing rows are untouched.
create unique index if not exists findings_id_property_uidx
  on public.findings (id, property_id);
create unique index if not exists finding_actions_id_property_uidx
  on public.finding_actions (id, property_id);
create unique index if not exists agent_pending_actions_id_property_uidx
  on public.agent_pending_actions (id, property_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Definitions — registered producer/category claims.
-- ───────────────────────────────────────────────────────────────────────────
-- @rls: service-role-only — definitions are registered/reviewed by trusted
-- ingestion; no direct browser read path (the API applies exact-hotel auth).
create table if not exists public.staxis_source_definitions (
  id                         uuid primary key default gen_random_uuid(),
  property_id                uuid not null references public.properties(id) on delete cascade,
  source_class               text not null check (source_class in ('app_owned', 'pms_report')),
  producer_key               text not null check (char_length(btrim(producer_key)) between 1 and 120),
  category                   text not null check (char_length(btrim(category)) between 1 and 120),
  entity_kind                text not null check (char_length(btrim(entity_kind)) between 1 and 120),
  claim_scope                text not null check (char_length(btrim(claim_scope)) between 1 and 200),
  ownership_claim            jsonb not null default '{}'::jsonb
                             check (jsonb_typeof(ownership_claim) = 'object'),
  owner_kind                 text not null check (char_length(btrim(owner_kind)) between 1 and 80),
  owner_label                text check (owner_label is null or char_length(btrim(owner_label)) between 1 and 200),
  owner_role                 text check (owner_role is null or char_length(btrim(owner_role)) between 1 and 120),
  authority_level            integer not null check (authority_level >= 0 and authority_level <= 100),
  precedence_rank            integer not null check (precedence_rank >= 0 and precedence_rank <= 100),
  freshness_required         boolean not null default true check (freshness_required is true),
  -- Every reviewed v1 definition has a positive limit, even when the
  -- definition marks freshness as not required.  This keeps the safe
  -- projection deterministic for strict clients.
  freshness_max_age_seconds  integer not null check (freshness_max_age_seconds > 0),
  completeness_required      text not null default 'complete'
                             check (completeness_required in ('complete', 'partial', 'unknown')),
  reviewed_at                timestamptz not null,
  created_at                 timestamptz not null default now(),
  constraint staxis_source_definitions_freshness_rule check (
    freshness_required = false or freshness_max_age_seconds is not null
  ),
  constraint staxis_source_definitions_claim_owner_rule check (
    ownership_claim ->> 'scope' = claim_scope
    and ownership_claim ->> 'owner' = owner_kind
  ),
  constraint staxis_source_definitions_owner_class_rule check (
    (source_class = 'pms_report' and owner_kind = 'pms')
    or (source_class = 'app_owned' and owner_kind in ('app', 'hotel', 'company', 'staxis', 'human', 'system'))
  ),
  constraint staxis_source_definitions_owner_snapshot_rule check (
    char_length(btrim(coalesce(owner_label, ''))) > 0
    or char_length(btrim(coalesce(owner_role, ''))) > 0
  ),
  constraint staxis_source_definitions_id_property_uq unique (id, property_id)
);
-- A corrected reviewed definition is a new immutable version for the same
-- logical scope; only the durable id is authoritative for admission.
alter table public.staxis_source_definitions
  drop constraint if exists staxis_source_definitions_natural_uq;
create index if not exists staxis_source_definitions_scope_idx
  on public.staxis_source_definitions (property_id, source_class, producer_key, category, entity_kind, claim_scope, reviewed_at desc);

comment on table public.staxis_source_definitions is
  'Property-scoped source/category registrations. Only app_owned and pms_report are trusted classes; claim scope and precedence are definition-owned and never globally ordered.';
comment on column public.staxis_source_definitions.ownership_claim is
  'Structured ownership proof (scope/owner plus producer-specific claims). It is metadata, not a private source payload.';

-- Definitions are append-only. A corrected definition gets a new id/review;
-- changing an authority or freshness rule would rewrite historical truth.
create or replace function public.staxis_source_definition_immutable()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'staxis_source_definitions are immutable; register a new reviewed definition instead'
    using errcode = 'check_violation';
end;
$$;

drop trigger if exists staxis_source_definitions_immutable_tg
  on public.staxis_source_definitions;
create trigger staxis_source_definitions_immutable_tg
  before update or delete on public.staxis_source_definitions
  for each row execute function public.staxis_source_definition_immutable();

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Receipts — safe provenance, no attachment path or private payload.
-- ───────────────────────────────────────────────────────────────────────────
-- @rls: service-role-only — direct receipt reads are denied; the bounded view
-- below exposes only safe receipt metadata through the exact-hotel gate.
create table if not exists public.staxis_source_receipts (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references public.properties(id) on delete cascade,
  source_definition_id  uuid not null,
  source_reference      text not null check (
    char_length(btrim(source_reference)) between 1 and 300
    and source_reference !~ '[\\/]'
    and source_reference !~* '(^|:)https?://'
    and source_reference !~* '(attachment|storage|bucket|raw[_-]?path)'
  ),
  source_hash           text not null check (source_hash ~ '^[a-f0-9]{64}$'),
  receipt_id            text check (
    receipt_id is null or (
      char_length(btrim(receipt_id)) between 1 and 200
      and receipt_id !~ '[\\/]'
      and receipt_id !~* '(^|:)https?://'
    )
  ),
  -- DB-derived digest of the immutable receipt envelope. The caller cannot
  -- forge the value used for idempotency or the safe projection.
  receipt_hash          text not null default '',
  as_of                 timestamptz not null,
  observed_at           timestamptz not null,
  received_at           timestamptz not null default now(),
  completeness          text not null check (completeness in ('complete', 'partial', 'unknown')),
  completeness_reason   text,
  freshness             text not null default 'unknown' check (freshness in ('fresh', 'stale', 'unknown')),
  freshness_checked_at  timestamptz,
  created_at            timestamptz not null default now(),
  constraint staxis_source_receipts_id_property_uq unique (id, property_id),
  constraint staxis_source_receipts_time_order check (
    as_of <= observed_at and observed_at <= received_at
  ),
  constraint staxis_source_receipts_completeness_reason check (
    (completeness = 'complete' and completeness_reason is null)
    or (completeness <> 'complete' and char_length(btrim(coalesce(completeness_reason, ''))) between 1 and 500)
  ),
  constraint staxis_source_receipts_hash_shape check (receipt_hash = '' or receipt_hash ~ '^[a-f0-9]{64}$')
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'staxis_source_receipts_definition_property_fk' and conrelid = 'public.staxis_source_receipts'::regclass) then
    alter table public.staxis_source_receipts
      add constraint staxis_source_receipts_definition_property_fk
      foreign key (source_definition_id, property_id)
      references public.staxis_source_definitions (id, property_id)
      on delete restrict;
  end if;
end;
$$;

create unique index if not exists staxis_source_receipts_idempotency_uq
  on public.staxis_source_receipts (property_id, source_hash, coalesce(receipt_id, ''));
create unique index if not exists staxis_source_receipts_receipt_id_uq
  on public.staxis_source_receipts (property_id, receipt_id)
  where receipt_id is not null;
create index if not exists staxis_source_receipts_property_observed_idx
  on public.staxis_source_receipts (property_id, observed_at desc);

comment on table public.staxis_source_receipts is
  'Immutable, safe receipt envelope. It carries no PMS attachment path or raw payload; source_reference is an opaque non-path token and receipt_hash is DB-derived.';

create or replace function public.staxis_source_receipt_immutable()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_definition public.staxis_source_definitions%rowtype;
  v_age_seconds numeric;
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'staxis_source_receipts are immutable'
      using errcode = 'check_violation';
  end if;

  select * into strict v_definition
    from public.staxis_source_definitions definition
   where definition.id = new.source_definition_id
     and definition.property_id = new.property_id;

  if v_definition.reviewed_at is null then
    raise exception 'source definition must be reviewed before a receipt can be recorded'
      using errcode = 'check_violation';
  end if;
  if v_definition.reviewed_at > clock_timestamp() + interval '5 minutes' then
    raise exception 'source definition review cannot be materially future-dated'
      using errcode = 'check_violation';
  end if;

  if new.as_of > new.observed_at or new.observed_at > new.received_at then
    raise exception 'source receipt timestamps must satisfy as_of <= observed_at <= received_at'
      using errcode = 'check_violation';
  end if;
  if new.observed_at > clock_timestamp() + interval '5 minutes' then
    raise exception 'source receipt observed_at cannot be materially in the future'
      using errcode = 'check_violation';
  end if;
  if new.received_at > clock_timestamp() + interval '5 minutes' then
    raise exception 'source receipt received_at cannot be materially in the future'
      using errcode = 'check_violation';
  end if;

  v_age_seconds := greatest(0, extract(epoch from (clock_timestamp() - new.as_of)));
  new.freshness_checked_at := new.observed_at;
  new.freshness := case
    when not v_definition.freshness_required then 'fresh'
    when v_definition.freshness_max_age_seconds is not null
      and v_age_seconds <= v_definition.freshness_max_age_seconds then 'fresh'
    when v_definition.freshness_required then 'stale'
    else 'unknown'
  end;
  new.receipt_hash := encode(
    sha256(convert_to(
      new.property_id::text || ':' || new.source_definition_id::text || ':' ||
      new.source_reference || ':' || coalesce(new.receipt_id, '') || ':' ||
      new.source_hash || ':' || new.as_of::text || ':' || new.observed_at::text || ':' ||
      new.received_at::text,
      'UTF8'
    )),
    'hex'
  );
  return new;
end;
$$;

drop trigger if exists staxis_source_receipts_immutable_tg
  on public.staxis_source_receipts;
create trigger staxis_source_receipts_immutable_tg
  before insert or update or delete on public.staxis_source_receipts
  for each row execute function public.staxis_source_receipt_immutable();

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Facts — immutable values linked to one receipt/definition.
-- ───────────────────────────────────────────────────────────────────────────
-- @rls: service-role-only — `value` is never selected by the safe
-- projection, which prevents a private PMS payload from reaching the browser.
create table if not exists public.staxis_source_facts (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references public.properties(id) on delete cascade,
  source_definition_id  uuid not null,
  source_receipt_id     uuid not null,
  entity_kind           text not null check (char_length(btrim(entity_kind)) between 1 and 120),
  entity_id             text not null check (char_length(btrim(entity_id)) between 1 and 240),
  entity_label          text check (entity_label is null or char_length(btrim(entity_label)) between 1 and 200),
  effective_at          timestamptz not null,
  as_of                 timestamptz not null,
  observed_at           timestamptz not null,
  received_at           timestamptz not null,
  expires_at            timestamptz,
  completeness          text not null check (completeness in ('complete', 'partial', 'unknown')),
  completeness_reason   text,
  freshness             text not null default 'unknown' check (freshness in ('fresh', 'stale', 'unknown')),
  freshness_max_age_seconds integer,
  freshness_checked_at  timestamptz,
  value                 jsonb not null check (jsonb_typeof(value) = 'object'),
  -- DB-derived from the receipt, identity, effective time, and canonical JSON.
  fingerprint           text not null default '',
  supersedes_id         uuid,
  owner_kind            text not null,
  owner_label           text check (owner_label is null or char_length(btrim(owner_label)) between 1 and 200),
  owner_role            text check (owner_role is null or char_length(btrim(owner_role)) between 1 and 120),
  authority_level       integer not null check (authority_level >= 0 and authority_level <= 100),
  precedence_rank       integer not null check (precedence_rank >= 0 and precedence_rank <= 100),
  idempotency_key       text not null default '',
  created_at            timestamptz not null default now(),
  constraint staxis_source_facts_id_property_uq unique (id, property_id),
  constraint staxis_source_facts_time_order check (
    as_of <= observed_at and observed_at <= received_at
  ),
  constraint staxis_source_facts_expiry check (
    expires_at is null or expires_at > observed_at
  ),
  constraint staxis_source_facts_completeness_reason check (
    (completeness = 'complete' and completeness_reason is null)
    or (completeness <> 'complete' and char_length(btrim(coalesce(completeness_reason, ''))) between 1 and 500)
  ),
  constraint staxis_source_facts_hash_shape check (
    fingerprint = '' or fingerprint ~ '^[a-f0-9]{64}$'
  )
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'staxis_source_facts_definition_property_fk' and conrelid = 'public.staxis_source_facts'::regclass) then
    alter table public.staxis_source_facts
      add constraint staxis_source_facts_definition_property_fk
      foreign key (source_definition_id, property_id)
      references public.staxis_source_definitions (id, property_id)
      on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'staxis_source_facts_receipt_property_fk' and conrelid = 'public.staxis_source_facts'::regclass) then
    alter table public.staxis_source_facts
      add constraint staxis_source_facts_receipt_property_fk
      foreign key (source_receipt_id, property_id)
      references public.staxis_source_receipts (id, property_id)
      on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'staxis_source_facts_supersedes_property_fk' and conrelid = 'public.staxis_source_facts'::regclass) then
    alter table public.staxis_source_facts
      add constraint staxis_source_facts_supersedes_property_fk
      foreign key (supersedes_id, property_id)
      references public.staxis_source_facts (id, property_id)
      on delete restrict;
  end if;
end;
$$;

create unique index if not exists staxis_source_facts_idempotency_uq
  on public.staxis_source_facts (property_id, idempotency_key);
create unique index if not exists staxis_source_facts_natural_uq
  on public.staxis_source_facts (property_id, source_receipt_id, entity_kind, entity_id, effective_at);
create unique index if not exists staxis_source_facts_fingerprint_uq
  on public.staxis_source_facts (property_id, fingerprint)
  where fingerprint <> '';
create index if not exists staxis_source_facts_entity_idx
  on public.staxis_source_facts (property_id, entity_kind, entity_id, effective_at desc);

comment on table public.staxis_source_facts is
  'Immutable hotel/entity facts with same-property receipt and definition FKs. The JSON value is service-only; fingerprints and idempotency are DB-derived.';

create or replace function public.staxis_source_fact_immutable()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_receipt public.staxis_source_receipts%rowtype;
  v_definition public.staxis_source_definitions%rowtype;
  v_previous public.staxis_source_facts%rowtype;
  v_age_seconds numeric;
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'staxis_source_facts are immutable'
      using errcode = 'check_violation';
  end if;

  select * into strict v_receipt
    from public.staxis_source_receipts receipt
   where receipt.id = new.source_receipt_id
     and receipt.property_id = new.property_id;
  select * into strict v_definition
    from public.staxis_source_definitions definition
   where definition.id = new.source_definition_id
     and definition.property_id = new.property_id;

  if v_definition.reviewed_at is null then
    raise exception 'source definition must be reviewed before a fact can be recorded'
      using errcode = 'check_violation';
  end if;
  if v_definition.reviewed_at > clock_timestamp() + interval '5 minutes' then
    raise exception 'source definition review cannot be materially future-dated'
      using errcode = 'check_violation';
  end if;

  if v_receipt.source_definition_id <> new.source_definition_id then
    raise exception 'source fact receipt and definition do not match'
      using errcode = 'foreign_key_violation';
  end if;
  if v_definition.entity_kind <> new.entity_kind then
    raise exception 'source fact entity kind does not match its reviewed definition'
      using errcode = 'check_violation';
  end if;
  if new.as_of <> v_receipt.as_of
     or new.observed_at <> v_receipt.observed_at
     or new.received_at <> v_receipt.received_at
  then
    raise exception 'source fact timestamps must match its immutable receipt'
      using errcode = 'check_violation';
  end if;
  if new.as_of > new.observed_at or new.observed_at > new.received_at then
    raise exception 'source fact timestamps must satisfy as_of <= observed_at <= received_at'
      using errcode = 'check_violation';
  end if;
  if new.expires_at is not null and new.expires_at <= new.observed_at then
    raise exception 'source fact expires_at must be after observed_at'
      using errcode = 'check_violation';
  end if;

  v_age_seconds := greatest(0, extract(epoch from (clock_timestamp() - new.as_of)));
  new.freshness_max_age_seconds := v_definition.freshness_max_age_seconds;
  new.freshness_checked_at := new.observed_at;
  new.freshness := case
    when not v_definition.freshness_required then 'fresh'
    when v_definition.freshness_max_age_seconds is not null
      and v_age_seconds <= v_definition.freshness_max_age_seconds then 'fresh'
    when v_definition.freshness_required then 'stale'
    else 'unknown'
  end;
  new.owner_kind := v_definition.owner_kind;
  new.owner_label := v_definition.owner_label;
  new.owner_role := v_definition.owner_role;
  new.authority_level := v_definition.authority_level;
  new.precedence_rank := v_definition.precedence_rank;
  new.fingerprint := encode(sha256(convert_to(
    new.property_id::text || ':' || new.source_receipt_id::text || ':' ||
    new.source_definition_id::text || ':' || new.entity_kind || ':' ||
    new.entity_id || ':' || new.effective_at::text || ':' || new.as_of::text || ':' ||
    new.value::text,
    'UTF8'
  )), 'hex');
  new.idempotency_key := new.source_receipt_id::text || ':' || new.entity_kind || ':' ||
    new.entity_id || ':' || new.effective_at::text || ':' || new.fingerprint;

  if new.supersedes_id is not null then
    select * into strict v_previous
      from public.staxis_source_facts previous_fact
     where previous_fact.id = new.supersedes_id
       and previous_fact.property_id = new.property_id;
    if v_previous.entity_kind <> new.entity_kind
       or v_previous.entity_id <> new.entity_id
       or v_previous.source_definition_id <> new.source_definition_id
       or new.effective_at <= v_previous.effective_at
    then
      raise exception 'source fact supersession must stay same-entity and move effective_at forward'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists staxis_source_facts_immutable_tg
  on public.staxis_source_facts;
create trigger staxis_source_facts_immutable_tg
  before insert or update or delete on public.staxis_source_facts
  for each row execute function public.staxis_source_fact_immutable();

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Finding admission + source-fact junction.
-- ───────────────────────────────────────────────────────────────────────────
-- @rls: service-role-only — no legacy finding is backfilled. A finding enters this ledger only when a
-- producer supplies a complete reproducible admission and links its facts.
create or replace function public.staxis_minimum_data_proof_is_valid(p_data jsonb, p_met boolean)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
  if jsonb_typeof(p_data) <> 'object'
     or jsonb_typeof(p_data -> 'required') <> 'array'
     or jsonb_array_length(p_data -> 'required') = 0
     or jsonb_typeof(p_data -> 'provided') <> 'array'
     or p_data ->> 'met' not in ('true', 'false')
     or p_met is distinct from ((p_data ->> 'met') = 'true')
     or (jsonb_typeof(p_data -> 'missing') is not null and jsonb_typeof(p_data -> 'missing') <> 'array')
     or coalesce(jsonb_array_length(p_data -> 'missing'), 0) <> 0
     or (select count(*) from jsonb_array_elements_text(p_data -> 'required'))
        <> (select count(distinct item.value) from jsonb_array_elements_text(p_data -> 'required') item)
     or (select count(*) from jsonb_array_elements_text(p_data -> 'provided'))
        <> (select count(distinct item.value) from jsonb_array_elements_text(p_data -> 'provided') item)
     or exists (
       select 1
         from jsonb_array_elements_text(p_data -> 'required') required_item
        where not exists (
          select 1 from jsonb_array_elements_text(p_data -> 'provided') provided_item
           where provided_item.value = required_item.value
        )
     ) then
    return false;
  end if;
  return true;
exception when others then
  return false;
end;
$$;

-- @rls: service-role-only — this admission ledger is a private, immutable
-- proof boundary and is never exposed directly to browser roles.
create table if not exists public.staxis_finding_admissions (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references public.properties(id) on delete cascade,
  finding_id            uuid,
  contract_version      text not null default 'staxis-source-fact.v1',
  detector_id           text not null check (char_length(btrim(detector_id)) between 1 and 120),
  receipt_query_id      text not null check (char_length(btrim(receipt_query_id)) between 1 and 200),
  evidence              jsonb not null check (jsonb_typeof(evidence) = 'object'),
  evidence_hash         text not null default '',
  minimum_data           jsonb not null check (jsonb_typeof(minimum_data) = 'object'),
  minimum_data_met       boolean not null default false,
  as_of                 timestamptz not null,
  observed_at           timestamptz not null,
  expires_at            timestamptz not null,
  completeness           text not null default 'unknown' check (completeness in ('complete', 'partial', 'unknown')),
  completeness_reason    text,
  freshness              text not null default 'unknown' check (freshness in ('fresh', 'stale', 'unknown')),
  freshness_max_age_seconds integer,
  admission_state        text not null default 'pending' check (admission_state in ('pending', 'admitted', 'rejected')),
  admitted_at            timestamptz,
  idempotency_key        text not null default '',
  created_at             timestamptz not null default now(),
  constraint staxis_finding_admissions_id_property_uq unique (id, property_id),
  constraint staxis_finding_admissions_time_order check (
    as_of <= observed_at and expires_at > observed_at
  ),
  constraint staxis_finding_admissions_minimum_reason check (
    minimum_data_met or char_length(btrim(coalesce(minimum_data ->> 'reason', ''))) between 1 and 500
  ),
  constraint staxis_finding_admissions_completeness_reason check (
    (completeness = 'complete' and completeness_reason is null)
    or (completeness <> 'complete' and char_length(btrim(coalesce(completeness_reason, ''))) between 1 and 500)
  ),
  constraint staxis_finding_admissions_minimum_proof check (
    public.staxis_minimum_data_proof_is_valid(minimum_data, minimum_data_met)
  ),
  constraint staxis_finding_admissions_hash_shape check (
    evidence_hash = '' or evidence_hash ~ '^[a-f0-9]{64}$'
  ),
  constraint staxis_finding_admissions_state_coherence check (
    (admission_state = 'admitted' and admitted_at is not null and minimum_data_met)
    or (admission_state <> 'admitted' and admitted_at is null)
  )
);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'staxis_finding_admissions_finding_property_fk' and conrelid = 'public.staxis_finding_admissions'::regclass) then
    alter table public.staxis_finding_admissions
      add constraint staxis_finding_admissions_finding_property_fk
      foreign key (finding_id)
      references public.findings (id)
      on delete set null;
  end if;
end;
$$;

create unique index if not exists staxis_finding_admissions_idempotency_uq
  on public.staxis_finding_admissions (property_id, idempotency_key);
create index if not exists staxis_finding_admissions_property_state_idx
  on public.staxis_finding_admissions (property_id, admission_state, observed_at desc);

-- @rls: service-role-only — immutable admission links are written through the
-- service admission RPC and never exposed as a direct browser table.
create table if not exists public.staxis_finding_source_facts (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references public.properties(id) on delete cascade,
  admission_id          uuid not null,
  source_fact_id        uuid not null,
  created_at            timestamptz not null default now(),
  constraint staxis_finding_source_facts_admission_property_uq
    unique (admission_id, property_id, source_fact_id)
);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'staxis_finding_source_facts_admission_property_fk' and conrelid = 'public.staxis_finding_source_facts'::regclass) then
    alter table public.staxis_finding_source_facts
      add constraint staxis_finding_source_facts_admission_property_fk
      foreign key (admission_id, property_id)
      references public.staxis_finding_admissions (id, property_id)
      on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'staxis_finding_source_facts_fact_property_fk' and conrelid = 'public.staxis_finding_source_facts'::regclass) then
    alter table public.staxis_finding_source_facts
      add constraint staxis_finding_source_facts_fact_property_fk
      foreign key (source_fact_id, property_id)
      references public.staxis_source_facts (id, property_id)
      on delete restrict;
  end if;
end;
$$;

create index if not exists staxis_finding_source_facts_property_admission_idx
  on public.staxis_finding_source_facts (property_id, admission_id);

comment on table public.staxis_finding_admissions is
  'Pending/admitted finding proof. Existing findings are not backfilled; admitted rows require same-property source facts that are complete, current, and reproducible.';

create or replace function public.staxis_finding_admission_immutable()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.finding_id is null then
      raise exception 'finding admission requires an existing finding id'
        using errcode = 'foreign_key_violation';
    end if;
    if not exists (
      select 1 from public.findings finding
       where finding.id = new.finding_id and finding.property_id = new.property_id
    ) then
      raise exception 'finding admission crosses the hotel boundary'
        using errcode = 'foreign_key_violation';
    end if;
    if exists (
      select 1 from public.findings finding
       where finding.id = new.finding_id
         and finding.property_id = new.property_id
         and (finding.detector_id is distinct from new.detector_id
              or finding.receipt_query_id is distinct from new.receipt_query_id)
    ) then
      raise exception 'finding admission detector/query does not match the durable finding'
        using errcode = 'check_violation';
    end if;
    new.evidence_hash := encode(sha256(convert_to(new.evidence::text, 'UTF8')), 'hex');
    new.idempotency_key := new.finding_id::text || ':' || new.receipt_query_id || ':' ||
      new.as_of::text || ':' || new.observed_at::text || ':' || new.evidence_hash;
    if new.admission_state = 'admitted' then
      raise exception 'finding admission must be linked and checked through staxis_admit_finding'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then
      return old;
    end if;
    raise exception 'staxis_finding_admissions are immutable; retain the rejection/admission history'
      using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and pg_trigger_depth() > 1
     and new.finding_id is null and old.finding_id is not null then
    return new;
  end if;

  if new.property_id is distinct from old.property_id
     or new.finding_id is distinct from old.finding_id
     or new.contract_version is distinct from old.contract_version
     or new.detector_id is distinct from old.detector_id
     or new.receipt_query_id is distinct from old.receipt_query_id
     or new.evidence is distinct from old.evidence
     or new.minimum_data is distinct from old.minimum_data
     or new.as_of is distinct from old.as_of
     or new.observed_at is distinct from old.observed_at
     or new.expires_at is distinct from old.expires_at
  then
    raise exception 'admission proof is immutable'
      using errcode = 'check_violation';
  end if;
  if old.admission_state = 'admitted' and new.admission_state <> old.admission_state then
    raise exception 'an admitted finding cannot be retracted or rewritten'
      using errcode = 'check_violation';
  end if;
  if new.admission_state = 'admitted' and old.admission_state <> 'admitted' then
    new.admitted_at := coalesce(new.admitted_at, now());
    new.evidence_hash := old.evidence_hash;
    new.idempotency_key := old.idempotency_key;
  else
    new.admitted_at := old.admitted_at;
    new.evidence_hash := old.evidence_hash;
    new.idempotency_key := old.idempotency_key;
  end if;
  return new;
end;
$$;

drop trigger if exists staxis_finding_admissions_immutable_tg
  on public.staxis_finding_admissions;
create trigger staxis_finding_admissions_immutable_tg
  before insert or update or delete on public.staxis_finding_admissions
  for each row execute function public.staxis_finding_admission_immutable();

create or replace function public.staxis_finding_source_facts_immutable()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  if tg_op <> 'INSERT' then
    if tg_op = 'UPDATE' and pg_trigger_depth() > 1 then
      return new;
    end if;
    raise exception 'staxis_finding_source_facts are immutable'
      using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from public.staxis_finding_admissions admission
     where admission.id = new.admission_id
       and admission.property_id = new.property_id
       and admission.admission_state = 'admitted'
  ) then
    raise exception 'source facts cannot be added after finding admission'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
drop trigger if exists staxis_finding_source_facts_immutable_tg
  on public.staxis_finding_source_facts;
create trigger staxis_finding_source_facts_immutable_tg
  before insert or update or delete on public.staxis_finding_source_facts
  for each row execute function public.staxis_finding_source_facts_immutable();

create or replace function public.staxis_admit_finding(
  p_admission_id uuid,
  p_property_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admission public.staxis_finding_admissions%rowtype;
  v_count integer;
  v_bad integer;
  v_freshness_max integer;
  v_min_as_of timestamptz;
  v_max_observed timestamptz;
  v_min_expiry timestamptz;
  v_source_horizon timestamptz;
  v_admission_completeness text;
  v_completeness_reason text;
begin
  select * into strict v_admission
    from public.staxis_finding_admissions admission
   where admission.id = p_admission_id
     and admission.property_id = p_property_id
   for update;

  if v_admission.admission_state = 'admitted' then
    return jsonb_build_object('admitted', true, 'id', v_admission.id, 'replayed', true);
  end if;
  if v_admission.admission_state = 'rejected' then
    return jsonb_build_object('admitted', false, 'reason', 'rejected');
  end if;
  if v_admission.contract_version <> 'staxis-source-fact.v1' then
    return jsonb_build_object('admitted', false, 'reason', 'unsupported_contract_version');
  end if;
  if coalesce(v_admission.evidence ->> 'queryId', v_admission.evidence ->> 'query_id') is distinct from v_admission.receipt_query_id
     or jsonb_typeof(coalesce(v_admission.evidence -> 'params', v_admission.evidence -> 'parameters')) <> 'object'
     or jsonb_typeof(v_admission.evidence -> 'values') <> 'object'
     or char_length(btrim(coalesce(v_admission.evidence ->> 'basis', v_admission.evidence ->> 'reason', ''))) = 0 then
    return jsonb_build_object('admitted', false, 'reason', 'evidence_proof_invalid');
  end if;
  if not v_admission.minimum_data_met then
    return jsonb_build_object('admitted', false, 'reason', 'minimum_data_not_met');
  end if;
  if v_admission.minimum_data ->> 'met' <> 'true'
     or jsonb_typeof(v_admission.minimum_data -> 'required') <> 'array'
     or jsonb_typeof(v_admission.minimum_data -> 'provided') <> 'array'
     or (jsonb_typeof(v_admission.minimum_data -> 'missing') is not null
         and jsonb_typeof(v_admission.minimum_data -> 'missing') <> 'array')
     or coalesce(jsonb_array_length(v_admission.minimum_data -> 'missing'), 0) <> 0
     or exists (
       select 1
         from jsonb_array_elements_text(v_admission.minimum_data -> 'required') required_item
        where not exists (
          select 1 from jsonb_array_elements_text(v_admission.minimum_data -> 'provided') provided_item
           where provided_item.value = required_item.value
        )
     )
     or (select count(*) from jsonb_array_elements_text(v_admission.minimum_data -> 'required'))
        <> (select count(distinct required_item.value) from jsonb_array_elements_text(v_admission.minimum_data -> 'required') required_item)
     or (select count(*) from jsonb_array_elements_text(v_admission.minimum_data -> 'provided'))
        <> (select count(distinct provided_item.value) from jsonb_array_elements_text(v_admission.minimum_data -> 'provided') provided_item)
  then
    return jsonb_build_object('admitted', false, 'reason', 'minimum_data_proof_invalid');
  end if;
  if v_admission.expires_at <= clock_timestamp() then
    return jsonb_build_object('admitted', false, 'reason', 'admission_expired');
  end if;

  select count(*)::integer,
         count(*) filter (
           where (definition.completeness_required = 'complete' and fact.completeness <> 'complete')
              or (definition.completeness_required = 'partial' and fact.completeness = 'unknown')
              or fact.expires_at is not null and fact.expires_at <= clock_timestamp()
              or definition.freshness_required
                 and (definition.freshness_max_age_seconds is null
                      or clock_timestamp() > fact.as_of + make_interval(secs => definition.freshness_max_age_seconds))
              or definition.reviewed_at is null
         )::integer,
         min(fact.as_of), max(fact.observed_at), min(fact.expires_at),
         min(least(
           coalesce(fact.expires_at, 'infinity'::timestamptz),
           case when definition.freshness_required
             then fact.as_of + make_interval(secs => definition.freshness_max_age_seconds)
             else 'infinity'::timestamptz end
         )),
         min(definition.freshness_max_age_seconds),
         case when bool_and(fact.completeness = 'complete') then 'complete'
              when bool_and(fact.completeness <> 'unknown') then 'partial'
              else 'unknown' end,
         max(nullif(btrim(fact.completeness_reason), ''))
    into v_count, v_bad, v_min_as_of, v_max_observed, v_min_expiry, v_source_horizon, v_freshness_max, v_admission_completeness, v_completeness_reason
    from public.staxis_finding_source_facts link
    join public.staxis_source_facts fact
      on fact.id = link.source_fact_id and fact.property_id = link.property_id
    join public.staxis_source_definitions definition
      on definition.id = fact.source_definition_id and definition.property_id = fact.property_id
   where link.admission_id = v_admission.id
     and link.property_id = v_admission.property_id;

  if v_count = 0 then
    return jsonb_build_object('admitted', false, 'reason', 'source_facts_missing');
  end if;
  if v_bad > 0 then
    return jsonb_build_object('admitted', false, 'reason', 'source_fact_stale_or_incomplete');
  end if;
  if v_admission.as_of is distinct from v_min_as_of
     or v_admission.observed_at is distinct from v_max_observed then
    return jsonb_build_object('admitted', false, 'reason', 'admission_clocks_do_not_match_source_facts');
  end if;
  if v_admission.completeness is distinct from v_admission_completeness then
    return jsonb_build_object('admitted', false, 'reason', 'admission_completeness_does_not_match_source_facts');
  end if;
  if v_admission.freshness is distinct from 'fresh'
     or v_admission.freshness_max_age_seconds is distinct from v_freshness_max then
    return jsonb_build_object('admitted', false, 'reason', 'admission_freshness_does_not_match_source_definitions');
  end if;
  if v_source_horizon is null or v_admission.expires_at > v_source_horizon then
    return jsonb_build_object('admitted', false, 'reason', 'admission_expiry_outlives_source_facts');
  end if;
  if exists (
    select 1
      from public.staxis_finding_source_facts link_a
      join public.staxis_source_facts fact_a on fact_a.id = link_a.source_fact_id and fact_a.property_id = link_a.property_id
      join public.staxis_source_definitions definition_a on definition_a.id = fact_a.source_definition_id and definition_a.property_id = fact_a.property_id
      join public.staxis_finding_source_facts link_b on link_b.admission_id = link_a.admission_id and link_b.property_id = link_a.property_id
      join public.staxis_source_facts fact_b on fact_b.id = link_b.source_fact_id and fact_b.property_id = link_b.property_id
      join public.staxis_source_definitions definition_b on definition_b.id = fact_b.source_definition_id and definition_b.property_id = fact_b.property_id
     where link_a.admission_id = v_admission.id and link_a.property_id = v_admission.property_id
       and fact_a.entity_kind = fact_b.entity_kind and fact_a.entity_id = fact_b.entity_id
       and fact_a.effective_at = fact_b.effective_at
       and definition_a.claim_scope = definition_b.claim_scope
       and fact_a.id <> fact_b.id
  ) then
    return jsonb_build_object('admitted', false, 'reason', 'overlapping_claim_scopes_are_ambiguous');
  end if;

  update public.staxis_finding_admissions
     set admission_state = 'admitted',
         admitted_at = clock_timestamp(),
         completeness = v_admission_completeness,
         completeness_reason = case when v_admission_completeness = 'complete' then null
                                    else coalesce(v_completeness_reason, nullif(btrim(v_admission.completeness_reason), ''), 'derived from source fact completeness') end,
         freshness = 'fresh',
         freshness_max_age_seconds = v_freshness_max,
         as_of = v_admission.as_of,
         observed_at = v_admission.observed_at,
         expires_at = v_admission.expires_at
   where id = v_admission.id and property_id = v_admission.property_id;

  return jsonb_build_object('admitted', true, 'id', v_admission.id, 'replayed', false);
end;
$$;

revoke all on function public.staxis_admit_finding(uuid, uuid) from public, anon, authenticated;
grant execute on function public.staxis_admit_finding(uuid, uuid) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Reviewed action definitions (empty registry; no category seeds).
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.staxis_action_contract_is_valid(p_contract jsonb)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_outcome_state text;
begin
  if jsonb_typeof(p_contract) <> 'object'
     or p_contract ->> 'contractVersion' <> 'staxis-action.v1'
     or jsonb_typeof(p_contract -> 'effect') <> 'object'
     or char_length(btrim(coalesce(p_contract #>> '{effect,domain}', ''))) not between 1 and 80
     or char_length(btrim(coalesce(p_contract #>> '{effect,operation}', ''))) not between 1 and 120
     or char_length(btrim(coalesce(p_contract #>> '{effect,targetKind}', ''))) not between 1 and 80
     or p_contract #>> '{effect,boundary}' <> 'in_app_only'
     or char_length(btrim(coalesce(p_contract #>> '{effect,statement}', ''))) not between 1 and 1_000
     or char_length(btrim(coalesce(p_contract #>> '{effect,limit}', ''))) not between 1 and 1_000
     or jsonb_typeof(p_contract -> 'authority') <> 'object'
     or (p_contract #>> '{authority,propertyScoped}')::boolean is distinct from true
     or not (p_contract -> 'authority' ? 'capability')
     or jsonb_typeof(p_contract #> '{authority,capability}') <> 'null'
     or jsonb_typeof(p_contract #> '{authority,roles}') <> 'array'
     or jsonb_array_length(p_contract #> '{authority,roles}') = 0
     or exists (select 1 from jsonb_array_elements(p_contract #> '{authority,roles}') role_item where jsonb_typeof(role_item.value) <> 'string' or char_length(btrim(role_item.value #>> '{}')) not between 1 and 80)
     or (select count(*) from jsonb_array_elements_text(p_contract #> '{authority,roles}') role_item)
        <> (select count(distinct role_item.value) from jsonb_array_elements_text(p_contract #> '{authority,roles}') role_item)
     or jsonb_typeof(p_contract #> '{authority,surfaces}') <> 'array'
     or jsonb_array_length(p_contract #> '{authority,surfaces}') = 0
     or exists (select 1 from jsonb_array_elements(p_contract #> '{authority,surfaces}') surface_item where jsonb_typeof(surface_item.value) <> 'string' or char_length(btrim(surface_item.value #>> '{}')) not between 1 and 80)
     or (select count(*) from jsonb_array_elements_text(p_contract #> '{authority,surfaces}') surface_item)
        <> (select count(distinct surface_item.value) from jsonb_array_elements_text(p_contract #> '{authority,surfaces}') surface_item)
     or jsonb_typeof(p_contract -> 'approval') <> 'object'
     or p_contract #>> '{approval,mode}' not in ('explicit_card', 'conversation_confirmation')
     or p_contract #>> '{approval,tier}' not in ('quick', 'card', 'conversation')
     or (p_contract #>> '{approval,mode}' = 'explicit_card' and p_contract #>> '{approval,tier}' <> 'card')
     or (p_contract #>> '{approval,mode}' = 'conversation_confirmation' and p_contract #>> '{approval,tier}' <> 'conversation')
     or char_length(btrim(coalesce(p_contract #>> '{approval,policyId}', ''))) not between 1 and 120
     or jsonb_typeof(p_contract -> 'frozenInput') <> 'object'
     or (p_contract #>> '{frozenInput,immutable}')::boolean is distinct from true
     or jsonb_typeof(p_contract #> '{frozenInput,fields}') <> 'array'
     or jsonb_array_length(p_contract #> '{frozenInput,fields}') <> 4
     or (select count(*) from jsonb_array_elements_text(p_contract #> '{frozenInput,fields}') field_item
          where field_item.value not in ('propertyId', 'findingId', 'params', 'verify')) > 0
     or (select count(distinct field_item.value) from jsonb_array_elements_text(p_contract #> '{frozenInput,fields}') field_item) <> 4
     or (select count(*) from jsonb_array_elements_text(p_contract #> '{frozenInput,fields}') field_item
          where field_item.value in ('propertyId', 'findingId', 'params', 'verify')) <> 4
     or p_contract #>> '{frozenInput,fingerprint}' <> 'server_sha256'
     or p_contract #>> '{frozenInput,staleInput}' <> 'decline'
     or jsonb_typeof(p_contract -> 'idempotency') <> 'object'
     or p_contract #>> '{idempotency,scope}' not in ('property_action', 'property_action_and_input')
     or jsonb_typeof(p_contract #> '{idempotency,keyFields}') <> 'array'
     or jsonb_array_length(p_contract #> '{idempotency,keyFields}') = 0
     or exists (select 1 from jsonb_array_elements(p_contract #> '{idempotency,keyFields}') field_item
                 where jsonb_typeof(field_item.value) <> 'string'
                    or char_length(btrim(field_item.value #>> '{}')) not between 1 and 120)
     or (select count(*) from jsonb_array_elements_text(p_contract #> '{idempotency,keyFields}') field_item)
        <> (select count(distinct field_item.value) from jsonb_array_elements_text(p_contract #> '{idempotency,keyFields}') field_item)
     or p_contract #>> '{idempotency,retry}' not in ('first_receipt', 'same_proposal')
     or jsonb_typeof(p_contract -> 'receipt') <> 'object'
     or p_contract #>> '{receipt,contractVersion}' <> 'staxis-action.v1'
     or (p_contract #>> '{receipt,internalOnly}')::boolean is distinct from true
     or p_contract #>> '{receipt,physicalCompletionClaim}' <> 'never'
     or jsonb_typeof(p_contract #> '{receipt,requiredFields}') <> 'array'
     or jsonb_array_length(p_contract #> '{receipt,requiredFields}') = 0
     or exists (select 1 from jsonb_array_elements(p_contract #> '{receipt,requiredFields}') field_item
                 where jsonb_typeof(field_item.value) <> 'string'
                    or char_length(btrim(field_item.value #>> '{}')) not between 1 and 120)
     or (select count(*) from jsonb_array_elements_text(p_contract #> '{receipt,requiredFields}') field_item)
        <> (select count(distinct field_item.value) from jsonb_array_elements_text(p_contract #> '{receipt,requiredFields}') field_item)
     or jsonb_typeof(p_contract -> 'outcome') <> 'object'
     or p_contract #>> '{outcome,observability}' not in ('observable', 'conditional', 'not_observable')
     or p_contract #>> '{outcome,verificationState}' not in ('pending', 'verified', 'not_observable', 'unverifiable', 'reverted')
     or jsonb_typeof(p_contract #> '{outcome,verificationWindowDays}') <> 'number'
     or (p_contract #>> '{outcome,verificationWindowDays}')::integer < 1
     or (p_contract #>> '{outcome,basisRequired}')::boolean is distinct from true
  then
    return false;
  end if;
  v_outcome_state := p_contract #>> '{outcome,verificationState}';
  if v_outcome_state <> 'pending' then
    return false;
  end if;
  return true;
exception when others then
  return false;
end;
$$;

-- @rls: service-role-only — action contracts are reviewed producer metadata,
-- never a browser-writable or browser-readable action catalog.
create table if not exists public.staxis_action_definitions (
  id                 uuid primary key default gen_random_uuid(),
  property_id        uuid not null references public.properties(id) on delete cascade,
  category           text not null check (char_length(btrim(category)) between 1 and 120),
  action_kind        text not null check (char_length(btrim(action_kind)) between 1 and 120),
  action_contract    jsonb not null check (public.staxis_action_contract_is_valid(action_contract)),
  reviewed_at        timestamptz not null,
  created_at         timestamptz not null default now(),
  constraint staxis_action_definitions_id_property_uq unique (id, property_id)
);
alter table public.staxis_action_definitions
  drop constraint if exists staxis_action_definitions_kind_uq;
create index if not exists staxis_action_definitions_kind_idx
  on public.staxis_action_definitions (property_id, action_kind, reviewed_at desc);
create or replace function public.staxis_action_definition_immutable()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
  raise exception 'staxis_action_definitions are immutable; register a new reviewed definition'
    using errcode = 'check_violation';
end;
$$;
drop trigger if exists staxis_action_definitions_immutable_tg
  on public.staxis_action_definitions;
create trigger staxis_action_definitions_immutable_tg
  before update or delete on public.staxis_action_definitions
  for each row execute function public.staxis_action_definition_immutable();

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Lifecycle correlation envelope + append-only events.
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.staxis_owner_snapshot_is_valid(p_snapshot jsonb)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_kind text;
  v_label text;
  v_role text;
begin
  if jsonb_typeof(p_snapshot) <> 'object'
     or not (p_snapshot ? 'kind')
     or not (p_snapshot ? 'label')
     or not (p_snapshot ? 'role')
  then
    return false;
  end if;
  v_kind := p_snapshot ->> 'kind';
  v_label := nullif(btrim(p_snapshot ->> 'label'), '');
  v_role := nullif(btrim(p_snapshot ->> 'role'), '');
  if v_kind not in ('app', 'pms', 'hotel', 'company', 'staxis', 'human', 'system', 'unknown', 'unassigned')
     or (jsonb_typeof(p_snapshot -> 'label') not in ('null', 'string'))
     or (jsonb_typeof(p_snapshot -> 'role') not in ('null', 'string'))
     or (v_label is not null and char_length(v_label) > 200)
     or (v_role is not null and char_length(v_role) > 120)
     or (v_kind not in ('unknown', 'unassigned') and v_label is null and v_role is null)
  then
    return false;
  end if;
  return true;
exception when others then
  return false;
end;
$$;

create or replace function public.staxis_domain_reference_is_valid(p_reference jsonb)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_kind text;
  v_id text;
  v_label text;
begin
  if jsonb_typeof(p_reference) <> 'object'
     or not (p_reference ? 'kind')
     or not (p_reference ? 'id')
     or not (p_reference ? 'label')
     or not (p_reference ? 'href')
     or jsonb_typeof(p_reference -> 'href') <> 'null'
  then
    return false;
  end if;
  v_kind := nullif(btrim(p_reference ->> 'kind'), '');
  v_id := p_reference ->> 'id';
  v_label := nullif(btrim(p_reference ->> 'label'), '');
  if v_kind is null
     or char_length(v_kind) > 120
     or v_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or jsonb_typeof(p_reference -> 'label') not in ('null', 'string')
     or (v_label is not null and char_length(v_label) > 300)
  then
    return false;
  end if;
  return true;
exception when others then
  return false;
end;
$$;

-- @rls: service-role-only — lifecycle correlation contains private contracts,
-- account/conversation snapshots, and is exposed only through the API.
create table if not exists public.staxis_lifecycle_records (
  id                         uuid primary key default gen_random_uuid(),
  property_id                uuid not null references public.properties(id) on delete cascade,
  finding_id                 uuid,
  -- Generic proposal identity; finding_action_id remains an optional link to
  -- an existing domain row and is never required for a v1 proposal.
  proposal_id                uuid,
  action_kind                text,
  action_definition_id       uuid,
  finding_action_id          uuid,
  pending_action_id          uuid,
  admission_id               uuid,
  entity_kind                text not null check (char_length(btrim(entity_kind)) between 1 and 120),
  entity_id                  text check (entity_id is null or char_length(btrim(entity_id)) between 1 and 240),
  entity_label               text check (entity_label is null or char_length(btrim(entity_label)) between 1 and 200),
  title_snapshot             text not null check (char_length(btrim(title_snapshot)) between 1 and 300),
  summary_snapshot           text check (summary_snapshot is null or char_length(btrim(summary_snapshot)) between 1 and 2_000),
  state                      text not null default 'observed' check (state in (
    'observed', 'proposed', 'approved', 'executed', 'outcome_verified',
    'not_observable', 'unverifiable'
  )),
  prior_states               text[] not null default '{}',
  action_contract            jsonb check (action_contract is null or jsonb_typeof(action_contract) = 'object'),
  approval_required          boolean not null default false,
  frozen_input               jsonb check (frozen_input is null or jsonb_typeof(frozen_input) = 'object'),
  frozen_input_hash          text check (frozen_input_hash is null or frozen_input_hash ~ '^[a-f0-9]{64}$'),
  action_idempotency_key     text not null default '' check (char_length(action_idempotency_key) between 0 and 300),
  idempotency_key            text not null default '' check (char_length(idempotency_key) between 1 and 300),
  owner_kind                 text not null check (owner_kind in ('app', 'pms', 'hotel', 'company', 'staxis', 'human', 'system', 'unknown', 'unassigned')),
  owner_id                   text check (owner_id is null or char_length(btrim(owner_id)) between 1 and 240),
  owner_label                text check (owner_label is null or char_length(btrim(owner_label)) between 1 and 200),
  owner_role                 text check (owner_role is null or char_length(btrim(owner_role)) between 1 and 120),
  conversation_id            uuid,
  account_id                 uuid,
  conversation_snapshot      jsonb not null default '{}'::jsonb check (jsonb_typeof(conversation_snapshot) = 'object'),
  account_snapshot           jsonb not null default '{}'::jsonb check (jsonb_typeof(account_snapshot) = 'object'),
  recorded_at                timestamptz not null default now(),
  reason                     text check (reason is null or char_length(btrim(reason)) between 1 and 1_000),
  constraint staxis_lifecycle_records_id_property_uq unique (id, property_id),
  constraint staxis_lifecycle_records_prior_states_check check (
    state = 'observed' and cardinality(prior_states) = 0
    or state <> 'observed'
  ),
  constraint staxis_lifecycle_records_action_boundary check (
    action_contract is null
    or coalesce(action_contract #>> '{effect,boundary}', action_contract ->> 'boundary') = 'in_app_only'
  ),
  constraint staxis_lifecycle_records_action_approval_check check (
    action_contract is null or approval_required is true
  ),
  constraint staxis_lifecycle_records_owner_snapshot_check check (
    owner_kind in ('unknown', 'unassigned') or owner_label is not null or owner_role is not null
  ),
  constraint staxis_lifecycle_records_proposal_shape check (
    (proposal_id is null and action_kind is null and action_definition_id is null and frozen_input is null and action_idempotency_key = '')
    or (proposal_id is not null and action_definition_id is not null and char_length(btrim(coalesce(action_kind, ''))) between 1 and 120
        and frozen_input is not null and action_idempotency_key <> '')
  )
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'staxis_lifecycle_records_finding_property_fk' and conrelid = 'public.staxis_lifecycle_records'::regclass) then
    alter table public.staxis_lifecycle_records
      add constraint staxis_lifecycle_records_finding_property_fk
      foreign key (finding_id)
      references public.findings (id)
      on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'staxis_lifecycle_records_action_definition_property_fk' and conrelid = 'public.staxis_lifecycle_records'::regclass) then
    alter table public.staxis_lifecycle_records
      add constraint staxis_lifecycle_records_action_definition_property_fk
      foreign key (action_definition_id, property_id)
      references public.staxis_action_definitions (id, property_id)
      on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'staxis_lifecycle_records_action_property_fk' and conrelid = 'public.staxis_lifecycle_records'::regclass) then
    alter table public.staxis_lifecycle_records
      add constraint staxis_lifecycle_records_action_property_fk
      foreign key (finding_action_id)
      references public.finding_actions (id)
      on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'staxis_lifecycle_records_pending_property_fk' and conrelid = 'public.staxis_lifecycle_records'::regclass) then
    alter table public.staxis_lifecycle_records
      add constraint staxis_lifecycle_records_pending_property_fk
      foreign key (pending_action_id)
      references public.agent_pending_actions (id)
      on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'staxis_lifecycle_records_admission_property_fk' and conrelid = 'public.staxis_lifecycle_records'::regclass) then
    alter table public.staxis_lifecycle_records
      add constraint staxis_lifecycle_records_admission_property_fk
      foreign key (admission_id)
      references public.staxis_finding_admissions (id)
      on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'staxis_lifecycle_records_conversation_fk' and conrelid = 'public.staxis_lifecycle_records'::regclass) then
    alter table public.staxis_lifecycle_records
      add constraint staxis_lifecycle_records_conversation_fk
      foreign key (conversation_id)
      references public.agent_conversations (id)
      on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'staxis_lifecycle_records_account_fk' and conrelid = 'public.staxis_lifecycle_records'::regclass) then
    alter table public.staxis_lifecycle_records
      add constraint staxis_lifecycle_records_account_fk
      foreign key (account_id)
      references public.accounts (id)
      on delete set null;
  end if;
end;
$$;

create unique index if not exists staxis_lifecycle_records_idempotency_uq
  on public.staxis_lifecycle_records (property_id, idempotency_key);
create unique index if not exists staxis_lifecycle_records_proposal_uq
  on public.staxis_lifecycle_records (property_id, proposal_id)
  where proposal_id is not null;
create unique index if not exists staxis_lifecycle_records_action_idempotency_uq
  on public.staxis_lifecycle_records (property_id, action_idempotency_key)
  where action_idempotency_key <> '';
create unique index if not exists staxis_lifecycle_records_admission_uq
  on public.staxis_lifecycle_records (property_id, admission_id)
  where admission_id is not null;
create index if not exists staxis_lifecycle_records_property_state_idx
  on public.staxis_lifecycle_records (property_id, state, recorded_at desc);

-- @rls: service-role-only — append-only custody events are API/service data.
create table if not exists public.staxis_lifecycle_events (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references public.properties(id) on delete cascade,
  lifecycle_id          uuid not null,
  from_state            text not null check (from_state in (
    'observed', 'proposed', 'approved', 'executed', 'outcome_verified',
    'not_observable', 'unverifiable'
  )),
  to_state              text not null check (to_state in (
    'observed', 'proposed', 'approved', 'executed', 'outcome_verified',
    'not_observable', 'unverifiable'
  )),
  event_kind            text not null default 'state_transition'
                        check (event_kind in ('state_transition', 'custody_updated')),
  actor_account_id      uuid references public.accounts(id) on delete set null,
  actor_snapshot        jsonb not null default '{}'::jsonb check (jsonb_typeof(actor_snapshot) = 'object'),
  owner_snapshot        jsonb not null default '{}'::jsonb check (public.staxis_owner_snapshot_is_valid(owner_snapshot)),
  domain_reference      jsonb check (domain_reference is null or domain_reference = '{}'::jsonb or public.staxis_domain_reference_is_valid(domain_reference)),
  approval_proof        jsonb check (approval_proof is null or jsonb_typeof(approval_proof) = 'object'),
  execution_receipt     jsonb,
  outcome_basis         text,
  reason                text,
  outcome_source_fact_id uuid,
  occurred_at           timestamptz not null default now(),
  idempotency_key       text not null default '' check (char_length(idempotency_key) between 1 and 300),
  constraint staxis_lifecycle_events_id_property_uq unique (id, property_id),
  -- observed -> observed is reserved for the initial proof event written by
  -- the atomic admission RPC. All later events must move the state.
  constraint staxis_lifecycle_events_distinct_state check (
    from_state <> to_state
    or (event_kind = 'state_transition' and from_state = 'observed' and to_state = 'observed')
    or (event_kind = 'custody_updated')
  ),
  constraint staxis_lifecycle_events_receipt_check check (
    to_state <> 'executed' or execution_receipt is not null
  ),
  constraint staxis_lifecycle_events_terminal_basis check (
    to_state not in ('outcome_verified', 'not_observable', 'unverifiable')
    or char_length(btrim(coalesce(outcome_basis, ''))) between 1 and 1_000
  ),
  constraint staxis_lifecycle_events_reason_shape check (
    reason is null or char_length(btrim(reason)) between 1 and 1_000
  )
);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'staxis_lifecycle_events_lifecycle_property_fk' and conrelid = 'public.staxis_lifecycle_events'::regclass) then
    alter table public.staxis_lifecycle_events
      add constraint staxis_lifecycle_events_lifecycle_property_fk
      foreign key (lifecycle_id, property_id)
      references public.staxis_lifecycle_records (id, property_id)
      on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'staxis_lifecycle_events_outcome_fact_property_fk' and conrelid = 'public.staxis_lifecycle_events'::regclass) then
    alter table public.staxis_lifecycle_events
      add constraint staxis_lifecycle_events_outcome_fact_property_fk
      foreign key (outcome_source_fact_id, property_id)
      references public.staxis_source_facts (id, property_id)
      on delete restrict;
  end if;
end;
$$;
create unique index if not exists staxis_lifecycle_events_idempotency_uq
  on public.staxis_lifecycle_events (property_id, lifecycle_id, idempotency_key);
create index if not exists staxis_lifecycle_events_lifecycle_idx
  on public.staxis_lifecycle_events (property_id, lifecycle_id, occurred_at);

comment on table public.staxis_lifecycle_records is
  'Correlation envelope only: links an admitted finding/action/pending action to an immutable state history and minimal owner/domain snapshots. It is not a universal task table.';
comment on table public.staxis_lifecycle_events is
  'Append-only lifecycle custody proof. Executed requires a receipt; every terminal state requires a human-readable basis, and outcome_verified is only reachable after execution.';

create or replace function public.staxis_lifecycle_record_immutable()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action public.finding_actions%rowtype;
  v_pending public.agent_pending_actions%rowtype;
  v_action_definition public.staxis_action_definitions%rowtype;
  v_admitted boolean;
  v_has_facts boolean;
  v_stale_facts boolean;
  v_has_proposal boolean;
  v_has_approval boolean;
  v_has_receipt boolean;
  v_has_verified_outcome boolean;
  v_has_outcome_basis boolean;
  v_expected_frozen_hash text;
begin
  if tg_op = 'INSERT' then
    if new.state <> 'observed' or cardinality(new.prior_states) <> 0 then
      raise exception 'new lifecycle records must begin observed'
        using errcode = 'check_violation';
    end if;
    if new.idempotency_key = '' then
      new.idempotency_key := encode(sha256(convert_to(
        coalesce(new.finding_id, new.id)::text || ':' || new.entity_kind || ':' || coalesce(new.entity_id, ''),
        'UTF8'
      )), 'hex');
    end if;
    if new.proposal_id is not null or new.action_kind is not null or new.action_definition_id is not null or new.frozen_input is not null or new.action_idempotency_key <> '' then
      if new.action_contract is null
         or new.proposal_id is null
         or new.action_definition_id is null
         or char_length(btrim(coalesce(new.action_kind, ''))) = 0
         or new.frozen_input is null
         or jsonb_typeof(new.frozen_input -> 'params') <> 'object'
         or jsonb_typeof(new.frozen_input -> 'verify') <> 'object'
         or new.action_idempotency_key = ''
         or new.frozen_input ->> 'propertyId' <> new.property_id::text
         or new.finding_id is null
         or new.frozen_input ->> 'findingId' <> new.finding_id::text
      then
        raise exception 'generic proposal requires contract, identity, frozen params/verify, and matching property/finding'
          using errcode = 'check_violation';
      end if;
      select * into strict v_action_definition
        from public.staxis_action_definitions definition
       where definition.id = new.action_definition_id
         and definition.property_id = new.property_id
         and definition.reviewed_at is not null
         and definition.reviewed_at <= clock_timestamp() + interval '5 minutes';
      if v_action_definition.action_kind <> new.action_kind
         or v_action_definition.action_contract is distinct from new.action_contract then
        raise exception 'proposal action kind/contract does not match the reviewed action definition'
          using errcode = 'check_violation';
      end if;
      v_expected_frozen_hash := encode(sha256(convert_to(new.frozen_input::text, 'UTF8')), 'hex');
      if new.frozen_input_hash is not distinct from null then
        new.frozen_input_hash := v_expected_frozen_hash;
      elsif new.frozen_input_hash <> v_expected_frozen_hash then
        raise exception 'frozen input hash does not match canonical frozen input'
          using errcode = 'check_violation';
      end if;
      if coalesce(new.action_contract #>> '{approval,mode}', '') not in ('explicit_card', 'conversation_confirmation')
         or coalesce(new.action_contract #>> '{approval,tier}', '') not in ('quick', 'card', 'conversation')
         or char_length(btrim(coalesce(new.action_contract #>> '{approval,policyId}', ''))) = 0
         or coalesce(new.action_contract #>> '{effect,boundary}', new.action_contract ->> 'boundary') <> 'in_app_only'
      then
        raise exception 'generic proposal approval/effect contract is invalid'
          using errcode = 'check_violation';
      end if;
      if new.approval_required is not true then
        raise exception 'v1 action proposals always require explicit approval'
          using errcode = 'check_violation';
      end if;
    end if;
    if new.action_contract is not null then
      -- Compute from the linked frozen params/verify (or pending tool args),
      -- never from the action contract text itself.
      declare
        v_linked_frozen_hash text;
      begin
      if new.finding_action_id is not null then
        select * into strict v_action
          from public.finding_actions action
         where action.id = new.finding_action_id and action.property_id = new.property_id;
        v_linked_frozen_hash := encode(sha256(convert_to(
          v_action.params::text || ':' || v_action.verify::text,
          'UTF8'
        )), 'hex');
      elsif new.pending_action_id is not null then
        select * into strict v_pending
          from public.agent_pending_actions pending
         where pending.id = new.pending_action_id and pending.property_id = new.property_id;
        v_linked_frozen_hash := encode(sha256(convert_to(v_pending.tool_args::text, 'UTF8')), 'hex');
      else
        if new.frozen_input is not null then
          v_linked_frozen_hash := encode(sha256(convert_to(new.frozen_input::text, 'UTF8')), 'hex');
        elsif new.frozen_input_hash is null then
          raise exception 'action lifecycle requires a server-derived frozen input hash or existing action link'
            using errcode = 'check_violation';
        else
          v_linked_frozen_hash := new.frozen_input_hash;
        end if;
      end if;
      if new.frozen_input_hash is distinct from v_linked_frozen_hash then
        raise exception 'frozen input hash does not match the linked immutable input'
          using errcode = 'check_violation';
      end if;
      new.frozen_input_hash := v_linked_frozen_hash;
      end;
    end if;
    if new.action_contract is not null and new.frozen_input_hash is null then
      raise exception 'action lifecycle requires frozen input proof'
        using errcode = 'check_violation';
    end if;
    if new.finding_id is not null and not exists (
      select 1 from public.findings finding
       where finding.id = new.finding_id and finding.property_id = new.property_id
    ) then
      raise exception 'lifecycle finding link crosses the hotel boundary'
        using errcode = 'foreign_key_violation';
    end if;
    if new.finding_action_id is not null and not exists (
      select 1 from public.finding_actions action
       where action.id = new.finding_action_id and action.property_id = new.property_id
    ) then
      raise exception 'lifecycle finding action link crosses the hotel boundary'
        using errcode = 'foreign_key_violation';
    end if;
    if new.pending_action_id is not null and not exists (
      select 1 from public.agent_pending_actions pending
       where pending.id = new.pending_action_id and pending.property_id = new.property_id
    ) then
      raise exception 'lifecycle pending action link crosses the hotel boundary'
        using errcode = 'foreign_key_violation';
    end if;
    if new.admission_id is not null and not exists (
      select 1 from public.staxis_finding_admissions admission
       where admission.id = new.admission_id and admission.property_id = new.property_id
    ) then
      raise exception 'lifecycle admission link crosses the hotel boundary'
        using errcode = 'foreign_key_violation';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then
      return old;
    end if;
    raise exception 'staxis_lifecycle_records are immutable; retain terminal proof'
      using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and pg_trigger_depth() > 1 then
    return new;
  end if;

  if new.property_id is distinct from old.property_id
     or new.finding_id is distinct from old.finding_id
     or new.proposal_id is distinct from old.proposal_id
     or new.action_kind is distinct from old.action_kind
     or new.action_definition_id is distinct from old.action_definition_id
     or new.finding_action_id is distinct from old.finding_action_id
     or new.pending_action_id is distinct from old.pending_action_id
     or new.admission_id is distinct from old.admission_id
     or new.entity_kind is distinct from old.entity_kind
     or new.entity_id is distinct from old.entity_id
     or new.entity_label is distinct from old.entity_label
     or new.title_snapshot is distinct from old.title_snapshot
     or new.summary_snapshot is distinct from old.summary_snapshot
     or new.action_contract is distinct from old.action_contract
     or new.approval_required is distinct from old.approval_required
     or new.frozen_input is distinct from old.frozen_input
     or new.frozen_input_hash is distinct from old.frozen_input_hash
     or new.action_idempotency_key is distinct from old.action_idempotency_key
     or new.idempotency_key is distinct from old.idempotency_key
     or new.owner_kind is distinct from old.owner_kind
     or new.owner_id is distinct from old.owner_id
     or new.owner_label is distinct from old.owner_label
     or new.owner_role is distinct from old.owner_role
     or new.conversation_id is distinct from old.conversation_id
     or new.account_id is distinct from old.account_id
     or new.conversation_snapshot is distinct from old.conversation_snapshot
     or new.account_snapshot is distinct from old.account_snapshot
  then
    raise exception 'lifecycle correlation envelope is immutable'
      using errcode = 'check_violation';
  end if;
  if new.state = old.state then
    new.prior_states := old.prior_states;
    return new;
  end if;

  if not (
    (old.state = 'observed' and new.state in ('proposed'))
    or (old.state = 'proposed' and new.state in ('approved'))
    or (old.state = 'approved' and new.state in ('executed'))
    or (old.state = 'executed' and new.state in ('outcome_verified', 'not_observable', 'unverifiable'))
  ) then
    raise exception 'illegal lifecycle transition % -> %', old.state, new.state
      using errcode = 'check_violation';
  end if;

  if new.admission_id is null then
    raise exception 'lifecycle admission is required before state can advance'
      using errcode = 'check_violation';
  end if;
  if new.state in ('proposed', 'approved', 'executed', 'outcome_verified')
     and new.action_contract is null then
    raise exception 'action lifecycle state requires an admitted action contract'
      using errcode = 'check_violation';
  end if;
  select admission.admission_state = 'admitted'
         and admission.completeness = 'complete'
         and admission.expires_at > clock_timestamp()
    into v_admitted
    from public.staxis_finding_admissions admission
   where admission.id = new.admission_id
     and admission.property_id = new.property_id;
  if not coalesce(v_admitted, false) then
    raise exception 'lifecycle admission is missing, cross-property, rejected, or expired'
      using errcode = 'check_violation';
  end if;
  select count(*) > 0,
         count(*) filter (
           where fact.completeness <> 'complete'
              or fact.expires_at is not null and fact.expires_at <= clock_timestamp()
              or definition.freshness_required
                 and (definition.freshness_max_age_seconds is null
                      or clock_timestamp() > fact.as_of + make_interval(secs => definition.freshness_max_age_seconds))
         ) > 0
    into v_has_facts, v_stale_facts
    from public.staxis_finding_source_facts link
    join public.staxis_source_facts fact
      on fact.id = link.source_fact_id and fact.property_id = link.property_id
    join public.staxis_source_definitions definition
      on definition.id = fact.source_definition_id and definition.property_id = fact.property_id
   where link.admission_id = new.admission_id and link.property_id = new.property_id;
  if not coalesce(v_has_facts, false) or coalesce(v_stale_facts, true) then
    raise exception 'lifecycle source facts are missing, incomplete, cross-property, or stale'
      using errcode = 'check_violation';
  end if;

  select exists (select 1 from public.staxis_lifecycle_events event
                  where event.lifecycle_id = new.id and event.property_id = new.property_id
                    and event.to_state = 'proposed') into v_has_proposal;
  select exists (select 1 from public.staxis_lifecycle_events event
                  where event.lifecycle_id = new.id and event.property_id = new.property_id
                    and event.to_state = 'approved') into v_has_approval;
  select exists (select 1 from public.staxis_lifecycle_events event
                  where event.lifecycle_id = new.id and event.property_id = new.property_id
                    and event.to_state = 'executed'
                    and event.execution_receipt is not null) into v_has_receipt;
  select exists (select 1 from public.staxis_lifecycle_events event
                  where event.lifecycle_id = new.id and event.property_id = new.property_id
                    and event.to_state = 'outcome_verified'
                    and event.outcome_basis is not null) into v_has_verified_outcome;
  select exists (select 1 from public.staxis_lifecycle_events event
                  where event.lifecycle_id = new.id and event.property_id = new.property_id
                    and event.to_state = new.state
                    and char_length(btrim(coalesce(event.outcome_basis, ''))) > 0) into v_has_outcome_basis;
  if new.state = 'proposed' and not v_has_proposal then
    raise exception 'proposed lifecycle state requires a proposal event'
      using errcode = 'check_violation';
  elsif new.state = 'approved' and (not v_has_proposal or not v_has_approval) then
    raise exception 'approved lifecycle state requires proposal and approval proof'
      using errcode = 'check_violation';
  elsif new.state = 'executed' and (not v_has_receipt) then
    raise exception 'executed lifecycle state requires an execution receipt'
      using errcode = 'check_violation';
  elsif new.state = 'outcome_verified' and (not v_has_receipt or not v_has_verified_outcome) then
    raise exception 'outcome_verified requires execution receipt and outcome basis'
      using errcode = 'check_violation';
  elsif new.state in ('not_observable', 'unverifiable') and not v_has_outcome_basis then
    raise exception '% lifecycle state requires an outcome basis', new.state
      using errcode = 'check_violation';
  end if;
  new.prior_states := array_append(old.prior_states, old.state);
  return new;
end;
$$;

drop trigger if exists staxis_lifecycle_records_immutable_tg
  on public.staxis_lifecycle_records;
create trigger staxis_lifecycle_records_immutable_tg
  before insert or update or delete on public.staxis_lifecycle_records
  for each row execute function public.staxis_lifecycle_record_immutable();

create or replace function public.staxis_lifecycle_event_immutable()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record public.staxis_lifecycle_records%rowtype;
  v_actor_user_id uuid;
  v_actor_role text;
  v_outcome_fact public.staxis_source_facts%rowtype;
  v_executed_event public.staxis_lifecycle_events%rowtype;
  v_approved_actor_id uuid;
  v_approved_event_id uuid;
  v_required_receipt_field text;
begin
  if tg_op <> 'INSERT' then
    if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
      return old;
    end if;
    if tg_op = 'UPDATE' and pg_trigger_depth() > 1 then
      return new;
    end if;
    raise exception 'staxis_lifecycle_events are append-only'
      using errcode = 'check_violation';
  end if;
  select * into strict v_record
    from public.staxis_lifecycle_records record
   where record.id = new.lifecycle_id and record.property_id = new.property_id
   for update;
  if new.actor_account_id is not null then
    select account.data_user_id, account.role into v_actor_user_id, v_actor_role
      from public.accounts account
     where account.id = new.actor_account_id;
  end if;
  -- Serialize event append and reject dangling/out-of-order events. The only
  -- same-state event is the one initial observed proof emitted by the bundle
  -- admission RPC.
  if new.event_kind = 'custody_updated' and new.from_state <> new.to_state then
    raise exception 'custody update cannot advance lifecycle state'
      using errcode = 'check_violation';
  end if;
  if new.event_kind = 'custody_updated' and v_record.state <> new.from_state then
    raise exception 'custody update starts at %, but record is currently %', new.from_state, v_record.state
      using errcode = 'check_violation';
  end if;
  if new.event_kind = 'custody_updated' and v_record.state not in ('executed', 'outcome_verified', 'not_observable', 'unverifiable') then
    raise exception 'custody updates are only valid after execution'
      using errcode = 'check_violation';
  end if;
  if new.event_kind = 'state_transition'
     and new.from_state = 'observed' and new.to_state = 'observed'
     and new.domain_reference <> '{}'::jsonb then
    raise exception 'initial observed proof cannot claim a domain work item'
      using errcode = 'check_violation';
  end if;
  if new.event_kind = 'state_transition'
     and new.to_state in ('proposed', 'approved')
     and new.domain_reference <> '{}'::jsonb then
    raise exception 'pre-execution lifecycle proof cannot claim a domain work item'
      using errcode = 'check_violation';
  end if;
  if not (new.event_kind = 'state_transition' and new.from_state = 'observed' and new.to_state = 'observed')
     and new.event_kind <> 'custody_updated'
     and v_record.state <> new.from_state then
    raise exception 'lifecycle event starts at %, but record is currently %', new.from_state, v_record.state
      using errcode = 'check_violation';
  end if;
  if new.event_kind = 'state_transition'
     and new.from_state = 'observed' and new.to_state = 'observed'
     and exists (
       select 1 from public.staxis_lifecycle_events prior
        where prior.lifecycle_id = new.lifecycle_id and prior.property_id = new.property_id
          and prior.from_state = 'observed' and prior.to_state = 'observed'
     ) then
    raise exception 'lifecycle observed proof already exists'
      using errcode = 'unique_violation';
  end if;
  if new.event_kind = 'custody_updated' then
    if new.domain_reference is null
       or jsonb_typeof(new.domain_reference) <> 'object'
       or coalesce(new.domain_reference ->> 'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or jsonb_typeof(new.owner_snapshot) <> 'object'
       or char_length(btrim(coalesce(new.owner_snapshot ->> 'kind', ''))) = 0
       or new.actor_account_id is null
       or not (new.actor_snapshot ? 'id' or new.actor_snapshot ? 'label' or new.actor_snapshot ? 'role')
    then
      raise exception 'custody update requires nonempty domain and owner snapshots'
        using errcode = 'check_violation';
    end if;
    if v_actor_user_id is null or not public.staxis_account_reaches_property(v_actor_user_id, new.property_id) then
      raise exception 'custody actor does not reach this hotel'
        using errcode = 'foreign_key_violation';
    end if;
    return new;
  end if;
  if not (
    (new.from_state = 'observed' and new.to_state in ('observed', 'proposed'))
    or (new.from_state = 'proposed' and new.to_state in ('approved'))
    or (new.from_state = 'approved' and new.to_state in ('executed'))
    or (new.from_state = 'executed' and new.to_state in ('outcome_verified', 'not_observable', 'unverifiable'))
  ) then
    raise exception 'illegal lifecycle event transition % -> %', new.from_state, new.to_state
      using errcode = 'check_violation';
  end if;
  if new.to_state = 'executed' and (
    new.execution_receipt is null
    or jsonb_typeof(new.execution_receipt) <> 'object'
    or coalesce(new.execution_receipt ->> 'contractVersion', new.execution_receipt ->> 'contract_version') <> 'staxis-action.v1'
    or coalesce(new.execution_receipt #>> '{effect,boundary}', new.execution_receipt ->> 'boundary') <> 'in_app_only'
    or coalesce((new.execution_receipt ->> 'internalOnly')::boolean, false) is not true
    or coalesce(new.execution_receipt ->> 'physicalCompletionClaim', new.execution_receipt ->> 'physical_completion_claim') <> 'never'
    or coalesce(new.execution_receipt ->> 'propertyId', new.execution_receipt ->> 'property_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(new.execution_receipt ->> 'propertyId', new.execution_receipt ->> 'property_id') is distinct from new.property_id::text
    or char_length(btrim(coalesce(new.execution_receipt ->> 'idempotencyKey', new.execution_receipt ->> 'idempotency_key', ''))) = 0
    or coalesce(new.execution_receipt ->> 'targetId', new.execution_receipt ->> 'target_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or char_length(btrim(coalesce(new.execution_receipt ->> 'targetKind', new.execution_receipt ->> 'target_kind', ''))) = 0
    or coalesce(new.execution_receipt ->> 'executedBy', new.execution_receipt ->> 'executed_by', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(new.execution_receipt ->> 'executedAt', new.execution_receipt ->> 'executed_at', '') = ''
    or (coalesce(new.execution_receipt ->> 'executedAt', new.execution_receipt ->> 'executed_at')::timestamptz) > new.occurred_at
    or (coalesce(new.execution_receipt ->> 'executedAt', new.execution_receipt ->> 'executed_at')::timestamptz) > clock_timestamp() + interval '5 minutes'
    or coalesce(new.execution_receipt ->> 'frozenInputHash', new.execution_receipt ->> 'frozen_input_hash') <> v_record.frozen_input_hash
    or jsonb_typeof(new.execution_receipt -> 'inputVerification') <> 'object'
    or new.execution_receipt #>> '{inputVerification,state}' <> 'matched'
    or (new.execution_receipt #>> '{inputVerification,verifiedAt}')::timestamptz is null
    or (new.execution_receipt #>> '{inputVerification,verifiedAt}')::timestamptz > (coalesce(new.execution_receipt ->> 'executedAt', new.execution_receipt ->> 'executed_at')::timestamptz)
    or jsonb_typeof(new.execution_receipt -> 'receipt') <> 'object'
    or jsonb_typeof(new.domain_reference) <> 'object'
    or coalesce(new.domain_reference ->> 'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or jsonb_typeof(new.owner_snapshot) <> 'object'
    or char_length(btrim(coalesce(new.owner_snapshot ->> 'kind', ''))) = 0
  ) then
    raise exception 'executed lifecycle event requires an execution receipt'
      using errcode = 'check_violation';
  end if;
  if new.to_state = 'executed'
     and coalesce(new.execution_receipt ->> 'targetId', new.execution_receipt ->> 'target_id')
         is distinct from new.domain_reference ->> 'id' then
    raise exception 'execution receipt target and domain reference do not match'
      using errcode = 'check_violation';
  end if;
  if new.to_state = 'executed'
     and coalesce(new.execution_receipt ->> 'targetKind', new.execution_receipt ->> 'target_kind')
         is distinct from new.domain_reference ->> 'kind' then
    raise exception 'execution receipt target kind and domain reference do not match'
      using errcode = 'check_violation';
  end if;
  if new.to_state = 'executed'
     and coalesce(new.execution_receipt ->> 'targetKind', new.execution_receipt ->> 'target_kind')
         is distinct from coalesce(new.execution_receipt #>> '{effect,targetKind}', new.execution_receipt ->> 'targetKind') then
    raise exception 'execution receipt target kind and admitted effect target kind do not match'
      using errcode = 'check_violation';
  end if;
  if new.to_state = 'executed'
     and coalesce(new.execution_receipt ->> 'executedBy', new.execution_receipt ->> 'executed_by')
         is distinct from new.actor_account_id::text then
    raise exception 'execution receipt actor does not match the authenticated lifecycle actor'
      using errcode = 'check_violation';
  end if;
  if new.to_state = 'approved' then
    if jsonb_typeof(new.approval_proof) <> 'object'
       or new.approval_proof ->> 'decision' <> 'approved'
       or new.approval_proof ->> 'policyId' <> v_record.action_contract #>> '{approval,policyId}'
       or new.approval_proof ->> 'mode' <> v_record.action_contract #>> '{approval,mode}'
       or new.approval_proof ->> 'tier' <> v_record.action_contract #>> '{approval,tier}' then
      raise exception 'approved lifecycle event requires a matching approval policy proof'
        using errcode = 'check_violation';
    end if;
  elsif new.approval_proof is not null then
    raise exception 'approval proof is only valid on the approved transition'
      using errcode = 'check_violation';
  end if;
  if new.to_state in ('outcome_verified', 'not_observable', 'unverifiable')
     and char_length(btrim(coalesce(new.outcome_basis, ''))) = 0 then
    raise exception 'terminal lifecycle event requires an outcome basis'
      using errcode = 'check_violation';
  end if;
  if new.to_state in ('outcome_verified', 'not_observable', 'unverifiable') then
    select * into strict v_executed_event
      from public.staxis_lifecycle_events prior
     where prior.lifecycle_id = new.lifecycle_id
       and prior.property_id = new.property_id
       and prior.to_state = 'executed'
       and prior.execution_receipt is not null
     order by prior.occurred_at desc
     limit 1;
    if coalesce(new.domain_reference ->> 'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or char_length(btrim(coalesce(new.owner_snapshot ->> 'kind', ''))) = 0
       or new.domain_reference ->> 'id' is distinct from v_executed_event.domain_reference ->> 'id'
       or new.domain_reference ->> 'kind' is distinct from v_executed_event.domain_reference ->> 'kind' then
      raise exception 'terminal lifecycle proof must retain the executed domain item'
        using errcode = 'check_violation';
    end if;
    if new.to_state in ('not_observable', 'unverifiable') and new.outcome_source_fact_id is not null then
      raise exception 'unverifiable outcome cannot claim source-fact verification'
        using errcode = 'check_violation';
    end if;
  end if;
  if new.to_state = 'outcome_verified' then
    if new.from_state <> 'executed' or new.outcome_source_fact_id is null then
      raise exception 'outcome_verified requires an executed predecessor and source fact proof'
        using errcode = 'check_violation';
    end if;
    select * into strict v_outcome_fact
      from public.staxis_source_facts fact
     where fact.id = new.outcome_source_fact_id
       and fact.property_id = new.property_id;
    select * into strict v_executed_event
      from public.staxis_lifecycle_events prior
     where prior.lifecycle_id = new.lifecycle_id
       and prior.property_id = new.property_id
       and prior.to_state = 'executed'
       and prior.execution_receipt is not null
     order by prior.occurred_at desc
     limit 1;
    if coalesce(new.domain_reference ->> 'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or new.domain_reference ->> 'id' is distinct from v_executed_event.domain_reference ->> 'id'
       or new.domain_reference ->> 'kind' is distinct from v_executed_event.domain_reference ->> 'kind'
       or v_outcome_fact.entity_kind is distinct from new.domain_reference ->> 'kind'
       or v_outcome_fact.entity_id is distinct from new.domain_reference ->> 'id'
       or v_outcome_fact.observed_at < v_executed_event.occurred_at then
      raise exception 'outcome proof must describe the executed domain item and occur after execution'
        using errcode = 'check_violation';
    end if;
    if v_outcome_fact.completeness <> 'complete'
       or (v_outcome_fact.expires_at is not null and v_outcome_fact.expires_at <= clock_timestamp())
       or exists (
         select 1 from public.staxis_source_definitions definition
          where definition.id = v_outcome_fact.source_definition_id
            and definition.property_id = v_outcome_fact.property_id
            and definition.freshness_required
            and (definition.freshness_max_age_seconds is null
                 or clock_timestamp() > v_outcome_fact.as_of + make_interval(secs => definition.freshness_max_age_seconds))
       ) then
      raise exception 'outcome source fact is stale, expired, incomplete, or not admissible'
        using errcode = 'check_violation';
    end if;
  end if;
  if new.to_state in ('approved', 'executed') then
    if new.actor_account_id is null
       or jsonb_typeof(new.actor_snapshot) <> 'object'
       or not (new.actor_snapshot ? 'id' or new.actor_snapshot ? 'label' or new.actor_snapshot ? 'role') then
      raise exception '% lifecycle event requires an actor account and snapshot', new.to_state
        using errcode = 'check_violation';
    end if;
    if not exists (
      select 1 from jsonb_array_elements_text(v_record.action_contract #> '{authority,roles}') allowed_role
       where allowed_role.value = v_actor_role
    )
       or new.actor_snapshot ->> 'role' is distinct from v_actor_role then
      raise exception '% lifecycle actor role is not authorized by the reviewed action contract', new.to_state
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  if new.to_state = 'executed' then
    select prior.id, prior.actor_account_id into v_approved_event_id, v_approved_actor_id
      from public.staxis_lifecycle_events prior
     where prior.lifecycle_id = new.lifecycle_id
       and prior.property_id = new.property_id
       and prior.to_state = 'approved'
     order by prior.occurred_at desc
     limit 1;
    if v_approved_event_id is null or v_approved_actor_id is null or new.actor_account_id <> v_approved_actor_id then
      raise exception 'executed lifecycle event must retain the approving actor'
        using errcode = 'check_violation';
    end if;
    if coalesce(new.execution_receipt ->> 'approvalId', new.execution_receipt ->> 'approval_id') <> v_approved_event_id::text then
      raise exception 'executed lifecycle event must reference its approval proof'
        using errcode = 'check_violation';
    end if;
    if v_record.proposal_id is null
       or coalesce(new.execution_receipt ->> 'proposalId', new.execution_receipt ->> 'proposal_id') is distinct from v_record.proposal_id::text
       or (new.execution_receipt ->> 'actionId' is not null and v_record.finding_action_id is null)
       or (new.execution_receipt ->> 'actionId' is not null and new.execution_receipt ->> 'actionId' is distinct from v_record.finding_action_id::text)
       or (new.execution_receipt ->> 'action_id' is not null and v_record.finding_action_id is null)
       or (new.execution_receipt ->> 'action_id' is not null and new.execution_receipt ->> 'action_id' is distinct from v_record.finding_action_id::text) then
      raise exception 'execution receipt action/proposal identity does not match the lifecycle proposal'
        using errcode = 'check_violation';
    end if;
    if coalesce(new.execution_receipt ->> 'idempotencyKey', new.execution_receipt ->> 'idempotency_key')
         is distinct from nullif(v_record.action_idempotency_key, '') then
      raise exception 'execution receipt idempotency key does not match the lifecycle action'
        using errcode = 'check_violation';
    end if;
    if new.execution_receipt -> 'effect' is distinct from v_record.action_contract -> 'effect'
       or coalesce(new.execution_receipt #>> '{effect,boundary}', new.execution_receipt ->> 'boundary') <> v_record.action_contract #>> '{effect,boundary}'
       or coalesce(new.execution_receipt #>> '{effect,targetKind}', new.execution_receipt ->> 'targetKind') <> v_record.action_contract #>> '{effect,targetKind}' then
      raise exception 'execution receipt effect does not match the admitted action contract'
        using errcode = 'check_violation';
    end if;
    for v_required_receipt_field in
      select value from jsonb_array_elements_text(coalesce(v_record.action_contract #> '{receipt,requiredFields}', '[]'::jsonb))
    loop
      if not ((new.execution_receipt -> 'receipt') ? v_required_receipt_field) then
        raise exception 'execution receipt is missing required field %', v_required_receipt_field
          using errcode = 'check_violation';
      end if;
    end loop;
  end if;
  if new.actor_account_id is not null then
    if v_actor_user_id is null or not public.staxis_account_reaches_property(v_actor_user_id, new.property_id) then
      raise exception 'lifecycle actor does not reach this hotel'
        using errcode = 'foreign_key_violation';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists staxis_lifecycle_events_immutable_tg
  on public.staxis_lifecycle_events;
create trigger staxis_lifecycle_events_immutable_tg
  before insert or update or delete on public.staxis_lifecycle_events
  for each row execute function public.staxis_lifecycle_event_immutable();

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Safe bounded projection (the only browser-readable lifecycle surface).
-- ───────────────────────────────────────────────────────────────────────────
create or replace view public.staxis_lifecycle_projection_v1 as
with lifecycle_evidence as (
  select lifecycle.id as lifecycle_id,
         lifecycle.property_id,
         fact.id as source_fact_id,
         fact.entity_label,
         fact.source_definition_id,
         fact.effective_at,
         fact.as_of,
         fact.observed_at,
         fact.received_at,
         fact.expires_at,
         fact.completeness,
         fact.completeness_reason,
         fact.owner_kind,
         fact.owner_label,
         fact.owner_role,
         fact.authority_level,
         fact.precedence_rank,
         fact.created_at as evidence_recorded_at,
         receipt.id as receipt_id,
         receipt.source_reference,
         receipt.receipt_hash,
         definition.source_class,
         definition.category,
         definition.claim_scope,
         definition.completeness_required,
         definition.freshness_required,
         definition.freshness_max_age_seconds
    from public.staxis_lifecycle_records lifecycle
    join public.staxis_finding_source_facts link
      on link.admission_id = lifecycle.admission_id
     and link.property_id = lifecycle.property_id
    join public.staxis_source_facts fact
      on fact.id = link.source_fact_id
     and fact.property_id = link.property_id
    join public.staxis_source_receipts receipt
      on receipt.id = fact.source_receipt_id
     and receipt.property_id = fact.property_id
    join public.staxis_source_definitions definition
      on definition.id = fact.source_definition_id
     and definition.property_id = fact.property_id
  union
  select lifecycle.id as lifecycle_id,
         lifecycle.property_id,
         fact.id as source_fact_id,
         fact.entity_label,
         fact.source_definition_id,
         fact.effective_at,
         fact.as_of,
         fact.observed_at,
         fact.received_at,
         fact.expires_at,
         fact.completeness,
         fact.completeness_reason,
         fact.owner_kind,
         fact.owner_label,
         fact.owner_role,
         fact.authority_level,
         fact.precedence_rank,
         fact.created_at as evidence_recorded_at,
         receipt.id as receipt_id,
         receipt.source_reference,
         receipt.receipt_hash,
         definition.source_class,
         definition.category,
         definition.claim_scope,
         definition.completeness_required,
         definition.freshness_required,
         definition.freshness_max_age_seconds
    from public.staxis_lifecycle_records lifecycle
    join public.staxis_lifecycle_events outcome_event
      on outcome_event.lifecycle_id = lifecycle.id
     and outcome_event.property_id = lifecycle.property_id
     and outcome_event.to_state = 'outcome_verified'
     and outcome_event.outcome_source_fact_id is not null
    join public.staxis_source_facts fact
      on fact.id = outcome_event.outcome_source_fact_id
     and fact.property_id = outcome_event.property_id
    join public.staxis_source_receipts receipt
      on receipt.id = fact.source_receipt_id
     and receipt.property_id = fact.property_id
    join public.staxis_source_definitions definition
      on definition.id = fact.source_definition_id
     and definition.property_id = fact.property_id
)
select
  'staxis-lifecycle.v1'::text as contract_version,
  lifecycle.id as projection_id,
  lifecycle.property_id,
  lifecycle.finding_id,
  lifecycle.proposal_id as proposal_id,
  nullif((select event.id from public.staxis_lifecycle_events event
           where event.lifecycle_id = lifecycle.id and event.property_id = lifecycle.property_id
             and event.to_state = 'approved' order by event.occurred_at desc limit 1), null) as approval_id,
  nullif((select event.id from public.staxis_lifecycle_events event
           where event.lifecycle_id = lifecycle.id and event.property_id = lifecycle.property_id
             and event.to_state = 'executed' and event.execution_receipt is not null
           order by event.occurred_at desc limit 1), null) as execution_receipt_id,
  lifecycle.entity_kind,
  lifecycle.entity_id,
  lifecycle.entity_label,
  coalesce(nullif(lifecycle.title_snapshot, ''), finding.summary, 'Lifecycle item') as title,
  coalesce(lifecycle.summary_snapshot, finding.summary) as summary,
  lifecycle.state,
  lifecycle.prior_states,
  coalesce((select array_agg(evidence.source_fact_id order by evidence.effective_at, evidence.source_fact_id)
              from lifecycle_evidence evidence
             where evidence.lifecycle_id = lifecycle.id and evidence.property_id = lifecycle.property_id), '{}'::uuid[]) as source_fact_ids,
  coalesce((select jsonb_agg(jsonb_build_object(
      'id', evidence.source_fact_id,
      'kind', evidence.source_class,
      'label', coalesce(evidence.entity_label, evidence.category),
      'reference', evidence.source_reference,
      'receiptId', evidence.receipt_id::text,
      'receiptHash', evidence.receipt_hash,
      'sourceDefinitionId', evidence.source_definition_id,
      'claimScope', evidence.claim_scope,
      'contractVersion', 'staxis-source-fact.v1',
      'effectiveAt', evidence.effective_at,
      'asOf', evidence.as_of,
      'observedAt', evidence.observed_at,
      'receivedAt', evidence.received_at,
      'completeness', evidence.completeness,
      'completenessReason', evidence.completeness_reason,
      'completenessRequired', evidence.completeness_required,
      'freshness', case
        when not evidence.freshness_required then 'fresh'
        when evidence.freshness_max_age_seconds is not null
          and clock_timestamp() <= evidence.as_of + make_interval(secs => evidence.freshness_max_age_seconds)
          and (evidence.expires_at is null or evidence.expires_at > clock_timestamp()) then 'fresh'
        when evidence.freshness_required then 'stale'
        else 'unknown' end,
      'freshnessMaxAgeSeconds', evidence.freshness_max_age_seconds,
      'owner', jsonb_build_object('kind', evidence.owner_kind, 'label', evidence.owner_label, 'role', evidence.owner_role),
      'authority', evidence.authority_level,
      'precedence', evidence.precedence_rank
    ) order by evidence.effective_at desc, evidence.source_fact_id)
    from lifecycle_evidence evidence
   where evidence.lifecycle_id = lifecycle.id and evidence.property_id = lifecycle.property_id), '[]'::jsonb) as sources,
  (select min(evidence.effective_at) from lifecycle_evidence evidence
   where evidence.lifecycle_id = lifecycle.id and evidence.property_id = lifecycle.property_id) as effective_at,
  (select min(evidence.as_of) from lifecycle_evidence evidence
   where evidence.lifecycle_id = lifecycle.id and evidence.property_id = lifecycle.property_id) as as_of,
  (select max(evidence.observed_at) from lifecycle_evidence evidence
   where evidence.lifecycle_id = lifecycle.id and evidence.property_id = lifecycle.property_id) as observed_at,
  greatest(
    lifecycle.recorded_at,
    coalesce((select max(event.occurred_at)
      from public.staxis_lifecycle_events event
     where event.lifecycle_id = lifecycle.id and event.property_id = lifecycle.property_id), lifecycle.recorded_at),
    coalesce((select max(evidence.received_at)
      from lifecycle_evidence evidence
     where evidence.lifecycle_id = lifecycle.id and evidence.property_id = lifecycle.property_id), lifecycle.recorded_at)
  ) as recorded_at,
  coalesce((select jsonb_build_object(
      'status', case when count(*) = 0 then 'unknown'
        when bool_and(not evidence.freshness_required
          or (evidence.freshness_max_age_seconds is not null
              and clock_timestamp() <= evidence.as_of + make_interval(secs => evidence.freshness_max_age_seconds)
              and (evidence.expires_at is null or evidence.expires_at > clock_timestamp()))) then 'fresh'
        else 'stale' end,
      'max_age_seconds', min(evidence.freshness_max_age_seconds)
    ) from lifecycle_evidence evidence
   where evidence.lifecycle_id = lifecycle.id and evidence.property_id = lifecycle.property_id), jsonb_build_object('status', 'unknown', 'max_age_seconds', null)) as freshness,
  coalesce((select jsonb_build_object(
      'status', case when count(*) = 0 then 'unknown'
                     when bool_or(evidence.completeness = 'unknown') then 'unknown'
                     when bool_or(evidence.completeness = 'partial') then 'partial'
                     else 'complete' end,
      'reason', case when bool_or(evidence.completeness in ('partial', 'unknown'))
                     then coalesce(max(nullif(btrim(evidence.completeness_reason), '')), 'derived from source fact completeness')
                     else null end
    ) from lifecycle_evidence evidence
   where evidence.lifecycle_id = lifecycle.id and evidence.property_id = lifecycle.property_id), jsonb_build_object('status', 'unknown', 'reason', null)) as completeness,
  jsonb_build_object(
    'owner', jsonb_build_object('kind', lifecycle.owner_kind, 'label', lifecycle.owner_label, 'role', lifecycle.owner_role),
    -- A scalar level/precedence is emitted only when one claim scope backs the
    -- projection. Distinct scopes remain separate; there is no global source
    -- hierarchy or max across unrelated ownership claims.
    'level', case when (select count(distinct evidence.claim_scope)
                          from lifecycle_evidence evidence
                         where evidence.lifecycle_id = lifecycle.id and evidence.property_id = lifecycle.property_id) = 1
                   then (select evidence.authority_level
                           from lifecycle_evidence evidence
                          where evidence.lifecycle_id = lifecycle.id and evidence.property_id = lifecycle.property_id
                          order by evidence.effective_at desc, evidence.source_fact_id limit 1)
                   else null end,
    'precedence', case when (select count(distinct evidence.claim_scope)
                               from lifecycle_evidence evidence
                              where evidence.lifecycle_id = lifecycle.id and evidence.property_id = lifecycle.property_id) = 1
                        then (select evidence.precedence_rank
                                from lifecycle_evidence evidence
                               where evidence.lifecycle_id = lifecycle.id and evidence.property_id = lifecycle.property_id
                               order by evidence.effective_at desc, evidence.source_fact_id limit 1)
                        else null end,
    'scopes', coalesce((select jsonb_agg(jsonb_build_object('claimScope', scoped.claim_scope, 'authority', scoped.authority_level, 'precedence', scoped.precedence_rank) order by scoped.claim_scope)
                from (
                  select distinct on (evidence.claim_scope)
                         evidence.claim_scope, evidence.authority_level, evidence.precedence_rank
                    from lifecycle_evidence evidence
                   where evidence.lifecycle_id = lifecycle.id and evidence.property_id = lifecycle.property_id
                   order by evidence.claim_scope, evidence.effective_at desc, evidence.source_fact_id
                ) scoped), '[]'::jsonb)
  ) as authority,
  (select jsonb_build_object(
      'id', coalesce(lifecycle.proposal_id, lifecycle.finding_action_id, lifecycle.id),
      'kind', coalesce(lifecycle.action_kind, finding_action.action_kind, lifecycle.action_contract #>> '{effect,operation}'),
      'targetId', coalesce(
        finding_action.created_object_id::text,
        (select event.domain_reference ->> 'id'
           from public.staxis_lifecycle_events event
          where event.lifecycle_id = lifecycle.id and event.property_id = lifecycle.property_id
            and event.to_state = 'executed'
            and event.domain_reference ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          order by event.occurred_at desc limit 1)
      ),
      'contractVersion', coalesce(lifecycle.action_contract ->> 'contractVersion', 'staxis-action.v1'),
      'effect', lifecycle.action_contract -> 'effect',
      'authority', lifecycle.action_contract -> 'authority',
      'approval', jsonb_build_object('mode', lifecycle.action_contract #>> '{approval,mode}', 'tier', lifecycle.action_contract #>> '{approval,tier}', 'policyId', lifecycle.action_contract #>> '{approval,policyId}', 'state', case when lifecycle.state in ('approved','executed','outcome_verified') or 'approved' = any(lifecycle.prior_states) then 'approved' else 'required' end),
      'frozenInput', jsonb_build_object('immutable', true, 'fields', lifecycle.action_contract #> '{frozenInput,fields}', 'fingerprint', 'server_sha256', 'staleInput', 'decline', 'hash', lifecycle.frozen_input_hash),
      'idempotency', lifecycle.action_contract -> 'idempotency',
      'receipt', lifecycle.action_contract -> 'receipt',
      'outcome', jsonb_build_object(
        'observability', coalesce(lifecycle.action_contract #>> '{outcome,observability}', 'observable'),
        'verificationState', case
          when lifecycle.state = 'outcome_verified' then 'verified'
          when lifecycle.state = 'not_observable' then 'not_observable'
          when lifecycle.state = 'unverifiable' then 'unverifiable'
          else 'pending' end,
        'verificationWindowDays', greatest(1, coalesce((lifecycle.action_contract #>> '{outcome,verificationWindowDays}')::integer, 1)),
        'basisRequired', true,
        'state', case
          when lifecycle.state = 'outcome_verified' then 'verified'
          when lifecycle.state = 'not_observable' then 'not_observable'
          when lifecycle.state = 'unverifiable' then 'unverifiable'
          else 'pending' end,
        'basis', (select event.outcome_basis
                    from public.staxis_lifecycle_events event
                   where event.lifecycle_id = lifecycle.id and event.property_id = lifecycle.property_id
                     and event.to_state in ('outcome_verified', 'not_observable', 'unverifiable')
                   order by event.occurred_at desc limit 1),
        'observedAt', (select event.occurred_at
                        from public.staxis_lifecycle_events event
                       where event.lifecycle_id = lifecycle.id and event.property_id = lifecycle.property_id
                         and event.to_state in ('outcome_verified', 'not_observable', 'unverifiable')
                       order by event.occurred_at desc limit 1)
      )
    ) where lifecycle.action_contract is not null) as action,
  (select jsonb_build_object(
      'kind', event.domain_reference ->> 'kind',
      'id', event.domain_reference ->> 'id',
      'label', event.domain_reference ->> 'label',
      'href', null,
      'observedAt', event.occurred_at,
      'owner', coalesce(event.owner_snapshot, jsonb_build_object('kind', lifecycle.owner_kind, 'label', lifecycle.owner_label, 'role', lifecycle.owner_role))
    )
     from public.staxis_lifecycle_events event
    where event.lifecycle_id = lifecycle.id and event.property_id = lifecycle.property_id
      and (event.to_state in ('executed', 'outcome_verified', 'not_observable', 'unverifiable') or event.event_kind = 'custody_updated')
      and char_length(btrim(coalesce(event.domain_reference ->> 'id', ''))) > 0
    order by event.occurred_at desc limit 1) as domain_work_item,
  case when lifecycle.state = 'executed' then
    jsonb_build_object('id', null, 'state', 'pending', 'basis', null, 'sourceFactId', null, 'observed_at', null)
  else (select jsonb_build_object('id', event.id, 'state', case when event.to_state = 'outcome_verified' then 'verified' when event.to_state = 'not_observable' then 'not_observable' else 'unverifiable' end,
                                  'basis', event.outcome_basis,
                                  'sourceFactId', event.outcome_source_fact_id,
                                  'observed_at', event.occurred_at)
          from public.staxis_lifecycle_events event
         where event.lifecycle_id = lifecycle.id and event.property_id = lifecycle.property_id
           and event.to_state in ('outcome_verified', 'not_observable', 'unverifiable')
         order by event.occurred_at desc limit 1)
  end as outcome,
  (select event.id
     from public.staxis_lifecycle_events event
    where event.lifecycle_id = lifecycle.id and event.property_id = lifecycle.property_id
      and event.to_state in ('outcome_verified', 'not_observable', 'unverifiable')
    order by event.occurred_at desc limit 1) as outcome_evidence_id,
  lifecycle.reason
from public.staxis_lifecycle_records lifecycle
left join public.findings finding on finding.id = lifecycle.finding_id and finding.property_id = lifecycle.property_id
left join public.finding_actions finding_action on finding_action.id = lifecycle.finding_action_id and finding_action.property_id = lifecycle.property_id
;

comment on view public.staxis_lifecycle_projection_v1 is
  'Safe exact-hotel lifecycle projection. It omits source fact values, admission evidence, action parameters, and raw PMS paths; current freshness is derived from as_of plus the registered definition max age at read time.';

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Narrow atomic service RPCs.
-- ───────────────────────────────────────────────────────────────────────────
-- All three functions are deliberately JSON-envelope APIs so a producer can
-- retry the same idempotency key without a partially recorded chain. Every
-- write remains inside the caller's transaction and every failure is a hard
-- false result (the bundle RPC raises, rolling back all preceding inserts).

create or replace function public.staxis_record_source_fact(
  p_property_id uuid,
  p_bundle jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_definition_id uuid;
  v_receipt_id uuid;
  v_fact_id uuid;
  v_receipt jsonb;
  v_fact jsonb;
  v_source_hash text;
  v_receipt_external_id text;
  v_source_reference text;
  v_as_of timestamptz;
  v_observed_at timestamptz;
  v_received_at timestamptz;
  v_entity_kind text;
  v_entity_id text;
  v_effective_at timestamptz;
  v_receipt_replayed boolean := false;
  v_fact_replayed boolean := false;
  v_receipt_hash text;
  v_fingerprint text;
  v_existing_receipt public.staxis_source_receipts%rowtype;
  v_existing_fact public.staxis_source_facts%rowtype;
begin
  if p_property_id is null or jsonb_typeof(p_bundle) <> 'object' then
    raise exception 'source fact bundle is invalid' using errcode = 'check_violation';
  end if;
  if p_bundle ->> 'propertyId' is not null and p_bundle ->> 'propertyId' <> p_property_id::text then
    raise exception 'source fact bundle property does not match its scoped writer' using errcode = 'foreign_key_violation';
  end if;
  v_definition_id := nullif(coalesce(p_bundle ->> 'sourceDefinitionId', p_bundle ->> 'source_definition_id'), '')::uuid;
  v_receipt := coalesce(p_bundle -> 'receipt', p_bundle);
  v_fact := coalesce(p_bundle -> 'fact', p_bundle);
  v_source_hash := coalesce(v_receipt ->> 'sourceHash', v_receipt ->> 'source_hash');
  if v_source_hash is null or v_source_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'source hash must be a caller-supplied SHA-256 digest' using errcode = 'check_violation';
  end if;
  -- `receiptId` is retained as a compatibility alias for the producer's
  -- external token; the durable UUID returned below is always DB-generated.
  v_receipt_external_id := coalesce(
    v_receipt ->> 'externalReceiptId', v_receipt ->> 'external_receipt_id',
    v_receipt ->> 'receiptId', v_receipt ->> 'receipt_id'
  );
  v_source_reference := coalesce(v_receipt ->> 'sourceReference', v_receipt ->> 'source_reference');
  v_as_of := coalesce(v_receipt ->> 'asOf', v_receipt ->> 'as_of')::timestamptz;
  v_observed_at := coalesce(v_receipt ->> 'observedAt', v_receipt ->> 'observed_at')::timestamptz;
  v_received_at := coalesce(v_receipt ->> 'receivedAt', v_receipt ->> 'received_at')::timestamptz;
  v_entity_kind := coalesce(v_fact ->> 'entityKind', v_fact ->> 'entity_kind');
  v_entity_id := coalesce(v_fact ->> 'entityId', v_fact ->> 'entity_id');
  v_effective_at := coalesce(v_fact ->> 'effectiveAt', v_fact ->> 'effective_at')::timestamptz;
  if jsonb_typeof(v_fact -> 'value') <> 'object' then
    raise exception 'source fact value must be an object' using errcode = 'check_violation';
  end if;

  select receipt.* into v_existing_receipt
    from public.staxis_source_receipts receipt
   where receipt.property_id = p_property_id
     and receipt.source_hash = v_source_hash
     and receipt.receipt_id is not distinct from v_receipt_external_id
   limit 1;
  v_receipt_replayed := v_existing_receipt.id is not null;
  if v_receipt_replayed and (
    v_existing_receipt.source_definition_id is distinct from v_definition_id
    or v_existing_receipt.source_reference is distinct from v_source_reference
    or v_existing_receipt.as_of is distinct from v_as_of
    or v_existing_receipt.observed_at is distinct from v_observed_at
    or v_existing_receipt.received_at is distinct from v_received_at
    or v_existing_receipt.completeness is distinct from coalesce(v_receipt ->> 'completeness', 'unknown')
    or v_existing_receipt.completeness_reason is distinct from v_receipt ->> 'completenessReason'
  ) then
    raise exception 'source receipt idempotency collision carries changed immutable content'
      using errcode = 'unique_violation';
  end if;

  insert into public.staxis_source_receipts (
    property_id, source_definition_id, source_reference, source_hash,
    receipt_id, as_of, observed_at, received_at, completeness, completeness_reason
  ) values (
    p_property_id, v_definition_id, v_source_reference, v_source_hash,
    v_receipt_external_id, v_as_of, v_observed_at, v_received_at,
    coalesce(v_receipt ->> 'completeness', 'unknown'),
    v_receipt ->> 'completenessReason'
  ) on conflict do nothing returning id into v_receipt_id;
  if v_receipt_id is null then
    v_receipt_replayed := true;
    select receipt.* into strict v_existing_receipt
      from public.staxis_source_receipts receipt
     where receipt.property_id = p_property_id
       and receipt.source_hash = v_source_hash
       and receipt.receipt_id is not distinct from v_receipt_external_id
     limit 1;
    v_receipt_id := v_existing_receipt.id;
  else
    select receipt.* into strict v_existing_receipt
      from public.staxis_source_receipts receipt
     where receipt.id = v_receipt_id and receipt.property_id = p_property_id;
  end if;
  if v_receipt_id is null then
    raise exception 'source receipt was not recorded' using errcode = 'check_violation';
  end if;
  if v_existing_receipt.source_definition_id is distinct from v_definition_id
     or v_existing_receipt.source_reference is distinct from v_source_reference
     or v_existing_receipt.as_of is distinct from v_as_of
     or v_existing_receipt.observed_at is distinct from v_observed_at
     or v_existing_receipt.received_at is distinct from v_received_at
     or v_existing_receipt.completeness is distinct from coalesce(v_receipt ->> 'completeness', 'unknown')
     or v_existing_receipt.completeness_reason is distinct from v_receipt ->> 'completenessReason'
  then
    raise exception 'source receipt idempotency collision carries changed immutable content'
      using errcode = 'unique_violation';
  end if;

  select fact.* into v_existing_fact
    from public.staxis_source_facts fact
   where fact.property_id = p_property_id
     and fact.source_receipt_id = v_receipt_id
     and fact.entity_kind = v_entity_kind
     and fact.entity_id = v_entity_id
     and fact.effective_at = v_effective_at
   limit 1;
  v_fact_replayed := v_existing_fact.id is not null;
  if v_fact_replayed and (
    v_existing_fact.source_definition_id is distinct from v_definition_id
    or v_existing_fact.entity_label is distinct from coalesce(v_fact ->> 'entityLabel', v_fact ->> 'entity_label')
    or v_existing_fact.value is distinct from coalesce(v_fact -> 'value', '{}'::jsonb)
    or v_existing_fact.expires_at is distinct from coalesce(v_fact ->> 'expiresAt', v_fact ->> 'expires_at')::timestamptz
    or v_existing_fact.supersedes_id is distinct from nullif(coalesce(v_fact ->> 'supersedesId', v_fact ->> 'supersedes_id'), '')::uuid
    or v_existing_fact.completeness is distinct from coalesce(v_fact ->> 'completeness', v_receipt ->> 'completeness', 'unknown')
    or v_existing_fact.completeness_reason is distinct from coalesce(v_fact ->> 'completenessReason', v_fact ->> 'completeness_reason', v_receipt ->> 'completenessReason', v_receipt ->> 'completeness_reason')
  ) then
    raise exception 'source fact idempotency collision carries changed immutable content'
      using errcode = 'unique_violation';
  end if;

  insert into public.staxis_source_facts (
    property_id, source_definition_id, source_receipt_id, entity_kind, entity_id,
    entity_label, effective_at, as_of, observed_at, received_at, expires_at,
    completeness, completeness_reason, value, supersedes_id
  ) values (
    p_property_id, v_definition_id, v_receipt_id, v_entity_kind, v_entity_id,
    coalesce(v_fact ->> 'entityLabel', v_fact ->> 'entity_label'), v_effective_at,
    v_as_of, v_observed_at, v_received_at,
    coalesce(v_fact ->> 'expiresAt', v_fact ->> 'expires_at')::timestamptz,
    coalesce(v_fact ->> 'completeness', v_receipt ->> 'completeness', 'unknown'),
    coalesce(v_fact ->> 'completenessReason', v_receipt ->> 'completenessReason'),
    coalesce(v_fact -> 'value', '{}'::jsonb),
    nullif(coalesce(v_fact ->> 'supersedesId', v_fact ->> 'supersedes_id'), '')::uuid
  ) on conflict do nothing;

  select fact.* into strict v_existing_fact
    from public.staxis_source_facts fact
   where fact.property_id = p_property_id
     and fact.source_receipt_id = v_receipt_id
     and fact.entity_kind = v_entity_kind
     and fact.entity_id = v_entity_id
     and fact.effective_at = v_effective_at
   limit 1;
  v_fact_id := v_existing_fact.id;
  if v_fact_id is null then
    raise exception 'source fact was not recorded' using errcode = 'check_violation';
  end if;
  if v_existing_fact.source_definition_id is distinct from v_definition_id
     or v_existing_fact.entity_label is distinct from coalesce(v_fact ->> 'entityLabel', v_fact ->> 'entity_label')
     or v_existing_fact.value is distinct from coalesce(v_fact -> 'value', '{}'::jsonb)
     or v_existing_fact.expires_at is distinct from coalesce(v_fact ->> 'expiresAt', v_fact ->> 'expires_at')::timestamptz
     or v_existing_fact.supersedes_id is distinct from nullif(coalesce(v_fact ->> 'supersedesId', v_fact ->> 'supersedes_id'), '')::uuid
     or v_existing_fact.completeness is distinct from coalesce(v_fact ->> 'completeness', v_receipt ->> 'completeness', 'unknown')
     or v_existing_fact.completeness_reason is distinct from coalesce(v_fact ->> 'completenessReason', v_fact ->> 'completeness_reason', v_receipt ->> 'completenessReason', v_receipt ->> 'completeness_reason')
  then
    raise exception 'source fact idempotency collision carries changed immutable content'
      using errcode = 'unique_violation';
  end if;
  select receipt.receipt_hash into v_receipt_hash
    from public.staxis_source_receipts receipt
   where receipt.id = v_receipt_id and receipt.property_id = p_property_id;
  select fact.fingerprint into v_fingerprint
    from public.staxis_source_facts fact
   where fact.id = v_fact_id and fact.property_id = p_property_id;
  return jsonb_build_object(
    'recorded', true,
    'admitted', true,
    'replayed', v_receipt_replayed and v_fact_replayed,
    'receiptId', v_receipt_id,
    'factId', v_fact_id,
    'receiptHash', v_receipt_hash,
    'fingerprint', v_fingerprint
  );
exception when others then
  return jsonb_build_object('recorded', false, 'code', 'rejected', 'reason', left(sqlerrm, 500));
end;
$$;

create or replace function public.staxis_admit_lifecycle_bundle(
  p_property_id uuid,
  p_bundle jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admission public.staxis_finding_admissions%rowtype;
  v_admission_result jsonb;
  v_lifecycle public.staxis_lifecycle_records%rowtype;
  v_lifecycle_bundle jsonb;
  v_fact_id uuid;
  v_finding_id uuid;
  v_admission_id uuid;
  v_lifecycle_id uuid;
  v_ids jsonb;
  v_id_text text;
  v_has_action boolean := false;
begin
  if p_property_id is null or jsonb_typeof(p_bundle) <> 'object' then
    raise exception 'lifecycle bundle is invalid' using errcode = 'check_violation';
  end if;
  if p_bundle ->> 'propertyId' is not null and p_bundle ->> 'propertyId' <> p_property_id::text then
    raise exception 'lifecycle bundle property does not match its scoped writer' using errcode = 'foreign_key_violation';
  end if;

  -- Optional source bundle is recorded in this same transaction. A failed
  -- source write aborts the whole admission chain.
  if p_bundle ? 'source' then
    v_admission_result := public.staxis_record_source_fact(p_property_id, p_bundle -> 'source');
    if coalesce((v_admission_result ->> 'recorded')::boolean, false) is not true then
      raise exception 'source bundle rejected: %', v_admission_result::text using errcode = 'check_violation';
    end if;
  end if;

  v_finding_id := nullif(coalesce(p_bundle ->> 'findingId', p_bundle ->> 'finding_id'), '')::uuid;
  if v_finding_id is null then
    raise exception 'lifecycle admission requires findingId' using errcode = 'foreign_key_violation';
  end if;

  v_ids := coalesce(p_bundle -> 'sourceFactIds', p_bundle -> 'source_fact_ids', '[]'::jsonb);
  if jsonb_typeof(v_ids) <> 'array' or jsonb_array_length(v_ids) = 0 then
    raise exception 'lifecycle admission requires an exact non-empty sourceFactIds array' using errcode = 'check_violation';
  end if;
  if exists (select 1 from jsonb_array_elements(v_ids) item where jsonb_typeof(item.value) <> 'string')
     or (select count(*) from jsonb_array_elements_text(v_ids) item)
        <> (select count(distinct item.value) from jsonb_array_elements_text(v_ids) item) then
    raise exception 'lifecycle admission sourceFactIds must contain unique UUID strings' using errcode = 'check_violation';
  end if;
  v_lifecycle_bundle := coalesce(p_bundle -> 'lifecycle', '{}'::jsonb);
  if jsonb_typeof(v_lifecycle_bundle) <> 'object' then
    raise exception 'lifecycle seed must be an object' using errcode = 'check_violation';
  end if;
  v_has_action := nullif(coalesce(v_lifecycle_bundle ->> 'proposalId', v_lifecycle_bundle ->> 'proposal_id'), '') is not null
                  or jsonb_typeof(v_lifecycle_bundle -> 'actionContract') = 'object'
                  or jsonb_typeof(v_lifecycle_bundle -> 'frozenInput') = 'object';
  if v_has_action and (
    nullif(coalesce(v_lifecycle_bundle ->> 'proposalId', v_lifecycle_bundle ->> 'proposal_id'), '') is null
    or nullif(coalesce(v_lifecycle_bundle ->> 'actionDefinitionId', v_lifecycle_bundle ->> 'action_definition_id'), '') is null
    or jsonb_typeof(v_lifecycle_bundle -> 'actionContract') <> 'object'
    or jsonb_typeof(v_lifecycle_bundle -> 'frozenInput') <> 'object'
    or jsonb_typeof(v_lifecycle_bundle -> 'frozenInput' -> 'params') <> 'object'
    or jsonb_typeof(v_lifecycle_bundle -> 'frozenInput' -> 'verify') <> 'object'
    or nullif(coalesce(v_lifecycle_bundle ->> 'actionKind', v_lifecycle_bundle ->> 'action_kind'), '') is null
    or nullif(coalesce(v_lifecycle_bundle ->> 'actionIdempotencyKey', v_lifecycle_bundle ->> 'action_idempotency_key'), '') is null
    or v_lifecycle_bundle -> 'frozenInput' ->> 'propertyId' <> p_property_id::text
    or v_lifecycle_bundle -> 'frozenInput' ->> 'findingId' <> v_finding_id::text
  ) then
    raise exception 'action lifecycle seed requires a generic proposal and matching frozen input' using errcode = 'check_violation';
  end if;
  if not v_has_action and coalesce((v_lifecycle_bundle ->> 'approvalRequired')::boolean, false) then
    raise exception 'action-free observed lifecycle records cannot require approval' using errcode = 'check_violation';
  end if;

  -- Exact replay path. The immutable junction trigger intentionally rejects
  -- writes after admission, so a retry must prove it names the same fact set
  -- before returning the existing chain.
  select admission.* into v_admission
    from public.staxis_finding_admissions admission
   where admission.property_id = p_property_id
     and admission.finding_id = v_finding_id
     and admission.receipt_query_id = coalesce(p_bundle ->> 'receiptQueryId', p_bundle ->> 'receipt_query_id')
     and admission.admission_state = 'admitted'
   order by admission.created_at desc
   limit 1;
  if v_admission.id is not null then
    if v_admission.contract_version is distinct from coalesce(p_bundle ->> 'contractVersion', 'staxis-source-fact.v1')
       or v_admission.detector_id is distinct from coalesce(p_bundle ->> 'detectorId', p_bundle ->> 'detector_id')
       or v_admission.minimum_data_met is distinct from coalesce((p_bundle ->> 'minimumDataMet')::boolean, (p_bundle ->> 'minimum_data_met')::boolean, false)
       or v_admission.evidence is distinct from coalesce(p_bundle -> 'evidence', '{}'::jsonb)
       or v_admission.minimum_data is distinct from coalesce(p_bundle -> 'minimumData', p_bundle -> 'minimum_data', '{}'::jsonb)
       or v_admission.as_of is distinct from coalesce(p_bundle ->> 'asOf', p_bundle ->> 'as_of')::timestamptz
       or v_admission.observed_at is distinct from coalesce(p_bundle ->> 'observedAt', p_bundle ->> 'observed_at')::timestamptz
       or v_admission.expires_at is distinct from coalesce(p_bundle ->> 'expiresAt', p_bundle ->> 'expires_at')::timestamptz
       or v_admission.completeness is distinct from coalesce(p_bundle ->> 'completeness', 'unknown')
       or v_admission.completeness_reason is distinct from p_bundle ->> 'completenessReason'
       or v_admission.freshness is distinct from coalesce(p_bundle ->> 'freshness', 'unknown')
       or v_admission.freshness_max_age_seconds is distinct from nullif(coalesce(p_bundle ->> 'freshnessMaxAgeSeconds', p_bundle ->> 'freshness_max_age_seconds'), '')::integer
    then
      raise exception 'lifecycle admission replay carries changed immutable proof'
        using errcode = 'unique_violation';
    end if;
    if (select count(*) from public.staxis_finding_source_facts link
         where link.property_id = p_property_id and link.admission_id = v_admission.id)
       <> jsonb_array_length(v_ids)
       or exists (
         select 1 from public.staxis_finding_source_facts link
          where link.property_id = p_property_id and link.admission_id = v_admission.id
            and not exists (
              select 1 from jsonb_array_elements_text(v_ids) provided
               where provided.value = link.source_fact_id::text
            )
       ) then
      raise exception 'lifecycle replay fact set does not exactly match the admitted set'
        using errcode = 'check_violation';
    end if;
    select coalesce(jsonb_agg(link.source_fact_id order by link.source_fact_id), '[]'::jsonb)
      into v_ids
      from public.staxis_finding_source_facts link
     where link.property_id = p_property_id and link.admission_id = v_admission.id;
    select record.id into v_lifecycle_id
      from public.staxis_lifecycle_records record
     where record.property_id = p_property_id and record.admission_id = v_admission.id
     order by record.recorded_at desc limit 1;
    if jsonb_typeof(p_bundle -> 'lifecycle') = 'object' and v_lifecycle_id is not null then
      select record.* into strict v_lifecycle
        from public.staxis_lifecycle_records record
       where record.id = v_lifecycle_id and record.property_id = p_property_id;
      if v_lifecycle.idempotency_key is distinct from coalesce(p_bundle -> 'lifecycle' ->> 'lifecycleIdempotencyKey', p_bundle -> 'lifecycle' ->> 'lifecycle_idempotency_key', p_bundle -> 'lifecycle' ->> 'idempotencyKey', p_bundle -> 'lifecycle' ->> 'idempotency_key', '')
         or v_lifecycle.action_contract is distinct from p_bundle -> 'lifecycle' -> 'actionContract'
         or v_lifecycle.proposal_id is distinct from nullif(coalesce(p_bundle -> 'lifecycle' ->> 'proposalId', p_bundle -> 'lifecycle' ->> 'proposal_id'), '')::uuid
         or v_lifecycle.action_kind is distinct from nullif(coalesce(p_bundle -> 'lifecycle' ->> 'actionKind', p_bundle -> 'lifecycle' ->> 'action_kind'), '')
         or v_lifecycle.action_definition_id is distinct from nullif(coalesce(p_bundle -> 'lifecycle' ->> 'actionDefinitionId', p_bundle -> 'lifecycle' ->> 'action_definition_id'), '')::uuid
         or v_lifecycle.frozen_input is distinct from p_bundle -> 'lifecycle' -> 'frozenInput'
         or v_lifecycle.action_idempotency_key is distinct from coalesce(p_bundle -> 'lifecycle' ->> 'actionIdempotencyKey', p_bundle -> 'lifecycle' ->> 'action_idempotency_key', '')
         or v_lifecycle.finding_action_id is distinct from nullif(coalesce(p_bundle -> 'lifecycle' ->> 'findingActionId', p_bundle -> 'lifecycle' ->> 'finding_action_id'), '')::uuid
         or v_lifecycle.pending_action_id is distinct from nullif(coalesce(p_bundle -> 'lifecycle' ->> 'pendingActionId', p_bundle -> 'lifecycle' ->> 'pending_action_id'), '')::uuid
         or v_lifecycle.entity_kind is distinct from coalesce(p_bundle -> 'lifecycle' ->> 'entityKind', p_bundle -> 'lifecycle' ->> 'entity_kind')
         or v_lifecycle.entity_id is distinct from nullif(coalesce(p_bundle -> 'lifecycle' ->> 'entityId', p_bundle -> 'lifecycle' ->> 'entity_id'), '')
         or v_lifecycle.entity_label is distinct from p_bundle -> 'lifecycle' ->> 'entityLabel'
         or v_lifecycle.title_snapshot is distinct from coalesce(p_bundle -> 'lifecycle' ->> 'title', p_bundle -> 'lifecycle' ->> 'titleSnapshot')
         or v_lifecycle.summary_snapshot is distinct from coalesce(p_bundle -> 'lifecycle' ->> 'summary', p_bundle -> 'lifecycle' ->> 'summarySnapshot')
         or v_lifecycle.approval_required is distinct from coalesce((p_bundle -> 'lifecycle' ->> 'approvalRequired')::boolean, v_has_action)
         or v_lifecycle.owner_kind is distinct from coalesce(p_bundle -> 'lifecycle' ->> 'ownerKind', p_bundle -> 'lifecycle' ->> 'owner_kind')
         or v_lifecycle.owner_id is distinct from p_bundle -> 'lifecycle' ->> 'ownerId'
         or v_lifecycle.owner_label is distinct from p_bundle -> 'lifecycle' ->> 'ownerLabel'
         or v_lifecycle.owner_role is distinct from p_bundle -> 'lifecycle' ->> 'ownerRole'
         or v_lifecycle.conversation_id is distinct from nullif(coalesce(p_bundle -> 'lifecycle' ->> 'conversationId', p_bundle -> 'lifecycle' ->> 'conversation_id'), '')::uuid
         or v_lifecycle.account_id is distinct from nullif(coalesce(p_bundle -> 'lifecycle' ->> 'accountId', p_bundle -> 'lifecycle' ->> 'account_id'), '')::uuid
         or v_lifecycle.conversation_snapshot is distinct from coalesce(p_bundle -> 'lifecycle' -> 'conversationSnapshot', '{}'::jsonb)
         or v_lifecycle.account_snapshot is distinct from coalesce(p_bundle -> 'lifecycle' -> 'accountSnapshot', '{}'::jsonb)
         or v_lifecycle.reason is distinct from p_bundle -> 'lifecycle' ->> 'reason'
      then
        raise exception 'lifecycle replay carries changed action or snapshot content'
          using errcode = 'unique_violation';
      end if;
    end if;
    return jsonb_build_object(
      'admitted', true,
      'replayed', true,
      'admissionId', v_admission.id,
      'lifecycleId', v_lifecycle_id,
      'proposalId', v_lifecycle.proposal_id,
      'frozenInputHash', v_lifecycle.frozen_input_hash,
      'sourceFactIds', v_ids
    );
  end if;

  insert into public.staxis_finding_admissions (
    property_id, finding_id, contract_version, detector_id, receipt_query_id,
    evidence, minimum_data, minimum_data_met, as_of, observed_at, expires_at,
    completeness, completeness_reason, freshness, freshness_max_age_seconds
  ) values (
    p_property_id, v_finding_id,
    coalesce(p_bundle ->> 'contractVersion', 'staxis-source-fact.v1'),
    coalesce(p_bundle ->> 'detectorId', p_bundle ->> 'detector_id'),
    coalesce(p_bundle ->> 'receiptQueryId', p_bundle ->> 'receipt_query_id'),
    coalesce(p_bundle -> 'evidence', '{}'::jsonb),
    coalesce(p_bundle -> 'minimumData', p_bundle -> 'minimum_data', '{}'::jsonb),
    coalesce((p_bundle ->> 'minimumDataMet')::boolean, (p_bundle ->> 'minimum_data_met')::boolean, false),
    coalesce(p_bundle ->> 'asOf', p_bundle ->> 'as_of')::timestamptz,
    coalesce(p_bundle ->> 'observedAt', p_bundle ->> 'observed_at')::timestamptz,
    coalesce(p_bundle ->> 'expiresAt', p_bundle ->> 'expires_at')::timestamptz,
    coalesce(p_bundle ->> 'completeness', 'unknown'),
    p_bundle ->> 'completenessReason',
    coalesce(p_bundle ->> 'freshness', 'unknown'),
    nullif(coalesce(p_bundle ->> 'freshnessMaxAgeSeconds', p_bundle ->> 'freshness_max_age_seconds'), '')::integer
  ) on conflict do nothing;

  select admission.* into strict v_admission
    from public.staxis_finding_admissions admission
   where admission.property_id = p_property_id
     and admission.finding_id = v_finding_id
     and admission.receipt_query_id = coalesce(p_bundle ->> 'receiptQueryId', p_bundle ->> 'receipt_query_id')
   order by admission.created_at desc
   limit 1
   for update;
  v_admission_id := v_admission.id;

  for v_id_text in select value from jsonb_array_elements_text(v_ids)
  loop
    v_fact_id := v_id_text::uuid;
    insert into public.staxis_finding_source_facts (property_id, admission_id, source_fact_id)
    values (p_property_id, v_admission_id, v_fact_id)
    on conflict do nothing;
  end loop;

  v_admission_result := public.staxis_admit_finding(v_admission_id, p_property_id);
  if coalesce((v_admission_result ->> 'admitted')::boolean, false) is not true then
    raise exception 'finding admission rejected: %', v_admission_result::text using errcode = 'check_violation';
  end if;

  select coalesce(jsonb_agg(link.source_fact_id order by link.source_fact_id), '[]'::jsonb)
    into v_ids
    from public.staxis_finding_source_facts link
   where link.property_id = p_property_id and link.admission_id = v_admission_id;

  if jsonb_typeof(v_lifecycle_bundle) = 'object' then
    insert into public.staxis_lifecycle_records (
      property_id, finding_id, proposal_id, action_kind, action_definition_id,
      finding_action_id, pending_action_id, admission_id,
      entity_kind, entity_id, entity_label, title_snapshot, summary_snapshot,
      action_contract, approval_required, frozen_input, frozen_input_hash,
      action_idempotency_key, idempotency_key,
      owner_kind, owner_id, owner_label, owner_role, conversation_id, account_id,
      conversation_snapshot, account_snapshot, reason
    ) values (
      p_property_id, v_finding_id,
      nullif(coalesce(v_lifecycle_bundle ->> 'proposalId', v_lifecycle_bundle ->> 'proposal_id'), '')::uuid,
      nullif(coalesce(v_lifecycle_bundle ->> 'actionKind', v_lifecycle_bundle ->> 'action_kind'), ''),
      nullif(coalesce(v_lifecycle_bundle ->> 'actionDefinitionId', v_lifecycle_bundle ->> 'action_definition_id'), '')::uuid,
      nullif(coalesce(v_lifecycle_bundle ->> 'findingActionId', v_lifecycle_bundle ->> 'finding_action_id'), '')::uuid,
      nullif(coalesce(v_lifecycle_bundle ->> 'pendingActionId', v_lifecycle_bundle ->> 'pending_action_id'), '')::uuid,
      v_admission_id,
      coalesce(v_lifecycle_bundle ->> 'entityKind', v_lifecycle_bundle ->> 'entity_kind'),
      nullif(coalesce(v_lifecycle_bundle ->> 'entityId', v_lifecycle_bundle ->> 'entity_id'), ''),
      v_lifecycle_bundle ->> 'entityLabel',
      coalesce(v_lifecycle_bundle ->> 'title', v_lifecycle_bundle ->> 'titleSnapshot'),
      coalesce(v_lifecycle_bundle ->> 'summary', v_lifecycle_bundle ->> 'summarySnapshot'),
      case when v_has_action then v_lifecycle_bundle -> 'actionContract' else null end,
      coalesce((v_lifecycle_bundle ->> 'approvalRequired')::boolean, v_has_action),
      case when v_has_action then v_lifecycle_bundle -> 'frozenInput' else null end,
      nullif(coalesce(v_lifecycle_bundle ->> 'frozenInputHash', v_lifecycle_bundle ->> 'frozen_input_hash'), ''),
      coalesce(v_lifecycle_bundle ->> 'actionIdempotencyKey', v_lifecycle_bundle ->> 'action_idempotency_key', ''),
      coalesce(v_lifecycle_bundle ->> 'lifecycleIdempotencyKey', v_lifecycle_bundle ->> 'lifecycle_idempotency_key', v_lifecycle_bundle ->> 'idempotencyKey', v_lifecycle_bundle ->> 'idempotency_key', ''),
      coalesce(v_lifecycle_bundle ->> 'ownerKind', v_lifecycle_bundle ->> 'owner_kind'),
      v_lifecycle_bundle ->> 'ownerId',
      v_lifecycle_bundle ->> 'ownerLabel',
      v_lifecycle_bundle ->> 'ownerRole',
      nullif(coalesce(v_lifecycle_bundle ->> 'conversationId', v_lifecycle_bundle ->> 'conversation_id'), '')::uuid,
      nullif(coalesce(v_lifecycle_bundle ->> 'accountId', v_lifecycle_bundle ->> 'account_id'), '')::uuid,
      coalesce(v_lifecycle_bundle -> 'conversationSnapshot', '{}'::jsonb),
      coalesce(v_lifecycle_bundle -> 'accountSnapshot', '{}'::jsonb),
      v_lifecycle_bundle ->> 'reason'
    ) on conflict do nothing
    returning * into v_lifecycle;
    if v_lifecycle.id is null then
      select record.* into strict v_lifecycle
        from public.staxis_lifecycle_records record
       where record.property_id = p_property_id
         and record.admission_id = v_admission_id
       order by record.recorded_at desc limit 1;
    end if;
    v_lifecycle_id := v_lifecycle.id;
    insert into public.staxis_lifecycle_events (
      property_id, lifecycle_id, from_state, to_state, event_kind, actor_account_id,
      actor_snapshot, owner_snapshot, domain_reference, idempotency_key
    ) values (
      p_property_id, v_lifecycle_id, 'observed', 'observed', 'state_transition',
      nullif(coalesce(v_lifecycle_bundle ->> 'accountId', v_lifecycle_bundle ->> 'account_id'), '')::uuid,
      coalesce(v_lifecycle_bundle -> 'accountSnapshot', '{}'::jsonb),
      jsonb_build_object('kind', v_lifecycle.owner_kind, 'id', v_lifecycle.owner_id, 'label', v_lifecycle.owner_label, 'role', v_lifecycle.owner_role),
      coalesce(v_lifecycle_bundle -> 'domainReference', v_lifecycle_bundle -> 'domain_reference', '{}'::jsonb),
      coalesce(v_lifecycle_bundle ->> 'eventIdempotencyKey', v_lifecycle_bundle ->> 'event_idempotency_key', v_lifecycle.id::text || ':observed')
    ) on conflict do nothing;
    if v_has_action then
      insert into public.staxis_lifecycle_events (
        property_id, lifecycle_id, from_state, to_state, event_kind, actor_account_id,
        actor_snapshot, owner_snapshot, domain_reference, idempotency_key
      ) values (
        p_property_id, v_lifecycle_id, 'observed', 'proposed', 'state_transition',
        nullif(coalesce(v_lifecycle_bundle ->> 'accountId', v_lifecycle_bundle ->> 'account_id'), '')::uuid,
        coalesce(v_lifecycle_bundle -> 'accountSnapshot', '{}'::jsonb),
        jsonb_build_object('kind', v_lifecycle.owner_kind, 'id', v_lifecycle.owner_id, 'label', v_lifecycle.owner_label, 'role', v_lifecycle.owner_role),
        '{}'::jsonb,
        coalesce(v_lifecycle_bundle ->> 'proposalEventIdempotencyKey', v_lifecycle_bundle ->> 'proposal_event_idempotency_key', v_lifecycle.id::text || ':proposed')
      ) on conflict do nothing;
      update public.staxis_lifecycle_records
         set state = 'proposed'
       where id = v_lifecycle_id and property_id = p_property_id;
    end if;
  end if;

  return jsonb_build_object(
    'admitted', true,
    'replayed', false,
    'admissionId', v_admission_id,
    'lifecycleId', v_lifecycle_id,
    'proposalId', v_lifecycle.proposal_id,
    'frozenInputHash', v_lifecycle.frozen_input_hash,
    'sourceFactIds', v_ids
  );
exception when others then
  raise;
end;
$$;

create or replace function public.staxis_append_lifecycle_event(
  p_property_id uuid,
  p_bundle jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record public.staxis_lifecycle_records%rowtype;
  v_event public.staxis_lifecycle_events%rowtype;
  v_lifecycle_id uuid;
  v_from_state text;
  v_to_state text;
  v_key text;
begin
  if p_property_id is null or jsonb_typeof(p_bundle) <> 'object' then
    return jsonb_build_object('recorded', false, 'code', 'invalid_bundle');
  end if;
  if p_bundle ->> 'propertyId' is not null and p_bundle ->> 'propertyId' <> p_property_id::text then
    return jsonb_build_object('recorded', false, 'code', 'property_mismatch');
  end if;
  v_lifecycle_id := nullif(coalesce(p_bundle ->> 'lifecycleId', p_bundle ->> 'lifecycle_id'), '')::uuid;
  v_from_state := coalesce(p_bundle ->> 'fromState', p_bundle ->> 'from_state');
  v_to_state := coalesce(p_bundle ->> 'toState', p_bundle ->> 'to_state');
  v_key := coalesce(p_bundle ->> 'idempotencyKey', p_bundle ->> 'idempotency_key');
  select record.* into strict v_record
    from public.staxis_lifecycle_records record
   where record.id = v_lifecycle_id and record.property_id = p_property_id
   for update;
  if v_from_state is null or v_key is null or char_length(btrim(v_key)) = 0 then
    return jsonb_build_object('recorded', false, 'code', 'from_state_or_idempotency_required');
  end if;

  select event.* into v_event
    from public.staxis_lifecycle_events event
   where event.lifecycle_id = v_lifecycle_id and event.property_id = p_property_id
     and event.idempotency_key = v_key
   limit 1;
  if v_event.id is not null then
    if v_event.from_state is distinct from v_from_state
       or v_event.event_kind is distinct from coalesce(p_bundle ->> 'eventKind', p_bundle ->> 'event_kind', 'state_transition')
       or v_event.to_state is distinct from v_to_state
       or v_event.actor_account_id is distinct from nullif(coalesce(p_bundle ->> 'actorAccountId', p_bundle ->> 'actor_account_id'), '')::uuid
       or v_event.actor_snapshot is distinct from coalesce(p_bundle -> 'actorSnapshot', p_bundle -> 'actor_snapshot', '{}'::jsonb)
       or v_event.execution_receipt is distinct from coalesce(p_bundle -> 'executionReceipt', p_bundle -> 'execution_receipt')
       or v_event.domain_reference is distinct from coalesce(p_bundle -> 'domainReference', p_bundle -> 'domain_reference', '{}'::jsonb)
       or v_event.owner_snapshot is distinct from coalesce(p_bundle -> 'ownerSnapshot', p_bundle -> 'owner_snapshot', '{}'::jsonb)
       or v_event.approval_proof is distinct from coalesce(p_bundle -> 'approvalProof', p_bundle -> 'approval_proof')
       or v_event.outcome_basis is distinct from coalesce(p_bundle ->> 'outcomeBasis', p_bundle ->> 'outcome_basis')
       or v_event.outcome_source_fact_id is distinct from nullif(coalesce(p_bundle ->> 'outcomeSourceFactId', p_bundle ->> 'outcome_source_fact_id'), '')::uuid
       or v_event.reason is distinct from nullif(coalesce(p_bundle ->> 'reason', ''), '')
    then
      return jsonb_build_object('recorded', false, 'code', 'idempotency_collision');
    end if;
    return jsonb_build_object('recorded', true, 'replayed', true, 'eventId', v_event.id, 'state', v_event.to_state, 'currentState', v_record.state);
  end if;
  if v_from_state <> v_record.state then
    return jsonb_build_object('recorded', false, 'code', 'from_state_mismatch');
  end if;

  insert into public.staxis_lifecycle_events (
    property_id, lifecycle_id, from_state, to_state, event_kind, actor_account_id,
    actor_snapshot, owner_snapshot, domain_reference, approval_proof, execution_receipt,
    outcome_basis, reason, outcome_source_fact_id, idempotency_key
  ) values (
    p_property_id, v_lifecycle_id, v_from_state, v_to_state,
    coalesce(p_bundle ->> 'eventKind', p_bundle ->> 'event_kind', 'state_transition'),
    nullif(coalesce(p_bundle ->> 'actorAccountId', p_bundle ->> 'actor_account_id'), '')::uuid,
    coalesce(p_bundle -> 'actorSnapshot', p_bundle -> 'actor_snapshot', '{}'::jsonb),
    coalesce(p_bundle -> 'ownerSnapshot', p_bundle -> 'owner_snapshot', '{}'::jsonb),
    coalesce(p_bundle -> 'domainReference', p_bundle -> 'domain_reference', '{}'::jsonb),
    coalesce(p_bundle -> 'approvalProof', p_bundle -> 'approval_proof'),
    coalesce(p_bundle -> 'executionReceipt', p_bundle -> 'execution_receipt'),
    coalesce(p_bundle ->> 'outcomeBasis', p_bundle ->> 'outcome_basis'),
    nullif(coalesce(p_bundle ->> 'reason', ''), ''),
    nullif(coalesce(p_bundle ->> 'outcomeSourceFactId', p_bundle ->> 'outcome_source_fact_id'), '')::uuid,
    v_key
  ) returning * into v_event;

  update public.staxis_lifecycle_records
     set state = v_to_state,
         reason = coalesce(p_bundle ->> 'reason', reason)
   where id = v_lifecycle_id and property_id = p_property_id;

  return jsonb_build_object('recorded', true, 'replayed', false, 'eventId', v_event.id, 'state', v_to_state);
exception when others then
  return jsonb_build_object('recorded', false, 'code', 'rejected', 'reason', left(sqlerrm, 500));
end;
$$;

revoke all on function public.staxis_record_source_fact(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.staxis_admit_lifecycle_bundle(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.staxis_append_lifecycle_event(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.staxis_record_source_fact(uuid, jsonb) to service_role;
grant execute on function public.staxis_admit_lifecycle_bundle(uuid, jsonb) to service_role;
grant execute on function public.staxis_append_lifecycle_event(uuid, jsonb) to service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 8. RLS/grants. Writes are service-only; only safe metadata/view is readable.
-- ───────────────────────────────────────────────────────────────────────────
alter table public.staxis_source_definitions enable row level security;
alter table public.staxis_source_receipts enable row level security;
alter table public.staxis_source_facts enable row level security;
alter table public.staxis_finding_admissions enable row level security;
alter table public.staxis_finding_source_facts enable row level security;
alter table public.staxis_action_definitions enable row level security;
alter table public.staxis_lifecycle_records enable row level security;
alter table public.staxis_lifecycle_events enable row level security;

revoke all on public.staxis_source_definitions, public.staxis_source_receipts,
  public.staxis_source_facts, public.staxis_finding_admissions,
  public.staxis_finding_source_facts, public.staxis_action_definitions,
  public.staxis_lifecycle_records,
  public.staxis_lifecycle_events from public, anon, authenticated, service_role;
grant select on public.staxis_source_definitions, public.staxis_source_receipts,
  public.staxis_source_facts, public.staxis_finding_admissions,
  public.staxis_finding_source_facts, public.staxis_action_definitions,
  public.staxis_lifecycle_records,
  public.staxis_lifecycle_events to service_role;
-- Registries may be registered directly by the trusted service. All durable
-- receipts, facts, admissions, links, records, and events are RPC-only writes.
grant insert on public.staxis_source_definitions, public.staxis_action_definitions to service_role;

-- Service role is the API boundary. Direct browser reads are intentionally
-- denied because the view is a bounded projection, not an RLS policy surface;
-- the route applies the exact hotel authorization before returning it.
revoke all on public.staxis_lifecycle_projection_v1 from public, anon, authenticated;
grant select on public.staxis_lifecycle_projection_v1 to service_role;

revoke all on function public.staxis_source_definition_immutable() from public, anon, authenticated;
revoke all on function public.staxis_action_contract_is_valid(jsonb) from public, anon, authenticated;
revoke all on function public.staxis_action_definition_immutable() from public, anon, authenticated;
revoke all on function public.staxis_minimum_data_proof_is_valid(jsonb, boolean) from public, anon, authenticated;
grant execute on function public.staxis_action_contract_is_valid(jsonb) to service_role;
grant execute on function public.staxis_minimum_data_proof_is_valid(jsonb, boolean) to service_role;
revoke all on function public.staxis_source_receipt_immutable() from public, anon, authenticated;
revoke all on function public.staxis_source_fact_immutable() from public, anon, authenticated;
revoke all on function public.staxis_finding_admission_immutable() from public, anon, authenticated;
revoke all on function public.staxis_finding_source_facts_immutable() from public, anon, authenticated;
revoke all on function public.staxis_lifecycle_record_immutable() from public, anon, authenticated;
revoke all on function public.staxis_lifecycle_event_immutable() from public, anon, authenticated;

insert into public.applied_migrations (version, description)
values (
  '0469',
  'Staxis shared foundation: property-scoped app_owned/pms_report definitions, immutable safe source receipts/facts, explicit finding admission links, and lifecycle correlation/events with fail-closed tenant, freshness, transition, receipt, and outcome invariants.'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
