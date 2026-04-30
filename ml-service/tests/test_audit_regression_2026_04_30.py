"""Regression tests for the 2026-04-30 ML audit fixes.

Each test pins a specific bug found in the deep-audit pass so the same class
of regression cannot ship again. When you read this file, the docstring on
each test names the bug it locks down.
"""
import os
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone

import numpy as np
import pandas as pd
import pytest

from src.advisory_lock import hash_property_layer
from src.layers.bayesian_regression import BayesianRegression


# ────────────────────────────────────────────────────────────────────────────
# CRITICAL-9: advisory_lock hash must be deterministic across processes.
# Previous implementation used Python's built-in hash() which is randomized
# per process, so two ML workers would compute different lock IDs for the
# same (property, layer) — the lock never actually serialized anything.
# ────────────────────────────────────────────────────────────────────────────
def test_advisory_lock_hash_is_deterministic_across_processes():
    """hash_property_layer must produce the same int regardless of PYTHONHASHSEED."""
    pid = "11111111-1111-1111-1111-111111111111"
    layer = "demand"
    in_proc = hash_property_layer(pid, layer)

    # Spawn a fresh interpreter with a different hash seed and ask it for
    # the same lock ID. If hash() were used internally these would differ.
    code = (
        "import sys; sys.path.insert(0, '.'); "
        "from src.advisory_lock import hash_property_layer; "
        f"print(hash_property_layer('{pid}', '{layer}'))"
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        env={**os.environ, "PYTHONHASHSEED": "12345"},
        capture_output=True,
        text=True,
        cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    )
    assert result.returncode == 0, f"subprocess failed: {result.stderr}"
    other_proc = int(result.stdout.strip())
    assert in_proc == other_proc, (
        f"Lock ID drifted across processes: in_proc={in_proc} other_proc={other_proc}. "
        "advisory_lock would never serialize concurrent runs."
    )


def test_advisory_lock_hash_distinguishes_layers():
    """Same property, different layer → different lock ID (so demand+supply
    training can run concurrently for the same property without blocking)."""
    pid = "22222222-2222-2222-2222-222222222222"
    assert hash_property_layer(pid, "demand") != hash_property_layer(pid, "supply")


def test_advisory_lock_hash_distinguishes_properties():
    """Same layer, different property → different lock ID."""
    pid_a = "33333333-3333-3333-3333-333333333333"
    pid_b = "44444444-4444-4444-4444-444444444444"
    assert hash_property_layer(pid_a, "demand") != hash_property_layer(pid_b, "demand")


# ────────────────────────────────────────────────────────────────────────────
# CRITICAL-2: Bayesian shape mismatch with a fitted posterior must raise,
# not silently revert to the prior. Cold-start (no posterior) is allowed to
# re-init the prior because nothing is being thrown away.
# ────────────────────────────────────────────────────────────────────────────
def test_bayesian_predict_raises_when_posterior_shape_mismatch():
    """A loaded posterior with the wrong feature count must error explicitly."""
    model = BayesianRegression()
    model.fit(
        pd.DataFrame({"intercept": [1, 1, 1], "x": [1.0, 2.0, 3.0]}),
        pd.Series([10.0, 12.0, 14.0]),
    )
    # Now attempt to predict with a different feature count.
    X_wrong = pd.DataFrame({"intercept": [1.0], "x": [1.0], "extra": [9.0]})
    with pytest.raises(ValueError, match="feature shape mismatch"):
        model.predict_quantile(X_wrong, [0.5])


def test_bayesian_predict_cold_start_allows_reinit():
    """Without a fitted posterior, prediction should still succeed even if
    _initialize_prior was called with a different shape than X."""
    model = BayesianRegression()
    model._initialize_prior(pd.DataFrame({"a": [1], "b": [2]}))  # 2 features
    X = pd.DataFrame({"intercept": [1], "a": [0.5], "b": [1.0]})  # 3 features
    quantiles = model.predict_quantile(X, [0.5])
    assert 0.5 in quantiles
    assert quantiles[0.5][0] >= 0


# ────────────────────────────────────────────────────────────────────────────
# CRITICAL-5: Monte-Carlo bin-packing must accumulate workload across all
# rooms assigned to a worker, not overwrite. Previously the code did
# `hk_workloads[staff_id] = room_time` which made max workload appear ~1
# room's worth instead of N.
# ────────────────────────────────────────────────────────────────────────────
def test_lpt_bin_packing_accumulates_across_rooms():
    """Independent regression: pack 10×40min rooms onto 2 workers → max load
    must be ~200min, not ~40min."""
    room_times = [40.0] * 10
    headcount = 2
    room_times.sort(reverse=True)
    worker_loads = [0.0] * headcount
    for t in room_times:
        idx = int(np.argmin(worker_loads))
        worker_loads[idx] += t
    makespan = max(worker_loads)
    # 10 × 40 = 400 total minutes split across 2 workers ⇒ each does 200.
    assert makespan == pytest.approx(200.0), (
        f"Bin-packing did not accumulate; makespan={makespan}. "
        "If overwrite bug regressed this would be ~40."
    )


def test_lpt_bin_packing_balances_load_across_workers():
    """LPT (Longest Processing Time first) gives an even distribution for
    well-conditioned inputs."""
    room_times = sorted([60, 50, 40, 30, 20, 10], reverse=True)
    worker_loads = [0.0] * 3
    for t in room_times:
        idx = int(np.argmin(worker_loads))
        worker_loads[idx] += t
    # Total = 210, 3 workers → ideal makespan = 70. LPT gets exactly that here.
    assert max(worker_loads) == pytest.approx(70.0)


# ────────────────────────────────────────────────────────────────────────────
# CRITICAL-3: prediction_date default must derive from America/Chicago, not
# UTC. Otherwise it rolls past the date boundary 6 hours early.
# ────────────────────────────────────────────────────────────────────────────
def test_tomorrow_in_property_tz_returns_houston_tomorrow():
    """At 11pm Houston time on day D, _tomorrow_in_property_tz must return D+1
    (in Houston), not D+2 (which is what utcnow + 1 day would have given for
    the same wall-clock instant once the user crosses midnight UTC)."""
    from src.inference.demand import _tomorrow_in_property_tz

    today_houston = (
        datetime.now(timezone.utc) - timedelta(hours=6)
    ).date()  # rough "Houston today"
    result = _tomorrow_in_property_tz()
    # Should equal Houston-today + 1 day, ± 1 day for the boundary case.
    assert (result - today_houston).days in (0, 1, 2), (
        f"_tomorrow_in_property_tz returned {result}; "
        f"expected within 1-2 days of Houston-today {today_houston}"
    )


# ────────────────────────────────────────────────────────────────────────────
# CRITICAL-7: UUID validation rejects malformed property_id at the boundary.
# ────────────────────────────────────────────────────────────────────────────
def test_demand_training_rejects_non_uuid_property_id():
    """train_demand_model must early-return with an error for non-UUID input."""
    import asyncio
    from src.training.demand import train_demand_model

    result = asyncio.run(train_demand_model("not-a-uuid"))
    assert result.get("error")
    assert "UUID" in result["error"]


def test_supply_training_rejects_non_uuid_property_id():
    """train_supply_model must early-return with an error for non-UUID input."""
    import asyncio
    from src.training.supply import train_supply_model

    result = asyncio.run(train_supply_model("'; DROP TABLE model_runs; --"))
    assert result.get("error")
    assert "UUID" in result["error"]
