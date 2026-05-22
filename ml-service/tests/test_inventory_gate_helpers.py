"""Pure-function tests for the inventory_rate force-deactivate gates.

Pins the contract at `training/_gates.py:should_force_deactivate`. Extracted
in the May 2026 honesty audit (Phase 1) from the inlined gates that used to
live at `training/inventory_rate.py:541-593`. The extraction is behavior-
preserving — these tests cover the same scenarios the inlined code handled.

No Supabase, no RPC stub, no ML deps. If a future change reorders gates or
weakens a threshold, these tests fail loud BEFORE the trainer ships it.
"""
from src.training._gates import should_force_deactivate


def _kwargs(**overrides):
    """Default kwargs for a clean-passing Bayesian model. Overrides apply per-test."""
    base = {
        "algorithm": "bayesian",
        "xgboost_inference_ready": False,
        "is_currently_active": True,
        "validation_holdout_n": 5,
        "validation_mae": 0.05,
        "mean_observed_rate": 1.0,
        "training_row_count": 20,
    }
    base.update(overrides)
    return base


# ── Gate 1: no validation set ─────────────────────────────────────────────


def test_no_validation_set_fires_when_holdout_is_zero():
    force, note = should_force_deactivate(**_kwargs(validation_holdout_n=0, training_row_count=3))
    assert force is True
    assert "rejected_no_validation_set" in note
    assert "3 training rows" in note


def test_no_validation_set_quotes_training_row_count_in_message():
    """The reject message names the training row count so Maria can triage."""
    _, note = should_force_deactivate(**_kwargs(validation_holdout_n=0, training_row_count=4))
    assert "4 training rows" in note


# ── Gate 2: max-MAE safety ────────────────────────────────────────────────


def test_max_mae_fires_when_val_mae_equals_mean():
    """MAE exactly at the mean is no information — must deactivate (>=)."""
    force, note = should_force_deactivate(**_kwargs(validation_mae=1.0, mean_observed_rate=1.0))
    assert force is True
    assert "rejected_high_mae" in note


def test_max_mae_fires_when_val_mae_exceeds_mean():
    force, note = should_force_deactivate(**_kwargs(validation_mae=5.0, mean_observed_rate=2.0))
    assert force is True
    assert "rejected_high_mae" in note


def test_max_mae_absolute_floor_protects_near_zero_mean_items():
    """For items with near-zero mean (cleaning supplies, mean=0.0007), the
    absolute floor of 1.0 prevents accepting a 0.5 MAE as "valid"."""
    force, _ = should_force_deactivate(
        **_kwargs(validation_mae=0.5, mean_observed_rate=0.0007)
    )
    assert force is False, "0.5 < 1.0 floor, should pass"

    force, _ = should_force_deactivate(
        **_kwargs(validation_mae=1.0, mean_observed_rate=0.0007)
    )
    assert force is True, "1.0 >= 1.0 floor, should reject"


def test_max_mae_skipped_when_val_mae_is_none():
    """A None validation_mae shouldn't crash or fire the gate."""
    force, _ = should_force_deactivate(**_kwargs(validation_mae=None))
    # Gate 1 doesn't fire (holdout_n=5), Gate 2 short-circuits on None,
    # Gate 3 doesn't fire (algorithm=bayesian) — clean pass.
    assert force is False


# ── Gate 3: XGBoost dead-end ──────────────────────────────────────────────


def test_xgboost_fires_when_algorithm_xgboost_and_inference_not_ready():
    """The graduation cliff: XGBoost trains but inference can't deserialize."""
    force, note = should_force_deactivate(
        **_kwargs(algorithm="xgboost-quantile", xgboost_inference_ready=False)
    )
    assert force is True
    assert "rejected_xgboost_inference_unavailable" in note


def test_xgboost_passes_when_inference_ready_flag_is_true():
    """When inventory inference learns to deserialize XGBoost, the gate becomes a no-op."""
    force, _ = should_force_deactivate(
        **_kwargs(algorithm="xgboost-quantile", xgboost_inference_ready=True)
    )
    assert force is False


def test_xgboost_gate_ignores_bayesian_algorithm():
    """Only xgboost-quantile is gated by this rule."""
    force, _ = should_force_deactivate(
        **_kwargs(algorithm="bayesian", xgboost_inference_ready=False)
    )
    assert force is False


def test_cold_start_algorithm_never_triggers_xgboost_gate():
    """Cold-start cohort-prior runs pass the gate cleanly."""
    force, _ = should_force_deactivate(
        **_kwargs(algorithm="cold-start-cohort-prior", xgboost_inference_ready=False)
    )
    assert force is False


# ── Gate ordering ─────────────────────────────────────────────────────────


def test_no_validation_wins_over_max_mae_when_both_would_fire():
    """A model with holdout=0 AND val_mae=0 (the sentinel) must report the
    no-validation reason, not the (passing) max-MAE check."""
    force, note = should_force_deactivate(
        **_kwargs(validation_holdout_n=0, validation_mae=0.0, training_row_count=2)
    )
    assert force is True
    assert "rejected_no_validation_set" in note
    assert "rejected_high_mae" not in note


def test_max_mae_wins_over_xgboost_when_both_would_fire():
    """When BOTH conditions hold (xgboost AND val_mae too high), report the
    earlier gate's reason — operator sees the same priority order they
    would have seen in the inlined version."""
    force, note = should_force_deactivate(
        **_kwargs(
            algorithm="xgboost-quantile",
            xgboost_inference_ready=False,
            validation_mae=10.0,
            mean_observed_rate=1.0,
        )
    )
    assert force is True
    assert "rejected_high_mae" in note
    assert "rejected_xgboost_inference_unavailable" not in note


# ── is_currently_active short-circuit ─────────────────────────────────────


def test_inactive_runs_skip_all_gates():
    """Shadow + skip-path runs bypass the gates — only activating runs matter."""
    force, note = should_force_deactivate(
        **_kwargs(
            is_currently_active=False,
            algorithm="xgboost-quantile",
            xgboost_inference_ready=False,
            validation_holdout_n=0,
            validation_mae=999.0,
        )
    )
    assert force is False
    assert note is None


# ── Clean-passing baseline ────────────────────────────────────────────────


def test_clean_bayesian_model_passes_all_gates():
    """The happy path — a healthy Bayesian fit must NOT be force-deactivated."""
    force, note = should_force_deactivate(**_kwargs())
    assert force is False
    assert note is None
