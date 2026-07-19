-- 0323 — Separate purchase budgets from usage caps and freeze close-time caps.
--
-- inventory_budgets originally represented money available for purchases.
-- Month-close accounting compares the inventory usage equation instead:
--
--   beginning owned value + confirmed purchases - ending owned value
--
-- Those are different facts.  A basis column lets both plans coexist for the
-- same property/key/month, while preserving every pre-0323 row as a purchase
-- budget.  Closed months snapshot the applicable usage caps so a later budget
-- edit, mode switch, or custom-section deletion cannot rewrite history.

begin;

-- ─── Budget basis ─────────────────────────────────────────────────────────

alter table public.inventory_budgets
  add column if not exists basis text;

-- Existing rows powered purchase/reorder headroom.  Never reinterpret them as
-- usage caps during this migration.
update public.inventory_budgets
set basis = 'purchases'
where basis is null;

alter table public.inventory_budgets
  alter column basis set default 'purchases',
  alter column basis set not null;

alter table public.inventory_budgets
  drop constraint if exists inventory_budgets_basis_check;
alter table public.inventory_budgets
  add constraint inventory_budgets_basis_check
  check (basis in ('purchases', 'usage'));

-- The former key omitted basis and therefore made the two budget concepts
-- overwrite one another.  There are no foreign keys to this primary key.
alter table public.inventory_budgets
  drop constraint if exists inventory_budgets_pkey;
alter table public.inventory_budgets
  add constraint inventory_budgets_pkey
  primary key (property_id, category, month_start, basis);

