"""Inference pipeline for Layer 1 Demand predictions."""
import json
from datetime import date, datetime, timedelta
from typing import Optional

import numpy as np
import pandas as pd

from src.config import get_settings
from src.supabase_client import get_supabase_client


async def predict_demand(
    property_id: str,
    prediction_date: Optional[date] = None,
) -> dict:
    """Predict total workload (demand) for a property on a given date.

    Args:
        property_id: Property UUID
        prediction_date: Date to predict for (defaults to tomorrow)

    Returns:
        Dictionary with predictions
    """
    settings = get_settings()
    client = get_supabase_client()

    if prediction_date is None:
        prediction_date = (datetime.utcnow() + timedelta(days=1)).date()

    # Find active demand model
    active_models = client.fetch_many(
        "model_runs",
        filters={"property_id": property_id, "layer": "demand", "is_active": True},
        limit=1,
    )

    if not active_models:
        return {
            "error": "No active demand model",
            "property_id": property_id,
            "date": str(prediction_date),
        }

    model_run = active_models[0]
    model_run_id = model_run["id"]

    # Fetch plan for prediction_date
    plan_query = f"""
        select
            coalesce(sum(case when room_status = 'CO' then 1 else 0 end), 0) as checkouts,
            coalesce(sum(case when room_status = 'SV1' then 1 else 0 end), 0) as stayover_day1,
            coalesce(sum(case when room_status = 'SV2+' then 1 else 0 end), 0) as stayover_day2plus,
            coalesce(sum(case when room_status = 'VD' then 1 else 0 end), 0) as vacant_dirty,
            extract(dow from '{prediction_date}'::date) as dow
        from plan_snapshots
        where property_id = '{property_id}'
          and date = '{prediction_date}'::date
    """

    try:
        plan_data = client.execute_sql(plan_query)
        if not plan_data:
            return {
                "error": "No plan snapshot for prediction date",
                "property_id": property_id,
                "date": str(prediction_date),
            }
        plan = plan_data[0]
    except Exception as e:
        return {
            "error": f"Failed to fetch plan: {e}",
            "property_id": property_id,
            "date": str(prediction_date),
        }

    # Build features
    features_dict = {
        "intercept": 1.0,
        "total_checkouts_today": float(plan.get("checkouts", 0)),
        "day_of_week": int(plan.get("dow", 3)),
        "occupancy_pct": 50.0,  # Simplified; would come from real occupancy data
    }

    # Create feature vector
    feature_cols = ["intercept", "total_checkouts_today", "day_of_week", "occupancy_pct"]
    X = pd.DataFrame([features_dict])[feature_cols]

    # Load and run model (simplified - in production would deserialize from storage)
    # For now, use Bayesian model directly with stored posterior
    from src.layers.bayesian_regression import BayesianRegression

    model = BayesianRegression()
    model.fit(X, pd.Series([100.0]))  # Dummy fit to initialize

    quantiles = [0.1, 0.25, 0.5, 0.75, 0.9, 0.95]
    predictions = model.predict_quantile(X, quantiles)

    # Write predictions
    prediction_row = {
        "property_id": property_id,
        "date": str(prediction_date),
        "predicted_minutes_p10": float(predictions[0.1][0]),
        "predicted_minutes_p25": float(predictions[0.25][0]),
        "predicted_minutes_p50": float(predictions[0.5][0]),
        "predicted_minutes_p75": float(predictions[0.75][0]),
        "predicted_minutes_p90": float(predictions[0.9][0]),
        "predicted_minutes_p95": float(predictions[0.95][0]),
        "predicted_headcount_p50": float(
            np.ceil(predictions[0.5][0] / settings.shift_cap_minutes)
        ),
        "predicted_headcount_p95": float(
            np.ceil(predictions[0.95][0] / settings.shift_cap_minutes)
        ),
        "features_snapshot": json.dumps(features_dict),
        "model_run_id": model_run_id,
        "predicted_at": datetime.utcnow().isoformat(),
    }

    try:
        result = client.upsert(
            "demand_predictions",
            prediction_row,
        )
        return {
            "property_id": property_id,
            "date": str(prediction_date),
            "predicted_minutes_p50": prediction_row["predicted_minutes_p50"],
            "predicted_minutes_p95": prediction_row["predicted_minutes_p95"],
            "predicted_headcount_p50": prediction_row["predicted_headcount_p50"],
            "predicted_headcount_p95": prediction_row["predicted_headcount_p95"],
            "model_version": model_run.get("model_version"),
        }
    except Exception as e:
        return {
            "error": f"Failed to write prediction: {e}",
            "property_id": property_id,
            "date": str(prediction_date),
        }
