-- 0468_company_coverage_never_empty.sql
--
-- NOT APPLIED BY THIS FILE. Apply manually, then `notify pgrst`.
--
-- ─── WHAT THIS CLOSES ──────────────────────────────────────────────────────
--
-- 0467 wrote a cardinality-based `hat_shape_check`, watched it turn the Stage C
-- contract suite red, and BACKED IT OUT with the note that some canonical write
-- path still emits `'{}'` where NULL was meant and had not been identified.
-- This migration identifies it, fixes it, and installs the constraint.
--
-- THE BUG IS ONE POSTGRES DETAIL: `array(subquery)` over zero rows returns
-- `'{}'`, not NULL. Two functions prune a hotel out of a property hat's
-- coverage with exactly that construct, so a hat whose only hotel was the one
-- being removed is rewritten to an empty array.
--
--   1. `staxis_remove_property_access_authoritative` (0426:6416).
--      Reproduced: an instrumented trigger installed where the CHECK would sit
--      raised inside the Stage C suite with the full PL/pgSQL stack —
--      `staxis_remove_property_access_authoritative … line 104 at SQL
--      statement`, target Frank's `property/front_desk` hat covering exactly
--      Beaumont. The very next block revokes such rows using
--      `cardinality(...) = 0`, so the authors knew about the empty case,
--      handled the AUTHORITY, and left the SHAPE wrong.
--
--   2. `staxis_delete_property_and_legacy_accounts` (0426:6597).
--      The same construct with no follow-up revoke at all. Reproduced
--      standalone: deleting Beaumont leaves TWO memberships `active`,
--      `ended_at is null`, `covered_property_ids = '{}'`. Product-reachable
--      through the admin hotel-delete route and the create-rollback path. No
--      test suite exercises it, which is why 0467 saw only the first one.
--
-- Both are the PROPERTY shape only, so no company hat was ever emptied and
-- nobody was handed a company job covering nothing. An empty property list
-- grants nothing (every resolver unnests it and gets no rows), so this was
-- never an access leak in either direction. What it was: a live row in a shape
-- the constraint is meant to forbid, and the reason the constraint could not be
-- installed.
--
-- ─── THE FIX, AND WHY NOT THE OBVIOUS ONE ──────────────────────────────────
--
-- "Write NULL instead of '{}'" does not work and was tested rather than
-- assumed: NULL coverage on a property hat satisfies none of the three CHECK
-- branches and Postgres refuses the row. NULL is the company shape and means
-- ALL HOTELS INCLUDING FUTURE ONES, which is the opposite of what an emptied
-- hat means.
--
-- So each site becomes two statements, split on whether anything survives the
-- prune:
--   something left  prune it out, exactly as before.
--   nothing left    END the hat and LEAVE its list alone. An ended hat is
--                   excluded from every resolver, so the authority outcome is
--                   identical to today, and the row keeps the record of which
--                   hotel the job was at instead of erasing it.
--
-- Nothing here grants access that did not exist. One visible consequence, named
-- rather than hidden: the Company Hub's access HISTORY panel resolves a
-- membership's coverage regardless of status, so a person detached from a hotel
-- now shows "used to have access here" where the emptied list previously showed
-- nothing. That panel is scoped to hotels the viewer already covers.
--
-- ─── THEN THE CONSTRAINT 0467 COULD NOT INSTALL ────────────────────────────
--
-- 0464 wrote `array_length(covered_property_ids, 1) >= 1`. For `'{}'` that is
-- `NULL >= 1` -> NULL, and a CHECK counts NULL as satisfied. `cardinality` is 0
-- and really refuses it. Production was verified clean before writing this:
-- 22 rows in `organization_memberships`, 18 with NULL coverage, ZERO empty; and
-- zero empty rows in `account_invites`.

begin;


