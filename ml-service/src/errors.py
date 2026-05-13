"""ML-service typed exceptions + property-meta validators.

Centralized so cron-route boundaries (main.py, training/* callers) can
catch + emit structured events without depending on string matching.

Phase 3.3 (total_rooms) and 3.5 (timezone) — Codex post-merge review
2026-05-13. Decision was log+skip over hard-fail so a single
misconfigured property can't take down ML for the whole fleet.
"""
from typing import Any, Dict, Optional


class PropertyMisconfiguredError(ValueError):
    """Raised when a property has missing/invalid metadata required for ML.

    Caught at the cron route boundary → log a `property_misconfigured`
    event + skip this property + continue with the next one.
    """

    def __init__(self, property_id: str, field: str, value: object) -> None:
        self.property_id = property_id
        self.field = field
        self.bad_value = value
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
    """Return a non-empty IANA timezone string or raise.

    Replaces the `DEFAULT_PROPERTY_TIMEZONE = "America/Chicago"` fallback
    in the four inference/optimizer modules. A property east or west of
    Texas with a missing timezone was silently rolling "tomorrow" at the
    wrong UTC hour — predictions for the wrong operational date.
    """
    if not tz_value or not isinstance(tz_value, str) or not tz_value.strip():
        raise PropertyMisconfiguredError(property_id, "timezone", tz_value)
    return tz_value.strip()
