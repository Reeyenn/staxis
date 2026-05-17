"""Lagged target features for demand model."""
from typing import Optional


def get_lagged_features(
    target_1d_ago: Optional[float] = None,
    target_7d_ago: Optional[float] = None,
    target_14d_ago: Optional[float] = None,
    target_28d_ago: Optional[float] = None,
) -> dict:
    """Extract lagged target features.

    Args:
        target_1d_ago: Total minutes 1 day ago (optional)
        target_7d_ago: Total minutes 7 days ago (optional)
        target_14d_ago: Total minutes 14 days ago (optional)
        target_28d_ago: Total minutes 28 days ago (optional)

    Returns:
        Dictionary of lagged features
    """
    return {
        "target_1d_ago": target_1d_ago,
        "target_7d_ago": target_7d_ago,
        "target_14d_ago": target_14d_ago,
        "target_28d_ago": target_28d_ago,
    }
