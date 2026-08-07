-- 0461 — Company invites get a "which hotels" answer, and two job words.
--
-- ─── WHAT CHANGES, IN ONE PARAGRAPH ────────────────────────────────────────
--
-- A company-scope hat used to mean "every hotel this company operates, now and
-- forever". That is wrong for the customers we have: a management company runs
-- hotels for DIFFERENT ownership groups, so an Owner of 3 of 20 hotels must
-- never see the other 17. From here a company hat carries EITHER an explicit
-- hotel list in `covered_property_ids` OR NULL, which keeps the old
-- all-including-future meaning. Both are selectable; neither is a default that
-- leaks.
--
-- At the same time the company vocabulary collapses from three words to two:
--   vp      -> regional_manager   renamed, same job
--   finance -> regional_manager   retired; the people become regional managers
--
-- Independent hotels (no company) are untouched by every statement here. Their
-- invites carry organization_id IS NULL and never reach any of this.
--
-- ─── ORDER MATTERS ─────────────────────────────────────────────────────────
--
-- 1. Drop the CHECKs first: the new words are illegal until they are gone.
-- 2. Convert stored data (hats, invitations, approval rules).
-- 3. Re-add the CHECKs in their new shape.
-- 4. Redefine the 16 functions that read these words.
--
-- Step 4 is the dangerous one and is why this migration is long: 16 live
-- functions branch on the retired words. A function left behind would not
-- error, it would silently stop recognizing somebody's authority. Each body
-- below is the CURRENT definition with only the role words and the coverage
-- rule changed; signatures are untouched, so `create or replace` preserves
-- every existing grant.
--
-- NOT APPLIED BY THIS FILE. Apply manually, then `notify pgrst`.

begin;

-- ─── 1. Drop the constraints that forbid the new vocabulary ────────────────

alter table public.organization_memberships
  drop constraint if exists organization_memberships_hat_shape_check;
alter table public.account_invites
  drop constraint if exists account_invites_hat_shape_check;
alter table public.account_invites
  drop constraint if exists account_invites_role_check;
alter table public.company_authority_rules
  drop constraint if exists company_authority_rules_approver_ck;

-- ─── 2. Convert stored data ────────────────────────────────────────────────

-- A person could hold BOTH a vp hat and a finance hat at one company. Both
-- become regional_manager, which would collide on the one-hat-per-job unique
-- index. Retire the finance row first and keep the vp one: same person, same
-- company, and the surviving row carries the wider job.
update public.organization_memberships finance_hat
   set status = 'ended',
       ended_at = now(),
       updated_at = now()
 where finance_hat.membership_scope = 'company'
   and finance_hat.staxis_role = 'finance'
   and finance_hat.ended_at is null
   and exists (
     select 1
     from public.organization_memberships peer
     where peer.organization_id = finance_hat.organization_id
       and peer.account_id = finance_hat.account_id
       and peer.membership_scope = 'company'
       and peer.staxis_role = 'vp'
       and peer.ended_at is null
   );

-- The rename itself. `covered_property_ids` is deliberately NOT touched: every
-- existing company hat keeps NULL, so every existing company person keeps the
-- all-hotels-including-future reach they have today. Nobody loses access on the
-- day this is applied.
update public.organization_memberships
   set staxis_role = 'regional_manager',
       job_category = case
         when job_category in ('finance', 'regional_manager') then 'regional_manager'
         else job_category
       end,
       updated_at = now()
 where membership_scope = 'company'
   and staxis_role in ('vp', 'finance');

-- Pending invitations that promised the retired words now promise the surviving
-- one, so a link already sitting in somebody's inbox still works.
update public.account_invites
   set role = 'regional_manager'
 where membership_scope = 'company'
   and role in ('vp', 'finance');

-- Approval rules name a job that has to keep existing, or the card they lock
-- would come unstuck. `mapRule` in src/lib/company/authority.ts now fails
-- CLOSED on a word it cannot read, but the right fix is that there is no such
-- word left to read.
update public.company_authority_rules
   set approver_role = 'regional_manager'
 where approver_role in ('vp', 'finance');

-- ─── 3. Re-add the constraints, in their new shape ─────────────────────────

alter table public.organization_memberships
  add constraint organization_memberships_hat_shape_check check (
    -- Legacy employment record: all three columns absent, together.
    (membership_scope is null and staxis_role is null and covered_property_ids is null)
    -- Company hat: NULL coverage means every hotel the company operates now and
    -- later; an explicit list means exactly those hotels and no future ones.
    or (membership_scope = 'company'
        and staxis_role in ('owner', 'regional_manager')
        and (covered_property_ids is null
          or (array_length(covered_property_ids, 1) >= 1
            and array_position(covered_property_ids, null) is null)))
    -- Property hat: an explicit, non-empty, null-free list of hotels.
    or (membership_scope = 'property'
        and staxis_role in ('general_manager', 'front_desk', 'housekeeping', 'maintenance')
        and covered_property_ids is not null
        and array_length(covered_property_ids, 1) >= 1
        and array_position(covered_property_ids, null) is null)
  );

alter table public.account_invites
  add constraint account_invites_role_check check (
    role in (
      'owner', 'regional_manager', 'general_manager',
      'front_desk', 'housekeeping', 'maintenance'
    )
  );

alter table public.account_invites
  add constraint account_invites_hat_shape_check check (
    (membership_scope is null and organization_id is null and covered_property_ids is null)
    or (membership_scope = 'company'
        and organization_id is not null
        and role in ('owner', 'regional_manager')
        and (covered_property_ids is null
          or (array_length(covered_property_ids, 1) >= 1
            and array_position(covered_property_ids, null) is null)))
    or (membership_scope = 'property'
        and organization_id is not null
        and covered_property_ids is not null
        and array_length(covered_property_ids, 1) >= 1
        and array_position(covered_property_ids, null) is null
        and role in ('general_manager', 'front_desk', 'housekeeping', 'maintenance'))
  );

alter table public.company_authority_rules
  add constraint company_authority_rules_approver_ck check (
    approver_role in ('owner', 'regional_manager', 'general_manager')
  );

comment on column public.organization_memberships.staxis_role is
  'The authorizing job. Company scope: owner|regional_manager. Property scope: general_manager|front_desk|housekeeping|maintenance. Paired with covered_property_ids, which for a company hat is NULL for "all hotels including future" or an explicit list. job_category next door is descriptive only and has its own, larger vocabulary. Reshaped 0461.';

-- ─── 4. The 16 functions that read these words ─────────────────────────────
--
-- Signatures are unchanged throughout, so grants survive `create or replace`.

-- ── 4.1 _staxis_nonlegacy_property_authorizations ─────────────────────────

