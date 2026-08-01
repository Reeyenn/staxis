-- Bound the finance-only overlay used by the live Inventory board.
--
-- The original function aggregated every count, receipt and discard a hotel
-- had ever recorded. Its response therefore grew forever even though the
-- board consumes a bounded recent operational window. Keep current-month
-- spend exact and unchanged, while limiting the id-keyed hydration maps to the
-- same recent-history scale the UI can use.

begin;

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
      from (
        select row.id, row.unit_cost, row.opening_adjustment_unit_cost
        from public.inventory row
        where row.property_id = p_property_id
          and row.archived_at is null
        order by row.id
        limit 2000
      ) i
    ), '{}'::jsonb),
    'counts', coalesce((
      select jsonb_object_agg(c.id::text, jsonb_build_object(
        'unitCost', c.unit_cost,
        'varianceValue', c.variance_value
      ) order by c.id)
      from (
        select row.id, row.unit_cost, row.variance_value
        from public.inventory_counts row
        where row.property_id = p_property_id
        order by row.counted_at desc, row.id desc
        limit 2000
      ) c
    ), '{}'::jsonb),
    'orders', coalesce((
      select jsonb_object_agg(o.id::text, jsonb_build_object(
        'unitCost', o.unit_cost,
        'totalCost', o.total_cost
      ) order by o.id)
      from (
        select row.id, row.unit_cost, row.total_cost
        from public.inventory_orders row
        where row.property_id = p_property_id
          and row.entry_kind = 'receipt'
        order by row.received_at desc, row.id desc
        limit 2000
      ) o
    ), '{}'::jsonb),
    'discards', coalesce((
      select jsonb_object_agg(d.id::text, jsonb_build_object(
        'unitCost', d.unit_cost,
        'costValue', d.cost_value
      ) order by d.id)
      from (
        select row.id, row.unit_cost, row.cost_value
        from public.inventory_discards row
        where row.property_id = p_property_id
        order by row.discarded_at desc, row.id desc
        limit 2000
      ) d
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
  '0413',
  'Bound live inventory financial hydration maps to stable recent windows while preserving exact property-local current-month receipt accounting.'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
