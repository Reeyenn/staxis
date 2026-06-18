"""Synthetic demand-accuracy benchmark (offline, no DB).

Generates realistic daily housekeeping data for a hotel under a known
data-generating process, then measures out-of-sample MAE for the candidate
demand models (StaticBaseline rules vs the Bayesian conjugate model). This is
the "before/after" yardstick for ANY accuracy change to Layer 1 demand.

It is a DEV TOOL, not a test. Run:
    .venv311/bin/python -m scripts.hk_demand_backtest_synth

The generated process intentionally differs a little from the static
baseline's fixed per-room minutes and adds day-of-week, a mild high-occupancy
slowdown, and occasional spike days + lognormal noise — so a model that
LEARNS the hotel's own coefficients should beat the fixed rules.
"""
import os
import sys

os.environ.setdefault("SUPABASE_URL", "https://placeholder.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "placeholder-service-role-key")
os.environ.setdefault("ML_SERVICE_SECRET", "placeholder-secret-12345")

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from src.layers.bayesian_regression import BayesianRegression  # noqa: E402
from src.layers.static_baseline import StaticBaseline  # noqa: E402

DEMAND_FEATURE_COLS = [
    "total_checkouts",
    "stayover_day_1_count",
    "stayover_day_2plus_count",
    "vacant_dirty_count",
    "occupancy_pct",
    "day_of_week",
]


def generate_hotel(rooms: int, days: int, seed: int) -> pd.DataFrame:
    """Generate `days` of daily room-mix + true total cleaning minutes."""
    rng = np.random.default_rng(seed)
    # This hotel's TRUE per-type minutes (the thing a learned model should
    # recover; deliberately != the static baseline's 30/15/20/30).
    t_checkout = rng.uniform(26, 36)
    t_stay1 = rng.uniform(11, 17)
    t_stay2 = rng.uniform(18, 25)
    t_vacant = rng.uniform(24, 34)

    rows = []
    for d in range(days):
        dow = d % 7  # 0..6
        # Occupancy oscillates weekly + noise; weekends busier.
        base_occ = 0.55 + 0.20 * (1 if dow in (4, 5) else 0) + rng.normal(0, 0.08)
        occ = float(np.clip(base_occ, 0.05, 0.99))
        occupied = int(round(occ * rooms))
        # Of occupied rooms, a fraction check out (heavier on Sun/Mon/Fri).
        checkout_frac = 0.35 + (0.15 if dow in (0, 4, 6) else 0.0) + rng.normal(0, 0.05)
        checkout_frac = float(np.clip(checkout_frac, 0.05, 0.9))
        checkouts = int(round(occupied * checkout_frac))
        remaining = max(0, occupied - checkouts)
        stay1 = int(round(remaining * float(np.clip(0.5 + rng.normal(0, 0.08), 0.1, 0.9))))
        stay2 = max(0, remaining - stay1)
        vacant_dirty = int(round(max(0, rooms - occupied) * float(np.clip(0.15 + rng.normal(0, 0.05), 0, 0.5))))

        # TRUE minutes: per-type times + mild high-occupancy slowdown
        # (cart congestion) + occasional spike day + lognormal noise.
        slowdown = 1.0 + 0.12 * max(0.0, occ - 0.85) / 0.15  # up to +12% near full
        base_minutes = (
            checkouts * t_checkout
            + stay1 * t_stay1
            + stay2 * t_stay2
            + vacant_dirty * t_vacant
        ) * slowdown
        spike = 1.0
        if rng.uniform() < 0.03:  # ~3% spike days (group checkout, deep cleans)
            spike = rng.uniform(1.3, 1.8)
        noise = float(np.exp(rng.normal(0, 0.10)))  # multiplicative lognormal
        true_minutes = max(0.0, base_minutes * spike * noise)

        rows.append({
            "total_checkouts": checkouts,
            "stayover_day_1_count": stay1,
            "stayover_day_2plus_count": stay2,
            "vacant_dirty_count": vacant_dirty,
            "occupancy_pct": round(100.0 * occupied / rooms, 2),
            "day_of_week": dow,
            "target_minutes": true_minutes,
        })
    return pd.DataFrame(rows)


def mae(pred, actual) -> float:
    return float(np.mean(np.abs(np.asarray(pred) - np.asarray(actual))))


def evaluate(df: pd.DataFrame) -> dict:
    X = df[DEMAND_FEATURE_COLS].astype(float)
    y = df["target_minutes"].astype(float)
    X = pd.concat([pd.Series(np.ones(len(X)), name="intercept"), X], axis=1)
    split = int(len(X) * 0.8)
    Xtr, Xte = X.iloc[:split], X.iloc[split:]
    ytr, yte = y.iloc[:split], y.iloc[split:]

    static = StaticBaseline()
    static.fit(Xtr, ytr)
    static_mae = mae(static.predict(Xte), yte.values)

    bayes = BayesianRegression()
    bayes.fit(Xtr, ytr)
    bayes_mae = mae(bayes.predict(Xte), yte.values)

    mean_actual = float(np.mean(np.abs(yte.values))) or 1.0
    return {
        "n": len(df),
        "mean_actual": mean_actual,
        "static_mae": static_mae,
        "bayes_mae": bayes_mae,
        "static_ratio": static_mae / mean_actual,
        "bayes_ratio": bayes_mae / mean_actual,
        "improve_pct": 100.0 * (static_mae - bayes_mae) / static_mae if static_mae else 0.0,
    }


def main() -> int:
    configs = [
        ("small-30rm-180d", 30, 180, 1),
        ("small-30rm-365d", 30, 365, 2),
        ("mid-90rm-180d", 90, 180, 3),
        ("mid-90rm-365d", 90, 365, 4),
        ("large-200rm-365d", 200, 365, 5),
    ]
    print(f"{'config':<20} {'n':>4} {'meanMin':>8} {'staticMAE':>10} {'bayesMAE':>9} "
          f"{'staticR':>8} {'bayesR':>7} {'bayes>static%':>13}")
    print("-" * 92)
    for name, rooms, days, seed in configs:
        df = generate_hotel(rooms, days, seed)
        r = evaluate(df)
        print(f"{name:<20} {r['n']:>4} {r['mean_actual']:>8.0f} {r['static_mae']:>10.1f} "
              f"{r['bayes_mae']:>9.1f} {r['static_ratio']:>8.3f} {r['bayes_ratio']:>7.3f} "
              f"{r['improve_pct']:>12.1f}%")
    print("-" * 92)
    print("staticR/bayesR = MAE / mean daily minutes (lower is better). "
          "Activation gate wants ratio < 0.10 and bayes beats static by >= 20%.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
