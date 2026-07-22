-- 0335: Durable, auditable account lifecycle intents.
--
-- Deactivation spans Supabase Auth and Postgres. Auth cannot participate in a
-- Postgres transaction, while accounts.active has organization-access triggers
-- with deliberate business side effects. This migration therefore adds an
-- inert intent phase: authorization and ordering commit first without touching
-- accounts.active; the server verifies Auth; one final RPC then changes active,
-- writes both audit records, and marks the intent committed atomically.
--
-- Additive rollout: this migration intentionally does NOT reject legacy direct
-- active writes. Application routes are switched only after 0335 is applied.

begin;

do $requirements$
begin
  if to_regclass('public.accounts') is null
     or to_regclass('public.properties') is null
     or to_regclass('public.capability_overrides') is null
     or to_regclass('public.role_changes') is null
     or to_regclass('public.admin_audit_log') is null
     or to_regclass('public.organizations') is null
     or to_regclass('public.organization_memberships') is null
     or to_regclass('public.organization_access_grants') is null
  then
    raise exception '0335 requires accounts, properties, capability overrides, audits, and organization access foundation';
  end if;
end
$requirements$;

-- These columns are an inert per-account ordering projection. Existing
-- organization triggers name active/property_access/role/staff_id explicitly,
-- so registering an intent cannot run deactivation side effects.
alter table public.accounts
  add column if not exists lifecycle_desired_active boolean,
  add column if not exists lifecycle_intent_version bigint not null default 0,
  add column if not exists lifecycle_committed_version bigint not null default 0;

update public.accounts
   set lifecycle_desired_active = active
 where lifecycle_desired_active is null;

alter table public.accounts
  alter column lifecycle_desired_active set default true,
  alter column lifecycle_desired_active set not null;

do $constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.accounts'::regclass
      and conname = 'accounts_lifecycle_versions_check'
  ) then
    alter table public.accounts
      add constraint accounts_lifecycle_versions_check
      check (
        lifecycle_intent_version >= 0
        and lifecycle_committed_version >= 0
        and lifecycle_committed_version <= lifecycle_intent_version
      );
  end if;
end
$constraints$;

comment on column public.accounts.lifecycle_desired_active is
  'Newest durable lifecycle intent. Inert: changing it does not run accounts.active organization triggers.';
comment on column public.accounts.lifecycle_intent_version is
  'Monotonic per-account lifecycle ordering version allocated by staxis_register_account_lifecycle_intent.';
comment on column public.accounts.lifecycle_committed_version is
  'Newest lifecycle version atomically committed to accounts.active and both audit logs.';

-- Production preflight found no duplicate mappings. Make the Auth-to-account
-- identity invariant durable so a later insert cannot make one Auth ban apply
-- to two hotel accounts. The transactional build fails cleanly if a duplicate
-- races the migration.
create unique index if not exists accounts_data_user_id_unique_idx
  on public.accounts (data_user_id);

-- @rls: service-role-only — durable cross-system intents are never browser-accessible; mutations are allowed only through service-role RPCs.
create table if not exists public.account_lifecycle_intents (
  operation_id                    uuid primary key,
  account_id                      uuid not null,
  version                         bigint not null,
  desired_active                  boolean not null,
  prior_active                    boolean not null,
  auth_user_id_snapshot           uuid not null,
  auth_banned_until_snapshot      text,
  auth_snapshot_recorded_at       timestamptz,
  target_role_snapshot            text not null,
  target_property_access_snapshot uuid[] not null,
  actor_account_id                uuid not null,
  actor_auth_user_id              uuid not null,
  actor_email                     text,
  hotel_id                        uuid not null,
  status                          text not null default 'pending',
  processor_token                 uuid,
  processor_lease_expires_at      timestamptz,
  attempt_count                   integer not null default 0,
  last_attempt_at                 timestamptz,
  last_error                      text,
  committed_at                    timestamptz,
  aborted_at                      timestamptz,
  abort_reason                    text,
  compensates_operation_id        uuid references public.account_lifecycle_intents(operation_id) on delete set null,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),

  constraint account_lifecycle_intents_account_version_key unique (account_id, version),
  constraint account_lifecycle_intents_version_check check (version > 0),
  constraint account_lifecycle_intents_attempt_count_check check (attempt_count >= 0),
  constraint account_lifecycle_intents_status_check
    check (status in ('pending', 'committed', 'aborted')),
  constraint account_lifecycle_intents_terminal_shape_check check (
    (status = 'pending' and committed_at is null and aborted_at is null)
    or (status = 'committed' and committed_at is not null and aborted_at is null)
    or (status = 'aborted' and committed_at is null and aborted_at is not null and abort_reason is not null)
  ),
  constraint account_lifecycle_intents_processor_lease_check check (
    (processor_token is null) = (processor_lease_expires_at is null)
  )
);

-- Upgrade safety for development/staging databases that evaluated an earlier
-- 0335 draft. Snapshot UUIDs are durable audit facts, not restrictive foreign
-- keys that should permanently prevent deleting an Auth user, actor, or hotel.
alter table public.account_lifecycle_intents
  add column if not exists auth_banned_until_snapshot text,
  add column if not exists auth_snapshot_recorded_at timestamptz,
  add column if not exists processor_token uuid,
  add column if not exists processor_lease_expires_at timestamptz,
  drop column if exists target_updated_at_snapshot,
  drop constraint if exists account_lifecycle_intents_account_id_fkey,
  drop constraint if exists account_lifecycle_intents_auth_user_id_snapshot_fkey,
  drop constraint if exists account_lifecycle_intents_actor_account_id_fkey,
  drop constraint if exists account_lifecycle_intents_actor_auth_user_id_fkey,
  drop constraint if exists account_lifecycle_intents_hotel_id_fkey,
  drop constraint if exists account_lifecycle_intents_processor_lease_check;

alter table public.account_lifecycle_intents
  add constraint account_lifecycle_intents_processor_lease_check check (
    (processor_token is null) = (processor_lease_expires_at is null)
  );

create unique index if not exists account_lifecycle_intents_one_pending_idx
  on public.account_lifecycle_intents (account_id)
  where status = 'pending';
create unique index if not exists account_lifecycle_intents_one_processor_idx
  on public.account_lifecycle_intents (account_id)
  where processor_token is not null;
create index if not exists account_lifecycle_intents_pending_sweep_idx
  on public.account_lifecycle_intents (updated_at, operation_id)
  where status = 'pending';
create index if not exists account_lifecycle_intents_actor_idx
  on public.account_lifecycle_intents (actor_account_id, created_at desc);

alter table public.account_lifecycle_intents enable row level security;
revoke all on table public.account_lifecycle_intents
  from public, anon, authenticated, service_role;
grant select on table public.account_lifecycle_intents to service_role;
drop policy if exists account_lifecycle_intents_deny_browser
  on public.account_lifecycle_intents;
create policy account_lifecycle_intents_deny_browser
  on public.account_lifecycle_intents
  for all to anon, authenticated using (false) with check (false);

-- While an Auth transition is pending, changing the target identity/scope/role
-- could make the already-authorized intent disable a newly promoted owner or a
-- different auth.users row. Friendly API checks exist too; this trigger is the
-- cross-route database fence (including ownership-transfer RPCs).
create or replace function public._staxis_guard_pending_account_lifecycle_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pending public.account_lifecycle_intents%rowtype;
  v_commit_operation text;
begin
  if tg_op = 'DELETE' then
    if exists (
      select 1
        from public.account_lifecycle_intents intent
       where intent.status = 'pending'
         and (intent.account_id = old.id or intent.actor_account_id = old.id)
    ) then
      raise exception 'account lifecycle change pending'
        using errcode = '55000';
    end if;
    return old;
  end if;

  select * into v_pending
    from public.account_lifecycle_intents intent
   where intent.account_id = old.id
     and intent.status = 'pending';
  if not found then
    return new;
  end if;

  v_commit_operation := nullif(
    current_setting('staxis.account_lifecycle_operation_id', true),
    ''
  );
  if v_commit_operation = v_pending.operation_id::text
     and new.active is not distinct from v_pending.desired_active
     and new.role is not distinct from old.role
     and new.property_access is not distinct from old.property_access
     and new.data_user_id is not distinct from old.data_user_id
     and new.display_name is not distinct from old.display_name
     and new.staff_id is not distinct from old.staff_id
  then
    return new;
  end if;

  raise exception 'account lifecycle change pending'
    using errcode = '55000';
end;
$$;

revoke all on function public._staxis_guard_pending_account_lifecycle_mutation()
  from public, anon, authenticated;

drop trigger if exists trg_accounts_guard_pending_lifecycle_mutation
  on public.accounts;
create trigger trg_accounts_guard_pending_lifecycle_mutation
  before update of active, role, property_access, data_user_id, display_name, staff_id
  on public.accounts
  for each row execute function public._staxis_guard_pending_account_lifecycle_mutation();

drop trigger if exists trg_accounts_guard_pending_lifecycle_delete
  on public.accounts;
create trigger trg_accounts_guard_pending_lifecycle_delete
  before delete on public.accounts
  for each row execute function public._staxis_guard_pending_account_lifecycle_mutation();

