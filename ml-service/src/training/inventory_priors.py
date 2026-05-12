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
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

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

    # 3. Compute per-(property, item) median daily-usage rate via SQL.
    #
    # Codex audit pass-6 P1 — two issues fixed:
    #
    # (a) The previous version computed `usage = max(0, prev_stock -
    #     curr_stock)`, ignoring orders/restocks and discards between
    #     two consecutive counts. If 50 units were ordered in between,
    #     real usage was ~50 + (prev - curr), not just (prev - curr).
    #     For active items this systematically under-counted usage,
    #     producing cohort priors that biased low.
    #
    # (b) The fetch was capped at limit=200000 with no pagination. Past
    #     ~5-10 hotels with 90 days of history this would silently
    #     truncate. Doing the aggregation in SQL also avoids pulling
    #     every count event into Python memory.
    #
    # The CTE pairs each count with the next one (LEAD over counted_at),
    # sums orders received and discards in the window, computes
    # actual_usage, and returns one median-rate row per (property, item).
    since = (datetime.utcnow() - timedelta(days=90)).isoformat()
    rates_query = f"""
        with paired as (
            select
                c.property_id,
                c.item_id,
                c.counted_stock as prev_stock,
                c.counted_at    as prev_at,
                lead(c.counted_stock) over (
                    partition by c.property_id, c.item_id
                    order by c.counted_at
                ) as curr_stock,
                lead(c.counted_at) over (
                    partition by c.property_id, c.item_id
                    order by c.counted_at
                ) as curr_at
            from inventory_counts c
            where c.counted_at >= '{since}'
        ),
        with_window as (
            select
                p.property_id,
                p.item_id,
                p.prev_stock,
                p.curr_stock,
                p.prev_at,
                p.curr_at,
                greatest(extract(epoch from (p.curr_at - p.prev_at)) / 86400.0, 0.5) as days,
                coalesce((
                    select sum(o.quantity)
                    from inventory_orders o
                    where o.property_id = p.property_id
                      and o.item_id = p.item_id
                      and o.received_at > p.prev_at
                      and o.received_at <= p.curr_at
                ), 0) as orders_in_window,
                coalesce((
                    select sum(d.quantity)
                    from inventory_discards d
                    where d.property_id = p.property_id
                      and d.item_id = p.item_id
                      and d.discarded_at > p.prev_at
                      and d.discarded_at <= p.curr_at
                ), 0) as discards_in_window
            from paired p
            where p.curr_at is not null
              and p.prev_stock is not null
              and p.curr_stock is not null
        ),
        per_pair as (
            select
                property_id,
                item_id,
                greatest(
                    (prev_stock + orders_in_window - discards_in_window - curr_stock),
                    0
                ) / days as rate_per_day
            from with_window
            where days > 0
        )
        select
            property_id,
            item_id,
            percentile_cont(0.5) within group (order by rate_per_day)::float8 as median_rate,
            count(*)::int as n_pairs
        from per_pair
        group by property_id, item_id
    """

    try:
        rate_rows = client.execute_sql(rates_query) or []
    except Exception as exc:
        return {"cohorts_updated": 0, "items_canonical": 0,
                "errors": [f"per-property rate aggregation failed: {exc}"]}

    per_property_item_rates: Dict[str, List[float]] = {}
    for row in rate_rows:
        canonical = canonical_by_item.get(row.get("item_id"))
        if not canonical or canonical == "unknown":
            continue
        median = row.get("median_rate")
        if median is None:
            continue
        per_property_item_rates[f"{row['property_id']}|{canonical}"] = [float(median)]

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