create or replace function public.staxis_remove_property_access_authoritative(
  p_actor_account_id uuid,
  p_actor_auth_user_id uuid,
  p_actor_email text,
  p_account_id uuid,
  p_hotel_id uuid,
  p_expected_role text,
  p_expected_authority_version bigint,
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
  v_access jsonb;
  v_target_ids uuid[] := '{}'::uuid[];
  v_remaining integer := 0;
  v_actor_role text;
  v_authority_changed boolean := false;
begin
  if p_actor_account_id is null or p_actor_auth_user_id is null
     or p_account_id is null or p_hotel_id is null
     or p_expected_role is null or p_expected_updated_at is null then
    return jsonb_build_object('status', 'invalid');
  end if;
  if p_actor_account_id = p_account_id then
    return jsonb_build_object('status', 'forbidden', 'reason', 'self');
  end if;

  perform 1 from public.accounts account
   where account.id = any(array[p_actor_account_id, p_account_id])
   order by account.id for update;
  perform 1 from public.account_authorization_state state
   where state.account_id = any(array[p_actor_account_id, p_account_id])
   order by state.account_id for update;
  select * into v_actor from public.accounts where id = p_actor_account_id;
  select * into v_target from public.accounts where id = p_account_id;
  select * into v_actor_state from public.account_authorization_state where account_id = p_actor_account_id;
  select * into v_target_state from public.account_authorization_state where account_id = p_account_id;
  if v_actor.id is null or v_target.id is null
     or v_actor_state.account_id is null or v_target_state.account_id is null then
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
    perform 1 from public.properties property where property.id = p_hotel_id for update nowait;
    if not found then return jsonb_build_object('status', 'not_found', 'reason', 'hotel_scope'); end if;
    perform pg_advisory_xact_lock(hashtextextended(p_hotel_id::text, 0));
  exception
    when lock_not_available or deadlock_detected then
      return jsonb_build_object('status', 'retry');
  end;
  if v_actor.active is not true or v_actor.data_user_id is distinct from p_actor_auth_user_id then
    return jsonb_build_object('status', 'forbidden', 'reason', 'actor');
  end if;
  if v_target.active is not true or v_target.role in ('admin', 'owner') then
    return jsonb_build_object('status', 'forbidden', 'reason', 'target');
  end if;
  if public._staxis_account_is_live_organization_owner(v_target.id) then
    return jsonb_build_object('status', 'forbidden', 'reason', 'organization_owner');
  end if;
  if v_target.role is distinct from p_expected_role
     or v_target.updated_at is distinct from p_expected_updated_at
     or (p_expected_authority_version is not null
         and v_target_state.authority_version is distinct from p_expected_authority_version)
  then
    return jsonb_build_object('status', 'conflict');
  end if;
  if v_target_state.authority_mode <> 'normalized' then
    return jsonb_build_object('status', 'forbidden', 'reason', 'final_authority_not_normalized');
  end if;
  if not public._staxis_account_can_manage_users_at_property(p_actor_account_id, p_hotel_id) then
    return jsonb_build_object('status', 'forbidden', 'reason', 'manage_users');
  end if;
  if v_actor.role <> 'admin' and v_target.role = 'general_manager' then
    v_actor_role := public._staxis_account_operational_role_at_property(v_actor.id, p_hotel_id);
    if not public._staxis_account_has_company_manager_hierarchy_at_property(v_actor.id, p_hotel_id)
       and v_actor_role <> 'owner' then
      return jsonb_build_object('status', 'forbidden', 'reason', 'hierarchy');
    end if;
  end if;
  v_access := public.staxis_list_account_authorized_properties(p_account_id);
  if coalesce((v_access->>'ok')::boolean, false) is not true then
    return jsonb_build_object('status', 'forbidden', 'reason', 'authority_unavailable');
  end if;
  select coalesce(array_agg(value::text::uuid order by value::text), '{}'::uuid[])
    into v_target_ids
  from jsonb_array_elements_text(coalesce(v_access->'propertyIds', '[]'::jsonb)) value;
  if not (p_hotel_id = any(v_target_ids)) then
    return jsonb_build_object('status', 'not_attached');
  end if;

  -- Company/property memberships are canonical authority too, but do not
  -- materialize an account_property_authorization_bridges row.  Remove the
  -- detached hotel from every active property-scoped membership first, revoke
  -- any matching property grant, and retain the historical membership row.
  --
  -- 0468: TWO statements, split on whether anything is left after the prune.
  -- 0426 wrote one, using `array(subquery)`, which returns '{}' rather than
  -- NULL over zero rows. A hat covering exactly this hotel was therefore
  -- rewritten to '{}' and only then revoked by a follow-up — an ended hat that
  -- no longer records which hotel it covered, in a shape neither hat branch of
  -- the CHECK is meant to admit. Ending the hat and LEAVING its list is the
  -- same authority outcome (an ended hat is excluded from every resolver) and
  -- keeps the history the row exists to hold.
  update public.organization_memberships membership
     set covered_property_ids = array(
           select distinct covered.property_id
           from unnest(coalesce(membership.covered_property_ids, '{}'::uuid[])) covered(property_id)
           where covered.property_id <> p_hotel_id
           order by covered.property_id
         ),
         updated_at = clock_timestamp()
   where membership.account_id = p_account_id
     and membership.membership_scope = 'property'
     and membership.status = 'active'
     and membership.ended_at is null
     and p_hotel_id = any(coalesce(membership.covered_property_ids, '{}'::uuid[]))
     -- Something OTHER than this hotel survives the prune. Asked as an
     -- existence test rather than `cardinality > 1` so a list that happens to
     -- name the same hotel twice still lands in the second statement.
     and exists (
       select 1
       from unnest(membership.covered_property_ids) covered(property_id)
       where covered.property_id <> p_hotel_id
     );
  if found then v_authority_changed := true; end if;

  -- This hotel was the hat's ONLY hotel: the hat is over.
  --
  -- `greatest(...)` rather than a bare `clock_timestamp()`: a hat whose
  -- `starts_at` is in the future would otherwise be given an `ended_at` BEFORE
  -- its start and `..._window_check` would abort the whole detach. 0426's
  -- revoke had the same exposure; it is closed rather than carried forward.
  update public.organization_memberships membership
     set status = 'revoked',
         ended_at = greatest(clock_timestamp(), membership.starts_at + interval '1 microsecond'),
         updated_at = clock_timestamp()
   where membership.account_id = p_account_id
     and membership.membership_scope = 'property'
     and membership.status = 'active'
     and membership.ended_at is null
     and p_hotel_id = any(coalesce(membership.covered_property_ids, '{}'::uuid[]))
     and not exists (
       select 1
       from unnest(membership.covered_property_ids) covered(property_id)
       where covered.property_id <> p_hotel_id
     );
  if found then v_authority_changed := true; end if;
  update public.organization_access_grants grant_row
     set status = 'revoked',
         revoked_at = clock_timestamp(),
         revoked_by_account_id = p_actor_account_id,
         revocation_reason = left(
           'Canonical hotel detach: ' || coalesce(nullif(btrim(p_request_id), ''), 'request'), 500
         ),
         version = grant_row.version + 1
    from public.organization_memberships membership
   where grant_row.membership_id = membership.id
     and membership.account_id = p_account_id
     and grant_row.property_id = p_hotel_id
     and grant_row.status = 'active';
  if found then
    v_authority_changed := true;
  end if;

  if not exists (
    select 1 from public.account_property_authorization_bridges bridge
    where bridge.account_id = p_account_id
      and bridge.property_id = p_hotel_id
      and bridge.status = 'active'
  ) then
    if not v_authority_changed then
      return jsonb_build_object('status', 'forbidden', 'reason', 'normalized_authority');
    end if;
  else
    update public.account_property_authorization_bridges bridge
       set status = 'retired', retired_at = clock_timestamp(),
           retirement_reason = left(
             'Canonical hotel detach: ' || coalesce(nullif(btrim(p_request_id), ''), 'request'), 500
           )
     where bridge.account_id = p_account_id
       and bridge.property_id = p_hotel_id
       and bridge.status = 'active';
    v_authority_changed := true;
  end if;
  perform public._staxis_refresh_account_authorization(p_account_id, 'Access Stage C canonical hotel detach');
  v_access := public.staxis_list_account_authorized_properties(p_account_id);
  v_remaining := jsonb_array_length(coalesce(v_access->'propertyIds', '[]'::jsonb));
  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, metadata
  ) values (
    p_actor_auth_user_id, nullif(btrim(p_actor_email), ''),
    'account.team_detach', 'account', p_account_id::text,
    jsonb_build_object(
      'hotel_id', p_hotel_id, 'remaining_hotels', v_remaining,
      'authority_mode', 'normalized', 'request_id', p_request_id
    )
  );
  return jsonb_build_object(
    'status', 'ok', 'remaining_hotels', v_remaining,
    'audit_written', true, 'authorityVersion', (v_access->>'authorityVersion')::bigint
  );
