-- ═══════════════════════════════════════════════════════════════════════════
-- 0310 — Inventory data integrity and durable write transactions
--
-- Field-test hardening for hotels that depend on Inventory as their system of
-- record. This migration makes four guarantees at the database boundary:
--
--   1. Items are archived, not browser-deleted, and retain creation/archive
--      provenance. Count/order/discard/reconciliation history is append-only.
--   2. A child row's property_id and item_id must identify the SAME hotel.
--   3. Counts and deliveries are atomic and idempotent across retries.
--   4. PO receiving computes its delta from locked database rows; callers can
--      no longer double stock by replaying a stale client-computed delta.
--
-- No legacy operational row is deleted or silently repaired. Pre-existing
-- tenant mismatches abort the migration with an actionable error.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

do $$
begin
  if to_regprocedure('public.mfa_verified_or_grace()') is null then
    raise exception 'inventory integrity requires public.mfa_verified_or_grace()';
  end if;
end
$$;

-- ─── Item provenance + soft archive ───────────────────────────────────────
-- Add nullable first, THEN set the default: old rows remain honestly unknown
-- instead of being backfilled with the migration timestamp.
alter table public.inventory add column if not exists created_at timestamptz;
alter table public.inventory alter column created_at set default now();
alter table public.inventory add column if not exists created_by uuid;
alter table public.inventory alter column created_by set default auth.uid();
alter table public.inventory add column if not exists archived_at timestamptz;
alter table public.inventory add column if not exists archived_by uuid;

alter table public.inventory
  drop constraint if exists inventory_created_by_fkey,
  drop constraint if exists inventory_archived_by_fkey,
  add constraint inventory_created_by_fkey
    foreign key (created_by) references auth.users(id) on delete set null,
  add constraint inventory_archived_by_fkey
    foreign key (archived_by) references auth.users(id) on delete set null;

comment on column public.inventory.created_at is
  'Immutable creation timestamp for rows created after migration 0310. NULL on legacy rows means creation time is genuinely unknown.';
comment on column public.inventory.created_by is
  'auth.users id that created the item. NULL for legacy/service-created rows or after the user is removed.';
comment on column public.inventory.archived_at is
  'Soft-removal timestamp. NULL means active. Archiving preserves the item and all operational history.';
comment on column public.inventory.archived_by is
  'auth.users id that archived the item.';

drop trigger if exists inventory_touch on public.inventory;
create trigger inventory_touch
  before update on public.inventory
  for each row execute function public.touch_updated_at();

-- Archived names may be re-created as a fresh active item. Active names remain
-- unique case-insensitively within a hotel.
drop index if exists public.inventory_property_name_unique_idx;
create unique index inventory_property_name_unique_idx
  on public.inventory (property_id, lower(name))
  where name is not null and archived_at is null;

-- Existing bad numeric rows are preserved for review. NOT VALID still enforces
-- each constraint for every future INSERT/UPDATE.
alter table public.inventory
  drop constraint if exists inventory_current_stock_nonnegative,
  add constraint inventory_current_stock_nonnegative check (current_stock >= 0) not valid,
  drop constraint if exists inventory_par_level_nonnegative,
  add constraint inventory_par_level_nonnegative check (par_level >= 0) not valid,
  drop constraint if exists inventory_reorder_at_nonnegative,
  add constraint inventory_reorder_at_nonnegative check (reorder_at is null or reorder_at >= 0) not valid,
  drop constraint if exists inventory_unit_cost_nonnegative,
  add constraint inventory_unit_cost_nonnegative check (unit_cost is null or unit_cost >= 0) not valid,
  drop constraint if exists inventory_usage_checkout_nonnegative,
  add constraint inventory_usage_checkout_nonnegative check (usage_per_checkout is null or usage_per_checkout >= 0) not valid,
  drop constraint if exists inventory_usage_stayover_nonnegative,
  add constraint inventory_usage_stayover_nonnegative check (usage_per_stayover is null or usage_per_stayover >= 0) not valid,
  drop constraint if exists inventory_reorder_lead_days_nonnegative,
  add constraint inventory_reorder_lead_days_nonnegative check (reorder_lead_days is null or reorder_lead_days >= 0) not valid,
  drop constraint if exists inventory_pack_size_positive,
  add constraint inventory_pack_size_positive check (pack_size is null or pack_size > 0) not valid;

-- ─── Count-session identity + durable idempotency receipts ────────────────
alter table public.inventory_counts
  add column if not exists count_session_id uuid;

create unique index if not exists inventory_counts_session_item_uq
  on public.inventory_counts (property_id, count_session_id, item_id)
  where count_session_id is not null;

comment on column public.inventory_counts.count_session_id is
  'Client request UUID shared by every item row in one atomic count save. Used for idempotency and exact History grouping.';

-- Numbered scanned invoices have a stable vendor+invoice tag in notes. Keep a
-- durable one-row business key so rescanning the same invoice under a brand-new
-- browser UUID cannot receive it twice. Multiple line rows on one invoice map
-- to the same key by design.
-- @rls: service-role-only — browser access is denied because delivery RPCs own these dedupe keys.
create table if not exists public.inventory_delivery_keys (
  property_id  uuid not null references public.properties(id) on delete cascade,
  delivery_key text not null,
  request_id   uuid,
  created_at   timestamptz not null default now(),
  primary key (property_id, delivery_key)
);

