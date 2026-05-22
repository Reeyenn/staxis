"""PII redaction for ml-service.

Mirrors src/lib/sentry-scrub.ts in the Next.js app. Two surfaces use this:

1. main.py's general_exception_handler — every str(exc) printed to stdout
   passes through scrub_string() so a Supabase-row leak or stack-frame
   string with a service-role JWT doesn't reach Railway's log aggregator
   verbatim.

2. sentry_init.py's before_send — the whole Sentry event is walked by
   scrub_event() before ingestion. This catches PII in places the print
   path doesn't touch: stacktrace frame locals, breadcrumbs, request
   headers, contexts, user.

Conservative posture: redact whenever a value MIGHT be PII rather than
only when we're sure. False positives are noise; false negatives are
compliance issues.
"""

from __future__ import annotations

import re
from typing import Any

# ── Regex patterns (mirror sentry-scrub.ts) ─────────────────────────

# Phone: tightened to require either explicit "+1" prefix OR separator
# inside the digit groups, so bare 10-digit reference codes don't trip
# the redactor. Matches the JS app's behavior.
PHONE_RX = re.compile(
    r"(?:\+1\d{10}|\+1[\s.\-]?\d{3}[\s.\-]?\d{3}[\s.\-]?\d{4}|\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4})"
)
EMAIL_RX = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
BEARER_RX = re.compile(r"(Authorization:\s*Bearer\s+)\S+", re.IGNORECASE)
COOKIE_RX = re.compile(r"(Cookie:\s*)[^\n]+", re.IGNORECASE)
# Anon-key-shaped JWT (3 segments, ≥10 chars each).
JWT_RX = re.compile(r"eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}")
# Service-role-shaped JWT (200+ char third segment). Caught separately
# so the longer-form pattern wins when both match.
LONG_JWT_RX = re.compile(
    r"eyJ[A-Za-z0-9_\-]{30,}\.[A-Za-z0-9_\-]{30,}\.[A-Za-z0-9_\-]{200,}"
)
ANTHROPIC_KEY_RX = re.compile(r"sk-ant-api\d{2}-[A-Za-z0-9_\-]{80,}")
# Base64 image data URI — redact the whole thing, since the value's
# always huge enough to flag and never useful as diagnostic.
BASE64_IMAGE_RX = re.compile(r"data:image/[a-z+]+;base64,[A-Za-z0-9+/=]+")
SUPABASE_KEY_RX = re.compile(r"sb-[a-z0-9\-]+-auth-token", re.IGNORECASE)
TWILIO_SID_RX = re.compile(r"\b(AC|SM|MM)[a-f0-9]{32}\b", re.IGNORECASE)

# ── Field-name allowlist (drop value wholesale when key matches) ────
#
# Lowercased comparison. Mirrors PII_KEYS in sentry-scrub.ts, plus
# `vars` to catch Sentry's frame-local payload key as defense layer 2
# even when sentry_sdk.init's include_local_variables is False.
PII_KEYS = frozenset({
    "phone",
    "phone_number",
    "phonenumber",
    "phone164",
    "email",
    "from",
    "fromnumber",
    "fromheader",
    "to",
    "tophone",
    "username",
    "password",
    "access_token",
    "accesstoken",
    "authorization",
    "cookie",
    "staffname",
    "staff_name",
    "guestname",
    "guest_name",
    "user",
    "vars",
    "apikey",
    "api_key",
    "openai_key",
    "anthropic_key",
    "resend_key",
    "elevenlabs_key",
})

# ── Safety caps ─────────────────────────────────────────────────────

# Maximum recursion depth into nested dicts/lists. Sentry event payloads
# can have 10+ levels (event.exception.values[i].stacktrace.frames[j].vars.foo.bar) —
# go a little deeper than the cua-service JS scrubber's 6 to match
# Python's nested-attr typical depth.
_MAX_DEPTH = 8
# Strings longer than this are truncated post-scrub. 16 KiB matches the
# cua-service log.ts. Sentry's own per-event payload cap is well above
# this, so the truncation is a safety net for printed log lines, not
# Sentry transport.
_MAX_STRING_LEN = 16 * 1024


