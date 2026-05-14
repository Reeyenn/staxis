"""Cross-hotel cohort prior aggregation for demand + supply layers.

Mirrors the inventory cohort-prior architecture (training/inventory_priors.py)
for the housekeeping ML stack. Runs on the same daily cadence as the
existing ml-aggregate-priors cron.

Demand (per-property per-day total housekeeping minutes):
  Source: cleaning_minutes_per_day_view.total_recorded_minutes
  Normalization: divide by total_rooms to make cohort-comparable
  Aggregate: median of (per-property median minutes-per-room-per-day)
  Output: demand_priors.prior_minutes_per_room_per_day

Supply (per-(room×staff×event) cleaning duration):
  Source: cleaning_events.duration_minutes (status='recorded' only —
          'flagged' rows are operator-marked outliers)
  Aggregate: median of (per-property median duration_minutes per event)
  Output: supply_priors.prior_minutes_per_event

Cohort key (same as inventory): "<brand>-<region>-<size_tier>" lowercased
+ slug-ified, with a 'global' fallback bucket per cohort.

Source tagging:
  industry-benchmark — hardcoded seed (migration 0122). Day 1 fallback
                       before any cohort has 5+ hotels.
  cohort-aggregate   — written here when cohort has 5+ hotels with data.
                       Overrides the industry seed once real fleet
                       evidence accumulates.

Prior strength schedule (mirrors inventory):
   <10 hotels  → strength=0.5  (weak — let property data dominate)
   10-50       → strength=2.0  (moderate)
   50+         → strength=5.0  (strong — cohort dominates day-1)
"""
import json
import statistics
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

from src.supabase_client import get_supabase_client


# ─── Shared helpers ─────────────────────────────────────────────────────


def _slug(s: Optional[str]) -> str:
    """Same slug normalization as inventory_priors._slug."""
    return (s or "").strip().lower().replace(" ", "-")


def _cohort_keys_for(prop: Dict[str, Any]) -> List[str]:
    """Returns one or two cohort keys for a property:
      - Always 'global'
      - Plus '<brand>-<region>-<size_tier>' if all three are populated.
    """
    keys = ["global"]
    brand = prop.get("brand")
    region = prop.get("region")
    size_tier = prop.get("size_tier")
    if brand and region and size_tier:
        keys.append(f"{_slug(brand)}-{_slug(region)}-{_slug(size_tier)}")
    return keys


def _prior_strength_for(n_hotels: int) -> float:
    """Cohort-size → prior strength. Same schedule as inventory."""
    if n_hotels < 10:
        return 0.5
    if n_hotels < 50:
        return 2.0
    return 5.0


# ─── Demand priors ──────────────────────────────────────────────────────


async def aggregate_demand_priors() -> Dict[str, Any]:
    """Recompute every row in demand_priors from network-wide cleaning data.

    Returns:
        {cohorts_updated, hotels_seen, errors, skipped_low_n}
    """
    client = get_supabase_client()

    # Pull all properties with cohort metadata + total_rooms (used to
    # normalize per-room).
    properties = client.fetch_many("properties", limit=5000)
    if not properties:
        return {"cohorts_updated": 0, "hotels_seen": 0, "errors": [],
                "note": "no properties in network"}
    prop_meta = {p["id"]: p for p in properties}

    # Pull last-90-days demand rows.
    since = (datetime.utcnow() - timedelta(days=90)).date().isoformat()
    try:
        rows = client.fetch_many(
            "cleaning_minutes_per_day_view",
            filters=None,
            order_by="date",
            descending=True,
            limit=200000,
        )
    except Exception as exc:
        return {"cohorts_updated": 0, "hotels_seen": 0,
                "errors": [f"cleaning_minutes_per_day_view fetch failed: {exc}"]}

    # Filter to last 90 days + non-null totals + property has total_rooms.
    cutoff_date = since
    per_property_rates: Dict[str, List[float]] = {}
    hotels_seen: set = set()
    for row in rows or []:
        date_val = row.get("date")
        if date_val is None or str(date_val) < cutoff_date:
            continue
        total = row.get("total_recorded_minutes")
        if total is None:
            continue
        pid = row.get("property_id")
        if not pid:
            continue
        prop = prop_meta.get(pid)
        if not prop:
            continue
        rooms = prop.get("total_rooms")
        if not rooms or rooms <= 0:
            continue  # require_total_rooms — properties without room count can't normalize
        per_room = float(total) / float(rooms)
        per_property_rates.setdefault(pid, []).append(per_room)
        hotels_seen.add(pid)

    # Per-property median, then bucket by cohort.
    cohort_buckets: Dict[str, List[float]] = {}
    cohort_hotels: Dict[str, set] = {}
    for pid, rates in per_property_rates.items():
        if not rates:
            continue
        prop_median = statistics.median(rates)
        prop = prop_meta.get(pid, {})
        for ck in _cohort_keys_for(prop):
            cohort_buckets.setdefault(ck, []).append(prop_median)
            cohort_hotels.setdefault(ck, set()).add(pid)

    # Upsert. Same logic as inventory:
    #   global cohort needs 5+ hotels (else industry-benchmark seed wins)
    #   specific cohorts always upsert (they only exist with real data)
    cohorts_updated = 0
    skipped_low_n = 0
    errors: List[str] = []
    for cohort_key, rates in cohort_buckets.items():
        if not rates:
            continue
        n_hotels = len(cohort_hotels.get(cohort_key, set()))
        if cohort_key == "global" and n_hotels < 5:
            skipped_low_n += 1
            continue
        cohort_median = statistics.median(rates)
        # Outlier defense: clip to [1, 200] min/room/day. Below 1 is
        # implausibly low (some clean must happen); above 200 is 3+ hours
        # per room which suggests data contamination, not real labor.
        cohort_median = max(1.0, min(200.0, cohort_median))
        try:
            client.client.table("demand_priors").upsert({
                "cohort_key": cohort_key,
                "prior_minutes_per_room_per_day": cohort_median,
                "n_hotels_contributing": n_hotels,
                "prior_strength": _prior_strength_for(n_hotels),
                "source": "cohort-aggregate",
                "updated_at": datetime.utcnow().isoformat(),
            }, on_conflict="cohort_key").execute()
            cohorts_updated += 1
        except Exception as exc:
            errors.append(f"demand upsert failed for {cohort_key}: {exc}")

    return {
        "cohorts_updated": cohorts_updated,
        "hotels_seen": len(hotels_seen),
        "skipped_low_n": skipped_low_n,
        "errors": errors,
    }


