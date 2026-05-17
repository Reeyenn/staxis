-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0142: Enforce missing foreign-key constraints (audit follow-up)
-- (Originally drafted as 0133; renumbered after rebase to avoid collision.
-- Schema constraints already applied to prod 2026-05-17 — this migration's
-- INSERT into applied_migrations is the bookkeeping catch-up.)
--
-- The May 2026 data-model audit found 8 columns that look like FKs (named
-- `<entity>_id`, type uuid) but had no `REFERENCES` clause. This migration
-- adds the FK constraints. For each, we first clean up any orphan rows
-- (NULL them or delete them, depending on the column's nullability), then
-- ADD CONSTRAINT.
--
-- ON DELETE policy choice rationale:
--   - NULL-able cols → SET NULL (preserve the parent row, just unlink)
--   - NOT-NULL cols → CASCADE (the row is meaningless without its parent;
--                              keeping orphans would be worse than losing
--                              the row)
--
-- Polymorphic columns that we deliberately do NOT enforce (the target
-- depends on a sibling discriminator column, so a single FK isn't
-- feasible — application code is the only place that can validate):
--   - admin_audit_log.target_id            (varies by target_type)
--   - prediction_log.prediction_id         (varies by layer)
--   - agent_cost_finalize_failures.reservation_id
--     (references a soft state of agent_costs that may be cancelled with
--      cost_usd = 0, so a hard FK would block cleanup paths)
-- These get COMMENT ON COLUMN entries so the rationale survives.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. staff.auth_user_id → auth.users(id) on delete set null ────────────
-- Pattern: accounts.data_user_id and properties.owner_id already reference
-- auth.users — cross-schema FK is a supported pattern in Supabase.
update public.staff
   set auth_user_id = null
 where auth_user_id is not null
   and auth_user_id not in (select id from auth.users);

alter table public.staff
  drop constraint if exists staff_auth_user_id_fkey,
  add  constraint staff_auth_user_id_fkey
    foreign key (auth_user_id) references auth.users(id) on delete set null;

-- ─── 2. onboarding_jobs.recipe_id → pms_recipes(id) on delete set null ────
update public.onboarding_jobs
   set recipe_id = null
 where recipe_id is not null
   and recipe_id not in (select id from public.pms_recipes);

alter table public.onboarding_jobs
  drop constraint if exists onboarding_jobs_recipe_id_fkey,
  add  constraint onboarding_jobs_recipe_id_fkey
    foreign key (recipe_id) references public.pms_recipes(id) on delete set null;

-- ─── 3. api_limits.property_id → properties(id) on delete cascade ─────────
-- property_id is part of the composite PK (property_id, endpoint,
-- hour_bucket); cascading delete cleans up that property's rate-limit
-- buckets when the property goes away.
delete from public.api_limits
 where property_id not in (select id from public.properties);

alter table public.api_limits
  drop constraint if exists api_limits_property_id_fkey,
  add  constraint api_limits_property_id_fkey
    foreign key (property_id) references public.properties(id) on delete cascade;

-- ─── 4. dashboard_by_date.property_id → properties(id) on delete cascade ─
-- 0041 added the column with a backfill but did not add the FK. Cascade
-- so deleting a property cleans up its dashboard history.
delete from public.dashboard_by_date
 where property_id not in (select id from public.properties);

alter table public.dashboard_by_date
  drop constraint if exists dashboard_by_date_property_id_fkey,
  add  constraint dashboard_by_date_property_id_fkey
    foreign key (property_id) references public.properties(id) on delete cascade;

-- ─── 5. agent_cost_finalize_failures.* → various ──────────────────────────
-- All three non-polymorphic FKs in one shot.
delete from public.agent_cost_finalize_failures
 where property_id not in (select id from public.properties);

delete from public.agent_cost_finalize_failures
 where user_id not in (select id from public.accounts);

update public.agent_cost_finalize_failures
   set conversation_id = null
 where conversation_id is not null
   and conversation_id not in (select id from public.agent_conversations);

alter table public.agent_cost_finalize_failures
  drop constraint if exists agent_cost_finalize_failures_property_id_fkey,
  drop constraint if exists agent_cost_finalize_failures_user_id_fkey,
  drop constraint if exists agent_cost_finalize_failures_conversation_id_fkey,
  add  constraint agent_cost_finalize_failures_property_id_fkey
    foreign key (property_id) references public.properties(id) on delete cascade,
  add  constraint agent_cost_finalize_failures_user_id_fkey
    foreign key (user_id) references public.accounts(id) on delete cascade,
  add  constraint agent_cost_finalize_failures_conversation_id_fkey
    foreign key (conversation_id) references public.agent_conversations(id) on delete set null;

-- ─── 6. model_runs.item_id → inventory(id) + cross-column CHECK ───────────
-- item_id is non-null iff layer = 'inventory_rate' (per the inventory ML
-- pipeline design — see 0062). Other layers (demand/supply/optimizer)
-- always have item_id = null. Enforce both the FK and the cross-column
-- invariant so a future writer can't introduce a misshaped row.
update public.model_runs
   set item_id = null
 where item_id is not null
   and item_id not in (select id from public.inventory);

alter table public.model_runs
  drop constraint if exists model_runs_item_id_fkey,
  drop constraint if exists model_runs_item_id_layer_check,
  add  constraint model_runs_item_id_fkey
    foreign key (item_id) references public.inventory(id) on delete set null,
  add  constraint model_runs_item_id_layer_check
    check ((layer = 'inventory_rate') = (item_id is not null));

-- ─── 7. Document the polymorphic FKs that we cannot enforce ───────────────
comment on column public.admin_audit_log.target_id is
  'Polymorphic reference: the target table is determined by target_type (account, property, recipe, prospect, expense, feedback, etc.). DB-level FK not feasible — validate at the API layer.';

comment on column public.prediction_log.prediction_id is
  'Polymorphic reference: target is demand_predictions, supply_predictions, or inventory_rate_predictions depending on the layer column. DB-level FK not feasible — validate at the ML service layer.';

comment on column public.agent_cost_finalize_failures.reservation_id is
  'Snapshot of the agent_costs row id that failed to finalize. NOT a hard FK because the agent_costs row may have been cancelled with cost_usd = 0; the failure record is the only place the real cost is recorded. Kept as a soft reference for forensic correlation.';

-- ─── 8. Track migration ───────────────────────────────────────────────────
insert into applied_migrations (version, description)
values (
  '0142',
  'enforce 8 missing FKs (staff.auth_user_id, onboarding_jobs.recipe_id, api_limits.property_id, dashboard_by_date.property_id, agent_cost_finalize_failures.{property_id,user_id,conversation_id}, model_runs.item_id) + cross-column CHECK on model_runs.item_id + document 3 polymorphic columns'
)
on conflict (version) do nothing;
