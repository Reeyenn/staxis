-- 0303 — recurring_task_templates: daily/weekly checklists that reappear.
--
-- WHY
-- ---
-- "Every morning, check the pool chemicals." "Every Monday, deep-clean the
-- lobby." Managers want checklist items that come back on a cadence instead of
-- re-typing them. This adds a TEMPLATE table the AI assistant manages
-- (create_recurring_todo / stop_recurring_todo), plus a once-a-day spawner that
-- materializes each active template into a NORMAL comms_tasks row.
--
-- WHY A TEMPLATE TABLE (not recurrence columns on comms_tasks)
-- -----------------------------------------------------------
-- The to-do pane reads comms_tasks. If we put a "repeats" flag on the task row
-- itself, we'd either mutate one long-lived row (losing the per-day done/undone
-- history the pane shows) or teach the pane to understand recurrence. Instead a
-- template SPAWNS a fresh, independent comms_tasks row each day: the pane shows
-- spawned instances exactly like any other task (they ARE ordinary rows), the
-- done state is per-day, and stopping a template leaves already-spawned
-- instances alone. Template-management UI is out of scope for now — the
-- assistant is the only manager of templates.
--
-- SPAWNING + IDEMPOTENCY
-- ----------------------
-- The process-sms-jobs cron tick calls the spawner. It runs once per property
-- per local day: for every active template due today (per cadence) it inserts a
-- comms_tasks row STAMPED with (recurring_template_id, recurring_instance_date).
-- A UNIQUE partial index on those two columns makes re-running the spawn within
-- the same day a no-op — the second insert hits the unique constraint and is
-- swallowed. So the every-5-min cron can call it freely; only the first tick of
-- a new local day actually spawns.
--
-- SECURITY
-- --------
-- recurring_task_templates is service-role only (deny-all RLS), same idiom as
-- comms_tasks (0241) and agent_pending_actions (0300). Managed by the agent
-- tools + spawned by the cron, both via supabaseAdmin.
--
-- Idempotent. Safe to re-run.

BEGIN;

-- ── Additive spawn-provenance columns on comms_tasks ────────────────────────
-- These tag a task row as "spawned from template T for day D". Nullable, so
-- every existing + manually-created task is unaffected (both stay NULL).
ALTER TABLE public.comms_tasks
  ADD COLUMN IF NOT EXISTS recurring_template_id  uuid,
  ADD COLUMN IF NOT EXISTS recurring_instance_date date;

-- One spawned instance per (template, day). This is the idempotency guard the
-- spawner relies on — a duplicate insert for the same day fails the unique index
-- and is caught/ignored. Partial so it costs nothing for non-recurring rows.
CREATE UNIQUE INDEX IF NOT EXISTS comms_tasks_recurring_instance_uniq
  ON public.comms_tasks (recurring_template_id, recurring_instance_date)
  WHERE recurring_template_id IS NOT NULL;

-- ── Recurrence templates ────────────────────────────────────────────────────
-- @rls: service-role-only — managed by the create_recurring_todo /
-- stop_recurring_todo agent tools and spawned by the process-sms-jobs cron,
-- exclusively through supabaseAdmin. Anon + authenticated get no policies
-- (deny-all), mirroring comms_tasks.
CREATE TABLE IF NOT EXISTS public.recurring_task_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  property_id          uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  created_by_staff_id  uuid REFERENCES public.staff(id) ON DELETE SET NULL,

  -- What the spawned to-do says + who it goes to (same targeting as comms_tasks:
  -- a person and/or a department).
  title                text NOT NULL,
  assigned_staff_id    uuid REFERENCES public.staff(id) ON DELETE SET NULL,
  assigned_department  text CHECK (
    assigned_department IS NULL
    OR assigned_department IN ('front_desk', 'housekeeping', 'maintenance', 'general')
  ),
  priority             text NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('normal', 'high', 'urgent')),

  -- Cadence:
  --   daily    → spawns every day
  --   weekdays → spawns Mon–Fri (property-local)
  --   weekly   → spawns on `weekday` (0=Sun … 6=Sat, property-local)
  cadence              text NOT NULL CHECK (cadence IN ('daily', 'weekdays', 'weekly')),
  -- Required + only meaningful for cadence='weekly'; 0=Sunday … 6=Saturday.
  weekday              integer CHECK (weekday IS NULL OR (weekday BETWEEN 0 AND 6)),

  -- Lifecycle. active=false stops future spawns; already-spawned tasks stay.
  active               boolean NOT NULL DEFAULT true,

  -- Bookkeeping so the spawner can run "once per local day" cheaply without
  -- re-deriving it from comms_tasks. The date (property-local) it last spawned.
  last_spawned_on      date,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  -- weekly cadence must name a weekday; the others must not.
  CONSTRAINT recurring_task_templates_weekly_weekday CHECK (
    (cadence = 'weekly' AND weekday IS NOT NULL)
    OR (cadence <> 'weekly' AND weekday IS NULL)
  )
);

-- Spawner hot path: a property's active templates.
CREATE INDEX IF NOT EXISTS recurring_task_templates_active_idx
  ON public.recurring_task_templates (property_id)
  WHERE active = true;

-- RLS: service-role only. Anon + authenticated get NO policies → default-deny
-- (mirrors comms_tasks 0241 and agent_pending_actions 0300).
ALTER TABLE public.recurring_task_templates ENABLE ROW LEVEL SECURITY;

-- Idempotent re-runs: drop any pre-existing policies before (re)declaring the
-- deny-all default. We declare none on purpose.
DO $$
DECLARE pol record;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'recurring_task_templates'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.recurring_task_templates', pol.policyname);
  END LOOP;
END $$;

COMMENT ON TABLE public.recurring_task_templates IS
  'Recurring to-do templates managed by the AI assistant (create_recurring_todo / stop_recurring_todo, card-gated). A once-a-day spawner (process-sms-jobs cron) materializes each active template into a normal comms_tasks row stamped with (recurring_template_id, recurring_instance_date); a unique partial index on those columns makes daily spawning idempotent. Cadence: daily / weekdays / weekly(weekday). Service-role only.';

COMMENT ON COLUMN public.comms_tasks.recurring_template_id IS
  'When set, this to-do was spawned from recurring_task_templates.id. NULL for all manually-created tasks.';
COMMENT ON COLUMN public.comms_tasks.recurring_instance_date IS
  'The property-local date this recurring instance was spawned for. Unique with recurring_template_id (idempotent daily spawn).';

-- ─── applied_migrations bookkeeping ──────────────────────────────────────
INSERT INTO public.applied_migrations (version, description)
VALUES (
  '0303',
  'recurring_task_templates: daily/weekly recurring to-do templates managed by the AI assistant. A once-a-day spawner (process-sms-jobs cron) materializes each active template into a normal comms_tasks row stamped with recurring_template_id + recurring_instance_date; a unique partial index on those makes spawning idempotent. Adds those two nullable columns to comms_tasks. Cadence daily/weekdays/weekly(weekday). Service-role only.'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
