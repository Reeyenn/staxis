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


# ─── Phase M3.4 — anti-regression for partial-posterior silent-prior bug ────


def _posterior_missing(*field_names):
    """Build a posterior dict with the named required fields removed.

    Used to verify hard-validation of REQUIRED_POSTERIOR_FIELDS.
    """
    posterior = _minimal_valid_posterior_dict()
    for f in field_names:
        del posterior[f]
    return posterior


def test_hydrate_rejects_partial_posterior_missing_mu_n():
    """Phase M3.4 anti-regression for Codex finding #2.

    On main pre-M3.4: an active Bayesian with mu_n absent silently fell
    through to BayesianRegression.predict_quantile's `mu_n is None`
    branch (bayesian_regression.py:159-162) which RE-INITIALIZES the
    prior and serves prior predictions. Operator saw plausible numbers
    instead of the explicit "retrain needed" failure.

    M3.4: hard-validate mu_n is present BEFORE constructing the model.
    Missing → return None from hydrate → predict_supply surfaces
    "no usable posterior_params (retrain needed)".
    """
    from src.inference.supply import predict_supply

    fake = make_fake_supabase(
        fetch_many={"model_runs": [_make_bayesian_active_model_run(
            property_id=PROPERTY_ID,
            posterior_params=_posterior_missing("mu_n"),
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

    assert result.get("error") == "Active supply model has no usable posterior_params (retrain needed)", (
        f"Partial-posterior corruption (mu_n missing) silently served prior predictions: {result!r}"
    )


def test_hydrate_rejects_partial_posterior_missing_sigma_n():
    """Same as mu_n test but for sigma_n. Each required field must trip the validator."""
    from src.inference.supply import predict_supply

    fake = make_fake_supabase(
        fetch_many={"model_runs": [_make_bayesian_active_model_run(
            property_id=PROPERTY_ID,
            posterior_params=_posterior_missing("sigma_n"),
        )]},
        execute_sql={
            "schedule_assignments": [
                make_schedule_assignment(staff_id="s1", assigned_rooms=["101"]),
            ],
            "plan_snapshots": [make_plan_snapshot(total_rooms=30, checkout_room_numbers=["101"])],
        },
    )

    with patch("src.inference.supply.get_supabase_client", return_value=fake):
        result = _run(predict_supply(PROPERTY_ID, date(2026, 5, 15)))

    assert result.get("error") == "Active supply model has no usable posterior_params (retrain needed)"


def test_hydrate_rejects_partial_posterior_missing_alpha_n():
    """alpha_n is part of the t-distribution noise estimate; missing = no usable posterior."""
    from src.inference.supply import predict_supply

    fake = make_fake_supabase(
        fetch_many={"model_runs": [_make_bayesian_active_model_run(
            property_id=PROPERTY_ID,
            posterior_params=_posterior_missing("alpha_n"),
        )]},
        execute_sql={
            "schedule_assignments": [
                make_schedule_assignment(staff_id="s1", assigned_rooms=["101"]),
            ],
            "plan_snapshots": [make_plan_snapshot(total_rooms=30, checkout_room_numbers=["101"])],
        },
    )

    with patch("src.inference.supply.get_supabase_client", return_value=fake):
        result = _run(predict_supply(PROPERTY_ID, date(2026, 5, 15)))

    assert result.get("error") == "Active supply model has no usable posterior_params (retrain needed)"


def test_hydrate_rejects_partial_posterior_missing_beta_n():
    """beta_n is the second t-distribution param. Same gating."""
    from src.inference.supply import predict_supply

    fake = make_fake_supabase(
        fetch_many={"model_runs": [_make_bayesian_active_model_run(
            property_id=PROPERTY_ID,
            posterior_params=_posterior_missing("beta_n"),
        )]},
        execute_sql={
            "schedule_assignments": [
                make_schedule_assignment(staff_id="s1", assigned_rooms=["101"]),
            ],
            "plan_snapshots": [make_plan_snapshot(total_rooms=30, checkout_room_numbers=["101"])],
        },
    )

    with patch("src.inference.supply.get_supabase_client", return_value=fake):
        result = _run(predict_supply(PROPERTY_ID, date(2026, 5, 15)))

    assert result.get("error") == "Active supply model has no usable posterior_params (retrain needed)"


def test_hydrate_rejects_partial_posterior_missing_feature_names():
    """Missing feature_names → can't align inference X with posterior → reject."""
    from src.inference.supply import predict_supply

    fake = make_fake_supabase(
        fetch_many={"model_runs": [_make_bayesian_active_model_run(
            property_id=PROPERTY_ID,
            posterior_params=_posterior_missing("feature_names"),
        )]},
        execute_sql={
            "schedule_assignments": [
                make_schedule_assignment(staff_id="s1", assigned_rooms=["101"]),
            ],
            "plan_snapshots": [make_plan_snapshot(total_rooms=30, checkout_room_numbers=["101"])],
        },
    )

    with patch("src.inference.supply.get_supabase_client", return_value=fake):
        result = _run(predict_supply(PROPERTY_ID, date(2026, 5, 15)))

    assert result.get("error") == "Active supply model has no usable posterior_params (retrain needed)"


def test_hydrate_accepts_complete_posterior_with_optional_priors_missing():
    """mu_0/sigma_0/alpha/beta are PRE-FIT priors. A fitted model legitimately
    doesn't need them re-loaded — the posterior fields supersede. Validating
    them would over-reject. Test pins that the validator is not over-broad.
    """
    from src.inference.supply import predict_supply

    posterior = _minimal_valid_posterior_dict()
    # Remove the OPTIONAL pre-fit prior fields. These should not trip validation.
    for f in ("mu_0", "sigma_0", "alpha", "beta"):
        posterior.pop(f, None)

    fake = make_fake_supabase(
        fetch_many={"model_runs": [_make_bayesian_active_model_run(
            property_id=PROPERTY_ID,
            posterior_params=posterior,
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

    # Should succeed — fitted posterior is complete; optional priors absent is fine.
    assert "error" not in result, (
        f"Validator over-rejected: optional pre-fit priors absent should still hydrate: {result!r}"
    )
    assert result["predicted_rooms"] == 1
