"""Smoke tests for the realized-MAE backtest (Phase 3 honesty audit).

Pins the contract for `run_inventory_backtest`:
  1. Reads prediction_log rows scoped to (property, layer='inventory_rate', window).
  2. Joins to model_runs via a SINGLE batched `.in_('id', ...)` call (NOT N+1).
  3. Computes per-item realized MAE.
  4. Flags active model_runs whose realized MAE > 1.5x validation_mae with ≥10 pairs.
  5. NEVER writes to model_runs or inventory_rate_predictions.
  6. Honors window_days clamp to [1, 180].
  7. Rejects malformed property_id.
"""
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest

import src.supabase_client as supabase_client_module
from src.eval import inventory_backtest as backtest_module
from src.eval.inventory_backtest import (
    DRIFT_RATIO_THRESHOLD,
    MIN_PAIRS_FOR_STALENESS,
    run_inventory_backtest,
)


PID = "11111111-1111-1111-1111-111111111111"
ITEM_A = "22222222-2222-2222-2222-222222222222"
ITEM_B = "33333333-3333-3333-3333-333333333333"
RUN_A = "44444444-4444-4444-4444-444444444444"
RUN_B = "55555555-5555-5555-5555-555555555555"


def _iso(d: datetime) -> str:
    return d.isoformat()


def _make_client(log_rows, runs_rows):
    """Build a fake supabase wrapper with parameterized fetch_many / .in_() chain.

    fetch_many is called for prediction_log; .in_() is called via the raw
    client for model_runs (the batched join). We track every call so we
    can assert "exactly one .in_() call" (the anti-N+1 invariant).
    """
    in_calls: list = []

    def _fetch_many(table, **kwargs):
        if table == "prediction_log":
            return log_rows
        return []

    raw_client = MagicMock()

    def _table(name):
        builder = MagicMock()

        # Track every .in_() invocation on model_runs.
        def _in_(col, ids):
            in_calls.append({"table": name, "col": col, "ids": list(ids)})
            select_resp = MagicMock()
            select_resp.data = [r for r in runs_rows if str(r.get("id")) in {str(i) for i in ids}]
            execute_chain = MagicMock()
            execute_chain.execute.return_value = select_resp
            return execute_chain

        select_builder = MagicMock()
        select_builder.in_.side_effect = _in_
        builder.select.return_value = select_builder
        return builder

    raw_client.table.side_effect = _table

    client = MagicMock()
    client.client = raw_client
    client.fetch_many.side_effect = _fetch_many
    client.in_calls = in_calls
    return client


@pytest.fixture(autouse=True)
def _patch_supabase_singleton(monkeypatch):
    """Inject a fake supabase wrapper via get_supabase_client for each test."""
    client_holder: dict = {}

    def _get_client():
        return client_holder.get("client") or _make_client([], [])

    monkeypatch.setattr(backtest_module, "get_supabase_client", _get_client)
    yield client_holder


def _set_client(holder, client):
    holder["client"] = client


# ── Validation ─────────────────────────────────────────────────────────────


def test_rejects_invalid_property_id(_patch_supabase_singleton):
    result = run_inventory_backtest("not-a-uuid")
    assert result["error"].startswith("Invalid property_id")
    assert result["n_pairs"] == 0
    assert result["per_item"] == []
    assert result["stale_active_models"] == []


def test_clamps_window_to_180_days(_patch_supabase_singleton):
    _set_client(_patch_supabase_singleton, _make_client([], []))
    result = run_inventory_backtest(PID, window_days=10_000)
    assert result["window_days"] == 180


def test_clamps_window_to_min_1(_patch_supabase_singleton):
    _set_client(_patch_supabase_singleton, _make_client([], []))
    result = run_inventory_backtest(PID, window_days=0)
    assert result["window_days"] == 1


# ── Empty-state ────────────────────────────────────────────────────────────


def test_empty_prediction_log_returns_zero_pairs(_patch_supabase_singleton):
    _set_client(_patch_supabase_singleton, _make_client([], []))
    result = run_inventory_backtest(PID)
    assert result["n_pairs"] == 0
    assert result["per_item"] == []
    assert result["stale_active_models"] == []


# ── Per-item realized MAE ──────────────────────────────────────────────────


