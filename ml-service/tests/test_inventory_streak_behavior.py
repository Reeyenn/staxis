"""Behavior tests for `_compute_consecutive_passes` (Codex round-5 META J1.3).

Why this exists: every inventory streak-counting bug across rounds 2-5
(Phase 3.2 → Option B → D4 → F2) shipped because the existing test
suite contained ONLY source-grep assertions like
`assert "settings.validation_mae_threshold" in src`. Those tests
checked the prose of the file, not its behavior. The D4 regression
(which actively dropped the prior MAE check while a comment claimed
otherwise) passed every grep test.

This file is the seed of the new pattern: each test exercises the
function with synthetic inputs and asserts on the output. A future
regression that subtly changes the math is caught here, not 6 weeks
later by a reviewer.
"""

from datetime import datetime, timedelta

from src.training._streak import compute_consecutive_passes as _compute_consecutive_passes


# Settings constants matching ml-service/src/config.py defaults.
# The function takes them as args so tests don't depend on env loading.
MIN_EVENTS = 30
MAE_RATIO = 0.10
CAP = 5
CURRENT_MEAN = 1.0  # synthetic — units don't matter for streak math


def _good_run(*, val_mae: float = 0.05, train_mae: float = 1.0, rows: int = 60):
    """Build a synthetic prior run that passes the gate by default."""
    return {
        "validation_mae": val_mae,
        "training_mae": train_mae,
        "training_row_count": rows,
    }


def _bad_run(*, val_mae: float = 5.0, train_mae: float = 1.0, rows: int = 60):
    """Build a synthetic prior run that FAILS the MAE gate."""
    return {
        "validation_mae": val_mae,
        "training_mae": train_mae,
        "training_row_count": rows,
    }


# ────────────────────────────────────────────────────────────────────────────
# Core behavior — current run gating
# ────────────────────────────────────────────────────────────────────────────
def test_returns_zero_when_current_run_fails():
    """If the current run doesn't pass its own gate, streak is 0
    regardless of prior history."""
    priors = [_good_run() for _ in range(10)]
    assert _compute_consecutive_passes(
        this_run_passes=False,
        prior_runs=priors,
        min_events=MIN_EVENTS,
        mae_ratio_threshold=MAE_RATIO,
        cap=CAP,
        current_mean_observed_rate=CURRENT_MEAN,
    ) == 0


def test_returns_one_when_current_passes_but_no_priors():
    """First-ever good run for a new property → streak = 1."""
    assert _compute_consecutive_passes(
        this_run_passes=True,
        prior_runs=[],
        min_events=MIN_EVENTS,
        mae_ratio_threshold=MAE_RATIO,
        cap=CAP,
        current_mean_observed_rate=CURRENT_MEAN,
    ) == 1


# ────────────────────────────────────────────────────────────────────────────
# THE D4 REGRESSION TEST — the bug Codex caught in round 4
# ────────────────────────────────────────────────────────────────────────────
def test_d4_regression_high_mae_priors_do_not_count():
    """D4 dropped the MAE check from prior_passes entirely. Result:
    a current good run + N historical bad runs flipped streak to N+1
    and could activate after just 1 actually-good run.

    This is THE test that would have caught it. The streak must NOT
    count high-MAE prior runs as passing — even if their row counts
    are high. F2 restored the check; this test pins it.
    """
    priors = [
        _bad_run(val_mae=5.0, train_mae=1.0, rows=60),  # ratio=5.0 > 0.10
        _bad_run(val_mae=5.0, train_mae=1.0, rows=60),
        _bad_run(val_mae=5.0, train_mae=1.0, rows=60),
        _bad_run(val_mae=5.0, train_mae=1.0, rows=60),
    ]
    streak = _compute_consecutive_passes(
        this_run_passes=True,
        prior_runs=priors,
        min_events=MIN_EVENTS,
        mae_ratio_threshold=MAE_RATIO,
        cap=CAP,
        current_mean_observed_rate=CURRENT_MEAN,
    )
    assert streak == 1, (
        f"D4 regression: expected streak 1 (current good only), got {streak}. "
        "Means high-MAE prior runs are being counted as passing."
    )


