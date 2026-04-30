"""Calendar and holiday features for ML models."""
from datetime import date
from typing import List

import numpy as np

# US Federal Holidays (fixed month/day)
US_FEDERAL_HOLIDAYS = [
    (1, 1),    # New Year's Day
    (1, 20),   # MLK Jr. Day (third Monday of January)
    (2, 17),   # Presidents Day (third Monday of February)
    (5, 26),   # Memorial Day (last Monday of May)
    (7, 4),    # Independence Day
    (9, 1),    # Labor Day (first Monday of September)
    (10, 13),  # Columbus Day (second Monday of October)
    (11, 11),  # Veterans Day
    (11, 27),  # Thanksgiving (fourth Thursday of November)
    (12, 25),  # Christmas
]

# Texas TEA School Holidays 2025-2026
TEXAS_SCHOOL_HOLIDAYS_2025_2026 = [
    (date(2025, 9, 1), date(2025, 9, 5)),    # Labor Day weekend
    (date(2025, 10, 10), date(2025, 10, 13)), # Fall break
    (date(2025, 11, 26), date(2025, 11, 28)), # Thanksgiving
    (date(2025, 12, 19), date(2026, 1, 5)),   # Winter break
    (date(2026, 2, 16), date(2026, 2, 20)),   # Presidents Day week
    (date(2026, 3, 16), date(2026, 3, 20)),   # Spring break
]

# Texas TEA School Holidays 2026-2027
TEXAS_SCHOOL_HOLIDAYS_2026_2027 = [
    (date(2026, 9, 7), date(2026, 9, 11)),    # Labor Day weekend
    (date(2026, 10, 12), date(2026, 10, 16)), # Fall break
    (date(2026, 11, 25), date(2026, 11, 27)), # Thanksgiving
    (date(2026, 12, 18), date(2027, 1, 4)),   # Winter break
    (date(2027, 2, 15), date(2027, 2, 19)),   # Presidents Day week
    (date(2027, 3, 15), date(2027, 3, 19)),   # Spring break
]


def day_of_week(d: date) -> int:
    """Return day of week (0=Sunday, 6=Saturday).

    Args:
        d: Date

    Returns:
        Day of week (0-6)
    """
    return d.weekday() + 1 if d.weekday() < 6 else 0


def is_weekend(d: date) -> bool:
    """Check if date is Saturday or Sunday.

    Args:
        d: Date

    Returns:
        True if weekend
    """
    return d.weekday() >= 5


def is_us_federal_holiday(d: date) -> bool:
    """Check if date is a US federal holiday.

    Args:
        d: Date

    Returns:
        True if federal holiday
    """
    return (d.month, d.day) in US_FEDERAL_HOLIDAYS


def is_tx_school_holiday(d: date) -> bool:
    """Check if date is a Texas school holiday.

    Args:
        d: Date

    Returns:
        True if school holiday
    """
    all_breaks = TEXAS_SCHOOL_HOLIDAYS_2025_2026 + TEXAS_SCHOOL_HOLIDAYS_2026_2027
    for start, end in all_breaks:
        if start <= d <= end:
            return True
    return False


def week_of_year(d: date) -> int:
    """Return ISO week number (1-53).

    Args:
        d: Date

    Returns:
        Week number
    """
    return d.isocalendar()[1]


def month(d: date) -> int:
    """Return month (1-12).

    Args:
        d: Date

    Returns:
        Month number
    """
    return d.month


def days_until_next_holiday(d: date) -> int:
    """Days until next holiday (US federal or TX school).

    Args:
        d: Date

    Returns:
        Days until next holiday, capped at 365
    """
    # Check next 365 days
    for days_ahead in range(1, 366):
        check_date = date(d.year, d.month, d.day)
        # Simple iteration (production would use dateutil)
        try:
            check_date = check_date.replace(day=check_date.day + days_ahead)
        except (ValueError, OverflowError):
            return 365
        if is_us_federal_holiday(check_date) or is_tx_school_holiday(check_date):
            return days_ahead
    return 365


# Feature extraction functions

def get_calendar_features(d: date) -> dict:
    """Extract all calendar-based features for a date.

    Args:
        d: Date to extract features for

    Returns:
        Dictionary of calendar features
    """
    return {
        "day_of_week": day_of_week(d),
        "is_weekend": is_weekend(d),
        "is_us_holiday": is_us_federal_holiday(d),
        "is_school_holiday": is_tx_school_holiday(d),
        "week_of_year": week_of_year(d),
        "month": month(d),
        "days_until_holiday": days_until_next_holiday(d),
    }
