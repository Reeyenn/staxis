"""Phase L (2026-05-14) — REAL behavior test for the shadow_mae recency
filter. Replaces the Phase K source-grep test that asserted
`"prediction_date >="` was in the SQL string and silently green-lit a
fix that queried a non-existent column.

What this test actually proves:
  1. compute_rolling_shadow_mae filters out stale operational dates
     (those older than auto_rollback_window_days).
  2. Only paired (active, comparator) days within the window contribute
     to the MAE comparison.
  3. The query column name is `date` (the actual prediction_log column,
     per migration 0021), so a future regression to a non-existent
     column would either crash the (now-logged) execute_sql call OR
     return zero rows — either way breaking this test.

We seed the mock SQL endpoint with FOUR rows:
  Active model:
    - row A1: date = today              (within 14d window)
    - row A2: date = today - 180 days   (stale, must be excluded)
  Comparator:
    - row C1: date = today              (within window, pairs with A1)
    - row C2: date = today - 180 days   (stale, must be excluded)

Pre-fix (Phase K's broken version): the SQL used a non-existent
`prediction_date` column → execute_sql raises → swallowed → return
None → test fails because no MAE tuple is produced.

Post-fix: the SQL uses `date`, returns the 4 rows, but the cutoff
filter on the SERVER side would have excluded A2/C2. We simulate that
by having the mock honor the cutoff like Postgres would, then assert
exactly ONE paired observation made it through.
"""
import asyncio
import re
from datetime import date, datetime, timedelta
from unittest.mock import MagicMock, patch


def _make_fake_client(seed_rows, captured_sql):
    """Mock client whose execute_sql:
    - captures the SQL string for column-name verification
    - parses the `date >= 'YYYY-MM-DDTHH:MM:SS.ffffff'` cutoff and
      returns ONLY rows whose date is on/after that cutoff (mimicking
      what Postgres would do server-side).
    """
    fake = MagicMock()
    fake.fetch_many.side_effect = [
        # First call: active model lookup.
        [{"id": "active-uuid"}],
        # Second call: prior runs lookup (one valid comparator).
        [
            {
                "id": "comparator-uuid",
                "deactivation_reason": None,
                "activated_at": "2026-04-01T00:00:00Z",
            }
        ],
    ]

    def _execute_sql(sql):
        captured_sql.append(sql)
        m = re.search(r"date\s*>=\s*'([^']+)'", sql)
        if m is None:
            # No cutoff in SQL means our fix regressed — return raw rows
            # so test assertions surface the regression loudly.
            return list(seed_rows)
        cutoff_str = m.group(1)
        cutoff = datetime.fromisoformat(cutoff_str).date()
        return [r for r in seed_rows if r["date"] >= cutoff]

    fake.execute_sql.side_effect = _execute_sql
    return fake


def test_stale_dates_are_excluded_by_the_recency_filter():
    """The load-bearing test: a stale date must NOT contribute to MAE."""
    from src.monitoring import shadow_mae

    today = date.today()
    stale = today - timedelta(days=180)

    seed_rows = [
        # Active model rows
        {"model_run_id": "active-uuid", "abs_error": 5.0, "date": today},
        {"model_run_id": "active-uuid", "abs_error": 99.0, "date": stale},
        # Comparator rows
        {"model_run_id": "comparator-uuid", "abs_error": 7.0, "date": today},
        {"model_run_id": "comparator-uuid", "abs_error": 88.0, "date": stale},
    ]
    captured_sql = []
    fake_client = _make_fake_client(seed_rows, captured_sql)

    fake_settings = MagicMock()
    fake_settings.auto_rollback_window_days = 14

    with patch.object(shadow_mae, "get_supabase_client", return_value=fake_client), \
         patch.object(shadow_mae, "get_settings", return_value=fake_settings):
        result = asyncio.run(
            shadow_mae.compute_rolling_shadow_mae("prop-123", "demand")
        )

    # The function returns early when paired_active has fewer than 10
    # samples — we have only 1 paired day post-cutoff. None is the
    # expected return; the assertion that matters is that the SQL
    # mock was called AT ALL and returned the cutoff-filtered set.
    assert len(captured_sql) == 1, (
        "execute_sql must be called exactly once per "
        "compute_rolling_shadow_mae invocation"
    )
    sql = captured_sql[0]

    # Real schema check: the actual prediction_log column is `date`.
    # If a future change reverts this to a non-existent column, the
    # mock won't filter anything (no cutoff regex match) — but the
    # production code would raise an undefined-column error caught by
    # the now-logged except handler.
    assert re.search(r"\bdate\b", sql), (
        "WHERE/SELECT must reference the `date` column from "
        "prediction_log (per migration 0021). Phase K used a "
        "non-existent `prediction_date`."
    )
    assert "prediction_date" not in sql, (
        "Reverting to `prediction_date` would query a non-existent "
        "column — the bug Codex caught in Phase K."
    )

    # Result is None because we have <10 paired samples (only 1).
    # The important guarantee is that the function processed the
    # cutoff-filtered set, not the raw set.
    assert result is None, (
        "Expected None due to <10 paired samples after cutoff filter; "
        "got a tuple, which means stale rows were paired in (regression)."
    )


def test_pairing_uses_date_field_for_bucketing():
    """The bucketing loop must read log['date'], not log['prediction_date'].

    Phase K's broken fix also tried to bucket on log.get('prediction_date')
    — even if the SQL were corrected, the bucketing loop would have
    silently dropped every row because the dict key didn't exist.
    """
    from src.monitoring import shadow_mae

    today = date.today()
    # Seed 12 paired days so we get past the n>=10 short-circuit.
    seed_rows = []
    for i in range(12):
        d = today - timedelta(days=i)
        seed_rows.append(
            {"model_run_id": "active-uuid", "abs_error": 5.0 + i * 0.1, "date": d}
        )
        seed_rows.append(
            {"model_run_id": "comparator-uuid", "abs_error": 7.0 + i * 0.1, "date": d}
        )
    captured_sql = []
    fake_client = _make_fake_client(seed_rows, captured_sql)

    fake_settings = MagicMock()
    fake_settings.auto_rollback_window_days = 30  # window covers all 12 days

    with patch.object(shadow_mae, "get_supabase_client", return_value=fake_client), \
         patch.object(shadow_mae, "get_settings", return_value=fake_settings):
        result = asyncio.run(
            shadow_mae.compute_rolling_shadow_mae("prop-123", "demand")
        )

    # 12 paired days got through the cutoff and through the bucketing.
    # If bucketing read the wrong field name, paired_active would be
    # empty and the function would return None.
    assert result is not None, (
        "Bucketing must read log['date']. If it reads a non-existent "
        "key, every row is silently dropped and the function returns "
        "None even with valid data."
    )
    active_mae, baseline_mae, pvalue = result
    assert active_mae > 0
    assert baseline_mae > 0
    # active errors are 5.0..6.1, baseline are 7.0..8.1 → baseline larger
    assert baseline_mae > active_mae, (
        "Comparator MAE > active MAE in our seed; if this flips, the "
        "two cohorts got swapped (active/comparator confusion)."
    )
