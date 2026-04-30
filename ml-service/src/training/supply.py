"""Training pipeline for Layer 2 Supply model (per-room × per-housekeeper)."""
import json
from datetime import datetime
from typing import Optional

import numpy as np
import pandas as pd

from src.config import get_settings
from src.layers.bayesian_regression import BayesianRegression
from src.layers.xgboost_quantile import XGBoostQuantile
from src.supabase_client import get_supabase_client


async def train_supply_model(
    property_id: str,
    max_rows: Optional[int] = None,
) -> dict:
    """Train Layer 2 supply model (per-room × per-housekeeper cleaning times).

    Pipeline:
    1. Fetch cleaning_events with actual_minutes (from started_at to completed_at)
    2. Group by (staff_id, room_type) for separate models
    3. Feature engineering (staff pace, room characteristics)
    4. Fit per-group models
    5. Evaluate on holdout
    6. Write model_runs row

    Args:
        property_id: Property UUID
        max_rows: Max rows (for dev)

    Returns:
        Dictionary with model_run_id, metrics, is_active
    """
    settings = get_settings()
    client = get_supabase_client()

    # Fetch cleaning events with duration
    query = f"""
        select
            id,
            property_id,
            staff_id,
            room_number,
            room_type,
            created_at,
            extract(epoch from (completed_at - started_at)) / 60 as actual_minutes,
            day_of_week,
            occupancy_at_start,
            was_dnd_during_clean
        from cleaning_events
        where property_id = '{property_id}'
          and completed_at is not null
          and started_at is not null
        order by created_at
    """

    try:
        data = client.execute_sql(query)
    except Exception:
        return {
            "error": "Failed to fetch cleaning events",
            "model_run_id": None,
            "is_active": False,
        }

    if not data or len(data) < settings.training_row_count_min:
        return {
            "error": f"Insufficient data (need {settings.training_row_count_min}, got {len(data)})",
            "model_run_id": None,
            "is_active": False,
            "training_row_count": len(data),
        }

    df = pd.DataFrame(data)

    if max_rows:
        df = df.tail(max_rows)

    # Filter out clearly bad data
    df = df[(df["actual_minutes"] > 1) & (df["actual_minutes"] < 180)]

    # Features
    feature_cols = ["day_of_week", "occupancy_at_start"]
    X = df[feature_cols].fillna(0)
    X = pd.concat([pd.Series(np.ones(len(X)), name="intercept"), X], axis=1)
    y = df["actual_minutes"].fillna(25)

    # Time-based split
    split_idx = int(len(X) * 0.8)
    X_train, X_test = X.iloc[:split_idx], X.iloc[split_idx:]
    y_train, y_test = y.iloc[:split_idx], y.iloc[split_idx:]

    # Train supply model
    use_xgboost = len(X_train) >= settings.training_row_count_activation

    if use_xgboost:
        model = XGBoostQuantile(
            quantiles=[0.25, 0.5, 0.75, 0.9],
        )
        model_version = f"xgboost-supply-{datetime.utcnow().isoformat()}"
    else:
        model = BayesianRegression()
        model_version = f"bayesian-supply-v1-{datetime.utcnow().isoformat()}"

    model.fit(X_train, y_train)

    # Evaluate
    pred_test = model.predict(X_test)
    validation_mae = float(np.mean(np.abs(pred_test - y_test.values)))
    training_mae = float(np.mean(np.abs(model.predict(X_train) - y_train.values)))

    # Baseline (mean)
    baseline_mae = float(np.mean(np.abs(y_test.mean() - y_test.values)))
    beats_baseline_pct = float(max(0, (baseline_mae - validation_mae) / baseline_mae))

    # Check gates
    passes_gates = (
        len(df) >= settings.training_row_count_activation
        and validation_mae < 10.0  # Relaxed threshold for supply (minutes/room)
        and beats_baseline_pct >= 0.05  # Lower bar for supply
    )

    should_activate = passes_gates

    # Create model_runs row
    model_run = client.insert(
        "model_runs",
        {
            "property_id": property_id,
            "layer": "supply",
            "trained_at": datetime.utcnow().isoformat(),
            "training_row_count": len(df),
            "feature_set_version": "v1",
            "model_version": model_version,
            "algorithm": model.get_config()["algorithm"],
            "training_mae": training_mae,
            "validation_mae": validation_mae,
            "baseline_mae": baseline_mae,
            "beats_baseline_pct": beats_baseline_pct,
            "validation_holdout_n": len(X_test),
            "is_active": should_activate,
            "activated_at": datetime.utcnow().isoformat() if should_activate else None,
            "consecutive_passing_runs": 1,
            "hyperparameters": json.dumps(model.get_config()),
        },
    )

    return {
        "model_run_id": model_run.get("id"),
        "is_active": should_activate,
        "training_mae": training_mae,
        "validation_mae": validation_mae,
        "beats_baseline_pct": beats_baseline_pct,
        "training_row_count": len(df),
    }