def scrub_string(s: str) -> str:
    """Apply every regex redactor to a string. Order matters: LONG_JWT
    runs before JWT so service-role keys get the longer-form marker, and
    ANTHROPIC_KEY runs before everything else so `sk-ant-…` doesn't pass
    through email/JWT regexes as a near-miss."""
    if not isinstance(s, str):
        return s
    out = s
    out = ANTHROPIC_KEY_RX.sub("<redacted:anthropic_key>", out)
    out = LONG_JWT_RX.sub("<redacted:long_jwt>", out)
    out = JWT_RX.sub("<jwt>", out)
    out = BEARER_RX.sub(r"\1<redacted>", out)
    out = COOKIE_RX.sub(r"\1<redacted>", out)
    out = BASE64_IMAGE_RX.sub("<base64-image>", out)
    out = SUPABASE_KEY_RX.sub("<supabase-key>", out)
    out = TWILIO_SID_RX.sub("<twilio-sid>", out)
    out = PHONE_RX.sub("<phone>", out)
    out = EMAIL_RX.sub("<email>", out)
    if len(out) > _MAX_STRING_LEN:
        out = out[:_MAX_STRING_LEN] + "…<truncated>"
    return out


def _scrub_value(key: str, v: Any, depth: int) -> Any:
    """Recursive helper. Drops value wholesale when key is in PII_KEYS.
    Otherwise applies regex redactors to strings and recurses into
    dicts/lists. Depth-capped to avoid pathological payloads."""
    if depth > _MAX_DEPTH:
        return "<redacted:depth_cap>"
    if isinstance(key, str) and key.lower() in PII_KEYS:
        return "<redacted>"
    if isinstance(v, str):
        return scrub_string(v)
    if isinstance(v, dict):
        return {k: _scrub_value(str(k), val, depth + 1) for k, val in v.items()}
    if isinstance(v, (list, tuple)):
        out_seq = [_scrub_value(f"{key}[{i}]", x, depth + 1) for i, x in enumerate(v)]
        return out_seq if isinstance(v, list) else tuple(out_seq)
    return v


def scrub_record(rec: dict[str, Any]) -> dict[str, Any]:
    """Public helper for scrubbing a top-level dict (e.g. event.tags,
    event.extra, event.contexts)."""
    if not isinstance(rec, dict):
        return rec
    return {k: _scrub_value(str(k), v, 0) for k, v in rec.items()}


