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

REDUCED-EXPOSURE ADDITION (2026-07-05): alongside the legacy per-room-per-day
prior (prior_rate_per_room_per_day, KEPT), we now also compute a per-CHECKOUT-
EQUIVALENT prior rate_per_checkout_eq = median over hotels of s_hat, where
s_hat = window_consumption / (ΣCheckouts + κ·ΣStayovers) (same window hygiene;
κ from each item's usage config). This seeds the exposure model's single
coefficient s for a brand-new item. Written to inventory_rate_priors.
rate_per_checkout_eq + n_hotels (migration 0294).

PRECISION CAP: with 1-3 contributing hotels the between-hotel signal is noise, so
the CONSUMER (trainer _lookup_exposure_prior_with_source) caps the exposure
prior's effective strength at ~1 hotel's worth of evidence until n_hotels >= 4.
The 0.5/2.0/5.0 schedule remains the ceiling SHAPE. Between-hotel-variance
empirical Bayes is DEFERRED until ≥4 hotels — not built here.

is_test / demo properties are EXCLUDED from every aggregation (both the Python
property fetch and the rate SQL), mirroring the inventory_ai_mode<>'off' filter,
so a demo hotel never shapes the network prior every real hotel inherits.
"""
import json
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

import numpy as np

from src.config import INVENTORY_DEFAULT_KAPPA
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

    # 1. Pull all properties with cohort metadata. Exclude test/demo properties
    #    (coalesce NULL → false) so a demo hotel never shapes the network prior —
    #    mirrors the SQL's is_test exclusion + the existing inventory_ai_mode
    #    filter. Belt-and-suspenders: the rate SQL already drops is_test rows, so
    #    filtering here just keeps prop_meta consistent.
    all_properties = client.fetch_many("properties", limit=5000)
    properties = [p for p in (all_properties or []) if not p.get("is_test", False)]
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
    # 2026-07-05 reduced-exposure rebuild — this SQL now produces TWO
    # denominations per (property, item):
    #   • median_rate  — legacy per-ROOM-per-day (KEPT; the occupancy-family
    #     model and other consumers still read it).
    #   • median_s     — per-CHECKOUT-EQUIVALENT usage scale s_hat =
    #     consumption / (ΣCO + κ·ΣSO) over the window, where ΣCO/ΣSO are summed
    #     daily_logs checkouts/stayovers (stayovers per 0224 INCLUDES arrivals)
    #     and κ = usage_per_stayover / usage_per_checkout from the inventory row
    #     (fallback {default_kappa} when missing/zero). This seeds the exposure
    #     model's single coefficient s for a brand-new item.
    # A window's exposure sum is only valid when daily_logs has NON-NULL
    # checkouts AND stayovers for EVERY day in (prev_at, curr_at]; otherwise the
    # window is EXCLUDED from median_s (but can still contribute to median_rate).
    # is_test properties are excluded (coalesce false) so a demo hotel never
    # shapes the network prior every real hotel inherits — mirrors the existing
    # inventory_ai_mode<>'off' exclusion.
    default_kappa = INVENTORY_DEFAULT_KAPPA
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
                extract(epoch from (p.curr_at - p.prev_at)) / 86400.0 as days,
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
                ), 0) as discards_in_window,
                -- Exposure sums over the window from daily_logs. NULL when ANY
                -- day in the window has NULL checkouts/stayovers (feed still
                -- learning) — an incomplete window is not a trustworthy s_hat.
                (
                    select case
                             when count(*) = 0 then null
                             when bool_or(dl.checkouts is null or dl.stayovers is null) then null
                             else sum(dl.checkouts)
                           end
                    from daily_logs dl
                    where dl.property_id = p.property_id
                      and dl.date > (p.prev_at)::date
                      and dl.date <= (p.curr_at)::date
                ) as sum_checkouts,
                (
                    select case
                             when count(*) = 0 then null
                             when bool_or(dl.checkouts is null or dl.stayovers is null) then null
                             else sum(dl.stayovers)
                           end
                    from daily_logs dl
                    where dl.property_id = p.property_id
                      and dl.date > (p.prev_at)::date
                      and dl.date <= (p.curr_at)::date
                ) as sum_stayovers
            from paired p
            where p.curr_at is not null
              and p.prev_stock is not null
              and p.curr_stock is not null
        ),
        per_pair as (
            -- Codex round-5 META J2.1 (2026-05-13): divide by total_rooms so the
            -- column name (prior_rate_per_room_per_day) matches its units.
            -- REDUCED-EXPOSURE (2026-07-05): also compute s_hat = consumption /
            -- (ΣCO + κ·ΣSO). κ from the inventory row's usage config; fallback
            -- {default_kappa}. NULL when the exposure denominator is missing
            -- (incomplete window) or <= 0.
            select
                w.property_id,
                w.item_id,
                (w.prev_stock + w.orders_in_window - w.discards_in_window - w.curr_stock)
                    / w.days / nullif(p.total_rooms, 0)::float8 as rate_per_room_per_day,
                case
                  when w.sum_checkouts is null or w.sum_stayovers is null then null
                  when (w.sum_checkouts + k.kappa * w.sum_stayovers) <= 0 then null
                  else (w.prev_stock + w.orders_in_window - w.discards_in_window - w.curr_stock)
                       / (w.sum_checkouts + k.kappa * w.sum_stayovers)::float8
                end as s_per_checkout_eq
            from with_window w
            join public.properties p on p.id = w.property_id
            join public.inventory inv on inv.id = w.item_id
            -- κ resolution MUST mirror training/_item_family.resolve_kappa
            -- exactly, or the cohort s_hat is denominated on a different κ
            -- than the trainer will use when serving that prior:
            --   • an EXPLICIT usage_per_stayover = 0 is honored as κ = 0
            --     (the old nullif(...,0) silently swapped it for the 0.30
            --     fallback);
            --   • κ is clamped to <= 5.0 (the trainer clamps; unclamped SQL
            --     let a fat-fingered usage_per_checkout=0.001 blow κ up);
            --   • missing/invalid config falls back to {default_kappa}.
            cross join lateral (
                select case
                         when inv.usage_per_checkout is not null
                          and inv.usage_per_checkout > 0
                          and inv.usage_per_stayover is not null
                          and inv.usage_per_stayover >= 0
                         then least(inv.usage_per_stayover / inv.usage_per_checkout, 5.0)::float8
                         else {default_kappa}
                       end as kappa
            ) k
            -- Window hygiene — mirror training/inventory_rate._build_training_rows:
            -- drop sub-day pairs; keep positive consumption AND genuine zero-
            -- usage windows; drop unexplained increases + auto-stock-up zeros.
            where w.days >= 1.0
              and p.total_rooms > 0
              and (
                (w.prev_stock + w.orders_in_window - w.discards_in_window - w.curr_stock) > 0
                or (
                  (w.prev_stock + w.orders_in_window - w.discards_in_window - w.curr_stock) = 0
                  and w.curr_stock <= w.prev_stock
                )
              )
              -- Exclude AI-off hotels (coalesce keeps legacy NULL = on).
              and coalesce(p.inventory_ai_mode, 'on') <> 'off'
              -- Exclude test/demo properties from the network prior.
              and coalesce(p.is_test, false) = false
        )
        select
            property_id,
            item_id,
            percentile_cont(0.5) within group (order by rate_per_room_per_day)::float8 as median_rate,
            -- percentile_cont is an ordered-set aggregate that IGNORES NULL
            -- inputs, so incomplete-window rows (s_per_checkout_eq NULL) drop out
            -- automatically; result is NULL when every window was incomplete.
            (percentile_cont(0.5) within group (order by s_per_checkout_eq))::float8 as median_s,
            count(*)::int as n_pairs,
            count(s_per_checkout_eq)::int as n_pairs_s
        from per_pair
        where rate_per_room_per_day is not null
        group by property_id, item_id
    """

    try:
        rate_rows = client.execute_sql(rates_query) or []
    except Exception as exc:
        return {"cohorts_updated": 0, "items_canonical": 0,
                "errors": [f"per-property rate aggregation failed: {exc}"]}

    per_property_item_rates: Dict[str, List[float]] = {}
    # Exposure denomination (2026-07-05): per-(property, canonical) list of s_hat
    # medians. Separate from the per-room list because a window can contribute to
    # median_rate but not median_s (incomplete daily_logs exposure).
    per_property_item_s: Dict[str, List[float]] = {}
    for row in rate_rows:
        canonical = canonical_by_item.get(row.get("item_id"))
        if not canonical or canonical == "unknown":
            continue
        median = row.get("median_rate")
        if median is not None:
            # APPEND, don't overwrite — several SKUs collapse to one canonical.
            per_property_item_rates.setdefault(
                f"{row['property_id']}|{canonical}", []
            ).append(float(median))
        median_s = row.get("median_s")
        if median_s is not None:
            try:
                s_val = float(median_s)
                if s_val > 0:
                    per_property_item_s.setdefault(
                        f"{row['property_id']}|{canonical}", []
                    ).append(s_val)
            except (TypeError, ValueError):
                pass

    # 5. Aggregate by cohort_key + canonical_name
    #    cohort_key = "<brand>-<region>-<size_tier>" (lowercased, slug-ified)
    #    plus a 'global' bucket per canonical_name covering all properties
    cohort_buckets: Dict[tuple, List[float]] = {}
    cohort_hotel_counts: Dict[tuple, set] = {}
    # Exposure buckets, parallel to cohort_buckets.
    cohort_s_buckets: Dict[tuple, List[float]] = {}
    cohort_s_hotels: Dict[tuple, set] = {}

    prop_meta = {p["id"]: p for p in properties}

    def _slug(s: Optional[str]) -> str:
        return (s or "").strip().lower().replace(" ", "-")

    def _cohort_keys_for(pid: str) -> List[str]:
        prop = prop_meta.get(pid)
        if not prop:
            return []
        brand = prop.get("brand")
        region = prop.get("region")
        size_tier = prop.get("size_tier")
        keys: List[str] = ["global"]
        if brand and region and size_tier:
            keys.append(f"{_slug(brand)}-{_slug(region)}-{_slug(size_tier)}")
        return keys

    for key_str, rates in per_property_item_rates.items():
        pid, canonical = key_str.split("|", 1)
        for ck in _cohort_keys_for(pid):
            tup = (ck, canonical)
            cohort_buckets.setdefault(tup, []).extend(rates)
            cohort_hotel_counts.setdefault(tup, set()).add(pid)

    for key_str, s_vals in per_property_item_s.items():
        pid, canonical = key_str.split("|", 1)
        for ck in _cohort_keys_for(pid):
            tup = (ck, canonical)
            cohort_s_buckets.setdefault(tup, []).extend(s_vals)
            cohort_s_hotels.setdefault(tup, set()).add(pid)

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
    cohorts_with_outliers_clipped = 0
    cohorts_skipped_out_of_range = 0
    errors: List[str] = []
    # Round 16 (2026-05-15): doctor.inventory_priors_in_range fires when a
    # cohort prior lands outside [0.001, 10] /room/day — single-hotel
    # cohorts with sparse incident logs were rounding down to 0.000 and
    # poisoning every new-hotel cold-start prediction in that cohort.
    # Match the doctor's sane range here so the trainer simply refuses
    # to write a prior the doctor would immediately flag.
    SANE_PRIOR_LO = 0.001
    SANE_PRIOR_HI = 10.0
    for (cohort_key, canonical), rates in cohort_buckets.items():
        if not rates:
            continue
        n_hotels = len(cohort_hotel_counts.get((cohort_key, canonical), set()))
        if cohort_key == "global" and n_hotels < 5:
            cohorts_skipped_low_n += 1
            continue

        # Codex adversarial review 2026-05-13 (M-C5): the prior implementation
        # took a raw median across per-hotel rates with NO outlier defense.
        # One rogue hotel logging 50,000 of an item per day skewed the global
        # prior, and every NEW hotel's day-1 prediction inherited that
        # poisoned value. We now apply IQR clipping (Tukey fences) before
        # taking the median:
        #   q1, q3 = 25th, 75th percentile
        #   iqr = q3 - q1
        #   keep rates in [q1 - 1.5*iqr, q3 + 1.5*iqr]
        # We need at least 4 contributors before clipping makes sense
        # (otherwise IQR is meaningless). Below 4, fall back to raw median.
        # Codex post-merge review 2026-05-13 (F5): IQR clip on raw rates
        # was over-aggressive for lognormal data (a 200-room hotel
        # legitimately uses 10× a 30-room hotel; Tukey-on-raw clipped real
        # cohort members and biased the prior LOW). Fix: clip on
        # log1p(rates) so multiplicative noise becomes additive and
        # the Tukey assumption (~symmetric distribution) holds.
        rates_arr = np.asarray(rates, dtype=float)
        if len(rates_arr) >= 4:
            log_rates = np.log1p(rates_arr)
            q1 = float(np.percentile(log_rates, 25))
            q3 = float(np.percentile(log_rates, 75))
            iqr = q3 - q1
            lo, hi = q1 - 1.5 * iqr, q3 + 1.5 * iqr
            mask = (log_rates >= lo) & (log_rates <= hi)
            n_clipped = int((~mask).sum())
            if mask.any():
                clipped = rates_arr[mask]
            else:
                # F5a: every value clipped is pathological — should never
                # happen with sane data. Log LOUD so operators notice,
                # then fall back to unclipped (a noisy prior beats no prior).
                print(json.dumps({
                    "level": "error",
                    "event": "cohort_prior_all_clipped",
                    "cohort_key": cohort_key,
                    "canonical": canonical,
                    "n_input": int(len(rates_arr)),
                    "log_iqr_lo": lo,
                    "log_iqr_hi": hi,
                    "rates_sample": [float(r) for r in rates_arr[:5].tolist()],
                    "ts": datetime.utcnow().isoformat(),
                }))
                clipped = rates_arr
            if n_clipped > 0:
                cohorts_with_outliers_clipped += 1
                print(json.dumps({
                    "level": "info",
                    "event": "cohort_prior_outliers_clipped",
                    "cohort_key": cohort_key,
                    "canonical": canonical,
                    "n_input": int(len(rates_arr)),
                    "n_clipped": n_clipped,
                    "log_iqr_lo": lo,
                    "log_iqr_hi": hi,
                    "ts": datetime.utcnow().isoformat(),
                }))
            cohort_median = float(np.median(clipped))
        else:
            sorted_rates = sorted(rates)
            mid = len(sorted_rates) // 2
            cohort_median = (sorted_rates[mid] if len(sorted_rates) % 2 == 1
                             else (sorted_rates[mid - 1] + sorted_rates[mid]) / 2.0)

        # Refuse to persist priors outside the doctor's sane range. A
        # single hotel with one or two sparse incident logs can compute a
        # median rate of 0.000 (or absurdly high) — writing that as the
        # cohort prior poisons every future new-hotel onboarding in that
        # cohort. Keep the industry-benchmark seed instead.
        if not (SANE_PRIOR_LO <= cohort_median <= SANE_PRIOR_HI):
            cohorts_skipped_out_of_range += 1
            print(json.dumps({
                "level": "warn",
                "event": "cohort_prior_out_of_sane_range",
                "cohort_key": cohort_key,
                "canonical": canonical,
                "n_hotels": n_hotels,
                "n_rates": int(len(rates)),
                "cohort_median": cohort_median,
                "sane_range": [SANE_PRIOR_LO, SANE_PRIOR_HI],
                "ts": datetime.utcnow().isoformat(),
            }))
            continue

        # ── Exposure prior (rate_per_checkout_eq) for this cohort+canonical ──
        # Pooled median of the per-(property) s_hat medians, log-IQR-clipped like
        # the per-room path when ≥4 contributors. n_hotels_s = distinct hotels
        # contributing an exposure s. Left NULL when no window had complete
        # daily_logs exposure. PRECISION CAP note: the exposure prior_strength is
        # capped consumer-side (trainer _lookup_exposure_prior_with_source) at ~1
        # hotel's evidence until n_hotels >= 4 — we still persist the true
        # n_hotels here so the cap can key off it.
        s_vals = cohort_s_buckets.get((cohort_key, canonical), [])
        n_hotels_s = len(cohort_s_hotels.get((cohort_key, canonical), set()))
        rate_per_checkout_eq: Optional[float] = None
        if s_vals:
            s_arr = np.asarray(s_vals, dtype=float)
            if len(s_arr) >= 4:
                log_s = np.log1p(s_arr)
                q1s = float(np.percentile(log_s, 25))
                q3s = float(np.percentile(log_s, 75))
                iqrs = q3s - q1s
                mask_s = (log_s >= q1s - 1.5 * iqrs) & (log_s <= q3s + 1.5 * iqrs)
                s_clipped = s_arr[mask_s] if mask_s.any() else s_arr
            else:
                s_clipped = s_arr
            cand = float(np.median(s_clipped))
            # Only persist a sane exposure prior (same [0.001, 10] band shape).
            if SANE_PRIOR_LO <= cand <= SANE_PRIOR_HI:
                rate_per_checkout_eq = cand

        try:
            payload = {
                "cohort_key": cohort_key,
                "item_canonical_name": canonical,
                "prior_rate_per_room_per_day": float(cohort_median),
                "n_hotels_contributing": n_hotels,
                "prior_strength": _prior_strength_for(n_hotels),
                "source": "cohort-aggregate",
                "updated_at": datetime.utcnow().isoformat(),
                "n_hotels": n_hotels_s,
            }
            if rate_per_checkout_eq is not None:
                payload["rate_per_checkout_eq"] = rate_per_checkout_eq
            client.client.table("inventory_rate_priors").upsert(
                payload, on_conflict="cohort_key,item_canonical_name"
            ).execute()
            cohorts_updated += 1
        except Exception as exc:
            errors.append(f"upsert failed for ({cohort_key}, {canonical}): {exc}")

    notes: List[str] = []
    if cohorts_skipped_low_n:
        notes.append(
            f"skipped {cohorts_skipped_low_n} global rows with n_hotels<5 "
            "(kept industry-benchmark seeds)"
        )
    if cohorts_skipped_out_of_range:
        notes.append(
            f"skipped {cohorts_skipped_out_of_range} cohort rows with "
            f"median outside [{SANE_PRIOR_LO}, {SANE_PRIOR_HI}] /room/day "
            "(kept industry-benchmark seeds)"
        )
    return {
        "cohorts_updated": cohorts_updated,
        "items_canonical": len(set(c[1] for c in cohort_buckets.keys())),
        "cohorts_with_outliers_clipped": cohorts_with_outliers_clipped,
        "cohorts_skipped_out_of_range": cohorts_skipped_out_of_range,
        "errors": errors,
        "note": "; ".join(notes) if notes else None,
    }
