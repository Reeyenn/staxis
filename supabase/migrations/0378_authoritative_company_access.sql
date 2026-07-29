-- 0378_authoritative_company_access.sql
--
-- One authority at a time. `accounts.property_access` is the legacy authority;
-- organization hats/grants are the normalized authority. An account is always
-- in exactly one durable mode (legacy, shadow, normalized), never a runtime
-- union of both. First normalized entitlement performs an audited cutover and
-- preserves only unmatched legacy hotel access as explicit bridge rows.
--
-- Portfolio AI receives an immutable, short-lived scope receipt. The receipt
-- contains BOTH the complete organization-wide authorized set and the exact
-- selector result. It is untruncated, versioned, epoch-bound, reproducible and
-- service-role-only. Every governing relationship is a current primary
-- owner/operator row; brand/vendor/consultant links never authorize customer
-- data. Portfolio grants and selectors include cycle-safe descendants.

begin;

do $$
begin
  if to_regclass('public.accounts') is null
     or to_regclass('public.organizations') is null
     or to_regclass('public.organization_memberships') is null
     or to_regclass('public.organization_access_grants') is null
     or to_regclass('public.organization_property_relationships') is null
     or to_regclass('public.organization_access_epochs') is null
     or to_regprocedure('public.staxis_account_reaches_property(uuid,uuid)') is null
  then
    raise exception '0378 requires organization access migrations 0325, 0364 and 0371';
  end if;
end
$$;

-- ── Durable rollout state ──────────────────────────────────────────────────

-- @rls: service-role-only — authority rollout state is exposed only through
-- fail-closed SECURITY DEFINER authorization functions, never direct clients.
create table if not exists public.account_authorization_state (
  account_id             uuid primary key references public.accounts(id) on delete cascade,
  authority_mode         text not null default 'legacy',
  authority_version      bigint not null default 1,
  legacy_scope_hash      text not null default '',
  normalized_scope_hash  text not null default '',
  cutover_at             timestamptz,
  cutover_reason         text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint account_authorization_state_mode_check
    check (authority_mode in ('legacy', 'shadow', 'normalized')),
  constraint account_authorization_state_version_check check (authority_version > 0),
  constraint account_authorization_state_cutover_check check (
    (authority_mode in ('legacy', 'shadow') and cutover_at is null)
    or (authority_mode = 'normalized' and cutover_at is not null)
  )
);

comment on table public.account_authorization_state is
  'The one authoritative access model for each account. legacy/shadow read only accounts.property_access; normalized reads only normalized entitlements plus explicit bridge rows. Runtime union is forbidden.';

-- @rls: service-role-only — migration bridges are authorization internals;
-- direct browser visibility would disclose otherwise inaccessible hotel IDs.
create table if not exists public.account_property_authorization_bridges (
  id                       uuid primary key default gen_random_uuid(),
  account_id               uuid not null references public.accounts(id) on delete cascade,
  property_id              uuid not null references public.properties(id) on delete cascade,
  -- Bind the bridge to the governing topology that existed at cutover. Both
  -- are null only when the hotel was independent at that instant. A bridge is
  -- invalid as soon as that exact relationship stops governing; it must never
  -- follow a transferred hotel into the acquiring company.
  cutover_organization_id  uuid,
  cutover_relationship_id  uuid,
  topology_bound_at        timestamptz not null default now(),
  status                   text not null default 'active',
  source_legacy_scope_hash text not null,
  cutover_reason           text not null,
  created_at               timestamptz not null default now(),
  retired_at               timestamptz,
  retirement_reason        text,

  constraint account_property_authorization_bridges_status_check
    check (status in ('active', 'retired')),
  constraint account_property_authorization_bridges_shape_check check (
    (status = 'active' and retired_at is null and retirement_reason is null)
    or (status = 'retired' and retired_at is not null
        and char_length(btrim(retirement_reason)) between 1 and 500)
  ),
  constraint account_property_authorization_bridges_reason_check
    check (char_length(btrim(cutover_reason)) between 1 and 500),
  constraint account_property_authorization_bridges_topology_shape_check
    check ((cutover_organization_id is null) = (cutover_relationship_id is null))
);

-- Rerun safety for a pre-release draft that did not capture cutover topology.
-- There is no safe way to infer whether today's company is the old or acquiring
-- company, so those draft rows are retired instead of being rebound.
alter table public.account_property_authorization_bridges
  add column if not exists cutover_organization_id uuid;
alter table public.account_property_authorization_bridges
  add column if not exists cutover_relationship_id uuid;
alter table public.account_property_authorization_bridges
  add column if not exists topology_bound_at timestamptz;
update public.account_property_authorization_bridges
   set status = 'retired',
       retired_at = coalesce(retired_at, clock_timestamp()),
       retirement_reason = coalesce(
         retirement_reason,
         'Retired during 0378 topology-binding upgrade; original company cannot be proven'
       ),
       topology_bound_at = clock_timestamp()
 where topology_bound_at is null;
alter table public.account_property_authorization_bridges
  alter column topology_bound_at set default now();
alter table public.account_property_authorization_bridges
  alter column topology_bound_at set not null;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.account_property_authorization_bridges'::regclass
      and conname = 'account_property_authorization_bridges_topology_shape_check'
  ) then
    alter table public.account_property_authorization_bridges
      add constraint account_property_authorization_bridges_topology_shape_check
      check ((cutover_organization_id is null) = (cutover_relationship_id is null));
  end if;
end
$$;

create unique index if not exists account_property_authorization_bridge_active_idx
  on public.account_property_authorization_bridges (account_id, property_id)
  where status = 'active';
create index if not exists account_property_authorization_bridge_account_idx
  on public.account_property_authorization_bridges (account_id, status, property_id);

comment on table public.account_property_authorization_bridges is
  'Explicit migration bridge for a legacy hotel not covered when an account cuts over. It is bound to the exact governing topology at cutover, never follows a hotel transfer, and retires permanently when superseded or invalidated.';

-- @rls: service-role-only — immutable receipts are asserted by scoped server
-- RPCs; direct reads could expose cross-hotel scope, provenance and topology.
create table if not exists public.authorization_scope_receipts (
  id                              uuid primary key default gen_random_uuid(),
  -- Deliberately retain opaque IDs after account/company deletion: this is an
  -- audit receipt, not a child authorization row, and must never block GDPR /
  -- account lifecycle deletion through an immutable CASCADE trigger.
  account_id                      uuid not null,
  organization_id                 uuid not null,
  organization_name               text not null,
  authority_mode                  text not null,
  selector_type                   text not null,
  requested_portfolio_id          uuid,
  requested_property_ids          uuid[] not null default '{}',
  authorized_property_ids         uuid[] not null,
  selected_property_ids           uuid[] not null,
  portfolio_catalog               jsonb not null default '[]'::jsonb,
  account_authorization_version   bigint not null,
  organization_access_epoch       bigint not null,
  resolver_version                text not null,
  authorization_hash              text not null,
  scope_hash                      text not null,
  provenance                      jsonb not null default '{}'::jsonb,
  resolved_at                     timestamptz not null default now(),
  expires_at                      timestamptz not null,

  constraint authorization_scope_receipts_mode_check
    check (authority_mode = 'normalized'),
  constraint authorization_scope_receipts_selector_check
    check (selector_type in ('all_authorized', 'portfolio', 'property_subset')),
  constraint authorization_scope_receipts_selector_shape_check check (
    (selector_type = 'all_authorized' and requested_portfolio_id is null
      and cardinality(requested_property_ids) = 0)
    or (selector_type = 'portfolio' and requested_portfolio_id is not null
      and cardinality(requested_property_ids) = 0)
    or (selector_type = 'property_subset' and requested_portfolio_id is null
      and cardinality(requested_property_ids) > 0)
  ),
  constraint authorization_scope_receipts_nonempty_check
    check (cardinality(authorized_property_ids) > 0
      and cardinality(selected_property_ids) > 0),
  constraint authorization_scope_receipts_subset_check
    check (selected_property_ids <@ authorized_property_ids),
  constraint authorization_scope_receipts_catalog_check
    check (jsonb_typeof(portfolio_catalog) = 'array'),
  constraint authorization_scope_receipts_provenance_check
    check (jsonb_typeof(provenance) = 'object'),
  constraint authorization_scope_receipts_hash_check
    check (authorization_hash ~ '^[0-9a-f]{64}$'
      and scope_hash ~ '^[0-9a-f]{64}$'),
  constraint authorization_scope_receipts_window_check
    check (expires_at > resolved_at and expires_at <= resolved_at + interval '5 minutes')
);

create index if not exists authorization_scope_receipts_account_expiry_idx
  on public.authorization_scope_receipts (account_id, expires_at desc);
create index if not exists authorization_scope_receipts_org_expiry_idx
  on public.authorization_scope_receipts (organization_id, expires_at desc);

comment on table public.authorization_scope_receipts is
  'Immutable authorization assertion used by portfolio intelligence. authorized_property_ids is the caller full current org reach; selected_property_ids is this query exact subset. Neither is truncated.';

-- Rerun safety for pre-release drafts that briefly declared cascading FKs.
-- Receipt subject IDs are deliberately retained as audit identifiers.
alter table public.authorization_scope_receipts
  drop constraint if exists authorization_scope_receipts_account_id_fkey;
alter table public.authorization_scope_receipts
  drop constraint if exists authorization_scope_receipts_organization_id_fkey;

-- ── Normalized entitlement projection ─────────────────────────────────────

