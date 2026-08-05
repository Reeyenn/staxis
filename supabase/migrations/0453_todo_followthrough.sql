-- 0453 — to-do follow-through: honest overdue, a credited completion day,
--        an optional time of day, and one more per-person cursor.
--
-- WHY
-- ---
-- A dated to-do that nobody did used to have exactly two honest endings and
-- one dishonest one. Four things the schema could not express:
--
--   1. "I did it yesterday."  Marking an overdue to-do done stamped
--      completed_at = now, so a job that happened on Tuesday was recorded as
--      having happened on Thursday. Every pattern the product learns from this
--      table (when work actually gets done, which cadences slip) was being
--      taught a date nobody chose. completed_for_date is the day the completion
--      is CREDITED to; completed_at stays the true instant of the tap, so the
--      row still says when it was reported as well as when it happened.
--
--   2. "Not needed."  The only ways to clear a to-do were done (a claim the
--      work happened) and blocked (a refusal, which REQUIRES a reason). Work
--      that simply stopped being needed had neither, so it was deleted — and a
--      deleted row teaches nothing and leaves the assigner with no answer at
--      all. A fourth terminal state records it instead.
--
--   3. A time of day.  comms_tasks carries a calendar day (due_at is the END of
--      the local due day, set by the server). "by 3pm" had nowhere to go, so it
--      stayed in the title and no ordering could see it. due_time is display +
--      sort only: the server still owns the day boundary, and due_at is
--      untouched. Nullable, and null means exactly what it means today.
--
--   4. "What is new since I last looked."  staxis_user_prefs already holds one
--      cursor (assigned_seen_at, for the Assigned-by-me drawer). The list
--      itself needed the same thing, and 0410 said the next per-person value
--      should be a column on this table rather than a second table.
--
-- WHY NOT A SEPARATE "skipped" TABLE, OR A DELETE
-- ----------------------------------------------
-- Both lose the fact that somebody looked at the work and decided. The whole
-- point of the three buttons is that the assigner always sees the true story,
-- and a row that vanished has no story.
--
-- SECURITY
-- --------
-- No new tables and no new grants. comms_tasks, recurring_task_templates and
-- staxis_user_prefs are all already service-role only (deny-all RLS, 0241 /
-- 0303 / 0410), and every access goes through /api/* with supabaseAdmin.
--
-- Idempotent. Safe to re-run.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════
-- 1. A completion can be credited to the day it was due
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.comms_tasks
  ADD COLUMN IF NOT EXISTS completed_for_date date;

COMMENT ON COLUMN public.comms_tasks.completed_for_date IS
  'The calendar day a completion is credited to, when it is not the day it was reported. Set by "Did it yesterday": completed_at stays the true instant of the tap, this is the day the work actually happened. NULL means the work happened when it was reported, which is the ordinary case.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. "Not needed" — a fourth terminal state, with no reason required
-- ═══════════════════════════════════════════════════════════════════════
--
-- Deliberately NOT folded into 'blocked'. A refusal carries a reason and the
-- CHECK from 0410 makes a reasonless one unrepresentable; "not needed" is not a
-- refusal and demanding a sentence for it would push people back to deleting.

ALTER TABLE public.comms_tasks
  ADD COLUMN IF NOT EXISTS skipped_at           timestamptz,
  ADD COLUMN IF NOT EXISTS skipped_by_staff_id  uuid;

-- Widen the status domain. Drop-then-add because a CHECK cannot be altered in
-- place; the same shape 0410 used, matched on the state it does not yet know
-- about so a re-run is a no-op either way.
DO $$
DECLARE con record;
BEGIN
  FOR con IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.comms_tasks'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
      AND pg_get_constraintdef(oid) NOT ILIKE '%skipped%'
  LOOP
    EXECUTE format('ALTER TABLE public.comms_tasks DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;

ALTER TABLE public.comms_tasks
  DROP CONSTRAINT IF EXISTS comms_tasks_status_domain;
ALTER TABLE public.comms_tasks
  ADD CONSTRAINT comms_tasks_status_domain
  CHECK (status IN ('open', 'done', 'blocked', 'skipped'));

-- The 0410 refusal-needs-a-reason rule is dropped by the loop above along with
-- the status domain only if it mentions status; it does, so restate it here.
-- Unchanged in meaning: a blocked row still cannot exist without its sentence.
ALTER TABLE public.comms_tasks
  DROP CONSTRAINT IF EXISTS comms_tasks_blocked_needs_reason;
ALTER TABLE public.comms_tasks
  ADD CONSTRAINT comms_tasks_blocked_needs_reason
  CHECK (
    status <> 'blocked'
    OR (blocked_reason IS NOT NULL AND btrim(blocked_reason) <> '')
  );

COMMENT ON COLUMN public.comms_tasks.skipped_at IS
  'When somebody decided this no longer needed doing. status=''skipped''. Not a refusal: no reason is required, which is the whole difference from ''blocked''.';

-- ═══════════════════════════════════════════════════════════════════════
-- 3. An optional time of day
-- ═══════════════════════════════════════════════════════════════════════
--
-- DISPLAY AND SORT ONLY. due_at remains the end of the local due day and the
-- server remains the only thing that decides where a day begins and ends. A
-- time here never becomes a timestamp and never moves a row between days: it
-- decides where the row sits WITHIN its day and what the row says out loud.
--
-- On the template too, so a repeating "check the boiler by 3pm" still says 3pm
-- on every instance the spawner creates. Without it the time would survive
-- exactly one day and then quietly disappear.

ALTER TABLE public.comms_tasks
  ADD COLUMN IF NOT EXISTS due_time time;

ALTER TABLE public.recurring_task_templates
  ADD COLUMN IF NOT EXISTS due_time time;

COMMENT ON COLUMN public.comms_tasks.due_time IS
  'Optional time of day this is wanted by, in the hotel''s own local clock. Display and sort only: due_at still holds the end of the local due day and is what every date comparison uses. NULL is the default and behaves exactly as before.';

COMMENT ON COLUMN public.recurring_task_templates.due_time IS
  'Optional time of day copied onto every instance this template spawns, so a repeating "by 3pm" keeps its time past its first day.';

-- ═══════════════════════════════════════════════════════════════════════
-- 4. One more per-person cursor
-- ═══════════════════════════════════════════════════════════════════════
--
-- The same shape as assigned_seen_at, one row further out: that stamp answers
-- "what came back from the people I handed work to", this one answers "what
-- arrived on my list while I was not looking". Both are derived-not-stored
-- read state: there is no notification table, nothing to mark read and nothing
-- that can get stuck, because the whole of it is one timestamp.

ALTER TABLE public.staxis_user_prefs
  ADD COLUMN IF NOT EXISTS list_seen_at timestamptz;

COMMENT ON COLUMN public.staxis_user_prefs.list_seen_at IS
  'When this person last looked at their Staxis list. Anything created after it is marked new on the row and counted on the tab. NULL means never looked, and everything recent counts, which is what teaches somebody the marker exists.';

-- ─── applied_migrations bookkeeping ──────────────────────────────────────
INSERT INTO public.applied_migrations (version, description)
VALUES (
  '0453',
  'to-do follow-through: comms_tasks gains completed_for_date (a completion credited to the day it was due), a fourth terminal status ''skipped'' with skipped_at/skipped_by_staff_id and no reason requirement, and an optional due_time; recurring_task_templates gains due_time so a repeating time survives past its first instance; staxis_user_prefs gains list_seen_at, the per-person cursor behind the new-since-you-looked marker. No new tables, no new grants.'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