end;
$$;

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
  v_accounts_to_remove uuid[] := '{}'::uuid[];
  v_accounts_removed integer := 0;
  v_accounts_pruned integer := 0;
  v_account record;
  v_scope_ids uuid[];
  v_has_company_scope boolean;
begin
  perform 1 from public.accounts account order by account.id for update;

  if not exists (
    select 1 from public.accounts actor
    where actor.id = p_actor_account_id and actor.role = 'admin' and actor.active is true
  ) then
    raise exception 'only an active Staxis administrator may delete a hotel'
      using errcode = '42501';
  end if;

  select property.name, property.onboarding_completed_at
    into v_property_name, v_onboarding_completed_at
  from public.properties property
  where property.id = p_property_id
  for update;
  if not found then raise exception 'property not found' using errcode = 'P0002'; end if;
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

  for v_account in
    select account.id, account.role, account.data_user_id
    from public.accounts account
    where account.role <> 'admin'
    order by account.id
  loop
    v_scope_ids := public._staxis_structural_account_property_ids(v_account.id);
    if not (p_property_id = any(v_scope_ids)) then continue; end if;

    select exists (
      select 1
      from public.organization_memberships membership
      join public.organizations organization
        on organization.id = membership.organization_id
       and organization.organization_type <> 'single_hotel'
      where membership.account_id = v_account.id
        and membership.status = 'active'
        and membership.ended_at is null
    ) into v_has_company_scope;

    if cardinality(v_scope_ids) = 1 and not v_has_company_scope then
      if v_account.data_user_id is not null then
        v_auth_user_ids := v_auth_user_ids || v_account.data_user_id;
      end if;
      -- Capture independent accounts before the property/anchor is removed.
      -- The property delete below retires the hidden single-hotel organization
      -- first; deleting these accounts only after that cascade avoids asking
      -- the final-owner guard to permit an account-by-account teardown of a
      -- whole hotel organization.
      v_accounts_to_remove := v_accounts_to_remove || v_account.id;
    else
      update public.account_property_authorization_bridges bridge
         set status = 'retired',
             retired_at = clock_timestamp(),
             retirement_reason = left('Property deleted: ' || p_property_id::text, 500)
       where bridge.account_id = v_account.id
         and bridge.property_id = p_property_id
         and bridge.status = 'active';

      -- 0468: the same two-statement split as the detach path above, and the
      -- worse of the two sites — this one had NO follow-up revoke at all, so
      -- deleting a hotel left an ACTIVE property hat covering '{}'. It granted
      -- nothing (the property branch of every resolver unnests the list, and an
      -- empty list unnests to no rows), but it is a live row in a shape the
      -- constraint is meant to forbid, and it is what a cardinality CHECK would
      -- have hit in production the first time somebody deleted a hotel whose
      -- staff wore single-hotel hats.
      update public.organization_memberships membership
         set covered_property_ids = array(
           select distinct covered.property_id
           from unnest(coalesce(membership.covered_property_ids, '{}'::uuid[])) covered(property_id)
           where covered.property_id <> p_property_id
           order by covered.property_id
         ),
             updated_at = clock_timestamp()
       where membership.account_id = v_account.id
         and membership.membership_scope = 'property'
         and p_property_id = any(coalesce(membership.covered_property_ids, '{}'::uuid[]))
         and exists (
           select 1
           from unnest(membership.covered_property_ids) covered(property_id)
           where covered.property_id <> p_property_id
         );

      -- The hat named only the hotel being deleted. End it, keeping the list,
      -- which is now the only record of where that job was.
      --
      -- `status` and `ended_at` move TOGETHER or `..._revoked_shape_check`
      -- refuses the row: it asserts `(status = 'revoked') = (ended_at is not
      -- null)`. So status is set unconditionally rather than only for an active
      -- row — a SUSPENDED hat given an ended_at while it kept its own status
      -- would violate that check, and a suspended job whose only hotel no
      -- longer exists is over in exactly the way an active one is. An
      -- already-revoked row keeps the ended_at it was given.
      update public.organization_memberships membership
         set status = 'revoked',
             ended_at = coalesce(
               membership.ended_at,
               greatest(clock_timestamp(), membership.starts_at + interval '1 microsecond')
             ),
             updated_at = clock_timestamp()
       where membership.account_id = v_account.id
         and membership.membership_scope = 'property'
         and p_property_id = any(coalesce(membership.covered_property_ids, '{}'::uuid[]))
         and not exists (
           select 1
           from unnest(membership.covered_property_ids) covered(property_id)
           where covered.property_id <> p_property_id
         );
      v_accounts_pruned := v_accounts_pruned + 1;
    end if;
  end loop;

  perform set_config('staxis.actor_account_id', p_actor_account_id::text, true);
  delete from public.properties where id = p_property_id;

  delete from public.accounts account
   where account.id = any(v_accounts_to_remove);
  get diagnostics v_accounts_removed = row_count;

  return jsonb_build_object(
    'name', v_property_name,
    'authUserIds', to_jsonb(v_auth_user_ids),
    'accountsRemoved', v_accounts_removed,
    'accountsPruned', v_accounts_pruned,
    'canonical', true,
    'propertyRosterLineagePreserved', true
  );
