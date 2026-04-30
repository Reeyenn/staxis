"""Tests for static baseline model."""
import numpy as np
import pandas as pd
import pytest

from src.layers.static_baseline import (
    CHECKOUT_MINUTES,
    STAYOVER_DAY1_MINUTES,
    STAYOVER_DAY2PLUS_MINUTES,
    StaticBaseline,
)


def test_static_baseline_initialization():
    """Test baseline initialization."""
    baseline = StaticBaseline()
    assert baseline.fitted is False


def test_static_baseline_fit():
    """Test baseline fit (no-op)."""
    baseline = StaticBaseline()
    X = pd.DataFrame({
        "total_checkouts": [10, 5, 8],
        "stayover_day_1_count": [20, 25, 22],
        "stayover_day_2plus_count": [30, 35, 32],
    })
    y = pd.Series([300, 350, 320])

    baseline.fit(X, y)
    assert baseline.fitted is True


def test_static_baseline_predictions():
    """Test static rule predictions."""
    baseline = StaticBaseline()
    baseline.fit(pd.DataFrame({"col": [1]}), pd.Series([100]))

    X = pd.DataFrame({
        "total_checkouts": [10],
        "stayover_day_1_count": [20],
        "stayover_day_2plus_count": [30],
    })

    pred = baseline.predict(X)
    expected = (
        10 * CHECKOUT_MINUTES
        + 20 * STAYOVER_DAY1_MINUTES
        + 30 * STAYOVER_DAY2PLUS_MINUTES
    )
    assert pred[0] == expected


def test_static_baseline_quantile_consistency():
    """Test that all quantiles return same value."""
    baseline = StaticBaseline()
    baseline.fit(pd.DataFrame({"col": [1]}), pd.Series([100]))

    X = pd.DataFrame({
        "total_checkouts": [10],
        "stayover_day_1_count": [20],
        "stayover_day_2plus_count": [30],
    })

    quantiles = baseline.predict_quantile(X, [0.1, 0.5, 0.9])
    # All quantiles should have same prediction (no uncertainty distribution)
    assert np.allclose(quantiles[0.1], quantiles[0.5])
    assert np.allclose(quantiles[0.5], quantiles[0.9])


def test_static_baseline_missing_columns():
    """Test baseline with missing columns (defaults to 0)."""
    baseline = StaticBaseline()
    baseline.fit(pd.DataFrame({"col": [1]}), pd.Series([100]))

    X = pd.DataFrame({
        "total_checkouts": [10],
        # Missing other columns
    })

    pred = baseline.predict(X)
    expected = 10 * CHECKOUT_MINUTES
    assert pred[0] == expected


def test_static_baseline_config():
    """Test config export."""
    baseline = StaticBaseline()
    config = baseline.get_config()

    assert config["algorithm"] == "static_baseline"
    assert config["checkout_minutes"] == CHECKOUT_MINUTES
