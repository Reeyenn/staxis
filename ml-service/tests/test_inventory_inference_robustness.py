"""Robustness tests for inventory inference numeric guards.

A degenerate posterior can yield NaN quantiles; `max(nan, 0)` returns nan, so
the non-negative clip does NOT catch them. The `_is_finite_nonneg` guard stops
those values reaching the NOT NULL numeric prediction columns.
"""
import numpy as np

from src.inference.inventory_rate import (
    _is_finite_nonneg,
    _predict_bayesian_quantiles,
)


def test_is_finite_nonneg_rejects_bad_values():
    for bad in [float("nan"), float("inf"), -float("inf"), -0.001, None, "x", [1]]:
        assert _is_finite_nonneg(bad) is False
    for good in [0.0, 0, 1, 3.5, 1e6]:
        assert _is_finite_nonneg(good) is True


def test_nan_posterior_produces_nonfinite_quantiles_that_guard_rejects():
    """A NaN-laden posterior yields NaN quantiles (the clip can't save it), and
    the guard flags them as non-finite."""
    params = {
        "mu_n": [float("nan"), 0.5],
        "sigma_n": [[1.0, 0.0], [0.0, 1.0]],
        "alpha_n": 2.0,
        "beta_n": 1.0,
    }
    q = _predict_bayesian_quantiles(params, 60.0)
    # p50 is NaN (mu_n[0] is NaN) → guard must reject it.
    assert not _is_finite_nonneg(q["p50"])


def test_healthy_posterior_passes_guard():
    params = {
        "mu_n": [20.0, 0.5],
        "sigma_n": [[1e-6, 0.0], [0.0, 1e-6]],
        "alpha_n": 50.0,
        "beta_n": 50.0,
    }
    q = _predict_bayesian_quantiles(params, 60.0)
    assert all(_is_finite_nonneg(q[k]) for k in ("p10", "p25", "p50", "p75", "p90"))
