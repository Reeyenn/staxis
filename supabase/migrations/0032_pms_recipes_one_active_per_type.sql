-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0032: Enforce at-most-one active recipe per PMS family
--
-- Why this exists:
--   Migration 0031 added pms_recipes with a unique constraint on
--   (pms_type, version, status). That stops the literal duplicate
--   (choice_advantage, 1, 'active') from being inserted twice, but it
--   does NOT stop two simultaneously-active recipes for the same
--   pms_type at different versions:
--      (choice_advantage, 1, 'active')   ← old, should be deprecated
--      (choice_advantage, 2, 'active')   ← new, became active by promotion
--
--   The promotion logic in cua-service/src/job-runner.ts demotes prior
--   actives during promotion, but if that demote query fails or races,
--   we end up with two actives. The recipe-loader picks the highest
--   version so the wrong recipe never runs, but the orphan active
--   lingers, confusing audits and rollback decisions.
--
--   This partial unique index makes the database the source of truth:
--   any code path that tries to leave two actives for the same pms_type
--   gets a constraint violation. Our promotion code already does the
--   right thing; this just guarantees nobody else can break it.
--
-- Re-runnable: IF NOT EXISTS guard + the existing data is already valid
-- (we have zero recipes today; 0031 just shipped).
-- ═══════════════════════════════════════════════════════════════════════════

create unique index if not exists pms_recipes_one_active_per_type_idx
  on public.pms_recipes (pms_type)
  where status = 'active';

comment on index pms_recipes_one_active_per_type_idx is
  'Enforces at most one active recipe per PMS family. Promotion logic in cua-service must demote the prior active before promoting a new one — this index turns a quiet logic bug into a loud constraint violation.';

insert into public.applied_migrations (version, description)
values ('0032', 'pms_recipes: at-most-one active per pms_type')
on conflict (version) do nothing;
