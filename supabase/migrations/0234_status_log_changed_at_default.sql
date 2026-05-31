-- 0234_status_log_changed_at_default.sql
--
-- Fix: every manager Rooms-tab save (mark clean / mark dirty) returned 500.
--
-- Root cause: pms_room_status_log.changed_at is NOT NULL with no default.
-- applyRoomUpdate() in src/lib/pms-rooms-writes.ts upserts the assignment
-- row (succeeds) and then appends a status_log audit row WITHOUT setting
-- changed_at — Postgres rejected the insert with a not-null violation, so
-- the whole room-action request threw 500. Net effect: zero 'manual'
-- status_log rows had ever been written, and managers saw tiles refuse to
-- change status (the optimistic flip reverted on the next poll).
--
-- Two-layer fix:
--   1. (code) pms-rooms-writes.ts now sets changed_at explicitly on insert.
--   2. (this migration) backfill a now() default so the column never
--      depends on the caller again — matches how id (gen_random_uuid())
--      and source ('manual') already default on this table.
--
-- Applied live to prod 2026-05-30 via psql ahead of this migration landing;
-- this file records it so a fresh DB rebuild reproduces the fix.

alter table public.pms_room_status_log
  alter column changed_at set default now();

notify pgrst, 'reload schema';

-- Self-register so the doctor's applied-migrations check + the
-- migration-bookkeeping drift test see this version. (Pre-existing drift:
-- this file shipped via main without the INSERT; added here so the suite
-- and a fresh rebuild stay in sync. Safe on prod — on conflict do nothing.)
insert into public.applied_migrations (version, description)
values ('0234', 'pms_room_status_log.changed_at default now()')
on conflict (version) do nothing;
