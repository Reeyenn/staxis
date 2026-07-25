-- 0351: a PMS row can never claim it was captured in the future.
--
-- WHY
-- The copilot now states HOW OLD the hotel's numbers are ("as of 2:40 PM,
-- 22 min ago") and refuses to state them as current when they are stale.
-- Every one of those judgements is `now() - captured_at`. A single row with a
-- capture time in the FUTURE — a PMS whose report header carries the guest's
-- local time, a timezone mistake in a parser, a clock-skewed ingest host —
-- makes the age negative, and a negative age reads as the freshest possible
-- data. The honesty layer would then confidently state hours-old numbers as
-- live: worse than the silence it replaced.
--
-- The application clamps a negative age to 0 and warns (freshnessAgeMinutes in
-- src/lib/pms/feed-status.ts). This migration is the belt for that braces: the
-- database refuses to store the impossible value in the first place.
--
-- WHAT
-- A CHECK on the six feed tables the model reads directly. All six already
-- have `captured_at timestamptz NOT NULL DEFAULT now()` (verified live on
-- 2026-07-24), so "a PMS row always records when it was captured" is already
-- DB-enforced; this closes the remaining hole.
--
-- The 5-minute grace absorbs ordinary clock skew between the ingest host and
-- the database — the constraint is aimed at hours-wrong values, not seconds.
--
-- NOT VALID first, then VALIDATE: NOT VALID takes only a SHARE UPDATE
-- EXCLUSIVE lock and applies to new writes immediately, and VALIDATE scans
-- without blocking reads or writes. If VALIDATE fails, some existing row
-- genuinely IS future-dated — that is a real data bug worth seeing, not a
-- reason to skip the constraint. Fix the row and re-run just the VALIDATE.
--
-- Restore-safe despite referencing now(): the predicate only forbids the
-- FUTURE, and a row that was valid when written stays valid as time moves
-- forward, so a later pg_restore re-check cannot fail on old data.
--
-- DELIBERATELY NOT INCLUDED: pms_reservations. It has no captured_at column at
-- all (only created_at / updated_at / last_synced_at), so the arrivals /
-- departures / stayovers half of the snapshot has no first-class capture time.
-- Adding that column is an ingestion-schema decision owned by the intake
-- workstream, not the AI layer; until it lands, freshness falls back to the
-- in-house snapshot capture, the session's last successful read, or the newest
-- pms_room_status_log.last_synced_at (see fetchFreshness in
-- src/lib/pms-feed-status-server.ts).
--
-- APPLY ORDER: migrations here are applied by hand. This one is
-- code-independent in both directions — the app never writes these tables, and
-- the constraint changes no read path — so it can be applied before or after
-- the deploy.

begin;

-- Driven off a list rather than hardcoded ALTERs, because the target set is
-- not stable across the migration history. 0343 (a sibling workstream, merged
-- alongside this one) renames pms_in_house_snapshot to
-- pms_occupancy_observation and leaves a compat VIEW behind at the old name,
-- and it drops pms_future_bookings outright in favour of pms_booking_pace.
-- Hardcoding either name makes this migration fail depending on which order a
-- database happened to receive them in — "ALTER action ADD CONSTRAINT cannot
-- be performed on relation" for the view, "does not exist" for the dropped
-- table.
--
-- So: name every table that has EVER been a target, and skip any entry that is
-- not currently a base table with a captured_at column. Adding a name here is
-- always safe; the guard decides whether it applies.
--
-- NOT VALID first, then VALIDATE, so the existing-row scan takes a weaker lock
-- than a plain ADD CONSTRAINT would.
do $$
declare
  tbl      text;
  con      text;
  targets  text[] := array[
    'pms_occupancy_observation',  -- 0343's name for the in-house snapshot
    'pms_in_house_snapshot',      -- pre-0343 name; a VIEW after it, hence skipped
    'pms_guest_balances',
    'pms_payments_daily',
    'pms_booking_pace',           -- 0343's replacement for pms_future_bookings
    'pms_future_bookings',        -- dropped by 0343; skipped once it is gone
    'pms_no_shows',
    'pms_cancellations'
  ];
begin
  foreach tbl in array targets loop
    -- relkind 'r' = ordinary table. Excludes the compat view explicitly.
    if not exists (
      select 1
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = tbl and c.relkind = 'r'
    ) then
      raise notice '0351: skipping %, not a base table here', tbl;
      continue;
    end if;

    if not exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = tbl and column_name = 'captured_at'
    ) then
      raise notice '0351: skipping %, no captured_at column', tbl;
      continue;
    end if;

    con := tbl || '_captured_at_not_future';
    if exists (select 1 from pg_constraint where conname = con) then
      continue;
    end if;

    execute format(
      'alter table public.%I add constraint %I check (captured_at <= now() + interval ''5 minutes'') not valid',
      tbl, con
    );
    -- A failure here is a REAL future-dated row, not a migration bug. Let it
    -- raise: a clock-skewed capture time is exactly what this constraint exists
    -- to surface, and silently skipping it would defeat the point.
    execute format('alter table public.%I validate constraint %I', tbl, con);
    raise notice '0351: constrained %', tbl;
  end loop;
end $$;

insert into public.applied_migrations (version, description) values (
  '0351',
  'CHECK constraints on the six PMS feed tables so captured_at can never be in the future — a negative data age would make every staleness tier read fresh (INV-32)'
)
on conflict (version) do nothing;

commit;

-- PostgREST caches the schema; reload it so the constraint is reflected.
notify pgrst, 'reload schema';

-- Verify after applying (expect 6 rows, all convalidated = t):
--   select conname, convalidated
--     from pg_constraint
--    where conname like '%\_captured\_at\_not\_future';
