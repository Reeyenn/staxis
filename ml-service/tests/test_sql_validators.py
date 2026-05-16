"""Tests for SQL-value validators introduced 2026-05-16 (Pattern B).

These wrappers run at every f-string SQL interpolation site in ml-service.
The Pydantic layer at the API boundary already validates property_id /
date inputs; these wrappers make the safety visible at the use site, so
a future caller that bypasses the boundary still hits a typed failure
instead of injecting into the SQL string.

See ml-service/src/supabase_client.py for the helpers + the security
review note (Pattern B).
"""

import pytest

from src.supabase_client import safe_uuid, safe_iso_date


class TestSafeUuid:
    def test_accepts_canonical_uuid(self):
        v = "8c1e1c1f-a1b2-4c3d-9e4f-5a6b7c8d9e0f"
        assert safe_uuid(v) == v

    def test_accepts_uppercase_and_normalizes_to_lowercase(self):
        v = "8C1E1C1F-A1B2-4C3D-9E4F-5A6B7C8D9E0F"
        # uuid.UUID preserves canonical lowercase form on stringify
        assert safe_uuid(v) == v.lower()

    def test_accepts_unhyphenated_and_normalizes(self):
        v = "8c1e1c1fa1b24c3d9e4f5a6b7c8d9e0f"
        assert safe_uuid(v) == "8c1e1c1f-a1b2-4c3d-9e4f-5a6b7c8d9e0f"

    def test_rejects_sql_injection_attempt(self):
        with pytest.raises(ValueError, match="not a valid UUID"):
            safe_uuid("'; DROP TABLE properties; --")

    def test_rejects_short_string(self):
        with pytest.raises(ValueError, match="not a valid UUID"):
            safe_uuid("abc")

    def test_rejects_empty_string(self):
        with pytest.raises(ValueError, match="not a valid UUID"):
            safe_uuid("")

    def test_rejects_none(self):
        with pytest.raises(ValueError, match="not a valid UUID"):
            safe_uuid(None)  # type: ignore[arg-type]


class TestSafeIsoDate:
    def test_accepts_yyyy_mm_dd(self):
        assert safe_iso_date("2026-05-16") == "2026-05-16"

    def test_rejects_full_datetime(self):
        # Strict — full ISO datetime is not a date.
        with pytest.raises(ValueError, match="YYYY-MM-DD"):
            safe_iso_date("2026-05-16T12:34:56")

    def test_rejects_date_with_timezone(self):
        with pytest.raises(ValueError, match="YYYY-MM-DD"):
            safe_iso_date("2026-05-16Z")

    def test_rejects_sql_injection_attempt(self):
        with pytest.raises(ValueError, match="YYYY-MM-DD"):
            safe_iso_date("2026-05-16'; DROP TABLE plan_snapshots; --")

    def test_rejects_short_date(self):
        with pytest.raises(ValueError, match="YYYY-MM-DD"):
            safe_iso_date("2026-5-1")

    def test_rejects_us_format(self):
        with pytest.raises(ValueError, match="YYYY-MM-DD"):
            safe_iso_date("05/16/2026")
