-- 0331: Enforce the Inventory financial boundary in Postgres itself.
--
-- The browser deliberately selected cost-free projections for line staff, but
-- the underlying tables still had table-wide SELECT.  A property member could
-- therefore ask PostgREST for unit_cost / total_cost / variance_value directly.
-- Budgets and allocation sections likewise used the old all-members policy.
-- Keep operational inventory readable while moving every dollar field behind
-- a finance-gated server hydration endpoint.

begin;

do $$
begin
  if to_regprocedure('public.staxis_user_can_view_inventory_financials(uuid)') is null then
    raise exception '0331 requires inventory financial capability helper from migration 0324';
  end if;
  if to_regclass('public.inventory_budgets') is null
     or to_regclass('public.inventory_budget_sections') is null
  then
    raise exception '0331 requires inventory budget tables';
  end if;
end
$$;

-- Match the API finance gate inside authenticated inventory RPCs too.  Only
-- an explicit JSON boolean false disables Financials; null/missing/non-false
-- retains the product's default-on section semantics.  Service role remains
-- available because server routes prove end-user authority before calling it.
create or replace function public.staxis_user_can_view_inventory_financials(p_property_id uuid)
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
      join public.properties p on p.id = p_property_id
      where a.data_user_id = auth.uid()
        and coalesce(p.enabled_sections->'financials', 'true'::jsonb) <> 'false'::jsonb
        and (
          a.role = 'admin'
          or (
            a.role in ('owner', 'general_manager')
            and p_property_id = any(a.property_access)
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
    );
$$;

revoke all on function public.staxis_user_can_view_inventory_financials(uuid)
  from public, anon;
grant execute on function public.staxis_user_can_view_inventory_financials(uuid)
  to authenticated, service_role;

drop policy if exists "owner rw inventory_budgets" on public.inventory_budgets;
drop policy if exists "inventory finance managers rw budgets" on public.inventory_budgets;
create policy "inventory finance managers rw budgets"
  on public.inventory_budgets
  for all to authenticated
  using (
    public.mfa_verified_or_grace()
    and public.staxis_user_can_view_inventory_financials(property_id)
  )
  with check (
    public.mfa_verified_or_grace()
    and public.staxis_user_can_view_inventory_financials(property_id)
  );

drop policy if exists "owner rw inventory_budget_sections" on public.inventory_budget_sections;
drop policy if exists "inventory finance managers rw budget sections" on public.inventory_budget_sections;
create policy "inventory finance managers rw budget sections"
  on public.inventory_budget_sections
  for all to authenticated
  using (
    public.mfa_verified_or_grace()
    and public.staxis_user_can_view_inventory_financials(property_id)
  )
  with check (
    public.mfa_verified_or_grace()
    and public.staxis_user_can_view_inventory_financials(property_id)
  );

-- Custom inventory tabs are operational configuration. Everyone assigned to
-- the hotel may read them, but mutations must mirror the same
-- manage_inventory_orders decision that gates the tab editor in the browser.
-- The capability has no manager floor: hotel roles are allowed by default and
-- an Access-grid `allowed=false` row removes the write permission. Explicitly
-- disabling Inventory removes it for every authenticated role, including admin,
-- matching the section gate on inventory API routes.
create or replace function public.staxis_user_can_manage_inventory_operations(p_property_id uuid)
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
      join public.properties p on p.id = p_property_id
      where a.data_user_id = auth.uid()
        and a.active is true
        and coalesce(p.enabled_sections->'inventory', 'true'::jsonb) <> 'false'::jsonb
        and (
          a.role = 'admin'
          or (
            p_property_id = any(coalesce(a.property_access, '{}'::uuid[]))
            and (
              -- `staff` is a legacy role that the Access grid cannot target;
              -- the shared TypeScript resolver therefore always uses its
              -- default grant and ignores override rows for this alias.
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
    );
$$;

revoke all on function public.staxis_user_can_manage_inventory_operations(uuid)
  from public, anon;
grant execute on function public.staxis_user_can_manage_inventory_operations(uuid)
  to authenticated, service_role;

drop policy if exists "owner rw inventory_custom_categories"
  on public.inventory_custom_categories;
drop policy if exists inventory_custom_categories_property_select
  on public.inventory_custom_categories;
drop policy if exists inventory_custom_categories_manage_insert
  on public.inventory_custom_categories;
drop policy if exists inventory_custom_categories_manage_update
  on public.inventory_custom_categories;
drop policy if exists inventory_custom_categories_manage_delete
  on public.inventory_custom_categories;

create policy inventory_custom_categories_property_select
  on public.inventory_custom_categories
  for select to authenticated
  using (
    public.user_owns_property(property_id)
    and public.mfa_verified_or_grace()
  );

create policy inventory_custom_categories_manage_insert
  on public.inventory_custom_categories
  for insert to authenticated
  with check (
    public.staxis_user_can_manage_inventory_operations(property_id)
    and public.mfa_verified_or_grace()
  );

create policy inventory_custom_categories_manage_update
  on public.inventory_custom_categories
  for update to authenticated
  using (
    public.staxis_user_can_manage_inventory_operations(property_id)
    and public.mfa_verified_or_grace()
  )
  with check (
    public.staxis_user_can_manage_inventory_operations(property_id)
    and public.mfa_verified_or_grace()
  );

create policy inventory_custom_categories_manage_delete
  on public.inventory_custom_categories
  for delete to authenticated
  using (
    public.staxis_user_can_manage_inventory_operations(property_id)
    and public.mfa_verified_or_grace()
  );

-- Remove table-wide SELECT, then grant only the operational projections used
-- by the Inventory board.  PostgreSQL checks column privileges before RLS, so
-- even an owner/GM cannot bypass the finance API with a hand-written REST
-- query; authorized money is hydrated by the service route below.  Explicit
-- service-role grants keep server accounting and close workflows unchanged.
revoke select on public.inventory from public, anon, authenticated;
grant select (
  id, property_id, created_at, created_by, archived_at, archived_by,
  name, category, custom_category_id, current_stock, set_aside, par_level,
  reorder_at, unit, notes, updated_at, usage_per_checkout,
  usage_per_stayover, reorder_lead_days, vendor_name, vendor_id,
  last_ordered_at, last_alerted_at, last_counted_at,
  opening_adjustment_quantity, opening_adjustment_at,
  opening_adjustment_request_id, pack_size, case_unit
) on public.inventory to authenticated;
grant select on public.inventory to service_role;

revoke select on public.inventory_counts from public, anon, authenticated;
grant select (
  id, property_id, activity_sequence, count_session_id, item_id, item_name,
  counted_stock, estimated_stock, variance, counted_at, counted_by, notes,
  created_at, recorded_by_user_id, recorded_by_name
) on public.inventory_counts to authenticated;
grant select on public.inventory_counts to service_role;

revoke select on public.inventory_orders from public, anon, authenticated;
grant select (
  id, property_id, activity_sequence, item_id, item_name, quantity,
  quantity_cases, vendor_name, ordered_at, received_at, notes, created_at,
  entry_kind, corrects_order_id, correction_event_id, request_id,
  recorded_by_user_id, recorded_by_name
) on public.inventory_orders to authenticated;
grant select on public.inventory_orders to service_role;

revoke select on public.inventory_discards from public, anon, authenticated;
grant select (
  id, property_id, activity_sequence, item_id, item_name, quantity, reason,
  discarded_at, discarded_by, notes, created_at, request_id, expected_stock,
  stock_before, stock_after, recorded_by_user_id
) on public.inventory_discards to authenticated;
grant select on public.inventory_discards to service_role;

revoke select on public.inventory_reconciliations from public, anon, authenticated;
grant select (
  id, property_id, item_id, item_name, reconciled_at, physical_count,
  system_estimate, discards_since_last, unaccounted_variance, reconciled_by,
  notes, created_at, recorded_by_user_id, recorded_by_name
) on public.inventory_reconciliations to authenticated;
grant select on public.inventory_reconciliations to service_role;

-- Reconciliations are immutable derived evidence and have no active browser
-- writer.  Do not leave a legacy insert grant that could fabricate either the
-- operational variance or its hidden dollar value.
revoke insert, update, delete on public.inventory_reconciliations
  from anon, authenticated;

-- Metadata edits remain direct browser writes for latency/realtime behavior.
-- Guard the three cost-bearing item columns at the row boundary so a line
-- staff caller cannot overwrite hidden money while owner/GM Add/Edit keeps
-- working without a second write path.  Delivery RPCs already apply this same
-- helper and send an explicit null cost for non-financial receivers.
create or replace function public.staxis_guard_inventory_financial_write()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  -- Check the actual PostgREST database role, not only the JWT GUC. Migration
  -- tooling and privileged repair sessions may carry an end-user JWT claim
  -- while deliberately writing as postgres/service role. Direct browser DML
  -- runs with current_user=authenticated and is always covered here.
  if current_user = 'authenticated'
     and not public.staxis_user_can_view_inventory_financials(new.property_id)
     and (
       (tg_op = 'INSERT' and (
         new.unit_cost is not null
         or new.opening_adjustment_unit_cost is not null
         or new.delivery_baseline_unit_cost is not null
       ))
       or
       (tg_op = 'UPDATE' and (
         new.unit_cost is distinct from old.unit_cost
         or new.opening_adjustment_unit_cost is distinct from old.opening_adjustment_unit_cost
         or new.delivery_baseline_unit_cost is distinct from old.delivery_baseline_unit_cost
       ))
     )
  then
    raise exception 'not authorized to write inventory financial fields for this property'
      using errcode = '42501';
  end if;
  return new;
end
$$;

revoke all on function public.staxis_guard_inventory_financial_write()
  from public, anon, authenticated, service_role;

drop trigger if exists inventory_guard_financial_write on public.inventory;
create trigger inventory_guard_financial_write
  before insert or update on public.inventory
  for each row execute function public.staxis_guard_inventory_financial_write();

-- One service-only statement returns a transactionally consistent, id-keyed
-- financial overlay for the operational rows.  The current-month subtotal is
-- evaluated in the hotel's local calendar and follows each receipt's terminal
-- correction (a void is known $0; an unresolved live cost makes complete=false).
create or replace function public.staxis_list_inventory_financial_evidence(p_property_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_timezone text;
  v_month_start_at timestamptz;
  v_month_end_at timestamptz;
  v_result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'inventory financial evidence is service-role only'
      using errcode = '42501';
  end if;

  select nullif(trim(p.timezone), '') into v_timezone
  from public.properties p
  where p.id = p_property_id;
  if not found then
    raise exception 'property not found' using errcode = 'P0002';
  end if;
  if v_timezone is null or not exists (
    select 1 from pg_catalog.pg_timezone_names z where z.name = v_timezone
  ) then
    raise exception 'property timezone is missing or invalid' using errcode = '22023';
  end if;

  v_month_start_at := date_trunc('month', now() at time zone v_timezone)
    at time zone v_timezone;
  v_month_end_at := (date_trunc('month', now() at time zone v_timezone) + interval '1 month')
    at time zone v_timezone;

  with current_receipts as (
    select
      root.id,
      case
        when tip.correction_kind = 'void' then 0::numeric
        when tip.id is not null then tip.corrected_total_cost
        else coalesce(root.total_cost, root.quantity * root.unit_cost)
      end as effective_total
    from public.inventory_orders root
    left join lateral (
      select c.id, c.correction_kind, c.corrected_total_cost
      from public.inventory_delivery_corrections c
      where c.property_id = p_property_id
        and c.original_order_id = root.id
        and not exists (
          select 1 from public.inventory_delivery_corrections child
          where child.property_id = c.property_id
            and child.prior_correction_id = c.id
        )
      limit 1
    ) tip on true
    where root.property_id = p_property_id
      and root.entry_kind = 'receipt'
      and root.received_at >= v_month_start_at
      and root.received_at < v_month_end_at
  ), month_spend as (
    select
      coalesce(sum(effective_total) filter (where effective_total is not null), 0)::numeric as total,
      coalesce(bool_and(effective_total is not null and effective_total >= 0), true) as complete
    from current_receipts
  )
  select jsonb_build_object(
    'inventory', coalesce((
      select jsonb_object_agg(i.id::text, jsonb_build_object(
        'unitCost', i.unit_cost,
        'openingAdjustmentUnitCost', i.opening_adjustment_unit_cost
      ) order by i.id)
      from public.inventory i where i.property_id = p_property_id
    ), '{}'::jsonb),
    'counts', coalesce((
      select jsonb_object_agg(c.id::text, jsonb_build_object(
        'unitCost', c.unit_cost,
        'varianceValue', c.variance_value
      ) order by c.id)
      from public.inventory_counts c where c.property_id = p_property_id
    ), '{}'::jsonb),
    'orders', coalesce((
      select jsonb_object_agg(o.id::text, jsonb_build_object(
        'unitCost', o.unit_cost,
        'totalCost', o.total_cost
      ) order by o.id)
      from public.inventory_orders o where o.property_id = p_property_id
    ), '{}'::jsonb),
    'discards', coalesce((
      select jsonb_object_agg(d.id::text, jsonb_build_object(
        'unitCost', d.unit_cost,
        'costValue', d.cost_value
      ) order by d.id)
      from public.inventory_discards d where d.property_id = p_property_id
    ), '{}'::jsonb),
    'currentMonthSpend', jsonb_build_object(
      'total', ms.total,
      'complete', ms.complete
    )
  ) into v_result
  from month_spend ms;

  return v_result;
end
$$;

revoke all on function public.staxis_list_inventory_financial_evidence(uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_list_inventory_financial_evidence(uuid)
  to service_role;

insert into public.applied_migrations(version, description)
values (
  '0331',
  'Inventory financial boundary: operational-only browser projections, service-only cost hydration, manager-floor/section-aware finance predicate, guarded item cost writes, finance-only budget configuration, and capability-gated custom-tab mutation.'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