-- Grant creation/activation and membership resumption are both capable of
-- making an account a real organization owner. Neither may cross a pending
-- lifecycle operation, or Auth could be changed before commit discovers the
-- promotion. Hidden single-hotel legacy anchors are compatibility topology.
create or replace function public._staxis_guard_pending_lifecycle_owner_grant()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_account_id uuid;
begin
  if new.access_profile <> 'organization_owner'
     or new.scope_type <> 'organization'
     or new.status <> 'active'
     or new.expires_at is not null
  then
    return new;
  end if;

  select membership.account_id into v_account_id
    from public.organization_memberships membership
    join public.organizations organization
      on organization.id = new.organization_id
     and organization.status = 'active'
   where membership.id = new.membership_id
     and membership.organization_id = new.organization_id
     and membership.status = 'active'
     and membership.ended_at is null
     and not (
       organization.organization_type = 'single_hotel'
       and new.source = 'legacy_backfill'
     );

  if v_account_id is not null and exists (
    select 1
      from public.account_lifecycle_intents intent
     where intent.account_id = v_account_id
       and intent.status = 'pending'
  ) then
    raise exception 'account lifecycle change pending'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function public._staxis_guard_pending_lifecycle_owner_grant()
  from public, anon, authenticated;

drop trigger if exists trg_organization_grants_guard_pending_lifecycle
  on public.organization_access_grants;
create trigger trg_organization_grants_guard_pending_lifecycle
  before insert or update of membership_id, organization_id, access_profile,
    scope_type, status, starts_at, expires_at, source
  on public.organization_access_grants
  for each row execute function public._staxis_guard_pending_lifecycle_owner_grant();

create or replace function public._staxis_guard_pending_lifecycle_owner_membership()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'active'
     and new.ended_at is null
     and exists (
       select 1
         from public.organization_access_grants grant_row
         join public.organizations organization
           on organization.id = grant_row.organization_id
          and organization.status = 'active'
        where grant_row.membership_id = new.id
          and grant_row.organization_id = new.organization_id
          and grant_row.access_profile = 'organization_owner'
          and grant_row.scope_type = 'organization'
          and grant_row.status = 'active'
          and grant_row.expires_at is null
          and not (
            organization.organization_type = 'single_hotel'
            and grant_row.source = 'legacy_backfill'
          )
     )
     and exists (
       select 1
         from public.account_lifecycle_intents intent
        where intent.account_id = new.account_id
          and intent.status = 'pending'
     )
  then
    raise exception 'account lifecycle change pending'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function public._staxis_guard_pending_lifecycle_owner_membership()
  from public, anon, authenticated;

drop trigger if exists trg_organization_memberships_guard_pending_lifecycle
  on public.organization_memberships;
create trigger trg_organization_memberships_guard_pending_lifecycle
  before update of account_id, organization_id, status, starts_at, ended_at
  on public.organization_memberships
  for each row execute function public._staxis_guard_pending_lifecycle_owner_membership();

create or replace function public._staxis_guard_pending_lifecycle_owner_organization()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'active'
     and (
       old.status is distinct from new.status
       or old.organization_type is distinct from new.organization_type
     )
     and exists (
       select 1
         from public.organization_access_grants grant_row
         join public.organization_memberships membership
           on membership.id = grant_row.membership_id
          and membership.organization_id = grant_row.organization_id
         join public.account_lifecycle_intents intent
           on intent.account_id = membership.account_id
          and intent.status = 'pending'
        where grant_row.organization_id = new.id
          and grant_row.access_profile = 'organization_owner'
          and grant_row.scope_type = 'organization'
          and grant_row.status = 'active'
          and grant_row.expires_at is null
          and membership.status = 'active'
          and membership.ended_at is null
          and not (
            new.organization_type = 'single_hotel'
            and grant_row.source = 'legacy_backfill'
          )
     )
  then
    raise exception 'account lifecycle change pending'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function public._staxis_guard_pending_lifecycle_owner_organization()
  from public, anon, authenticated;

drop trigger if exists trg_organizations_guard_pending_lifecycle
  on public.organizations;
create trigger trg_organizations_guard_pending_lifecycle
  before update of status, organization_type on public.organizations
  for each row execute function public._staxis_guard_pending_lifecycle_owner_organization();

