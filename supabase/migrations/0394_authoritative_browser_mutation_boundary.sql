-- Authoritative browser mutation boundary.
--
-- `user_owns_property` deliberately means tenant READ reach.  A management-
-- company owner, VP, or finance user may therefore read a governed hotel while
-- their per-hotel standing remains operationally read-only.  Reusing that read
-- predicate for INSERT/UPDATE/DELETE let direct PostgREST calls bypass
-- `hotelMutationAllowed`.  This migration keeps the read predicate intact and
-- gives every browser write one predicate backed by the exact same standing
-- DTO as the server authorization layer.

begin;

create or replace function public._staxis_authoritative_property_standing_for_auth_user(
  p_auth_user_id uuid,
  p_property_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_account_ids uuid[];
  v_access jsonb;
  v_standing jsonb;
begin
  if p_auth_user_id is null or p_property_id is null then return null; end if;

  select coalesce(array_agg(account.id order by account.id), '{}'::uuid[])
    into v_account_ids
  from public.accounts account
  where account.data_user_id = p_auth_user_id
    and account.active is true;
  -- Duplicate live identities are a corrupt/ambiguous session and fail closed.
  if cardinality(v_account_ids) <> 1 then return null; end if;

  v_access := public.staxis_list_account_authorized_properties(v_account_ids[1]);
  if coalesce((v_access->>'ok')::boolean, false) is not true then return null; end if;
  if coalesce((v_access->>'all')::boolean, false) is true then
    return jsonb_build_object(
      'propertyId', p_property_id,
      'operationalRole', 'admin',
      'seesFinancials', true,
      'hotelMutationAllowed', true,
      'portfolioIntelligenceRead', true
    );
  end if;

  select standing.value into v_standing
  from jsonb_array_elements(coalesce(v_access->'propertyStandings', '[]'::jsonb)) standing(value)
  where standing.value->>'propertyId' = p_property_id::text;
  return v_standing;
exception when others then
  -- RLS authorization storage/parsing failures never become access.
  return null;
end;
$$;

revoke all on function public._staxis_authoritative_property_standing_for_auth_user(uuid,uuid)
  from public, anon, authenticated, service_role;

create or replace function public.staxis_user_can_mutate_property(p_property_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(auth.role(), '') = 'service_role'
    or coalesce((public._staxis_authoritative_property_standing_for_auth_user(
      auth.uid(), p_property_id
    )->>'hotelMutationAllowed')::boolean, false);
$$;

revoke all on function public.staxis_user_can_mutate_property(uuid) from public, anon;
grant execute on function public.staxis_user_can_mutate_property(uuid)
  to authenticated, service_role;
comment on function public.staxis_user_can_mutate_property(uuid) is
  'Browser/RPC write predicate backed by the current authoritative per-hotel standing. Read reach alone is insufficient.';

-- 0290's manager helper trusted the legacy account role/property array even
-- after normalized cutover and did not require an active account. Keep the
-- compatibility name, but make it an alias of the current explicit hotel
-- mutation standing so no future policy can revive stale legacy reach.
create or replace function public.user_manages_property(p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.staxis_user_can_mutate_property(p_id);
$$;
revoke all on function public.user_manages_property(uuid) from public, anon;
grant execute on function public.user_manages_property(uuid)
  to authenticated, service_role;

-- Fix the platform-admin identity bridge used by mapping-help RLS.  `uid` is
-- auth.users.id in every caller, not accounts.id, and deactivation/demotion is
-- immediate even in an already-open session.
create or replace function public.is_admin_user(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.accounts account
    where account.data_user_id = uid
      and account.active is true
      and account.role = 'admin'
  );
$$;
revoke all on function public.is_admin_user(uuid) from public, anon;
grant execute on function public.is_admin_user(uuid) to authenticated, service_role;

-- Rebuild legacy raw-account capability helpers over the same current
-- standing.  Capability overrides continue to restrict the standing role;
-- they can never manufacture mutation authority.
create or replace function public.staxis_user_can_manage_equipment(p_property_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_standing jsonb;
  v_role text;
begin
  if coalesce(auth.role(), '') = 'service_role' then return true; end if;
  v_standing := public._staxis_authoritative_property_standing_for_auth_user(
    auth.uid(), p_property_id
  );
  v_role := v_standing->>'operationalRole';
  return public.staxis_property_section_enabled(p_property_id, 'maintenance')
    and coalesce((v_standing->>'hotelMutationAllowed')::boolean, false)
    and v_role in (
      'admin', 'owner', 'general_manager', 'front_desk',
      'housekeeping', 'maintenance', 'staff'
    )
    and (
      v_role = 'admin' or v_role = 'staff' or not exists (
        select 1 from public.capability_overrides override_row
        where override_row.property_id = p_property_id
          and override_row.capability = 'manage_equipment'
          and override_row.role = v_role
          and override_row.allowed = false
      )
    );
end;
$$;

create or replace function public.staxis_user_can_manage_staff(p_property_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_standing jsonb;
  v_role text;
begin
  if coalesce(auth.role(), '') = 'service_role' then return true; end if;
  v_standing := public._staxis_authoritative_property_standing_for_auth_user(
    auth.uid(), p_property_id
  );
  v_role := v_standing->>'operationalRole';
  return public.staxis_property_section_enabled(p_property_id, 'staff')
    and coalesce((v_standing->>'hotelMutationAllowed')::boolean, false)
    and v_role in ('admin', 'owner', 'general_manager')
    and (
      v_role = 'admin' or not exists (
        select 1 from public.capability_overrides override_row
        where override_row.property_id = p_property_id
          and override_row.capability = 'manage_team'
          and override_row.role = v_role
          and override_row.allowed = false
      )
    );
end;
$$;

create or replace function public.staxis_user_can_manage_inventory_operations(
  p_property_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_standing jsonb;
  v_role text;
begin
  if coalesce(auth.role(), '') = 'service_role' then return true; end if;
  v_standing := public._staxis_authoritative_property_standing_for_auth_user(
    auth.uid(), p_property_id
  );
  v_role := v_standing->>'operationalRole';
  return public.staxis_property_section_enabled(p_property_id, 'inventory')
    and coalesce((v_standing->>'hotelMutationAllowed')::boolean, false)
    and v_role in (
      'admin', 'owner', 'general_manager', 'front_desk',
      'housekeeping', 'maintenance', 'staff'
    )
    and (
      v_role = 'admin' or v_role = 'staff' or not exists (
        select 1 from public.capability_overrides override_row
        where override_row.property_id = p_property_id
          and override_row.capability = 'manage_inventory_orders'
          and override_row.role = v_role
          and override_row.allowed = false
      )
    );
end;
$$;

create or replace function public.staxis_user_can_view_inventory_financials(
  p_property_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_standing jsonb;
  v_role text;
begin
  if coalesce(auth.role(), '') = 'service_role' then return true; end if;
  v_standing := public._staxis_authoritative_property_standing_for_auth_user(
    auth.uid(), p_property_id
  );
  v_role := v_standing->>'operationalRole';
  return public.staxis_property_section_enabled(p_property_id, 'inventory')
    and public.staxis_property_section_enabled(p_property_id, 'financials')
    and coalesce((v_standing->>'seesFinancials')::boolean, false)
    and (
      v_role not in ('admin', 'owner', 'general_manager') or v_role = 'admin'
      or not exists (
        select 1 from public.capability_overrides override_row
        where override_row.property_id = p_property_id
          and override_row.capability = 'view_financials'
          and override_row.role = v_role
          and override_row.allowed = false
      )
    );
end;
$$;

revoke all on function public.staxis_user_can_manage_equipment(uuid) from public, anon;
revoke all on function public.staxis_user_can_manage_staff(uuid) from public, anon;
revoke all on function public.staxis_user_can_manage_inventory_operations(uuid) from public, anon;
revoke all on function public.staxis_user_can_view_inventory_financials(uuid) from public, anon;
grant execute on function public.staxis_user_can_manage_equipment(uuid)
  to authenticated, service_role;
grant execute on function public.staxis_user_can_manage_staff(uuid)
  to authenticated, service_role;
grant execute on function public.staxis_user_can_manage_inventory_operations(uuid)
  to authenticated, service_role;
grant execute on function public.staxis_user_can_view_inventory_financials(uuid)
  to authenticated, service_role;

-- Historical `FOR ALL` policies mixed tenant reads and writes. Split them so
-- company/portfolio readers keep current-hotel reads while every mutation
-- independently requires the authoritative write bit.
do $policies$
declare
  policy_row record;
begin
  for policy_row in
    select * from (values
      ('attendance_marks', 'owner write attendance_marks'),
      ('cleaning_events', 'owner rw cleaning_events'),
      ('daily_logs', 'owner rw daily_logs'),
      ('deep_clean_config', 'owner rw deep_clean_config'),
      ('deep_clean_records', 'owner rw deep_clean_records'),
      ('guest_requests', 'owner rw guest_requests'),
      ('handoff_logs', 'owner rw handoff_logs'),
      ('laundry_config', 'owner rw laundry_config'),
      ('manager_notifications', 'owner rw manager_notifications'),
      ('ml_feature_flags', 'owner write ml_feature_flags'),
      ('public_areas', 'owner rw public_areas'),
      ('schedule_assignments', 'owner rw schedule_assignments'),
      ('shift_confirmations', 'owner rw shift_confirmations')
    ) policies(table_name, old_policy_name)
  loop
    execute format('drop policy if exists %I on public.%I',
      policy_row.old_policy_name, policy_row.table_name);
    execute format(
      'create policy staxis_authoritative_property_select on public.%I '
      'for select to authenticated using ('
      'public.user_owns_property(property_id) and public.mfa_verified_or_grace())',
      policy_row.table_name
    );
    execute format(
      'create policy staxis_authoritative_property_insert on public.%I '
      'for insert to authenticated with check ('
      'public.user_owns_property(property_id) '
      'and public.staxis_user_can_mutate_property(property_id) '
      'and public.mfa_verified_or_grace())',
      policy_row.table_name
    );
    execute format(
      'create policy staxis_authoritative_property_update on public.%I '
      'for update to authenticated using ('
      'public.user_owns_property(property_id) '
      'and public.staxis_user_can_mutate_property(property_id) '
      'and public.mfa_verified_or_grace()) with check ('
      'public.user_owns_property(property_id) '
      'and public.staxis_user_can_mutate_property(property_id) '
      'and public.mfa_verified_or_grace())',
      policy_row.table_name
    );
    execute format(
      'create policy staxis_authoritative_property_delete on public.%I '
      'for delete to authenticated using ('
      'public.user_owns_property(property_id) '
      'and public.staxis_user_can_mutate_property(property_id) '
      'and public.mfa_verified_or_grace())',
      policy_row.table_name
    );
  end loop;
end
$policies$;

alter policy "owner insert inventory" on public.inventory
  with check (
    public.user_owns_property(property_id)
    and public.staxis_user_can_mutate_property(property_id)
    and public.mfa_verified_or_grace()
    and public.staxis_property_section_enabled(property_id, 'inventory')
  );
alter policy "owner update inventory" on public.inventory
  using (
    public.user_owns_property(property_id)
    and public.staxis_user_can_mutate_property(property_id)
    and public.mfa_verified_or_grace()
    and public.staxis_property_section_enabled(property_id, 'inventory')
  )
  with check (
    public.user_owns_property(property_id)
    and public.staxis_user_can_mutate_property(property_id)
    and public.mfa_verified_or_grace()
    and public.staxis_property_section_enabled(property_id, 'inventory')
  );
alter policy "owner insert inventory_reconciliations"
  on public.inventory_reconciliations
  with check (
    public.user_owns_property(property_id)
    and public.staxis_user_can_mutate_property(property_id)
    and public.mfa_verified_or_grace()
  );
alter policy "owner insert prediction_overrides" on public.prediction_overrides
  with check (
    public.user_owns_property(property_id)
    and public.staxis_user_can_mutate_property(property_id)
    and public.mfa_verified_or_grace()
  );

drop policy if exists work_orders_property_maintenance_rw on public.work_orders;
create policy work_orders_property_maintenance_select on public.work_orders
  for select to authenticated
  using (
    public.user_owns_property(property_id)
    and public.mfa_verified_or_grace()
    and public.staxis_property_section_enabled(property_id, 'maintenance')
  );
create policy work_orders_property_maintenance_insert on public.work_orders
  for insert to authenticated
  with check (
    public.user_owns_property(property_id)
    and public.staxis_user_can_mutate_property(property_id)
    and public.mfa_verified_or_grace()
    and public.staxis_property_section_enabled(property_id, 'maintenance')
  );
create policy work_orders_property_maintenance_update on public.work_orders
  for update to authenticated
  using (
    public.user_owns_property(property_id)
    and public.staxis_user_can_mutate_property(property_id)
    and public.mfa_verified_or_grace()
    and public.staxis_property_section_enabled(property_id, 'maintenance')
  )
  with check (
    public.user_owns_property(property_id)
    and public.staxis_user_can_mutate_property(property_id)
    and public.mfa_verified_or_grace()
    and public.staxis_property_section_enabled(property_id, 'maintenance')
  );
create policy work_orders_property_maintenance_delete on public.work_orders
  for delete to authenticated
  using (
    public.user_owns_property(property_id)
    and public.staxis_user_can_mutate_property(property_id)
    and public.mfa_verified_or_grace()
    and public.staxis_property_section_enabled(property_id, 'maintenance')
  );

-- Financial visibility is a read bit. Budget mutation additionally requires
-- hotel mutation, so a finance/company role can drill down without editing.
drop policy if exists "inventory finance managers rw budgets" on public.inventory_budgets;
drop policy if exists "inventory finance managers rw budget sections"
  on public.inventory_budget_sections;
do $financial_policies$
declare
  table_name text;
begin
  foreach table_name in array array['inventory_budgets', 'inventory_budget_sections']
  loop
    execute format(
      'create policy staxis_authoritative_financial_select on public.%I '
      'for select to authenticated using ('
      'public.mfa_verified_or_grace() '
      'and public.staxis_user_can_view_inventory_financials(property_id))',
      table_name
    );
    execute format(
      'create policy staxis_authoritative_financial_insert on public.%I '
      'for insert to authenticated with check ('
      'public.mfa_verified_or_grace() '
      'and public.staxis_user_can_view_inventory_financials(property_id) '
      'and public.staxis_user_can_mutate_property(property_id))',
      table_name
    );
    execute format(
      'create policy staxis_authoritative_financial_update on public.%I '
      'for update to authenticated using ('
      'public.mfa_verified_or_grace() '
      'and public.staxis_user_can_view_inventory_financials(property_id) '
      'and public.staxis_user_can_mutate_property(property_id)) with check ('
      'public.mfa_verified_or_grace() '
      'and public.staxis_user_can_view_inventory_financials(property_id) '
      'and public.staxis_user_can_mutate_property(property_id))',
      table_name
    );
    execute format(
      'create policy staxis_authoritative_financial_delete on public.%I '
      'for delete to authenticated using ('
      'public.mfa_verified_or_grace() '
      'and public.staxis_user_can_view_inventory_financials(property_id) '
      'and public.staxis_user_can_mutate_property(property_id))',
      table_name
    );
  end loop;
end
$financial_policies$;

-- Platform property lifecycle always rechecks active global-admin status.
alter policy "admin can insert properties" on public.properties
  with check (public.is_admin_user(auth.uid()) and public.mfa_verified_or_grace());
alter policy "admin can update properties" on public.properties
  using (public.is_admin_user(auth.uid()) and public.mfa_verified_or_grace())
  with check (public.is_admin_user(auth.uid()) and public.mfa_verified_or_grace());
alter policy "admin can delete properties" on public.properties
  using (public.is_admin_user(auth.uid()) and public.mfa_verified_or_grace());

-- Storage object names carry the property id in path segment one. Preserve
-- current read reach, but never treat it as upload/update/delete authority.
-- The four historical "anon deny" policies were created as PERMISSIVE, where
-- `bucket_id <> target` becomes an allow for every other bucket. Recreate them
-- as RESTRICTIVE predicates so they can deny their target without granting
-- anything themselves.
drop policy if exists "anon deny capex-attachments" on storage.objects;
create policy "anon deny capex-attachments" on storage.objects
  as restrictive for all to anon, authenticated
  using (bucket_id <> 'capex-attachments')
  with check (bucket_id <> 'capex-attachments');
drop policy if exists "anon deny housekeeping-issue-photos" on storage.objects;
create policy "anon deny housekeeping-issue-photos" on storage.objects
  as restrictive for all to anon, authenticated
  using (bucket_id <> 'housekeeping-issue-photos')
  with check (bucket_id <> 'housekeeping-issue-photos');
drop policy if exists "anon deny lost-found-item-photos" on storage.objects;
create policy "anon deny lost-found-item-photos" on storage.objects
  as restrictive for all to anon, authenticated
  using (bucket_id <> 'lost-found-item-photos')
  with check (bucket_id <> 'lost-found-item-photos');
drop policy if exists "anon deny package-label-photos" on storage.objects;
create policy "anon deny package-label-photos" on storage.objects
  as restrictive for all to anon, authenticated
  using (bucket_id <> 'package-label-photos')
  with check (bucket_id <> 'package-label-photos');

drop policy if exists "owner rw counts" on storage.objects;
create policy "owner read counts" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'counts'
    and public.mfa_verified_or_grace()
    and (storage.foldername(name))[1] is not null
    and public.user_owns_property(((storage.foldername(name))[1])::uuid)
  );
create policy "authorized write counts" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'counts'
    and public.mfa_verified_or_grace()
    and (storage.foldername(name))[1] is not null
    and public.user_owns_property(((storage.foldername(name))[1])::uuid)
    and public.staxis_user_can_mutate_property(((storage.foldername(name))[1])::uuid)
  );
create policy "authorized update counts" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'counts'
    and public.mfa_verified_or_grace()
    and (storage.foldername(name))[1] is not null
    and public.user_owns_property(((storage.foldername(name))[1])::uuid)
    and public.staxis_user_can_mutate_property(((storage.foldername(name))[1])::uuid)
  )
  with check (
    bucket_id = 'counts'
    and public.mfa_verified_or_grace()
    and (storage.foldername(name))[1] is not null
    and public.user_owns_property(((storage.foldername(name))[1])::uuid)
    and public.staxis_user_can_mutate_property(((storage.foldername(name))[1])::uuid)
  );
create policy "authorized delete counts" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'counts'
    and public.mfa_verified_or_grace()
    and (storage.foldername(name))[1] is not null
    and public.user_owns_property(((storage.foldername(name))[1])::uuid)
    and public.staxis_user_can_mutate_property(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "owner rw invoices" on storage.objects;
create policy "owner read invoices" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'invoices'
    and public.mfa_verified_or_grace()
    and (storage.foldername(name))[1] is not null
    and public.user_owns_property(((storage.foldername(name))[1])::uuid)
  );
create policy "authorized write invoices" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'invoices'
    and public.mfa_verified_or_grace()
    and (storage.foldername(name))[1] is not null
    and public.user_owns_property(((storage.foldername(name))[1])::uuid)
    and public.staxis_user_can_mutate_property(((storage.foldername(name))[1])::uuid)
  );
create policy "authorized update invoices" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'invoices'
    and public.mfa_verified_or_grace()
    and (storage.foldername(name))[1] is not null
    and public.user_owns_property(((storage.foldername(name))[1])::uuid)
    and public.staxis_user_can_mutate_property(((storage.foldername(name))[1])::uuid)
  )
  with check (
    bucket_id = 'invoices'
    and public.mfa_verified_or_grace()
    and (storage.foldername(name))[1] is not null
    and public.user_owns_property(((storage.foldername(name))[1])::uuid)
    and public.staxis_user_can_mutate_property(((storage.foldername(name))[1])::uuid)
  );
create policy "authorized delete invoices" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'invoices'
    and public.mfa_verified_or_grace()
    and (storage.foldername(name))[1] is not null
    and public.user_owns_property(((storage.foldername(name))[1])::uuid)
    and public.staxis_user_can_mutate_property(((storage.foldername(name))[1])::uuid)
  );

alter policy maintenance_photos_write_owner on storage.objects
  with check (
    bucket_id = 'maintenance-photos'
    and (storage.foldername(name))[1] is not null
    and public.user_owns_property(((storage.foldername(name))[1])::uuid)
    and public.staxis_user_can_mutate_property(((storage.foldername(name))[1])::uuid)
  );
alter policy maintenance_photos_delete_owner on storage.objects
  using (
    bucket_id = 'maintenance-photos'
    and (storage.foldername(name))[1] is not null
    and public.user_owns_property(((storage.foldername(name))[1])::uuid)
    and public.staxis_user_can_mutate_property(((storage.foldername(name))[1])::uuid)
  );

-- SECURITY DEFINER inventory RPCs bypass table RLS, including idempotent
-- replay branches. Rebuild their public entry points so the current standing
-- is checked before the older implementation can read a receipt or write.
create or replace function public.staxis_save_inventory_count(
  p_property_id uuid,
  p_request_id uuid,
  p_counted_at timestamptz,
  p_counted_by text,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and (
    not public.staxis_user_can_mutate_property(p_property_id)
    or not public.mfa_verified_or_grace()
  ) then
    raise exception 'not authorized to count inventory for this property'
      using errcode = '42501';
  end if;
  perform public.staxis_require_inventory_section(p_property_id);
  return public.staxis_save_inventory_count_0334_impl(
    p_property_id, p_request_id, p_counted_at, p_counted_by, p_rows
  );
end;
$$;

create or replace function public.staxis_receive_inventory_delivery(
  p_property_id uuid,
  p_request_id uuid,
  p_received_at timestamptz,
  p_vendor_name text,
  p_notes text,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and (
    not public.staxis_user_can_manage_inventory_operations(p_property_id)
    or not public.mfa_verified_or_grace()
  ) then
    raise exception 'not authorized to receive inventory for this property'
      using errcode = '42501';
  end if;
  perform public.staxis_require_inventory_section(p_property_id);
  return public.staxis_receive_inventory_delivery_0334_impl(
    p_property_id, p_request_id, p_received_at, p_vendor_name, p_notes, p_lines
  );
end;
$$;

create or replace function public.staxis_record_inventory_loss(
  p_property_id uuid,
  p_request_id uuid,
  p_recorded_at timestamptz,
  p_recorded_by text,
  p_item_id uuid,
  p_expected_stock numeric,
  p_quantity numeric,
  p_reason text,
  p_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and (
    not public.staxis_user_can_manage_inventory_operations(p_property_id)
    or not public.mfa_verified_or_grace()
  ) then
    raise exception 'not authorized to record inventory loss for this property'
      using errcode = '42501';
  end if;
  perform public.staxis_require_inventory_section(p_property_id);
  return public.staxis_record_inventory_loss_0334_impl(
    p_property_id, p_request_id, p_recorded_at, p_recorded_by,
    p_item_id, p_expected_stock, p_quantity, p_reason, p_notes
  );
end;
$$;

create or replace function public.staxis_correct_inventory_delivery(
  p_property_id uuid,
  p_request_id uuid,
  p_corrected_at timestamptz,
  p_corrected_by text,
  p_reason text,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and (
    not public.staxis_user_can_mutate_property(p_property_id)
    or not public.staxis_user_can_view_inventory_financials(p_property_id)
    or not public.mfa_verified_or_grace()
  ) then
    raise exception 'not authorized to correct inventory delivery for this property'
      using errcode = '42501';
  end if;
  perform public.staxis_require_inventory_section(p_property_id);
  return public.staxis_correct_inventory_delivery_0334_impl(
    p_property_id, p_request_id, p_corrected_at, p_corrected_by, p_reason, p_lines
  );
end;
$$;

do $archive_wrapper$
begin
  if to_regprocedure(
    'public.staxis_verify_legacy_archived_inventory_zero_0394_impl(uuid,uuid,uuid,timestamp with time zone,text,text)'
  ) is null then
    alter function public.staxis_verify_legacy_archived_inventory_zero(
      uuid,uuid,uuid,timestamptz,text,text
    ) rename to staxis_verify_legacy_archived_inventory_zero_0394_impl;
  end if;
end
$archive_wrapper$;

revoke all on function public.staxis_verify_legacy_archived_inventory_zero_0394_impl(
  uuid,uuid,uuid,timestamptz,text,text
) from public, anon, authenticated, service_role;

create or replace function public.staxis_verify_legacy_archived_inventory_zero(
  p_property_id uuid,
  p_request_id uuid,
  p_item_id uuid,
  p_expected_archived_at timestamptz,
  p_verified_by text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and (
    not public.staxis_user_can_mutate_property(p_property_id)
    or not public.staxis_user_can_view_inventory_financials(p_property_id)
    or not public.mfa_verified_or_grace()
  ) then
    raise exception 'not authorized to verify archived inventory for this property'
      using errcode = '42501';
  end if;
  perform public.staxis_require_inventory_section(p_property_id);
  return public.staxis_verify_legacy_archived_inventory_zero_0394_impl(
    p_property_id, p_request_id, p_item_id, p_expected_archived_at,
    p_verified_by, p_reason
  );
end;
$$;

revoke all on function public.staxis_save_inventory_count(
  uuid,uuid,timestamptz,text,jsonb
) from public, anon;
revoke all on function public.staxis_receive_inventory_delivery(
  uuid,uuid,timestamptz,text,text,jsonb
) from public, anon;
revoke all on function public.staxis_record_inventory_loss(
  uuid,uuid,timestamptz,text,uuid,numeric,numeric,text,text
) from public, anon;
revoke all on function public.staxis_correct_inventory_delivery(
  uuid,uuid,timestamptz,text,text,jsonb
) from public, anon;
revoke all on function public.staxis_verify_legacy_archived_inventory_zero(
  uuid,uuid,uuid,timestamptz,text,text
) from public, anon;
grant execute on function public.staxis_save_inventory_count(
  uuid,uuid,timestamptz,text,jsonb
) to authenticated, service_role;
grant execute on function public.staxis_receive_inventory_delivery(
  uuid,uuid,timestamptz,text,text,jsonb
) to authenticated, service_role;
grant execute on function public.staxis_record_inventory_loss(
  uuid,uuid,timestamptz,text,uuid,numeric,numeric,text,text
) to authenticated, service_role;
grant execute on function public.staxis_correct_inventory_delivery(
  uuid,uuid,timestamptz,text,text,jsonb
) to authenticated, service_role;
grant execute on function public.staxis_verify_legacy_archived_inventory_zero(
  uuid,uuid,uuid,timestamptz,text,text
) to authenticated, service_role;

-- Private Communications data is served only by routes that first resolve an
-- explicit local hotel standing and conversation membership. The permissive
-- property-wide policies from 0290 cannot express DM/channel membership and,
-- after normalized company grants were introduced, would also admit read-only
-- company actors. Remove the PostgREST bypass for all route-backed comms data.
drop policy if exists comms_acknowledgements_select_tenant on public.comms_acknowledgements;
drop policy if exists comms_conversations_select_tenant on public.comms_conversations;
drop policy if exists comms_log_entries_select_tenant on public.comms_log_entries;
drop policy if exists comms_log_replies_select_tenant on public.comms_log_replies;
drop policy if exists comms_members_select_tenant on public.comms_members;
drop policy if exists comms_messages_select_tenant on public.comms_messages;
drop policy if exists comms_presence_select_tenant on public.comms_presence;
drop policy if exists comms_reactions_select_tenant on public.comms_reactions;
drop policy if exists comms_tasks_select_tenant on public.comms_tasks;
drop policy if exists schedule_templates_select_mgr on public.schedule_templates;
drop policy if exists schedule_week_signoffs_select_mgr on public.schedule_week_signoffs;

do $comms_browser_lockdown$
declare
  v_table text;
begin
  foreach v_table in array array[
    'comms_acknowledgements', 'comms_conversations', 'comms_log_entries',
    'comms_log_replies', 'comms_members', 'comms_messages', 'comms_presence',
    'comms_reactions', 'comms_tasks', 'schedule_templates',
    'schedule_week_signoffs'
  ]
  loop
    execute format('drop policy if exists %I on public.%I',
      v_table || '_deny_browser_select', v_table);
    execute format(
      'create policy %I on public.%I for select to anon, authenticated using (false)',
      v_table || '_deny_browser_select', v_table
    );
    execute format('revoke select on public.%I from anon, authenticated', v_table);
    execute format('grant select, insert, update, delete on public.%I to service_role', v_table);
  end loop;
end
$comms_browser_lockdown$;

insert into public.applied_migrations(version, description)
values (
  '0394',
  'Authoritative browser/RPC boundary, read-only company finance drill-down, private Communications route-only reads, and immediate active platform-admin RLS'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
