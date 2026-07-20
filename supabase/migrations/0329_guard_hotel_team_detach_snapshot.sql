-- 0329: prevent stale hotel-team removals from acting on a changed account.
--
-- /api/auth/team authorizes a target from its role and updated_at snapshot.
-- A concurrent promotion or access edit must not be followed by a stale
-- hotel-removal request. Lock the account row and compare that snapshot in
-- the same transaction that removes the hotel.

create or replace function public.staxis_remove_property_access_guarded(
  p_account_id          uuid,
  p_hotel_id            uuid,
  p_expected_role       text,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role              text;
  v_updated_at        timestamptz;
  v_property_access   uuid[];
  v_remaining_hotels  int;
begin
  select account.role::text, account.updated_at, account.property_access
    into v_role, v_updated_at, v_property_access
    from public.accounts account
   where account.id = p_account_id
   for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_role is distinct from p_expected_role
     or v_updated_at is distinct from p_expected_updated_at then
    return jsonb_build_object('status', 'conflict');
  end if;

  if not (p_hotel_id = any(coalesce(v_property_access, '{}'::uuid[]))) then
    return jsonb_build_object('status', 'not_attached');
  end if;

  update public.accounts
     set property_access = array_remove(coalesce(v_property_access, '{}'::uuid[]), p_hotel_id),
         updated_at = now()
   where id = p_account_id
   returning coalesce(array_length(property_access, 1), 0)
        into v_remaining_hotels;

  return jsonb_build_object(
    'status', 'ok',
    'remaining_hotels', v_remaining_hotels
  );
end;
$$;

revoke all on function public.staxis_remove_property_access_guarded(uuid, uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.staxis_remove_property_access_guarded(uuid, uuid, text, timestamptz)
  to service_role;

comment on function public.staxis_remove_property_access_guarded(uuid, uuid, text, timestamptz) is
  'Service-route helper: atomically removes one hotel only when the target account role/version still matches the authorization snapshot.';

insert into public.applied_migrations (version, description)
values (
  '0329',
  'guard hotel-team access removal with the authorized target role and updated_at snapshot'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