create or replace function public._staxis_nonlegacy_property_authorizations(
  p_account_id uuid
)
returns table (
  account_id uuid,
  organization_id uuid,
  property_id uuid,
  entitlement_kind text,
  entitlement_id uuid,
  membership_id uuid,
  access_profile text,
  staxis_role text,
  scope_type text,
  portfolio_id uuid,
  can_portfolio_intelligence boolean
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with recursive
  live_account as (
    select a.id
    from public.accounts a
    where a.id = p_account_id
      and a.active is true
      and a.role <> 'admin'
  ),
  governing_relationships as (
    select r.id, r.organization_id, r.property_id
    from public._staxis_current_primary_property_relationships() r
    join public.organizations o
      on o.id = r.organization_id
     and o.status = 'active'
     and o.organization_type <> 'single_hotel'
    where r.active_primary_count = 1
  ),
  active_memberships as (
    select m.*
    from public.organization_memberships m
    join live_account a on a.id = m.account_id
    join public.organizations o
      on o.id = m.organization_id
     and o.status = 'active'
     and o.organization_type <> 'single_hotel'
    where m.status = 'active'
      and m.starts_at <= now()
      and m.ended_at is null
  ),
  active_hats as (
    select m.*
    from active_memberships m
    where (m.membership_scope = 'company'
             and m.staxis_role in ('owner', 'regional_manager'))
       or (m.membership_scope = 'property'
             and m.staxis_role in (
               'general_manager', 'front_desk', 'housekeeping', 'maintenance'
             ))
  ),
  active_grants as (
    select g.*
    from public.organization_access_grants g
    join active_memberships m
      on m.id = g.membership_id
     and m.organization_id = g.organization_id
    where g.status = 'active'
      and g.source <> 'legacy_backfill'
      and g.starts_at <= now()
      and (g.expires_at is null or g.expires_at > now())
  ),
  portfolio_grant_tree (
    grant_id, organization_id, membership_id, access_profile,
    scope_type, root_portfolio_id, portfolio_id
  ) as (
    select g.id, g.organization_id, g.membership_id, g.access_profile,
           g.scope_type, g.portfolio_id, p.id
    from active_grants g
    join public.portfolios p
      on p.id = g.portfolio_id
     and p.organization_id = g.organization_id
     and p.status = 'active'
    where g.scope_type = 'portfolio'

    union

    select tree.grant_id, tree.organization_id, tree.membership_id,
           tree.access_profile, tree.scope_type, tree.root_portfolio_id, child.id
    from portfolio_grant_tree tree
    join public.portfolios child
      on child.parent_id = tree.portfolio_id
     and child.organization_id = tree.organization_id
     and child.status = 'active'
  ),
  expanded as (
    -- A company hat follows current governing topology, INTERSECTED with its
    -- own hotel list when it has one. NULL means "every hotel this company
    -- operates, including ones added later" and copies no list, which is the
    -- shape every company hat had before 0461.
    select h.account_id, h.organization_id, r.property_id,
           'membership_hat'::text as entitlement_kind,
           h.id as entitlement_id, h.id as membership_id,
           null::text as access_profile, h.staxis_role,
           h.membership_scope as scope_type, null::uuid as portfolio_id,
           true as can_portfolio_intelligence
    from active_hats h
    join governing_relationships r on r.organization_id = h.organization_id
    where h.membership_scope = 'company'
      and (h.covered_property_ids is null
        or r.property_id = any(h.covered_property_ids))

    union all

    -- A property hat is always intersected with what the company governs now.
    select h.account_id, h.organization_id, r.property_id,
           'membership_hat'::text, h.id, h.id, null::text, h.staxis_role,
           h.membership_scope, null::uuid,
           h.staxis_role = 'general_manager'
    from active_hats h
    cross join lateral unnest(h.covered_property_ids) covered(property_id)
    join governing_relationships r
      on r.organization_id = h.organization_id
     and r.property_id = covered.property_id
    where h.membership_scope = 'property'

    union all

    select m.account_id, g.organization_id, r.property_id,
           'access_grant'::text, g.id, g.membership_id, g.access_profile,
           null::text, g.scope_type, null::uuid,
           g.access_profile in (
             'organization_owner', 'organization_admin',
             'portfolio_manager', 'property_manager'
           )
    from active_grants g
    join active_memberships m on m.id = g.membership_id
    join governing_relationships r on r.organization_id = g.organization_id
    where g.scope_type = 'organization'

    union all

    select m.account_id, g.organization_id, r.property_id,
           'access_grant'::text, g.id, g.membership_id, g.access_profile,
           null::text, g.scope_type, null::uuid,
           g.access_profile in (
             'organization_owner', 'organization_admin',
             'portfolio_manager', 'property_manager'
           )
    from active_grants g
    join active_memberships m on m.id = g.membership_id
    join governing_relationships r
      on r.id = g.property_relationship_id
     and r.organization_id = g.organization_id
     and r.property_id = g.property_id
    where g.scope_type = 'property'

    union all

    select m.account_id, tree.organization_id, r.property_id,
           'access_grant'::text, tree.grant_id, tree.membership_id,
           tree.access_profile, null::text, tree.scope_type,
           tree.root_portfolio_id,
           tree.access_profile in (
             'organization_owner', 'organization_admin',
             'portfolio_manager', 'property_manager'
           )
    from portfolio_grant_tree tree
    join active_memberships m on m.id = tree.membership_id
    join public.portfolio_properties pp
      on pp.organization_id = tree.organization_id
     and pp.portfolio_id = tree.portfolio_id
     and pp.assigned_at <= now()
     and (pp.removed_at is null or pp.removed_at > now())
    join governing_relationships r
      on r.id = pp.property_relationship_id
     and r.organization_id = pp.organization_id
     and r.property_id = pp.property_id
  )
  select distinct expanded.account_id, expanded.organization_id,
         expanded.property_id, expanded.entitlement_kind,
         expanded.entitlement_id, expanded.membership_id,
         expanded.access_profile, expanded.staxis_role,
         expanded.scope_type, expanded.portfolio_id,
         expanded.can_portfolio_intelligence
  from expanded;
$$;

-- ── 4.2 _staxis_structural_account_property_ids ───────────────────────────

create or replace function public._staxis_structural_account_property_ids(
  p_account_id uuid
)
returns uuid[]
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
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
      and membership.staxis_role in ('owner', 'regional_manager')
      and (membership.covered_property_ids is null
        or relationship.property_id = any(membership.covered_property_ids))

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
     and (assignment.removed_at is null or assignment.removed_at > clock_timestamp())
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
  from expanded;
$$;

-- ── 4.3 _staxis_account_ambiguous_portfolio_organizations ─────────────────

create or replace function public._staxis_account_ambiguous_portfolio_organizations(
  p_account_id uuid
)
returns table (organization_id uuid)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with
  memberships as (
    select membership.*
    from public.organization_memberships membership
    join public.accounts account
      on account.id = membership.account_id
     and account.active is true
     and account.role <> 'admin'
    join public.organizations organization
      on organization.id = membership.organization_id
     and organization.status = 'active'
     and organization.organization_type in ('management_company', 'ownership_group')
    where membership.account_id = p_account_id
      and membership.status = 'active'
      and membership.starts_at <= now()
      and membership.ended_at is null
  ),
  grants as (
    select grant_row.*
    from public.organization_access_grants grant_row
    join memberships membership
      on membership.id = grant_row.membership_id
     and membership.organization_id = grant_row.organization_id
    where grant_row.status = 'active'
      and grant_row.source <> 'legacy_backfill'
      and grant_row.starts_at <= now()
      and (grant_row.expires_at is null or grant_row.expires_at > now())
      and grant_row.access_profile in (
        'organization_owner', 'organization_admin',
        'portfolio_manager', 'property_manager'
      )
  ),
  potential as (
    select membership.organization_id
    from memberships membership
    where membership.membership_scope = 'company'
      and membership.staxis_role in ('owner', 'regional_manager')

    union

    select membership.organization_id
    from memberships membership
    where membership.membership_scope = 'property'
      and membership.staxis_role = 'general_manager'
      and (
        select count(distinct covered.property_id)
        from unnest(coalesce(membership.covered_property_ids, '{}'::uuid[]))
          covered(property_id)
        where exists (
          select 1
          from public._staxis_current_primary_property_relationships() relationship
          where relationship.organization_id = membership.organization_id
            and relationship.property_id = covered.property_id
        )
      ) > 1

    union

    select grant_row.organization_id
    from grants grant_row
    where grant_row.scope_type in ('organization', 'portfolio')

    union

    select grant_row.organization_id
    from grants grant_row
    where grant_row.scope_type = 'property'
    group by grant_row.organization_id
    having count(distinct grant_row.property_id) > 1
  )
  select distinct potential.organization_id
  from potential
  where public._staxis_organization_has_ambiguous_primary_topology(
    potential.organization_id
  );
$$;

-- ── 4.4 staxis_list_account_authorized_properties ─────────────────────────

create or replace function public.staxis_list_account_authorized_properties(
  p_account_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_account public.accounts%rowtype;
  v_state public.account_authorization_state%rowtype;
  v_property_ids uuid[] := '{}'::uuid[];
  v_bridge_ids uuid[] := '{}'::uuid[];
  v_normalized_ids uuid[] := '{}'::uuid[];
  v_standings jsonb := '[]'::jsonb;
  v_hash text;
begin
  select account.* into v_account
  from public.accounts account
  where account.id = p_account_id and account.active is true;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_active_account');
  end if;

  select state.* into v_state
  from public.account_authorization_state state
  where state.account_id = p_account_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'authorization_state_missing');
  end if;
  if v_state.authority_mode <> 'normalized' then
    return jsonb_build_object('ok', false, 'reason', 'final_authority_not_normalized');
  end if;

  if v_account.role = 'admin' then
    v_hash := encode(sha256(convert_to(jsonb_build_object(
      'all', true, 'authorityMode', 'normalized',
      'authorityVersion', v_state.authority_version,
      'accountRole', v_account.role,
      'propertyIds', '[]'::jsonb,
      'propertyStandings', '[]'::jsonb
    )::text, 'UTF8')), 'hex');
    return jsonb_build_object(
      'ok', true, 'all', true, 'authorityMode', 'normalized',
      'authorityVersion', v_state.authority_version,
      'effectiveAccessHash', v_hash,
      'propertyIds', '[]'::jsonb, 'legacyPropertyIds', '[]'::jsonb,
      'membershipPropertyIds', '[]'::jsonb, 'propertyStandings', '[]'::jsonb
    );
  end if;

  with raw as (
    select authz.*,
           case authz.entitlement_kind
             when 'membership_hat' then 3
             when 'access_grant' then 2
             else 1
           end as authority_priority,
           case
             when authz.entitlement_kind = 'membership_hat' then
               case authz.staxis_role
                 when 'general_manager' then 'general_manager'
                 when 'housekeeping' then 'housekeeping'
                 when 'maintenance' then 'maintenance'
                 else 'front_desk'
               end
             when authz.entitlement_kind = 'access_grant' then
               case when authz.access_profile = 'property_manager'
                    and authz.scope_type = 'property'
                 then 'general_manager' else 'front_desk' end
             else v_account.role
           end as operational_role,
           case
             when authz.entitlement_kind = 'membership_hat'
               and authz.scope_type = 'property' then
                 case authz.staxis_role
                   when 'general_manager' then 900
                   when 'front_desk' then 500
                   when 'maintenance' then 400
                   when 'housekeeping' then 300
                   else 100
                 end
             when authz.entitlement_kind = 'access_grant'
               and authz.scope_type = 'property'
               and authz.access_profile = 'property_manager' then 850
             else 100
           end as role_priority,
           case
             when authz.entitlement_kind = 'membership_hat'
               then authz.staxis_role in ('owner', 'regional_manager', 'general_manager')
             when authz.entitlement_kind = 'access_grant'
               then authz.access_profile in ('organization_owner', 'property_manager')
             else v_account.role in ('owner', 'general_manager')
           end as sees_financials,
           case
             when authz.entitlement_kind = 'access_grant'
               then authz.scope_type = 'property' and authz.access_profile = 'property_manager'
             when authz.entitlement_kind = 'membership_hat'
               then authz.scope_type = 'property'
             else true
           end as hotel_mutation_allowed
    from public._staxis_account_property_authorizations(p_account_id) authz
  ),
  winning as (
    select raw.*
    from raw
    join (
      select property_id, max(authority_priority) as authority_priority
      from raw group by property_id
    ) priority
      on priority.property_id = raw.property_id
     and priority.authority_priority = raw.authority_priority
  ),
  grouped as (
    select winning.property_id,
           (array_agg(winning.operational_role order by winning.role_priority desc,
             winning.entitlement_kind, winning.entitlement_id))[1] as operational_role,
           bool_or(winning.sees_financials) as sees_financials,
           bool_or(winning.hotel_mutation_allowed) as hotel_mutation_allowed,
           bool_or(winning.can_portfolio_intelligence) as portfolio_intelligence_read,
           jsonb_agg(jsonb_build_object(
             'kind', winning.entitlement_kind,
             'entitlementId', winning.entitlement_id,
             'organizationId', winning.organization_id,
             'membershipId', winning.membership_id,
             'accessProfile', winning.access_profile,
             'staxisRole', winning.staxis_role,
             'scopeType', winning.scope_type,
             'portfolioId', winning.portfolio_id
           ) order by winning.role_priority desc,
             winning.entitlement_kind, winning.entitlement_id) as entitlements
    from winning
    group by winning.property_id
  )
  select coalesce(array_agg(grouped.property_id order by grouped.property_id), '{}'::uuid[]),
         coalesce(jsonb_agg(jsonb_build_object(
           'propertyId', grouped.property_id,
           'operationalRole', grouped.operational_role,
           'seesFinancials', grouped.sees_financials,
           'hotelMutationAllowed', grouped.hotel_mutation_allowed,
           'portfolioIntelligenceRead', grouped.portfolio_intelligence_read,
           'entitlements', grouped.entitlements
         ) order by grouped.property_id), '[]'::jsonb)
    into v_property_ids, v_standings
  from grouped;

  select coalesce(array_agg(distinct authz.property_id order by authz.property_id)
                    filter (where authz.entitlement_kind = 'legacy_bridge'), '{}'::uuid[]),
         coalesce(array_agg(distinct authz.property_id order by authz.property_id)
                    filter (where authz.entitlement_kind <> 'legacy_bridge'), '{}'::uuid[])
    into v_bridge_ids, v_normalized_ids
  from public._staxis_account_property_authorizations(p_account_id) authz;

  v_hash := encode(sha256(convert_to(jsonb_build_object(
    'all', false, 'authorityMode', 'normalized',
    'authorityVersion', v_state.authority_version,
    'accountRole', v_account.role,
    'propertyIds', to_jsonb(v_property_ids),
    'legacyPropertyIds', to_jsonb(v_bridge_ids),
    'membershipPropertyIds', to_jsonb(v_normalized_ids),
    'propertyStandings', v_standings
  )::text, 'UTF8')), 'hex');

  return jsonb_build_object(
    'ok', true, 'all', false, 'authorityMode', 'normalized',
    'authorityVersion', v_state.authority_version,
    'effectiveAccessHash', v_hash,
    'propertyIds', to_jsonb(v_property_ids),
    'legacyPropertyIds', to_jsonb(v_bridge_ids),
    'membershipPropertyIds', to_jsonb(v_normalized_ids),
    'propertyStandings', v_standings
  );
end;
$$;

-- ── 4.5 _staxis_can_set_membership_hat ────────────────────────────────────

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
         and p_staxis_role in ('owner', 'regional_manager')
         and (p_property_ids is null
           or cardinality(p_property_ids) between 1 and 5000))
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
                  and authority.staxis_role in ('owner', 'regional_manager'))
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

  -- An explicit company list must be clean and must name hotels THIS company
  -- actually governs. Without this a listed stranger-hotel would simply not
  -- appear among the governed rows below and would pass by absence.
  if p_property_ids is not null then
    if array_position(p_property_ids, null) is not null
       or (select count(*) from unnest(p_property_ids) property_id)
          <> (select count(distinct property_id) from unnest(p_property_ids) property_id)
    then
      return false;
    end if;
    if exists (
      select 1
      from unnest(p_property_ids) target(property_id)
      where not exists (
        select 1
        from public._staxis_current_primary_property_relationships() relationship
        where relationship.organization_id = p_organization_id
          and relationship.property_id = target.property_id
          and relationship.active_primary_count = 1
      )
    ) then
      return false;
    end if;
  end if;

  -- ONLY somebody whose own standing follows the company forward may hand out
  -- all-including-future. An owner named on an explicit list that happens to
  -- cover every hotel today still may not: hotel 21 is not theirs to give.
  if p_property_ids is null and not exists (
    select 1
    from public.organization_memberships membership
    where membership.account_id = p_actor_account_id
      and membership.organization_id = p_organization_id
      and membership.status = 'active'
      and membership.ended_at is null
      and membership.membership_scope = 'company'
      and membership.staxis_role = 'owner'
      and membership.covered_property_ids is null
    union all
    select 1
    from public.organization_access_grants access_grant
    join public.organization_memberships membership
      on membership.id = access_grant.membership_id
     and membership.account_id = p_actor_account_id
     and membership.status = 'active'
     and membership.ended_at is null
    where access_grant.organization_id = p_organization_id
      and access_grant.status = 'active'
      and access_grant.scope_type = 'organization'
      and access_grant.access_profile = 'organization_owner'
      and access_grant.starts_at <= v_now
      and (access_grant.expires_at is null or access_grant.expires_at > v_now)
  ) then
    return false;
  end if;

  -- Every hotel the new hat will reach must be one the actor personally
  -- reaches through a broad company/organization row that could grant it.
  -- The finance job was the only company job a non-owner could ever hand out,
  -- and 0461 retired it, so this is owner or organization_owner, nothing else.
  return not exists (
    select 1
    from public._staxis_current_primary_property_relationships() governed
    where governed.organization_id = p_organization_id
      and governed.active_primary_count = 1
      and (p_property_ids is null or governed.property_id = any(p_property_ids))
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
              and authority.staxis_role = 'owner'
            )
            or
            (
              authority.entitlement_kind = 'access_grant'
              and authority.scope_type = 'organization'
              and authority.access_profile = 'organization_owner'
            )
          )
      )
  );