# ─── Supply priors ──────────────────────────────────────────────────────


async def aggregate_supply_priors() -> Dict[str, Any]:
    """Recompute every row in supply_priors from network-wide cleaning_events.

    Returns:
        {cohorts_updated, hotels_seen, errors, skipped_low_n}
    """
    client = get_supabase_client()

    properties = client.fetch_many("properties", limit=5000)
    if not properties:
        return {"cohorts_updated": 0, "hotels_seen": 0, "errors": [],
                "note": "no properties in network"}
    prop_meta = {p["id"]: p for p in properties}

    # Pull last-90-days cleaning_events. status filter excludes 'flagged'
    # operator-marked outliers — those would skew the median.
    since = (datetime.utcnow() - timedelta(days=90)).date().isoformat()
    try:
        rows = client.fetch_many(
            "cleaning_events",
            filters={"status": "recorded"},
            order_by="date",
            descending=True,
            limit=200000,
        )
    except Exception as exc:
        return {"cohorts_updated": 0, "hotels_seen": 0,
                "errors": [f"cleaning_events fetch failed: {exc}"]}

    per_property_durations: Dict[str, List[float]] = {}
    hotels_seen: set = set()
    cutoff_date = since
    for row in rows or []:
        date_val = row.get("date")
        if date_val is None or str(date_val) < cutoff_date:
            continue
        duration = row.get("duration_minutes")
        if duration is None:
            continue
        try:
            d = float(duration)
        except (TypeError, ValueError):
            continue
        if d <= 0:
            continue
        pid = row.get("property_id")
        if not pid or pid not in prop_meta:
            continue
        per_property_durations.setdefault(pid, []).append(d)
        hotels_seen.add(pid)

    cohort_buckets: Dict[str, List[float]] = {}
    cohort_hotels: Dict[str, set] = {}
    for pid, durations in per_property_durations.items():
        if not durations:
            continue
        prop_median = statistics.median(durations)
        prop = prop_meta.get(pid, {})
        for ck in _cohort_keys_for(prop):
            cohort_buckets.setdefault(ck, []).append(prop_median)
            cohort_hotels.setdefault(ck, set()).add(pid)

    cohorts_updated = 0
    skipped_low_n = 0
    errors: List[str] = []
    for cohort_key, rates in cohort_buckets.items():
        if not rates:
            continue
        n_hotels = len(cohort_hotels.get(cohort_key, set()))
        if cohort_key == "global" and n_hotels < 5:
            skipped_low_n += 1
            continue
        cohort_median = statistics.median(rates)
        # Outlier defense: clip to [5, 120] minutes per cleaning event.
        # Below 5 is "didn't really clean" data quality issue; above 120
        # is "took 2 hours" likely a logged break or stuck timer.
        cohort_median = max(5.0, min(120.0, cohort_median))
        try:
            client.client.table("supply_priors").upsert({
                "cohort_key": cohort_key,
                "prior_minutes_per_event": cohort_median,
                "n_hotels_contributing": n_hotels,
                "prior_strength": _prior_strength_for(n_hotels),
                "source": "cohort-aggregate",
                "updated_at": datetime.utcnow().isoformat(),
            }, on_conflict="cohort_key").execute()
            cohorts_updated += 1
        except Exception as exc:
            errors.append(f"supply upsert failed for {cohort_key}: {exc}")

    return {
        "cohorts_updated": cohorts_updated,
        "hotels_seen": len(hotels_seen),
        "skipped_low_n": skipped_low_n,
        "errors": errors,
    }
