"""Layer 3 Optimizer: Monte Carlo simulation for headcount recommendation."""
import hashlib
import heapq
import json
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from src.config import get_settings
from src.supabase_client import get_supabase_client


DEFAULT_PROPERTY_TIMEZONE = "America/Chicago"


# ─── Deterministic RNG helpers ─────────────────────────────────────────────
# Codex adversarial review 2026-05-13 (M-C2): the prior implementation called
# np.random.uniform(...) with no seed, so two optimizer runs minutes apart
# produced different recommended_headcount values. That defeats reproducibility
# (auditors can't ask "why did you recommend 6 on 2026-05-01") and confuses
# managers when the cockpit number flips on refresh.
#
# We seed per (property_id, prediction_date) so:
#   - The same input always gives the same output (idempotent, auditable).
#   - Different days get independent samples (no cross-day leakage).
#   - Different properties on the same day are independent.

def _deterministic_seed(property_id: str, prediction_date: date) -> int:
    """Stable 32-bit seed derived from (property_id, prediction_date)."""
    digest = hashlib.md5(
        f"{property_id}:{prediction_date.isoformat()}".encode("utf-8")
    ).hexdigest()
    return int(digest[:16], 16) % (2**32)


def _invert_quantile_cdf(quantiles: Dict[float, float], u: float) -> float:
    """Piecewise-linear inverse-CDF sampler from a discrete quantile set.

    Codex adversarial review 2026-05-13 (M-C3): the prior code did
    np.random.uniform(p25, p90), which is NOT a draw from the underlying
    distribution — it gives equal mass to every value in the inter-quartile
    range, throws away the tails entirely, and shifts E[X] far above the
    true median when the distribution is right-skewed (which housekeeping
    times always are).

    Given (q, value) pairs and a uniform u in [0, 1], walk the sorted
    quantile points and linearly interpolate. For tails (u < q_min or
    u > q_max) we extrapolate but clamp to [min_value, max_value] so a
    rare-tail draw can't return a wildly negative or runaway-large time.
    """
    if not quantiles:
        return 0.0
    sorted_pairs = sorted(quantiles.items())
    qs = [q for q, _ in sorted_pairs]
    vs = [v for _, v in sorted_pairs]
    min_v, max_v = min(vs), max(vs)

    # Below the smallest known quantile: extrapolate using the first segment,
    # clamped at the floor.
    if u <= qs[0]:
        if len(sorted_pairs) >= 2 and qs[1] != qs[0]:
            slope = (vs[1] - vs[0]) / (qs[1] - qs[0])
            extrapolated = vs[0] - slope * (qs[0] - u)
            return max(min_v, extrapolated)
        return vs[0]

    # Above the largest known quantile: extrapolate using the last segment,
    # clamped at the ceiling.
    if u >= qs[-1]:
        if len(sorted_pairs) >= 2 and qs[-1] != qs[-2]:
            slope = (vs[-1] - vs[-2]) / (qs[-1] - qs[-2])
            extrapolated = vs[-1] + slope * (u - qs[-1])
            return min(max_v, extrapolated)
        return vs[-1]

    # Interior: piecewise-linear between the two adjacent known quantiles.
    for i in range(len(sorted_pairs) - 1):
        if qs[i] <= u <= qs[i + 1]:
            if qs[i + 1] == qs[i]:
                return vs[i]
            t = (u - qs[i]) / (qs[i + 1] - qs[i])
            return vs[i] + t * (vs[i + 1] - vs[i])
    return vs[-1]  # unreachable


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

    # Seed RNG deterministically from (property_id, date) so this run is
    # reproducible. Codex adversarial review 2026-05-13 (M-C2). All sampling
    # below uses `rng`, NEVER bare np.random.uniform.
    rng = np.random.default_rng(_deterministic_seed(property_id, prediction_date))

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

        # Codex audit pass-6 P1 — search range used to be hard-coded
        # range(1, 11). For a hotel with enough rooms to need 12+
        # housekeepers we'd cap at 10 and silently return an
        # under-recommended headcount. Now we compute a property-aware
        # upper bound from the actual workload (sum of median-time
        # estimates × 1.5 buffer) so larger properties get a real answer,
        # while still bounding the loop to keep the function fast.
        median_total_minutes = sum(
            float(p.get("predicted_minutes_p50", 25)) for p in supply_preds
        )
        shift_cap = float(settings.shift_cap_minutes) or 1.0
        max_headcount = max(
            10,
            min(50, int((median_total_minutes / shift_cap) * 1.5) + 1),
        )

        # Codex post-merge review 2026-05-13 (F4 — common random numbers):
        # Pre-generate the per-(draw, room) uniforms ONCE, outside the H
        # loop. Every H value samples from the SAME u-matrix → adjacent H
        # values differ ONLY in how the LPT bin-packing distributes the
        # same set of job times → variance of the difference between
        # adjacent H values drops dramatically. Without CRN, adjacent H
        # could swap purely from MC noise (SE~0.69pp at p=0.95).
        n_rooms = len(supply_preds)
        u_matrix = rng.uniform(size=(settings.monte_carlo_draws, n_rooms))

        # Pre-compute each room's quantile triple ONCE so the inner loop
        # doesn't re-parse predictions every draw.
        room_quantiles: List[Tuple[float, float, float, bool]] = []
        for pred in supply_preds:
            p25 = float(pred.get("predicted_minutes_p25", 15))
            p50 = float(pred.get("predicted_minutes_p50", 22))
            p90 = float(pred.get("predicted_minutes_p90", 30))
            degenerate = p90 <= p25
            room_quantiles.append((p25, p50, p90, degenerate))

        # Pre-compute the sampled room_times matrix ONCE — used by every H.
        # Shape: [monte_carlo_draws, n_rooms]
        sampled_times = np.zeros((settings.monte_carlo_draws, n_rooms))
        for j, (p25, p50, p90, degenerate) in enumerate(room_quantiles):
            if degenerate:
                sampled_times[:, j] = (p25 + p90) / 2.0
            else:
                quantile_dict = {0.25: p25, 0.5: p50, 0.9: p90}
                for d in range(settings.monte_carlo_draws):
                    sampled_times[d, j] = _invert_quantile_cdf(quantile_dict, float(u_matrix[d, j]))

        for headcount in range(1, max_headcount + 1):
            total_completed = 0

            for d in range(settings.monte_carlo_draws):
                # Same draw d → same room_times across every H (CRN).
                row = sampled_times[d].copy()
                # LPT: longest jobs first → assign to the currently-least-loaded
                # worker. Codex post-merge review F4a: use a min-heap so each
                # assignment is O(log H) instead of O(H) np.argmin.
                row[::-1].sort()  # descending in-place
                heap: List[Tuple[float, int]] = [(0.0, i) for i in range(headcount)]
                heapq.heapify(heap)
                for t in row:
                    load, worker_idx = heapq.heappop(heap)
                    heapq.heappush(heap, (load + float(t), worker_idx))

                # Max load = makespan = max(load for load, _ in heap)
                makespan = max(load for load, _ in heap) if heap else 0.0
                if makespan <= shift_cap:
                    total_completed += 1

            completion_prob = float(total_completed / settings.monte_carlo_draws)
            completion_curves.append({"headcount": headcount, "p": completion_prob})

            # First headcount that meets the target is the recommendation.
            if recommended_headcount is None and completion_prob >= target_prob:
                recommended_headcount = headcount

        # Codex post-merge review F4b: track whether we hit the search
        # ceiling without satisfying the target. If so, the cockpit should
        # show "we couldn't find a headcount that meets 95% on-time" rather
        # than treating the returned value as a confident recommendation.
        truncated_at_cap = False
        if recommended_headcount is None:
            recommended_headcount = max(completion_curves, key=lambda c: c["p"])["headcount"]
            truncated_at_cap = True
    else:
        # L1 path: total demand only. Codex adversarial review 2026-05-13
        # (M-C3): the prior code sampled uniform(p50, p95) which is biased
        # *upward* (opposite direction of the L2 bias). Now we use the
        # quantile-CDF inversion sampler. We have only two quantile points
        # to work with on the L1 layer (p50 and p95), so the inversion is
        # piecewise-linear with extrapolation in the tails.
        p50_minutes = float(demand.get("predicted_minutes_p50", 180.0) or 180.0)
        p95_minutes = float(demand.get("predicted_minutes_p95", 240.0) or 240.0)
        # Build the quantile dict; keep min/max for fallback when degenerate.
        l1_quantiles = {0.5: p50_minutes, 0.95: p95_minutes}
        max_demand = max(p95_minutes, p50_minutes + 1.0)  # avoid zero-width range

        completion_curves = []
        recommended_headcount = None

        # Codex audit pass-6 P1 — same rationale as the L2 path: derive
        # the search ceiling from the actual demand instead of a hard 10.
        shift_cap_l1 = float(settings.shift_cap_minutes) or 1.0
        max_headcount = max(
            10,
            min(50, int((max_demand / shift_cap_l1) * 1.5) + 1),
        )

        # Codex post-merge review F4 (CRN): pre-generate uniforms ONCE so
        # adjacent H values see the same demand samples.
        u_l1 = rng.uniform(size=settings.monte_carlo_draws)
        sampled_demands = np.array(
            [_invert_quantile_cdf(l1_quantiles, float(u)) for u in u_l1]
        )

        for headcount in range(1, max_headcount + 1):
            shift_capacity = headcount * settings.shift_cap_minutes
            # Same sampled_demands across every H → CRN.
            total_completed = int((sampled_demands <= shift_capacity).sum())

            completion_prob = float(total_completed / settings.monte_carlo_draws)
            completion_curves.append({"headcount": headcount, "p": completion_prob})

            if recommended_headcount is None and completion_prob >= target_prob:
                recommended_headcount = headcount

        # Same truncated_at_cap surfacing as the L2 path (F4b).
        truncated_at_cap = False
        if recommended_headcount is None:
            recommended_headcount = max(completion_curves, key=lambda c: c["p"])["headcount"]
            truncated_at_cap = True

    # Look up completion_prob by headcount value (not array index) so a
    # future change to the search range (e.g. range(2, 12)) doesn't
    # silently misalign. May 2026 audit pass-5: line 200 had a guard but
    # the symmetric lookup at line 227 didn't — IndexError if anything
    # ever pushes recommended_headcount past len(completion_curves).
    achieved_p = next(
        (c["p"] for c in completion_curves if c["headcount"] == recommended_headcount),
        0.95,
    )
    # Codex audit pass-6 P1 — flag when even the best searched headcount
    # didn't satisfy the target. The cockpit can render "we couldn't find
    # a headcount that meets 95% — at H=N you're at P=…" instead of
    # silently returning a recommendation that under-promises.
    target_met = achieved_p >= target_prob

    # Bound the optimistic sensitivity scenario at the actual searched
    # ceiling for this run rather than the old hard-coded 10.
    sensitivity_ceiling = max(c["headcount"] for c in completion_curves)

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
            "plus_5_checkouts": {"recommended": min(sensitivity_ceiling, recommended_headcount + 1)},
            "target_met": target_met,
            # Codex post-merge F4b: surface explicitly when no H in the
            # searched range met target_prob, so the cockpit can render
            # "we couldn't find a satisfying headcount" instead of treating
            # the returned value as a confident recommendation.
            "truncated_at_cap": truncated_at_cap,
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
