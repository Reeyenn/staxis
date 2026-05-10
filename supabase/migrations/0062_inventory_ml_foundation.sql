-- ═══════════════════════════════════════════════════════════════════════════
-- Staxis / HotelOps AI — Inventory ML Foundation (Migration 0062)
--
-- Goal: extend the existing ML infrastructure (originally built for housekeeping
-- demand/supply prediction in 0021) to learn per-(property × item) inventory
-- usage rates. This is the foundation slice — schema only, no business logic
-- changes. The Python ml-service and the inventory cockpit panels are added in
-- the same release, but each is independent of the others.
--
-- Architecture: same Bayesian-then-XGBoost pattern as housekeeping. Per-item
-- model_runs rows. Cohort priors at 50+ hotels. Network XGBoost at 300+.
--
-- Manager-visible behavior changes (per Reeyen's spec):
--   - Reorder list silently uses learned daily rates instead of hand-typed rates.
--   - Anomaly alerts fire when observed rate diverges from prediction.
--   - Count Mode auto-fills the count input ONCE the per-item model has
--     graduated (≥30 events + MAE/mean<0.10 + 5 consecutive passing runs).
--   - A "AI Helper" chip on the inventory page opens a plain-English explainer
--     page with a 3-mode toggle (off / auto / always-on).
--
-- All new tables are RLS-enabled, owner-scoped via user_owns_property().
-- Writes from the Python ML service use the service-role key (bypass RLS).
--
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. model_runs.layer enum: add 'inventory_rate' ────────────────────────
-- Existing constraint allowed only ('demand','supply','optimizer'). Drop and
-- re-add with the new value. Existing rows are unchanged.
alter table model_runs drop constraint if exists model_runs_layer_check;
alter table model_runs add constraint model_runs_layer_check
  check (layer in ('demand','supply','optimizer','inventory_rate'));

-- ─── 1a. model_runs: per-item auto-fill graduation flag ────────────────────
-- Set true by the training pipeline when an inventory_rate model passes ALL
-- three graduation gates (30+ events for that item, MAE/mean < 0.10, and
-- 5 consecutive passing runs). The inventory page reads this flag to decide
-- whether to pre-fill the count input. Reset to false on auto-rollback.
alter table model_runs add column if not exists auto_fill_enabled boolean not null default false;
alter table model_runs add column if not exists auto_fill_enabled_at timestamptz;

comment on column model_runs.auto_fill_enabled is
  'Inventory rate models only: true when the per-item model has earned enough accuracy to safely pre-fill the count input in Count Mode. Set by training when 3 gates pass; reset on auto-rollback. False for housekeeping-layer rows (n/a).';
comment on column model_runs.auto_fill_enabled_at is
  'Timestamp when auto_fill_enabled most recently flipped to true.';

-- ─── 1b. model_runs: optional item_id for inventory_rate rows ──────────────
-- Inventory_rate models are per-(property × item), so we need an item pointer
-- to disambiguate. Housekeeping layers leave this NULL.
alter table model_runs add column if not exists item_id uuid;

comment on column model_runs.item_id is
  'Inventory rate models only: the inventory.id this model was trained for. NULL for housekeeping layers (demand/supply/optimizer).';

-- The 0021 partial unique index `model_runs_one_active_per_layer_idx` enforces
-- "one active row per (property, layer)" — fine for housekeeping (one model
-- per layer) but wrong for inventory_rate (one model per ITEM). Drop and
-- recreate as two scoped indexes: one for housekeeping layers (unchanged
-- semantics) and one for inventory_rate keyed on (property_id, item_id).
drop index if exists model_runs_one_active_per_layer_idx;

create unique index if not exists model_runs_active_housekeeping_uq
  on model_runs (property_id, layer)
  where is_active and layer in ('demand','supply','optimizer');

create unique index if not exists model_runs_active_inventory_uq
  on model_runs (property_id, item_id)
  where is_active and layer = 'inventory_rate';

-- ─── 1c. properties: inventory AI mode + cohort metadata ───────────────────
alter table properties add column if not exists inventory_ai_mode text not null default 'auto'
  check (inventory_ai_mode in ('off','auto','always-on'));
alter table properties add column if not exists brand text;
alter table properties add column if not exists region text;
alter table properties add column if not exists climate_zone text;
alter table properties add column if not exists size_tier text;

comment on column properties.inventory_ai_mode is
  'Manager-facing AI Helper toggle. Three modes: off (no AI), auto (default — silently use predictions; auto-fill per item once it graduates), always-on (auto-fill any item with a prediction, regardless of graduation gates). Stored at the property level, not per item.';
comment on column properties.brand is
  'Hotel brand for cohort-prior aggregation. Examples: "Comfort Suites", "Hampton Inn", "Holiday Inn Express". NULL until set during onboarding.';
comment on column properties.region is
  'US Census region for cohort priors: Northeast, Midwest, South, West. NULL until set.';
comment on column properties.climate_zone is
  'IECC climate zone (1A..8). Reserved for future cohort-prior refinement.';
comment on column properties.size_tier is
  'Property size bucket for cohort priors: small (<60 rooms), medium (60-120), large (120+). Computed from total_rooms.';

-- Backfill the existing Comfort Suites property so cohort math works on day 1.
update properties
   set brand = coalesce(brand, 'Comfort Suites'),
       region = coalesce(region, 'South'),
       size_tier = coalesce(size_tier,
         case when total_rooms < 60 then 'small'
              when total_rooms < 120 then 'medium'
              else 'large' end)
 where brand is null or region is null or size_tier is null;

-- ─── 2. prediction_log.layer enum: add 'inventory_rate' ────────────────────
alter table prediction_log drop constraint if exists prediction_log_layer_check;
alter table prediction_log add constraint prediction_log_layer_check
  check (layer in ('demand','supply','inventory_rate'));

-- prediction_log.cleaning_event_id is nullable already, fine for inventory rows.
-- Add an inventory_count_id pointer for inventory_rate prediction-actual pairs.
alter table prediction_log add column if not exists inventory_count_id uuid
  references inventory_counts(id) on delete set null;

comment on column prediction_log.inventory_count_id is
  'Inventory rate layer only: the inventory_counts row that supplied the actual_value for this prediction. NULL for housekeeping layers.';

-- ─── 3. inventory_rate_predictions ─────────────────────────────────────────
-- One row per (property, item, predicted_for_date). Written by the nightly
-- inference cron. Read by the inventory page (reorder list + Count Mode
-- auto-fill) and by the cockpit's Today's Predictions panel.
create table if not exists inventory_rate_predictions (
  id                          uuid primary key default gen_random_uuid(),
  property_id                 uuid not null references properties(id) on delete cascade,
  item_id                     uuid not null references inventory(id) on delete cascade,
  item_name                   text not null,                     -- snapshotted to survive item delete
  predicted_for_date          date not null,                     -- the operational date this predicts FOR
  predicted_daily_rate        numeric(12,4) not null,            -- units consumed per day (point estimate = p50)
  predicted_daily_rate_p10    numeric(12,4),
  predicted_daily_rate_p25    numeric(12,4),
  predicted_daily_rate_p50    numeric(12,4),
  predicted_daily_rate_p75    numeric(12,4),
  predicted_daily_rate_p90    numeric(12,4),
  predicted_current_stock     numeric(12,4),                     -- last_counted + orders − discards − rate × days_since_count; pulled by Count Mode for auto-fill
  model_run_id                uuid not null references model_runs(id) on delete cascade,
  predicted_at                timestamptz not null default now()
);

create index if not exists inventory_rate_predictions_property_item_idx
  on inventory_rate_predictions (property_id, item_id, predicted_for_date desc);
create index if not exists inventory_rate_predictions_property_date_idx
  on inventory_rate_predictions (property_id, predicted_for_date desc);
create index if not exists inventory_rate_predictions_model_run_idx
  on inventory_rate_predictions (model_run_id);

alter table inventory_rate_predictions enable row level security;
drop policy if exists "owner read inventory_rate_predictions" on inventory_rate_predictions;
create policy "owner read inventory_rate_predictions"
  on inventory_rate_predictions for select
  using (user_owns_property(property_id));

comment on table inventory_rate_predictions is
  'Per-(property × item) daily rate forecast, written nightly by the inference cron. Powers the reorder list, Count Mode auto-fill, and the cockpit Todays Predictions panel.';

-- ─── 4. inventory_rate_priors ──────────────────────────────────────────────
-- Cohort + global priors used as mu_0 (prior mean) when training a per-item
-- Bayesian model. Aggregated nightly across all hotels in the same cohort.
-- The 'global' cohort_key is the fallback when no cohort match exists.
create table if not exists inventory_rate_priors (
  id                              uuid primary key default gen_random_uuid(),
  cohort_key                      text not null,                  -- 'global' or '<brand>-<region>-<size_tier>'
  item_canonical_name             text not null,                  -- e.g. 'shampoo', 'towel-bath'
  prior_rate_per_room_per_day     numeric(10,4) not null,
  n_hotels_contributing           integer not null default 0,
  prior_strength                  numeric(6,2) not null default 1.0,    -- higher = stronger prior, suppresses noisy data
  source                          text not null default 'industry-benchmark', -- 'industry-benchmark' | 'cohort-aggregate'
  updated_at                      timestamptz not null default now(),
  unique (cohort_key, item_canonical_name)
);

create index if not exists inventory_rate_priors_cohort_idx
  on inventory_rate_priors (cohort_key, item_canonical_name);

alter table inventory_rate_priors enable row level security;
-- Priors are network-wide aggregates with no per-property data; readable by
-- any authenticated user. Writes only by service-role (the nightly cron).
drop policy if exists "auth read inventory_rate_priors" on inventory_rate_priors;
create policy "auth read inventory_rate_priors"
  on inventory_rate_priors for select
  to authenticated
  using (true);

comment on table inventory_rate_priors is
  'Cohort + global priors for inventory rate models. Used as Bayesian mu_0 to give cold-start hotels day-1 accuracy. Refreshed nightly by aggregating inventory_counts across hotels in the same brand-region-size_tier cohort.';

-- Seed industry-benchmark priors for ~20 common hotel inventory items.
-- Rates are units consumed per occupied room per day, based on hospitality
-- industry averages. These will get refined by cohort aggregation as more
-- hotels onboard.
insert into inventory_rate_priors (cohort_key, item_canonical_name, prior_rate_per_room_per_day, n_hotels_contributing, prior_strength, source)
values
  ('global', 'shampoo',                0.40, 0, 1.0, 'industry-benchmark'),
  ('global', 'conditioner',            0.35, 0, 1.0, 'industry-benchmark'),
  ('global', 'body wash',              0.40, 0, 1.0, 'industry-benchmark'),
  ('global', 'soap',                   0.30, 0, 1.0, 'industry-benchmark'),
  ('global', 'lotion',                 0.20, 0, 1.0, 'industry-benchmark'),
  ('global', 'towel bath',             1.00, 0, 1.0, 'industry-benchmark'),
  ('global', 'towel hand',             1.00, 0, 1.0, 'industry-benchmark'),
  ('global', 'towel wash',             1.50, 0, 1.0, 'industry-benchmark'),
  ('global', 'toilet paper',           0.80, 0, 1.0, 'industry-benchmark'),
  ('global', 'tissues',                0.30, 0, 1.0, 'industry-benchmark'),
  ('global', 'coffee pod',             1.50, 0, 1.0, 'industry-benchmark'),
  ('global', 'sugar packet',           1.00, 0, 1.0, 'industry-benchmark'),
  ('global', 'creamer',                1.50, 0, 1.0, 'industry-benchmark'),
  ('global', 'sheet king',             0.50, 0, 1.0, 'industry-benchmark'),
  ('global', 'sheet queen',            0.50, 0, 1.0, 'industry-benchmark'),
  ('global', 'sheet twin',             0.50, 0, 1.0, 'industry-benchmark'),
  ('global', 'pillowcase',             1.00, 0, 1.0, 'industry-benchmark'),
  ('global', 'blanket',                0.10, 0, 1.0, 'industry-benchmark'),
  ('global', 'garbage bag',            1.20, 0, 1.0, 'industry-benchmark'),
  ('global', 'all-purpose cleaner',    0.05, 0, 1.0, 'industry-benchmark')
on conflict (cohort_key, item_canonical_name) do nothing;

-- ─── 5. ml_feature_flags: inventory layer kill-switch ──────────────────────
alter table ml_feature_flags add column if not exists inventory_layer_enabled boolean not null default true;

comment on column ml_feature_flags.inventory_layer_enabled is
  'Kill-switch for the inventory-rate ML layer. When false, training and inference are skipped and the inventory page falls back to manager-typed rates.';

-- ─── 6. item_canonical_name_view ───────────────────────────────────────────
-- Maps inventory.name to a canonical name used for cohort-prior matching.
-- v1 is a simple lookup table — lowercased word stems. Hotels naming items
-- weirdly (e.g. "Body Wash 30ml Pump Bottle Marriott") fall through to the
-- 'global' cohort_key with a generic prior. Future migrations can refine
-- the mapping (Levenshtein, embeddings, etc.).
create or replace view item_canonical_name_view as
select
  inv.id                                                   as item_id,
  inv.property_id                                          as property_id,
  inv.name                                                 as item_name,
  case
    when lower(inv.name) like '%shampoo%'                              then 'shampoo'
    when lower(inv.name) like '%conditioner%'                          then 'conditioner'
    when lower(inv.name) like '%body wash%' or lower(inv.name) like '%bodywash%' then 'body wash'
    when lower(inv.name) like '%soap%' and lower(inv.name) not like '%dispenser%' then 'soap'
    when lower(inv.name) like '%lotion%'                               then 'lotion'
    when lower(inv.name) like '%bath%towel%' or lower(inv.name) like '%towel%bath%' then 'towel bath'
    when lower(inv.name) like '%hand%towel%' or lower(inv.name) like '%towel%hand%' then 'towel hand'
    when lower(inv.name) like '%wash%cloth%' or lower(inv.name) like '%washcloth%' or lower(inv.name) like '%towel%wash%' then 'towel wash'
    when lower(inv.name) like '%toilet%paper%' or lower(inv.name) like '%tp %' or lower(inv.name) = 'tp' then 'toilet paper'
    when lower(inv.name) like '%tissue%' or lower(inv.name) like '%kleenex%' then 'tissues'
    when lower(inv.name) like '%coffee%pod%' or lower(inv.name) like '%k-cup%' or lower(inv.name) like '%coffee%cup%' then 'coffee pod'
    when lower(inv.name) like '%sugar%'                                then 'sugar packet'
    when lower(inv.name) like '%creamer%' or lower(inv.name) like '%cream%coffee%' then 'creamer'
    when lower(inv.name) like '%sheet%king%' or lower(inv.name) like '%king%sheet%' then 'sheet king'
    when lower(inv.name) like '%sheet%queen%' or lower(inv.name) like '%queen%sheet%' then 'sheet queen'
    when lower(inv.name) like '%sheet%twin%' or lower(inv.name) like '%twin%sheet%' then 'sheet twin'
    when lower(inv.name) like '%pillowcase%' or lower(inv.name) like '%pillow%case%' then 'pillowcase'
    when lower(inv.name) like '%blanket%'                              then 'blanket'
    when lower(inv.name) like '%garbage%bag%' or lower(inv.name) like '%trash%bag%' or lower(inv.name) like '%bin%liner%' then 'garbage bag'
    when lower(inv.name) like '%cleaner%' or lower(inv.name) like '%multi%surface%' or lower(inv.name) like '%all%purpose%' then 'all-purpose cleaner'
    else 'unknown'
  end                                                      as item_canonical_name
from inventory inv;

comment on view item_canonical_name_view is
  'Maps inventory.name to a canonical key used for cohort-prior lookup. v1 uses a hand-crafted CASE expression. Items not matched fall through to canonical name "unknown" and use the global default prior.';

-- ─── 7. (No applied_migrations tracker insert) ─────────────────────────────
-- 0021 noted that the applied_migrations table shape differs across envs;
-- we skip the auto-tracker step here for the same reason. Migration name
-- documented in commit message instead.

-- ─── 8. PostgREST schema reload ────────────────────────────────────────────
-- Force the API to pick up the new columns and tables immediately.
notify pgrst, 'reload schema';
