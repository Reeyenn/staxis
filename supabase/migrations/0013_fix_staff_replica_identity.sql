-- ═══════════════════════════════════════════════════════════════════════════
-- Staxis / HotelOps AI — Fix replica-identity vs publication-column-list
-- conflict on `staff` and `shift_confirmations` (Migration 0013)
--
-- THE BUG:
--   Migration 0006 set REPLICA IDENTITY FULL on every realtime-published
--   table. Migration 0009 then re-published `staff` and `shift_confirmations`
--   with explicit column allow-lists (to keep phone numbers / hourly_wage
--   out of realtime payloads).
--
--   Postgres rejects this combination at UPDATE time:
--     ERROR 42P10: cannot update table "staff"
--     details: Column list used by the publication does not cover the
--              replica identity.
--
--   Result: every UPDATE to `staff` (and `shift_confirmations`) has been
--   silently failing in production since 0009 was applied. The Staff
--   Priority modal, Edit Staff form, schedule_priority changes, the
--   activate/deactivate toggle, vacation dates — none of these have been
--   persisting. The error was only surfaced via console logs that nobody
--   was watching.
--
--   The migration 0009 comment explicitly claimed this combination was
--   safe ("column-filtered tables can still have replica identity full").
--   That claim is wrong; Postgres requires the publication's column list
--   to be a superset of the replica identity's columns. With REPLICA
--   IDENTITY FULL, that's "every column," which contradicts having any
--   filter at all.
--
-- THE FIX:
--   Drop REPLICA IDENTITY FULL on the two affected tables back to the
--   Postgres default (primary key based). Side effect: realtime
--   UPDATE/DELETE events for these tables now only carry the primary key
--   in the OLD record, not the entire previous row. That's fine for our
--   app — subscribeTable in db.ts re-fetches the whole row from the table
--   on any change event, never relying on the OLD payload for diff.
--
-- Safe to re-run: ALTER TABLE ... REPLICA IDENTITY DEFAULT is idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.staff               replica identity default;
alter table public.shift_confirmations replica identity default;

-- Helpful comment so the next person reading pg_class knows why these
-- two tables are different from the rest of the realtime-published set.
comment on table public.staff is
  'Replica identity is DEFAULT (PK-only) instead of FULL because the realtime publication has a column allow-list filtering phone/hourly_wage. FULL + column-list is a Postgres error.';
comment on table public.shift_confirmations is
  'Replica identity is DEFAULT (PK-only) instead of FULL because the realtime publication has a column allow-list filtering staff_phone. FULL + column-list is a Postgres error.';