-- Atomically authorize and register an inert lifecycle intent. The account row
-- locks make actor/target state stable; the SHARE table lock serializes an
-- override revoke with the authorization decision, including absence of a row.
drop function if exists public.staxis_register_account_lifecycle_intent(
  uuid,uuid,uuid,text,uuid,uuid,boolean,boolean,text,uuid,timestamptz,bigint
);
create or replace function public.staxis_register_account_lifecycle_intent(
  p_operation_id uuid,
  p_actor_account_id uuid,
  p_actor_auth_user_id uuid,
  p_actor_email text,
  p_hotel_id uuid,
  p_target_account_id uuid,
  p_desired_active boolean,
  p_expected_active boolean,
  p_expected_role text,
  p_expected_auth_user_id uuid,
  p_expected_property_access uuid[],
  p_expected_intent_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.accounts%rowtype;
  v_target public.accounts%rowtype;
  v_existing public.account_lifecycle_intents%rowtype;
  v_pending public.account_lifecycle_intents%rowtype;
  v_version bigint;
begin
  if p_operation_id is null or p_actor_account_id is null
     or p_actor_auth_user_id is null or p_hotel_id is null
     or p_target_account_id is null or p_desired_active is null
  then
    return jsonb_build_object('status', 'invalid');
  end if;
  if p_actor_account_id = p_target_account_id then
    return jsonb_build_object('status', 'forbidden', 'reason', 'self');
  end if;

  -- Stable UUID ordering avoids actor-A/target-B versus actor-B/target-A
  -- deadlocks. Both rows remain locked through authorization + intent insert.
  perform 1
    from public.accounts account
   where account.id = any(array[p_actor_account_id, p_target_account_id])
   order by account.id
   for update;

  select * into v_actor from public.accounts where id = p_actor_account_id;
  select * into v_target from public.accounts where id = p_target_account_id;
  if v_actor.id is null or v_target.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if (select count(*) from public.accounts where data_user_id = p_actor_auth_user_id) <> 1
     or (select count(*) from public.accounts where data_user_id = v_target.data_user_id) <> 1
  then
    return jsonb_build_object('status', 'identity_conflict');
  end if;

  -- A retry with the same operation UUID resumes only its exact original
  -- action. It cannot adopt another actor's or hotel's pending operation.
  select * into v_existing
    from public.account_lifecycle_intents
   where operation_id = p_operation_id
   for update;
  if found then
    if v_existing.actor_account_id <> p_actor_account_id
       or v_existing.actor_auth_user_id <> p_actor_auth_user_id
       or v_existing.hotel_id <> p_hotel_id
       or v_existing.account_id <> p_target_account_id
       or v_existing.desired_active <> p_desired_active
    then
      return jsonb_build_object('status', 'operation_mismatch');
    end if;
    if v_target.lifecycle_intent_version > v_existing.version then
      return jsonb_build_object(
        'status', 'superseded',
        'operation_id', v_existing.operation_id,
        'active', v_target.active,
        'desired_active', v_target.lifecycle_desired_active,
        'intent_version', v_target.lifecycle_intent_version
      );
    end if;
    return jsonb_build_object(
      'status', v_existing.status,
      'operation_id', v_existing.operation_id,
      'intent_version', v_existing.version,
      'desired_active', v_existing.desired_active,
      'prior_active', v_existing.prior_active,
      'active', v_target.active,
      'committed_version', v_target.lifecycle_committed_version
    );
  end if;

  select * into v_pending
    from public.account_lifecycle_intents
   where account_id = p_target_account_id and status = 'pending'
   for update;
  if found then
    return jsonb_build_object('status', 'pending_conflict');
  end if;

  if exists (
    select 1
      from public.account_lifecycle_intents processing
     where processing.account_id = p_target_account_id
       and processing.processor_token is not null
       and processing.processor_lease_expires_at > clock_timestamp()
  ) then
    return jsonb_build_object('status', 'retry');
  end if;

  if not v_actor.active or v_actor.data_user_id <> p_actor_auth_user_id then
    return jsonb_build_object('status', 'forbidden', 'reason', 'caller_inactive');
  end if;
  if v_actor.role not in ('admin', 'owner', 'general_manager') then
    return jsonb_build_object('status', 'forbidden', 'reason', 'caller_role');
  end if;
  if v_target.role in ('admin', 'owner') then
    return jsonb_build_object('status', 'forbidden', 'reason', 'target_role');
  end if;
  if v_target.role = 'general_manager' and v_actor.role = 'general_manager' then
    return jsonb_build_object('status', 'forbidden', 'reason', 'hierarchy');
  end if;
  if not (p_hotel_id = any(coalesce(v_target.property_access, '{}'::uuid[]))) then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Serialize both existing override rows and an otherwise-racing insert that
  -- would revoke manage_users immediately after this decision.
  begin
    lock table public.capability_overrides,
               public.organizations,
               public.organization_memberships,
               public.organization_access_grants
      in share mode nowait;
  exception
    when lock_not_available then
      return jsonb_build_object('status', 'retry');
  end;

  if v_actor.role <> 'admin' then
    if not (p_hotel_id = any(coalesce(v_actor.property_access, '{}'::uuid[])))
       or not (coalesce(v_target.property_access, '{}'::uuid[])
               <@ coalesce(v_actor.property_access, '{}'::uuid[]))
    then
      return jsonb_build_object('status', 'forbidden', 'reason', 'scope');
    end if;
    if exists (
      select 1
      from unnest(coalesce(v_target.property_access, '{}'::uuid[])) hotel_id
      join public.capability_overrides override_row
        on override_row.property_id = hotel_id
       and override_row.capability = 'manage_users'
       and override_row.role = v_actor.role
       and override_row.allowed = false
    ) then
      return jsonb_build_object('status', 'forbidden', 'reason', 'manage_users');
    end if;
  end if;

  if v_target.active is distinct from p_expected_active
     or v_target.role is distinct from p_expected_role
     or v_target.data_user_id is distinct from p_expected_auth_user_id
     or v_target.property_access is distinct from p_expected_property_access
     or v_target.lifecycle_intent_version is distinct from p_expected_intent_version
  then
    return jsonb_build_object(
      'status', 'conflict',
      'active', v_target.active,
      'intent_version', v_target.lifecycle_intent_version
    );
  end if;

  -- Real organization owners use normalized grants and may still have a GM
  -- legacy account role. Hidden single-hotel legacy anchors are topology, not
  -- customer ownership, and intentionally do not block lifecycle work.
  if not p_desired_active and exists (
    select 1
      from public.organization_memberships membership
      join public.organization_access_grants grant_row
        on grant_row.membership_id = membership.id
       and grant_row.organization_id = membership.organization_id
      join public.organizations organization
        on organization.id = membership.organization_id
       and organization.status = 'active'
     where membership.account_id = v_target.id
       and membership.status = 'active'
       and membership.ended_at is null
       and grant_row.access_profile = 'organization_owner'
       and grant_row.scope_type = 'organization'
       and grant_row.status = 'active'
       and grant_row.expires_at is null
       and not (
         organization.organization_type = 'single_hotel'
         and grant_row.source = 'legacy_backfill'
       )
  ) then
    return jsonb_build_object('status', 'forbidden', 'reason', 'organization_owner');
  end if;

  v_version := v_target.lifecycle_intent_version + 1;
  update public.accounts
     set lifecycle_desired_active = p_desired_active,
         lifecycle_intent_version = v_version
   where id = v_target.id;

  insert into public.account_lifecycle_intents (
    operation_id, account_id, version, desired_active, prior_active,
    auth_user_id_snapshot, target_role_snapshot,
    target_property_access_snapshot,
    actor_account_id, actor_auth_user_id, actor_email, hotel_id
  ) values (
    p_operation_id, v_target.id, v_version, p_desired_active, v_target.active,
    v_target.data_user_id, v_target.role,
    v_target.property_access,
    v_actor.id, p_actor_auth_user_id, nullif(btrim(p_actor_email), ''), p_hotel_id
  );

  return jsonb_build_object(
    'status', 'pending',
    'operation_id', p_operation_id,
    'intent_version', v_version,
    'desired_active', p_desired_active,
    'prior_active', v_target.active,
    'active', v_target.active,
    'committed_version', v_target.lifecycle_committed_version,
    'auth_user_id', v_target.data_user_id
  );
end;
$$;

-- Exactly one route/cron worker may write Auth for an intent at a time. A
-- bounded renewable lease prevents overlapping retries from committing and
-- then clobbering a newer opposite operation with a stale Auth write.
create or replace function public.staxis_claim_account_lifecycle_intent(
  p_operation_id uuid,
  p_processor_token uuid,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_account_id uuid;
  v_intent public.account_lifecycle_intents%rowtype;
  v_target public.accounts%rowtype;
  v_lease interval;
begin
  if p_operation_id is null or p_processor_token is null then
    return jsonb_build_object('status', 'invalid');
  end if;
  v_lease := make_interval(
    secs => least(greatest(coalesce(p_lease_seconds, 300), 60), 600)
  );

  select intent.account_id into v_account_id
    from public.account_lifecycle_intents intent
   where intent.operation_id = p_operation_id;
  if v_account_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  perform 1 from public.accounts where id = v_account_id for update;
  select * into v_intent
    from public.account_lifecycle_intents
   where operation_id = p_operation_id
   for update;
  select * into v_target from public.accounts where id = v_account_id;

  if v_target.lifecycle_intent_version > v_intent.version then
    if exists (
      select 1 from public.account_lifecycle_intents pending
       where pending.account_id = v_account_id
         and pending.status = 'pending'
         and pending.operation_id <> p_operation_id
    ) then
      return jsonb_build_object('status', 'busy');
    end if;
  elsif v_intent.status <> 'pending' then
    return jsonb_build_object('status', v_intent.status);
  end if;

  if exists (
    select 1
      from public.account_lifecycle_intents processing
     where processing.account_id = v_account_id
       and processing.processor_token is not null
       and processing.processor_token <> p_processor_token
       and processing.processor_lease_expires_at > clock_timestamp()
  ) then
    return jsonb_build_object('status', 'busy');
  end if;

  -- The account row lock serializes claims and registrations. Clear expired
  -- claims before assigning this token so the per-account unique index is a
  -- hard invariant rather than best-effort application coordination.
  update public.account_lifecycle_intents expired
     set processor_token = null,
         processor_lease_expires_at = null
   where expired.account_id = v_account_id
     and expired.operation_id <> p_operation_id
     and expired.processor_token is not null
     and expired.processor_lease_expires_at <= clock_timestamp();

  update public.account_lifecycle_intents
     set processor_token = p_processor_token,
         processor_lease_expires_at = clock_timestamp() + v_lease,
         updated_at = now()
   where operation_id = p_operation_id
  returning * into v_intent;
  return jsonb_build_object(
    'status', case
      when v_target.lifecycle_intent_version > v_intent.version
        then 'superseded'
      else 'claimed'
    end,
    'operation_id', v_intent.operation_id,
    'active', v_target.active,
    'desired_active', v_target.lifecycle_desired_active,
    'intent_version', v_target.lifecycle_intent_version,
    'lease_expires_at', v_intent.processor_lease_expires_at
  );
end;
$$;

-- Complete a verified pending intent. The target snapshot/owner rechecks fence
-- a grant change that happened after registration. active, role_changes,
-- admin_audit_log, committed version, and intent status share one transaction.
drop function if exists public.staxis_commit_account_lifecycle_intent(uuid,text);
create or replace function public.staxis_commit_account_lifecycle_intent(
  p_operation_id uuid,
  p_request_id text,
  p_processor_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_account_id uuid;
  v_intent public.account_lifecycle_intents%rowtype;
  v_target public.accounts%rowtype;
  v_state_changed boolean;
begin
  select account_id into v_account_id
    from public.account_lifecycle_intents
   where operation_id = p_operation_id;
  if v_account_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  perform 1 from public.accounts where id = v_account_id for update;
  select * into v_intent
    from public.account_lifecycle_intents
   where operation_id = p_operation_id
   for update;
  select * into v_target from public.accounts where id = v_account_id;

  if v_target.lifecycle_intent_version > v_intent.version then
    return jsonb_build_object(
      'status', 'superseded',
      'active', v_target.active,
      'desired_active', v_target.lifecycle_desired_active,
      'intent_version', v_target.lifecycle_intent_version
    );
  end if;
  if v_intent.status = 'committed' then
    return jsonb_build_object(
      'status', 'committed',
      'operation_id', v_intent.operation_id,
      'intent_version', v_intent.version,
      'active', v_target.active,
      'noop', v_intent.prior_active = v_intent.desired_active
    );
  end if;
  if v_intent.status = 'aborted' then
    return jsonb_build_object('status', 'aborted');
  end if;
  if p_processor_token is null
     or v_intent.processor_token is distinct from p_processor_token
     or v_intent.processor_lease_expires_at <= clock_timestamp()
  then
    return jsonb_build_object('status', 'lease_lost');
  end if;
  if v_target.lifecycle_intent_version <> v_intent.version
     or v_target.lifecycle_desired_active <> v_intent.desired_active
  then
    return jsonb_build_object(
      'status', 'superseded',
      'active', v_target.active,
      'desired_active', v_target.lifecycle_desired_active,
      'intent_version', v_target.lifecycle_intent_version
    );
  end if;
  if v_target.data_user_id <> v_intent.auth_user_id_snapshot
     or v_target.role <> v_intent.target_role_snapshot
     or v_target.property_access <> v_intent.target_property_access_snapshot
     or v_target.active <> v_intent.prior_active
     or v_intent.auth_snapshot_recorded_at is null
     or v_target.role in ('admin', 'owner')
  then
    return jsonb_build_object(
      'status', 'invariant_conflict',
      'reason', case
        when v_intent.auth_snapshot_recorded_at is null then 'auth_snapshot_missing'
        else 'target_snapshot_changed'
      end
    );
  end if;

  if not v_intent.desired_active and exists (
    select 1
      from public.organization_memberships membership
      join public.organization_access_grants grant_row
        on grant_row.membership_id = membership.id
       and grant_row.organization_id = membership.organization_id
      join public.organizations organization
        on organization.id = membership.organization_id
       and organization.status = 'active'
     where membership.account_id = v_target.id
       and membership.status = 'active'
       and membership.ended_at is null
       and grant_row.access_profile = 'organization_owner'
       and grant_row.scope_type = 'organization'
       and grant_row.status = 'active'
       and grant_row.expires_at is null
       and not (
         organization.organization_type = 'single_hotel'
         and grant_row.source = 'legacy_backfill'
       )
  ) then
    return jsonb_build_object('status', 'invariant_conflict', 'reason', 'organization_owner');
  end if;

  perform set_config('staxis.actor_account_id', v_intent.actor_account_id::text, true);
  perform set_config(
    'staxis.account_lifecycle_operation_id',
    v_intent.operation_id::text,
    true
  );
  v_state_changed := v_target.active is distinct from v_intent.desired_active;
  if v_state_changed then
    update public.accounts
       set active = v_intent.desired_active,
           lifecycle_committed_version = v_intent.version
     where id = v_target.id;
  else
    -- Do not execute UPDATE OF active for a no-op: 0325 active triggers have
    -- intentional request-cancellation and organization side effects.
    update public.accounts
       set lifecycle_committed_version = v_intent.version
     where id = v_target.id;
  end if;

  insert into public.role_changes (
    account_id, property_id, changed_by_account_id,
    old_role, new_role, change_kind, reason
  )
  select
    v_target.id, affected_hotel.id, v_intent.actor_account_id,
    v_target.role, v_target.role,
    case when v_intent.desired_active then 'reactivate' else 'deactivate' end,
    null
  from (
    select distinct unnest(v_target.property_access) as id
  ) affected_hotel;

  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, metadata
  ) values (
    v_intent.actor_auth_user_id,
    v_intent.actor_email,
    case when v_intent.desired_active then 'account.reactivate' else 'account.deactivate' end,
    'account',
    v_target.id::text,
    jsonb_build_object(
      'hotel_id', v_intent.hotel_id,
      'role', v_target.role,
      'sign_in_blocked', not v_intent.desired_active,
      'global_account_change', true,
      'affected_hotel_ids', to_jsonb(v_target.property_access),
      'state_changed', v_state_changed,
      'operation_id', v_intent.operation_id,
      'lifecycle_version', v_intent.version,
      'request_id', p_request_id
    )
  );

  update public.account_lifecycle_intents
     set status = 'committed',
         committed_at = now(),
         processor_token = null,
         processor_lease_expires_at = null,
         updated_at = now(),
         last_error = null
   where operation_id = v_intent.operation_id;

  return jsonb_build_object(
    'status', 'committed',
    'operation_id', v_intent.operation_id,
    'intent_version', v_intent.version,
    'active', v_intent.desired_active,
    'noop', not v_state_changed
  );
end;
$$;

-- Once Auth has been restored and verified to the still-committed active state,
-- abort a failed pending operation and append a committed inert compensation
-- version. No UPDATE OF active occurs here.
drop function if exists public.staxis_compensate_account_lifecycle_intent(uuid,text);
create or replace function public.staxis_compensate_account_lifecycle_intent(
  p_operation_id uuid,
  p_reason text,
  p_processor_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_account_id uuid;
  v_intent public.account_lifecycle_intents%rowtype;
  v_target public.accounts%rowtype;
  v_compensation_id uuid := gen_random_uuid();
  v_version bigint;
begin
  select account_id into v_account_id
    from public.account_lifecycle_intents
   where operation_id = p_operation_id;
  if v_account_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  perform 1 from public.accounts where id = v_account_id for update;
  select * into v_intent
    from public.account_lifecycle_intents
   where operation_id = p_operation_id
   for update;
  select * into v_target from public.accounts where id = v_account_id;

  if v_target.lifecycle_intent_version > v_intent.version
     and v_intent.status = 'committed'
  then
    return jsonb_build_object(
      'status', 'superseded',
      'active', v_target.active,
      'desired_active', v_target.lifecycle_desired_active,
      'intent_version', v_target.lifecycle_intent_version
    );
  end if;
  if v_intent.status = 'committed' then
    return jsonb_build_object('status', 'committed', 'active', v_target.active);
  end if;
  if v_intent.status = 'aborted' then
    return jsonb_build_object('status', 'aborted', 'active', v_target.active);
  end if;
  if p_processor_token is null
     or v_intent.processor_token is distinct from p_processor_token
     or v_intent.processor_lease_expires_at <= clock_timestamp()
  then
    return jsonb_build_object('status', 'lease_lost');
  end if;
  if v_target.lifecycle_intent_version <> v_intent.version then
    update public.account_lifecycle_intents
       set status = 'aborted',
           aborted_at = now(),
           processor_token = null,
           processor_lease_expires_at = null,
           abort_reason = left(
             coalesce(nullif(btrim(p_reason), ''), 'Superseded lifecycle intent'),
             500
           ),
           updated_at = now()
     where operation_id = v_intent.operation_id;
    insert into public.admin_audit_log (
      actor_user_id, actor_email, action, target_type, target_id, metadata
    ) values (
      v_intent.actor_auth_user_id, v_intent.actor_email,
      'account.lifecycle_superseded', 'account', v_target.id::text,
      jsonb_build_object(
        'hotel_id', v_intent.hotel_id,
        'operation_id', v_intent.operation_id,
        'active', v_target.active,
        'latest_lifecycle_version', v_target.lifecycle_intent_version,
        'reason', left(
          coalesce(nullif(btrim(p_reason), ''), 'Superseded lifecycle intent'),
          500
        )
      )
    );
    return jsonb_build_object(
      'status', 'aborted',
      'active', v_target.active,
      'intent_version', v_target.lifecycle_intent_version
    );
  end if;

  v_version := v_target.lifecycle_intent_version + 1;
  update public.account_lifecycle_intents
     set status = 'aborted',
         aborted_at = now(),
         processor_token = null,
         processor_lease_expires_at = null,
         abort_reason = left(coalesce(nullif(btrim(p_reason), ''), 'Auth state not changed'), 500),
         updated_at = now()
   where operation_id = v_intent.operation_id;

  update public.accounts
     set lifecycle_desired_active = v_target.active,
         lifecycle_intent_version = v_version,
         lifecycle_committed_version = v_version
   where id = v_target.id;

  insert into public.account_lifecycle_intents (
    operation_id, account_id, version, desired_active, prior_active,
    auth_user_id_snapshot, target_role_snapshot,
    target_property_access_snapshot,
    actor_account_id, actor_auth_user_id, actor_email, hotel_id,
    status, committed_at, compensates_operation_id, last_error
  ) values (
    v_compensation_id, v_target.id, v_version, v_target.active, v_target.active,
    v_target.data_user_id, v_target.role,
    v_target.property_access,
    v_intent.actor_account_id, v_intent.actor_auth_user_id,
    v_intent.actor_email, v_intent.hotel_id,
    'committed', now(), v_intent.operation_id,
    left(coalesce(nullif(btrim(p_reason), ''), 'Auth state not changed'), 500)
  );

  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, metadata
  ) values (
    v_intent.actor_auth_user_id, v_intent.actor_email,
    'account.lifecycle_compensated', 'account', v_target.id::text,
    jsonb_build_object(
      'hotel_id', v_intent.hotel_id,
      'operation_id', v_intent.operation_id,
      'compensation_operation_id', v_compensation_id,
      'active', v_target.active,
      'reason', left(coalesce(nullif(btrim(p_reason), ''), 'Auth state not changed'), 500)
    )
  );

  return jsonb_build_object(
    'status', 'aborted',
    'operation_id', v_intent.operation_id,
    'compensation_operation_id', v_compensation_id,
    'active', v_target.active,
    'intent_version', v_version
  );
end;
$$;

create or replace function public.staxis_note_account_lifecycle_attempt(
  p_operation_id uuid,
  p_error text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_intent public.account_lifecycle_intents%rowtype;
begin
  update public.account_lifecycle_intents
     set attempt_count = attempt_count + 1,
         last_attempt_at = now(),
         last_error = left(coalesce(nullif(btrim(p_error), ''), 'unknown'), 500),
         updated_at = now()
   where operation_id = p_operation_id
     and status = 'pending'
  returning * into v_intent;
  if not found then
    return jsonb_build_object('status', 'not_pending');
  end if;
  return jsonb_build_object(
    'status', 'pending',
    'operation_id', v_intent.operation_id,
    'attempt_count', v_intent.attempt_count
  );
end;
$$;

drop function if exists public.staxis_record_account_lifecycle_auth_snapshot(uuid,text);
create or replace function public.staxis_record_account_lifecycle_auth_snapshot(
  p_operation_id uuid,
  p_banned_until text,
  p_processor_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_intent public.account_lifecycle_intents%rowtype;
begin
  select * into v_intent
    from public.account_lifecycle_intents
   where operation_id = p_operation_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_intent.status <> 'pending' then
    return jsonb_build_object('status', v_intent.status);
  end if;
  if p_processor_token is null
     or v_intent.processor_token is distinct from p_processor_token
     or v_intent.processor_lease_expires_at <= clock_timestamp()
  then
    return jsonb_build_object('status', 'lease_lost');
  end if;

  update public.account_lifecycle_intents
     set auth_banned_until_snapshot = left(p_banned_until, 200),
         auth_snapshot_recorded_at = now(),
         updated_at = now()
   where operation_id = p_operation_id
     and status = 'pending'
     and auth_snapshot_recorded_at is null
  returning * into v_intent;

  if not found then
    select * into v_intent from public.account_lifecycle_intents
     where operation_id = p_operation_id;
  end if;
  return jsonb_build_object(
    'status', v_intent.status,
    'operation_id', v_intent.operation_id,
    'auth_banned_until', v_intent.auth_banned_until_snapshot,
    'auth_snapshot_recorded_at', v_intent.auth_snapshot_recorded_at
  );
end;
$$;

create or replace function public.staxis_get_account_lifecycle_intent(
  p_operation_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select jsonb_build_object(
      'status', intent.status,
      'operation_id', intent.operation_id,
      'account_id', intent.account_id,
      'intent_version', intent.version,
      'desired_active', intent.desired_active,
      'prior_active', intent.prior_active,
      'auth_user_id', intent.auth_user_id_snapshot,
      'auth_banned_until', intent.auth_banned_until_snapshot,
      'auth_snapshot_recorded_at', intent.auth_snapshot_recorded_at,
      'active', account.active,
      'committed_version', account.lifecycle_committed_version,
      'latest_desired_active', account.lifecycle_desired_active,
      'latest_intent_version', account.lifecycle_intent_version,
      'updated_at', intent.updated_at
    )
      from public.account_lifecycle_intents intent
      join public.accounts account on account.id = intent.account_id
     where intent.operation_id = p_operation_id
  ), jsonb_build_object('status', 'not_found'));
$$;

create or replace function public.staxis_release_account_lifecycle_processor(
  p_operation_id uuid,
  p_processor_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_account_id uuid;
  v_intent public.account_lifecycle_intents%rowtype;
begin
  select account_id into v_account_id
    from public.account_lifecycle_intents
   where operation_id = p_operation_id;
  if v_account_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  perform 1 from public.accounts where id = v_account_id for update;
  select * into v_intent
    from public.account_lifecycle_intents
   where operation_id = p_operation_id
   for update;
  if v_intent.status = 'pending' then
    return jsonb_build_object('status', 'still_pending');
  end if;
  if v_intent.processor_token is null then
    return jsonb_build_object('status', 'released');
  end if;
  if p_processor_token is null
     or v_intent.processor_token <> p_processor_token
  then
    return jsonb_build_object('status', 'lease_lost');
  end if;
  update public.account_lifecycle_intents
     set processor_token = null,
         processor_lease_expires_at = null,
         updated_at = now()
   where operation_id = p_operation_id;
  return jsonb_build_object('status', 'released');
end;
$$;

-- Ordinary (non-owner) role changes are global account mutations. Authorize
-- against locked actor/target rows and serialize capability revokes; write the
-- role plus every hotel-scoped audit row in the same transaction.
drop function if exists public.staxis_change_hotel_team_role_guarded(
  uuid,uuid,text,uuid,uuid,text,text,boolean,text,uuid,uuid[],text,bigint,text
);
create or replace function public.staxis_change_hotel_team_role_guarded(
  p_actor_account_id uuid,
  p_actor_auth_user_id uuid,
  p_actor_email text,
  p_hotel_id uuid,
  p_target_account_id uuid,
  p_new_role text,
  p_new_display_name text,
  p_expected_active boolean,
  p_expected_role text,
  p_expected_auth_user_id uuid,
  p_expected_property_access uuid[],
  p_expected_display_name text,
  p_expected_updated_at timestamptz,
  p_expected_intent_version bigint,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.accounts%rowtype;
  v_target public.accounts%rowtype;
  v_display_name text;
begin
  if p_actor_account_id is null or p_actor_auth_user_id is null
     or p_hotel_id is null or p_target_account_id is null
     or p_new_role is null
  then
    return jsonb_build_object('status', 'invalid');
  end if;
  if p_actor_account_id = p_target_account_id then
    return jsonb_build_object('status', 'forbidden', 'reason', 'self');
  end if;
  if p_new_role not in (
    'general_manager', 'front_desk', 'housekeeping', 'maintenance'
  ) then
    return jsonb_build_object('status', 'invalid', 'reason', 'role');
  end if;
  v_display_name := case
    when p_new_display_name is null then null
    else nullif(btrim(p_new_display_name), '')
  end;
  if p_new_display_name is not null
     and (v_display_name is null or char_length(v_display_name) > 120)
  then
    return jsonb_build_object('status', 'invalid', 'reason', 'display_name');
  end if;

  perform 1
    from public.accounts account
   where account.id = any(array[p_actor_account_id, p_target_account_id])
   order by account.id
   for update;
  select * into v_actor from public.accounts where id = p_actor_account_id;
  select * into v_target from public.accounts where id = p_target_account_id;
  if v_actor.id is null or v_target.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  if exists (
    select 1
      from public.account_lifecycle_intents intent
     where intent.status = 'pending'
       and intent.account_id = any(array[p_actor_account_id, p_target_account_id])
  ) then
    return jsonb_build_object('status', 'pending_conflict');
  end if;
  begin
    lock table public.capability_overrides,
               public.organizations,
               public.organization_memberships,
               public.organization_access_grants
      in share mode nowait;
  exception
    when lock_not_available then
      return jsonb_build_object('status', 'retry');
  end;

  if not v_actor.active or v_actor.data_user_id <> p_actor_auth_user_id
     or v_actor.role not in ('admin', 'owner', 'general_manager')
  then
    return jsonb_build_object('status', 'forbidden', 'reason', 'actor');
  end if;
  if not v_target.active or v_target.role in ('admin', 'owner') then
    return jsonb_build_object('status', 'forbidden', 'reason', 'target');
  end if;
  -- A real normalized organization owner may still carry a legacy hotel GM
  -- role. Do not let the ordinary hotel-role path mutate that principal. The
  -- four SHARE locks above make both an existing owner grant and its absence
  -- stable through this decision. Hidden single-hotel legacy grants remain
  -- compatibility topology and intentionally do not count as ownership.
  if exists (
    select 1
      from public.organization_memberships membership
      join public.organization_access_grants grant_row
        on grant_row.membership_id = membership.id
       and grant_row.organization_id = membership.organization_id
      join public.organizations organization
        on organization.id = membership.organization_id
       and organization.status = 'active'
     where membership.account_id = v_target.id
       and membership.status = 'active'
       and membership.ended_at is null
       and grant_row.access_profile = 'organization_owner'
       and grant_row.scope_type = 'organization'
       and grant_row.status = 'active'
       and grant_row.expires_at is null
       and not (
         organization.organization_type = 'single_hotel'
         and grant_row.source = 'legacy_backfill'
       )
  ) then
    return jsonb_build_object(
      'status', 'forbidden',
      'reason', 'organization_owner'
    );
  end if;
  if v_target.role = 'general_manager' and v_actor.role = 'general_manager' then
    return jsonb_build_object('status', 'forbidden', 'reason', 'hierarchy');
  end if;
  if p_new_role = 'general_manager'
     and v_actor.role not in ('admin', 'owner')
  then
    return jsonb_build_object('status', 'forbidden', 'reason', 'promotion');
  end if;
  if not (p_hotel_id = any(coalesce(v_target.property_access, '{}'::uuid[]))) then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_actor.role <> 'admin' then
    if not (p_hotel_id = any(coalesce(v_actor.property_access, '{}'::uuid[])))
       or not (coalesce(v_target.property_access, '{}'::uuid[])
               <@ coalesce(v_actor.property_access, '{}'::uuid[]))
    then
      return jsonb_build_object('status', 'forbidden', 'reason', 'scope');
    end if;
    if exists (
      select 1
        from unnest(coalesce(v_target.property_access, '{}'::uuid[])) hotel_id
        join public.capability_overrides override_row
          on override_row.property_id = hotel_id
         and override_row.capability = 'manage_users'
         and override_row.role = v_actor.role
         and override_row.allowed = false
    ) then
      return jsonb_build_object('status', 'forbidden', 'reason', 'manage_users');
    end if;
  end if;

  if v_target.active is distinct from p_expected_active
     or v_target.role is distinct from p_expected_role
     or v_target.data_user_id is distinct from p_expected_auth_user_id
     or v_target.property_access is distinct from p_expected_property_access
     or v_target.display_name is distinct from p_expected_display_name
     or v_target.updated_at is distinct from p_expected_updated_at
     or v_target.lifecycle_intent_version is distinct from p_expected_intent_version
  then
    return jsonb_build_object('status', 'conflict');
  end if;
  if v_target.role = p_new_role
     and (v_display_name is null or v_target.display_name = v_display_name)
  then
    return jsonb_build_object('status', 'noop');
  end if;

  perform set_config('staxis.actor_account_id', v_actor.id::text, true);
  perform set_config('staxis.request_id', coalesce(p_request_id, ''), true);
  update public.accounts
     set role = p_new_role,
         display_name = coalesce(v_display_name, display_name)
   where id = v_target.id;

  insert into public.role_changes (
    account_id, property_id, changed_by_account_id,
    old_role, new_role, change_kind, reason
  )
  select v_target.id, affected_hotel.id, v_actor.id,
         v_target.role, p_new_role, 'role_change', null
    from (
      select distinct unnest(v_target.property_access) as id
    ) affected_hotel;

  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, metadata
  ) values (
    p_actor_auth_user_id, nullif(btrim(p_actor_email), ''),
    'account.team_update', 'account', v_target.id::text,
    jsonb_build_object(
      'hotel_id', p_hotel_id,
      'affected_hotel_ids', to_jsonb(v_target.property_access),
      'display_name_changed', v_display_name is not null
        and v_display_name <> v_target.display_name,
      'role_changed', p_new_role,
      'old_role', v_target.role,
      'password_reset', false,
      'staff_link_changed', false,
      'request_id', p_request_id
    )
  );
  return jsonb_build_object('status', 'ok');
end;
$$;

-- Server-side projection helper for My Hotel. Browser roles cannot inspect the
-- normalized organization graph directly; this returns only the requested
-- account IDs that are protected real owners under the lifecycle predicate.
create or replace function public.staxis_list_normalized_organization_owner_account_ids(
  p_account_ids uuid[]
)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    array_agg(distinct membership.account_id order by membership.account_id),
    '{}'::uuid[]
  )
    from public.organization_memberships membership
    join public.organization_access_grants grant_row
      on grant_row.membership_id = membership.id
     and grant_row.organization_id = membership.organization_id
    join public.organizations organization
      on organization.id = membership.organization_id
     and organization.status = 'active'
   where membership.account_id = any(coalesce(p_account_ids, '{}'::uuid[]))
     and membership.status = 'active'
     and membership.ended_at is null
     and grant_row.access_profile = 'organization_owner'
     and grant_row.scope_type = 'organization'
     and grant_row.status = 'active'
     and grant_row.expires_at is null
     and not (
       organization.organization_type = 'single_hotel'
       and grant_row.source = 'legacy_backfill'
     );
$$;

-- Replace the legacy detach helper so normalized organization owners are
-- protected by the same authoritative predicate as role/lifecycle controls.
-- The graph SHARE locks make both an owner grant and its absence stable until
-- the account-row update commits.
create or replace function public.staxis_remove_property_access_guarded(
  p_account_id uuid,
  p_hotel_id uuid,
  p_expected_role text,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_account public.accounts%rowtype;
  v_remaining_hotels integer;
begin
  select * into v_account
    from public.accounts account
   where account.id = p_account_id
   for update;
  if v_account.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if exists (
    select 1 from public.account_lifecycle_intents intent
     where intent.account_id = v_account.id and intent.status = 'pending'
  ) then
    return jsonb_build_object('status', 'pending_conflict');
  end if;
  begin
    lock table public.organizations,
               public.organization_memberships,
               public.organization_access_grants
      in share mode nowait;
  exception
    when lock_not_available then
      return jsonb_build_object('status', 'retry');
  end;
  if exists (
    select 1
      from public.organization_memberships membership
      join public.organization_access_grants grant_row
        on grant_row.membership_id = membership.id
       and grant_row.organization_id = membership.organization_id
      join public.organizations organization
        on organization.id = membership.organization_id
       and organization.status = 'active'
     where membership.account_id = v_account.id
       and membership.status = 'active'
       and membership.ended_at is null
       and grant_row.access_profile = 'organization_owner'
       and grant_row.scope_type = 'organization'
       and grant_row.status = 'active'
       and grant_row.expires_at is null
       and not (
         organization.organization_type = 'single_hotel'
         and grant_row.source = 'legacy_backfill'
       )
  ) then
    return jsonb_build_object(
      'status', 'forbidden',
      'reason', 'organization_owner'
    );
  end if;
  if v_account.role is distinct from p_expected_role
     or v_account.updated_at is distinct from p_expected_updated_at
  then
    return jsonb_build_object('status', 'conflict');
  end if;
  if not (p_hotel_id = any(coalesce(v_account.property_access, '{}'::uuid[]))) then
    return jsonb_build_object('status', 'not_attached');
  end if;

  update public.accounts
     set property_access = array_remove(
           coalesce(v_account.property_access, '{}'::uuid[]),
           p_hotel_id
         ),
         updated_at = now()
   where id = v_account.id
   returning coalesce(array_length(property_access, 1), 0)
        into v_remaining_hotels;
  return jsonb_build_object(
    'status', 'ok',
    'remaining_hotels', v_remaining_hotels
  );
end;
$$;

-- 0220 locked the old owner and then the new owner. Lifecycle registration
-- locks actor/target by UUID, so opposite requests could deadlock. Replace the
-- ownership RPC with the same stable ordering and make the pending-intent
-- check part of the locked transaction rather than relying on a route precheck.
create or replace function public.staxis_transfer_ownership(
  p_property_id uuid,
  p_old_owner_account_id uuid,
  p_new_owner_account_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old_row public.accounts%rowtype;
  v_new_row public.accounts%rowtype;
begin
  if p_old_owner_account_id = p_new_owner_account_id then
    return '{"ok":false,"error":"old and new owner are the same account"}';
  end if;

  perform 1
    from public.accounts account
   where account.id = any(array[p_old_owner_account_id, p_new_owner_account_id])
   order by account.id
   for update;

  select * into v_old_row
    from public.accounts where id = p_old_owner_account_id;
  select * into v_new_row
    from public.accounts where id = p_new_owner_account_id;
  if v_old_row.id is null then
    return '{"ok":false,"error":"old owner account not found"}';
  end if;
  if v_new_row.id is null then
    return '{"ok":false,"error":"new owner account not found"}';
  end if;
  if exists (
    select 1
      from public.account_lifecycle_intents intent
     where intent.status = 'pending'
       and intent.account_id = any(array[p_old_owner_account_id, p_new_owner_account_id])
  ) then
    return '{"ok":false,"error":"account lifecycle change pending"}';
  end if;
  begin
    lock table public.capability_overrides,
               public.organizations,
               public.organization_memberships,
               public.organization_access_grants
      in share mode nowait;
  exception
    when lock_not_available then
      return '{"ok":false,"error":"ownership transfer temporarily unavailable"}';
  end;
  if exists (
    select 1
      from public.organization_memberships membership
      join public.organization_access_grants grant_row
        on grant_row.membership_id = membership.id
       and grant_row.organization_id = membership.organization_id
      join public.organizations organization
        on organization.id = membership.organization_id
       and organization.status = 'active'
     where membership.account_id = any(array[
       p_old_owner_account_id, p_new_owner_account_id
     ])
       and membership.status = 'active'
       and membership.ended_at is null
       and grant_row.access_profile = 'organization_owner'
       and grant_row.scope_type = 'organization'
       and grant_row.status = 'active'
       and grant_row.expires_at is null
       and not (
         organization.organization_type = 'single_hotel'
         and grant_row.source = 'legacy_backfill'
       )
  ) then
    return '{"ok":false,"error":"normalized organization ownership must be managed separately"}';
  end if;
  if v_old_row.role <> 'owner' then
    return '{"ok":false,"error":"caller is not currently the owner"}';
  end if;
  if not (p_property_id = any(coalesce(v_old_row.property_access, '{}'::uuid[]))) then
    return '{"ok":false,"error":"old owner has no access to this hotel"}';
  end if;
  if v_new_row.role = 'admin' then
    return '{"ok":false,"error":"cannot transfer ownership to an admin"}';
  end if;
  if not v_new_row.active then
    return '{"ok":false,"error":"cannot transfer ownership to a deactivated account"}';
  end if;
  if not (p_property_id = any(coalesce(v_new_row.property_access, '{}'::uuid[]))) then
    return '{"ok":false,"error":"new owner has no access to this hotel"}';
  end if;
  if (
    select coalesce(array_agg(distinct hotel_id order by hotel_id), '{}'::uuid[])
      from unnest(coalesce(v_old_row.property_access, '{}'::uuid[])) hotel_id
  ) is distinct from (
    select coalesce(array_agg(distinct hotel_id order by hotel_id), '{}'::uuid[])
      from unnest(coalesce(v_new_row.property_access, '{}'::uuid[])) hotel_id
  ) then
    return '{"ok":false,"error":"ownership transfer requires the same hotel access"}';
  end if;

  update public.accounts set role = 'owner'
   where id = p_new_owner_account_id;
  update public.accounts set role = 'general_manager'
   where id = p_old_owner_account_id;
  return '{"ok":true}';
end;
$$;

-- Rollout-safe ownership transfer for My Hotel. The legacy three-argument
-- function above remains callable while older application instances drain.
-- New callers bind the signed-in Auth identity, supply exact old/new account
-- snapshots, and receive structured statuses. Account rows are locked in UUID
-- order, so actor/old/new overlap and opposite transfers cannot deadlock.
-- Role writes and all structured/generic audit rows commit atomically.
drop function if exists public.staxis_transfer_ownership_guarded(
  uuid,uuid,text,uuid,uuid,uuid,
  boolean,text,uuid,uuid[],bigint,
  boolean,text,uuid,uuid[],bigint,text,text
);
create or replace function public.staxis_transfer_ownership_guarded(
  p_operation_id uuid,
  p_actor_account_id uuid,
  p_actor_auth_user_id uuid,
  p_actor_email text,
  p_property_id uuid,
  p_old_owner_account_id uuid,
  p_new_owner_account_id uuid,
  p_expected_old_active boolean,
  p_expected_old_role text,
  p_expected_old_auth_user_id uuid,
  p_expected_old_property_access uuid[],
  p_expected_old_intent_version bigint,
  p_expected_new_active boolean,
  p_expected_new_role text,
  p_expected_new_auth_user_id uuid,
  p_expected_new_property_access uuid[],
  p_expected_new_intent_version bigint,
  p_reason text,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.accounts%rowtype;
  v_old_owner public.accounts%rowtype;
  v_new_owner public.accounts%rowtype;
  v_old_affected_hotel_ids uuid[];
  v_new_affected_hotel_ids uuid[];
  v_matching_audit boolean;
  v_reason text;
  v_request_id text;
begin
  v_request_id := nullif(btrim(p_request_id), '');
  v_reason := nullif(btrim(p_reason), '');
  if p_operation_id is null
     or p_actor_account_id is null or p_actor_auth_user_id is null
     or p_property_id is null or p_old_owner_account_id is null
     or p_new_owner_account_id is null
     or p_expected_old_active is null or p_expected_old_role is null
     or p_expected_old_auth_user_id is null
     or p_expected_old_property_access is null
     or p_expected_old_intent_version is null
     or p_expected_new_active is null or p_expected_new_role is null
     or p_expected_new_auth_user_id is null
     or p_expected_new_property_access is null
     or p_expected_new_intent_version is null
     or v_request_id is null or char_length(v_request_id) > 200
  then
    return jsonb_build_object('status', 'invalid');
  end if;
  if p_old_owner_account_id = p_new_owner_account_id then
    return jsonb_build_object('status', 'invalid', 'reason', 'same_account');
  end if;
  if v_reason is not null and char_length(v_reason) > 500 then
    return jsonb_build_object('status', 'invalid', 'reason', 'reason');
  end if;

  -- The client-stable operation UUID, not the per-attempt server request ID,
  -- is the idempotency key. Serialize it even if an invalid reuse targets
  -- disjoint accounts; the atomic audit row becomes the durable replay proof.
  perform pg_advisory_xact_lock(
    hashtextextended('staxis.transfer-ownership:' || p_operation_id::text, 0)
  );

  perform 1
    from public.accounts account
   where account.id = any(array[
     p_actor_account_id,
     p_old_owner_account_id,
     p_new_owner_account_id
   ])
   order by account.id
   for update;

  select * into v_actor
    from public.accounts where id = p_actor_account_id;
  select * into v_old_owner
    from public.accounts where id = p_old_owner_account_id;
  select * into v_new_owner
    from public.accounts where id = p_new_owner_account_id;
  if v_actor.id is null then
    return jsonb_build_object('status', 'not_found', 'reason', 'actor');
  end if;
  if v_old_owner.id is null then
    return jsonb_build_object('status', 'not_found', 'reason', 'old_owner');
  end if;
  if v_new_owner.id is null then
    return jsonb_build_object('status', 'not_found', 'reason', 'new_owner');
  end if;

  if v_actor.data_user_id <> p_actor_auth_user_id then
    return jsonb_build_object('status', 'forbidden', 'reason', 'actor');
  end if;

  select coalesce(array_agg(affected.id order by affected.id), '{}'::uuid[])
    into v_old_affected_hotel_ids
    from (
      select distinct unnest(v_old_owner.property_access) as id
    ) affected;
  select coalesce(array_agg(affected.id order by affected.id), '{}'::uuid[])
    into v_new_affected_hotel_ids
    from (
      select distinct unnest(v_new_owner.property_access) as id
    ) affected;

  select exists (
    select 1
      from public.admin_audit_log audit
     where audit.action = 'account.transfer_ownership'
       and audit.actor_user_id = p_actor_auth_user_id
       and audit.target_type = 'account'
       and audit.target_id = p_new_owner_account_id::text
       and audit.metadata ->> 'operation_id' = p_operation_id::text
       and audit.metadata ->> 'hotel_id' = p_property_id::text
       and audit.metadata ->> 'from_account_id'
             = p_old_owner_account_id::text
       and audit.metadata ->> 'to_account_id'
             = p_new_owner_account_id::text
  ) into v_matching_audit;

  if v_matching_audit then
    if v_old_owner.role = 'general_manager'
       and v_new_owner.role = 'owner'
       and exists (
         select 1
           from public.admin_audit_log audit
          where audit.action = 'account.transfer_ownership'
            and audit.actor_user_id = p_actor_auth_user_id
            and audit.target_type = 'account'
            and audit.target_id = p_new_owner_account_id::text
            and audit.metadata ->> 'operation_id' = p_operation_id::text
            and audit.metadata ->> 'hotel_id' = p_property_id::text
            and audit.metadata ->> 'from_account_id'
                  = p_old_owner_account_id::text
            and audit.metadata ->> 'to_account_id'
                  = p_new_owner_account_id::text
            and audit.metadata ->> 'from_active'
                  = v_old_owner.active::text
            and audit.metadata ->> 'to_active'
                  = v_new_owner.active::text
            and audit.metadata ->> 'from_auth_user_id'
                  = v_old_owner.data_user_id::text
            and audit.metadata ->> 'to_auth_user_id'
                  = v_new_owner.data_user_id::text
            and audit.metadata -> 'old_owner_affected_hotel_ids'
                  = to_jsonb(v_old_affected_hotel_ids)
            and audit.metadata -> 'new_owner_affected_hotel_ids'
                  = to_jsonb(v_new_affected_hotel_ids)
       )
    then
      return jsonb_build_object(
        'status', 'already_applied',
        'operation_id', p_operation_id,
        'old_owner_account_id', v_old_owner.id,
        'new_owner_account_id', v_new_owner.id
      );
    end if;
    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'replay_state_changed'
    );
  end if;

  if exists (
    select 1
      from public.admin_audit_log audit
     where audit.action = 'account.transfer_ownership'
       and audit.metadata ->> 'operation_id' = p_operation_id::text
  ) then
    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'operation_id_reused'
    );
  end if;

  -- A proven replay above is read-only and must remain available even if a
  -- later lifecycle intent has started. Only a brand-new transfer is fenced.
  if exists (
    select 1
      from public.account_lifecycle_intents intent
     where intent.status = 'pending'
       and intent.account_id = any(array[
         p_actor_account_id,
         p_old_owner_account_id,
         p_new_owner_account_id
       ])
  ) then
    return jsonb_build_object('status', 'pending_conflict');
  end if;

  -- Only an initial operation uses the caller's optimistic pre-state. A
  -- response-loss retry reaches the durable audit path above with post-state
  -- roles and therefore must not be rejected by these initial-state guards.
  if p_expected_old_role <> 'owner'
     or p_expected_new_role in ('admin', 'owner')
  then
    return jsonb_build_object('status', 'invalid', 'reason', 'role');
  end if;
  if not p_expected_old_active or not p_expected_new_active then
    return jsonb_build_object('status', 'invalid', 'reason', 'inactive_snapshot');
  end if;
  -- A role is global on accounts, not scoped per property. Exact set equality
  -- prevents demoting the old owner at a hotel the replacement cannot access
  -- or silently promoting the replacement at an unrelated extra hotel.
  if v_old_affected_hotel_ids is distinct from v_new_affected_hotel_ids then
    return jsonb_build_object(
      'status', 'conflict',
      'reason', 'hotel_access_mismatch'
    );
  end if;

  -- Serialize a capability restriction and normalized organization change
  -- with this authorization decision. Keep the table order identical to the
  -- lifecycle and ordinary-role RPCs to avoid cross-operation deadlocks.
  begin
    lock table public.capability_overrides,
               public.organizations,
               public.organization_memberships,
               public.organization_access_grants
      in share mode nowait;
  exception
    when lock_not_available then
      return jsonb_build_object('status', 'retry');
  end;

  -- accounts.role is only a legacy/global application role. A real normalized
  -- organization-owner relationship must be transferred by the company
  -- ownership workflow so the authoritative grant changes too. Hidden
  -- single-hotel legacy anchors remain compatible with this hotel flow.
  if exists (
    select 1
      from public.organization_memberships membership
      join public.organization_access_grants grant_row
        on grant_row.membership_id = membership.id
       and grant_row.organization_id = membership.organization_id
      join public.organizations organization
        on organization.id = membership.organization_id
       and organization.status = 'active'
     where membership.account_id = any(array[
       v_old_owner.id, v_new_owner.id
     ])
       and membership.status = 'active'
       and membership.ended_at is null
       and grant_row.access_profile = 'organization_owner'
       and grant_row.scope_type = 'organization'
       and grant_row.status = 'active'
       and grant_row.expires_at is null
       and not (
         organization.organization_type = 'single_hotel'
         and grant_row.source = 'legacy_backfill'
       )
  ) then
    return jsonb_build_object(
      'status', 'forbidden',
      'reason', 'normalized_organization_owner'
    );
  end if;

  if not v_actor.active then
    return jsonb_build_object('status', 'forbidden', 'reason', 'actor');
  end if;
  if not v_old_owner.active or v_old_owner.role <> 'owner' then
    return jsonb_build_object(
      'status', 'forbidden',
      'reason', 'current_owner'
    );
  end if;
  if v_actor.role <> 'admin'
     and (
       v_actor.id <> v_old_owner.id
       or v_actor.role <> 'owner'
     )
  then
    return jsonb_build_object(
      'status', 'forbidden',
      'reason', 'current_owner'
    );
  end if;
  if not v_new_owner.active or v_new_owner.role in ('admin', 'owner') then
    return jsonb_build_object('status', 'forbidden', 'reason', 'new_owner');
  end if;
  if not (p_property_id = any(
    coalesce(v_old_owner.property_access, '{}'::uuid[])
  )) or not (p_property_id = any(
    coalesce(v_new_owner.property_access, '{}'::uuid[])
  )) then
    return jsonb_build_object('status', 'not_found', 'reason', 'hotel_scope');
  end if;

  if v_actor.role <> 'admin' then
    if not (p_property_id = any(
      coalesce(v_actor.property_access, '{}'::uuid[])
    )) or not (
      coalesce(v_old_owner.property_access, '{}'::uuid[])
        <@ coalesce(v_actor.property_access, '{}'::uuid[])
    ) or not (
      coalesce(v_new_owner.property_access, '{}'::uuid[])
        <@ coalesce(v_actor.property_access, '{}'::uuid[])
    ) then
      return jsonb_build_object('status', 'forbidden', 'reason', 'scope');
    end if;
    if exists (
      select 1
        from (
          select distinct affected.id
            from unnest(
              coalesce(v_old_owner.property_access, '{}'::uuid[])
              || coalesce(v_new_owner.property_access, '{}'::uuid[])
            ) affected(id)
        ) affected_hotel
        join public.capability_overrides override_row
          on override_row.property_id = affected_hotel.id
         and override_row.capability = 'manage_users'
         and override_row.role = v_actor.role
         and override_row.allowed = false
    ) then
      return jsonb_build_object(
        'status', 'forbidden',
        'reason', 'manage_users'
      );
    end if;
  end if;

  if v_old_owner.active is distinct from p_expected_old_active
     or v_old_owner.role is distinct from p_expected_old_role
     or v_old_owner.data_user_id
          is distinct from p_expected_old_auth_user_id
     or v_old_owner.property_access
          is distinct from p_expected_old_property_access
     or v_old_owner.lifecycle_intent_version
          is distinct from p_expected_old_intent_version
     or v_new_owner.active is distinct from p_expected_new_active
     or v_new_owner.role is distinct from p_expected_new_role
     or v_new_owner.data_user_id
          is distinct from p_expected_new_auth_user_id
     or v_new_owner.property_access
          is distinct from p_expected_new_property_access
     or v_new_owner.lifecycle_intent_version
          is distinct from p_expected_new_intent_version
  then
    return jsonb_build_object('status', 'conflict');
  end if;

  perform set_config('staxis.actor_account_id', v_actor.id::text, true);
  perform set_config('staxis.request_id', v_request_id, true);

  update public.accounts
     set role = 'owner'
   where id = v_new_owner.id;
  update public.accounts
     set role = 'general_manager'
   where id = v_old_owner.id;

  insert into public.role_changes (
    account_id, property_id, changed_by_account_id,
    old_role, new_role, change_kind, reason
  )
  select v_new_owner.id, affected_hotel.id, v_actor.id,
         v_new_owner.role, 'owner', 'transfer_ownership', v_reason
    from unnest(v_new_affected_hotel_ids) affected_hotel(id);

  insert into public.role_changes (
    account_id, property_id, changed_by_account_id,
    old_role, new_role, change_kind, reason
  )
  select v_old_owner.id, affected_hotel.id, v_actor.id,
         v_old_owner.role, 'general_manager', 'transfer_ownership', v_reason
    from unnest(v_old_affected_hotel_ids) affected_hotel(id);

  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, metadata
  ) values (
    p_actor_auth_user_id,
    nullif(btrim(p_actor_email), ''),
    'account.transfer_ownership',
    'account',
    v_new_owner.id::text,
    jsonb_build_object(
      'hotel_id', p_property_id,
      'operation_id', p_operation_id,
      'from_account_id', v_old_owner.id,
      'to_account_id', v_new_owner.id,
      'from_old_role', v_old_owner.role,
      'to_old_role', v_new_owner.role,
      'from_active', v_old_owner.active,
      'to_active', v_new_owner.active,
      'from_auth_user_id', v_old_owner.data_user_id,
      'to_auth_user_id', v_new_owner.data_user_id,
      'from_property_access', to_jsonb(v_old_owner.property_access),
      'to_property_access', to_jsonb(v_new_owner.property_access),
      'from_lifecycle_intent_version',
        v_old_owner.lifecycle_intent_version,
      'to_lifecycle_intent_version',
        v_new_owner.lifecycle_intent_version,
      'old_owner_affected_hotel_ids',
        to_jsonb(v_old_affected_hotel_ids),
      'new_owner_affected_hotel_ids',
        to_jsonb(v_new_affected_hotel_ids),
      'global_account_change', true,
      'reason', v_reason,
      'request_id', v_request_id
    )
  );

  return jsonb_build_object(
    'status', 'ok',
    'operation_id', p_operation_id,
    'old_owner_account_id', v_old_owner.id,
    'new_owner_account_id', v_new_owner.id
  );
end;
$$;

revoke all on function public.staxis_transfer_ownership(uuid,uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_transfer_ownership(uuid,uuid,uuid)
  to service_role;
revoke all on function public.staxis_transfer_ownership_guarded(
  uuid,uuid,uuid,text,uuid,uuid,uuid,
  boolean,text,uuid,uuid[],bigint,
  boolean,text,uuid,uuid[],bigint,text,text
) from public, anon, authenticated;
grant execute on function public.staxis_transfer_ownership_guarded(
  uuid,uuid,uuid,text,uuid,uuid,uuid,
  boolean,text,uuid,uuid[],bigint,
  boolean,text,uuid,uuid[],bigint,text,text
) to service_role;

revoke all on function public.staxis_register_account_lifecycle_intent(
  uuid,uuid,uuid,text,uuid,uuid,boolean,boolean,text,uuid,uuid[],bigint
) from public, anon, authenticated;
grant execute on function public.staxis_register_account_lifecycle_intent(
  uuid,uuid,uuid,text,uuid,uuid,boolean,boolean,text,uuid,uuid[],bigint
) to service_role;

revoke all on function public.staxis_claim_account_lifecycle_intent(uuid,uuid,integer)
  from public, anon, authenticated;
grant execute on function public.staxis_claim_account_lifecycle_intent(uuid,uuid,integer)
  to service_role;
revoke all on function public.staxis_commit_account_lifecycle_intent(uuid,text,uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_commit_account_lifecycle_intent(uuid,text,uuid)
  to service_role;
revoke all on function public.staxis_compensate_account_lifecycle_intent(uuid,text,uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_compensate_account_lifecycle_intent(uuid,text,uuid)
  to service_role;
revoke all on function public.staxis_note_account_lifecycle_attempt(uuid,text)
  from public, anon, authenticated;
grant execute on function public.staxis_note_account_lifecycle_attempt(uuid,text)
  to service_role;
revoke all on function public.staxis_record_account_lifecycle_auth_snapshot(uuid,text,uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_record_account_lifecycle_auth_snapshot(uuid,text,uuid)
  to service_role;
revoke all on function public.staxis_get_account_lifecycle_intent(uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_get_account_lifecycle_intent(uuid)
  to service_role;
revoke all on function public.staxis_release_account_lifecycle_processor(uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_release_account_lifecycle_processor(uuid,uuid)
  to service_role;
revoke all on function public.staxis_change_hotel_team_role_guarded(
  uuid,uuid,text,uuid,uuid,text,text,boolean,text,uuid,uuid[],text,timestamptz,bigint,text
) from public, anon, authenticated;
grant execute on function public.staxis_change_hotel_team_role_guarded(
  uuid,uuid,text,uuid,uuid,text,text,boolean,text,uuid,uuid[],text,timestamptz,bigint,text
) to service_role;
revoke all on function public.staxis_list_normalized_organization_owner_account_ids(uuid[])
  from public, anon, authenticated;
grant execute on function public.staxis_list_normalized_organization_owner_account_ids(uuid[])
  to service_role;
revoke all on function public.staxis_remove_property_access_guarded(
  uuid,uuid,text,timestamptz
) from public, anon, authenticated;
grant execute on function public.staxis_remove_property_access_guarded(
  uuid,uuid,text,timestamptz
) to service_role;

comment on table public.account_lifecycle_intents is
  'Durable cross-system account activation intents. Service role only; Auth must be verified before atomic commit RPC.';
comment on function public.staxis_register_account_lifecycle_intent(
  uuid,uuid,uuid,text,uuid,uuid,boolean,boolean,text,uuid,uuid[],bigint
) is 'Atomically authorizes and registers an inert account lifecycle intent without changing accounts.active.';
comment on function public.staxis_commit_account_lifecycle_intent(uuid,text,uuid) is
  'Idempotently commits verified Auth state: accounts.active + role_changes + admin_audit_log + committed intent in one transaction.';
comment on function public.staxis_change_hotel_team_role_guarded(
  uuid,uuid,text,uuid,uuid,text,text,boolean,text,uuid,uuid[],text,timestamptz,bigint,text
) is 'Atomically authorizes a global non-owner hotel role change, rejects real normalized organization owners, and writes every scoped audit row.';
comment on function public.staxis_list_normalized_organization_owner_account_ids(uuid[])
  is 'Service-role projection of requested accounts protected by effective non-legacy normalized organization-owner grants.';
comment on function public.staxis_remove_property_access_guarded(uuid,uuid,text,timestamptz)
  is 'Atomically detaches one hotel only for the expected snapshot and never detaches an effective normalized organization owner.';
comment on function public.staxis_transfer_ownership_guarded(
  uuid,uuid,uuid,text,uuid,uuid,uuid,
  boolean,text,uuid,uuid[],bigint,
  boolean,text,uuid,uuid[],bigint,text,text
) is 'Rollout-safe atomic ownership transfer with Auth-bound authorization, exact old/new snapshots, lifecycle fences, global per-hotel role audits, generic audit, and client-stable operation-id replay detection.';

insert into public.applied_migrations (version, description)
values (
  '0335',
  'Durable service-role account lifecycle intents with atomic authorization, Auth-verification handoff, active/audit commit, compensation, and pending mutation fence'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
