"""Phase 7 v2 (2026-05-22) — recent_rollback_within_cooldown.

After a rollback fires for (property, layer), the orchestrator must
skip that pair for `auto_rollback_cooldown_days` (default 14). This
prevents oscillation: roll back → property serves cold-start → next
training cycle creates a fresh active → if that ALSO drifts, the
14-day cooldown gives it room to demonstrate the drift rather than
immediately firing again on the same (property, layer).
"""
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from tests.conftest import make_fake_supabase
from src.monitoring.shadow_mae import recent_rollback_within_cooldown


PROPERTY_ID = "8a041d6e-d881-4f19-83e0-7250f0e36eaa"


def test_returns_true_for_rollback_inside_cooldown_window():
    """Rollback 5 days ago, cooldown is 14 days → True (skip the check)."""
    five_days_ago_iso = (
        datetime.now(timezone.utc) - timedelta(days=5)
    ).isoformat()
    fake = make_fake_supabase(
        fetch_many={"model_runs": [{
            "id": "rolled-back-id",
            "property_id": PROPERTY_ID,
            "layer": "demand",
            "deactivation_reason": "auto_rollback",
            "deactivated_at": five_days_ago_iso,
        }]},
    )
    assert recent_rollback_within_cooldown(fake, PROPERTY_ID, "demand") is True


def test_returns_false_for_rollback_outside_cooldown_window():
    """Rollback 20 days ago, cooldown is 14 days → False (run the check)."""
    twenty_days_ago_iso = (
        datetime.now(timezone.utc) - timedelta(days=20)
    ).isoformat()
    fake = make_fake_supabase(
        fetch_many={"model_runs": [{
            "id": "rolled-back-id",
            "property_id": PROPERTY_ID,
            "layer": "demand",
            "deactivation_reason": "auto_rollback",
            "deactivated_at": twenty_days_ago_iso,
        }]},
    )
    assert recent_rollback_within_cooldown(fake, PROPERTY_ID, "demand") is False


def test_returns_false_when_no_rollback_history():
    """Never rolled back → False (eligible for the check)."""
    fake = make_fake_supabase(fetch_many={"model_runs": []})
    assert recent_rollback_within_cooldown(fake, PROPERTY_ID, "demand") is False
