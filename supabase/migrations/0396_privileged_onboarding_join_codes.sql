-- 0396_privileged_onboarding_join_codes.sql
--
-- Migration 0152 correctly retired reusable owner/GM join codes, but its
-- blanket CHECK also made the platform-admin new-hotel flow impossible on a
-- fresh schema. This migration restores only the narrow bootstrap capability:
-- one unrevoked, one-use owner/GM code for a hotel that is still demonstrably
-- unclaimed and incomplete. Mint and final signup are serialized RPCs; a trigger
-- guards every service-role write so a future route cannot accidentally turn
-- hotel_join_codes back into an ownership-transfer primitive.

begin;

do $requirements$
begin
  if to_regclass('public.hotel_join_codes') is null
     or to_regclass('public.properties') is null
     or to_regclass('public.accounts') is null
     or to_regprocedure('public._staxis_assert_active_platform_admin(uuid)') is null
     or to_regprocedure('public._staxis_nonlegacy_property_authorizations(uuid)') is null
     or to_regprocedure('public._staxis_manage_team_context(uuid,uuid)') is null
  then
    raise exception '0396 requires join codes 0064/0152 and authoritative access 0376/0382/0391';
  end if;
end
$requirements$;

alter table public.hotel_join_codes
  add column if not exists code_kind text;

-- Direct table writers before 0396 carried no tenant/relationship provenance.
-- Retire every still-live legacy credential during the first rollout; managers
-- can mint a new one through the guarded RPC. Even the historical role-null
-- 1/1 shape is revoked: storage cannot prove it was a resume link rather than
-- an exhausted one-shot staff link, so promoting it would create authority.
with revoked as (
  update public.hotel_join_codes code_row
     set revoked_at = clock_timestamp()
   where code_row.code_kind is null
     and code_row.revoked_at is null
  returning code_row.id, code_row.hotel_id
)
insert into public.admin_audit_log (
  actor_user_id, actor_email, action, target_type, target_id, metadata
)
select null, null, 'join_code.migration_revoke', 'join_code', revoked.id::text,
       jsonb_build_object(
         'hotel_id', revoked.hotel_id,
         'reason', 'unbound_pre_0396_credential'
       )
from revoked;

-- 0152 already revoked every historical privileged row. Keep those rows for
-- audit, but make them structurally incapable of becoming live again.
update public.hotel_join_codes
   set code_kind = case
     when role in ('owner', 'general_manager') then 'legacy_revoked'
     else 'staff_signup'
   end
 where code_kind is null;

alter table public.hotel_join_codes
  alter column code_kind set default 'staff_signup',
  alter column code_kind set not null;

alter table public.hotel_join_codes
  drop constraint if exists hotel_join_codes_role_check_no_privileged;
alter table public.hotel_join_codes
  drop constraint if exists hotel_join_codes_kind_shape_check;

-- This is intentionally not a broad role allow-list. A live privileged row
-- has a distinct kind, is bounded to one use and seven days, and is also
-- subject to the lifecycle trigger below. Historical privileged rows remain
-- allowed only while revoked.
alter table public.hotel_join_codes
  add constraint hotel_join_codes_kind_shape_check check (
    (
      code_kind = 'staff_signup'
      and (role is null or role in ('front_desk', 'housekeeping', 'maintenance'))
    )
    or (
      code_kind = 'onboarding_resume'
      and role is null
      and max_uses = 1
      and used_count = 1
      and expires_at > created_at
      and expires_at <= created_at + interval '7 days'
    )
    or (
      code_kind = 'privileged_onboarding'
      and role in ('owner', 'general_manager')
      and max_uses = 1
      and used_count between 0 and 1
      and expires_at > created_at
      and expires_at <= created_at + interval '7 days'
    )
    or (
      code_kind = 'legacy_revoked'
      and role in ('owner', 'general_manager')
      and revoked_at is not null
    )
  );

-- Even a consumed code occupies the hotel's privileged slot until explicitly
-- revoked. This prevents a second code from being minted in the small saga
-- window between slot claim and account/onboarding-state persistence.
create unique index if not exists hotel_join_codes_one_privileged_onboarding_idx
  on public.hotel_join_codes (hotel_id)
  where code_kind = 'privileged_onboarding' and revoked_at is null;

create or replace function public._staxis_guard_privileged_onboarding_join_code()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_context text := coalesce(
    current_setting('staxis.privileged_join_code_write', true), ''
  );
  v_property_owner_id uuid;
  v_onboarding_completed_at timestamptz;
  v_onboarding_state jsonb;
  v_creator_auth_user_id uuid;
  v_creator_role text;
  v_creator_active boolean;
  v_structural_change boolean := false;
begin
  if new.role is null or new.role not in ('owner', 'general_manager') then
    return new;
  end if;

  if new.code_kind = 'legacy_revoked' then
    if new.revoked_at is null then
      raise exception 'legacy privileged join codes cannot be reactivated'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.code_kind <> 'privileged_onboarding' then
    raise exception 'privileged join code kind is invalid'
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if v_context <> 'mint' then
      raise exception 'privileged onboarding codes must be minted by the guarded RPC'
        using errcode = '42501';
    end if;
  else
    v_structural_change :=
      new.id is distinct from old.id
      or new.hotel_id is distinct from old.hotel_id
      or new.code is distinct from old.code
      or new.role is distinct from old.role
      or new.code_kind is distinct from old.code_kind
      or new.expires_at is distinct from old.expires_at
      or new.max_uses is distinct from old.max_uses
      or new.created_by is distinct from old.created_by
      or new.created_at is distinct from old.created_at
      or (old.revoked_at is not null and new.revoked_at is null);

    if v_structural_change and v_context <> 'mint' then
      raise exception 'privileged onboarding code structure is immutable outside mint'
        using errcode = '42501';
    end if;
    if new.used_count is distinct from old.used_count and not (
      (v_context = 'claim' and old.used_count = 0 and new.used_count = 1)
      or (v_context = 'release' and old.used_count = 1 and new.used_count = 0)
    ) then
      raise exception 'privileged onboarding code usage must use claim/release RPCs'
        using errcode = '42501';
    end if;
  end if;

  -- Revocation is always safe and remains available to existing operational
  -- tooling. Every live/unrevoked mutation below must re-prove hotel state.
  if new.revoked_at is not null then
    return new;
  end if;

  select property.owner_id,
         property.onboarding_completed_at,
         coalesce(property.onboarding_state, '{}'::jsonb)
    into v_property_owner_id,
         v_onboarding_completed_at,
         v_onboarding_state
  from public.properties property
  where property.id = new.hotel_id
  for update of property;

  if not found then
    raise exception 'privileged onboarding hotel does not exist'
      using errcode = '55000';
  end if;

  select creator.data_user_id, creator.role, creator.active
    into v_creator_auth_user_id, v_creator_role, v_creator_active
  from public.accounts creator
  where creator.id = new.created_by
  for update;

  if not found
     or v_creator_role is distinct from 'admin'
     or v_creator_active is distinct from true
     or v_creator_auth_user_id is null
     or v_property_owner_id is distinct from v_creator_auth_user_id
  then
    raise exception 'privileged onboarding code requires the active platform-admin placeholder owner'
      using errcode = '55000';
  end if;

  if v_onboarding_completed_at is not null
     or nullif(v_onboarding_state->>'accountCreatedAt', '') is not null
  then
    raise exception 'hotel onboarding has already been claimed or completed'
      using errcode = '55000';
  end if;

  -- accountCreatedAt is the primary lifecycle marker. These two checks are a
  -- fail-closed repair for older/non-atomic paths where that marker failed to
  -- persist after a privileged account was already created.
  if exists (
    select 1
    from public.accounts account
    where account.role in ('owner', 'general_manager')
      and new.hotel_id = any(coalesce(account.property_access, '{}'::uuid[]))
  ) or exists (
    select 1
    from public.accounts account
    join public.account_authorization_state state
      on state.account_id = account.id
     and state.authority_mode = 'normalized'
    cross join lateral public._staxis_nonlegacy_property_authorizations(account.id) authority
    where authority.property_id = new.hotel_id
      and (
        (
          authority.entitlement_kind = 'membership_hat'
          and authority.scope_type = 'property'
          and authority.staxis_role = 'general_manager'
        )
        or (
          authority.entitlement_kind = 'access_grant'
          and authority.access_profile = 'property_manager'
        )
      )
  ) then
    raise exception 'hotel already has a privileged property operator'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