insert into public.inventory_delivery_keys(property_id, delivery_key, request_id, created_at)
select property_id, lower(trim(notes)), null, min(coalesce(received_at, created_at))
from public.inventory_orders
where notes is not null and trim(notes) ~* '^Invoice scan · inv#'
group by property_id, lower(trim(notes))
on conflict (property_id, delivery_key) do nothing;

alter table public.inventory_delivery_keys enable row level security;
drop policy if exists "inventory_delivery_keys deny browser" on public.inventory_delivery_keys;
create policy "inventory_delivery_keys deny browser"
  on public.inventory_delivery_keys for all to anon, authenticated
  using (false) with check (false);
revoke all on public.inventory_delivery_keys from public, anon, authenticated;
grant select, insert, update, delete on public.inventory_delivery_keys to service_role;

comment on table public.inventory_delivery_keys is
  'Database-enforced dedupe keys for numbered scanned invoices. Backfilled from retained order history; request_id is NULL for legacy invoices.';

create table if not exists public.inventory_write_receipts (
  property_id  uuid not null references public.properties(id) on delete cascade,
  request_id   uuid not null,
  operation    text not null check (operation in ('count', 'delivery')),
  payload      jsonb not null,
  result       jsonb,
  created_at   timestamptz not null default now(),
  primary key (property_id, request_id)
);

comment on table public.inventory_write_receipts is
  'Append-only idempotency claims for atomic inventory count and delivery RPCs. Each UUID is bound to its operation and canonical JSON payload; the committed result is replayed after an ambiguous response.';

alter table public.inventory_write_receipts enable row level security;
drop policy if exists "owner read inventory_write_receipts" on public.inventory_write_receipts;
drop policy if exists "owner insert inventory_write_receipts" on public.inventory_write_receipts;
create policy "owner read inventory_write_receipts"
  on public.inventory_write_receipts for select to authenticated
  using (public.user_owns_property(property_id) and public.mfa_verified_or_grace());

revoke all on public.inventory_write_receipts from anon;
revoke insert, update, delete on public.inventory_write_receipts from authenticated;
grant select on public.inventory_write_receipts to authenticated;
grant select, insert, update, delete on public.inventory_write_receipts to service_role;

-- ─── Detect tenant mismatches before adding composite FKs/triggers ────────
do $$
begin
  if exists (
    select 1 from public.inventory_counts c
    join public.inventory i on i.id = c.item_id
    where c.property_id <> i.property_id
  ) then raise exception '0310 blocked: inventory_counts contains cross-property item references'; end if;

  if exists (
    select 1 from public.inventory_orders o
    join public.inventory i on i.id = o.item_id
    where o.property_id <> i.property_id
  ) then raise exception '0310 blocked: inventory_orders contains cross-property item references'; end if;

  if exists (
    select 1 from public.inventory_discards d
    join public.inventory i on i.id = d.item_id
    where d.property_id <> i.property_id
  ) then raise exception '0310 blocked: inventory_discards contains cross-property item references'; end if;

  if exists (
    select 1 from public.inventory_reconciliations r
    join public.inventory i on i.id = r.item_id
    where r.property_id <> i.property_id
  ) then raise exception '0310 blocked: inventory_reconciliations contains cross-property item references'; end if;

  if exists (
    select 1 from public.inventory_rate_predictions p
    join public.inventory i on i.id = p.item_id
    where p.property_id <> i.property_id
  ) then raise exception '0310 blocked: inventory_rate_predictions contains cross-property item references'; end if;

  if exists (
    select 1 from public.model_runs m
    join public.inventory i on i.id = m.item_id
    where m.item_id is not null and m.property_id <> i.property_id
  ) then raise exception '0310 blocked: model_runs contains cross-property item references'; end if;

  if exists (
    select 1 from public.inventory_rate_predictions p
    join public.model_runs m on m.id = p.model_run_id
    where p.property_id is distinct from m.property_id
       or p.item_id is distinct from m.item_id
  ) then raise exception '0310 blocked: inventory_rate_predictions contains cross-property model references'; end if;

  if exists (
    select 1 from public.prediction_log p
    join public.inventory_counts c on c.id = p.inventory_count_id
    where p.inventory_count_id is not null and p.property_id <> c.property_id
  ) then raise exception '0310 blocked: prediction_log contains cross-property inventory-count references'; end if;

  if exists (
    select 1 from public.purchase_order_lines l
    join public.purchase_orders p on p.id = l.purchase_order_id
    join public.inventory i on i.id = l.item_id
    where l.item_id is not null and p.property_id <> i.property_id
  ) then raise exception '0310 blocked: purchase_order_lines contains cross-property item references'; end if;

  if exists (
    select 1 from public.inventory i
    join public.vendors v on v.id = i.vendor_id
    where i.vendor_id is not null and i.property_id <> v.property_id
  ) then raise exception '0310 blocked: inventory.vendor_id contains a cross-property reference'; end if;

  if exists (
    select 1 from public.purchase_orders p
    join public.vendors v on v.id = p.vendor_id
    where p.vendor_id is not null and p.property_id <> v.property_id
  ) then raise exception '0310 blocked: purchase_orders.vendor_id contains a cross-property reference'; end if;

  if exists (
    select 1 from public.inventory i
    join public.inventory_custom_categories c on c.id = i.custom_category_id
    where i.custom_category_id is not null and i.property_id <> c.property_id
  ) then raise exception '0310 blocked: inventory.custom_category_id contains a cross-property reference'; end if;

  if exists (
    select 1
    from public.inventory_budget_sections s
    cross join lateral unnest(s.item_ids) as x(item_id)
    left join public.inventory i on i.id = x.item_id
    where i.id is null or i.property_id <> s.property_id
  ) then raise exception '0310 blocked: inventory_budget_sections.item_ids contains missing/cross-property items'; end if;