-- Canonical current-primary projection. Ambiguous hotels deliberately retain
-- every current row with a count greater than one so customer readers can
-- deny access without rewriting evidence needed by platform-admin repair.
create or replace function public._staxis_current_primary_property_relationships()
returns table (
  id uuid,
  organization_id uuid,
  property_id uuid,
  relationship_type text,
  starts_at timestamptz,
  ends_at timestamptz,
  active_primary_count bigint
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select relationship.id,
         relationship.organization_id,
         relationship.property_id,
         relationship.relationship_type,
         relationship.starts_at,
         relationship.ends_at,
         count(*) over (partition by relationship.property_id)
  from public.organization_property_relationships relationship
  where relationship.is_primary_grouping is true
    and relationship.relationship_type in ('operator', 'owner')
    and relationship.starts_at <= now()
    and (relationship.ends_at is null or relationship.ends_at > now());
$$;

revoke all on function public._staxis_current_primary_property_relationships()
  from public, anon, authenticated, service_role;

create or replace function public._staxis_organization_has_ambiguous_primary_topology(
  p_organization_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public._staxis_current_primary_property_relationships() relationship
    where relationship.organization_id = p_organization_id
      and relationship.active_primary_count > 1
  );
$$;

revoke all on function public._staxis_organization_has_ambiguous_primary_topology(uuid)
  from public, anon, authenticated, service_role;

-- Potential portfolio/company jobs are derived from entitlement facts rather
-- than the fail-closed property projection. That distinction lets the scope
-- resolver report an unavailable organization instead of silently shortening
-- an `all_authorized` scope when the corrupt hotel is the only hotel involved.
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
      and membership.staxis_role in ('owner', 'vp', 'finance')

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

revoke all on function public._staxis_account_ambiguous_portfolio_organizations(uuid)
  from public, anon, authenticated, service_role;

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
             and m.staxis_role in ('owner', 'vp', 'finance'))
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
    -- A company hat follows current governing topology; no hotel list is copied.
    select h.account_id, h.organization_id, r.property_id,
           'membership_hat'::text as entitlement_kind,
           h.id as entitlement_id, h.id as membership_id,
           null::text as access_profile, h.staxis_role,
           h.membership_scope as scope_type, null::uuid as portfolio_id,
           true as can_portfolio_intelligence
    from active_hats h
    join governing_relationships r on r.organization_id = h.organization_id
    where h.membership_scope = 'company'

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

revoke all on function public._staxis_nonlegacy_property_authorizations(uuid)
  from public, anon, authenticated, service_role;

