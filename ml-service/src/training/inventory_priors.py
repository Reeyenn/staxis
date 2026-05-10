"""Cross-hotel cohort prior aggregation.

Runs nightly. Aggregates inventory_counts from EVERY hotel in the network
by (brand, region, size_tier, item_canonical_name) and writes one row per
cohort+item pair to inventory_rate_priors. New properties signing up the
next day get accurate predictions on day 1 because their per-(item ×
property) Bayesian model is initialized with the cohort prior as mu_0.

Architecture:
- For each (cohort_key, item_canonical_name) tuple:
   - Look up every property in that cohort
   - Sum each property's recent count delta -> daily rate
   - Average across properties
   - Write to inventory_rate_priors with source='cohort-aggregate'
- The 'global' cohort is the fallback when no brand/region match exists;
  computed as the network-wide mean per item_canonical_name.

Prior strength schedule (used by training/inventory_rate.py via the
prior_strength column on inventory_rate_priors):
   <10 hotels in cohort  → strength=0.5  (weak — let property data dominate)
   10-50 hotels          → strength=2.0  (moderate — cohort gets ~10% weight)
   50+ hotels            → strength=5.0  (strong — cohort dominates new-hotel
                                          day-1 prediction)
"""
import json
import uuid
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

import pandas as pd

from src.supabase_client import get_supabase_client


# Prior strength schedule by cohort size
def _prior_strength_for(n_hotels: int) -> float:
    if n_hotels < 10:
        return 0.5
    if n_hotels < 50:
        return 2.0
    return 5.0


