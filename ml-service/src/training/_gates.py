"""Pure-function safety gates for the inventory_rate trainer.

Extracted from `_train_single_item` (inventory_rate.py:541-593) in the May 2026
honesty audit so the three force-deactivate gates can be unit-tested without
spinning up a Supabase RPC stub. Same pattern as `_streak.py` (extracted in
Codex round-5 META J1.3 for the same reason).

NO ML deps (no numpy, no pandas, no supabase). Keeps the test suite import
fast AND makes the gate trivial to property-test going forward.

The three gates fire in priority order (first match wins). They only apply
to runs that the trainer has already decided would activate — shadow runs
and skip-paths short-circuit at the `is_currently_active` check.
"""
from typing import Optional, Tuple


def should_force_deactivate(
    *,
    algorithm: str,
    xgboost_inference_ready: bool,
    is_currently_active: bool,
    validation_holdout_n: int,
    validation_mae: Optional[float],
    mean_observed_rate: float,
    training_row_count: int,
) -> Tuple[bool, Optional[str]]:
    """Decide whether to force the model_run to is_active=False.

    Returns (force_deactivate, reason_string).

    Gates (evaluated in this order, first match wins):

      1. **No-validation-set** — validation_holdout_n == 0.
         A model with zero held-out rows has no evidence it generalizes.
         The trainer defaults validation_mae=0 for this case, which would
         silently pass the max-MAE gate below (0 < 1.0). This gate catches
         it first so cold-start hotels (2-3 counts per item) don't ship
         "validated" models that have nothing to validate against.

      2. **Max-MAE safety** — validation_mae >= max(mean_observed_rate, 1.0).
         A model whose validation error meets or exceeds the mean is no
         better than predicting the constant mean. The 1.0 absolute floor
         covers items with near-zero mean rates where the ratio is
         meaningless. Threshold tightened from 1.5x to 1.0x in the May 2026
         audit (Coffee Pods at MAE=49.99, mean=50 was passing 1.5x).

      3. **XGBoost-not-served** — algorithm == 'xgboost-quantile' AND
         NOT xgboost_inference_ready. UNREACHABLE for the inventory layer as of
         the 2026-07-05 reduced-exposure rebuild: the inventory trainer no
         longer produces xgboost-quantile runs (the XGBoost branch was removed —
         a single-regressor exposure fit at N=10-30 can't be improved by
         XGBoost). The gate is kept as a harmless safety valve in case a future
         caller ever sets algorithm='xgboost-quantile' on an inventory run
         without wiring inference; the shared XGBoostQuantile class itself lives
         on for housekeeping demand/supply.

    Args:
      algorithm: Model's `algorithm` field, e.g. 'bayesian', 'xgboost-quantile',
        'cold-start-cohort-prior'.
      xgboost_inference_ready: The module-level XGBOOST_INFERENCE_READY flag
        from `layers/xgboost_quantile.py`. False today; gate flips to a no-op
        when inventory inference learns to deserialize XGBoost artifacts.
      is_currently_active: Whether the trainer has already decided this run
        would activate (vs. shadow). Gates only apply to activating runs.
      validation_holdout_n: Number of rows in the held-out test set (the
        trainer's len(X_test)). 0 means no holdout; <5 training rows produces
        this case.
      validation_mae: MAE on the held-out set. None when no holdout.
      mean_observed_rate: y_test.mean() if test set non-empty, else
        y_train.mean(). The denominator used by the activation gate ratio.
      training_row_count: Size of the training set (len(X_train)). Used in
        the no-validation-set rejection message for operator triage.

    Returns:
      (False, None) when no gate fires — model can stay active.
      (True, reason_str) when a gate fires — caller sets is_active=False and
        stores reason_str in model_runs.notes for triage.
    """
    if not is_currently_active:
        return (False, None)

    # Gate 1: no validation set
    if validation_holdout_n == 0:
        return (
            True,
            f"rejected_no_validation_set: only {training_row_count} training rows "
            f"(need ≥5 for an 80/20 split). Falling back to cold-start prior.",
        )

    # Gate 2: max-MAE safety
    if (
        validation_mae is not None
        and validation_mae >= max(mean_observed_rate * 1.0, 1.0)
    ):
        return (
            True,
            f"rejected_high_mae: validation_mae={validation_mae:.4f} >= "
            f"threshold={max(mean_observed_rate * 1.0, 1.0):.4f} "
            f"(mean_rate={mean_observed_rate:.4f})",
        )

    # Gate 3: XGBoost dead-end
    if algorithm == "xgboost-quantile" and not xgboost_inference_ready:
        return (
            True,
            "rejected_xgboost_inference_unavailable: XGBoost graduates "
            "but inference can't deserialize the artifact yet",
        )

    return (False, None)
