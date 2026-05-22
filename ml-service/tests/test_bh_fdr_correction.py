"""Phase 7 v2 (2026-05-22) — Benjamini-Hochberg FDR correction.

Two contracts:

  1. Single test (n=1) reduces to raw alpha — no over-correction.
  2. Fleet of 100 random p-values from uniform[0,1] (the null) should
     yield very few rejections under BH-FDR at alpha=0.05. Compared
     to raw alpha=0.05 which would reject ~5 by expectation, BH
     should reject 0-1 in most runs (the FDR is bounded, not the
     per-test type-1 rate).
"""
import numpy as np

from src.monitoring.fleet_rollback import adjusted_alpha_mask


def test_empty_input_returns_empty_mask():
    assert adjusted_alpha_mask([]) == []


def test_single_pvalue_below_alpha_rejects():
    """n=1 BH reduces to raw alpha comparison."""
    assert adjusted_alpha_mask([0.01], alpha=0.05) == [True]


def test_single_pvalue_above_alpha_does_not_reject():
    assert adjusted_alpha_mask([0.20], alpha=0.05) == [False]


def test_clear_signal_passes_bh_correction():
    """When most p-values are very small (clear effect), BH still rejects."""
    pvalues = [0.0001, 0.0005, 0.001, 0.005, 0.01]
    mask = adjusted_alpha_mask(pvalues, alpha=0.05)
    # All these are clearly significant even after BH correction.
    assert all(mask), f"expected all rejections, got {mask}"


def test_fleet_under_null_keeps_false_positives_bounded():
    """100 uniform[0,1] p-values under the null. BH-FDR at alpha=0.05
    bounds the EXPECTED proportion of false rejections among rejections
    at 5%. With this many tests under the null, BH should typically
    reject 0 hypotheses (vs raw alpha=0.05 which would reject ~5).
    """
    rng = np.random.default_rng(42)
    pvalues = list(rng.uniform(0.0, 1.0, size=100))
    mask = adjusted_alpha_mask(pvalues, alpha=0.05)
    n_reject = sum(mask)
    # Under the null with n=100, BH-FDR typically rejects 0 or 1.
    # We allow up to 3 to keep the test stable across seeds, but
    # this is dramatically less than the ~5 raw-alpha would produce.
    assert n_reject <= 3, (
        f"BH-FDR rejected {n_reject} of 100 null p-values — "
        "expected near-zero, suggests the correction isn't working"
    )
