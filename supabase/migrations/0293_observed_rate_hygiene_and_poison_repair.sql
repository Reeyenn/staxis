-- ═══════════════════════════════════════════════════════════════════════════
-- 0293 — Inventory-ML data hygiene: align the observed-rate view with the
--         trainer + cohort-prior window rules, and repair poisoned daily_logs.
--
-- WHY (part A — the view)
--   inventory_observed_rate_v (last defined in 0096) is the accuracy scorecard
--   for the inventory-usage model: post-count-process reads it → prediction_log
--   → the realized-MAE backtest + the graduation gate. But the Python trainer
--   (ml-service/src/training/inventory_rate.py::_build_training_rows) and the
--   cohort-prior SQL (ml-service/src/training/inventory_priors.py) were changed
--   to DROP contaminated windows instead of clamping them, and the view was
--   never updated to match. Result: training and its own scorecard disagreed on
--   which windows count — the view still greatest(...,0)-CLAMPED unexplained
--   increases and auto-stock-up windows to a fake 0-rate, over-feeding zeros
--   into the MAE backtest.
--
--   This aligns all three consumers on ONE window rule:
--     keep a window iff  days_elapsed >= 1.0
--                   AND ( consumption > 0
--                         OR (consumption = 0 AND newer_stock <= older_stock) )
--   where consumption = older_stock + orders − discards − newer_stock.
--     • consumption > 0            → real usage. KEEP.
--     • consumption = 0, count flat/down → genuine zero-usage period. KEEP
--       (dropping these would over-estimate intermittently-used items ~2x by
--        learning burn-WHEN-USED instead of average burn).
--     • consumption = 0, count ROSE → the auto-logged "stock-up" order masks
--       real usage (prev + (curr−prev) − curr = 0). DROP.
--     • consumption < 0            → an unexplained stock INCREASE (restock made
--       outside the app, never logged). Corrupt signal. DROP.
--   NO greatest(...,0) clamp: only kept windows reach the projection, so their
--   consumption is already > 0 or a genuine 0.
--
--   Diff vs 0096: (1) drop the `greatest(..., 0)` clamp on observed_rate;
--   (2) add the `consumption > 0 OR (consumption = 0 AND newer_stock <=
--   older_stock)` predicate to the final WHERE. Everything else (paired_counts
--   LAG, orders/discards subqueries filtered by item_id AND property_id, the
--   `raw_days_elapsed >= 1.0` sub-day floor) is byte-for-byte identical to 0096.
--   Safe-degrading: the view only ever returns FEWER rows than before, and the
--   sole consumer (post-count-process) already skips a missing row.
--
-- WHY (part B — the daily_logs repair)
--   While a hotel's PMS robot was down, the seal-daily cron sealed FABRICATED
--   zeros into daily_logs (occupied=0/checkouts=0/stayovers=0) because its trust
--   gate DEFAULTS TO TRUSTED on a feed-status lookup failure and never checked
--   whether the CUA had ever delivered data. Verified in prod: Comfort Suites
--   Beaumont has 14 such rows and ZERO rows in pms_in_house_snapshot (i.e. the
--   robot has never landed a snapshot for it). Those fake 0-occupancy days
--   depress the occupancy feature the inventory model trains on.
--
--   Repair (NON-destructive): for any daily_logs row whose property has NO
--   pms_in_house_snapshot row AND whose occupied = 0, NULL OUT the PMS-derived
--   columns (occupied, checkouts, stayovers) so ML treats the day as "no data"
--   instead of "0% occupancy". Rows are NOT deleted; non-PMS columns
--   (total_minutes, avg_turnaround_minutes, rooms_completed, recommended_staff,
--   wages, etc.) are left untouched. NULL is the honest value the sealer now
--   writes going forward when there is no fresh CUA evidence (see the seal-daily
--   trust-gate fix shipped alongside this migration).
--
--   NOTE ON COLUMNS: the task brief also lists vacant_clean / vacant_dirty /
--   ooo, but daily_logs (defined in 0001) has NO such columns — those live only
--   on pms_in_house_snapshot. The three PMS-derived columns that DO exist on
--   daily_logs are occupied, checkouts, stayovers; all three are nullable in
--   0001 (only property_id, date, created_at, updated_at are NOT NULL). We NULL
--   exactly those three.
--
-- Idempotent: CREATE OR REPLACE VIEW + the UPDATE is naturally idempotent (a
-- second run matches nothing new — the WHERE occupied = 0 no longer holds once
-- occupied is NULL). Safe to re-run.
--
-- Manual prod apply: per project_migration_application_manual.md — this file is
-- NOT auto-applied on deploy; the doctor check is the net.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── Part A — observed-rate view: match the trainer's window hygiene ──────
create or replace view public.inventory_observed_rate_v as
with paired_counts as (
  -- Pair each count with its predecessor (per item). Tie-break on id so two
  -- saves at the same microsecond order deterministically (0096 F8a).
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
  -- For each (item, window) sum orders + discards in (older, newer]. Filter by
  -- item_id AND property_id for defense-in-depth + consistency with the Python
  -- consumers (0096 N11).
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
  -- No greatest(...,0) clamp (that was the 0096 behavior): the final WHERE only
  -- lets through windows whose consumption is already > 0 or a genuine 0, so the
  -- honest quotient is safe. Mirrors training/inventory_rate.py::
  -- _build_training_rows + inventory_priors.py: keep positive consumption AND
  -- genuine zero-usage windows (count flat/down); drop unexplained increases
  -- (<0) and auto-stock-up zeros (=0 on a count that ROSE).
  ((w.older_stock + w.orders_in_window - w.discards_in_window - w.newer_stock)
    / w.raw_days_elapsed)::numeric as observed_rate
from windowed_movements w
where w.raw_days_elapsed >= 1.0
  and (
    (w.older_stock + w.orders_in_window - w.discards_in_window - w.newer_stock) > 0
    or (
      (w.older_stock + w.orders_in_window - w.discards_in_window - w.newer_stock) = 0
      and w.newer_stock <= w.older_stock
    )
  );

comment on view public.inventory_observed_rate_v is
  'Per-item observed daily consumption rate between consecutive counts. Mirrors the Python trainer (training/inventory_rate.py::_build_training_rows) + cohort-prior SQL (inventory_priors.py): drops sub-day pairs (< 1.0 day), unexplained-increase (<0) and auto-stock-up (=0 on a count-up) windows; keeps genuine zero-usage windows; NO greatest(...,0) clamp. Supersedes 0096 (which clamped contaminated windows to a fake 0-rate, disagreeing with the trainer).';

grant select on public.inventory_observed_rate_v to service_role;

-- ─── Part B — one-off repair of poisoned daily_logs (fabricated zeros) ────
-- Rows written while a property's PMS robot was down slipped past the (now
-- fixed) trust gate that defaulted to trusted. NULL the three PMS-derived
-- columns for any such row (property has NO pms_in_house_snapshot AND
-- occupied = 0), leaving the row and all non-PMS columns intact.
--
-- SCOPE NOTE: the "no pms_in_house_snapshot row" predicate also matches a
-- genuinely-manual no-PMS hotel that legitimately entered occupied=0 via the
-- UI (src/lib/db/daily-logs.ts saveDailyLog). That is INTENTIONAL and safe: a
-- hotel with no PMS has no trustworthy machine-sourced occupancy, so NULL
-- ("no PMS data") is the honest label — the sealer's own trust gate writes
-- NULL for exactly these hotels going forward. Rows are never deleted, so a
-- manual hotel loses nothing structural; only the PMS-provenance columns reset
-- to "unknown". The verified target (Comfort Suites) is a live-robot hotel
-- whose robot was down; it re-acquires a snapshot row on recovery, after which
-- no future rows match this WHERE.
update public.daily_logs dl
set
  occupied  = null,
  checkouts = null,
  stayovers = null
where dl.occupied = 0
  and not exists (
    select 1
    from public.pms_in_house_snapshot s
    where s.property_id = dl.property_id
  );

-- ─── applied_migrations bookkeeping ──────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0293',
  'Inventory-ML hygiene: rewrite inventory_observed_rate_v to match the trainer + cohort-prior window rules (drop unexplained-increase/auto-stock-up windows, no greatest(...,0) clamp), superseding 0096; one-off repair NULLing occupied/checkouts/stayovers on daily_logs rows fabricated as 0 while a property had no pms_in_house_snapshot (dead-robot days).'
)
on conflict (version) do nothing;

COMMIT;

NOTIFY pgrst, 'reload schema';
