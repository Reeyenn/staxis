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

alter table public.pms_in_house_snapshot
  add constraint pms_in_house_snapshot_captured_at_not_future
  check (captured_at <= now() + interval '5 minutes') not valid;

alter table public.pms_guest_balances
  add constraint pms_guest_balances_captured_at_not_future
  check (captured_at <= now() + interval '5 minutes') not valid;

alter table public.pms_payments_daily
  add constraint pms_payments_daily_captured_at_not_future
  check (captured_at <= now() + interval '5 minutes') not valid;

alter table public.pms_future_bookings
  add constraint pms_future_bookings_captured_at_not_future
  check (captured_at <= now() + interval '5 minutes') not valid;

alter table public.pms_no_shows
  add constraint pms_no_shows_captured_at_not_future
  check (captured_at <= now() + interval '5 minutes') not valid;

alter table public.pms_cancellations
  add constraint pms_cancellations_captured_at_not_future
  check (captured_at <= now() + interval '5 minutes') not valid;

alter table public.pms_in_house_snapshot validate constraint pms_in_house_snapshot_captured_at_not_future;
alter table public.pms_guest_balances    validate constraint pms_guest_balances_captured_at_not_future;
alter table public.pms_payments_daily    validate constraint pms_payments_daily_captured_at_not_future;
alter table public.pms_future_bookings   validate constraint pms_future_bookings_captured_at_not_future;
alter table public.pms_no_shows          validate constraint pms_no_shows_captured_at_not_future;
alter table public.pms_cancellations     validate constraint pms_cancellations_captured_at_not_future;

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
