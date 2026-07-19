-- 0325_organization_access_foundation.sql
--
-- Organization / portfolio / scoped-access foundation. Existing
-- accounts.property_access values are continuously reconciled into normalized
-- facts for compatibility. Hotel-operation permissions deliberately remain on
-- the existing per-hotel role/access model: organization profiles authorize
-- Company Hub capabilities and never silently widen direct hotel CRUD access.
--
-- Security model:
--   * every table is service-role-only; browser roles have an explicit deny
--   * customer job identity is descriptive and never authorizes on its own
--   * grants are scoped to an organization, portfolio, or property relationship
--   * Staxis `accounts.role = 'admin'` remains a separate internal realm
--   * every mutation is audited by an AFTER trigger in the same transaction
--   * organization_access_events is append-only, including for service_role
--
-- @rls: service-role-only — all reads/writes flow through authenticated Next
-- API routes using supabaseAdmin. No organization/access PII is browser-readable.

-- ─── Organizations and hotel relationships ─────────────────────────────────

create table if not exists public.organizations (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  organization_type     text not null,
  status                text not null default 'active',
  -- Backfilled single-hotel tenant anchors are deliberately distinguishable
  -- from real management/ownership organizations. The Admin UI renders these
  -- properties under Independent Hotels instead of as organization rows.
  legacy_property_id    uuid unique references public.properties(id) on delete set null,
  created_by_account_id uuid references public.accounts(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint organizations_name_check
    check (char_length(btrim(name)) between 1 and 160),
  constraint organizations_type_check
    check (organization_type in (
      'management_company', 'ownership_group', 'single_hotel',
      'brand', 'vendor', 'other'
    )),
  constraint organizations_status_check
    check (status in ('active', 'suspended', 'inactive')),
  constraint organizations_legacy_anchor_check
    check (legacy_property_id is null or organization_type = 'single_hotel')
);

create index if not exists organizations_type_status_idx
  on public.organizations (organization_type, status, name);
create index if not exists organizations_status_updated_idx
  on public.organizations (status, updated_at desc);

-- @rls: service-role-only — organization/property topology is exposed only by scoped server DTOs.
create table if not exists public.organization_property_relationships (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations(id) on delete cascade,
  property_id           uuid not null references public.properties(id) on delete cascade,
  relationship_type     text not null,
  is_primary_grouping   boolean not null default false,
  starts_at             timestamptz not null default now(),
  ends_at               timestamptz,
  created_by_account_id uuid references public.accounts(id) on delete set null,
  updated_by_account_id uuid references public.accounts(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint organization_property_relationships_type_check
    check (relationship_type in (
      'operator', 'owner', 'brand', 'franchisor', 'vendor', 'consultant', 'other'
    )),
  constraint organization_property_relationships_window_check
    check (ends_at is null or ends_at > starts_at),
  constraint organization_property_relationships_primary_kind_check
    check (not is_primary_grouping or relationship_type in ('operator', 'owner')),
  constraint organization_property_relationships_id_org_property_key
    unique (id, organization_id, property_id)
);

-- A hotel may have many owner/brand/vendor relationships but at most one open
-- primary grouping relationship. No open primary means Independent Hotel.
create unique index if not exists organization_property_one_open_primary_idx
  on public.organization_property_relationships (property_id)
  where is_primary_grouping and ends_at is null;
create unique index if not exists organization_property_one_open_kind_idx
  on public.organization_property_relationships (
    organization_id, property_id, relationship_type
  ) where ends_at is null;
create index if not exists organization_property_org_open_idx
  on public.organization_property_relationships (organization_id, property_id)
  where ends_at is null;
create index if not exists organization_property_property_history_idx
  on public.organization_property_relationships (property_id, starts_at desc);

-- ─── Portfolios / regions ──────────────────────────────────────────────────

create table if not exists public.portfolios (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations(id) on delete cascade,
  parent_id             uuid,
  name                  text not null,
  portfolio_type        text not null default 'portfolio',
  status                text not null default 'active',
  created_by_account_id uuid references public.accounts(id) on delete set null,
  updated_by_account_id uuid references public.accounts(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint portfolios_id_organization_key unique (id, organization_id),
  constraint portfolios_parent_same_organization_fkey
    foreign key (parent_id, organization_id)
    references public.portfolios(id, organization_id) on delete restrict,
  constraint portfolios_name_check
    check (char_length(btrim(name)) between 1 and 120),
  constraint portfolios_type_check
    check (portfolio_type in ('portfolio', 'region', 'division', 'other')),
  constraint portfolios_status_check
    check (status in ('active', 'archived')),
  constraint portfolios_not_self_parent_check
    check (parent_id is null or parent_id <> id)
);

create unique index if not exists portfolios_open_name_idx
  on public.portfolios (organization_id, lower(name))
  where status = 'active';
create index if not exists portfolios_org_parent_idx
  on public.portfolios (organization_id, parent_id, name);

-- @rls: service-role-only — portfolio membership is resolved by authenticated server APIs.
create table if not exists public.portfolio_properties (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null,
  portfolio_id             uuid not null,
  property_relationship_id uuid not null,
  property_id              uuid not null,
  assigned_at              timestamptz not null default now(),
  removed_at               timestamptz,
  assigned_by_account_id   uuid references public.accounts(id) on delete set null,
  removed_by_account_id    uuid references public.accounts(id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint portfolio_properties_portfolio_scope_fkey
    foreign key (portfolio_id, organization_id)
    references public.portfolios(id, organization_id) on delete cascade,
  constraint portfolio_properties_relationship_scope_fkey
    foreign key (property_relationship_id, organization_id, property_id)
    references public.organization_property_relationships(id, organization_id, property_id)
    on delete cascade,
  constraint portfolio_properties_window_check
    check (removed_at is null or removed_at > assigned_at),
  constraint portfolio_properties_removed_actor_check
    check (removed_at is not null or removed_by_account_id is null)
);

create unique index if not exists portfolio_properties_one_open_assignment_idx
  on public.portfolio_properties (portfolio_id, property_id)
  where removed_at is null;
create index if not exists portfolio_properties_property_open_idx
  on public.portfolio_properties (property_id, portfolio_id)
  where removed_at is null;
create index if not exists portfolio_properties_org_open_idx
  on public.portfolio_properties (organization_id, portfolio_id, property_id)
  where removed_at is null;

-- ─── Organization membership and per-property staff identity ───────────────

-- @rls: service-role-only — cross-property identity and job data is server-filtered.
create table if not exists public.organization_memberships (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations(id) on delete cascade,
  account_id            uuid not null references public.accounts(id) on delete cascade,
  job_category          text not null default 'other',
  job_title             text,
  status                text not null default 'active',
  starts_at             timestamptz not null default now(),
  ended_at               timestamptz,
  created_by_account_id uuid references public.accounts(id) on delete set null,
  updated_by_account_id uuid references public.accounts(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint organization_memberships_id_org_key unique (id, organization_id),
  constraint organization_memberships_job_category_check
    check (job_category in (
      'owner_principal', 'executive', 'operations', 'regional_manager',
      'asset_manager', 'general_manager', 'assistant_general_manager',
      'revenue', 'finance', 'human_resources', 'information_technology',
      'department_head', 'hotel_employee', 'consultant', 'other'
    )),
  constraint organization_memberships_job_title_check
    check (job_title is null or char_length(btrim(job_title)) between 1 and 120),
  constraint organization_memberships_status_check
    check (status in ('active', 'suspended', 'revoked')),
  constraint organization_memberships_window_check
    check (ended_at is null or ended_at > starts_at),
  constraint organization_memberships_revoked_shape_check
    check ((status = 'revoked') = (ended_at is not null))
);

create unique index if not exists organization_memberships_one_current_idx
  on public.organization_memberships (organization_id, account_id)
  where ended_at is null;
create index if not exists organization_memberships_account_current_idx
  on public.organization_memberships (account_id, organization_id)
  where ended_at is null;
create index if not exists organization_memberships_org_status_idx
  on public.organization_memberships (organization_id, status, account_id);

-- Preserve accounts.staff_id for compatibility while adding the normalized
-- many-property identity link. The composite FK makes cross-hotel staff links
-- impossible even if an API accidentally submits mismatched IDs.
do $migration$
begin
  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.staff'::regclass
      and c.conname = 'staff_id_property_id_key'
  ) then
    alter table public.staff
      add constraint staff_id_property_id_key unique (id, property_id);
  end if;
end;
$migration$;

-- @rls: service-role-only — authentication-to-staff identity links never leave server gates.
create table if not exists public.account_property_staff_links (
  account_id              uuid not null references public.accounts(id) on delete cascade,
  property_id             uuid not null references public.properties(id) on delete cascade,
  staff_id                uuid not null,
  is_active               boolean not null default true,
  source                  text not null default 'legacy_backfill',
  linked_by_account_id    uuid references public.accounts(id) on delete set null,
  linked_at               timestamptz not null default now(),
  deactivated_at          timestamptz,
  deactivated_by_account_id uuid references public.accounts(id) on delete set null,
  updated_at              timestamptz not null default now(),

  primary key (account_id, property_id),
  constraint account_property_staff_links_staff_property_fkey
    foreign key (staff_id, property_id)
    references public.staff(id, property_id) on delete cascade,
  constraint account_property_staff_links_deactivated_shape_check
    check (
      (is_active and deactivated_at is null and deactivated_by_account_id is null)
      or (not is_active and deactivated_at is not null)
    ),
  constraint account_property_staff_links_source_check
    check (source in ('legacy_backfill', 'manual', 'invitation', 'system'))
);

-- Rerun/upgrade safety for databases created from an earlier draft.
alter table public.account_property_staff_links
  add column if not exists source text not null default 'legacy_backfill';
alter table public.account_property_staff_links
  drop constraint if exists account_property_staff_links_source_check;
alter table public.account_property_staff_links
  add constraint account_property_staff_links_source_check
  check (source in ('legacy_backfill', 'manual', 'invitation', 'system'));

-- One active login per operational staff identity. Historical inactive links
-- remain available for audit and account migrations.
create unique index if not exists account_property_staff_one_active_account_idx
  on public.account_property_staff_links (staff_id)
  where is_active;
create index if not exists account_property_staff_account_active_idx
  on public.account_property_staff_links (account_id, property_id)
  where is_active;

-- ─── Scoped grants, invitations, and requests ───────────────────────────────

-- @rls: service-role-only — authorization grants must not be browser-readable or writable.
create table if not exists public.organization_access_grants (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null,
  membership_id            uuid not null,
  access_profile           text not null,
  scope_type               text not null,
  portfolio_id             uuid,
  property_relationship_id uuid,
  property_id              uuid,
  starts_at                timestamptz not null default now(),
  expires_at               timestamptz,
  status                   text not null default 'active',
  source                   text not null default 'manual',
  granted_by_account_id    uuid references public.accounts(id) on delete set null,
  revoked_at               timestamptz,
  revoked_by_account_id    uuid references public.accounts(id) on delete set null,
  revocation_reason        text,
  version                  integer not null default 1,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint organization_access_grants_membership_scope_fkey
    foreign key (membership_id, organization_id)
    references public.organization_memberships(id, organization_id) on delete cascade,
  constraint organization_access_grants_portfolio_scope_fkey
    foreign key (portfolio_id, organization_id)
    references public.portfolios(id, organization_id) on delete cascade,
  constraint organization_access_grants_property_scope_fkey
    foreign key (property_relationship_id, organization_id, property_id)
    references public.organization_property_relationships(id, organization_id, property_id)
    on delete cascade,
  constraint organization_access_grants_profile_check
    check (access_profile in (
      'organization_owner', 'organization_admin', 'portfolio_manager',
      'property_manager', 'department_lead', 'contributor', 'viewer',
      'external_collaborator'
    )),
  constraint organization_access_grants_scope_check
    check (scope_type in ('organization', 'portfolio', 'property')),
  constraint organization_access_grants_scope_shape_check
    check (
      (scope_type = 'organization' and portfolio_id is null
        and property_relationship_id is null and property_id is null)
      or (scope_type = 'portfolio' and portfolio_id is not null
        and property_relationship_id is null and property_id is null)
      or (scope_type = 'property' and portfolio_id is null
        and property_relationship_id is not null and property_id is not null)
    ),
  constraint organization_access_grants_profile_scope_check
    check (
      (access_profile in ('organization_owner', 'organization_admin')
        and scope_type = 'organization')
      or (access_profile = 'portfolio_manager' and scope_type = 'portfolio')
      or (access_profile = 'property_manager' and scope_type = 'property')
      or access_profile in (
        'department_lead', 'contributor', 'viewer', 'external_collaborator'
      )
    ),
  constraint organization_access_grants_status_check
    check (status in ('active', 'revoked')),
  constraint organization_access_grants_source_check
    check (source in (
      'manual', 'invitation', 'access_request', 'legacy_backfill', 'system'
    )),
  constraint organization_access_grants_window_check
    check (expires_at is null or expires_at > starts_at),
  constraint organization_access_grants_owner_permanent_check
    check (access_profile <> 'organization_owner' or expires_at is null),
  constraint organization_access_grants_external_expiry_check
    check (access_profile <> 'external_collaborator' or expires_at is not null),
  constraint organization_access_grants_revoked_shape_check
    check (
      (status = 'active' and revoked_at is null and revoked_by_account_id is null
        and revocation_reason is null)
      or (status = 'revoked' and revoked_at is not null
        and revocation_reason is not null
        and char_length(btrim(revocation_reason)) between 1 and 500)
    ),
  constraint organization_access_grants_version_check check (version > 0)
);

-- Keep reruns/upgrades aligned with the declaration above. Automatic cleanup
-- of a stale legacy_backfill grant is a system action and therefore may have
-- no customer account to place in revoked_by_account_id. Historical revoker
-- references can also become null when an account is deliberately deleted;
-- the immutable access event retains the actor UUID and before/after snapshot.
alter table public.organization_access_grants
  drop constraint if exists organization_access_grants_revoked_shape_check;
alter table public.organization_access_grants
  add constraint organization_access_grants_revoked_shape_check
  check (
    (status = 'active' and revoked_at is null and revoked_by_account_id is null
      and revocation_reason is null)
    or (status = 'revoked' and revoked_at is not null
      and revocation_reason is not null
      and char_length(btrim(revocation_reason)) between 1 and 500)
  );

create unique index if not exists organization_access_grants_one_active_scope_idx
  on public.organization_access_grants (
    membership_id, access_profile, scope_type,
    coalesce(portfolio_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(property_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) where status = 'active';
create index if not exists organization_access_grants_membership_active_idx
  on public.organization_access_grants (membership_id, starts_at, expires_at)
  where status = 'active';
create index if not exists organization_access_grants_org_active_idx
  on public.organization_access_grants (organization_id, access_profile, scope_type)
  where status = 'active';
create index if not exists organization_access_grants_property_active_idx
  on public.organization_access_grants (property_id, membership_id)
  where status = 'active' and property_id is not null;

-- @rls: service-role-only — invitation email/token metadata is handled by server routes only.
create table if not exists public.organization_invitations (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations(id) on delete cascade,
  email                    text not null,
  token_hash               text not null unique,
  job_category             text not null default 'other',
  job_title                text,
  access_profile           text not null,
  scope_type               text not null,
  portfolio_id             uuid,
  property_relationship_id uuid,
  property_id              uuid,
  grant_expires_at         timestamptz,
  status                   text not null default 'pending',
  invited_by_account_id    uuid references public.accounts(id) on delete set null,
  created_at               timestamptz not null default now(),
  expires_at               timestamptz not null,
  accepted_at              timestamptz,
  accepted_by_membership_id uuid,
  revoked_at               timestamptz,
  revoked_by_account_id    uuid references public.accounts(id) on delete set null,
  updated_at               timestamptz not null default now(),

  constraint organization_invitations_accept_membership_scope_fkey
    foreign key (accepted_by_membership_id, organization_id)
    references public.organization_memberships(id, organization_id)
    on delete set null (accepted_by_membership_id),
  constraint organization_invitations_portfolio_scope_fkey
    foreign key (portfolio_id, organization_id)
    references public.portfolios(id, organization_id) on delete cascade,
  constraint organization_invitations_property_scope_fkey
    foreign key (property_relationship_id, organization_id, property_id)
    references public.organization_property_relationships(id, organization_id, property_id)
    on delete cascade,
  constraint organization_invitations_email_check
    check (char_length(email) between 3 and 320 and email = lower(btrim(email))),
  constraint organization_invitations_token_hash_check
    check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint organization_invitations_job_category_check
    check (job_category in (
      'owner_principal', 'executive', 'operations', 'regional_manager',
      'asset_manager', 'general_manager', 'assistant_general_manager',
      'revenue', 'finance', 'human_resources', 'information_technology',
      'department_head', 'hotel_employee', 'consultant', 'other'
    )),
  constraint organization_invitations_job_title_check
    check (job_title is null or char_length(btrim(job_title)) between 1 and 120),
  constraint organization_invitations_profile_check
    check (access_profile in (
      'organization_owner', 'organization_admin', 'portfolio_manager',
      'property_manager', 'department_lead', 'contributor', 'viewer',
      'external_collaborator'
    )),
  constraint organization_invitations_scope_check
    check (scope_type in ('organization', 'portfolio', 'property')),
  constraint organization_invitations_scope_shape_check
    check (
      (scope_type = 'organization' and portfolio_id is null
        and property_relationship_id is null and property_id is null)
      or (scope_type = 'portfolio' and portfolio_id is not null
        and property_relationship_id is null and property_id is null)
      or (scope_type = 'property' and portfolio_id is null
        and property_relationship_id is not null and property_id is not null)
    ),
  constraint organization_invitations_profile_scope_check
    check (
      (access_profile in ('organization_owner', 'organization_admin')
        and scope_type = 'organization')
      or (access_profile = 'portfolio_manager' and scope_type = 'portfolio')
      or (access_profile = 'property_manager' and scope_type = 'property')
      or access_profile in (
        'department_lead', 'contributor', 'viewer', 'external_collaborator'
      )
    ),
  constraint organization_invitations_external_expiry_check
    check (access_profile <> 'external_collaborator' or grant_expires_at is not null),
  constraint organization_invitations_owner_permanent_check
    check (access_profile <> 'organization_owner' or grant_expires_at is null),
  constraint organization_invitations_status_check
    check (status in ('pending', 'accepted', 'revoked')),
  constraint organization_invitations_expiry_check
    check (expires_at > created_at and (grant_expires_at is null or grant_expires_at > created_at)),
  constraint organization_invitations_state_shape_check
    check (
      (status = 'pending' and accepted_at is null
        and accepted_by_membership_id is null and revoked_at is null)
      or (status = 'accepted' and accepted_at is not null
        and revoked_at is null)
      or (status = 'revoked' and accepted_at is null
        and accepted_by_membership_id is null and revoked_at is not null)
    )
);

create unique index if not exists organization_invitations_one_pending_scope_idx
  on public.organization_invitations (
    organization_id, lower(email), access_profile, scope_type,
    coalesce(portfolio_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(property_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) where status = 'pending';
create index if not exists organization_invitations_email_status_idx
  on public.organization_invitations (lower(email), status, expires_at);
create index if not exists organization_invitations_org_status_idx
  on public.organization_invitations (organization_id, status, created_at desc);

-- @rls: service-role-only — access requests and reviewer data are returned through scoped DTOs.
create table if not exists public.organization_access_requests (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null,
  membership_id            uuid not null,
  requested_access_profile text not null,
  scope_type               text not null,
  portfolio_id             uuid,
  property_relationship_id uuid,
  property_id              uuid,
  reason                   text not null,
  status                   text not null default 'pending',
  requested_at             timestamptz not null default now(),
  reviewed_at              timestamptz,
  reviewed_by_account_id   uuid references public.accounts(id) on delete set null,
  review_note              text,
  resulting_grant_id       uuid references public.organization_access_grants(id) on delete set null,
  updated_at               timestamptz not null default now(),

  constraint organization_access_requests_membership_scope_fkey
    foreign key (membership_id, organization_id)
    references public.organization_memberships(id, organization_id) on delete cascade,
  constraint organization_access_requests_portfolio_scope_fkey
    foreign key (portfolio_id, organization_id)
    references public.portfolios(id, organization_id) on delete cascade,
  constraint organization_access_requests_property_scope_fkey
    foreign key (property_relationship_id, organization_id, property_id)
    references public.organization_property_relationships(id, organization_id, property_id)
    on delete cascade,
  constraint organization_access_requests_profile_check
    check (requested_access_profile in (
      'organization_owner', 'organization_admin', 'portfolio_manager',
      'property_manager', 'department_lead', 'contributor', 'viewer',
      'external_collaborator'
    )),
  constraint organization_access_requests_scope_check
    check (scope_type in ('organization', 'portfolio', 'property')),
  constraint organization_access_requests_scope_shape_check
    check (
      (scope_type = 'organization' and portfolio_id is null
        and property_relationship_id is null and property_id is null)
      or (scope_type = 'portfolio' and portfolio_id is not null
        and property_relationship_id is null and property_id is null)
      or (scope_type = 'property' and portfolio_id is null
        and property_relationship_id is not null and property_id is not null)
    ),
  constraint organization_access_requests_profile_scope_check
    check (
      (requested_access_profile in ('organization_owner', 'organization_admin')
        and scope_type = 'organization')
      or (requested_access_profile = 'portfolio_manager' and scope_type = 'portfolio')
      or (requested_access_profile = 'property_manager' and scope_type = 'property')
      or requested_access_profile in (
        'department_lead', 'contributor', 'viewer', 'external_collaborator'
      )
    ),
  constraint organization_access_requests_status_check
    check (status in ('pending', 'approved', 'denied', 'cancelled')),
  constraint organization_access_requests_reason_check
    check (char_length(btrim(reason)) between 1 and 1000),
  constraint organization_access_requests_review_shape_check
    check (
      (status = 'pending' and reviewed_at is null
        and reviewed_by_account_id is null and resulting_grant_id is null)
      or (status = 'cancelled' and resulting_grant_id is null)
      or (status = 'denied' and reviewed_at is not null
        and resulting_grant_id is null)
      or (status = 'approved' and reviewed_at is not null)
    )
);

-- Account deletion preserves invitation/request/grant history instead of
-- turning audit FKs into an undeletable-account trap. Event rows retain the
-- immutable actor UUID and fact snapshots even after live account rows leave.
alter table public.organization_invitations
  alter column invited_by_account_id drop not null;
alter table public.organization_invitations
  drop constraint if exists organization_invitations_invited_by_account_id_fkey;
alter table public.organization_invitations
  add constraint organization_invitations_invited_by_account_id_fkey
  foreign key (invited_by_account_id) references public.accounts(id) on delete set null;
alter table public.organization_invitations
  drop constraint if exists organization_invitations_accept_membership_scope_fkey;
alter table public.organization_invitations
  add constraint organization_invitations_accept_membership_scope_fkey
  foreign key (accepted_by_membership_id, organization_id)
  references public.organization_memberships(id, organization_id)
  on delete set null (accepted_by_membership_id);
alter table public.organization_invitations
  drop constraint if exists organization_invitations_state_shape_check;
alter table public.organization_invitations
  add constraint organization_invitations_state_shape_check
  check (
    (status = 'pending' and accepted_at is null
      and accepted_by_membership_id is null and revoked_at is null)
    or (status = 'accepted' and accepted_at is not null and revoked_at is null)
    or (status = 'revoked' and accepted_at is null
      and accepted_by_membership_id is null and revoked_at is not null)
  );
alter table public.organization_access_requests
  drop constraint if exists organization_access_requests_review_shape_check;
alter table public.organization_access_requests
  add constraint organization_access_requests_review_shape_check
  check (
    (status = 'pending' and reviewed_at is null
      and reviewed_by_account_id is null and resulting_grant_id is null)
    or (status = 'cancelled' and resulting_grant_id is null)
    or (status = 'denied' and reviewed_at is not null and resulting_grant_id is null)
    or (status = 'approved' and reviewed_at is not null)
  );

create unique index if not exists organization_access_requests_one_pending_scope_idx
  on public.organization_access_requests (
    membership_id, requested_access_profile, scope_type,
    coalesce(portfolio_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(property_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) where status = 'pending';
create index if not exists organization_access_requests_org_status_idx
  on public.organization_access_requests (organization_id, status, requested_at desc);
create index if not exists organization_access_requests_member_status_idx
  on public.organization_access_requests (membership_id, status, requested_at desc);

-- Monotonic per-organization epoch used by Company Hub reads to detect any
-- authorization/topology change that commits while their projection is being
-- assembled across PostgREST queries. A mismatched epoch makes the route retry
-- once and then fail closed instead of returning a stale authorized snapshot.
create table if not exists public.organization_access_epochs (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  version bigint not null default 1 check (version > 0),
  updated_at timestamptz not null default now()
);
insert into public.organization_access_epochs (organization_id)
select id from public.organizations
on conflict (organization_id) do nothing;

-- ─── Time-limited Staxis support sessions ──────────────────────────────────

-- @rls: service-role-only — internal support scopes and reasons are never customer-readable.
-- Reserved for a later break-glass workflow. This table is not an active
-- authorization source in the shadow rollout, and no RPC in this migration
-- treats a support-session row as permission.
create table if not exists public.staxis_support_sessions (
  id                       uuid primary key default gen_random_uuid(),
  operator_account_id      uuid not null references public.accounts(id) on delete restrict,
  approved_by_account_id   uuid references public.accounts(id) on delete restrict,
  scope_type               text not null,
  organization_id          uuid references public.organizations(id) on delete restrict,
  property_id              uuid references public.properties(id) on delete restrict,
  access_mode              text not null default 'read_only',
  reason                   text not null,
  status                   text not null default 'active',
  starts_at                timestamptz not null default now(),
  expires_at               timestamptz not null,
  ended_at                 timestamptz,
  ended_by_account_id      uuid references public.accounts(id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint staxis_support_sessions_scope_check
    check (scope_type in ('organization', 'property')),
  constraint staxis_support_sessions_scope_shape_check
    check (
      (scope_type = 'organization' and organization_id is not null and property_id is null)
      or (scope_type = 'property' and organization_id is null and property_id is not null)
    ),
  constraint staxis_support_sessions_mode_check
    check (access_mode in ('read_only', 'write')),
  constraint staxis_support_sessions_write_approval_check
    check (
      access_mode = 'read_only'
      or (approved_by_account_id is not null and approved_by_account_id <> operator_account_id)
    ),
  constraint staxis_support_sessions_reason_check
    check (char_length(btrim(reason)) between 10 and 1000),
  constraint staxis_support_sessions_status_check
    check (status in ('active', 'ended', 'revoked')),
  constraint staxis_support_sessions_window_check
    check (expires_at > starts_at and expires_at <= starts_at + interval '8 hours'),
  constraint staxis_support_sessions_end_shape_check
    check (
      (status = 'active' and ended_at is null and ended_by_account_id is null)
      or (status in ('ended', 'revoked') and ended_at is not null)
    )
);

create index if not exists staxis_support_sessions_operator_idx
  on public.staxis_support_sessions (operator_account_id, status, expires_at desc);
create index if not exists staxis_support_sessions_org_active_idx
  on public.staxis_support_sessions (organization_id, expires_at)
  where status = 'active' and organization_id is not null;
create index if not exists staxis_support_sessions_property_active_idx
  on public.staxis_support_sessions (property_id, expires_at)
  where status = 'active' and property_id is not null;

-- ─── Immutable, transactional access audit ─────────────────────────────────

create table if not exists public.organization_access_events (
  id                   uuid primary key default gen_random_uuid(),
  occurred_at          timestamptz not null default now(),
  organization_id      uuid,
  actor_account_id     uuid,
  actor_kind           text not null default 'system',
  support_session_id   uuid,
  event_type           text not null,
  target_type          text not null,
  target_id            text,
  request_id           uuid,
  before_state         jsonb,
  after_state          jsonb,
  metadata             jsonb not null default '{}'::jsonb,

  constraint organization_access_events_actor_kind_check
    check (actor_kind in ('account', 'staxis_admin', 'support_session', 'system')),
  constraint organization_access_events_event_type_check
    check (char_length(btrim(event_type)) between 3 and 120),
  constraint organization_access_events_target_type_check
    check (char_length(btrim(target_type)) between 1 and 120),
  constraint organization_access_events_state_check
    check (before_state is not null or after_state is not null or metadata <> '{}'::jsonb)
);

create index if not exists organization_access_events_org_time_idx
  on public.organization_access_events (organization_id, occurred_at desc);
create index if not exists organization_access_events_actor_time_idx
  on public.organization_access_events (actor_account_id, occurred_at desc);
create index if not exists organization_access_events_target_time_idx
  on public.organization_access_events (target_type, target_id, occurred_at desc);
create index if not exists organization_access_events_request_idx
  on public.organization_access_events (request_id, occurred_at)
  where request_id is not null;

-- ─── Trigger helpers ────────────────────────────────────────────────────────

create or replace function public._staxis_touch_organization_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public._staxis_touch_organization_updated_at() from public, anon, authenticated;

-- Every organization-scoped mutation takes the same transaction advisory lock.
-- With table DML removed from service_role later in this migration, this makes
-- authority checks and the mutation they authorize one serializable unit.
create or replace function public._staxis_lock_organization(p_organization_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_organization_id is not null then
    perform pg_advisory_xact_lock(
      hashtextextended('staxis.organization-access:' || p_organization_id::text, 0)
    );
  end if;
end;
$$;

revoke all on function public._staxis_lock_organization(uuid)
  from public, anon, authenticated;

create or replace function public._staxis_guard_customer_membership_account()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.ended_at is null and exists (
    select 1 from public.accounts a
    where a.id = new.account_id and a.role = 'admin'
  ) then
    raise exception 'Staxis administrators cannot be customer organization members'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public._staxis_guard_customer_membership_account()
  from public, anon, authenticated;

create or replace function public._staxis_guard_internal_admin_promotion()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.role = 'admin' and old.role <> 'admin' and exists (
    select 1 from public.organization_memberships m
    where m.account_id = new.id and m.ended_at is null
  ) then
    raise exception 'revoke customer organization memberships before promoting a Staxis administrator'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public._staxis_guard_internal_admin_promotion()
  from public, anon, authenticated;

create or replace function public._staxis_prevent_access_event_mutation()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  raise exception 'organization_access_events is append-only'
    using errcode = '55000';
end;
$$;

revoke all on function public._staxis_prevent_access_event_mutation() from public, anon, authenticated;

drop trigger if exists trg_organization_access_events_immutable
  on public.organization_access_events;
create trigger trg_organization_access_events_immutable
  before update or delete on public.organization_access_events
  for each row execute function public._staxis_prevent_access_event_mutation();

create or replace function public._staxis_audit_organization_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old             jsonb;
  v_new             jsonb;
  v_subject         jsonb;
  v_organization_id uuid;
  v_actor_id        uuid;
  v_support_id      uuid;
  v_request_id      uuid;
  v_actor_kind      text := 'system';
begin
  v_old := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end;
  v_new := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end;
  v_subject := coalesce(v_new, v_old, '{}'::jsonb);

  -- Token digests are authentication material, not audit payload.
  v_old := case when v_old is null then null else v_old - 'token_hash' end;
  v_new := case when v_new is null then null else v_new - 'token_hash' end;

  begin
    v_organization_id := nullif(v_subject->>'organization_id', '')::uuid;
  exception when invalid_text_representation then
    v_organization_id := null;
  end;
  if v_organization_id is null and tg_table_name = 'organizations' then
    begin
      v_organization_id := nullif(v_subject->>'id', '')::uuid;
    exception when invalid_text_representation then
      v_organization_id := null;
    end;
  end if;

  begin
    v_support_id := nullif(current_setting('staxis.support_session_id', true), '')::uuid;
  exception when invalid_text_representation then
    v_support_id := null;
  end;
  begin
    v_request_id := nullif(current_setting('staxis.request_id', true), '')::uuid;
  exception when invalid_text_representation then
    v_request_id := null;
  end;
  begin
    v_actor_id := coalesce(
      nullif(current_setting('staxis.actor_account_id', true), '')::uuid,
      nullif(v_subject->>'updated_by_account_id', '')::uuid,
      nullif(v_subject->>'granted_by_account_id', '')::uuid,
      nullif(v_subject->>'revoked_by_account_id', '')::uuid,
      nullif(v_subject->>'reviewed_by_account_id', '')::uuid,
      nullif(v_subject->>'removed_by_account_id', '')::uuid,
      nullif(v_subject->>'deactivated_by_account_id', '')::uuid,
      nullif(v_subject->>'linked_by_account_id', '')::uuid,
      nullif(v_subject->>'invited_by_account_id', '')::uuid,
      nullif(v_subject->>'created_by_account_id', '')::uuid,
      nullif(v_subject->>'operator_account_id', '')::uuid
    );
  exception when invalid_text_representation then
    v_actor_id := null;
  end;

  if v_support_id is not null then
    v_actor_kind := 'support_session';
  elsif v_actor_id is not null and exists (
    select 1 from public.accounts a where a.id = v_actor_id and a.role = 'admin'
  ) then
    v_actor_kind := 'staxis_admin';
  elsif v_actor_id is not null then
    v_actor_kind := 'account';
  end if;

  if v_organization_id is not null
     and not (tg_table_name = 'organizations' and tg_op = 'DELETE')
     and exists (
       select 1 from public.organizations epoch_organization
       where epoch_organization.id = v_organization_id
     ) then
    insert into public.organization_access_epochs (organization_id, version, updated_at)
    values (v_organization_id, 1, clock_timestamp())
    on conflict (organization_id) do update
      set version = public.organization_access_epochs.version + 1,
          updated_at = excluded.updated_at;
  end if;

  insert into public.organization_access_events (
    organization_id, actor_account_id, actor_kind, support_session_id,
    event_type, target_type, target_id, request_id, before_state, after_state
  ) values (
    v_organization_id, v_actor_id, v_actor_kind, v_support_id,
    tg_table_name || '.' || lower(tg_op), tg_table_name,
    coalesce(v_subject->>'id', v_subject->>'account_id'),
    v_request_id, v_old, v_new
  );

  return coalesce(new, old);
end;
$$;

revoke all on function public._staxis_audit_organization_mutation() from public, anon, authenticated;

-- Prevent support sessions from being opened by a customer account. Write-mode
-- sessions require a second, distinct Staxis administrator by table constraint.
create or replace function public._staxis_validate_support_session_admins()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.accounts a
    where a.id = new.operator_account_id and a.role = 'admin' and a.active
  ) then
    raise exception 'support session operator must be a Staxis administrator'
      using errcode = '42501';
  end if;
  if new.approved_by_account_id is not null and not exists (
    select 1 from public.accounts a
    where a.id = new.approved_by_account_id and a.role = 'admin' and a.active
  ) then
    raise exception 'support session approver must be a Staxis administrator'
      using errcode = '42501';
  end if;

  if new.ended_by_account_id is not null and not exists (
    select 1 from public.accounts a
    where a.id = new.ended_by_account_id and a.role = 'admin' and a.active
  ) then
    raise exception 'support session ender must be a Staxis administrator'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public._staxis_validate_support_session_admins() from public, anon, authenticated;

drop trigger if exists trg_staxis_support_sessions_validate
  on public.staxis_support_sessions;
create trigger trg_staxis_support_sessions_validate
  before insert or update on public.staxis_support_sessions
  for each row execute function public._staxis_validate_support_session_admins();

drop trigger if exists trg_organization_memberships_customer_realm
  on public.organization_memberships;
create trigger trg_organization_memberships_customer_realm
  before insert or update of account_id, status, ended_at
  on public.organization_memberships
  for each row execute function public._staxis_guard_customer_membership_account();

drop trigger if exists trg_accounts_internal_admin_realm on public.accounts;
create trigger trg_accounts_internal_admin_realm
  before update of role on public.accounts
  for each row execute function public._staxis_guard_internal_admin_promotion();

-- Guard removal/suspension of the last active organization owner. Anchor
-- single-hotel organizations are included: they need a replacement owner or a
-- deliberate organization suspension before their final owner can be removed.
create or replace function public._staxis_guard_last_organization_owner_grant()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_removes_owner boolean;
begin
  v_removes_owner := old.access_profile = 'organization_owner'
    and old.status = 'active'
    and (
      tg_op = 'DELETE'
      or new.status <> 'active'
      or new.access_profile <> 'organization_owner'
      or new.organization_id <> old.organization_id
      or new.membership_id <> old.membership_id
      or (old.starts_at <= now() and new.starts_at > now())
    );

  if not v_removes_owner then
    return coalesce(new, old);
  end if;

  perform public._staxis_lock_organization(old.organization_id);
  -- Hidden single-hotel anchors mirror legacy accounts.property_access. They
  -- are system topology, not customer-managed companies, and an ordinary
  -- owner -> GM/staff edit must be able to replace its generated owner grant
  -- with the corresponding legacy profile atomically. Real/manual owner
  -- grants keep the final-owner invariant below.
  if old.source = 'legacy_backfill' and exists (
    select 1 from public.organizations o
    where o.id = old.organization_id and o.organization_type = 'single_hotel'
  ) then
    return coalesce(new, old);
  end if;
  if not exists (
    select 1 from public.organizations o
    where o.id = old.organization_id and o.status = 'active'
  ) then
    return coalesce(new, old);
  end if;
  if not exists (
    select 1
    from public.organization_access_grants g
    join public.organization_memberships m
      on m.id = g.membership_id and m.organization_id = g.organization_id
    join public.accounts owner_account
      on owner_account.id = m.account_id and owner_account.active
    where g.organization_id = old.organization_id
      and g.id <> old.id
      and g.access_profile = 'organization_owner'
      and g.scope_type = 'organization'
      and g.status = 'active'
      and g.starts_at <= now()
      and g.expires_at is null
      and m.status = 'active'
      and m.starts_at <= now()
      and m.ended_at is null
  ) then
    raise exception 'cannot remove the final active organization owner'
      using errcode = '23514';
  end if;

  return coalesce(new, old);
end;
$$;

revoke all on function public._staxis_guard_last_organization_owner_grant() from public, anon, authenticated;

drop trigger if exists trg_organization_access_grants_last_owner
  on public.organization_access_grants;
create trigger trg_organization_access_grants_last_owner
  before update or delete on public.organization_access_grants
  for each row execute function public._staxis_guard_last_organization_owner_grant();

create or replace function public._staxis_guard_last_owner_membership()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_was_active boolean;
begin
  if tg_op = 'UPDATE' and (
    new.id <> old.id
    or new.organization_id <> old.organization_id
    or new.account_id <> old.account_id
  ) then
    raise exception 'membership identity is immutable; create a new membership or transfer access'
      using errcode = '23514';
  end if;

  v_was_active := old.status = 'active'
    and old.starts_at <= now()
    and old.ended_at is null;
  if not v_was_active or (
    tg_op = 'UPDATE' and new.status = 'active'
      and new.starts_at <= now() and new.ended_at is null
  ) then
    return coalesce(new, old);
  end if;

  if not exists (
    select 1 from public.organization_access_grants g
    where g.membership_id = old.id
      and g.access_profile = 'organization_owner'
      and g.status = 'active'
  ) then
    return coalesce(new, old);
  end if;

  perform public._staxis_lock_organization(old.organization_id);
  if not exists (
    select 1 from public.organizations o
    where o.id = old.organization_id and o.status = 'active'
  ) then
    return coalesce(new, old);
  end if;
  if not exists (
    select 1
    from public.organization_access_grants g
    join public.organization_memberships m
      on m.id = g.membership_id and m.organization_id = g.organization_id
    join public.accounts owner_account
      on owner_account.id = m.account_id and owner_account.active
    where g.organization_id = old.organization_id
      and m.id <> old.id
      and g.access_profile = 'organization_owner'
      and g.status = 'active'
      and g.starts_at <= now()
      and g.expires_at is null
      and m.status = 'active'
      and m.starts_at <= now()
      and m.ended_at is null
  ) then
    raise exception 'cannot suspend or remove the final active organization owner'
      using errcode = '23514';
  end if;

  return coalesce(new, old);
end;
$$;

revoke all on function public._staxis_guard_last_owner_membership() from public, anon, authenticated;

drop trigger if exists trg_organization_memberships_last_owner
  on public.organization_memberships;
create trigger trg_organization_memberships_last_owner
  before update or delete on public.organization_memberships
  for each row execute function public._staxis_guard_last_owner_membership();

-- Account deactivation is an authorization transition even though it keeps
-- membership/grant history intact for clean reactivation. Refuse to deactivate
-- the final owner of a real customer organization; hidden legacy anchors are
-- system topology and may temporarily have no generated owner.
create or replace function public._staxis_guard_account_deactivation_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_organization_id uuid;
begin
  if not old.active or new.active then
    return new;
  end if;

  -- Serialize both final-owner validation and pending-request retirement with
  -- the review/grant RPCs. Include grant-less requesters: disabling an account
  -- must close its first-access requests too.
  for v_organization_id in
    select distinct affected.organization_id
    from (
      select g.organization_id
      from public.organization_access_grants g
      join public.organization_memberships m
        on m.id = g.membership_id and m.organization_id = g.organization_id
      join public.organizations o on o.id = g.organization_id and o.status = 'active'
      where m.account_id = old.id
        and m.status = 'active' and m.starts_at <= now() and m.ended_at is null
        and g.access_profile = 'organization_owner'
        and g.scope_type = 'organization'
        and g.status = 'active' and g.starts_at <= now() and g.expires_at is null
        and not (o.organization_type = 'single_hotel' and g.source = 'legacy_backfill')
      union all
      select request.organization_id
      from public.organization_access_requests request
      join public.organization_memberships request_membership
        on request_membership.id = request.membership_id
       and request_membership.organization_id = request.organization_id
      where request_membership.account_id = old.id
        and request.status = 'pending'
    ) affected
    order by affected.organization_id
  loop
    perform public._staxis_lock_organization(v_organization_id);
    if exists (
      select 1
      from public.organization_access_grants current_owner
      join public.organization_memberships current_membership
        on current_membership.id = current_owner.membership_id
       and current_membership.organization_id = current_owner.organization_id
      join public.organizations current_organization
        on current_organization.id = current_owner.organization_id
       and current_organization.status = 'active'
      where current_owner.organization_id = v_organization_id
        and current_membership.account_id = old.id
        and current_membership.status = 'active'
        and current_membership.starts_at <= now()
        and current_membership.ended_at is null
        and current_owner.access_profile = 'organization_owner'
        and current_owner.scope_type = 'organization'
        and current_owner.status = 'active'
        and current_owner.starts_at <= now()
        and current_owner.expires_at is null
        and not (
          current_organization.organization_type = 'single_hotel'
          and current_owner.source = 'legacy_backfill'
        )
    ) and not exists (
      select 1
      from public.organization_access_grants replacement
      join public.organization_memberships replacement_membership
        on replacement_membership.id = replacement.membership_id
       and replacement_membership.organization_id = replacement.organization_id
      join public.accounts replacement_account
        on replacement_account.id = replacement_membership.account_id
       and replacement_account.active
      where replacement.organization_id = v_organization_id
        and replacement_membership.account_id <> old.id
        and replacement_membership.status = 'active'
        and replacement_membership.starts_at <= now()
        and replacement_membership.ended_at is null
        and replacement.access_profile = 'organization_owner'
        and replacement.scope_type = 'organization'
        and replacement.status = 'active'
        and replacement.starts_at <= now()
        and replacement.expires_at is null
    ) then
      raise exception 'cannot deactivate the final active organization owner'
        using errcode = '23514';
    end if;
  end loop;

  update public.organization_access_requests request
     set status = 'cancelled',
         reviewed_at = clock_timestamp(),
         review_note = 'Account deactivated',
         updated_at = clock_timestamp()
    from public.organization_memberships membership
   where request.membership_id = membership.id
     and request.organization_id = membership.organization_id
     and membership.account_id = old.id
     and request.status = 'pending';
  return new;
end;
$$;

revoke all on function public._staxis_guard_account_deactivation_owner()
  from public, anon, authenticated;

drop trigger if exists trg_accounts_guard_final_organization_owner
  on public.accounts;
create trigger trg_accounts_guard_final_organization_owner
  before update of active on public.accounts
  for each row execute function public._staxis_guard_account_deactivation_owner();

create or replace function public._staxis_prevent_portfolio_cycle()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.parent_id is null then
    return new;
  end if;

  if exists (
    with recursive ancestors as (
      select p.id, p.parent_id
      from public.portfolios p
      where p.id = new.parent_id and p.organization_id = new.organization_id
      union all
      select p.id, p.parent_id
      from public.portfolios p
      join ancestors a on a.parent_id = p.id
      where p.organization_id = new.organization_id
    )
    select 1 from ancestors where id = new.id
  ) then
    raise exception 'portfolio hierarchy cannot contain a cycle'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public._staxis_prevent_portfolio_cycle()
  from public, anon, authenticated;

drop trigger if exists trg_portfolios_prevent_cycle on public.portfolios;
create trigger trg_portfolios_prevent_cycle
  before insert or update of parent_id, organization_id on public.portfolios
  for each row execute function public._staxis_prevent_portfolio_cycle();

-- updated_at and immutable audit wiring. Using individual trigger statements
-- keeps schema-audit tooling and future reviewers able to see every source.
drop trigger if exists trg_organizations_touch on public.organizations;
create trigger trg_organizations_touch before update on public.organizations
  for each row execute function public._staxis_touch_organization_updated_at();
drop trigger if exists trg_organization_property_relationships_touch on public.organization_property_relationships;
create trigger trg_organization_property_relationships_touch before update on public.organization_property_relationships
  for each row execute function public._staxis_touch_organization_updated_at();
drop trigger if exists trg_portfolios_touch on public.portfolios;
create trigger trg_portfolios_touch before update on public.portfolios
  for each row execute function public._staxis_touch_organization_updated_at();
drop trigger if exists trg_portfolio_properties_touch on public.portfolio_properties;
create trigger trg_portfolio_properties_touch before update on public.portfolio_properties
  for each row execute function public._staxis_touch_organization_updated_at();
drop trigger if exists trg_organization_memberships_touch on public.organization_memberships;
create trigger trg_organization_memberships_touch before update on public.organization_memberships
  for each row execute function public._staxis_touch_organization_updated_at();
drop trigger if exists trg_account_property_staff_links_touch on public.account_property_staff_links;
create trigger trg_account_property_staff_links_touch before update on public.account_property_staff_links
  for each row execute function public._staxis_touch_organization_updated_at();
drop trigger if exists trg_organization_access_grants_touch on public.organization_access_grants;
create trigger trg_organization_access_grants_touch before update on public.organization_access_grants
  for each row execute function public._staxis_touch_organization_updated_at();
drop trigger if exists trg_organization_invitations_touch on public.organization_invitations;
create trigger trg_organization_invitations_touch before update on public.organization_invitations
  for each row execute function public._staxis_touch_organization_updated_at();
drop trigger if exists trg_organization_access_requests_touch on public.organization_access_requests;
create trigger trg_organization_access_requests_touch before update on public.organization_access_requests
  for each row execute function public._staxis_touch_organization_updated_at();
drop trigger if exists trg_staxis_support_sessions_touch on public.staxis_support_sessions;
create trigger trg_staxis_support_sessions_touch before update on public.staxis_support_sessions
  for each row execute function public._staxis_touch_organization_updated_at();

drop trigger if exists trg_organizations_access_audit on public.organizations;
create trigger trg_organizations_access_audit after insert or update or delete on public.organizations
  for each row execute function public._staxis_audit_organization_mutation();
drop trigger if exists trg_organization_property_relationships_access_audit on public.organization_property_relationships;
create trigger trg_organization_property_relationships_access_audit after insert or update or delete on public.organization_property_relationships
  for each row execute function public._staxis_audit_organization_mutation();
drop trigger if exists trg_portfolios_access_audit on public.portfolios;
create trigger trg_portfolios_access_audit after insert or update or delete on public.portfolios
  for each row execute function public._staxis_audit_organization_mutation();
drop trigger if exists trg_portfolio_properties_access_audit on public.portfolio_properties;
create trigger trg_portfolio_properties_access_audit after insert or update or delete on public.portfolio_properties
  for each row execute function public._staxis_audit_organization_mutation();
drop trigger if exists trg_organization_memberships_access_audit on public.organization_memberships;
create trigger trg_organization_memberships_access_audit after insert or update or delete on public.organization_memberships
  for each row execute function public._staxis_audit_organization_mutation();
drop trigger if exists trg_account_property_staff_links_access_audit on public.account_property_staff_links;
create trigger trg_account_property_staff_links_access_audit after insert or update or delete on public.account_property_staff_links
  for each row execute function public._staxis_audit_organization_mutation();
drop trigger if exists trg_organization_access_grants_access_audit on public.organization_access_grants;
create trigger trg_organization_access_grants_access_audit after insert or update or delete on public.organization_access_grants
  for each row execute function public._staxis_audit_organization_mutation();
drop trigger if exists trg_organization_invitations_access_audit on public.organization_invitations;
create trigger trg_organization_invitations_access_audit after insert or update or delete on public.organization_invitations
  for each row execute function public._staxis_audit_organization_mutation();
drop trigger if exists trg_organization_access_requests_access_audit on public.organization_access_requests;
create trigger trg_organization_access_requests_access_audit after insert or update or delete on public.organization_access_requests
  for each row execute function public._staxis_audit_organization_mutation();
drop trigger if exists trg_staxis_support_sessions_access_audit on public.staxis_support_sessions;
create trigger trg_staxis_support_sessions_access_audit after insert or update or delete on public.staxis_support_sessions
  for each row execute function public._staxis_audit_organization_mutation();

-- ─── Atomic service-role mutation RPCs ─────────────────────────────────────

-- Idempotent reconciliation keeps the shadow model continuous for
-- properties/accounts created after this migration. The account trigger below
-- also retires stale legacy_backfill facts when the legacy hotel list or role
-- changes. Explicit manual/invitation/request grants are never touched.
create or replace function public._staxis_reconcile_legacy_organization_access(
  p_property_id uuid default null,
  p_actor_account_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_anchor record;
  v_delta integer;
  v_organizations integer := 0;
  v_relationships integer := 0;
  v_memberships integer := 0;
  v_grants integer := 0;
  v_staff_links integer := 0;
begin
  perform set_config(
    'staxis.actor_account_id',
    coalesce(p_actor_account_id::text, ''),
    true
  );

  insert into public.organizations (
    name, organization_type, status, legacy_property_id, created_by_account_id
  )
  select p.name, 'single_hotel', 'active', p.id, p_actor_account_id
  from public.properties p
  where p_property_id is null or p.id = p_property_id
  on conflict (legacy_property_id) do nothing;
  get diagnostics v_organizations = row_count;

  for v_anchor in
    select o.id as organization_id, o.legacy_property_id as property_id
    from public.organizations o
    where o.organization_type = 'single_hotel'
      and o.legacy_property_id is not null
      and (p_property_id is null or o.legacy_property_id = p_property_id)
    order by o.legacy_property_id
  loop
    perform 1 from public.properties p
      where p.id = v_anchor.property_id for update;
    perform public._staxis_lock_organization(v_anchor.organization_id);

    insert into public.organization_property_relationships (
      organization_id, property_id, relationship_type, is_primary_grouping,
      created_by_account_id, updated_by_account_id
    )
    select
      v_anchor.organization_id,
      v_anchor.property_id,
      'operator',
      not exists (
        select 1 from public.organization_property_relationships current_primary
        where current_primary.property_id = v_anchor.property_id
          and current_primary.is_primary_grouping
          and current_primary.ends_at is null
      ),
      p_actor_account_id,
      p_actor_account_id
    where not exists (
      select 1 from public.organization_property_relationships existing_anchor
      where existing_anchor.organization_id = v_anchor.organization_id
        and existing_anchor.property_id = v_anchor.property_id
        and existing_anchor.ends_at is null
    )
    on conflict do nothing;
    get diagnostics v_delta = row_count;
    v_relationships := v_relationships + v_delta;

    update public.organization_property_relationships anchor_relationship
       set is_primary_grouping = true,
           updated_by_account_id = p_actor_account_id
     where anchor_relationship.organization_id = v_anchor.organization_id
       and anchor_relationship.property_id = v_anchor.property_id
       and anchor_relationship.ends_at is null
       and not anchor_relationship.is_primary_grouping
       and not exists (
         select 1 from public.organization_property_relationships current_primary
         where current_primary.property_id = v_anchor.property_id
           and current_primary.is_primary_grouping
           and current_primary.ends_at is null
       );

    insert into public.organization_memberships (
      organization_id, account_id, job_category, job_title, status,
      created_by_account_id
    )
    select
      v_anchor.organization_id,
      a.id,
      case a.role
        when 'owner' then 'owner_principal'
        when 'general_manager' then 'general_manager'
        when 'front_desk' then 'hotel_employee'
        when 'housekeeping' then 'hotel_employee'
        when 'maintenance' then 'hotel_employee'
        else 'other'
      end,
      case a.role
        when 'owner' then 'Owner'
        when 'general_manager' then 'General Manager'
        when 'front_desk' then 'Front Desk'
        when 'housekeeping' then 'Housekeeping'
        when 'maintenance' then 'Maintenance'
        else 'Staff'
      end,
      'active',
      p_actor_account_id
    from public.accounts a
    where a.role <> 'admin'
      and v_anchor.property_id = any(coalesce(a.property_access, '{}'::uuid[]))
    on conflict (organization_id, account_id) where ended_at is null do update
      set job_category = excluded.job_category,
          job_title = excluded.job_title,
          updated_by_account_id = coalesce(
            excluded.updated_by_account_id,
            organization_memberships.updated_by_account_id
          )
      -- A normalized suspension is an explicit customer-company decision.
      -- Legacy hotel reconciliation may refresh the descriptive fields of its
      -- own active membership, but must never resurrect a suspended member or
      -- overwrite metadata supplied by an invitation/request grant.
      where organization_memberships.status = 'active'
        and organization_memberships.ended_at is null
        and not exists (
          select 1
          from public.organization_access_grants explicit_grant
          where explicit_grant.membership_id = organization_memberships.id
            and explicit_grant.source <> 'legacy_backfill'
        )
        and (
          organization_memberships.job_category is distinct from excluded.job_category
          or organization_memberships.job_title is distinct from excluded.job_title
        );
    get diagnostics v_delta = row_count;
    v_memberships := v_memberships + v_delta;

    insert into public.organization_access_grants (
      organization_id, membership_id, access_profile, scope_type,
      property_relationship_id, property_id, source, granted_by_account_id
    )
    select
      m.organization_id,
      m.id,
      case a.role
        when 'owner' then 'organization_owner'
        when 'general_manager' then 'property_manager'
        else 'contributor'
      end,
      case when a.role = 'owner' then 'organization' else 'property' end,
      case when a.role = 'owner' then null else relationship.id end,
      case when a.role = 'owner' then null else relationship.property_id end,
      'legacy_backfill',
      p_actor_account_id
    from public.organization_memberships m
    join public.accounts a on a.id = m.account_id and a.role <> 'admin'
    join lateral (
      select r.id, r.property_id
      from public.organization_property_relationships r
      where r.organization_id = v_anchor.organization_id
        and r.property_id = v_anchor.property_id
        and r.starts_at <= now()
        and (r.ends_at is null or r.ends_at > now())
      order by r.is_primary_grouping desc, r.starts_at desc
      limit 1
    ) relationship on true
    where m.organization_id = v_anchor.organization_id
      and m.status = 'active'
      and m.ended_at is null
      and v_anchor.property_id = any(coalesce(a.property_access, '{}'::uuid[]))
    on conflict do nothing;
    get diagnostics v_delta = row_count;
    v_grants := v_grants + v_delta;

    with ranked_staff_links as (
      select a.id as account_id, s.property_id, s.id as staff_id,
             row_number() over (
               partition by s.id order by a.created_at, a.id
             ) as staff_rank
      from public.accounts a
      join public.staff s on s.id = a.staff_id
      where s.property_id = v_anchor.property_id
        and a.role <> 'admin'
        and v_anchor.property_id = any(coalesce(a.property_access, '{}'::uuid[]))
    )
    insert into public.account_property_staff_links (
      account_id, property_id, staff_id, source, linked_by_account_id
    )
    select account_id, property_id, staff_id, 'legacy_backfill', p_actor_account_id
    from ranked_staff_links
    where staff_rank = 1
    on conflict (account_id, property_id) do update
      set staff_id = excluded.staff_id,
          is_active = true,
          linked_by_account_id = coalesce(
            excluded.linked_by_account_id,
            account_property_staff_links.linked_by_account_id
          ),
          linked_at = case
            when account_property_staff_links.staff_id is distinct from excluded.staff_id
              then now()
            else account_property_staff_links.linked_at
          end,
          deactivated_at = null,
          deactivated_by_account_id = null
      where account_property_staff_links.source = 'legacy_backfill'
        and not exists (
        select 1
        from public.account_property_staff_links active_link
        where active_link.staff_id = excluded.staff_id
          and active_link.is_active
          and active_link.account_id <> excluded.account_id
      )
        and (
          not account_property_staff_links.is_active
          or account_property_staff_links.staff_id is distinct from excluded.staff_id
          or account_property_staff_links.deactivated_at is not null
          or account_property_staff_links.deactivated_by_account_id is not null
        );
    get diagnostics v_delta = row_count;
    v_staff_links := v_staff_links + v_delta;
  end loop;

  return jsonb_build_object(
    'organizations', v_organizations,
    'relationships', v_relationships,
    'memberships', v_memberships,
    'grants', v_grants,
    'staff_links', v_staff_links
  );
end;
$$;

revoke all on function public._staxis_reconcile_legacy_organization_access(uuid, uuid)
  from public, anon, authenticated;

create or replace function public._staxis_reconcile_property_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._staxis_reconcile_legacy_organization_access(new.id, null);
  return new;
end;
$$;

revoke all on function public._staxis_reconcile_property_trigger()
  from public, anon, authenticated;

-- A hard-deleted hotel must also retire its hidden single-hotel anchor. The
-- legacy_property_id FK is deliberately ON DELETE SET NULL for historical
-- topology, so without this BEFORE DELETE hook the anchor (and any generated
-- owner authority) would survive as an unresolvable orphan. Suspending first
-- lets the final-owner guards recognize this as whole-organization retirement;
-- deleting the anchor then cascades every membership/grant/relationship fact.
create or replace function public._staxis_retire_legacy_property_anchor()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_organization_id uuid;
begin
  select o.id into v_organization_id
  from public.organizations o
  where o.organization_type = 'single_hotel'
    and o.legacy_property_id = old.id
  for update;

  if v_organization_id is not null then
    perform public._staxis_lock_organization(v_organization_id);
    update public.organizations
       set status = 'suspended', updated_at = clock_timestamp()
     where id = v_organization_id;
    delete from public.organizations where id = v_organization_id;
  end if;
  return old;
end;
$$;

revoke all on function public._staxis_retire_legacy_property_anchor()
  from public, anon, authenticated;

create or replace function public._staxis_reconcile_account_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_property_id     uuid;
  v_organization_id uuid;
  v_actor_id        uuid;
  v_now             timestamptz := clock_timestamp();
  v_affected_property_ids uuid[];
begin
  begin
    v_actor_id := nullif(current_setting('staxis.actor_account_id', true), '')::uuid;
  exception when invalid_text_representation then
    v_actor_id := null;
  end;

  -- Account rows are necessarily locked before row triggers run. Hotel
  -- deletion therefore follows the same account -> property order. Lock and
  -- validate every property that NEW still references so a concurrent delete
  -- cannot leave a dangling UUID in accounts.property_access.
  v_affected_property_ids := coalesce(new.property_access, '{}'::uuid[]);
  if tg_op = 'UPDATE' then
    v_affected_property_ids := coalesce(old.property_access, '{}'::uuid[])
      || v_affected_property_ids;
  end if;
  for v_property_id in
    select distinct affected.property_id
    from unnest(v_affected_property_ids) as affected(property_id)
    order by affected.property_id
  loop
    perform 1
    from public.properties property
    where property.id = v_property_id
    for update;
    if not found and v_property_id = any(coalesce(new.property_access, '{}'::uuid[])) then
      raise exception 'account property access references a missing hotel'
        using errcode = '23503';
    end if;
  end loop;

  if tg_op = 'UPDATE' then
    -- Lock every hidden single-hotel anchor affected by either side of the
    -- account change. This uses the same organization lock as customer RPCs,
    -- so a concurrent invite/review cannot authorize from a grant while its
    -- legacy source is being removed or downgraded.
    for v_property_id, v_organization_id in
      select o.legacy_property_id, o.id
      from public.organizations o
      where o.organization_type = 'single_hotel'
        and o.legacy_property_id = any(
          coalesce(old.property_access, '{}'::uuid[])
          || coalesce(new.property_access, '{}'::uuid[])
        )
      order by o.legacy_property_id, o.id
    loop
      -- Property rows were locked above in UUID order. Organization locks
      -- follow them consistently for every reconciliation path.
      perform public._staxis_lock_organization(v_organization_id);
    end loop;

    -- Mirror removals and role changes, but ONLY for automatically-created
    -- grants in hidden legacy anchors. Explicit customer-company access is an
    -- independent decision and survives legacy hotel-team edits.
    update public.organization_access_grants stale_grant
       set status = 'revoked',
           revoked_at = v_now,
           revoked_by_account_id = v_actor_id,
           revocation_reason = 'Legacy hotel access or role changed',
           version = version + 1
      from public.organization_memberships membership
      join public.organizations organization
        on organization.id = membership.organization_id
       and organization.organization_type = 'single_hotel'
     where stale_grant.membership_id = membership.id
       and stale_grant.organization_id = membership.organization_id
       and membership.account_id = new.id
       and stale_grant.source = 'legacy_backfill'
       and stale_grant.status = 'active'
       and (
         new.role = 'admin'
         or not (
           organization.legacy_property_id = any(
             coalesce(new.property_access, '{}'::uuid[])
           )
         )
         or case
           when new.role = 'owner' then not (
             stale_grant.access_profile = 'organization_owner'
             and stale_grant.scope_type = 'organization'
           )
           when new.role = 'general_manager' then not (
             stale_grant.access_profile = 'property_manager'
             and stale_grant.scope_type = 'property'
             and stale_grant.property_id = organization.legacy_property_id
           )
           else not (
             stale_grant.access_profile = 'contributor'
             and stale_grant.scope_type = 'property'
             and stale_grant.property_id = organization.legacy_property_id
           )
         end
       );

    update public.account_property_staff_links staff_link
       set is_active = false,
           deactivated_at = v_now,
           deactivated_by_account_id = v_actor_id
     where staff_link.account_id = new.id
       and staff_link.source = 'legacy_backfill'
       and staff_link.is_active
       and (
         new.role = 'admin'
         or not (
           staff_link.property_id = any(
             coalesce(new.property_access, '{}'::uuid[])
           )
         )
         or new.staff_id is null
         or staff_link.staff_id is distinct from new.staff_id
       );

    -- Close a hidden-anchor membership only when the hotel was actually
    -- removed (or the account left the customer realm) and no explicit grant
    -- keeps that membership meaningful. A role-only change reuses the same
    -- membership and updates its descriptive job fields below.
    update public.organization_memberships stale_membership
       set status = 'revoked',
           ended_at = v_now,
           updated_by_account_id = v_actor_id
      from public.organizations organization
     where stale_membership.organization_id = organization.id
       and organization.organization_type = 'single_hotel'
       and stale_membership.account_id = new.id
       and stale_membership.ended_at is null
       and (
         new.role = 'admin'
         or not (
           organization.legacy_property_id = any(
             coalesce(new.property_access, '{}'::uuid[])
           )
         )
       )
       and not exists (
         select 1
         from public.organization_access_grants surviving_grant
         where surviving_grant.membership_id = stale_membership.id
           and surviving_grant.status = 'active'
           and (surviving_grant.expires_at is null or surviving_grant.expires_at > v_now)
       );
  end if;

  if new.role <> 'admin' and new.active then
    foreach v_property_id in array coalesce(new.property_access, '{}'::uuid[])
    loop
      perform public._staxis_reconcile_legacy_organization_access(v_property_id, null);
    end loop;
  end if;
  insert into public.organization_access_epochs (organization_id, version, updated_at)
  select distinct membership.organization_id, 1, clock_timestamp()
  from public.organization_memberships membership
  where membership.account_id = new.id
  on conflict (organization_id) do update
    set version = public.organization_access_epochs.version + 1,
        updated_at = excluded.updated_at;
  return new;
end;
$$;

revoke all on function public._staxis_reconcile_account_trigger()
  from public, anon, authenticated;

drop trigger if exists trg_properties_reconcile_legacy_organization_access
  on public.properties;
create trigger trg_properties_reconcile_legacy_organization_access
  after insert on public.properties
  for each row execute function public._staxis_reconcile_property_trigger();

drop trigger if exists trg_properties_retire_legacy_organization_anchor
  on public.properties;
create trigger trg_properties_retire_legacy_organization_anchor
  before delete on public.properties
  for each row execute function public._staxis_retire_legacy_property_anchor();

drop trigger if exists trg_accounts_reconcile_legacy_organization_access
  on public.accounts;
create trigger trg_accounts_reconcile_legacy_organization_access
  after insert or update of property_access, staff_id, role, active on public.accounts
  for each row execute function public._staxis_reconcile_account_trigger();

create or replace function public._staxis_can_delegate_organization_access(
  p_actor_account_id uuid,
  p_organization_id uuid,
  p_access_profile text,
  p_scope_type text,
  p_portfolio_id uuid,
  p_property_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
      select 1
      from public.organization_memberships m
      join public.accounts actor_account
        on actor_account.id = m.account_id
       and actor_account.role <> 'admin'
       and actor_account.active
      join public.organizations o
        on o.id = m.organization_id and o.status = 'active'
      join public.organization_access_grants g
        on g.membership_id = m.id and g.organization_id = m.organization_id
      where m.account_id = p_actor_account_id
        and m.organization_id = p_organization_id
        and m.status = 'active'
        and m.starts_at <= now()
        and m.ended_at is null
        and g.status = 'active'
        and g.starts_at <= now()
        and (g.expires_at is null or g.expires_at > now())
        and (
          -- Owners may delegate any profile anywhere in their organization.
          (g.access_profile = 'organization_owner' and g.scope_type = 'organization')
          -- Organization admins may delegate non-owner/non-admin profiles.
          or (
            g.access_profile = 'organization_admin'
            and g.scope_type = 'organization'
            and p_access_profile not in ('organization_owner', 'organization_admin')
          )
          -- Portfolio managers may delegate lower profiles only inside their
          -- own portfolio (including a direct hotel contained by it).
          or (
            g.access_profile = 'portfolio_manager'
            and exists (
              select 1 from public.portfolios holder_portfolio
              where holder_portfolio.id = g.portfolio_id
                and holder_portfolio.organization_id = g.organization_id
                and holder_portfolio.status = 'active'
            )
            and p_access_profile in (
              'property_manager', 'department_lead', 'contributor',
              'viewer', 'external_collaborator'
            )
            and (
              (p_scope_type = 'portfolio' and p_portfolio_id = g.portfolio_id)
              or (
                p_scope_type = 'property'
                and exists (
                  select 1
                  from public.portfolio_properties pp
                  join public.organization_property_relationships r
                    on r.id = pp.property_relationship_id
                   and r.organization_id = pp.organization_id
                   and r.property_id = pp.property_id
                  where pp.organization_id = p_organization_id
                    and pp.portfolio_id = g.portfolio_id
                    and pp.property_id = p_property_id
                    and pp.assigned_at <= now()
                    and (pp.removed_at is null or pp.removed_at > now())
                    and r.starts_at <= now()
                    and (r.ends_at is null or r.ends_at > now())
                )
              )
            )
          )
          -- Property managers may delegate lower profiles only at their hotel.
          or (
            g.access_profile = 'property_manager'
            and p_access_profile in (
              'department_lead', 'contributor', 'viewer', 'external_collaborator'
            )
            and p_scope_type = 'property'
            and p_property_id = g.property_id
            and exists (
              select 1
              from public.organization_property_relationships r
              where r.id = g.property_relationship_id
                and r.organization_id = g.organization_id
                and r.property_id = g.property_id
                and r.starts_at <= now()
                and (r.ends_at is null or r.ends_at > now())
            )
          )
        )
    );
$$;

revoke all on function public._staxis_can_delegate_organization_access(
  uuid, uuid, text, text, uuid, uuid
) from public, anon, authenticated;

create or replace function public.staxis_reconcile_legacy_organization_access(
  p_actor_account_id uuid,
  p_property_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.accounts a
    where a.id = p_actor_account_id and a.role = 'admin' and a.active
  ) then
    raise exception 'only a Staxis administrator may reconcile legacy access'
      using errcode = '42501';
  end if;
  if p_property_id is not null and not exists (
    select 1 from public.properties p where p.id = p_property_id
  ) then
    raise exception 'property not found' using errcode = 'P0002';
  end if;

  perform set_config('staxis.actor_account_id', p_actor_account_id::text, true);
  return public._staxis_reconcile_legacy_organization_access(
    p_property_id,
    p_actor_account_id
  );
end;
$$;

revoke all on function public.staxis_reconcile_legacy_organization_access(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_reconcile_legacy_organization_access(uuid, uuid)
  to service_role;

create or replace function public.staxis_create_organization(
  p_actor_account_id uuid,
  p_name text,
  p_organization_type text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if not exists (
    select 1 from public.accounts a
    where a.id = p_actor_account_id and a.role = 'admin' and a.active
  ) then
    raise exception 'only a Staxis administrator may create an organization'
      using errcode = '42501';
  end if;
  if p_organization_type = 'single_hotel' then
    raise exception 'single-hotel tenant anchors are system-managed'
      using errcode = '42501';
  end if;

  perform set_config('staxis.actor_account_id', p_actor_account_id::text, true);
  insert into public.organizations (
    name, organization_type, created_by_account_id
  ) values (
    btrim(p_name), p_organization_type, p_actor_account_id
  ) returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.staxis_create_organization(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.staxis_create_organization(uuid, text, text)
  to service_role;

create or replace function public.staxis_set_primary_property_organization(
  p_actor_account_id uuid,
  p_property_id uuid,
  p_organization_id uuid,
  p_relationship_type text default 'operator'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_relationship_id uuid;
  v_ending_relationship_ids uuid[] := '{}'::uuid[];
  v_lock_organization_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  if not exists (
    select 1 from public.accounts a
    where a.id = p_actor_account_id and a.role = 'admin' and a.active
  ) then
    raise exception 'only a Staxis administrator may move a hotel between organizations'
      using errcode = '42501';
  end if;
  if p_relationship_type not in ('operator', 'owner') then
    raise exception 'primary relationship type must be operator or owner'
      using errcode = '22023';
  end if;

  -- Serialize moves for this property and fail clearly for an unknown hotel.
  perform 1 from public.properties p where p.id = p_property_id for update;
  if not found then
    raise exception 'property not found' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_property_id::text, 0));
  perform set_config('staxis.actor_account_id', p_actor_account_id::text, true);

  -- Ensure post-migration properties always have their hidden Independent
  -- Hotel anchor before a move or an explicit transition back to independent.
  perform public._staxis_reconcile_legacy_organization_access(
    p_property_id,
    p_actor_account_id
  );

  -- Lock every affected organization in UUID order. All other organization
  -- access RPCs use the same lock before checking authority or writing.
  for v_lock_organization_id in
    select organization_id
    from (
      select p_organization_id as organization_id
      union
      select r.organization_id
      from public.organization_property_relationships r
      where r.property_id = p_property_id and r.ends_at is null
    ) affected
    where organization_id is not null
    order by organization_id
  loop
    perform public._staxis_lock_organization(v_lock_organization_id);
  end loop;

  if p_organization_id is not null and not exists (
    select 1 from public.organizations o
    where o.id = p_organization_id
      and o.status = 'active'
      and o.organization_type <> 'single_hotel'
  ) then
    raise exception 'target organization is unavailable or is a system-managed single-hotel anchor'
      using errcode = '23503';
  end if;

  -- Hidden single-hotel anchors remain open as secondary relationships so the
  -- conservative legacy backfill continues to authorize existing staff while
  -- a real management organization is piloted. Real organization moves end the
  -- previous relationship immediately and revoke its inherited access.
  update public.organization_property_relationships r
     set is_primary_grouping = false,
         updated_by_account_id = p_actor_account_id
    from public.organizations o
   where r.organization_id = o.id
     and r.property_id = p_property_id
     and r.is_primary_grouping
     and r.ends_at is null
     and o.organization_type = 'single_hotel';

  select coalesce(array_agg(r.id order by r.id), '{}'::uuid[])
    into v_ending_relationship_ids
  from public.organization_property_relationships r
  where r.property_id = p_property_id
    and r.is_primary_grouping
    and r.ends_at is null
    and not exists (
      select 1 from public.organizations o
      where o.id = r.organization_id and o.organization_type = 'single_hotel'
    )
    and (
      p_organization_id is null
      or r.organization_id <> p_organization_id
      or r.relationship_type <> p_relationship_type
    );

  if cardinality(v_ending_relationship_ids) > 0 then
    update public.organization_access_grants
       set status = 'revoked',
           revoked_at = v_now,
           revoked_by_account_id = p_actor_account_id,
           revocation_reason = 'Hotel relationship ended',
           version = version + 1
     where property_relationship_id = any(v_ending_relationship_ids)
       and status = 'active';

    update public.organization_invitations
       set status = 'revoked',
           revoked_at = v_now,
           revoked_by_account_id = p_actor_account_id
     where property_relationship_id = any(v_ending_relationship_ids)
       and status = 'pending';

    update public.organization_access_requests
       set status = 'cancelled',
           reviewed_at = v_now,
           reviewed_by_account_id = p_actor_account_id,
           review_note = 'Hotel relationship ended before review',
           resulting_grant_id = null
     where property_relationship_id = any(v_ending_relationship_ids)
       and status = 'pending';

    delete from public.portfolio_properties
     where property_relationship_id = any(v_ending_relationship_ids)
       and removed_at is null
       and assigned_at >= v_now;

    update public.portfolio_properties
       set removed_at = v_now,
           removed_by_account_id = p_actor_account_id
     where property_relationship_id = any(v_ending_relationship_ids)
       and removed_at is null
       and assigned_at < v_now;
  end if;

  update public.organization_property_relationships r
     set starts_at = least(r.starts_at, v_now - interval '1 microsecond'),
         ends_at = v_now,
         updated_by_account_id = p_actor_account_id
   where r.id = any(v_ending_relationship_ids);

  if p_organization_id is null then
    -- "Independent" is represented internally by the hidden tenant anchor,
    -- while customer/admin DTOs deliberately expose no customer organization.
    select r.id into v_relationship_id
    from public.organization_property_relationships r
    join public.organizations o
      on o.id = r.organization_id
     and o.organization_type = 'single_hotel'
     and o.legacy_property_id = p_property_id
    where r.property_id = p_property_id and r.ends_at is null
    order by r.starts_at
    limit 1
    for update of r;
    if v_relationship_id is not null then
      update public.organization_property_relationships
         set is_primary_grouping = true,
             updated_by_account_id = p_actor_account_id
       where id = v_relationship_id;
    end if;
    return null;
  end if;

  select r.id into v_relationship_id
  from public.organization_property_relationships r
  where r.organization_id = p_organization_id
    and r.property_id = p_property_id
    and r.relationship_type = p_relationship_type
    and r.ends_at is null
  for update;

  if v_relationship_id is null then
    insert into public.organization_property_relationships (
      organization_id, property_id, relationship_type, is_primary_grouping,
      created_by_account_id, updated_by_account_id
    ) values (
      p_organization_id, p_property_id, p_relationship_type, true,
      p_actor_account_id, p_actor_account_id
    ) returning id into v_relationship_id;
  else
    update public.organization_property_relationships
       set is_primary_grouping = true,
           updated_by_account_id = p_actor_account_id
     where id = v_relationship_id;
  end if;

  return v_relationship_id;
end;
$$;

revoke all on function public.staxis_set_primary_property_organization(
  uuid, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.staxis_set_primary_property_organization(
  uuid, uuid, uuid, text
) to service_role;

create or replace function public.staxis_grant_organization_access(
  p_actor_account_id uuid,
  p_membership_id uuid,
  p_access_profile text,
  p_scope_type text,
  p_portfolio_id uuid default null,
  p_property_id uuid default null,
  p_starts_at timestamptz default now(),
  p_expires_at timestamptz default null,
  p_source text default 'manual'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_organization_id uuid;
  v_relationship_id uuid;
  v_grant_id uuid;
begin
  select m.organization_id into v_organization_id
  from public.organization_memberships m
  where m.id = p_membership_id;
  if v_organization_id is null then
    raise exception 'organization membership not found' using errcode = 'P0002';
  end if;

  perform public._staxis_lock_organization(v_organization_id);
  select m.organization_id into v_organization_id
  from public.organization_memberships m
  join public.organizations o
    on o.id = m.organization_id
   and o.organization_type <> 'single_hotel'
  join public.accounts target_account
    on target_account.id = m.account_id
   and target_account.active
   and target_account.role <> 'admin'
  where m.id = p_membership_id
    and m.status = 'active'
    and m.ended_at is null
    and o.status = 'active'
  for update of m;
  if v_organization_id is null then
    raise exception 'active organization membership not found' using errcode = 'P0002';
  end if;

  if not public._staxis_can_delegate_organization_access(
    p_actor_account_id, v_organization_id, p_access_profile, p_scope_type,
    p_portfolio_id, p_property_id
  ) then
    raise exception 'actor cannot delegate this profile or scope'
      using errcode = '42501';
  end if;
  if p_source not in ('manual', 'access_request') then
    raise exception 'invalid grant source for this mutation path'
      using errcode = '22023';
  end if;

  if p_scope_type = 'portfolio' and not exists (
    select 1 from public.portfolios p
    where p.id = p_portfolio_id
      and p.organization_id = v_organization_id
      and p.status = 'active'
  ) then
    raise exception 'active portfolio not found in organization' using errcode = '23503';
  elsif p_scope_type = 'property' then
    select r.id into v_relationship_id
    from public.organization_property_relationships r
    where r.organization_id = v_organization_id
      and r.property_id = p_property_id
      and r.starts_at <= now()
      and (r.ends_at is null or r.ends_at > now())
    order by r.is_primary_grouping desc, r.starts_at desc
    limit 1;
    if v_relationship_id is null then
      raise exception 'active property relationship not found in organization'
        using errcode = '23503';
    end if;
  end if;

  perform set_config('staxis.actor_account_id', p_actor_account_id::text, true);

  -- Expiration is a time condition, not a status transition. Close an expired
  -- row before renewal so the active-status unique index cannot return a dead
  -- grant or block the replacement.
  update public.organization_access_grants expired_grant
     set status = 'revoked',
         revoked_at = clock_timestamp(),
         revoked_by_account_id = p_actor_account_id,
         revocation_reason = 'Expired grant closed before renewal',
         version = version + 1
   where membership_id = p_membership_id
     and access_profile = p_access_profile
     and scope_type = p_scope_type
     and portfolio_id is not distinct from p_portfolio_id
     and property_id is not distinct from p_property_id
     and status = 'active'
     and expires_at is not null
     and expires_at <= now();

  -- Idempotency for retried API requests.
  select g.id into v_grant_id
  from public.organization_access_grants g
  where g.membership_id = p_membership_id
    and g.access_profile = p_access_profile
    and g.scope_type = p_scope_type
    and g.portfolio_id is not distinct from p_portfolio_id
    and g.property_id is not distinct from p_property_id
    and g.property_relationship_id is not distinct from v_relationship_id
    and g.status = 'active'
  limit 1;
  if v_grant_id is not null then
    -- An exact-scope grant is a renewal/update, not a silent no-op. Honor the
    -- requested window so an approved extension cannot leave the prior expiry
    -- in place (and a deliberately time-boxed replacement cannot stay
    -- permanent). The audit trigger records the versioned before/after fact.
    update public.organization_access_grants g
       set starts_at = p_starts_at,
           expires_at = p_expires_at,
           source = p_source,
           granted_by_account_id = p_actor_account_id,
           version = g.version + 1
     where g.id = v_grant_id
       and (
         g.starts_at is distinct from p_starts_at
         or g.expires_at is distinct from p_expires_at
         or g.source is distinct from p_source
         or g.granted_by_account_id is distinct from p_actor_account_id
       );
    return v_grant_id;
  end if;
  insert into public.organization_access_grants (
    organization_id, membership_id, access_profile, scope_type,
    portfolio_id, property_relationship_id, property_id,
    starts_at, expires_at, source, granted_by_account_id
  ) values (
    v_organization_id, p_membership_id, p_access_profile, p_scope_type,
    p_portfolio_id, v_relationship_id, p_property_id,
    p_starts_at, p_expires_at, p_source, p_actor_account_id
  ) returning id into v_grant_id;

  return v_grant_id;
end;
$$;

revoke all on function public.staxis_grant_organization_access(
  uuid, uuid, text, text, uuid, uuid, timestamptz, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.staxis_grant_organization_access(
  uuid, uuid, text, text, uuid, uuid, timestamptz, timestamptz, text
) to service_role;

create or replace function public.staxis_revoke_organization_access(
  p_actor_account_id uuid,
  p_grant_id uuid,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_grant public.organization_access_grants%rowtype;
begin
  if nullif(btrim(p_reason), '') is null then
    raise exception 'a revocation reason is required' using errcode = '22023';
  end if;

  select g.organization_id into v_grant.organization_id
  from public.organization_access_grants g
  where g.id = p_grant_id;
  if not found then
    raise exception 'access grant not found' using errcode = 'P0002';
  end if;

  perform public._staxis_lock_organization(v_grant.organization_id);
  select * into v_grant
  from public.organization_access_grants g
  where g.id = p_grant_id
  for update;

  if not public._staxis_can_delegate_organization_access(
    p_actor_account_id, v_grant.organization_id, v_grant.access_profile,
    v_grant.scope_type, v_grant.portfolio_id, v_grant.property_id
  ) then
    raise exception 'actor cannot revoke this profile or scope'
      using errcode = '42501';
  end if;
  if v_grant.status = 'revoked' then
    return false;
  end if;
  if v_grant.source = 'legacy_backfill' then
    raise exception 'legacy hotel access must be changed through hotel role settings'
      using errcode = '42501';
  end if;

  perform set_config('staxis.actor_account_id', p_actor_account_id::text, true);
  update public.organization_access_grants
     set status = 'revoked',
         revoked_at = clock_timestamp(),
         revoked_by_account_id = p_actor_account_id,
         revocation_reason = btrim(p_reason),
         version = version + 1
   where id = p_grant_id;
  return true;
end;
$$;

revoke all on function public.staxis_revoke_organization_access(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.staxis_revoke_organization_access(uuid, uuid, text)
  to service_role;

create or replace function public.staxis_create_organization_invitation(
  p_actor_account_id uuid,
  p_organization_id uuid,
  p_email text,
  p_token_hash text,
  p_job_category text,
  p_job_title text,
  p_access_profile text,
  p_scope_type text,
  p_portfolio_id uuid default null,
  p_property_id uuid default null,
  p_expires_at timestamptz default (now() + interval '7 days'),
  p_grant_expires_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_relationship_id uuid;
  v_invitation_id uuid;
begin
  perform public._staxis_lock_organization(p_organization_id);
  if exists (
    select 1 from public.organizations o
    where o.id = p_organization_id and o.organization_type = 'single_hotel'
  ) then
    raise exception 'legacy hotel team access must be changed through hotel role settings'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.organizations o
    where o.id = p_organization_id and o.status = 'active'
  ) then
    raise exception 'active organization not found' using errcode = 'P0002';
  end if;
  if exists (
    select 1
    from public.accounts a
    join auth.users u on u.id = a.data_user_id
    where a.role = 'admin' and lower(u.email) = lower(btrim(p_email))
  ) then
    raise exception 'Staxis administrators cannot be invited into customer organizations'
      using errcode = '42501';
  end if;
  if not public._staxis_can_delegate_organization_access(
    p_actor_account_id, p_organization_id, p_access_profile, p_scope_type,
    p_portfolio_id, p_property_id
  ) then
    raise exception 'actor cannot invite this profile or scope'
      using errcode = '42501';
  end if;

  if p_scope_type = 'portfolio' and not exists (
    select 1 from public.portfolios p
    where p.id = p_portfolio_id
      and p.organization_id = p_organization_id
      and p.status = 'active'
  ) then
    raise exception 'active portfolio not found in organization' using errcode = '23503';
  elsif p_scope_type = 'property' then
    select r.id into v_relationship_id
    from public.organization_property_relationships r
    where r.organization_id = p_organization_id
      and r.property_id = p_property_id
      and r.starts_at <= now()
      and (r.ends_at is null or r.ends_at > now())
    order by r.is_primary_grouping desc, r.starts_at desc
    limit 1;
    if v_relationship_id is null then
      raise exception 'active property relationship not found in organization'
        using errcode = '23503';
    end if;
  end if;

  perform set_config('staxis.actor_account_id', p_actor_account_id::text, true);
  update public.organization_invitations
     set status = 'revoked',
         revoked_at = clock_timestamp(),
         revoked_by_account_id = p_actor_account_id
   where organization_id = p_organization_id
     and email = lower(btrim(p_email))
     and access_profile = p_access_profile
     and scope_type = p_scope_type
     and portfolio_id is not distinct from p_portfolio_id
     and property_id is not distinct from p_property_id
     and status = 'pending'
     and expires_at <= now();

  insert into public.organization_invitations (
    organization_id, email, token_hash, job_category, job_title,
    access_profile, scope_type, portfolio_id, property_relationship_id,
    property_id, grant_expires_at, invited_by_account_id, expires_at
  ) values (
    p_organization_id, lower(btrim(p_email)), lower(btrim(p_token_hash)),
    p_job_category, nullif(btrim(p_job_title), ''), p_access_profile,
    p_scope_type, p_portfolio_id, v_relationship_id, p_property_id,
    p_grant_expires_at, p_actor_account_id, p_expires_at
  ) returning id into v_invitation_id;
  return v_invitation_id;
end;
$$;

revoke all on function public.staxis_create_organization_invitation(
  uuid, uuid, text, text, text, text, text, text, uuid, uuid, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.staxis_create_organization_invitation(
  uuid, uuid, text, text, text, text, text, text, uuid, uuid, timestamptz, timestamptz
) to service_role;

-- Explicit platform recovery/bootstrap seam. A Staxis admin may sponsor a
-- customer leader invitation even when another leader exists, but can never
-- enroll an internal admin account or use the generic customer delegation path.
create or replace function public.staxis_bootstrap_organization_leader_invitation(
  p_actor_account_id uuid,
  p_organization_id uuid,
  p_email text,
  p_token_hash text,
  p_job_category text,
  p_job_title text,
  p_access_profile text,
  p_expires_at timestamptz default (now() + interval '7 days')
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invitation_id uuid;
begin
  if not exists (
    select 1 from public.accounts a
    where a.id = p_actor_account_id and a.role = 'admin' and a.active
  ) then
    raise exception 'only a Staxis administrator may bootstrap an organization leader'
      using errcode = '42501';
  end if;
  if p_access_profile not in ('organization_owner', 'organization_admin') then
    raise exception 'bootstrap profile must be organization_owner or organization_admin'
      using errcode = '22023';
  end if;
  perform public._staxis_lock_organization(p_organization_id);
  if not exists (
    select 1 from public.organizations o
    where o.id = p_organization_id
      and o.status = 'active'
      and o.organization_type <> 'single_hotel'
  ) then
    raise exception 'bootstrap target must be an active customer organization'
      using errcode = '23503';
  end if;
  if exists (
    select 1
    from public.accounts a
    join auth.users u on u.id = a.data_user_id
    where a.role = 'admin' and lower(u.email) = lower(btrim(p_email))
  ) then
    raise exception 'Staxis administrators cannot be invited into customer organizations'
      using errcode = '42501';
  end if;

  perform set_config('staxis.actor_account_id', p_actor_account_id::text, true);
  update public.organization_invitations
     set status = 'revoked',
         revoked_at = clock_timestamp(),
         revoked_by_account_id = p_actor_account_id
   where organization_id = p_organization_id
     and email = lower(btrim(p_email))
     and access_profile = p_access_profile
     and scope_type = 'organization'
     and status = 'pending'
     and expires_at <= now();

  insert into public.organization_invitations (
    organization_id, email, token_hash, job_category, job_title,
    access_profile, scope_type, invited_by_account_id, expires_at
  ) values (
    p_organization_id, lower(btrim(p_email)), lower(btrim(p_token_hash)),
    p_job_category, nullif(btrim(p_job_title), ''), p_access_profile,
    'organization', p_actor_account_id, p_expires_at
  ) returning id into v_invitation_id;
  return v_invitation_id;
end;
$$;

revoke all on function public.staxis_bootstrap_organization_leader_invitation(
  uuid, uuid, text, text, text, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.staxis_bootstrap_organization_leader_invitation(
  uuid, uuid, text, text, text, text, text, timestamptz
) to service_role;

create or replace function public.staxis_accept_organization_invitation(
  p_token_hash text,
  p_account_id uuid
)
returns table (membership_id uuid, grant_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invitation public.organization_invitations%rowtype;
  v_account_email text;
  v_account_role text;
  v_membership_id uuid;
  v_grant_id uuid;
begin
  select i.organization_id, i.invited_by_account_id
    into v_invitation.organization_id, v_invitation.invited_by_account_id
  from public.organization_invitations i
  where i.token_hash = lower(btrim(p_token_hash));
  if not found then
    raise exception 'invitation is invalid, expired, or already used'
      using errcode = '22023';
  end if;

  -- Account deactivation takes an account-row lock before the organization
  -- guard runs, so invitation acceptance uses the same account -> organization
  -- order. Lock both identities in UUID order to keep cross-invitation cases
  -- deterministic and ensure neither can be disabled mid-acceptance.
  perform 1
  from public.accounts locked_account
  where locked_account.id in (p_account_id, v_invitation.invited_by_account_id)
  order by locked_account.id
  for share;
  perform public._staxis_lock_organization(v_invitation.organization_id);
  select i.* into v_invitation
  from public.organization_invitations i
  where i.token_hash = lower(btrim(p_token_hash))
  for update;
  if v_invitation.status <> 'pending'
     or v_invitation.expires_at <= now() then
    raise exception 'invitation is invalid, expired, or already used'
      using errcode = '22023';
  end if;

  select lower(u.email), a.role into v_account_email, v_account_role
  from public.accounts a
  join auth.users u on u.id = a.data_user_id
  where a.id = p_account_id and a.active;
  if v_account_email is null or v_account_email <> v_invitation.email then
    raise exception 'invitation email does not match the authenticated account'
      using errcode = '42501';
  end if;
  if v_account_role = 'admin' then
    raise exception 'Staxis administrators cannot accept customer organization invitations'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.organizations o
    where o.id = v_invitation.organization_id
      and o.status = 'active'
      and o.organization_type <> 'single_hotel'
  ) then
    raise exception 'invitation organization is not active' using errcode = '23514';
  end if;
  if v_invitation.scope_type = 'portfolio' and not exists (
    select 1 from public.portfolios p
    where p.id = v_invitation.portfolio_id and p.organization_id = v_invitation.organization_id
      and p.status = 'active'
  ) then
    raise exception 'invited portfolio is no longer active' using errcode = '23514';
  elsif v_invitation.scope_type = 'property' and not exists (
    select 1 from public.organization_property_relationships r
    where r.id = v_invitation.property_relationship_id
      and r.organization_id = v_invitation.organization_id
      and r.property_id = v_invitation.property_id
      and r.starts_at <= now() and (r.ends_at is null or r.ends_at > now())
  ) then
    raise exception 'invited property relationship is no longer active'
      using errcode = '23514';
  end if;

  -- Authority is evaluated again at acceptance, not frozen at send time. A
  -- revoked/demoted inviter or a scope that moved since the email was sent can
  -- never mint access from a stale invitation.
  if not (
    (
      v_invitation.scope_type = 'organization'
      and v_invitation.access_profile in ('organization_owner', 'organization_admin')
      and exists (
        select 1 from public.accounts bootstrap_sponsor
        where bootstrap_sponsor.id = v_invitation.invited_by_account_id
          and bootstrap_sponsor.role = 'admin'
          and bootstrap_sponsor.active
      )
    )
    or public._staxis_can_delegate_organization_access(
      v_invitation.invited_by_account_id,
      v_invitation.organization_id,
      v_invitation.access_profile,
      v_invitation.scope_type,
      v_invitation.portfolio_id,
      v_invitation.property_id
    )
  ) then
    raise exception 'inviter no longer has authority for this profile or scope'
      using errcode = '42501';
  end if;

  perform set_config('staxis.actor_account_id', p_account_id::text, true);
  select m.id into v_membership_id
  from public.organization_memberships m
  where m.organization_id = v_invitation.organization_id
    and m.account_id = p_account_id
    and m.ended_at is null
  for update;

  if v_membership_id is null then
    insert into public.organization_memberships (
      organization_id, account_id, job_category, job_title, status,
      created_by_account_id
    ) values (
      v_invitation.organization_id, p_account_id, v_invitation.job_category,
      v_invitation.job_title, 'active', v_invitation.invited_by_account_id
    ) returning id into v_membership_id;
  elsif not exists (
    select 1 from public.organization_memberships m
    where m.id = v_membership_id and m.status = 'active'
  ) then
    raise exception 'existing organization membership is suspended'
      using errcode = '42501';
  end if;

  update public.organization_access_grants expired_grant
     set status = 'revoked',
         revoked_at = clock_timestamp(),
         revoked_by_account_id = p_account_id,
         revocation_reason = 'Expired grant closed before invitation renewal',
         version = version + 1
   where expired_grant.membership_id = v_membership_id
     and expired_grant.access_profile = v_invitation.access_profile
     and expired_grant.scope_type = v_invitation.scope_type
     and expired_grant.portfolio_id is not distinct from v_invitation.portfolio_id
     and expired_grant.property_id is not distinct from v_invitation.property_id
     and expired_grant.status = 'active'
     and expired_grant.expires_at is not null
     and expired_grant.expires_at <= now();

  select g.id into v_grant_id
  from public.organization_access_grants g
  where g.membership_id = v_membership_id
    and g.access_profile = v_invitation.access_profile
    and g.scope_type = v_invitation.scope_type
    and g.portfolio_id is not distinct from v_invitation.portfolio_id
    and g.property_id is not distinct from v_invitation.property_id
    and g.property_relationship_id is not distinct from v_invitation.property_relationship_id
    and g.status = 'active'
  limit 1;

  if v_grant_id is null then
    insert into public.organization_access_grants (
      organization_id, membership_id, access_profile, scope_type,
      portfolio_id, property_relationship_id, property_id,
      expires_at, source, granted_by_account_id
    ) values (
      v_invitation.organization_id, v_membership_id,
      v_invitation.access_profile, v_invitation.scope_type,
      v_invitation.portfolio_id, v_invitation.property_relationship_id,
      v_invitation.property_id, v_invitation.grant_expires_at,
      'invitation', v_invitation.invited_by_account_id
    ) returning id into v_grant_id;
  else
    -- Accepting an invitation with the same profile/scope renews the existing
    -- fact to the invitation's explicit expiry instead of silently accepting
    -- the invite while leaving stale terms in force.
    update public.organization_access_grants g
       set starts_at = least(g.starts_at, clock_timestamp()),
           expires_at = v_invitation.grant_expires_at,
           source = 'invitation',
           granted_by_account_id = v_invitation.invited_by_account_id,
           version = g.version + 1
     where g.id = v_grant_id
       and (
         g.expires_at is distinct from v_invitation.grant_expires_at
         or g.source <> 'invitation'
         or g.granted_by_account_id is distinct from v_invitation.invited_by_account_id
         or g.starts_at > now()
       );
  end if;

  update public.organization_invitations
     set status = 'accepted', accepted_at = clock_timestamp(),
         accepted_by_membership_id = v_membership_id
   where id = v_invitation.id;

  return query select v_membership_id, v_grant_id;
end;
$$;

revoke all on function public.staxis_accept_organization_invitation(text, uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_accept_organization_invitation(text, uuid)
  to service_role;

create or replace function public.staxis_create_organization_access_request(
  p_actor_account_id uuid,
  p_membership_id uuid,
  p_requested_access_profile text,
  p_scope_type text,
  p_reason text,
  p_portfolio_id uuid default null,
  p_property_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_organization_id uuid;
  v_relationship_id uuid;
  v_request_id uuid;
begin
  select m.organization_id into v_organization_id
  from public.organization_memberships m
  where m.id = p_membership_id and m.account_id = p_actor_account_id;
  if v_organization_id is null then
    raise exception 'actor does not own an organization membership'
      using errcode = '42501';
  end if;

  perform public._staxis_lock_organization(v_organization_id);
  select m.organization_id into v_organization_id
  from public.organization_memberships m
  join public.organizations o on o.id = m.organization_id and o.status = 'active'
  join public.accounts actor_account
    on actor_account.id = m.account_id
   and actor_account.active
   and actor_account.role <> 'admin'
  where m.id = p_membership_id
    and m.account_id = p_actor_account_id
    and m.status = 'active'
    and m.starts_at <= now()
    and m.ended_at is null
  for update of m;
  if v_organization_id is null then
    raise exception 'actor does not own an active membership'
      using errcode = '42501';
  end if;
  if exists (
    select 1 from public.organizations o
    where o.id = v_organization_id and o.organization_type = 'single_hotel'
  ) then
    raise exception 'legacy hotel team access must be changed through hotel role settings'
      using errcode = '42501';
  end if;

  if p_scope_type = 'portfolio' and not exists (
    select 1 from public.portfolios p
    where p.id = p_portfolio_id
      and p.organization_id = v_organization_id
      and p.status = 'active'
  ) then
    raise exception 'active portfolio not found in organization' using errcode = '23503';
  elsif p_scope_type = 'property' then
    select r.id into v_relationship_id
    from public.organization_property_relationships r
    where r.organization_id = v_organization_id
      and r.property_id = p_property_id
      and r.starts_at <= now()
      and (r.ends_at is null or r.ends_at > now())
    order by r.is_primary_grouping desc, r.starts_at desc
    limit 1;
    if v_relationship_id is null then
      raise exception 'active property relationship not found in organization'
        using errcode = '23503';
    end if;
  end if;

  perform set_config('staxis.actor_account_id', p_actor_account_id::text, true);
  insert into public.organization_access_requests (
    organization_id, membership_id, requested_access_profile, scope_type,
    portfolio_id, property_relationship_id, property_id, reason
  ) values (
    v_organization_id, p_membership_id, p_requested_access_profile, p_scope_type,
    p_portfolio_id, v_relationship_id, p_property_id, btrim(p_reason)
  ) returning id into v_request_id;

  return v_request_id;
end;
$$;

revoke all on function public.staxis_create_organization_access_request(
  uuid, uuid, text, text, text, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.staxis_create_organization_access_request(
  uuid, uuid, text, text, text, uuid, uuid
) to service_role;

create or replace function public.staxis_review_organization_access_request(
  p_actor_account_id uuid,
  p_request_id uuid,
  p_decision text,
  p_review_note text default null,
  p_expires_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.organization_access_requests%rowtype;
  v_grant_id uuid;
begin
  if p_decision not in ('approved', 'denied') then
    raise exception 'decision must be approved or denied' using errcode = '22023';
  end if;

  select r.organization_id into v_request.organization_id
  from public.organization_access_requests r
  where r.id = p_request_id;
  if not found then
    raise exception 'access request not found' using errcode = 'P0002';
  end if;

  perform public._staxis_lock_organization(v_request.organization_id);
  select r.* into v_request
  from public.organization_access_requests r
  where r.id = p_request_id
  for update;
  if v_request.status <> 'pending' then
    raise exception 'access request has already been reviewed'
      using errcode = '55000';
  end if;

  if v_request.scope_type = 'property' and not exists (
    select 1 from public.organization_property_relationships relationship
    where relationship.id = v_request.property_relationship_id
      and relationship.organization_id = v_request.organization_id
      and relationship.property_id = v_request.property_id
      and relationship.starts_at <= now()
      and (relationship.ends_at is null or relationship.ends_at > now())
  ) then
    raise exception 'requested hotel relationship is no longer active'
      using errcode = '55000';
  end if;

  -- Approval and denial require the same live delegation authority. This
  -- prevents a former manager from clearing the queue after losing scope.
  if not public._staxis_can_delegate_organization_access(
    p_actor_account_id,
    v_request.organization_id,
    v_request.requested_access_profile,
    v_request.scope_type,
    v_request.portfolio_id,
    v_request.property_id
  ) then
    raise exception 'actor cannot review this requested profile or scope'
      using errcode = '42501';
  end if;

  if p_decision = 'denied' and nullif(btrim(p_review_note), '') is null then
    raise exception 'a denial reason is required' using errcode = '22023';
  end if;

  perform set_config('staxis.actor_account_id', p_actor_account_id::text, true);
  if p_decision = 'approved' then
    -- Nested RPC performs fresh organization/scope/delegation checks and the
    -- grant insert. Any later request-update failure rolls the grant back.
    v_grant_id := public.staxis_grant_organization_access(
      p_actor_account_id,
      v_request.membership_id,
      v_request.requested_access_profile,
      v_request.scope_type,
      v_request.portfolio_id,
      v_request.property_id,
      now(),
      p_expires_at,
      'access_request'
    );

    update public.organization_access_requests
       set status = 'approved',
           reviewed_at = clock_timestamp(),
           reviewed_by_account_id = p_actor_account_id,
           review_note = nullif(btrim(p_review_note), ''),
           resulting_grant_id = v_grant_id
     where id = p_request_id;
  else
    update public.organization_access_requests
       set status = 'denied',
           reviewed_at = clock_timestamp(),
           reviewed_by_account_id = p_actor_account_id,
           review_note = btrim(p_review_note),
           resulting_grant_id = null
     where id = p_request_id;
  end if;

  return v_grant_id;
end;
$$;

revoke all on function public.staxis_review_organization_access_request(
  uuid, uuid, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.staxis_review_organization_access_request(
  uuid, uuid, text, text, timestamptz
) to service_role;

-- ─── Effective property-access projection (service-role only) ───────────────

create or replace view public.organization_effective_property_access
with (security_invoker = true)
as
with valid_memberships as (
  select m.*
  from public.organization_memberships m
  join public.accounts a on a.id = m.account_id and a.role <> 'admin' and a.active
  join public.organizations o on o.id = m.organization_id
  where m.status = 'active'
    and m.starts_at <= now()
    and m.ended_at is null
    and o.status = 'active'
), valid_grants as (
  select g.*
  from public.organization_access_grants g
  join valid_memberships m
    on m.id = g.membership_id and m.organization_id = g.organization_id
  where g.status = 'active'
    and g.starts_at <= now()
    and (g.expires_at is null or g.expires_at > now())
), valid_relationships as (
  select r.*
  from public.organization_property_relationships r
  where r.starts_at <= now()
    and (r.ends_at is null or r.ends_at > now())
), expanded as (
  select g.id as grant_id, g.membership_id, g.organization_id,
         r.property_id, g.access_profile, g.scope_type, g.source,
         g.starts_at, g.expires_at, r.id as property_relationship_id
  from valid_grants g
  join valid_relationships r on r.organization_id = g.organization_id
  where g.scope_type = 'organization'

  union all

  select g.id, g.membership_id, g.organization_id,
         pp.property_id, g.access_profile, g.scope_type, g.source,
         g.starts_at, g.expires_at, pp.property_relationship_id
  from valid_grants g
  join public.portfolios p
    on p.id = g.portfolio_id
   and p.organization_id = g.organization_id
   and p.status = 'active'
  join public.portfolio_properties pp
    on pp.portfolio_id = g.portfolio_id
   and pp.organization_id = g.organization_id
   and pp.assigned_at <= now()
   and (pp.removed_at is null or pp.removed_at > now())
  join valid_relationships r
    on r.id = pp.property_relationship_id
   and r.organization_id = pp.organization_id
   and r.property_id = pp.property_id
  where g.scope_type = 'portfolio'

  union all

  select g.id, g.membership_id, g.organization_id,
         g.property_id, g.access_profile, g.scope_type, g.source,
         g.starts_at, g.expires_at, g.property_relationship_id
  from valid_grants g
  join valid_relationships r
    on r.id = g.property_relationship_id
   and r.organization_id = g.organization_id
   and r.property_id = g.property_id
  where g.scope_type = 'property'
)
select m.account_id, e.membership_id, e.organization_id, e.property_id,
       e.grant_id, e.access_profile, e.scope_type, e.source,
       e.starts_at, e.expires_at, e.property_relationship_id
from expanded e
join valid_memberships m on m.id = e.membership_id;

-- A single bounded read for the workflow feeds in Company Hub. Keeping these
-- filters in PostgreSQL avoids one PostgREST request per delegatable
-- profile/scope tuple (which can grow with every hotel and portfolio). The API
-- still revalidates every returned row with the pure resolver as defense in
-- depth. Hidden single-hotel compatibility anchors never participate.
create or replace function public.staxis_company_access_feed(
  p_actor_account_id uuid,
  p_limit integer default 100
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with
  feed_limit as materialized (
    select least(greatest(coalesce(p_limit, 100), 1), 200) as row_limit
  ),
  actor_account as materialized (
    select account.id
    from public.accounts account
    where account.id = p_actor_account_id
      and account.active
      and account.role <> 'admin'
  ),
  actor_memberships as materialized (
    select membership.id, membership.organization_id
    from public.organization_memberships membership
    join actor_account on actor_account.id = membership.account_id
    join public.organizations organization
      on organization.id = membership.organization_id
     and organization.status = 'active'
     and organization.organization_type <> 'single_hotel'
    where membership.status = 'active'
      and membership.starts_at <= now()
      and membership.ended_at is null
  ),
  actor_organizations as materialized (
    select distinct membership.organization_id
    from actor_memberships membership
  ),
  actor_relationships as materialized (
    select relationship.*
    from actor_organizations actor_organization
    join public.organization_property_relationships relationship
      on relationship.organization_id = actor_organization.organization_id
    where relationship.starts_at <= now()
      and (relationship.ends_at is null or relationship.ends_at > now())
  ),
  actor_portfolios as materialized (
    select portfolio.*
    from actor_organizations actor_organization
    join public.portfolios portfolio
      on portfolio.organization_id = actor_organization.organization_id
    where portfolio.status = 'active'
  ),
  actor_portfolio_properties as materialized (
    select assignment.*
    from actor_portfolios portfolio
    join public.portfolio_properties assignment
      on assignment.organization_id = portfolio.organization_id
     and assignment.portfolio_id = portfolio.id
    join actor_relationships relationship
      on relationship.id = assignment.property_relationship_id
     and relationship.organization_id = assignment.organization_id
     and relationship.property_id = assignment.property_id
    where assignment.assigned_at <= now()
      and (assignment.removed_at is null or assignment.removed_at > now())
  ),
  actor_grants as materialized (
    select grant_row.*
    from public.organization_access_grants grant_row
    join actor_memberships membership
      on membership.id = grant_row.membership_id
     and membership.organization_id = grant_row.organization_id
    where grant_row.status = 'active'
      and grant_row.starts_at <= now()
      and (grant_row.expires_at is null or grant_row.expires_at > now())
  ),
  authorized_invitations as materialized (
    select invitation.id, invitation.organization_id, invitation.email,
           invitation.access_profile, invitation.scope_type,
           invitation.portfolio_id, invitation.property_id,
           invitation.status, invitation.expires_at,
           invitation.invited_by_account_id, invitation.created_at
    from actor_memberships actor_membership
    join public.organization_invitations invitation
      on invitation.organization_id = actor_membership.organization_id
    where invitation.status = 'pending'
      and public._staxis_can_delegate_organization_access(
        p_actor_account_id,
        invitation.organization_id,
        invitation.access_profile,
        invitation.scope_type,
        invitation.portfolio_id,
        invitation.property_id
      )
  ),
  invitation_page as materialized (
    select invitation.*
    from authorized_invitations invitation
    order by invitation.created_at desc, invitation.id desc
    limit (select row_limit from feed_limit)
  ),
  authorized_requests as materialized (
    select request_row.id, request_row.organization_id,
           request_row.membership_id,
           request_row.requested_access_profile,
           request_row.scope_type, request_row.portfolio_id,
           request_row.property_id, request_row.reason, request_row.status,
           request_row.requested_at, request_row.reviewed_by_account_id,
           case
             when request_row.status = 'pending'
              and target_membership.account_id <> p_actor_account_id then 1
             when request_row.status = 'pending' then 2
             else 3
           end as priority
    from actor_memberships actor_membership
    join public.organization_access_requests request_row
      on request_row.organization_id = actor_membership.organization_id
    join public.organization_memberships target_membership
      on target_membership.id = request_row.membership_id
     and target_membership.organization_id = request_row.organization_id
    where (
        target_membership.account_id = p_actor_account_id
        or public._staxis_can_delegate_organization_access(
          p_actor_account_id,
          request_row.organization_id,
          request_row.requested_access_profile,
          request_row.scope_type,
          request_row.portfolio_id,
          request_row.property_id
        )
      )
  ),
  request_page as materialized (
    select request_row.*
    from authorized_requests request_row
    order by request_row.priority, request_row.requested_at desc,
             request_row.id desc
    limit (select row_limit from feed_limit)
  ),
  activity_grants as materialized (
    select grant_row.*
    from actor_grants grant_row
    where grant_row.access_profile in (
      'organization_owner', 'organization_admin',
      'portfolio_manager', 'property_manager'
    )
  ),
  full_activity_organizations as materialized (
    select distinct grant_row.organization_id
    from activity_grants grant_row
    where grant_row.scope_type = 'organization'
  ),
  -- Full-organization viewers are authorized directly in event_page and do
  -- not need per-property target expansion. Excluding those organizations here
  -- prevents an O(hotels x grants/invitations/requests) intermediate result for
  -- the largest management companies while preserving scoped-viewer filtering.
  activity_properties as materialized (
    select grant_row.organization_id, relationship.property_id
    from activity_grants grant_row
    join actor_relationships relationship
      on relationship.organization_id = grant_row.organization_id
    where grant_row.scope_type = 'organization'
      and not exists (
        select 1
        from full_activity_organizations full_scope
        where full_scope.organization_id = grant_row.organization_id
      )

    union

    select grant_row.organization_id, assignment.property_id
    from activity_grants grant_row
    join actor_portfolio_properties assignment
      on assignment.organization_id = grant_row.organization_id
     and assignment.portfolio_id = grant_row.portfolio_id
    where grant_row.scope_type = 'portfolio'
      and not exists (
        select 1
        from full_activity_organizations full_scope
        where full_scope.organization_id = grant_row.organization_id
      )

    union

    select grant_row.organization_id, grant_row.property_id
    from activity_grants grant_row
    join actor_relationships relationship
      on relationship.id = grant_row.property_relationship_id
     and relationship.organization_id = grant_row.organization_id
     and relationship.property_id = grant_row.property_id
    where grant_row.scope_type = 'property'
      and not exists (
        select 1
        from full_activity_organizations full_scope
        where full_scope.organization_id = grant_row.organization_id
      )
  ),
  -- Every historical target expansion starts from the actor's current
  -- activity properties. This both bounds materialization to the actor's
  -- tenant/scope and lets revoked grants plus accepted/cancelled invitations
  -- remain visible without exposing neighboring hotel scopes.
  scoped_relationship_target_properties as materialized (
    select activity_property.organization_id, relationship.id::text as target_id,
           activity_property.property_id
    from activity_properties activity_property
    join public.organization_property_relationships relationship
      on relationship.organization_id = activity_property.organization_id
     and relationship.property_id = activity_property.property_id
  ),
  scoped_grant_target_properties as materialized (
    select activity_property.organization_id, target_grant.id::text as grant_id,
           target_grant.membership_id::text as membership_id,
           activity_property.property_id
    from activity_properties activity_property
    join public.organization_access_grants target_grant
      on target_grant.organization_id = activity_property.organization_id
     and target_grant.scope_type = 'organization'

    union all

    select activity_property.organization_id, target_grant.id::text,
           target_grant.membership_id::text, activity_property.property_id
    from activity_properties activity_property
    join actor_portfolio_properties assignment
      on assignment.organization_id = activity_property.organization_id
     and assignment.property_id = activity_property.property_id
    join public.organization_access_grants target_grant
      on target_grant.organization_id = assignment.organization_id
     and target_grant.scope_type = 'portfolio'
     and target_grant.portfolio_id = assignment.portfolio_id

    union all

    select activity_property.organization_id, target_grant.id::text,
           target_grant.membership_id::text, activity_property.property_id
    from activity_properties activity_property
    join public.organization_access_grants target_grant
      on target_grant.organization_id = activity_property.organization_id
     and target_grant.scope_type = 'property'
     and target_grant.property_id = activity_property.property_id
  ),
  scoped_invitation_target_properties as materialized (
    select activity_property.organization_id, invitation.id::text as target_id,
           activity_property.property_id
    from activity_properties activity_property
    join public.organization_invitations invitation
      on invitation.organization_id = activity_property.organization_id
     and invitation.scope_type = 'organization'

    union all

    select activity_property.organization_id, invitation.id::text,
           activity_property.property_id
    from activity_properties activity_property
    join actor_portfolio_properties assignment
      on assignment.organization_id = activity_property.organization_id
     and assignment.property_id = activity_property.property_id
    join public.organization_invitations invitation
      on invitation.organization_id = assignment.organization_id
     and invitation.scope_type = 'portfolio'
     and invitation.portfolio_id = assignment.portfolio_id

    union all

    select activity_property.organization_id, invitation.id::text,
           activity_property.property_id
    from activity_properties activity_property
    join public.organization_invitations invitation
      on invitation.organization_id = activity_property.organization_id
     and invitation.scope_type = 'property'
     and invitation.property_id = activity_property.property_id
  ),
  scoped_request_target_properties as materialized (
    select activity_property.organization_id, request_row.id::text as target_id,
           activity_property.property_id
    from activity_properties activity_property
    join public.organization_access_requests request_row
      on request_row.organization_id = activity_property.organization_id
     and request_row.scope_type = 'organization'

    union all

    select activity_property.organization_id, request_row.id::text,
           activity_property.property_id
    from activity_properties activity_property
    join actor_portfolio_properties assignment
      on assignment.organization_id = activity_property.organization_id
     and assignment.property_id = activity_property.property_id
    join public.organization_access_requests request_row
      on request_row.organization_id = assignment.organization_id
     and request_row.scope_type = 'portfolio'
     and request_row.portfolio_id = assignment.portfolio_id

    union all

    select activity_property.organization_id, request_row.id::text,
           activity_property.property_id
    from activity_properties activity_property
    join public.organization_access_requests request_row
      on request_row.organization_id = activity_property.organization_id
     and request_row.scope_type = 'property'
     and request_row.property_id = activity_property.property_id
  ),
  scoped_portfolio_target_properties as materialized (
    select activity_property.organization_id,
           assignment.portfolio_id::text as portfolio_id,
           assignment.id::text as assignment_id,
           activity_property.property_id
    from activity_properties activity_property
    join public.portfolio_properties assignment
      on assignment.organization_id = activity_property.organization_id
     and assignment.property_id = activity_property.property_id
  ),
  allowed_target_properties as materialized (
    select relationship.organization_id,
           'organization_property_relationships'::text as target_type,
           relationship.target_id, relationship.property_id
    from scoped_relationship_target_properties relationship

    union all

    select grant_target.organization_id, 'organization_access_grants',
           grant_target.grant_id, grant_target.property_id
    from scoped_grant_target_properties grant_target

    union all

    select grant_target.organization_id, 'organization_memberships',
           grant_target.membership_id, grant_target.property_id
    from scoped_grant_target_properties grant_target

    union all

    select invitation.organization_id, 'organization_invitations',
           invitation.target_id, invitation.property_id
    from scoped_invitation_target_properties invitation

    union all

    select request_row.organization_id, 'organization_access_requests',
           request_row.target_id, request_row.property_id
    from scoped_request_target_properties request_row

    union all

    select portfolio.organization_id, 'portfolios',
           portfolio.portfolio_id, portfolio.property_id
    from scoped_portfolio_target_properties portfolio

    union all

    select portfolio.organization_id, 'portfolio_properties',
           portfolio.assignment_id, portfolio.property_id
    from scoped_portfolio_target_properties portfolio
  ),
  allowed_scoped_targets as materialized (
    select target.organization_id, target.target_type, target.target_id,
           array_agg(distinct target.property_id order by target.property_id)
             as authorized_property_ids
    from allowed_target_properties target
    where target.target_id is not null
    group by target.organization_id, target.target_type, target.target_id
  ),
  activity_organizations as materialized (
    select distinct grant_row.organization_id
    from activity_grants grant_row
  ),
  candidate_events as materialized (
    select event_row.*
    from activity_organizations activity_organization
    join public.organization_access_events event_row
      on event_row.organization_id = activity_organization.organization_id
  ),
  event_page as materialized (
    select event_row.id, event_row.organization_id,
           event_row.actor_account_id, event_row.actor_kind,
           event_row.event_type, event_row.target_type,
           event_row.target_id, event_row.occurred_at,
           event_actor.display_name as actor_display_name,
           event_actor.role as actor_role,
           (full_scope.organization_id is not null) as full_organization_scope,
           case when full_scope.organization_id is not null
             then '{}'::uuid[]
             else scoped_target.authorized_property_ids
           end as authorized_property_ids
    from candidate_events event_row
    left join full_activity_organizations full_scope
      on full_scope.organization_id = event_row.organization_id
    left join allowed_scoped_targets scoped_target
      on scoped_target.organization_id = event_row.organization_id
     and scoped_target.target_type = event_row.target_type
     and scoped_target.target_id = event_row.target_id
    left join public.accounts event_actor
      on event_actor.id = event_row.actor_account_id
    where full_scope.organization_id is not null
       or scoped_target.target_id is not null
    order by event_row.occurred_at desc, event_row.id desc
    limit (select row_limit from feed_limit)
  )
  select jsonb_build_object(
    'invitations', coalesce((
      select jsonb_agg(to_jsonb(invitation) order by invitation.created_at desc,
                       invitation.id desc)
      from invitation_page invitation
    ), '[]'::jsonb),
    'requests', coalesce((
      select jsonb_agg(to_jsonb(request_row) - 'priority'
                       order by request_row.priority,
                                request_row.requested_at desc,
                                request_row.id desc)
      from request_page request_row
    ), '[]'::jsonb),
    'activity', coalesce((
      select jsonb_agg(to_jsonb(event_row) order by event_row.occurred_at desc,
                       event_row.id desc)
      from event_page event_row
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.staxis_company_access_feed(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.staxis_company_access_feed(uuid, integer)
  to service_role;

-- ─── Service-role-only permissions / RLS ──────────────────────────────────

alter table public.organizations enable row level security;
alter table public.organization_property_relationships enable row level security;
alter table public.portfolios enable row level security;
alter table public.portfolio_properties enable row level security;
alter table public.organization_memberships enable row level security;
alter table public.account_property_staff_links enable row level security;
alter table public.organization_access_grants enable row level security;
alter table public.organization_invitations enable row level security;
alter table public.organization_access_requests enable row level security;
alter table public.staxis_support_sessions enable row level security;
alter table public.organization_access_events enable row level security;
alter table public.organization_access_epochs enable row level security;

revoke all on public.organizations from public, anon, authenticated;
revoke all on public.organization_property_relationships from public, anon, authenticated;
revoke all on public.portfolios from public, anon, authenticated;
revoke all on public.portfolio_properties from public, anon, authenticated;
revoke all on public.organization_memberships from public, anon, authenticated;
revoke all on public.account_property_staff_links from public, anon, authenticated;
revoke all on public.organization_access_grants from public, anon, authenticated;
revoke all on public.organization_invitations from public, anon, authenticated;
revoke all on public.organization_access_requests from public, anon, authenticated;
revoke all on public.staxis_support_sessions from public, anon, authenticated;
revoke all on public.organization_access_events from public, anon, authenticated;
revoke all on public.organization_access_epochs from public, anon, authenticated;
revoke all on public.organization_effective_property_access from public, anon, authenticated;

revoke all on public.organizations from service_role;
revoke all on public.organization_property_relationships from service_role;
revoke all on public.portfolios from service_role;
revoke all on public.portfolio_properties from service_role;
revoke all on public.organization_memberships from service_role;
revoke all on public.account_property_staff_links from service_role;
revoke all on public.organization_access_grants from service_role;
revoke all on public.organization_invitations from service_role;
revoke all on public.organization_access_requests from service_role;
revoke all on public.staxis_support_sessions from service_role;
revoke all on public.organization_access_events from service_role;
revoke all on public.organization_access_epochs from service_role;

grant select on public.organizations to service_role;
grant select on public.organization_property_relationships to service_role;
grant select on public.portfolios to service_role;
grant select on public.portfolio_properties to service_role;
grant select on public.organization_memberships to service_role;
grant select on public.account_property_staff_links to service_role;
grant select on public.organization_access_grants to service_role;
grant select on public.organization_invitations to service_role;
grant select on public.organization_access_requests to service_role;
grant select on public.staxis_support_sessions to service_role;
grant select on public.organization_access_events to service_role;
grant select on public.organization_access_epochs to service_role;
grant select on public.organization_effective_property_access to service_role;

drop policy if exists organizations_deny_browser on public.organizations;
create policy organizations_deny_browser on public.organizations
  for all to anon, authenticated using (false) with check (false);
drop policy if exists organization_property_relationships_deny_browser on public.organization_property_relationships;
create policy organization_property_relationships_deny_browser on public.organization_property_relationships
  for all to anon, authenticated using (false) with check (false);
drop policy if exists portfolios_deny_browser on public.portfolios;
create policy portfolios_deny_browser on public.portfolios
  for all to anon, authenticated using (false) with check (false);
drop policy if exists portfolio_properties_deny_browser on public.portfolio_properties;
create policy portfolio_properties_deny_browser on public.portfolio_properties
  for all to anon, authenticated using (false) with check (false);
drop policy if exists organization_memberships_deny_browser on public.organization_memberships;
create policy organization_memberships_deny_browser on public.organization_memberships
  for all to anon, authenticated using (false) with check (false);
drop policy if exists account_property_staff_links_deny_browser on public.account_property_staff_links;
create policy account_property_staff_links_deny_browser on public.account_property_staff_links
  for all to anon, authenticated using (false) with check (false);
drop policy if exists organization_access_grants_deny_browser on public.organization_access_grants;
create policy organization_access_grants_deny_browser on public.organization_access_grants
  for all to anon, authenticated using (false) with check (false);
drop policy if exists organization_invitations_deny_browser on public.organization_invitations;
create policy organization_invitations_deny_browser on public.organization_invitations
  for all to anon, authenticated using (false) with check (false);
drop policy if exists organization_access_requests_deny_browser on public.organization_access_requests;
create policy organization_access_requests_deny_browser on public.organization_access_requests
  for all to anon, authenticated using (false) with check (false);
drop policy if exists staxis_support_sessions_deny_browser on public.staxis_support_sessions;
create policy staxis_support_sessions_deny_browser on public.staxis_support_sessions
  for all to anon, authenticated using (false) with check (false);
drop policy if exists organization_access_events_deny_browser on public.organization_access_events;
create policy organization_access_events_deny_browser on public.organization_access_events
  for all to anon, authenticated using (false) with check (false);
drop policy if exists organization_access_epochs_deny_browser on public.organization_access_epochs;
create policy organization_access_epochs_deny_browser on public.organization_access_epochs
  for all to anon, authenticated using (false) with check (false);

-- ─── Conservative legacy backfill ──────────────────────────────────────────

-- Reuse the same idempotent path that protects post-migration inserts. Passing
-- a null actor deliberately records these migration-time writes as system work.
select public._staxis_reconcile_legacy_organization_access(null, null);

-- If corrupt legacy data points two accounts at one staff row, record each
-- skipped duplicate without making reruns append the same event repeatedly.

insert into public.organization_access_events (
  actor_kind, event_type, target_type, target_id, metadata
)
select
  'system', 'account_property_staff_links.backfill_conflict',
  'staff', ranked.staff_id::text,
  jsonb_build_object(
    'skipped_account_id', ranked.account_id,
    'reason', 'multiple legacy accounts referenced the same accounts.staff_id'
  )
from (
  select a.id as account_id, s.id as staff_id,
         row_number() over (partition by s.id order by a.created_at, a.id) as staff_rank
  from public.accounts a
  join public.staff s on s.id = a.staff_id
  where a.staff_id is not null
) ranked
where ranked.staff_rank > 1
  and not exists (
    select 1 from public.organization_access_events existing
    where existing.event_type = 'account_property_staff_links.backfill_conflict'
      and existing.target_type = 'staff'
      and existing.target_id = ranked.staff_id::text
      and existing.metadata->>'skipped_account_id' = ranked.account_id::text
  );

-- ─── Company Hub lifecycle mutations ───────────────────────────────────────

create or replace function public.staxis_cancel_organization_invitation(
  p_actor_account_id uuid,
  p_invitation_id uuid,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invitation public.organization_invitations%rowtype;
begin
  if char_length(btrim(coalesce(p_reason, ''))) not between 8 and 500 then
    raise exception 'invitation cancellation reason must be between 8 and 500 characters'
      using errcode = '22023';
  end if;

  select invitation.organization_id into v_invitation.organization_id
  from public.organization_invitations invitation
  where invitation.id = p_invitation_id;
  if not found then
    raise exception 'organization invitation not found' using errcode = 'P0002';
  end if;

  perform public._staxis_lock_organization(v_invitation.organization_id);
  select * into v_invitation
  from public.organization_invitations invitation
  where invitation.id = p_invitation_id
  for update;
  if not found then
    raise exception 'organization invitation not found' using errcode = 'P0002';
  end if;

  if not public._staxis_can_delegate_organization_access(
    p_actor_account_id,
    v_invitation.organization_id,
    v_invitation.access_profile,
    v_invitation.scope_type,
    v_invitation.portfolio_id,
    v_invitation.property_id
  ) then
    raise exception 'actor cannot cancel this invitation'
      using errcode = '42501';
  end if;
  if v_invitation.status = 'revoked' then
    return false;
  end if;
  if v_invitation.status <> 'pending' then
    raise exception 'only a pending invitation can be cancelled'
      using errcode = '23514';
  end if;

  perform set_config('staxis.actor_account_id', p_actor_account_id::text, true);
  update public.organization_invitations
     set status = 'revoked',
         revoked_at = clock_timestamp(),
         revoked_by_account_id = p_actor_account_id
   where id = p_invitation_id;

  insert into public.organization_access_events (
    organization_id, actor_account_id, actor_kind, event_type,
    target_type, target_id, metadata
  ) values (
    v_invitation.organization_id, p_actor_account_id, 'account',
    'organization_invitation.cancelled', 'organization_invitations',
    p_invitation_id::text,
    jsonb_build_object('reason', btrim(p_reason))
  );
  return true;
end;
$$;

revoke all on function public.staxis_cancel_organization_invitation(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.staxis_cancel_organization_invitation(uuid, uuid, text)
  to service_role;

create or replace function public.staxis_change_organization_membership_status(
  p_actor_account_id uuid,
  p_membership_id uuid,
  p_action text,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_membership public.organization_memberships%rowtype;
  v_actor_is_owner boolean := false;
  v_actor_is_admin boolean := false;
  v_target_is_leader boolean := false;
begin
  if p_action is null or p_action not in ('suspend', 'resume', 'remove') then
    raise exception 'membership action must be suspend, resume, or remove'
      using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) not between 8 and 500 then
    raise exception 'membership change reason must be between 8 and 500 characters'
      using errcode = '22023';
  end if;

  select membership.organization_id into v_membership.organization_id
  from public.organization_memberships membership
  where membership.id = p_membership_id;
  if not found then
    raise exception 'organization membership not found' using errcode = 'P0002';
  end if;

  perform public._staxis_lock_organization(v_membership.organization_id);
  select * into v_membership
  from public.organization_memberships membership
  where membership.id = p_membership_id
  for update;
  if not found then
    raise exception 'organization membership not found' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.organizations organization
    where organization.id = v_membership.organization_id
      and organization.organization_type = 'single_hotel'
  ) then
    raise exception 'legacy hotel memberships must be changed through hotel role settings'
      using errcode = '42501';
  end if;

  if v_membership.account_id = p_actor_account_id then
    raise exception 'members cannot change their own membership status'
      using errcode = '42501';
  end if;

  select
    coalesce(bool_or(actor_grant.access_profile = 'organization_owner'), false),
    coalesce(bool_or(actor_grant.access_profile = 'organization_admin'), false)
  into v_actor_is_owner, v_actor_is_admin
  from public.organization_memberships actor_membership
  join public.accounts actor_account
    on actor_account.id = actor_membership.account_id
   and actor_account.role <> 'admin'
   and actor_account.active
  join public.organizations organization
    on organization.id = actor_membership.organization_id
   and organization.status = 'active'
  join public.organization_access_grants actor_grant
    on actor_grant.membership_id = actor_membership.id
   and actor_grant.organization_id = actor_membership.organization_id
  where actor_membership.account_id = p_actor_account_id
    and actor_membership.organization_id = v_membership.organization_id
    and actor_membership.status = 'active'
    and actor_membership.starts_at <= now()
    and actor_membership.ended_at is null
    and actor_grant.status = 'active'
    and actor_grant.starts_at <= now()
    and (actor_grant.expires_at is null or actor_grant.expires_at > now())
    and actor_grant.scope_type = 'organization'
    and actor_grant.access_profile in ('organization_owner', 'organization_admin');

  if not v_actor_is_owner and not v_actor_is_admin then
    raise exception 'actor cannot manage organization memberships'
      using errcode = '42501';
  end if;

  select exists (
    select 1
    from public.organization_access_grants target_grant
    where target_grant.membership_id = v_membership.id
      and target_grant.organization_id = v_membership.organization_id
      and target_grant.status = 'active'
      and target_grant.starts_at <= now()
      and (target_grant.expires_at is null or target_grant.expires_at > now())
      and target_grant.scope_type = 'organization'
      and target_grant.access_profile in ('organization_owner', 'organization_admin')
  ) into v_target_is_leader;
  if not v_actor_is_owner and v_target_is_leader then
    raise exception 'organization administrators cannot manage owners or peer administrators'
      using errcode = '42501';
  end if;

  if p_action = 'suspend' and v_membership.status = 'suspended' then
    return false;
  end if;
  if p_action = 'resume' and v_membership.status = 'active' then
    return false;
  end if;
  if p_action = 'remove' and v_membership.status = 'revoked' then
    return false;
  end if;
  if p_action in ('suspend', 'resume') and v_membership.status = 'revoked' then
    raise exception 'a removed membership cannot be suspended or resumed'
      using errcode = '23514';
  end if;
  if p_action = 'resume' and not exists (
    select 1 from public.accounts target_account
    where target_account.id = v_membership.account_id
      and target_account.active
      and target_account.role <> 'admin'
  ) then
    raise exception 'an inactive customer account cannot be resumed'
      using errcode = '23514';
  end if;

  perform set_config('staxis.actor_account_id', p_actor_account_id::text, true);
  if p_action = 'suspend' then
    update public.organization_memberships
       set status = 'suspended',
           ended_at = null,
           updated_by_account_id = p_actor_account_id
     where id = p_membership_id;

    -- Pending requests from a suspended identity cannot be fulfilled: the
    -- grant RPC correctly requires an active membership. Cancel them now so
    -- reviewers never see an actionable item that will deterministically fail.
    update public.organization_access_requests
       set status = 'cancelled',
           reviewed_at = clock_timestamp(),
           reviewed_by_account_id = p_actor_account_id,
           review_note = 'Membership suspended: ' || btrim(p_reason)
     where membership_id = p_membership_id
       and organization_id = v_membership.organization_id
       and status = 'pending';
  elsif p_action = 'resume' then
    update public.organization_memberships
       set status = 'active',
           ended_at = null,
           updated_by_account_id = p_actor_account_id
     where id = p_membership_id;
  else
    update public.organization_access_grants
       set status = 'revoked',
           revoked_at = clock_timestamp(),
           revoked_by_account_id = p_actor_account_id,
           revocation_reason = left('Membership removed: ' || btrim(p_reason), 500),
           version = version + 1
     where membership_id = p_membership_id
       and organization_id = v_membership.organization_id
       and status = 'active';

    update public.organization_access_requests
       set status = 'cancelled',
           reviewed_at = clock_timestamp(),
           reviewed_by_account_id = p_actor_account_id,
           review_note = 'Membership removed: ' || btrim(p_reason)
     where membership_id = p_membership_id
       and organization_id = v_membership.organization_id
       and status = 'pending';

    update public.organization_memberships
       set status = 'revoked',
           ended_at = greatest(clock_timestamp(), starts_at + interval '1 microsecond'),
           updated_by_account_id = p_actor_account_id
     where id = p_membership_id;
  end if;

  insert into public.organization_access_events (
    organization_id, actor_account_id, actor_kind, event_type,
    target_type, target_id, metadata
  ) values (
    v_membership.organization_id, p_actor_account_id, 'account',
    'organization_membership.' || case
      when p_action = 'suspend' then 'suspended'
      when p_action = 'resume' then 'resumed'
      else 'removed'
    end,
    'organization_memberships', p_membership_id::text,
    jsonb_build_object('reason', btrim(p_reason))
  );
  return true;
end;
$$;

revoke all on function public.staxis_change_organization_membership_status(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.staxis_change_organization_membership_status(uuid, uuid, text, text)
  to service_role;

-- Atomically retire a hotel, its hidden organization anchor, and legacy
-- account links. Auth identities live in Supabase Auth and are deleted by the
-- route after this transaction commits; their IDs are returned for that
-- best-effort cleanup. If any account is still the final owner of a real
-- customer organization, the owner guard aborts this entire transaction so a
-- hotel can never disappear while account cleanup only half-finishes.
drop function if exists public.staxis_delete_property_and_legacy_accounts(uuid, uuid, boolean);
create or replace function public.staxis_delete_property_and_legacy_accounts(
  p_actor_account_id uuid,
  p_property_id uuid,
  p_confirmed_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_property_name text;
  v_onboarding_completed_at timestamptz;
  v_auth_user_ids uuid[] := '{}'::uuid[];
  v_accounts_removed integer := 0;
  v_accounts_pruned integer := 0;
begin
  -- Account updates acquire their row lock before the reconciliation trigger
  -- can lock referenced properties. A rare hotel deletion locks all existing
  -- account rows in stable order first, preserving that global order and also
  -- preventing an unscanned account from adding this hotel mid-delete. Inserts
  -- are covered by the trigger's post-lock missing-property validation.
  perform 1
  from public.accounts account
  order by account.id
  for update;

  if not exists (
    select 1 from public.accounts actor
    where actor.id = p_actor_account_id
      and actor.role = 'admin'
      and actor.active
  ) then
    raise exception 'only an active Staxis administrator may delete a hotel'
      using errcode = '42501';
  end if;

  select property.name, property.onboarding_completed_at
    into v_property_name, v_onboarding_completed_at
  from public.properties property
  where property.id = p_property_id
  for update;
  if not found then
    raise exception 'property not found' using errcode = 'P0002';
  end if;
  if nullif(btrim(p_confirmed_name), '') is not null
     and lower(btrim(p_confirmed_name)) <> lower(btrim(v_property_name)) then
    raise exception 'confirmed hotel name does not match the locked hotel name'
      using errcode = '23514';
  end if;
  if v_onboarding_completed_at is not null
     and nullif(btrim(p_confirmed_name), '') is null then
    raise exception 'hotel completed onboarding and requires explicit confirmation'
      using errcode = '23514';
  end if;

  select coalesce(array_agg(account.data_user_id order by account.id), '{}'::uuid[])
    into v_auth_user_ids
  from public.accounts account
  where account.role <> 'admin'
    and p_property_id = any(coalesce(account.property_access, '{}'::uuid[]))
    and cardinality(array_remove(coalesce(account.property_access, '{}'::uuid[]), p_property_id)) = 0
    and not exists (
      select 1
      from public.organization_memberships company_membership
      join public.organizations company_organization
        on company_organization.id = company_membership.organization_id
       and company_organization.organization_type <> 'single_hotel'
      where company_membership.account_id = account.id
        and company_membership.ended_at is null
    );

  perform set_config('staxis.actor_account_id', p_actor_account_id::text, true);
  -- BEFORE DELETE retires the hidden anchor; every later account mutation is
  -- still part of this transaction and rolls the property back on failure.
  delete from public.properties where id = p_property_id;

  update public.accounts account
     set property_access = array_remove(account.property_access, p_property_id)
   where account.role <> 'admin'
     and p_property_id = any(coalesce(account.property_access, '{}'::uuid[]))
     and (
       cardinality(array_remove(coalesce(account.property_access, '{}'::uuid[]), p_property_id)) > 0
       or exists (
         select 1
         from public.organization_memberships company_membership
         join public.organizations company_organization
           on company_organization.id = company_membership.organization_id
          and company_organization.organization_type <> 'single_hotel'
         where company_membership.account_id = account.id
           and company_membership.ended_at is null
       )
     );
  get diagnostics v_accounts_pruned = row_count;

  delete from public.accounts account
   where account.role <> 'admin'
     and p_property_id = any(coalesce(account.property_access, '{}'::uuid[]))
     and cardinality(array_remove(coalesce(account.property_access, '{}'::uuid[]), p_property_id)) = 0
     and not exists (
       select 1
       from public.organization_memberships company_membership
       join public.organizations company_organization
         on company_organization.id = company_membership.organization_id
        and company_organization.organization_type <> 'single_hotel'
       where company_membership.account_id = account.id
         and company_membership.ended_at is null
     );
  get diagnostics v_accounts_removed = row_count;

  return jsonb_build_object(
    'name', v_property_name,
    'authUserIds', to_jsonb(v_auth_user_ids),
    'accountsRemoved', v_accounts_removed,
    'accountsPruned', v_accounts_pruned
  );
end;
$$;

revoke all on function public.staxis_delete_property_and_legacy_accounts(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.staxis_delete_property_and_legacy_accounts(uuid, uuid, text)
  to service_role;

-- Migration 0243 removed these browser roles by name but left PostgreSQL's
-- default PUBLIC execute privilege intact. Invitation token claims use this
-- helper as a server-only capability, so close the inherited privilege too.
revoke all on function public.claim_idempotency_key(text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_idempotency_key(text, text, uuid)
  to service_role;

insert into public.applied_migrations (version, description)
values (
  '0325',
  'Organization + portfolio + multi-scope access foundation: normalized tenant relationships, serialized memberships/grants/invitations/requests, multi-property staff identity, reserved support-session ledger, immutable transactional audit, Company Hub authorization, and continuous idempotent legacy reconciliation. Hotel-operation authorization remains explicitly separate.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