def test_computes_realized_mae_per_item():
    now = datetime.now(timezone.utc)
    log = [
        {
            "property_id": PID, "layer": "inventory_rate",
            "item_id": ITEM_A, "model_run_id": RUN_A,
            "predicted_value": 10.0, "actual_value": 8.0,
            "logged_at": _iso(now - timedelta(days=2)),
        },
        {
            "property_id": PID, "layer": "inventory_rate",
            "item_id": ITEM_A, "model_run_id": RUN_A,
            "predicted_value": 12.0, "actual_value": 10.0,
            "logged_at": _iso(now - timedelta(days=1)),
        },
        # Different item — independent MAE
        {
            "property_id": PID, "layer": "inventory_rate",
            "item_id": ITEM_B, "model_run_id": RUN_B,
            "predicted_value": 5.0, "actual_value": 6.0,
            "logged_at": _iso(now - timedelta(days=1)),
        },
    ]
    runs = [
        {"id": RUN_A, "algorithm": "bayesian", "training_mae": 1.0,
         "validation_mae": 1.5, "is_active": True, "item_id": ITEM_A},
        {"id": RUN_B, "algorithm": "bayesian", "training_mae": 0.5,
         "validation_mae": 0.6, "is_active": True, "item_id": ITEM_B},
    ]
    client = _make_client(log, runs)
    holder = {"client": client}
    # Inject via monkeypatch shadowing the fixture's closure
    import src.eval.inventory_backtest as bm
    orig = bm.get_supabase_client
    bm.get_supabase_client = lambda: client
    try:
        result = run_inventory_backtest(PID)
    finally:
        bm.get_supabase_client = orig

    assert result["n_pairs"] == 3
    item_a = next(r for r in result["per_item"] if r["item_id"] == ITEM_A)
    item_b = next(r for r in result["per_item"] if r["item_id"] == ITEM_B)
    # |10-8| + |12-10| = 2 + 2 → mean 2.0
    assert item_a["realized_mae"] == 2.0
    assert item_a["n_pairs"] == 2
    assert item_a["validation_mae"] == 1.5
    assert item_a["drift_ratio"] == 2.0 / 1.5
    # |5-6| = 1 → mean 1.0
    assert item_b["realized_mae"] == 1.0


def test_uses_single_batched_in_call_for_model_runs():
    """Codex + senior-eng review pin: must NOT loop fetch_many per run_id."""
    now = datetime.now(timezone.utc)
    log = [
        {
            "property_id": PID, "layer": "inventory_rate",
            "item_id": ITEM_A, "model_run_id": RUN_A,
            "predicted_value": 10.0, "actual_value": 9.0,
            "logged_at": _iso(now - timedelta(days=1)),
        },
        {
            "property_id": PID, "layer": "inventory_rate",
            "item_id": ITEM_B, "model_run_id": RUN_B,
            "predicted_value": 6.0, "actual_value": 5.0,
            "logged_at": _iso(now - timedelta(days=1)),
        },
    ]
    runs = [
        {"id": RUN_A, "algorithm": "bayesian", "training_mae": 1.0,
         "validation_mae": 1.0, "is_active": True, "item_id": ITEM_A},
        {"id": RUN_B, "algorithm": "bayesian", "training_mae": 0.5,
         "validation_mae": 0.5, "is_active": True, "item_id": ITEM_B},
    ]
    client = _make_client(log, runs)
    import src.eval.inventory_backtest as bm
    orig = bm.get_supabase_client
    bm.get_supabase_client = lambda: client
    try:
        run_inventory_backtest(PID)
    finally:
        bm.get_supabase_client = orig
    assert len(client.in_calls) == 1, (
        f"expected ONE batched .in_() call, got {len(client.in_calls)} (N+1 regression)"
    )
    assert client.in_calls[0]["col"] == "id"
    assert set(client.in_calls[0]["ids"]) == {RUN_A, RUN_B}


# ── Staleness flag ─────────────────────────────────────────────────────────


def test_flags_stale_active_models_when_drift_exceeds_threshold():
    """Realized MAE = 2.0, validation_mae = 1.0 → ratio 2.0, exceeds 1.5
    threshold and >=10 pairs → flagged."""
    now = datetime.now(timezone.utc)
    log = []
    for i in range(MIN_PAIRS_FOR_STALENESS + 2):
        log.append({
            "property_id": PID, "layer": "inventory_rate",
            "item_id": ITEM_A, "model_run_id": RUN_A,
            "predicted_value": 5.0, "actual_value": 7.0,   # |5-7| = 2.0
            "logged_at": _iso(now - timedelta(days=1, hours=i)),
        })
    runs = [
        {"id": RUN_A, "algorithm": "bayesian", "training_mae": 0.8,
         "validation_mae": 1.0, "is_active": True, "item_id": ITEM_A},
    ]
    client = _make_client(log, runs)
    import src.eval.inventory_backtest as bm
    orig = bm.get_supabase_client
    bm.get_supabase_client = lambda: client
    try:
        result = run_inventory_backtest(PID)
    finally:
        bm.get_supabase_client = orig
    assert len(result["stale_active_models"]) == 1
    stale = result["stale_active_models"][0]
    assert stale["item_id"] == ITEM_A
    assert stale["model_run_id"] == RUN_A
    assert stale["ratio"] > DRIFT_RATIO_THRESHOLD


