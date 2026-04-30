"""Sensitivity analysis for optimizer (what-if scenarios)."""
from typing import Dict, Optional

import numpy as np


async def run_sensitivity_analysis(
    base_demand_minutes: float,
    base_headcount: int,
    shift_cap_minutes: int = 420,
) -> Dict[str, Dict[str, int]]:
    """Analyze sensitivity to key perturbations.

    Args:
        base_demand_minutes: Base predicted demand (p50)
        base_headcount: Base recommended headcount
        shift_cap_minutes: Shift capacity in minutes

    Returns:
        Dictionary of scenarios to recommended headcount
    """

    def headcount_for_demand(demand: float) -> int:
        """Find minimum headcount for given demand."""
        return max(1, int(np.ceil(demand / shift_cap_minutes)))

    return {
        "one_hk_sick": {"recommended": max(1, base_headcount - 1)},
        "one_hk_plus_slow": {"recommended": base_headcount + 1},
        "plus_5_checkouts": {
            "recommended": headcount_for_demand(base_demand_minutes + 5 * 30)
        },
        "minus_5_checkouts": {
            "recommended": headcount_for_demand(base_demand_minutes - 5 * 30)
        },
        "high_occ_plus_20pct": {
            "recommended": headcount_for_demand(base_demand_minutes * 1.2)
        },
    }
