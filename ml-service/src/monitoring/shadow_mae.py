"""Rolling 14-day shadow MAE computation and auto-rollback."""
import json
from datetime import datetime, timedelta
from typing import Optional, Tuple

import numpy as np
import psycopg2
from scipy import stats

from src.advisory_lock import advisory_lock
from src.config import get_settings
from src.supabase_client import get_supabase_client


async def compute_rolling_shadow_mae(
    property_id: str,
    layer: str,
) -> Optional[Tuple[float, float, float]]:
    """Compute rolling 14-day shadow MAE for active model vs baseline.

    Args:
        property_id: Property UUID
        layer: Layer name (demand, supply)

    Returns:
        Tuple of (active_mae, baseline_mae, pvalue) or None if insufficient data
    """
    client = get_supabase_client()
    settings = get_settings()

    # Find active model
    active_models = client.fetch_many(
        "model_runs",
        filters={"property_id": property_id, "layer": layer, "is_active": True},
        limit=1,
    )

    if not active_models:
        return None

    active_model_id = active_models[0]["id"]
    activation_mae = active_models[0].get("validation_mae", 5.0)

    # Fetch prediction_log for last 14 days
    cutoff_date = (datetime.utcnow() - timedelta(days=settings.auto_rollback_window_days)).isoformat()

    logs = client.fetch_many(
        "prediction_log",
        filters={"property_id": property_id, "layer": layer},
        order_by="logged_at",
        descending=True,
        limit=1000,
    )

    if not logs or len(logs) < 10:
        return None

    # Split into active model and baseline
    active_errors = []
    baseline_errors = []

    for log in logs:
        error = float(log.get("abs_error", 0))
        is_active = log.get("model_run_id") == active_model_id

        if is_active:
            active_errors.append(error)
        else:
            baseline_errors.append(error)

    if len(active_errors) < 5 or len(baseline_errors) < 5:
        return None

    # Compute MAE
    active_mae = np.mean(active_errors)
    baseline_mae = np.mean(baseline_errors)

    # Mann-Whitney U test (unpaired test for comparing two independent samples)
    # Null: active and baseline have same distribution
    # Alt: active is worse (higher errors) — one-tailed
    try:
        statistic, pvalue = stats.mannwhitneyu(
            active_errors, baseline_errors, alternative="greater"
        )
    except Exception:
        return None

    return (active_mae, baseline_mae, float(pvalue))


async def check_auto_rollback(
    property_id: str,
    layer: str,
) -> bool:
    """Check if active model should be rolled back.

    Criteria:
    - Wilcoxon p-value < 0.05 AND
    - Active model errors > baseline errors

    Args:
        property_id: Property UUID
        layer: Layer name

    Returns:
        True if rollback should happen
    """
    settings = get_settings()
    result = await compute_rolling_shadow_mae(property_id, layer)

    if result is None:
        return False

    active_mae, baseline_mae, pvalue = result

    # Rollback if statistically worse
    should_rollback = (
        pvalue < settings.auto_rollback_pvalue_threshold
        and active_mae > baseline_mae
    )

    if should_rollback:
        # Look up the active model FIRST so we can log its id even if the lock
        # acquisition or update fails. (Previous version referenced
        # active_models[0]['id'] in the log line BEFORE that variable was
        # ever populated — the log always wrote null.)
        client = get_supabase_client()
        try:
            active_models = client.fetch_many(
                "model_runs",
                filters={"property_id": property_id, "layer": layer, "is_active": True},
                limit=1,
            )
        except Exception as fetch_err:
            print(
                json.dumps(
                    {
                        "level": "error",
                        "event": "auto_rollback_active_model_fetch_failed",
                        "property_id": property_id,
                        "layer": layer,
                        "err": repr(fetch_err),
                        "ts": datetime.utcnow().isoformat(),
                    }
                )
            )
            return should_rollback
        active_model_id = active_models[0]["id"] if active_models else None

        # Acquire advisory lock so concurrent workers don't double-deactivate.
        conn = None
        try:
            conn = psycopg2.connect(
                host=settings.supabase_url.split("://")[1].split("/")[0],
                database="postgres",
                user="postgres",
                password=settings.supabase_service_role_key,
            )
            with advisory_lock(conn, property_id, layer, blocking=False) as acquired:
                if not acquired:
                    # Another worker is handling this rollback; skip silently.
                    print(
                        json.dumps(
                            {
                                "level": "info",
                                "event": "auto_rollback_lock_held_by_other",
                                "property_id": property_id,
                                "layer": layer,
                                "ts": datetime.utcnow().isoformat(),
                            }
                        )
                    )
                    return should_rollback

                # Emit structured log before deactivating.
                print(
                    json.dumps(
                        {
                            "level": "error",
                            "event": "auto_rollback_triggered",
                            "property_id": property_id,
                            "layer": layer,
                            "active_model_run_id": active_model_id,
                            "active_mae": float(active_mae),
                            "baseline_mae": float(baseline_mae),
                            "pvalue": float(pvalue),
                            "ts": datetime.utcnow().isoformat(),
                        }
                    )
                )

                # Deactivate the model.
                if active_model_id:
                    try:
                        client.update(
                            "model_runs",
                            {
                                "is_active": False,
                                "deactivated_at": datetime.utcnow().isoformat(),
                                "deactivation_reason": "auto_rollback",
                            },
                            {"id": active_model_id},
                        )
                    except Exception as update_err:
                        print(
                            json.dumps(
                                {
                                    "level": "error",
                                    "event": "auto_rollback_update_failed",
                                    "property_id": property_id,
                                    "layer": layer,
                                    "active_model_run_id": active_model_id,
                                    "err": repr(update_err),
                                    "ts": datetime.utcnow().isoformat(),
                                }
                            )
                        )
        except Exception as lock_err:
            # Lock acquisition / connection failed — surface to operators
            # instead of silently skipping (previous version did `pass`).
            print(
                json.dumps(
                    {
                        "level": "error",
                        "event": "auto_rollback_lock_or_conn_failed",
                        "property_id": property_id,
                        "layer": layer,
                        "active_model_run_id": active_model_id,
                        "err": repr(lock_err),
                        "ts": datetime.utcnow().isoformat(),
                    }
                )
            )
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

    return should_rollback
