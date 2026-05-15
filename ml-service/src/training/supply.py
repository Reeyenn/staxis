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
from src.layers.xgboost_quantile import XGBoostQuantile, XGBOOST_INFERENCE_READY
from src.supabase_client import get_supabase_client


from src.training._streak_utils import parse_iso_datetime as _parse_iso_datetime  # noqa: E402


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
        # Phase M3 cold-start path. Same shape as demand.py — reads
        # supply_priors.prior_minutes_per_event via the shared helpers.
        from src.training._cold_start import install_cold_start, lookup_cohort_prior
        local_rows = len(data) if data else 0
        prior_value, prior_strength, source, cohort_key = lookup_cohort_prior(
            client, property_id,
            table="supply_priors",
            value_col="prior_minutes_per_event",
            hardcoded_fallback=30.0,
        )
        return install_cold_start(
            client, property_id,
            layer="supply",
            prior_value=prior_value,
            prior_strength=prior_strength,
            source=source,
            cohort_key=cohort_key,
            local_rows_observed=local_rows,
            value_param_name="prior_minutes_per_event",
        )

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

    # Phase 3.2 (2026-05-13): size-relative MAE gate. The prior absolute
    # 10-min threshold was Beaumont-shaped; a 30-room hotel needs MAE 5
    # (0.5% relative — achievable), a 200-room hotel makes the absolute
    # number meaningless. Gate on ratio with a floor so trivial values
    # don't auto-pass.
    #
    # Codex follow-up 2026-05-13 (B1): denominator is ACTUALS (y_test),
    # not predictions — see training/demand.py for rationale.
    mean_actual_pos = float(np.mean(np.abs(y_test.values))) or 1.0
    mae_ratio = validation_mae / max(mean_actual_pos, settings.validation_mae_floor)

    # Check gates. Supply still uses a lower baseline-beat bar (0.05) than
    # demand (0.20) because per-room cleaning-time variance is inherently
    # noisier than per-day total demand variance.
    # Codex follow-up 2026-05-13 (B2): sample-size guard (>=30 holdout).
    #
    # Phase M3.2 (2026-05-14) — root-cause fix for the activation gap.
    # Previously this required `len(df) >= training_row_count_activation`
    # (=500). Properties with 200-499 events were trapped in a no-active-
    # model state: cold-start fired only at <200, Bayesian activated only
    # at >=500. Beaumont (201 events, MAE 1.09 min, beats baseline 76%)
    # had GREAT metrics but never went live.
    #
    # First-principles: the row-count guard was redundant. A model that
    # passes ALL of {holdout >=30, mae_ratio under threshold, beats_baseline
    # >= 5%, consecutive_passing_runs >= 2} has empirically demonstrated
    # itself trustworthy — the row count was paternalism that ignored the
    # other gates' work. Dropping it lets quality, not quantity, decide
    # activation. Still-noisy models can't squeak through because the
    # other 4 gates do the work. XGBoost algorithm selection at line 178
    # keeps the row-count threshold (XGBoost overfits at low N) — that's
    # an algorithm-choice gate, not an activation gate.
    passes_gates = (
        len(X_test) >= 30
        and mae_ratio < settings.validation_mae_ratio_threshold
        and beats_baseline_pct >= 0.05
    )

    # Check consecutive passing runs: look at last 5 runs, count backwards.
    # Phase 3.2 (revised after Codex review 2026-05-13 #3): prior runs
    # are evaluated against the OLD absolute MAE gate (10 min for
    # supply), while the current run uses the new ratio gate. See
    # training/demand.py for the longer rationale.
    recent_runs = client.fetch_many(
        "model_runs",
        filters={"property_id": property_id, "layer": "supply"},
        order_by="trained_at",
        descending=True,
        limit=5,
    )

    # Count consecutive passing runs (from most recent backwards).
    #
    # Phase M3.4 (2026-05-14) — Codex adversarial finding #1: each prior
    # run that counts toward the streak must represent a DISTINCT
    # training window. Pre-M3.4 the loop counted any 5 prior model_runs
    # by metric value alone, so 5 retries on identical data minutes
    # apart (e.g. manual cron dispatches during incident replay,
    # onboarding script, dev verification) all counted toward the
    # streak as if they were 5 weekly windows of stability. That's
    # how Beaumont activated instantly on rapid-fire dispatch.
    #
    # Two semantic changes:
    #   1. Distinctness check: a prior run only counts if its trained_at
    #      is at least min_hours_between_passing_runs (default 24h)
    #      before the previously-counted run.
    #   2. continue (not break) on non-distinct: a same-window retry
    #      is neither evidence FOR nor evidence AGAINST stability — it
    #      doesn't add to the streak but doesn't erase prior evidence.
    #      Failed runs still break (genuine failure breaks the streak).
    min_gap_seconds = settings.min_hours_between_passing_runs * 3600
    consecutive_passes = 1 if passes_gates else 0
    last_counted_trained_at = _parse_iso_datetime(
        datetime.utcnow().isoformat() if passes_gates else None
    )
    for prior_run in (recent_runs or []):
        prior_trained_at = _parse_iso_datetime(prior_run.get("trained_at"))
        if prior_trained_at is None:
            break
        # Distinctness: must be older than the last-counted run by min_gap.
        if last_counted_trained_at is not None:
            gap = (last_counted_trained_at - prior_trained_at).total_seconds()
            if gap < min_gap_seconds:
                continue  # same training window → skip but don't break
        # Check if this prior run passed gates. Legacy absolute MAE
        # threshold (10 min for supply) because prior rows don't carry
        # mae_ratio. Phase M3.2: row-count guard removed.
        prior_passes = (
            prior_run.get("beats_baseline_pct", 0) >= 0.05
            and prior_run.get("validation_mae", float("inf")) < 10.0
        )
        if not prior_passes:
            break  # Genuine failure → streak broken
        consecutive_passes += 1
        last_counted_trained_at = prior_trained_at
        if consecutive_passes >= 5:
            break  # Cap at 5

    should_activate = passes_gates and consecutive_passes >= settings.consecutive_passing_runs_required

    # Codex audit pass-6 P0 — supply inference returns an explicit error
    # for active XGBoost runs (deserialization not yet wired up). Block
    # XGBoost activation until inference can serve the artifact, so a
    # graduated property doesn't silently lose all supply predictions.
    if model.get_config()["algorithm"] == "xgboost-quantile" and not XGBOOST_INFERENCE_READY:
        should_activate = False

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

    # Codex adversarial review 2026-05-13 (A6): atomic deactivate + insert
    # via the migration 0107 RPC. See training/demand.py for the rationale.
    fields = {
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
        "consecutive_passing_runs": consecutive_passes,
        "posterior_params": posterior_params,
        "hyperparameters": model.get_config(),
    }
    rpc_result = client.client.rpc(
        "staxis_install_housekeeping_model_run",
        {
            "p_property_id": property_id,
            "p_layer": "supply",
            "p_fields": fields,
            "p_should_activate": should_activate,
        },
    ).execute()
    rows = rpc_result.data or []
    row = rows[0] if isinstance(rows, list) and rows else (rows or {})
    if not row.get("ok"):
        return {
            "error": f"model_install_refused: {row.get('reason', 'unknown')}",
            "model_run_id": None,
            "is_active": False,
        }
    new_run_id = row.get("model_run_id")

    return {
        "model_run_id": new_run_id,
        "is_active": should_activate,
        "training_mae": training_mae,
        "validation_mae": validation_mae,
        "beats_baseline_pct": beats_baseline_pct,
        "training_row_count": len(df),
    }
