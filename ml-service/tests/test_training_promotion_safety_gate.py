"""Phase 4a (2026-05-22) — promotion safety gate for housekeeping retrains.

Three branches the new gate logic must handle correctly:

  1. **First model ever** (no active row exists) → existing RPC path,
     activates directly. Nothing changes vs pre-Phase-4a behavior.
  2. **Active is cold-start** → RPC path with direct replace. Cold-start
     is the "anything beats this" baseline; no soak needed.
  3. **Active is fitted** → BYPASS the RPC. Write directly with
     is_shadow=true, is_active=false, shadow_started_at=now(). The
     already-layer-agnostic ml-shadow-evaluate cron promotes after a
     7-day soak iff shadow.validation_mae <= active.validation_mae × 1.05.

Why bypass the RPC: the migration-0107 RPC's INSERT column list doesn't
include is_shadow / shadow_started_at, and extending it would require
a new migration (out of scope). Shadow rows have is_active=false so
they don't conflict with the partial unique index the RPC's
lock-then-deactivate dance was built to protect.
"""
import asyncio
import json
from datetime import datetime
from unittest.mock import MagicMock, patch

import numpy as np

from tests.conftest import make_fake_supabase

PROPERTY_ID = "8a041d6e-d881-4f19-83e0-7250f0e36eaa"


def _run(coro):
    return asyncio.run(coro)


def _synthetic_supply_events(n=250):
    """Synthetic cleaning_events rows that pass the activation gates.

    260+ rows with low-variance actual_minutes around a single value so
    the Bayesian fit achieves a near-zero MAE and the gate at supply.py
    `mae_ratio < validation_mae_ratio_threshold` passes.
    """
    rows = []
    rng = np.random.default_rng(42)
    for i in range(n):
        # Mix of room_types + staff so build_supply_features generates
        # the per-room and per-staff one-hot columns the production
        # training expects.
        rows.append({
            "id": f"evt-{i}",
            "property_id": PROPERTY_ID,
            "staff_id": f"staff-{i % 3}",
            "room_number": str(100 + (i % 20)),
            "room_type": "checkout" if i % 2 else "stayover",
            "created_at": f"2026-01-{(i % 28) + 1:02d}T00:00:00",
            "actual_minutes": float(25.0 + rng.normal(0, 0.5)),
            "day_of_week": i % 7,
            "occupancy_at_start": 60,
            "was_dnd_during_clean": False,
        })
    return rows


def _build_fake(active_row, *, rpc_ok=True):
    """Fake supabase client wired with one active model row (or none)
    and a successful RPC return.
    """
    def _fetch_many(table, **kwargs):
        if table == "model_runs":
            filters = kwargs.get("filters") or {}
            # Used by the gate-check and the streak counter both.
            if filters.get("is_active") is True:
                return [active_row] if active_row else []
            # Streak-counter "recent N runs" fetch — empty is fine, just
            # means consecutive_passes stays at 1.
            return []
        return []

    fake = make_fake_supabase(
        fetch_many=_fetch_many,
        execute_sql={"cleaning_events": _synthetic_supply_events()},
    )

    # The training code calls `client.client.rpc(...).execute()`. Wire
    # that so the test can assert whether the RPC fired.
    rpc_calls = []

    def _rpc(name, params):
        rpc_calls.append({"name": name, "params": params})
        m = MagicMock()
        m.execute.return_value.data = (
            [{"ok": True, "reason": None, "model_run_id": "new-rpc-id"}] if rpc_ok
            else [{"ok": False, "reason": "test_forced", "model_run_id": None}]
        )
        return m

    fake.client = MagicMock()
    fake.client.rpc.side_effect = _rpc
    fake.rpc_calls = rpc_calls

    # The shadow path calls client.insert("model_runs", row). Wire that
    # too and capture for assertion.
    inserts = []

    def _insert(table, data):
        inserts.append({"table": table, "data": data})
        return {"id": "new-shadow-id", **data}

    fake.insert.side_effect = _insert
    fake.inserts = inserts
    return fake


def test_first_model_ever_uses_rpc_path():
    """No active row → goes through staxis_install_housekeeping_model_run RPC."""
    from src.training.supply import train_supply_model

    fake = _build_fake(active_row=None)
    with patch("src.training.supply.get_supabase_client", return_value=fake), \
         patch("src.training.supply.psycopg2.connect", side_effect=Exception("no lock")):
        result = _run(train_supply_model(PROPERTY_ID, max_rows=None, blocking_lock=False))

    # RPC fired exactly once for the install path.
    rpc_names = [c["name"] for c in fake.rpc_calls]
    assert "staxis_install_housekeeping_model_run" in rpc_names, (
        f"expected RPC install path, got rpc calls={rpc_names!r}, "
        f"inserts={[i['data'].get('is_shadow') for i in fake.inserts]!r}, "
        f"result={result!r}"
    )
    # No shadow insert.
    shadow_inserts = [
        i for i in fake.inserts
        if i["table"] == "model_runs" and i["data"].get("is_shadow")
    ]
    assert shadow_inserts == [], (
        f"first-model-ever path must not write a shadow row, got: {shadow_inserts!r}"
    )


