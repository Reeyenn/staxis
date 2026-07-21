-- 0334: Make section switches a database authorization boundary for the
-- browser-maintained Maintenance, Staff, and Inventory records.
--
-- Server routes already hide disabled sections, but browser Supabase clients
-- can write operational rows and invoke atomic Inventory RPCs directly. RLS
-- and RPC entry points therefore have to enforce the same property section
-- state. Staff roster SELECT remains
-- deliberately section-independent because schedules, assignments, and shared
-- operational surfaces need it even when the Staff product page is disabled.

begin;

do $$
begin
  if to_regclass('public.properties') is null
     or to_regclass('public.work_orders') is null
     or to_regclass('public.preventive_tasks') is null
     or to_regclass('public.staff') is null
     or to_regclass('public.property_shift_presets') is null
     or to_regclass('public.scheduled_shifts') is null
     or to_regclass('public.time_off_requests') is null
     or to_regclass('public.week_publications') is null
     or to_regclass('public.capability_overrides') is null
     or to_regclass('public.inventory') is null
     or to_regclass('public.inventory_counts') is null
     or to_regclass('public.inventory_orders') is null
     or to_regclass('public.inventory_discards') is null
     or to_regclass('public.inventory_reconciliations') is null
     or to_regclass('public.inventory_custom_categories') is null
     or to_regclass('public.inventory_budgets') is null
     or to_regclass('public.inventory_budget_sections') is null
     or to_regclass('public.inventory_rate_predictions') is null
  then
    raise exception '0334 requires properties, maintenance, staff, inventory, and capability tables';
  end if;
  if to_regprocedure('public.user_owns_property(uuid)') is null
     or to_regprocedure('public.mfa_verified_or_grace()') is null
     or to_regprocedure('public.staxis_user_can_manage_staff(uuid)') is null
     or to_regprocedure('public.staxis_user_can_manage_inventory_operations(uuid)') is null
     or to_regprocedure('public.staxis_user_can_view_inventory_financials(uuid)') is null
     or to_regprocedure('public.staxis_save_inventory_count(uuid,uuid,timestamp with time zone,text,jsonb)') is null
     or to_regprocedure('public.staxis_receive_inventory_delivery(uuid,uuid,timestamp with time zone,text,text,jsonb)') is null
     or to_regprocedure('public.staxis_record_inventory_loss(uuid,uuid,timestamp with time zone,text,uuid,numeric,numeric,text,text)') is null
     or to_regprocedure('public.staxis_list_inventory_delivery_corrections(uuid,uuid[],boolean)') is null
     or to_regprocedure('public.staxis_correct_inventory_delivery(uuid,uuid,timestamp with time zone,text,text,jsonb)') is null
  then
    raise exception '0334 requires existing tenant, MFA, Staff, and Inventory authorization functions';
  end if;
end
$$;

