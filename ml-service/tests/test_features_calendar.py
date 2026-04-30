"""Tests for calendar features."""
from datetime import date

import pytest

from src.features.calendar import (
    day_of_week,
    is_us_federal_holiday,
    is_weekend,
    is_tx_school_holiday,
)


def test_day_of_week():
    """Test day_of_week calculation."""
    # 2026-05-01 is a Friday
    assert day_of_week(date(2026, 5, 1)) == 5
    # 2026-05-03 is a Sunday
    assert day_of_week(date(2026, 5, 3)) == 0


def test_is_weekend():
    """Test weekend detection."""
    assert is_weekend(date(2026, 5, 2)) is True  # Saturday
    assert is_weekend(date(2026, 5, 3)) is True  # Sunday
    assert is_weekend(date(2026, 5, 1)) is False  # Friday


def test_is_us_federal_holiday():
    """Test federal holiday detection."""
    assert is_us_federal_holiday(date(2026, 7, 4)) is True  # Independence Day
    assert is_us_federal_holiday(date(2026, 12, 25)) is True  # Christmas
    assert is_us_federal_holiday(date(2026, 7, 5)) is False


def test_is_tx_school_holiday():
    """Test Texas school holiday detection."""
    assert is_tx_school_holiday(date(2025, 12, 20)) is True  # Winter break starts
    assert is_tx_school_holiday(date(2025, 7, 1)) is False  # Summer, not in school
