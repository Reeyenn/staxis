"""Tests for XGBoost quantile regressor."""
import numpy as np
import pandas as pd
import pytest

from src.layers.xgboost_quantile import XGBoostQuantile


def test_xgboost_initialization():
    """Test XGBoost initialization."""
    model = XGBoostQuantile(
        quantiles=[0.25, 0.5, 0.75, 0.9],
    )
    assert model.quantiles == [0.25, 0.5, 0.75, 0.9]
    assert len(model.models) == 0  # No models until fit


def test_xgboost_fit():
    """Test fitting XGBoost models."""
    model = XGBoostQuantile(
        quantiles=[0.5, 0.75],
        n_estimators=10,
    )

    X = pd.DataFrame({
        "feature1": np.random.randn(50),
        "feature2": np.random.randn(50),
    })
    y = pd.Series(np.abs(np.random.randn(50) * 20 + 60))

    model.fit(X, y)

    # Should have trained models for each quantile
    assert len(model.models) == 2
    assert 0.5 in model.models
    assert 0.75 in model.models


def test_xgboost_predictions():
    """Test quantile predictions."""
    model = XGBoostQuantile(
        quantiles=[0.25, 0.5, 0.75, 0.9],
        n_estimators=10,
    )

    X_train = pd.DataFrame({
        "feature1": np.linspace(0, 1, 50),
        "feature2": np.linspace(0, 1, 50),
    })
    y_train = pd.Series(X_train["feature1"] * 100 + 50)

    model.fit(X_train, y_train)

    X_test = pd.DataFrame({
        "feature1": [0.5],
        "feature2": [0.5],
    })

    predictions = model.predict_quantile(X_test, [0.25, 0.5, 0.75, 0.9])

    # Should return all quantiles
    assert len(predictions) == 4
    # Predictions should be positive
    for q in [0.25, 0.5, 0.75, 0.9]:
        assert predictions[q][0] > 0
    # Quantiles should be monotonically increasing
    assert predictions[0.25][0] <= predictions[0.5][0]
    assert predictions[0.5][0] <= predictions[0.75][0]
    assert predictions[0.75][0] <= predictions[0.9][0]


def test_xgboost_interpolation():
    """Test interpolation for untrained quantiles."""
    model = XGBoostQuantile(
        quantiles=[0.25, 0.75],
        n_estimators=10,
    )

    X_train = pd.DataFrame({
        "feature1": np.linspace(0, 1, 50),
    })
    y_train = pd.Series(X_train["feature1"] * 100 + 50)

    model.fit(X_train, y_train)

    X_test = pd.DataFrame({
        "feature1": [0.5],
    })

    # Request quantile that wasn't trained (0.5)
    predictions = model.predict_quantile(X_test, [0.5])

    # Should interpolate between 0.25 and 0.75
    assert 0.5 in predictions
    assert predictions[0.5][0] > 0


def test_xgboost_save_load():
    """Test model serialization."""
    import tempfile
    import os

    model = XGBoostQuantile(
        quantiles=[0.5, 0.75],
        n_estimators=10,
    )

    X = pd.DataFrame({
        "feature1": np.linspace(0, 1, 50),
    })
    y = pd.Series(X["feature1"] * 100 + 50)

    model.fit(X, y)

    # Save
    with tempfile.NamedTemporaryFile(delete=False) as f:
        path = f.name

    try:
        model.save(path)

        # Load
        model2 = XGBoostQuantile()
        model2.load(path)

        # Check parameters match
        assert model2.quantiles == model.quantiles

        # Predictions should match
        X_test = pd.DataFrame({"feature1": [0.5]})
        pred1 = model.predict(X_test)
        pred2 = model2.predict(X_test)
        assert np.allclose(pred1, pred2, atol=0.1)

    finally:
        os.unlink(path)


def test_xgboost_config():
    """Test config export."""
    model = XGBoostQuantile(
        quantiles=[0.5, 0.75],
        max_depth=6,
        learning_rate=0.05,
    )

    config = model.get_config()

    assert config["algorithm"] == "xgboost-quantile"
    assert config["max_depth"] == 6
    assert config["learning_rate"] == 0.05