create or replace function public._staxis_account_property_authorizations(
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
  select normalized.*
  from public._staxis_nonlegacy_property_authorizations(p_account_id) normalized
  join public.account_authorization_state state
    on state.account_id = normalized.account_id
   and state.authority_mode = 'normalized'

  union all

  select bridge.account_id, bridge.cutover_organization_id, bridge.property_id,
         'legacy_bridge'::text, bridge.id, null::uuid, null::text, null::text,
         'property'::text, null::uuid, false
  from public.account_property_authorization_bridges bridge
  join public.account_authorization_state state
    on state.account_id = bridge.account_id
   and state.authority_mode = 'normalized'
  join public.accounts account
    on account.id = bridge.account_id and account.active is true
  where bridge.account_id = p_account_id
    and bridge.status = 'active'
    and (
      -- Independent at cutover: valid only while it remains independent.
      (bridge.cutover_relationship_id is null and not exists (
        select 1
        from public._staxis_current_primary_property_relationships() current_relationship
        where current_relationship.property_id = bridge.property_id
      ))
      or exists (
        -- Company hotel at cutover: the exact relationship must still govern.
        select 1
        from public._staxis_current_primary_property_relationships() current_relationship
        where current_relationship.id = bridge.cutover_relationship_id
          and current_relationship.organization_id = bridge.cutover_organization_id
          and current_relationship.property_id = bridge.property_id
          and current_relationship.active_primary_count = 1
      )
    );
$$;

revoke all on function public._staxis_account_property_authorizations(uuid)
  from public, anon, authenticated, service_role;

-- Replace the older grant projection with the same governing/descendant rules.
-- Its column contract stays identical for existing service readers.
create or replace view public.organization_effective_property_access
with (security_invoker = true)
as
with recursive
valid_memberships as (
  select membership.*
  from public.organization_memberships membership
  join public.accounts account
    on account.id = membership.account_id
   and account.role <> 'admin'
   and account.active is true
  join public.organizations organization
    on organization.id = membership.organization_id
   and organization.status = 'active'
  where membership.status = 'active'
    and membership.starts_at <= now()
    and membership.ended_at is null
),
valid_grants as (
  select grant_row.*
  from public.organization_access_grants grant_row
  join valid_memberships membership
    on membership.id = grant_row.membership_id
   and membership.organization_id = grant_row.organization_id
  where grant_row.status = 'active'
    and grant_row.starts_at <= now()
    and (grant_row.expires_at is null or grant_row.expires_at > now())
),
governing_relationships as (
  -- This compatibility view is SECURITY INVOKER. Inline the same canonical
  -- count instead of granting callers EXECUTE on the private definer helper,
  -- which would expose the complete raw company/property topology.
  select relationship.*
  from (
    select raw_relationship.*,
           count(*) over (partition by raw_relationship.property_id)
             as active_primary_count
    from public.organization_property_relationships raw_relationship
    where raw_relationship.is_primary_grouping is true
      and raw_relationship.relationship_type in ('operator', 'owner')
      and raw_relationship.starts_at <= now()
      and (raw_relationship.ends_at is null or raw_relationship.ends_at > now())
  ) relationship
  where relationship.active_primary_count = 1
),
portfolio_tree (grant_id, organization_id, portfolio_id) as (
  select grant_row.id, grant_row.organization_id, portfolio.id
  from valid_grants grant_row
  join public.portfolios portfolio
    on portfolio.id = grant_row.portfolio_id
   and portfolio.organization_id = grant_row.organization_id
   and portfolio.status = 'active'
  where grant_row.scope_type = 'portfolio'

  union

  select tree.grant_id, tree.organization_id, child.id
  from portfolio_tree tree
  join public.portfolios child
    on child.parent_id = tree.portfolio_id
   and child.organization_id = tree.organization_id
   and child.status = 'active'
),
expanded as (
  select grant_row.id as grant_id, grant_row.membership_id,
         grant_row.organization_id, relationship.property_id,
         grant_row.access_profile, grant_row.scope_type, grant_row.source,
         grant_row.starts_at, grant_row.expires_at,
         relationship.id as property_relationship_id
  from valid_grants grant_row
  join governing_relationships relationship
    on relationship.organization_id = grant_row.organization_id
  where grant_row.scope_type = 'organization'

  union all

  select grant_row.id, grant_row.membership_id, grant_row.organization_id,
         relationship.property_id, grant_row.access_profile,
         grant_row.scope_type, grant_row.source, grant_row.starts_at,
         grant_row.expires_at, relationship.id
  from valid_grants grant_row
  join portfolio_tree tree on tree.grant_id = grant_row.id
  join public.portfolio_properties assignment
    on assignment.organization_id = tree.organization_id
   and assignment.portfolio_id = tree.portfolio_id
   and assignment.assigned_at <= now()
   and (assignment.removed_at is null or assignment.removed_at > now())
  join governing_relationships relationship
    on relationship.id = assignment.property_relationship_id
   and relationship.organization_id = assignment.organization_id
   and relationship.property_id = assignment.property_id
  where grant_row.scope_type = 'portfolio'

  union all

  select grant_row.id, grant_row.membership_id, grant_row.organization_id,
         grant_row.property_id, grant_row.access_profile,
         grant_row.scope_type, grant_row.source, grant_row.starts_at,
         grant_row.expires_at, grant_row.property_relationship_id
  from valid_grants grant_row
  join governing_relationships relationship
    on relationship.id = grant_row.property_relationship_id
   and relationship.organization_id = grant_row.organization_id
   and relationship.property_id = grant_row.property_id
  where grant_row.scope_type = 'property'
)
select distinct membership.account_id, expanded.membership_id,
       expanded.organization_id, expanded.property_id, expanded.grant_id,
       expanded.access_profile, expanded.scope_type, expanded.source,
       expanded.starts_at, expanded.expires_at,
       expanded.property_relationship_id
from expanded
join valid_memberships membership on membership.id = expanded.membership_id;

revoke all on public.organization_effective_property_access
  from public, anon, authenticated;
grant select on public.organization_effective_property_access to service_role;

-- ── Cutover and version maintenance ───────────────────────────────────────

insert into public.account_authorization_state (
  account_id, authority_mode, authority_version, legacy_scope_hash,
  normalized_scope_hash
)
select a.id, 'legacy', 1,
       encode(sha256(convert_to(coalesce((
         select string_agg(property_id::text, ',' order by property_id::text)
         from unnest(a.property_access) property_id
       ), ''), 'UTF8')), 'hex'),
       encode(sha256(convert_to('', 'UTF8')), 'hex')
from public.accounts a
on conflict (account_id) do nothing;

create or replace function public._staxis_guard_authorization_state_transition()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.authority_mode = 'normalized' and new.authority_mode <> 'normalized' then
    raise exception 'normalized authorization cannot be downgraded to legacy/shadow'
      using errcode = '23514';
  end if;
  if new.authority_version < old.authority_version then
    raise exception 'authorization version cannot move backwards'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public._staxis_guard_authorization_state_transition()
  from public, anon, authenticated;

drop trigger if exists trg_account_authorization_state_transition
  on public.account_authorization_state;
create trigger trg_account_authorization_state_transition
  before update on public.account_authorization_state
  for each row execute function public._staxis_guard_authorization_state_transition();

create or replace function public._staxis_refresh_account_authorization(
  p_account_id uuid,
  p_reason text default 'authorization fact changed'
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mode text;
  v_has_real_entitlement boolean;
  v_legacy_hash text;
  v_normalized_hash text;
  v_now timestamptz := clock_timestamp();
begin
  if p_account_id is null then return; end if;

  insert into public.account_authorization_state (account_id)
  select a.id from public.accounts a where a.id = p_account_id
  on conflict (account_id) do nothing;

  select state.authority_mode into v_mode
  from public.account_authorization_state state
  where state.account_id = p_account_id
  for update;
  if not found then return; end if;

  select encode(sha256(convert_to(coalesce((
    select string_agg(property_id::text, ',' order by property_id::text)
    from public.accounts account
    cross join lateral unnest(account.property_access) property_id
    where account.id = p_account_id
  ), ''), 'UTF8')), 'hex')
  into v_legacy_hash;

  -- Scheduled hats/grants trigger cutover when they are created, not only
  -- after their wall-clock start. Their coverage still stays inactive in the
  -- projection until starts_at; cutting over early preserves legacy hotels as
  -- explicit bridges and lets the scheduled entitlement activate without a
  -- later write or a polling job.
  select (
    exists (
      select 1
      from public.organization_memberships membership
      join public.organizations organization
        on organization.id = membership.organization_id
       and organization.status = 'active'
       and organization.organization_type <> 'single_hotel'
      join public.accounts account
        on account.id = membership.account_id
       and account.active is true
       and account.role <> 'admin'
      where membership.account_id = p_account_id
        and membership.status = 'active'
        and membership.ended_at is null
        and membership.staxis_role is not null
    ) or exists (
      select 1
      from public.organization_access_grants grant_row
      join public.organization_memberships membership
        on membership.id = grant_row.membership_id
       and membership.organization_id = grant_row.organization_id
      join public.organizations organization
        on organization.id = grant_row.organization_id
       and organization.status = 'active'
       and organization.organization_type <> 'single_hotel'
      join public.accounts account
        on account.id = membership.account_id
       and account.active is true
       and account.role <> 'admin'
      where membership.account_id = p_account_id
        and membership.status = 'active'
        and membership.ended_at is null
        and grant_row.status = 'active'
        and grant_row.source <> 'legacy_backfill'
        and (grant_row.expires_at is null or grant_row.expires_at > now())
    )
  ) into v_has_real_entitlement;

  -- Deliberately do not auto-cut a shadow account: shadow is an explicit
  -- rollout state whose authority remains legacy while drift is measured.
  if v_mode = 'legacy' and v_has_real_entitlement then
    insert into public.account_property_authorization_bridges (
      account_id, property_id, cutover_organization_id,
      cutover_relationship_id, source_legacy_scope_hash, cutover_reason
    )
    select p_account_id, legacy_property.property_id,
           relationship.organization_id, relationship.id, v_legacy_hash,
           left(coalesce(nullif(btrim(p_reason), ''), 'normalized entitlement created'), 500)
    from public.accounts account
    cross join lateral unnest(account.property_access) legacy_property(property_id)
    left join lateral (
      select governing.id, governing.organization_id
      from public._staxis_current_primary_property_relationships() governing
      where governing.property_id = legacy_property.property_id
        and governing.active_primary_count = 1
      order by governing.id
      limit 1
    ) relationship on true
    where account.id = p_account_id
      and (
        relationship.id is not null
        or not exists (
          select 1
          from public._staxis_current_primary_property_relationships() current_relationship
          where current_relationship.property_id = legacy_property.property_id
        )
      )
      and not exists (
        select 1
        from public._staxis_nonlegacy_property_authorizations(p_account_id) normalized
        where normalized.property_id = legacy_property.property_id
      )
      and not exists (
        select 1
        from public.account_property_authorization_bridges existing_bridge
        where existing_bridge.account_id = p_account_id
          and existing_bridge.property_id = legacy_property.property_id
      );

    update public.account_authorization_state state
       set authority_mode = 'normalized',
           cutover_at = coalesce(state.cutover_at, v_now),
           cutover_reason = coalesce(
             state.cutover_reason,
             left(coalesce(nullif(btrim(p_reason), ''), 'normalized entitlement created'), 500)
           )
     where state.account_id = p_account_id;
    v_mode := 'normalized';
  end if;

  if v_mode = 'normalized' then
    -- Once a real entitlement covers a bridged hotel, the bridge is retired.
    -- If that entitlement is later revoked, the obsolete legacy array cannot
    -- resurrect access.
    update public.account_property_authorization_bridges bridge
       set status = 'retired',
           retired_at = v_now,
           retirement_reason = 'Superseded by normalized entitlement'
     where bridge.account_id = p_account_id
       and bridge.status = 'active'
       and exists (
         select 1
         from public._staxis_nonlegacy_property_authorizations(p_account_id) normalized
         where normalized.property_id = bridge.property_id
       );
  end if;

  select encode(sha256(convert_to(coalesce(string_agg(
    concat_ws(':', authz.organization_id::text,
                    authz.property_id::text,
                    authz.entitlement_kind,
                    authz.entitlement_id::text,
                    coalesce(authz.scope_type, ''),
                    coalesce(authz.portfolio_id::text, ''),
                    authz.can_portfolio_intelligence::text),
    ',' order by authz.organization_id::text nulls first,
                 authz.property_id::text,
                 authz.entitlement_kind,
                 authz.entitlement_id::text
  ), ''), 'UTF8')), 'hex')
  into v_normalized_hash
  from (
    select *
    from public._staxis_account_property_authorizations(p_account_id)
    where v_mode = 'normalized'

    union all

    select *
    from public._staxis_nonlegacy_property_authorizations(p_account_id)
    where v_mode = 'shadow'
  ) authz;

  update public.account_authorization_state state
     set legacy_scope_hash = coalesce(v_legacy_hash, encode(sha256(convert_to('', 'UTF8')), 'hex')),
         normalized_scope_hash = coalesce(v_normalized_hash, encode(sha256(convert_to('', 'UTF8')), 'hex')),
         authority_version = state.authority_version + 1,
         updated_at = v_now
   where state.account_id = p_account_id;
end;
$$;

revoke all on function public._staxis_refresh_account_authorization(uuid, text)
  from public, anon, authenticated;
grant execute on function public._staxis_refresh_account_authorization(uuid, text)
  to service_role;

-- Idempotent rollout door for accounts deliberately held in shadow mode.
-- Directly flipping the state row would either drop unmatched legacy hotels or
-- encourage a live legacy/normalized union. This function applies the same
-- one-way bridge rule as automatic first-entitlement cutover, then refreshes
-- the version/hash used to invalidate receipts and caches.
create or replace function public.staxis_promote_shadow_authorization(
  p_account_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_state public.account_authorization_state%rowtype;
  v_legacy_hash text;
  v_now timestamptz := clock_timestamp();
  v_reason text;
begin
  if p_account_id is null
     or p_reason is null
     or char_length(btrim(p_reason)) not between 1 and 500 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_request');
  end if;
  v_reason := btrim(p_reason);

  select state.* into v_state
  from public.account_authorization_state state
  where state.account_id = p_account_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_state.authority_mode = 'normalized' then
    return jsonb_build_object(
      'ok', true,
      'status', 'already_normalized',
      'accountId', p_account_id,
      'authorityVersion', v_state.authority_version
    );
  end if;
  if v_state.authority_mode <> 'shadow' then
    return jsonb_build_object('ok', false, 'reason', 'not_shadow');
  end if;

  select encode(sha256(convert_to(coalesce((
    select string_agg(property_id::text, ',' order by property_id::text)
    from public.accounts account
    cross join lateral unnest(account.property_access) property_id
    where account.id = p_account_id
  ), ''), 'UTF8')), 'hex')
  into v_legacy_hash;

  insert into public.account_property_authorization_bridges (
    account_id, property_id, cutover_organization_id,
    cutover_relationship_id, source_legacy_scope_hash, cutover_reason
  )
  select p_account_id, legacy_property.property_id,
         relationship.organization_id, relationship.id, v_legacy_hash, v_reason
  from public.accounts account
  cross join lateral unnest(account.property_access) legacy_property(property_id)
  left join lateral (
    select governing.id, governing.organization_id
    from public._staxis_current_primary_property_relationships() governing
    where governing.property_id = legacy_property.property_id
      and governing.active_primary_count = 1
    order by governing.id
    limit 1
  ) relationship on true
  where account.id = p_account_id
    and (
      relationship.id is not null
      or not exists (
        select 1
        from public._staxis_current_primary_property_relationships() current_relationship
        where current_relationship.property_id = legacy_property.property_id
      )
    )
    and not exists (
      select 1
      from public._staxis_nonlegacy_property_authorizations(p_account_id) normalized
      where normalized.property_id = legacy_property.property_id
    )
    -- A retired bridge is a durable revocation decision and must never be
    -- recreated by a retried or manually repaired rollout.
    and not exists (
      select 1
      from public.account_property_authorization_bridges existing_bridge
      where existing_bridge.account_id = p_account_id
        and existing_bridge.property_id = legacy_property.property_id
    );

  update public.account_authorization_state state
     set authority_mode = 'normalized',
         cutover_at = v_now,
         cutover_reason = v_reason
   where state.account_id = p_account_id;

  perform public._staxis_refresh_account_authorization(
    p_account_id, 'shadow promotion: ' || v_reason
  );
  select state.* into v_state
  from public.account_authorization_state state
  where state.account_id = p_account_id;

  return jsonb_build_object(
    'ok', true,
    'status', 'promoted',
    'accountId', p_account_id,
    'authorityVersion', v_state.authority_version
  );
end;
$$;

revoke all on function public.staxis_promote_shadow_authorization(uuid, text)
  from public, anon, authenticated;
grant execute on function public.staxis_promote_shadow_authorization(uuid, text)
  to service_role;

create or replace function public._staxis_refresh_account_authorization_from_account()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._staxis_refresh_account_authorization(new.id, 'account authorization fields changed');
  return new;
end;
$$;

create or replace function public._staxis_refresh_account_authorization_from_membership()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    perform public._staxis_refresh_account_authorization(old.account_id, 'organization membership removed');
    return old;
  end if;
  if tg_op = 'UPDATE' and old.account_id is distinct from new.account_id then
    perform public._staxis_refresh_account_authorization(old.account_id, 'organization membership moved');
  end if;
  perform public._staxis_refresh_account_authorization(new.account_id, 'organization membership changed');
  return new;
end;
$$;

create or replace function public._staxis_refresh_account_authorization_from_grant()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old_account_id uuid;
  v_new_account_id uuid;
begin
  if tg_op <> 'INSERT' then
    select membership.account_id into v_old_account_id
    from public.organization_memberships membership
    where membership.id = old.membership_id;
  end if;
  if tg_op <> 'DELETE' then
    select membership.account_id into v_new_account_id
    from public.organization_memberships membership
    where membership.id = new.membership_id;
  end if;
  if v_old_account_id is not null then
    perform public._staxis_refresh_account_authorization(v_old_account_id, 'organization access grant changed');
  end if;
  if v_new_account_id is not null and v_new_account_id is distinct from v_old_account_id then
    perform public._staxis_refresh_account_authorization(v_new_account_id, 'organization access grant changed');
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function public._staxis_refresh_account_authorization_from_account()
  from public, anon, authenticated;
revoke all on function public._staxis_refresh_account_authorization_from_membership()
  from public, anon, authenticated;
revoke all on function public._staxis_refresh_account_authorization_from_grant()
  from public, anon, authenticated;

drop trigger if exists trg_accounts_authorization_refresh on public.accounts;
create trigger trg_accounts_authorization_refresh
  after insert or update of property_access, active, role on public.accounts
  for each row execute function public._staxis_refresh_account_authorization_from_account();

-- PostgreSQL orders same-event triggers by name. The `00_` prefix is
-- intentional: authorization refresh locks account state before the existing
-- access-audit trigger bumps/locks the organization epoch. Receipt issuance
-- uses that same state -> epoch order, avoiding a revocation/receipt deadlock.
drop trigger if exists trg_organization_memberships_authorization_refresh
  on public.organization_memberships;
drop trigger if exists trg_organization_memberships_00_authorization_refresh
  on public.organization_memberships;
create trigger trg_organization_memberships_00_authorization_refresh
  after insert or update or delete on public.organization_memberships
  for each row execute function public._staxis_refresh_account_authorization_from_membership();

drop trigger if exists trg_organization_access_grants_authorization_refresh
  on public.organization_access_grants;
drop trigger if exists trg_organization_access_grants_00_authorization_refresh
  on public.organization_access_grants;
create trigger trg_organization_access_grants_00_authorization_refresh
  after insert or update or delete on public.organization_access_grants
  for each row execute function public._staxis_refresh_account_authorization_from_grant();

-- A bridge is a cutover-time compatibility fact, not a portable hotel grant.
-- Retire it permanently when the property's governing topology no longer
-- matches the topology captured on the bridge. The `00` name intentionally
-- runs before organization epoch/audit triggers, preserving the global lock
-- order account-state -> organization-epoch used by receipt issuance.
create or replace function public._staxis_retire_bridges_after_relationship_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_property_ids uuid[];
  v_account_id uuid;
begin
  v_property_ids := case
    when tg_op = 'INSERT' then array[new.property_id]
    when tg_op = 'DELETE' then array[old.property_id]
    else array[old.property_id, new.property_id]
  end;

  for v_account_id in
    with retired as (
      update public.account_property_authorization_bridges bridge
         set status = 'retired',
             retired_at = clock_timestamp(),
             retirement_reason = 'Governing hotel relationship changed after cutover'
       where bridge.status = 'active'
         and bridge.property_id = any(v_property_ids)
         and (
           (
             bridge.cutover_relationship_id is null
             and exists (
               -- Future-dated assignments retire an independent bridge at
               -- scheduling time so wall-clock activation cannot later revive
               -- it without an authorization event.
               select 1
               from public.organization_property_relationships current_relationship
               where current_relationship.property_id = bridge.property_id
                 and current_relationship.is_primary_grouping is true
                 and current_relationship.relationship_type in ('operator', 'owner')
                 and (current_relationship.ends_at is null
                   or current_relationship.ends_at > now())
             )
           )
           or (
             bridge.cutover_relationship_id is not null
             and not exists (
               select 1
               from public._staxis_current_primary_property_relationships() current_relationship
               where current_relationship.id = bridge.cutover_relationship_id
                 and current_relationship.organization_id = bridge.cutover_organization_id
                 and current_relationship.property_id = bridge.property_id
                 and current_relationship.active_primary_count = 1
             )
           )
         )
       returning bridge.account_id
    )
    select distinct retired.account_id from retired
  loop
    perform public._staxis_refresh_account_authorization(
      v_account_id,
      'legacy bridge retired after governing relationship change'
    );
  end loop;
  return coalesce(new, old);
end;
$$;

revoke all on function public._staxis_retire_bridges_after_relationship_change()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_organization_property_relationships_00_bridge_retirement
  on public.organization_property_relationships;
create trigger trg_organization_property_relationships_00_bridge_retirement
  after insert or update or delete on public.organization_property_relationships
  for each row execute function public._staxis_retire_bridges_after_relationship_change();

-- Existing normalized customers cut over once, under the same bridge rule as
-- accounts receiving their first real entitlement after this migration.
do $$
declare
  v_account_id uuid;
begin
  for v_account_id in
    select distinct candidate.account_id
    from (
      select membership.account_id
      from public.organization_memberships membership
      join public.organizations organization
        on organization.id = membership.organization_id
       and organization.status = 'active'
       and organization.organization_type <> 'single_hotel'
      where membership.status = 'active'
        and membership.ended_at is null
        and membership.staxis_role is not null

      union

      select membership.account_id
      from public.organization_access_grants grant_row
      join public.organization_memberships membership
        on membership.id = grant_row.membership_id
       and membership.organization_id = grant_row.organization_id
      join public.organizations organization
        on organization.id = grant_row.organization_id
       and organization.status = 'active'
       and organization.organization_type <> 'single_hotel'
      where grant_row.status = 'active'
        and grant_row.source <> 'legacy_backfill'
        and (grant_row.expires_at is null or grant_row.expires_at > now())
        and membership.status = 'active'
        and membership.ended_at is null
    ) candidate
  loop
    perform public._staxis_refresh_account_authorization(
      v_account_id, '0378 normalized authority cutover'
    );
  end loop;
end
$$;

-- Hat creation itself must enforce the same governing relationship rule used
-- by every reader. A brand/vendor link is never a valid property-scope hat.
create or replace function public._staxis_validate_membership_hat()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_missing uuid;
begin
  if new.staxis_role is null then return new; end if;

  if not exists (
    select 1
    from public.organizations organization
    where organization.id = new.organization_id
      and organization.status = 'active'
      and organization.organization_type <> 'single_hotel'
  ) then
    raise exception 'a role/scope hat requires an active customer organization'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.accounts account
    where account.id = new.account_id
      and account.active is true
      and account.role <> 'admin'
  ) then
    raise exception 'a role/scope hat requires an active customer account'
      using errcode = '42501';
  end if;

  if new.membership_scope = 'property' then
    select candidate into v_missing
    from unnest(new.covered_property_ids) candidate
    where not exists (
      select 1
      from public._staxis_current_primary_property_relationships() relationship
      where relationship.organization_id = new.organization_id
        and relationship.property_id = candidate
        and relationship.active_primary_count = 1
    )
    limit 1;
    if v_missing is not null then
      raise exception 'hotel % is not governed by this company', v_missing
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public._staxis_validate_membership_hat()
  from public, anon, authenticated;

create or replace function public._staxis_validate_authoritative_access_grant()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Hidden single-hotel compatibility grants belong to the legacy projection.
  if new.source = 'legacy_backfill' then return new; end if;

  if not exists (
    select 1
    from public.organization_memberships membership
    join public.organizations organization
      on organization.id = membership.organization_id
     and organization.status = 'active'
     and organization.organization_type <> 'single_hotel'
    join public.accounts account
      on account.id = membership.account_id
     and account.active is true
     and account.role <> 'admin'
    where membership.id = new.membership_id
      and membership.organization_id = new.organization_id
      and membership.status = 'active'
      and membership.starts_at <= now()
      and membership.ended_at is null
  ) then
    raise exception 'normalized grant requires an active customer membership'
      using errcode = '23514';
  end if;

  if new.scope_type = 'property' and not exists (
    select 1
    from public._staxis_current_primary_property_relationships() relationship
    where relationship.id = new.property_relationship_id
      and relationship.organization_id = new.organization_id
      and relationship.property_id = new.property_id
      and relationship.active_primary_count = 1
  ) then
    raise exception 'property grant requires a current governing relationship'
      using errcode = '23514';
  elsif new.scope_type = 'portfolio' and not exists (
    select 1 from public.portfolios portfolio
    where portfolio.id = new.portfolio_id
      and portfolio.organization_id = new.organization_id
      and portfolio.status = 'active'
  ) then
    raise exception 'portfolio grant requires an active portfolio in the organization'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public._staxis_validate_authoritative_access_grant()
  from public, anon, authenticated;

drop trigger if exists trg_organization_access_grants_authoritative_scope
  on public.organization_access_grants;
create trigger trg_organization_access_grants_authoritative_scope
  before insert or update of organization_id, membership_id, scope_type,
    portfolio_id, property_relationship_id, property_id, source
  on public.organization_access_grants
  for each row execute function public._staxis_validate_authoritative_access_grant();

-- Service DTO for old hotel-mode callers. This is the exact same authority as
-- RLS below; it intentionally returns no partial answer on any missing state.
create or replace function public.staxis_list_account_authorized_properties(
  p_account_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_account public.accounts%rowtype;
  v_state public.account_authorization_state%rowtype;
  v_property_ids uuid[] := '{}'::uuid[];
  v_legacy_ids uuid[] := '{}'::uuid[];
  v_normalized_ids uuid[] := '{}'::uuid[];
  v_property_standings jsonb := '[]'::jsonb;
  v_effective_access_hash text;
begin
  select * into v_account from public.accounts account
  where account.id = p_account_id and account.active is true;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_active_account');
  end if;

  select * into v_state from public.account_authorization_state state
  where state.account_id = p_account_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'authorization_state_missing');
  end if;

  if v_account.role = 'admin' then
    v_effective_access_hash := encode(sha256(convert_to(jsonb_build_object(
      'all', true,
      'authorityMode', v_state.authority_mode,
      'authorityVersion', v_state.authority_version,
      'accountRole', v_account.role,
      'propertyIds', '[]'::jsonb,
      'propertyStandings', '[]'::jsonb
    )::text, 'UTF8')), 'hex');
    return jsonb_build_object(
      'ok', true, 'all', true, 'authorityMode', v_state.authority_mode,
      'authorityVersion', v_state.authority_version,
      'effectiveAccessHash', v_effective_access_hash,
      'propertyIds', '[]'::jsonb, 'legacyPropertyIds', '[]'::jsonb,
      'membershipPropertyIds', '[]'::jsonb,
      'propertyStandings', '[]'::jsonb
    );
  end if;

  if v_state.authority_mode in ('legacy', 'shadow') then
    select coalesce(array_agg(distinct legacy_property.property_id
      order by legacy_property.property_id), '{}'::uuid[])
      into v_property_ids
    from unnest(v_account.property_access) legacy_property(property_id)
    join public._staxis_current_primary_property_relationships() relationship
      on relationship.property_id = legacy_property.property_id
     and relationship.active_primary_count = 1;
    v_legacy_ids := v_property_ids;

    select coalesce(jsonb_agg(jsonb_build_object(
      'propertyId', property_id,
      'operationalRole', v_account.role,
      'seesFinancials', v_account.role in ('owner', 'general_manager'),
      'hotelMutationAllowed', true,
      'portfolioIntelligenceRead', false,
      'entitlements', jsonb_build_array(jsonb_build_object(
        'kind', 'legacy',
        'entitlementId', v_account.id,
        'organizationId', null,
        'membershipId', null,
        'accessProfile', null,
        'staxisRole', null,
        'scopeType', 'property',
        'portfolioId', null
      ))
    ) order by property_id), '[]'::jsonb)
      into v_property_standings
    from unnest(v_property_ids) property_id;
  elsif v_state.authority_mode = 'normalized' then
    select
      coalesce(array_agg(distinct authz.property_id
        order by authz.property_id), '{}'::uuid[]),
      coalesce(array_agg(distinct authz.property_id
        order by authz.property_id)
        filter (where authz.entitlement_kind = 'legacy_bridge'), '{}'::uuid[]),
      coalesce(array_agg(distinct authz.property_id
        order by authz.property_id)
        filter (where authz.entitlement_kind <> 'legacy_bridge'), '{}'::uuid[])
    into v_property_ids, v_legacy_ids, v_normalized_ids
    from public._staxis_account_property_authorizations(p_account_id) authz;

    -- Capacity is resolved atomically with reach. Authority classes are not
    -- additive: an explicit membership hat wins over an access-profile grant,
    -- and either wins over a cutover bridge. Within the winning class the
    -- strongest hotel role wins while finance visibility is OR'd only across
    -- that class. This prevents a stale global GM/owner role on a bridge from
    -- resurfacing after a narrower normalized entitlement exists.
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
                   -- Company jobs grant company/portfolio reach, not a hotel
                   -- operating job. Only an explicit property-scope hat may
                   -- project an operational role at that hotel.
                   when 'owner' then 'front_desk'
                   when 'vp' then 'front_desk'
                   when 'finance' then 'front_desk'
                   when 'general_manager' then 'general_manager'
                   when 'front_desk' then 'front_desk'
                   when 'housekeeping' then 'housekeeping'
                   when 'maintenance' then 'maintenance'
                   else 'staff'
                 end
               when authz.entitlement_kind = 'access_grant' then
                 case authz.access_profile
                   -- An organization/portfolio profile is never silently
                   -- upgraded into a hotel mutation role. Property-manager
                   -- capacity requires an exact property-scoped grant.
                   when 'property_manager' then case
                     when authz.scope_type = 'property' then 'general_manager'
                     else 'front_desk'
                   end
                   -- `staff` has the unrestricted legacy chat catalog. A
                   -- normalized read-only profile instead uses the bounded
                   -- front-desk lens plus the explicit mutation bit below.
                   else 'front_desk'
                 end
               else v_account.role::text
             end as operational_role,
             case
               when authz.entitlement_kind = 'membership_hat' then
                 case
                   when authz.scope_type = 'property' then case authz.staxis_role
                     when 'general_manager' then 900
                     when 'front_desk' then 500
                     when 'maintenance' then 400
                     when 'housekeeping' then 300
                     else 100
                   end
                   else 100
                 end
               when authz.entitlement_kind = 'access_grant' then
                 case authz.access_profile
                   when 'property_manager' then case
                     when authz.scope_type = 'property' then 850
                     else 100
                   end
                   else 100
                 end
               else case v_account.role
                 when 'owner' then 900
                 when 'general_manager' then 850
                 when 'front_desk' then 500
                 when 'maintenance' then 400
                 when 'housekeeping' then 300
                 else 100
               end
             end as role_priority,
             case
               when authz.entitlement_kind = 'membership_hat'
                 then authz.staxis_role in ('owner', 'vp', 'finance', 'general_manager')
               when authz.entitlement_kind = 'access_grant'
                 then authz.access_profile in ('organization_owner', 'property_manager')
               else v_account.role in ('owner', 'general_manager')
             end as sees_financials
             ,case
               when authz.entitlement_kind = 'access_grant'
                 then authz.scope_type = 'property'
                   and authz.access_profile = 'property_manager'
               when authz.entitlement_kind = 'membership_hat'
                 then authz.scope_type = 'property'
               else true
             end as hotel_mutation_allowed,
             authz.can_portfolio_intelligence as portfolio_intelligence_read
      from public._staxis_account_property_authorizations(p_account_id) authz
    ),
    winning_class as (
      select raw.property_id, max(raw.authority_priority) as authority_priority
      from raw
      group by raw.property_id
    ),
    chosen as (
      select raw.*
      from raw
      join winning_class
        on winning_class.property_id = raw.property_id
       and winning_class.authority_priority = raw.authority_priority
    ),
    grouped as (
      select chosen.property_id,
             (array_agg(chosen.operational_role order by
                chosen.role_priority desc,
                chosen.entitlement_kind,
                chosen.entitlement_id))[1] as operational_role,
             bool_or(chosen.sees_financials) as sees_financials,
             bool_or(chosen.hotel_mutation_allowed) as hotel_mutation_allowed,
             bool_or(chosen.portfolio_intelligence_read) as portfolio_intelligence_read,
             jsonb_agg(jsonb_build_object(
               'kind', chosen.entitlement_kind,
               'entitlementId', chosen.entitlement_id,
               'organizationId', chosen.organization_id,
               'membershipId', chosen.membership_id,
               'accessProfile', chosen.access_profile,
               'staxisRole', chosen.staxis_role,
               'scopeType', chosen.scope_type,
               'portfolioId', chosen.portfolio_id
             ) order by
               chosen.role_priority desc,
               chosen.entitlement_kind,
               chosen.entitlement_id) as entitlements
      from chosen
      group by chosen.property_id
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'propertyId', grouped.property_id,
      'operationalRole', grouped.operational_role,
      'seesFinancials', grouped.sees_financials,
      'hotelMutationAllowed', grouped.hotel_mutation_allowed,
      'portfolioIntelligenceRead', grouped.portfolio_intelligence_read,
      'entitlements', grouped.entitlements
    ) order by grouped.property_id), '[]'::jsonb)
      into v_property_standings
    from grouped;
  else
    return jsonb_build_object('ok', false, 'reason', 'invalid_authority_mode');
  end if;

  v_effective_access_hash := encode(sha256(convert_to(jsonb_build_object(
    'all', false,
    'authorityMode', v_state.authority_mode,
    'authorityVersion', v_state.authority_version,
    'accountRole', v_account.role,
    'propertyIds', to_jsonb(v_property_ids),
    'legacyPropertyIds', to_jsonb(v_legacy_ids),
    'membershipPropertyIds', to_jsonb(v_normalized_ids),
    'propertyStandings', v_property_standings
  )::text, 'UTF8')), 'hex');

  return jsonb_build_object(
    'ok', true,
    'all', false,
    'authorityMode', v_state.authority_mode,
    'authorityVersion', v_state.authority_version,
    'effectiveAccessHash', v_effective_access_hash,
    'propertyIds', to_jsonb(v_property_ids),
    'legacyPropertyIds', to_jsonb(v_legacy_ids),
    'membershipPropertyIds', to_jsonb(v_normalized_ids),
    'propertyStandings', v_property_standings
  );