end
$$;

-- The composite key is the anchor for every operational child. DEFERRABLE
-- NO ACTION blocks standalone item deletion while still allowing the explicit
-- whole-property cascade to delete both parent and children in one transaction.
alter table public.inventory
  drop constraint if exists inventory_id_property_id_key,
  add constraint inventory_id_property_id_key unique (id, property_id);

alter table public.inventory_counts
  drop constraint if exists inventory_counts_item_id_fkey,
  drop constraint if exists inventory_counts_item_property_fkey,
  add constraint inventory_counts_item_property_fkey
    foreign key (item_id, property_id)
    references public.inventory(id, property_id)
    on delete no action deferrable initially deferred;

alter table public.inventory_orders
  drop constraint if exists inventory_orders_item_id_fkey,
  drop constraint if exists inventory_orders_item_property_fkey,
  add constraint inventory_orders_item_property_fkey
    foreign key (item_id, property_id)
    references public.inventory(id, property_id)
    on delete no action deferrable initially deferred;

alter table public.inventory_discards
  drop constraint if exists inventory_discards_item_id_fkey,
  drop constraint if exists inventory_discards_item_property_fkey,
  add constraint inventory_discards_item_property_fkey
    foreign key (item_id, property_id)
    references public.inventory(id, property_id)
    on delete no action deferrable initially deferred;

alter table public.inventory_reconciliations
  drop constraint if exists inventory_reconciliations_item_id_fkey,
  drop constraint if exists inventory_reconciliations_item_property_fkey,
  add constraint inventory_reconciliations_item_property_fkey
    foreign key (item_id, property_id)
    references public.inventory(id, property_id)
    on delete no action deferrable initially deferred;

alter table public.inventory_rate_predictions
  drop constraint if exists inventory_rate_predictions_item_id_fkey,
  drop constraint if exists inventory_rate_predictions_item_property_fkey,
  add constraint inventory_rate_predictions_item_property_fkey
    foreign key (item_id, property_id)
    references public.inventory(id, property_id)
    on delete no action deferrable initially deferred;

alter table public.model_runs
  drop constraint if exists model_runs_item_id_fkey,
  drop constraint if exists model_runs_item_property_fkey,
  add constraint model_runs_item_property_fkey
    foreign key (item_id, property_id)
    references public.inventory(id, property_id)
    on delete no action deferrable initially deferred;

alter table public.inventory_counts
  drop constraint if exists inventory_counts_id_property_id_key,
  add constraint inventory_counts_id_property_id_key unique (id, property_id);

alter table public.model_runs
  drop constraint if exists model_runs_id_property_item_key,
  add constraint model_runs_id_property_item_key unique (id, property_id, item_id);

alter table public.inventory_rate_predictions
  drop constraint if exists inventory_rate_predictions_model_run_id_fkey,
  drop constraint if exists inventory_rate_predictions_model_property_item_fkey,
  add constraint inventory_rate_predictions_model_property_item_fkey
    foreign key (model_run_id, property_id, item_id)
    references public.model_runs(id, property_id, item_id)
    on delete cascade deferrable initially deferred;

alter table public.prediction_log
  drop constraint if exists prediction_log_inventory_count_id_fkey,
  drop constraint if exists prediction_log_inventory_count_property_fkey,
  add constraint prediction_log_inventory_count_property_fkey
    foreign key (inventory_count_id, property_id)
    references public.inventory_counts(id, property_id)
    on delete no action deferrable initially deferred;

-- ─── Tenant-validation triggers for non-composite/array references ────────
create or replace function public.staxis_validate_inventory_tenant_links()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and new.property_id is distinct from old.property_id then
    raise exception 'purchase-order property is immutable' using errcode = '23514';
  end if;
  if new.vendor_id is not null and not exists (
    select 1 from public.vendors v
    where v.id = new.vendor_id and v.property_id = new.property_id
  ) then
    raise exception 'inventory vendor does not belong to property' using errcode = '23503';
  end if;

  if new.custom_category_id is not null and not exists (
    select 1 from public.inventory_custom_categories c
    where c.id = new.custom_category_id and c.property_id = new.property_id
  ) then
    raise exception 'inventory custom category does not belong to property' using errcode = '23503';
  end if;
  return new;
end
$$;

drop trigger if exists inventory_validate_tenant_links on public.inventory;
create trigger inventory_validate_tenant_links
  before insert or update of property_id, vendor_id, custom_category_id on public.inventory
  for each row execute function public.staxis_validate_inventory_tenant_links();

create or replace function public.staxis_validate_purchase_order_tenant_links()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.vendor_id is not null and not exists (
    select 1 from public.vendors v
    where v.id = new.vendor_id and v.property_id = new.property_id
  ) then
    raise exception 'purchase-order vendor does not belong to property' using errcode = '23503';
  end if;
  return new;
end
$$;

drop trigger if exists purchase_orders_validate_tenant_links on public.purchase_orders;
create trigger purchase_orders_validate_tenant_links
  before insert or update of property_id, vendor_id on public.purchase_orders
  for each row execute function public.staxis_validate_purchase_order_tenant_links();

