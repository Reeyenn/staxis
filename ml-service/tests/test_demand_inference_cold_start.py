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

    # 2026-06-18: cold-start demand is now COMPOSITION-AWARE (industry per-type
    # minutes applied to tomorrow's room mix), not flat prior×rooms. The default
    # make_plan_snapshot is 10 checkout, 8 stayover-day1, 5 stayover-day2+,
    # 2 vacant-dirty → 10·30 + 8·15 + 5·20 + 2·30 = 580.
    expected_mu = 10 * 30 + 8 * 15 + 5 * 20 + 2 * 30  # 580
    assert result["predicted_minutes_p50"] == expected_mu

    # Exactly one upsert to demand_predictions with the right contract.
    assert len(fake.upserts) == 1
    upsert = fake.upserts[0]
    assert upsert["table"] == "demand_predictions"
    assert upsert["on_conflict"] == "property_id,date,model_run_id"

    payload = upsert["data"]
    assert payload["predicted_minutes_p50"] == expected_mu
    assert payload["model_run_id"] == "demand-mr-uuid"
    assert payload["features_snapshot"]  # non-empty JSON
    assert "composition" in payload["features_snapshot"]  # basis recorded


def test_cold_start_quantile_bands_use_expected_multipliers():
    """Cold-start branch produces quantile bands at fixed mu × {0.5, 0.7, 1.0, 1.3, 1.6, 1.8}.

    These multipliers are the wide-band signal an operator should treat with
    humility. Pinning them prevents accidental tightening in a future refactor.
    """
    from src.inference.demand import predict_demand

    # Explicit single-type composition (5 checkouts) on a 10-room hotel whose
    # 5 occupied rooms are all the checkouts → composition covers occupancy
    # (passes the partial-data guard), base mu = 5 × 30 = 150. The multiplier
    # structure is what this test pins.
    fake = make_fake_supabase(
        fetch_many={"model_runs": [make_demand_cold_start_model_run(
            property_id=PROPERTY_ID, prior=20.0, cohort_key="industry-default")]},
        execute_sql={"plan_snapshots": [make_plan_snapshot(
            total_rooms=10, checkouts=5, stayover_day1=0, stayover_day2=0,
            vacant_dirty=0, vacant_clean=5, ooo=0)]},
    )

    with patch("src.inference.demand.get_supabase_client", return_value=fake):
        _run(predict_demand(PROPERTY_ID, date(2026, 5, 15)))

    mu = 5 * 30  # composition: 5 checkouts × 30 min = 150
    payload = fake.upserts[0]["data"]
    assert payload["predicted_minutes_p10"] == mu * 0.5
    assert payload["predicted_minutes_p25"] == mu * 0.7
    assert payload["predicted_minutes_p50"] == mu
    assert payload["predicted_minutes_p75"] == mu * 1.3
    assert payload["predicted_minutes_p90"] == mu * 1.6
    assert payload["predicted_minutes_p95"] == mu * 1.8


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

    # Composition is present (default plan) so the point estimate comes from the
    # room mix, not the prior — but the corrupt posterior must not crash. The
    # prior=20.0 fallback only governs the no-composition flat path (tested in
    # test_cold_start_flat_fallback_when_no_composition).
    fake = make_fake_supabase(
        fetch_many={"model_runs": [bad_model]},
        execute_sql={"plan_snapshots": [make_plan_snapshot(total_rooms=10)]},
    )

    with patch("src.inference.demand.get_supabase_client", return_value=fake):
        result = _run(predict_demand(PROPERTY_ID, date(2026, 5, 15)))

    assert "error" not in result
    # Composition basis: 10·30 + 8·15 + 5·20 + 2·30 = 580 (no crash on corrupt posterior).
    assert result["predicted_minutes_p50"] == 580.0


def test_cold_start_composition_aware_checkout_vs_stayover():
    """A checkout-heavy day must predict MORE minutes than a stayover-heavy day
    at the SAME total room count — the core composition-awareness win.
    """
    from src.inference.demand import predict_demand

    def predict_with(checkouts, stay1):
        fake = make_fake_supabase(
            fetch_many={"model_runs": [make_demand_cold_start_model_run(
                property_id=PROPERTY_ID, prior=20.0)]},
            execute_sql={"plan_snapshots": [make_plan_snapshot(
                total_rooms=40, checkouts=checkouts, stayover_day1=stay1,
                stayover_day2=0, vacant_dirty=0)]},
        )
        with patch("src.inference.demand.get_supabase_client", return_value=fake):
            return _run(predict_demand(PROPERTY_ID, date(2026, 5, 15)))

    checkout_heavy = predict_with(checkouts=20, stay1=4)   # 20·30 + 4·15 = 660
    stayover_heavy = predict_with(checkouts=4, stay1=20)   # 4·30 + 20·15 = 420
    assert checkout_heavy["predicted_minutes_p50"] == 660.0
    assert stayover_heavy["predicted_minutes_p50"] == 420.0
    assert checkout_heavy["predicted_minutes_p50"] > stayover_heavy["predicted_minutes_p50"]


