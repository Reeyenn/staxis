"""Phase K (2026-05-13): the auto-rollback Wilcoxon query at
shadow_mae.py:159 was filtering on logged_at, not prediction_date.
logged_at = when the actual error was recorded; prediction_date = when
the prediction was MADE FOR. A stale prediction from 6 months ago that
gets logged today (e.g., a backfill) would pair against fresh actuals,
biasing the MAE comparison and potentially rolling back a healthy model
or keeping a degraded one.

Auto-rollback is currently dead code (DEAD CODE NOTICE in the same
file) — but the bug would silently corrupt rollback decisions the day
auto-rollback gets wired. Fixing now is preventive.

This test captures the SQL string the function builds and asserts the
WHERE clause filters on prediction_date. Failing the test means a
future change either reverted the fix or reintroduced the wrong
column."""
import asyncio
from unittest.mock import MagicMock, patch


def test_compute_rolling_shadow_mae_filters_on_prediction_date():
    """The cutoff filter must apply to prediction_date, not logged_at."""
    from src.monitoring import shadow_mae

    captured_sql = {"value": None}

    def fake_execute_sql(sql):
        captured_sql["value"] = sql
        return []  # Empty result short-circuits the rest of the function.

    fake_client = MagicMock()
    # First fetch_many: active model lookup → return one row so we get past the early-out.
    # Second fetch_many: prior_runs lookup → return one valid comparator.
    fake_client.fetch_many.side_effect = [
        [{"id": "active-uuid"}],  # active models
        [
            {
                "id": "comparator-uuid",
                "deactivation_reason": None,
                "activated_at": "2026-04-01T00:00:00Z",
            }
        ],  # prior runs
    ]
    fake_client.execute_sql.side_effect = fake_execute_sql

    fake_settings = MagicMock()
    fake_settings.auto_rollback_window_days = 14

    with patch.object(shadow_mae, "get_supabase_client", return_value=fake_client), \
         patch.object(shadow_mae, "get_settings", return_value=fake_settings):
        asyncio.run(
            shadow_mae.compute_rolling_shadow_mae("prop-123", "demand")
        )

    sql = captured_sql["value"]
    assert sql is not None, "execute_sql was never called — test mock setup is wrong"
    # The fix: the cutoff filter must reference prediction_date.
    assert "prediction_date >=" in sql, (
        "WHERE clause must filter on prediction_date "
        "(when the prediction was MADE FOR), not logged_at "
        "(when the error was recorded). See Phase K bug 2."
    )
    # And explicitly NOT logged_at — the bug.
    assert "logged_at >=" not in sql, (
        "Reverting to logged_at would re-introduce the staleness bug "
        "where 6-month-old predictions pair against fresh actuals."
    )