def test_streak_counts_consecutive_good_priors():
    """The happy path: current good + 4 good priors → streak = 5 (the cap)."""
    priors = [_good_run() for _ in range(10)]
    streak = _compute_consecutive_passes(
        this_run_passes=True,
        prior_runs=priors,
        min_events=MIN_EVENTS,
        mae_ratio_threshold=MAE_RATIO,
        cap=CAP,
        current_mean_observed_rate=CURRENT_MEAN,
    )
    assert streak == CAP


def test_streak_breaks_at_first_failing_prior():
    """Order matters: priors are most-recent-first. Walk until a fail.
    [good, good, bad, good, good] → streak = 3 (current + 2 good before bad)."""
    priors = [_good_run(), _good_run(), _bad_run(), _good_run(), _good_run()]
    streak = _compute_consecutive_passes(
        this_run_passes=True,
        prior_runs=priors,
        min_events=MIN_EVENTS,
        mae_ratio_threshold=MAE_RATIO,
        cap=CAP,
        current_mean_observed_rate=CURRENT_MEAN,
    )
    assert streak == 3


# ────────────────────────────────────────────────────────────────────────────
# Edge cases — gate boundaries
# ────────────────────────────────────────────────────────────────────────────
def test_low_row_count_prior_fails_gate():
    """A prior run with <min_events row count fails regardless of MAE."""
    priors = [_good_run(rows=MIN_EVENTS - 1)]
    streak = _compute_consecutive_passes(
        this_run_passes=True,
        prior_runs=priors,
        min_events=MIN_EVENTS,
        mae_ratio_threshold=MAE_RATIO,
        cap=CAP,
        current_mean_observed_rate=CURRENT_MEAN,
    )
    assert streak == 1  # only the current run


def test_prior_with_null_training_mae_falls_back_to_current_mean():
    """F2 fix: older rows without training_mae should use the current
    run's mean as the denominator (the only stable value available
    in that case). Pre-F2, ratio was unbounded → streak broke for
    legitimate prior runs."""
    priors = [
        {"training_mae": None, "validation_mae": 0.05, "training_row_count": 60},
    ]
    streak = _compute_consecutive_passes(
        this_run_passes=True,
        prior_runs=priors,
        min_events=MIN_EVENTS,
        mae_ratio_threshold=MAE_RATIO,
        cap=CAP,
        current_mean_observed_rate=1.0,  # ratio = 0.05 / 1.0 = 0.05 → passes
    )
    assert streak == 2


def test_streak_never_exceeds_cap():
    """Even with 100 good priors, streak caps at the configured value."""
    priors = [_good_run() for _ in range(100)]
    streak = _compute_consecutive_passes(
        this_run_passes=True,
        prior_runs=priors,
        min_events=MIN_EVENTS,
        mae_ratio_threshold=MAE_RATIO,
        cap=CAP,
        current_mean_observed_rate=CURRENT_MEAN,
    )
    assert streak == CAP


def test_validation_mae_at_threshold_boundary_fails():
    """Threshold is strict less-than. ratio == threshold fails."""
    # Crafted so ratio = 0.10 exactly, which should NOT pass.
    priors = [_good_run(val_mae=0.10, train_mae=1.0)]
    streak = _compute_consecutive_passes(
        this_run_passes=True,
        prior_runs=priors,
        min_events=MIN_EVENTS,
        mae_ratio_threshold=MAE_RATIO,
        cap=CAP,
        current_mean_observed_rate=CURRENT_MEAN,
    )
    assert streak == 1, "ratio == threshold must NOT pass (strict less-than)"


# ────────────────────────────────────────────────────────────────────────────
# [9] denominator: prior runs use mean_observed_rate, NOT training_mae
# ────────────────────────────────────────────────────────────────────────────
def test_prior_uses_persisted_mean_observed_rate_not_training_mae():
    """A prior whose val_mae is 40% of its mean must FAIL the 10% gate, even if
    its training_mae is large. The old code divided by max(training_mae, mean),
    so a large training_mae (5.0) made ratio 0.4/5.0 = 0.08 < 0.10 and the bad
    prior counted. Now the prior's persisted mean_observed_rate (1.0) is the
    denominator → ratio 0.40 → correctly fails."""
    prior = {
        "validation_mae": 0.4,
        "training_mae": 5.0,                       # would mask the failure (old bug)
        "training_row_count": 60,
        "hyperparameters": {"mean_observed_rate": 1.0},
    }
    streak = _compute_consecutive_passes(
        this_run_passes=True, prior_runs=[prior],
        min_events=MIN_EVENTS, mae_ratio_threshold=MAE_RATIO, cap=CAP,
        current_mean_observed_rate=1.0,
    )
    assert streak == 1, "prior must be judged on its own mean_observed_rate"


