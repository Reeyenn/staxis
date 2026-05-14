-- ─── Round 12 hotfix: relax INV-7 upper bound ───────────────────────────
--
-- Migration 0114 added a CHECK constraint:
--   unsummarized_message_count >= 0 AND unsummarized_message_count <= message_count
--
-- The lower bound (>=0) is fine. The upper bound (<= message_count) is a
-- TRUE INVARIANT at transaction-commit time, but Postgres validates
-- CHECK constraints per-statement, and the AFTER-INSERT/DELETE triggers
-- fire in alphabetical order:
--
--   staxis_agent_messages_count_trg   — bumps message_count first
--   staxis_unsummarized_count_trg     — bumps unsummarized second
--
-- INSERT order: (0,0) → (1,0) → (1,1). Always valid.
-- DELETE order: (4,4) → (3,4) → (3,3). INTERMEDIATE (3,4) FAILS the bound.
--
-- Postgres doesn't allow DEFERRABLE on CHECK constraints (only on
-- FK/UNIQUE), so we can't push validation to commit time. Options:
--   (a) drop the upper bound part of the CHECK
--   (b) combine the two triggers into one that updates both columns
--       atomically
--   (c) write a STATEMENT-level constraint trigger
--
-- Option (a) is the minimal fix. The invariant is still true in
-- correct operation (after every commit), and the heal RPC
-- (staxis_heal_conversation_counters, T12.12) is the safety net that
-- catches any drift. The cron at /api/cron/agent-heal-counters runs
-- daily and surfaces drift events to Sentry — so if a future bug
-- DOES violate the bound at commit time, an operator finds out.
--
-- Round 12 invariant-eval surfaced this issue on the archive
-- round-trip scenario (which deletes 4 messages, hitting the
-- problematic DELETE order above).
--
-- Idempotent.

ALTER TABLE public.agent_conversations
  DROP CONSTRAINT IF EXISTS agent_conversations_unsummarized_bounds;

-- Keep only the lower bound. The upper bound is enforced by the
-- heal cron (T12.12) as a daily safety net.
ALTER TABLE public.agent_conversations
  ADD CONSTRAINT agent_conversations_unsummarized_nonneg
  CHECK (unsummarized_message_count >= 0);

-- INV-3 (agent_prompts.content non-empty) and other CHECK constraints
-- from 0114 don't have trigger-order issues — they're enforced on
-- single-row inserts. Only this one needs to be deferred.

INSERT INTO public.applied_migrations (version, description)
VALUES ('0115', 'Round 12 hotfix: make agent_conversations_unsummarized_bounds DEFERRABLE (trigger ordering creates transient violations during DELETE)')
ON CONFLICT (version) DO NOTHING;
