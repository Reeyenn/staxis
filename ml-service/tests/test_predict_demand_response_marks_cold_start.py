"""Phase 1.1b (2026-05-22) — the predict_demand response carries the
algorithm + is_cold_start flag so downstream callers (cron / cockpit /
Schedule tab) can branch the user-facing label without an extra
model_runs join.

Bug this pins: prior to Phase 1, the cron + UI saw `{predicted_rooms: N,
model_version: X}` and couldn't tell apart a fitted Bayesian prediction
from a cohort-prior cold-start prediction. The UI then labeled both as
"AI recommendation".
"""
import asyncio
from datetime import date
from unittest.mock import patch

from tests.conftest import (
    make_demand_cold_start_model_run,
    make_fake_supabase,
    make_plan_snapshot,
)

PROPERTY_ID = "8a041d6e-d881-4f19-83e0-7250f0e36eaa"


def _run(coro):
    return asyncio.run(coro)


def test_response_includes_algorithm_and_is_cold_start_for_cold_start_model():
    from src.inference.demand import predict_demand

    fake = make_fake_supabase(
        fetch_many={"model_runs": [make_demand_cold_start_model_run(
            property_id=PROPERTY_ID, prior=22.0)]},
        execute_sql={
            "plan_snapshots": [make_plan_snapshot(total_rooms=30, checkouts=10)],
        },
    )

    with patch("src.inference.demand.get_supabase_client", return_value=fake):
        result = _run(predict_demand(PROPERTY_ID, date(2026, 5, 15)))

    assert "error" not in result, f"unexpected error: {result!r}"
    # Phase 1.1b contract: the cold-start path's response carries the
    # algorithm string and is_cold_start=true so the cron + cockpit can
    # branch without re-querying model_runs.
    assert result["algorithm"] == "cold-start-cohort-prior"
    assert result["is_cold_start"] is True


def test_response_includes_algorithm_for_bayesian_fitted_model():
    """Sanity: a fitted (non-cold-start) model returns is_cold_start=False."""
    from src.inference.demand import predict_demand

    fitted_model_run = {
        "id": "demand-fitted-mr",
        "property_id": PROPERTY_ID,
        "layer": "demand",
        "is_active": True,
        "is_shadow": False,
        "algorithm": "bayesian",
        "is_cold_start": False,
        "model_version": "bayesian-v1-fitted",
        # Posterior with all 5 required fields so the hydrate path succeeds.
        "posterior_params": {
            "mu_n": [10.0, 1.0, 0.5, 0.5, 0.2, 0.1, 0.1],
            "sigma_n": [[0.0] * 7 for _ in range(7)],
            "alpha_n": 5.0,
            "beta_n": 1.0,
            "feature_names": [
                "intercept", "total_checkouts", "stayover_day_1_count",
                "stayover_day_2plus_count", "vacant_dirty_count", "occupancy_pct",
                "day_of_week",
            ],
        },
    }
    fake = make_fake_supabase(
        fetch_many={"model_runs": [fitted_model_run]},
        execute_sql={
            "plan_snapshots": [make_plan_snapshot(total_rooms=30, checkouts=10)],
        },
    )

    with patch("src.inference.demand.get_supabase_client", return_value=fake):
        result = _run(predict_demand(PROPERTY_ID, date(2026, 5, 15)))

    assert "error" not in result, f"unexpected error: {result!r}"
    assert result["algorithm"] == "bayesian"
    assert result["is_cold_start"] is False
