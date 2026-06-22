-- 0286_atomic_po_receive
--
-- Audit fix #10: receiving a purchase order was NOT atomic. The app bumped each
-- line's qty_received in one write, then incremented inventory.current_stock in
-- a separate write. If the DB hiccupped between the two, the line was marked
-- received but the stock count never moved — and because the next retry
-- recomputes delta = target - qty_received (now 0), the stock was permanently
-- understated, with no way to self-heal.
--
-- This function applies ALL of a receive's (qty_received, stock-delta) pairs in
-- ONE transaction (the function body is atomic): either every line's received
-- total AND its stock increment land together, or nothing does and the receive
-- is safely retryable. The stock bump is also a single atomic
-- `current_stock + delta` (no read-modify-write), which closes the small race
-- the old per-item read+write left open.
--
-- p_lines is a JSON array of { line_id, target_qty, item_id, delta } — only
-- lines with a positive delta. item_id may be null (a free-text line with no
-- inventory item); delta <= 0 lines are simply skipped. Every write is scoped
-- (purchase_order_lines by p_po_id, inventory by p_property_id) so a forged id
-- can't touch another PO/hotel.
--
-- SECURITY INVOKER (default): only ever called server-side via supabaseAdmin
-- (service_role, which has bypassrls); EXECUTE is granted to service_role only,
-- never to authenticated, so a logged-in user can't call it directly.

create or replace function public.staxis_receive_po_lines(
  p_property_id uuid,
  p_po_id uuid,
  p_lines jsonb
) returns void
language plpgsql
as $$
declare
  r record;
  v_line_id uuid;
  v_target  numeric;
  v_item_id uuid;
  v_delta   numeric;
begin
  for r in select value from jsonb_array_elements(p_lines)
  loop
    v_line_id := (r.value->>'line_id')::uuid;
    v_target  := (r.value->>'target_qty')::numeric;
    v_item_id := nullif(r.value->>'item_id', '')::uuid;
    v_delta   := coalesce((r.value->>'delta')::numeric, 0);

    -- 1) Bump the line's cumulative received total (scoped to this PO).
    update public.purchase_order_lines
       set qty_received = v_target
     where id = v_line_id
       and purchase_order_id = p_po_id;

    -- 2) Atomic stock increment (scoped to this property), only for a real
    --    positive delta on an inventory-backed line.
    if v_item_id is not null and v_delta > 0 then
      update public.inventory
         set current_stock   = coalesce(current_stock, 0) + v_delta,
             last_ordered_at = now()
       where id = v_item_id
         and property_id = p_property_id;
    end if;
  end loop;
end;
$$;

revoke all on function public.staxis_receive_po_lines(uuid, uuid, jsonb) from public;
grant execute on function public.staxis_receive_po_lines(uuid, uuid, jsonb) to service_role;

-- ─── Track the migration ─────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values ('0286', 'Audit fix #10: staxis_receive_po_lines — atomic PO receive (line bumps + stock increments in one transaction).')
on conflict (version) do nothing;

notify pgrst, 'reload schema';