revoke all on function public._staxis_guard_privileged_onboarding_join_code()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_hotel_join_codes_20_privileged_onboarding_guard
  on public.hotel_join_codes;
create trigger trg_hotel_join_codes_20_privileged_onboarding_guard
  before insert or update on public.hotel_join_codes
  for each row execute function public._staxis_guard_privileged_onboarding_join_code();

-- Ordinary staff-signup links are private hotel-operational credentials. A
-- company title may provide aggregate People/invitation access, but it must
-- never reveal or mutate this bearer link. Every ordinary-code RPC below runs
-- this lock-and-assert helper immediately before reading or writing the code.
-- The helper deliberately reuses 0391's `_staxis_manage_team_context`, whose
-- contract requires an exact authoritative hotel standing with
-- hotelMutationAllowed=true, an owner/GM floor (or a live platform admin), and
-- the current manage_team capability override.
create or replace function public._staxis_staff_join_code_authority_context(
  p_actor_account_id uuid,
  p_actor_auth_user_id uuid,
  p_property_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_context jsonb;
  v_actor_email text;
begin
  if p_actor_account_id is null
     or p_actor_auth_user_id is null
     or p_property_id is null
  then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  -- One transaction-level hotel mutex serializes the new read/create/revoke
  -- path across every serverless instance. The application RPC readers must be
  -- deployed first; after old instances drain, this migration revokes direct
  -- service table access. Missing RPCs are a retryable fail-closed condition.
  perform 1
  from public.properties property
  where property.id = p_property_id
  for share;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'denied');
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(p_property_id::text, 0)
  );

  -- Freeze every relation that can change the authoritative standing or its
  -- capability while `_staxis_manage_team_context` evaluates it. NOWAIT makes
  -- a racing revoke/transfer an explicit retryable refusal, not stale access.
  begin
    lock table public.capability_overrides,
               public.organizations,
               public.organization_property_relationships,
               public.organization_memberships,
               public.organization_access_grants,
               public.portfolios,
               public.portfolio_properties,
               public.account_property_authorization_bridges
      in share mode nowait;
  exception when lock_not_available then
    raise exception 'staff join-code authority changed concurrently'
      using errcode = '55P03';
  end;

  perform 1
  from public.accounts actor
  where actor.id = p_actor_account_id
  for share nowait;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'denied');
  end if;
  perform 1
  from public.account_authorization_state state
  where state.account_id = p_actor_account_id
  for share nowait;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'denied');
  end if;

  select lower(auth_user.email)
    into v_actor_email
  from public.accounts actor
  left join auth.users auth_user on auth_user.id = actor.data_user_id
  where actor.id = p_actor_account_id
    and actor.data_user_id = p_actor_auth_user_id
    and actor.active is true;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'denied');
  end if;

  v_context := public._staxis_manage_team_context(
    p_actor_account_id, p_property_id
  );
  if coalesce((v_context->>'allowed')::boolean, false) is not true then
    return jsonb_build_object('ok', false, 'reason', 'denied');
  end if;

  return jsonb_build_object(
    'ok', true,
    'role', v_context->>'role',
    'authorityMode', v_context->>'authorityMode',
    'actorEmail', v_actor_email
  );
end;
$$;

revoke all on function public._staxis_staff_join_code_authority_context(
  uuid,uuid,uuid
) from public, anon, authenticated, service_role;

