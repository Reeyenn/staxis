"""Pure-function streak counting for inventory model graduation.

Codex round-5 META J1.3 (2026-05-13): extracted from
`_train_single_item` (inventory_rate.py) so the streak logic — which
has been the source of regressions in rounds 2 (Phase 3.2),
3 (Option B), 4 (D4 + F2) — is unit-testable in isolation.

This module has NO ML deps (no numpy, no pandas, no supabase) beyond the
dependency-light `_streak_utils` ISO-date parser. That keeps the test suite
import-time fast AND makes the function trivial to property-test going forward.
If a future regression touches streak math, the test in
`tests/test_inventory_streak_behavior.py` catches it BEFORE it ships.
"""
from typing import Any, Dict, Iterable, Optional

from src.training._streak_utils import parse_iso_datetime


def _prior_mean_observed_rate(pr: Dict[str, Any], fallback: float) -> float:
    """The activation-gate denominator for a prior run.

    The gate is `validation_mae / mean_observed_rate < threshold`. The trainer
    persists `mean_observed_rate` in `hyperparameters` (honesty-audit Phase 2),
    so use the prior run's OWN value when present. Older rows that predate that
    field fall back to the current run's mean. We deliberately do NOT use the
    prior's `training_mae` (a wholly different quantity) — doing so made the
    streak gate mean nothing: an overfit prior (tiny train_mae) failed unfairly
    and an underfit prior (large train_mae) sailed through.
    """
    hp = pr.get("hyperparameters")
    if isinstance(hp, dict):
        val = hp.get("mean_observed_rate")
        if val is not None:
            try:
                v = float(val)
                if v > 1e-9:
                    return v
            except (TypeError, ValueError):
                pass
    return fallback


def compute_consecutive_passes(
    *,
    this_run_passes: bool,
    prior_runs: Iterable[Dict[str, Any]],
    min_events: int,
    mae_ratio_threshold: float,
    cap: int,
    current_mean_observed_rate: float,
    current_trained_at: Optional[str] = None,
    min_gap_seconds: float = 0.0,
) -> int:
    """Count consecutive passing model_runs ending with the current run.

    Each prior run "passes" when:
      • training_row_count >= min_events
      • validation_mae / mean_observed_rate < mae_ratio_threshold
        (mean_observed_rate is the prior's persisted value, else the current
        run's mean — NEVER training_mae)

    Distinctness gate (Phase M3.4 parity with demand/supply): when
    `min_gap_seconds > 0`, a prior run only counts toward the streak if its
    `trained_at` is at least `min_gap_seconds` before the previously-counted
    run. This stops 5 rapid retrains on identical data (manual cron dispatch,
    onboarding script, dev verification) masquerading as 5 distinct weekly
    windows of stability. A non-distinct run is SKIPPED (continue), not failed —
    it is neither evidence for nor against stability. A genuinely failing run
    still breaks the streak. With the default `min_gap_seconds=0.0` the gate is
    off and behaviour is unchanged.

    Args:
      this_run_passes: did the current training run pass its gates?
      prior_runs: prior model_runs rows for this (property, item),
        ordered most-recent-first.
      min_events: minimum training_row_count for a pass.
      mae_ratio_threshold: validation_mae / mean must be below this
        (strict less-than).
      cap: maximum streak length to return.
      current_mean_observed_rate: current run's y_test.mean(), used as
        the fallback denominator for prior rows missing mean_observed_rate.
      current_trained_at: ISO timestamp of the current run, the anchor the
        first prior run's distinctness is measured against.
      min_gap_seconds: minimum spacing between counted runs. 0 disables the
        distinctness gate.

    Returns:
      Streak count in [0, cap].
    """
    if not this_run_passes:
        return 0
    consecutive_passes = 1
    current_mean_floor = max(current_mean_observed_rate, 1e-9)
    spacing_on = min_gap_seconds > 0.0
    last_counted_dt = parse_iso_datetime(current_trained_at) if spacing_on else None

    for pr in prior_runs:
        # Evaluate pass/fail FIRST so a genuine failure breaks the streak no
        # matter WHEN it was trained. (A failing retry that happened to be
        # within min_gap of the last counted run must NOT be silently skipped —
        # that would let a broken model keep an accumulating streak.)
        prior_denom = max(_prior_mean_observed_rate(pr, current_mean_floor), 1e-9)
        prior_mae_ratio = (pr.get("validation_mae") or float("inf")) / prior_denom
        prior_passes = (
            (pr.get("training_row_count") or 0) >= min_events
            and prior_mae_ratio < mae_ratio_threshold
        )
        if not prior_passes:
            break

        # Distinctness applies ONLY to passing runs: a PASSING retry within
        # min_gap of the last counted window is the same window retried, not new
        # evidence of stability — skip it (continue) without breaking.
        if spacing_on:
            pr_dt = parse_iso_datetime(pr.get("trained_at"))
            if pr_dt is None:
                break  # can't prove this is a distinct window → stop counting
            if last_counted_dt is not None and (
                last_counted_dt - pr_dt
            ).total_seconds() < min_gap_seconds:
                continue
            last_counted_dt = pr_dt

        consecutive_passes += 1
        if consecutive_passes >= cap:
            return cap
    return consecutive_passes
