-- 0455 — "every N days": one open-ended cadence instead of a chip per number.
--
-- WHY
-- ---
-- The Repeat row on the to-do composer offers Once / Every day / Every 3 days /
-- Every 4 days / Every week / Every 2 weeks / Every month, plus a blank a person
-- fills in: "every ___ days". Every gap in that list except the typed one is a
-- shape the table already has. The typed one is not: recurring_task_templates
-- can say daily, weekdays, weekly(weekday), biweekly(weekday+anchor) and
-- monthly(day_of_month), and none of those can say "every 3 days".
--
-- Filters get changed every 45 days. Pool sand gets backwashed every 5. A
-- quarterly vendor visit is every 90. A cadence per number is not a design, so
-- this adds ONE cadence that carries a number.
--
-- WHY ANCHORED AND NOT COUNTED
-- ----------------------------
-- interval_days is measured from anchor_date, exactly as biweekly is measured
-- from its anchor. A gap kept as "days since the last spawn" walks forward every
-- time the spawner misses a tick, so "every 3 days" quietly becomes every 4 and
-- nothing on any screen would ever explain the drift. Anchored, a missed day is
-- one missed instance and the rhythm is untouched. See isTemplateDueOn() in
-- src/lib/recurring-tasks/store.ts.
--
-- WHY 2..365
-- ----------
-- 1 is refused because 'daily' already exists, and two spellings of one cadence
-- is how a screen ends up saying "every 1 days". 365 is the far end of anything
-- a hotel schedules on a to-do list; past that it is a project, not a chore.
--
-- SECURITY
-- --------
-- No new tables, no new grants, no policy changes. recurring_task_templates is
-- service-role only (deny-all RLS, 0303) and stays that way.
--
-- Idempotent. Safe to re-run.

BEGIN;

-- ─── 1. The number ──────────────────────────────────────────────────────────

ALTER TABLE public.recurring_task_templates
  ADD COLUMN IF NOT EXISTS interval_days integer;

COMMENT ON COLUMN public.recurring_task_templates.interval_days IS
  'How many days apart, for cadence = ''every_n_days''. Counted from anchor_date '
  'rather than from the last spawn, so a missed cron tick costs one instance and '
  'never shifts the rhythm. 2..365; 1 is refused because ''daily'' already says it. '
  'NULL for every other cadence.';

ALTER TABLE public.recurring_task_templates
  DROP CONSTRAINT IF EXISTS recurring_task_templates_interval_days_range;
ALTER TABLE public.recurring_task_templates
  ADD CONSTRAINT recurring_task_templates_interval_days_range
  CHECK (interval_days IS NULL OR (interval_days BETWEEN 2 AND 365));

-- ─── 2. Widen the cadence domain ────────────────────────────────────────────
-- Same drop-then-add shape 0410 used, with the sentinel moved forward: the loop
-- clears any CHECK that mentions cadence and does NOT already know the new
-- value, so a re-run over an already-migrated table is a no-op.

DO $$
DECLARE con record;
BEGIN
  FOR con IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.recurring_task_templates'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%cadence%'
      AND pg_get_constraintdef(oid) NOT ILIKE '%every_n_days%'
  LOOP
    EXECUTE format('ALTER TABLE public.recurring_task_templates DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;

ALTER TABLE public.recurring_task_templates
  DROP CONSTRAINT IF EXISTS recurring_task_templates_cadence_domain;
ALTER TABLE public.recurring_task_templates
  ADD CONSTRAINT recurring_task_templates_cadence_domain
  CHECK (cadence IN ('daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'every_n_days'));

-- ─── 3. Every cadence carries exactly its own parameters ────────────────────
-- Restated in full because the loop above takes the old shape CHECK with it.
-- The ELSE branch is the one that matters here: without naming interval_days in
-- it, a daily or weekly template could carry a gap nothing reads, and an
-- every_n_days template could carry no gap at all and simply never spawn.

ALTER TABLE public.recurring_task_templates
  DROP CONSTRAINT IF EXISTS recurring_task_templates_cadence_shape;
ALTER TABLE public.recurring_task_templates
  ADD CONSTRAINT recurring_task_templates_cadence_shape
  CHECK (
    CASE cadence
      WHEN 'weekly'   THEN weekday IS NOT NULL AND day_of_month IS NULL AND interval_days IS NULL
      WHEN 'biweekly' THEN weekday IS NOT NULL AND anchor_date IS NOT NULL AND day_of_month IS NULL
                           AND interval_days IS NULL
      WHEN 'monthly'  THEN day_of_month IS NOT NULL AND weekday IS NULL AND interval_days IS NULL
      WHEN 'every_n_days' THEN interval_days IS NOT NULL AND anchor_date IS NOT NULL
                               AND weekday IS NULL AND day_of_month IS NULL
      ELSE weekday IS NULL AND day_of_month IS NULL AND interval_days IS NULL
    END
  );

COMMENT ON TABLE public.recurring_task_templates IS
  'Recurring to-do templates. A spawner (process-agent-schedules cron) materializes each active template into a normal comms_tasks row stamped with (recurring_template_id, recurring_instance_date); a unique partial index on those columns makes daily spawning idempotent. Cadence: daily / weekdays / weekly(weekday) / biweekly(weekday + anchor_date) / monthly(day_of_month 1..28) / every_n_days(interval_days 2..365 + anchor_date). Service-role only.';

-- ─── applied_migrations bookkeeping ─────────────────────────────────────────
INSERT INTO public.applied_migrations (version, description)
VALUES (
  '0455',
  'recurring to-dos gain an every_n_days cadence: recurring_task_templates.interval_days (2..365, CHECKed), the cadence domain widened to include ''every_n_days'', and the per-cadence shape CHECK restated so every_n_days requires interval_days + anchor_date and the other five forbid interval_days. Counted from the anchor rather than the last spawn so a missed cron tick cannot shift the rhythm. No new tables, no new grants.'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