def test_does_not_flag_when_too_few_pairs():
    """Same drift but only 3 pairs → below MIN_PAIRS_FOR_STALENESS."""
    now = datetime.now(timezone.utc)
    log = [
        {
            "property_id": PID, "layer": "inventory_rate",
            "item_id": ITEM_A, "model_run_id": RUN_A,
            "predicted_value": 5.0, "actual_value": 7.0,
            "logged_at": _iso(now - timedelta(days=1, hours=i)),
        }
        for i in range(3)
    ]
    runs = [
        {"id": RUN_A, "algorithm": "bayesian", "training_mae": 0.8,
         "validation_mae": 1.0, "is_active": True, "item_id": ITEM_A},
    ]
    client = _make_client(log, runs)
    import src.eval.inventory_backtest as bm
    orig = bm.get_supabase_client
    bm.get_supabase_client = lambda: client
    try:
        result = run_inventory_backtest(PID)
    finally:
        bm.get_supabase_client = orig
    assert result["stale_active_models"] == []


def test_does_not_flag_when_run_is_not_active():
    """High drift but model already deactivated → no flag (admin already knows)."""
    now = datetime.now(timezone.utc)
    log = [
        {
            "property_id": PID, "layer": "inventory_rate",
            "item_id": ITEM_A, "model_run_id": RUN_A,
            "predicted_value": 5.0, "actual_value": 7.0,
            "logged_at": _iso(now - timedelta(days=1, hours=i)),
        }
        for i in range(MIN_PAIRS_FOR_STALENESS + 2)
    ]
    runs = [
        {"id": RUN_A, "algorithm": "bayesian", "training_mae": 0.8,
         "validation_mae": 1.0, "is_active": False, "item_id": ITEM_A},
    ]
    client = _make_client(log, runs)
    import src.eval.inventory_backtest as bm
    orig = bm.get_supabase_client
    bm.get_supabase_client = lambda: client
    try:
        result = run_inventory_backtest(PID)
    finally:
        bm.get_supabase_client = orig
    assert result["stale_active_models"] == []


# ── Window enforcement ─────────────────────────────────────────────────────


def test_excludes_pairs_outside_window():
    now = datetime.now(timezone.utc)
    log = [
        # Inside window — counts
        {
            "property_id": PID, "layer": "inventory_rate",
            "item_id": ITEM_A, "model_run_id": RUN_A,
            "predicted_value": 5.0, "actual_value": 5.0,
            "logged_at": _iso(now - timedelta(days=2)),
        },
        # Outside 30-day window — should be skipped
        {
            "property_id": PID, "layer": "inventory_rate",
            "item_id": ITEM_A, "model_run_id": RUN_A,
            "predicted_value": 5.0, "actual_value": 100.0,
            "logged_at": _iso(now - timedelta(days=60)),
        },
    ]
    runs = [
        {"id": RUN_A, "algorithm": "bayesian", "training_mae": 0.1,
         "validation_mae": 0.1, "is_active": True, "item_id": ITEM_A},
    ]
    client = _make_client(log, runs)
    import src.eval.inventory_backtest as bm
    orig = bm.get_supabase_client
    bm.get_supabase_client = lambda: client
    try:
        result = run_inventory_backtest(PID, window_days=30)
    finally:
        bm.get_supabase_client = orig
    assert result["n_pairs"] == 1
    item_a = result["per_item"][0]
    assert item_a["realized_mae"] == 0.0


# ── No-write invariant ─────────────────────────────────────────────────────


def test_backtest_never_calls_upsert_or_insert_or_update():
    """Pin the read-only contract: NO writes to any operational table."""
    now = datetime.now(timezone.utc)
    log = [
        {
            "property_id": PID, "layer": "inventory_rate",
            "item_id": ITEM_A, "model_run_id": RUN_A,
            "predicted_value": 5.0, "actual_value": 5.0,
            "logged_at": _iso(now - timedelta(days=1)),
        },
    ]
    runs = [{"id": RUN_A, "algorithm": "bayesian", "training_mae": 0.1,
             "validation_mae": 0.1, "is_active": True, "item_id": ITEM_A}]
    client = _make_client(log, runs)
    # Wrap the methods we care about so any call surfaces in calls list.
    client.insert = MagicMock(side_effect=Exception("backtest wrote insert"))
    client.update = MagicMock(side_effect=Exception("backtest wrote update"))
    client.upsert = MagicMock(side_effect=Exception("backtest wrote upsert"))

    import src.eval.inventory_backtest as bm
    orig = bm.get_supabase_client
    bm.get_supabase_client = lambda: client
    try:
        run_inventory_backtest(PID)
    finally:
        bm.get_supabase_client = orig
    client.insert.assert_not_called()
    client.update.assert_not_called()
    client.upsert.assert_not_called()
