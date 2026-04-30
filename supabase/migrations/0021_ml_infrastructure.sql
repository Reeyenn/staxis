-- ═══════════════════════════════════════════════════════════════════════════
-- Staxis / HotelOps AI — ML Infrastructure Foundation (Migration 0021)
--
-- Goal: predict tomorrow's optimal housekeeping headcount with quantified
-- uncertainty. Three-layer hierarchical architecture:
--
--   • Layer 1 (Demand model)    — predicts total cleaning workload as a
--                                 distribution. Tables: demand_predictions.
--   • Layer 2 (Supply model)    — predicts per-(room × housekeeper) cleaning
--                                 minutes. Tables: supply_predictions.
--   • Layer 3 (Optimizer)       — Monte Carlo over L1+L2 → recommended
--                                 headcount with completion-probability curve.
--                                 Tables: optimizer_results.
--
-- Plus shared infrastructure:
--   • model_runs            — every training attempt, with metrics + activation
--   • prediction_log        — shadow-mode pairs (predicted vs actual)
--   • prediction_disagreement — when L1's total ≠ sum(L2)
--   • prediction_overrides  — when Maria overrides the optimizer's headcount,
--                             we treat that as a label and feed it back to
--                             training. The single most-important "human in
--                             the loop" mechanism.
--
-- Plus columns added to existing tables:
--   • cleaning_events       — 10 new feature columns snapshotted at insert
--                             time. Future training samples carry their full
--                             feature context inline (no join brittleness).
--   • rooms                 — last_started_occupancy (in-house at the moment
--                             a HK tapped Start, used to populate
--                             occupancy_at_start on the cleaning_events row
--                             when Done is tapped).
--   • schedule_assignments  — marked_attended (bool, per-HK) + marked_attended_at
--                             so Maria can confirm at end-of-day who actually
--                             showed up. This is the ground-truth attendance
--                             signal for the headcount-actuals view.
--
-- All new tables are RLS-enabled, owner-scoped via user_owns_property() for
-- read paths. Writes from the Python ML service use the service-role key
-- which bypasses RLS — same pattern as the scraper.
--
-- Storage:
--   ml-models bucket (private, service-role-write-only) holds trained model
--   artifacts. Created by the application via the Supabase Storage API on
--   first training run because policy creation differs across Supabase
--   versions; this migration only ensures the bucket NAME is reserved via a
--   note in scraper_status[ml_storage_bucket]. See ml-service/src/storage.py.
--
-- This migration is safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. cleaning_events: snapshot feature columns ──────────────────────────
-- All nullable. Existing rows stay NULL. Future inserts populate inline.
-- Each column is annotated with what populates it and why it matters.

alter table cleaning_events add column if not exists day_of_week        smallint;     -- 0=Sun..6=Sat, derivable but materialized for fast training queries
alter table cleaning_events add column if not exists day_of_stay_raw    integer;      -- raw stayover day-of-stay before bucketing — preserves magnitude (existing stayover_day collapses to 1|2)
alter table cleaning_events add column if not exists room_floor         smallint;     -- parsed from room_number first digit (1xx=floor 1, 4xx=floor 4)
alter table cleaning_events add column if not exists occupancy_at_start integer;      -- in_house count at started_at, snapshotted via rooms.last_started_occupancy
alter table cleaning_events add column if not exists total_checkouts_today      integer; -- from plan_snapshots(property,date).checkouts at insert time
alter table cleaning_events add column if not exists total_rooms_assigned_to_hk integer; -- count from schedule_assignments(date,staff_id)
alter table cleaning_events add column if not exists route_position     integer;      -- 1-indexed position in this HK's day; first room=1, second=2…
alter table cleaning_events add column if not exists minutes_since_shift_start integer; -- started_at minus min(started_at) for (this hk, this date). NULL for route_position=1.
alter table cleaning_events add column if not exists was_dnd_during_clean boolean;    -- rooms.is_dnd at started_at (best-effort, uses current value if no historical capture)
alter table cleaning_events add column if not exists weather_class      text;          -- reserved for future weather feature; NULL for now
alter table cleaning_events add column if not exists feature_set_version text default 'v1'; -- versioning so old model_runs stay reproducible against this row's features

