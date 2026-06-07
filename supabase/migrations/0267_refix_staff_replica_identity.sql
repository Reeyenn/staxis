-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0267: RE-fix REPLICA IDENTITY on staff / shift_confirmations
--
-- THE REGRESSION:
--   Migration 0013 set `staff` and `shift_confirmations` to REPLICA IDENTITY
--   DEFAULT (primary-key only) on purpose: both tables have a realtime
--   publication with a COLUMN ALLOW-LIST (filtering phone / hourly_wage /
--   staff_phone out of realtime payloads). Postgres requires the publication's
--   column list to be a SUPERSET of the replica identity's columns — so
--   REPLICA IDENTITY FULL ("every column") is illegal alongside a column
--   filter, and every UPDATE raises:
--       ERROR 42P10: cannot update table "staff"
--
--   Migration 0133 ("cost audit: REPLICA IDENTITY FULL on hot realtime
--   tables") then blanket-set FULL on five tables — including these two —
--   to get full-row realtime payloads. For rooms / cleaning_events /
--   schedule_assignments that's fine (no column filter). For staff and
--   shift_confirmations it silently re-introduced the exact 0009→0013 bug:
--   the Staff Priority modal, Edit Staff form, schedule_priority changes,
--   activate/deactivate, and vacation-date edits have all been failing in
--   production again since 0133 was applied (confirmed live 2026-06-05 via
--   the new Schedule board's priority save → 500 "cannot update table staff").
--
-- THE FIX:
--   Drop these two tables back to REPLICA IDENTITY DEFAULT. Leave the other
--   three 0133 tables at FULL — they have no column filter, so FULL is legal
--   and 0133's full-payload optimization still applies to them.
--
--   Trade-off (same as 0013): realtime UPDATE/DELETE events for staff /
--   shift_confirmations carry only the PK in the OLD record. That is fine —
--   subscribeTable in src/lib/db/_common.ts refetches the whole row on any
--   change event and never relies on the OLD payload for a diff.
--
-- Safe to re-run: ALTER TABLE ... REPLICA IDENTITY DEFAULT is idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.staff               replica identity default;
alter table public.shift_confirmations replica identity default;

comment on table public.staff is
  'Replica identity is DEFAULT (PK-only), NOT FULL: the realtime publication has a column allow-list (filters phone/hourly_wage), and FULL + column-list is a Postgres 42P10 error on UPDATE. See migrations 0013 + 0267. Do not set REPLICA IDENTITY FULL here.';
comment on table public.shift_confirmations is
  'Replica identity is DEFAULT (PK-only), NOT FULL: the realtime publication has a column allow-list (filters staff_phone), and FULL + column-list is a Postgres 42P10 error on UPDATE. See migrations 0013 + 0267. Do not set REPLICA IDENTITY FULL here.';

insert into applied_migrations (version, description)
values (
  '0267',
  're-fix REPLICA IDENTITY DEFAULT on staff/shift_confirmations (0133 regressed 0013 → 42P10 cannot update staff)'
)
on conflict (version) do nothing;
