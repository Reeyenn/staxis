"""Training pipeline for Layer 2 Supply model (per-room × per-housekeeper)."""
import json
import os
import uuid
from datetime import datetime
from typing import Optional

import numpy as np
import pandas as pd
import psycopg2

from src.advisory_lock import advisory_lock
from src.config import get_settings
from src.features.supply_matrix import build_supply_features
from src.layers.bayesian_regression import BayesianRegression
from src.layers.xgboost_quantile import XGBoostQuantile
from src.supabase_client import get_supabase_client


# Feature set version. Bump when build_supply_features() changes its output
# columns so old models (trained with a smaller feature set) get retrained
# rather than producing shape-mismatch errors at inference time.
#   v1 — day_of_week + occupancy_at_start only (the original 2-feature model)
#   v2 — adds room_type, stayover_day_2, room_floor, one-hot room_number,
#        one-hot staff_id. This is what teaches the model to learn that
#        e.g. room 305 reliably runs longer than room 412 (size effect)
#        and that Cindy is faster than Astri on stayovers (pace effect).
FEATURE_SET_VERSION = "v2"


def _validate_property_id(property_id: str) -> Optional[str]:
    """Reject any property_id that is not a well-formed UUID."""
    try:
        uuid.UUID(str(property_id))
        return None
    except (ValueError, AttributeError, TypeError):
        return f"Invalid property_id: not a UUID ({property_id!r})"


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
    err = _validate_property_id(property_id)
    if err:
        return {"error": err, "model_run_id": None, "is_active": False}

    settings = get_settings()
    client = get_supabase_client()

    db_url = os.environ.get("SUPABASE_DB_URL") or os.environ.get("DATABASE_URL")
    lock_conn = None
    if db_url:
        try:
            lock_conn = psycopg2.connect(db_url)
        except Exception as exc:
            print(json.dumps({
                "evt": "advisory_lock_connect_failed",
                "layer": "supply", "property_id": property_id, "error": str(exc),
            }))

    def _do_train() -> dict:
        return _train_supply_inner(property_id, max_rows, settings, client)

    try:
        if lock_conn is not None:
            with advisory_lock(lock_conn, property_id, "supply", blocking=True):
                return _do_train()
        else:
            return _do_train()
    finally:
        if lock_conn is not None:
            try:
                lock_conn.close()
            except Exception:
                pass


def _train_supply_inner(
    property_id: str,
    max_rows: Optional[int],
    settings,
    client,
) -> dict:
    """Inner supply training routine — runs inside the advisory lock."""
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
          and status != 'discarded'
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
    df = df[(df["actual_minutes"] > 1) & (df["actual_minutes"] < 180)].reset_index(drop=True)

    # Build the feature matrix via the shared helper. v2 features include
    # per-room and per-staff one-hot encodings on top of the original
    # day/occupancy/type signals — see src/features/supply_matrix.py for
    # the full list. The list of column names is captured here so it can
    # be persisted on model_runs.posterior_params, and the inference path
    # rebuilds X with exactly the same column order at predict time.
    X, feature_names = build_supply_features(df, training=True)
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

    # Baseline: predict the training mean for every test row. This is the
    # simplest "no model" benchmark — anything worth deploying must beat it.
    baseline_pred = y_train.mean()
    baseline_mae = float(np.mean(np.abs(baseline_pred - y_test.values)))
    if baseline_mae > 1e-9:
        beats_baseline_pct = float(max(0.0, (baseline_mae - validation_mae) / baseline_mae))
    else:
        beats_baseline_pct = 0.0

    # Check gates
    passes_gates = (
        len(df) >= settings.training_row_count_activation
        and validation_mae < 10.0  # Relaxed threshold for supply (minutes/room)
        and beats_baseline_pct >= 0.05  # Lower bar for supply
    )

    # Check consecutive passing runs: look at last 5 runs, count backwards
    recent_runs = client.fetch_many(
        "model_runs",
        filters={"property_id": property_id, "layer": "supply"},
        order_by="trained_at",
        descending=True,
        limit=5,
    )

    # Count consecutive passing runs (from most recent backwards)
    consecutive_passes = 1 if passes_gates else 0
    for prior_run in (recent_runs or []):
        # Check if this prior run passed gates
        prior_passes = (
            prior_run.get("beats_baseline_pct", 0) >= 0.05
            and prior_run.get("validation_mae", float("inf")) < 10.0
            and prior_run.get("training_row_count", 0) >= settings.training_row_count_activation
        )
        if prior_passes and consecutive_passes > 0:
            consecutive_passes += 1
            if consecutive_passes > 5:
                consecutive_passes = 5  # Cap at 5
        else:
            break  # Stop counting at first non-passing run

    should_activate = passes_gates and consecutive_passes >= settings.consecutive_passing_runs_required

    # Serialize Bayesian posterior so supply inference can rebuild the model
    # without re-fitting. Without this the inference function silently fell
    # back to a one-row dummy fit and predicted a flat 25 minutes per room.
    posterior_params = None
    if model.get_config()["algorithm"] == "bayesian":
        posterior_params = {
            "mu_n": model.mu_n.tolist() if model.mu_n is not None else None,
            "sigma_n": model.sigma_n.tolist() if model.sigma_n is not None else None,
            "alpha_n": float(model.alpha_n) if model.alpha_n is not None else None,
            "beta_n": float(model.beta_n) if model.beta_n is not None else None,
            "mu_0": model.mu_0.tolist() if model.mu_0 is not None else None,
            "sigma_0": model.sigma_0.tolist() if model.sigma_0 is not None else None,
            "alpha": float(model.alpha),
            "beta": float(model.beta),
            # Use the column list returned by build_supply_features() rather
            # than model.feature_names — the helper drops all-zero columns
            # (rooms / staff that never appeared in training) before fitting,
            # so the kept column list is what inference must align to.
            "feature_names": feature_names,
            "feature_set_version": FEATURE_SET_VERSION,
        }

    # Create model_runs row
    model_run = client.insert(
        "model_runs",
        {
            "property_id": property_id,
            "layer": "supply",
            "trained_at": datetime.utcnow().isoformat(),
            "training_row_count": len(df),
            "feature_set_version": FEATURE_SET_VERSION,
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
        "beats_baseline_pct": beats_baseline_pct,
        "training_row_count": len(df),
    }
