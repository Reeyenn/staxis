"""Training pipeline for Layer 1 Demand model."""
import json
import uuid
from datetime import datetime, timedelta
from typing import Optional, Tuple

import numpy as np
import pandas as pd
from sklearn.model_selection import cross_val_score

from src.config import get_settings
from src.layers.bayesian_regression import BayesianRegression
from src.layers.static_baseline import StaticBaseline
from src.layers.xgboost_quantile import XGBoostQuantile
from src.supabase_client import get_supabase_client


async def train_demand_model(
    property_id: str,
    max_rows: Optional[int] = None,
) -> dict:
    """Train Layer 1 demand model for a property.

    Pipeline:
    1. Fetch training data from cleaning_events + headcount_actuals_view
    2. Feature engineering
    3. Time-based train/validation split (80/20)
    4. Fit Bayesian or XGBoost based on data size
    5. Evaluate on validation set
    6. Check activation gates
    7. Write model_runs row

    Args:
        property_id: Property UUID
        max_rows: Max rows to use (for dev/testing)

    Returns:
        Dictionary with model_run_id, metrics, is_active
    """
    settings = get_settings()
    client = get_supabase_client()

    # Fetch training data
    query = f"""
        select ce.*, hav.actual_headcount
        from cleaning_events ce
        join headcount_actuals_view hav on (
            ce.property_id = hav.property_id
            and date(ce.created_at) = hav.date
        )
        where ce.property_id = '{property_id}'
          and hav.labels_complete = true
          and ce.status != 'discarded'
        order by ce.created_at
    """

    try:
        data = client.execute_sql(query)
    except Exception:
        return {
            "error": "Failed to fetch training data",
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

    # Convert to DataFrame
    df = pd.DataFrame(data)

    # Ensure we have required columns
    required_cols = [
        "total_checkouts_today",
        "day_of_week",
        "occupancy_pct",
    ]
    missing = [c for c in required_cols if c not in df.columns]
    if missing:
        return {
            "error": f"Missing columns: {missing}",
            "model_run_id": None,
            "is_active": False,
        }

    if max_rows:
        df = df.tail(max_rows)

    # Target: minutes actually worked
    # Estimate: actual_headcount * shift_cap / planned
    df["target_minutes"] = (
        (df["actual_headcount"] * settings.shift_cap_minutes).astype(float)
    )

    # Features
    feature_cols = [
        "total_checkouts_today",
        "day_of_week",
        "occupancy_pct",
    ]
    feature_cols = [c for c in feature_cols if c in df.columns]

    X = df[feature_cols].fillna(0)
    y = df["target_minutes"].fillna(0)

    # Add intercept
    X = pd.concat([pd.Series(np.ones(len(X)), name="intercept"), X], axis=1)

    # Time-based split: 80% train, 20% test
    split_idx = int(len(X) * 0.8)
    X_train, X_test = X.iloc[:split_idx], X.iloc[split_idx:]
    y_train, y_test = y.iloc[:split_idx], y.iloc[split_idx:]

    # Choose algorithm based on data size
    use_xgboost = len(X_train) >= settings.training_row_count_activation

    if use_xgboost:
        model = XGBoostQuantile(
            quantiles=[0.1, 0.25, 0.5, 0.75, 0.9, 0.95],
        )
        model_version = f"xgboost-{datetime.utcnow().isoformat()}"
    else:
        model = BayesianRegression()
        model_version = f"bayesian-v1-{datetime.utcnow().isoformat()}"

    # Fit
    model.fit(X_train, y_train)

    # Evaluate on holdout
    pred_test = model.predict(X_test)
    validation_mae = float(np.mean(np.abs(pred_test - y_test.values)))
    training_mae = float(np.mean(np.abs(model.predict(X_train) - y_train.values)))

    # Baseline MAE
    baseline = StaticBaseline()
    baseline.fit(X_train, y_train)
    pred_baseline = baseline.predict(X_test)
    baseline_mae = float(np.mean(np.abs(pred_baseline - y_test.values)))

    beats_baseline_pct = float(max(0, (baseline_mae - validation_mae) / baseline_mae))

    # Check activation gates
    passes_gates = (
        len(df) >= settings.training_row_count_activation
        and validation_mae < settings.validation_mae_threshold
        and beats_baseline_pct >= settings.baseline_beat_pct_threshold
    )

    # Check consecutive passing runs: look at last 5 runs, count backwards
    recent_runs = client.fetch_many(
        "model_runs",
        filters={"property_id": property_id, "layer": "demand"},
        order_by="trained_at",
        descending=True,
        limit=5,
    )

    # Count consecutive passing runs (from most recent backwards)
    consecutive_passes = 1 if passes_gates else 0
    for prior_run in (recent_runs or []):
        # Check if this prior run passed gates
        prior_passes = (
            prior_run.get("beats_baseline_pct", 0) >= settings.baseline_beat_pct_threshold
            and prior_run.get("validation_mae", float("inf")) < settings.validation_mae_threshold
            and prior_run.get("training_row_count", 0) >= settings.training_row_count_activation
        )
        if prior_passes and consecutive_passes > 0:
            consecutive_passes += 1
            if consecutive_passes > 5:
                consecutive_passes = 5  # Cap at 5
        else:
            break  # Stop counting at first non-passing run

    should_activate = passes_gates and consecutive_passes >= settings.consecutive_passing_runs_required

    # Prepare posterior params if Bayesian
    posterior_params = None
    if model.get_config()["algorithm"] == "bayesian":
        # Serialize Bayesian posterior for later inference
        posterior_params = {
            "mu_n": model.mu_n.tolist() if model.mu_n is not None else None,
            "sigma_n": model.sigma_n.tolist() if model.sigma_n is not None else None,
            "alpha_n": float(model.alpha_n) if model.alpha_n is not None else None,
            "beta_n": float(model.beta_n) if model.beta_n is not None else None,
            "mu_0": model.mu_0.tolist() if model.mu_0 is not None else None,
            "sigma_0": model.sigma_0.tolist() if model.sigma_0 is not None else None,
            "alpha": float(model.alpha),
            "beta": float(model.beta),
            "feature_names": model.feature_names,
        }

    # Create model_runs row
    model_run = client.insert(
        "model_runs",
        {
            "property_id": property_id,
            "layer": "demand",
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
            "consecutive_passing_runs": consecutive_passes,
            "posterior_params": json.dumps(posterior_params) if posterior_params else None,
            "hyperparameters": json.dumps(model.get_config()),
        },
    )

    return {
        "model_run_id": model_run.get("id"),
        "is_active": should_activate,
        "training_mae": training_mae,
        "validation_mae": validation_mae,
        "baseline_mae": baseline_mae,
        "beats_baseline_pct": beats_baseline_pct,
        "training_row_count": len(df),
    }
