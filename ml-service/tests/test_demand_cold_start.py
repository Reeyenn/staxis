"""Phase M3 (2026-05-14) — behavior tests for the cold-start cohort-prior
helpers shared by demand + supply training paths.

Module under test: src/training/_cold_start.py (extracted so it doesn't
pull sklearn — same Phase L pattern as _streak.py for inventory).

What this proves:
  1. lookup_cohort_prior returns the most-specific cohort prior when one
     exists, falls through to global, then industry-default, then a
     hardcoded last-resort number.
  2. install_cold_start passes the right payload to the RPC and unpacks
     the response correctly.
  3. The RPC's "refuse to clobber a real model" return (NULL) is handled
     as a non-error skipped result, not as a fatal error.
  4. RPC exceptions are LOGGED + returned as error dicts (Phase L
     discipline rule #3 — never swallow silently).

Per Phase L: behavior tests with seeded inputs + asserted outputs.
No source-grep tests.
"""
from unittest.mock import MagicMock

from src.training._cold_start import (
    install_cold_start,
    lookup_cohort_prior,
)


def _make_client(prop_row=None, priors_table=None, rpc_response_data=None,
                 rpc_raises=None):
    """Build a fake supabase client with controlled responses.

    prop_row: returned by fetch_one('properties', ...). None = property not found.
    priors_table: dict {cohort_key: row} — fetch_one(<table>, ...) returns matching row.
    rpc_response_data: what .rpc(...).execute() returns as .data
    rpc_raises: if set, .rpc().execute() raises this exception
    """
    client = MagicMock()

    def fetch_one(table, filters=None):
        if table == "properties":
            return prop_row
        if table in ("demand_priors", "supply_priors"):
            ck = (filters or {}).get("cohort_key")
            return (priors_table or {}).get(ck)
        return None

    client.fetch_one.side_effect = fetch_one

    rpc_mock = MagicMock()
    if rpc_raises:
        rpc_mock.execute.side_effect = rpc_raises
    else:
        rpc_result = MagicMock()
        rpc_result.data = rpc_response_data
        rpc_mock.execute.return_value = rpc_result
    client.client = MagicMock()
    client.client.rpc.return_value = rpc_mock
    return client


# ─── lookup_cohort_prior ─────────────────────────────────────────────────


def test_lookup_uses_specific_cohort_when_available():
    """Property has full cohort metadata + matching cohort prior exists."""
    client = _make_client(
        prop_row={"id": "p1", "brand": "Comfort Suites", "region": "South", "size_tier": "medium"},
        priors_table={
            "comfort-suites-south-medium": {
                "prior_minutes_per_room_per_day": 25.0,
                "prior_strength": 2.0,
                "source": "cohort-aggregate",
            },
        },
    )
    rate, strength, source, key = lookup_cohort_prior(
        client, "p1",
        table="demand_priors",
        value_col="prior_minutes_per_room_per_day",
        hardcoded_fallback=20.0,
    )
    assert rate == 25.0
    assert strength == 2.0
    assert source == "cohort-aggregate"
    assert key == "comfort-suites-south-medium"


def test_lookup_falls_through_to_global_when_specific_missing():
    """Specific cohort exists in property metadata but no row in priors table."""
    client = _make_client(
        prop_row={"id": "p1", "brand": "RareBrand", "region": "Mars", "size_tier": "huge"},
        priors_table={
            "global": {
                "prior_minutes_per_room_per_day": 18.0,
                "prior_strength": 1.0,
                "source": "cohort-aggregate",
            },
        },
    )
    rate, strength, source, key = lookup_cohort_prior(
        client, "p1",
        table="demand_priors",
        value_col="prior_minutes_per_room_per_day",
        hardcoded_fallback=20.0,
    )
    assert rate == 18.0
    assert key == "global"


def test_lookup_falls_through_to_industry_default_when_no_cohort_data():
    """No specific or global cohort row — only the industry seed exists."""
    client = _make_client(
        prop_row={"id": "p1", "brand": None, "region": None, "size_tier": None},
        priors_table={
            "industry-default": {
                "prior_minutes_per_room_per_day": 20.0,
                "prior_strength": 0.5,
                "source": "industry-benchmark",
            },
        },
    )
    rate, strength, source, key = lookup_cohort_prior(
        client, "p1",
        table="demand_priors",
        value_col="prior_minutes_per_room_per_day",
        hardcoded_fallback=20.0,
    )
    assert rate == 20.0
    assert key == "industry-default"
    assert source == "industry-benchmark"


