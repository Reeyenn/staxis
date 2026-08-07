-- ═══════════════════════════════════════════════════════════════════════════
-- Staxis / HotelOps AI — the nightly robot's own record (Migration 0460)
--
-- ONE ROW PER WALKTHROUGH. Every night a robot signs into the real live app at
-- a dedicated test hotel and does what a manager does: adds a to-do, assigns
-- it, marks it done, opens the log book, teaches the companion a fact, asks it
-- a question, adds and deletes an inventory item, looks at the roster, signs
-- out. This table is what it wrote down about that.
--
-- ─── WHY IT EXISTS ─────────────────────────────────────────────────────────
--
-- Every other health signal in this product asks the database whether the data
-- looks right. None of them asks whether a person can still USE the app. A
-- broken sign-in, a composer that no longer submits, a list that renders empty
-- for a signed-in manager: all of those leave a perfectly healthy database
-- behind them, and the doctor reports green while the hotel cannot work.
--
-- The robot is the only check that fails when the PRODUCT fails. So its result
-- has to survive the run that produced it — a GitHub Actions log is not a
-- health signal, nobody reads one, and it ages out.
--
-- ─── WHY NOT ONE OF THE TABLES WE ALREADY HAVE ─────────────────────────────
--
-- Asked before writing this, per the house rule:
--
--   cron_heartbeats   one row per job, last_success_at and a best-effort
--                     `notes` blob. It answers "did it run", which the robot
--                     does also use it for. It cannot answer "which of the
--                     twelve steps failed, and for how long has step 7 been
--                     failing" — that is a history, and a heartbeat is a
--                     single mutable row by design.
--   error_logs        where a FAILED step goes, and it stays that way: it is
--                     what feeds Mission Control's "Recent errors" box, which
--                     is the one place the founder looks. But it holds only
--                     failures. A green run writes nothing there, so error_logs
--                     alone can never distinguish "the robot passed" from "the
--                     robot never ran", which is the difference the doctor
--                     check exists to see.
--   app_events        product analytics for real people using the app. Mixing
--                     a synthetic robot's clicks into it would corrupt every
--                     usage figure derived from it.
--   activity_log      per-hotel journal the companion reads. The robot's own
--                     bookkeeping is fleet infrastructure, not something that
--                     happened at a hotel, and putting it there would make the
--                     companion notice its own test data.
--
-- ─── NO property_id, ON PURPOSE ────────────────────────────────────────────
--
-- The robot always walks the same seeded test hotel. Keying these rows to it
-- would suggest the hotel is the subject, and a future reader would filter this
-- table by hotel and get nothing useful. The subject is the APP. The hotel it
-- happened at is recorded inside `steps` when a step needs to name it.
--
-- That is also why there is no tenant column to write an RLS policy against:
-- this is fleet-operational data, service-role only, deny-all for the browser,
-- exactly like error_logs and cron_heartbeats next to it.
--
-- ─── RETENTION ─────────────────────────────────────────────────────────────
--
-- 90 days, swept by the report route itself on each insert. No new cron: one
-- row a night is 365 rows a year, and a janitor cron for a table this small
-- would cost more to operate than the rows it deletes.
--
-- Manual prod apply: per project_migration_application_manual.md.
-- Idempotent: create-if-not-exists everywhere. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- @rls: service-role-only — written by /api/admin/robot-walk/report behind
-- CRON_SECRET and read by the doctor. No browser path touches it.
create table if not exists public.robot_walk_runs (
  id                uuid primary key default gen_random_uuid(),

  -- When the robot opened the browser and when it closed it. Both are recorded
  -- by the runner rather than defaulted here: the run happens on a GitHub
  -- runner and lands here afterwards, so `now()` at insert time is the moment
  -- the REPORT arrived, which is a different fact and a misleading one.
  started_at        timestamptz not null,
  finished_at       timestamptz not null,

  -- The whole verdict in one boolean: every step passed. Deliberately not
  -- derived from `steps` at read time — the doctor asks this question every
  -- five minutes and a stored answer is what keeps that a single indexed read.
  ok                boolean not null,

  -- [{ name, ok, ms, error? }] in the order the robot walked them. jsonb and
  -- not a child table: nothing ever queries one step across runs, the array is
  -- read whole or not at all, and a twelve-row child table per night is a join
  -- bought with nothing.
  steps             jsonb not null default '[]'::jsonb,

  -- Deep link to the GitHub Actions run, so a failure in Mission Control is one
  -- click from the log and the screenshot. Null when the robot was run by hand.
  workflow_run_url  text,

  created_at        timestamptz not null default now(),

  -- A run that finished before it started is a clock bug in the runner, and it
  -- would quietly poison every duration ever computed off this table.
  constraint robot_walk_runs_finished_after_started check (finished_at >= started_at),
  -- `steps` is an array of step objects or it is nothing. A bare object here
  -- would make every reader's `.map()` throw.
  constraint robot_walk_runs_steps_is_array check (jsonb_typeof(steps) = 'array')
);

comment on table public.robot_walk_runs is
  'One row per nightly robot walkthrough of the live app. Written only by /api/admin/robot-walk/report; read by the doctor''s robot_walk_recent check. Service-role only. 90-day retention swept by the report route. Created 0460.';
comment on column public.robot_walk_runs.ok is
  'True only when every step passed. The doctor reads this column directly rather than re-deriving it from steps.';
comment on column public.robot_walk_runs.steps is
  'Ordered array of { name, ok, ms, error? }. One entry per step the robot attempted.';
comment on column public.robot_walk_runs.workflow_run_url is
  'GitHub Actions run URL for this walkthrough, or null when a person ran it by hand.';

-- ── The one index ──────────────────────────────────────────────────────────
-- Both readers ask the same question: "the most recent run". The doctor asks it
-- every five minutes behind a 60-second cache, and the retention sweep asks the
-- mirror image of it. One descending index on started_at serves both.
create index if not exists robot_walk_runs_started_idx
  on public.robot_walk_runs (started_at desc);

-- ── RLS: service-role only (matches error_logs + cron_heartbeats) ──────────
alter table public.robot_walk_runs enable row level security;
revoke all on public.robot_walk_runs from public, anon, authenticated;
grant select, insert, update, delete on public.robot_walk_runs to service_role;

drop policy if exists robot_walk_runs_deny_browser on public.robot_walk_runs;
create policy robot_walk_runs_deny_browser
  on public.robot_walk_runs
  as permissive for all to anon, authenticated
  using (false) with check (false);
comment on policy robot_walk_runs_deny_browser on public.robot_walk_runs is
  'Service-role only. Nothing in the browser reads or writes the robot''s own bookkeeping. Created 0460.';

-- ─── applied_migrations bookkeeping ─────────────────────────────────────────
INSERT INTO public.applied_migrations (version, description)
VALUES (
  '0460',
  'the nightly robot''s own record: one row per walkthrough of the live app holding the per-step results, so a green night is distinguishable from a night the robot never ran. Service-role only, 90-day retention swept by the report route, no new cron.'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
