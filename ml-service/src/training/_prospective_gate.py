"""Prospective graduation gate for inventory auto-fill (2026-07-05 rebuild).

Replaces the retrain-STREAK graduation (30 clean windows + val_MAE/mean<0.10 +
5 consecutive 24h-apart passing retrains). The streak was statistically hollow:
it re-evaluated the SAME training windows N times (a retrain on unchanged data
"passes" again trivially), and the 0.10 relative-MAE bar sat below the count
noise floor. So a model could graduate to auto-fill on nothing but repetition.

Graduation now demands PROSPECTIVE evidence — predicted-vs-actual pairs from
prediction_log, which are genuinely out-of-sample BY CONSTRUCTION: each pair is
written when a manager counts an item, comparing the prediction the model made
*before* that count to the observed rate. The model never saw those actuals at
fit time.

auto_fill_enabled requires ALL of:
  A. ≥ min_training_windows clean training windows (the trainer's row count).
  B. ≥ min_pairs prospective prediction_log pairs for the item …
  C. … spanning ≥ span_days calendar days (so the pairs aren't all one week).
  D. prospective WAPE = Σ|pred−actual| / Σ|actual| < wape_threshold.
  E. prospective MAE beats the cohort-prior baseline's MAE on the SAME pairs
     (the model must be worth more than "just predict the network average").

This is a PURE function: the caller (trainer) pulls the pairs from prediction_log
and passes them in, plus a baseline prediction per pair. NO Supabase / ML deps.
"""
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional, Sequence


@dataclass
class ProspectivePair:
    """One out-of-sample predicted-vs-actual observation from prediction_log."""
    predicted: float
    actual: float
    when: date          # operational date the prediction was FOR
    baseline: float     # cohort-prior baseline's prediction for the same pair


@dataclass
class ProspectiveGateResult:
    passed: bool
    reason: str                 # machine-readable why-not (or 'ok')
    n_pairs: int
    span_days: int
    wape: Optional[float]
    prospective_mae: Optional[float]
    baseline_mae: Optional[float]


def evaluate_prospective_gate(
    *,
    n_training_windows: int,
    pairs: Sequence[ProspectivePair],
    min_training_windows: int,
    min_pairs: int,
    span_days: int,
    wape_threshold: float,
) -> ProspectiveGateResult:
    """Decide whether an item may graduate to auto_fill_enabled.

    Returns a ProspectiveGateResult; `.passed` is the graduation decision.
    Each failing check sets `.reason` to a distinct code so the trainer can
    persist WHY an item hasn't graduated (operator triage).
    """
    n = len(pairs)

    # Gate A — enough clean training windows.
    if n_training_windows < min_training_windows:
        return ProspectiveGateResult(
            passed=False,
            reason="insufficient_training_windows",
            n_pairs=n, span_days=0, wape=None,
            prospective_mae=None, baseline_mae=None,
        )

    # Gate B — enough prospective pairs.
    if n < min_pairs:
        return ProspectiveGateResult(
            passed=False,
            reason="insufficient_prospective_pairs",
            n_pairs=n, span_days=0, wape=None,
            prospective_mae=None, baseline_mae=None,
        )

    # Gate C — pairs span enough calendar days.
    days = [p.when for p in pairs]
    span = (max(days) - min(days)).days
    if span < span_days:
        return ProspectiveGateResult(
            passed=False,
            reason="prospective_span_too_short",
            n_pairs=n, span_days=span, wape=None,
            prospective_mae=None, baseline_mae=None,
        )

    # Gate D — WAPE below threshold.
    abs_err = sum(abs(p.predicted - p.actual) for p in pairs)
    abs_actual = sum(abs(p.actual) for p in pairs)
    # WAPE denominator guard: if every actual is 0 (a genuinely unused item),
    # WAPE is undefined. Treat all-zero actuals as "no usage to predict" — the
    # item shouldn't be driving auto-fill anyway → fail closed.
    if abs_actual <= 1e-9:
        return ProspectiveGateResult(
            passed=False,
            reason="prospective_actuals_all_zero",
            n_pairs=n, span_days=span, wape=None,
            prospective_mae=None, baseline_mae=None,
        )
    wape = abs_err / abs_actual
    prospective_mae = abs_err / n
    baseline_mae = sum(abs(p.baseline - p.actual) for p in pairs) / n

    if wape >= wape_threshold:
        return ProspectiveGateResult(
            passed=False,
            reason="prospective_wape_too_high",
            n_pairs=n, span_days=span, wape=wape,
            prospective_mae=prospective_mae, baseline_mae=baseline_mae,
        )

    # Gate E — beat the cohort-prior baseline on the same pairs.
    if prospective_mae >= baseline_mae:
        return ProspectiveGateResult(
            passed=False,
            reason="does_not_beat_baseline",
            n_pairs=n, span_days=span, wape=wape,
            prospective_mae=prospective_mae, baseline_mae=baseline_mae,
        )

    return ProspectiveGateResult(
        passed=True,
        reason="ok",
        n_pairs=n, span_days=span, wape=wape,
        prospective_mae=prospective_mae, baseline_mae=baseline_mae,
    )


def parse_operational_date(value: Any) -> Optional[date]:
    """Parse prediction_log.date (a DATE) into a python date, tolerantly."""
    if value is None:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    s = str(value)
    # prediction_log.date is a plain YYYY-MM-DD; be tolerant of a T-suffix.
    try:
        if "T" in s:
            s = s.split("T", 1)[0]
        if s.endswith("Z"):
            s = s[:-1]
        return date.fromisoformat(s[:10])
    except (ValueError, TypeError):
        return None