end;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
--  PART TWO: a hat that names three hotels may not speak for twenty
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 0467 fixed `whole_company_view` and deliberately left two neighbours alone.
-- Both turn out to be live reach rather than presentation, so both are fixed
-- here, and one door that fails closed is opened to the shape it was always
-- meant to carry.

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
          -- 0468: the same rule 0467 applied to whole_company_view, for the
          -- same reason. "Manages ALL portfolios" is a claim about the whole
          -- company. Left unconditioned it was not cosmetic: it put EVERY
          -- portfolio of the company into manageable_portfolio_ids, and
          -- staxis_commit_company_portfolio_assignment gates on exactly that
          -- array. Reproduced end to end: an Owner covering one of two hotels
          -- moved her hotel into a portfolio belonging to a different
          -- ownership group, which is a portfolio manager over there gaining
          -- her hotel and her own group losing it.
          and membership.covered_property_ids is null
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

-- ── Delegation may not reach past the hats you actually wear ──────────────
--
-- `_staxis_company_access_can_delegate_v0381` answers "may this person hand
-- out this access profile at this scope". Its company-owner branch has no
-- coverage condition at all, and none was added by 0464: it asks only whether
-- an active company hat with staxis_role 'owner' exists. So an Owner named on
-- an explicit three-hotel list could grant somebody an ORGANIZATION-scope
-- organization_owner profile, and an organization-scope grant reaches every
-- hotel the company operates. Verified against the live function: for an Owner
-- narrowed to one of two hotels, `_staxis_company_access_can_delegate(...,
-- 'organization_owner', 'organization', ...)` returns TRUE, and
-- `_staxis_preview_company_access_edit` has no second coverage gate behind it.
--
-- That is the whole point of 0464 defeated by proxy: the subset Owner does not
-- reach the other seventeen hotels, they mint somebody who does.
--
-- Wrapped rather than rewritten, the same pattern 0467 used, so neither policy
-- body is retyped. The wrapper only ever REFUSES.
--
-- NOT CHANGED HERE, and reported as a decision rather than guessed at: the
-- delegate body still tests `staxis_role = 'vp'`, a word 0464 converted out of
-- existence, so the branch letting a Regional Manager hand out viewer-level
-- access has been silently dead since 0464 applied. Restoring it is a one-word
-- change, but it RESTORES a capability rather than removing one, and that is
-- the founder's call, not an auditor's.

