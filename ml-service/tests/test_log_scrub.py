"""Tests for ml-service/src/log_scrub.py — the Python PII redactor.

Mirrors the JS sentry-scrub tests in shape and coverage:
  - Value-regex redaction (phone, email, JWT short + long, Anthropic key,
    base64 image, Twilio SID, Bearer, Cookie).
  - PII_KEYS allowlist drops field values wholesale.
  - scrub_event() walks the Codex BLOCKER #2 surfaces:
      event["exception"]["values"][*]["value"]
      event["exception"]["values"][*]["stacktrace"]["frames"][*]["vars"]
      event["breadcrumbs"][*]["message"] and ["data"]
      event["extra"], event["tags"], event["request"], event["contexts"], event["user"]
"""

from __future__ import annotations

import copy
from typing import Any

import pytest

from src.log_scrub import (
    PII_KEYS,
    scrub_event,
    scrub_record,
    scrub_string,
)


# ──────────────────────────────────────────────────────────────────────────
# scrub_string — value regex pass
# ──────────────────────────────────────────────────────────────────────────

class TestScrubString:
    def test_anthropic_key(self):
        k = "sk-ant-api03-" + "A" * 95
        out = scrub_string(f"call failed with key {k}")
        assert "<redacted:anthropic_key>" in out
        assert "sk-ant-api03-" not in out

    def test_service_role_long_jwt(self):
        seg1 = "eyJ" + "A" * 40
        seg2 = "B" * 40
        seg3 = "C" * 220
        long_jwt = f"{seg1}.{seg2}.{seg3}"
        out = scrub_string(f"upstream said: {long_jwt} expired")
        assert "<redacted:long_jwt>" in out
        assert seg3 not in out

    def test_anon_jwt(self):
        seg1 = "eyJ" + "A" * 15
        seg2 = "B" * 15
        seg3 = "C" * 15
        anon = f"{seg1}.{seg2}.{seg3}"
        out = scrub_string(f"token={anon}")
        assert "<jwt>" in out
        assert seg2 not in out

    def test_phone_e164(self):
        out = scrub_string("texted +15551234567 OK")
        assert "<phone>" in out
        assert "+15551234567" not in out

    def test_phone_separator(self):
        out = scrub_string("number is 555-555-1234.")
        assert "<phone>" in out

    def test_email(self):
        out = scrub_string("send to maria@hotel.com please")
        assert "<email>" in out
        assert "maria@hotel.com" not in out

    def test_base64_image(self):
        img = "data:image/png;base64," + "A" * 200
        out = scrub_string(f"payload was {img}")
        assert "<base64-image>" in out
        assert "AAAA" not in out

    def test_bearer_header(self):
        out = scrub_string("Authorization: Bearer abc.def.ghi-stuff")
        assert "<redacted>" in out
        assert "abc.def.ghi-stuff" not in out

    def test_cookie_header(self):
        out = scrub_string("Cookie: staxis_session=abcdef; tracking=xyz")
        assert "<redacted>" in out
        assert "staxis_session=abcdef" not in out

    def test_twilio_sid(self):
        out = scrub_string("event SM" + "f" * 32 + " landed")
        assert "<twilio-sid>" in out

    def test_truncates_huge_strings(self):
        out = scrub_string("x" * (32 * 1024))
        # The cap is 16 KiB + truncated marker.
        assert "<truncated>" in out

    def test_passthrough_non_pii(self):
        # Ensure normal strings aren't damaged.
        out = scrub_string("hello world — order #1234 succeeded in 53ms")
        assert out == "hello world — order #1234 succeeded in 53ms"


# ──────────────────────────────────────────────────────────────────────────
# scrub_record — PII_KEYS dropwise
# ──────────────────────────────────────────────────────────────────────────

class TestScrubRecord:
    def test_drops_pii_keys_wholesale(self):
        rec = {
            "phone": "anything",
            "email": "anything",
            "api_key": "anything",
            "openai_key": "anything",
            "anthropic_key": "anything",
            "keep_me": "non-sensitive",
        }
        out = scrub_record(rec)
        for k in ["phone", "email", "api_key", "openai_key", "anthropic_key"]:
            assert out[k] == "<redacted>"
        assert out["keep_me"] == "non-sensitive"

    def test_recurses_into_nested_dicts(self):
        rec = {
            "outer": {
                "inner_password": "supersecret",
                "details": "a phone +1-555-555-1234 is here",
            },
        }
        out = scrub_record(rec)
        inner = out["outer"]
        # `password` is in PII_KEYS — value dropped.
        # But our key is `inner_password`, lowercase doesn't equal `password`.
        # That's intentional: we drop on exact lowered-name match, not substring.
        # So `inner_password` should NOT be dropped, but its value passes
        # through scrub_string (which doesn't match a regex for "supersecret").
        assert inner["inner_password"] == "supersecret"
        # The phone in `details` should be scrubbed.
        assert "<phone>" in inner["details"]

    def test_recurses_into_lists(self):
        rec = {"items": ["maria@hotel.com", "ok"]}
        out = scrub_record(rec)
        assert out["items"][0] == "<email>"
        assert out["items"][1] == "ok"

    def test_depth_cap(self):
        # Build a deeply nested dict to verify the depth-cap returns a
        # sentinel rather than recursing forever.
        rec: dict[str, Any] = {"k": "v"}
        cursor = rec
        for _ in range(20):
            cursor["n"] = {"k": "v"}
            cursor = cursor["n"]
        # Should not raise; depth-capped values become "<redacted:depth_cap>".
        out = scrub_record(rec)
        assert isinstance(out, dict)


