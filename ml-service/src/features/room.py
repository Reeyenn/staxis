"""Room-level features."""
from typing import Optional


def get_room_features(
    room_number: str,
    room_type: str,
    room_floor: Optional[int] = None,
    was_dnd: bool = False,
    day_of_stay: Optional[int] = None,
) -> dict:
    """Extract room-level features.

    Args:
        room_number: Room number (e.g., "301")
        room_type: Room type (single, double, suite, etc.)
        room_floor: Floor number (parsed from room_number)
        was_dnd: Was room marked do-not-disturb?
        day_of_stay: Day of guest stay (1, 2, 3+)

    Returns:
        Dictionary of room features
    """
    # Parse floor if not provided
    if room_floor is None and room_number:
        try:
            room_floor = int(room_number[0])
        except (ValueError, IndexError):
            room_floor = 1

    return {
        "room_number": room_number,
        "room_type": room_type,
        "room_floor": room_floor or 1,
        "was_dnd": was_dnd,
        "day_of_stay": day_of_stay or 1,
    }
