"""Regression lock for the JSONResponse exception-handler fix (Round 16).

History:
  The first version of these handlers returned raw dicts:
      @app.exception_handler(HTTPException)
      async def http_exception_handler(request, exc):
          return {"error": exc.detail, "status_code": exc.status_code}
  FastAPI exception handlers MUST return a Response. Starlette's
  ServerErrorMiddleware then tried to call the returned dict as if it
  were an ASGI app and crashed with `TypeError: 'dict' object is not
  callable`, which REPLACED the original exception in the logs. Every
  5xx in the ML service became unreadable. The Round 17 schedule-cron
  outage was prolonged because the upstream Vercel route saw a Vercel
  502 (the cron's HTTP client couldn't parse the broken body) — the
  actual ML exception was masked.

These tests assert:
  1. HTTPException → JSONResponse with the original status_code intact.
  2. Generic Exception → JSONResponse 500 with parseable JSON body.
  3. The response is *always* a Response object (i.e. has the ASGI
     callable shape Starlette expects).

Run with:  python -m pytest ml-service/tests/test_exception_handlers.py
"""
import json

import pytest
from fastapi import FastAPI, HTTPException, status
from fastapi.responses import JSONResponse, Response
from fastapi.testclient import TestClient


# Import the actual handlers from the production module so the regression
# test catches any future drift in handler implementation. The tests build
# a tiny FastAPI app, register the prod handlers, and exercise both
# rejection paths.
from src.main import http_exception_handler, general_exception_handler


def _build_app() -> FastAPI:
    """A minimal app with the production handlers + two routes that
    trigger them deterministically."""
    app = FastAPI()
    # Cast handler tuple as `Any` because FastAPI's add_exception_handler
    # types are awkward for arbitrary exception classes; behavior matches.
    app.add_exception_handler(HTTPException, http_exception_handler)  # type: ignore[arg-type]
    app.add_exception_handler(Exception, general_exception_handler)

    @app.get("/raises-http")
    def _raises_http():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="forbidden by test",
        )

    @app.get("/raises-generic")
    def _raises_generic():
        # A genuine runtime exception, not subclassed off HTTPException.
        raise RuntimeError("boom from test")

    return app


@pytest.fixture
def client():
    return TestClient(_build_app(), raise_server_exceptions=False)


def test_http_exception_returns_jsonresponse_with_status_code(client):
    """HTTPException → JSONResponse(status_code=exc.status_code).

    FastAPI quirk: if you only pass content= to JSONResponse, the
    response uses 200 OK. The handler must explicitly pass status_code.
    """
    res = client.get("/raises-http")
    assert res.status_code == 403, f"expected 403, got {res.status_code}"
    body = res.json()
    assert body == {"error": "forbidden by test", "status_code": 403}


def test_generic_exception_returns_500_with_parseable_json(client):
    """Generic Exception → JSONResponse 500 with valid JSON body."""
    res = client.get("/raises-generic")
    assert res.status_code == 500, f"expected 500, got {res.status_code}"
    # If body is a raw dict (pre-fix bug), starlette would have crashed
    # before reaching here. Parsing the body confirms it's valid JSON.
    body = res.json()
    assert body["status_code"] == 500
    assert "boom from test" in body["error"]


def test_handlers_return_response_subclass_not_dict():
    """Direct unit test: calling each handler with a fake request must
    return a Response (specifically JSONResponse), not a dict.

    This is the regression guard against the pre-fix bug shape, where
    `return {...}` would type-check (handlers are loosely typed) but
    break at runtime inside Starlette's middleware. Asserting on the
    return type catches a revert without needing a TestClient request.
    """
    import asyncio

    # Minimal request stub — handlers don't use it for these branches.
    fake_request = None  # type: ignore[assignment]

    http_resp = asyncio.run(
        http_exception_handler(
            fake_request,  # type: ignore[arg-type]
            HTTPException(status_code=418, detail="teapot"),
        )
    )
    assert isinstance(http_resp, Response), (
        f"http_exception_handler returned {type(http_resp).__name__}, "
        "expected Response — this was the Round 16 regression."
    )
    assert isinstance(http_resp, JSONResponse)
    assert http_resp.status_code == 418
    body = json.loads(bytes(http_resp.body))
    assert body == {"error": "teapot", "status_code": 418}

    generic_resp = asyncio.run(
        general_exception_handler(fake_request, RuntimeError("unit test")),  # type: ignore[arg-type]
    )
    assert isinstance(generic_resp, Response)
    assert isinstance(generic_resp, JSONResponse)
    assert generic_resp.status_code == 500
    body = json.loads(bytes(generic_resp.body))
    assert body["status_code"] == 500
    assert "unit test" in body["error"]
