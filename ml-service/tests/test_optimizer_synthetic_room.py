"""Tests for the synthetic-room cold-start headcount path (2026-06-18).

When no L2 per-room supply predictions exist (the common case for brand-new
hotels and any pre-schedule planning moment), the optimizer decomposes the L1
total-demand draw into INDIVISIBLE rooms sized by the plan-snapshot composition
and LPT-packs them — instead of assuming work is infinitely divisible.
"""
import json
from datetime import date

import numpy as np
import pytest

import src.optimizer.monte_carlo as mc
from src.optimizer.monte_carlo import (
    _synthetic_room_weights,
    _synthetic_room_completion_prob,
)
from src.layers.static_baseline import (
    CHECKOUT_MINUTES,
    STAYOVER_DAY1_MINUTES,
    STAYOVER_DAY2PLUS_MINUTES,
    VACANT_DIRTY_MINUTES,
)
from tests.conftest import make_fake_supabase

PROP = "d1f8a3b1-1234-5678-9abc-def012345678"
DATE = date(2026, 6, 19)


# ─── _synthetic_room_weights ────────────────────────────────────────────────

def test_weights_one_job_per_room_with_type_minutes():
    w = _synthetic_room_weights({
        "checkouts": 2, "stayover_day_1": 1,
        "stayover_day_2plus": 1, "vacant_dirty": 1,
    })
    assert sorted(w.tolist()) == sorted([
        float(CHECKOUT_MINUTES), float(CHECKOUT_MINUTES),
        float(STAYOVER_DAY1_MINUTES), float(STAYOVER_DAY2PLUS_MINUTES),
        float(VACANT_DIRTY_MINUTES),
    ])
    assert w.size == 5


def test_weights_empty_when_no_rooms():
    assert _synthetic_room_weights({}).size == 0
    assert _synthetic_room_weights({"checkouts": 0}).size == 0


def test_weights_tolerates_garbage_counts():
    w = _synthetic_room_weights({"checkouts": None, "stayover_day_1": "x", "vacant_dirty": 2})
    assert w.size == 2  # only the 2 valid vacant_dirty rooms


# ─── _synthetic_room_completion_prob ────────────────────────────────────────

def test_completion_prob_scales_with_demand():
    # 4 equal rooms, 2 workers → LPT makespan = 2 rooms' worth = D/2.
    # With shift_cap = 100 and D fixed at 200, makespan = 100 → exactly fits.
    weights = np.array([25.0, 25.0, 25.0, 25.0])
    demands = np.full(1000, 200.0)
    assert _synthetic_room_completion_prob(demands, weights, 2, 100.0) == pytest.approx(1.0)
    # Tighten the cap below makespan → nothing fits.
    assert _synthetic_room_completion_prob(demands, weights, 2, 99.0) == pytest.approx(0.0)


def test_completion_prob_indivisibility_vs_divisible():
    # One dominant job: weights [100,1,1] (sum 102), D=204 → room times scale to
    # [200, 2, 2]. On 2 workers LPT makespan = 200 (the big job alone). The
    # divisible view would say D/2 = 102. Indivisibility forces the larger value.
    weights = np.array([100.0, 1.0, 1.0])
    demands = np.full(500, 204.0)
    # makespan 200 > 150 → 0% complete (divisible 102 would have said 100%).
    assert _synthetic_room_completion_prob(demands, weights, 2, 150.0) == pytest.approx(0.0)
    # cap above 200 → completes.
    assert _synthetic_room_completion_prob(demands, weights, 2, 205.0) == pytest.approx(1.0)


def test_completion_prob_empty_weights_zero():
    assert _synthetic_room_completion_prob(np.full(10, 100.0), np.array([]), 2, 100.0) == 0.0


# ─── end-to-end optimize_headcount ──────────────────────────────────────────

