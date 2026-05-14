"""Phase M3.1 (2026-05-14) — load-bearing integration test for predict_demand
cold-start path.

This test exists to catch the NameError at ml-service/src/inference/demand.py:214
where `property_meta.get("total_rooms")` was referenced but `property_meta` was
never defined or fetched in the function. Phase M3 shipped this bug because every
M3 test exercised _cold_start.py helpers in isolation — none called predict_demand
end-to-end.

Phase L discipline: behavior tests with seeded inputs + asserted outputs. Mocks at
the supabase client wrapper layer so all real branching logic in predict_demand
runs (UUID validation, algorithm dispatch, cold-start prediction math, upsert
payload shape).
"""
import asyncio
from datetime import date
from unittest.mock import patch

from tests.conftest import (
    make_demand_cold_start_model_run,
    make_fake_supabase,
    make_plan_snapshot,
)


def _run(coro):
    return asyncio.run(coro)


PROPERTY_ID = "8a041d6e-d881-4f19-83e0-7250f0e36eaa"


def test_cold_start_inference_writes_predictions():
    """Active cold-start model + plan snapshot → demand_predictions row written.

    Anti-regression for the NameError at demand.py:214. Must FAIL on M3 main
    (commit 6825556) and PASS after M3.1 commit 1.
    """
    from src.inference.demand import predict_demand

    fake = make_fake_supabase(
        fetch_many={"model_runs": [make_demand_cold_start_model_run(
            property_id=PROPERTY_ID, prior=22.0, cohort_key="industry-default")]},
        execute_sql={"plan_snapshots": [make_plan_snapshot(total_rooms=30)]},
    )

    with patch("src.inference.demand.get_supabase_client", return_value=fake):
        result = _run(predict_demand(PROPERTY_ID, date(2026, 5, 15)))

    # Load-bearing assertion: NO error key. Fails on M3 main with the NameError-
    # wrapped error response.
    assert "error" not in result, f"Expected no error, got: {result!r}"

    # mu = prior_per_room (22) × total_rooms (30) = 660
    assert result["predicted_minutes_p50"] == 660.0

    # Exactly one upsert to demand_predictions with the right contract.
    assert len(fake.upserts) == 1
    upsert = fake.upserts[0]
    assert upsert["table"] == "demand_predictions"
    assert upsert["on_conflict"] == "property_id,date,model_run_id"

    payload = upsert["data"]
    assert payload["predicted_minutes_p50"] == 660.0
    assert payload["model_run_id"] == "demand-mr-uuid"
    assert payload["features_snapshot"]  # non-empty JSON


def test_cold_start_quantile_bands_use_expected_multipliers():
    """Cold-start branch produces quantile bands at fixed mu × {0.5, 0.7, 1.0, 1.3, 1.6, 1.8}.

    These multipliers are the wide-band signal an operator should treat with
    humility. Pinning them prevents accidental tightening in a future refactor.
    """
    from src.inference.demand import predict_demand

    fake = make_fake_supabase(
        fetch_many={"model_runs": [make_demand_cold_start_model_run(
            property_id=PROPERTY_ID, prior=20.0, cohort_key="industry-default")]},
        execute_sql={"plan_snapshots": [make_plan_snapshot(total_rooms=10)]},
    )

    with patch("src.inference.demand.get_supabase_client", return_value=fake):
        _run(predict_demand(PROPERTY_ID, date(2026, 5, 15)))

    mu = 20.0 * 10  # = 200
    payload = fake.upserts[0]["data"]
    assert payload["predicted_minutes_p10"] == mu * 0.5  # 100
    assert payload["predicted_minutes_p25"] == mu * 0.7  # 140
    assert payload["predicted_minutes_p50"] == mu        # 200
    assert payload["predicted_minutes_p75"] == mu * 1.3  # 260
    assert payload["predicted_minutes_p90"] == mu * 1.6  # 320
    assert payload["predicted_minutes_p95"] == mu * 1.8  # 360


def test_cold_start_no_active_model_returns_error_no_crash():
    """No active model → graceful error, no crash, no upserts."""
    from src.inference.demand import predict_demand

    fake = make_fake_supabase(fetch_many={"model_runs": []})

    with patch("src.inference.demand.get_supabase_client", return_value=fake):
        result = _run(predict_demand(PROPERTY_ID, date(2026, 5, 15)))

    assert result["error"] == "No active demand model"
    assert len(fake.upserts) == 0


def test_cold_start_no_plan_snapshot_returns_error_no_crash():
    """Active cold-start model but no plan_snapshot for date → graceful error."""
    from src.inference.demand import predict_demand

    fake = make_fake_supabase(
        fetch_many={"model_runs": [make_demand_cold_start_model_run(property_id=PROPERTY_ID)]},
        execute_sql={"plan_snapshots": []},
    )

    with patch("src.inference.demand.get_supabase_client", return_value=fake):
        result = _run(predict_demand(PROPERTY_ID, date(2026, 5, 15)))

    assert "No plan snapshot" in result["error"]
    assert len(fake.upserts) == 0


def test_cold_start_corrupt_posterior_falls_back_to_industry_default():
    """If posterior_params is malformed JSON, cold-start uses 20.0 fallback (no crash).

    Defends against a corrupt or schema-drifted model_runs row taking down inference.
    """
    from src.inference.demand import predict_demand

    bad_model = make_demand_cold_start_model_run(property_id=PROPERTY_ID)
    bad_model["posterior_params"] = "not-valid-json{"

    fake = make_fake_supabase(
        fetch_many={"model_runs": [bad_model]},
        execute_sql={"plan_snapshots": [make_plan_snapshot(total_rooms=10)]},
    )

    with patch("src.inference.demand.get_supabase_client", return_value=fake):
        result = _run(predict_demand(PROPERTY_ID, date(2026, 5, 15)))

    assert "error" not in result
    # Falls back to industry-default 20.0 → mu = 20 × 10 = 200
    assert result["predicted_minutes_p50"] == 200.0
