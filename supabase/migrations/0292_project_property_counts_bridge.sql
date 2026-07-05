-- ═══════════════════════════════════════════════════════════════════════════
-- 0292 — Bridge: pms_* → plan_snapshots projection (FUTURE dates).
--
-- WHAT & WHY
--   The Python ML service (ml-service/src/{inference,training}/*.py) reads
--   tomorrow's PROJECTED occupancy from public.plan_snapshots to serve the
--   inventory-usage model at the right x (daily_rate = a + b·occupancy_pct).
--   plan_snapshots is an EMPTY stub since Plan v4 (0205 recreated it; the old
--   Railway scraper that wrote it was deleted, and nothing writes it today),
--   so ML has silently fallen back to a 14-day historic mean on every run.
--
--   The new CUA pipeline HAS the data, in the pms_* tables (0202). This
--   migration adds project_property_counts_v1(property_id, target_date): the
--   forward-looking sibling of today_property_counts_v1 (0224). It computes,
--   for a FUTURE date, the plan_snapshots-shaped counts the ML code reads —
--   derived from pms_reservations (arrivals + stayovers spanning the date) and
--   pms_rooms_inventory (room total, fallback to properties.total_rooms).
--
--   A companion writer (the seal-daily cron, src/app/api/cron/seal-daily) calls
--   this RPC and UPSERTs plan_snapshots rows for today + tomorrow per property,
--   so the projection flows automatically for every hotel with a live CUA feed.
--   Zero Python changes: ML keeps reading plan_snapshots exactly as before.
--
-- COLUMN MAPPING (what ML reads ⇐ what this RPC fills)
--   inventory_rate.py::_occupancy_for_target_date reads:
--       occ% = 100·(stayovers + arrivals) / total_rooms
--     ← arrivals    = reservations with arrival_date = target (not cancelled/
--                     no_show/checked_out)
--     ← stayovers   = reservations spanning the target (arrival < target <
--                     departure, status booked/checked_in)
--     ← total_rooms = pms_rooms_inventory count (fallback properties.total_rooms)
--
--   demand.py / supply.py / training/demand.py read occupancy as:
--       occ% = 100·(total_rooms − vacant_clean − vacant_dirty − ooo) / total_rooms
--     For a PROJECTION there is no live housekeeping state, so we set
--       vacant_clean = max(0, total_rooms − (stayovers + arrivals))
--       vacant_dirty = 0 ; ooo = 0
--     ⇒ occupied = total_rooms − vacant_clean = stayovers + arrivals, i.e. the
--       demand/supply occupancy formula converges to the SAME projected
--       occupancy the inventory path uses. One projection, both readers happy.
--
--   demand/supply also read the cleaning-composition columns:
--       checkouts            ← reservations with departure_date = target
--       stayover_day1        ← stayovers (whole stayover bucket labelled day-1;
--                              the projection has no per-night day-of-stay split,
--                              and demand.py sums day1+day2+arrival+unknown into
--                              one "stayover_day_2plus" feature anyway)
--       stayover_day2/arrival_day/unknown ← 0 (folded into stayover_day1)
--       total_cleaning_minutes ← 0 (unknown at projection time; supply/demand
--                              COALESCE it to 0 and the trained models weight it
--                              lightly — leaving it 0 is truthful, not fake data)
--   The *_room_numbers text[] arrays (supply.py per-room path) are populated
--   from the projected reservations so supply's synthetic-room path has real
--   room lists instead of falling back to "everyone stayover day 1".
--
-- SEMANTICS NOTE — "no CUA data" is the writer's job, not the RPC's.
--   This RPC always returns exactly one row (COALESCEs to 0). It CANNOT tell
--   "genuinely 0 occupancy" from "no snapshot yet". The seal-daily writer gates
--   on the property actually having a pms_in_house_snapshot row + trusted feed
--   status BEFORE it upserts, so we never poison ML with fake 0-occupancy rows.
--   Same trust-boundary discipline the seal-daily daily_logs write already uses.
--
-- Modeled on 0224 (today_property_counts_v1): SQL, STABLE, SECURITY DEFINER,
-- same grants. Idempotent (create or replace). Safe to re-run.
--
-- Manual prod apply: per project_migration_application_manual.md — this file
-- is NOT auto-applied on deploy; the doctor check is the net.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── Drop existing (defensive — for re-apply during dev) ──────────────────
DROP FUNCTION IF EXISTS public.project_property_counts_v1(uuid, date);

-- ─── project_property_counts_v1 ──────────────────────────────────────────
-- Forward-looking projection of plan_snapshots-shaped counts for a FUTURE
-- (or today's) date, derived from pms_reservations + pms_rooms_inventory.
-- Returns exactly one row. The caller decides whether to persist it (gated
-- on the property having live CUA data).

CREATE OR REPLACE FUNCTION public.project_property_counts_v1(
  p_property_id uuid,
  p_target_date date
)
RETURNS TABLE (
  total_rooms                 int,
  arrivals                    int,
  stayovers                   int,
  checkouts                   int,
  vacant_clean                int,
  vacant_dirty                int,
  ooo                         int,
  stayover_day1               int,
  stayover_day2               int,
  stayover_arrival_day        int,
  stayover_unknown            int,
  arrival_room_numbers        text[],
  stayover_day1_room_numbers  text[],
  checkout_room_numbers       text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH rooms AS (
    -- Prefer the CUA-learned room list; fall back to the property's
    -- configured room count so occupancy math is never divided by 0 for
    -- hotels whose room layout feed hasn't landed yet.
    SELECT
      GREATEST(
        (SELECT COUNT(*) FROM public.pms_rooms_inventory WHERE property_id = p_property_id),
        COALESCE((SELECT total_rooms FROM public.properties WHERE id = p_property_id), 0)
      )::int AS total
  ),
  res AS (
    SELECT
      -- ARRIVALS: checking in ON the target date, still an active reservation.
      COUNT(*) FILTER (
        WHERE arrival_date = p_target_date
          AND (status IS NULL OR status IN ('booked','checked_in'))
      ) AS arrivals,
      -- STAYOVERS: already in-house before the target date and staying THROUGH
      -- it (arrival strictly before target, departure strictly after).
      COUNT(*) FILTER (
        WHERE arrival_date < p_target_date
          AND departure_date > p_target_date
          AND (status IS NULL OR status IN ('booked','checked_in'))
      ) AS stayovers,
      -- CHECKOUTS: departing on the target date (composition feature for
      -- demand/supply; not part of occupancy).
      COUNT(*) FILTER (
        WHERE departure_date = p_target_date
          AND (status IS NULL OR status IN ('booked','checked_in','checked_out'))
      ) AS checkouts,
      -- Room-number arrays for supply.py's per-room path. Reservations may
      -- lack a room_number this far out; NULLs are stripped so the array only
      -- carries assigned rooms (supply falls back to day-1 for unassigned).
      COALESCE(
        ARRAY_AGG(room_number) FILTER (
          WHERE arrival_date = p_target_date
            AND (status IS NULL OR status IN ('booked','checked_in'))
            AND room_number IS NOT NULL
        ),
        '{}'
      ) AS arrival_rooms,
      COALESCE(
        ARRAY_AGG(room_number) FILTER (
          WHERE arrival_date < p_target_date
            AND departure_date > p_target_date
            AND (status IS NULL OR status IN ('booked','checked_in'))
            AND room_number IS NOT NULL
        ),
        '{}'
      ) AS stayover_rooms,
      COALESCE(
        ARRAY_AGG(room_number) FILTER (
          WHERE departure_date = p_target_date
            AND (status IS NULL OR status IN ('booked','checked_in','checked_out'))
            AND room_number IS NOT NULL
        ),
        '{}'
      ) AS checkout_rooms
    FROM public.pms_reservations
    WHERE property_id = p_property_id
      -- Bound the scan: any reservation that could touch the target date.
      AND arrival_date <= p_target_date
      AND departure_date >= p_target_date
  )
  SELECT
    rooms.total                                                         AS total_rooms,
    res.arrivals::int                                                   AS arrivals,
    res.stayovers::int                                                  AS stayovers,
    res.checkouts::int                                                  AS checkouts,
    -- Projected vacancy: whatever isn't occupied on the target date reads as
    -- vacant_clean, so the demand/supply occupancy formula
    -- (total − vacant_clean − vacant_dirty − ooo) collapses to arrivals+stayovers.
    GREATEST(0, rooms.total - (res.arrivals + res.stayovers))::int      AS vacant_clean,
    0                                                                   AS vacant_dirty,
    0                                                                   AS ooo,
    -- Whole stayover bucket labelled day-1 (no per-night split at projection
    -- time; demand.py folds day1/day2/arrival/unknown into one feature).
    res.stayovers::int                                                  AS stayover_day1,
    0                                                                   AS stayover_day2,
    0                                                                   AS stayover_arrival_day,
    0                                                                   AS stayover_unknown,
    res.arrival_rooms                                                   AS arrival_room_numbers,
    res.stayover_rooms                                                  AS stayover_day1_room_numbers,
    res.checkout_rooms                                                  AS checkout_room_numbers
  FROM rooms
  CROSS JOIN res;
$$;

COMMENT ON FUNCTION public.project_property_counts_v1(uuid, date) IS
  'Plan v4 bridge (0292) — FORWARD-looking projection of plan_snapshots-shaped counts for a future/today date, derived live from pms_reservations + pms_rooms_inventory. Returns arrivals, stayovers, checkouts, total_rooms, and the vacant_clean/stayover_day1/room-number columns the Python ML service reads from plan_snapshots (inventory occupancy = (stayovers+arrivals)/total_rooms; demand/supply occupancy = (total_rooms−vacant_clean)/total_rooms converges to the same value). Companion to today_property_counts_v1 (0224). Caller (seal-daily cron) decides whether to persist, gated on the property having live CUA data.';

-- ─── Grant EXECUTE (same posture as 0224) ────────────────────────────────
-- SECURITY DEFINER bypasses RLS internally; the body only ever filters by the
-- passed property_id, so it's safe. Callers must validate property ownership
-- BEFORE invoking. service_role (seal-daily) is the only real caller today;
-- anon/authenticated mirror 0224 for parity with the other bridge RPC.
GRANT EXECUTE ON FUNCTION public.project_property_counts_v1(uuid, date) TO anon, authenticated, service_role;

-- ─── applied_migrations bookkeeping ──────────────────────────────────────
INSERT INTO public.applied_migrations (version, description)
VALUES (
  '0292',
  'Bridge pms_* → plan_snapshots projection: project_property_counts_v1(property_id, target_date) computes future-date arrivals/stayovers/checkouts/total_rooms + the vacant_clean/room-number columns the Python ML inventory/demand/supply code reads from plan_snapshots. Feeds the seal-daily cron''s today+tomorrow plan_snapshots upsert so ML uses real projected occupancy instead of the 14-day-mean fallback.'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
