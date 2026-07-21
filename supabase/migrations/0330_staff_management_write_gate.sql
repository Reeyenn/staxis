-- Staff roster reads remain hotel-wide because schedules, assignments, and
-- communications need the complete roster. Staff roster WRITES are different:
-- they change who can be scheduled and must stay behind manage_team.
--
-- The legacy "owner rw staff" policy called user_owns_property(), whose name is
-- historical: today it means any account with property_access. That let a line
-- staff account bypass a hidden Add/Edit/Delete button through direct PostgREST.
-- Split SELECT from mutation policies and mirror the server manage_team rule.

create or replace function public.staxis_user_can_manage_staff(p_property_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(auth.role(), '') = 'service_role'
    or exists (
      select 1
      from public.accounts a
      where a.data_user_id = auth.uid()
        and a.active is true
        and (
          a.role = 'admin'
          or (
            a.role in ('owner', 'general_manager')
            and p_property_id = any(coalesce(a.property_access, '{}'::uuid[]))
            and not exists (
              select 1
              from public.capability_overrides o
              where o.property_id = p_property_id
                and o.capability = 'manage_team'
                and o.role = a.role
                and o.allowed = false
            )
          )
        )
    );
$$;

revoke all on function public.staxis_user_can_manage_staff(uuid) from public, anon;
grant execute on function public.staxis_user_can_manage_staff(uuid)
  to authenticated, service_role;

drop policy if exists "owner rw staff" on public.staff;
drop policy if exists staff_property_roster_select on public.staff;
drop policy if exists staff_manage_insert on public.staff;
drop policy if exists staff_manage_update on public.staff;
drop policy if exists staff_manage_delete on public.staff;

create policy staff_property_roster_select
  on public.staff
  for select
  to authenticated
  using (
    public.user_owns_property(property_id)
    and public.mfa_verified_or_grace()
  );

create policy staff_manage_insert
  on public.staff
  for insert
  to authenticated
  with check (
    public.staxis_user_can_manage_staff(property_id)
    and public.mfa_verified_or_grace()
  );

create policy staff_manage_update
  on public.staff
  for update
  to authenticated
  using (
    public.staxis_user_can_manage_staff(property_id)
    and public.mfa_verified_or_grace()
  )
  with check (
    public.staxis_user_can_manage_staff(property_id)
    and public.mfa_verified_or_grace()
  );

create policy staff_manage_delete
  on public.staff
  for delete
  to authenticated
  using (
    public.staxis_user_can_manage_staff(property_id)
    and public.mfa_verified_or_grace()
  );

insert into public.applied_migrations (version, description)
values (
  '0330',
  'Split staff roster read/write RLS and enforce manage_team for browser mutations'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
