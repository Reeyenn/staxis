-- ═══════════════════════════════════════════════════════════════════════════
-- ML Post-Review Fixes: add posterior_params, stayover_day, model blob support
-- ═══════════════════════════════════════════════════════════════════════════

-- Add posterior_params column to model_runs for Bayesian posterior persistence
alter table model_runs
  add column if not exists posterior_params jsonb;

comment on column model_runs.posterior_params is
  'Bayesian posterior parameters (mu_n, sigma_n, alpha_n, beta_n) serialized as JSON. '
  'Used by inference to load trained posterior without re-fitting dummy data.';

-- Add stayover_day column to rooms table (tracks which day of stay for a guest)
alter table rooms
  add column if not exists stayover_day integer;

comment on column rooms.stayover_day is
  'Day of stay for guest in this room (1 = first night, 2+ = subsequent nights). '
  'Used to differentiate cleaning types (light vs full clean).';

-- Add model_blob_path column for XGBoost serialized models stored in Supabase Storage
alter table model_runs
  add column if not exists model_blob_path text;

comment on column model_runs.model_blob_path is
  'Path in Supabase Storage to serialized XGBoost model blob (e.g., '
  '"ml-models/property-abc123/demand/model_20260430_123456.pkl"). '
  'Used by inference to download and deserialize XGBoost models.';
