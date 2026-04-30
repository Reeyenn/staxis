"""Tests for Bayesian regression model."""
import numpy as np
import pandas as pd
import pytest

from src.layers.bayesian_regression import BayesianRegression


def test_bayesian_initialization():
    """Test Bayesian model initialization."""
    model = BayesianRegression(prior_strength=1.0)
    assert model.mu_0 is None  # Not initialized until fit
    assert model.n_samples == 0


def test_bayesian_cold_start_predictions():
    """Test predictions from prior (no training data)."""
    model = BayesianRegression()
    model._initialize_prior(pd.DataFrame({"a": [1], "b": [2]}))

    # Predict without fitting (uses prior)
    X = pd.DataFrame({"intercept": [1], "a": [0.5], "b": [1.0]})
    quantiles = model.predict_quantile(X, [0.25, 0.5, 0.75])

    # Should return all quantiles
    assert len(quantiles) == 3
    for q in [0.25, 0.5, 0.75]:
        assert q in quantiles
        assert len(quantiles[q]) == 1
        assert quantiles[q][0] > 0  # Should be positive (clipped)


def test_bayesian_fit_small_data():
    """Test fitting with small dataset."""
    model = BayesianRegression()
    X = pd.DataFrame({
        "intercept": [1, 1, 1, 1],
        "feature1": [0.1, 0.2, 0.3, 0.4],
    })
    y = pd.Series([50, 55, 60, 65])

    model.fit(X, y)
    assert model.n_samples == 4
    assert model.mu_n is not None
    assert model.sigma_n is not None


def test_bayesian_predictions():
    """Test quantile predictions after fitting."""
    model = BayesianRegression()
    X_train = pd.DataFrame({
        "intercept": [1, 1, 1, 1],
        "feature1": [0.1, 0.2, 0.3, 0.4],
    })
    y_train = pd.Series([50, 55, 60, 65])

    model.fit(X_train, y_train)

    X_test = pd.DataFrame({
        "intercept": [1],
        "feature1": [0.25],
    })

    quantiles = model.predict_quantile(X_test, [0.25, 0.5, 0.75])

    # Median should be > 0
    assert quantiles[0.5][0] > 0
    # Quantiles should be monotonically increasing
    assert quantiles[0.25][0] < quantiles[0.5][0]
    assert quantiles[0.5][0] < quantiles[0.75][0]


def test_bayesian_posterior_narrowing():
    """Test that posterior becomes narrower with more data."""
    model1 = BayesianRegression()
    X_small = pd.DataFrame({
        "intercept": [1] * 10,
        "feature1": np.linspace(0, 1, 10),
    })
    y_small = pd.Series(np.linspace(50, 100, 10))
    model1.fit(X_small, y_small)

    model2 = BayesianRegression()
    X_large = pd.DataFrame({
        "intercept": [1] * 100,
        "feature1": np.tile(np.linspace(0, 1, 10), 10),
    })
    y_large = pd.Series(np.tile(np.linspace(50, 100, 10), 10))
    model2.fit(X_large, y_large)

    # Posterior variance should be smaller with more data
    # (higher precision = smaller sigma_n eigenvalues)
    var1 = np.mean(np.diag(model1.sigma_n))
    var2 = np.mean(np.diag(model2.sigma_n))
    assert var2 < var1


def test_bayesian_save_load():
    """Test model serialization."""
    import tempfile
    import os

    model = BayesianRegression()
    X = pd.DataFrame({
        "intercept": [1, 1, 1],
        "feature1": [0.1, 0.2, 0.3],
    })
    y = pd.Series([50, 55, 60])
    model.fit(X, y)

    # Save
    with tempfile.NamedTemporaryFile(delete=False) as f:
        path = f.name

    try:
        model.save(path)

        # Load
        model2 = BayesianRegression()
        model2.load(path)

        # Check parameters match
        assert np.allclose(model.mu_n, model2.mu_n)
        assert np.allclose(model.sigma_n, model2.sigma_n)
        assert model.n_samples == model2.n_samples
    finally:
        os.unlink(path)


def test_bayesian_config():
    """Test config export."""
    model = BayesianRegression(prior_strength=2.0)
    config = model.get_config()

    assert config["algorithm"] == "bayesian"
    assert config["prior_strength"] == 2.0
