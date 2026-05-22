"""Phase 2.1 (2026-05-22) — refusal contract.

When the walk-forward window contains fewer than 14 fitted days, the
backtest must refuse to report a misleading headline MAE that's
dominated by cold-start prior error. Returns refusal_reason set to
'INSUFFICIENT_FITTED_DATA' and fitted_only_mae=None.

This catches the "Beaumont has 201 events over 4 months" scenario the
senior-engineer pass flagged: most days in any 8-week backtest window
would be cold-start, and reporting their MAE as the headline number
would make the system look terrible even though the fitted model is
accurate on its own.
"""
from scripts.backtest_housekeeping import (
    BacktestResult,
    DayResult,
    _aggregate,
)


def test_aggregate_refuses_when_fewer_than_14_fitted_days():
    """13 fitted days + 20 cold-start days → INSUFFICIENT_FITTED_DATA."""
    daily = []
    for i in range(13):
        daily.append(DayResult(
            date=f"2026-04-{i+1:02d}", actual=1000.0, predicted=950.0,
            abs_error=50.0, train_set_size=250, was_fitted=True, used_cohort_prior=False,
        ))
    for i in range(20):
        daily.append(DayResult(
            date=f"2026-05-{i+1:02d}", actual=1000.0, predicted=600.0,
            abs_error=400.0, train_set_size=50, was_fitted=False, used_cohort_prior=True,
        ))
    res = _aggregate("00000000-0000-0000-0000-000000000000", "demand", 8, daily)
    assert isinstance(res, BacktestResult)
    assert res.refusal_reason == "INSUFFICIENT_FITTED_DATA"
    assert res.fitted_only_mae is None
    assert res.fitted_only_mae_ratio is None
    assert res.days_fitted == 13
    assert res.days_cold_start == 20
    # All-days MAE may still be reported for context, but the headline
    # `fitted_only_mae` is the audit-grade number — it MUST be None.
    assert res.all_days_mae is not None


def test_aggregate_reports_headline_when_at_least_14_fitted_days():
    """14 fitted days passes the refusal threshold; reports fitted_only_mae."""
    daily = []
    for i in range(14):
        daily.append(DayResult(
            date=f"2026-05-{i+1:02d}", actual=1000.0, predicted=950.0,
            abs_error=50.0, train_set_size=250, was_fitted=True, used_cohort_prior=False,
        ))
    res = _aggregate("00000000-0000-0000-0000-000000000000", "demand", 8, daily)
    assert res.refusal_reason is None
    assert res.fitted_only_mae == 50.0
    assert res.fitted_only_mae_ratio is not None
    assert res.fitted_only_mae_ratio == 50.0 / 1000.0  # 5.0%
    assert res.days_fitted == 14
    assert res.days_cold_start == 0


def test_aggregate_reports_no_data_when_window_is_empty():
    """No cleaning events in window → distinct refusal_reason."""
    res = _aggregate("00000000-0000-0000-0000-000000000000", "demand", 8, [])
    assert res.refusal_reason == "NO_DATA_IN_WINDOW"
    assert res.fitted_only_mae is None
    assert res.all_days_mae is None
    assert res.days_fitted == 0
