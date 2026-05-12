"""Layer 3 Optimizer: Monte Carlo simulation for headcount recommendation."""
import json
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from src.config import get_settings
from src.supabase_client import get_supabase_client


DEFAULT_PROPERTY_TIMEZONE = "America/Chicago"


def _tomorrow_in_property_tz(tz_name: str = DEFAULT_PROPERTY_TIMEZONE) -> date:
    """Tomorrow as seen by a property in `tz_name` (matches demand.py).

    Pass `properties.timezone` so the optimizer's "tomorrow" matches when
    the demand+supply models predicted, otherwise multi-property results
    can be off by a day on the East/West coast.
    """
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(tz_name)
    except Exception:  # pragma: no cover
        tz = timezone(timedelta(hours=-6))
    now_local = datetime.now(timezone.utc).astimezone(tz)
    return (now_local + timedelta(days=1)).date()


def _validate_property_id(property_id: str) -> Optional[str]:
    try:
        uuid.UUID(str(property_id))
        return None
    except (ValueError, AttributeError, TypeError):
        return f"Invalid property_id: not a UUID ({property_id!r})"


async def optimize_headcount(
    property_id: str,
    prediction_date: Optional[date] = None,
    property_timezone: Optional[str] = None,
) -> dict:
    """Run Monte Carlo optimizer to recommend headcount.

    Samples from L1 demand distribution and L2 supply per-room distributions,
    then simulates full-day cleaning to find minimum headcount H where
    P(complete within shift_cap × H) >= target_completion_probability.

    Args:
        property_id: Property UUID
        prediction_date: Date to optimize for (defaults to tomorrow)

    Returns:
        Dictionary with recommended_headcount, completion_probability_curve, etc.
    """
    err = _validate_property_id(property_id)
    if err:
        return {"error": err, "property_id": property_id, "date": None}

    settings = get_settings()
    client = get_supabase_client()

    if prediction_date is None:
        prediction_date = _tomorrow_in_property_tz(
            property_timezone or DEFAULT_PROPERTY_TIMEZONE
        )

    # Fetch active L1 + L2 predictions
    demand_preds = client.fetch_many(
        "demand_predictions",
        filters={"property_id": property_id, "date": str(prediction_date)},
        limit=1,
    )

    if not demand_preds:
        return {
            "error": "No demand prediction available",
            "property_id": property_id,
            "date": str(prediction_date),
        }

    demand = demand_preds[0]

    # Load feature flags for completion probability target
    flags = client.fetch_one(
        "ml_feature_flags",
        filters={"property_id": property_id},
    )
    target_prob = (flags.get("target_completion_prob", settings.target_completion_probability)
                   if flags else settings.target_completion_probability)

    # Fetch L2 supply predictions if available.
    #
    # Codex audit pass-6 P0 — this used to cap at limit=100 with the
    # comment "Fetch all supply predictions for this date". A hotel
    # with >100 scheduled rooms had its workload silently truncated,
    # producing a headcount recommendation that was too low. Beaumont
    # is under 100 today but the system needs to handle multi-property
    # / larger-property deployments without quietly undercounting.
    #
    # Bumped to 5000 (well above any realistic single-property room
    # count) and we emit a structured warning if we hit the new ceiling
    # so we know to add real pagination before that ever bites.
    SUPPLY_PRED_FETCH_CEILING = 5000
    supply_preds = client.fetch_many(
        "supply_predictions",
        filters={"property_id": property_id, "date": str(prediction_date)},
        limit=SUPPLY_PRED_FETCH_CEILING,
    )
    if len(supply_preds) >= SUPPLY_PRED_FETCH_CEILING:
        print(json.dumps({
            "level": "warning",
            "event": "monte_carlo_supply_fetch_at_ceiling",
            "property_id": property_id,
            "date": str(prediction_date),
            "rows_returned": len(supply_preds),
            "ceiling": SUPPLY_PRED_FETCH_CEILING,
            "note": "supply predictions may be truncated; add pagination",
        }))

    # Use L2 supply predictions if available and sufficient, otherwise fall back to L1 uniform
    use_l2_supply = len(supply_preds) >= 10

    if use_l2_supply:
        # L2 path: per-room quantile sampling + LPT bin-packing across H abstract workers.
        #
        # Why we ignore staff_id from supply_preds here: this Monte Carlo simulates
        # a hypothetical staffing level (1, 2, 3 …). The actually-assigned staff
        # from tomorrow's schedule is irrelevant to "what does headcount=H give us?".
        # We treat each room time as an independent job and pack it onto H workers
        # via Longest Processing Time first (LPT), the classic greedy approximation
        # for makespan minimization. Then check whether the slowest worker finishes
        # within shift_cap_minutes.
        #
        # Previous bug: the bin-packing loop did `hk_workloads[staff_id] = room_time`
        # (assignment, not accumulation), so the same housekeeper's later rooms
        # overwrote earlier ones. Workload was massively underestimated and the
        # optimizer recommended too few housekeepers.
        completion_curves = []
        recommended_headcount = None  # decided below

        for headcount in range(1, 11):
            shift_cap = float(settings.shift_cap_minutes)
            total_completed = 0

            for _ in range(settings.monte_carlo_draws):
                # Sample per-room times from supply predictions. Uniform between
                # p25 and p90 is a coarse but unbiased approximation of the
                # quantile-pinball distribution shape.
                room_times: List[float] = []
                for pred in supply_preds:
                    p25 = float(pred.get("predicted_minutes_p25", 15))
                    p90 = float(pred.get("predicted_minutes_p90", 30))
                    if p90 <= p25:
                        # Degenerate distribution — use the midpoint deterministically.
                        room_times.append((p25 + p90) / 2.0)
                    else:
                        room_times.append(float(np.random.uniform(p25, p90)))

                # LPT: longest jobs first → assign each to the currently-least-loaded worker.
                room_times.sort(reverse=True)
                worker_loads = [0.0] * headcount
                for t in room_times:
                    idx = int(np.argmin(worker_loads))
                    worker_loads[idx] += t

                makespan = max(worker_loads) if worker_loads else 0.0
                if makespan <= shift_cap:
                    total_completed += 1

            completion_prob = float(total_completed / settings.monte_carlo_draws)
            completion_curves.append({"headcount": headcount, "p": completion_prob})

            # First headcount that meets the target is the recommendation.
            if recommended_headcount is None and completion_prob >= target_prob:
                recommended_headcount = headcount

        # If no headcount in 1..10 meets the target, pick the highest curve point
        # rather than silently defaulting to 5 (the previous default hid this case).
        if recommended_headcount is None:
            recommended_headcount = max(completion_curves, key=lambda c: c["p"])["headcount"]
    else:
        # L1 path: total demand only. Sample uniformly between p50 and p95
        # of the predicted minutes distribution. shift_capacity = H × shift_cap;
        # success = sampled_demand fits in capacity.
        p50_minutes = float(demand.get("predicted_minutes_p50", 180.0) or 180.0)
        p95_minutes = float(demand.get("predicted_minutes_p95", 240.0) or 240.0)
        min_demand = p50_minutes
        max_demand = max(p95_minutes, p50_minutes + 1.0)  # avoid zero-width range

        completion_curves = []
        recommended_headcount = None

        for headcount in range(1, 11):
            shift_capacity = headcount * settings.shift_cap_minutes
            total_completed = 0

            for _ in range(settings.monte_carlo_draws):
                sampled_demand = float(np.random.uniform(min_demand, max_demand))
                if sampled_demand <= shift_capacity:
                    total_completed += 1

            completion_prob = float(total_completed / settings.monte_carlo_draws)
            completion_curves.append({"headcount": headcount, "p": completion_prob})

            if recommended_headcount is None and completion_prob >= target_prob:
                recommended_headcount = headcount

        if recommended_headcount is None:
            recommended_headcount = max(completion_curves, key=lambda c: c["p"])["headcount"]

    # Look up completion_prob by headcount value (not array index) so a
    # future change to the search range (e.g. range(2, 12)) doesn't
    # silently misalign. May 2026 audit pass-5: line 200 had a guard but
    # the symmetric lookup at line 227 didn't — IndexError if anything
    # ever pushes recommended_headcount past len(completion_curves).
    achieved_p = next(
        (c["p"] for c in completion_curves if c["headcount"] == recommended_headcount),
        0.95,
    )

    # Write optimizer_results
    optimizer_result = {
        "property_id": property_id,
        "date": str(prediction_date),
        "recommended_headcount": recommended_headcount,
        "target_completion_probability": float(target_prob),
        "achieved_completion_probability": float(achieved_p),
        "completion_probability_curve": json.dumps(completion_curves),
        "assignment_plan": json.dumps({}),  # Simplified
        "sensitivity_analysis": json.dumps({
            "one_hk_sick": {"recommended": max(1, recommended_headcount - 1)},
            "plus_5_checkouts": {"recommended": min(10, recommended_headcount + 1)},
        }),
        "inputs_snapshot": json.dumps({
            "l1_model_run_id": demand.get("model_run_id"),
            "l2_model_run_ids": [p.get("model_run_id") for p in supply_preds] if use_l2_supply else [],
            "used_l2_supply": use_l2_supply,
            "l2_prediction_count": len(supply_preds) if use_l2_supply else 0,
        }),
        "monte_carlo_draws": settings.monte_carlo_draws,
        "ran_at": datetime.utcnow().isoformat(),
    }

    try:
        result = client.upsert("optimizer_results", optimizer_result)
        return {
            "property_id": property_id,
            "date": str(prediction_date),
            "recommended_headcount": recommended_headcount,
            "achieved_completion_probability": float(achieved_p),
            "completion_probability_curve": completion_curves,
        }
    except Exception as e:
        return {
            "error": f"Failed to write optimizer result: {e}",
            "property_id": property_id,
            "date": str(prediction_date),
        }