create or replace function public.staxis_validate_purchase_order_line_tenant()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_property_id uuid;
begin
  select p.property_id into v_property_id
  from public.purchase_orders p
  where p.id = new.purchase_order_id;
  if v_property_id is null then
    raise exception 'purchase-order parent not found' using errcode = '23503';
  end if;
  if new.item_id is not null and not exists (
    select 1 from public.inventory i
    where i.id = new.item_id
      and i.property_id = v_property_id
      and i.archived_at is null
  ) then
    raise exception 'purchase-order item does not belong to property or is archived' using errcode = '23503';
  end if;
  return new;
end
$$;

drop trigger if exists purchase_order_lines_validate_tenant on public.purchase_order_lines;
create trigger purchase_order_lines_validate_tenant
  before insert or update of purchase_order_id, item_id on public.purchase_order_lines
  for each row execute function public.staxis_validate_purchase_order_line_tenant();

create or replace function public.staxis_validate_inventory_budget_section_items()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1
    from unnest(new.item_ids) as x(item_id)
    left join public.inventory i on i.id = x.item_id
    where i.id is null or i.property_id <> new.property_id
  ) then
    raise exception 'budget section contains a missing or cross-property inventory item' using errcode = '23503';
  end if;
  return new;
end
$$;

drop trigger if exists inventory_budget_sections_validate_items on public.inventory_budget_sections;
create trigger inventory_budget_sections_validate_items
  before insert or update of property_id, item_ids on public.inventory_budget_sections
  for each row execute function public.staxis_validate_inventory_budget_section_items();

-- Referenced tenant parents cannot be reassigned after creation; otherwise a
-- valid child link could silently become cross-hotel later.
create or replace function public.staxis_reject_property_reassignment()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.property_id is distinct from old.property_id then
    raise exception '% property is immutable', tg_table_name using errcode = '23514';
  end if;
  return new;
end
$$;

drop trigger if exists vendors_property_immutable on public.vendors;
create trigger vendors_property_immutable
  before update of property_id on public.vendors
  for each row execute function public.staxis_reject_property_reassignment();

drop trigger if exists inventory_custom_categories_property_immutable on public.inventory_custom_categories;
create trigger inventory_custom_categories_property_immutable
  before update of property_id on public.inventory_custom_categories
  for each row execute function public.staxis_reject_property_reassignment();

create or replace function public.staxis_validate_active_inventory_ml_link()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.item_id is not null and not exists (
    select 1 from public.inventory i
    where i.id = new.item_id
      and i.property_id = new.property_id
      and i.archived_at is null
  ) then
    raise exception 'ML row item does not belong to property or is archived' using errcode = '23503';
  end if;
  return new;
end
$$;

drop trigger if exists model_runs_validate_active_inventory_item on public.model_runs;
create trigger model_runs_validate_active_inventory_item
  before insert or update of property_id, item_id on public.model_runs
  for each row execute function public.staxis_validate_active_inventory_ml_link();

drop trigger if exists inventory_rate_predictions_validate_active_item on public.inventory_rate_predictions;
create trigger inventory_rate_predictions_validate_active_item
  before insert or update on public.inventory_rate_predictions
  for each row execute function public.staxis_validate_active_inventory_ml_link();

-- Creation provenance and archive state are database-owned. Browser metadata
-- edits remain allowed, but direct stock/timestamp changes are rejected so a
-- stale client cannot bypass the atomic stock+ledger RPCs.
create or replace function public.staxis_enforce_inventory_row_integrity()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null and auth.role() <> 'service_role' then
      new.created_at := now();
      new.created_by := auth.uid();
      new.archived_at := null;
      new.archived_by := null;
    else
      new.created_at := coalesce(new.created_at, now());
    end if;
    return new;
  end if;

  if new.id is distinct from old.id or new.property_id is distinct from old.property_id then
    raise exception 'inventory identity and property are immutable' using errcode = '23514';
  end if;
  if new.created_at is distinct from old.created_at then
    raise exception 'inventory creation timestamp is immutable' using errcode = '23514';
  end if;
  if old.archived_at is not null then
    -- auth.users FK ON DELETE SET NULL is the sole mutation allowed on an
    -- archived row. It preserves operational fields while honestly recording
    -- that the original actor no longer exists.
    if current_user not in ('authenticated', 'anon')
       and (to_jsonb(new) - array['created_by', 'archived_by', 'updated_at'])
           = (to_jsonb(old) - array['created_by', 'archived_by', 'updated_at'])
       and (new.created_by is not distinct from old.created_by or new.created_by is null)
       and (new.archived_by is not distinct from old.archived_by or new.archived_by is null)
    then
      return new;
    end if;
    raise exception 'archived inventory items are immutable' using errcode = '23514';
  end if;
  if new.created_by is distinct from old.created_by and not (
    current_user not in ('authenticated', 'anon') and new.created_by is null
  ) then
    raise exception 'inventory creator is immutable' using errcode = '23514';
  end if;

  if new.archived_at is distinct from old.archived_at then
    if new.archived_at is null then
      raise exception 'inventory items cannot be unarchived in place' using errcode = '23514';
    end if;
    new.archived_at := now();
    if auth.uid() is not null and auth.role() <> 'service_role' then
      new.archived_by := auth.uid();
    end if;
  elsif new.archived_by is distinct from old.archived_by then
    raise exception 'archive provenance can change only while archiving' using errcode = '23514';
  end if;

  if current_user in ('authenticated', 'anon') and (
    new.current_stock is distinct from old.current_stock
    or new.last_counted_at is distinct from old.last_counted_at
    or new.last_ordered_at is distinct from old.last_ordered_at
  ) then
    raise exception 'inventory stock timestamps must be changed through an atomic inventory RPC'
      using errcode = '42501';
  end if;

  return new;