def test_lookup_hardcoded_fallback_when_table_empty():
    """Even if industry-default seed is gone, return a hardcoded sane value.

    Defense-in-depth: should never hit in prod (migration 0122 seeds the
    industry-default row), but if someone deletes it the system shouldn't
    crash on cold-start install.
    """
    client = _make_client(
        prop_row={"id": "p1", "brand": None, "region": None, "size_tier": None},
        priors_table={},  # empty
    )
    rate, strength, source, key = lookup_cohort_prior(
        client, "p1",
        table="supply_priors",
        value_col="prior_minutes_per_event",
        hardcoded_fallback=30.0,
    )
    assert rate == 30.0  # hardcoded fallback
    assert key == "hardcoded-fallback"


def test_lookup_logs_structured_event_when_properties_fetch_raises(capsys):
    """Phase L rule #3: silent swallow is a bug. When properties fetch fails,
    lookup must emit a structured log line before falling through.
    """
    client = MagicMock()

    def fetch_one(table, filters=None):
        if table == "properties":
            raise RuntimeError("simulated db outage")
        if table == "demand_priors" and (filters or {}).get("cohort_key") == "industry-default":
            return {
                "prior_minutes_per_room_per_day": 20.0,
                "prior_strength": 0.5,
                "source": "industry-benchmark",
            }
        return None

    client.fetch_one.side_effect = fetch_one

    rate, _, _, key = lookup_cohort_prior(
        client, "p1",
        table="demand_priors",
        value_col="prior_minutes_per_room_per_day",
        hardcoded_fallback=20.0,
    )
    # Lookup still falls through to industry-default — graceful degradation.
    assert rate == 20.0
    assert key == "industry-default"
    # And structured-log line was emitted on the swallow.
    out = capsys.readouterr().out
    assert "cold_start_lookup_swallowed" in out
    assert "fetch_properties" in out
    assert "simulated db outage" in out


def test_lookup_logs_structured_event_when_priors_fetch_raises(capsys):
    """When the priors table fetch raises for one cohort key, log + try next."""
    client = MagicMock()

    def fetch_one(table, filters=None):
        if table == "properties":
            return {"id": "p1", "brand": None, "region": None, "size_tier": None}
        if table == "demand_priors":
            ck = (filters or {}).get("cohort_key")
            if ck == "global":
                raise RuntimeError("transient timeout")
            if ck == "industry-default":
                return {
                    "prior_minutes_per_room_per_day": 20.0,
                    "prior_strength": 0.5,
                    "source": "industry-benchmark",
                }
        return None

    client.fetch_one.side_effect = fetch_one

    rate, _, _, key = lookup_cohort_prior(
        client, "p1",
        table="demand_priors",
        value_col="prior_minutes_per_room_per_day",
        hardcoded_fallback=20.0,
    )
    assert rate == 20.0
    assert key == "industry-default"
    out = capsys.readouterr().out
    assert "cold_start_lookup_swallowed" in out
    assert "fetch_cohort_prior" in out
    assert "global" in out
    assert "transient timeout" in out


def test_lookup_works_for_supply_priors_with_different_value_col():
    """Same helper handles both demand + supply because value_col is parameterized."""
    client = _make_client(
        prop_row={"id": "p1", "brand": "Hilton", "region": "West", "size_tier": "large"},
        priors_table={
            "hilton-west-large": {
                "prior_minutes_per_event": 28.5,
                "prior_strength": 2.0,
                "source": "cohort-aggregate",
            },
        },
    )
    rate, strength, source, key = lookup_cohort_prior(
        client, "p1",
        table="supply_priors",
        value_col="prior_minutes_per_event",
        hardcoded_fallback=30.0,
    )
    assert rate == 28.5
    assert key == "hilton-west-large"


# ─── install_cold_start ──────────────────────────────────────────────────


