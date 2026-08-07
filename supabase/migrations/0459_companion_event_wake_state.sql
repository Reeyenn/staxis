-- ═══════════════════════════════════════════════════════════════════════════
-- Staxis / HotelOps AI — where the companion's eyes were last (Migration 0459)
--
-- ONE ROW PER HOTEL. One timestamp that means "everything before this, I have
-- already looked at". That is the whole table.
--
-- ─── WHY IT EXISTS ─────────────────────────────────────────────────────────
--
-- The companion used to notice things on a nightly schedule. A work order
-- opened at 9am was news at 6am the following morning, by which point it was
-- either fixed or forgotten. The fix is a cheap sweep every ten minutes that
-- asks one deterministic question per hotel, with no model call in it:
--
--   "how many INTERESTING rows have landed in activity_log since I last
--    looked?"
--
-- "Since I last looked" needs a place to live. It is per HOTEL, not per person
-- (staxis_user_prefs is the per-person store and is the wrong grain: the
-- companion looks once for the building, not once per manager who happens to
-- have a tab open), and it must survive a deploy, so it is a row rather than
-- memory.
--
-- ─── WHY NOT ONE OF THE TABLES WE ALREADY HAVE ─────────────────────────────
--
-- Asked before writing this, per the house rule:
--
--   cron_heartbeats     one row per CRON, not per hotel, and its `notes` blob
--                       is a diagnostic written best-effort by a helper that
--                       swallows its own errors. Cost control must not depend
--                       on a write that is allowed to silently fail, and a
--                       read-modify-write of one shared jsonb row from a
--                       concurrent fan-out loses updates by construction.
--   app_settings        a singleton by CHECK constraint (id = true). No hotel
--                       dimension at all.
--   finding_detector_state  per (hotel, DETECTOR). Squatting on it with a
--                       pseudo-detector id would put a row in front of the
--                       demotion pass that the demotion pass would then try to
--                       demote.
--   properties          a column here is still a migration, and it would turn
--                       the hotel's own identity row into something written
--                       every ten minutes by a background job.
--   activity_log        the obvious one, and the reason it does not work: a
--                       sweep that finds nothing worth waking for writes
--                       NOTHING (see the no-noise rule in the runner). A cursor
--                       derived from the journal would therefore never advance
--                       on a quiet hotel, and the same events would be re-read
--                       until something finally happened.
--
-- ─── THE CURSOR IS ALSO THE CONCURRENCY CONTROL ────────────────────────────
--
-- The sweep advances `last_looked_at` with a compare-and-set: it updates only
-- the row it read, matching on the exact prior value. Two overlapping sweeps
-- therefore cannot both claim the same window — the loser updates zero rows,
-- sees that, and does nothing. This is why there is no advisory lock here and
-- no RPC: the claim IS the write, and the write is already atomic.
--
-- ─── AND IT IS THE CHEAP HALF OF THE SPEND CEILING ─────────────────────────
--
-- `wakes_day` / `wakes_today` cap how many times a hotel may wake the model in
-- one HOTEL-LOCAL day. It is the ceiling that costs nothing to enforce, and it
-- sits in front of the dollar ceiling (src/lib/findings/judge-budget.ts) rather
-- than instead of it. The companion may say at most five unprompted things a
-- day (COMPANION_MAX_SPEECH_PER_DAY); preparing forty notes for five mouths is
-- money spent on things nobody will ever be told.
--
-- Manual prod apply: per project_migration_application_manual.md.
-- Idempotent: create-if-not-exists everywhere. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- The sweep reads activity_log. A project without it has nothing to look at,
-- and a cursor into a table that is not there is a row that can only mislead.
DO $$
BEGIN
  IF to_regclass('public.activity_log') IS NULL THEN
    RAISE EXCEPTION '0459 requires the activity_log table from migration 0228';
  END IF;
END
$$;

-- @rls: service-role-only — written by the ten-minute cron sweep and read by
-- the server; no browser path reads or writes this cursor, and there is nothing
-- on it a person would ever be shown.
create table if not exists public.companion_event_wake_state (
  -- PRIMARY KEY, not a surrogate id with a unique index bolted on. There is
  -- exactly one of these per hotel, forever, and saying so in the key is what
  -- makes a duplicate impossible rather than merely unlikely.
  property_id     uuid primary key references public.properties(id) on delete cascade,

  -- The exclusive lower bound of the next window. Everything at or before this
  -- instant has already been considered. Seeded to `now()` the first time a
  -- hotel is swept, which is why a hotel's first sweep never wakes anything:
  -- "every interesting thing since the beginning of time" is not news.
  last_looked_at  timestamptz not null,

  -- When the model was last actually called for this hotel. Null until it has
  -- been. Diagnostic, and the thing an operator looks at first when asking
  -- "is this hotel noisy or is it broken".
  last_woke_at    timestamptz,

  -- The hotel-local day `wakes_today` belongs to, YYYY-MM-DD. Hotel-local and
  -- never UTC: a night auditor at 1am is on the hotel's calendar, which is the
  -- calendar the whole product already counts by.
  wakes_day       text check (wakes_day is null or wakes_day ~ '^\d{4}-\d{2}-\d{2}$'),
  wakes_today     integer not null default 0 check (wakes_today >= 0),

  -- Lifetime counters. Cheap, and they are what makes "this hotel has been
  -- swept 4,000 times and woken twice" a sentence anybody can check.
  looks_total     bigint not null default 0 check (looks_total >= 0),
  wakes_total     bigint not null default 0 check (wakes_total >= 0),

  updated_at      timestamptz not null default now()
);

comment on table public.companion_event_wake_state is
  'One row per hotel. Where the companion''s event sweep last looked in activity_log, and how many times it has woken the model today. Written only by src/lib/companion/event-wake/*. Service-role only. Created 0459.';
comment on column public.companion_event_wake_state.last_looked_at is
  'Exclusive lower bound of the next sweep window. Advanced by compare-and-set, which is also what stops two overlapping sweeps claiming the same events.';
comment on column public.companion_event_wake_state.wakes_day is
  'Hotel-local YYYY-MM-DD that wakes_today counts within. Never UTC.';

-- ── No index beyond the primary key ────────────────────────────────────────
-- Every read and every write is `where property_id = $1`. That is the primary
-- key. A secondary index here would be an index nothing can use.

-- ── RLS: service-role only (matches activity_log + app_settings) ───────────
alter table public.companion_event_wake_state enable row level security;
revoke all on public.companion_event_wake_state from public, anon, authenticated;
grant select, insert, update, delete on public.companion_event_wake_state to service_role;

drop policy if exists companion_event_wake_state_deny_browser
  on public.companion_event_wake_state;
create policy companion_event_wake_state_deny_browser
  on public.companion_event_wake_state
  as permissive for all to anon, authenticated
  using (false) with check (false);
comment on policy companion_event_wake_state_deny_browser on public.companion_event_wake_state is
  'Service-role only. No browser path reads or writes this cursor. Created 0459.';

-- ─── applied_migrations bookkeeping ─────────────────────────────────────────
INSERT INTO public.applied_migrations (version, description)
VALUES (
  '0459',
  'where the companion''s eyes were last: one row per hotel holding the activity_log cursor the ten-minute event sweep reads from, plus the hotel-local daily wake counter that caps model calls before the dollar ceiling has to. One table, one primary key, no new indexes, service-role only.'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
