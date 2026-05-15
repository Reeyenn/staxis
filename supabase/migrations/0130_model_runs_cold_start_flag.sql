-- Round 18 (2026-05-15): explicit cold-start flag on model_runs.
--
-- The doctor's ml_models_holdout_size check needs to distinguish
-- cold-start models (which legitimately have no historical-data
-- validation holdout) from trained models with a small holdout
-- (which is the real failure mode). Round 17 keyed off
-- algorithm.startsWith('cold-start') — a naming-convention contract
-- with no schema enforcement. If a future algorithm string lands as
-- 'coldstart-xgboost' or 'bootstrap-cold', the check silently
-- misclassifies it.
--
-- Fix: add an explicit `cold_start` boolean column. Backfill from the
-- existing algorithm string. Future cold-start variants set the flag
-- explicitly on insert. Doctor reads the column, algorithm naming is
-- free.
--
-- Idempotent: `add column if not exists` + backfill is a no-op on
-- re-apply.

alter table public.model_runs
  add column if not exists cold_start boolean not null default false;

-- Backfill from the only cold-start algorithm name currently in use.
-- Safe to extend the OR-list as new cold-start variants appear; this
-- statement runs once on first apply.
update public.model_runs
   set cold_start = true
 where cold_start = false
   and (algorithm like 'cold-start-%' or algorithm like 'cold_start_%');

comment on column public.model_runs.cold_start is
  'True when this model run was bootstrapped from a cohort prior rather '
  'than trained on historical data. The validation_holdout_n column is '
  'NULL for cold-start runs; the doctor''s ml_models_holdout_size check '
  'excludes cold-start rows from the warn-on-small-holdout logic.';

insert into public.applied_migrations (version, description)
values ('0130', 'model_runs.cold_start boolean column + backfill')
on conflict (version) do nothing;