def scrub_event(event: dict[str, Any], _hint: Any = None) -> dict[str, Any] | None:
    """Sentry SDK before_send hook. Walks every PII-bearing surface of a
    Sentry ErrorEvent and returns the scrubbed event. Returning None
    would drop the event entirely; we never want that — drop-on-PII
    would mask real bugs whose context happens to include a JWT-shaped
    string (every Supabase token starts with "eyJ"), so we redact rather
    than drop.

    Surfaces covered (Codex BLOCKER #2 — frame-locals were the missing
    surface in plan v2):
      - event["message"]
      - event["exception"]["values"][i]["value"]
      - event["exception"]["values"][i]["stacktrace"]["frames"][j]["vars"]
      - event["breadcrumbs"][k]["message"] and ["data"]
      - event["request"]["data"], ["query_string"], ["headers"], ["cookies"]
      - event["tags"], event["extra"], event["contexts"], event["user"]
    """
    if not isinstance(event, dict):
        return event

    # Top-level message.
    if isinstance(event.get("message"), str):
        event["message"] = scrub_string(event["message"])

    # Exception values + stacktrace frame vars (the frame-locals path).
    exc = event.get("exception")
    if isinstance(exc, dict):
        values = exc.get("values")
        if isinstance(values, list):
            for ex in values:
                if not isinstance(ex, dict):
                    continue
                if isinstance(ex.get("value"), str):
                    ex["value"] = scrub_string(ex["value"])
                # Frame-locals: when include_local_variables=True (we set
                # it False, but defense in depth), each frame can carry a
                # "vars" dict with local variable name → value-as-string.
                # Walk the dict; the PII_KEYS allowlist will drop the
                # `vars` key wholesale if a future SDK keeps the key
                # name, and otherwise the recursive walk redacts values.
                stack = ex.get("stacktrace")
                if isinstance(stack, dict):
                    frames = stack.get("frames")
                    if isinstance(frames, list):
                        for fr in frames:
                            if not isinstance(fr, dict):
                                continue
                            # Recurse into vars per-entry rather than
                            # passing the whole dict through _scrub_value,
                            # which would treat the literal "vars" key as
                            # a PII_KEYS match and drop the whole frame-
                            # local map. scrub_record visits each inner
                            # key, so PII_KEYS still catches inner
                            # api_key/phone/email fields while leaving
                            # non-PII locals visible for debugging.
                            vars_obj = fr.get("vars")
                            if isinstance(vars_obj, dict):
                                fr["vars"] = scrub_record(vars_obj)
                            # pre_context / post_context are source-text
                            # lines, lower risk but can carry interpolated
                            # values — scrub conservatively.
                            for ctx_key in ("pre_context", "post_context", "context_line"):
                                if isinstance(fr.get(ctx_key), str):
                                    fr[ctx_key] = scrub_string(fr[ctx_key])
                                elif isinstance(fr.get(ctx_key), list):
                                    fr[ctx_key] = [
                                        scrub_string(s) if isinstance(s, str) else s
                                        for s in fr[ctx_key]
                                    ]

    # Breadcrumbs.
    crumbs = event.get("breadcrumbs")
    # Sentry uses either {"values": [...]} or a bare list — handle both.
    crumb_list: list[Any] | None = None
    if isinstance(crumbs, dict) and isinstance(crumbs.get("values"), list):
        crumb_list = crumbs["values"]
    elif isinstance(crumbs, list):
        crumb_list = crumbs
    if crumb_list is not None:
        for b in crumb_list:
            if not isinstance(b, dict):
                continue
            if isinstance(b.get("message"), str):
                b["message"] = scrub_string(b["message"])
            if isinstance(b.get("data"), dict):
                b["data"] = scrub_record(b["data"])

    # Request body / query / headers / cookies.
    req = event.get("request")
    if isinstance(req, dict):
        if isinstance(req.get("data"), str):
            req["data"] = scrub_string(req["data"])
        elif isinstance(req.get("data"), dict):
            req["data"] = scrub_record(req["data"])
        if isinstance(req.get("query_string"), str):
            req["query_string"] = scrub_string(req["query_string"])
        if isinstance(req.get("headers"), dict):
            # Drop sensitive headers wholesale (BEARER_RX/COOKIE_RX both
            # require the "Header:" prefix in the value, which the SDK
            # has already split off by the time the value reaches here).
            # Fall back to scrub_string for everything else so a stray
            # phone in User-Agent or X-Forwarded-For still gets redacted.
            SENSITIVE_HEADER_LC = {
                "authorization", "cookie", "set-cookie",
                "x-supabase-auth", "x-amz-security-token",
            }
            new_headers: dict[str, Any] = {}
            for k, v in req["headers"].items():
                if isinstance(k, str) and k.lower() in SENSITIVE_HEADER_LC:
                    new_headers[k] = "<redacted>"
                elif isinstance(v, str):
                    new_headers[k] = scrub_string(v)
                else:
                    new_headers[k] = v
            req["headers"] = new_headers
        if isinstance(req.get("cookies"), dict):
            req["cookies"] = {k: "<redacted>" for k in req["cookies"]}
        elif isinstance(req.get("cookies"), str):
            req["cookies"] = "<redacted>"

    # Tags / extras / contexts.
    if isinstance(event.get("tags"), dict):
        event["tags"] = scrub_record(event["tags"])
    if isinstance(event.get("extra"), dict):
        event["extra"] = scrub_record(event["extra"])
    if isinstance(event.get("contexts"), dict):
        event["contexts"] = scrub_record(event["contexts"])

    # User: high-PII surface — strip everything except `id` which is
    # safe to keep for triage. Sentry won't enrich it with PII via
    # send_default_pii=False, but a developer could have manually set
    # username/email — drop both.
    user = event.get("user")
    if isinstance(user, dict):
        event["user"] = {
            k: ("<redacted>" if k.lower() in {"username", "email", "ip_address"} else v)
            for k, v in user.items()
        }

    return event
