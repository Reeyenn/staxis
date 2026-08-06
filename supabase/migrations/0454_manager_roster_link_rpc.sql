-- 0454_manager_roster_link_rpc.sql
--
-- The manager-roster bridge needs one guarded way to write its account link.
--
-- Accepting an invitation to RUN a hotel puts that person on the hotel's staff
-- list (src/lib/schedule/staff-identity.ts), and the last step of that bridge
-- is the (account, property) row in account_property_staff_links. Stage C
-- (0325 lockdown, kept by 0426) leaves service_role with SELECT only on that
-- table, so the bridge's direct upsert fails in production with "permission
-- denied for table account_property_staff_links": the roster rows appear and
-- nothing is ever linked to the login.
--
-- This adds the missing SECURITY DEFINER write path and nothing else. No table
-- grant is widened, no RLS policy is touched, and the only new privilege is
-- EXECUTE on this one function for service_role.
--
-- The guards mirror the link write inside 0426's staxis_accept_account_invite
-- and the roster-row lock in 0416's _staxis_lock_invite_target_staff:
--   * the account exists, is active, and is not a platform admin
--   * the hotel exists, and is locked in the same order (account, then hotel
--     row plus its advisory lock, then the roster row, then the link rows)
--   * the account holds canonical authority over that hotel, resolved through
--     _staxis_account_property_authorizations, the same source of truth
--     staxis_account_reaches_property uses as the final tenant gate
--   * the roster row is this hotel's, still active, and not housekeeping
--   * no OTHER login already holds the active link on that roster row, which
--     is account_property_staff_one_active_account_idx stated as a clean
--     refusal instead of a unique-violation

begin;

do $$
begin
  if to_regclass('public.account_property_staff_links') is null
     or to_regclass('public.account_authorization_state') is null
     or to_regclass('public.staff') is null
     or to_regclass('public.accounts') is null
     or to_regclass('public.properties') is null
     or to_regprocedure('public._staxis_account_property_authorizations(uuid)') is null
     or to_regprocedure('public.staxis_account_reaches_property(uuid,uuid)') is null
  then
    raise exception '0454 requires the authoritative access contract from 0325, 0378, and 0426';
  end if;
end
$$;

create or replace function public.staxis_bridge_manager_roster_link(
  p_account_id uuid,
  p_property_id uuid,
  p_staff_id uuid,
  p_source text,
  p_linked_by_account_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_account public.accounts%rowtype;
  v_department text;
  v_now timestamptz := clock_timestamp();
  v_existing_staff_id uuid;
  v_had_row boolean := false;
  v_written_account_id uuid;
begin
  if p_account_id is null
     or p_property_id is null
     or p_staff_id is null
     or p_source is null
     or p_source not in ('invitation', 'system')
  then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  select account.* into v_account
  from public.accounts account
  where account.id = p_account_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'account_not_found');
  end if;
  if v_account.active is not true then
    return jsonb_build_object('ok', false, 'reason', 'account_inactive');
  end if;
  -- Platform admins are not on any hotel's staff list.
  if v_account.role = 'admin' then
    return jsonb_build_object('ok', false, 'reason', 'role_conflict');
  end if;

  if p_linked_by_account_id is not null and not exists (
    select 1 from public.accounts actor where actor.id = p_linked_by_account_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'actor_not_found');
  end if;

  perform 1 from public.properties property
   where property.id = p_property_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'property_not_found');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_property_id::text, 0));

  -- Hold the standing authority still for the rest of this transaction. This
  -- write never changes it, so a share lock is enough and it keeps the same
  -- account/property/state order the Stage C grant helper takes.
  perform 1 from public.account_authorization_state state
   where state.account_id = p_account_id
   for share;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'authorization_state_missing');
  end if;

  if not exists (
    select 1
    from public._staxis_account_property_authorizations(p_account_id) authorization_row
    where authorization_row.property_id = p_property_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;

  -- A null department is read as housekeeping, the same reading 0416 uses.
  select coalesce(staff_row.department, 'housekeeping')
    into v_department
  from public.staff staff_row
  where staff_row.id = p_staff_id
    and staff_row.property_id = p_property_id
    and staff_row.is_active is true
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'staff_not_found');
  end if;
  if v_department = 'housekeeping' then
    return jsonb_build_object('ok', false, 'reason', 'department_conflict');
  end if;

  -- Every link row this statement could touch, locked once in a deterministic
  -- order so two concurrent acceptances cannot interleave into a second active
  -- claim on the same roster identity.
  perform 1
  from public.account_property_staff_links staff_link
  where staff_link.staff_id = p_staff_id
     or (staff_link.account_id = p_account_id and staff_link.property_id = p_property_id)
  order by staff_link.account_id, staff_link.property_id
  for update;

  if exists (
    select 1
    from public.account_property_staff_links staff_link
    where staff_link.staff_id = p_staff_id
      and staff_link.is_active is true
      and staff_link.account_id <> p_account_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'staff_in_use');
  end if;

  select staff_link.staff_id
    into v_existing_staff_id
  from public.account_property_staff_links staff_link
  where staff_link.account_id = p_account_id
    and staff_link.property_id = p_property_id;
  v_had_row := found;

  insert into public.account_property_staff_links (
    account_id, property_id, staff_id, is_active, source,
    linked_by_account_id, linked_at,
    deactivated_at, deactivated_by_account_id, updated_at
  ) values (
    p_account_id, p_property_id, p_staff_id, true, p_source,
    p_linked_by_account_id, v_now,
    null, null, v_now
  )
  on conflict (account_id, property_id) do update
    set staff_id = excluded.staff_id,
        is_active = true,
        source = excluded.source,
        linked_by_account_id = excluded.linked_by_account_id,
        -- The first link is when this employment started; a later repair run
        -- must not rewrite that.
        linked_at = coalesce(public.account_property_staff_links.linked_at, excluded.linked_at),
        deactivated_at = null,
        deactivated_by_account_id = null,
        updated_at = excluded.updated_at
  returning account_id into v_written_account_id;
  if v_written_account_id is null then
    return jsonb_build_object('ok', false, 'reason', 'link_conflict');
  end if;

  return jsonb_build_object(
    'ok', true,
    'status', case
      when not v_had_row then 'linked'
      when v_existing_staff_id = p_staff_id then 'unchanged'
      else 'relinked'
    end,
    'accountId', p_account_id,
    'propertyId', p_property_id,
    'staffId', p_staff_id
  );
end;
$$;

comment on function public.staxis_bridge_manager_roster_link(uuid,uuid,uuid,text,uuid) is
  'Guarded manager-roster account link. The only write path to account_property_staff_links for the roster bridge: it revalidates canonical hotel authority, the roster row, and the one-active-login rule before upserting the (account, property) link.';

revoke all on function public.staxis_bridge_manager_roster_link(uuid,uuid,uuid,text,uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_bridge_manager_roster_link(uuid,uuid,uuid,text,uuid)
  to service_role;

insert into public.applied_migrations (version, description)
values (
  '0454',
  'Guarded SECURITY DEFINER account link for the manager roster bridge'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