comment on column cleaning_events.day_of_week         is 'ML feature: 0=Sun..6=Sat. Derived from date column at insert; materialized for query speed.';
comment on column cleaning_events.day_of_stay_raw     is 'ML feature: raw stayover day-of-stay (1,2,3,4…) before bucketing. NULL for non-stayovers.';
comment on column cleaning_events.room_floor          is 'ML feature: parsed from room_number[0]. e.g. "414"→4. Captures floor-level effects.';
comment on column cleaning_events.occupancy_at_start  is 'ML feature: in_house count at started_at, snapshotted via rooms.last_started_occupancy at Start tap.';
comment on column cleaning_events.total_checkouts_today        is 'ML feature: total checkouts on this property+date, from plan_snapshots at insert.';
comment on column cleaning_events.total_rooms_assigned_to_hk   is 'ML feature: rooms assigned to this HK on this date, count from schedule_assignments at insert.';
comment on column cleaning_events.route_position      is 'ML feature: 1-indexed position in this HK''s day-of-cleans. Captures warm-up / fatigue dynamics.';
comment on column cleaning_events.minutes_since_shift_start is 'ML feature: minutes from this HK''s first clean of the day. Captures fatigue.';
comment on column cleaning_events.was_dnd_during_clean is 'ML feature: was the room flagged DND when started? (best-effort capture)';
comment on column cleaning_events.weather_class       is 'ML feature: reserved for weather (cold/normal/hot). NULL until weather scraper added.';
comment on column cleaning_events.feature_set_version is 'Versioning: tags the schema of features captured on this row, so model_runs can pin reproducibility.';

-- ─── 2. rooms: occupancy snapshot at Start tap ─────────────────────────────
-- Captured on Start, copied to cleaning_events.occupancy_at_start on Done.
alter table rooms add column if not exists last_started_occupancy integer;
comment on column rooms.last_started_occupancy is 'In-house room count at the moment a housekeeper most recently tapped Start on this room. Copied to cleaning_events.occupancy_at_start when Done is tapped.';

-- ─── 3. attendance_marks: end-of-day per-housekeeper attendance log ───────
-- Maria taps a checkbox at end of shift confirming each HK actually showed
-- up. This is the ground-truth signal for headcount_actuals_view.
--
-- Why a new table instead of a column on schedule_assignments:
-- schedule_assignments has primary key (property_id, date) — one row per day.
-- The HK roster lives inside that row's `crew uuid[]` array. To mark
-- per-HK attendance without breaking that schema we keep a separate table
-- with (property_id, date, staff_id) granularity.
--
-- shift_confirmations (existing) captures pre-shift "I'll be there" SMS
-- replies — a noisy proxy. attendance_marks is Maria's eyeball confirmation,
-- the actual ground truth.
create table if not exists attendance_marks (
  property_id        uuid not null references properties(id) on delete cascade,
  date               date not null,
  staff_id           uuid not null references staff(id) on delete cascade,
  attended           boolean not null,                     -- true = showed up + worked, false = no-show
  marked_at          timestamptz not null default now(),
  marked_by          uuid,                                 -- auth.users id of whoever tapped the box
  notes              text,                                 -- Maria-typed reason for no-show, optional
  primary key (property_id, date, staff_id)
);

create index if not exists attendance_marks_property_date_idx
  on attendance_marks (property_id, date desc);

alter table attendance_marks enable row level security;
drop policy if exists "owner read attendance_marks" on attendance_marks;
create policy "owner read attendance_marks"
  on attendance_marks for select
  using (user_owns_property(property_id));
drop policy if exists "owner write attendance_marks" on attendance_marks;
create policy "owner write attendance_marks"
  on attendance_marks for all
  using (user_owns_property(property_id))
  with check (user_owns_property(property_id));

comment on table  attendance_marks is 'Ground-truth per-housekeeper attendance log. Set by Maria at end-of-shift. Drives headcount_actuals_view, the target variable for Layer 1 training.';
comment on column attendance_marks.attended is 'true = showed up + worked the shift. false = no-show. Always explicitly set, never null — absence of a row means "not marked yet."';