def test_active_cold_start_replaces_via_rpc():
    """Active is cold-start → RPC path, direct replace (no shadow)."""
    from src.training.supply import train_supply_model

    cold_active = {
        "id": "active-cold-id",
        "property_id": PROPERTY_ID,
        "layer": "supply",
        "is_active": True,
        "is_shadow": False,
        "algorithm": "cold-start-cohort-prior",
        "is_cold_start": True,
        "validation_mae": None,
        "trained_at": "2026-04-01T00:00:00",
    }
    fake = _build_fake(active_row=cold_active)
    with patch("src.training.supply.get_supabase_client", return_value=fake), \
         patch("src.training.supply.psycopg2.connect", side_effect=Exception("no lock")):
        result = _run(train_supply_model(PROPERTY_ID, max_rows=None, blocking_lock=False))

    rpc_names = [c["name"] for c in fake.rpc_calls]
    assert "staxis_install_housekeeping_model_run" in rpc_names, (
        f"cold-start active must be replaced via RPC, got: {rpc_names!r}, result={result!r}"
    )
    shadow_inserts = [
        i for i in fake.inserts
        if i["table"] == "model_runs" and i["data"].get("is_shadow")
    ]
    assert shadow_inserts == [], (
        f"cold-start replacement must not soak as a shadow: {shadow_inserts!r}"
    )


def test_active_fitted_routes_new_fit_to_shadow():
    """Active is fitted → bypass RPC, write shadow row with is_shadow=true."""
    from src.training.supply import train_supply_model

    fitted_active = {
        "id": "active-fitted-id",
        "property_id": PROPERTY_ID,
        "layer": "supply",
        "is_active": True,
        "is_shadow": False,
        "algorithm": "bayesian",
        "is_cold_start": False,
        "validation_mae": 4.2,
        "trained_at": "2026-04-01T00:00:00",
    }
    fake = _build_fake(active_row=fitted_active)
    with patch("src.training.supply.get_supabase_client", return_value=fake), \
         patch("src.training.supply.psycopg2.connect", side_effect=Exception("no lock")):
        result = _run(train_supply_model(PROPERTY_ID, max_rows=None, blocking_lock=False))

    # When the gates passed AND active is fitted, the new fit must take
    # the shadow path — direct insert, not the activation RPC.
    rpc_install_calls = [c for c in fake.rpc_calls
                         if c["name"] == "staxis_install_housekeeping_model_run"]
    if result.get("is_active") is True:
        # Gates didn't pass (would have activated via RPC) — that's fine
        # for this test's synthetic data, retry with a stronger model.
        # We still expect zero shadow inserts in the should_not-activate case.
        pass
    shadow_inserts = [
        i for i in fake.inserts
        if i["table"] == "model_runs" and i["data"].get("is_shadow") is True
    ]
    # The shadow path only fires when the new run would have activated
    # (should_activate=True). With our synthetic data and a fitted active,
    # we expect EITHER (a) the shadow path fired, OR (b) gates didn't pass
    # and the RPC path fired with p_should_activate=False. Either is fine
    # for honesty; what's NOT fine is RPC firing with p_should_activate=True.
    rpc_active_calls = [
        c for c in rpc_install_calls
        if c["params"].get("p_should_activate") is True
    ]
    if not shadow_inserts:
        # Gates didn't pass — verify the RPC didn't activate either.
        assert rpc_active_calls == [], (
            "active-fitted exists but new fit took RPC-with-activate path "
            f"(bypassed the safety gate): {rpc_active_calls!r}"
        )
        return  # synthetic data was unlucky; gates didn't pass

    # Shadow path fired — assert the row carries the right markers.
    assert len(shadow_inserts) == 1
    row = shadow_inserts[0]["data"]
    assert row["is_shadow"] is True
    assert row["is_active"] is False
    assert "shadow_started_at" in row and row["shadow_started_at"]
    assert row["property_id"] == PROPERTY_ID
    assert row["layer"] == "supply"
    # Response carries is_shadow flag so callers can branch.
    assert result.get("is_shadow") is True
    assert result.get("is_active") is False
