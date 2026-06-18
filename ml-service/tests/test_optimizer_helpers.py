"""Unit tests for the extracted Monte Carlo optimizer helpers.

These pin the pure simulation core (LPT bin-packing, completion-probability,
headcount search, search-ceiling) that the L2 / L1 / synthetic-room paths
all share. Extracted 2026-06-18.
"""
import numpy as np
import pytest

from src.optimizer.monte_carlo import (
    _lpt_makespan,
    _lpt_completion_prob,
    _search_headcount,
    _headcount_search_ceiling,
)


# ─── _lpt_makespan ──────────────────────────────────────────────────────────

def test_lpt_makespan_two_workers_balanced():
    # jobs [10,20,30,40], 2 workers. LPT packs to {40,10}=50 and {30,20}=50.
    assert _lpt_makespan(np.array([10, 20, 30, 40]), 2) == pytest.approx(50.0)


def test_lpt_makespan_single_worker_is_sum():
    assert _lpt_makespan(np.array([10, 20, 30, 40]), 1) == pytest.approx(100.0)


def test_lpt_makespan_workers_ge_jobs_is_max_job():
    # 4 workers, 4 jobs → each its own worker → makespan = largest job.
    assert _lpt_makespan(np.array([10, 20, 30, 40]), 4) == pytest.approx(40.0)
    assert _lpt_makespan(np.array([10, 20, 30, 40]), 8) == pytest.approx(40.0)


def test_lpt_makespan_zero_headcount_is_inf():
    assert _lpt_makespan(np.array([10.0]), 0) == float("inf")


def test_lpt_makespan_empty_jobs_is_zero():
    assert _lpt_makespan(np.array([]), 3) == pytest.approx(0.0)


def test_lpt_makespan_indivisibility_penalty():
    # One big indivisible job dominates: [100, 1, 1] on 2 workers → 100,
    # NOT the perfectly-divisible 51. This is the core realism the synthetic
    # room path adds over infinite divisibility.
    assert _lpt_makespan(np.array([100, 1, 1]), 2) == pytest.approx(100.0)


# ─── _lpt_completion_prob ───────────────────────────────────────────────────

def test_completion_prob_all_fit():
    times = np.array([[40.0, 40.0]] * 100)
    # 2 workers, each gets one 40-min room → makespan 40 <= 40 → all complete.
    assert _lpt_completion_prob(times, 2, 40.0) == pytest.approx(1.0)


def test_completion_prob_none_fit():
    times = np.array([[40.0, 40.0]] * 100)
    assert _lpt_completion_prob(times, 2, 39.0) == pytest.approx(0.0)


def test_completion_prob_more_workers_monotonic():
    rng = np.random.default_rng(7)
    times = rng.uniform(10, 40, size=(500, 20))
    probs = [_lpt_completion_prob(times, h, 120.0) for h in range(1, 10)]
    for a, b in zip(probs, probs[1:]):
        assert a <= b + 1e-9, "completion prob must be non-decreasing in headcount"


def test_completion_prob_empty_matrix_is_zero():
    assert _lpt_completion_prob(np.zeros((0, 5)), 3, 100.0) == 0.0


# ─── _search_headcount ──────────────────────────────────────────────────────

def test_search_picks_first_meeting_target():
    curve, rec, trunc = _search_headcount(lambda h: 0.0 if h < 3 else 1.0, 10, 0.95)
    assert rec == 3
    assert trunc is False
    assert len(curve) == 10
    assert curve[2] == {"headcount": 3, "p": 1.0}


def test_search_truncates_when_target_unreachable():
    # Best achievable is 0.5 (< 0.95 target) → truncated, returns best headcount.
    curve, rec, trunc = _search_headcount(lambda h: min(0.5, 0.1 * h), 10, 0.95)
    assert trunc is True
    # best p is at the largest h (0.5 plateau) — max() returns the first max,
    # which is the first h that reaches 0.5 (h=5).
    assert rec == 5


# ─── _headcount_search_ceiling ──────────────────────────────────────────────

def test_ceiling_small_workload_floor_10():
    assert _headcount_search_ceiling(500, 420) == 10


def test_ceiling_scales_with_workload():
    assert _headcount_search_ceiling(5200, 420) == 19


def test_ceiling_capped_at_50():
    assert _headcount_search_ceiling(1_000_000, 420) == 50


def test_ceiling_zero_shift_safe():
    # No division-by-zero when shift cap is degenerate.
    assert _headcount_search_ceiling(500, 0) >= 10
