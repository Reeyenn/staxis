"""Regression test for the fail-fast startup added in the deploy-ci-cron plan.

Before this gate, missing required env (SUPABASE_URL, ML_SERVICE_SECRET, etc.)
only surfaced as a 500 on the first /predict — operators saw a "healthy"
container that silently couldn't serve traffic.

The lifespan handler in src/main.py now calls get_settings() at boot and
crashes the container with a clear log if Pydantic validation fails. This
file proves the gate is alive both ways:

  1. With valid placeholder env, TestClient(app) enters its context manager
     cleanly — the lifespan runs without error.
  2. With a required env var removed, the lifespan raises ValidationError
     and TestClient(app) refuses to enter its context manager.

If either assertion fails, the lifespan is mis-wired and the fail-fast
gate is broken.
"""

import os

# Same self-sufficient env setup as test_main_hardening.py — Pydantic
# Settings maps `supabase_url` to env var SUPABASE_URL (case_sensitive=
# False). Without these, importing src.main crashes on get_settings()
# at module load. Test cases that need to remove env do so via
# monkeypatch.delenv inside the test body.
os.environ.setdefault("SUPABASE_URL", "https://placeholder.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "placeholder-service-role-key-min-20-chars")
os.environ.setdefault("ML_SERVICE_SECRET", "placeholder-ml-service-secret-min-32-bytes-padding")

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from src.main import app


def test_lifespan_enters_cleanly_with_valid_env():
    """TestClient(app) as a context manager fires the lifespan handler.
    With valid env, lifespan should call get_settings() and yield without
    raising — `with TestClient(app)` enters and the /health endpoint is
    reachable."""
    with TestClient(app) as client:
        response = client.get("/health")
        assert response.status_code == 200


def test_lifespan_refuses_boot_when_required_env_missing(monkeypatch):
    """Remove a required env var, then enter TestClient context. The
    lifespan handler should raise ValidationError before yielding, which
    propagates out of the context-manager entry.

    This is the regression Codex flagged — without the lifespan call,
    the same missing env would only surface as a 500 on first request.
    """
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("NEXT_PUBLIC_SUPABASE_URL", raising=False)

    with pytest.raises(ValidationError):
        with TestClient(app):
            # Should never reach here — lifespan should crash on entry.
            pass
