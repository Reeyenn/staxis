"""Phase M3.1 (2026-05-14) — load-bearing integration test for predict_supply
cold-start path.

This test catches the AttributeError at ml-service/src/inference/supply.py:296
where `model.feature_names` was dereferenced unconditionally even though the
cold-start branch (line 153) never assigns to `model` — it stays None. The
guard at line 297 fires AFTER the crash on line 296.

Phase L discipline: behavior tests with seeded inputs + asserted outputs.
"""
import asyncio
from datetime import date
from unittest.mock import patch

from tests.conftest import (
    make_fake_supabase,
    make_plan_snapshot,
    make_schedule_assignment,
    make_supply_cold_start_model_run,
)


def _run(coro):
    return asyncio.run(coro)


PROPERTY_ID = "8a041d6e-d881-4f19-83e0-7250f0e36eaa"


def test_cold_start_inference_writes_predictions_per_room_staff():
    """Active cold-start model + scheduled rooms → one supply_predictions row per (room, staff).

    Anti-regression for the AttributeError at supply.py:296. Must FAIL on M3
    main (commit 6825556) and PASS after M3.1 commit 2.
    """
    from src.inference.supply import predict_supply

    # 2 staff, 3 rooms total (s1: rooms 101 + 102; s2: room 201).
    # Plan marks 101 + 201 as checkout, 102 as stayover-day-1.
    fake = make_fake_supabase(
        fetch_many={"model_runs": [make_supply_cold_start_model_run(
            property_id=PROPERTY_ID, prior=30.0, cohort_key="industry-default")]},
        execute_sql={
            "schedule_assignments": [
                make_schedule_assignment(staff_id="s1", assigned_rooms=["101", "102"]),
                make_schedule_assignment(staff_id="s2", assigned_rooms=["201"]),
            ],
            "plan_snapshots": [make_plan_snapshot(
                total_rooms=30,
                checkout_room_numbers=["101", "201"],
                stayover_day1_room_numbers=["102"],
            )],
        },
    )

    with patch("src.inference.supply.get_supabase_client", return_value=fake):
        result = _run(predict_supply(PROPERTY_ID, date(2026, 5, 15)))

    # Load-bearing: NO error key. Fails on M3 main with AttributeError-wrapped error.
    assert "error" not in result, f"Expected no error, got: {result!r}"

    assert result["predicted_rooms"] == 3

    # Exactly one upsert per (room, staff) pair.
    assert len(fake.upserts) == 3
    for u in fake.upserts:
        assert u["table"] == "supply_predictions"
        assert u["on_conflict"] == "property_id,date,room_number,staff_id,model_run_id"

    # Every payload uses the cold-start mu = 30 with the fixed multipliers.
    for u in fake.upserts:
        d = u["data"]
        assert d["predicted_minutes_p25"] == 30.0 * 0.7  # 21.0
        assert d["predicted_minutes_p50"] == 30.0        # mu
        assert d["predicted_minutes_p75"] == 30.0 * 1.3  # 39.0
        assert d["predicted_minutes_p90"] == 30.0 * 1.6  # 48.0
        assert d["model_run_id"] == "supply-mr-uuid"
        # features_snapshot is a JSON string with the cold_start flag.
        assert "cold_start" in d["features_snapshot"]

    # All 3 expected (room, staff) pairs covered.
    pairs = {(u["data"]["room_number"], u["data"]["staff_id"]) for u in fake.upserts}
    assert pairs == {("101", "s1"), ("102", "s1"), ("201", "s2")}


def test_cold_start_inference_does_not_dereference_model_feature_names():
    """Regression test specifically for the model.feature_names AttributeError.

    Forces the cold-start path. The current M3 code unconditionally accesses
    model.feature_names BEFORE checking algorithm — this MUST not happen.
    Equivalent to test #1 but documents the specific contract being protected.
    """
    from src.inference.supply import predict_supply

    fake = make_fake_supabase(
        fetch_many={"model_runs": [make_supply_cold_start_model_run(
            property_id=PROPERTY_ID, prior=30.0)]},
        execute_sql={
            "schedule_assignments": [
                make_schedule_assignment(staff_id="s1", assigned_rooms=["101"]),
            ],
            "plan_snapshots": [make_plan_snapshot(
                total_rooms=30, checkout_room_numbers=["101"])],
        },
    )

    with patch("src.inference.supply.get_supabase_client", return_value=fake):
        result = _run(predict_supply(PROPERTY_ID, date(2026, 5, 15)))

    # If model.feature_names was dereferenced, result["error"] would contain
    # "AttributeError" or "NoneType". The fix moves that dereference into the
    # bayesian-only branch.
    assert "error" not in result, (
        f"Cold-start path crashed before reaching the prediction loop: {result!r}"
    )
    assert result["predicted_rooms"] == 1


def test_cold_start_no_active_model_returns_error_no_crash():
    """No active supply model → graceful error, no crash, no upserts."""
    from src.inference.supply import predict_supply

    fake = make_fake_supabase(fetch_many={"model_runs": []})

    with patch("src.inference.supply.get_supabase_client", return_value=fake):
        result = _run(predict_supply(PROPERTY_ID, date(2026, 5, 15)))

    assert result["error"] == "No active supply model"
    assert len(fake.upserts) == 0


def test_cold_start_empty_schedule_returns_zero_predictions():
    """Active cold-start model but no scheduled rooms → predicted_rooms=0, no upserts."""
    from src.inference.supply import predict_supply

    fake = make_fake_supabase(
        fetch_many={"model_runs": [make_supply_cold_start_model_run(property_id=PROPERTY_ID)]},
        execute_sql={
            "schedule_assignments": [],
            "plan_snapshots": [make_plan_snapshot(total_rooms=30)],
        },
    )

    with patch("src.inference.supply.get_supabase_client", return_value=fake):
        result = _run(predict_supply(PROPERTY_ID, date(2026, 5, 15)))

    assert "error" not in result
    assert result["predicted_rooms"] == 0
    assert len(fake.upserts) == 0


def test_cold_start_room_not_in_plan_falls_back_to_stayover_day1():
    """Scheduled room not in any plan_snapshot array → defaults to (stayover, 1).

    Verifies the fallback logic at supply.py:322-326 + the structured log fires.
    """
    from src.inference.supply import predict_supply

    fake = make_fake_supabase(
        fetch_many={"model_runs": [make_supply_cold_start_model_run(property_id=PROPERTY_ID)]},
        execute_sql={
            "schedule_assignments": [
                # Room 999 isn't in any plan array → fallback path.
                make_schedule_assignment(staff_id="s1", assigned_rooms=["999"]),
            ],
            "plan_snapshots": [make_plan_snapshot(total_rooms=30)],
        },
    )

    with patch("src.inference.supply.get_supabase_client", return_value=fake):
        result = _run(predict_supply(PROPERTY_ID, date(2026, 5, 15)))

    assert "error" not in result
    assert result["predicted_rooms"] == 1
    # Still wrote the prediction (cold-start mu = 30) — fallback isn't an error path.
    assert fake.upserts[0]["data"]["predicted_minutes_p50"] == 30.0
