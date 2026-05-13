-- ─── Round 11 T3: drop dead canary_pct column ─────────────────────────────
-- agent_prompts.canary_pct was added by migration 0102 with the intent
-- to slowly roll out prompt changes to a fraction of conversations.
-- The resolver code in prompts-store.ts was structured for it but
-- never actually used the bucket — line 138 computed canaryBucket()
-- and immediately threw it away.
--
-- Product decision (2026-05-13): rollouts are always 100%; rollback
-- is "re-activate the prior version" via /admin/agent/prompts. No
-- need for partial rollout. The column is dead weight that confuses
-- future engineers.
--
-- This migration:
--   - Drops the column from agent_prompts
--   - Idempotent (IF EXISTS guard)
--
-- Code-side cleanup happens in the same commit (prompts-store.ts,
-- admin UI, POST/PATCH endpoints, eval runner comments).

ALTER TABLE public.agent_prompts
  DROP COLUMN IF EXISTS canary_pct;

INSERT INTO public.applied_migrations (version, description)
VALUES ('0108', 'Round 11 T3: drop unused agent_prompts.canary_pct column')
ON CONFLICT (version) DO NOTHING;
