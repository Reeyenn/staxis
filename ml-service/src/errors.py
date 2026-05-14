"""ML-service typed exceptions + property-meta validators.

Centralized so cron-route boundaries (main.py, training/* callers) can
catch + emit structured events without depending on string matching.

Phase 3.3 (total_rooms) and 3.5 (timezone) — Codex post-merge review
2026-05-13. Decision was log+skip over hard-fail so a single
misconfigured property can't take down ML for the whole fleet.
"""
from typing import Any, Dict, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


class PropertyMisconfiguredError(ValueError):
    """Raised when a property has missing/invalid metadata required for ML.

    Caught at the cron route boundary → log a `property_misconfigured`
    event + skip this property + continue with the next one.

    Codex round-3 review 2026-05-13 (D3): two value representations are
    exposed:
      - `bad_value` (raw object — preserved for forensic inspection)
      - `printable_value` (str(value) for strings, repr(value) otherwise)
    The error message itself uses repr() so it stays human-readable even
    for None/numbers. The structured event downstream (logged via stdout
    → parsed by TS cron) uses printable_value to avoid surrounding-quotes
    on string-typed bad values like 'Mars/Olympus' → "'Mars/Olympus'".
    """

    def __init__(self, property_id: str, field: str, value: object) -> None:
        self.property_id = property_id
        self.field = field
        self.bad_value = value
        # printable_value: stringify without repr's quote-wrapping for
        # string-typed values. None / numbers / bools / dicts use repr()
        # because their str() and repr() are equivalent OR because we
        # want the type-distinguishing repr (e.g. None vs "None").
        if isinstance(value, str):
            self.printable_value = value
        else:
            self.printable_value = repr(value)
        super().__init__(
            f"Property {property_id} has missing/invalid {field}={value!r}. "
            f"Set this via the onboarding wizard before re-running ML."
        )


def require_total_rooms(property_meta: Optional[Dict[str, Any]], property_id: str) -> int:
    """Return a positive total_rooms or raise PropertyMisconfiguredError.

    Replaces the silent `int(property_meta.get("total_rooms") or 60)` fallback
    that gave non-60-room hotels Beaumont-shaped predictions. The 60-room
    default was a one-property-deploy convenience; at fleet scale it has
    to go.
    """
    value = (property_meta or {}).get("total_rooms")
    try:
        as_int = int(value) if value is not None else 0
    except (TypeError, ValueError):
        as_int = 0
    if as_int <= 0:
        raise PropertyMisconfiguredError(property_id, "total_rooms", value)
    return as_int


def require_property_timezone(tz_value: Optional[str], property_id: str) -> str:
    """Return a non-empty, IANA-validated timezone string or raise.

    Replaces the `DEFAULT_PROPERTY_TIMEZONE = "America/Chicago"` fallback
    in the four inference/optimizer modules. A property east or west of
    Texas with a missing timezone was silently rolling "tomorrow" at the
    wrong UTC hour — predictions for the wrong operational date.

    Phase K (2026-05-13): also reject names that aren't in the IANA tz
    database. Pre-fix, "Mars/Olympus" or "Chicago" (continent prefix
    missing) passed this guard and crashed inside ZoneInfo() at the
    call site instead of surfacing as a structured event.
    """
    if not tz_value or not isinstance(tz_value, str) or not tz_value.strip():
        raise PropertyMisconfiguredError(property_id, "timezone", tz_value)
    cleaned = tz_value.strip()
    try:
        ZoneInfo(cleaned)
    except ZoneInfoNotFoundError:
        raise PropertyMisconfiguredError(property_id, "timezone", tz_value)
    return cleaned