def _run(monkeypatch, *, plan_counts, supply_n=0, p50=1800.0, p95=2400.0, shift=420,
         cold_start=True):
    demand_row = {"model_run_id": "demand-run",
                  "predicted_minutes_p50": p50, "predicted_minutes_p95": p95}
    supply_rows = [{"room_number": str(i), "staff_id": None, "model_run_id": "supply-run",
                    "predicted_minutes_p25": 21, "predicted_minutes_p50": 30,
                    "predicted_minutes_p90": 48} for i in range(supply_n)]

    def fetch_one(table, filters=None):
        if table == "properties":
            return {"id": PROP, "shift_minutes": shift}
        if table == "ml_feature_flags":
            return {"target_completion_prob": 0.95}
        if table == "model_runs":
            return {"id": (filters or {}).get("id"), "is_cold_start": cold_start,
                    "algorithm": "cold-start-cohort-prior" if cold_start else "bayesian"}
        return None

    def fetch_many(table, **kw):
        if table == "demand_predictions":
            return [demand_row]
        if table == "supply_predictions":
            return supply_rows
        return []

    execute_sql = {"plan_snapshots": [plan_counts]} if plan_counts else {"plan_snapshots": []}
    fake = make_fake_supabase(fetch_one=fetch_one, fetch_many=fetch_many, execute_sql=execute_sql)
    monkeypatch.setattr(mc, "get_supabase_client", lambda: fake)
    result = __import__("asyncio").run(mc.optimize_headcount(PROP, prediction_date=DATE))
    method = None
    for up in fake.upserts:
        if up["table"] == "optimizer_results":
            method = json.loads(up["data"]["inputs_snapshot"]).get("headcount_method")
    return result, method


def test_e2e_uses_synthetic_room_with_plan(monkeypatch):
    result, method = _run(monkeypatch, plan_counts={
        "checkouts": 25, "stayover_day_1": 18, "stayover_day_2plus": 10, "vacant_dirty": 5,
    })
    assert "error" not in result
    assert method == "synthetic_room"
    assert result["recommended_headcount"] >= 1


def test_e2e_falls_back_to_divisible_without_plan(monkeypatch):
    result, method = _run(monkeypatch, plan_counts=None)
    assert "error" not in result
    assert method == "l1_divisible"
    assert result["recommended_headcount"] >= 1


def test_e2e_uses_l2_when_supply_available(monkeypatch):
    result, method = _run(monkeypatch, plan_counts={"checkouts": 25}, supply_n=60)
    assert method == "l2_supply"


def test_e2e_l2_path_is_deterministic_golden(monkeypatch):
    """Frozen-seed golden for the L2 path: same (property, date) must always
    give the SAME recommended_headcount, and the curve must be monotonic
    non-decreasing. Locks the behavior-preservation of the helper refactor
    against future drift (the optimizer seeds RNG from property_id+date).
    """
    # Fitted models so the completion curve is populated (cold-start omits it).
    r1, _ = _run(monkeypatch, plan_counts={"checkouts": 25}, supply_n=60,
                 p50=1800.0, p95=2400.0, cold_start=False)
    r2, _ = _run(monkeypatch, plan_counts={"checkouts": 25}, supply_n=60,
                 p50=1800.0, p95=2400.0, cold_start=False)
    # Deterministic across runs (seeded RNG).
    assert r1["recommended_headcount"] == r2["recommended_headcount"]
    # Golden value — change this only with an intentional, reviewed model change.
    assert r1["recommended_headcount"] == 5
    curve = r1["completion_probability_curve"]
    assert curve, "fitted L2 run must emit a completion curve"
    ps = [c["p"] for c in curve]
    assert ps == sorted(ps), "completion probability must be non-decreasing in headcount"


def test_e2e_parttime_shift_needs_more_than_divisible(monkeypatch):
    # 4h shift, indivisibility bites → recommended should be >= the divisible
    # ceil(p95/shift) bound.
    import math
    result, method = _run(monkeypatch, plan_counts={
        "checkouts": 25, "stayover_day_1": 18, "stayover_day_2plus": 10, "vacant_dirty": 5,
    }, p50=1200.0, p95=1600.0, shift=240)
    assert method == "synthetic_room"
    assert result["recommended_headcount"] >= math.ceil(1600 / 240)
