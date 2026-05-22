"""Phase 1.2 (2026-05-22) — when both L1 and L2 backing models are
cold-start, the optimizer omits the completion_probability_curve
because it has no per-hotel signal.

The Monte Carlo runs over fixed-multiplier quantiles (mu × [0.5, 0.7,
1.0, 1.3, 1.4, 1.6, 1.8] for demand; mu × [0.7, 1.0, 1.3, 1.6] for
supply). The only variance comes from LPT bin-packing across H workers,
so the resulting curve is mathematically deterministic for a given
seed — calling it a "confidence band" misleads the cockpit + Schedule
tab consumers. Hide it; let the UI fall back gracefully.
"""
import asyncio
import json
from datetime import date
from unittest.mock import patch

# Reuse the helper from the sibling layer-flags test.
from tests.test_optimizer_writes_layer_flags import (
    PROPERTY_ID,
    _fake_with_layers,
    _run,
)


def test_curve_is_empty_when_both_layers_cold_start():
    from src.optimizer.monte_carlo import optimize_headcount

    fake = _fake_with_layers(l1_cold_start=True, l2_cold_start=True)
    with patch("src.optimizer.monte_carlo.get_supabase_client", return_value=fake):
        result = _run(optimize_headcount(PROPERTY_ID, date(2026, 5, 15)))

    assert "error" not in result, f"unexpected error: {result!r}"
    upserts = [u for u in fake.upserts if u["table"] == "optimizer_results"]
    assert len(upserts) == 1
    curve_json = upserts[0]["data"]["completion_probability_curve"]
    assert json.loads(curve_json) == [], (
        "full-cold-start curve must be empty — synthetic-quantile MC has no signal"
    )
    # And the response mirrors the same.
    assert result["completion_probability_curve"] == []


def test_curve_is_populated_when_layers_are_fitted():
    """Inverse check — fitted layers DO write a curve. Catches regressions
    that accidentally suppress the curve for legitimate predictions.
    """
    from src.optimizer.monte_carlo import optimize_headcount

    fake = _fake_with_layers(l1_cold_start=False, l2_cold_start=False)
    with patch("src.optimizer.monte_carlo.get_supabase_client", return_value=fake):
        result = _run(optimize_headcount(PROPERTY_ID, date(2026, 5, 15)))

    assert "error" not in result
    upserts = [u for u in fake.upserts if u["table"] == "optimizer_results"]
    curve = json.loads(upserts[0]["data"]["completion_probability_curve"])
    assert isinstance(curve, list) and len(curve) > 0, (
        f"fitted-layers curve should be non-empty, got {curve!r}"
    )
    assert result["completion_probability_curve"] == curve