end;
$$;

-- ── 4.6 staxis_set_membership_hat ─────────────────────────────────────────

create or replace function public.staxis_set_membership_hat(
  p_actor_account_id uuid,
  p_organization_id uuid,
  p_account_id uuid,
  p_membership_scope text,
  p_staxis_role text,
  p_property_ids jsonb default null,
  p_job_title text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_membership_id uuid;
  v_job_category text;
  v_property_ids uuid[];
  v_actor_is_staxis_admin boolean;
  v_target_email text;
  v_existing record;
begin
  if p_membership_scope not in ('company', 'property') then
    raise exception 'membership scope must be company or property' using errcode = '22023';
  end if;

  if p_property_ids is not null and jsonb_typeof(p_property_ids) <> 'array' then
    raise exception 'the chosen hotels must be a list' using errcode = '22023';
  end if;
  if p_property_ids is not null then
    select array_agg(distinct (element #>> '{}')::uuid)
      into v_property_ids
      from jsonb_array_elements(p_property_ids) as element;
  end if;

  perform public._staxis_lock_organization(p_organization_id);

  if not public._staxis_can_set_membership_hat(
    p_actor_account_id, p_organization_id, p_membership_scope, p_staxis_role, v_property_ids
  ) then
    raise exception 'actor may not grant this job at this scope' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.accounts a where a.id = p_account_id and a.active
  ) then
    raise exception 'target account is not active' using errcode = '42501';
  end if;

  -- A Staxis administrator is a separate realm and never wears a customer hat.
  -- The 0325 guard trigger refuses the row and
  -- `staxis_accept_organization_invitation` refuses the invitation; this says
  -- the same thing at the third door, in the same words.
  if exists (
    select 1 from public.accounts a where a.id = p_account_id and a.role = 'admin'
  ) then
    raise exception 'Staxis administrators cannot hold a customer organization job'
      using errcode = '42501';
  end if;

  select coalesce(a.role = 'admin', false) into v_actor_is_staxis_admin
  from public.accounts a where a.id = p_actor_account_id;

  select lower(u.email) into v_target_email
  from public.accounts a
  join auth.users u on u.id = a.data_user_id
  where a.id = p_account_id;

  -- (a) The target must already belong to this company. An administrator
  --     bootstrapping a company is exempt — before the first hat exists there
  --     is nobody to be a member, which is the whole reason that door is open.
  --
  --     THREE DOORS COUNT, because the product has three and refusing one of
  --     them would strand a real new hire at the login screen:
  --       * a membership row here (a hat, or a plain 0325 employment record);
  --       * an `account_invites` row — the Staxis-native invitation, which is
  --         what /api/auth/accept-invite consumes and then mints the hat from.
  --         Deliberately NOT filtered on `accepted_at`: that flow CLAIMS the
  --         invite atomically before minting, so at this point it is always
  --         already accepted. Revoking one deletes the row;
  --       * an `organization_invitations` row that was not revoked.
  --
  --     What none of the three admits is the case this closes: an account id
  --     the company has never had any relationship with at all.
  if not coalesce(v_actor_is_staxis_admin, false)
     and not exists (
       select 1 from public.organization_memberships m
       where m.organization_id = p_organization_id
         and m.account_id = p_account_id
         and m.ended_at is null
     )
     and not exists (
       select 1 from public.account_invites i
       where i.organization_id = p_organization_id
         and v_target_email is not null
         and lower(i.email) = v_target_email
     )
     and not exists (
       select 1 from public.organization_invitations i
       where i.organization_id = p_organization_id
         and v_target_email is not null
         and lower(i.email) = v_target_email
         and i.status <> 'revoked'
     ) then
    raise exception 'that person has no job or invitation at this company — invite them first'
      using errcode = '42501';
  end if;

  -- (b) Nobody may attach a job to somebody who already outranks them here.
  --     Asked as "could you have granted the job they already hold?", so the
  --     rule needs no second ranking table to drift out of step with
  --     `_staxis_can_set_membership_hat`.
  if not coalesce(v_actor_is_staxis_admin, false) then
    for v_existing in
      select m.membership_scope, m.staxis_role, m.covered_property_ids
      from public.organization_memberships m
      where m.organization_id = p_organization_id
        and m.account_id = p_account_id
        and m.status = 'active'
        and m.ended_at is null
        and m.staxis_role is not null
    loop
      if not public._staxis_can_set_membership_hat(
        p_actor_account_id, p_organization_id,
        v_existing.membership_scope, v_existing.staxis_role, v_existing.covered_property_ids
      ) then
        raise exception 'that person holds a job you could not have given them'
          using errcode = '42501';
      end if;
    end loop;
  end if;

  -- Descriptive only. Authority lives in staxis_role; job_category exists so
  -- the 0325 Company Hub directory keeps rendering a sensible label.
  v_job_category := case p_staxis_role
    when 'owner' then 'owner_principal'
    when 'regional_manager' then 'regional_manager'
    when 'general_manager' then 'general_manager'
    else 'hotel_employee'
  end;

  select m.id into v_membership_id
  from public.organization_memberships m
  where m.organization_id = p_organization_id
    and m.account_id = p_account_id
    and m.membership_scope = p_membership_scope
    and m.staxis_role = p_staxis_role
    and m.ended_at is null
  for update;

  if v_membership_id is null then
    insert into public.organization_memberships (
      organization_id, account_id, job_category, job_title, status,
      membership_scope, staxis_role, covered_property_ids,
      created_by_account_id, updated_by_account_id
    ) values (
      p_organization_id, p_account_id, v_job_category, p_job_title, 'active',
      p_membership_scope, p_staxis_role,
      v_property_ids,
      p_actor_account_id, p_actor_account_id
    )
    returning id into v_membership_id;
  else
    -- Same job, same scope: this is the SAME hat over a different set of
    -- hotels, not a second hat.
    update public.organization_memberships m
       set covered_property_ids = v_property_ids,
           job_title = coalesce(p_job_title, m.job_title),
           updated_by_account_id = p_actor_account_id
     where m.id = v_membership_id;
  end if;

  return v_membership_id;
end;
$$;

-- ── 4.7 _staxis_can_control_account_invite ────────────────────────────────

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
         and p_role in ('owner', 'regional_manager')
         and (p_covered_property_ids is null
           or cardinality(p_covered_property_ids) between 1 and 5000))
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

-- ── 4.8 staxis_accept_account_invite ──────────────────────────────────────

create or replace function public.staxis_accept_account_invite(
  p_token_hash text,
  p_claim_token uuid,
  p_auth_user_id uuid,
  p_username text,
  p_display_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite public.account_invites%rowtype;
  v_now timestamptz := clock_timestamp();
  v_context jsonb;
  v_account_id uuid;
  v_membership_id uuid;
  v_account_role text;
  v_candidate_username text;
  v_coverage uuid[];
  v_property_id uuid;
  v_current_org_id uuid;
  v_current_org_type text;
  v_relationship_count integer;
  v_attempt integer;
  v_independent jsonb;
  v_staff_status text;
  v_staff_link_account_id uuid;
begin
  if p_token_hash is null
     or p_token_hash !~ '^[0-9a-f]{64}$'
     or p_claim_token is null
     or p_auth_user_id is null
     or p_username is null
     or lower(btrim(p_username)) !~ '^[a-z0-9._+-]{2,40}$'
     or p_display_name is null
     or char_length(btrim(p_display_name)) not between 1 and 120
  then
    raise exception 'invalid invitation acceptance input' using errcode = '22023';
  end if;

  select invitation.* into v_invite
  from public.account_invites invitation
  where invitation.token_hash = p_token_hash
  for update;
  if not found
     or v_invite.accepted_at is not null
     or v_invite.expires_at <= v_now
     or v_invite.acceptance_claim_token is distinct from p_claim_token
     or v_invite.acceptance_claimed_at <= v_now - interval '10 minutes'
  then
    raise exception 'invitation claim is no longer current' using errcode = '40001';
  end if;
  if not exists (
    select 1 from auth.users auth_user
    where auth_user.id = p_auth_user_id
      and lower(auth_user.email) = lower(v_invite.email)
  ) or exists (
    select 1 from public.accounts account where account.data_user_id = p_auth_user_id
  ) then
    raise exception 'Auth identity does not match this unused invitation' using errcode = '42501';
  end if;

  v_coverage := case when v_invite.membership_scope = 'property'
    then coalesce(v_invite.covered_property_ids, '{}'::uuid[])
    else '{}'::uuid[] end;
  for v_property_id in
    select distinct locked_id
    from unnest(array[v_invite.hotel_id] || v_coverage) locked_id
    order by locked_id
  loop
    perform 1 from public.properties property where property.id = v_property_id for update;
    if not found then raise exception 'invited hotel is unavailable' using errcode = 'P0002'; end if;
    perform pg_advisory_xact_lock(hashtextextended(v_property_id::text, 0));
  end loop;

  select count(*)::integer,
         (array_agg(relationship.organization_id order by relationship.id))[1],
         (array_agg(organization.organization_type order by relationship.id))[1]
    into v_relationship_count, v_current_org_id, v_current_org_type
  from public._staxis_current_primary_property_relationships() relationship
  join public.organizations organization
    on organization.id = relationship.organization_id and organization.status = 'active'
  where relationship.property_id = v_invite.hotel_id
    and relationship.active_primary_count = 1;
  if v_relationship_count <> 1 then
    raise exception 'invited hotel has no authoritative topology' using errcode = '23514';
  end if;
  perform public._staxis_lock_organization(coalesce(v_invite.organization_id, v_current_org_id));
  perform 1 from public.accounts inviter where inviter.id = v_invite.invited_by for share nowait;
  if not found then raise exception 'inviter no longer exists' using errcode = '42501'; end if;
  perform 1 from public.account_authorization_state state where state.account_id = v_invite.invited_by for share nowait;

  if v_invite.membership_scope is not null or v_invite.organization_id is not null then
    if v_invite.organization_id is null
       or v_invite.membership_scope not in ('company', 'property')
       or not (
         (v_invite.membership_scope = 'company'
           and v_invite.role in ('owner', 'regional_manager')
           and (v_invite.covered_property_ids is null
             or cardinality(v_coverage) > 0))
         or (v_invite.membership_scope = 'property'
           and v_invite.role in ('general_manager', 'front_desk', 'housekeeping', 'maintenance')
           and cardinality(v_coverage) > 0 and v_invite.hotel_id = any(v_coverage))
       )
       or v_current_org_type not in ('management_company', 'ownership_group')
       or v_current_org_id is distinct from v_invite.organization_id
       or not public._staxis_can_set_membership_hat(
         v_invite.invited_by, v_invite.organization_id, v_invite.membership_scope,
         v_invite.role, case when cardinality(v_coverage) > 0 then v_coverage else null end
       ) then
      raise exception 'invitation topology or promised job is no longer valid' using errcode = '42501';
    end if;
    if exists (
      select 1 from unnest(v_coverage) covered(property_id)
      where not exists (
        select 1 from public._staxis_current_primary_property_relationships() relationship
        where relationship.organization_id = v_invite.organization_id
          and relationship.property_id = covered.property_id
          and relationship.active_primary_count = 1
      )
    ) then
      raise exception 'one or more invited hotels changed company' using errcode = '42501';
    end if;
    v_account_role := case v_invite.role when 'owner' then 'owner'
      when 'regional_manager' then 'front_desk' else v_invite.role end;
  else
    v_context := public._staxis_manage_team_context(v_invite.invited_by, v_invite.hotel_id);
    if coalesce((v_context->>'allowed')::boolean, false) is not true
       or v_current_org_type <> 'single_hotel'
       or v_invite.role not in ('owner','general_manager','front_desk','housekeeping','maintenance')
       or not ((v_invite.role in ('owner','general_manager') and v_context->>'role' in ('admin','owner'))
               or v_invite.role in ('front_desk','housekeeping','maintenance')) then
      raise exception 'legacy invitation is no longer valid for this hotel' using errcode = '42501';
    end if;
    v_account_role := v_invite.role;
  end if;

  for v_attempt in 0..4 loop
    v_candidate_username := case when v_attempt = 0 then lower(btrim(p_username))
      else left(lower(btrim(p_username)), 30)
        || substring(replace(p_claim_token::text, '-', ''), 1 + (v_attempt - 1) * 2, 6)
        || v_attempt::text end;
    begin
      insert into public.accounts (username, display_name, role, data_user_id)
      values (v_candidate_username, btrim(p_display_name), v_account_role, p_auth_user_id)
      returning id into v_account_id;
      exit;
    exception when unique_violation then
      if exists (select 1 from public.accounts account where account.data_user_id = p_auth_user_id) then
        raise exception 'Auth identity already has an account' using errcode = '23505';
      end if;
      if v_attempt = 4 then raise exception 'could not allocate an account username' using errcode = '23505'; end if;
    end;
  end loop;

  if v_invite.organization_id is not null then
    v_membership_id := public.staxis_set_membership_hat(
      v_invite.invited_by, v_invite.organization_id, v_account_id,
      v_invite.membership_scope, v_invite.role,
      case when v_invite.membership_scope = 'property' then to_jsonb(v_coverage) else null end,
      null
    );
    if v_membership_id is null or not exists (
      select 1 from public._staxis_account_property_authorizations(v_account_id) authz
      where authz.property_id = v_invite.hotel_id
    ) then
      raise exception 'promised normalized entitlement did not activate' using errcode = '23514';
    end if;
  else
    v_independent := public._staxis_stage_c_grant_independent_hotel(
      v_account_id, v_invite.hotel_id, 'Access Stage C invite acceptance'
    );
    if coalesce((v_independent->>'ok')::boolean, false) is not true then
      raise exception 'promised independent entitlement did not activate: %', v_independent using errcode = '23514';
    end if;
  end if;

  if v_invite.target_staff_id is not null then
    v_staff_status := public._staxis_lock_invite_target_staff(
      v_invite.invited_by, v_invite.hotel_id, v_invite.role,
      v_invite.target_staff_id, v_account_id, v_invite.id
    );
    if v_staff_status <> 'ok' then
      raise exception 'promised roster profile is no longer linkable' using errcode = '23514';
    end if;
    update public.accounts account
       set staff_id = v_invite.target_staff_id, updated_at = v_now
     where account.id = v_account_id and account.staff_id is null;
    if not found then raise exception 'accepted account already has a different roster identity' using errcode = '23514'; end if;
    insert into public.account_property_staff_links (
      account_id, property_id, staff_id, is_active, source,
      linked_by_account_id, linked_at, updated_at
    ) values (
      v_account_id, v_invite.hotel_id, v_invite.target_staff_id, true, 'invitation',
      v_invite.invited_by, v_now, v_now
    ) on conflict (account_id, property_id) do update
      set staff_id = excluded.staff_id, is_active = true, source = excluded.source,
          linked_by_account_id = excluded.linked_by_account_id,
          linked_at = coalesce(public.account_property_staff_links.linked_at, excluded.linked_at),
          deactivated_at = null, deactivated_by_account_id = null, updated_at = excluded.updated_at
      where public.account_property_staff_links.is_active is false
         or public.account_property_staff_links.staff_id = excluded.staff_id
      returning account_id into v_staff_link_account_id;
    if v_staff_link_account_id is null then raise exception 'accepted account staff link changed before commit' using errcode = '40001'; end if;
  end if;

  update public.account_invites invitation
     set accepted_at = v_now, accepted_by = v_account_id,
         acceptance_claim_token = null, acceptance_claimed_at = null
   where invitation.id = v_invite.id and invitation.accepted_at is null
     and invitation.acceptance_claim_token = p_claim_token;
  if not found then raise exception 'invitation claim changed before commit' using errcode = '40001'; end if;

  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, metadata
  ) values (
    p_auth_user_id, lower(v_invite.email), 'invite.accept', 'invite', v_invite.id::text,
    jsonb_build_object('hotel_id', v_invite.hotel_id, 'role', v_invite.role,
      'username', v_candidate_username, 'scope', v_invite.membership_scope,
      'organizationId', v_invite.organization_id, 'membershipId', v_membership_id,
      'authorityMode', 'normalized', 'staffId', v_invite.target_staff_id)
  );
  return jsonb_build_object(
    'ok', true, 'accountId', v_account_id, 'email', lower(v_invite.email),
    'username', v_candidate_username, 'normalized', true, 'membershipId', v_membership_id,
    'staffId', v_invite.target_staff_id
  );
end;
$$;

-- ── 4.9 staxis_grant_existing_account_invite_guarded ──────────────────────

create or replace function public.staxis_grant_existing_account_invite_guarded(
  p_actor_account_id uuid,
  p_actor_auth_user_id uuid,
  p_hotel_id uuid,
  p_target_account_id uuid,
  p_email text,
  p_role text,
  p_organization_id uuid,
  p_membership_scope text,
  p_covered_property_ids uuid[],
  p_target_staff_id uuid default null,
  p_request_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_actor public.accounts%rowtype;
  v_target public.accounts%rowtype;
  v_target_state public.account_authorization_state%rowtype;
  v_actor_email text;
  v_org_id uuid;
  v_org_type text;
  v_relationship_count integer;
  v_membership_id uuid;
  v_staff_status text;
  v_link_account_id uuid;
  v_role_changed boolean := false;
  v_access_changed boolean := false;
  v_link_changed boolean := false;
  v_effective_coverage uuid[];
  v_job_category text;
  v_independent jsonb;
begin
  if p_actor_account_id is null or p_actor_auth_user_id is null or p_hotel_id is null
     or p_target_account_id is null or char_length(v_email) not between 3 and 320
     or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or p_role not in ('owner','regional_manager','general_manager','front_desk','housekeeping','maintenance')
     or char_length(coalesce(p_request_id, '')) > 200 then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if p_actor_account_id = p_target_account_id then
    return jsonb_build_object('ok', false, 'reason', 'role_conflict');
  end if;

  perform 1 from public.properties property where property.id = p_hotel_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  perform pg_advisory_xact_lock(hashtextextended(p_hotel_id::text, 0));
  select count(*)::integer,
         (array_agg(relationship.organization_id order by relationship.id))[1],
         (array_agg(relationship.organization_type order by relationship.id))[1]
    into v_relationship_count, v_org_id, v_org_type
  from public._staxis_cutover_valid_current_primary_property_relationships() relationship
  where relationship.property_id = p_hotel_id
    and relationship.active_primary_count = 1
    and relationship.organization_status = 'active';
  if v_relationship_count <> 1 then return jsonb_build_object('ok', false, 'reason', 'denied'); end if;

  select actor.* into v_actor from public.accounts actor where actor.id = p_actor_account_id for update;
  select lower(auth_user.email) into v_actor_email from auth.users auth_user
   where auth_user.id = p_actor_auth_user_id for share;
  if not found or v_actor.data_user_id is distinct from p_actor_auth_user_id
     or v_actor.active is not true
     or not public._staxis_can_control_account_invite(
       p_actor_account_id, p_hotel_id, p_organization_id, p_membership_scope,
       p_role, p_covered_property_ids
     ) then
    return jsonb_build_object('ok', false, 'reason', 'denied');
  end if;
  select target.* into v_target from public.accounts target
   where target.id = p_target_account_id for update;
  if not found or v_target.active is not true then
    return jsonb_build_object('ok', false, 'reason', case when not found then 'not_found' else 'role_conflict' end);
  end if;
  if v_target.role = 'admin' then return jsonb_build_object('ok', false, 'reason', 'role_conflict'); end if;
  if not exists (
    select 1 from auth.users auth_user where auth_user.id = v_target.data_user_id
      and lower(auth_user.email) = v_email
  ) then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  select state.* into v_target_state from public.account_authorization_state state
   where state.account_id = v_target.id for update;
  if not found or v_target_state.authority_mode <> 'normalized' then
    return jsonb_build_object('ok', false, 'reason', 'final_authority_not_normalized');
  end if;

  v_staff_status := public._staxis_lock_invite_target_staff(
    p_actor_account_id, p_hotel_id, p_role, p_target_staff_id, v_target.id, null
  );
  if v_staff_status <> 'ok' then return jsonb_build_object('ok', false, 'reason', v_staff_status); end if;

  if p_organization_id is not null or p_membership_scope is not null or p_covered_property_ids is not null then
    if p_organization_id is null or p_membership_scope not in ('company','property')
       or v_org_type not in ('management_company','ownership_group')
       or v_org_id is distinct from p_organization_id
       or (p_membership_scope = 'company' and p_covered_property_ids is not null)
       or (p_membership_scope = 'property' and (
         cardinality(coalesce(p_covered_property_ids, '{}'::uuid[])) = 0
         or not (p_hotel_id = any(p_covered_property_ids)))) then
      return jsonb_build_object('ok', false, 'reason', 'role_conflict');
    end if;
    if v_actor.role <> 'admin' and not public._staxis_can_set_membership_hat(
      v_actor.id, p_organization_id, p_membership_scope, p_role,
      case when p_membership_scope = 'property' then p_covered_property_ids else null end
    ) then
      return jsonb_build_object('ok', false, 'reason', 'denied');
    end if;
    v_effective_coverage := case when p_membership_scope = 'property' then array(
      select distinct covered.property_id from unnest(p_covered_property_ids) covered(property_id)
      order by covered.property_id) else null end;
    v_job_category := case p_role when 'owner' then 'owner_principal'
      when 'regional_manager' then 'regional_manager'
      when 'general_manager' then 'general_manager' else 'hotel_employee' end;
    insert into public.organization_memberships (
      organization_id, account_id, job_category, status, starts_at,
      created_by_account_id, updated_by_account_id, membership_scope, staxis_role, covered_property_ids
    ) values (
      p_organization_id, v_target.id, v_job_category, 'active', v_now,
      v_actor.id, v_actor.id, p_membership_scope, p_role, v_effective_coverage
    ) on conflict (organization_id, account_id, membership_scope, staxis_role)
      where ended_at is null and staxis_role is not null
    do update set covered_property_ids = excluded.covered_property_ids,
                  status = 'active', starts_at = least(public.organization_memberships.starts_at, excluded.starts_at),
                  updated_by_account_id = excluded.updated_by_account_id, updated_at = v_now
    returning id into v_membership_id;
    v_access_changed := true;
    if not exists (
      select 1 from public._staxis_account_property_authorizations(v_target.id) authz
      where authz.property_id = p_hotel_id and authz.entitlement_kind = 'membership_hat'
        and authz.entitlement_id = v_membership_id
    ) then raise exception 'existing-account normalized entitlement did not activate' using errcode = '23514'; end if;
  else
    if v_org_type <> 'single_hotel' then return jsonb_build_object('ok', false, 'reason', 'role_conflict'); end if;
    if v_target.role is distinct from p_role then
      if exists (select 1 from public._staxis_nonlegacy_property_authorizations(v_target.id))
         or exists (select 1 from public.account_property_staff_links link_row where link_row.account_id = v_target.id and link_row.is_active)
      then return jsonb_build_object('ok', false, 'reason', 'role_conflict'); end if;
      update public.accounts account set role = p_role where account.id = v_target.id;
      v_role_changed := true;
    end if;
    v_independent := public._staxis_stage_c_grant_independent_hotel(
      v_target.id, p_hotel_id, 'Access Stage C existing-account invite grant'
    );
    if coalesce((v_independent->>'ok')::boolean, false) is not true then
      return v_independent || jsonb_build_object('ok', false);
    end if;
    v_access_changed := (v_independent->>'status') = 'granted';
  end if;

  if p_target_staff_id is not null then
    v_link_changed := not exists (
      select 1 from public.account_property_staff_links link_row
      where link_row.account_id = v_target.id and link_row.property_id = p_hotel_id
        and link_row.staff_id = p_target_staff_id and link_row.is_active
    );
    update public.accounts account set staff_id = coalesce(account.staff_id, p_target_staff_id)
      where account.id = v_target.id;
    insert into public.account_property_staff_links (
      account_id, property_id, staff_id, is_active, source, linked_by_account_id, linked_at, updated_at
    ) values (v_target.id, p_hotel_id, p_target_staff_id, true, 'invitation', v_actor.id, v_now, v_now)
    on conflict (account_id, property_id) do update
      set staff_id = excluded.staff_id, is_active = true, source = excluded.source,
          linked_by_account_id = excluded.linked_by_account_id, deactivated_at = null,
          deactivated_by_account_id = null, updated_at = excluded.updated_at
      where public.account_property_staff_links.is_active is false
         or public.account_property_staff_links.staff_id = excluded.staff_id
      returning account_id into v_link_account_id;
    if v_link_account_id is null then raise exception 'target account staff link changed during access grant' using errcode = '40001'; end if;
  end if;
  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, metadata
  ) values (
    p_actor_auth_user_id, v_actor_email, 'invite.existing_account_grant', 'account', v_target.id::text,
    jsonb_build_object('hotel_id', p_hotel_id, 'target_email', v_email, 'role', p_role,
      'organization_id', p_organization_id, 'scope', p_membership_scope,
      'property_ids', case when p_membership_scope = 'property' then to_jsonb(p_covered_property_ids) else null end,
      'membership_id', v_membership_id, 'staff_id', p_target_staff_id,
      'role_changed', v_role_changed, 'access_changed', v_access_changed,
      'staff_link_changed', v_link_changed, 'request_id', p_request_id, 'authorityMode', 'normalized')
  );
  return jsonb_build_object(
    'ok', true, 'status', case when v_role_changed or v_access_changed or v_link_changed then 'granted' else 'noop' end,
    'accountId', v_target.id, 'hotelId', p_hotel_id, 'role', p_role,
    'normalized', true, 'membershipId', v_membership_id, 'staffId', p_target_staff_id
  );
end;
$$;

-- ── 4.10 _staxis_account_has_company_people_authority_at_property ──────────

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
          and authority.staxis_role in ('owner', 'regional_manager')
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

-- ── 4.11 _staxis_account_has_company_manager_hierarchy_at_property ─────────

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
          and authority.staxis_role in ('owner', 'regional_manager')
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

-- ── 4.12 _staxis_company_structure_actor_rights ────────────────────────────

create or replace function public._staxis_company_structure_actor_rights(
  p_actor_account_id uuid,
  p_organization_id uuid
)
returns table (
  authorized_property_ids uuid[],
  whole_company_view boolean,
  can_manage_portfolios boolean,
  manageable_portfolio_ids uuid[]
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with recursive
  live_actor as (
    select account.id
    from public.accounts account
    join public.account_authorization_state state
      on state.account_id = account.id
     and state.authority_mode = 'normalized'
    join public.organizations organization
      on organization.id = p_organization_id
     and organization.status = 'active'
     and organization.organization_type in ('management_company', 'ownership_group')
    where account.id = p_actor_account_id
      and account.active is true
      and account.role <> 'admin'
  ),
  active_memberships as (
    select membership.*
    from public.organization_memberships membership
    join live_actor actor on actor.id = membership.account_id
    where membership.organization_id = p_organization_id
      and membership.status = 'active'
      and membership.starts_at <= now()
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
      and grant_row.starts_at <= now()
      and (grant_row.expires_at is null or grant_row.expires_at > now())
  ),
  actor_authorizations as (
    select distinct authorized.property_id
    from live_actor actor
    cross join lateral public._staxis_nonlegacy_property_authorizations(actor.id) authorized
    where authorized.organization_id = p_organization_id
  ),
  flags as (
    select
      exists (
        select 1
        from active_memberships membership
        where membership.membership_scope = 'company'
          and membership.staxis_role in ('owner', 'regional_manager')
      ) or exists (
        select 1
        from active_grants grant_row
        where grant_row.scope_type = 'organization'
      ) as whole_company_view,
      exists (
        select 1
        from active_memberships membership
        where membership.membership_scope = 'company'
          and membership.staxis_role in ('owner', 'regional_manager')
      ) or exists (
        select 1
        from active_grants grant_row
        where (grant_row.scope_type = 'organization'
                 and grant_row.access_profile in ('organization_owner', 'organization_admin'))
           or (grant_row.scope_type = 'portfolio'
                 and grant_row.access_profile = 'portfolio_manager')
      ) as can_manage_portfolios,
      exists (
        select 1
        from active_memberships membership
        where membership.membership_scope = 'company'
          and membership.staxis_role in ('owner', 'regional_manager')
      ) or exists (
        select 1
        from active_grants grant_row
        where grant_row.scope_type = 'organization'
          and grant_row.access_profile in ('organization_owner', 'organization_admin')
      ) as manages_all_portfolios
  ),
  portfolio_tree (portfolio_id) as (
    select portfolio.id
    from public.portfolios portfolio
    cross join flags
    where portfolio.organization_id = p_organization_id
      and portfolio.status = 'active'
      and flags.manages_all_portfolios

    union

    select grant_row.portfolio_id
    from active_grants grant_row
    join public.portfolios portfolio
      on portfolio.id = grant_row.portfolio_id
     and portfolio.organization_id = grant_row.organization_id
     and portfolio.status = 'active'
    where grant_row.scope_type = 'portfolio'
      and grant_row.access_profile = 'portfolio_manager'

    union

    select child.id
    from portfolio_tree tree
    join public.portfolios child
      on child.parent_id = tree.portfolio_id
     and child.organization_id = p_organization_id
     and child.status = 'active'
  )
  select
    coalesce((select array_agg(property_id order by property_id) from actor_authorizations), '{}'::uuid[]),
    flags.whole_company_view,
    flags.can_manage_portfolios,
    coalesce((select array_agg(portfolio_id order by portfolio_id) from portfolio_tree), '{}'::uuid[])
  from flags;
$$;

-- ── 4.13 _staxis_company_structure_manageable_property_ids ─────────────────

create or replace function public._staxis_company_structure_manageable_property_ids(
  p_actor_account_id uuid,
  p_organization_id uuid
)
returns uuid[]
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with recursive
  live_actor as (
    select account.id
    from public.accounts account
    join public.account_authorization_state state
      on state.account_id = account.id
     and state.authority_mode = 'normalized'
    join public.organizations organization
      on organization.id = p_organization_id
     and organization.status = 'active'
     and organization.organization_type in ('management_company', 'ownership_group')
    where account.id = p_actor_account_id
      and account.active is true
      and account.role <> 'admin'
  ),
  active_memberships as (
    select membership.*
    from public.organization_memberships membership
    join live_actor actor on actor.id = membership.account_id
    where membership.organization_id = p_organization_id
      and membership.status = 'active'
      and membership.starts_at <= now()
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
      and grant_row.starts_at <= now()
      and (grant_row.expires_at is null or grant_row.expires_at > now())
  ),
  broad_manager as (
    select (
      exists (
        select 1
        from active_memberships membership
        where membership.membership_scope = 'company'
          and membership.staxis_role in ('owner', 'regional_manager')
      ) or exists (
        select 1
        from active_grants grant_row
        where grant_row.scope_type = 'organization'
          and grant_row.access_profile in ('organization_owner', 'organization_admin')
      )
    ) as allowed
  ),
  manager_portfolio_tree (portfolio_id) as (
    select portfolio.id
    from active_grants grant_row
    join public.portfolios portfolio
      on portfolio.id = grant_row.portfolio_id
     and portfolio.organization_id = grant_row.organization_id
     and portfolio.status = 'active'
    where grant_row.scope_type = 'portfolio'
      and grant_row.access_profile = 'portfolio_manager'

    union

    select child.id
    from manager_portfolio_tree tree
    join public.portfolios child
      on child.parent_id = tree.portfolio_id
     and child.organization_id = p_organization_id
     and child.status = 'active'
  ),
  governed_relationships as (
    select relationship.id, relationship.property_id
    from public._staxis_current_primary_property_relationships() relationship
    where relationship.organization_id = p_organization_id
      and relationship.active_primary_count = 1
  ),
  manageable as (
    select relationship.property_id
    from governed_relationships relationship
    cross join broad_manager manager
    where manager.allowed

    union

    select relationship.property_id
    from manager_portfolio_tree tree
    join public.portfolio_properties assignment
      on assignment.organization_id = p_organization_id
     and assignment.portfolio_id = tree.portfolio_id
     and assignment.assigned_at <= now()
     and (assignment.removed_at is null or assignment.removed_at > now())
    join governed_relationships relationship
      on relationship.id = assignment.property_relationship_id
     and relationship.property_id = assignment.property_id
  )
  select coalesce(array_agg(property_id order by property_id), '{}'::uuid[])
  from manageable;
$$;

-- ── 4.14 _staxis_company_access_can_delegate ───────────────────────────────

create or replace function public._staxis_company_access_can_delegate(
  p_actor_account_id uuid,
  p_organization_id uuid,
  p_access_profile text,
  p_scope_type text,
  p_portfolio_id uuid,
  p_property_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_actor_account_id is null
     or p_organization_id is null
     or p_access_profile not in (
       'organization_owner', 'organization_admin', 'portfolio_manager',
       'property_manager', 'department_lead', 'contributor', 'viewer',
       'external_collaborator'
     )
     or p_scope_type not in ('organization', 'portfolio', 'property')
  then
    return false;
  end if;

  if (p_access_profile in ('organization_owner', 'organization_admin')
      and p_scope_type <> 'organization')
     or (p_access_profile = 'portfolio_manager' and p_scope_type <> 'portfolio')
     or (p_access_profile = 'property_manager' and p_scope_type <> 'property')
  then
    return false;
  end if;

  if not exists (
    select 1
    from public.accounts account
    join public.account_authorization_state state
      on state.account_id = account.id
     and state.authority_mode = 'normalized'
    join public.organizations organization
      on organization.id = p_organization_id
     and organization.status = 'active'
     and organization.organization_type in ('management_company', 'ownership_group')
    where account.id = p_actor_account_id
      and account.active is true
      and account.role <> 'admin'
  ) or not exists (
    select 1
    from public._staxis_nonlegacy_property_authorizations(p_actor_account_id) authz
    where authz.organization_id = p_organization_id
  ) then
    return false;
  end if;

  if p_scope_type = 'organization' then
    if p_portfolio_id is not null or p_property_id is not null then return false; end if;
  elsif p_scope_type = 'portfolio' then
    if p_portfolio_id is null or p_property_id is not null or not exists (
      select 1 from public.portfolios portfolio
      where portfolio.id = p_portfolio_id
        and portfolio.organization_id = p_organization_id
        and portfolio.status = 'active'
    ) then return false; end if;
  else
    if p_property_id is null or p_portfolio_id is not null or not exists (
      select 1
      from public._staxis_current_primary_property_relationships() relationship
      join public._staxis_nonlegacy_property_authorizations(p_actor_account_id) authz
        on authz.organization_id = relationship.organization_id
       and authz.property_id = relationship.property_id
      where relationship.organization_id = p_organization_id
        and relationship.property_id = p_property_id
        and relationship.active_primary_count = 1
    ) then return false; end if;
  end if;

  -- Company owner: any valid normalized profile/scope in this company.
  if exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.account_id = p_actor_account_id
      and membership.status = 'active'
      and membership.starts_at <= now()
      and membership.ended_at is null
      and membership.membership_scope = 'company'
      and membership.staxis_role = 'owner'
  ) then
    return true;
  end if;

  -- Company VP has manage_access but cannot mint an owner/admin/peer portfolio
  -- authority. Finance and all property hats intentionally have no branch.
  if p_access_profile in (
       'property_manager', 'department_lead', 'contributor', 'viewer',
       'external_collaborator'
     ) and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.account_id = p_actor_account_id
      and membership.status = 'active'
      and membership.starts_at <= now()
      and membership.ended_at is null
      and membership.membership_scope = 'company'
      and membership.staxis_role = 'regional_manager'
  ) then
    return true;
  end if;

  -- Normalized organization owner/admin grants follow the canonical
  -- DELEGATABLE_PROFILES hierarchy.
  if exists (
    select 1
    from public.organization_access_grants actor_grant
    join public.organization_memberships actor_membership
      on actor_membership.id = actor_grant.membership_id
     and actor_membership.organization_id = actor_grant.organization_id
    where actor_membership.account_id = p_actor_account_id
      and actor_membership.organization_id = p_organization_id
      and actor_membership.status = 'active'
      and actor_membership.starts_at <= now()
      and actor_membership.ended_at is null
      and actor_grant.status = 'active'
      and actor_grant.source <> 'legacy_backfill'
      and actor_grant.starts_at <= now()
      and (actor_grant.expires_at is null or actor_grant.expires_at > now())
      and actor_grant.scope_type = 'organization'
      and (
        actor_grant.access_profile = 'organization_owner'
        or (
          actor_grant.access_profile = 'organization_admin'
          and p_access_profile not in ('organization_owner', 'organization_admin')
        )
      )
  ) then
    return true;
  end if;

  -- A normalized portfolio manager can delegate only lower access inside the
  -- exact portfolio they hold. Property-manager holders are excluded from
  -- this company-level editor even though hotel-specific team tooling remains.
  if p_access_profile in (
       'property_manager', 'department_lead', 'contributor', 'viewer',
       'external_collaborator'
     ) and exists (
    select 1
    from public.organization_access_grants actor_grant
    join public.organization_memberships actor_membership
      on actor_membership.id = actor_grant.membership_id
     and actor_membership.organization_id = actor_grant.organization_id
    join public.portfolios held_portfolio
      on held_portfolio.id = actor_grant.portfolio_id
     and held_portfolio.organization_id = actor_grant.organization_id
     and held_portfolio.status = 'active'
    where actor_membership.account_id = p_actor_account_id
      and actor_membership.organization_id = p_organization_id
      and actor_membership.status = 'active'
      and actor_membership.starts_at <= now()
      and actor_membership.ended_at is null
      and actor_grant.status = 'active'
      and actor_grant.source <> 'legacy_backfill'
      and actor_grant.starts_at <= now()
      and (actor_grant.expires_at is null or actor_grant.expires_at > now())
      and actor_grant.access_profile = 'portfolio_manager'
      and actor_grant.scope_type = 'portfolio'
      and (
        (p_scope_type = 'portfolio' and p_portfolio_id = actor_grant.portfolio_id)
        or (
          p_scope_type = 'property'
          and exists (
            select 1
            from public.portfolio_properties assignment
            join public._staxis_current_primary_property_relationships() relationship
              on relationship.id = assignment.property_relationship_id
             and relationship.organization_id = assignment.organization_id
             and relationship.property_id = assignment.property_id
            where assignment.organization_id = p_organization_id
              and assignment.portfolio_id = actor_grant.portfolio_id
              and assignment.property_id = p_property_id
              and assignment.assigned_at <= now()
              and (assignment.removed_at is null or assignment.removed_at > now())
              and relationship.active_primary_count = 1
          )
        )
      )
  ) then
    return true;
  end if;

  return false;
end;
$$;

-- ── 4.15 staxis_company_access_editor_projection_v2 ────────────────────────

create or replace function public.staxis_company_access_editor_projection_v2(
  p_actor_account_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_base jsonb;
  v_organization jsonb;
  v_organizations jsonb := '[]'::jsonb;
  v_grant_memberships jsonb;
  v_hat_memberships jsonb;
begin
  v_base := public.staxis_company_access_editor_projection(p_actor_account_id);
  if v_base is null or jsonb_typeof(v_base->'organizations') <> 'array' then
    raise exception 'company access editor v1 projection was malformed'
      using errcode = '22023';
  end if;

  for v_organization in
    select organization_value
    from jsonb_array_elements(v_base->'organizations') organization_value
  loop
    select coalesce(jsonb_agg(
      membership_value || jsonb_build_object(
        'sourceKind', 'grant_set',
        'sourceRole', null,
        'sourceScope', null
      ) order by membership_value->>'id'
    ), '[]'::jsonb)
      into v_grant_memberships
    from jsonb_array_elements(v_organization->'memberships') membership_value;

    select coalesce(jsonb_agg(jsonb_build_object(
      'id', membership.id,
      'accessRevision', public._staxis_company_access_hat_conversion_revision(membership.id),
      'sourceKind', 'membership_hat',
      'sourceRole', membership.staxis_role,
      'sourceScope', membership.membership_scope,
      'canAdd', false,
      'canReplace', public._staxis_company_access_can_retire_hat(
        p_actor_account_id, membership.id
      ),
      'blockedReason', case
        when public._staxis_company_access_can_retire_hat(
          p_actor_account_id, membership.id
        ) then null
        else 'membership_hat_outside_scope'
      end,
      'currentGrants', case
        when membership.membership_scope = 'company' then jsonb_build_array(
          jsonb_build_object(
            'id', membership.id,
            'accessProfile', case membership.staxis_role
              when 'owner' then 'organization_owner'
              when 'regional_manager' then 'contributor'
              else 'viewer'
            end,
            'scopeType', 'organization',
            'portfolioId', null,
            'propertyId', null,
            'startsAt', membership.starts_at,
            'expiresAt', null
          )
        )
        else coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', relationship.id,
            'accessProfile', case membership.staxis_role
              when 'general_manager' then 'property_manager'
              when 'front_desk' then 'contributor'
              else 'viewer'
            end,
            'scopeType', 'property',
            'portfolioId', null,
            'propertyId', relationship.property_id,
            'startsAt', membership.starts_at,
            'expiresAt', null
          ) order by relationship.property_id)
          from public._staxis_current_primary_property_relationships() relationship
          where relationship.organization_id = membership.organization_id
            and relationship.property_id = any(
              coalesce(membership.covered_property_ids, '{}'::uuid[])
            )
            and relationship.active_primary_count = 1
        ), '[]'::jsonb)
      end
    ) order by target_account.display_name, membership.id), '[]'::jsonb)
      into v_hat_memberships
    from public.organization_memberships membership
    join public.accounts target_account
      on target_account.id = membership.account_id
     and target_account.active is true
     and target_account.role <> 'admin'
    where membership.organization_id = (v_organization->>'id')::uuid
      and membership.account_id <> p_actor_account_id
      and membership.status = 'active'
      and membership.starts_at <= clock_timestamp()
      and membership.ended_at is null
      and membership.staxis_role is not null
      and membership.membership_scope in ('company', 'property');

    v_organization := jsonb_set(
      v_organization,
      '{memberships}',
      coalesce(v_grant_memberships, '[]'::jsonb)
        || coalesce(v_hat_memberships, '[]'::jsonb),
      true
    );
    v_organizations := v_organizations || jsonb_build_array(v_organization);
  end loop;

  return jsonb_build_object(
    'schemaVersion', 'company-access-editor-v2',
    'generatedAt', clock_timestamp(),
    'organizations', v_organizations
  );