def test_prior_passes_on_its_own_mean_when_train_mae_tiny():
    """Symmetric: an overfit prior (tiny train_mae) must still PASS when its
    val_mae is small relative to its OWN mean. Old code's max(train_mae, mean)
    could understate the denominator and unfairly fail it."""
    prior = {
        "validation_mae": 0.4,
        "training_mae": 0.001,
        "training_row_count": 60,
        "hyperparameters": {"mean_observed_rate": 8.0},   # ratio 0.4/8 = 0.05 → pass
    }
    streak = _compute_consecutive_passes(
        this_run_passes=True, prior_runs=[prior],
        min_events=MIN_EVENTS, mae_ratio_threshold=MAE_RATIO, cap=CAP,
        current_mean_observed_rate=1.0,
    )
    assert streak == 2


# ────────────────────────────────────────────────────────────────────────────
# [2] time-spacing distinctness gate
# ────────────────────────────────────────────────────────────────────────────
_BASE = datetime(2026, 2, 1, 12, 0, 0)


def _good_run_at(days_before: float):
    return {**_good_run(), "trained_at": (_BASE - timedelta(days=days_before)).isoformat()}


def test_rapid_retrains_do_not_inflate_streak():
    """4 good priors all minutes apart → distinctness gate skips them → streak 1."""
    priors = [_good_run_at(days_before=(i + 1) / 144.0) for i in range(4)]  # ~10-40 min back
    streak = _compute_consecutive_passes(
        this_run_passes=True, prior_runs=priors,
        min_events=MIN_EVENTS, mae_ratio_threshold=MAE_RATIO, cap=CAP,
        current_mean_observed_rate=CURRENT_MEAN,
        current_trained_at=_BASE.isoformat(),
        min_gap_seconds=24 * 3600,
    )
    assert streak == 1


def test_distinct_weekly_priors_count_toward_streak():
    """4 good priors each 7 days apart → 5 distinct windows → streak == cap."""
    priors = [_good_run_at(days_before=7 * (i + 1)) for i in range(4)]
    streak = _compute_consecutive_passes(
        this_run_passes=True, prior_runs=priors,
        min_events=MIN_EVENTS, mae_ratio_threshold=MAE_RATIO, cap=CAP,
        current_mean_observed_rate=CURRENT_MEAN,
        current_trained_at=_BASE.isoformat(),
        min_gap_seconds=24 * 3600,
    )
    assert streak == CAP


def test_too_close_failing_prior_still_breaks_streak():
    """A FAILING run minutes after the current run must BREAK the streak, not be
    skipped as 'non-distinct' (Codex MED-1). Otherwise a broken model keeps an
    accumulating streak."""
    bad_recent = {**_bad_run(), "trained_at": (_BASE - timedelta(minutes=5)).isoformat()}
    good_old = {**_good_run(), "trained_at": (_BASE - timedelta(days=8)).isoformat()}
    streak = _compute_consecutive_passes(
        this_run_passes=True, prior_runs=[bad_recent, good_old],
        min_events=MIN_EVENTS, mae_ratio_threshold=MAE_RATIO, cap=CAP,
        current_mean_observed_rate=CURRENT_MEAN,
        current_trained_at=_BASE.isoformat(), min_gap_seconds=24 * 3600,
    )
    assert streak == 1  # the recent failure breaks it; the older good run never counts


def test_spacing_on_breaks_on_missing_trained_at():
    """With spacing on, a prior with no parseable trained_at can't be proven
    distinct → stop counting (don't silently count it)."""
    priors = [_good_run()]  # no trained_at
    streak = _compute_consecutive_passes(
        this_run_passes=True, prior_runs=priors,
        min_events=MIN_EVENTS, mae_ratio_threshold=MAE_RATIO, cap=CAP,
        current_mean_observed_rate=CURRENT_MEAN,
        current_trained_at=_BASE.isoformat(),
        min_gap_seconds=24 * 3600,
    )
    assert streak == 1