def test_install_returns_active_cold_start_on_rpc_success():
    """RPC returns TABLE(ok=true, reason=null, model_run_id=...) → active cold-start.

    Phase M3.1 (migration 0123) changed the RPC return from bare uuid to
    TABLE(ok, reason, model_run_id). Helper unpacks list-of-dicts shape.
    """
    client = _make_client(rpc_response_data=[
        {"ok": True, "reason": None, "model_run_id": "new-model-uuid"},
    ])
    result = install_cold_start(
        client, "p1",
        layer="demand",
        prior_value=22.0,
        prior_strength=2.0,
        source="cohort-aggregate",
        cohort_key="comfort-south-medium",
        local_rows_observed=3,
        value_param_name="prior_minutes_per_room_per_day",
    )
    assert result["model_run_id"] == "new-model-uuid"
    assert result["is_active"] is True
    assert result["cold_start"] is True
    assert result["cohort_key"] == "comfort-south-medium"
    assert result["prior_source"] == "cohort-aggregate"


def test_install_skipped_when_real_model_already_active():
    """RPC returns (ok=false, reason='graduated_model_active') = refused to clobber.

    Load-bearing assertion: a graduated Bayesian model must NOT be replaced
    by a cold-start prior even if local data later drops (e.g., transient
    view glitch returning fewer rows).
    """
    client = _make_client(rpc_response_data=[
        {"ok": False, "reason": "graduated_model_active", "model_run_id": None},
    ])
    result = install_cold_start(
        client, "p1",
        layer="demand",
        prior_value=20.0, prior_strength=0.5,
        source="industry-benchmark", cohort_key="industry-default",
        local_rows_observed=0,
        value_param_name="prior_minutes_per_room_per_day",
    )
    assert result["skipped"] is True
    # Phase M3.1: reason now comes from the RPC, not invented in Python.
    assert result["reason"] == "graduated_model_active"
    assert result["is_active"] is False
    assert result["cold_start"] is False
    # Critically: no error key — this is a normal flow, not a failure.
    assert "error" not in result


def test_install_handles_empty_rpc_response_as_skipped():
    """Defensive: empty data array (e.g. supabase-py shape drift) → skipped.

    The unpack idiom `rows[0] if rows else {}` returns {} for empty data;
    {}.get('ok') is None which is falsy, so we treat as a skipped install
    rather than crashing.
    """
    client = _make_client(rpc_response_data=[])
    result = install_cold_start(
        client, "p1",
        layer="supply",
        prior_value=30.0, prior_strength=0.5,
        source="industry-benchmark", cohort_key="industry-default",
        local_rows_observed=0,
        value_param_name="prior_minutes_per_event",
    )
    assert result["skipped"] is True
    assert "error" not in result


def test_install_returns_error_dict_on_rpc_exception():
    """If the RPC throws, log + return error dict (no swallow).

    Phase L discipline rule #3: bare except handlers must log structured
    events. Caller decides what to do with the error; this function's
    contract is "tell me what happened, don't hide it."
    """
    client = _make_client(rpc_raises=Exception("connection timed out"))
    result = install_cold_start(
        client, "p1",
        layer="supply",
        prior_value=30.0, prior_strength=0.5,
        source="industry-benchmark", cohort_key="industry-default",
        local_rows_observed=0,
        value_param_name="prior_minutes_per_event",
    )
    assert "error" in result
    assert "cold-start install failed" in result["error"]
    assert result["is_active"] is False
    assert result["model_run_id"] is None


def test_install_passes_correct_layer_to_rpc():
    """Both demand + supply share the RPC; layer must be passed correctly."""
    for layer in ("demand", "supply"):
        client = _make_client(rpc_response_data=[
            {"ok": True, "reason": None, "model_run_id": f"id-{layer}"},
        ])
        result = install_cold_start(
            client, "p1",
            layer=layer,
            prior_value=25.0, prior_strength=1.0,
            source="cohort-aggregate", cohort_key="x-y-z",
            local_rows_observed=2,
            value_param_name="prior_minutes_per_room_per_day",
        )
        assert result["model_run_id"] == f"id-{layer}"
        # Verify the RPC was called with the right p_layer arg
        rpc_call = client.client.rpc.call_args
        assert rpc_call[0][1]["p_layer"] == layer


def test_install_handles_missing_property_metadata_gracefully():
    """Property fetch returning None must not crash the install path."""
    client = _make_client(prop_row=None, rpc_response_data=[
        {"ok": True, "reason": None, "model_run_id": "new-id"},
    ])
    result = install_cold_start(
        client, "p1",
        layer="demand",
        prior_value=20.0, prior_strength=0.5,
        source="industry-benchmark", cohort_key="industry-default",
        local_rows_observed=0,
        value_param_name="prior_minutes_per_room_per_day",
    )
    assert result["model_run_id"] == "new-id"
    assert result["cohort_key"] == "industry-default"
