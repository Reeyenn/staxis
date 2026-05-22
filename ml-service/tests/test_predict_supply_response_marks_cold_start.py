"""Phase 1.1b (2026-05-22) — predict_supply response carries the
algorithm + is_cold_start flag.

Mirror of test_predict_demand_response_marks_cold_start.py for the L2
supply path. Same honesty bug, same fix shape, but supply's success
return is at the bottom of the file (line ~582) and the cold-start
branch writes per-(room, staff) rows.
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

PROPERTY_ID = "8a041d6e-d881-4f19-83e0-7250f0e36eaa"
STAFF = "11111111-1111-1111-1111-111111111111"


def _run(coro):
    return asyncio.run(coro)


def test_response_includes_algorithm_and_is_cold_start_for_cold_start_model():
    from src.inference.supply import predict_supply

    fake = make_fake_supabase(
        fetch_many={"model_runs": [make_supply_cold_start_model_run(
            property_id=PROPERTY_ID, prior=30.0)]},
        fetch_one={"schedule_assignments": make_schedule_assignment(
            staff_id=STAFF, assigned_rooms=["101"])},
        execute_sql={
            "plan_snapshots": [make_plan_snapshot(
                total_rooms=30, checkout_room_numbers=["101"])],
        },
    )

    with patch("src.inference.supply.get_supabase_client", return_value=fake):
        result = _run(predict_supply(PROPERTY_ID, date(2026, 5, 15)))

    assert "error" not in result, f"unexpected error: {result!r}"
    assert result["algorithm"] == "cold-start-cohort-prior"
    assert result["is_cold_start"] is True


def test_response_empty_schedule_still_carries_algorithm():
    """The early "predicted_rooms=0" path also flows the honesty fields."""
    from src.inference.supply import predict_supply

    fake = make_fake_supabase(
        fetch_many={"model_runs": [make_supply_cold_start_model_run(
            property_id=PROPERTY_ID)]},
        fetch_one={"schedule_assignments": None},  # no schedule for the date
        execute_sql={
            "plan_snapshots": [make_plan_snapshot(total_rooms=30)],
        },
    )

    with patch("src.inference.supply.get_supabase_client", return_value=fake):
        result = _run(predict_supply(PROPERTY_ID, date(2026, 5, 15)))

    assert "error" not in result
    assert result["predicted_rooms"] == 0
    assert result["algorithm"] == "cold-start-cohort-prior"
    assert result["is_cold_start"] is True