-- Read the one deterministic ordinary bearer credential only while the exact
-- caller's current authority and the selected hotel's code rows are locked in
-- this transaction. Malformed/weak historical rows are never projected.
create or replace function public.staxis_read_staff_join_code_guarded(
  p_actor_account_id uuid,
  p_actor_auth_user_id uuid,
  p_hotel_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_context jsonb;
  v_code public.hotel_join_codes%rowtype;
begin
  v_context := public._staxis_staff_join_code_authority_context(
    p_actor_account_id, p_actor_auth_user_id, p_hotel_id
  );
  if coalesce((v_context->>'ok')::boolean, false) is not true then
    return v_context;
  end if;

  select code_row.* into v_code
  from public.hotel_join_codes code_row
  where code_row.hotel_id = p_hotel_id
    and code_row.code_kind = 'staff_signup'
    and code_row.role is null
    and code_row.revoked_at is null
    and code_row.expires_at > clock_timestamp()
    and code_row.max_uses between 1 and 100
    and code_row.used_count between 0 and code_row.max_uses - 1
    and code_row.code ~ '^[A-Z]{4}-[A-Z2-9]{10}$'
  order by code_row.created_at, code_row.id
  limit 1
  for share;
  if not found then
    return jsonb_build_object(
      'ok', true, 'status', 'empty', 'hotelId', p_hotel_id
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'status', 'found',
    'hotelId', v_code.hotel_id,
    'codeId', v_code.id,
    'code', v_code.code,
    'role', v_code.role,
    'expiresAt', v_code.expires_at,
    'maxUses', v_code.max_uses,
    'usedCount', v_code.used_count,
    'createdAt', v_code.created_at
  );
end;
$$;

revoke all on function public.staxis_read_staff_join_code_guarded(
  uuid,uuid,uuid
) from public, anon, authenticated;
grant execute on function public.staxis_read_staff_join_code_guarded(
  uuid,uuid,uuid
) to service_role;

-- Atomic ordinary-code get-or-create. TTL and capacity belong to the
-- database, not request JSON. The oldest valid code wins; any other usable
-- ordinary rows are revoked and audited in this same transaction.
create or replace function public.staxis_get_or_create_staff_join_code_guarded(
  p_actor_account_id uuid,
  p_actor_auth_user_id uuid,
  p_hotel_id uuid,
  p_code text,
  p_request_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_context jsonb;
  v_code_text text := upper(btrim(coalesce(p_code, '')));
  v_canonical public.hotel_join_codes%rowtype;
  v_revoked_ids uuid[] := '{}'::uuid[];
  v_created boolean := false;
begin
  if v_code_text !~ '^[A-Z]{4}-[A-Z2-9]{10}$'
     or char_length(coalesce(p_request_id, '')) > 200
  then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  v_context := public._staxis_staff_join_code_authority_context(
    p_actor_account_id, p_actor_auth_user_id, p_hotel_id
  );
  if coalesce((v_context->>'ok')::boolean, false) is not true then
    return v_context;
  end if;

  -- Lock every current ordinary row after the hotel advisory lock. New-route
  -- callers therefore converge across processes; the deterministic cleanup
  -- also repairs duplicates left by an older rolling-deploy writer.
  perform 1
  from public.hotel_join_codes code_row
  where code_row.hotel_id = p_hotel_id
    and code_row.code_kind = 'staff_signup'
  for update;

  select code_row.* into v_canonical
  from public.hotel_join_codes code_row
  where code_row.hotel_id = p_hotel_id
    and code_row.code_kind = 'staff_signup'
    and code_row.role is null
    and code_row.revoked_at is null
    and code_row.expires_at > v_now
    and code_row.max_uses between 1 and 100
    and code_row.used_count between 0 and code_row.max_uses - 1
    and code_row.code ~ '^[A-Z]{4}-[A-Z2-9]{10}$'
  order by code_row.created_at, code_row.id
  limit 1;

  if not found then
    begin
      insert into public.hotel_join_codes (
        hotel_id, code, role, code_kind, expires_at,
        max_uses, used_count, created_by, created_at
      ) values (
        p_hotel_id, v_code_text, null, 'staff_signup',
        v_now + interval '7 days', 100, 0, p_actor_account_id, v_now
      ) returning * into v_canonical;
      v_created := true;
    exception when unique_violation then
      return jsonb_build_object('ok', false, 'reason', 'code_collision');
    end;
  end if;

  with revoked as (
    update public.hotel_join_codes code_row
       set revoked_at = v_now
     where code_row.hotel_id = p_hotel_id
       and code_row.code_kind = 'staff_signup'
       and code_row.id <> v_canonical.id
       and code_row.revoked_at is null
       and code_row.expires_at > v_now
       and code_row.used_count < code_row.max_uses
    returning code_row.id
  )
  select coalesce(array_agg(id order by id), '{}'::uuid[])
    into v_revoked_ids
  from revoked;

  if cardinality(v_revoked_ids) > 0 then
    insert into public.admin_audit_log (
      actor_user_id, actor_email, action, target_type, target_id, metadata
    ) values (
      p_actor_auth_user_id,
      nullif(v_context->>'actorEmail', ''),
      'join_code.staff_signup_reconcile',
      'join_code',
      v_canonical.id::text,
      jsonb_build_object(
        'hotel_id', p_hotel_id,
        'canonical_id', v_canonical.id,
        'revoked_ids', to_jsonb(v_revoked_ids),
        'request_id', nullif(btrim(p_request_id), '')
      )
    );
  end if;

  if v_created then
    insert into public.admin_audit_log (
      actor_user_id, actor_email, action, target_type, target_id, metadata
    ) values (
      p_actor_auth_user_id,
      nullif(v_context->>'actorEmail', ''),
      'join_code.create',
      'join_code',
      v_canonical.id::text,
      jsonb_build_object(
        'hotel_id', p_hotel_id,
        'max_uses', v_canonical.max_uses,
        'expires_at', v_canonical.expires_at,
        'request_id', nullif(btrim(p_request_id), '')
      )
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'status', case when v_created then 'created' else 'existing' end,
    'created', v_created,
    'hotelId', v_canonical.hotel_id,
    'codeId', v_canonical.id,
    'code', v_canonical.code,
    'role', v_canonical.role,
    'expiresAt', v_canonical.expires_at,
    'maxUses', v_canonical.max_uses,
    'usedCount', v_canonical.used_count,
    'createdAt', v_canonical.created_at
  );
end;
$$;

revoke all on function public.staxis_get_or_create_staff_join_code_guarded(
  uuid,uuid,uuid,text,text
) from public, anon, authenticated;
grant execute on function public.staxis_get_or_create_staff_join_code_guarded(
  uuid,uuid,uuid,text,text
) to service_role;

-- Revoke by opaque id without disclosing whether another tenant owns it. The
-- first lookup discovers only a tentative hotel; the row is selected again
-- under that hotel's advisory/authority locks before the mutation commits.
create or replace function public.staxis_revoke_staff_join_code_guarded(
  p_actor_account_id uuid,
  p_actor_auth_user_id uuid,
  p_code_id uuid,
  p_request_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_hotel_id uuid;
  v_context jsonb;
  v_code public.hotel_join_codes%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_actor_account_id is null
     or p_actor_auth_user_id is null
     or p_code_id is null
     or char_length(coalesce(p_request_id, '')) > 200
  then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  select code_row.hotel_id into v_hotel_id
  from public.hotel_join_codes code_row
  where code_row.id = p_code_id
    and code_row.code_kind = 'staff_signup';
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  v_context := public._staxis_staff_join_code_authority_context(
    p_actor_account_id, p_actor_auth_user_id, v_hotel_id
  );
  if coalesce((v_context->>'ok')::boolean, false) is not true then
    return v_context;
  end if;

  select code_row.* into v_code
  from public.hotel_join_codes code_row
  where code_row.id = p_code_id
    and code_row.hotel_id = v_hotel_id
    and code_row.code_kind = 'staff_signup'
  for update;
  if not found or v_code.revoked_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  update public.hotel_join_codes code_row
     set revoked_at = v_now
   where code_row.id = v_code.id
     and code_row.revoked_at is null;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, metadata
  ) values (
    p_actor_auth_user_id,
    nullif(v_context->>'actorEmail', ''),
    'join_code.revoke',
    'join_code',
    v_code.id::text,
    jsonb_build_object(
      'hotel_id', v_code.hotel_id,
      'request_id', nullif(btrim(p_request_id), '')
    )
  );

  return jsonb_build_object(
    'ok', true,
    'status', 'revoked',
    'codeId', v_code.id,
    'hotelId', v_code.hotel_id
  );
end;
$$;

revoke all on function public.staxis_revoke_staff_join_code_guarded(
  uuid,uuid,uuid,text
) from public, anon, authenticated;
grant execute on function public.staxis_revoke_staff_join_code_guarded(
  uuid,uuid,uuid,text
) to service_role;

comment on function public.staxis_read_staff_join_code_guarded(uuid,uuid,uuid) is
  'Service-only atomic read of one ordinary staff bearer code after fresh exact-hotel manage_team authorization.';
comment on function public.staxis_get_or_create_staff_join_code_guarded(uuid,uuid,uuid,text,text) is
  'Service-only ordinary staff-code get/create with exact live hotel authority, deterministic reconciliation, and atomic audit.';
comment on function public.staxis_revoke_staff_join_code_guarded(uuid,uuid,uuid,text) is
  'Service-only ordinary staff-code revoke with anti-enumerating live authority and atomic audit.';

-- Public onboarding routes possess the bearer but must not possess direct table
-- access. Resolve one exact, bounded token to a closed capability receipt. The
-- token is intentionally never echoed: callers already hold it, and repeating
-- it in a DTO makes accidental logging much easier.
create or replace function public.staxis_resolve_join_code_capability(
  p_code text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_normalized text := upper(btrim(coalesce(p_code, '')));
  v_code public.hotel_join_codes%rowtype;
  v_status text;
begin
  -- Current codes are PREFIX-XXXXXXXXXX. The wider bounded legacy grammar is
  -- deliberate: historical six-letter/baked-role codes remain redeemable, but
  -- whitespace, Unicode, control bytes and fuzzy matching are all refused.
  if octet_length(v_normalized) not between 6 and 128
     or v_normalized !~ '^[A-Z0-9][A-Z0-9-]{4,126}[A-Z0-9]$'
  then
    return jsonb_build_object('ok', false, 'status', 'not_found');
  end if;
  select code_row.* into v_code
  from public.hotel_join_codes code_row
  where code_row.code = v_normalized;
  if not found
     or v_code.code_kind not in (
       'staff_signup', 'onboarding_resume', 'privileged_onboarding', 'legacy_revoked'
     )
     or (v_code.role is not null and v_code.role not in (
       'owner', 'general_manager', 'front_desk', 'housekeeping', 'maintenance'
     ))
     or v_code.max_uses < 1
     or v_code.used_count < 0
  then
    return jsonb_build_object('ok', false, 'status', 'not_found');
  end if;
  if (
    select count(*)
    from public._staxis_current_primary_property_relationships() relationship
    where relationship.property_id = v_code.hotel_id
      and relationship.active_primary_count = 1
      and relationship.starts_at <= v_code.created_at
  ) <> 1 then
    return jsonb_build_object('ok', false, 'status', 'not_found');
  end if;

  v_status := case
    when v_code.revoked_at is not null then 'revoked'
    when v_code.expires_at <= statement_timestamp() then 'expired'
    when v_code.used_count >= v_code.max_uses then 'used_up'
    else 'active'
  end;

  return jsonb_build_object(
    'ok', true,
    'schemaVersion', 'join-code-capability-v1',
    'status', v_status,
    'codeId', v_code.id,
    'hotelId', v_code.hotel_id,
    'codeKind', v_code.code_kind,
    'role', v_code.role,
    'expiresAt', v_code.expires_at,
    'maxUses', v_code.max_uses,
    'usedCount', v_code.used_count
  );
end;
$$;

revoke all on function public.staxis_resolve_join_code_capability(text)
  from public, anon, authenticated;
grant execute on function public.staxis_resolve_join_code_capability(text)
  to service_role;

comment on function public.staxis_resolve_join_code_capability(text) is
  'Service-only exact bearer lookup for redemption/onboarding. Returns a closed capability receipt and never echoes the bearer.';

-- Authenticated owners/GMs sometimes need a non-redeemable link to resume an
-- unfinished wizard. Resolve or mint it behind the same fresh exact-hotel
-- authority boundary as ordinary staff-code management. A company title alone
-- cannot read this credential. The fallback row is born fully consumed, so it
-- can resume the wizard but can never create a second account.
create or replace function public.staxis_resolve_or_mint_resume_join_code_guarded(
  p_actor_account_id uuid,
  p_actor_auth_user_id uuid,
  p_hotel_id uuid,
  p_code text,
  p_request_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_context jsonb;
  v_code_text text := upper(btrim(coalesce(p_code, '')));
  v_resume public.hotel_join_codes%rowtype;
  v_created boolean := false;
begin
  if v_code_text !~ '^[A-Z]{4}-[A-Z2-9]{10}$'
     or char_length(coalesce(p_request_id, '')) > 200
  then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  v_context := public._staxis_staff_join_code_authority_context(
    p_actor_account_id, p_actor_auth_user_id, p_hotel_id
  );
  if coalesce((v_context->>'ok')::boolean, false) is not true then
    return v_context;
  end if;

  perform 1
  from public.hotel_join_codes code_row
  where code_row.hotel_id = p_hotel_id
  for update;

  select code_row.* into v_resume
  from public.hotel_join_codes code_row
  where code_row.hotel_id = p_hotel_id
    and code_row.code_kind in ('onboarding_resume', 'privileged_onboarding')
    and code_row.revoked_at is null
    and code_row.expires_at > v_now
    and code_row.max_uses >= 1
    and code_row.used_count >= 0
    and code_row.code ~ '^[A-Z0-9][A-Z0-9-]{4,126}[A-Z0-9]$'
    and exists (
      select 1
      from public._staxis_current_primary_property_relationships() relationship
      where relationship.property_id = code_row.hotel_id
        and relationship.active_primary_count = 1
        and relationship.starts_at <= code_row.created_at
    )
  order by code_row.created_at desc, code_row.id desc
  limit 1;

  if not found then
    begin
      insert into public.hotel_join_codes (
        hotel_id, code, role, code_kind, expires_at,
        max_uses, used_count, created_by, created_at
      ) values (
        p_hotel_id, v_code_text, null, 'onboarding_resume',
        v_now + interval '7 days', 1, 1, p_actor_account_id, v_now
      ) returning * into v_resume;
      v_created := true;
    exception when unique_violation then
      return jsonb_build_object('ok', false, 'reason', 'code_collision');
    end;

    insert into public.admin_audit_log (
      actor_user_id, actor_email, action, target_type, target_id, metadata
    ) values (
      p_actor_auth_user_id,
      nullif(v_context->>'actorEmail', ''),
      'join_code.resume_create',
      'join_code',
      v_resume.id::text,
      jsonb_build_object(
        'hotel_id', p_hotel_id,
        'max_uses', 1,
        'used_count', 1,
        'expires_at', v_resume.expires_at,
        'request_id', nullif(btrim(p_request_id), '')
      )
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'schemaVersion', 'join-code-resume-v1',
    'status', case when v_created then 'created' else 'existing' end,
    'created', v_created,
    'codeId', v_resume.id,
    'hotelId', v_resume.hotel_id,
    'code', v_resume.code,
    'expiresAt', v_resume.expires_at
  );
end;
$$;

revoke all on function public.staxis_resolve_or_mint_resume_join_code_guarded(
  uuid,uuid,uuid,text,text
) from public, anon, authenticated;
grant execute on function public.staxis_resolve_or_mint_resume_join_code_guarded(
  uuid,uuid,uuid,text,text
) to service_role;

comment on function public.staxis_resolve_or_mint_resume_join_code_guarded(uuid,uuid,uuid,text,text) is
  'Service-only exact-hotel manager resume-code resolve/mint. Rechecks actor identity and live hotel mutation/team authority; fallback is pre-consumed.';

-- The wizard has two deliberately unauthenticated mutations before a reliable
-- session exists. Commit those transitions here so bearer revocation/expiry or
-- a hotel transfer cannot land between a route-level check and a service-role
-- properties UPDATE.
create or replace function public.staxis_apply_onboarding_join_code_transition(
  p_code_id uuid,
  p_hotel_id uuid,
  p_transition text,
  p_request_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_code public.hotel_join_codes%rowtype;
  v_state jsonb;
  v_next_state jsonb;
  v_current_step integer;
  v_changed boolean := false;
begin
  if p_code_id is null
     or p_hotel_id is null
     or p_transition not in ('welcome', 'account_created')
     or char_length(coalesce(p_request_id, '')) > 200
  then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  -- Match the relationship-transfer and staff-code RPC lock order.
  select coalesce(property.onboarding_state, jsonb_build_object('step', 1))
    into v_state
  from public.properties property
  where property.id = p_hotel_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_hotel_id::text, 0));

  select code_row.* into v_code
  from public.hotel_join_codes code_row
  where code_row.id = p_code_id
    and code_row.hotel_id = p_hotel_id
  for update;
  if not found
     or v_code.revoked_at is not null
     or v_code.expires_at <= v_now
     or v_code.code_kind not in ('privileged_onboarding', 'onboarding_resume')
     or (
       select count(*)
       from public._staxis_current_primary_property_relationships() relationship
       where relationship.property_id = v_code.hotel_id
         and relationship.active_primary_count = 1
         and relationship.starts_at <= v_code.created_at
     ) <> 1
  then
    return jsonb_build_object('ok', false, 'reason', 'denied');
  end if;

  if p_transition = 'account_created' and not (
    v_code.code_kind = 'privileged_onboarding'
    and v_code.role in ('owner', 'general_manager')
    and v_code.used_count >= v_code.max_uses
  ) then
    return jsonb_build_object('ok', false, 'reason', 'denied');
  end if;

  v_next_state := v_state;
  if p_transition = 'welcome' then
    if nullif(v_state->>'accountCreatedAt', '') is null
       and coalesce((v_state->>'step')::integer, 1) <= 2
    then
      v_next_state := jsonb_set(v_state, '{step}', '2'::jsonb, true);
      v_changed := v_next_state is distinct from v_state;
    end if;
  elsif nullif(v_state->>'accountCreatedAt', '') is null then
    v_next_state := jsonb_set(
      v_state,
      '{accountCreatedAt}',
      to_jsonb(v_now),
      true
    );
    v_changed := true;
  end if;

  v_current_step := case
    when nullif(v_next_state->>'accountCreatedAt', '') is null
      then case when v_next_state->>'step' = '2' then 2 else 1 end
    when nullif(v_next_state->>'emailVerifiedAt', '') is null then 3
    when nullif(v_next_state->>'hotelDetailsAt', '') is null then 4
    when nullif(v_next_state->>'pmsCredentialsAt', '') is null
      and nullif(v_next_state->>'pmsSkippedAt', '') is null then 5
    when nullif(v_next_state->>'mappingCompletedAt', '') is null
      and nullif(v_next_state->>'pmsSkippedAt', '') is null then 6
    when nullif(v_next_state->>'staffAt', '') is null then 7
    when nullif(v_next_state->>'hotelContextAt', '') is null then 8
    else 9
  end;
  v_next_state := jsonb_set(v_next_state, '{step}', to_jsonb(v_current_step), true);

  if v_changed or v_next_state is distinct from v_state then
    update public.properties property
       set onboarding_state = v_next_state
     where property.id = p_hotel_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'schemaVersion', 'onboarding-code-transition-v1',
    'status', case when v_changed then 'applied' else 'noop' end,
    'hotelId', p_hotel_id,
    'transition', p_transition,
    'currentStep', v_current_step
  );
exception when invalid_text_representation or numeric_value_out_of_range then
  return jsonb_build_object('ok', false, 'reason', 'invalid_state');
end;
$$;

revoke all on function public.staxis_apply_onboarding_join_code_transition(
  uuid,uuid,text,text
) from public, anon, authenticated;
grant execute on function public.staxis_apply_onboarding_join_code_transition(
  uuid,uuid,text,text
) to service_role;

comment on function public.staxis_apply_onboarding_join_code_transition(uuid,uuid,text,text) is
  'Service-only atomic welcome/account-created onboarding mutation with final bearer, expiry and hotel-transfer serialization.';

-- Platform-admin-only, serialized mint. The caller supplies no TTL or usage
-- count; those security properties are owned by the database. A retry returns
-- the already-minted code for the same hotel/role instead of creating a second
-- bearer credential.
create or replace function public.staxis_mint_privileged_onboarding_join_code(
  p_actor_account_id uuid,
  p_actor_auth_user_id uuid,
  p_hotel_id uuid,
  p_code text,
  p_role text,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := now();
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_existing public.hotel_join_codes%rowtype;
  v_inserted public.hotel_join_codes%rowtype;
begin
  if p_actor_account_id is null or p_actor_auth_user_id is null
     or p_hotel_id is null
     or p_role not in ('owner', 'general_manager')
     or v_code !~ '^[A-Z]{4}-[A-Z2-9]{10}$'
  then
    return jsonb_build_object('ok', false, 'status', 'invalid');
  end if;

  perform public._staxis_assert_active_platform_admin(p_actor_account_id);
  perform 1
    from public.accounts actor
    where actor.id = p_actor_account_id
      and actor.data_user_id = p_actor_auth_user_id
      and actor.active is true
      and actor.role = 'admin'
    for update;
  if not found then
    raise exception 'platform-admin identity changed'
      using errcode = '42501';
  end if;

  perform 1 from public.properties property
   where property.id = p_hotel_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'status', 'property_not_found');
  end if;

  select * into v_existing
  from public.hotel_join_codes code_row
  where code_row.hotel_id = p_hotel_id
    and code_row.code_kind = 'privileged_onboarding'
    and code_row.revoked_at is null
  for update;

  if found then
    if v_existing.used_count > 0 then
      return jsonb_build_object('ok', false, 'status', 'already_claimed');
    end if;
    if v_existing.expires_at > v_now then
      if v_existing.role <> p_role then
        return jsonb_build_object('ok', false, 'status', 'role_conflict');
      end if;
      return jsonb_build_object(
        'ok', true,
        'status', 'existing',
        'created', false,
        'codeId', v_existing.id,
        'code', v_existing.code,
        'expiresAt', v_existing.expires_at,
        'role', v_existing.role
      );
    end if;
    update public.hotel_join_codes
       set revoked_at = v_now
     where id = v_existing.id;
  end if;

  perform set_config('staxis.privileged_join_code_write', 'mint', true);
  begin
    insert into public.hotel_join_codes (
      hotel_id, code, role, code_kind, expires_at,
      max_uses, used_count, created_by, created_at
    ) values (
      p_hotel_id, v_code, p_role, 'privileged_onboarding',
      v_now + interval '7 days', 1, 0, p_actor_account_id, v_now
    ) returning * into v_inserted;
  exception
    when unique_violation then
      return jsonb_build_object('ok', false, 'status', 'code_collision');
    when sqlstate '55000' then
      return jsonb_build_object('ok', false, 'status', 'hotel_not_unclaimed');
  end;

  insert into public.admin_audit_log (
    actor_user_id, action, target_type, target_id, metadata
  ) values (
    p_actor_auth_user_id,
    'join_code.privileged_onboarding_mint',
    'join_code',
    v_inserted.id::text,
    jsonb_build_object(
      'hotel_id', p_hotel_id,
      'role', p_role,
      'max_uses', 1,
      'expires_at', v_inserted.expires_at,
      'request_id', nullif(btrim(p_request_id), '')
    )
  );

  return jsonb_build_object(
    'ok', true,
    'status', 'created',
    'created', true,
    'codeId', v_inserted.id,
    'code', v_inserted.code,
    'expiresAt', v_inserted.expires_at,
    'role', v_inserted.role
  );
end;
$$;

revoke all on function public.staxis_mint_privileged_onboarding_join_code(
  uuid,uuid,uuid,text,text,text
) from public, anon, authenticated;
grant execute on function public.staxis_mint_privileged_onboarding_join_code(
  uuid,uuid,uuid,text,text,text
) to service_role;

-- Auth user creation lives in GoTrue, outside the database transaction. Every
-- relational effect of redeeming its bearer must nevertheless commit as one
-- unit. This finalizer is the only supported signup write boundary: it takes
-- the same hotel mutex as relationship transfer, rechecks the exact code and
-- current governing relationship, consumes one use, creates the account (and
-- pending staff request where applicable), updates privileged onboarding, and
-- writes the bearer-free audit before returning.
--
-- A durable audit/account pair also makes the RPC idempotent for the narrow
-- case where Postgres committed but the HTTP response was lost. The raw bearer
-- is revalidated against that exact row under lock, but is never returned,
-- audited, or stored anywhere new.
create or replace function public.staxis_finalize_join_code_signup(
  p_code_id uuid,
  p_code text,
  p_hotel_id uuid,
  p_expected_used_count integer,
  p_auth_user_id uuid,
  p_username text,
  p_display_name text,
  p_requested_role text,
  p_phone text,
  p_language text,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz;
  v_code public.hotel_join_codes%rowtype;
  v_onboarding_state jsonb;
  v_next_state jsonb;
  v_current_step integer;
  v_final_role text;
  v_pending_approval boolean;
  v_account_id uuid;
  v_existing_username text;
  v_actor_email text;
  v_code_text text := upper(btrim(coalesce(p_code, '')));
  v_username text := lower(btrim(coalesce(p_username, '')));
  v_display_name text := btrim(coalesce(p_display_name, ''));
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
begin
  if p_code_id is null
     or p_hotel_id is null
     or p_auth_user_id is null
     or octet_length(v_code_text) not between 6 and 128
     or v_code_text !~ '^[A-Z0-9][A-Z0-9-]{4,126}[A-Z0-9]$'
     or p_expected_used_count is null
     or p_expected_used_count < 0
     or char_length(v_username) not between 1 and 40
     or octet_length(v_username) > 160
     or v_username !~ '^[a-z0-9._+-]+$'
     or char_length(v_display_name) not between 1 and 200
     or octet_length(v_display_name) > 800
     or char_length(coalesce(v_phone, '')) > 64
     or p_requested_role not in (
       'owner', 'general_manager', 'front_desk', 'housekeeping', 'maintenance'
     )
     or p_language not in ('en', 'es')
     or char_length(coalesce(p_request_id, '')) > 200
  then
    return jsonb_build_object('ok', false, 'status', 'invalid');
  end if;

  -- Transfer and join-code writers all acquire property -> advisory -> code.
  -- A transfer that wins first revokes the code; a finalization that wins
  -- first commits its complete account before the transfer can revoke reach.
  select coalesce(property.onboarding_state, jsonb_build_object('step', 1))
    into v_onboarding_state
  from public.properties property
  where property.id = p_hotel_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'status', 'not_found');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_hotel_id::text, 0));
  v_now := clock_timestamp();

  select code_row.* into v_code
  from public.hotel_join_codes code_row
  where code_row.id = p_code_id
    and code_row.hotel_id = p_hotel_id
    and code_row.code = v_code_text
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'status', 'not_found');
  end if;

  if v_code.code_kind = 'privileged_onboarding'
     and v_code.role in ('owner', 'general_manager')
     and p_requested_role = v_code.role
  then
    v_final_role := v_code.role;
    v_pending_approval := false;
  elsif v_code.code_kind = 'staff_signup'
        and v_code.role is null
        and p_requested_role in ('front_desk', 'housekeeping', 'maintenance')
  then
    v_final_role := p_requested_role;
    v_pending_approval := true;
  elsif v_code.code_kind = 'staff_signup'
        and v_code.role in ('front_desk', 'housekeeping', 'maintenance')
        and p_requested_role = v_code.role
  then
    v_final_role := v_code.role;
    v_pending_approval := false;
  else
    return jsonb_build_object('ok', false, 'status', 'denied');
  end if;

  -- A retry after a committed-but-unacknowledged RPC recovers the exact
  -- result. The audit row and account must agree on every authority-bearing
  -- field; an unrelated account for the Auth identity is never adopted.
  select account.id, account.username
    into v_account_id, v_existing_username
  from public.admin_audit_log audit
  join public.accounts account
    on account.id::text = audit.metadata->>'account_id'
   and account.data_user_id = p_auth_user_id
  where audit.action = 'join_code.use'
    and audit.target_type = 'join_code'
    and audit.target_id = v_code.id::text
    and audit.actor_user_id = p_auth_user_id
    and audit.metadata->>'hotel_id' = p_hotel_id::text
    and audit.metadata->>'role' = v_final_role
    and audit.metadata->>'pending_approval' = v_pending_approval::text
    and audit.metadata->>'expected_used_count' = p_expected_used_count::text
    and v_code.used_count >= p_expected_used_count + 1
  order by audit.ts desc, audit.id desc
  limit 1;
  if found then
    return jsonb_build_object(
      'ok', true,
      'schemaVersion', 'join-code-signup-finalization-v1',
      'status', 'existing',
      'codeId', v_code.id,
      'hotelId', v_code.hotel_id,
      'accountId', v_account_id,
      'finalRole', v_final_role,
      'username', v_existing_username,
      'pendingApproval', v_pending_approval,
      'usedCount', p_expected_used_count + 1
    );
  end if;

  select lower(auth_user.email)
    into v_actor_email
  from auth.users auth_user
  where auth_user.id = p_auth_user_id
  for share;
  if not found then
    return jsonb_build_object('ok', false, 'status', 'auth_user_missing');
  end if;
  if exists (
    select 1 from public.accounts account
    where account.data_user_id = p_auth_user_id
  ) then
    return jsonb_build_object('ok', false, 'status', 'account_exists');
  end if;

  if v_code.revoked_at is not null then
    return jsonb_build_object('ok', false, 'status', 'revoked');
  end if;
  if v_code.expires_at <= v_now then
    return jsonb_build_object('ok', false, 'status', 'expired');
  end if;
  if v_code.used_count >= v_code.max_uses then
    return jsonb_build_object('ok', false, 'status', 'used_up');
  end if;
  if v_code.used_count <> p_expected_used_count then
    return jsonb_build_object('ok', false, 'status', 'conflict');
  end if;
  if (
    select count(*)
    from public._staxis_current_primary_property_relationships() relationship
    where relationship.property_id = v_code.hotel_id
      and relationship.active_primary_count = 1
      and relationship.starts_at <= v_code.created_at
  ) <> 1 then
    return jsonb_build_object('ok', false, 'status', 'denied');
  end if;

  -- Roll the code increment back to this savepoint if username allocation
  -- loses a race. Every later failure remains uncaught and rolls the entire
  -- RPC transaction back, including the account and code use.
  begin
    if v_code.code_kind = 'privileged_onboarding' then
      perform set_config('staxis.privileged_join_code_write', 'claim', true);
    end if;
    update public.hotel_join_codes code_row
       set used_count = code_row.used_count + 1
     where code_row.id = v_code.id;

    insert into public.accounts (
      username, display_name, role, property_access, data_user_id, phone
    ) values (
      v_username,
      v_display_name,
      v_final_role,
      case when v_pending_approval then '{}'::uuid[] else array[p_hotel_id] end,
      p_auth_user_id,
      v_phone
    ) returning id into v_account_id;
  exception
    when unique_violation then
      if exists (
        select 1 from public.accounts account
        where account.data_user_id = p_auth_user_id
      ) then
        return jsonb_build_object('ok', false, 'status', 'account_exists');
      end if;
      if exists (
        select 1 from public.accounts account
        where account.username = v_username
      ) then
        return jsonb_build_object('ok', false, 'status', 'username_conflict');
      end if;
      raise;
    when sqlstate '55000' then
      return jsonb_build_object('ok', false, 'status', 'denied');
  end;

  if v_pending_approval then
    insert into public.join_requests (
      property_id, account_id, name, phone, language, department
    ) values (
      p_hotel_id, v_account_id, v_display_name, v_phone, p_language, v_final_role
    );
  end if;

  if v_final_role = 'owner' then
    update public.properties property
       set owner_id = p_auth_user_id
     where property.id = p_hotel_id;
  end if;

  if v_code.code_kind = 'privileged_onboarding' then
    v_next_state := jsonb_set(
      v_onboarding_state,
      '{accountCreatedAt}',
      to_jsonb(v_now),
      true
    );
    v_current_step := case
      when nullif(v_next_state->>'emailVerifiedAt', '') is null then 3
      when nullif(v_next_state->>'hotelDetailsAt', '') is null then 4
      when nullif(v_next_state->>'pmsCredentialsAt', '') is null
        and nullif(v_next_state->>'pmsSkippedAt', '') is null then 5
      when nullif(v_next_state->>'mappingCompletedAt', '') is null
        and nullif(v_next_state->>'pmsSkippedAt', '') is null then 6
      when nullif(v_next_state->>'staffAt', '') is null then 7
      when nullif(v_next_state->>'hotelContextAt', '') is null then 8
      else 9
    end;
    v_next_state := jsonb_set(
      v_next_state, '{step}', to_jsonb(v_current_step), true
    );
    update public.properties property
       set onboarding_state = v_next_state
     where property.id = p_hotel_id;
  end if;

  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, metadata
  ) values (
    p_auth_user_id,
    v_actor_email,
    'join_code.use',
    'join_code',
    v_code.id::text,
    jsonb_build_object(
      'account_id', v_account_id,
      'hotel_id', p_hotel_id,
      'role', v_final_role,
      'username', v_username,
      'has_phone', v_phone is not null,
      'owner_id_transferred', v_final_role = 'owner',
      'pending_approval', v_pending_approval,
      'expected_used_count', p_expected_used_count,
      'used_count', p_expected_used_count + 1,
      'request_id', nullif(btrim(p_request_id), '')
    )
  );

  return jsonb_build_object(
    'ok', true,
    'schemaVersion', 'join-code-signup-finalization-v1',
    'status', 'finalized',
    'codeId', v_code.id,
    'hotelId', v_code.hotel_id,
    'accountId', v_account_id,
    'finalRole', v_final_role,
    'username', v_username,
    'pendingApproval', v_pending_approval,
    'usedCount', p_expected_used_count + 1
  );
