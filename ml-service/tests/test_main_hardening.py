"""Tests for Plan v2 F-AI-4 / F-AI-12 ML service hardening in main.py.

These tests exercise the API-boundary defenses without spinning up a
real database. Each test uses FastAPI's TestClient against the real
`app`, with `verify_bearer_token` and `train_*` dependencies overridden
where needed.

Coverage:
  - max_rows above MAX_ROWS_CAP → 422
  - max_rows within cap → reaches the (mocked) training function
  - 409 returned when training reports status='already_running'
  - 500 handler returns sanitized body (no exception text)
  - body-size middleware refuses bodies > ML_MAX_BODY_BYTES
"""

import os
import json

os.environ.setdefault("NEXT_PUBLIC_SUPABASE_URL", "https://placeholder.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "placeholder-service-role-key-min-20-chars")
os.environ.setdefault("ML_SERVICE_SECRET", "placeholder-ml-service-secret-min-32-bytes-padding")
os.environ.setdefault("ML_MAX_ROWS_CAP", "200000")
os.environ.setdefault("ML_MAX_BODY_BYTES", str(64 * 1024))

import pytest
from fastapi.testclient import TestClient

from src.main import app, MAX_ROWS_CAP
from src.auth import verify_bearer_token


# Bypass the bearer-check entirely for these tests; we're testing
# the API-shape, not the auth layer (which has its own coverage).
async def _allow_all() -> str:
    return "test-token"


app.dependency_overrides[verify_bearer_token] = _allow_all

# raise_server_exceptions=False lets the registered exception_handler run
# and produce its sanitized 500 body instead of re-raising the exception
# out of TestClient (which would defeat the test for that handler).
client = TestClient(app, raise_server_exceptions=False)


# A real UUID so Pydantic validation passes before we get to the max_rows check.
_PID = "00000000-0000-0000-0000-000000000001"


def test_max_rows_above_cap_rejected_with_422():
    response = client.post(
        "/train/demand",
        json={"property_id": _PID, "max_rows": MAX_ROWS_CAP + 1},
        headers={"Authorization": "Bearer x"},
    )
    assert response.status_code == 422
    body = response.json()
    # Pydantic's 422 body includes the field path; we just look for the cap mention.
    assert "max_rows" in json.dumps(body)
    assert str(MAX_ROWS_CAP) in json.dumps(body)


def test_negative_max_rows_rejected():
    response = client.post(
        "/train/supply",
        json={"property_id": _PID, "max_rows": -1},
        headers={"Authorization": "Bearer x"},
    )
    assert response.status_code == 422


def test_max_rows_within_cap_accepted_shape(monkeypatch):
    """When max_rows ≤ cap, the training function is called with that value.

    We stub the underlying train function to short-circuit (no DB) and
    return a minimal happy response. The assertion confirms the request
    body passes through the validator.
    """
    async def fake_train_demand(*, property_id: str, max_rows, blocking_lock=True):
        return {
            "model_run_id": "mr-1",
            "is_active": False,
            "training_mae": None,
            "validation_mae": None,
            "baseline_mae": None,
            "beats_baseline_pct": None,
            "training_row_count": 0,
        }

    monkeypatch.setattr("src.main.train_demand_model", fake_train_demand)
    response = client.post(
        "/train/demand",
        json={"property_id": _PID, "max_rows": MAX_ROWS_CAP},
        headers={"Authorization": "Bearer x"},
    )
    assert response.status_code == 200


def test_training_already_running_returns_409(monkeypatch):
    async def busy_train(*, property_id: str, max_rows, blocking_lock=False):
        return {
            "status": "already_running",
            "model_run_id": None,
            "is_active": False,
            "error": "training_already_running",
        }

    monkeypatch.setattr("src.main.train_demand_model", busy_train)
    response = client.post(
        "/train/demand",
        json={"property_id": _PID},
        headers={"Authorization": "Bearer x"},
    )
    assert response.status_code == 409
    assert response.json()["status"] == "already_running"


def test_500_body_is_sanitized(monkeypatch):
    """A train function that throws an unexpected exception must NOT leak
    its text into the response. The body should be the generic shape +
    an incident id; the full exception goes to stdout.
    """
    async def raising_train(*, property_id: str, max_rows, blocking_lock=False):
        raise RuntimeError("CRITICAL: psycopg2 connection to host=db-secret.example failed for property_id=" + property_id)

    monkeypatch.setattr("src.main.train_demand_model", raising_train)
    response = client.post(
        "/train/demand",
        json={"property_id": _PID},
        headers={"Authorization": "Bearer x"},
    )
    assert response.status_code == 500
    body = response.json()
    assert body["error"] == "internal_error"
    assert "incident_id" in body
    # The exception message must NOT appear in the response.
    raw = json.dumps(body)
    assert "psycopg2" not in raw
    assert "db-secret" not in raw
    assert _PID not in raw


def test_body_size_limit_rejects_oversized_request():
    big_payload = '{"property_id":"' + _PID + '","extra":"' + ("x" * (80 * 1024)) + '"}'
    response = client.post(
        "/train/demand",
        data=big_payload,
        headers={"Authorization": "Bearer x", "Content-Type": "application/json"},
    )
    assert response.status_code == 413
    assert response.json()["error"] == "request_body_too_large"
