"""Regression tests for the inventory_rate occupancy feature.

These lock in the fix for the dead-occupancy bug: the trainer/inference used to
read a non-existent `daily_logs.occupancy_pct` column, so occupancy was always
the 50.0 default and the model could not learn `rate = a + b·occupancy`.

Pure-function tests — no Supabase, no network.
"""
import numpy as np
import pandas as pd

from src.config import INVENTORY_OCC_BASELINE_PCT
from src.inference.inventory_rate import (
    _predict_bayesian_quantiles,
    _recent_avg_occupancy,
)
from src.training.inventory_rate import (
    _avg_occupancy_in_window,
    _build_training_rows,
    _occ_pct_from_log,
)


# ───────────────────────── trainer occupancy derivation ──────────────────────

def test_occ_pct_from_log_derives_from_occupied():
    # 48 occupied of 80 rooms = 60%
    assert _occ_pct_from_log({"occupied": 48}, 80.0) == 60.0


def test_occ_pct_from_log_prefers_explicit_pct_when_present():
    # If a future schema adds occupancy_pct, it wins over the derived value.
    assert _occ_pct_from_log({"occupied": 10, "occupancy_pct": 73.0}, 80.0) == 73.0


def test_occ_pct_from_log_none_without_occupied():
    assert _occ_pct_from_log({"checkouts": 5}, 80.0) is None


def test_occ_pct_from_log_clamps_to_0_100():
    assert _occ_pct_from_log({"occupied": 200}, 80.0) == 100.0


def test_avg_occupancy_window_derives_and_varies():
    """The window average must reflect occupied/total_rooms, NOT a flat 50."""
    logs = [
        {"date": "2026-01-02", "occupied": 40},   # 50%
        {"date": "2026-01-03", "occupied": 72},   # 90%
        {"date": "2026-01-04", "occupied": 56},   # 70%
    ]
    # Prior count at Jan-1 23:00 → half-open window (Jan-1, Jan-4] covers
    # Jan-2/3/4. Exclusive start keeps the prior boundary date out.
    start = pd.Timestamp("2026-01-01T23:00:00")
    end = pd.Timestamp("2026-01-04T23:00:00")
    avg = _avg_occupancy_in_window(logs, start, end, total_rooms=80)
    assert avg == (50.0 + 90.0 + 70.0) / 3.0  # 70.0 — not the dead 50.0 default


def test_avg_occupancy_window_defaults_50_when_no_overlap():
    logs = [{"date": "2025-12-01", "occupied": 40}]
    avg = _avg_occupancy_in_window(
        logs, pd.Timestamp("2026-01-02"), pd.Timestamp("2026-01-04"), total_rooms=80
    )
    assert avg == 50.0


def test_build_training_rows_occupancy_not_constant():
    """End-to-end: varying occupied → varying occupancy_pct in the rows.

    The pre-fix behaviour produced a constant 50.0 occupancy column (dead
    feature); this asserts it now varies with the underlying occupancy.
    """
    total_rooms = 80
    counts = [
        {"counted_at": "2026-01-01T23:00:00", "counted_stock": 200},
        {"counted_at": "2026-01-05T23:00:00", "counted_stock": 160},
        {"counted_at": "2026-01-09T23:00:00", "counted_stock": 120},
    ]
    # Window 1 (Jan 2-5) low occupancy; window 2 (Jan 6-9) high occupancy.
    daily_logs = [
        {"date": "2026-01-02", "occupied": 32},  # 40%
        {"date": "2026-01-03", "occupied": 32},
        {"date": "2026-01-04", "occupied": 32},
        {"date": "2026-01-05", "occupied": 32},
        {"date": "2026-01-06", "occupied": 72},  # 90%
        {"date": "2026-01-07", "occupied": 72},
        {"date": "2026-01-08", "occupied": 72},
        {"date": "2026-01-09", "occupied": 72},
    ]
    rows = _build_training_rows(counts, [], [], daily_logs, total_rooms)
    occ = [r["occupancy_pct"] for r in rows]
    assert len(occ) == 2
    assert occ[0] != occ[1]                      # NOT a dead constant
    assert occ[0] == 40.0 and occ[1] == 90.0     # exact derived values


# ───────────────────────── inference occupancy + centering ───────────────────

def test_recent_avg_occupancy_derives_from_occupied():
    logs = [{"occupied": 40}, {"occupied": 60}]   # 50%, 75% of 80
    assert _recent_avg_occupancy(logs, total_rooms=80) == (50.0 + 75.0) / 2.0


def test_recent_avg_occupancy_neutral_without_total_rooms():
    logs = [{"occupied": 40}, {"occupied": 60}]
    assert _recent_avg_occupancy(logs, total_rooms=None) == 50.0
    assert _recent_avg_occupancy(logs, total_rooms=0) == 50.0


def test_bayesian_quantiles_are_occupancy_centered():
    """p50 at baseline occupancy must equal the intercept; the slope effect
    is measured relative to the baseline (proves serve-time centering)."""
    # Posterior: intercept=20 units/day at baseline, slope=0.5 units / occ-pt.
    # sigma_n tiny so the quantile spread is negligible and p50 ≈ mean.
    params = {
        "mu_n": [20.0, 0.5],
        "sigma_n": [[1e-9, 0.0], [0.0, 1e-9]],
        "alpha_n": 1e6,
        "beta_n": 1e6,  # beta/alpha ≈ 1, but sigma term dominates → tiny var
    }
    at_base = _predict_bayesian_quantiles(params, INVENTORY_OCC_BASELINE_PCT)
    at_plus10 = _predict_bayesian_quantiles(params, INVENTORY_OCC_BASELINE_PCT + 10.0)
    # At baseline occupancy the centered feature is 0 → mean == intercept.
    assert abs(at_base["p50"] - 20.0) < 0.5
    # +10 occupancy points → +10*slope = +5 units.
    assert at_plus10["p50"] - at_base["p50"] > 3.0
