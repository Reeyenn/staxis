"""Phase K (2026-05-13): require_property_timezone only checked the
value was a non-empty string. "Mars/Olympus" or "Chicago" (no continent
prefix) both passed and then crashed inside ZoneInfo(tz_name) at the
call site.

Now: validate against the IANA tz database via stdlib zoneinfo at the
boundary, so the misconfiguration surfaces as a structured
PropertyMisconfiguredError (caught + logged + skip) instead of an
AttributeError thrown deep inside inference."""
import pytest

from src.errors import PropertyMisconfiguredError, require_property_timezone


def test_invalid_iana_name_raises():
    """Today: 'Mars/Olympus' passes silently and crashes downstream.
    Fixed: raises PropertyMisconfiguredError at the boundary."""
    with pytest.raises(PropertyMisconfiguredError) as exc_info:
        require_property_timezone("Mars/Olympus", "test-prop")
    assert exc_info.value.field == "timezone"
    assert exc_info.value.bad_value == "Mars/Olympus"


def test_continent_only_string_raises():
    """'Chicago' is not a valid IANA name — needs the 'America/' prefix."""
    with pytest.raises(PropertyMisconfiguredError):
        require_property_timezone("Chicago", "test-prop")


def test_valid_iana_returns_cleaned_value():
    """Standard valid IANA names pass through unchanged."""
    assert require_property_timezone("America/Chicago", "p") == "America/Chicago"
    assert require_property_timezone("America/New_York", "p") == "America/New_York"
    assert require_property_timezone("Europe/London", "p") == "Europe/London"
    assert require_property_timezone("UTC", "p") == "UTC"


def test_whitespace_is_stripped_before_validation():
    """Existing behavior: leading/trailing whitespace is tolerated.
    Pre-fix this passed by virtue of the .strip() at the end of the
    function. Post-fix the strip happens BEFORE zoneinfo validation."""
    assert require_property_timezone("  America/Chicago  ", "p") == "America/Chicago"


def test_empty_string_still_raises():
    """Original empty/None check stays — these were already caught."""
    with pytest.raises(PropertyMisconfiguredError):
        require_property_timezone("", "p")
    with pytest.raises(PropertyMisconfiguredError):
        require_property_timezone(None, "p")
    with pytest.raises(PropertyMisconfiguredError):
        require_property_timezone("   ", "p")


# ── Phase L: edge cases that Phase K's `except ZoneInfoNotFoundError`
# did NOT catch. Verified empirically against stdlib zoneinfo:
#   '../../etc/passwd' -> ValueError (path traversal guard)
#   '\x00abc'          -> ValueError (embedded null byte)
#   'a' * 1000         -> OSError    (filename too long)
# All three crashed inference with generic exceptions before this fix.


def test_path_traversal_raises_property_misconfigured():
    """ZoneInfo raises ValueError for keys outside TZPATH; we catch it."""
    with pytest.raises(PropertyMisconfiguredError) as exc_info:
        require_property_timezone("../../etc/passwd", "test-prop")
    assert exc_info.value.field == "timezone"


def test_embedded_null_byte_raises_property_misconfigured():
    """ZoneInfo raises ValueError for embedded \\x00; we catch it."""
    with pytest.raises(PropertyMisconfiguredError) as exc_info:
        require_property_timezone("\x00abc", "test-prop")
    assert exc_info.value.field == "timezone"


def test_over_long_name_raises_property_misconfigured():
    """ZoneInfo raises OSError [Errno 63] for over-long filenames; we catch it."""
    with pytest.raises(PropertyMisconfiguredError) as exc_info:
        require_property_timezone("a" * 1000, "test-prop")
    assert exc_info.value.field == "timezone"
