-- Migration 0085: observed-rate view that accounts for orders + discards
--
-- Adversarial review (2026-05-13) finding I-C3: the post-count-process
-- TS handler computes observed daily rate as (older - newer) / days,
-- ignoring orders received and discards logged between counts. The Python
-- ML training code at ml-service/src/training/inventory_rate.py:659-668
-- gets the math right:
--   consumption = max(0, older + orders_in_window - discards_in_window - newer)
--   daily_rate = consumption / days_elapsed
-- This view mirrors that math in SQL so both consumers (TS post-count
-- handler and any future analytics) agree on what "observed rate" means.
--
-- Stock equation:
--   newer = older + orders - discards - consumption
--   ⇒ consumption = older + orders - discards - newer
--
-- Discards SUBTRACT (they reduce stock without being consumption); orders
-- ADD (they increase stock). Both must be netted out before attributing
-- the residual to consumption. Today's TS code attributes ALL of (older -
-- newer) to consumption — wrong in both directions:
--   - 20-unit order in window → underestimates consumption by 20
--   - 5-unit discard in window → overestimates consumption by 5
-- This pollutes prediction_log.actual_value, which feeds shadow MAE,
-- which gates model graduation. Bad inputs → bad models promoted.

create or replace view public.inventory_observed_rate_v as
with paired_counts as (
  -- Pair each count with its predecessor (per item).
  select
    c.id              as newer_count_id,
    c.property_id,
    c.item_id,
    c.counted_at      as newer_counted_at,
    c.counted_stock   as newer_stock,
    lag(c.id)            over w as older_count_id,
    lag(c.counted_at)    over w as older_counted_at,
    lag(c.counted_stock) over w as older_stock
  from public.inventory_counts c
  window w as (partition by c.item_id order by c.counted_at)
),
windowed_movements as (
  -- For each (item, window) compute orders + discards in (older, newer].
  select
    p.newer_count_id,
    p.property_id,
    p.item_id,
    p.older_counted_at,
    p.newer_counted_at,
    p.older_stock,
    p.newer_stock,
    -- Use received_at (always set) for orders; ordered_at is nullable
    -- and represents PO-placed time, not stock-arrival time.
    coalesce((
      select sum(o.quantity)
      from public.inventory_orders o
      where o.item_id = p.item_id
        and o.received_at >  p.older_counted_at
        and o.received_at <= p.newer_counted_at
    ), 0)::numeric as orders_in_window,
    coalesce((
      select sum(d.quantity)
      from public.inventory_discards d
      where d.item_id = p.item_id
        and d.discarded_at >  p.older_counted_at
        and d.discarded_at <= p.newer_counted_at
    ), 0)::numeric as discards_in_window
  from paired_counts p
  where p.older_count_id is not null
)
select
  w.newer_count_id,
  w.property_id,
  w.item_id,
  w.older_counted_at,
  w.newer_counted_at,
  w.older_stock,
  w.newer_stock,
  w.orders_in_window,
  w.discards_in_window,
  -- Days between counts, floored at 0.5 to avoid divide-by-zero on
  -- two saves within seconds (matches existing TS guard at
  -- src/app/api/inventory/post-count-process/route.ts).
  greatest(
    extract(epoch from (w.newer_counted_at - w.older_counted_at)) / 86400.0,
    0.5
  )::numeric as days_elapsed,
  -- Observed daily consumption rate. Mirrors Python at
  -- ml-service/src/training/inventory_rate.py:659-668.
  greatest(
    (w.older_stock + w.orders_in_window - w.discards_in_window - w.newer_stock)
      / greatest(extract(epoch from (w.newer_counted_at - w.older_counted_at)) / 86400.0, 0.5),
    0
  )::numeric as observed_rate
from windowed_movements w;

comment on view public.inventory_observed_rate_v is
  'Per-item observed daily consumption rate between consecutive counts. Accounts for orders received and discards logged in the window: rate = max(0, (older + orders - discards - newer) / days). Mirrors the Python ML training math. Codex adversarial review 2026-05-13 (I-C3).';

-- RLS: views inherit RLS from their base tables, but we want service_role
-- access for the post-count-process route (uses supabaseAdmin).
grant select on public.inventory_observed_rate_v to service_role;

insert into public.applied_migrations (version, description)
values ('0086', 'Codex review: observed-rate view accounting for orders + discards (I-C3)')
on conflict (version) do nothing;
