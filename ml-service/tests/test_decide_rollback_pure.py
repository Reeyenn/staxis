"""Phase 7 v2 (2026-05-22) — decide_rollback is a pure function.

Returns True iff BOTH:
  1. pvalue < alpha (the BH-adjusted alpha the orchestrator passes)
  2. active_mae > baseline_mae (direction guard against perverse
     Wilcoxon rejection on tied data)
"""
from src.monitoring.shadow_mae import decide_rollback


def test_returns_true_when_pvalue_below_alpha_and_active_worse():
    assert decide_rollback(active_mae=10.0, baseline_mae=8.0, pvalue=0.01, alpha=0.05) is True


def test_returns_false_when_pvalue_above_alpha():
    assert decide_rollback(active_mae=10.0, baseline_mae=8.0, pvalue=0.10, alpha=0.05) is False


def test_returns_false_when_pvalue_equals_alpha():
    """Strict less-than — the equality case stays as 'keep active'."""
    assert decide_rollback(active_mae=10.0, baseline_mae=8.0, pvalue=0.05, alpha=0.05) is False


def test_returns_false_when_active_is_better_despite_low_pvalue():
    """Direction guard. Wilcoxon on tied data can rarely reject with
    the wrong sign; we must not deactivate a model that's actually
    performing better than naive.
    """
    assert decide_rollback(active_mae=5.0, baseline_mae=8.0, pvalue=0.001, alpha=0.05) is False


def test_returns_false_when_active_equals_baseline():
    """No improvement is no rejection."""
    assert decide_rollback(active_mae=7.0, baseline_mae=7.0, pvalue=0.001, alpha=0.05) is False
