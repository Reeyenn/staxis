-- ═══════════════════════════════════════════════════════════════════════════
-- Staxis / HotelOps AI — the agent gets a life record (Migration 0456)
--
-- ONE VALUE, ADDED TO ONE CHECK CONSTRAINT. That is the whole migration.
--
-- ─── WHAT THIS IS FOR ──────────────────────────────────────────────────────
--
-- `activity_log` (0228) is already the hotel's append-only "everything that
-- happened" timeline: nullable actor_account_id for system actors, a
-- pre-rendered plain-English `description`, free-text `event_type`, a jsonb
-- payload, an index on (property_id, occurred_at), and exemption from every
-- retention purge. It is the correct home for the companion's own record of
-- what it did, and it has been sitting there empty of that record because the
-- `source` CHECK had no value that meant "the companion itself".
--
-- Every other candidate meant something else and would have been a lie:
--   'cron'         the nightly detector run, not a decision made in a turn
--   'rules_engine' the deterministic automation rules, which are not the agent
--   'system'       the catch-all a trigger writes when nothing else fits, so
--                  it cannot be filtered on to answer "what did YOU do today"
--
-- The read that motivated it (`feedStaxisToday` in src/lib/agent/awareness.ts)
-- filters `source = 'staxis_agent'`. A shared bucket would have made that read
-- either wrong or impossible.
--
-- ─── WHY NO NEW TABLE ──────────────────────────────────────────────────────
--
-- A second timeline is a second thing to secure, index, purge-exempt, and keep
-- in sync with the first, and the question a manager actually asks ("what
-- happened at my hotel today") does not distinguish "a person did it" from
-- "the companion did it". One stream, one filter.
--
-- ─── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────────
--
-- No new index. The reader is always property-scoped and time-bounded, which
-- is exactly `activity_log_property_time_idx` from 0228, and the source filter
-- runs over a slice already bounded to one hotel-day.
-- No grants. `activity_log` stays service-role-only; the writer is a server
-- module and the reads are server-side.
-- No trigger. Unlike every other writer of this table, this one is application
-- code by necessity: an agent decision is not an INSERT on some other table
-- that a trigger could observe.
--
-- Manual prod apply: per project_migration_application_manual.md.
-- Idempotent: the constraint is dropped and recreated. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- The table must exist. A migration that silently no-ops on a project missing
-- 0228 would leave the journal writing into a CHECK it thinks it widened.
DO $$
BEGIN
  IF to_regclass('public.activity_log') IS NULL THEN
    RAISE EXCEPTION '0456 requires the activity_log table from migration 0228';
  END IF;
END
$$;

-- ─── The one change: 'staxis_agent' joins the source domain ────────────────
--
-- Restated in full rather than patched, so this file is the readable definition
-- of the constraint rather than a diff somebody has to reconstruct from 0228.
ALTER TABLE public.activity_log
  DROP CONSTRAINT IF EXISTS activity_log_source_check;

ALTER TABLE public.activity_log
  ADD CONSTRAINT activity_log_source_check
  CHECK (source IN (
    'housekeeper_app',
    'manager_dashboard',
    'admin_dashboard',
    'cron',
    'cua_worker',
    'rules_engine',
    'pms_sync',
    'system',
    'sms',
    'voice',
    -- New. The companion's own acts: decisions it made, beliefs it changed,
    -- and things it said to a person. Written only by
    -- src/lib/agent/journal.ts, which is the single application-code writer
    -- of this table.
    'staxis_agent'
  ));

COMMENT ON COLUMN public.activity_log.source IS
  'Which system component produced the event. Trigger-written rows carry the source table''s own component; ''staxis_agent'' is the one value written by application code (src/lib/agent/journal.ts) and marks the companion''s own record of what it did.';

-- ─── applied_migrations bookkeeping ─────────────────────────────────────────
INSERT INTO public.applied_migrations (version, description)
VALUES (
  '0456',
  'the agent gets a life record: activity_log.source gains ''staxis_agent'' so the companion can record its own decisions, belief changes and the things it said to a person in the timeline the hotel already keeps. One CHECK constraint widened by one value. No new tables, no new indexes, no new grants.'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
