"""Training pipeline for Layer 1 Demand model."""
import json
import os
import uuid
from datetime import datetime, timedelta
from typing import Optional, Tuple

import numpy as np
import pandas as pd
import psycopg2
from sklearn.model_selection import cross_val_score

from src.advisory_lock import advisory_lock
from src.config import get_settings
from src.layers.bayesian_regression import BayesianRegression
from src.layers.static_baseline import StaticBaseline
from src.layers.xgboost_quantile import XGBoostQuantile, XGBOOST_INFERENCE_READY
from src.supabase_client import get_supabase_client


# Feature columns used for demand training. Must match the columns produced by
# the SQL query below AND the column names StaticBaseline expects, so that
# baseline_mae is a meaningful comparison against the rules-based prior.
DEMAND_FEATURE_COLS = [
    "total_checkouts",
    "stayover_day_1_count",
    "stayover_day_2plus_count",
    "vacant_dirty_count",
    "occupancy_pct",
    "day_of_week",
]


def _validate_property_id(property_id: str) -> Optional[str]:
    """Reject any property_id that is not a well-formed UUID.

    The ML service interpolates property_id into raw SQL strings, so a malformed
    or attacker-controlled value would either error noisily or, worst case,
    inject SQL. Validate at the entrypoint.
    """
    try:
        uuid.UUID(str(property_id))
        return None
    except (ValueError, AttributeError, TypeError):
        return f"Invalid property_id: not a UUID ({property_id!r})"


async def train_demand_model(
    property_id: str,
    max_rows: Optional[int] = None,
) -> dict:
    """Train Layer 1 demand model for a property.

    Pipeline:
    1. Acquire per-(property, layer) advisory lock so concurrent runs serialize
    2. Fetch training data: one row per day, target = total cleaning minutes
       actually worked that day (from cleaning_minutes_per_day_view)
    3. Day-level features: checkout/stayover composition + occupancy + dow
    4. Time-based train/validation split (80/20)
    5. Fit Bayesian or XGBoost based on data size
    6. Evaluate validation MAE against StaticBaseline (apples-to-apples: same
       feature columns the static rules expect)
    7. Check activation gates (size + MAE + beats-baseline%)
    8. Write model_runs row with posterior_params for Bayesian reuse

    Args:
        property_id: Property UUID (validated)
        max_rows: Max rows to use (for dev/testing)

    Returns:
        Dictionary with model_run_id, metrics, is_active
    """
    err = _validate_property_id(property_id)
    if err:
        return {"error": err, "model_run_id": None, "is_active": False}

    settings = get_settings()
    client = get_supabase_client()

    # Build a separate psycopg2 connection just for the advisory lock — the
    # supabase-py client doesn't expose pg_advisory_lock primitives.
    db_url = os.environ.get("SUPABASE_DB_URL") or os.environ.get("DATABASE_URL")
    lock_conn = None
    if db_url:
        try:
            lock_conn = psycopg2.connect(db_url)
        except Exception as exc:
            # Fail open: log but proceed without the lock. Concurrent runs are
            # expected to be rare (weekly cron + manual triggers).
            print(json.dumps({
                "evt": "advisory_lock_connect_failed",
                "layer": "demand", "property_id": property_id, "error": str(exc),
            }))

    def _do_train() -> dict:
        return _train_demand_inner(property_id, max_rows, settings, client)

    try:
        if lock_conn is not None:
            with advisory_lock(lock_conn, property_id, "demand", blocking=True):
                return _do_train()
        else:
            return _do_train()
    finally:
        if lock_conn is not None:
            try:
                lock_conn.close()
            except Exception:
                pass


