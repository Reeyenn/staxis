-- 0380_portfolio_intelligence_snapshots.sql
--
-- Property-grain, organization-independent metric materializations plus an
-- immutable answer audit receipt. A hotel transfer therefore cannot make a
-- cached company aggregate visible to the acquiring or former company: there
-- are no persisted company aggregates. Every portfolio answer re-aggregates
-- these hotel facts only after resolving a fresh exact authorization receipt.

begin;

do $$
begin
  if to_regclass('public.properties') is null
     or to_regclass('public.accounts') is null
     or to_regclass('public.organizations') is null
     or to_regclass('public.agent_conversations') is null
     or to_regclass('public.pms_ingest_runs') is null
  then
    raise exception '0380 requires properties, accounts, organizations, agent conversations and PMS ingest receipts';
  end if;
end
$$;

-- @rls: service-role-only — property-grain acceleration is readable only by
-- receipt-asserted server orchestration; browser roles are explicitly denied.
create table if not exists public.portfolio_metric_snapshots (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references public.properties(id) on delete cascade,
  metric_id             text not null,
  metric_version        text not null,
  comparison_version    text not null default 'none',
  business_date         date not null,
  source_ingest_run_id  uuid references public.pms_ingest_runs(id) on delete set null,
  source_record_id      text,
  source_captured_at    timestamptz,
  snapshot_key          text not null,
  fact                  jsonb not null,
  generated_at          timestamptz not null default now(),
  expires_at            timestamptz not null,

  constraint portfolio_metric_snapshots_metric_id_check
    check (char_length(metric_id) between 1 and 100),
  constraint portfolio_metric_snapshots_metric_version_check
    check (char_length(metric_version) between 1 and 120),
  constraint portfolio_metric_snapshots_comparison_version_check
    check (char_length(comparison_version) between 1 and 120),
  constraint portfolio_metric_snapshots_key_check
    check (snapshot_key ~ '^[0-9a-f]{64}$'),
  constraint portfolio_metric_snapshots_fact_object_check
    check (jsonb_typeof(fact) = 'object' and octet_length(fact::text) <= 65536),
  constraint portfolio_metric_snapshots_expiry_check check (expires_at > generated_at)
);

create unique index if not exists portfolio_metric_snapshots_key_uidx
  on public.portfolio_metric_snapshots(property_id, snapshot_key);

create index if not exists portfolio_metric_snapshots_lookup_idx
  on public.portfolio_metric_snapshots(
    property_id, metric_id, metric_version, comparison_version, business_date,
    expires_at desc, generated_at desc
  );

comment on table public.portfolio_metric_snapshots is
  'Immutable, short-lived property-level canonical metric facts. Deliberately has no organization_id and stores no cross-hotel aggregate, preventing stale company-cache leakage after hotel transfer. Created 0380.';

-- @rls: service-role-only — immutable reproduction/audit receipts contain
-- exact authorization sets and are never exposed through a browser table API.
create table if not exists public.portfolio_query_receipts (
  id                       uuid primary key default gen_random_uuid(),
  property_id              uuid not null references public.properties(id) on delete cascade,
  organization_id          uuid not null references public.organizations(id) on delete cascade,
  account_id               uuid not null references public.accounts(id) on delete cascade,
  conversation_id          uuid references public.agent_conversations(id) on delete set null,
  scope_receipt_id         uuid not null,
  authorization_hash       text not null,
  scope_hash               text not null,
  question_hash            text not null,
  query_plan_version       text not null,
  evidence_version         text not null,
  prompt_version           text not null,
  model_id                 text,
  model_tier               text,
  authorized_property_ids  uuid[] not null,
  selected_property_ids    uuid[] not null,
  metric_versions          jsonb not null,
  source_versions          jsonb not null,
  plan                     jsonb not null,
  evidence                 jsonb not null,
  answer_hash              text,
  status                   text not null,
  duration_ms              integer not null,
  generated_at             timestamptz not null default now(),

  constraint portfolio_query_receipts_hashes_check check (
    question_hash ~ '^[0-9a-f]{64}$'
    and (answer_hash is null or answer_hash ~ '^[0-9a-f]{64}$')
    and char_length(authorization_hash) between 1 and 500
    and char_length(scope_hash) between 1 and 500
  ),
  constraint portfolio_query_receipts_scope_check check (
    cardinality(authorized_property_ids) > 0
    and cardinality(selected_property_ids) > 0
    and selected_property_ids <@ authorized_property_ids
    and property_id = any(selected_property_ids)
  ),
  constraint portfolio_query_receipts_json_check check (
    jsonb_typeof(metric_versions) = 'object'
    and jsonb_typeof(source_versions) = 'array'
    and jsonb_typeof(plan) = 'object'
    and jsonb_typeof(evidence) = 'object'
    and octet_length(evidence::text) <= 2097152
  ),
  constraint portfolio_query_receipts_status_check
    check (status in ('completed', 'partial', 'abstained', 'authorization_changed')),
  constraint portfolio_query_receipts_duration_check check (duration_ms >= 0)
);

