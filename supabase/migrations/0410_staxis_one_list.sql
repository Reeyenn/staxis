-- 0410 — the one list: couldn't-do receipts, the full repeat vocabulary, and
--        one per-person preference row.
--
-- WHY
-- ---
-- The Staxis tab becomes THE list of everything that needs a person: findings,
-- to-dos, assigned work, due reminders, work orders, approvals. Three things
-- the schema could not express yet:
--
--   1. "Can't do this."  comms_tasks.status was open|done. A person who cannot
--      do the thing had exactly two options, both lies. The assigner needs the
--      REASON, and needs it attached to the row rather than typed into a chat
--      message that scrolls away. So: a third status plus the three receipt
--      columns, with a CHECK that makes a reasonless refusal unrepresentable —
--      the whole point of the state is the sentence that comes with it.
--
--   2. Biweekly and monthly.  recurring_task_templates spoke daily/weekdays/
--      weekly. The composer offers Daily / Weekly / Biweekly / Monthly, and the
--      chat door creates through the SAME table, so the vocabulary has to widen
--      here rather than in a second scheduler. Biweekly needs an ANCHOR (which
--      of the two weeks is "on"); monthly needs a day of the month, capped at 28
--      so no template silently skips February.
--
--   3. A place to remember one person's choice.  "Include log book in Staxis"
--      is per-user, per-hotel, and there was no per-user preference table in the
--      product at all (report_preferences is report-delivery specific, orphaned
--      since the report crons were deleted, and wrong-shaped). One narrow table,
--      keyed the same way report_preferences is, so a second per-person toggle
--      later is a column and not another table.
--
-- SECURITY
-- --------
-- staxis_user_prefs is service-role only (deny-all RLS), same idiom as
-- comms_tasks (0241) and recurring_task_templates (0303). Every read and write
-- goes through /api/feed/prefs with a session + property-access check.
--
-- Idempotent. Safe to re-run.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════
-- 1. "Can't do this" — a third terminal state, and the receipt it carries
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.comms_tasks
  ADD COLUMN IF NOT EXISTS blocked_at           timestamptz,
  ADD COLUMN IF NOT EXISTS blocked_by_staff_id  uuid,
  ADD COLUMN IF NOT EXISTS blocked_reason       text;

