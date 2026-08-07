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
  update public.organization_memberships membership
     set status = 'revoked',
         ended_at = clock_timestamp(),
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
      -- which is now the only record of where that job was. Already-ended rows
      -- keep the ended_at they were given; `status` and `ended_at` move
      -- together or the revoked-shape CHECK refuses the row.
      update public.organization_memberships membership
         set status = case when membership.status = 'active' then 'revoked' else membership.status end,
             ended_at = coalesce(membership.ended_at, clock_timestamp()),
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
