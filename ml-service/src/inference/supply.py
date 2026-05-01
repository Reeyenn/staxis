"""Inference pipeline for Layer 2 Supply predictions."""
import json
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Optional

import numpy as np
import pandas as pd

from src.config import get_settings
from src.features.supply_matrix import build_supply_features
from src.supabase_client import get_supabase_client


def _tomorrow_in_property_tz() -> date:
    """Tomorrow as seen by a Houston property (matches demand.py)."""
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo("America/Chicago")
    except Exception:  # pragma: no cover
        tz = timezone(timedelta(hours=-6))
    now_local = datetime.now(timezone.utc).astimezone(tz)
    return (now_local + timedelta(days=1)).date()


def _validate_property_id(property_id: str) -> Optional[str]:
    try:
        uuid.UUID(str(property_id))
        return None
    except (ValueError, AttributeError, TypeError):
        return f"Invalid property_id: not a UUID ({property_id!r})"


def _hydrate_bayesian_from_run(model_run: dict):
    """Reconstruct a BayesianRegression instance from saved posterior_params.

    Returns the model, or None if posterior_params is missing/corrupt.
    """
    from src.layers.bayesian_regression import BayesianRegression

    pp_json = model_run.get("posterior_params")
    if not pp_json:
        return None

    try:
        pp = json.loads(pp_json)
    except Exception as exc:
        print(json.dumps({
            "evt": "supply_posterior_json_invalid",
            "model_run_id": model_run.get("id"), "error": str(exc),
        }))
        return None

    model = BayesianRegression()
    try:
        model.mu_n     = np.array(pp["mu_n"])     if pp.get("mu_n") is not None else None
        model.sigma_n  = np.array(pp["sigma_n"])  if pp.get("sigma_n") is not None else None
        model.alpha_n  = pp.get("alpha_n")
        model.beta_n   = pp.get("beta_n")
        model.mu_0     = np.array(pp["mu_0"])     if pp.get("mu_0") is not None else None
        model.sigma_0  = np.array(pp["sigma_0"])  if pp.get("sigma_0") is not None else None
        model.alpha    = pp.get("alpha", 2.0)
        model.beta     = pp.get("beta", 1.0)
        model.feature_names = pp.get("feature_names")
        return model
    except Exception as exc:
        print(json.dumps({
            "evt": "supply_posterior_hydrate_failed",
            "model_run_id": model_run.get("id"), "error": str(exc),
        }))
        return None


