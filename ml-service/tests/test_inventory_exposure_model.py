"""Tests for the reduced-exposure inventory model math.

Covers:
  * κ composition (usage_per_stayover / usage_per_checkout, fallback, clamp)
  * item-family routing (exposure vs occupancy)
  * exposure window building + contamination filters
  * window-completeness dropping (NULL daily_logs day → drop + count)
  * row weights w = 1/(σ_d²·d + 2τ²)
  * train→serve round-trip recovers the true s with base pinned at 0

Pure-function tests — no Supabase.
"""
import datetime as dt

import numpy as np
import pandas as pd

from src.config import INVENTORY_DEFAULT_KAPPA
from src.layers.bayesian_regression import BayesianRegression
from src.inference.inventory_rate import (
    _exposure_s_coefficient,
    _predict_exposure_quantiles,
)
from src.training._exposure import (
    build_exposure_rows,
    compose_exposure,
    row_weight,
    window_exposure,
    _daily_exposure_index,
)
from src.training._item_family import (
    resolve_kappa,
    route_item_family,
    OCCUPANCY_CANONICALS,
)


# ───────────────────────── kappa ─────────────────────────

def test_kappa_from_usage_fields():
    assert resolve_kappa({"usage_per_checkout": 4.0, "usage_per_stayover": 2.0}, 0.3) == 0.5


def test_kappa_falls_back_when_checkout_zero():
    assert resolve_kappa({"usage_per_checkout": 0.0, "usage_per_stayover": 2.0}, 0.3) == 0.3


def test_kappa_falls_back_when_field_missing():
    assert resolve_kappa({"usage_per_checkout": 4.0}, 0.3) == 0.3
    assert resolve_kappa({}, 0.3) == 0.3


def test_kappa_falls_back_on_non_numeric():
    assert resolve_kappa({"usage_per_checkout": "x", "usage_per_stayover": 2.0}, 0.3) == 0.3


def test_kappa_clamped_to_ceiling():
    # 100/1 would be 100 → clamp to 5.0
    assert resolve_kappa({"usage_per_checkout": 1.0, "usage_per_stayover": 100.0}, 0.3) == 5.0


def test_kappa_default_constant_is_030():
    assert INVENTORY_DEFAULT_KAPPA == 0.30


# ───────────────────────── family routing ─────────────────────────

def test_route_guest_consumable_is_exposure():
    assert route_item_family({"category": "housekeeping", "name": "Shampoo"}, "shampoo") == "exposure"
    assert route_item_family({"category": "housekeeping", "name": "Bath Towel"}, "towel bath") == "exposure"


def test_route_breakfast_is_exposure():
    assert route_item_family({"category": "breakfast", "name": "Coffee Pods"}, "coffee pod") == "exposure"


def test_route_maintenance_is_occupancy():
    assert route_item_family({"category": "maintenance", "name": "LED Bulb"}, "unknown") == "occupancy"


def test_route_cleaning_canonical_is_occupancy():
    assert route_item_family({"category": "housekeeping", "name": "APC"}, "all-purpose cleaner") == "occupancy"
    assert route_item_family({"category": "housekeeping", "name": "Liners"}, "garbage bag") == "occupancy"


def test_route_unknown_amenity_defaults_to_exposure():
    assert route_item_family({"category": "housekeeping", "name": "Mystery Amenity"}, "unknown") == "exposure"


def test_route_unknown_bulb_keyword_is_occupancy():
    assert route_item_family({"category": "housekeeping", "name": "Replacement bulb 60w"}, "unknown") == "occupancy"


def test_occupancy_canonicals_contents():
    assert "all-purpose cleaner" in OCCUPANCY_CANONICALS
    assert "garbage bag" in OCCUPANCY_CANONICALS
    assert "shampoo" not in OCCUPANCY_CANONICALS


# ───────────────────────── exposure composition + weight ─────────────────────────

def test_compose_exposure():
    assert compose_exposure(10, 30, 0.3) == 10 + 0.3 * 30


def test_row_weight_shrinks_with_days():
    # w = 1/(1*d + 2*1); a 2-day window weighs more than a 6-day window
    w2 = row_weight(2, 1.0, 1.0)
    w6 = row_weight(6, 1.0, 1.0)
    assert w2 > w6
    assert abs(w2 - 1.0 / (2 + 2)) < 1e-12
    assert abs(w6 - 1.0 / (6 + 2)) < 1e-12


def test_row_weight_never_zero_or_negative():
    assert row_weight(0, 0.0, 0.0) > 0


# ───────────────────────── window completeness ─────────────────────────

LOGS_FULL = [
    {"date": "2026-01-02", "checkouts": 10, "stayovers": 30},
    {"date": "2026-01-03", "checkouts": 8, "stayovers": 28},
    {"date": "2026-01-04", "checkouts": 12, "stayovers": 32},
]
COUNTS = [
    {"counted_at": "2026-01-01T23:00:00", "counted_stock": 100},
    {"counted_at": "2026-01-04T23:00:00", "counted_stock": 80},
]


def test_complete_window_kept():
    rows, dropped = build_exposure_rows(COUNTS, [], [], LOGS_FULL, 0.3, 1.0, 1.0)
    assert len(rows) == 1
    assert dropped == 0
    # exposure = sum(CO) + 0.3*sum(SO) = 30 + 0.3*90 = 57
    assert abs(rows[0]["exposure"] - (30 + 0.3 * 90)) < 1e-9
    # consumption = 100 - 80 = 20
    assert abs(rows[0]["consumption"] - 20.0) < 1e-9