-- Widen the status domain. Drop-then-add because a CHECK cannot be altered in
-- place; the old name is preserved so a re-run is a no-op either way.
DO $$
DECLARE con record;
BEGIN
  FOR con IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.comms_tasks'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
      AND pg_get_constraintdef(oid) NOT ILIKE '%blocked%'
  LOOP
    EXECUTE format('ALTER TABLE public.comms_tasks DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;

ALTER TABLE public.comms_tasks
  DROP CONSTRAINT IF EXISTS comms_tasks_status_domain;
ALTER TABLE public.comms_tasks
  ADD CONSTRAINT comms_tasks_status_domain
  CHECK (status IN ('open', 'done', 'blocked'));

-- A refusal without a reason is the failure mode this state exists to prevent:
-- the assigner learns the work did not happen and learns nothing about why, so
-- they have to go and ask, which is the round trip the receipt replaces. Make it
-- unrepresentable rather than validated in a route that a second caller can skip.
ALTER TABLE public.comms_tasks
  DROP CONSTRAINT IF EXISTS comms_tasks_blocked_needs_reason;
ALTER TABLE public.comms_tasks
  ADD CONSTRAINT comms_tasks_blocked_needs_reason
  CHECK (
    status <> 'blocked'
    OR (blocked_reason IS NOT NULL AND btrim(blocked_reason) <> '')
  );

-- The "Assigned by me" drawer's only query: what did I hand out, and where did
-- it get to. Partial because a task nobody assigned is never in the drawer.
CREATE INDEX IF NOT EXISTS comms_tasks_assigner_idx
  ON public.comms_tasks (property_id, created_by_staff_id, status)
  WHERE created_by_staff_id IS NOT NULL AND assigned_staff_id IS NOT NULL;

COMMENT ON COLUMN public.comms_tasks.blocked_reason IS
  'Why the assignee could not do it. NOT NULL whenever status=''blocked'' (comms_tasks_blocked_needs_reason). Shown verbatim to the assigner in the Assigned-by-me drawer.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. The full repeat vocabulary
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.recurring_task_templates
  -- 1..28 only. A "monthly on the 31st" template silently skips seven months a
  -- year, and a manager who set it would never learn why the task stopped
  -- appearing. Refuse the ambiguity at the column rather than inventing a
  -- clamp rule the UI and the chat door would each have to remember.
  ADD COLUMN IF NOT EXISTS day_of_month integer,
  -- Which of the two weeks is the "on" one, for biweekly. Any date on an ON
  -- week works; the spawner compares whole weeks between it and today.
  ADD COLUMN IF NOT EXISTS anchor_date  date;

ALTER TABLE public.recurring_task_templates
  DROP CONSTRAINT IF EXISTS recurring_task_templates_day_of_month_range;
ALTER TABLE public.recurring_task_templates
  ADD CONSTRAINT recurring_task_templates_day_of_month_range
  CHECK (day_of_month IS NULL OR (day_of_month BETWEEN 1 AND 28));

-- Widen the cadence domain.
DO $$
DECLARE con record;
BEGIN
  FOR con IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.recurring_task_templates'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%cadence%'
      AND pg_get_constraintdef(oid) NOT ILIKE '%biweekly%'
  LOOP
    EXECUTE format('ALTER TABLE public.recurring_task_templates DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;

ALTER TABLE public.recurring_task_templates
  DROP CONSTRAINT IF EXISTS recurring_task_templates_cadence_domain;
ALTER TABLE public.recurring_task_templates
  ADD CONSTRAINT recurring_task_templates_cadence_domain
  CHECK (cadence IN ('daily', 'weekdays', 'weekly', 'biweekly', 'monthly'));

-- Every cadence carries exactly the parameters it needs, and none it does not.
-- Stated as one constraint per cadence so a violation names the cadence that
-- is wrong rather than "the shape".
ALTER TABLE public.recurring_task_templates
  DROP CONSTRAINT IF EXISTS recurring_task_templates_cadence_shape;
ALTER TABLE public.recurring_task_templates
  ADD CONSTRAINT recurring_task_templates_cadence_shape
  CHECK (
    CASE cadence
      WHEN 'weekly'   THEN weekday IS NOT NULL AND day_of_month IS NULL
      WHEN 'biweekly' THEN weekday IS NOT NULL AND anchor_date IS NOT NULL AND day_of_month IS NULL
      WHEN 'monthly'  THEN day_of_month IS NOT NULL AND weekday IS NULL
      ELSE weekday IS NULL AND day_of_month IS NULL
    END
  );

-- The old weekly-only constraint is subsumed by the shape CHECK above; it would
-- reject every biweekly row (weekday NOT NULL with cadence <> 'weekly').
ALTER TABLE public.recurring_task_templates
  DROP CONSTRAINT IF EXISTS recurring_task_templates_weekly_weekday;

-- Departments: the composer targets a ROLE using comms_tasks' own vocabulary
-- ('all_staff'), and the spawner copies this column straight onto the spawned
-- task row. Add it here so the two tables cannot disagree about what a
-- department is. 'general' stays for rows the chat door already created.
DO $$
DECLARE con record;
BEGIN
  FOR con IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.recurring_task_templates'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%assigned_department%'
      AND pg_get_constraintdef(oid) NOT ILIKE '%all_staff%'
  LOOP
    EXECUTE format('ALTER TABLE public.recurring_task_templates DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;

ALTER TABLE public.recurring_task_templates
  DROP CONSTRAINT IF EXISTS recurring_task_templates_department_domain;
ALTER TABLE public.recurring_task_templates
  ADD CONSTRAINT recurring_task_templates_department_domain
  CHECK (
    assigned_department IS NULL
    OR assigned_department IN ('front_desk', 'housekeeping', 'maintenance', 'general', 'all_staff')
  );

COMMENT ON COLUMN public.recurring_task_templates.anchor_date IS
  'Biweekly only: a date inside an ON week. The spawner spawns when the whole-week distance from this date is even, so "every other Tuesday" stays on the same fortnight forever.';
COMMENT ON COLUMN public.recurring_task_templates.day_of_month IS
  'Monthly only: 1..28. Capped so a monthly template can never skip a short month.';

-- ═══════════════════════════════════════════════════════════════════════
-- 3. One per-person preference row
-- ═══════════════════════════════════════════════════════════════════════

-- @rls: service-role-only — read and written only by /api/feed/prefs with
-- supabaseAdmin behind a session + property-access check. Anon + authenticated
-- get no policies (deny-all), mirroring comms_tasks (0241).
CREATE TABLE IF NOT EXISTS public.staxis_user_prefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  account_id  uuid NOT NULL REFERENCES public.accounts(id)   ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,

  -- "Include log book in Staxis". Off by default: the log book is a place you
  -- go, and a hotel that has never opened it should not find its shift notes
  -- interleaved with its money.
  logbook_in_list boolean NOT NULL DEFAULT false,

  -- When this person last opened their "Assigned by me" drawer. A task they
  -- handed out that got settled AFTER this stamp is news, and shows as a
  -- one-line notice on their list; opening the drawer moves the stamp and the
  -- notice stops. NULL means never opened, which is correct: the first thing
  -- that comes back should be the thing that teaches them the drawer exists.
  assigned_seen_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (account_id, property_id)
);

ALTER TABLE public.staxis_user_prefs ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE pol record;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'staxis_user_prefs'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.staxis_user_prefs', pol.policyname);
  END LOOP;
END $$;

COMMENT ON TABLE public.staxis_user_prefs IS
  'One row per (person, hotel) holding that person''s state on their Staxis list: whether log book entries are merged in, and when they last opened the Assigned-by-me drawer. Service-role only; every access goes through /api/feed/prefs.';

-- ─── applied_migrations bookkeeping ──────────────────────────────────────
INSERT INTO public.applied_migrations (version, description)
VALUES (
  '0410',
  'the one list: comms_tasks gains a blocked status with blocked_at/blocked_by_staff_id/blocked_reason and a CHECK making a reasonless refusal unrepresentable, plus the assigner-drawer index; recurring_task_templates gains biweekly (weekday + anchor_date) and monthly (day_of_month 1..28) cadences with a per-cadence shape CHECK and all_staff in the department domain; new staxis_user_prefs (account, property) holding the per-person "include log book in Staxis" switch and the assigned-by-me seen stamp. Service-role only.'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
