"""Sentry initialization for ml-service.

Why this exists:
    The Next.js app, the CUA worker, and (as of this pass) the scraper
    all ship errors to staxis.sentry.io. The Python ML service used to
    print structured JSON to Railway logs and that was it — training
    crashes, prediction timeouts, and auto-rollback failures all lived
    in Railway and only Reeyen knew (when he remembered to check). This
    module sends them to the same Sentry project as the other three
    services.

Surface area kept intentionally small:
    - init_sentry() called once from main.py at startup, no-op if
      SENTRY_DSN unset. Must NEVER crash the service on failure —
      ml-service crash-looping means the cron's demand predictions
      stop, which is a real product issue.
    - The general_exception_handler in main.py is the only place that
      calls sentry_sdk.capture_exception. We don't enable Sentry's
      FastAPI integration because it auto-captures handled HTTPException
      and RateLimitExceeded as errors, which would flood the dashboard
      with expected 4xx noise. Plain sentry-sdk + explicit captures only.

PII handling: see log_scrub.py for the regex+key-name redactor.
sentry_init wires it as the before_send hook so every event goes through
it before transport. include_local_variables=False keeps frame locals
out of the event entirely — defense layer 1; log_scrub.scrub_event is
defense layer 2.
"""

from __future__ import annotations

import os
import sys
from typing import Any

from src.log_scrub import scrub_event

_initialized = False


def init_sentry() -> bool:
    """Initialize Sentry. Returns True on successful init with a real DSN,
    False otherwise (DSN absent, import failure, init exception). Safe to
    call from main.py at import time."""
    global _initialized
    if _initialized:
        return True

    dsn = os.environ.get("SENTRY_DSN", "").strip()
    if not dsn:
        # Local dev or kill-switched deploy — fail open silently. The
        # main.py exception handler checks `_initialized` (via this
        # module's `is_initialized()` below) before calling capture_*
        # methods.
        return False

    try:
        import sentry_sdk  # type: ignore
    except Exception as exc:  # pragma: no cover — exercised only when SDK missing
        print(
            f"[sentry] sentry-sdk import failed (continuing without monitoring): {exc}",
            file=sys.stderr,
            flush=True,
        )
        return False

    try:
        sentry_sdk.init(
            dsn=dsn,
            # Small but nonzero — gives us at-a-glance "are predictions
            # slow?" without flooding. Workers don't generate enough
            # request volume to matter for quota.
            traces_sample_rate=0.05,
            # Disable SDK's automatic PII attachers. ml-service doesn't
            # serve user traffic directly (cron → bearer-gated POST), so
            # there's little the SDK would pull anyway, but explicit is
            # better than relying on a default.
            send_default_pii=False,
            # CODEX BLOCKER #2 — frame-locals are the real PII vector
            # in Python Sentry. Local variables in stack frames carry
            # request bodies, Supabase rows, bearer tokens, etc.
            # Disable at the source as defense layer 1; the scrub_event
            # before_send is layer 2.
            include_local_variables=False,
            environment=os.environ.get("RAILWAY_ENVIRONMENT")
            or os.environ.get("ENVIRONMENT")
            or "production",
            before_send=scrub_event,
            # No default integrations beyond the SDK's safe defaults —
            # we explicitly avoid sentry_sdk.integrations.fastapi
            # because it auto-captures handled HTTPException and
            # RateLimitExceeded as errors. We capture unhandled errors
            # ourselves from the general_exception_handler.
            #
            # Default integrations like Logging/StdLib/Threading are
            # left enabled — they're safe and useful.
        )
        # Set service tag on the global scope so every event carries it.
        try:
            sentry_sdk.set_tag("service", "ml-service")
        except Exception:
            pass
    except Exception as exc:
        print(
            f"[sentry] init failed (continuing without monitoring): {exc}",
            file=sys.stderr,
            flush=True,
        )
        return False

    _initialized = True
    return True


def is_initialized() -> bool:
    """True iff init_sentry() succeeded with a real DSN. Callers gate
    capture_* calls on this so a missing/invalid DSN doesn't raise."""
    return _initialized