comment on column public.inventory_budgets.basis is
  '''purchases'' is live purchasing/reorder headroom; ''usage'' is a full-month cap compared only with an immutable closed-month usage actual. Pre-0323 rows are purchases.';
comment on table public.inventory_budgets is
  'Monthly inventory plans. basis distinguishes purchase headroom from closed-month usage caps. Custom section keys are strings by design so deleting a live section never cascades away historical plan rows.';

-- Budget writes must serialize with staxis_close_inventory_month_close.  The
-- close RPC already locks the property row, as do property-mode and section
-- edits; 0322 did not yet put the same lock on inventory_budgets themselves.
drop trigger if exists inventory_budget_month_close_lock on public.inventory_budgets;
create trigger inventory_budget_month_close_lock
  before insert or update or delete on public.inventory_budgets
  for each row execute function public.staxis_inventory_close_property_lock();

-- ─── Immutable usage-budget evidence on the close header ─────────────────

alter table public.inventory_month_closes
  add column if not exists usage_budget_mode text,
  add column if not exists usage_budget_total_cents bigint,
  add column if not exists usage_budget_by_key jsonb;

comment on column public.inventory_month_closes.usage_budget_mode is
  'Close-time snapshot of properties.inventory_budget_mode (total|sections). Null only while open.';
comment on column public.inventory_month_closes.usage_budget_total_cents is
  'Close-time total of applicable positive usage caps. In total mode this is the total-key cap; in sections mode it is the sum of built-in and then-active custom-section caps. Null means no positive cap.';
comment on column public.inventory_month_closes.usage_budget_by_key is
  'Close-time immutable JSON object of applicable positive usage caps, in cents, keyed exactly like inventory_budgets.category. Empty object means no positive cap.';

-- One canonical selector is shared by the transition trigger and migration
-- backfill.  In sections mode, orphan section:<uuid> rows remain durable but
-- are not an active future cap after the live section has been deleted.
create or replace function public.staxis_inventory_usage_budget_snapshot(
  p_property_id uuid,
  p_month_start date
) returns table (
  usage_budget_mode text,
  usage_budget_total_cents bigint,
  usage_budget_by_key jsonb
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with property_config as (
    select p.inventory_budget_mode as mode
    from public.properties p
    where p.id = p_property_id
  ), applicable as (
    select b.category as budget_key, b.budget_cents::bigint as budget_cents
    from property_config pc
    join public.inventory_budgets b
      on b.property_id = p_property_id
     and b.month_start = p_month_start
     and b.basis = 'usage'
     and b.budget_cents > 0
    where
      (pc.mode = 'total' and b.category = 'total')
      or
      (pc.mode = 'sections' and (
        b.category in ('housekeeping', 'maintenance', 'breakfast')
        or exists (
          select 1
          from public.inventory_budget_sections s
          where s.property_id = p_property_id
            and b.category = 'section:' || s.id::text
        )
      ))
  )
  select
    pc.mode::text,
    (select sum(a.budget_cents)::bigint from applicable a),
    coalesce(
      (
        select jsonb_object_agg(a.budget_key, a.budget_cents order by a.budget_key)
        from applicable a
      ),
      '{}'::jsonb
    )
  from property_config pc;
$$;

revoke all on function public.staxis_inventory_usage_budget_snapshot(uuid, date)
  from public, anon, authenticated;

-- Best-available backfill for any 0322 close completed before this migration.
-- Legacy budget rows have just been classified as purchases, so they are not
-- silently repurposed as usage caps.  The header guard must be disabled only
-- inside this migration transaction because closed headers are otherwise (and
-- remain) immutable.
alter table public.inventory_month_closes
  disable trigger inventory_month_close_header_guard;

update public.inventory_month_closes c
set (
  usage_budget_mode,
  usage_budget_total_cents,
  usage_budget_by_key
) = (
  select
    s.usage_budget_mode,
    s.usage_budget_total_cents,
    s.usage_budget_by_key
  from public.staxis_inventory_usage_budget_snapshot(c.property_id, c.month_start) s
)
where c.status = 'closed'
  and c.usage_budget_mode is null;

alter table public.inventory_month_closes
  enable trigger inventory_month_close_header_guard;

alter table public.inventory_month_closes
  drop constraint if exists inventory_month_closes_usage_budget_mode_check,
  drop constraint if exists inventory_month_closes_usage_budget_total_check,
  drop constraint if exists inventory_month_closes_usage_budget_map_check,
  drop constraint if exists inventory_month_closes_usage_budget_state_check;

alter table public.inventory_month_closes
  add constraint inventory_month_closes_usage_budget_mode_check
    check (usage_budget_mode is null or usage_budget_mode in ('total', 'sections')),
  add constraint inventory_month_closes_usage_budget_total_check
    check (usage_budget_total_cents is null or usage_budget_total_cents > 0),
  add constraint inventory_month_closes_usage_budget_map_check
    check (usage_budget_by_key is null or jsonb_typeof(usage_budget_by_key) = 'object'),
  add constraint inventory_month_closes_usage_budget_state_check
    check (
      (status = 'open'
        and usage_budget_mode is null
        and usage_budget_total_cents is null
        and usage_budget_by_key is null)
      or
      (status = 'closed'
        and usage_budget_mode is not null
        and usage_budget_by_key is not null)
    );

create or replace function public.staxis_snapshot_inventory_usage_budget_on_close()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_snapshot record;
begin
  -- Open rows never carry a caller-provided preview.  The authoritative value
  -- is read atomically only when the row becomes closed.
  if new.status = 'open' then
    new.usage_budget_mode := null;
    new.usage_budget_total_cents := null;
    new.usage_budget_by_key := null;
    return new;
  end if;

  if tg_op = 'INSERT' or (old.status = 'open' and new.status = 'closed') then
    select * into v_snapshot
    from public.staxis_inventory_usage_budget_snapshot(new.property_id, new.month_start);

    if not found then
      raise exception 'inventory usage-budget snapshot property not found'
        using errcode = '23503';
    end if;

    -- Always overwrite caller input.  The existing SECURITY DEFINER close RPC
    -- therefore cannot accidentally or deliberately bypass this snapshot.
    new.usage_budget_mode := v_snapshot.usage_budget_mode;
    new.usage_budget_total_cents := v_snapshot.usage_budget_total_cents;
    new.usage_budget_by_key := v_snapshot.usage_budget_by_key;
  end if;

  return new;
end
$$;

revoke all on function public.staxis_snapshot_inventory_usage_budget_on_close()
  from public, anon, authenticated;

drop trigger if exists inventory_month_close_usage_budget_snapshot
  on public.inventory_month_closes;
create trigger inventory_month_close_usage_budget_snapshot
  before insert or update on public.inventory_month_closes
  for each row execute function public.staxis_snapshot_inventory_usage_budget_on_close();

-- Fire even if a replication-role session invokes the existing close RPC.
-- PostgreSQL triggers also fire normally inside SECURITY DEFINER functions;
-- ALWAYS makes that invariant explicit for non-origin sessions as well.
alter table public.inventory_month_closes
  enable always trigger inventory_month_close_usage_budget_snapshot;

insert into public.applied_migrations(version, description)
values (
  '0323',
  'Inventory budget integrity: purchase|usage basis with basis-inclusive key; serialized budget writes; immutable close-time usage budget mode, total, and by-key snapshots; legacy close backfill; custom-section deletion preserves historical rows.'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
