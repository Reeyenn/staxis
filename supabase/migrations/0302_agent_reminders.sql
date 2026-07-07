-- 0302 — agent_reminders: delayed one-shot reminders scheduled by the AI assistant.
--
-- WHY
-- ---
-- "Remind the morning shift about the pool at 8am." Until now the assistant
-- could only act NOW — send a message, post an announcement, create a to-do.
-- This table lets a manager schedule a message to fire LATER: the create_reminder
-- tool writes a pending row here (behind the same approval card every mutation
-- goes through), and a cron tick fires anything due by posting into the
-- Communications hub — a DM from the creator to the target person, or an
-- announcement-style broadcast for a whole department.
--
-- TARGETING (mirrors comms_tasks)
-- -------------------------------
-- A reminder is aimed at EITHER one person (`target_staff_id`) OR one department
-- (`target_department`), never both. Same shape the to-do list uses, so the
-- delivery code can reuse the comms core: a staff target becomes a DM from the
-- creator; a department target becomes an announcement.
--
-- FIRING
-- ------
-- `fire_at` is when it should go out. A cron tick (piggybacked on the existing
-- process-sms-jobs worker — no new vercel.json cron) claims every row whose
-- fire_at <= now() with fired_at IS NULL AND canceled_at IS NULL, delivers it,
-- and stamps `fired_at`. Late-firing is tolerated on purpose: an overdue
-- reminder still fires on the next tick (better a few minutes late than dropped).
-- `canceled_at` tombstones a reminder the manager called off before it fired.
--
-- SECURITY
-- --------
-- Service-role only (deny-all RLS), same idiom as agent_pending_actions (0300)
-- and staff_link_tokens (0295). It is written by the create_reminder tool and
-- read/fired by the cron, both via supabaseAdmin. Anon + authenticated get no
-- policies (default-deny). Property scoping lives in the tool + cron, not the DB.
--
-- Idempotent. Safe to re-run.

BEGIN;

-- @rls: service-role-only — written by the create_reminder agent tool and
-- fired by the process-sms-jobs cron, exclusively through supabaseAdmin. Anon +
-- authenticated get no policies (deny-all).
CREATE TABLE IF NOT EXISTS public.agent_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  property_id          uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  -- Who scheduled it (staff.id). A DM target is delivered AS this person, so
  -- the recipient sees the reminder coming from a real colleague, not "Staxis".
  created_by_staff_id  uuid REFERENCES public.staff(id) ON DELETE SET NULL,

  -- Targeting: exactly one of target_staff_id / target_department (same as
  -- comms_tasks). A staff target → DM; a department target → announcement.
  target_staff_id      uuid REFERENCES public.staff(id) ON DELETE CASCADE,
  target_department    text CHECK (
    target_department IS NULL
    OR target_department IN ('front_desk', 'housekeeping', 'maintenance', 'general')
  ),

  -- The reminder text (what the recipient reads).
  body                 text NOT NULL,

  -- When it should fire, and when it actually did (null = not yet). canceled_at
  -- tombstones a reminder called off before firing.
  fire_at              timestamptz NOT NULL,
  fired_at             timestamptz,
  canceled_at          timestamptz,

  created_at           timestamptz NOT NULL DEFAULT now(),

  -- Aim at a person OR a department, never neither and never both — mirrors the
  -- to-do targeting model so delivery can branch cleanly.
  CONSTRAINT agent_reminders_one_target CHECK (
    (target_staff_id IS NOT NULL AND target_department IS NULL)
    OR (target_staff_id IS NULL AND target_department IS NOT NULL)
  )
);

-- Hot path for the cron sweep: "everything due, not yet fired, not canceled".
-- Partial index keeps it tiny — fired/canceled rows drop out of the index.
CREATE INDEX IF NOT EXISTS agent_reminders_due_idx
  ON public.agent_reminders (fire_at)
  WHERE fired_at IS NULL AND canceled_at IS NULL;

-- List/cancel path: a property's still-pending reminders, soonest first.
CREATE INDEX IF NOT EXISTS agent_reminders_property_idx
  ON public.agent_reminders (property_id, fire_at)
  WHERE fired_at IS NULL AND canceled_at IS NULL;

-- RLS: service-role only. Anon + authenticated get NO policies → default-deny
-- (mirrors agent_pending_actions 0300 and every other server-only table).
ALTER TABLE public.agent_reminders ENABLE ROW LEVEL SECURITY;

-- Idempotent re-runs: drop any pre-existing policies before (re)declaring the
-- deny-all default. We declare none on purpose.
DO $$
DECLARE pol record;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'agent_reminders'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.agent_reminders', pol.policyname);
  END LOOP;
END $$;

COMMENT ON TABLE public.agent_reminders IS
  'Delayed one-shot reminders scheduled by the AI assistant (create_reminder tool, card-gated). Aimed at one staff member (DM from the creator) or one department (announcement). A cron tick on process-sms-jobs fires everything due (fire_at <= now, fired_at IS NULL, canceled_at IS NULL), delivers into the Communications hub, and stamps fired_at. Late firing tolerated. Service-role only.';

-- ─── applied_migrations bookkeeping ──────────────────────────────────────
INSERT INTO public.applied_migrations (version, description)
VALUES (
  '0302',
  'agent_reminders: delayed one-shot reminders scheduled by the AI assistant. create_reminder writes a pending row (approval card); a process-sms-jobs cron tick fires anything due by posting a DM (staff target) or announcement (department target) into comms, then stamps fired_at. Late firing tolerated; canceled_at tombstones. Service-role only.'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