end;
$$;

revoke all on function public.staxis_list_account_authorized_properties(uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_list_account_authorized_properties(uuid)
  to service_role;

-- RLS and server DTO now share the same mode switch. There is no `legacy OR
-- normalized` branch: legacy/shadow consult only the array, normalized consults
-- only normalized entitlements/bridges. Deactivation revokes every mode.
create or replace function public.staxis_account_reaches_property(
  p_user_id uuid,
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
    join public.account_authorization_state state on state.account_id = account.id
    where account.data_user_id = p_user_id
      and account.active is true
      and (
        account.role = 'admin'
        or (
          state.authority_mode in ('legacy', 'shadow')
          and p_property_id = any(account.property_access)
          and exists (
            select 1
            from public._staxis_current_primary_property_relationships() relationship
            where relationship.property_id = p_property_id
              and relationship.active_primary_count = 1
          )
        )
        or (
          state.authority_mode = 'normalized'
          and exists (
            select 1
            from public._staxis_account_property_authorizations(account.id) authz
            where authz.property_id = p_property_id
          )
        )
      )
  );
$$;

comment on function public.staxis_account_reaches_property(uuid, uuid) is
  'Authoritative per-property tenant gate. legacy/shadow use only accounts.property_access; normalized uses only normalized entitlements plus explicit bridges. Active account required; no runtime union.';

revoke all on function public.staxis_account_reaches_property(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_account_reaches_property(uuid, uuid)
  to service_role;

create or replace function public.user_owns_property(p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.staxis_account_reaches_property(auth.uid(), p_id);
$$;

comment on function public.user_owns_property(uuid) is
  'Per-property RLS gate delegated to the versioned authoritative access mode in staxis_account_reaches_property.';

revoke all on function public.user_owns_property(uuid) from public;
grant execute on function public.user_owns_property(uuid)
  to anon, authenticated, service_role;

-- ── Exact portfolio catalog and receipt serialization ─────────────────────

create or replace function public._staxis_authorized_portfolio_catalog(
  p_organization_id uuid,
  p_authorized_property_ids uuid[]
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with recursive
  active_portfolios as (
    select portfolio.id, portfolio.parent_id, portfolio.name,
           portfolio.portfolio_type
    from public.portfolios portfolio
    where portfolio.organization_id = p_organization_id
      and portfolio.status = 'active'
  ),
  descendants (root_id, portfolio_id) as (
    select portfolio.id, portfolio.id from active_portfolios portfolio
    union
    select descendants.root_id, child.id
    from descendants
    join active_portfolios child on child.parent_id = descendants.portfolio_id
  ),
  valid_assignments as (
    select assignment.portfolio_id, assignment.property_id
    from public.portfolio_properties assignment
    join public._staxis_current_primary_property_relationships() relationship
      on relationship.id = assignment.property_relationship_id
     and relationship.organization_id = assignment.organization_id
     and relationship.property_id = assignment.property_id
     and relationship.active_primary_count = 1
    where assignment.organization_id = p_organization_id
      and assignment.assigned_at <= now()
      and (assignment.removed_at is null or assignment.removed_at > now())
      and assignment.property_id = any(p_authorized_property_ids)
  ),
  catalog_rows as (
    select portfolio.id, portfolio.parent_id, portfolio.name,
           portfolio.portfolio_type,
           coalesce((
             select jsonb_agg(to_jsonb(direct.property_id) order by direct.property_id)
             from (
               select distinct assignment.property_id
               from valid_assignments assignment
               where assignment.portfolio_id = portfolio.id
             ) direct
           ), '[]'::jsonb) as direct_property_ids,
           coalesce((
             select jsonb_agg(to_jsonb(inherited.property_id) order by inherited.property_id)
             from (
               select distinct assignment.property_id
               from descendants descendant
               join valid_assignments assignment
                 on assignment.portfolio_id = descendant.portfolio_id
               where descendant.root_id = portfolio.id
             ) inherited
           ), '[]'::jsonb) as property_ids
    from active_portfolios portfolio
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'portfolioId', row.id,
    'name', row.name,
    'portfolioType', row.portfolio_type,
    'parentId', row.parent_id,
    'directPropertyIds', row.direct_property_ids,
    'propertyIds', row.property_ids
  ) order by row.id), '[]'::jsonb)
  from catalog_rows row
  -- Do not reveal names/topology of sibling portfolios outside a scoped
  -- manager's authorized hotel set. Ancestors remain visible only when an
  -- authorized descendant hotel makes their property_ids non-empty.
  where jsonb_array_length(row.property_ids) > 0;
$$;

revoke all on function public._staxis_authorized_portfolio_catalog(uuid, uuid[])
  from public, anon, authenticated, service_role;

-- A hotel authorization does not, by itself, disclose every internal grouping
-- that happens to mention that hotel. Organization-wide entitlements may see
-- the full catalog. A portfolio-scoped entitlement may see only its granted
-- root and active descendants. Property-scoped entitlements keep using exact
-- hotel selectors and receive no portfolio-name/topology side channel.
create or replace function public._staxis_account_authorized_portfolio_catalog(
  p_account_id uuid,
  p_organization_id uuid,
  p_authorized_property_ids uuid[]
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with recursive
  entitlements as (
    select distinct authz.scope_type, authz.portfolio_id
    from public._staxis_nonlegacy_property_authorizations(p_account_id) authz
    where authz.organization_id = p_organization_id
      and authz.can_portfolio_intelligence is true
      and authz.property_id = any(p_authorized_property_ids)
  ),
  whole_organization as (
    select exists (
      select 1 from entitlements entitlement
      where entitlement.scope_type in ('company', 'organization')
    ) as allowed
  ),
  allowed_portfolios (portfolio_id) as (
    select entitlement.portfolio_id
    from entitlements entitlement
    join public.portfolios portfolio
      on portfolio.id = entitlement.portfolio_id
     and portfolio.organization_id = p_organization_id
     and portfolio.status = 'active'
    where entitlement.scope_type = 'portfolio'

    union

    select child.id
    from allowed_portfolios allowed
    join public.portfolios child
      on child.parent_id = allowed.portfolio_id
     and child.organization_id = p_organization_id
     and child.status = 'active'
  ),
  base_catalog as (
    select entry
    from jsonb_array_elements(public._staxis_authorized_portfolio_catalog(
      p_organization_id, p_authorized_property_ids
    )) entry
  ),
  visible_catalog as (
    select case
      when (select allowed from whole_organization)
        or entry->>'parentId' is null
        or exists (
          select 1 from allowed_portfolios parent
          where parent.portfolio_id::text = entry->>'parentId'
        )
      then entry
      else jsonb_set(entry, '{parentId}', 'null'::jsonb, false)
    end as entry
    from base_catalog
    where (select allowed from whole_organization)
       or exists (
         select 1 from allowed_portfolios allowed
         where allowed.portfolio_id::text = entry->>'portfolioId'
       )
  )
  select coalesce(
    jsonb_agg(visible.entry order by visible.entry->>'portfolioId'),
    '[]'::jsonb
  )
  from visible_catalog visible;
$$;

revoke all on function public._staxis_account_authorized_portfolio_catalog(
  uuid, uuid, uuid[]
) from public, anon, authenticated, service_role;

create or replace function public._staxis_authorization_scope_receipt_json(
  p_receipt_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'id', receipt.id,
    'accountId', receipt.account_id,
    'organizationId', receipt.organization_id,
    'organizationName', receipt.organization_name,
    'authorityMode', receipt.authority_mode,
    'selectorType', receipt.selector_type,
    'requestedPortfolioId', receipt.requested_portfolio_id,
    'requestedPropertyIds', to_jsonb(receipt.requested_property_ids),
    'authorizedPropertyIds', to_jsonb(receipt.authorized_property_ids),
    'propertyIds', to_jsonb(receipt.selected_property_ids),
    'authorizedPropertyCount', cardinality(receipt.authorized_property_ids),
    'selectedPropertyCount', cardinality(receipt.selected_property_ids),
    'portfolioCatalog', receipt.portfolio_catalog,
    'accountAuthorizationVersion', receipt.account_authorization_version,
    'organizationAccessEpoch', receipt.organization_access_epoch,
    'resolverVersion', receipt.resolver_version,
    'authorizationHash', receipt.authorization_hash,
    'scopeHash', receipt.scope_hash,
    'provenance', receipt.provenance,
    'resolvedAt', receipt.resolved_at,
    'expiresAt', receipt.expires_at
  )
  from public.authorization_scope_receipts receipt
  where receipt.id = p_receipt_id;
$$;

revoke all on function public._staxis_authorization_scope_receipt_json(uuid)
  from public, anon, authenticated, service_role;

-- Resolve user -> exact organization authorization universe -> exact selector.
-- Explicit selectors are all-or-nothing. Nothing is sampled or truncated.
create or replace function public.staxis_resolve_authorization_scope(
  p_account_id uuid,
  p_organization_id uuid default null,
  p_selector_type text default 'all_authorized',
  p_portfolio_id uuid default null,
  p_property_ids jsonb default null,
  p_ttl_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_state public.account_authorization_state%rowtype;
  v_target_organization_id uuid;
  v_organization_name text;
  v_candidate_organization_ids uuid[];
  v_authorized_property_ids uuid[];
  v_requested_property_ids uuid[] := '{}'::uuid[];
  v_selected_property_ids uuid[];
  v_portfolio_catalog jsonb;
  v_provenance jsonb;
  v_epoch bigint;
  v_authorization_hash text;
  v_scope_hash text;
  v_receipt_id uuid;
  v_resolved_at timestamptz := clock_timestamp();
  v_ttl_seconds integer;
  v_element text;
  v_selector_portfolio jsonb;
  v_resolver_version constant text := 'portfolio-scope-v1';
begin
  if p_account_id is null
     or p_selector_type not in ('all_authorized', 'portfolio', 'property_subset')
     or (p_selector_type = 'all_authorized'
       and (p_portfolio_id is not null or p_property_ids is not null))
     or (p_selector_type = 'portfolio'
       and (p_portfolio_id is null or p_property_ids is not null))
     or (p_selector_type = 'property_subset'
       and (p_portfolio_id is not null or p_property_ids is null))
  then
    return jsonb_build_object('ok', false, 'reason', 'invalid_request');
  end if;

  -- The account + mode row lock makes entitlement/account refresh block until
  -- this receipt commits. Its version then changes, invalidating the receipt.
  select state.* into v_state
  from public.account_authorization_state state
  join public.accounts account
    on account.id = state.account_id
   and account.active is true
   and account.role <> 'admin'
  where state.account_id = p_account_id
  for share of state;
  if not found or v_state.authority_mode <> 'normalized' then
    return jsonb_build_object('ok', false, 'reason', 'no_company_job');
  end if;

  if exists (
    select 1
    from public._staxis_account_ambiguous_portfolio_organizations(p_account_id)
      ambiguous
    where p_organization_id is null
       or ambiguous.organization_id = p_organization_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'store_unavailable');
  end if;

  select coalesce(array_agg(candidate.organization_id order by candidate.organization_id),
                  '{}'::uuid[])
    into v_candidate_organization_ids
  from (
    select authz.organization_id
    from public._staxis_nonlegacy_property_authorizations(p_account_id) authz
    join public.organizations candidate_organization
      on candidate_organization.id = authz.organization_id
     and candidate_organization.status = 'active'
     and candidate_organization.organization_type in (
       'management_company', 'ownership_group'
     )
    where authz.can_portfolio_intelligence is true
      and authz.organization_id is not null
    group by authz.organization_id
    -- An explicit company/organization/portfolio entitlement opens portfolio
    -- mode. Property-scoped managers do so only when their exact current reach
    -- spans multiple hotels; a one-hotel GM remains in hotel mode and cannot
    -- make an otherwise unambiguous company job appear ambiguous.
    having bool_or(authz.scope_type in ('company', 'organization', 'portfolio'))
       or count(distinct authz.property_id) > 1
  ) candidate;

  if p_organization_id is not null then
    if not (p_organization_id = any(v_candidate_organization_ids)) then
      return jsonb_build_object('ok', false, 'reason', 'no_company_job');
    end if;
    v_target_organization_id := p_organization_id;
  elsif cardinality(v_candidate_organization_ids) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_company_job');
  elsif cardinality(v_candidate_organization_ids) > 1 then
    return jsonb_build_object('ok', false, 'reason', 'ambiguous_company');
  else
    v_target_organization_id := v_candidate_organization_ids[1];
  end if;

  if public._staxis_organization_has_ambiguous_primary_topology(
    v_target_organization_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'store_unavailable');
  end if;

  insert into public.organization_access_epochs (organization_id)
  values (v_target_organization_id)
  on conflict (organization_id) do nothing;

  select organization.name, epoch.version
    into v_organization_name, v_epoch
  from public.organizations organization
  join public.organization_access_epochs epoch
    on epoch.organization_id = organization.id
  where organization.id = v_target_organization_id
    and organization.status = 'active'
    and organization.organization_type in ('management_company', 'ownership_group')
  for share of organization, epoch;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'scope_changed');
  end if;

  select coalesce(array_agg(candidate.property_id order by candidate.property_id), '{}'::uuid[])
    into v_authorized_property_ids
  from (
    select distinct authz.property_id
    from public._staxis_nonlegacy_property_authorizations(p_account_id) authz
    where authz.organization_id = v_target_organization_id
      and authz.can_portfolio_intelligence is true
  ) candidate;

  if cardinality(v_authorized_property_ids) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_hotels');
  end if;
  if cardinality(v_authorized_property_ids) > 5000 then
    return jsonb_build_object('ok', false, 'reason', 'scope_too_large');
  end if;

  v_portfolio_catalog := public._staxis_account_authorized_portfolio_catalog(
    p_account_id, v_target_organization_id, v_authorized_property_ids
  );
  if jsonb_array_length(v_portfolio_catalog) > 2000 then
    return jsonb_build_object('ok', false, 'reason', 'scope_too_large');
  end if;

  if p_selector_type = 'all_authorized' then
    v_selected_property_ids := v_authorized_property_ids;
  elsif p_selector_type = 'property_subset' then
    if jsonb_typeof(p_property_ids) <> 'array'
       or jsonb_array_length(p_property_ids) = 0
       or jsonb_array_length(p_property_ids) > 5000 then
      return jsonb_build_object('ok', false, 'reason', 'invalid_request');
    end if;
    for v_element in select jsonb_array_elements_text(p_property_ids)
    loop
      if v_element !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        return jsonb_build_object('ok', false, 'reason', 'invalid_request');
      end if;
    end loop;
    select coalesce(array_agg(distinct element::uuid order by element::uuid), '{}'::uuid[])
      into v_requested_property_ids
    from jsonb_array_elements_text(p_property_ids) element;
    if cardinality(v_requested_property_ids) <> jsonb_array_length(p_property_ids) then
      return jsonb_build_object('ok', false, 'reason', 'invalid_request');
    end if;
    if not (v_requested_property_ids <@ v_authorized_property_ids) then
      return jsonb_build_object('ok', false, 'reason', 'unauthorized_scope');
    end if;
    v_selected_property_ids := v_requested_property_ids;
  else
    select catalog_entry into v_selector_portfolio
    from jsonb_array_elements(v_portfolio_catalog) catalog_entry
    where catalog_entry->>'portfolioId' = p_portfolio_id::text;
    if v_selector_portfolio is null then
      return jsonb_build_object('ok', false, 'reason', 'unauthorized_scope');
    end if;
    select coalesce(array_agg(property_id::uuid order by property_id::uuid), '{}'::uuid[])
      into v_selected_property_ids
    from jsonb_array_elements_text(v_selector_portfolio->'propertyIds') property_id;
    if cardinality(v_selected_property_ids) = 0 then
      return jsonb_build_object('ok', false, 'reason', 'no_hotels');
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'propertyId', provenance_row.property_id,
    'entitlementKind', provenance_row.entitlement_kind,
    'entitlementId', provenance_row.entitlement_id,
    'membershipId', provenance_row.membership_id,
    'accessProfile', provenance_row.access_profile,
    'staxisRole', provenance_row.staxis_role,
    'scopeType', provenance_row.scope_type,
    'portfolioId', provenance_row.portfolio_id
  ) order by
    provenance_row.property_id, provenance_row.entitlement_kind,
    provenance_row.entitlement_id), '[]'::jsonb)
    into v_provenance
  from (
    select distinct authz.property_id,
           authz.entitlement_kind,
           authz.entitlement_id,
           authz.membership_id,
           authz.access_profile,
           authz.staxis_role,
           authz.scope_type,
           authz.portfolio_id
    from public._staxis_nonlegacy_property_authorizations(p_account_id) authz
    where authz.organization_id = v_target_organization_id
      and authz.can_portfolio_intelligence is true
      and authz.property_id = any(v_selected_property_ids)
  ) provenance_row;
  v_provenance := jsonb_build_object(
    'entitlements', v_provenance,
    'governingRelationshipTypes', jsonb_build_array('operator', 'owner'),
    'selectionWasTruncated', false
  );

  v_authorization_hash := encode(sha256(convert_to(jsonb_build_object(
    'organizationId', v_target_organization_id,
    'authorizedPropertyIds', to_jsonb(v_authorized_property_ids),
    'accountAuthorizationVersion', v_state.authority_version,
    'organizationAccessEpoch', v_epoch,
    'resolverVersion', v_resolver_version
  )::text, 'UTF8')), 'hex');

  v_scope_hash := encode(sha256(convert_to(jsonb_build_object(
    'authorizationHash', v_authorization_hash,
    'selectorType', p_selector_type,
    'requestedPortfolioId', p_portfolio_id,
    'requestedPropertyIds', to_jsonb(v_requested_property_ids),
    'propertyIds', to_jsonb(v_selected_property_ids),
    'portfolioCatalog', v_portfolio_catalog
  )::text, 'UTF8')), 'hex');

  v_ttl_seconds := least(300, greatest(5, coalesce(p_ttl_seconds, 120)));
  insert into public.authorization_scope_receipts (
    account_id, organization_id, organization_name, authority_mode,
    selector_type, requested_portfolio_id, requested_property_ids,
    authorized_property_ids, selected_property_ids, portfolio_catalog,
    account_authorization_version, organization_access_epoch, resolver_version,
    authorization_hash, scope_hash, provenance, resolved_at, expires_at
  ) values (
    p_account_id, v_target_organization_id, v_organization_name, 'normalized',
    p_selector_type, p_portfolio_id, v_requested_property_ids,
    v_authorized_property_ids, v_selected_property_ids, v_portfolio_catalog,
    v_state.authority_version, v_epoch, v_resolver_version,
    v_authorization_hash, v_scope_hash, v_provenance, v_resolved_at,
    v_resolved_at + make_interval(secs => v_ttl_seconds)
  ) returning id into v_receipt_id;

  return jsonb_build_object(
    'ok', true,
    'receipt', public._staxis_authorization_scope_receipt_json(v_receipt_id)
  );