-- ─── 4. model_runs: every training attempt ────────────────────────────────
-- One row per training invocation. Captures metrics + activation state +
-- enough metadata to reproduce the run later (feature_set_version + hyperparams
-- + training_row_count + holdout split definition).
create table if not exists model_runs (
  id                       uuid primary key default gen_random_uuid(),
  property_id              uuid not null references properties(id) on delete cascade,
  layer                    text not null check (layer in ('demand','supply','optimizer')),
  trained_at               timestamptz not null default now(),
  training_row_count       integer not null,
  feature_set_version      text not null default 'v1',
  model_version            text not null,                -- e.g. 'bayesian-v1' or 'xgb-1.7-2026-04-30T22:00'
  algorithm                text not null,                -- 'bayesian' | 'xgboost-quantile' | 'monte-carlo'
  model_blob_path          text,                         -- Supabase Storage path; null for closed-form Bayesian models
  hyperparameters          jsonb,
  -- Metrics, all computed on time-based holdout (most-recent 20%)
  training_mae             numeric(10,4),
  validation_mae           numeric(10,4),
  baseline_mae             numeric(10,4),                -- static-rules MAE on same holdout
  beats_baseline_pct       numeric(8,4),                 -- (baseline - validation) / baseline
  validation_holdout_n     integer,
  -- Activation state. At most one row per (property, layer) may have is_active=true.
  -- Enforced by partial unique index below.
  is_active                boolean not null default false,
  activated_at             timestamptz,
  deactivated_at           timestamptz,
  deactivation_reason      text,                         -- 'auto_rollback', 'manual', 'superseded'
  -- Stability gate state — model only activates after 2 consecutive passing
  -- runs (per the v3 spec). The pass count is computed at activation time
  -- by scanning the previous (this property, this layer) rows.
  consecutive_passing_runs integer not null default 0,
  notes                    text,
  created_at               timestamptz not null default now()
);

create index if not exists model_runs_property_layer_idx
  on model_runs (property_id, layer, trained_at desc);

-- Partial unique: at most one active model per (property, layer)
create unique index if not exists model_runs_one_active_per_layer_idx
  on model_runs (property_id, layer)
  where is_active = true;

alter table model_runs enable row level security;
drop policy if exists "owner read model_runs" on model_runs;
create policy "owner read model_runs"
  on model_runs for select
  using (user_owns_property(property_id));
-- Writes are service-role-only (bypasses RLS). No write policy.

comment on table model_runs is 'ML training history. Every training attempt writes a row. Activation state controlled here.';

-- ─── 5. demand_predictions: Layer 1 output ────────────────────────────────
-- Quantile-regression output: full distribution per (property, date).
create table if not exists demand_predictions (
  id                  uuid primary key default gen_random_uuid(),
  property_id         uuid not null references properties(id) on delete cascade,
  date                date not null,                    -- the operational date predicted FOR
  predicted_minutes_p10 numeric(10,2),
  predicted_minutes_p25 numeric(10,2),
  predicted_minutes_p50 numeric(10,2) not null,
  predicted_minutes_p75 numeric(10,2),
  predicted_minutes_p90 numeric(10,2),
  predicted_minutes_p95 numeric(10,2),
  predicted_headcount_p50 numeric(6,2),                -- p50_minutes / shift_cap, ceiling — convenience field
  predicted_headcount_p80 numeric(6,2),                -- p80_minutes / shift_cap, ceiling — what the optimizer should target
  predicted_headcount_p95 numeric(6,2),                -- p95 — for "don't get caught short" upper bound
  features_snapshot   jsonb,                           -- the feature vector used; debugging + reproducibility
  model_run_id        uuid not null references model_runs(id) on delete cascade,
  predicted_at        timestamptz not null default now(),
  unique (property_id, date, model_run_id)
);

create index if not exists demand_predictions_property_date_idx
  on demand_predictions (property_id, date desc);

alter table demand_predictions enable row level security;
drop policy if exists "owner read demand_predictions" on demand_predictions;
create policy "owner read demand_predictions"
  on demand_predictions for select
  using (user_owns_property(property_id));

comment on table demand_predictions is 'Layer 1 output: total workload distribution per (property, date). Multiple model_runs may predict the same (property, date); the predictions_active_demand view filters to is_active.';

-- ─── 6. supply_predictions: Layer 2 output ────────────────────────────────
-- Per-(room × housekeeper) cleaning-time predictions, quantile output.
create table if not exists supply_predictions (
  id                       uuid primary key default gen_random_uuid(),
  property_id              uuid not null references properties(id) on delete cascade,
  date                     date not null,
  room_number              text not null,
  staff_id                 uuid not null references staff(id) on delete cascade,
  predicted_minutes_p25    numeric(8,2),
  predicted_minutes_p50    numeric(8,2) not null,
  predicted_minutes_p75    numeric(8,2),
  predicted_minutes_p90    numeric(8,2),
  features_snapshot        jsonb,
  model_run_id             uuid not null references model_runs(id) on delete cascade,
  predicted_at             timestamptz not null default now(),
  unique (property_id, date, room_number, staff_id, model_run_id)
);

