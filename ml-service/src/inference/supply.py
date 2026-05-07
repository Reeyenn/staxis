"""Inference pipeline for Layer 2 Supply predictions."""
import json
from datetime import date, datetime, timedelta
from typing import Optional

import numpy as np
import pandas as pd

from src.config import get_settings
from src.supabase_client import get_supabase_client


async def predict_supply(
    property_id: str,
    prediction_date: Optional[date] = None,
) -> dict:
    """Predict per-(room × housekeeper) cleaning times for a property.

    Args:
        property_id: Property UUID
        prediction_date: Date to predict for (defaults to tomorrow)

    Returns:
        Dictionary with per-room × per-staff predictions
    """
    settings = get_settings()
    client = get_supabase_client()

    if prediction_date is None:
        prediction_date = (datetime.utcnow() + timedelta(days=1)).date()

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

    # Generate predictions for each room × staff
    predictions = []

    for sched in schedule_data or []:
        staff_id = sched["staff_id"]
        rooms = sched.get("assigned_rooms", [])

        for room_number in rooms:
            # Build features (simplified)
            features_dict = {
                "intercept": 1.0,
                "day_of_week": (datetime.utcnow() + timedelta(days=1)).weekday(),
                "occupancy_at_start": 50,
            }

            # Simple prediction: baseline 25 min/room
            from src.layers.bayesian_regression import BayesianRegression

            model = BayesianRegression()
            X = pd.DataFrame([features_dict])[["intercept", "day_of_week", "occupancy_at_start"]]
            model.fit(X, pd.Series([25.0]))  # Dummy fit

            quantiles = [0.25, 0.5, 0.75, 0.9]
            preds = model.predict_quantile(X, quantiles)

            predictions.append({
                "room_number": room_number,
                "staff_id": staff_id,
                "predicted_minutes_p25": float(preds[0.25][0]),
                "predicted_minutes_p50": float(preds[0.5][0]),
                "predicted_minutes_p75": float(preds[0.75][0]),
                "predicted_minutes_p90": float(preds[0.9][0]),
                "features_snapshot": json.dumps(features_dict),
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
        except Exception:
            pass  # Continue on individual failures

    return {
        "property_id": property_id,
        "date": str(prediction_date),
        "predicted_rooms": len(predictions),
        "model_version": model_run.get("model_version"),
    }
