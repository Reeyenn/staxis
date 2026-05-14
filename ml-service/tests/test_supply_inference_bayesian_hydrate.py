"""Phase M3.3 (2026-05-14) — anti-regression for the silent supply-Bayesian
inference rejection when posterior_params is a dict (Supabase JSONB shape).

Latent bug: _hydrate_bayesian_from_run called json.loads() unconditionally,
which throws TypeError on a dict input. The except returned None, which
made predict_supply return:
  {"error": "Active supply model has no usable posterior_params (retrain needed)"}

ml-run-inference then 502s because supply stage status='error'. Surfaced
when M3.2 dropped the row-count gate, letting Beaumont's supply Bayesian
activate for the first time.

This test seeds a Bayesian-active model_run with posterior_params as a
DICT (matching real Supabase JSONB behavior). On main pre-fix it fails
with the "no usable posterior_params" error. After the fix it succeeds
and writes per-(room, staff) predictions.
"""
import asyncio
from datetime import date
from unittest.mock import patch

from tests.conftest import (
    make_fake_supabase,
    make_plan_snapshot,
    make_schedule_assignment,
)


def _run(coro):
    return asyncio.run(coro)


PROPERTY_ID = "8a041d6e-d881-4f19-83e0-7250f0e36eaa"


def _make_bayesian_active_model_run(*, property_id, posterior_params):
    """Bayesian-active supply model_run with caller-controlled posterior shape.

    The shape parameter lets tests verify both dict (real Supabase JSONB)
    and string (legacy / test-fixture) inputs through the same code path.
    """
    return {
        "id": "supply-bayes-mr-uuid",
        "property_id": property_id,
        "layer": "supply",
        "is_active": True,
        "is_shadow": False,
        "algorithm": "bayesian",
        "model_version": "supply-bayesian-v1-test",
        "trained_at": "2026-05-14T00:00:00",
        "training_row_count": 201,
        "posterior_params": posterior_params,
        "hyperparameters": {},
    }


def _minimal_valid_posterior_dict():
    """Minimal-but-valid Bayesian posterior. 3 features, 1 room, 1 staff."""
    return {
        "mu_n": [0.0, 0.0, 0.0],
        "sigma_n": [[1.0, 0, 0], [0, 1.0, 0], [0, 0, 1.0]],
        "alpha_n": 2.0,
        "beta_n": 1.0,
        "mu_0": [0.0, 0.0, 0.0],
        "sigma_0": [[1.0, 0, 0], [0, 1.0, 0], [0, 0, 1.0]],
        "alpha": 2.0,
        "beta": 1.0,
        "feature_names": ["intercept", "occupancy_at_start", "is_checkout"],
        "feature_set_version": "v2",
    }


def test_bayesian_hydrate_accepts_dict_posterior_params_supabase_jsonb_shape():
    """Anti-regression: posterior_params arriving as a dict (Supabase JSONB
    deserialization) must NOT cause _hydrate_bayesian_from_run to return
    None. Must FAIL on main pre-M3.3 with 'no usable posterior_params'.
    """
    from src.inference.supply import predict_supply

    fake = make_fake_supabase(
        fetch_many={"model_runs": [_make_bayesian_active_model_run(
            property_id=PROPERTY_ID,
            posterior_params=_minimal_valid_posterior_dict(),  # DICT not string
        )]},
        execute_sql={
            "schedule_assignments": [
                make_schedule_assignment(staff_id="s1", assigned_rooms=["101"]),
            ],
            "plan_snapshots": [make_plan_snapshot(
                total_rooms=30, checkout_room_numbers=["101"])],
        },
    )

    with patch("src.inference.supply.get_supabase_client", return_value=fake):
        result = _run(predict_supply(PROPERTY_ID, date(2026, 5, 15)))

    # Load-bearing: NO error key. On main pre-fix this returns
    # {"error": "Active supply model has no usable posterior_params (retrain needed)"}
    assert "error" not in result, (
        f"Bayesian hydrate rejected dict-shaped posterior_params (the actual "
        f"Supabase JSONB shape): {result!r}"
    )
    # And it actually wrote a per-room prediction.
    assert result["predicted_rooms"] == 1


def test_bayesian_hydrate_still_accepts_string_posterior_params_backward_compat():
    """If a future test fixture or legacy model_run somehow passes a
    JSON string, the hydrate path must still parse it. The
    isinstance(x, str) guard preserves backward compat with string input.
    """
    import json as json_mod
    from src.inference.supply import predict_supply

    fake = make_fake_supabase(
        fetch_many={"model_runs": [_make_bayesian_active_model_run(
            property_id=PROPERTY_ID,
            posterior_params=json_mod.dumps(_minimal_valid_posterior_dict()),  # STRING
        )]},
        execute_sql={
            "schedule_assignments": [
                make_schedule_assignment(staff_id="s1", assigned_rooms=["101"]),
            ],
            "plan_snapshots": [make_plan_snapshot(
                total_rooms=30, checkout_room_numbers=["101"])],
        },
    )

    with patch("src.inference.supply.get_supabase_client", return_value=fake):
        result = _run(predict_supply(PROPERTY_ID, date(2026, 5, 15)))

    assert "error" not in result, (
        f"Bayesian hydrate rejected string-shaped posterior_params: {result!r}"
    )
    assert result["predicted_rooms"] == 1


def test_bayesian_hydrate_returns_none_for_truly_corrupt_posterior():
    """The fix must NOT swallow real corruption — a string that isn't
    valid JSON should still hydrate to None and surface the
    'retrain needed' error. Defends against the fix being over-broad.
    """
    from src.inference.supply import predict_supply

    fake = make_fake_supabase(
        fetch_many={"model_runs": [_make_bayesian_active_model_run(
            property_id=PROPERTY_ID,
            posterior_params="this is not valid json{",  # corrupt STRING
        )]},
        execute_sql={
            "schedule_assignments": [
                make_schedule_assignment(staff_id="s1", assigned_rooms=["101"]),
            ],
            "plan_snapshots": [make_plan_snapshot(
                total_rooms=30, checkout_room_numbers=["101"])],
        },
    )

    with patch("src.inference.supply.get_supabase_client", return_value=fake):
        result = _run(predict_supply(PROPERTY_ID, date(2026, 5, 15)))

    # Truly corrupt → hydrate returns None → predict_supply returns the
    # original "retrain needed" error. This is the right behavior; the
    # M3.3 fix is narrow (handle dict shape) and doesn't paper over
    # actual data corruption.
    assert result.get("error") == "Active supply model has no usable posterior_params (retrain needed)"