async def aggregate_inventory_priors() -> Dict[str, Any]:
    """Recompute every row in inventory_rate_priors from network-wide data.

    Returns:
        Summary stats: {cohorts_updated, items_canonical, errors}
    """
    client = get_supabase_client()

    # 1. Pull all properties with cohort metadata
    properties = client.fetch_many("properties", limit=5000)
    if not properties:
        return {"cohorts_updated": 0, "items_canonical": 0, "errors": [],
                "note": "no properties in network"}

    # 2. Pull canonical-name view (item_id → canonical_name)
    try:
        canonical_rows = client.fetch_many("item_canonical_name_view", limit=50000)
    except Exception as exc:
        return {"cohorts_updated": 0, "items_canonical": 0,
                "errors": [f"item_canonical_name_view fetch failed: {exc}"]}
    canonical_by_item = {r["item_id"]: r["item_canonical_name"] for r in canonical_rows or []}

    # 3. Pull every count event (last 90 days; older counts are stale for rate aggregation)
    since = (datetime.utcnow() - timedelta(days=90)).isoformat()
    try:
        all_counts_resp = client.client.table("inventory_counts")\
            .select("property_id,item_id,counted_stock,counted_at")\
            .gte("counted_at", since)\
            .limit(200000)\
            .execute()
        all_counts = all_counts_resp.data or []
    except Exception as exc:
        return {"cohorts_updated": 0, "items_canonical": 0,
                "errors": [f"inventory_counts fetch failed: {exc}"]}

    # 4. Compute per-property × per-item daily rate (consecutive count pairs)
    #    Skip items with <2 counts.
    per_property_item_rates: Dict[str, List[float]] = {}  # key = "property_id|canonical_name"
    grouped: Dict[tuple, List[Dict[str, Any]]] = {}
    for c in all_counts:
        canonical = canonical_by_item.get(c.get("item_id"))
        if not canonical or canonical == "unknown":
            continue
        key = (c["property_id"], canonical)
        grouped.setdefault(key, []).append(c)

    for (pid, canonical), counts in grouped.items():
        # Sort by counted_at ascending
        counts.sort(key=lambda r: r.get("counted_at") or "")
        rates: List[float] = []
        for i in range(1, len(counts)):
            prev = counts[i - 1]
            curr = counts[i]
            try:
                t_prev = pd.to_datetime(prev["counted_at"]).tz_localize(None)
                t_curr = pd.to_datetime(curr["counted_at"]).tz_localize(None)
            except Exception:
                continue
            days = max((t_curr - t_prev).total_seconds() / 86400.0, 0.5)
            usage = max(0.0, float(prev.get("counted_stock") or 0) - float(curr.get("counted_stock") or 0))
            rate = usage / days
            rates.append(rate)
        if rates:
            # Median is robust to outliers vs mean
            sorted_rates = sorted(rates)
            mid = len(sorted_rates) // 2
            median = (sorted_rates[mid] if len(sorted_rates) % 2 == 1
                      else (sorted_rates[mid - 1] + sorted_rates[mid]) / 2.0)
            per_property_item_rates[f"{pid}|{canonical}"] = [median]

    # 5. Aggregate by cohort_key + canonical_name
    #    cohort_key = "<brand>-<region>-<size_tier>" (lowercased, slug-ified)
    #    plus a 'global' bucket per canonical_name covering all properties
    cohort_buckets: Dict[tuple, List[float]] = {}
    cohort_hotel_counts: Dict[tuple, set] = {}

    prop_meta = {p["id"]: p for p in properties}

    def _slug(s: Optional[str]) -> str:
        return (s or "").strip().lower().replace(" ", "-")

    for key_str, rates in per_property_item_rates.items():
        pid, canonical = key_str.split("|", 1)
        prop = prop_meta.get(pid)
        if not prop:
            continue
        # Cohort key (specific) — only when all 3 cohort fields are populated
        brand = prop.get("brand")
        region = prop.get("region")
        size_tier = prop.get("size_tier")
        cohort_keys: List[str] = ["global"]
        if brand and region and size_tier:
            cohort_keys.append(f"{_slug(brand)}-{_slug(region)}-{_slug(size_tier)}")
        for ck in cohort_keys:
            tup = (ck, canonical)
            cohort_buckets.setdefault(tup, []).extend(rates)
            cohort_hotel_counts.setdefault(tup, set()).add(pid)

    # 6. Upsert into inventory_rate_priors. CAREFUL: we don't want to clobber
    #    the industry-benchmark seeds at small N — a single hotel's atypical
    #    median can pull the global prior far from the well-tuned seed value.
    #    Rule:
    #      - cohort_key != 'global' → always upsert (cohort priors only exist
    #        when we actually have cohort data; nothing to clobber).
    #      - cohort_key == 'global' AND n_hotels < 5 → skip. Industry seed
    #        stays. The model's per-property Bayesian posterior will dominate
    #        anyway after a few counts.
    #      - cohort_key == 'global' AND n_hotels >= 5 → upsert. Real network
    #        signal beats a hardcoded benchmark.
    cohorts_updated = 0
    cohorts_skipped_low_n = 0
    errors: List[str] = []
    for (cohort_key, canonical), rates in cohort_buckets.items():
        if not rates:
            continue
        n_hotels = len(cohort_hotel_counts.get((cohort_key, canonical), set()))
        if cohort_key == "global" and n_hotels < 5:
            cohorts_skipped_low_n += 1
            continue
        # Median across the (median-rate-per-hotel) values
        sorted_rates = sorted(rates)
        mid = len(sorted_rates) // 2
        cohort_median = (sorted_rates[mid] if len(sorted_rates) % 2 == 1
                         else (sorted_rates[mid - 1] + sorted_rates[mid]) / 2.0)
        try:
            client.client.table("inventory_rate_priors").upsert({
                "cohort_key": cohort_key,
                "item_canonical_name": canonical,
                "prior_rate_per_room_per_day": float(cohort_median),
                "n_hotels_contributing": n_hotels,
                "prior_strength": _prior_strength_for(n_hotels),
                "source": "cohort-aggregate",
                "updated_at": datetime.utcnow().isoformat(),
            }, on_conflict="cohort_key,item_canonical_name").execute()
            cohorts_updated += 1
        except Exception as exc:
            errors.append(f"upsert failed for ({cohort_key}, {canonical}): {exc}")

    return {
        "cohorts_updated": cohorts_updated,
        "items_canonical": len(set(c[1] for c in cohort_buckets.keys())),
        "errors": errors,
        "note": (
            f"skipped {cohorts_skipped_low_n} global rows with n_hotels<5 "
            "(kept industry-benchmark seeds)"
            if cohorts_skipped_low_n else None
        ),
    }
