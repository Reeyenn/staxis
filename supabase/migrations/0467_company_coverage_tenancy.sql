-- 0467_company_coverage_tenancy.sql
--
-- A fast-follow on 0464, which introduced the company hat that names its
-- hotels. Three faults in that shape, found by verifying the shipped code
-- against production rather than against its own tests.
--
-- ─── 1. THE GUARDED WRITES TRUSTED THE LIST ────────────────────────────────
-- `_staxis_can_control_account_invite` and `_staxis_can_set_membership_hat`
-- both validated `covered_property_ids` ONLY under
-- `if p_membership_scope = 'property'`, and each handed the hat gate
-- `case when p_membership_scope = 'property' then <list> else null end`. The
-- company+list shape therefore reached the write with its list unexamined:
-- calling the guarded RPC directly with one real hotel plus one uuid that is
-- not a property at all returned ok and STORED the bogus id. Reproduced on
-- production; the row was revoked and prod is clean.
--
-- The app route validated upstream, so this was never reachable through the
-- UI, and read-time resolution intersects with operated hotels so the stored
-- id was inert. Neither of those is the point: the RPC is the independent last
-- line, a stored cross-tenant reference violates the invariant, and something
-- will eventually trust it.
--
-- Every coverage list is now checked by ONE function, for BOTH shapes, and a
-- bad entry is REJECTED rather than filtered out — silently narrowing somebody
-- else's promise is its own bug.
--
-- ─── 2. AN EXPLICIT-LIST INVITATION COULD NOT BE ACCEPTED ──────────────────
-- `staxis_accept_account_invite` predates the list shape: it set
-- `v_coverage := '{}'` for company scope, discarding the promised hotels. The
-- validity check then saw a non-null `covered_property_ids` with zero coverage
-- and raised "invitation topology or promised job is no longer valid" — so the
-- headline feature of 0464 could be offered, emailed and claimed, but never
-- accepted. Had it got past, the row it stored carried NULL coverage, which is
-- the all-hotels-including-future shape: a 3-hotel Owner silently upgraded to
-- all 20.
--
-- ACCEPTANCE SEMANTICS, decided and documented: accept re-verifies and
-- REJECTS if any promised hotel has left the company since the invitation was
-- written. That is not a new rule; it is exactly what the property shape has
-- always done at this line ("one or more invited hotels changed company"), and
-- honouring a written promise exactly or not at all is the honest reading of a
-- named list. Shrinkage AFTER acceptance is still handled the way 0464 chose
-- for hats: live read-time intersection, no revocation.
--
-- ─── 3. A SUBSET HAT READ AS THE WHOLE COMPANY ─────────────────────────────
-- `_staxis_company_structure_actor_rights` counted any company-scope
-- owner/regional_manager as `whole_company_view` and `manages_all_portfolios`.
-- Both are claims about the WHOLE company, which a hat naming three hotels
-- does not satisfy. `can_manage_portfolios` is deliberately left alone: it
-- gates whether this person may manage portfolios at all, not how many.
--
-- The matching TS fault (`resolveHatCoverage` returning every operated hotel
-- for any company hat) is fixed in the same change, outside this file.
--
-- Nothing here grants access that did not exist. Every change removes reach or
-- refuses a write.

begin;

