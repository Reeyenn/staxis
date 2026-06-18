"""Offline accuracy harness for the inventory_rate model — NO database.

Why this exists
---------------
There is no local Supabase, so we cannot measure real validation MAE the way
the cron does. This harness simulates a hotel's daily inventory life under a
KNOWN ground-truth consumption model, drives the *real* training code
(`_build_training_rows` + the same Bayesian fit / 80-20 split the trainer
uses), and reports:

  * recovered intercept + occupancy slope   (does the model learn occupancy?)
  * validation MAE on a held-out tail        (lower = better)
  * a "constant-mean" baseline MAE           (what a no-occupancy model gets)
  * an "oracle" MAE (model knows true a,b)    (the noise floor)

Run it BEFORE and AFTER a change and compare the numbers. It is deterministic
(seeded), so a diff in the printed table is a real signal, not RNG.

Ground truth: daily usage of an item ~ a + b * occupancy_pct  (+ noise),
which is exactly the linear form the Bayesian model is parameterised to learn
(`usage_rate = intercept + occupancy_pct * slope`). If the model can't recover
b, occupancy is dead as a feature.

Usage:
    .venv/bin/python -m scripts.inventory_offline_eval
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Dict, List

import numpy as np
import pandas as pd

from src.config import INVENTORY_OCC_BASELINE_PCT
from src.layers.bayesian_regression import BayesianRegression
from src.training.inventory_rate import (
    INVENTORY_FEATURE_COLS,
    _build_training_rows,
    _seed_bayesian_intercept,
)


# ───────────────────────── synthetic hotel generator ─────────────────────────

@dataclass
class Scenario:
    name: str
    counts: List[Dict[str, Any]]
    orders: List[Dict[str, Any]]
    discards: List[Dict[str, Any]]
    daily_logs: List[Dict[str, Any]]
    total_rooms: int
    true_a: float
    true_b: float
    prior_rate_per_room: float
    occ_pct_by_day: List[float] = field(default_factory=list)


def _occupancy_pattern(rng: np.random.Generator, n_days: int) -> np.ndarray:
    """Realistic limited-service occupancy: weekday/weekend swing + noise + a
    couple of busy stretches. Returns occupancy FRACTION in [0.2, 1.0]."""
    base = np.empty(n_days)
    for d in range(n_days):
        dow = d % 7
        # Fri/Sat busier for a roadside limited-service hotel.
        weekend = 0.22 if dow in (4, 5) else 0.0
        seasonal = 0.10 * math.sin(2 * math.pi * d / 30.0)  # ~monthly swing
        base[d] = 0.58 + weekend + seasonal
    noise = rng.normal(0.0, 0.06, n_days)
    occ = np.clip(base + noise, 0.20, 1.0)
    return occ


def simulate_hotel(
    *,
    name: str,
    seed: int,
    n_days: int = 160,
    total_rooms: int = 80,
    true_a: float = 2.0,          # baseline units/day at 0% occupancy
    true_b: float = 0.30,         # extra units/day per occupancy-percentage-point
    count_every_days: int = 3,
    noise_frac: float = 0.12,     # multiplicative noise on daily consumption
    restock_threshold: int = 25,
    restock_to: int = 220,
    unlogged_restock_prob: float = 0.0,   # restocks NOT logged as orders (count-up windows)
) -> Scenario:
    """Simulate counts/orders/daily_logs for one hotel under a known model."""
    rng = np.random.default_rng(seed)
    occ_frac = _occupancy_pattern(rng, n_days)
    occ_pct = occ_frac * 100.0

    start = datetime(2026, 1, 1, 9, 0, 0)
    daily_logs: List[Dict[str, Any]] = []
    for d in range(n_days):
        daily_logs.append({
            "date": (start + timedelta(days=d)).date().isoformat(),
            "occupied": int(round(occ_frac[d] * total_rooms)),
        })

    # True daily consumption (never negative).
    true_daily = np.maximum(
        true_a + true_b * occ_pct + rng.normal(0.0, 1.0, n_days) * (true_a + true_b * occ_pct) * noise_frac,
        0.0,
    )

    counts: List[Dict[str, Any]] = []
    orders: List[Dict[str, Any]] = []
    discards: List[Dict[str, Any]] = []

    # Timestamp discipline so a window's (prev + orders − curr)/days is EXACT:
    # orders are logged at noon, counts at 23:00. A same-day restock is thus
    # logged BEFORE the count that already reflects it, so it lands in the
    # window ending at that count (not the next one). Getting this wrong
    # injects spurious rate noise that swamps the occupancy signal.
    stock = float(restock_to)
    for d in range(n_days):
        # consume today
        stock -= float(true_daily[d])
        # restock when low (order logged at noon)
        if stock < restock_threshold:
            qty = restock_to - stock
            if rng.random() < unlogged_restock_prob:
                # Manager bought supplies outside the app — NO order logged.
                # This produces a count-up window (the contamination case).
                pass
            else:
                orders.append({
                    "received_at": (start + timedelta(days=d, hours=3)).isoformat(),  # 12:00
                    "quantity": round(float(qty), 2),
                })
            stock = float(restock_to)
        # take a count every count_every_days, at 23:00 (after consume+restock)
        if d % count_every_days == 0:
            counts.append({
                "counted_at": (start + timedelta(days=d, hours=14)).isoformat(),  # 23:00
                "counted_stock": round(max(stock, 0.0), 2),
            })

    return Scenario(
        name=name, counts=counts, orders=orders, discards=discards,
        daily_logs=daily_logs, total_rooms=total_rooms,
        true_a=true_a, true_b=true_b,
        prior_rate_per_room=(true_a / total_rooms + true_b * 0.6 * 100.0 / total_rooms),
        occ_pct_by_day=occ_pct.tolist(),
    )


# ───────────────────────── evaluation (mirrors trainer) ──────────────────────

@dataclass
class EvalResult:
    n_rows: int
    intercept: float
    slope: float
    val_mae: float
    train_mae: float
    baseline_mean_mae: float   # constant-mean model on the same holdout
    oracle_mae: float          # model that knows true a,b on the same holdout
    mean_rate: float


def evaluate(scn: Scenario, *, prior_strength: float = 0.5) -> EvalResult:
    """Build training rows with the REAL trainer helper, fit the REAL Bayesian
    model the same way `_train_single_item` does, and score a held-out tail."""
    rows = _build_training_rows(scn.counts, scn.orders, scn.discards, scn.daily_logs, scn.total_rooms)
    df = pd.DataFrame(rows)
    df["daily_rate"] = pd.to_numeric(df["daily_rate"], errors="coerce")
    df["occupancy_pct"] = pd.to_numeric(df["occupancy_pct"], errors="coerce").fillna(50.0)
    df = df[df["daily_rate"].notna() & (df["daily_rate"] >= 0)].reset_index(drop=True)

    occ_raw = df["occupancy_pct"].astype(float).values  # raw 0-100 for the oracle
    X = df[INVENTORY_FEATURE_COLS].copy()
    X["occupancy_pct"] = X["occupancy_pct"] - INVENTORY_OCC_BASELINE_PCT  # mirror trainer centering
    y = df["daily_rate"].astype(float)
    X.insert(0, "intercept", 1.0)

    if len(X) >= 5:
        split = int(len(X) * 0.8)
        X_tr, X_te = X.iloc[:split], X.iloc[split:]
        y_tr, y_te = y.iloc[:split], y.iloc[split:]
        occ_te_raw = occ_raw[split:]
    else:
        X_tr, X_te, y_tr, y_te = X, X.iloc[:0], y, y.iloc[:0]
        occ_te_raw = occ_raw[:0]

    model = BayesianRegression(prior_strength=prior_strength)
    _seed_bayesian_intercept(model, scn.prior_rate_per_room, scn.total_rooms)
    model.fit(X_tr, y_tr)

    intercept = float(model.mu_n[0])
    slope = float(model.mu_n[1]) if model.mu_n.shape[0] > 1 else 0.0

    if len(X_te) > 0:
        pred = model.predict(X_te)
        val_mae = float(np.mean(np.abs(pred - y_te.values)))
        mean_rate = float(y_te.mean())
        baseline_mean_mae = float(np.mean(np.abs(y_tr.mean() - y_te.values)))
        oracle = scn.true_a + scn.true_b * occ_te_raw
        oracle_mae = float(np.mean(np.abs(oracle - y_te.values)))
    else:
        val_mae = float("nan"); mean_rate = float(y.mean())
        baseline_mean_mae = float("nan"); oracle_mae = float("nan")

    train_mae = float(np.mean(np.abs(model.predict(X_tr) - y_tr.values)))
    return EvalResult(
        n_rows=len(df), intercept=intercept, slope=slope, val_mae=val_mae,
        train_mae=train_mae, baseline_mean_mae=baseline_mean_mae,
        oracle_mae=oracle_mae, mean_rate=mean_rate,
    )


SCENARIOS = [
    dict(name="amenity-occ-driven", seed=1, true_a=1.0, true_b=0.35, total_rooms=80),
    dict(name="coffee-high-volume", seed=2, true_a=3.0, true_b=0.55, total_rooms=120),
    dict(name="towels-low-base", seed=3, true_a=0.5, true_b=0.22, total_rooms=60),
    dict(name="paper-steady", seed=4, true_a=6.0, true_b=0.10, total_rooms=100),
]


def main() -> None:
    print(f"\n{'scenario':22} {'rows':>4} {'true_b':>7} {'slope':>8} "
          f"{'val_mae':>8} {'mean_base':>9} {'oracle':>7} {'vs_base':>8}")
    print("-" * 86)
    agg = {"val": [], "base": [], "oracle": [], "slope_err": []}
    for cfg in SCENARIOS:
        scn = simulate_hotel(**cfg)
        r = evaluate(scn)
        improve = (r.baseline_mean_mae - r.val_mae) / r.baseline_mean_mae * 100 if r.baseline_mean_mae else float("nan")
        print(f"{scn.name:22} {r.n_rows:>4} {scn.true_b:>7.2f} {r.slope:>8.3f} "
              f"{r.val_mae:>8.3f} {r.baseline_mean_mae:>9.3f} {r.oracle_mae:>7.3f} {improve:>7.1f}%")
        agg["val"].append(r.val_mae); agg["base"].append(r.baseline_mean_mae)
        agg["oracle"].append(r.oracle_mae); agg["slope_err"].append(abs(r.slope - scn.true_b))
    print("-" * 86)
    print(f"{'MEAN':22} {'':>4} {'':>7} "
          f"{'':>8} {np.mean(agg['val']):>8.3f} {np.mean(agg['base']):>9.3f} "
          f"{np.mean(agg['oracle']):>7.3f}")
    print(f"\nmean |slope - true_b| = {np.mean(agg['slope_err']):.3f}  "
          f"(0 = perfectly recovers occupancy effect; ~true_b = occupancy is dead)\n")


if __name__ == "__main__":
    main()