alter function public._staxis_company_access_can_delegate(uuid, uuid, text, text, uuid, uuid)
  rename to _staxis_company_access_can_delegate_v0403;

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
declare
  v_whole_company boolean;
  v_scope_property_ids uuid[];
begin
  -- Property scope is already coverage-correct: every branch that reaches it
  -- joins the actor's own non-legacy authorizations. Only the two scopes that
  -- speak for more than one hotel are gated here.
  if p_scope_type in ('organization', 'portfolio') then
    v_whole_company := exists (
      select 1
      from public.organization_memberships membership
      where membership.organization_id = p_organization_id
        and membership.account_id = p_actor_account_id
        and membership.status = 'active'
        and membership.starts_at <= now()
        and membership.ended_at is null
        and membership.membership_scope = 'company'
        and membership.staxis_role in ('owner', 'regional_manager')
        and membership.covered_property_ids is null
    ) or exists (
      select 1
      from public.organization_access_grants access_grant
      join public.organization_memberships membership
        on membership.id = access_grant.membership_id
       and membership.account_id = p_actor_account_id
       and membership.status = 'active'
       and membership.ended_at is null
      where access_grant.organization_id = p_organization_id
        and access_grant.status = 'active'
        and access_grant.source <> 'legacy_backfill'
        and access_grant.scope_type = 'organization'
        and access_grant.access_profile in ('organization_owner', 'organization_admin')
        and access_grant.starts_at <= now()
        and (access_grant.expires_at is null or access_grant.expires_at > now())
    );

    if p_scope_type = 'organization' and not v_whole_company then
      return false;
    end if;

    -- A portfolio may be delegated over when it reaches at least one hotel and
    -- every hotel it reaches is one the actor already reaches. Reach is the
    -- portfolio's own RECURSIVE expansion, through
    -- `_staxis_company_access_scope_properties`, which is the same function the
    -- grant itself is expanded by: a parent portfolio whose hotels all hang off
    -- its children is a legitimate delegation target and a direct-assignment
    -- test would refuse it.
    --
    -- A portfolio reaching NO hotel does not qualify: a portfolio_manager grant
    -- on it silently gains whatever is added to it later, which is the same
    -- all-including-future promise only a whole-company standing may make.
    if p_scope_type = 'portfolio' and not v_whole_company then
      if p_portfolio_id is null then return false; end if;
      v_scope_property_ids := public._staxis_company_access_scope_properties(
        p_organization_id, 'portfolio', p_portfolio_id, null
      );
      if v_scope_property_ids is null or cardinality(v_scope_property_ids) = 0 then
        return false;
      end if;
      if exists (
        select 1
        from unnest(v_scope_property_ids) target(property_id)
        where not exists (
          select 1
          from public._staxis_nonlegacy_property_authorizations(p_actor_account_id) authority
          where authority.organization_id = p_organization_id
            and authority.property_id = target.property_id
        )
      ) then
        return false;
      end if;
    end if;
  end if;

  return public._staxis_company_access_can_delegate_v0403(
    p_actor_account_id, p_organization_id, p_access_profile,
    p_scope_type, p_portfolio_id, p_property_id
  );