end;
$$;

revoke all on function public.staxis_finalize_join_code_signup(
  uuid,text,uuid,integer,uuid,text,text,text,text,text,text
) from public, anon, authenticated;
grant execute on function public.staxis_finalize_join_code_signup(
  uuid,text,uuid,integer,uuid,text,text,text,text,text,text
) to service_role;

comment on function public.staxis_finalize_join_code_signup(
  uuid,text,uuid,integer,uuid,text,text,text,text,text,text
) is
  'Service-only idempotent join-code signup finalizer. Rechecks transfer/revocation and atomically commits code use, account reach, pending request/onboarding state, and bearer-free audit.';

-- Atomic replacement for the route's SELECT/CAS update. It serializes every
-- claimant and lets the trigger recheck the property lifecycle in the same
-- transaction that consumes a privileged code.
create or replace function public.staxis_claim_join_code_slot(
  p_id uuid,
  p_expected_used_count integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_code public.hotel_join_codes%rowtype;
  v_hotel_id uuid;
begin
  if p_id is null or p_expected_used_count is null or p_expected_used_count < 0 then
    return jsonb_build_object('status', 'invalid');
  end if;

  select code_row.hotel_id into v_hotel_id
  from public.hotel_join_codes code_row
  where code_row.id = p_id;
  if not found then return jsonb_build_object('status', 'not_found'); end if;

  perform 1 from public.properties property
  where property.id = v_hotel_id
  for share;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  perform pg_advisory_xact_lock(hashtextextended(v_hotel_id::text, 0));

  select * into v_code
  from public.hotel_join_codes code_row
  where code_row.id = p_id
    and code_row.hotel_id = v_hotel_id
  for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_code.revoked_at is not null then return jsonb_build_object('status', 'revoked'); end if;
  if v_code.expires_at <= now() then return jsonb_build_object('status', 'expired'); end if;
  if v_code.used_count >= v_code.max_uses then return jsonb_build_object('status', 'used_up'); end if;
  if v_code.used_count <> p_expected_used_count then
    return jsonb_build_object('status', 'conflict');
  end if;
  if (
    select count(*)
    from public._staxis_current_primary_property_relationships() relationship
    where relationship.property_id = v_code.hotel_id
      and relationship.active_primary_count = 1
      and relationship.starts_at <= v_code.created_at
  ) <> 1 then
    return jsonb_build_object('status', 'not_claimable', 'privileged', false);
  end if;

  if v_code.code_kind = 'privileged_onboarding' then
    perform set_config('staxis.privileged_join_code_write', 'claim', true);
  end if;
  begin
    update public.hotel_join_codes
       set used_count = used_count + 1
     where id = v_code.id;
  exception
    when sqlstate '55000' or insufficient_privilege or check_violation then
      return jsonb_build_object(
        'status', 'not_claimable',
        'privileged', v_code.code_kind = 'privileged_onboarding'
      );
  end;

  return jsonb_build_object(
    'status', 'claimed',
    'usedCount', v_code.used_count + 1,
    'privileged', v_code.code_kind = 'privileged_onboarding'
  );
end;
$$;

revoke all on function public.staxis_claim_join_code_slot(uuid,integer)
  from public, anon, authenticated;
grant execute on function public.staxis_claim_join_code_slot(uuid,integer)
  to service_role;

-- Keep the established cleanup API, but make privileged release token-shaped
-- at the database boundary: only the exact 1 -> 0 transition is allowed and
-- the lifecycle trigger refuses to resurrect a code after an account/property
-- claim became visible.
create or replace function public.staxis_release_join_code_slot(
  p_id uuid
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_code public.hotel_join_codes%rowtype;
  v_count integer;
begin
  select * into v_code
  from public.hotel_join_codes code_row
  where code_row.id = p_id
  for update;
  if not found then return -1; end if;
  if v_code.used_count <= 0 then return 0; end if;

  if v_code.code_kind = 'privileged_onboarding' then
    if v_code.used_count <> 1 then return -2; end if;
    perform set_config('staxis.privileged_join_code_write', 'release', true);
  end if;
  begin
    update public.hotel_join_codes
       set used_count = greatest(used_count - 1, 0)
     where id = v_code.id
     returning used_count into v_count;
  exception
    when sqlstate '55000' or insufficient_privilege or check_violation then
      return -2;
  end;
  return v_count;
end;
$$;

revoke all on function public.staxis_release_join_code_slot(uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_release_join_code_slot(uuid)
  to service_role;

create or replace function public._staxis_jsonb_has_join_code_bearer_key(
  p_value jsonb
)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  v_key text;
  v_child jsonb;
begin
  if p_value is null then return false; end if;
  if jsonb_typeof(p_value) = 'object' then
    for v_key, v_child in select key, value from jsonb_each(p_value)
    loop
      if lower(v_key) = any(array['code', 'joincode', 'join_code', 'token', 'bearer'])
         or public._staxis_jsonb_has_join_code_bearer_key(v_child)
      then
        return true;
      end if;
    end loop;
  elsif jsonb_typeof(p_value) = 'array' then
    for v_child in select value from jsonb_array_elements(p_value)
    loop
      if public._staxis_jsonb_has_join_code_bearer_key(v_child) then
        return true;
      end if;
    end loop;
  end if;
  return false;
end;
$$;

revoke all on function public._staxis_jsonb_has_join_code_bearer_key(jsonb)
  from public, anon, authenticated;
grant execute on function public._staxis_jsonb_has_join_code_bearer_key(jsonb)
  to service_role;

create or replace function public._staxis_redact_join_code_bearer_keys(
  p_value jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  v_key text;
  v_child jsonb;
  v_result jsonb;
begin
  if p_value is null then return null; end if;
  if jsonb_typeof(p_value) = 'object' then
    v_result := '{}'::jsonb;
    for v_key, v_child in select key, value from jsonb_each(p_value)
    loop
      if lower(v_key) <> all(array['code', 'joincode', 'join_code', 'token', 'bearer']) then
        v_result := v_result || jsonb_build_object(
          v_key, public._staxis_redact_join_code_bearer_keys(v_child)
        );
      end if;
    end loop;
    return v_result;
  elsif jsonb_typeof(p_value) = 'array' then
    select coalesce(
      jsonb_agg(public._staxis_redact_join_code_bearer_keys(item.value)),
      '[]'::jsonb
    ) into v_result
    from jsonb_array_elements(p_value) item;
    return v_result;
  end if;
  return p_value;
end;
$$;

revoke all on function public._staxis_redact_join_code_bearer_keys(jsonb)
  from public, anon, authenticated, service_role;

-- The pre-0396 manager route placed the live staff bearer in audit metadata.
-- Remove that secret recursively while preserving the event, actor, target and
-- an explicit redaction marker.
update public.admin_audit_log audit
   set metadata = public._staxis_redact_join_code_bearer_keys(audit.metadata)
     || jsonb_build_object(
       'bearer_redacted', true,
       'bearer_redaction_reason', '0396 join-code storage boundary'
     )
 where audit.action like 'join_code.%'
   and public._staxis_jsonb_has_join_code_bearer_key(audit.metadata);

alter table public.admin_audit_log
  drop constraint if exists admin_audit_log_join_code_bearer_free_check;
alter table public.admin_audit_log
  add constraint admin_audit_log_join_code_bearer_free_check check (
    action not like 'join_code.%'
    or not public._staxis_jsonb_has_join_code_bearer_key(metadata)
  );

-- Ending or replacing an active primary relationship invalidates every bearer
-- issued for that hotel's former governance context in the same transaction.
-- The official transfer primitive holds the property row before reaching this
-- trigger; rollback restores both the relationship and credentials.
create or replace function public._staxis_revoke_join_codes_on_relationship_end()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_actor_account_id uuid := nullif(
    current_setting('staxis.actor_account_id', true), ''
  )::uuid;
  v_actor_auth_user_id uuid;
  v_actor_email text;
begin
  if old.is_primary_grouping is not true
     or old.relationship_type not in ('operator', 'owner')
     or old.starts_at > v_now
     or (old.ends_at is not null and old.ends_at <= v_now)
  then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.property_id = old.property_id
       and new.organization_id = old.organization_id
       and new.is_primary_grouping is true
       and new.relationship_type in ('operator', 'owner')
       and new.starts_at <= v_now
       and (new.ends_at is null or new.ends_at > v_now)
    then
      return new;
    end if;
  end if;

  if v_actor_account_id is not null then
    select actor.data_user_id, lower(auth_user.email)
      into v_actor_auth_user_id, v_actor_email
    from public.accounts actor
    left join auth.users auth_user on auth_user.id = actor.data_user_id
    where actor.id = v_actor_account_id;
  end if;

  with revoked as (
    update public.hotel_join_codes code_row
       set revoked_at = v_now
     where code_row.hotel_id = old.property_id
       and code_row.revoked_at is null
    returning code_row.id, code_row.code_kind
  )
  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, metadata
  )
  select v_actor_auth_user_id, v_actor_email,
         'join_code.relationship_revoke', 'join_code', revoked.id::text,
         jsonb_build_object(
           'hotel_id', old.property_id,
           'code_kind', revoked.code_kind,
           'previous_relationship_id', old.id,
           'previous_organization_id', old.organization_id,
           'actor_account_id', v_actor_account_id
         )
  from revoked;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public._staxis_revoke_join_codes_on_relationship_end()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_organization_relationship_join_code_revoke
  on public.organization_property_relationships;
create trigger trg_organization_relationship_join_code_revoke
  after update or delete on public.organization_property_relationships
  for each row execute function public._staxis_revoke_join_codes_on_relationship_end();

-- There is no actor identity in a legacy service-role table query, and SELECT
-- cannot be trigger-guarded. Keeping direct CRUD for an old application would
-- therefore preserve the exact check/read and check/write authorization gap
-- this migration closes. Mixed-version instances intentionally fail closed;
-- all supported reads and writes above are SECURITY DEFINER RPCs with narrow
-- receipts. This is an availability tradeoff during rollout, never a fallback.
revoke all privileges on table public.hotel_join_codes from service_role;

comment on column public.hotel_join_codes.code_kind is
  'staff_signup creates ordinary join requests; onboarding_resume is pre-consumed and wizard-only; privileged_onboarding is a DB-guarded one-shot hotel bootstrap; legacy_revoked is immutable audit history.';
comment on function public.staxis_mint_privileged_onboarding_join_code(uuid,uuid,uuid,text,text,text) is
  'Service-only platform-admin mint for one unrevoked owner/GM code on an exact unclaimed, incomplete hotel.';
comment on function public.staxis_claim_join_code_slot(uuid,integer) is
  'Service-only serialized code claim; privileged claims recheck hotel lifecycle in the same transaction as used_count consumption.';

insert into public.applied_migrations(version, description)
values (
  '0396',
  'RPC-only join-code storage: DB-guarded privileged onboarding, atomic signup finalization, transfer revocation, actor-bound staff/resume access, and bearer-free audit.'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