end;
$$;

revoke all on function public.staxis_resolve_authorization_scope(
  uuid, uuid, text, uuid, jsonb, integer
) from public, anon, authenticated;
grant execute on function public.staxis_resolve_authorization_scope(
  uuid, uuid, text, uuid, jsonb, integer
) to service_role;

create or replace function public.staxis_assert_authorization_scope_receipt(
  p_receipt_id uuid,
  p_account_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_receipt public.authorization_scope_receipts%rowtype;
  v_state public.account_authorization_state%rowtype;
  v_current_epoch bigint;
  v_authorized_property_ids uuid[];
  v_selected_property_ids uuid[];
  v_portfolio_catalog jsonb;
  v_selector_portfolio jsonb;
  v_authorization_hash text;
  v_scope_hash text;
begin
  select receipt.* into v_receipt
  from public.authorization_scope_receipts receipt
  where receipt.id = p_receipt_id
    and receipt.account_id = p_account_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_receipt.expires_at <= clock_timestamp() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;

  select state.* into v_state
  from public.account_authorization_state state
  join public.accounts account
    on account.id = state.account_id
   and account.active is true
   and account.role <> 'admin'
  where state.account_id = p_account_id
  for share of state;
  if not found
     or v_state.authority_mode <> 'normalized'
     or v_state.authority_version <> v_receipt.account_authorization_version then
    return jsonb_build_object('ok', false, 'reason', 'revoked_or_changed');
  end if;

  if public._staxis_organization_has_ambiguous_primary_topology(
    v_receipt.organization_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'scope_changed');
  end if;

  select epoch.version into v_current_epoch
  from public.organization_access_epochs epoch
  join public.organizations organization
    on organization.id = epoch.organization_id
   and organization.status = 'active'
   and organization.organization_type in ('management_company', 'ownership_group')
  where epoch.organization_id = v_receipt.organization_id
  for share of epoch;
  if not found or v_current_epoch <> v_receipt.organization_access_epoch then
    return jsonb_build_object('ok', false, 'reason', 'scope_changed');
  end if;

  select coalesce(array_agg(candidate.property_id order by candidate.property_id), '{}'::uuid[])
    into v_authorized_property_ids
  from (
    select distinct authz.property_id
    from public._staxis_nonlegacy_property_authorizations(p_account_id) authz
    where authz.organization_id = v_receipt.organization_id
      and authz.can_portfolio_intelligence is true
  ) candidate;
  if cardinality(v_authorized_property_ids) = 0
     or cardinality(v_authorized_property_ids) > 5000 then
    return jsonb_build_object('ok', false, 'reason', 'revoked_or_changed');
  end if;

  v_portfolio_catalog := public._staxis_account_authorized_portfolio_catalog(
    p_account_id, v_receipt.organization_id, v_authorized_property_ids
  );
  if jsonb_array_length(v_portfolio_catalog) > 2000 then
    return jsonb_build_object('ok', false, 'reason', 'scope_changed');
  end if;

  if v_receipt.selector_type = 'all_authorized' then
    v_selected_property_ids := v_authorized_property_ids;
  elsif v_receipt.selector_type = 'property_subset' then
    if not (v_receipt.requested_property_ids <@ v_authorized_property_ids) then
      return jsonb_build_object('ok', false, 'reason', 'revoked_or_changed');
    end if;
    v_selected_property_ids := v_receipt.requested_property_ids;
  else
    select catalog_entry into v_selector_portfolio
    from jsonb_array_elements(v_portfolio_catalog) catalog_entry
    where catalog_entry->>'portfolioId' = v_receipt.requested_portfolio_id::text;
    if v_selector_portfolio is null then
      return jsonb_build_object('ok', false, 'reason', 'scope_changed');
    end if;
    select coalesce(array_agg(property_id::uuid order by property_id::uuid), '{}'::uuid[])
      into v_selected_property_ids
    from jsonb_array_elements_text(v_selector_portfolio->'propertyIds') property_id;
    if cardinality(v_selected_property_ids) = 0 then
      return jsonb_build_object('ok', false, 'reason', 'scope_changed');
    end if;
  end if;

  v_authorization_hash := encode(sha256(convert_to(jsonb_build_object(
    'organizationId', v_receipt.organization_id,
    'authorizedPropertyIds', to_jsonb(v_authorized_property_ids),
    'accountAuthorizationVersion', v_state.authority_version,
    'organizationAccessEpoch', v_current_epoch,
    'resolverVersion', v_receipt.resolver_version
  )::text, 'UTF8')), 'hex');
  v_scope_hash := encode(sha256(convert_to(jsonb_build_object(
    'authorizationHash', v_authorization_hash,
    'selectorType', v_receipt.selector_type,
    'requestedPortfolioId', v_receipt.requested_portfolio_id,
    'requestedPropertyIds', to_jsonb(v_receipt.requested_property_ids),
    'propertyIds', to_jsonb(v_selected_property_ids),
    'portfolioCatalog', v_portfolio_catalog
  )::text, 'UTF8')), 'hex');

  if v_authorized_property_ids is distinct from v_receipt.authorized_property_ids
     or v_selected_property_ids is distinct from v_receipt.selected_property_ids
     or v_portfolio_catalog is distinct from v_receipt.portfolio_catalog
     or v_authorization_hash is distinct from v_receipt.authorization_hash
     or v_scope_hash is distinct from v_receipt.scope_hash then
    return jsonb_build_object('ok', false, 'reason', 'scope_changed');
  end if;

  return jsonb_build_object(
    'ok', true,
    'receipt', public._staxis_authorization_scope_receipt_json(v_receipt.id)
  );
end;
$$;

revoke all on function public.staxis_assert_authorization_scope_receipt(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_assert_authorization_scope_receipt(uuid, uuid)
  to service_role;

create or replace function public._staxis_authorization_scope_receipt_immutable()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE'
     and current_setting('staxis.scope_receipt_retention_purge', true) = '1'
     and old.expires_at <= clock_timestamp() - interval '24 hours' then
    return old;
  end if;
  raise exception 'authorization scope receipts are immutable'
    using errcode = '55000';
end;
$$;

revoke all on function public._staxis_authorization_scope_receipt_immutable()
  from public, anon, authenticated;

drop trigger if exists trg_authorization_scope_receipts_immutable
  on public.authorization_scope_receipts;
create trigger trg_authorization_scope_receipts_immutable
  before update or delete on public.authorization_scope_receipts
  for each row execute function public._staxis_authorization_scope_receipt_immutable();

create or replace function public.staxis_purge_authorization_scope_receipts(
  p_before timestamptz default null,
  p_limit integer default 10000
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cutoff timestamptz;
  v_limit integer;
  v_deleted integer;
begin
  -- A receipt is useful only for minutes, but retain at least 24 hours for
  -- incident reconstruction. Default retention is 30 days and deletion is
  -- bounded so maintenance cannot lock the ledger indefinitely.
  v_cutoff := least(
    coalesce(p_before, clock_timestamp() - interval '30 days'),
    clock_timestamp() - interval '24 hours'
  );
  v_limit := least(50000, greatest(1, coalesce(p_limit, 10000)));
  perform set_config('staxis.scope_receipt_retention_purge', '1', true);
  delete from public.authorization_scope_receipts receipt
  where receipt.id in (
    select candidate.id
    from public.authorization_scope_receipts candidate
    where candidate.expires_at <= v_cutoff
    order by candidate.expires_at, candidate.id
    limit v_limit
  );
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.staxis_purge_authorization_scope_receipts(
  timestamptz, integer
) from public, anon, authenticated;
grant execute on function public.staxis_purge_authorization_scope_receipts(
  timestamptz, integer
) to service_role;

-- ── RLS and grants ─────────────────────────────────────────────────────────

alter table public.account_authorization_state enable row level security;
alter table public.account_property_authorization_bridges enable row level security;
alter table public.authorization_scope_receipts enable row level security;

revoke all on public.account_authorization_state from public, anon, authenticated;
revoke all on public.account_property_authorization_bridges from public, anon, authenticated;
revoke all on public.authorization_scope_receipts from public, anon, authenticated;
revoke all on public.account_authorization_state from service_role;
revoke all on public.account_property_authorization_bridges from service_role;
revoke all on public.authorization_scope_receipts from service_role;
-- No direct service-role reads: server code uses the bounded list/resolve/assert
-- RPCs. Database owners retain operational access for incident response.

drop policy if exists account_authorization_state_deny_browser
  on public.account_authorization_state;
create policy account_authorization_state_deny_browser
  on public.account_authorization_state
  for all to anon, authenticated using (false) with check (false);

drop policy if exists account_property_authorization_bridges_deny_browser
  on public.account_property_authorization_bridges;
create policy account_property_authorization_bridges_deny_browser
  on public.account_property_authorization_bridges
  for all to anon, authenticated using (false) with check (false);

drop policy if exists authorization_scope_receipts_deny_browser
  on public.authorization_scope_receipts;
create policy authorization_scope_receipts_deny_browser
  on public.authorization_scope_receipts
  for all to anon, authenticated using (false) with check (false);

-- Applying the migration must leave every account with exactly one mode.
do $$
begin
  if exists (
    select 1 from public.accounts account
    left join public.account_authorization_state state on state.account_id = account.id
    where state.account_id is null
  ) then
    raise exception '0378 self-check failed: account without authorization state';
  end if;
end
$$;

insert into public.applied_migrations (version, description)
values (
  '0378',
  'Authoritative legacy/shadow/normalized access modes, governing scope projection, immutable exact portfolio scope receipts and RLS parity'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