end;
$$;

-- ── 4.16 _staxis_company_knowledge_editor_role ─────────────────────────────

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
         and entitlement->>'staxisRole' in ('owner', 'regional_manager')
          then entitlement->>'staxisRole'
        when entitlement->>'scopeType' = 'organization'
         and entitlement->>'accessProfile' = 'organization_owner' then 'owner'
        when entitlement->>'scopeType' = 'organization'
         and entitlement->>'accessProfile' = 'organization_admin' then 'regional_manager'
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
  order by case complete.role when 'owner' then 1 when 'regional_manager' then 2 else 3 end
  limit 1;
  if v_role is null then return null; end if;

  select setting.setting_value into v_choice
  from public.company_access_settings setting
  where setting.organization_id = p_organization_id
    and setting.setting_key = 'rulebook_editors';
  v_choice := coalesce(v_choice, 'owner_and_vp');

  if v_role = 'owner'
     or (v_role = 'regional_manager'
       and v_choice in ('owner_and_vp', 'company_scope')) then
    return v_role;
  end if;
  return null;
exception when others then
  return null;
end;
$$;

-- ─── 5. Bookkeeping ────────────────────────────────────────────────────────

insert into public.applied_migrations (version, description)
values (
  '0461',
  'Company invite rescope. (1) A company-scope hat now carries EITHER an explicit covered_property_ids list OR NULL, where NULL keeps the pre-0461 "every hotel including future acquisitions" meaning; the hat-shape CHECKs on organization_memberships and account_invites allow both. This is what lets a management company give an Owner 3 of its 20 hotels without exposing the other 17. (2) The company role vocabulary collapses from owner|vp|finance to owner|regional_manager: vp is renamed and finance is retired, with existing hats, pending account_invites and stored company_authority_rules.approver_role rows converted to regional_manager, and a duplicate vp+finance holder having their finance row ended first so the one-hat-per-job unique index still holds. (3) 16 functions that branched on the retired words were redefined, of which four also learned the coverage rule: _staxis_nonlegacy_property_authorizations and _staxis_structural_account_property_ids now intersect a company hat with its own list, and _staxis_can_set_membership_hat / _staxis_can_control_account_invite / staxis_accept_account_invite / staxis_grant_existing_account_invite_guarded accept and enforce the two shapes. Nobody may grant past their own edge, and only an actor whose own standing is itself all-including-future may mint an all-including-future hat. No existing row changes coverage: every current company hat keeps NULL. RLS and grants unchanged; nothing granted to anon.'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
