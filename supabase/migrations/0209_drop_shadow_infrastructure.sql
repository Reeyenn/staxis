-- ═══════════════════════════════════════════════════════════════════════════
-- 0209 — Drop Plan v7 shadow infrastructure (Reeyen direction 2026-05-24).
--
-- Why this exists:
--   Plan v7's 7-day shadow-parity gate was a conservative way to retire
--   the legacy choice-advantage normalizers + new-schema-writer one
--   table at a time. Per Reeyen: we're going to onboard ~350 hotels in
--   the next 3 months and the legacy hand-coded CA path is irrelevant
--   to that scale story. Cut the safety net, delete the legacy code,
--   let the new generic-table-writer be the only path forward.
--
--   This migration:
--     - DROPs the 6 shadow tables (pms_*_shadow). Empty so nothing lost.
--     - DROPs pms_parity_diffs. Empty so nothing lost.
--     - Leaves pms_table_schemas alive — the generic-table-writer still
--       needs it as the per-table descriptor source.
--     - Leaves the 0207 + 0208 migrations as history; only undoing
--       what they created where it's no longer needed.
--
-- Idempotent: drop table if exists. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

drop table if exists public.pms_reservations_shadow              cascade;
drop table if exists public.pms_rooms_inventory_shadow           cascade;
drop table if exists public.pms_room_status_log_shadow           cascade;
drop table if exists public.pms_housekeeping_assignments_shadow  cascade;
drop table if exists public.pms_work_orders_v2_shadow            cascade;
drop table if exists public.pms_in_house_snapshot_shadow         cascade;
drop table if exists public.pms_parity_diffs                     cascade;

insert into public.applied_migrations (version, description)
values ('0209', 'Drop Plan v7 shadow tables + pms_parity_diffs. Legacy CA normalizers + new-schema-writer are being deleted in code so the parity gate has nothing to compare. New generic-table-writer becomes the sole write path.')
on conflict (version) do nothing;

notify pgrst, 'reload schema';
