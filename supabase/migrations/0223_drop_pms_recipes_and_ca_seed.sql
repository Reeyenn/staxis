-- Plan v8 D.3 — drop the legacy pms_recipes table + nuke the hand-seeded
-- Choice Advantage v5 row from pms_knowledge_files.
--
-- Why now:
--   - pms_recipes was the original recipe storage from the 4-action mapper
--     era (pre-v4). The new system stores recipes in pms_knowledge_files
--     (15-table schema, vision-built). No code reads pms_recipes after
--     this migration:
--       * src/app/api/admin/property-health/route.ts → deleted
--       * cua-service/src/recipe-signing.ts → reads signature columns from
--         pms_knowledge_files now, not pms_recipes
--   - The choice_advantage v5 row in pms_knowledge_files was built by the
--     DOM tool which was deleted in Plan v8 D.2. Greenfield rebuild: the
--     vision mapper will produce a fresh recipe when Comfort Suites
--     (or any other PMS on choice_advantage) is onboarded.
--
-- After this migration:
--   - session-driver finds no active knowledge file for choice_advantage
--     and goes into `paused_no_knowledge_file` status on any hotel using
--     that PMS family
--   - Reeyen onboards the next hotel → Live Mapping UI fires → vision
--     mapper builds recipe v1 → session-driver resumes
--   - The pms_recipes table is gone; CASCADE-dropped FK columns are safe
--     because no downstream tables FK into it (verified)

BEGIN;

-- ─── Step 1: nuke the choice_advantage hand-seeded recipe ────────────────
-- 0203_seed_choice_advantage_knowledge.sql inserted a v1 row hand-ported
-- from the deleted Railway scraper. The vision mapper supersedes it.
DELETE FROM public.pms_knowledge_files
WHERE pms_family = 'choice_advantage';

-- ─── Step 2: drop the legacy pms_recipes table ───────────────────────────
-- RLS policies + grants cascade with the table. No FK columns reference
-- pms_recipes from other tables (verified — onboarding_jobs.recipe_id
-- was the only FK and that table is also legacy, but stays for now since
-- the workflow_jobs system tracks the active queue).
DROP TABLE IF EXISTS public.pms_recipes CASCADE;

-- ─── Step 3: applied_migrations bookkeeping ──────────────────────────────
INSERT INTO public.applied_migrations (version, description)
VALUES (
  '0223',
  'Plan v8 D.3 — drop legacy pms_recipes table + DELETE the hand-seeded choice_advantage row from pms_knowledge_files. Forces fresh vision-built recipes on next hotel onboarding.'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;
