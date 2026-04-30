"""Workload composition features."""
from typing import Optional


def get_mix_features(
    total_checkouts: int,
    stayover_day_1_count: int,
    stayover_day_2plus_count: int,
    vacant_dirty_count: int,
    total_occupied_rooms: Optional[int] = None,
) -> dict:
    """Extract workload mix features.

    Args:
        total_checkouts: Checkout rooms
        stayover_day_1_count: Day-1 stayovers
        stayover_day_2plus_count: Day-2+ stayovers
        vacant_dirty_count: Vacant dirty rooms
        total_occupied_rooms: Total occupied (for pct calculations)

    Returns:
        Dictionary of mix features
    """
    total_rooms = total_checkouts + stayover_day_1_count + stayover_day_2plus_count
    safe_denom = total_rooms if total_rooms > 0 else 1

    pct_checkout = (total_checkouts / safe_denom) * 100
    pct_stayover_1 = (stayover_day_1_count / safe_denom) * 100
    pct_stayover_2plus = (stayover_day_2plus_count / safe_denom) * 100
    pct_vacant_dirty = (vacant_dirty_count / safe_denom) * 100 if vacant_dirty_count > 0 else 0

    return {
        "pct_checkout": pct_checkout,
        "pct_stayover_day_1": pct_stayover_1,
        "pct_stayover_day_2plus": pct_stayover_2plus,
        "pct_vacant_dirty": pct_vacant_dirty,
        "total_checkouts": total_checkouts,
        "stayover_day_1_count": stayover_day_1_count,
        "stayover_day_2plus_count": stayover_day_2plus_count,
    }