def test_null_checkouts_day_drops_window():
    logs = [
        {"date": "2026-01-02", "checkouts": 10, "stayovers": 30},
        {"date": "2026-01-03", "checkouts": None, "stayovers": 28},  # NULL
        {"date": "2026-01-04", "checkouts": 12, "stayovers": 32},
    ]
    rows, dropped = build_exposure_rows(COUNTS, [], [], logs, 0.3, 1.0, 1.0)
    assert rows == []
    assert dropped == 1


def test_missing_day_drops_window():
    logs = [
        {"date": "2026-01-02", "checkouts": 10, "stayovers": 30},
        # 2026-01-03 entirely absent
        {"date": "2026-01-04", "checkouts": 12, "stayovers": 32},
    ]
    rows, dropped = build_exposure_rows(COUNTS, [], [], logs, 0.3, 1.0, 1.0)
    assert rows == []
    assert dropped == 1


def test_window_exposure_direct():
    idx = _daily_exposure_index(LOGS_FULL)
    got = window_exposure(idx, pd.Timestamp("2026-01-01T23:00:00"), pd.Timestamp("2026-01-04T23:00:00"))
    assert got == (30.0, 90.0)


# ───────────────────────── contamination filters ─────────────────────────

def test_sub_day_pair_dropped_and_not_counted_as_incomplete():
    counts = [
        {"counted_at": "2026-01-04T09:00:00", "counted_stock": 100},
        {"counted_at": "2026-01-04T11:00:00", "counted_stock": 90},
    ]
    rows, dropped = build_exposure_rows(counts, [], [], LOGS_FULL, 0.3, 1.0, 1.0)
    assert rows == []
    assert dropped == 0  # sub-day is not an incomplete-window drop


def test_unexplained_increase_dropped():
    counts = [
        {"counted_at": "2026-01-01T23:00:00", "counted_stock": 80},
        {"counted_at": "2026-01-04T23:00:00", "counted_stock": 120},  # rose, no order
    ]
    rows, dropped = build_exposure_rows(counts, [], [], LOGS_FULL, 0.3, 1.0, 1.0)
    assert rows == []


def test_genuine_zero_usage_kept():
    counts = [
        {"counted_at": "2026-01-01T23:00:00", "counted_stock": 100},
        {"counted_at": "2026-01-04T23:00:00", "counted_stock": 100},  # flat, nothing used
    ]
    rows, dropped = build_exposure_rows(counts, [], [], LOGS_FULL, 0.3, 1.0, 1.0)
    assert len(rows) == 1
    assert rows[0]["consumption"] == 0.0


def test_orders_in_window_added_to_consumption():
    counts = [
        {"counted_at": "2026-01-01T23:00:00", "counted_stock": 50},
        {"counted_at": "2026-01-04T23:00:00", "counted_stock": 40},
    ]
    orders = [{"received_at": "2026-01-03T12:00:00", "quantity": 30}]
    rows, _ = build_exposure_rows(counts, orders, [], LOGS_FULL, 0.3, 1.0, 1.0)
    # consumption = 50 + 30 - 0 - 40 = 40
    assert abs(rows[0]["consumption"] - 40.0) < 1e-9


# ───────────────────────── train→serve round-trip ─────────────────────────

def test_exposure_train_serve_recovers_s_with_base_zero():
    """Fit through the real BayesianRegression with the pinned-intercept prior;
    serve through the real inference quantile fn; recover s and confirm base≈0."""
    kappa = 0.3
    s_true = 0.5
    base = dt.date(2026, 1, 1)
    rng = np.random.default_rng(1)
    logs = []
    idx_dates = []
    for i in range(40):
        d = base + dt.timedelta(days=i)
        logs.append({"date": d.isoformat(), "checkouts": int(rng.integers(5, 15)),
                     "stayovers": int(rng.integers(20, 40))})
        idx_dates.append(d)
    logs_newest_first = list(reversed(logs))
    idx = _daily_exposure_index(logs_newest_first)

    counts = [{"counted_at": base.isoformat() + "T23:00:00", "counted_stock": 1000.0}]
    for k in range(4, 40, 4):
        cd = base + dt.timedelta(days=k)
        t_prev = pd.Timestamp(counts[-1]["counted_at"]).tz_localize(None)
        t_curr = pd.Timestamp(cd.isoformat() + "T23:00:00")
        exp = window_exposure(idx, t_prev, t_curr)
        consumed = s_true * compose_exposure(exp[0], exp[1], kappa)
        counts.append({"counted_at": cd.isoformat() + "T23:00:00",
                       "counted_stock": counts[-1]["counted_stock"] - consumed})

    rows, dropped = build_exposure_rows(counts, [], [], logs_newest_first, kappa, 1.0, 1.0)
    assert dropped == 0
    df = pd.DataFrame(rows)
    X = df[["exposure"]].astype(float).copy()
    X.insert(0, "intercept", 1.0)
    y = df["consumption"].astype(float)
    w = df["weight"].astype(float).values

    model = BayesianRegression(
        prior_strength=0.5,
        prior_mean=np.array([0.0, 0.4]),
        prior_variance=np.array([1e-6, 2.0]),
    )
    model.fit(X, y, sample_weight=w)
    # base pinned near 0, s recovered near 0.5
    assert abs(model.mu_n[0]) < 0.01
    assert abs(model.mu_n[1] - s_true) < 0.05

    params = {
        "mu_n": model.mu_n.tolist(),
        "sigma_n": model.sigma_n.tolist(),
        "alpha_n": float(model.alpha_n),
        "beta_n": float(model.beta_n),
        "kappa": kappa,
    }
    assert abs(_exposure_s_coefficient(params) - s_true) < 0.05
    # serve at exposure 19 (co=10, so=30) → ~9.5
    q = _predict_exposure_quantiles(params, 10 + kappa * 30)
    assert abs(q["p50"] - s_true * (10 + kappa * 30)) < 0.5
    assert q["p10"] <= q["p50"] <= q["p90"]
