-- 0075_inventory_prediction_history.sql
-- Insert-only archive of every inventory_rate_predictions write, so we
-- can ask "what did the AI predict on May 5 for Coffee Pods?" and
-- compare against the actual consumption that day.
--
-- Pre-migration, inventory_rate_predictions used (property_id, item_id,
-- predicted_for_date) as a PK with upsert-on-conflict — each day's
-- prediction overwrote the prior write for the same target date. We
-- lost the entire backtest signal: "did the model say 50 last Monday?
-- Was that accurate?"
--
-- Approach: a database trigger that mirrors every INSERT or UPDATE on
-- inventory_rate_predictions into a new history table. The trigger
-- runs after the row commits, so a failed prediction write doesn't get
-- archived as success. The ML service needs no code changes.
--
-- Why a trigger vs application-side: the prediction-write code path
-- exists in multiple places (the ML service, the manual retrain admin
-- route). One trigger guarantees every write lands in history without
-- relying on every caller remembering to dual-write.

create table if not exists public.inventory_rate_prediction_history (
  id uuid primary key default gen_random_uuid(),
  -- Pre-overwrite prediction row id. Useful for joining back to the
  -- "current state" view. Not a FK because the row may have been
  -- overwritten (the same id can survive a row-level upsert).
  source_prediction_id uuid not null,
  property_id uuid not null,
  item_id uuid,
  item_name text,
  predicted_for_date date not null,
  predicted_daily_rate numeric,
  predicted_daily_rate_p10 numeric,
  predicted_daily_rate_p25 numeric,
  predicted_daily_rate_p50 numeric,
  predicted_daily_rate_p75 numeric,
  predicted_daily_rate_p90 numeric,
  predicted_current_stock numeric,
  model_run_id uuid,
  predicted_at timestamptz,
  is_shadow boolean,
  -- When did THIS history row land. Distinct from predicted_at because
  -- a retroactive backfill could write rows with old predicted_at but
  -- a fresh recorded_at.
  recorded_at timestamptz not null default now()
);

comment on table public.inventory_rate_prediction_history is
  'Insert-only archive of every inventory_rate_predictions write. Populated by trigger. Used for AI-accuracy backtests: join against later-observed inventory_counts to compute how close the prediction was. May 2026 audit closed the "no history" gap.';

-- Index for the typical backtest query: per-property + date range.
create index if not exists inventory_rate_prediction_history_property_date_idx
  on public.inventory_rate_prediction_history (property_id, predicted_for_date desc);

-- Index for "all predictions written today" sweeps.
create index if not exists inventory_rate_prediction_history_recorded_at_idx
  on public.inventory_rate_prediction_history (recorded_at desc);

-- RLS deny-all. Backtest analytics run server-side via service_role.
alter table public.inventory_rate_prediction_history enable row level security;

drop policy if exists inventory_rate_prediction_history_deny_browser
  on public.inventory_rate_prediction_history;
create policy inventory_rate_prediction_history_deny_browser
  on public.inventory_rate_prediction_history
  for all
  to anon, authenticated
  using (false)
  with check (false);

-- ─── Trigger ─────────────────────────────────────────────────────────
-- One trigger function that archives both INSERT and UPDATE events on
-- inventory_rate_predictions. UPDATE includes the case "upsert
-- replaced the row" — Postgres's ON CONFLICT DO UPDATE fires UPDATE
-- triggers on the conflicted row.
create or replace function public.archive_inventory_rate_prediction()
returns trigger
language plpgsql
as $$
begin
  insert into public.inventory_rate_prediction_history (
    source_prediction_id,
    property_id,
    item_id,
    item_name,
    predicted_for_date,
    predicted_daily_rate,
    predicted_daily_rate_p10,
    predicted_daily_rate_p25,
    predicted_daily_rate_p50,
    predicted_daily_rate_p75,
    predicted_daily_rate_p90,
    predicted_current_stock,
    model_run_id,
    predicted_at,
    is_shadow
  ) values (
    new.id,
    new.property_id,
    new.item_id,
    new.item_name,
    new.predicted_for_date,
    new.predicted_daily_rate,
    new.predicted_daily_rate_p10,
    new.predicted_daily_rate_p25,
    new.predicted_daily_rate_p50,
    new.predicted_daily_rate_p75,
    new.predicted_daily_rate_p90,
    new.predicted_current_stock,
    new.model_run_id,
    new.predicted_at,
    new.is_shadow
  );
  return new;
end;
$$;

comment on function public.archive_inventory_rate_prediction() is
  'Triggered on every INSERT or UPDATE of inventory_rate_predictions. Copies the new row into inventory_rate_prediction_history. Insert-only archive enables backtests.';

drop trigger if exists inventory_rate_predictions_archive on public.inventory_rate_predictions;
create trigger inventory_rate_predictions_archive
  after insert or update on public.inventory_rate_predictions
  for each row
  execute function public.archive_inventory_rate_prediction();

insert into public.applied_migrations (version, description)
values ('0075', 'inventory_rate_prediction_history: insert-only archive for ML accuracy backtests')
on conflict (version) do nothing;
