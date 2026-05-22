"""Phase 1.2 (2026-05-22) — when fewer than 10 supply predictions exist,
the optimizer drops to the L1-only path. used_l2_supply=false on
inputs_snapshot + response.

This is the "capacity-unavailable" state Codex flagged in the
adversarial review. Without the dedicated marker, the Schedule tab
would label these results as "warming up" when in fact L1 may be fully
fitted — they're just missing the per-room capacity model.
"""
import asyncio
import json
from datetime import date
from unittest.mock import patch

from tests.test_optimizer_writes_layer_flags import (
    PROPERTY_ID,
    _fake_with_layers,
    _run,
)


def test_l1_only_path_sets_used_l2_supply_false():
    from src.optimizer.monte_carlo import optimize_headcount

    # 5 supply predictions < 10 threshold → L1-only path triggers.
    fake = _fake_with_layers(l1_cold_start=False, l2_cold_start=False, n_supply=5)
    with patch("src.optimizer.monte_carlo.get_supabase_client", return_value=fake):
        result = _run(optimize_headcount(PROPERTY_ID, date(2026, 5, 15)))

    assert "error" not in result, f"unexpected error: {result!r}"
    upserts = [u for u in fake.upserts if u["table"] == "optimizer_results"]
    assert len(upserts) == 1
    snap = json.loads(upserts[0]["data"]["inputs_snapshot"])
    assert snap["used_l2_supply"] is False
    assert snap["l2_prediction_count"] == 0  # set to 0 when L2 path skipped
    # L1 is fitted, so l1_is_cold_start is false — but capacity-unavailable
    # is the headline state for the UI.
    assert snap["l1_is_cold_start"] is False
    assert result["used_l2_supply"] is False
    assert result["l1_is_cold_start"] is False
