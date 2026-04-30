"""Per-housekeeper features with cold-start handling."""
from typing import Optional


def get_housekeeper_features(
    staff_id: str,
    avg_minutes_per_clean: Optional[float] = None,
    num_cleans_30d: int = 0,
    total_minutes_30d: Optional[float] = None,
    pct_on_time_30d: Optional[float] = None,
) -> dict:
    """Extract per-housekeeper features with cold-start fallback.

    For new staff (num_cleans_30d < 20), uses property-wide or industry priors.

    Args:
        staff_id: Staff member ID
        avg_minutes_per_clean: Personal avg cleaning time
        num_cleans_30d: Number of cleans in last 30 days
        total_minutes_30d: Total minutes worked in last 30 days
        pct_on_time_30d: Pct of cleans completed within SLA

    Returns:
        Dictionary of housekeeper features
    """
    # Cold-start: when staff has < 20 events, use property/industry priors
    is_cold_start = num_cleans_30d < 20

    return {
        "staff_id": staff_id,
        "avg_minutes_per_clean": avg_minutes_per_clean or (25.0 if not is_cold_start else 27.5),
        "num_cleans_30d": num_cleans_30d,
        "is_cold_start_staff": is_cold_start,
        "pct_on_time_30d": pct_on_time_30d or 0.85,
    }
