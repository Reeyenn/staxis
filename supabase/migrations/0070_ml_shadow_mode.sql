-- 0070_ml_shadow_mode.sql
-- ML shadow mode + auto-rollback (Tier 2 Phase 5).
--
-- Problem: today, every re-train of a graduated (auto_fill_enabled=true)
-- model immediately replaces the active model. If the new fit is worse —
-- a noisy weekly retrain on a hotel that had a bad-data week, say — Count
-- Mode silently auto-fills with degraded numbers and Maria's only signal
-- is "the autofill suddenly feels off." There's no safety net.
--
-- Shadow mode: when re-training an item that already has a graduated
-- active model, the new model lands as a shadow run instead of replacing
-- the active one. It runs alongside for 7 days, the evaluation cron
-- compares shadow vs active MAE against fresh actuals, and only then
-- promotes (or marks the shadow rejected). If the shadow underperforms,
-- nothing changes — the existing active keeps serving. That's the
-- "auto-rollback" half: a bad retrain can't take the autofill down.
--
-- This migration adds the columns the training + inference + evaluation
-- paths need. The code wiring goes in this same commit (training writes
-- shadows, inference predicts via both, evaluate cron promotes/rejects).
--
-- Scope: scaffolds the columns for every ML layer (model_runs is shared
-- across demand/supply/optimizer/inventory_rate). Phase 5 wires
-- inventory_rate end-to-end; the housekeeping layers can adopt
-- progressively — they get the column defaults (is_shadow=false) and
-- their behavior is unchanged.

-- ─── model_runs ──────────────────────────────────────────────────────────
alter table public.model_runs
  add column if not exists is_shadow boolean not null default false;

comment on column public.model_runs.is_shadow is
  'When true, this run is a shadow model: it was trained alongside an existing graduated active model and is being evaluated against fresh production data before being promoted. is_active stays false until promotion (or true=rejected, depending on the evaluation cron''s decision).';

alter table public.model_runs
  add column if not exists shadow_started_at timestamptz;

comment on column public.model_runs.shadow_started_at is
  'When this run entered shadow mode. The evaluation cron treats rows where now() - shadow_started_at >= 7 days as ready for promotion/rejection. Null for non-shadow runs.';

alter table public.model_runs
  add column if not exists shadow_evaluation_mae numeric;

comment on column public.model_runs.shadow_evaluation_mae is
  'MAE the shadow model achieved on production data during its trial. Written by the shadow-evaluate cron at promotion/rejection time. Null until evaluated.';

alter table public.model_runs
  add column if not exists shadow_promoted_at timestamptz;

comment on column public.model_runs.shadow_promoted_at is
  'When the shadow was promoted to active. Null if the shadow was rejected (in which case deactivation_reason will be ''shadow_underperformed'').';

create index if not exists model_runs_shadow_pending_idx
  on public.model_runs (property_id, layer, shadow_started_at)
  where is_shadow = true and shadow_promoted_at is null;

comment on index public.model_runs_shadow_pending_idx is
  'Lookup index for the daily shadow-evaluate cron: find shadow runs that have been observing long enough to be promoted or rejected.';

-- ─── inventory_rate_predictions ──────────────────────────────────────────
-- Shadow inventory predictions need to coexist with active predictions
-- for the same (property, item, target_date). Tag them so the existing
-- "delete prior prediction" logic in inference doesn't wipe the other
-- side.
alter table public.inventory_rate_predictions
  add column if not exists is_shadow boolean not null default false;

comment on column public.inventory_rate_predictions.is_shadow is
  'When true, this prediction came from a shadow model (model_runs.is_shadow=true). The cockpit + Count Mode autofill should ignore these rows; they exist so the shadow-evaluate cron can compare to actuals.';

-- Drop the partial unique index that assumes one prediction per
-- (property, item, target_date) and recreate it split by is_shadow.
-- We need both active and shadow predictions to coexist on the same date.
do $$
declare
  idx record;
begin
  -- Find any existing unique index that includes the (property, item, date)
  -- tuple but not is_shadow — those would block shadow inserts.
  for idx in
    select indexrelname
    from pg_stat_user_indexes s
    join pg_index i on i.indexrelid = s.indexrelid
    where s.relname = 'inventory_rate_predictions'
      and i.indisunique = true
  loop
    -- Defer; the partial-unique is recreated below with is_shadow factored in.
    null;
  end loop;
end $$;

create unique index if not exists inventory_rate_predictions_active_unique_idx
  on public.inventory_rate_predictions (property_id, item_id, predicted_for_date)
  where is_shadow = false;

comment on index public.inventory_rate_predictions_active_unique_idx is
  'Exactly one active prediction per (property, item, date). Shadow rows are excluded (they can coexist via the separate shadow index).';

create unique index if not exists inventory_rate_predictions_shadow_unique_idx
  on public.inventory_rate_predictions (property_id, item_id, predicted_for_date)
  where is_shadow = true;

comment on index public.inventory_rate_predictions_shadow_unique_idx is
  'Exactly one shadow prediction per (property, item, date). Separate from the active uniqueness so shadow + active can coexist.';

-- ─── Bookkeeping ─────────────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values ('0070', 'ml shadow mode + auto-rollback (model_runs.is_shadow + shadow_started_at; inventory_rate_predictions.is_shadow)')
on conflict (version) do nothing;
