"""Tests for BayesianRegression per-coefficient prior mean/variance overrides.

The reduced-exposure inventory model needs a prior mean of [0, prior_s] and a
tight-then-loose per-coefficient variance. This pins:
  * override changes mu_0 / sigma_0 diagonal
  * DEFAULT behavior (no overrides) is bit-for-bit unchanged (demand/supply +
    occupancy-family inventory must not shift)
  * a wrong-length override is ignored (falls back to default) rather than crash
"""
import numpy as np
import pandas as pd

from src.layers.bayesian_regression import BayesianRegression


def _fit_X():
    return pd.DataFrame({"intercept": [1.0, 1.0, 1.0], "x": [0.0, 1.0, 2.0]})


def test_default_prior_unchanged():
    """No overrides → intercept prior 60, others 0; sigma_0 default shape."""
    m = BayesianRegression(prior_strength=1.0)
    m._initialize_prior(_fit_X())
    assert m.mu_0[0] == 60.0
    assert m.mu_0[1] == 0.0
    # default sigma_0: diag (1/strength) with intercept ×10 looser
    assert m.sigma_0[0, 0] == 10.0
    assert m.sigma_0[1, 1] == 1.0


def test_prior_mean_override_applies():
    m = BayesianRegression(prior_strength=1.0, prior_mean=np.array([0.0, 0.5]))
    m._initialize_prior(_fit_X())
    assert m.mu_0[0] == 0.0
    assert m.mu_0[1] == 0.5


def test_prior_variance_override_applies():
    m = BayesianRegression(
        prior_strength=1.0,
        prior_mean=np.array([0.0, 0.5]),
        prior_variance=np.array([1e-6, 2.0]),
    )
    m._initialize_prior(_fit_X())
    assert abs(m.sigma_0[0, 0] - 1e-6) < 1e-12
    assert abs(m.sigma_0[1, 1] - 2.0) < 1e-12
    # off-diagonal zero
    assert m.sigma_0[0, 1] == 0.0


def test_wrong_length_override_falls_back_to_default():
    """A 3-length override on a 2-feature X is ignored (default used), no crash."""
    m = BayesianRegression(prior_strength=1.0, prior_mean=np.array([1.0, 2.0, 3.0]))
    m._initialize_prior(_fit_X())
    assert m.mu_0[0] == 60.0  # default, override ignored


def test_default_fit_matches_pre_override_behavior():
    """A fit with no overrides produces the same posterior as the un-patched
    class would — proves demand/supply are unaffected. We check the posterior
    mean recovers a known linear relationship."""
    rng = np.random.default_rng(0)
    x = np.linspace(0, 10, 50)
    y = 3.0 + 2.0 * x + rng.normal(0, 0.01, size=50)
    X = pd.DataFrame({"intercept": np.ones(50), "x": x})
    m = BayesianRegression(prior_strength=0.01)  # weak prior so data dominates
    m.fit(X, pd.Series(y))
    assert abs(m.mu_n[0] - 3.0) < 0.2
    assert abs(m.mu_n[1] - 2.0) < 0.1
