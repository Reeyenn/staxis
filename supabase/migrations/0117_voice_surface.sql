-- ─── Migration 0117: voice surface (Whisper STT + Nova TTS + wake word) ──
-- Phase L (2026-05-14): originally written and applied as 0116 but
-- collided with 0116_properties_total_rooms_check.sql from the parallel
-- Phase K work. The DDL is already deployed in prod under filename
-- 0116_voice_surface.sql; this rename keeps the on-disk version unique
-- so a fresh-DB replay won't hit duplicate-version INSERTs into
-- applied_migrations. Phase L Fix 3 adds a CI-time test invariant that
-- prevents future duplicate-version filename collisions at write time.
--
-- Adds the schema for the voice layer that sits on top of /api/agent/command.
-- Three concerns:
--
-- 1. Per-account preferences for "talk back to me" + "Hey Staxis wake word"
--    (default OFF for both — voice is opt-in).
--
-- 2. Drop $10/$50 caps to $5/$25 per Reeyen's master prompt. Existing tier
--    structure (accounts.ai_cost_tier from 0100) overrides the free baseline;
--    we only touch the free-tier default + the property cap.
--
-- 3. Audio cost records: extend agent_costs.kind to include 'audio' so
--    Whisper + TTS calls land in the same ledger as text spend. Audio costs
--    are recorded after-the-fact (not reserved up front like 'request');
--    the route-side `assertAudioBudget` gate sums ALL kinds to enforce the
--    daily cap across text + voice combined (master-prompt clarification).
--
-- 4. Retention table: voice_recordings holds the storage_key + transcript
--    for each utterance for 7 days. A daily cron purges expired rows + the
--    referenced storage object. INV-18..21 live in INVARIANTS.md.
--
-- Idempotent.

-- ─── 1. Account-level voice preferences ──────────────────────────────────

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS voice_replies_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS wake_word_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS voice_onboarded_at timestamptz;

-- ─── 2. Extend agent_costs.kind to include 'audio' ───────────────────────

-- 0080 defined the kind constraint inline as `check (kind in ('request',
-- 'eval', 'background'))` which Postgres auto-named `agent_costs_kind_check`.
-- Drop the unnamed-default and re-add a named version that includes 'audio'.
ALTER TABLE public.agent_costs
  DROP CONSTRAINT IF EXISTS agent_costs_kind_check;

ALTER TABLE public.agent_costs
  ADD CONSTRAINT agent_costs_kind_check
  CHECK (kind IN ('request', 'eval', 'background', 'audio'));

-- ─── 3. Voice recordings retention table ─────────────────────────────────

CREATE TABLE IF NOT EXISTS public.voice_recordings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.properties(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES public.agent_conversations(id) ON DELETE SET NULL,
  -- Path in the private `voice-recordings` storage bucket.
  storage_key text NOT NULL,
  duration_sec numeric(7, 2) NOT NULL CHECK (duration_sec >= 0),
  -- Nullable until Whisper returns; intentionally NOT enforced at DB level
  -- because a transcription failure should still leave the audio row for
  -- debugging.
  transcript text,
  language text,
  cost_usd numeric(10, 6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- INV-18: expires_at = created_at + interval '7 days'. Enforced by DEFAULT
  -- + a CHECK to catch any caller that overrides with an earlier value.
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  CONSTRAINT voice_recordings_expires_after_created
    CHECK (expires_at > created_at)
);

-- Hot path: purge cron does `WHERE expires_at <= now()`. Index supports
-- both equality and range scans.
CREATE INDEX IF NOT EXISTS voice_recordings_expires_idx
  ON public.voice_recordings (expires_at);

-- User-level "show me my voice history" lookup (future debug surface, plus
-- a join target for `agent_costs` reconciliation when needed).
CREATE INDEX IF NOT EXISTS voice_recordings_user_created_idx
  ON public.voice_recordings (user_id, created_at DESC);

-- ─── 4. RLS — users see their own recordings, service-role bypasses ──────

ALTER TABLE public.voice_recordings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "voice_recordings_select_own"
  ON public.voice_recordings
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.accounts a
      WHERE a.id = voice_recordings.user_id
        AND a.data_user_id = auth.uid()
    )
  );

-- ─── 5. Audit ────────────────────────────────────────────────────────────

INSERT INTO public.applied_migrations (version, description)
VALUES (
  '0117',
  'Voice surface: account voice prefs + audio cost kind + voice_recordings retention table'
)
ON CONFLICT (version) DO NOTHING;