async def predict_supply(
    property_id: str,
    prediction_date: Optional[date] = None,
) -> dict:
    """Predict per-(room × housekeeper) cleaning times for a property.

    Loads the active supply model from `model_runs.posterior_params` (Bayesian)
    or `model_runs.model_blob_path` (XGBoost — not yet implemented). Previously
    this function ignored the trained model entirely and refit a one-row
    "dummy" Bayesian on y=25.0, which made every prediction a flat 25 minutes
    regardless of room or housekeeper.
    """
    err = _validate_property_id(property_id)
    if err:
        return {"error": err, "property_id": property_id, "date": None}

    settings = get_settings()
    client = get_supabase_client()

    if prediction_date is None:
        prediction_date = _tomorrow_in_property_tz()

    # Find active supply model
    active_models = client.fetch_many(
        "model_runs",
        filters={"property_id": property_id, "layer": "supply", "is_active": True},
        limit=1,
    )

    if not active_models:
        return {
            "error": "No active supply model",
            "property_id": property_id,
            "date": str(prediction_date),
        }

    model_run = active_models[0]
    model_run_id = model_run["id"]
    algorithm = model_run.get("algorithm", "bayesian")

    # Hydrate the actual trained model. If we can't, return an explicit error
    # rather than fabricating predictions from a dummy fit.
    model = None
    if algorithm == "bayesian":
        model = _hydrate_bayesian_from_run(model_run)
        if model is None:
            return {
                "error": "Active supply model has no usable posterior_params (retrain needed)",
                "property_id": property_id,
                "date": str(prediction_date),
                "model_version": model_run.get("model_version"),
            }
    elif algorithm == "xgboost-quantile":
        # XGBoost serialization not yet wired up. Fail explicitly so this is
        # visible in the cockpit rather than silently producing flat numbers.
        return {
            "error": "XGBoost supply model deserialization not yet implemented",
            "property_id": property_id,
            "date": str(prediction_date),
            "model_version": model_run.get("model_version"),
        }
    else:
        return {
            "error": f"Unknown supply algorithm: {algorithm}",
            "property_id": property_id,
            "date": str(prediction_date),
        }

    # Fetch schedule for prediction_date (assigned rooms)
    schedule_query = f"""
        select
            s.id as staff_id,
            array_agg(sr.room_number) as assigned_rooms,
            count(sr.room_number) as room_count
        from schedule_assignments sa
        join staff s on s.id = any(sa.crew)
        left join schedule_rooms sr on sr.schedule_assignment_id = sa.id
        where sa.property_id = '{property_id}'
          and sa.date = '{prediction_date}'::date
        group by s.id
    """

    try:
        schedule_data = client.execute_sql(schedule_query)
    except Exception as e:
        return {
            "error": f"Failed to fetch schedule: {e}",
            "property_id": property_id,
            "date": str(prediction_date),
        }

    # Pull tomorrow's day-level features once. Per-room fanout uses these.
    plan_query = f"""
        select
            extract(dow from date)::int as dow,
            case
                when coalesce(total_rooms, 0) > 0
                then round((100.0 * (total_rooms - coalesce(vacant_clean,0) - coalesce(vacant_dirty,0) - coalesce(ooo,0))::numeric / total_rooms)::numeric, 2)
                else 50.0
            end as occupancy_pct
        from plan_snapshots
        where property_id = '{property_id}'
          and date = '{prediction_date}'::date
        order by pulled_at desc
        limit 1
    """
    try:
        plan_rows = client.execute_sql(plan_query)
    except Exception:
        plan_rows = []
    plan = plan_rows[0] if plan_rows else {}
    dow = int(plan.get("dow", prediction_date.weekday()) or prediction_date.weekday())
    occupancy_at_start = int(round(float(plan.get("occupancy_pct", 50.0) or 50.0)))

    # Generate predictions using the trained Bayesian model.
    quantiles = [0.25, 0.5, 0.75, 0.9]
    predictions = []

    # The trained model's feature_names list is the column order we MUST
    # build X with. build_supply_features() aligns one-hot columns
    # (room_<number>, staff_<uuid>) to this list — rooms / staff that
    # weren't seen at training time silently fall to all-zero rows
    # (i.e. the baseline intercept + day/occupancy/type effects).
    saved_feature_names = list(model.feature_names) if model.feature_names else None
    if not saved_feature_names:
        return {
            "error": "Active supply model has no feature_names — retrain needed",
            "property_id": property_id,
            "date": str(prediction_date),
            "model_version": model_run.get("model_version"),
        }

    # Build the full per-(room, staff) context dataframe up front. Doing
    # the fanout in one pass lets us shape-validate ALL predictions against
    # the model's feature_names BEFORE writing anything — previously the
    # per-room loop could fail mid-schedule and leave half the rooms
    # written with the prior model and half with no row at all.
    pair_rows: list[dict] = []
    for sched in schedule_data or []:
        staff_id = sched["staff_id"]
        rooms = sched.get("assigned_rooms", []) or []
        for room_number in rooms:
            pair_rows.append({
                "room_number": room_number,
                "staff_id": staff_id,
                "day_of_week": dow,
                "occupancy_at_start": occupancy_at_start,
                # Tomorrow's per-room type/stayover_day data isn't on the
                # supply input today (the schedule_assignments table only
                # tracks who cleans which room). Fall back to 'stayover'
                # day-1 — the most common case — and let the model's
                # day/occupancy/room-floor signals carry the prediction
                # for now. A future improvement is to look up the actual
                # room_status from plan_snapshots per room.
                "room_type": "stayover",
                "stayover_day": 1,
            })

    if not pair_rows:
        return {
            "property_id": property_id,
            "date": str(prediction_date),
            "predicted_rooms": 0,
            "model_version": model_run.get("model_version"),
        }

    pair_df = pd.DataFrame(pair_rows)

    # Single matrix build → single shape check. If feature_names is
    # incompatible (e.g. an old v1 model is still active and we trained
    # the page expecting v2 columns), this raises and we bail before
    # touching supply_predictions at all.
    try:
        X_all, _ = build_supply_features(
            pair_df, training=False, feature_names=saved_feature_names,
        )
        all_preds = model.predict_quantile(X_all, quantiles)
    except ValueError as exc:
        return {
            "error": f"Supply posterior incompatible with inference features: {exc}",
            "property_id": property_id,
            "date": str(prediction_date),
            "model_version": model_run.get("model_version"),
        }

    # all_preds is a dict { quantile -> ndarray length N }. Pull row-wise.
    for i, row in enumerate(pair_rows):
        # Per-(room, staff) snapshot of the actual feature values that
        # produced this prediction. Useful for debugging "why did room 305
        # get 35 min when room 412 got 22?" — read this column to see the
        # one-hot encodings and base features at predict time.
        features_snapshot = {
            k: (X_all.iloc[i][k] if k in X_all.columns else 0.0)
            for k in saved_feature_names
        }
        predictions.append({
            "room_number": row["room_number"],
            "staff_id": row["staff_id"],
            "predicted_minutes_p25": float(all_preds[0.25][i]),
            "predicted_minutes_p50": float(all_preds[0.5][i]),
            "predicted_minutes_p75": float(all_preds[0.75][i]),
            "predicted_minutes_p90": float(all_preds[0.9][i]),
            "features_snapshot": json.dumps(features_snapshot),
        })

    # Write all predictions
    for pred in predictions:
        pred.update({
            "property_id": property_id,
            "date": str(prediction_date),
            "model_run_id": model_run_id,
            "predicted_at": datetime.utcnow().isoformat(),
        })

        try:
            client.upsert("supply_predictions", pred)
        except Exception as exc:
            print(json.dumps({
                "evt": "supply_prediction_write_failed",
                "room": pred.get("room_number"), "staff_id": pred.get("staff_id"),
                "error": str(exc),
            }))

    return {
        "property_id": property_id,
        "date": str(prediction_date),
        "predicted_rooms": len(predictions),
        "model_version": model_run.get("model_version"),
    }
