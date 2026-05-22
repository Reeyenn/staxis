"""Phase 7 v2 (2026-05-22) — end-to-end orchestrator behavior in dry-run.

Verifies the full pipeline: backfill → check → cooldown filter →
BH-FDR → dry-run-log. The dry-run path is the most important to test
because that's what'll run in production for the first 30 days. The
test asserts:

  - The orchestrator completes without exceptions on synthetic empty data.
  - The summary dict has the expected shape.
  - In dry-run mode, model_runs is NEVER updated (no .update calls).
"""
import asyncio
from unittest.mock import patch

from tests.conftest import make_fake_supabase
from src.monitoring.fleet_rollback import run_daily_rollback_pipeline


def _run(coro):
    return asyncio.run(coro)


def test_empty_fleet_returns_zero_counts_no_exceptions():
    """No properties with active fitted models → all phases return
    cleanly with zero counts.
    """
    def _execute_sql(sql):
        # The list-eligible-pairs query returns nothing.
        if "from model_runs" in sql:
            return []
        return []

    fake = make_fake_supabase(execute_sql=_execute_sql)
    import os
    os.environ.pop("DATABASE_URL", None)
    os.environ.pop("SUPABASE_DB_URL", None)
    with patch("src.monitoring.fleet_rollback.get_supabase_client", return_value=fake), \
         patch("src.actuals.get_supabase_client", return_value=fake):
        result = _run(run_daily_rollback_pipeline())

    # Shape check.
    assert "phase_backfill" in result
    assert "phase_check" in result
    assert "rollbacks_fired" in result
    assert "dry_run_would_fire" in result
    assert "execute_failures" in result
    assert "dry_run" in result
    assert "alpha" in result
    assert "results" in result
    # Counts all zero.
    assert result["rollbacks_fired"] == 0
    assert result["dry_run_would_fire"] == 0
    assert result["execute_failures"] == []
    assert result["phase_check"]["pairs_evaluated"] == 0
    # Dry-run flag from settings (default True).
    assert result["dry_run"] is True
    # No model_runs updates in dry-run regardless.
    assert fake.update.call_count == 0