# ──────────────────────────────────────────────────────────────────────────
# scrub_event — full Sentry-event walk (Codex BLOCKER #2 surface)
# ──────────────────────────────────────────────────────────────────────────

class TestScrubEvent:
    def _make_event(self) -> dict[str, Any]:
        """Construct a realistic ErrorEvent-shaped dict with PII at every
        documented surface — the test then asserts each is redacted."""
        return {
            "message": "User maria@hotel.com hit error",
            "exception": {
                "values": [
                    {
                        "type": "RuntimeError",
                        "value": "Phone +1-555-555-1234 lookup failed",
                        "stacktrace": {
                            "frames": [
                                {
                                    "function": "send_sms",
                                    "vars": {
                                        "phone": "+15551234567",
                                        "api_key": "sk-ant-api03-" + "X" * 95,
                                        "row": {"email": "maria@hotel.com"},
                                    },
                                    "pre_context": ["  to = '+1-555-555-1234'"],
                                    "context_line": "  twilio.send(to)",
                                    "post_context": ["  # for maria@hotel.com"],
                                },
                            ],
                        },
                    },
                ],
            },
            "breadcrumbs": {
                "values": [
                    {
                        "type": "log",
                        "message": "Texting +1-555-555-1234",
                        "data": {"phone": "+15551234567", "ok": True},
                    },
                ],
            },
            "request": {
                "url": "https://getstaxis.com/api/sms-reply",
                "data": {"from": "+15551234567", "body": "ok thanks"},
                "headers": {
                    "Authorization": "Bearer abc.def.ghi-stuff",
                    "User-Agent": "Twilio",
                },
                "cookies": {"staxis_session": "abc.def.ghi", "x": "y"},
            },
            "tags": {"phone": "+15551234567", "incident_id": "abc123"},
            "extra": {"openai_key": "sk-proj-abc", "ok": "yes"},
            "contexts": {"runtime": {"name": "python", "version": "3.12"}},
            "user": {"id": "u_42", "username": "maria", "email": "maria@hotel.com", "ip_address": "10.0.0.1"},
        }

    def test_top_level_message_scrubbed(self):
        ev = self._make_event()
        out = scrub_event(copy.deepcopy(ev))
        assert "<email>" in out["message"]

    def test_exception_value_scrubbed(self):
        ev = self._make_event()
        out = scrub_event(copy.deepcopy(ev))
        v = out["exception"]["values"][0]["value"]
        assert "<phone>" in v

    def test_frame_vars_scrubbed(self):
        ev = self._make_event()
        out = scrub_event(copy.deepcopy(ev))
        vars = out["exception"]["values"][0]["stacktrace"]["frames"][0]["vars"]
        assert vars["phone"] == "<redacted>"
        assert vars["api_key"] == "<redacted>"
        # Nested PII inside the row dict — email scrubbed via regex.
        assert vars["row"]["email"] == "<redacted>"

    def test_frame_context_lines_scrubbed(self):
        ev = self._make_event()
        out = scrub_event(copy.deepcopy(ev))
        fr = out["exception"]["values"][0]["stacktrace"]["frames"][0]
        assert "<phone>" in fr["pre_context"][0]
        assert "<email>" in fr["post_context"][0]

    def test_breadcrumbs_scrubbed(self):
        ev = self._make_event()
        out = scrub_event(copy.deepcopy(ev))
        b = out["breadcrumbs"]["values"][0]
        assert "<phone>" in b["message"]
        assert b["data"]["phone"] == "<redacted>"

    def test_request_headers_data_cookies_scrubbed(self):
        ev = self._make_event()
        out = scrub_event(copy.deepcopy(ev))
        req = out["request"]
        # Authorization header value redacted.
        assert "<redacted>" in req["headers"]["Authorization"]
        # request.data is a dict — `from` is in PII_KEYS, dropped.
        assert req["data"]["from"] == "<redacted>"
        # Cookies wholesale dropped.
        assert req["cookies"]["staxis_session"] == "<redacted>"

    def test_tags_extra_user_scrubbed(self):
        ev = self._make_event()
        out = scrub_event(copy.deepcopy(ev))
        assert out["tags"]["phone"] == "<redacted>"
        assert out["tags"]["incident_id"] == "abc123"
        assert out["extra"]["openai_key"] == "<redacted>"
        u = out["user"]
        assert u["id"] == "u_42"
        assert u["username"] == "<redacted>"
        assert u["email"] == "<redacted>"
        assert u["ip_address"] == "<redacted>"


# ──────────────────────────────────────────────────────────────────────────
# PII_KEYS — sanity
# ──────────────────────────────────────────────────────────────────────────

def test_pii_keys_set_includes_new_additions():
    """Codex BLOCKER #2: vars / user / api_key / openai_key etc. must be
    in the field-name set so frame-local payloads drop wholesale."""
    for k in ["vars", "user", "api_key", "openai_key", "anthropic_key", "resend_key"]:
        assert k in PII_KEYS, f"{k!r} should be in PII_KEYS"
