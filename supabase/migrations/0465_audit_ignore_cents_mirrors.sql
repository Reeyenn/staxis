-- 0465_audit_ignore_cents_mirrors.sql
--
-- 0463 added GENERATED ALWAYS ... STORED integer-cents mirrors next to the
-- legacy dollar money columns. Three of them landed on public.inventory
-- (unit_cost_cents, opening_adjustment_unit_cost_cents,
-- delivery_baseline_unit_cost_cents). The audit trigger
-- staxis_capture_inventory_audit_event() diffs to_jsonb(old) against
-- to_jsonb(new) minus a static ignore-list, so every price edit since 0463
-- has recorded the derived mirror as its own entry in
-- summary.changedFields: a person reading item history saw
-- "unit_cost_cents" change alongside "unit_cost", twice for the same edit.
--
-- Fix: the derived mirrors join the ignore-list. They can never change
-- independently of their dollar source, so excluding them loses no
-- information. before_state/after_state snapshots still carry them, which
-- is correct: they are true row state.
--
-- This restates the 0326 function verbatim except for the two compare
-- arrays. If you edit the function again, edit THIS file's copy.

create or replace function public.staxis_capture_inventory_audit_event()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_old jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_new jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_property_id uuid;
  v_entity_id uuid;
  v_entity_key text;
  v_source_id text;
  v_action text;
  v_entity_type text;
  v_request_id text;
  v_occurred_at timestamptz;
  v_actor_id uuid;
  v_actor_name text;
  v_summary jsonb := '{}'::jsonb;
  v_details jsonb := '{}'::jsonb;
  v_financial jsonb := '{}'::jsonb;
  v_dedupe text;
  v_changed_fields text[] := '{}'::text[];
  v_compare_old jsonb;
  v_compare_new jsonb;
  v_row jsonb := coalesce(v_new, v_old);
