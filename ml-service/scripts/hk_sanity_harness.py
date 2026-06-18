"""Housekeeping ML sanity / before-after harness (offline, no DB).

Drives the REAL inference + optimizer code paths with a synthetic in-memory
Supabase fake so we can measure how the system behaves for representative
hotels — especially brand-new (cold-start) hotels — and compare numbers
before vs after an improvement.

This is a DEV TOOL, not a test. Run:
    .venv311/bin/python -m scripts.hk_sanity_harness

It prints one row per scenario:
  - demand p50/p95 minutes (Layer 1)
  - recommended_headcount + achieved completion probability (Layer 3)
  - used_l2_supply (did the per-room LPT simulation run, or the cruder
    L1 infinite-divisibility path?)
  - naive_hc = ceil(p95_minutes / shift) — the "perfectly divisible" lower
    bound a head housekeeper might eyeball
  - sanity flags (headcount must be >=1 when there is work; not absurd)

Nothing here writes to a real database — the fake client captures upserts
in memory.
"""
import asyncio
import sys
from dataclasses import dataclass, field
from datetime import date
from typing import Dict, List, Optional
from unittest.mock import MagicMock

# Placeholder env so get_settings() constructs without a real .env. Must be
# set before importing src.* (mirrors tests/conftest.py).
import os
os.environ.setdefault("SUPABASE_URL", "https://placeholder.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "placeholder-service-role-key")
os.environ.setdefault("ML_SERVICE_SECRET", "placeholder-secret-12345")

import src.optimizer.monte_carlo as mc  # noqa: E402
from src.config import get_settings  # noqa: E402

PROP = "d1f8a3b1-1234-5678-9abc-def012345678"
DATE = date(2026, 6, 19)


def _fixed_multiplier_supply(prior_minutes_per_event: float) -> dict:
    """The cold-start per-room quantile shape from inference/supply.py."""
    mu = float(prior_minutes_per_event)
    return {
        "predicted_minutes_p25": mu * 0.7,
        "predicted_minutes_p50": mu,
        "predicted_minutes_p75": mu * 1.3,
        "predicted_minutes_p90": mu * 1.6,
    }


@dataclass
class Scenario:
    name: str
    total_rooms: int
    shift_minutes: int
    # Layer 1 demand prediction (total minutes) as written to demand_predictions
    demand_p50: float
    demand_p95: float
    demand_cold_start: bool
    # Layer 2 supply: number of per-room predictions available, and the
    # per-event minutes used to build their quantiles. n_supply < 10 forces
    # the optimizer onto the L1-only path.
    n_supply: int
    supply_minutes_per_event: float
    supply_cold_start: bool
    target_prob: float = 0.95


def build_fake_client(s: Scenario) -> MagicMock:
    """Build a fake supabase client wrapper for one scenario."""
    client = MagicMock()

    demand_row = {
        "model_run_id": "demand-run",
        "predicted_minutes_p50": s.demand_p50,
        "predicted_minutes_p95": s.demand_p95,
    }
    supply_rows = []
    for i in range(s.n_supply):
        row = {"room_number": str(100 + i), "staff_id": None, "model_run_id": "supply-run"}
        row.update(_fixed_multiplier_supply(s.supply_minutes_per_event))
        supply_rows.append(row)

    model_runs = {
        "demand-run": {
            "id": "demand-run",
            "is_cold_start": s.demand_cold_start,
            "algorithm": "cold-start-cohort-prior" if s.demand_cold_start else "bayesian",
        },
        "supply-run": {
            "id": "supply-run",
            "is_cold_start": s.supply_cold_start,
            "algorithm": "cold-start-cohort-prior" if s.supply_cold_start else "bayesian",
        },
    }

    def _fetch_one(table, filters=None):
        if table == "properties":
            return {"id": s.name, "shift_minutes": s.shift_minutes, "total_rooms": s.total_rooms}
        if table == "ml_feature_flags":
            return {"target_completion_prob": s.target_prob}
        if table == "model_runs":
            return model_runs.get((filters or {}).get("id"))
        return None

    def _fetch_many(table, **kwargs):
        if table == "demand_predictions":
            return [demand_row]
        if table == "supply_predictions":
            return supply_rows
        return []

    upserts: List[dict] = []

    def _upsert(table, data, on_conflict=None):
        upserts.append({"table": table, "data": data, "on_conflict": on_conflict})
        return data

    client.fetch_one.side_effect = _fetch_one
    client.fetch_many.side_effect = _fetch_many
    client.upsert.side_effect = _upsert
    client.upserts = upserts
    return client


def run_scenario(s: Scenario) -> dict:
    fake = build_fake_client(s)
    orig = mc.get_supabase_client
    mc.get_supabase_client = lambda: fake
    try:
        result = asyncio.run(mc.optimize_headcount(PROP, prediction_date=DATE))
    finally:
        mc.get_supabase_client = orig
    return result


SCENARIOS = [
    # Brand-new small select-service hotel, day 1, no schedule yet (n_supply=0)
    Scenario("coldstart-small-30rm", 30, 420, demand_p50=600, demand_p95=840,
             demand_cold_start=True, n_supply=0, supply_minutes_per_event=30,
             supply_cold_start=True),
    # Brand-new mid hotel, checkout-heavy day, no schedule
    Scenario("coldstart-mid-90rm", 90, 420, demand_p50=1800, demand_p95=2400,
             demand_cold_start=True, n_supply=0, supply_minutes_per_event=30,
             supply_cold_start=True),
    # Brand-new large hotel, no schedule
    Scenario("coldstart-large-200rm", 200, 420, demand_p50=4000, demand_p95=5200,
             demand_cold_start=True, n_supply=0, supply_minutes_per_event=30,
             supply_cold_start=True),
    # Same mid hotel but a schedule exists so L2 per-room sim can run
    Scenario("coldstart-mid-90rm+L2", 90, 420, demand_p50=1800, demand_p95=2400,
             demand_cold_start=True, n_supply=60, supply_minutes_per_event=30,
             supply_cold_start=True),
    # Fitted mid hotel with L2 schedule
    Scenario("fitted-mid-90rm+L2", 90, 420, demand_p50=1700, demand_p95=2200,
             demand_cold_start=False, n_supply=60, supply_minutes_per_event=28,
             supply_cold_start=False),
    # Tiny / near-empty day (robustness)
    Scenario("near-empty-30rm", 30, 420, demand_p50=30, demand_p95=60,
             demand_cold_start=True, n_supply=0, supply_minutes_per_event=30,
             supply_cold_start=True),
    # 8-hour shift hotel (shift != global 420 default)
    Scenario("coldstart-mid-480shift", 90, 480, demand_p50=1800, demand_p95=2400,
             demand_cold_start=True, n_supply=0, supply_minutes_per_event=30,
             supply_cold_start=True),
]


def main() -> int:
    import math
    print(f"{'scenario':<26} {'p50min':>7} {'p95min':>7} {'hc':>3} {'achP':>5} "
          f"{'L2':>3} {'naiveHC':>7} {'flags'}")
    print("-" * 86)
    bad = 0
    for s in SCENARIOS:
        r = run_scenario(s)
        if r.get("error"):
            print(f"{s.name:<26} ERROR: {r['error']}")
            bad += 1
            continue
        hc = r.get("recommended_headcount")
        achp = r.get("achieved_completion_probability")
        usedl2 = r.get("used_l2_supply")
        naive = math.ceil(s.demand_p95 / s.shift_minutes)
        flags = []
        has_work = s.demand_p95 > 0
        if has_work and (hc is None or hc < 1):
            flags.append("HC<1_WITH_WORK")
        if hc is not None and hc > max(naive * 4, 8):
            flags.append("HC_ABSURDLY_HIGH")
        # L1 infinite-divisibility under-recommendation signal: when not using
        # L2, the headcount tends to equal the perfectly-divisible naive bound,
        # which ignores that rooms are indivisible jobs.
        if not usedl2 and hc is not None and hc < naive:
            flags.append("HC_BELOW_NAIVE")
        flagstr = ",".join(flags) if flags else "ok"
        if flags:
            bad += 1
        print(f"{s.name:<26} {s.demand_p50:>7.0f} {s.demand_p95:>7.0f} "
              f"{str(hc):>3} {achp:>5.2f} {str(usedl2):>3} {naive:>7} {flagstr}")
    print("-" * 86)
    print(f"shift_cap_minutes default (global): {get_settings().shift_cap_minutes}")
    print(f"monte_carlo_draws: {get_settings().monte_carlo_draws}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
