"""Pure-Python helpers for the activation streak distinctness logic.

Phase M3.4 (2026-05-14) — extracted from supply.py / demand.py training
modules so unit tests can import this without triggering the sklearn /
static_baseline import chain that supply.py / demand.py pull in.

Same Phase L extraction pattern as _cold_start.py and _streak.py.
"""
import re
from datetime import datetime
from typing import Optional


# Postgres returns timestamptz with variable-width microseconds (1-6
# digits). Py 3.9 datetime.fromisoformat is strict — only accepts 3 or 6
# digits. Pad/truncate to exactly 6 to make parsing robust across Python
# versions. Also handles trailing `Z` (UTC shorthand) by rewriting to +00:00.
_FRACT_SECONDS_RE = re.compile(r"\.(\d+)")


def parse_iso_datetime(value) -> Optional[datetime]:
    """Parse a Postgres timestamptz string or datetime into a naive UTC datetime.

    Used by the activation streak distinctness check (Codex finding #1).
    Returns None for unparseable values so the caller can treat them
    defensively (treat as "no usable timestamp" → don't count).

    Handles both the Py 3.11+ ISO format and the Py 3.9 strict subset:
      - "2026-05-14T19:30:14.97017+00:00"  (Postgres-style, 5-digit microseconds)
      - "2026-05-14T19:30:14Z"             (UTC shorthand)
      - "2026-05-14T19:30:14.123456+00:00" (full precision)
      - "2026-05-14T19:30:14"              (no offset)
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.replace(tzinfo=None) if value.tzinfo else value
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s:
        return None
    # Z suffix → +00:00 so fromisoformat accepts it on Py 3.9.
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    # Pad/truncate microseconds to exactly 6 digits (Py 3.9 strict).
    def _pad_microseconds(m):
        digits = m.group(1)
        if len(digits) < 6:
            digits = digits + "0" * (6 - len(digits))
        elif len(digits) > 6:
            digits = digits[:6]
        return "." + digits
    s = _FRACT_SECONDS_RE.sub(_pad_microseconds, s)
    try:
        dt = datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return None
    return dt.replace(tzinfo=None) if dt.tzinfo else dt