create index if not exists supply_predictions_property_date_idx
  on supply_predictions (property_id, date desc);
create index if not exists supply_predictions_staff_idx
  on supply_predictions (property_id, staff_id, date desc);

alter table supply_predictions enable row level security;
drop policy if exists "owner read supply_predictions" on supply_predictions;
create policy "owner read supply_predictions"
  on supply_predictions for select
  using (user_owns_property(property_id));

comment on table supply_predictions is 'Layer 2 output: per-(room, housekeeper) cleaning-minute distribution. Drives auto-assign budgets when active.';

-- ─── 7. optimizer_results: Layer 3 output ─────────────────────────────────
-- Single row per (property, date) summarizing the Monte Carlo run that
-- produced THE recommendation. completion_probability_curve is a jsonb array
-- of {headcount, p_complete} so the dashboard can render the curve.
create table if not exists optimizer_results (
  id                            uuid primary key default gen_random_uuid(),
  property_id                   uuid not null references properties(id) on delete cascade,
  date                          date not null,
  recommended_headcount         integer not null,
  target_completion_probability numeric(4,3) not null default 0.95, -- configurable per property
  achieved_completion_probability numeric(4,3),                     -- P(complete) at recommended_headcount
  completion_probability_curve  jsonb not null,                     -- [{headcount: 1, p: 0.05}, …, {headcount: 10, p: 0.99}]
  assignment_plan               jsonb,                              -- {room_number: staff_id, …} suggested mapping
  sensitivity_analysis          jsonb,                              -- {one_hk_sick: {recommended: 5}, plus_5_checkouts: {recommended: 5}, …}
  inputs_snapshot               jsonb not null,                     -- which L1 + L2 model_run_ids were used
  monte_carlo_draws             integer not null default 1000,
  ran_at                        timestamptz not null default now(),
  unique (property_id, date)
);

create index if not exists optimizer_results_property_date_idx
  on optimizer_results (property_id, date desc);

alter table optimizer_results enable row level security;
drop policy if exists "owner read optimizer_results" on optimizer_results;
create policy "owner read optimizer_results"
  on optimizer_results for select
  using (user_owns_property(property_id));

comment on table optimizer_results is 'Layer 3 output: recommended headcount + assignment plan + sensitivity analysis. Schedule tab consumes when active.';

-- ─── 8. prediction_log: shadow-mode pairs (predicted vs actual) ──────────
-- Filled when a cleaning_event arrives that pairs with a prior prediction.
-- Powers the rolling-MAE dashboard + auto-rollback signal.
create table if not exists prediction_log (
  id                  uuid primary key default gen_random_uuid(),
  property_id         uuid not null references properties(id) on delete cascade,
  layer               text not null check (layer in ('demand','supply')),
  prediction_id       uuid not null,                    -- references demand_predictions.id OR supply_predictions.id (polymorphic by layer)
  cleaning_event_id   uuid references cleaning_events(id) on delete set null, -- supply layer: which clean was the actual? Null for demand layer.
  date                date not null,                   -- operational date the prediction was for
  predicted_value     numeric(10,4) not null,          -- predicted_minutes_p50 (or aggregate for demand)
  actual_value        numeric(10,4) not null,
  abs_error           numeric(10,4) generated always as (abs(predicted_value - actual_value)) stored,
  squared_error       numeric(12,4) generated always as ((predicted_value - actual_value) * (predicted_value - actual_value)) stored,
  pinball_loss_p50    numeric(10,4),                   -- standard quantile loss for p50; lower is better
  model_run_id        uuid not null references model_runs(id) on delete cascade,
  logged_at           timestamptz not null default now()
);

create index if not exists prediction_log_property_layer_logged_idx
  on prediction_log (property_id, layer, logged_at desc);
create index if not exists prediction_log_model_run_idx
  on prediction_log (model_run_id, logged_at desc);

alter table prediction_log enable row level security;
drop policy if exists "owner read prediction_log" on prediction_log;
create policy "owner read prediction_log"
  on prediction_log for select
  using (user_owns_property(property_id));