begin
  v_property_id := case when tg_table_name = 'properties'
    then (v_row->>'id')::uuid
    else (v_row->>'property_id')::uuid
  end;
  -- FK cascades do not expose a reliable trigger-depth distinction. Once the
  -- parent property is already gone, this is a whole-property teardown rather
  -- than a manager deleting one configuration row, so there is no surviving
  -- tenant timeline to append to (and the audit FK must not block the cascade).
  if tg_op = 'DELETE' and not exists (
    select 1 from public.properties p where p.id = v_property_id
  ) then
    return old;
  end if;
  v_source_id := coalesce(v_row->>'id', v_row->>'category', v_property_id::text);

  if tg_table_name = 'inventory' then
    v_entity_type := 'item';
    v_entity_id := (v_row->>'id')::uuid;
    v_entity_key := v_entity_id::text;
    if tg_op = 'INSERT' then
      v_action := 'item.created';
      v_actor_id := nullif(v_new->>'created_by', '')::uuid;
      v_occurred_at := (v_new->>'created_at')::timestamptz;
      v_dedupe := 'item:create:' || v_entity_id::text;
    elsif v_old->>'archived_at' is null and v_new->>'archived_at' is not null then
      v_action := 'item.archived';
      v_actor_id := nullif(v_new->>'archived_by', '')::uuid;
      v_occurred_at := (v_new->>'archived_at')::timestamptz;
      v_dedupe := 'item:archive:' || v_entity_id::text;
    else
      -- Stock/timestamp changes are represented by their count, delivery, loss,
      -- correction, or opening-adjustment source event. Metadata changes remain.
      -- The *_cents entries are the 0463 GENERATED mirrors: derived from their
      -- dollar source on every write, so they can never change on their own and
      -- naming them in changedFields would double-report every price edit.
      v_compare_old := v_old - array[
        'updated_at','current_stock','last_counted_at','last_ordered_at','last_alerted_at',
        'opening_adjustment_quantity','opening_adjustment_unit_cost',
        'opening_adjustment_at','opening_adjustment_request_id',
        'unit_cost_cents','opening_adjustment_unit_cost_cents','delivery_baseline_unit_cost_cents'
      ];
      v_compare_new := v_new - array[
        'updated_at','current_stock','last_counted_at','last_ordered_at','last_alerted_at',
        'opening_adjustment_quantity','opening_adjustment_unit_cost',
        'opening_adjustment_at','opening_adjustment_request_id',
        'unit_cost_cents','opening_adjustment_unit_cost_cents','delivery_baseline_unit_cost_cents'
      ];
      select coalesce(array_agg(k order by k), '{}'::text[]) into v_changed_fields
      from (
        select key as k from jsonb_each(v_compare_old)
        union
        select key as k from jsonb_each(v_compare_new)
      ) keys
      where v_compare_old->k is distinct from v_compare_new->k;
      if cardinality(v_changed_fields) = 0 then return new; end if;
      v_action := 'item.updated';
      v_occurred_at := coalesce((v_new->>'updated_at')::timestamptz, clock_timestamp());
    end if;
    v_summary := jsonb_build_object(
      'label', v_row->>'name', 'secondaryLabel', v_row->>'category',
      'quantity', null, 'unit', v_row->>'unit', 'itemCount', null,
      'changedFields', to_jsonb(v_changed_fields)
    );
    v_details := jsonb_build_object(
      'category', v_row->>'category',
      'currentStock', nullif(v_row->>'current_stock', '')::numeric,
      'setAside', coalesce(nullif(v_row->>'set_aside', '')::numeric, 0),
      'archived', v_row->>'archived_at' is not null
    );
    v_financial := jsonb_build_object(
      'unitCostBefore', nullif(v_old->>'unit_cost', '')::numeric,
      'unitCostAfter', nullif(v_new->>'unit_cost', '')::numeric
    );

  elsif tg_table_name = 'inventory_counts' then
    v_action := 'count.saved'; v_entity_type := 'count';
    v_entity_id := (v_new->>'id')::uuid; v_entity_key := v_new->>'item_id';
    v_request_id := v_new->>'count_session_id';
    v_occurred_at := (v_new->>'counted_at')::timestamptz;
    v_actor_id := nullif(v_new->>'recorded_by_user_id', '')::uuid;
    v_actor_name := coalesce(v_new->>'recorded_by_name', v_new->>'counted_by');
    v_dedupe := 'count:' || v_entity_id::text;
    v_summary := jsonb_build_object(
      'label', v_new->>'item_name', 'secondaryLabel', null,
      'quantity', nullif(v_new->>'counted_stock', '')::numeric,
      'unit', (select i.unit from public.inventory i where i.id = (v_new->>'item_id')::uuid and i.property_id = v_property_id),
      'itemCount', null, 'changedFields', '[]'::jsonb
    );
    v_details := jsonb_build_object(
      'itemId', v_new->>'item_id',
      'countedStock', nullif(v_new->>'counted_stock', '')::numeric,
      'estimatedStock', nullif(v_new->>'estimated_stock', '')::numeric,
      'variance', nullif(v_new->>'variance', '')::numeric,
      'notes', v_new->>'notes'
    );
    v_financial := jsonb_build_object(
      'unitCost', nullif(v_new->>'unit_cost', '')::numeric,
      'varianceValue', nullif(v_new->>'variance_value', '')::numeric
    );

  elsif tg_table_name = 'inventory_orders' then
    if coalesce(v_new->>'entry_kind', 'receipt') <> 'receipt' then return new; end if;
    v_action := 'delivery.received'; v_entity_type := 'delivery';
    v_entity_id := (v_new->>'id')::uuid; v_entity_key := v_new->>'item_id';
    v_request_id := v_new->>'request_id';
    v_occurred_at := (v_new->>'received_at')::timestamptz;
    v_actor_id := nullif(v_new->>'recorded_by_user_id', '')::uuid;
    v_actor_name := v_new->>'recorded_by_name';
    v_dedupe := 'delivery:' || v_entity_id::text;
    v_summary := jsonb_build_object(
      'label', v_new->>'item_name', 'secondaryLabel', v_new->>'vendor_name',
      'quantity', nullif(v_new->>'quantity', '')::numeric,
      'unit', (select i.unit from public.inventory i where i.id = (v_new->>'item_id')::uuid and i.property_id = v_property_id),
      'itemCount', null, 'changedFields', '[]'::jsonb
    );
    v_details := jsonb_build_object(
      'itemId', v_new->>'item_id', 'vendorName', v_new->>'vendor_name',
      'quantity', nullif(v_new->>'quantity', '')::numeric,
      'quantityCases', nullif(v_new->>'quantity_cases', '')::numeric,
      'receivedAt', v_new->>'received_at', 'reference', v_new->>'notes'
    );
    v_financial := jsonb_build_object(
      'unitCost', nullif(v_new->>'unit_cost', '')::numeric,
      'totalCost', nullif(v_new->>'total_cost', '')::numeric
    );

  elsif tg_table_name = 'inventory_discards' then
    v_action := 'loss.recorded'; v_entity_type := 'loss';
    v_entity_id := (v_new->>'id')::uuid; v_entity_key := v_new->>'item_id';
    v_request_id := v_new->>'request_id';
    v_occurred_at := (v_new->>'discarded_at')::timestamptz;
    v_actor_id := nullif(v_new->>'recorded_by_user_id', '')::uuid;
    v_actor_name := v_new->>'discarded_by';
    v_dedupe := 'loss:' || v_entity_id::text;
    v_summary := jsonb_build_object(
      'label', v_new->>'item_name', 'secondaryLabel', v_new->>'reason',
      'quantity', nullif(v_new->>'quantity', '')::numeric,
      'unit', (select i.unit from public.inventory i where i.id = (v_new->>'item_id')::uuid and i.property_id = v_property_id),
      'itemCount', null, 'changedFields', '[]'::jsonb
    );
    v_details := jsonb_build_object(
      'itemId', v_new->>'item_id', 'reason', v_new->>'reason',
      'quantity', nullif(v_new->>'quantity', '')::numeric,
      'stockBefore', nullif(v_new->>'stock_before', '')::numeric,
      'stockAfter', nullif(v_new->>'stock_after', '')::numeric,
      'notes', v_new->>'notes'
    );
    v_financial := jsonb_build_object(
      'unitCost', nullif(v_new->>'unit_cost', '')::numeric,
      'costValue', nullif(v_new->>'cost_value', '')::numeric
    );

  elsif tg_table_name = 'inventory_reconciliations' then
    v_action := 'reconciliation.recorded'; v_entity_type := 'reconciliation';
    v_entity_id := (v_new->>'id')::uuid; v_entity_key := v_new->>'item_id';
    v_occurred_at := (v_new->>'reconciled_at')::timestamptz;
    v_actor_id := nullif(v_new->>'recorded_by_user_id', '')::uuid;
    v_actor_name := coalesce(v_new->>'recorded_by_name', v_new->>'reconciled_by');
    v_dedupe := 'reconciliation:' || v_entity_id::text;
    v_summary := jsonb_build_object(
      'label', v_new->>'item_name', 'secondaryLabel', null,
      'quantity', nullif(v_new->>'physical_count', '')::numeric,
      'unit', (select i.unit from public.inventory i where i.id = (v_new->>'item_id')::uuid and i.property_id = v_property_id),
      'itemCount', null, 'changedFields', '[]'::jsonb
    );
    v_details := jsonb_build_object(
      'itemId', v_new->>'item_id',
      'physicalCount', nullif(v_new->>'physical_count', '')::numeric,
      'systemEstimate', nullif(v_new->>'system_estimate', '')::numeric,
      'variance', nullif(v_new->>'unaccounted_variance', '')::numeric,
      'notes', v_new->>'notes'
    );
    v_financial := jsonb_build_object(
      'unitCost', nullif(v_new->>'unit_cost', '')::numeric,
      'varianceValue', nullif(v_new->>'unaccounted_variance_value', '')::numeric
    );

  elsif tg_table_name = 'inventory_delivery_corrections' then
    v_action := case when v_new->>'correction_kind' = 'void' then 'delivery.voided' else 'delivery.corrected' end;
    v_entity_type := 'delivery_correction';
    v_entity_id := (v_new->>'id')::uuid; v_entity_key := v_new->>'original_order_id';
    v_request_id := v_new->>'request_id';
    v_occurred_at := (v_new->>'corrected_at')::timestamptz;
    v_actor_id := nullif(v_new->>'corrected_by_user_id', '')::uuid;
    v_actor_name := v_new->>'corrected_by';
    v_dedupe := 'delivery-correction:' || v_entity_id::text;
    v_summary := jsonb_build_object(
      'label', coalesce(v_new->>'corrected_item_name', v_new->>'previous_item_name'),
      'secondaryLabel', v_new->>'correction_kind',
      'quantity', nullif(v_new->>'corrected_quantity', '')::numeric,
      'unit', null, 'itemCount', 1, 'changedFields', '[]'::jsonb
    );
    v_details := jsonb_build_object(
      'originalOrderId', v_new->>'original_order_id', 'kind', v_new->>'correction_kind',
      'reason', v_new->>'reason',
      'previousQuantity', nullif(v_new->>'previous_quantity', '')::numeric,
      'correctedQuantity', nullif(v_new->>'corrected_quantity', '')::numeric,
      'stockEffect', coalesce(v_new->'stock_effect', '[]'::jsonb)
    );
    v_financial := jsonb_build_object(
      'previousUnitCost', nullif(v_new->>'previous_unit_cost', '')::numeric,
      'previousTotalCost', nullif(v_new->>'previous_total_cost', '')::numeric,
      'correctedUnitCost', nullif(v_new->>'corrected_unit_cost', '')::numeric,
      'correctedTotalCost', nullif(v_new->>'corrected_total_cost', '')::numeric
    );

  elsif tg_table_name = 'inventory_opening_adjustments' then
    v_action := 'opening_adjustment.recorded'; v_entity_type := 'opening_adjustment';
    v_entity_id := (v_new->>'id')::uuid; v_entity_key := v_new->>'item_id';
    v_request_id := v_new->>'request_id';
    v_occurred_at := (v_new->>'effective_at')::timestamptz;
    v_actor_id := nullif(v_new->>'actor_id', '')::uuid;
    v_actor_name := v_new->>'actor_name';
    v_dedupe := 'opening-adjustment:' || v_entity_id::text;
    v_summary := jsonb_build_object(
      'label', (select i.name from public.inventory i where i.id = (v_new->>'item_id')::uuid and i.property_id = v_property_id),
      'secondaryLabel', null, 'quantity', nullif(v_new->>'quantity', '')::numeric,
      'unit', (select i.unit from public.inventory i where i.id = (v_new->>'item_id')::uuid and i.property_id = v_property_id),
      'itemCount', 1, 'changedFields', '[]'::jsonb
    );
    v_details := jsonb_build_object(
      'itemId', v_new->>'item_id', 'quantity', nullif(v_new->>'quantity', '')::numeric,
      'stockBefore', nullif(v_new->>'stock_before', '')::numeric,
      'stockAfter', nullif(v_new->>'stock_after', '')::numeric
    );
    v_financial := jsonb_build_object(
      'unitCostCents', nullif(v_new->>'unit_cost_cents', '')::numeric,
      'valueCents', nullif(v_new->>'value_cents', '')::numeric
    );

  elsif tg_table_name = 'inventory_month_closes' then
    v_entity_type := 'month'; v_entity_id := (v_row->>'id')::uuid;
    v_entity_key := v_property_id::text || ':' || (v_row->>'month_start');
    if tg_op = 'INSERT' then
      v_action := 'month.started'; v_request_id := v_new->>'start_request_id';
      v_actor_id := nullif(v_new->>'opened_by', '')::uuid; v_actor_name := v_new->>'opened_by_name';
      v_occurred_at := (v_new->>'baseline_at')::timestamptz;
      v_dedupe := 'month:start:' || v_entity_id::text;
    elsif v_old->>'status' = 'open' and v_new->>'status' = 'closed' then
      v_action := 'month.closed'; v_request_id := v_new->>'close_request_id';
      v_actor_id := nullif(v_new->>'closed_by', '')::uuid; v_actor_name := v_new->>'closed_by_name';
      v_occurred_at := (v_new->>'closed_at')::timestamptz;
      v_dedupe := 'month:close:' || v_entity_id::text;
    else
      return new;
    end if;
    v_summary := jsonb_build_object(
      'label', v_row->>'month_start', 'secondaryLabel', v_row->>'status',
      'quantity', null, 'unit', null, 'itemCount', null, 'changedFields', '[]'::jsonb
    );
    v_details := jsonb_build_object(
      'month', v_row->>'month_start', 'status', v_row->>'status',
      'partial', coalesce((v_row->>'is_partial')::boolean, false),
      'purchaseSource', v_row->>'purchase_source'
    );
    v_financial := jsonb_build_object(
      'beginningValueCents', nullif(v_row->>'beginning_value_cents', '')::numeric,
      'purchaseCents', nullif(v_row->>'confirmed_purchase_cents', '')::numeric,
      'endingValueCents', nullif(v_row->>'ending_value_cents', '')::numeric,
      'actualUsageCents', nullif(v_row->>'actual_usage_cents', '')::numeric
    );

  elsif tg_table_name = 'vendors' then
    v_entity_type := 'vendor'; v_entity_id := (v_row->>'id')::uuid; v_entity_key := v_entity_id::text;
    if tg_op = 'INSERT' then v_action := 'vendor.created';
    elsif coalesce((v_old->>'is_active')::boolean, true) and not coalesce((v_new->>'is_active')::boolean, true)
      then v_action := 'vendor.inactivated';
    else v_action := 'vendor.updated'; end if;
    v_occurred_at := case when tg_op = 'DELETE' then clock_timestamp() else
      coalesce((v_row->>'updated_at')::timestamptz, (v_row->>'created_at')::timestamptz, clock_timestamp()) end;
    v_dedupe := case when tg_op = 'INSERT' then 'vendor:create:' || v_entity_id::text else null end;
    v_summary := jsonb_build_object(
      'label', v_row->>'name', 'secondaryLabel', null, 'quantity', null,
      'unit', null, 'itemCount', null, 'changedFields', '[]'::jsonb
    );
    v_details := jsonb_build_object('active', coalesce((v_row->>'is_active')::boolean, true));
    v_financial := jsonb_build_object('accountNumber', v_row->>'account_number');

  elsif tg_table_name = 'inventory_budgets' then
    v_entity_type := 'budget'; v_entity_id := null;
    v_entity_key := v_property_id::text || ':' || (v_row->>'category') || ':' || (v_row->>'month_start') || ':' || coalesce(v_row->>'basis', 'purchases');
    v_source_id := v_entity_key;
    v_action := case tg_op when 'INSERT' then 'budget.created' when 'UPDATE' then 'budget.updated' else 'budget.deleted' end;
    v_occurred_at := case when tg_op = 'DELETE' then clock_timestamp() else
      coalesce((v_row->>'updated_at')::timestamptz, (v_row->>'created_at')::timestamptz, clock_timestamp()) end;
    v_summary := jsonb_build_object(
      'label', v_row->>'category', 'secondaryLabel', v_row->>'month_start',
      'quantity', null, 'unit', null, 'itemCount', null, 'changedFields', '[]'::jsonb
    );
    v_details := jsonb_build_object('month', v_row->>'month_start', 'basis', coalesce(v_row->>'basis', 'purchases'));
    v_financial := jsonb_build_object('budgetCents', nullif(v_row->>'budget_cents', '')::numeric);

  elsif tg_table_name = 'inventory_custom_categories' then
    v_entity_type := 'category'; v_entity_id := (v_row->>'id')::uuid; v_entity_key := v_entity_id::text;
    v_action := case tg_op when 'INSERT' then 'category.created' when 'UPDATE' then 'category.updated' else 'category.deleted' end;
    v_occurred_at := case when tg_op = 'DELETE' then clock_timestamp() else
      coalesce((v_row->>'updated_at')::timestamptz, (v_row->>'created_at')::timestamptz, clock_timestamp()) end;
    v_summary := jsonb_build_object(
      'label', v_row->>'name', 'secondaryLabel', null, 'quantity', null,
      'unit', null, 'itemCount', null, 'changedFields', '[]'::jsonb
    );

  elsif tg_table_name = 'inventory_budget_sections' then
    v_entity_type := 'budget_section'; v_entity_id := (v_row->>'id')::uuid; v_entity_key := v_entity_id::text;
    v_action := case tg_op when 'INSERT' then 'budget_section.created' when 'UPDATE' then 'budget_section.updated' else 'budget_section.deleted' end;
    v_occurred_at := case when tg_op = 'DELETE' then clock_timestamp() else
      coalesce((v_row->>'updated_at')::timestamptz, (v_row->>'created_at')::timestamptz, clock_timestamp()) end;
    v_summary := jsonb_build_object(
      'label', v_row->>'name', 'secondaryLabel', null, 'quantity', null,
      'unit', null, 'itemCount', coalesce(jsonb_array_length(coalesce(v_row->'item_ids', '[]'::jsonb)), 0),
      'changedFields', '[]'::jsonb
    );
    v_details := jsonb_build_object('itemCount', coalesce(jsonb_array_length(coalesce(v_row->'item_ids', '[]'::jsonb)), 0));

  elsif tg_table_name = 'properties' then
    v_entity_type := 'config'; v_entity_id := v_property_id; v_entity_key := v_property_id::text;
    v_source_id := v_property_id::text; v_action := 'config.updated';
    v_occurred_at := clock_timestamp();
    if v_old->'inventory_tab_layout' is distinct from v_new->'inventory_tab_layout' then
      v_changed_fields := array_append(v_changed_fields, 'inventory_tab_layout');
    end if;
    if v_old->'inventory_budget_mode' is distinct from v_new->'inventory_budget_mode' then
      v_changed_fields := array_append(v_changed_fields, 'inventory_budget_mode');
    end if;
    if cardinality(v_changed_fields) = 0 then return new; end if;
    v_summary := jsonb_build_object(
      'label', v_new->>'name', 'secondaryLabel', null, 'quantity', null,
      'unit', null, 'itemCount', null, 'changedFields', to_jsonb(v_changed_fields)
    );
    v_details := jsonb_build_object(
      'budgetMode', v_new->>'inventory_budget_mode',
      'tabLayout', coalesce(v_new->'inventory_tab_layout', '{}'::jsonb)
    );
    v_old := jsonb_build_object(
      'inventory_budget_mode', v_old->'inventory_budget_mode',
      'inventory_tab_layout', v_old->'inventory_tab_layout'
    );
    v_new := jsonb_build_object(
      'inventory_budget_mode', v_new->'inventory_budget_mode',
      'inventory_tab_layout', v_new->'inventory_tab_layout'
    );
  else
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  perform public.staxis_append_inventory_audit_event(
    v_property_id, v_action, v_entity_type, v_entity_id, v_entity_key,
    tg_table_name, v_source_id, v_request_id, v_occurred_at,
    v_actor_id, v_actor_name, v_summary, v_details, v_financial,
    v_old, v_new, v_dedupe
  );
  return case when tg_op = 'DELETE' then old else new end;
end
$$;

insert into public.applied_migrations (version, description)
values ('0465', 'the audit trigger stops naming the 0463 generated cents mirrors in changedFields: to_jsonb row diffs now subtract unit_cost_cents, opening_adjustment_unit_cost_cents and delivery_baseline_unit_cost_cents on public.inventory, so an item history entry names each real edit once instead of twice. Function restated verbatim from 0326 otherwise. No table, index, RLS or grant changes.')
on conflict (version) do nothing;