def test_cold_start_flat_fallback_when_no_composition():
    """No cleanable-room composition (all zero) → fall back to cohort flat
    estimate (prior × total_rooms) so the day-1 number is never blank.
    """
    from src.inference.demand import predict_demand

    fake = make_fake_supabase(
        fetch_many={"model_runs": [make_demand_cold_start_model_run(
            property_id=PROPERTY_ID, prior=22.0)]},
        execute_sql={"plan_snapshots": [make_plan_snapshot(
            total_rooms=30, checkouts=0, stayover_day1=0, stayover_day2=0,
            vacant_dirty=0)]},
    )

    with patch("src.inference.demand.get_supabase_client", return_value=fake):
        result = _run(predict_demand(PROPERTY_ID, date(2026, 5, 15)))

    assert "error" not in result
    # Flat fallback: prior 22 × 30 rooms = 660.
    assert result["predicted_minutes_p50"] == 660.0
    assert "flat_cohort" in fake.upserts[0]["data"]["features_snapshot"]


def test_cold_start_partial_composition_does_not_underpredict():
    """Incomplete plan data (only checkouts captured among many occupied rooms)
    must NOT under-staff — the partial-data guard falls back to max(composition,
    cohort flat) so a missing stayover column can't collapse the demand estimate.
    """
    from src.inference.demand import predict_demand

    # 60-room hotel, 53 occupied, but only 10 checkouts captured (stayover
    # columns missing/zero) → composition covers 12 of 53 occupied → suspected
    # partial. composition minutes = 10·30 + 2·30(vacant) = 360; flat = 20·60 =
    # 1200. Guard must take the max (1200), not the under-counted 360.
    fake = make_fake_supabase(
        fetch_many={"model_runs": [make_demand_cold_start_model_run(
            property_id=PROPERTY_ID, prior=20.0)]},
        execute_sql={"plan_snapshots": [make_plan_snapshot(
            total_rooms=60, checkouts=10, stayover_day1=0, stayover_day2=0,
            vacant_dirty=2, vacant_clean=3, ooo=2)]},
    )

    with patch("src.inference.demand.get_supabase_client", return_value=fake):
        result = _run(predict_demand(PROPERTY_ID, date(2026, 5, 15)))

    assert "error" not in result
    assert result["predicted_minutes_p50"] == 1200.0  # flat, not 360
    assert "flat_cohort_partial" in fake.upserts[0]["data"]["features_snapshot"]


def test_headcount_bands_use_per_property_shift_minutes():
    """predicted_headcount_* must divide by the property's shift_minutes, not the
    global 420 default — a hotel on an 8h shift should get a LOWER headcount band.
    """
    from src.inference.demand import predict_demand
    import math

    def headcounts_for(shift_minutes):
        fake = make_fake_supabase(
            fetch_one={"properties": {"id": PROPERTY_ID, "shift_minutes": shift_minutes}},
            fetch_many={"model_runs": [make_demand_cold_start_model_run(
                property_id=PROPERTY_ID, prior=20.0)]},
            # 40 checkouts → mu = 40 × 30 = 1200; p95 = 1200 × 1.8 = 2160.
            execute_sql={"plan_snapshots": [make_plan_snapshot(
                total_rooms=60, checkouts=40, stayover_day1=0, stayover_day2=0,
                vacant_dirty=0)]},
        )
        with patch("src.inference.demand.get_supabase_client", return_value=fake):
            _run(predict_demand(PROPERTY_ID, date(2026, 5, 15)))
        return fake.upserts[0]["data"]

    eight_hr = headcounts_for(480)
    seven_hr = headcounts_for(420)
    # p95 minutes = 2160 → ceil(2160/480)=5 vs ceil(2160/420)=6.
    assert eight_hr["predicted_headcount_p95"] == math.ceil(2160 / 480)  # 5
    assert seven_hr["predicted_headcount_p95"] == math.ceil(2160 / 420)  # 6
    assert eight_hr["predicted_headcount_p95"] < seven_hr["predicted_headcount_p95"]