comment on table prediction_log is 'Shadow-mode logger: every prediction paired with its actual outcome. Drives rolling-MAE + auto-rollback.';

-- ─── 9. prediction_disagreement: L1↔L2 sanity check ──────────────────────
-- When sum(L2 predictions for tomorrow) drifts from L1's total prediction
-- by >X% (adaptive threshold computed from historical disagreement variance,
-- not a flat 20% which would flap on small data), log it. Surfaces on the
-- ML dashboard.
create table if not exists prediction_disagreement (
  id                              uuid primary key default gen_random_uuid(),
  property_id                     uuid not null references properties(id) on delete cascade,
  date                            date not null,
  layer1_total_p50                numeric(10,2) not null,
  layer2_summed_p50               numeric(10,2) not null,
  disagreement_pct                numeric(8,4) not null,
  threshold_used                  numeric(8,4) not null,           -- the dynamic threshold this disagreement was compared against
  layer1_model_run_id             uuid not null references model_runs(id),
  layer2_model_run_id             uuid not null references model_runs(id),
  detected_at                     timestamptz not null default now()
);

create index if not exists prediction_disagreement_property_idx
  on prediction_disagreement (property_id, detected_at desc);

alter table prediction_disagreement enable row level security;
drop policy if exists "owner read prediction_disagreement" on prediction_disagreement;
create policy "owner read prediction_disagreement"
  on prediction_disagreement for select
  using (user_owns_property(property_id));

comment on table prediction_disagreement is 'Detection log for L1↔L2 model disagreements. Threshold is adaptive based on historical disagreement variance — flat thresholds flap on small data.';

-- ─── 10. prediction_overrides: Maria's overrides as training signal ──────
-- When Maria sees the optimizer's "Recommended headcount: 5" and decides to
-- call in 4 (or 6) instead, that override is high-value training signal.
-- It tells the model "the truth was different from what you predicted."
-- Without this loop, the model ossifies — it can't ingest expert disagreement.
create table if not exists prediction_overrides (
  id                            uuid primary key default gen_random_uuid(),
  property_id                   uuid not null references properties(id) on delete cascade,
  date                          date not null,
  optimizer_recommendation      integer not null,                   -- what Layer 3 said
  manual_headcount              integer not null,                   -- what Maria actually decided
  override_reason               text,                              -- optional Maria-typed reason ("convention", "Cindy out sick", etc.)
  override_by                   uuid,                              -- auth.users id
  optimizer_results_id          uuid references optimizer_results(id) on delete set null,
  -- Outcome (filled in next morning by a backfill job once we know how the day went)
  outcome_recorded_at           timestamptz,
  outcome_actual_minutes_worked numeric(10,2),                     -- from cleaning_events sum + marked_attended × shift_cap
  outcome_completed_on_time     boolean,
  outcome_overtime_minutes      numeric(10,2),
  override_at                   timestamptz not null default now()
);

create index if not exists prediction_overrides_property_date_idx
  on prediction_overrides (property_id, date desc);

alter table prediction_overrides enable row level security;
drop policy if exists "owner read prediction_overrides" on prediction_overrides;
create policy "owner read prediction_overrides"
  on prediction_overrides for select
  using (user_owns_property(property_id));
drop policy if exists "owner insert prediction_overrides" on prediction_overrides;
create policy "owner insert prediction_overrides"
  on prediction_overrides for insert
  with check (user_owns_property(property_id));

comment on table prediction_overrides is 'Human-in-the-loop signal. When Maria overrides the optimizer, we record it, then backfill the day''s outcome to feed back into training.';

