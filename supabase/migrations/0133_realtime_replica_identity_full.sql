-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0133: REPLICA IDENTITY FULL on hot realtime tables
--
-- Postgres' UPDATE WAL record by default only includes the primary key
-- and changed columns. For Supabase Realtime, that means `payload.new`
-- arrives on the client missing every unchanged column — fine when the
-- client refetches the whole table on every event, but a problem if we
-- want to apply the payload locally (audit recommendation #4).
--
-- REPLICA IDENTITY FULL changes the WAL to log the entire row on UPDATE,
-- so payload.new is complete. Trade-off: slightly larger WAL volume and
-- replication overhead. For the 5 tables below — all of which already
-- drive realtime subscriptions on hot UX paths — the cost is well worth
-- the elimination of refetch amplification.
--
-- Cost audit recommendation #4 in .claude/reports/cost-hotpaths-audit.md.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.rooms                    replica identity full;
alter table public.staff                    replica identity full;
alter table public.cleaning_events          replica identity full;
alter table public.schedule_assignments     replica identity full;
alter table public.shift_confirmations      replica identity full;

insert into applied_migrations (version, description)
values (
  '0133',
  'cost audit: REPLICA IDENTITY FULL on rooms/staff/cleaning_events/schedule_assignments/shift_confirmations so realtime payloads include full row on UPDATE'
)
on conflict (version) do nothing;