end;
$$;
revoke all on function public._staxis_company_access_can_delegate(uuid, uuid, text, text, uuid, uuid)
  from public, anon, authenticated, service_role;

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
       -- 0468: this door used to refuse EVERY company hat carrying a hotel
       -- list ("role_conflict"), because it predates the 0464 list shape. It
       -- failed closed, so nothing leaked, but the only company hat it could
       -- mint was the WIDEST one: omit the list and you get NULL, which means
       -- every hotel including future ones. An Owner of 3 hotels could not add
       -- an existing colleague as a 3-hotel Regional Manager at all.
       --
       -- The list now travels, and every rule that governs it is the one the
       -- invitation door already used: _staxis_can_set_membership_hat, which
       -- since 0467 runs the coverage list through
       -- _staxis_company_coverage_list_ok. Nothing is widened. A company list
       -- is strictly narrower than the NULL this door already accepted, and
       -- the NULL branch still demands an all-hotels standing of the actor.
       or (p_membership_scope = 'company'
         and p_covered_property_ids is not null
         and (cardinality(p_covered_property_ids) = 0
           -- The grant is anchored at one hotel and the function asserts below
           -- that the target really gained it. A list that omits the anchor
           -- cannot satisfy that, so refuse it here with a reason the caller
           -- can read instead of raising at the assertion.
           or not (p_hotel_id = any(p_covered_property_ids))))
       or (p_membership_scope = 'property' and (
         cardinality(coalesce(p_covered_property_ids, '{}'::uuid[])) = 0
         or not (p_hotel_id = any(p_covered_property_ids)))) then
      return jsonb_build_object('ok', false, 'reason', 'role_conflict');
    end if;
    if v_actor.role <> 'admin' and not public._staxis_can_set_membership_hat(
      v_actor.id, p_organization_id, p_membership_scope, p_role,
      p_covered_property_ids
    ) then
      return jsonb_build_object('ok', false, 'reason', 'denied');
    end if;
    v_effective_coverage := case when p_covered_property_ids is null then null else array(
      select distinct covered.property_id from unnest(p_covered_property_ids) covered(property_id)
      order by covered.property_id) end;
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