-- Read a section flag without depending on the caller's properties RLS. A
-- genuinely NULL map and a missing key retain the legacy default-ON behavior.
-- Every explicit value must be the JSON boolean true; false, JSON null,
-- strings, numbers, arrays, malformed map shapes, and unknown section names
-- fail closed. Internal service-role workflows remain section-independent.
create or replace function public.staxis_property_section_enabled(
  p_property_id uuid,
  p_section text
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(auth.role(), '') = 'service_role'
    or exists (
      select 1
      from public.properties p
      where p.id = p_property_id
        and p_section = any(array[
          'staxis', 'dashboard', 'housekeeping', 'communications',
          'maintenance', 'inventory', 'staff', 'financials'
        ]::text[])
        and (
          p.enabled_sections is null
          or (
            jsonb_typeof(p.enabled_sections) = 'object'
            and (
              not (p.enabled_sections ? p_section)
              or p.enabled_sections -> p_section = 'true'::jsonb
            )
          )
        )
    );
$$;

revoke all on function public.staxis_property_section_enabled(uuid, text)
  from public, anon;
grant execute on function public.staxis_property_section_enabled(uuid, text)
  to authenticated, service_role;

comment on function public.staxis_property_section_enabled(uuid, text) is
  'Strict RLS-safe section predicate. SQL NULL maps and missing keys default ON; explicit keys require JSON true. Service role bypasses section switches.';

-- manage_equipment has no role floor: every recognized hotel role with
-- property access is allowed by default, a per-hotel allowed=false override
-- removes that role, the legacy staff alias keeps its non-targetable default,
-- and Staxis admins remain allowed. A disabled Maintenance section blocks all
-- authenticated users, including admins, just like the application gate.
create or replace function public.staxis_user_can_manage_equipment(
  p_property_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(auth.role(), '') = 'service_role'
    or (
      public.staxis_property_section_enabled(p_property_id, 'maintenance')
      and exists (
        select 1
        from public.accounts a
        where a.data_user_id = auth.uid()
          and a.active is true
          and (
            a.role = 'admin'
            or (
              a.role in (
                'owner', 'general_manager', 'front_desk',
                'housekeeping', 'maintenance', 'staff'
              )
              and p_property_id = any(coalesce(a.property_access, '{}'::uuid[]))
              and (
                a.role = 'staff'
                or not exists (
                  select 1
                  from public.capability_overrides o
                  where o.property_id = p_property_id
                    and o.capability = 'manage_equipment'
                    and o.role = a.role
                    and o.allowed = false
                )
              )
            )
          )
      )
    );
$$;

revoke all on function public.staxis_user_can_manage_equipment(uuid)
  from public, anon;
grant execute on function public.staxis_user_can_manage_equipment(uuid)
  to authenticated, service_role;

comment on function public.staxis_user_can_manage_equipment(uuid) is
  'RLS predicate for preventive-maintenance mutations: active property access, Maintenance enabled, and no manage_equipment deny override; service role bypasses.';

-- Staff writes already use the manager-floor manage_team predicate. Add only
-- the Staff section boundary; keep roster reads on their existing shared-data
-- policy and preserve service-role workflows.
create or replace function public.staxis_user_can_manage_staff(p_property_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(auth.role(), '') = 'service_role'
    or (
      public.staxis_property_section_enabled(p_property_id, 'staff')
      and exists (
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
      )
    );
$$;

revoke all on function public.staxis_user_can_manage_staff(uuid)
  from public, anon;
grant execute on function public.staxis_user_can_manage_staff(uuid)
  to authenticated, service_role;

-- Inventory operational mutations have the same everyone-by-default
-- capability semantics as Equipment: a recognized hotel role with property
-- access is allowed unless its role has an explicit deny override. Compose the
-- strict section helper so malformed explicit flags fail closed instead of
-- inheriting the older "anything except false" behavior.
create or replace function public.staxis_user_can_manage_inventory_operations(
  p_property_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(auth.role(), '') = 'service_role'
    or (
      public.staxis_property_section_enabled(p_property_id, 'inventory')
      and exists (
        select 1
        from public.accounts a
        where a.data_user_id = auth.uid()
          and a.active is true
          and (
            a.role = 'admin'
            or (
              a.role in (
                'owner', 'general_manager', 'front_desk',
                'housekeeping', 'maintenance', 'staff'
              )
              and p_property_id = any(coalesce(a.property_access, '{}'::uuid[]))
              and (
                a.role = 'staff'
                or not exists (
                  select 1
                  from public.capability_overrides o
                  where o.property_id = p_property_id
                    and o.capability = 'manage_inventory_orders'
                    and o.role = a.role
                    and o.allowed = false
                )
              )
            )
          )
      )
    );
$$;

revoke all on function public.staxis_user_can_manage_inventory_operations(uuid)
  from public, anon;
grant execute on function public.staxis_user_can_manage_inventory_operations(uuid)
  to authenticated, service_role;

-- Inventory money is visible only when both owning product sections are
-- available. Keep the existing manager floor and view_financials deny
-- override, while making explicit JSON null/non-boolean section values fail
-- closed. The service role continues to support already-authorized APIs.
create or replace function public.staxis_user_can_view_inventory_financials(
  p_property_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(auth.role(), '') = 'service_role'
    or (
      public.staxis_property_section_enabled(p_property_id, 'inventory')
      and public.staxis_property_section_enabled(p_property_id, 'financials')
      and exists (
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
                  and o.capability = 'view_financials'
                  and o.role = a.role
                  and o.allowed = false
              )
            )
          )
      )
    );
$$;

revoke all on function public.staxis_user_can_view_inventory_financials(uuid)
  from public, anon;
grant execute on function public.staxis_user_can_view_inventory_financials(uuid)
  to authenticated, service_role;

-- Staff scheduling rows are shared by the manager grid and My Shifts, so all
-- hotel members retain reads while Staff is enabled. Server-side scheduling
-- workflows use service_role and keep full table access; authenticated writes
-- remain on the existing deny-all policies.
alter policy property_shift_presets_select on public.property_shift_presets
  using (
    public.user_owns_property(property_id)
    and public.mfa_verified_or_grace()
    and public.staxis_property_section_enabled(property_id, 'staff')
  );
alter policy scheduled_shifts_select on public.scheduled_shifts
  using (
    public.user_owns_property(property_id)
    and public.mfa_verified_or_grace()
    and public.staxis_property_section_enabled(property_id, 'staff')
  );
alter policy time_off_requests_select on public.time_off_requests
  using (
    public.user_owns_property(property_id)
    and public.mfa_verified_or_grace()
    and public.staxis_property_section_enabled(property_id, 'staff')
  );
alter policy week_publications_select on public.week_publications
  using (
    public.user_owns_property(property_id)
    and public.mfa_verified_or_grace()
    and public.staxis_property_section_enabled(property_id, 'staff')
  );

grant select, insert, update, delete on public.property_shift_presets to service_role;
grant select, insert, update, delete on public.scheduled_shifts to service_role;
grant select, insert, update, delete on public.time_off_requests to service_role;
grant select, insert, update, delete on public.week_publications to service_role;

-- Direct browser Inventory data must disappear with the section. Preserve the
-- existing property/MFA and column-privacy boundaries; this adds only the
-- strict product-section predicate to every active operational read/write
-- policy. Service-role APIs bypass RLS as before.
alter policy "owner read inventory" on public.inventory
  using (
    public.user_owns_property(property_id)
    and public.mfa_verified_or_grace()
    and public.staxis_property_section_enabled(property_id, 'inventory')
  );
alter policy "owner insert inventory" on public.inventory
  with check (
    public.user_owns_property(property_id)
    and public.mfa_verified_or_grace()
    and public.staxis_property_section_enabled(property_id, 'inventory')
  );
alter policy "owner update inventory" on public.inventory
  using (
    public.user_owns_property(property_id)
    and public.mfa_verified_or_grace()
    and public.staxis_property_section_enabled(property_id, 'inventory')
  )
  with check (
    public.user_owns_property(property_id)
    and public.mfa_verified_or_grace()
    and public.staxis_property_section_enabled(property_id, 'inventory')
  );
alter policy "owner read inventory_counts" on public.inventory_counts
  using (
    public.user_owns_property(property_id)
    and public.mfa_verified_or_grace()
    and public.staxis_property_section_enabled(property_id, 'inventory')
  );
alter policy "owner read inventory_orders" on public.inventory_orders
  using (
    public.user_owns_property(property_id)
    and public.mfa_verified_or_grace()
    and public.staxis_property_section_enabled(property_id, 'inventory')
  );
alter policy "owner read inventory_discards" on public.inventory_discards
  using (
    public.user_owns_property(property_id)
    and public.mfa_verified_or_grace()
    and public.staxis_property_section_enabled(property_id, 'inventory')
  );
alter policy "owner read inventory_reconciliations" on public.inventory_reconciliations
  using (
    public.user_owns_property(property_id)
    and public.mfa_verified_or_grace()
    and public.staxis_property_section_enabled(property_id, 'inventory')
  );
alter policy inventory_custom_categories_property_select
  on public.inventory_custom_categories
  using (
    public.user_owns_property(property_id)
    and public.mfa_verified_or_grace()
    and public.staxis_property_section_enabled(property_id, 'inventory')
  );
alter policy "owner read inventory_rate_predictions"
  on public.inventory_rate_predictions
  using (
    public.user_owns_property(property_id)
    and public.mfa_verified_or_grace()
    and public.staxis_property_section_enabled(property_id, 'inventory')
  );

-- Unauthenticated callers need neither table privileges nor policies. An
-- authenticated browser gets only the DML the RLS policies below authorize;
-- service-role clients keep explicit privileges in addition to BYPASSRLS.
-- Explicitly re-enable RLS because work_orders was rebuilt during a legacy
-- table cutover; a recreated table does not inherit its predecessor's RLS
-- bit even when a later migration restores a policy.
alter table public.work_orders enable row level security;
alter table public.preventive_tasks enable row level security;
alter table public.staff enable row level security;

revoke all privileges on public.work_orders from public, anon;
grant select, insert, update, delete on public.work_orders
  to authenticated, service_role;

drop policy if exists "owner rw work_orders" on public.work_orders;
drop policy if exists work_orders_property_maintenance_rw on public.work_orders;
create policy work_orders_property_maintenance_rw
  on public.work_orders
  for all
  to authenticated
  using (
    public.user_owns_property(property_id)
    and public.mfa_verified_or_grace()
    and public.staxis_property_section_enabled(property_id, 'maintenance')
  )
  with check (
    public.user_owns_property(property_id)
    and public.mfa_verified_or_grace()
    and public.staxis_property_section_enabled(property_id, 'maintenance')
  );

revoke all privileges on public.preventive_tasks from public, anon;
grant select, insert, update, delete on public.preventive_tasks
  to authenticated, service_role;

drop policy if exists "owner rw preventive_tasks" on public.preventive_tasks;
drop policy if exists preventive_tasks_property_maintenance_select on public.preventive_tasks;
drop policy if exists preventive_tasks_manage_insert on public.preventive_tasks;
drop policy if exists preventive_tasks_manage_update on public.preventive_tasks;
drop policy if exists preventive_tasks_manage_delete on public.preventive_tasks;

create policy preventive_tasks_property_maintenance_select
  on public.preventive_tasks
  for select
  to authenticated
  using (
    public.user_owns_property(property_id)
    and public.mfa_verified_or_grace()
    and public.staxis_property_section_enabled(property_id, 'maintenance')
  );

create policy preventive_tasks_manage_insert
  on public.preventive_tasks
  for insert
  to authenticated
  with check (
    public.mfa_verified_or_grace()
    and public.staxis_user_can_manage_equipment(property_id)
  );

create policy preventive_tasks_manage_update
  on public.preventive_tasks
  for update
  to authenticated
  using (
    public.mfa_verified_or_grace()
    and public.staxis_user_can_manage_equipment(property_id)
  )
  with check (
    public.mfa_verified_or_grace()
    and public.staxis_user_can_manage_equipment(property_id)
  );

create policy preventive_tasks_manage_delete
  on public.preventive_tasks
  for delete
  to authenticated
  using (
    public.mfa_verified_or_grace()
    and public.staxis_user_can_manage_equipment(property_id)
  );

-- Migration 0332 intentionally controls staff SELECT at column granularity.
-- Touch only mutation privileges here so sensitive roster columns stay behind
-- the manager-gated server hydration routes.
revoke insert, update, delete on public.staff from public, anon;
grant insert, update, delete on public.staff to authenticated, service_role;

-- The five browser RPCs below are intentionally SECURITY DEFINER so a count,
-- delivery, loss, or correction can update its append-only evidence atomically.
-- Their older bodies authorize property/MFA/capabilities but predate section
-- switches. Rename those audited implementations once, revoke direct access,
-- and restore the public signatures as thin section-gated wrappers. This keeps
-- the large transaction bodies byte-for-byte intact and also blocks idempotent
-- replay/read paths that a table trigger would never see.
create or replace function public.staxis_require_inventory_section(
  p_property_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.staxis_property_section_enabled(p_property_id, 'inventory') then
    raise exception 'inventory section is disabled or unavailable for this property'
      using errcode = '42501';
  end if;
end
$$;

revoke all on function public.staxis_require_inventory_section(uuid)
  from public, anon, authenticated, service_role;

do $migration$
begin
  if to_regprocedure('public.staxis_save_inventory_count_0334_impl(uuid,uuid,timestamp with time zone,text,jsonb)') is null then
    alter function public.staxis_save_inventory_count(uuid,uuid,timestamptz,text,jsonb)
      rename to staxis_save_inventory_count_0334_impl;
  end if;
  if to_regprocedure('public.staxis_receive_inventory_delivery_0334_impl(uuid,uuid,timestamp with time zone,text,text,jsonb)') is null then
    alter function public.staxis_receive_inventory_delivery(uuid,uuid,timestamptz,text,text,jsonb)
      rename to staxis_receive_inventory_delivery_0334_impl;
  end if;
  if to_regprocedure('public.staxis_record_inventory_loss_0334_impl(uuid,uuid,timestamp with time zone,text,uuid,numeric,numeric,text,text)') is null then
    alter function public.staxis_record_inventory_loss(uuid,uuid,timestamptz,text,uuid,numeric,numeric,text,text)
      rename to staxis_record_inventory_loss_0334_impl;
  end if;
  if to_regprocedure('public.staxis_list_inventory_delivery_corrections_0334_impl(uuid,uuid[],boolean)') is null then
    alter function public.staxis_list_inventory_delivery_corrections(uuid,uuid[],boolean)
      rename to staxis_list_inventory_delivery_corrections_0334_impl;
  end if;
  if to_regprocedure('public.staxis_correct_inventory_delivery_0334_impl(uuid,uuid,timestamp with time zone,text,text,jsonb)') is null then
    alter function public.staxis_correct_inventory_delivery(uuid,uuid,timestamptz,text,text,jsonb)
      rename to staxis_correct_inventory_delivery_0334_impl;
  end if;
end
$migration$;

revoke all on function public.staxis_save_inventory_count_0334_impl(
  uuid,uuid,timestamptz,text,jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.staxis_receive_inventory_delivery_0334_impl(
  uuid,uuid,timestamptz,text,text,jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.staxis_record_inventory_loss_0334_impl(
  uuid,uuid,timestamptz,text,uuid,numeric,numeric,text,text
) from public, anon, authenticated, service_role;
revoke all on function public.staxis_list_inventory_delivery_corrections_0334_impl(
  uuid,uuid[],boolean
) from public, anon, authenticated, service_role;
revoke all on function public.staxis_correct_inventory_delivery_0334_impl(
  uuid,uuid,timestamptz,text,text,jsonb
) from public, anon, authenticated, service_role;

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
set search_path = public, pg_temp
as $$
begin
  perform public.staxis_require_inventory_section(p_property_id);
  return public.staxis_save_inventory_count_0334_impl(
    p_property_id, p_request_id, p_counted_at, p_counted_by, p_rows
  );
end
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
set search_path = public, pg_temp
as $$
begin
  perform public.staxis_require_inventory_section(p_property_id);
  return public.staxis_receive_inventory_delivery_0334_impl(
    p_property_id, p_request_id, p_received_at, p_vendor_name, p_notes, p_lines
  );
end
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
set search_path = public, pg_temp
as $$
begin
  perform public.staxis_require_inventory_section(p_property_id);
  return public.staxis_record_inventory_loss_0334_impl(
    p_property_id, p_request_id, p_recorded_at, p_recorded_by,
    p_item_id, p_expected_stock, p_quantity, p_reason, p_notes
  );
end
$$;

create or replace function public.staxis_list_inventory_delivery_corrections(
  p_property_id uuid,
  p_root_order_ids uuid[],
  p_include_financials boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.staxis_require_inventory_section(p_property_id);
  return public.staxis_list_inventory_delivery_corrections_0334_impl(
    p_property_id, p_root_order_ids, p_include_financials
  );
end
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
set search_path = public, pg_temp
as $$
begin
  perform public.staxis_require_inventory_section(p_property_id);
  return public.staxis_correct_inventory_delivery_0334_impl(
    p_property_id, p_request_id, p_corrected_at, p_corrected_by, p_reason, p_lines
  );
end
$$;

revoke all on function public.staxis_save_inventory_count(
  uuid,uuid,timestamptz,text,jsonb
) from public, anon;
grant execute on function public.staxis_save_inventory_count(
  uuid,uuid,timestamptz,text,jsonb
) to authenticated, service_role;
revoke all on function public.staxis_receive_inventory_delivery(
  uuid,uuid,timestamptz,text,text,jsonb
) from public, anon;
grant execute on function public.staxis_receive_inventory_delivery(
  uuid,uuid,timestamptz,text,text,jsonb
) to authenticated, service_role;
revoke all on function public.staxis_record_inventory_loss(
  uuid,uuid,timestamptz,text,uuid,numeric,numeric,text,text
) from public, anon;
grant execute on function public.staxis_record_inventory_loss(
  uuid,uuid,timestamptz,text,uuid,numeric,numeric,text,text
) to authenticated, service_role;
revoke all on function public.staxis_list_inventory_delivery_corrections(
  uuid,uuid[],boolean
) from public, anon;
grant execute on function public.staxis_list_inventory_delivery_corrections(
  uuid,uuid[],boolean
) to authenticated, service_role;
revoke all on function public.staxis_correct_inventory_delivery(
  uuid,uuid,timestamptz,text,text,jsonb
) from public, anon;
grant execute on function public.staxis_correct_inventory_delivery(
  uuid,uuid,timestamptz,text,text,jsonb
) to authenticated, service_role;

insert into public.applied_migrations (version, description)
values (
  '0334',
  'Strict section-aware browser RLS for Maintenance, Staff roster/schedules, and Inventory operational/financial data; atomic Inventory RPC entry gates'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
