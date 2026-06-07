-- 0272 — Drop the legacy rooms table set and its remaining couplings.
--
-- Context: the AI copilot, housekeeper workflow, manager Rooms tab,
-- front-desk, comms, inspections, and all agent tools now read/write the
-- pms_* schema exclusively (migrations 0269 + 0270 + 0271 +
-- feature/pms-rooms-retire). Nothing in src/ references `.from('rooms')` and
-- no SQL function references public.rooms after 0271. This migration removes
-- the dead objects.
--
-- KEPT (out of scope, still live): cleaning_events (labor audit, keyed by
-- property/room/date with no rooms FK), work_orders (Staxis tickets, separate
-- from pms_work_orders_v2), dashboard_by_date, pull_metrics.
--
-- ⚠️ APPLY TO PROD AT MERGE, not before: once `rooms` is gone, any pre-merge
-- main code still doing `.from('rooms')` would error instead of returning
-- empty. 0270 (additive) and 0271 (backward-compatible rewrites) are safe to
-- apply ahead of merge; THIS migration fires when the branch goes live.

-- 1) Pause-audit removal. room_pause_events (0 rows in prod — its composite
--    room_id never satisfied the uuid FK, so the audit silently never wrote)
--    + its activity-log triggers. CASCADE drops the two triggers attached to
--    the table; the trigger FUNCTIONS are dropped explicitly below. This also
--    removes the room_pause_events.room_id → rooms(id) FK (the real
--    drop-blocker).
drop table if exists public.room_pause_events cascade;
drop function if exists public._activity_log_on_room_pause_insert() cascade;
drop function if exists public._activity_log_on_room_pause_update() cascade;

-- 2) Dead rooms-mutating functions (no live callers — only referenced by the
--    generated database.types.ts, regenerated in this branch).
drop function if exists public.staxis_refresh_rooms_from_pms(uuid, date, jsonb, text[]) cascade;
drop function if exists public.staxis_bulk_update_room_status(uuid, date, jsonb) cascade;
drop function if exists public.staxis_apply_shift_assignments(uuid, date, jsonb) cascade;
drop function if exists public.staxis_checklist_toggle(uuid, uuid, boolean) cascade;

-- 3) Drop the legacy tables. IF EXISTS so a from-scratch replay (where 0205's
--    creates are neutralized) is a clean no-op; CASCADE removes their RLS
--    policies / indexes. rooms is dropped LAST — after room_pause_events so
--    its inbound FK is already gone.
drop table if exists public.plan_snapshots cascade;
drop table if exists public.scraper_status cascade;
drop table if exists public.rooms cascade;

insert into applied_migrations (version, description)
values ('0272', 'drop legacy rooms/plan_snapshots/scraper_status + room_pause_events audit + 4 dead rooms RPCs (pms_* is the single source)')
on conflict (version) do nothing;

notify pgrst, 'reload schema';
