-- 0395_authoritative_people_lifecycle.sql
--
-- Close the remaining My Hotel -> People lifecycle seams after authoritative
-- company access cutover.  The old lifecycle/role/detach RPCs authorized from
-- accounts.role + accounts.property_access.  That both rejected legitimate
-- normalized company managers and let stale legacy arrays survive a hotel
-- transfer.  Every operation below resolves the durable authority mode at the
-- final database write, including inactive targets whose access would resume
-- on reactivation.

begin;

do $requirements$
begin
  if to_regprocedure('public.staxis_list_account_authorized_properties(uuid)') is null
     or to_regprocedure('public.staxis_list_authoritative_hotel_accounts(uuid,boolean)') is null
     or to_regprocedure('public.staxis_register_account_lifecycle_intent(uuid,uuid,uuid,text,uuid,uuid,boolean,boolean,text,uuid,uuid[],bigint)') is null
     or to_regprocedure('public.staxis_commit_account_lifecycle_intent(uuid,text,uuid)') is null
     or to_regprocedure('public._staxis_manage_team_context(uuid,uuid)') is null
     or to_regclass('public.account_authorization_state') is null
     or to_regclass('public.account_lifecycle_intents') is null
     or to_regclass('public.account_invites') is null
     or to_regclass('public.account_property_staff_links') is null
  then
    raise exception '0395 requires authoritative access 0378, lifecycle intents 0335, and people bridge 0390';
  end if;
end
$requirements$;

-- Lifecycle intent authorization is independently reproducible at commit.
-- Columns are nullable only for rolling-upgrade compatibility: any old pending
-- row without them is rejected at commit and Auth is compensated by the
-- existing processor. New registrations always populate all three.
alter table public.account_lifecycle_intents
  add column if not exists actor_authority_version_snapshot bigint,
  add column if not exists target_authority_version_snapshot bigint,
  add column if not exists target_authorized_property_ids_snapshot uuid[];

comment on column public.account_lifecycle_intents.actor_authority_version_snapshot is
  'Durable actor authorization generation captured when the lifecycle intent was registered; rechecked before accounts.active commits.';
comment on column public.account_lifecycle_intents.target_authority_version_snapshot is
  'Durable target authorization generation captured when the lifecycle intent was registered; rechecked before accounts.active commits.';
comment on column public.account_lifecycle_intents.target_authorized_property_ids_snapshot is
  'Exact sorted hotel set structurally attached to the target at registration, including inactive normalized accounts; rechecked at commit and used for audit.';

