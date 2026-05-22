"""Phase 7 v2 (2026-05-22) — execute_rollback behavior tests.

  - Dry-run mode: emits the structured log + returns would_fire WITHOUT
    touching model_runs.
  - Live mode: deactivates the active model. Does NOT promote any
    fallback (Codex high-pri finding — property serves cold-start cohort
    prior until next training).
  - No-active edge case: gracefully returns 'no_active' instead of throwing.
"""
from unittest.mock import patch

from tests.conftest import make_fake_supabase
from src.monitoring.shadow_mae import execute_rollback


PROPERTY_ID = "8a041d6e-d881-4f19-83e0-7250f0e36eaa"


def _fake_with_active(active=True):
    if active:
        active_rows = [{
            "id": "active-mr-id",
            "property_id": PROPERTY_ID,
            "layer": "demand",
            "is_active": True,
            "is_shadow": False,
            "algorithm": "bayesian",
            "model_version": "bayesian-v1-test",
        }]
    else:
        active_rows = []
    return make_fake_supabase(fetch_many={"model_runs": active_rows})


def test_dry_run_does_not_call_update():
    """In dry-run, the model_runs.update path must NOT be invoked.
    Asserted via the fake supabase client's call tracking.
    """
    fake = _fake_with_active(active=True)
    with patch("src.monitoring.shadow_mae.get_supabase_client", return_value=fake):
        result = execute_rollback(PROPERTY_ID, "demand", dry_run=True)

    assert result["decision"] == "would_fire"
    assert result["dry_run"] is True
    assert result["deactivated_model_run_id"] is None
    # Confirm no update was attempted — MagicMock records every call.
    assert fake.update.call_count == 0


def test_dry_run_no_active_returns_no_active():
    """No active model + dry_run → 'no_active' (not 'would_fire')."""
    fake = _fake_with_active(active=False)
    with patch("src.monitoring.shadow_mae.get_supabase_client", return_value=fake):
        result = execute_rollback(PROPERTY_ID, "demand", dry_run=True)

    assert result["decision"] == "no_active"
    assert fake.update.call_count == 0


def test_live_mode_without_database_url_fails_with_explicit_error():
    """Live mode requires DATABASE_URL for the advisory lock. Without
    it, returns execute_failed with a clear error — does NOT silently
    skip the deactivation, which would leave the rolling MAE evidence
    inconsistent with model_runs.
    """
    fake = _fake_with_active(active=True)
    with patch("src.monitoring.shadow_mae.get_supabase_client", return_value=fake), \
         patch.dict("os.environ", {"DATABASE_URL": "", "SUPABASE_DB_URL": ""}, clear=False):
        # Clear is False so other env vars survive; we just blank these two.
        import os
        os.environ.pop("DATABASE_URL", None)
        os.environ.pop("SUPABASE_DB_URL", None)
        result = execute_rollback(PROPERTY_ID, "demand", dry_run=False)

    assert result["decision"] == "execute_failed"
    assert result["error"] == "no_database_url_for_lock"
    assert fake.update.call_count == 0