end
$$;

drop trigger if exists inventory_enforce_row_integrity on public.inventory;
create trigger inventory_enforce_row_integrity
  before insert or update on public.inventory
  for each row execute function public.staxis_enforce_inventory_row_integrity();

-- ─── Browser RLS: active item mutation, append-only operational history ───
drop policy if exists "owner rw inventory" on public.inventory;
drop policy if exists "owner read inventory" on public.inventory;
drop policy if exists "owner insert inventory" on public.inventory;
drop policy if exists "owner update inventory" on public.inventory;
create policy "owner read inventory" on public.inventory
  for select to authenticated
  using (public.user_owns_property(property_id) and public.mfa_verified_or_grace());
create policy "owner insert inventory" on public.inventory
  for insert to authenticated
  with check (public.user_owns_property(property_id) and public.mfa_verified_or_grace());
create policy "owner update inventory" on public.inventory
  for update to authenticated
  using (public.user_owns_property(property_id) and public.mfa_verified_or_grace())
  with check (public.user_owns_property(property_id) and public.mfa_verified_or_grace());
revoke delete on public.inventory from authenticated, anon;

drop policy if exists "owner rw inventory_counts" on public.inventory_counts;
drop policy if exists "owner read inventory_counts" on public.inventory_counts;
drop policy if exists "owner insert inventory_counts" on public.inventory_counts;
create policy "owner read inventory_counts" on public.inventory_counts
  for select to authenticated
  using (public.user_owns_property(property_id) and public.mfa_verified_or_grace());

drop policy if exists "owner rw inventory_orders" on public.inventory_orders;
drop policy if exists "owner read inventory_orders" on public.inventory_orders;
drop policy if exists "owner insert inventory_orders" on public.inventory_orders;
create policy "owner read inventory_orders" on public.inventory_orders
  for select to authenticated
  using (public.user_owns_property(property_id) and public.mfa_verified_or_grace());

drop policy if exists "owner rw inventory_discards" on public.inventory_discards;
drop policy if exists "owner read inventory_discards" on public.inventory_discards;
drop policy if exists "owner insert inventory_discards" on public.inventory_discards;
create policy "owner read inventory_discards" on public.inventory_discards
  for select to authenticated
  using (public.user_owns_property(property_id) and public.mfa_verified_or_grace());
create policy "owner insert inventory_discards" on public.inventory_discards
  for insert to authenticated
  with check (public.user_owns_property(property_id) and public.mfa_verified_or_grace());

drop policy if exists "owner rw inventory_reconciliations" on public.inventory_reconciliations;
drop policy if exists "owner read inventory_reconciliations" on public.inventory_reconciliations;
drop policy if exists "owner insert inventory_reconciliations" on public.inventory_reconciliations;
create policy "owner read inventory_reconciliations" on public.inventory_reconciliations
  for select to authenticated
  using (public.user_owns_property(property_id) and public.mfa_verified_or_grace());
create policy "owner insert inventory_reconciliations" on public.inventory_reconciliations
  for insert to authenticated
  with check (public.user_owns_property(property_id) and public.mfa_verified_or_grace());

revoke insert, update, delete on public.inventory_counts from authenticated, anon;
revoke insert, update, delete on public.inventory_orders from authenticated, anon;
revoke update, delete on public.inventory_discards from authenticated, anon;
revoke update, delete on public.inventory_reconciliations from authenticated, anon;

-- PostgreSQL numeric accepts NaN and ±Infinity, and those values can satisfy
-- ordinary nonnegative comparisons. Parse only finite decimal/exponent text at
-- every JSON RPC boundary before it can reach stock or financial columns.
create or replace function public.staxis_parse_finite_numeric(
  p_value text,
  p_label text
) returns numeric
language plpgsql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  v_value numeric;
begin
  if p_value is null or p_value !~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$' then
    raise exception '% must be a finite number', p_label using errcode = '22023';
  end if;
  v_value := p_value::numeric;
  if v_value::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception '% must be a finite number', p_label using errcode = '22023';
  end if;
  return v_value;
end
$$;

revoke all on function public.staxis_parse_finite_numeric(text, text)
  from public, anon, authenticated;