-- Return the hotels structurally attached to an account without treating
-- accounts.active=false as if its memberships disappeared. This is deliberately
-- service-internal: operational/RLS reach still requires an active account.
create or replace function public._staxis_structural_account_property_ids(
  p_account_id uuid
)
returns uuid[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_mode text;
  v_property_ids uuid[] := '{}'::uuid[];
begin
  select state.authority_mode into v_mode
  from public.account_authorization_state state
  join public.accounts account on account.id = state.account_id
  where state.account_id = p_account_id;
  if not found then return '{}'::uuid[]; end if;

  if v_mode in ('legacy', 'shadow') then
    select coalesce(array_agg(distinct legacy_property.property_id
      order by legacy_property.property_id), '{}'::uuid[])
      into v_property_ids
    from public.accounts account
    cross join lateral unnest(coalesce(account.property_access, '{}'::uuid[]))
      legacy_property(property_id)
    join public._staxis_current_primary_property_relationships() relationship
      on relationship.property_id = legacy_property.property_id
     and relationship.active_primary_count = 1
    where account.id = p_account_id;
    return v_property_ids;
  end if;
  if v_mode <> 'normalized' then return '{}'::uuid[]; end if;

  with recursive
  governing_relationships as (
    select relationship.id, relationship.organization_id, relationship.property_id
    from public._staxis_current_primary_property_relationships() relationship
    join public.organizations organization
      on organization.id = relationship.organization_id
     and organization.status = 'active'
     and organization.organization_type <> 'single_hotel'
    where relationship.active_primary_count = 1
  ),
  active_memberships as (
    select membership.*
    from public.organization_memberships membership
    join public.organizations organization
      on organization.id = membership.organization_id
     and organization.status = 'active'
     and organization.organization_type <> 'single_hotel'
    where membership.account_id = p_account_id
      and membership.status = 'active'
      and membership.starts_at <= clock_timestamp()
      and membership.ended_at is null
  ),
  active_grants as (
    select grant_row.*
    from public.organization_access_grants grant_row
    join active_memberships membership
      on membership.id = grant_row.membership_id
     and membership.organization_id = grant_row.organization_id
    where grant_row.status = 'active'
      and grant_row.source <> 'legacy_backfill'
      and grant_row.starts_at <= clock_timestamp()
      and (grant_row.expires_at is null or grant_row.expires_at > clock_timestamp())
  ),
  portfolio_tree (grant_id, organization_id, membership_id, portfolio_id) as (
    select grant_row.id, grant_row.organization_id,
           grant_row.membership_id, portfolio.id
    from active_grants grant_row
    join public.portfolios portfolio
      on portfolio.id = grant_row.portfolio_id
     and portfolio.organization_id = grant_row.organization_id
     and portfolio.status = 'active'
    where grant_row.scope_type = 'portfolio'

    union

    select tree.grant_id, tree.organization_id,
           tree.membership_id, child.id
    from portfolio_tree tree
    join public.portfolios child
      on child.parent_id = tree.portfolio_id
     and child.organization_id = tree.organization_id
     and child.status = 'active'
  ),
  expanded(property_id) as (
    select relationship.property_id
    from active_memberships membership
    join governing_relationships relationship
      on relationship.organization_id = membership.organization_id
    where membership.membership_scope = 'company'
      and membership.staxis_role in ('owner', 'vp', 'finance')

    union

    select relationship.property_id
    from active_memberships membership
    cross join lateral unnest(
      coalesce(membership.covered_property_ids, '{}'::uuid[])
    ) covered(property_id)
    join governing_relationships relationship
      on relationship.organization_id = membership.organization_id
     and relationship.property_id = covered.property_id
    where membership.membership_scope = 'property'
      and membership.staxis_role in (
        'general_manager', 'front_desk', 'housekeeping', 'maintenance'
      )

    union

    select relationship.property_id
    from active_grants grant_row
    join governing_relationships relationship
      on relationship.organization_id = grant_row.organization_id
    where grant_row.scope_type = 'organization'

    union

    select relationship.property_id
    from active_grants grant_row
    join governing_relationships relationship
      on relationship.id = grant_row.property_relationship_id
     and relationship.organization_id = grant_row.organization_id
     and relationship.property_id = grant_row.property_id
    where grant_row.scope_type = 'property'

    union

    select relationship.property_id
    from portfolio_tree tree
    join public.portfolio_properties assignment
      on assignment.organization_id = tree.organization_id
     and assignment.portfolio_id = tree.portfolio_id
     and assignment.assigned_at <= clock_timestamp()
     and (assignment.removed_at is null
       or assignment.removed_at > clock_timestamp())
    join governing_relationships relationship
      on relationship.id = assignment.property_relationship_id
     and relationship.organization_id = assignment.organization_id
     and relationship.property_id = assignment.property_id

    union

    select bridge.property_id
    from public.account_property_authorization_bridges bridge
    where bridge.account_id = p_account_id
      and bridge.status = 'active'
      and (
        (bridge.cutover_relationship_id is null and not exists (
          select 1
          from public._staxis_current_primary_property_relationships() current_relationship
          where current_relationship.property_id = bridge.property_id
        ))
        or exists (
          select 1
          from public._staxis_current_primary_property_relationships() current_relationship
          where current_relationship.id = bridge.cutover_relationship_id
            and current_relationship.organization_id = bridge.cutover_organization_id
            and current_relationship.property_id = bridge.property_id
            and current_relationship.active_primary_count = 1
        )
      )
  )
  select coalesce(array_agg(distinct property_id order by property_id), '{}'::uuid[])
    into v_property_ids
  from expanded;
  return v_property_ids;
end;
$$;

revoke all on function public._staxis_structural_account_property_ids(uuid)
  from public, anon, authenticated, service_role;

-- People/Access administration is an organization-plane capability, not a
-- hotel-operations mutation. Company owners and VPs therefore retain
-- manage_people/manage_access over the exact hotels their organization
-- currently governs even though 0378 deliberately gives those hats
-- hotelMutationAllowed=false. Normalized manager grants are scoped through the
-- canonical non-legacy projection, so portfolio descendants, hotel transfers,
-- expiry, revocation, and authority-mode cutover all fail closed here too.
create or replace function public._staxis_account_has_company_people_authority_at_property(
  p_account_id uuid,
  p_property_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.accounts account
    join public.account_authorization_state state
      on state.account_id = account.id
     and state.authority_mode = 'normalized'
    join public._staxis_nonlegacy_property_authorizations(account.id) authority
      on authority.property_id = p_property_id
    where account.id = p_account_id
      and account.active is true
      and account.role <> 'admin'
      and (
        (
          authority.entitlement_kind = 'membership_hat'
          and authority.scope_type = 'company'
          and authority.staxis_role in ('owner', 'vp')
        )
        or (
          authority.entitlement_kind = 'access_grant'
          and authority.access_profile in (
            'organization_owner', 'organization_admin',
            'portfolio_manager', 'property_manager'
          )
        )
      )
  );
$$;

-- Higher-level organization authority may manage a hotel's GM-equivalent
-- access. A property manager/GM can manage staff in their hotel, but cannot
-- demote, detach, or mint a peer manager. The profile list mirrors the
-- canonical DELEGATABLE_PROFILES hierarchy.
create or replace function public._staxis_account_has_company_manager_hierarchy_at_property(
  p_account_id uuid,
  p_property_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.accounts account
    join public.account_authorization_state state
      on state.account_id = account.id
     and state.authority_mode = 'normalized'
    join public._staxis_nonlegacy_property_authorizations(account.id) authority
      on authority.property_id = p_property_id
    where account.id = p_account_id
      and account.active is true
      and account.role <> 'admin'
      and (
        (
          authority.entitlement_kind = 'membership_hat'
          and authority.scope_type = 'company'
          and authority.staxis_role in ('owner', 'vp')
        )
        or (
          authority.entitlement_kind = 'access_grant'
          and authority.access_profile in (
            'organization_owner', 'organization_admin', 'portfolio_manager'
          )
        )
      )
  );
$$;

-- Hotel-local owners/GMs keep their existing exact-property People ability,
-- including an explicit manage_users deny. Finance/read-only company hats have
-- neither organization authority above nor operational mutation authority.
create or replace function public._staxis_account_can_manage_users_at_property(
  p_account_id uuid,
  p_property_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_account public.accounts%rowtype;
  v_access jsonb;
  v_standing jsonb;
  v_role text;
begin
  select * into v_account
  from public.accounts account
  where account.id = p_account_id and account.active is true;
  if not found then return false; end if;
  if v_account.role = 'admin' then return true; end if;
  if public._staxis_account_has_company_people_authority_at_property(
    p_account_id, p_property_id
  ) then
    return true;
  end if;

  v_access := public.staxis_list_account_authorized_properties(p_account_id);
  if v_access->>'ok' <> 'true' or v_access->>'all' = 'true' then return false; end if;
  select standing into v_standing
  from jsonb_array_elements(coalesce(v_access->'propertyStandings', '[]'::jsonb)) standing
  where standing->>'propertyId' = p_property_id::text;
  if v_standing is null or v_standing->>'hotelMutationAllowed' <> 'true' then
    return false;
  end if;
  v_role := v_standing->>'operationalRole';
  if v_role not in ('owner', 'general_manager') then return false; end if;
  if exists (
    select 1 from public.capability_overrides override_row
    where override_row.property_id = p_property_id
      and override_row.capability = 'manage_users'
      and override_row.role = v_role
      and override_row.allowed is false
  ) then
    return false;
  end if;
  return true;
end;
$$;

create or replace function public._staxis_account_operational_role_at_property(
  p_account_id uuid,
  p_property_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_account_role text;
  v_access jsonb;
  v_role text;
begin
  select account.role into v_account_role
  from public.accounts account
  where account.id = p_account_id and account.active is true;
  if not found then return null; end if;
  if v_account_role = 'admin' then return 'admin'; end if;
  v_access := public.staxis_list_account_authorized_properties(p_account_id);
  select standing->>'operationalRole' into v_role
  from jsonb_array_elements(coalesce(v_access->'propertyStandings', '[]'::jsonb)) standing
  where standing->>'propertyId' = p_property_id::text;
  return v_role;
end;
$$;

revoke all on function public._staxis_account_has_company_people_authority_at_property(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public._staxis_account_has_company_manager_hierarchy_at_property(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public._staxis_account_can_manage_users_at_property(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public._staxis_account_operational_role_at_property(uuid,uuid)
  from public, anon, authenticated, service_role;

-- Membership-hat delegation is an organization-plane decision. The original
-- 0364 matrix understood company hats but not normalized organization,
-- portfolio, or property grants. Replacing it here keeps one final database
-- authority check for invitation acceptance, direct hat changes, and hat
-- conversion. Every target hotel must be justified by one exact current
-- entitlement row; capabilities from different grants are never unioned into
-- a synthetic delegation path.
create or replace function public._staxis_can_set_membership_hat(
  p_actor_account_id uuid,
  p_organization_id uuid,
  p_membership_scope text,
  p_staxis_role text,
  p_property_ids uuid[]
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_role text;
  v_authority_mode text;
  v_now timestamptz := clock_timestamp();
begin
  if p_actor_account_id is null
     or p_organization_id is null
     or p_membership_scope not in ('company', 'property')
     or not (
       (p_membership_scope = 'company'
         and p_staxis_role in ('owner', 'vp', 'finance')
         and p_property_ids is null)
       or
       (p_membership_scope = 'property'
         and p_staxis_role in (
           'general_manager', 'front_desk', 'housekeeping', 'maintenance'
         )
         and p_property_ids is not null
         and cardinality(p_property_ids) between 1 and 5000)
     )
  then
    return false;
  end if;

  select account.role into v_actor_role
  from public.accounts account
  where account.id = p_actor_account_id
    and account.active is true;
  if not found then return false; end if;

  if not exists (
    select 1
    from public.organizations organization
    where organization.id = p_organization_id
      and organization.status = 'active'
      and organization.organization_type in ('management_company', 'ownership_group')
  ) then
    return false;
  end if;

  -- Staxis administrators bootstrap a company, but account.role is read on
  -- every call so removing the role invalidates an open/stale session.
  if v_actor_role = 'admin' then return true; end if;

  select state.authority_mode into v_authority_mode
  from public.account_authorization_state state
  where state.account_id = p_actor_account_id;
  if v_authority_mode is distinct from 'normalized' then return false; end if;

  if p_membership_scope = 'property' then
    if array_position(p_property_ids, null) is not null
       or (select count(*) from unnest(p_property_ids) property_id)
          <> (select count(distinct property_id) from unnest(p_property_ids) property_id)
    then
      return false;
    end if;

    -- Each requested hotel has exactly one live governing company and it is
    -- the organization in the invitation. Transfers and ambiguous topology
    -- therefore invalidate the delegation before entitlement evaluation.
    if exists (
      select 1
      from unnest(p_property_ids) target(property_id)
      where 1 <> (
        select count(*)
        from public._staxis_current_primary_property_relationships() relationship
        join public.organizations organization
          on organization.id = relationship.organization_id
         and organization.status = 'active'
        where relationship.property_id = target.property_id
          and relationship.active_primary_count = 1
      )
      or not exists (
        select 1
        from public._staxis_current_primary_property_relationships() relationship
        where relationship.organization_id = p_organization_id
          and relationship.property_id = target.property_id
          and relationship.active_primary_count = 1
      )
    ) then
      return false;
    end if;

    return not exists (
      select 1
      from unnest(p_property_ids) target(property_id)
      where not exists (
        select 1
        from public._staxis_nonlegacy_property_authorizations(
          p_actor_account_id
        ) authority
        where authority.organization_id = p_organization_id
          and authority.property_id = target.property_id
          and (
            (
              authority.entitlement_kind = 'membership_hat'
              and (
                (authority.scope_type = 'company'
                  and authority.staxis_role in ('owner', 'vp'))
                or
                (authority.scope_type = 'property'
                  and authority.staxis_role = 'general_manager'
                  and p_staxis_role in ('front_desk', 'housekeeping', 'maintenance'))
              )
            )
            or
            (
              authority.entitlement_kind = 'access_grant'
              and (
                authority.access_profile in (
                  'organization_owner', 'organization_admin', 'portfolio_manager'
                )
                or (authority.access_profile = 'property_manager'
                  and p_staxis_role in ('front_desk', 'housekeeping', 'maintenance'))
              )
            )
          )
      )
    );
  end if;

  -- Whole-company grants include future acquisitions. The actor must currently
  -- cover every operated hotel through a broad company/organization
  -- entitlement that itself carries the requested hierarchy. A single broad
  -- row at one hotel cannot launder narrow portfolio grants at its peers.
  if public._staxis_organization_has_ambiguous_primary_topology(
       p_organization_id
     ) or not exists (
    select 1
    from public._staxis_current_primary_property_relationships() relationship
    where relationship.organization_id = p_organization_id
      and relationship.active_primary_count = 1
  ) then
    return false;
  end if;

  return not exists (
    select 1
    from public._staxis_current_primary_property_relationships() governed
    where governed.organization_id = p_organization_id
      and governed.active_primary_count = 1
      and not exists (
        select 1
        from public._staxis_nonlegacy_property_authorizations(
          p_actor_account_id
        ) authority
        where authority.organization_id = p_organization_id
          and authority.property_id = governed.property_id
          and (
            (
              authority.entitlement_kind = 'membership_hat'
              and authority.scope_type = 'company'
              and (
                authority.staxis_role = 'owner'
                or (authority.staxis_role = 'vp' and p_staxis_role = 'finance')
              )
            )
            or
            (
              authority.entitlement_kind = 'access_grant'
              and authority.scope_type = 'organization'
              and (
                authority.access_profile = 'organization_owner'
                or (authority.access_profile in (
                    'organization_admin', 'portfolio_manager'
                  ) and p_staxis_role = 'finance')
              )
            )
          )
      )
  );
end;
$$;

revoke all on function public._staxis_can_set_membership_hat(
  uuid, uuid, text, text, uuid[]
) from public, anon, authenticated;
grant execute on function public._staxis_can_set_membership_hat(
  uuid, uuid, text, text, uuid[]
) to service_role;

-- Invitation creation and revocation are authorization mutations too. Keep
-- their shape/topology/delegation predicate internal so both actor-bound RPCs
-- below make the same decision while their transaction locks are held.
create or replace function public._staxis_can_control_account_invite(
  p_actor_account_id uuid,
  p_hotel_id uuid,
  p_organization_id uuid,
  p_membership_scope text,
  p_role text,
  p_covered_property_ids uuid[]
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_normalized boolean;
  v_current_organization_id uuid;
  v_current_organization_type text;
  v_current_relationship_count integer;
  v_context jsonb;
begin
  if p_actor_account_id is null or p_hotel_id is null or p_role is null then
    return false;
  end if;

  select count(*)::integer
    into v_current_relationship_count
  from public._staxis_current_primary_property_relationships() relationship
  join public.organizations organization
    on organization.id = relationship.organization_id
   and organization.status = 'active'
  where relationship.property_id = p_hotel_id
    and relationship.active_primary_count = 1;
  if v_current_relationship_count <> 1 then return false; end if;

  select relationship.organization_id, organization.organization_type
    into v_current_organization_id, v_current_organization_type
  from public._staxis_current_primary_property_relationships() relationship
  join public.organizations organization
    on organization.id = relationship.organization_id
   and organization.status = 'active'
  where relationship.property_id = p_hotel_id
    and relationship.active_primary_count = 1;

  v_normalized := p_organization_id is not null
    or p_membership_scope is not null
    or p_covered_property_ids is not null;

  if not v_normalized then
    if v_current_organization_type <> 'single_hotel'
       or p_role not in (
         'owner', 'general_manager', 'front_desk', 'housekeeping', 'maintenance'
       )
    then
      return false;
    end if;
    v_context := public._staxis_manage_team_context(
      p_actor_account_id, p_hotel_id
    );
    return coalesce((v_context->>'allowed')::boolean, false) is true
      and (
        (p_role in ('owner', 'general_manager')
          and v_context->>'role' in ('admin', 'owner'))
        or p_role in ('front_desk', 'housekeeping', 'maintenance')
      );
  end if;

  if p_organization_id is null
     or p_membership_scope not in ('company', 'property')
     or v_current_organization_id is distinct from p_organization_id
     or v_current_organization_type not in (
       'management_company', 'ownership_group'
     )
     or not (
       (p_membership_scope = 'company'
         and p_role in ('owner', 'vp', 'finance')
         and p_covered_property_ids is null)
       or
       (p_membership_scope = 'property'
         and p_role in (
           'general_manager', 'front_desk', 'housekeeping', 'maintenance'
         )
         and p_covered_property_ids is not null
         and cardinality(p_covered_property_ids) between 1 and 5000)
     )
  then
    return false;
  end if;

  if p_membership_scope = 'property' then
    if not (p_hotel_id = any(p_covered_property_ids))
       or array_position(p_covered_property_ids, null) is not null
       or (select count(*) from unnest(p_covered_property_ids) property_id)
          <> (select count(distinct property_id)
              from unnest(p_covered_property_ids) property_id)
       or exists (
         select 1
         from unnest(p_covered_property_ids) target(property_id)
         where 1 <> (
           select count(*)
           from public._staxis_current_primary_property_relationships() relationship
           join public.organizations organization
             on organization.id = relationship.organization_id
            and organization.status = 'active'
           where relationship.property_id = target.property_id
             and relationship.active_primary_count = 1
         )
         or not exists (
           select 1
           from public._staxis_current_primary_property_relationships() relationship
           where relationship.organization_id = p_organization_id
             and relationship.property_id = target.property_id
             and relationship.active_primary_count = 1
         )
       )
    then
      return false;
    end if;
  end if;

  return public._staxis_can_set_membership_hat(
    p_actor_account_id,
    p_organization_id,
    p_membership_scope,
    p_role,
    case when p_membership_scope = 'property'
      then p_covered_property_ids else null end
  );
end;
$$;

revoke all on function public._staxis_can_control_account_invite(
  uuid, uuid, uuid, text, text, uuid[]
) from public, anon, authenticated, service_role;

-- Create the pending invitation and its audit record in the same transaction
-- that re-locks the actor and all authority inputs. The caller may send email
-- only after this RPC succeeds, so a revoked actor cannot leave a pending row
-- or an apparently valid message in the check/write gap.
create or replace function public.staxis_create_account_invite_guarded(
  p_actor_account_id uuid,
  p_actor_auth_user_id uuid,
  p_hotel_id uuid,
  p_email text,
  p_role text,
  p_token_hash text,
  p_expires_at timestamptz,
  p_organization_id uuid,
  p_membership_scope text,
  p_covered_property_ids uuid[],
  p_request_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_email text := lower(btrim(p_email));
  v_invite_id uuid;
  v_hotel_name text;
  v_actor_email text;
  v_property_id uuid;
  v_lock_property_ids uuid[];
  v_current_organization_id uuid;
begin
  if p_actor_account_id is null
     or p_actor_auth_user_id is null
     or p_hotel_id is null
     or p_email is null
     or char_length(v_email) not between 3 and 320
     or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or p_role is null
     or p_token_hash is null
     or p_token_hash !~ '^[0-9a-f]{64}$'
     or p_expires_at is null
     or p_expires_at <= v_now
     or p_expires_at > v_now + interval '8 days'
  then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  v_lock_property_ids := array[p_hotel_id]
    || case when p_membership_scope = 'property'
      then coalesce(p_covered_property_ids, '{}'::uuid[])
      else '{}'::uuid[] end;
  for v_property_id in
    select distinct locked_id
    from unnest(v_lock_property_ids) locked_id
    where locked_id is not null
    order by locked_id
  loop
    perform 1
    from public.properties property
    where property.id = v_property_id
    for update;
    if not found then
      return jsonb_build_object('ok', false, 'reason', 'denied');
    end if;
    perform pg_advisory_xact_lock(hashtextextended(v_property_id::text, 0));
  end loop;

  select relationship.organization_id into v_current_organization_id
  from public._staxis_current_primary_property_relationships() relationship
  join public.organizations organization
    on organization.id = relationship.organization_id
   and organization.status = 'active'
  where relationship.property_id = p_hotel_id
    and relationship.active_primary_count = 1
  order by relationship.id
  limit 1;
  if v_current_organization_id is not null then
    -- Organization-plane writers take this lock before table DML. Matching
    -- that order avoids a SHARE-table/advisory-lock deadlock cycle.
    perform public._staxis_lock_organization(v_current_organization_id);
  end if;

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
    raise exception 'invitation authority changed concurrently'
      using errcode = '55P03';
  end;

  select property.name into v_hotel_name
  from public.properties property
  where property.id = p_hotel_id;
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
  select lower(auth_user.email) into v_actor_email
  from public.accounts actor
  left join auth.users auth_user on auth_user.id = actor.data_user_id
  where actor.id = p_actor_account_id
    and actor.data_user_id = p_actor_auth_user_id
    and actor.active is true;
  if not found or not public._staxis_can_control_account_invite(
    p_actor_account_id,
    p_hotel_id,
    p_organization_id,
    p_membership_scope,
    p_role,
    p_covered_property_ids
  ) then
    return jsonb_build_object('ok', false, 'reason', 'denied');
  end if;

  insert into public.account_invites (
    hotel_id, email, role, token_hash, expires_at, invited_by,
    organization_id, membership_scope, covered_property_ids
  ) values (
    p_hotel_id, v_email, p_role, p_token_hash, p_expires_at,
    p_actor_account_id, p_organization_id, p_membership_scope,
    p_covered_property_ids
  ) returning id into v_invite_id;

  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, metadata
  ) values (
    p_actor_auth_user_id, v_actor_email, 'invite.create', 'invite',
    v_invite_id::text,
    jsonb_build_object(
      'hotel_id', p_hotel_id,
      'email', v_email,
      'role', p_role,
      'scope', p_membership_scope,
      'organization_id', p_organization_id,
      'property_ids', case when p_membership_scope = 'property'
        then to_jsonb(p_covered_property_ids) else null end,
      'request_id', p_request_id
    )
  );

  return jsonb_build_object(
    'ok', true,
    'inviteId', v_invite_id,
    'hotelId', p_hotel_id,
    'hotelName', v_hotel_name
  );
end;
$$;

revoke all on function public.staxis_create_account_invite_guarded(
  uuid, uuid, uuid, text, text, text, timestamptz,
  uuid, text, uuid[], text
) from public, anon, authenticated;
grant execute on function public.staxis_create_account_invite_guarded(
  uuid, uuid, uuid, text, text, text, timestamptz,
  uuid, text, uuid[], text
) to service_role;

-- Revoke only after the exact persisted promise is re-authorized under the
-- same locks used by creation/acceptance. Unauthorized and missing identifiers
-- are intentionally indistinguishable to the HTTP route.
create or replace function public.staxis_revoke_account_invite_guarded(
  p_actor_account_id uuid,
  p_actor_auth_user_id uuid,
  p_invite_id uuid,
  p_request_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite public.account_invites%rowtype;
  v_actor_email text;
  v_actor_role text;
  v_property_id uuid;
  v_lock_property_ids uuid[];
  v_current_organization_id uuid;
begin
  if p_actor_account_id is null
     or p_actor_auth_user_id is null
     or p_invite_id is null
  then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  select invitation.* into v_invite
  from public.account_invites invitation
  where invitation.id = p_invite_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  v_lock_property_ids := array[v_invite.hotel_id]
    || case when v_invite.membership_scope = 'property'
      then coalesce(v_invite.covered_property_ids, '{}'::uuid[])
      else '{}'::uuid[] end;
  for v_property_id in
    select distinct locked_id
    from unnest(v_lock_property_ids) locked_id
    where locked_id is not null
    order by locked_id
  loop
    perform 1
    from public.properties property
    where property.id = v_property_id
    for update;
    if not found then
      return jsonb_build_object('ok', false, 'reason', 'denied');
    end if;
    perform pg_advisory_xact_lock(hashtextextended(v_property_id::text, 0));
  end loop;

  select relationship.organization_id into v_current_organization_id
  from public._staxis_current_primary_property_relationships() relationship
  join public.organizations organization
    on organization.id = relationship.organization_id
   and organization.status = 'active'
  where relationship.property_id = v_invite.hotel_id
    and relationship.active_primary_count = 1
  order by relationship.id
  limit 1;
  if v_current_organization_id is not null then
    perform public._staxis_lock_organization(v_current_organization_id);
  end if;

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
    raise exception 'invitation authority changed concurrently'
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
  select actor.role, lower(auth_user.email) into v_actor_role, v_actor_email
  from public.accounts actor
  left join auth.users auth_user on auth_user.id = actor.data_user_id
  where actor.id = p_actor_account_id
    and actor.data_user_id = p_actor_auth_user_id
    and actor.active is true;
  if not found or (
    v_actor_role <> 'admin'
    and not public._staxis_can_control_account_invite(
      p_actor_account_id,
      v_invite.hotel_id,
      v_invite.organization_id,
      v_invite.membership_scope,
      v_invite.role,
      v_invite.covered_property_ids
    )
  ) then
    return jsonb_build_object('ok', false, 'reason', 'denied');
  end if;
  -- Only an actor who still has exact authority may learn that a known invite
  -- is already terminal; unauthorized accepted ids remain indistinguishable
  -- from missing ids at the HTTP boundary.
  if v_invite.accepted_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'not_pending');
  end if;

  delete from public.account_invites invitation
  where invitation.id = v_invite.id
    and invitation.accepted_at is null;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_pending');
  end if;

  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, metadata
  ) values (
    p_actor_auth_user_id, v_actor_email, 'invite.revoke', 'invite',
    v_invite.id::text,
    jsonb_build_object(
      'hotel_id', v_invite.hotel_id,
      'email', lower(v_invite.email),
      'role', v_invite.role,
      'scope', v_invite.membership_scope,
      'organization_id', v_invite.organization_id,
      'property_ids', case when v_invite.membership_scope = 'property'
        then to_jsonb(v_invite.covered_property_ids) else null end,
      'request_id', p_request_id
    )
  );

  return jsonb_build_object(
    'ok', true,
    'inviteId', v_invite.id,
    'hotelId', v_invite.hotel_id
  );
end;
$$;

revoke all on function public.staxis_revoke_account_invite_guarded(
  uuid, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.staxis_revoke_account_invite_guarded(
  uuid, uuid, uuid, text
) to service_role;

-- My Hotel > People changes use actor-bound wrappers rather than trusting a
-- service caller to pair an arbitrary account id with a stale browser session.
-- The underlying staxis_set/end_membership_hat functions remain the single
-- hierarchy implementation. Their organization_memberships DML fires the
-- append-only organization_access_events trigger in this same transaction;
-- setting the actor/request context here gives that canonical audit event an
-- exact initiator and correlation id. If audit insertion fails, the hat DML
-- rolls back with it.
create or replace function public.staxis_set_membership_hat_guarded(
  p_actor_account_id uuid,
  p_actor_auth_user_id uuid,
  p_organization_id uuid,
  p_account_id uuid,
  p_membership_scope text,
  p_staxis_role text,
  p_property_ids jsonb default null,
  p_job_title text default null,
  p_audit_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_membership_id uuid;
  v_actor public.accounts%rowtype;
  v_target public.accounts%rowtype;
begin
  if p_actor_account_id is null
     or p_actor_auth_user_id is null
     or p_organization_id is null
     or p_account_id is null
  then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  -- Organization writers serialize here. Account rows are then locked in a
  -- deterministic order so role removal/deactivation cannot commit between
  -- the final identity check and the membership write.
  perform public._staxis_lock_organization(p_organization_id);
  begin
    perform 1
    from public.accounts account
    where account.id = any(array[p_actor_account_id, p_account_id])
    order by account.id
    for share nowait;
    perform 1
    from public.account_authorization_state state
    where state.account_id = p_actor_account_id
    for share nowait;
  exception when lock_not_available then
    raise exception 'membership authority changed concurrently'
      using errcode = '55P03';
  end;

  select * into v_actor
  from public.accounts actor
  where actor.id = p_actor_account_id;
  select * into v_target
  from public.accounts target
  where target.id = p_account_id;
  if v_actor.id is null
     or v_target.id is null
     or v_actor.active is not true
     or v_target.active is not true
     or v_actor.data_user_id is distinct from p_actor_auth_user_id
  then
    return jsonb_build_object('ok', false, 'reason', 'denied');
  end if;

  perform set_config('staxis.actor_account_id', p_actor_account_id::text, true);
  perform set_config(
    'staxis.request_id', coalesce(p_audit_request_id::text, ''), true
  );
  v_membership_id := public.staxis_set_membership_hat(
    p_actor_account_id,
    p_organization_id,
    p_account_id,
    p_membership_scope,
    p_staxis_role,
    p_property_ids,
    p_job_title
  );
  if v_membership_id is null then
    return jsonb_build_object('ok', false, 'reason', 'denied');
  end if;
  return jsonb_build_object(
    'ok', true,
    'membershipId', v_membership_id,
    'organizationId', p_organization_id,
    'accountId', p_account_id,
    'auditRequestId', p_audit_request_id
  );
end;
$$;

revoke all on function public.staxis_set_membership_hat_guarded(
  uuid, uuid, uuid, uuid, text, text, jsonb, text, uuid
) from public, anon, authenticated;
grant execute on function public.staxis_set_membership_hat_guarded(
  uuid, uuid, uuid, uuid, text, text, jsonb, text, uuid
) to service_role;

create or replace function public.staxis_end_membership_hat_guarded(
  p_actor_account_id uuid,
  p_actor_auth_user_id uuid,
  p_membership_id uuid,
  p_audit_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_organization_id uuid;
  v_current_organization_id uuid;
  v_ended_at timestamptz;
  v_actor public.accounts%rowtype;
  v_removed boolean;
begin
  if p_actor_account_id is null
     or p_actor_auth_user_id is null
     or p_membership_id is null
  then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  select membership.organization_id into v_organization_id
  from public.organization_memberships membership
  where membership.id = p_membership_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  perform public._staxis_lock_organization(v_organization_id);
  begin
    select membership.organization_id, membership.ended_at
      into v_current_organization_id, v_ended_at
    from public.organization_memberships membership
    where membership.id = p_membership_id
    for share nowait;
    perform 1
    from public.accounts actor
    where actor.id = p_actor_account_id
    for share nowait;
    perform 1
    from public.account_authorization_state state
    where state.account_id = p_actor_account_id
    for share nowait;
  exception when lock_not_available then
    raise exception 'membership authority changed concurrently'
      using errcode = '55P03';
  end;
  if v_current_organization_id is distinct from v_organization_id then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_ended_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'not_pending');
  end if;

  select * into v_actor
  from public.accounts actor
  where actor.id = p_actor_account_id;
  if v_actor.id is null
     or v_actor.active is not true
     or v_actor.data_user_id is distinct from p_actor_auth_user_id
  then
    return jsonb_build_object('ok', false, 'reason', 'denied');
  end if;

  perform set_config('staxis.actor_account_id', p_actor_account_id::text, true);
  perform set_config(
    'staxis.request_id', coalesce(p_audit_request_id::text, ''), true
  );
  v_removed := public.staxis_end_membership_hat(
    p_actor_account_id, p_membership_id
  );
  if v_removed is not true then
    return jsonb_build_object('ok', false, 'reason', 'not_pending');
  end if;
  return jsonb_build_object(
    'ok', true,
    'membershipId', p_membership_id,
    'organizationId', v_organization_id,
    'auditRequestId', p_audit_request_id
  );
end;
$$;

revoke all on function public.staxis_end_membership_hat_guarded(
  uuid, uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.staxis_end_membership_hat_guarded(
  uuid, uuid, uuid, uuid
) to service_role;

create or replace function public._staxis_account_is_live_organization_owner(
  p_account_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.organization_memberships membership
    join public.organizations organization
      on organization.id = membership.organization_id
     and organization.status = 'active'
     and organization.organization_type <> 'single_hotel'
    where membership.account_id = p_account_id
      and membership.status = 'active'
      and membership.starts_at <= clock_timestamp()
      and membership.ended_at is null
      and membership.membership_scope = 'company'
      and membership.staxis_role = 'owner'
  ) or exists (
    select 1
    from public.organization_memberships membership
    join public.organization_access_grants grant_row
      on grant_row.membership_id = membership.id
     and grant_row.organization_id = membership.organization_id
    join public.organizations organization
      on organization.id = membership.organization_id
     and organization.status = 'active'
     and organization.organization_type <> 'single_hotel'
    where membership.account_id = p_account_id
      and membership.status = 'active'
      and membership.starts_at <= clock_timestamp()
      and membership.ended_at is null
      and grant_row.access_profile = 'organization_owner'
      and grant_row.scope_type = 'organization'
      and grant_row.status = 'active'
      and grant_row.starts_at <= clock_timestamp()
      and grant_row.expires_at is null
      and grant_row.source <> 'legacy_backfill'
  );
$$;

revoke all on function public._staxis_account_is_live_organization_owner(uuid)
  from public, anon, authenticated, service_role;

-- The roster is a management projection, not an RLS reach assertion. Include
-- inactive customer accounts at their resumable structural scope so People can
-- reactivate them, while transferred/revoked topology disappears immediately.
create or replace function public.staxis_list_authoritative_hotel_accounts(
  p_property_id uuid,
  p_include_platform_admins boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
  v_accounts jsonb;
begin
  if p_property_id is null or not exists (
    select 1 from public.properties property where property.id = p_property_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'property_not_found');
  end if;

  with roster as (
    select account.id, account.username, account.display_name, account.role,
           account.active, account.data_user_id, account.staff_id,
           account.created_at, account.updated_at, state.authority_mode,
           state.authority_version, structural.property_ids
    from public.accounts account
    join public.account_authorization_state state on state.account_id = account.id
    cross join lateral (
      select public._staxis_structural_account_property_ids(account.id) as property_ids
    ) structural
    where (account.role = 'admin' and account.active is true
           and p_include_platform_admins is true)
       or (account.role <> 'admin'
           and p_property_id = any(structural.property_ids))
  )
  select count(*)::integer,
         coalesce(jsonb_agg(jsonb_build_object(
           'accountId', roster.id,
           'username', roster.username,
           'displayName', roster.display_name,
           'role', roster.role,
           'active', roster.active,
           'dataUserId', roster.data_user_id,
           'staffId', roster.staff_id,
           'createdAt', roster.created_at,
           'updatedAt', roster.updated_at,
           'authorityMode', roster.authority_mode,
           'authorityVersion', roster.authority_version,
           'propertyIds', case when roster.role = 'admin' then '[]'::jsonb
             else to_jsonb(roster.property_ids) end,
           'managementSurface', case
             when roster.authority_mode = 'normalized' then 'company_access'
             else 'legacy_hotel'
           end
         ) order by roster.created_at, roster.id), '[]'::jsonb)
    into v_count, v_accounts
  from roster;

  if v_count > 5000 then
    return jsonb_build_object('ok', false, 'reason', 'roster_too_large');
  end if;
  return jsonb_build_object(
    'ok', true,
    'schemaVersion', 'authoritative-hotel-roster-v1',
    'propertyId', p_property_id,
    'generatedAt', clock_timestamp(),
    'accounts', v_accounts
  );
end;
$$;

revoke all on function public.staxis_list_authoritative_hotel_accounts(uuid,boolean)
  from public, anon, authenticated;
grant execute on function public.staxis_list_authoritative_hotel_accounts(uuid,boolean)
  to service_role;

-- Register lifecycle work only after resolving the actor and target through
-- the same durable authority mode used by hotel RLS and portfolio chat.
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
  v_actor_state public.account_authorization_state%rowtype;
  v_target_state public.account_authorization_state%rowtype;
  v_existing public.account_lifecycle_intents%rowtype;
  v_pending public.account_lifecycle_intents%rowtype;
  v_target_property_ids uuid[] := '{}'::uuid[];
  v_property_id uuid;
  v_version bigint;
begin
  if p_operation_id is null or p_actor_account_id is null
     or p_actor_auth_user_id is null or p_hotel_id is null
     or p_target_account_id is null or p_desired_active is null
     or p_expected_active is null or p_expected_role is null
     or p_expected_auth_user_id is null or p_expected_property_access is null
     or p_expected_intent_version is null
  then
    return jsonb_build_object('status', 'invalid');
  end if;
  if p_actor_account_id = p_target_account_id then
    return jsonb_build_object('status', 'forbidden', 'reason', 'self');
  end if;

  perform 1
  from public.accounts account
  where account.id = any(array[p_actor_account_id, p_target_account_id])
  order by account.id
  for update;
  perform 1
  from public.account_authorization_state state
  where state.account_id = any(array[p_actor_account_id, p_target_account_id])
  order by state.account_id
  for update;

  select * into v_actor from public.accounts where id = p_actor_account_id;
  select * into v_target from public.accounts where id = p_target_account_id;
  select * into v_actor_state from public.account_authorization_state
    where account_id = p_actor_account_id;
  select * into v_target_state from public.account_authorization_state
    where account_id = p_target_account_id;
  if v_actor.id is null or v_target.id is null
     or v_actor_state.account_id is null or v_target_state.account_id is null
  then
    return jsonb_build_object('status', 'not_found');
  end if;

  if (select count(*) from public.accounts where data_user_id = p_actor_auth_user_id) <> 1
     or (select count(*) from public.accounts where data_user_id = v_target.data_user_id) <> 1
  then
    return jsonb_build_object('status', 'identity_conflict');
  end if;

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
  exception
    when lock_not_available then
      return jsonb_build_object('status', 'retry');
  end;

  if not v_actor.active or v_actor.data_user_id <> p_actor_auth_user_id then
    return jsonb_build_object('status', 'forbidden', 'reason', 'caller_inactive');
  end if;
  if v_target.role in ('admin', 'owner') then
    return jsonb_build_object('status', 'forbidden', 'reason', 'target_role');
  end if;

  v_target_property_ids := public._staxis_structural_account_property_ids(
    p_target_account_id
  );
  if cardinality(v_target_property_ids) = 0
     or not (p_hotel_id = any(v_target_property_ids))
  then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_actor.role <> 'admin' then
    foreach v_property_id in array v_target_property_ids
    loop
      if not public._staxis_account_can_manage_users_at_property(
        p_actor_account_id, v_property_id
      ) then
        return jsonb_build_object('status', 'forbidden', 'reason', 'manage_users');
      end if;
    end loop;
    if v_target.role = 'general_manager' and exists (
      select 1 from unnest(v_target_property_ids) property_id
      where not public._staxis_account_has_company_manager_hierarchy_at_property(
              p_actor_account_id, property_id
            )
        and public._staxis_account_operational_role_at_property(
              p_actor_account_id, property_id
            ) <> 'owner'
    ) then
      return jsonb_build_object('status', 'forbidden', 'reason', 'hierarchy');
    end if;
  end if;

  -- A retry may observe a terminal record, but a pending retry is admitted
  -- only after the fresh checks above. A revoked open session therefore cannot
  -- resume an already-registered operation.
  select * into v_existing
  from public.account_lifecycle_intents intent
  where intent.operation_id = p_operation_id
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
    if v_existing.status = 'pending' and (
      v_existing.actor_authority_version_snapshot is null
      or v_existing.target_authority_version_snapshot is null
      or v_existing.target_authorized_property_ids_snapshot is null
      or v_existing.actor_authority_version_snapshot
           is distinct from v_actor_state.authority_version
      or v_existing.target_authority_version_snapshot
           is distinct from v_target_state.authority_version
      or v_existing.target_authorized_property_ids_snapshot
           is distinct from v_target_property_ids
    ) then
      return jsonb_build_object('status', 'conflict');
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
  from public.account_lifecycle_intents intent
  where intent.account_id = p_target_account_id and intent.status = 'pending'
  for update;
  if found then return jsonb_build_object('status', 'pending_conflict'); end if;
  if exists (
    select 1 from public.account_lifecycle_intents processing
    where processing.account_id = p_target_account_id
      and processing.processor_token is not null
      and processing.processor_lease_expires_at > clock_timestamp()
  ) then
    return jsonb_build_object('status', 'retry');
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

  if not p_desired_active
     and public._staxis_account_is_live_organization_owner(v_target.id)
  then
    return jsonb_build_object(
      'status', 'forbidden', 'reason', 'organization_owner'
    );
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
    actor_account_id, actor_auth_user_id, actor_email, hotel_id,
    actor_authority_version_snapshot,
    target_authority_version_snapshot,
    target_authorized_property_ids_snapshot
  ) values (
    p_operation_id, v_target.id, v_version, p_desired_active, v_target.active,
    v_target.data_user_id, v_target.role, v_target.property_access,
    v_actor.id, p_actor_auth_user_id, nullif(btrim(p_actor_email), ''), p_hotel_id,
    v_actor_state.authority_version, v_target_state.authority_version,
    v_target_property_ids
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

-- The processor changes Auth before this RPC. If either side lost authority
-- after registration, return invariant_conflict so the existing processor
-- restores the verified pre-change Auth snapshot and aborts the intent.
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
  v_actor public.accounts%rowtype;
  v_target public.accounts%rowtype;
  v_actor_state public.account_authorization_state%rowtype;
  v_target_state public.account_authorization_state%rowtype;
  v_target_property_ids uuid[] := '{}'::uuid[];
  v_property_id uuid;
  v_state_changed boolean;
begin
  select account_id into v_account_id
  from public.account_lifecycle_intents intent
  where intent.operation_id = p_operation_id;
  if v_account_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  select * into v_intent
  from public.account_lifecycle_intents intent
  where intent.operation_id = p_operation_id;
  perform 1
  from public.accounts account
  where account.id = any(array[v_intent.actor_account_id, v_account_id])
  order by account.id
  for update;
  perform 1
  from public.account_authorization_state state
  where state.account_id = any(array[v_intent.actor_account_id, v_account_id])
  order by state.account_id
  for update;
  select * into v_intent
  from public.account_lifecycle_intents intent
  where intent.operation_id = p_operation_id
  for update;
  select * into v_actor from public.accounts
    where id = v_intent.actor_account_id;
  select * into v_target from public.accounts where id = v_account_id;
  select * into v_actor_state from public.account_authorization_state
    where account_id = v_intent.actor_account_id;
  select * into v_target_state from public.account_authorization_state
    where account_id = v_account_id;

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
        when v_intent.auth_snapshot_recorded_at is null
          then 'auth_snapshot_missing'
        else 'target_snapshot_changed'
      end
    );
  end if;

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
  exception
    when lock_not_available then
      return jsonb_build_object('status', 'retry');
  end;

  if v_actor.id is null or v_target.id is null
     or v_actor_state.account_id is null or v_target_state.account_id is null
     or v_intent.actor_authority_version_snapshot is null
     or v_intent.target_authority_version_snapshot is null
     or v_intent.target_authorized_property_ids_snapshot is null
     or not v_actor.active
     or v_actor.data_user_id <> v_intent.actor_auth_user_id
     or v_actor_state.authority_version
          is distinct from v_intent.actor_authority_version_snapshot
     or v_target_state.authority_version
          is distinct from v_intent.target_authority_version_snapshot
  then
    return jsonb_build_object(
      'status', 'invariant_conflict', 'reason', 'authorization_changed'
    );
  end if;

  v_target_property_ids := public._staxis_structural_account_property_ids(
    v_target.id
  );
  if cardinality(v_target_property_ids) = 0
     or v_target_property_ids is distinct from
          v_intent.target_authorized_property_ids_snapshot
     or not (v_intent.hotel_id = any(v_target_property_ids))
  then
    return jsonb_build_object(
      'status', 'invariant_conflict', 'reason', 'target_scope_changed'
    );
  end if;

  if v_actor.role <> 'admin' then
    foreach v_property_id in array v_target_property_ids
    loop
      if not public._staxis_account_can_manage_users_at_property(
        v_actor.id, v_property_id
      ) then
        return jsonb_build_object(
          'status', 'invariant_conflict', 'reason', 'actor_scope_changed'
        );
      end if;
    end loop;
    if v_target.role = 'general_manager' and exists (
      select 1 from unnest(v_target_property_ids) property_id
      where not public._staxis_account_has_company_manager_hierarchy_at_property(
              v_actor.id, property_id
            )
        and public._staxis_account_operational_role_at_property(
              v_actor.id, property_id
            ) <> 'owner'
    ) then
      return jsonb_build_object(
        'status', 'invariant_conflict', 'reason', 'actor_hierarchy_changed'
      );
    end if;
  end if;

  if not v_intent.desired_active
     and public._staxis_account_is_live_organization_owner(v_target.id)
  then
    return jsonb_build_object(
      'status', 'invariant_conflict', 'reason', 'organization_owner'
    );
  end if;

  perform set_config('staxis.actor_account_id', v_intent.actor_account_id::text, true);
  perform set_config(
    'staxis.account_lifecycle_operation_id', v_intent.operation_id::text, true
  );
  v_state_changed := v_target.active is distinct from v_intent.desired_active;
  if v_state_changed then
    update public.accounts
       set active = v_intent.desired_active,
           lifecycle_committed_version = v_intent.version
     where id = v_target.id;
  else
    update public.accounts
       set lifecycle_committed_version = v_intent.version
     where id = v_target.id;
  end if;

  insert into public.role_changes (
    account_id, property_id, changed_by_account_id,
    old_role, new_role, change_kind, reason
  )
  select v_target.id, affected_hotel.property_id, v_intent.actor_account_id,
         v_target.role, v_target.role,
         case when v_intent.desired_active then 'reactivate' else 'deactivate' end,
         null
  from unnest(v_target_property_ids) affected_hotel(property_id);

  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, metadata
  ) values (
    v_intent.actor_auth_user_id,
    v_intent.actor_email,
    case when v_intent.desired_active
      then 'account.reactivate' else 'account.deactivate' end,
    'account',
    v_target.id::text,
    jsonb_build_object(
      'hotel_id', v_intent.hotel_id,
      'role', v_target.role,
      'sign_in_blocked', not v_intent.desired_active,
      'global_account_change', true,
      'affected_hotel_ids', to_jsonb(v_target_property_ids),
      'authority_mode', v_target_state.authority_mode,
      'actor_authority_version', v_actor_state.authority_version,
      'target_authority_version', v_target_state.authority_version,
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

-- Global account-role changes remain a legacy-account operation, but company
-- managers may operate acquired-hotel legacy people when they control every
-- current hotel on that account. Normalized targets always use Access.
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
  v_actor_state public.account_authorization_state%rowtype;
  v_target_state public.account_authorization_state%rowtype;
  v_target_property_ids uuid[] := '{}'::uuid[];
  v_property_id uuid;
  v_actor_role text;
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
  v_display_name := case when p_new_display_name is null then null
    else nullif(btrim(p_new_display_name), '') end;
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
  perform 1
  from public.account_authorization_state state
  where state.account_id = any(array[p_actor_account_id, p_target_account_id])
  order by state.account_id
  for update;
  select * into v_actor from public.accounts where id = p_actor_account_id;
  select * into v_target from public.accounts where id = p_target_account_id;
  select * into v_actor_state from public.account_authorization_state
    where account_id = p_actor_account_id;
  select * into v_target_state from public.account_authorization_state
    where account_id = p_target_account_id;
  if v_actor.id is null or v_target.id is null
     or v_actor_state.account_id is null or v_target_state.account_id is null
  then
    return jsonb_build_object('status', 'not_found');
  end if;
  if exists (
    select 1 from public.account_lifecycle_intents intent
    where intent.status = 'pending'
      and intent.account_id = any(array[p_actor_account_id, p_target_account_id])
  ) then
    return jsonb_build_object('status', 'pending_conflict');
  end if;

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
  exception
    when lock_not_available then
      return jsonb_build_object('status', 'retry');
  end;

  if not v_actor.active or v_actor.data_user_id <> p_actor_auth_user_id then
    return jsonb_build_object('status', 'forbidden', 'reason', 'actor');
  end if;
  if v_target_state.authority_mode not in ('legacy', 'shadow') then
    return jsonb_build_object('status', 'forbidden', 'reason', 'normalized_authority');
  end if;
  if not v_target.active or v_target.role in ('admin', 'owner') then
    return jsonb_build_object('status', 'forbidden', 'reason', 'target');
  end if;
  if public._staxis_account_is_live_organization_owner(v_target.id) then
    return jsonb_build_object('status', 'forbidden', 'reason', 'organization_owner');
  end if;

  v_target_property_ids := public._staxis_structural_account_property_ids(
    v_target.id
  );
  if cardinality(v_target_property_ids) = 0
     or not (p_hotel_id = any(v_target_property_ids))
  then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_actor.role <> 'admin' then
    foreach v_property_id in array v_target_property_ids
    loop
      if not public._staxis_account_can_manage_users_at_property(
        v_actor.id, v_property_id
      ) then
        return jsonb_build_object('status', 'forbidden', 'reason', 'manage_users');
      end if;
      v_actor_role := public._staxis_account_operational_role_at_property(
        v_actor.id, v_property_id
      );
      if v_target.role = 'general_manager'
         and not public._staxis_account_has_company_manager_hierarchy_at_property(
           v_actor.id, v_property_id
         )
         and v_actor_role <> 'owner'
      then
        return jsonb_build_object('status', 'forbidden', 'reason', 'hierarchy');
      end if;
      if p_new_role = 'general_manager'
         and not public._staxis_account_has_company_manager_hierarchy_at_property(
           v_actor.id, v_property_id
         )
         and v_actor_role <> 'owner'
      then
        return jsonb_build_object('status', 'forbidden', 'reason', 'promotion');
      end if;
    end loop;
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
  select v_target.id, affected_hotel.property_id, v_actor.id,
         v_target.role, p_new_role, 'role_change', null
  from unnest(v_target_property_ids) affected_hotel(property_id);

  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, metadata
  ) values (
    p_actor_auth_user_id, nullif(btrim(p_actor_email), ''),
    'account.team_update', 'account', v_target.id::text,
    jsonb_build_object(
      'hotel_id', p_hotel_id,
      'affected_hotel_ids', to_jsonb(v_target_property_ids),
      'authority_mode', v_target_state.authority_mode,
      'actor_authority_version', v_actor_state.authority_version,
      'target_authority_version', v_target_state.authority_version,
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

-- Display-name and staff-identity changes are global/account identity writes,
-- not presentation-only edits. Re-resolve the actor, target topology, hotel
-- mutation standing, hierarchy, and complete target scope under the same
-- transaction that mutates accounts + the normalized staff link + audit.
-- This closes the route's former check/write window on revocation and hotel
-- transfer and keeps foreign staff IDs from becoming a cross-hotel oracle.
create or replace function public.staxis_update_hotel_team_profile_guarded(
  p_actor_account_id uuid,
  p_actor_auth_user_id uuid,
  p_actor_email text,
  p_hotel_id uuid,
  p_target_account_id uuid,
  p_change_display_name boolean,
  p_new_display_name text,
  p_change_staff_link boolean,
  p_new_staff_id uuid,
  p_expected_active boolean,
  p_expected_role text,
  p_expected_auth_user_id uuid,
  p_expected_property_access uuid[],
  p_expected_target_property_ids uuid[],
  p_expected_display_name text,
  p_expected_staff_id uuid,
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
  v_actor_state public.account_authorization_state%rowtype;
  v_target_state public.account_authorization_state%rowtype;
  v_target_property_ids uuid[] := '{}'::uuid[];
  v_expected_property_ids uuid[] := '{}'::uuid[];
  v_required_property_ids uuid[] := '{}'::uuid[];
  v_property_id uuid;
  v_context jsonb;
  v_context_role text;
  v_display_name text;
  v_display_changed boolean := false;
  v_staff_changed boolean := false;
  v_link_changed boolean := false;
  v_now timestamptz := clock_timestamp();
begin
  if p_actor_account_id is null or p_actor_auth_user_id is null
     or p_hotel_id is null or p_target_account_id is null
     or p_change_display_name is null or p_change_staff_link is null
     or (not p_change_display_name and not p_change_staff_link)
     or p_expected_active is null or p_expected_role is null
     or p_expected_auth_user_id is null
     or p_expected_target_property_ids is null
     or p_expected_updated_at is null or p_expected_intent_version is null
  then
    return jsonb_build_object('status', 'invalid');
  end if;
  if (not p_change_display_name and p_new_display_name is not null)
     or (not p_change_staff_link and p_new_staff_id is not null)
     or cardinality(p_expected_target_property_ids) not between 1 and 5000
     or exists (
       select 1 from unnest(p_expected_target_property_ids) expected(property_id)
       where expected.property_id is null
     )
  then
    return jsonb_build_object('status', 'invalid');
  end if;
  select coalesce(array_agg(distinct expected.property_id order by expected.property_id), '{}'::uuid[])
    into v_expected_property_ids
  from unnest(p_expected_target_property_ids) expected(property_id);
  if v_expected_property_ids is distinct from p_expected_target_property_ids
     or not (p_hotel_id = any(v_expected_property_ids))
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  if p_change_display_name then
    v_display_name := nullif(btrim(p_new_display_name), '');
    if v_display_name is null or char_length(v_display_name) > 120 then
      return jsonb_build_object('status', 'invalid', 'reason', 'display_name');
    end if;
  end if;

  -- Follow the lifecycle/role/detach lock order: account + authority-state
  -- rows first, then authority topology tables. The table locks make the
  -- projection repeatable through commit; NOWAIT breaks a cycle with an
  -- in-flight transfer/revocation into a bounded retry.
  begin
    perform 1
    from public.accounts account
    where account.id = any(array[p_actor_account_id, p_target_account_id])
    order by account.id
    for update nowait;
    perform 1
    from public.account_authorization_state state
    where state.account_id = any(array[p_actor_account_id, p_target_account_id])
    order by state.account_id
    for update nowait;
    lock table public.capability_overrides,
               public.organizations,
               public.organization_property_relationships,
               public.organization_memberships,
               public.organization_access_grants,
               public.portfolios,
               public.portfolio_properties,
               public.account_property_authorization_bridges
      in share mode nowait;
  exception
    when lock_not_available or deadlock_detected then
      return jsonb_build_object('status', 'retry');
  end;

  select * into v_actor from public.accounts where id = p_actor_account_id;
  select * into v_target from public.accounts where id = p_target_account_id;
  select * into v_actor_state from public.account_authorization_state
    where account_id = p_actor_account_id;
  select * into v_target_state from public.account_authorization_state
    where account_id = p_target_account_id;
  if v_actor.id is null or v_target.id is null
     or v_actor_state.account_id is null or v_target_state.account_id is null
  then
    return jsonb_build_object('status', 'not_found');
  end if;
  if not v_actor.active or v_actor.data_user_id <> p_actor_auth_user_id then
    return jsonb_build_object('status', 'forbidden', 'reason', 'actor');
  end if;
  if v_target.role = 'admin' then
    return jsonb_build_object('status', 'forbidden', 'reason', 'target');
  end if;
  if exists (
    select 1 from public.account_lifecycle_intents intent
    where intent.status = 'pending'
      and intent.account_id = any(array[p_actor_account_id, p_target_account_id])
  ) then
    return jsonb_build_object('status', 'pending_conflict');
  end if;

  v_target_property_ids := public._staxis_structural_account_property_ids(v_target.id);
  if cardinality(v_target_property_ids) = 0
     or cardinality(v_target_property_ids) > 5000
     or not (p_hotel_id = any(v_target_property_ids))
  then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_target_property_ids is distinct from v_expected_property_ids
     or v_target.active is distinct from p_expected_active
     or v_target.role is distinct from p_expected_role
     or v_target.data_user_id is distinct from p_expected_auth_user_id
     or v_target.property_access is distinct from p_expected_property_access
     or v_target.display_name is distinct from p_expected_display_name
     or v_target.staff_id is distinct from p_expected_staff_id
     or v_target.updated_at is distinct from p_expected_updated_at
     or v_target.lifecycle_intent_version is distinct from p_expected_intent_version
  then
    return jsonb_build_object('status', 'conflict');
  end if;

  -- Normalized identity/scope belongs to Access. Only a person's own display
  -- name may use this endpoint; staff linkage remains a legacy/shadow bridge.
  if v_target_state.authority_mode = 'normalized'
     and (p_change_staff_link or p_actor_account_id <> p_target_account_id)
  then
    return jsonb_build_object('status', 'forbidden', 'reason', 'normalized_authority');
  end if;
  if p_change_staff_link
     and (v_target_state.authority_mode not in ('legacy', 'shadow')
       or cardinality(v_target_property_ids) <> 1)
  then
    return jsonb_build_object('status', 'forbidden', 'reason', 'staff_scope');
  end if;

  -- An other-person display-name edit is global, so the actor must retain
  -- private hotel mutation standing at every hotel attached to the target.
  -- Self display-name edits need the selected hotel's standing only. Staff
  -- links are already constrained to exactly one selected hotel above.
  v_required_property_ids := case
    when p_change_display_name and p_actor_account_id <> p_target_account_id
      then v_target_property_ids
    else array[p_hotel_id]::uuid[]
  end;
  foreach v_property_id in array v_required_property_ids
  loop
    v_context := public._staxis_manage_team_context(v_actor.id, v_property_id);
    if coalesce((v_context->>'allowed')::boolean, false) is not true then
      return jsonb_build_object('status', 'forbidden', 'reason', 'manage_team');
    end if;
    v_context_role := v_context->>'role';
    if p_actor_account_id <> p_target_account_id
       and v_target.role = 'owner'
       and v_context_role not in ('admin', 'owner')
    then
      return jsonb_build_object('status', 'forbidden', 'reason', 'hierarchy');
    end if;
    if p_actor_account_id <> p_target_account_id
       and v_target.role = 'general_manager'
       and v_context_role not in ('admin', 'owner')
    then
      return jsonb_build_object('status', 'forbidden', 'reason', 'hierarchy');
    end if;
  end loop;

  if p_change_staff_link and p_new_staff_id is not null then
    begin
      perform 1
      from public.staff staff_row
      where staff_row.id = p_new_staff_id
        and staff_row.property_id = p_hotel_id
        and staff_row.is_active is true
      for update nowait;
    exception
      when lock_not_available or deadlock_detected then
        return jsonb_build_object('status', 'retry');
    end;
    if not found then
      return jsonb_build_object('status', 'not_found');
    end if;
  end if;
  if p_change_staff_link then
    begin
      perform 1
      from public.account_property_staff_links staff_link
      where (staff_link.account_id = v_target.id
             and staff_link.property_id = p_hotel_id)
         or (p_new_staff_id is not null
             and staff_link.staff_id = p_new_staff_id
             and staff_link.is_active is true)
      order by staff_link.account_id, staff_link.property_id
      for update nowait;
    exception
      when lock_not_available or deadlock_detected then
        return jsonb_build_object('status', 'retry');
    end;
  end if;
  if p_change_staff_link and p_new_staff_id is not null then
    if exists (
      select 1 from public.accounts other_account
      where other_account.id <> v_target.id
        and other_account.staff_id = p_new_staff_id
    ) or exists (
      select 1 from public.account_property_staff_links other_link
      where other_link.account_id <> v_target.id
        and other_link.staff_id = p_new_staff_id
        and other_link.is_active is true
    ) then
      return jsonb_build_object('status', 'conflict', 'reason', 'staff_in_use');
    end if;
  end if;

  v_display_changed := p_change_display_name
    and v_target.display_name is distinct from v_display_name;
  v_staff_changed := p_change_staff_link
    and v_target.staff_id is distinct from p_new_staff_id;
  v_link_changed := p_change_staff_link and (
    (p_new_staff_id is not null and not exists (
      select 1 from public.account_property_staff_links current_link
      where current_link.account_id = v_target.id
        and current_link.property_id = p_hotel_id
        and current_link.staff_id = p_new_staff_id
        and current_link.is_active is true
    ))
    or (p_new_staff_id is null and exists (
      select 1 from public.account_property_staff_links current_link
      where current_link.account_id = v_target.id
        and current_link.property_id = p_hotel_id
        and current_link.is_active is true
    ))
  );
  if not v_display_changed and not v_staff_changed and not v_link_changed then
    return jsonb_build_object('status', 'noop');
  end if;

  perform set_config('staxis.actor_account_id', v_actor.id::text, true);
  perform set_config('staxis.request_id', coalesce(p_request_id, ''), true);
  begin
    update public.accounts
       set display_name = case when v_display_changed then v_display_name else display_name end,
           staff_id = case when p_change_staff_link then p_new_staff_id else staff_id end,
           updated_at = v_now
     where id = v_target.id;

    if p_change_staff_link and p_new_staff_id is null then
      update public.account_property_staff_links staff_link
         set is_active = false,
             deactivated_at = v_now,
             deactivated_by_account_id = v_actor.id,
             updated_at = v_now
       where staff_link.account_id = v_target.id
         and staff_link.property_id = p_hotel_id
         and staff_link.is_active is true;
    elsif p_change_staff_link then
      insert into public.account_property_staff_links (
        account_id, property_id, staff_id, is_active, source,
        linked_by_account_id, linked_at, deactivated_at,
        deactivated_by_account_id, updated_at
      ) values (
        v_target.id, p_hotel_id, p_new_staff_id, true, 'manual',
        v_actor.id, v_now, null, null, v_now
      )
      on conflict (account_id, property_id) do update
        set staff_id = excluded.staff_id,
            is_active = true,
            source = 'manual',
            linked_by_account_id = excluded.linked_by_account_id,
            linked_at = case
              when account_property_staff_links.staff_id is distinct from excluded.staff_id
                or account_property_staff_links.is_active is false
                then excluded.linked_at
              else account_property_staff_links.linked_at
            end,
            deactivated_at = null,
            deactivated_by_account_id = null,
            updated_at = excluded.updated_at;
    end if;

    insert into public.admin_audit_log (
      actor_user_id, actor_email, action, target_type, target_id, metadata
    ) values (
      p_actor_auth_user_id, nullif(btrim(p_actor_email), ''),
      'account.team_update', 'account', v_target.id::text,
      jsonb_build_object(
        'hotel_id', p_hotel_id,
        'affected_hotel_ids', to_jsonb(v_target_property_ids),
        'authority_mode', v_target_state.authority_mode,
        'actor_authority_version', v_actor_state.authority_version,
        'target_authority_version', v_target_state.authority_version,
        'display_name_changed', v_display_changed,
        'role_changed', null,
        'password_reset', false,
        'staff_link_changed', v_staff_changed or v_link_changed,
        'request_id', p_request_id
      )
    );
  exception
    when unique_violation or foreign_key_violation or check_violation then
      return jsonb_build_object('status', 'conflict', 'reason', 'staff_link');
  end;

  return jsonb_build_object(
    'status', 'ok',
    'audit_written', true,
    'display_name_changed', v_display_changed,
    'staff_link_changed', v_staff_changed or v_link_changed
  );
end;
$$;

-- Actor-bound replacement for the old four-argument detach helper. Exact
-- hotel detach is safe for a multi-hotel legacy account because it changes no
-- global role; target and actor reach are both re-resolved under locks.
create or replace function public.staxis_remove_property_access_guarded_v2(
  p_actor_account_id uuid,
  p_actor_auth_user_id uuid,
  p_actor_email text,
  p_account_id uuid,
  p_hotel_id uuid,
  p_expected_role text,
  p_expected_updated_at timestamptz,
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
  v_actor_state public.account_authorization_state%rowtype;
  v_target_state public.account_authorization_state%rowtype;
  v_target_property_ids uuid[] := '{}'::uuid[];
  v_remaining_hotels integer;
  v_actor_role text;
begin
  if p_actor_account_id is null or p_actor_auth_user_id is null
     or p_account_id is null or p_hotel_id is null
     or p_expected_role is null or p_expected_updated_at is null
  then
    return jsonb_build_object('status', 'invalid');
  end if;
  if p_actor_account_id = p_account_id then
    return jsonb_build_object('status', 'forbidden', 'reason', 'self');
  end if;

  perform 1
  from public.accounts account
  where account.id = any(array[p_actor_account_id, p_account_id])
  order by account.id
  for update;
  perform 1
  from public.account_authorization_state state
  where state.account_id = any(array[p_actor_account_id, p_account_id])
  order by state.account_id
  for update;
  select * into v_actor from public.accounts where id = p_actor_account_id;
  select * into v_target from public.accounts where id = p_account_id;
  select * into v_actor_state from public.account_authorization_state
    where account_id = p_actor_account_id;
  select * into v_target_state from public.account_authorization_state
    where account_id = p_account_id;
  if v_actor.id is null or v_target.id is null
     or v_actor_state.account_id is null or v_target_state.account_id is null
  then
    return jsonb_build_object('status', 'not_found');
  end if;
  if exists (
    select 1 from public.account_lifecycle_intents intent
    where intent.status = 'pending'
      and intent.account_id = any(array[p_actor_account_id, p_account_id])
  ) then
    return jsonb_build_object('status', 'pending_conflict');
  end if;

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
  exception
    when lock_not_available then
      return jsonb_build_object('status', 'retry');
  end;

  if not v_actor.active or v_actor.data_user_id <> p_actor_auth_user_id then
    return jsonb_build_object('status', 'forbidden', 'reason', 'actor');
  end if;
  if v_target_state.authority_mode not in ('legacy', 'shadow') then
    return jsonb_build_object('status', 'forbidden', 'reason', 'normalized_authority');
  end if;
  if v_target.role in ('admin', 'owner') then
    return jsonb_build_object('status', 'forbidden', 'reason', 'target');
  end if;
  if public._staxis_account_is_live_organization_owner(v_target.id) then
    return jsonb_build_object('status', 'forbidden', 'reason', 'organization_owner');
  end if;

  v_target_property_ids := public._staxis_structural_account_property_ids(
    v_target.id
  );
  if not (p_hotel_id = any(v_target_property_ids)) then
    return jsonb_build_object('status', 'not_attached');
  end if;
  if not public._staxis_account_can_manage_users_at_property(
    v_actor.id, p_hotel_id
  ) then
    return jsonb_build_object('status', 'forbidden', 'reason', 'manage_users');
  end if;
  if v_actor.role <> 'admin' and v_target.role = 'general_manager' then
    v_actor_role := public._staxis_account_operational_role_at_property(
      v_actor.id, p_hotel_id
    );
    if not public._staxis_account_has_company_manager_hierarchy_at_property(
         v_actor.id, p_hotel_id
       )
       and v_actor_role <> 'owner'
    then
      return jsonb_build_object('status', 'forbidden', 'reason', 'hierarchy');
    end if;
  end if;
  if v_target.role is distinct from p_expected_role
     or v_target.updated_at is distinct from p_expected_updated_at
  then
    return jsonb_build_object('status', 'conflict');
  end if;

  perform set_config('staxis.actor_account_id', v_actor.id::text, true);
  perform set_config('staxis.request_id', coalesce(p_request_id, ''), true);
  update public.accounts
     set property_access = array_remove(
           coalesce(v_target.property_access, '{}'::uuid[]), p_hotel_id
         ),
         updated_at = now()
   where id = v_target.id
   returning coalesce(array_length(property_access, 1), 0)
     into v_remaining_hotels;

  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, metadata
  ) values (
    p_actor_auth_user_id, nullif(btrim(p_actor_email), ''),
    'account.team_detach', 'account', v_target.id::text,
    jsonb_build_object(
      'hotel_id', p_hotel_id,
      'remaining_hotels', v_remaining_hotels,
      'affected_hotel_ids_before', to_jsonb(v_target_property_ids),
      'authority_mode', v_target_state.authority_mode,
      'actor_authority_version', v_actor_state.authority_version,
      'target_authority_version', v_target_state.authority_version,
      'request_id', p_request_id
    )
  );
  return jsonb_build_object(
    'status', 'ok',
    'remaining_hotels', v_remaining_hotels,
    'audit_written', true
  );
end;
$$;

revoke all on function public.staxis_register_account_lifecycle_intent(
  uuid,uuid,uuid,text,uuid,uuid,boolean,boolean,text,uuid,uuid[],bigint
) from public, anon, authenticated;
grant execute on function public.staxis_register_account_lifecycle_intent(
  uuid,uuid,uuid,text,uuid,uuid,boolean,boolean,text,uuid,uuid[],bigint
) to service_role;

revoke all on function public.staxis_commit_account_lifecycle_intent(uuid,text,uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_commit_account_lifecycle_intent(uuid,text,uuid)
  to service_role;

revoke all on function public.staxis_change_hotel_team_role_guarded(
  uuid,uuid,text,uuid,uuid,text,text,boolean,text,uuid,uuid[],text,
  timestamptz,bigint,text
) from public, anon, authenticated;
grant execute on function public.staxis_change_hotel_team_role_guarded(
  uuid,uuid,text,uuid,uuid,text,text,boolean,text,uuid,uuid[],text,
  timestamptz,bigint,text
) to service_role;

revoke all on function public.staxis_update_hotel_team_profile_guarded(
  uuid,uuid,text,uuid,uuid,boolean,text,boolean,uuid,boolean,text,uuid,
  uuid[],uuid[],text,uuid,timestamptz,bigint,text
) from public, anon, authenticated;
grant execute on function public.staxis_update_hotel_team_profile_guarded(
  uuid,uuid,text,uuid,uuid,boolean,text,boolean,uuid,boolean,text,uuid,
  uuid[],uuid[],text,uuid,timestamptz,bigint,text
) to service_role;

-- No service caller may use the identity-free compatibility detach after this
-- migration. The application and support tooling must supply an actor to v2.
revoke execute on function public.staxis_remove_property_access_guarded(
  uuid,uuid,text,timestamptz
) from service_role;
revoke all on function public.staxis_remove_property_access_guarded_v2(
  uuid,uuid,text,uuid,uuid,text,timestamptz,text
) from public, anon, authenticated;
grant execute on function public.staxis_remove_property_access_guarded_v2(
  uuid,uuid,text,uuid,uuid,text,timestamptz,text
) to service_role;

insert into public.applied_migrations(version, description)
values (
  '0395',
  'Authoritative actor-bound People lifecycle, guarded profile/staff identity commits, acquired-hotel legacy role/detach management, inactive normalized roster scope, and commit-time revocation fences.'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
