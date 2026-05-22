"""Phase 1.2 (2026-05-22) — the optimizer persists L1+L2 cold-start
status into optimizer_results.inputs_snapshot AND mirrors it in the
response payload.

These four fields drive `getActiveOptimizerForTomorrow()`'s `modelKind`
derivation (Phase 1.3), which in turn drives the Schedule tab's label
branch between "AI recommendation" and "Industry estimate · learning"
(Phase 1.4). Without them the UI can't tell whether the underlying
demand/supply models were fitted-from-this-hotel or cohort priors.
"""
import asyncio
import json
from datetime import date
from unittest.mock import patch

from tests.conftest import make_fake_supabase

PROPERTY_ID = "8a041d6e-d881-4f19-83e0-7250f0e36eaa"


def _run(coro):
    return asyncio.run(coro)


def _demand_pred(model_run_id="demand-mr-fitted"):
    """Single demand_predictions row used as the optimizer's L1 input."""
    return {
        "property_id": PROPERTY_ID,
        "date": "2026-05-15",
        "predicted_minutes_p50": 1000.0,
        "predicted_minutes_p95": 1300.0,
        "predicted_headcount_p50": 3.0,
        "predicted_headcount_p95": 4.0,
        "model_run_id": model_run_id,
    }


def _supply_pred(room, model_run_id="supply-mr-fitted"):
    """Single supply_predictions row — gets fanned out per (room, staff)."""
    return {
        "property_id": PROPERTY_ID,
        "date": "2026-05-15",
        "room_number": room,
        "staff_id": "11111111-1111-1111-1111-111111111111",
        "predicted_minutes_p25": 15.0,
        "predicted_minutes_p50": 22.0,
        "predicted_minutes_p75": 28.0,
        "predicted_minutes_p90": 35.0,
        "model_run_id": model_run_id,
    }


def _model_run_row(model_run_id, *, is_cold_start, algorithm):
    return {
        "id": model_run_id,
        "is_cold_start": is_cold_start,
        "algorithm": algorithm,
        "layer": "demand" if "demand" in model_run_id else "supply",
    }


def _fake_with_layers(*, l1_cold_start: bool, l2_cold_start: bool, n_supply: int = 15):
    """Build a fake supabase client that returns demand + supply preds
    plus the right model_runs rows when fetched by id.
    """
    l1_algo = "cold-start-cohort-prior" if l1_cold_start else "bayesian"
    l2_algo = "cold-start-cohort-prior" if l2_cold_start else "bayesian"
    demand_preds = [_demand_pred("demand-mr-fitted")]
    supply_preds = [_supply_pred(str(100 + i), "supply-mr-fitted") for i in range(n_supply)]

    def _fetch_many(table, **kwargs):
        if table == "demand_predictions":
            return demand_preds
        if table == "supply_predictions":
            return supply_preds
        return []

    def _fetch_one(table, filters=None):
        filters = filters or {}
        if table == "properties":
            return {"id": PROPERTY_ID, "shift_minutes": 420}
        if table == "ml_feature_flags":
            return None
        if table == "model_runs":
            mid = filters.get("id")
            if mid == "demand-mr-fitted":
                return _model_run_row(mid, is_cold_start=l1_cold_start, algorithm=l1_algo)
            if mid == "supply-mr-fitted":
                return _model_run_row(mid, is_cold_start=l2_cold_start, algorithm=l2_algo)
        return None

    return make_fake_supabase(
        fetch_many=_fetch_many,
        fetch_one=_fetch_one,
        execute_sql={},
    )


def test_optimizer_inputs_snapshot_records_l1_l2_flags_for_mixed_state():
    """L1=cold-start, L2=fitted → inputs_snapshot has the right flags."""
    from src.optimizer.monte_carlo import optimize_headcount

    fake = _fake_with_layers(l1_cold_start=True, l2_cold_start=False)
    with patch("src.optimizer.monte_carlo.get_supabase_client", return_value=fake):
        result = _run(optimize_headcount(PROPERTY_ID, date(2026, 5, 15)))

    assert "error" not in result, f"unexpected error: {result!r}"
    upserts = [u for u in fake.upserts if u["table"] == "optimizer_results"]
    assert len(upserts) == 1, "optimizer should write exactly one row"
    snap = json.loads(upserts[0]["data"]["inputs_snapshot"])
    assert snap["l1_is_cold_start"] is True
    assert snap["l2_any_cold_start"] is False
    assert snap["used_l2_supply"] is True
    assert snap["l2_prediction_count"] == 15
    # Response payload mirrors the flags so the cron can branch without
    # re-reading optimizer_results.
    assert result["l1_is_cold_start"] is True
    assert result["l2_any_cold_start"] is False
    assert result["used_l2_supply"] is True
    assert result["l2_prediction_count"] == 15
