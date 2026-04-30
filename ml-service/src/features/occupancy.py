"""Occupancy-based features."""
from typing import Optional


def get_occupancy_features(
    in_house_count: int,
    arrivals_today: int,
    departures_today: int,
    total_rooms: int,
    occupancy_7d_avg: Optional[float] = None,
    occupancy_30d_avg: Optional[float] = None,
) -> dict:
    """Extract occupancy-based features.

    Args:
        in_house_count: Rooms currently occupied
        arrivals_today: Check-ins today
        departures_today: Check-outs today
        total_rooms: Total property rooms
        occupancy_7d_avg: 7-day average occupancy pct (optional)
        occupancy_30d_avg: 30-day average occupancy pct (optional)

    Returns:
        Dictionary of occupancy features
    """
    occupancy_pct = (in_house_count / total_rooms * 100) if total_rooms > 0 else 0

    return {
        "in_house": in_house_count,
        "arrivals_today": arrivals_today,
        "departures_today": departures_today,
        "occupancy_pct": occupancy_pct,
        "occupancy_7d_avg": occupancy_7d_avg or occupancy_pct,
        "occupancy_30d_avg": occupancy_30d_avg or occupancy_pct,
    }