def _train_demand_inner(
    property_id: str,
    max_rows: Optional[int],
    settings,
    client,
) -> dict:
    """Inner training routine — runs inside the advisory lock."""
    # ── Fetch training data: one row per day ───────────────────────────────
    # Target (`target_minutes`) = real cleaning minutes worked that day, summed
    # from cleaning_events that Maria has confirmed. NOT actual_headcount × shift_cap
    # (that was a cardinal bug — the model just learned to spit back headcount × 420
    # which made every prediction 3-5× too high).
    #
    # Features are pulled from plan_snapshots (one row per property+date,
    # already aggregated by the scraper) so we get checkout/stayover composition
    # in the exact column names StaticBaseline expects.
    query = f"""
        select
          cmpd.date as date,
          cmpd.total_recorded_minutes as target_minutes,
          coalesce(ps.checkouts, 0) as total_checkouts,
          coalesce(ps.stayover_day1, 0) as stayover_day_1_count,
          coalesce(ps.stayover_day2, 0) + coalesce(ps.stayover_arrival_day, 0) + coalesce(ps.stayover_unknown, 0) as stayover_day_2plus_count,
          coalesce(ps.vacant_dirty, 0) as vacant_dirty_count,
          case
            when coalesce(ps.total_rooms, 0) > 0
            then round((100.0 * (ps.total_rooms - coalesce(ps.vacant_clean, 0) - coalesce(ps.vacant_dirty, 0) - coalesce(ps.ooo, 0))::numeric / ps.total_rooms)::numeric, 2)
            else 50.0
          end as occupancy_pct,
          extract(dow from cmpd.date)::int as day_of_week,
          hav.actual_headcount
        from cleaning_minutes_per_day_view cmpd
        join headcount_actuals_view hav
          on hav.property_id = cmpd.property_id and hav.date = cmpd.date
        left join plan_snapshots ps
          on ps.property_id = cmpd.property_id and ps.date = cmpd.date
        where cmpd.property_id = '{property_id}'
          and hav.labels_complete = true
          and cmpd.total_recorded_minutes is not null
          and cmpd.total_recorded_minutes > 0
        order by cmpd.date
    """

    try:
        data = client.execute_sql(query)
    except Exception as exc:
        return {
            "error": f"Failed to fetch training data: {exc}",
            "model_run_id": None,
            "is_active": False,
        }

    if not data or len(data) < settings.training_row_count_min:
        return {
            "error": f"Insufficient data (need {settings.training_row_count_min} days, got {len(data) if data else 0})",
            "model_run_id": None,
            "is_active": False,
            "training_row_count": len(data) if data else 0,
        }

    df = pd.DataFrame(data)

    # Ensure all required feature + target columns are present (defensive — the
    # SQL above produces them but a future schema bump shouldn't silently break).
    missing = [c for c in DEMAND_FEATURE_COLS + ["target_minutes"] if c not in df.columns]
    if missing:
        return {
            "error": f"Missing columns from training query: {missing}",
            "model_run_id": None,
            "is_active": False,
        }

    if max_rows:
        df = df.tail(max_rows)

    # Cast types: SQL numerics come back as Decimal/string, force to float for math.
    for col in DEMAND_FEATURE_COLS + ["target_minutes"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    # Drop any rows where target is missing or non-positive (sanity).
    df = df[df["target_minutes"].notna() & (df["target_minutes"] > 0)].reset_index(drop=True)
    if len(df) < settings.training_row_count_min:
        return {
            "error": f"Insufficient valid rows after cleaning (got {len(df)})",
            "model_run_id": None,
            "is_active": False,
            "training_row_count": len(df),
        }

    feature_cols = list(DEMAND_FEATURE_COLS)
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

    # Baseline MAE — StaticBaseline reads `total_checkouts`,
    # `stayover_day_1_count`, `stayover_day_2plus_count`, `vacant_dirty_count`
    # from X by name. Our SQL above produces those exact column names so the
    # baseline can compute its hospitality-rules estimate (previously the
    # training query produced different column names so the baseline silently
    # predicted 0 for every row, making `beats_baseline_pct` meaningless).
    baseline = StaticBaseline()
    baseline.fit(X_train, y_train)
    pred_baseline = baseline.predict(X_test)
    baseline_mae = float(np.mean(np.abs(pred_baseline - y_test.values)))

    # Guard against degenerate baseline (e.g. baseline_mae == 0). Without this
    # we'd divide by zero and write NaN into beats_baseline_pct.
    if baseline_mae > 1e-9:
        beats_baseline_pct = float(max(0.0, (baseline_mae - validation_mae) / baseline_mae))
    else:
        beats_baseline_pct = 0.0

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

    # Codex audit pass-6 P0 — XGBoost graduates at training time but
    # inference doesn't yet load XGBoost artifacts (returns an error).
    # Block activation until inference is wired up so a graduated
    # property doesn't silently lose predictions. Training still runs
    # and the row gets logged so we can compare metrics.
    if model.get_config()["algorithm"] == "xgboost-quantile" and not XGBOOST_INFERENCE_READY:
        should_activate = False

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