create index if not exists portfolio_query_receipts_account_time_idx
  on public.portfolio_query_receipts(account_id, generated_at desc);
create index if not exists portfolio_query_receipts_org_time_idx
  on public.portfolio_query_receipts(organization_id, generated_at desc);
create index if not exists portfolio_query_receipts_conversation_idx
  on public.portfolio_query_receipts(conversation_id, generated_at desc)
  where conversation_id is not null;

comment on table public.portfolio_query_receipts is
  'Immutable reproduction receipt for one portfolio answer. Stores hashes, exact authorization/selection, plan/evidence/prompt/model/source versions, but never stores raw user or assistant text. Service-role-only. Created 0380.';

create or replace function public.staxis_refuse_portfolio_receipt_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  -- Referential cascades/SET NULL are tenant lifecycle, not a caller rewriting
  -- history. They execute from a parent-table trigger at nesting depth > 1.
  if pg_trigger_depth() > 1
     or current_setting('staxis.portfolio_purge', true) = 'on'
  then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  raise exception '% is immutable; insert a new versioned receipt instead', tg_table_name;
end
$$;

drop trigger if exists portfolio_metric_snapshots_immutable on public.portfolio_metric_snapshots;
create trigger portfolio_metric_snapshots_immutable
  before update or delete on public.portfolio_metric_snapshots
  for each row execute function public.staxis_refuse_portfolio_receipt_mutation();

drop trigger if exists portfolio_query_receipts_immutable on public.portfolio_query_receipts;
create trigger portfolio_query_receipts_immutable
  before update or delete on public.portfolio_query_receipts
  for each row execute function public.staxis_refuse_portfolio_receipt_mutation();

alter table public.portfolio_metric_snapshots enable row level security;
alter table public.portfolio_query_receipts enable row level security;

drop policy if exists portfolio_metric_snapshots_deny_browser on public.portfolio_metric_snapshots;
create policy portfolio_metric_snapshots_deny_browser
  on public.portfolio_metric_snapshots for all to anon, authenticated
  using (false) with check (false);

drop policy if exists portfolio_query_receipts_deny_browser on public.portfolio_query_receipts;
create policy portfolio_query_receipts_deny_browser
  on public.portfolio_query_receipts for all to anon, authenticated
  using (false) with check (false);

revoke all on public.portfolio_metric_snapshots from public, anon, authenticated;
revoke all on public.portfolio_query_receipts from public, anon, authenticated;
grant select, insert on public.portfolio_metric_snapshots to service_role;
grant select, insert on public.portfolio_query_receipts to service_role;

revoke all on function public.staxis_refuse_portfolio_receipt_mutation() from public, anon, authenticated;

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
    raise exception 'query receipt retention must be at least ninety days';
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
  return query select v_snapshots, v_receipts;
end
$$;

revoke all on function public.staxis_purge_expired_portfolio_records(timestamptz, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.staxis_purge_expired_portfolio_records(timestamptz, timestamptz, integer)
  to service_role;

insert into public.applied_migrations(version, description)
values (
  '0380',
  'Portfolio Intelligence immutable property metric snapshots and versioned answer receipts. No company aggregates are persisted; exact authorization is re-resolved before every aggregate, preventing hotel-transfer cache leakage.'
)
on conflict (version) do nothing;

commit;
