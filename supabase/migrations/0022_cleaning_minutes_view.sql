-- ═══════════════════════════════════════════════════════════════════════════
-- Staxis / HotelOps AI — Cleaning Minutes View for ML Service (Migration 0022)
--
-- Exposes "minutes worked yesterday" per (property, date) for the Python ML
-- service when computing headcount actuals. This drives Layer 1 training's
-- target variable (total workload in minutes).
--
-- The view aggregates cleaning_events that were NOT discarded or rejected,
-- summing both recorded and approved events. Flagged entries are excluded
-- pending Maria's review decision.
--
-- Used by: ml-service/src/actuals.py when backfilling prediction_log rows
-- after a day's cleaning is complete.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace view cleaning_minutes_per_day_view as
select
  ce.property_id,
  ce.date,
  sum(ce.duration_minutes) filter (where ce.status in ('recorded', 'approved')) as total_recorded_minutes,
  sum(ce.duration_minutes) filter (where ce.status = 'approved') as total_approved_minutes,
  count(*) filter (where ce.status in ('recorded', 'approved', 'flagged')) as n_events
from cleaning_events ce
group by ce.property_id, ce.date;

comment on view cleaning_minutes_per_day_view is 'ML helper: total cleaning minutes worked per (property, date). Aggregates recorded + approved events. Flagged events excluded pending review. Used by ml-service to compute headcount actuals for Layer 1 training.';

-- (No applied_migrations tracker insert — see 0021's note.)