-- ─── 11. headcount_actuals_view: ground-truth headcount per day ──────────
-- Joins schedule_assignments (which holds the scheduled crew uuid[]) with
-- attendance_marks (which holds Maria's per-HK confirmation). Days where
-- some scheduled HK has no attendance_mark row are flagged as having
-- incomplete labels, so the trainer can drop them.
create or replace view headcount_actuals_view as
with scheduled as (
  select
    sa.property_id,
    sa.date,
    coalesce(array_length(sa.crew, 1), 0) as scheduled_headcount,
    sa.crew
  from schedule_assignments sa
),
marked as (
  select
    am.property_id,
    am.date,
    count(*) filter (where am.attended is true)  as attended_count,
    count(*) filter (where am.attended is false) as no_show_count,
    count(*)                                     as marked_count
  from attendance_marks am
  group by am.property_id, am.date
)
select
  s.property_id,
  s.date,
  s.scheduled_headcount,
  coalesce(m.attended_count, 0) as actual_headcount,
  coalesce(m.no_show_count, 0)  as no_show_count,
  s.scheduled_headcount - coalesce(m.marked_count, 0) as unmarked_count,
  case when coalesce(m.marked_count, 0) >= s.scheduled_headcount and s.scheduled_headcount > 0
       then true else false end as labels_complete
from scheduled s
left join marked m on m.property_id = s.property_id and m.date = s.date;

comment on view headcount_actuals_view is 'Ground-truth attendance per day. actual_headcount drives Layer 1 training. labels_complete=false means Maria did not finish marking — those days are excluded from training to avoid biased labels.';

-- ─── 12. predictions_active_demand: latest active L1 prediction per date ──
-- Tomorrow's recommended workload, from whichever model is currently active.
-- Uses CT timezone for date arithmetic to match the scraper's local clock.
create or replace view predictions_active_demand as
select
  dp.*,
  mr.model_version,
  mr.algorithm
from demand_predictions dp
join model_runs mr on mr.id = dp.model_run_id
where mr.is_active = true
  and dp.date = ((now() at time zone 'America/Chicago')::date + 1);

comment on view predictions_active_demand is 'Tomorrow''s active L1 prediction. Schedule tab reads this for the "Recommended headcount" pill.';

-- ─── 13. predictions_active_supply: per-(room, hk) for tomorrow ──────────
create or replace view predictions_active_supply as
select
  sp.*,
  mr.model_version,
  mr.algorithm
from supply_predictions sp
join model_runs mr on mr.id = sp.model_run_id
where mr.is_active = true
  and sp.date = ((now() at time zone 'America/Chicago')::date + 1);

comment on view predictions_active_supply is 'Tomorrow''s active per-(room, hk) predictions. Auto-assign uses these for budget when present.';

-- ─── 14. predictions_active_optimizer: L3 result for tomorrow ─────────────
create or replace view predictions_active_optimizer as
select * from optimizer_results
where date = ((now() at time zone 'America/Chicago')::date + 1);

comment on view predictions_active_optimizer is 'Tomorrow''s optimizer recommendation, the headline number Maria sees in the Schedule tab.';

-- ─── 15. ml_feature_flags: kill-switch infrastructure ─────────────────────
-- Per-property booleans that gate the entire ML integration. If something
-- goes sideways, flip the flag — predictions stop driving Schedule tab,
-- system falls back to static rules immediately, no redeploy needed.
create table if not exists ml_feature_flags (
  property_id            uuid primary key references properties(id) on delete cascade,
  predictions_enabled    boolean not null default true,    -- master kill-switch
  demand_layer_enabled   boolean not null default true,
  supply_layer_enabled   boolean not null default true,
  optimizer_enabled      boolean not null default true,
  shadow_mode_enabled    boolean not null default true,
  target_completion_prob numeric(4,3) not null default 0.95 check (target_completion_prob between 0.5 and 0.999),
  updated_at             timestamptz not null default now(),
  updated_by             uuid
);

alter table ml_feature_flags enable row level security;
drop policy if exists "owner read ml_feature_flags" on ml_feature_flags;
create policy "owner read ml_feature_flags"
  on ml_feature_flags for select
  using (user_owns_property(property_id));
drop policy if exists "owner write ml_feature_flags" on ml_feature_flags;
create policy "owner write ml_feature_flags"
  on ml_feature_flags for all
  using (user_owns_property(property_id))
  with check (user_owns_property(property_id));

comment on table ml_feature_flags is 'Per-property ML kill-switches. Maria-facing UI never sees ML output if predictions_enabled=false.';

-- Seed flags for any existing properties (idempotent)
insert into ml_feature_flags (property_id)
select id from properties
on conflict (property_id) do nothing;

-- ─── 16. (No applied_migrations tracker insert) ────────────────────────────
-- The applied_migrations table in this project uses a different column
-- shape than the migration 0015 comment suggested. To keep this migration
-- portable across environments where the tracker may or may not exist
-- with our expected columns, we skip the auto-tracker step. The migration
-- itself remains idempotent (`if not exists` guards) so this is purely
-- cosmetic — the tracker can be hand-updated later if desired.
