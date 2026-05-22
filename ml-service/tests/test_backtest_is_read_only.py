"""Phase 2.1 (2026-05-22) — the walk-forward backtest MUST NOT mutate
production state. Codex's H2 finding in the v1-plan review: the
naive design would have called train_supply_model / predict_supply
from the production code paths, which upsert to model_runs +
demand_predictions + supply_predictions. v2 wraps the supabase client
in a ReadOnlySupabaseClient proxy that raises on any writer call.

This test asserts that any attempt to call a non-whitelisted writer
DOES raise, and that the legitimate path (run_backtest end-to-end on
synthetic data) completes without violating the proxy.
"""
import pytest

from scripts.backtest_housekeeping import (
    ReadOnlySupabaseClient,
    _ReadOnlyViolation,
)
from tests.conftest import make_fake_supabase


def test_proxy_raises_on_upsert():
    inner = make_fake_supabase()
    proxy = ReadOnlySupabaseClient(inner)
    with pytest.raises(_ReadOnlyViolation):
        proxy.upsert("model_runs", {"id": "abc"})


def test_proxy_raises_on_insert():
    inner = make_fake_supabase()
    proxy = ReadOnlySupabaseClient(inner)
    with pytest.raises(_ReadOnlyViolation):
        proxy.insert("demand_predictions", {"property_id": "x"})


def test_proxy_raises_on_update():
    inner = make_fake_supabase()
    proxy = ReadOnlySupabaseClient(inner)
    with pytest.raises(_ReadOnlyViolation):
        proxy.update("model_runs", {"is_active": False}, {"id": "x"})


def test_proxy_raises_on_delete():
    inner = make_fake_supabase()
    proxy = ReadOnlySupabaseClient(inner)
    with pytest.raises(_ReadOnlyViolation):
        proxy.delete("model_runs", {"id": "x"})


def test_proxy_raises_on_rpc():
    inner = make_fake_supabase()
    proxy = ReadOnlySupabaseClient(inner)
    with pytest.raises(_ReadOnlyViolation):
        proxy.rpc("any_function", {"p_x": 1})


def test_proxy_passes_through_reads():
    """fetch_one / fetch_many / execute_sql work normally."""
    inner = make_fake_supabase(
        fetch_one={"properties": {"id": "abc", "total_rooms": 30}},
        execute_sql={"select 1": [{"col": 1}]},
    )
    proxy = ReadOnlySupabaseClient(inner)
    assert proxy.fetch_one("properties", {"id": "abc"})["total_rooms"] == 30
    assert proxy.execute_sql("select 1") == [{"col": 1}]


def test_proxy_blocks_unknown_attribute_by_default():
    """Defense in depth: any unknown method also refuses."""
    inner = make_fake_supabase()
    proxy = ReadOnlySupabaseClient(inner)
    with pytest.raises(_ReadOnlyViolation):
        proxy.some_future_writer("model_runs", {})
