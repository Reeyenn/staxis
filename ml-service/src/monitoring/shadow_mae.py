"""Rolling 14-day shadow MAE computation and auto-rollback."""
from datetime import datetime, timedelta
from typing import Optional, Tuple

import numpy as np
from scipy import stats

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

    # Wilcoxon signed-rank test
    # Null: active and baseline have same median error
    # Alt: active is worse (higher median)
    try:
        statistic, pvalue = stats.wilcoxon(active_errors, baseline_errors)
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
        # Deactivate the model
        client = get_supabase_client()
        active_models = client.fetch_many(
            "model_runs",
            filters={"property_id": property_id, "layer": layer, "is_active": True},
            limit=1,
        )
        if active_models:
            client.update(
                "model_runs",
                {
                    "is_active": False,
                    "deactivated_at": datetime.utcnow().isoformat(),
                    "deactivation_reason": "auto_rollback",
                },
                {"id": active_models[0]["id"]},
            )

    return should_rollback