-- ── The one place a coverage list is judged ────────────────────────────────
--
-- True only for a list that is structurally sound AND wholly inside the
-- organization: no NULL entries, no duplicates, at least one hotel, and every
-- id an active operated property of THIS company under current topology. The
-- "exactly one live governing relationship" test is the same one the rest of
-- the spine uses, so a hotel mid-transfer fails here too.
create or replace function public._staxis_company_coverage_list_ok(
  p_organization_id uuid,
  p_property_ids uuid[]
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_organization_id is not null
     and p_property_ids is not null
     and cardinality(p_property_ids) between 1 and 5000
     and array_position(p_property_ids, null) is null
     and (select count(*) from unnest(p_property_ids) pid)
       = (select count(distinct pid) from unnest(p_property_ids) pid)
     and not exists (
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
     );
$$;
revoke all on function public._staxis_company_coverage_list_ok(uuid, uuid[])
  from public, anon, authenticated, service_role;

-- ── The two gates, wrapped rather than rewritten ───────────────────────────
--
-- Both keep their 0464 bodies verbatim under a _v0464 name and gain a coverage
-- check in front. The established pattern in this codebase (see
-- _staxis_company_access_can_delegate_v0381 and
-- _staxis_create_account_invite_guarded_0395_impl) and the safest one: the
-- logic that was reviewed and shipped is not retyped, and the new rule is one
-- readable statement instead of a diff buried in 240 lines.

alter function public._staxis_can_set_membership_hat(uuid, uuid, text, text, uuid[])
  rename to _staxis_can_set_membership_hat_v0464;

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
begin
  -- The COMPANY shape only. The property shape was already validated inside the
  -- 0464 body — nulls, duplicates and tenancy alike — and its caller raises a
  -- specific "hotel % is not governed by this company" that callers and tests
  -- read. Re-checking it here would preempt that message with a generic one and
  -- tell somebody less about what they got wrong. The gap was company-only.
  if p_membership_scope = 'company'
     and p_property_ids is not null
     and not public._staxis_company_coverage_list_ok(p_organization_id, p_property_ids)
  then
    return false;
  end if;
  return public._staxis_can_set_membership_hat_v0464(
    p_actor_account_id, p_organization_id, p_membership_scope,
    p_staxis_role, p_property_ids
  );
end;
$$;
revoke all on function public._staxis_can_set_membership_hat(uuid, uuid, text, text, uuid[])
  from public, anon, authenticated, service_role;

alter function public._staxis_can_control_account_invite(uuid, uuid, uuid, text, text, uuid[])
  rename to _staxis_can_control_account_invite_v0464;

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
begin
  -- The company+list shape never reached the inner gate with its list intact,
  -- because the inner body passes NULL for company scope. Checking here is
  -- what closes that path for both create and grant.
  if p_covered_property_ids is not null
     and not public._staxis_company_coverage_list_ok(
       p_organization_id, p_covered_property_ids
     )
  then
    return false;
  end if;
  return public._staxis_can_control_account_invite_v0464(
    p_actor_account_id, p_hotel_id, p_organization_id,
    p_membership_scope, p_role, p_covered_property_ids
  );
end;
$$;
revoke all on function public._staxis_can_control_account_invite(uuid, uuid, uuid, text, text, uuid[])
  from public, anon, authenticated, service_role;

-- ── An empty list is a list that names nothing, and must be refused ────────
--
-- 0464 wrote `array_length(covered_property_ids, 1) >= 1`. For '{}' that is
-- `NULL >= 1` -> NULL, and a CHECK treats NULL as satisfied, so the empty array
-- sailed through both constraints. `cardinality('{}')` is 0, which is really
-- false. Proven by a direct UPDATE against the shipped migration, bypassing
-- every RPC — which is the only way to test what a constraint actually holds.
--
-- This matters because an empty list is not a harmless nothing: the jsonb path
-- in staxis_set_membership_hat turns [] into NULL, and NULL is the
-- all-hotels-including-future shape. An empty list was therefore a silent
-- upgrade to the whole company, through the supported door.

alter table public.organization_memberships
  drop constraint if exists organization_memberships_hat_shape_check;
alter table public.organization_memberships
  add constraint organization_memberships_hat_shape_check check (
    (membership_scope is null and staxis_role is null and covered_property_ids is null)
    or (membership_scope = 'company'
        and staxis_role in ('owner', 'regional_manager')
        and (covered_property_ids is null
          or (cardinality(covered_property_ids) >= 1
            and array_position(covered_property_ids, null) is null)))
    or (membership_scope = 'property'
        and staxis_role in ('general_manager', 'front_desk', 'housekeeping', 'maintenance')
        and covered_property_ids is not null
        and cardinality(covered_property_ids) >= 1
        and array_position(covered_property_ids, null) is null)
  );

alter table public.account_invites
  drop constraint if exists account_invites_hat_shape_check;
alter table public.account_invites
  add constraint account_invites_hat_shape_check check (
    (membership_scope is null and organization_id is null and covered_property_ids is null)
    or (membership_scope = 'company'
        and organization_id is not null
        and role in ('owner', 'regional_manager')
        and (covered_property_ids is null
          or (cardinality(covered_property_ids) >= 1
            and array_position(covered_property_ids, null) is null)))
    or (membership_scope = 'property'
        and organization_id is not null
        and covered_property_ids is not null
        and cardinality(covered_property_ids) >= 1
        and array_position(covered_property_ids, null) is null
        and role in ('general_manager', 'front_desk', 'housekeeping', 'maintenance'))
  );

-- ── The supported door refuses an explicit empty list too ──────────────────
--
-- `staxis_set_membership_hat` takes its hotels as jsonb and builds the array
-- with array_agg over jsonb_array_elements, which yields NULL for `[]` — the
-- all-hotels shape. A caller sending an empty selection therefore asked for
-- "no hotels" and was handed the whole company. The constraint above cannot
-- see this, because by the time it looks the value is already NULL.

alter function public.staxis_set_membership_hat(uuid, uuid, uuid, text, text, jsonb, text)
  rename to staxis_set_membership_hat_v0464;

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
begin
  -- An explicitly empty selection is a refusal, never a promotion. NULL still
  -- travels through untouched: that is the deliberate all-hotels shape.
  if p_property_ids is not null
     and jsonb_typeof(p_property_ids) = 'array'
     and jsonb_array_length(p_property_ids) = 0 then
    raise exception 'a hat must name at least one hotel'
      using errcode = '23514';
  end if;
  return public.staxis_set_membership_hat_v0464(
    p_actor_account_id, p_organization_id, p_account_id,
    p_membership_scope, p_staxis_role, p_property_ids, p_job_title
  );
end;
$$;
revoke all on function public.staxis_set_membership_hat(uuid, uuid, uuid, text, text, jsonb, text)
  from public, anon, authenticated, service_role;

-- ── Acceptance: carry the promised list, and honour it exactly ─────────────

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

  -- 0467: the company+list shape is carried here too. 0464 hard-coded this to
  -- '{}' for company scope, which discarded the promised hotel list: the
  -- validity check below then saw a non-null list with zero coverage and every
  -- explicit-list company invitation failed acceptance outright. Carrying the
  -- real list also means the lock loop locks the promised hotels and the
  -- "changed company" re-check below actually covers them.
  v_coverage := coalesce(v_invite.covered_property_ids, '{}'::uuid[]);
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
      -- 0467: NULL only when the invitation itself promised no list, which is
      -- the all-hotels-including-future shape. An explicit list is stored as
      -- promised; storing NULL for it silently upgraded a 3-hotel Owner to the
      -- whole company.
      case when v_invite.covered_property_ids is null then null else to_jsonb(v_coverage) end,
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


-- ── Structure rights: a named list is not the whole company ───────────────

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
          -- 0467: only an all-hotels-including-future hat. A company hat with
          -- an explicit list does not see the WHOLE company by definition.
          and membership.covered_property_ids is null
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

comment on function public._staxis_company_coverage_list_ok(uuid, uuid[]) is
  'One judge for every covered_property_ids list, for both the property shape and the 0464 company+list shape: rejects NULLs, duplicates, empty lists, and any hotel that is not an active operated property of this organization under current topology. Rejects rather than filters, so a bad entry fails the write instead of silently narrowing somebody''s promise.';

insert into public.applied_migrations (version, description)
values ('0467', 'Company coverage tenancy: guarded writes validate covered_property_ids for both shapes, explicit-list invitations can be accepted, and a subset hat no longer reads as the whole company.')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