-- ─── Atomic count save ────────────────────────────────────────────────────
create or replace function public.staxis_save_inventory_count(
  p_property_id uuid,
  p_request_id uuid,
  p_counted_at timestamptz,
  p_counted_by text,
  p_rows jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_claimed uuid;
  v_receipt public.inventory_write_receipts%rowtype;
  v_payload jsonb;
  v_result jsonb;
  v_item public.inventory%rowtype;
  v_item_id uuid;
  v_expected numeric;
  v_counted numeric;
  v_estimated numeric;
  v_variance numeric;
  v_saved integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' and (
    auth.uid() is null
    or not public.user_owns_property(p_property_id)
    or not public.mfa_verified_or_grace()
  ) then
    raise exception 'not authorized to count inventory for this property' using errcode = '42501';
  end if;
  if p_request_id is null then raise exception 'request id is required'; end if;
  if p_counted_at is not null and p_counted_at > now() + interval '5 minutes' then
    raise exception 'counted_at cannot be in the future' using errcode = '22023';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'count rows must be a non-empty array';
  end if;

  v_payload := jsonb_build_object(
    'counted_at', p_counted_at,
    'counted_by', nullif(trim(p_counted_by), ''),
    'rows', p_rows
  );
  insert into public.inventory_write_receipts(property_id, request_id, operation, payload)
  values (p_property_id, p_request_id, 'count', v_payload)
  on conflict do nothing
  returning request_id into v_claimed;
  if v_claimed is null then
    select * into v_receipt
    from public.inventory_write_receipts
    where property_id = p_property_id and request_id = p_request_id;
    if v_receipt.operation is distinct from 'count' or v_receipt.payload is distinct from v_payload then
      raise exception 'inventory request id was already used for a different operation or payload'
        using errcode = '22023';
    end if;
    return coalesce(v_receipt.result, jsonb_build_object('saved', 0))
      || jsonb_build_object('replayed', true);
  end if;

  for r in select value from jsonb_array_elements(p_rows)
  loop
    v_item_id := (r.value->>'item_id')::uuid;
    v_expected := public.staxis_parse_finite_numeric(r.value->>'expected_stock', 'expected_stock');
    v_counted := public.staxis_parse_finite_numeric(r.value->>'counted_stock', 'counted_stock');
    if v_expected < 0 or v_counted < 0 then
      raise exception 'counted_stock must be nonnegative';
    end if;

    if r.value ? 'estimated_stock' and r.value->'estimated_stock' <> 'null'::jsonb then
      v_estimated := public.staxis_parse_finite_numeric(r.value->>'estimated_stock', 'estimated_stock');
      if v_estimated < 0 then raise exception 'estimated_stock must be nonnegative'; end if;
    else
      v_estimated := null;
    end if;

    select * into v_item
    from public.inventory i
    where i.id = v_item_id
      and i.property_id = p_property_id
      and i.archived_at is null
    for update;
    if not found then
      raise exception 'active inventory item % not found for property', v_item_id using errcode = 'P0002';
    end if;
    if v_item.current_stock is distinct from v_expected then
      raise exception 'inventory item % changed after this count was opened; refresh and recount', v_item_id
        using errcode = '40001';
    end if;
    if p_counted_at is not null
       and v_item.last_counted_at is not null
       and p_counted_at < v_item.last_counted_at
    then
      raise exception 'inventory item % has a newer count; refresh and recount', v_item_id
        using errcode = '40001';
    end if;

    v_variance := case when v_estimated is null then null else v_counted - v_estimated end;
    insert into public.inventory_counts (
      property_id, count_session_id, item_id, item_name,
      counted_stock, estimated_stock, variance, variance_value, unit_cost,
      counted_at, counted_by, notes
    ) values (
      p_property_id, p_request_id, v_item.id, v_item.name,
      v_counted, v_estimated, v_variance,
      case when v_variance is null or v_item.unit_cost is null then null else v_variance * v_item.unit_cost end,
      v_item.unit_cost, coalesce(p_counted_at, now()), nullif(trim(p_counted_by), ''),
      nullif(r.value->>'notes', '')
    );

    update public.inventory
    set current_stock = v_counted,
        last_counted_at = coalesce(p_counted_at, now())
    where id = v_item.id and property_id = p_property_id;
    v_saved := v_saved + 1;
  end loop;

  v_result := jsonb_build_object('replayed', false, 'saved', v_saved);
  update public.inventory_write_receipts
  set result = v_result
  where property_id = p_property_id and request_id = p_request_id;
  return v_result;
end
$$;

revoke all on function public.staxis_save_inventory_count(uuid, uuid, timestamptz, text, jsonb)
  from public, anon;
grant execute on function public.staxis_save_inventory_count(uuid, uuid, timestamptz, text, jsonb)
  to authenticated, service_role;