-- ── An invitation may not promise a job that cannot be accepted ───────────
--
-- 0467 found and fixed one shape of this: an explicit-list company invitation
-- could be offered, emailed and claimed, and then failed at acceptance. Here is
-- a second one it did not look for.
--
-- Every invitation is anchored at one hotel, and `staxis_accept_account_invite`
-- asserts that the minted hat really reaches that hotel ("promised normalized
-- entitlement did not activate"). Nothing on the CREATE side checks that a
-- company hotel list contains the anchor. Reproduced: an invitation anchored at
-- Beaumont promising coverage of Lufkin only is created with ok:true, and its
-- acceptance raises that exception every time. The property shape has always
-- had this check; the company shape never got one.
--
-- Refusing at creation turns a guaranteed later failure into an immediate one,
-- which is the whole reason the guarded RPCs exist. It removes no reachable
-- outcome: nothing that this now refuses could ever have been accepted.

alter function public._staxis_can_control_account_invite(uuid, uuid, uuid, text, text, uuid[])
  rename to _staxis_can_control_account_invite_v0467;

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
  if p_membership_scope = 'company'
     and p_covered_property_ids is not null
     and not (p_hotel_id = any(p_covered_property_ids))
  then
    return false;
  end if;
  return public._staxis_can_control_account_invite_v0467(
    p_actor_account_id, p_hotel_id, p_organization_id,
    p_membership_scope, p_role, p_covered_property_ids
  );
end;
$$;
revoke all on function public._staxis_can_control_account_invite(uuid, uuid, uuid, text, text, uuid[])
  from public, anon, authenticated, service_role;

-- ── Defence in depth: no row may name zero hotels ─────────────────────────
--
-- Belt to the two braces above. Production is already clean, so this normalize
-- is expected to touch nothing; it exists so that applying this file to a
-- database that DOES carry an empty row fails safe rather than aborting
-- half-way through a DDL transaction with an unhelpful constraint message.
--
-- The normalize demotes such a row to a plain employment record — the CHECK's
-- first branch, which is what a hat naming zero hotels already amounts to — and
-- ends it. It never sets a hat's coverage to NULL: for the company shape NULL
-- means EVERY hotel including future ones, so "repairing" an empty company hat
-- to NULL would silently hand somebody the entire portfolio. Demoting is the
-- fail-closed reading and the only honest one.
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public.organization_memberships
  where covered_property_ids is not null
    and cardinality(covered_property_ids) = 0;
  if v_count > 0 then
    raise notice '0468: demoting % membership row(s) that named zero hotels', v_count;
    update public.organization_memberships membership
       set membership_scope = null,
           staxis_role = null,
           covered_property_ids = null,
           status = 'revoked',
           ended_at = coalesce(
             membership.ended_at,
             greatest(clock_timestamp(), membership.starts_at + interval '1 microsecond')
           ),
           updated_at = clock_timestamp()
     where membership.covered_property_ids is not null
       and cardinality(membership.covered_property_ids) = 0;
  end if;
end;
$$;

alter table public.organization_memberships
  drop constraint if exists organization_memberships_hat_shape_check;

alter table public.organization_memberships
  add constraint organization_memberships_hat_shape_check check (
    -- Legacy employment record: all three columns absent, together.
    (membership_scope is null and staxis_role is null and covered_property_ids is null)
    -- Company hat: NULL coverage means every hotel the company operates now and
    -- later; an explicit list means exactly those hotels and no future ones.
    -- `cardinality`, not `array_length`: for '{}' the latter is NULL and a CHECK
    -- reads NULL as satisfied, which is how an empty list got in.
    or (membership_scope = 'company'
        and staxis_role in ('owner', 'regional_manager')
        and (covered_property_ids is null
          or (cardinality(covered_property_ids) >= 1
            and array_position(covered_property_ids, null) is null)))
    -- Property hat: an explicit, non-empty, null-free list of hotels.
    or (membership_scope = 'property'
        and staxis_role in ('general_manager', 'front_desk', 'housekeeping', 'maintenance')
        and covered_property_ids is not null
        and cardinality(covered_property_ids) >= 1
        and array_position(covered_property_ids, null) is null)
  );

-- The invitation side of the same hole. No normalize here on purpose: an
-- invitation is a written promise to a named person, and quietly rewriting one
-- is worse than refusing to apply. Production carries none; if a database does,
-- this statement fails loudly and a human decides what the promise was.
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

comment on column public.organization_memberships.covered_property_ids is
  'Which hotels a hat reaches. Company scope: NULL for every hotel the company operates including future ones, or an explicit non-empty list for exactly those. Property scope: always an explicit non-empty list. An empty array is not a legal value in either shape and is refused by organization_memberships_hat_shape_check (0468); the two writers that produced one end the hat instead.';

insert into public.applied_migrations (version, description)
values ('0468', 'Coverage never empties: detach and hotel deletion end a property hat instead of writing an empty list, and the hat-shape checks refuse an empty array.')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
