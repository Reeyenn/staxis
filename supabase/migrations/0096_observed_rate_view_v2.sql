-- Migration 0093: observed-rate view v2 — day-1 floor + deterministic LAG + property_id filter
--
-- Codex post-merge review (2026-05-13) findings F8, F8a, N11 against the
-- view introduced in migration 0086:
--   F8  — 0.5-day floor turns a 30-second double-save into a 2× rate row.
--   F8a — LAG window ORDER BY counted_at is ambiguous when two counts have
--         the same microsecond timestamp.
--   N11 — orders/discards subqueries filter by item_id only. Items are
--         property-scoped (FK to inventory), so cross-property collision
--         is astronomically unlikely with UUIDs, but inventory_priors.py
--         already filters by both — the two consumers disagree on
--         defense-in-depth.
--
-- Fixes:
--   1. WHERE days_elapsed >= 1.0 — drop sub-day pairs entirely. The legacy
--      0.5 floor produced finite-but-wrong rates; missing rows are
--      handled by the consumer (post-count-process falls back to the
--      legacy formula on no-row, but with the day-1 gate it just skips
--      that count-pair for the training feedback loop, which is correct).
--   2. LAG window adds id ASC as a tie-breaker — deterministic ordering.
--   3. Orders + discards subqueries filter by both item_id AND
--      property_id for defense-in-depth and consistency.

create or replace view public.inventory_observed_rate_v as
with paired_counts as (
  -- Pair each count with its predecessor (per item). Codex post-merge F8a:
  -- tie-break on id so two saves at the same microsecond have deterministic
  -- ordering across runs.
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
  window w as (partition by c.item_id order by c.counted_at asc, c.id asc)
),
windowed_movements as (
  -- For each (item, window) compute orders + discards in (older, newer].
  -- Codex post-merge N11: filter by property_id too (defense-in-depth +
  -- consistency with inventory_priors.py).
  select
    p.newer_count_id,
    p.property_id,
    p.item_id,
    p.older_counted_at,
    p.newer_counted_at,
    p.older_stock,
    p.newer_stock,
    coalesce((
      select sum(o.quantity)
      from public.inventory_orders o
      where o.item_id = p.item_id
        and o.property_id = p.property_id
        and o.received_at >  p.older_counted_at
        and o.received_at <= p.newer_counted_at
    ), 0)::numeric as orders_in_window,
    coalesce((
      select sum(d.quantity)
      from public.inventory_discards d
      where d.item_id = p.item_id
        and d.property_id = p.property_id
        and d.discarded_at >  p.older_counted_at
        and d.discarded_at <= p.newer_counted_at
    ), 0)::numeric as discards_in_window,
    extract(epoch from (p.newer_counted_at - p.older_counted_at)) / 86400.0 as raw_days_elapsed
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
  w.raw_days_elapsed::numeric as days_elapsed,
  -- Codex post-merge F8: drop the 0.5-day floor entirely. Pairs with
  -- raw_days_elapsed < 1.0 are filtered out by the WHERE below — they're
  -- noise, not signal. The observed_rate is now computed honestly without
  -- a divisor floor.
  greatest(
    (w.older_stock + w.orders_in_window - w.discards_in_window - w.newer_stock)
      / w.raw_days_elapsed,
    0
  )::numeric as observed_rate
from windowed_movements w
where w.raw_days_elapsed >= 1.0;

comment on view public.inventory_observed_rate_v is
  'Per-item observed daily consumption rate between consecutive counts. Mirrors Python ml-service inventory_rate.py training math. Codex review 2026-05-13 (I-C3) + post-merge review (F8 day-1 floor, F8a deterministic LAG, N11 property_id filter).';

grant select on public.inventory_observed_rate_v to service_role;

insert into public.applied_migrations (version, description)
values ('0096', 'Codex post-merge review: observed-rate view v2 — day-1 floor + deterministic LAG + property_id filter (F8/F8a/N11)')
on conflict (version) do nothing;
