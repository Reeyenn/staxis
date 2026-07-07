-- 0296 — pms_knowledge_files.disabled_feeds: per-feed collection gate.
--
-- feature/coverage-gated-feeds (2026-07-06). The founder's rule: the robot only
-- collects feeds that were PROVEN readable by a preview capture on the Coverage
-- Editor ("Captured" panel). Feeds that were mapped at learn time but never
-- produced a successful preview would otherwise be polled forever, silently
-- writing nothing (their rows fail the safety layer) — wasted work the founder
-- explicitly doesn't want.
--
-- MECHANICS
-- ---------
-- - Founder clicks Make live on a property-scoped Coverage page → promoteMap
--   computes which mapped feeds have NO live/{propertyId}/{feed}.sample.json
--   preview artifact and stores their action keys here (jsonb array of strings).
-- - The CUA session-driver excludes these keys when building its polling
--   templates, so a disabled feed is never navigated to at all.
-- - A later SUCCESSFUL preview (mapper.capture_feed job) removes that feed's
--   key from the array — proving a feed works turns its collection on.
-- - Worker-side auto-promotion of a fresh complete learn never sets this
--   column, so it keeps the default '[]' = collect everything (a complete learn
--   already verified every feed).
--
-- WHY OUTSIDE THE SIGNED ENVELOPE
-- -------------------------------
-- The knowledge jsonb is HMAC-signed (Fly-only key); folding this flag into it
-- would force a worker re-sign job for every on/off toggle. Kept as a sibling
-- column instead: a tampered value can only REDUCE what's collected (deny-of-
-- data, admin-visible on the Coverage page), never inject selectors or steps.

BEGIN;

ALTER TABLE public.pms_knowledge_files
  ADD COLUMN IF NOT EXISTS disabled_feeds jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.pms_knowledge_files.disabled_feeds IS
  'Action keys the session-driver must NOT poll (jsonb array of strings, e.g. ["getGuests"]). Set at founder Make-live for feeds with no successful preview capture; cleared per-feed by a later successful capture. Deliberately outside the signed knowledge envelope — toggling never needs a re-sign.';

INSERT INTO public.applied_migrations (version, description)
VALUES (
  '0296',
  'pms_knowledge_files.disabled_feeds — per-feed collection gate: Make-live only turns on feeds proven by a preview capture; the CUA driver skips the rest; a later successful Re-read re-enables a feed.'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