-- ─── Atomic manual/scanned delivery ──────────────────────────────────────
create or replace function public.staxis_receive_inventory_delivery(
  p_property_id uuid,
  p_request_id uuid,
  p_received_at timestamptz,
  p_vendor_name text,
  p_notes text,
  p_lines jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_claimed uuid;
  v_receipt public.inventory_write_receipts%rowtype;
  v_payload jsonb;
  v_result jsonb;
  v_delivery_key text;
  v_key_claimed text;
  v_item public.inventory%rowtype;
  v_item_id uuid;
  v_line_key text;
  v_seen_keys text[] := '{}';
  v_quantity numeric;
  v_cases numeric;
  v_unit_cost numeric;
  v_name text;
  v_category text;
  v_unit text;
  v_par numeric;
  v_saved integer := 0;
  v_created jsonb := '[]'::jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' and (
    auth.uid() is null
    or not public.user_owns_property(p_property_id)
    or not public.mfa_verified_or_grace()
    or exists (
      select 1
      from public.accounts a
      join public.capability_overrides o
        on o.property_id = p_property_id
       and o.capability = 'manage_inventory_orders'
       and o.role = a.role
       and o.allowed = false
      where a.data_user_id = auth.uid()
        and a.role <> 'admin'
    )
  ) then
    raise exception 'not authorized to receive inventory for this property' using errcode = '42501';
  end if;
  if p_request_id is null then raise exception 'request id is required'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'delivery lines must be a non-empty array';
  end if;

  v_payload := jsonb_build_object(
    'received_at', p_received_at,
    'vendor_name', nullif(trim(p_vendor_name), ''),
    'notes', nullif(trim(p_notes), ''),
    'lines', p_lines
  );
  insert into public.inventory_write_receipts(property_id, request_id, operation, payload)
  values (p_property_id, p_request_id, 'delivery', v_payload)
  on conflict do nothing
  returning request_id into v_claimed;
  if v_claimed is null then
    select * into v_receipt
    from public.inventory_write_receipts
    where property_id = p_property_id and request_id = p_request_id;
    if v_receipt.operation is distinct from 'delivery' or v_receipt.payload is distinct from v_payload then
      raise exception 'inventory request id was already used for a different operation or payload'
        using errcode = '22023';
    end if;
    return coalesce(v_receipt.result, jsonb_build_object('saved', 0, 'created', '[]'::jsonb))
      || jsonb_build_object('replayed', true);
  end if;

  v_delivery_key := case
    when trim(coalesce(p_notes, '')) ~* '^Invoice scan · inv#'
      then lower(trim(p_notes))
    else null
  end;
  if v_delivery_key is not null then
    insert into public.inventory_delivery_keys(property_id, delivery_key, request_id)
    values (p_property_id, v_delivery_key, p_request_id)
    on conflict do nothing
    returning delivery_key into v_key_claimed;
    if v_key_claimed is null then
      raise exception 'this numbered invoice was already received for the property'
        using errcode = '23505';
    end if;
  end if;

  for r in select value from jsonb_array_elements(p_lines)
  loop
    v_line_key := trim(coalesce(r.value->>'line_key', ''));
    if v_line_key = '' or v_line_key = any(v_seen_keys) then
      raise exception 'delivery line keys must be non-empty and unique';
    end if;
    v_seen_keys := array_append(v_seen_keys, v_line_key);

    v_quantity := public.staxis_parse_finite_numeric(r.value->>'quantity', 'delivery quantity');
    if v_quantity <= 0 then
      raise exception 'delivery quantity must be positive';
    end if;

    if r.value ? 'quantity_cases' and r.value->'quantity_cases' <> 'null'::jsonb then
      v_cases := public.staxis_parse_finite_numeric(r.value->>'quantity_cases', 'quantity_cases');
      if v_cases <= 0 or trunc(v_cases) <> v_cases then
        raise exception 'quantity_cases must be a positive whole number';
      end if;
    else
      v_cases := null;
    end if;

    if r.value ? 'unit_cost' and r.value->'unit_cost' <> 'null'::jsonb then
      v_unit_cost := public.staxis_parse_finite_numeric(r.value->>'unit_cost', 'unit_cost');
      if v_unit_cost < 0 then raise exception 'unit_cost must be nonnegative'; end if;
    else
      v_unit_cost := null;
    end if;

    v_item_id := nullif(r.value->>'item_id', '')::uuid;
    if v_item_id is null then
      v_name := trim(coalesce(r.value->>'item_name', ''));
      v_category := coalesce(r.value->>'category', '');
      v_unit := trim(coalesce(r.value->>'unit', ''));
      v_par := case
        when r.value ? 'par_level' and r.value->'par_level' <> 'null'::jsonb
          then public.staxis_parse_finite_numeric(r.value->>'par_level', 'par_level')
        else 0
      end;
      if v_name = '' or v_unit = '' or v_category not in ('housekeeping','maintenance','breakfast') or v_par < 0 then
        raise exception 'invalid new inventory item in delivery';
      end if;

      insert into public.inventory (
        property_id, name, category, current_stock, par_level, unit,
        unit_cost, vendor_name, last_ordered_at, last_counted_at
      ) values (
        p_property_id, v_name, v_category, v_quantity, v_par, v_unit,
        v_unit_cost, nullif(trim(p_vendor_name), ''), coalesce(p_received_at, now()), coalesce(p_received_at, now())
      ) returning * into v_item;
      v_item_id := v_item.id;
      v_created := v_created || jsonb_build_array(jsonb_build_object('line_key', v_line_key, 'item_id', v_item_id));
    else
      select * into v_item
      from public.inventory i
      where i.id = v_item_id
        and i.property_id = p_property_id
        and i.archived_at is null
      for update;
      if not found then
        raise exception 'active inventory item % not found for property', v_item_id using errcode = 'P0002';
      end if;

      update public.inventory
      set current_stock = current_stock + v_quantity,
          last_ordered_at = coalesce(p_received_at, now()),
          vendor_name = coalesce(nullif(trim(p_vendor_name), ''), vendor_name),
          unit_cost = coalesce(v_unit_cost, unit_cost)
      where id = v_item_id and property_id = p_property_id
      returning * into v_item;
    end if;

    insert into public.inventory_orders (
      property_id, item_id, item_name, quantity, quantity_cases,
      unit_cost, total_cost, vendor_name, ordered_at, received_at, notes
    ) values (
      p_property_id, v_item_id, v_item.name, v_quantity, v_cases::integer,
      coalesce(v_unit_cost, v_item.unit_cost),
      case when coalesce(v_unit_cost, v_item.unit_cost) is null then null
           else round(v_quantity * coalesce(v_unit_cost, v_item.unit_cost), 2) end,
      coalesce(nullif(trim(p_vendor_name), ''), v_item.vendor_name),
      null, coalesce(p_received_at, now()), nullif(trim(p_notes), '')
    );
    v_saved := v_saved + 1;
  end loop;

  v_result := jsonb_build_object('replayed', false, 'saved', v_saved, 'created', v_created);
  update public.inventory_write_receipts
  set result = v_result
  where property_id = p_property_id and request_id = p_request_id;
  return v_result;
