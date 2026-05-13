"""Tests for Monte Carlo optimizer."""
from datetime import date

import numpy as np
import pytest

from src.optimizer.monte_carlo import (
    _deterministic_seed,
    _invert_quantile_cdf,
)


# ─── Codex post-merge review 2026-05-13 (H-2): upper-tail extrapolation ─────

def test_invert_quantile_cdf_upper_tail_no_clamp():
    """u > q_max must extrapolate, not clamp at max_v.

    Pre-fix the function returned `min(max_v, extrapolated)` which
    discarded the extrapolation slope and capped EVERY u in (q_max, 1.0]
    at exactly max_v. For lognormal cleaning times that's ~10% of
    optimizer draws collapsing to p90 with no mass beyond, biasing
    makespan low and under-recommending headcount.
    """
    # quantiles {0.25: 15, 0.5: 20, 0.9: 60}; slope of last segment is
    # (60-20)/(0.9-0.5) = 100. extrapolated at u=0.95 = 60 + 100*0.05 = 65.
    result = _invert_quantile_cdf({0.25: 15, 0.5: 20, 0.9: 60}, 0.95)
    assert result == pytest.approx(65.0), (
        f"Expected 65.0 (extrapolated), got {result} (likely clamped at max_v)"
    )


def test_invert_quantile_cdf_lower_tail_clamped():
    """u < q_min extrapolates but clamps at min_v (cleaning times >= 0)."""
    # quantiles {0.5: 20, 0.95: 60}; min_v=20. Extrapolation at u=0
    # would give 20 - (60-20)/(0.95-0.5) * 0.5 = 20 - 44.4 = -24.4.
    # Lower-tail clamp to min_v=20 keeps it non-negative.
    result = _invert_quantile_cdf({0.5: 20, 0.95: 60}, 0.01)
    assert result == 20.0, f"Lower tail must clamp at min_v=20, got {result}"


def test_invert_quantile_cdf_distribution_exceeds_max_quantile():
    """A uniform draw with quantiles {p25, p50, p90} should put ~10% past p90."""
    rng = np.random.default_rng(42)
    qd = {0.25: 15.0, 0.5: 20.0, 0.9: 60.0}
    samples = [_invert_quantile_cdf(qd, float(u)) for u in rng.uniform(size=10_000)]
    above_p90 = sum(1 for s in samples if s > 60.0)
    # At u in (0.9, 1.0] (~10% of draws) values must exceed p90=60.
    # Pre-fix this would have been 0%.
    assert above_p90 / 10_000 > 0.05, (
        f"Expected ~10% of draws to exceed p90=60, got {above_p90/10_000:.2%}"
    )


def test_invert_quantile_cdf_degenerate_single_point():
    """Single-quantile dict — both tails return the only value."""
    qd = {0.5: 25.0}
    assert _invert_quantile_cdf(qd, 0.0) == 25.0
    assert _invert_quantile_cdf(qd, 0.5) == 25.0
    assert _invert_quantile_cdf(qd, 1.0) == 25.0


# ─── Codex post-merge review 2026-05-13 (H-3): 128-bit seed ─────────────────

def test_deterministic_seed_same_input_same_state():
    """Reproducibility — same (property, date) → identical state."""
    seed_a = _deterministic_seed("d1f8a3b1-1234-5678-9abc-def012345678", date(2026, 5, 13))
    seed_b = _deterministic_seed("d1f8a3b1-1234-5678-9abc-def012345678", date(2026, 5, 13))
    assert seed_a.entropy == seed_b.entropy, (
        "Same input must produce identical SeedSequence entropy"
    )


def test_deterministic_seed_different_dates_differ():
    """Different dates for same property → independent samples."""
    seed_a = _deterministic_seed("d1f8a3b1-1234-5678-9abc-def012345678", date(2026, 5, 13))
    seed_b = _deterministic_seed("d1f8a3b1-1234-5678-9abc-def012345678", date(2026, 5, 14))
    assert seed_a.entropy != seed_b.entropy


def test_deterministic_seed_uses_full_128_bits():
    """Verify entropy is in the full md5 hex range, not modded to 32 bits.

    Pre-fix the seed was `int(digest[:16], 16) % (2**32)` — capped at 2^32.
    The fix uses `int(digest, 16)` which is a 128-bit (32 hex char) integer.
    """
    seed = _deterministic_seed("d1f8a3b1-1234-5678-9abc-def012345678", date(2026, 5, 13))
    # md5 produces 16 bytes = 128 bits. SeedSequence.entropy stores the
    # original int. The chance of a 128-bit md5 digest happening to be
    # under 2^32 is ~2^-96 — for any real input this is well above 2^32.
    assert seed.entropy > (2**32), (
        f"Seed entropy {seed.entropy} fits in 32 bits — looks like the "
        f"% (2**32) modulus is still in place"
    )


def test_deterministic_seed_drives_default_rng():
    """default_rng accepts SeedSequence and produces deterministic draws."""
    seed_a = _deterministic_seed("uuid-A", date(2026, 5, 13))
    seed_b = _deterministic_seed("uuid-A", date(2026, 5, 13))
    rng_a = np.random.default_rng(seed_a)
    rng_b = np.random.default_rng(seed_b)
    assert np.array_equal(rng_a.uniform(size=10), rng_b.uniform(size=10))


# ─── Existing tests ─────────────────────────────────────────────────────────


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
