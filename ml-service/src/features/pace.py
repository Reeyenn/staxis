"""Rolling pace features (cleaning speed per room)."""
from typing import Optional


def get_pace_features(
    avg_minutes_per_room_7d: Optional[float] = None,
    avg_minutes_per_room_30d: Optional[float] = None,
    occupancy_at_start: Optional[int] = None,
) -> dict:
    """Extract pace (cleaning speed) features.

    Args:
        avg_minutes_per_room_7d: 7-day rolling average minutes/room
        avg_minutes_per_room_30d: 30-day rolling average minutes/room
        occupancy_at_start: In-house count at cleaning start

    Returns:
        Dictionary of pace features
    """
    return {
        "avg_minutes_per_room_7d": avg_minutes_per_room_7d or 25.0,  # Default prior
        "avg_minutes_per_room_30d": avg_minutes_per_room_30d or 25.0,
        "occupancy_at_start": occupancy_at_start or 0,
    }