end
$$;

revoke all on function public.staxis_receive_inventory_delivery(uuid, uuid, timestamptz, text, text, jsonb)
  from public, anon;
grant execute on function public.staxis_receive_inventory_delivery(uuid, uuid, timestamptz, text, text, jsonb)
  to authenticated, service_role;

-- ─── Concurrency-safe, ledger-atomic PO receiving ─────────────────────────
-- V2 derives every delta from locked database state. The V1 body is replaced
-- below for defense in depth, but service-role execution is revoked: during a
-- rolling deployment an old server fails closed instead of writing an
-- incomplete or duplicate delivery ledger.
create or replace function public.staxis_receive_po_lines_v2(
  p_property_id uuid,
  p_po_id uuid,
  p_lines jsonb
) returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  r record;
  v_po public.purchase_orders%rowtype;
  v_line public.purchase_order_lines%rowtype;
  v_line_id uuid;
  v_target numeric;
  v_delta numeric;
  v_all_received boolean;
  v_any_received boolean;
  v_updated integer;
begin
  if jsonb_typeof(p_lines) <> 'array' then raise exception 'PO receive lines must be an array'; end if;

  select * into v_po
  from public.purchase_orders p
  where p.id = p_po_id and p.property_id = p_property_id
  for update;
  if not found then raise exception 'purchase order not found for property' using errcode = 'P0002'; end if;
  if v_po.status = 'cancelled' then raise exception 'purchase order is cancelled'; end if;

  for r in select value from jsonb_array_elements(p_lines)
  loop
    v_line_id := (r.value->>'line_id')::uuid;
    v_target := (r.value->>'target_qty')::numeric;
    if v_target is null
       or v_target::text in ('NaN', 'Infinity', '-Infinity')
       or v_target < 0
    then
      raise exception 'target_qty must be finite and nonnegative';
    end if;

    select * into v_line
    from public.purchase_order_lines l
    where l.id = v_line_id and l.purchase_order_id = p_po_id
    for update;
    if not found then raise exception 'purchase-order line not found for order' using errcode = 'P0002'; end if;

    v_target := greatest(v_line.qty_received, least(v_target, v_line.qty_ordered));
    v_delta := v_target - v_line.qty_received;
    if v_delta > 0 and v_line.item_id is not null then
      update public.inventory
      set current_stock = current_stock + v_delta,
          last_ordered_at = now()
      where id = v_line.item_id
        and property_id = p_property_id
        and archived_at is null;
      get diagnostics v_updated = row_count;
      if v_updated <> 1 then
        raise exception 'active PO inventory item not found for property' using errcode = 'P0002';
      end if;

      insert into public.inventory_orders (
        property_id, item_id, item_name, quantity, unit_cost, total_cost,
        vendor_name, ordered_at, received_at, notes
      ) values (
        p_property_id, v_line.item_id, v_line.description, v_delta,
        case when v_line.unit_cost_cents > 0 then v_line.unit_cost_cents::numeric / 100 else null end,
        case when v_line.unit_cost_cents > 0 then round(v_delta * v_line.unit_cost_cents::numeric / 100, 2) else null end,
        v_po.vendor_name_snapshot, coalesce(v_po.sent_at, v_po.created_at), now(),
        'Received ' || v_po.po_number
      );
    end if;

    update public.purchase_order_lines
    set qty_received = v_target
    where id = v_line.id and purchase_order_id = p_po_id;
  end loop;

  select coalesce(bool_and(qty_received >= qty_ordered), false),
         coalesce(bool_or(qty_received > 0), false)
  into v_all_received, v_any_received
  from public.purchase_order_lines
  where purchase_order_id = p_po_id;

  update public.purchase_orders
  set status = case
        when v_all_received then 'received'
        when v_any_received then 'partially_received'
        else status
      end,
      received_at = case when v_all_received then coalesce(received_at, now()) else received_at end,
      updated_at = now()
  where id = p_po_id and property_id = p_property_id;
end
$$;

revoke all on function public.staxis_receive_po_lines_v2(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.staxis_receive_po_lines_v2(uuid, uuid, jsonb)
  to service_role;

-- Preserve a safe body at the old signature for privileged maintenance, but
-- never trust its legacy `delta`/`item_id` fields. V2 locks each canonical PO
-- line and derives the delta from qty_received. The application service role
-- intentionally receives no EXECUTE grant on V1; only the new V2 contract may
-- receive purchase orders after this migration.
create or replace function public.staxis_receive_po_lines(
  p_property_id uuid,
  p_po_id uuid,
  p_lines jsonb
) returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  perform public.staxis_receive_po_lines_v2(p_property_id, p_po_id, p_lines);
end
$$;

revoke all on function public.staxis_receive_po_lines(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;

-- auth-user deletion must never cascade-delete a live hotel. The explicit
-- admin property-delete route removes the property first, then its auth user.
alter table public.properties
  drop constraint if exists properties_owner_id_fkey,
  add constraint properties_owner_id_fkey
    foreign key (owner_id) references auth.users(id) on delete restrict;

insert into public.applied_migrations (version, description)
values (
  '0310',
  'Inventory integrity: item provenance/soft archive, append-only ledgers, composite tenant FKs, idempotent atomic count+delivery RPCs, concurrency-safe PO receive, and owner-delete protection.'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
