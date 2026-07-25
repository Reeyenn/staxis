-- ═══════════════════════════════════════════════════════════════════════════
-- 0349 — Make unused indexes visible instead of guessed at
-- ═══════════════════════════════════════════════════════════════════════════
-- Measured live before writing this: the public schema holds 734 indexes, 276
-- of which have not been scanned once since the 2026-04-08 stats reset. Only
-- 98 of those are droppable at all (not a primary key, not a unique
-- constraint), and together they occupy 3,632 kB.
--
-- So a blind sweep buys 3.6 MB and risks the query plan of something nobody
-- happened to run during a quiet quarter on a one-hotel database. idx_scan = 0
-- means "unused" only once there is real traffic on real data; today it mostly
-- means "this hotel has 40 rooms".
--
-- The policy is therefore a rule and a light, not a sweep:
--
--   1. scripts/audit-index-justification.mjs (in `npm run lint`) requires every
--      NEW index to name the query it serves. The existing 734 are
--      grandfathered — retro-justifying them is busywork.
--
--   2. This view. /api/admin/doctor reports, but never fails on, any
--      non-unique index with zero scans on a table big enough for the number
--      to mean something. When a table crosses 10,000 rows and an index on it
--      has still never been used, that is a real signal worth acting on.
--
--   3. Revisit when there is production traffic. Not before.
--
-- Zero new tables.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

drop view if exists public.staxis_unused_index_watch;
create view public.staxis_unused_index_watch as
  select
    psui.relname::text                              as table_name,
    psui.indexrelname::text                         as index_name,
    psui.idx_scan                                   as scans,
    pg_relation_size(psui.indexrelid)               as index_bytes,
    pg_size_pretty(pg_relation_size(psui.indexrelid)) as index_size,
    coalesce(pst.n_live_tup, 0)                     as approx_rows
  from pg_stat_user_indexes psui
  join pg_index i        on i.indexrelid = psui.indexrelid
  join pg_stat_user_tables pst on pst.relid = psui.relid
  where psui.schemaname = 'public'
    and psui.idx_scan = 0
    -- A primary key or unique index is a CONSTRAINT, not a performance guess.
    -- Never surface those as droppable, no matter how idle they look.
    and not i.indisunique
    and not i.indisprimary
    -- Below this size a "never scanned" reading says more about the hotel
    -- than about the index.
    and coalesce(pst.n_live_tup, 0) > 10000;

comment on view public.staxis_unused_index_watch is
  'Non-unique, never-scanned indexes on tables with more than ~10,000 rows. Read by /api/admin/doctor unused_index_watch, which WARNS and never fails — an index is a judgement call, not an outage. Excludes primary/unique indexes because those are constraints. Created 0349.';

revoke all on public.staxis_unused_index_watch from public, anon, authenticated;
grant select on public.staxis_unused_index_watch to service_role;

insert into public.applied_migrations (version, description)
values (
  '0349',
  'staxis_unused_index_watch view — surfaces never-scanned non-unique indexes on large tables for the doctor, instead of dropping indexes on a guess'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
