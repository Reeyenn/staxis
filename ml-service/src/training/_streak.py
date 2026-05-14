"""Pure-function streak counting for inventory model graduation.

Codex round-5 META J1.3 (2026-05-13): extracted from
`_train_single_item` (inventory_rate.py) so the streak logic — which
has been the source of regressions in rounds 2 (Phase 3.2),
3 (Option B), 4 (D4 + F2) — is unit-testable in isolation.

This module has NO ML deps (no numpy, no pandas, no supabase). That
keeps the test suite import-time fast AND makes the function trivial
to property-test going forward. If a future regression touches streak
math, the test in `tests/test_inventory_streak_behavior.py` catches
it BEFORE it ships.
"""
from typing import Any, Dict, Iterable


def compute_consecutive_passes(
    *,
    this_run_passes: bool,
    prior_runs: Iterable[Dict[str, Any]],
    min_events: int,
    mae_ratio_threshold: float,
    cap: int,
    current_mean_observed_rate: float,
) -> int:
    """Count consecutive passing model_runs ending with the current run.

    Each prior run "passes" when:
      • training_row_count >= min_events
      • validation_mae / max(prior.training_mae, current_mean, 1e-9)
        < mae_ratio_threshold

    Using the prior's own training_mae as denominator keeps the gate
    stable across retrains. Falls back to the current mean for pre-F2
    rows where training_mae was null.

    Args:
      this_run_passes: did the current training run pass its gates?
      prior_runs: prior model_runs rows for this (property, item),
        ordered most-recent-first.
      min_events: minimum training_row_count for a pass.
      mae_ratio_threshold: validation_mae / mean must be below this
        (strict less-than).
      cap: maximum streak length to return.
      current_mean_observed_rate: current run's y_test.mean(), used as
        a fallback denominator for prior rows missing training_mae.

    Returns:
      Streak count in [0, cap].
    """
    if not this_run_passes:
        return 0
    consecutive_passes = 1
    fleet_mae_floor_for_prior = max(current_mean_observed_rate, 1e-9)
    for pr in prior_runs:
        prior_train_mae = pr.get("training_mae") or 0.0
        prior_denom = max(float(prior_train_mae), fleet_mae_floor_for_prior, 1e-9)
        prior_mae_ratio = (pr.get("validation_mae") or float("inf")) / prior_denom
        prior_passes = (
            (pr.get("training_row_count") or 0) >= min_events
            and prior_mae_ratio < mae_ratio_threshold
        )
        if not prior_passes:
            break
        consecutive_passes += 1
        if consecutive_passes >= cap:
            return cap
    return consecutive_passes
