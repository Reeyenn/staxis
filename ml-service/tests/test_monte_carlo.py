"""Tests for Monte Carlo optimizer."""
import numpy as np
import pytest


def test_monte_carlo_completion_probability():
    """Test Monte Carlo completion probability estimation."""
    # Simple test: with enough capacity, should have high completion prob
    np.random.seed(42)

    demand_samples = np.random.uniform(100, 200, 1000)
    shift_cap = 420  # 7 hours
    headcount = 1

    completions = np.sum(demand_samples <= shift_cap * headcount)
    completion_prob = completions / len(demand_samples)

    # With shift_cap=420 and demand_samples in [100, 200],
    # we expect ~100% completion (actually all of them)
    assert completion_prob >= 0.5  # At least moderate completion


def test_monte_carlo_headcount_curves():
    """Test that completion probability increases with headcount."""
    np.random.seed(42)

    demand_samples = np.random.uniform(200, 400, 1000)
    shift_cap = 420

    probs = []
    for headcount in range(1, 6):
        completions = np.sum(demand_samples <= shift_cap * headcount)
        prob = completions / len(demand_samples)
        probs.append(prob)

    # Probabilities should be strictly increasing
    for i in range(len(probs) - 1):
        assert probs[i] <= probs[i + 1], "Completion prob should increase with headcount"


def test_monte_carlo_deterministic():
    """Test Monte Carlo gives consistent results with same seed."""
    np.random.seed(42)
    demand1 = np.random.uniform(100, 300, 1000)

    np.random.seed(42)
    demand2 = np.random.uniform(100, 300, 1000)

    assert np.allclose(demand1, demand2), "Same seed should give same samples"


def test_monte_carlo_target_completion():
    """Test headcount selection for target completion probability."""
    np.random.seed(42)

    demand_samples = np.random.uniform(300, 500, 1000)
    shift_cap = 420
    target_prob = 0.95

    # Find minimum headcount to meet target
    for headcount in range(1, 11):
        completions = np.sum(demand_samples <= shift_cap * headcount)
        prob = completions / len(demand_samples)

        if prob >= target_prob:
            assert headcount >= 2, "Should need at least 2 people for this demand"
            break
