-- Plan v4 cleanup follow-on — bridge between the new pms_* tables
-- (written by the vision CUA) and the housekeeping app's Schedule tab
-- + ML feature derivation, both of which used to read plan_snapshots
-- (dropped in v4).
--
-- What this exposes:
--
--   public.today_room_work_v1(p_property_id uuid, p_date date)
--     RETURNS TABLE (room_number text, stay_type text, housekeeper text,
--                    stayover_day int)
--
--   public.today_property_counts_v1(p_property_id uuid, p_date date)
--     RETURNS TABLE (checkouts int, stayovers int, vacant_clean int,
--                    vacant_dirty int, ooo int, total_rooms int,
--                    total_checkouts_today int, in_house int)
--
-- Both are derived live from pms_room_status_log (latest row per room) +
-- pms_reservations (today's arrivals + stayovers) + pms_in_house_snapshot
-- (per-property aggregates). Single source of truth = whatever the CUA
-- wrote most recently.
--
-- Why a SQL function (not a view): the date parameter has to be runtime —
-- a view tied to CURRENT_DATE creates per-tenant timezone weirdness, and
-- a parameterized view (functionally) needs the function-style syntax
-- anyway. Set-returning function gives the same ergonomics from the app
-- side (SELECT * FROM today_room_work_v1(pid, '2026-05-25')).
--
-- Cost: PostgREST RPC, ~50ms per call against ~200 rooms. The Schedule
-- tab polls every 30s today and would call this RPC instead. Cheap.

BEGIN;

-- ─── Drop existing (defensive — for re-apply during dev) ──────────────────
DROP FUNCTION IF EXISTS public.today_room_work_v1(uuid, date);
DROP FUNCTION IF EXISTS public.today_property_counts_v1(uuid, date);

-- ─── today_room_work_v1 ──────────────────────────────────────────────────
-- For each room the CUA knows about (latest row in pms_room_status_log),
-- decide what work it needs today:
--   stay_type = 'C/O'  when today's pms_reservations row has departure_date = p_date
--   stay_type = 'Stay' when today's pms_reservations row covers p_date but
--                      departure_date > p_date
--   stay_type = NULL   for vacant / OOO rooms (Schedule tab skips these)
--
-- housekeeper comes from pms_housekeeping_assignments if present.
-- stayover_day counts inclusive nights elapsed so the UI can label S1/S2.

CREATE OR REPLACE FUNCTION public.today_room_work_v1(
  p_property_id uuid,
  p_date date
)
RETURNS TABLE (
  room_number   text,
  stay_type     text,
  housekeeper   text,
  stayover_day  int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- One row per room (latest status), joined to today's reservation +
  -- today's housekeeping assignment.
  WITH latest_status AS (
    SELECT DISTINCT ON (room_number)
      room_number, status
    FROM public.pms_room_status_log
    WHERE property_id = p_property_id
    ORDER BY room_number, changed_at DESC
  ),
  today_res AS (
    SELECT
      r.room_number,
      CASE
        WHEN r.departure_date = p_date THEN 'C/O'
        WHEN r.arrival_date <= p_date AND r.departure_date > p_date THEN 'Stay'
        ELSE NULL
      END                                      AS stay_type,
      -- inclusive day-of-stay (1-indexed): first night = 1
      GREATEST(1, (p_date - r.arrival_date) + 1) AS stayover_day
    FROM public.pms_reservations r
    WHERE r.property_id = p_property_id
      AND r.arrival_date <= p_date
      AND r.departure_date >= p_date
  ),
  today_assign AS (
    SELECT room_number, housekeeper_name
    FROM public.pms_housekeeping_assignments
    WHERE property_id = p_property_id
      AND date = p_date
  )
  SELECT
    ls.room_number,
    tr.stay_type,
    ta.housekeeper_name AS housekeeper,
    tr.stayover_day
  FROM latest_status ls
  LEFT JOIN today_res    tr ON tr.room_number = ls.room_number
  LEFT JOIN today_assign ta ON ta.room_number = ls.room_number
  ORDER BY ls.room_number;
$$;

COMMENT ON FUNCTION public.today_room_work_v1(uuid, date) IS
  'Plan v4 bridge — returns one row per known room with stay_type (C/O / Stay / NULL), housekeeper name, and stayover day-of-stay. Replaces the plan_snapshots.rooms[] jsonb that the housekeeping Schedule tab and snapshotToShiftRooms helper used to read. Source of truth: latest pms_room_status_log + today''s pms_reservations + today''s pms_housekeeping_assignments. Set-returning function so the date is a runtime parameter.';

-- ─── today_property_counts_v1 ────────────────────────────────────────────
-- Day-level aggregates that the deleted feature-derivation.ts +
-- seal-daily cron used to read straight off plan_snapshots. Now derived
-- live from pms_in_house_snapshot (point-in-time counts for today) +
-- pms_reservations (today's checkout count, total scheduled).

CREATE OR REPLACE FUNCTION public.today_property_counts_v1(
  p_property_id uuid,
  p_date date
)
RETURNS TABLE (
  checkouts                int,
  stayovers                int,
  vacant_clean             int,
  vacant_dirty             int,
  ooo                      int,
  total_rooms              int,
  total_checkouts_today    int,
  in_house                 int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH ihs AS (
    SELECT *
    FROM public.pms_in_house_snapshot
    WHERE property_id = p_property_id
  ),
  res AS (
    SELECT
      COUNT(*) FILTER (WHERE departure_date = p_date)                                  AS checkouts,
      COUNT(*) FILTER (WHERE arrival_date <= p_date AND departure_date > p_date)       AS stayovers
    FROM public.pms_reservations
    WHERE property_id = p_property_id
      AND arrival_date <= p_date
      AND departure_date >= p_date
  ),
  rooms AS (
    SELECT
      COUNT(*) AS total
    FROM public.pms_rooms_inventory
    WHERE property_id = p_property_id
  )
  SELECT
    res.checkouts::int,
    res.stayovers::int,
    COALESCE(ihs.total_vacant_clean,    0)::int                                     AS vacant_clean,
    COALESCE(ihs.total_vacant_dirty,    0)::int                                     AS vacant_dirty,
    COALESCE(ihs.total_ooo,             0)::int                                     AS ooo,
    COALESCE(rooms.total,               0)::int                                     AS total_rooms,
    res.checkouts::int                                                              AS total_checkouts_today,
    COALESCE(ihs.total_occupied_rooms,  0)::int                                     AS in_house
  FROM res
  CROSS JOIN rooms
  LEFT JOIN ihs ON true;
$$;

COMMENT ON FUNCTION public.today_property_counts_v1(uuid, date) IS
  'Plan v4 bridge — returns day-level aggregates (checkouts, stayovers, vacant_clean, vacant_dirty, ooo, in_house, total_rooms) for the property on the given date. Replaces plan_snapshots top-level columns. Source: pms_in_house_snapshot (point-in-time counts) + pms_reservations (today''s arrivals/stayovers/checkouts) + pms_rooms (inventory total).';

-- ─── Grant EXECUTE so the anon/authenticated PostgREST RPCs work ─────────
-- SECURITY DEFINER means the function bypasses RLS internally; the
-- function body only ever filters by the passed property_id so it's
-- safe. Callers must validate property_id ownership BEFORE invoking.
GRANT EXECUTE ON FUNCTION public.today_room_work_v1(uuid, date)        TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.today_property_counts_v1(uuid, date) TO anon, authenticated, service_role;

-- ─── applied_migrations bookkeeping ──────────────────────────────────────
INSERT INTO public.applied_migrations (version, description)
VALUES (
  '0224',
  'Plan v4 bridge functions — today_room_work_v1 + today_property_counts_v1. Derive plan_snapshots-shaped per-room work + day aggregates live from pms_room_status_log + pms_reservations + pms_in_house_snapshot + pms_housekeeping_assignments. Restores housekeeping Schedule tab + ML feature derivation without re-introducing the dropped plan_snapshots table.'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;
