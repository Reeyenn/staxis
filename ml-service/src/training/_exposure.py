"""Reduced-exposure inventory model — pure window/weight math.

The converged model (from the 4-way review) for guest-consumable items:

    window_consumption_i = s · (ΣCO_i + κ · ΣSO_i) + ε_i

  • ΣCO_i / ΣSO_i  — summed daily checkouts / stayovers from daily_logs over the
    count window (t_prev, t_curr].
  • κ              — FIXED per item (usage_per_stayover / usage_per_checkout;
    fallback INVENTORY_DEFAULT_KAPPA). Not learned.
  • s              — the ONE learned coefficient (per-checkout usage scale),
    fit with the conjugate BayesianRegression on the single composite
    regressor  x_i = ΣCO_i + κ · ΣSO_i.  No intercept — base fixed at 0.

Row weight (down-weights long/noisy windows):

    w_i = 1 / (σ_d² · d_i + 2·τ²)

  d_i = window length in days; σ_d² = per-day process variance
  (inventory_daily_process_var); τ² = single-count read variance
  (inventory_count_noise). The 2·τ² is the variance of the two boundary counts
  that bound every window.

WINDOW COMPLETENESS: a window's exposure sums are only valid if daily_logs has
NON-NULL checkouts AND stayovers for EVERY operational day in (t_prev, t_curr].
Incomplete windows are DROPPED (the caller counts how many). daily_logs.checkouts
/ .stayovers are NULL while the reservation feeds are learning (seal-daily writes
NULL, not 0) — folding a NULL day in as 0 would understate exposure and inflate s.

daily_logs ↔ plan_snapshots STAYOVER ALIGNMENT (load-bearing — read before
changing): daily_logs is sealed from today_property_counts_v1 (migration 0224),
whose `stayovers` = reservations with arrival_date <= date AND departure_date >
date — i.e. it INCLUDES same-day arrivals who stay overnight. `checkouts` =
departure_date = date. plan_snapshots (migration 0292 project_property_counts_v1)
splits the SAME population into `arrivals` (arrival_date = target) + `stayovers`
(arrival < target < departure, EXCLUDING arrivals). Therefore, to serve the model
at the SAME exposure definition it was trained on, tomorrow's stayover exposure =
plan_snapshots.stayovers + plan_snapshots.arrivals, and checkout exposure =
plan_snapshots.checkouts. The inference module implements exactly that mapping.

NO ML deps here (pandas is used only for timestamp parsing, matching the rest of
the trainer). Kept separate so the window/weight/exposure math is unit-testable.
"""
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd


def compose_exposure(sum_co: float, sum_so: float, kappa: float) -> float:
    """The single composite regressor x = ΣCO + κ·ΣSO."""
    return float(sum_co) + float(kappa) * float(sum_so)


def to_local_naive(ts: Any, timezone: Optional[str]) -> pd.Timestamp:
    """Parse a timestamp and express it in the property's LOCAL clock (naive).

    daily_logs.date is a property-local operational day, but counted_at /
    received_at / discarded_at are UTC timestamptz. Stripping tz without
    converting (the old behavior) put an evening count — 7pm Central is
    next-day UTC — on the WRONG operational day, shifting the whole window
    boundary by one day for evening-counting hotels.

    timezone=None (or an unknown zone) preserves the legacy UTC-naive
    behavior exactly, so callers without a timezone lose nothing.
    """
    t = pd.to_datetime(ts)
    if t.tzinfo is None:
        t = t.tz_localize("UTC")
    if timezone:
        try:
            t = t.tz_convert(timezone)
        except Exception:
            t = t.tz_convert("UTC")
    else:
        t = t.tz_convert("UTC")
    return t.tz_localize(None)


def row_weight(days: float, daily_process_var: float, count_noise: float) -> float:
    """w = 1 / (σ_d²·d + 2·τ²). Always finite and positive."""
    denom = float(daily_process_var) * max(float(days), 0.0) + 2.0 * float(count_noise)
    if denom <= 1e-12:
        denom = 1e-12
    return 1.0 / denom


def _daily_exposure_index(daily_logs: List[Dict[str, Any]]) -> Dict[Any, Tuple[Optional[float], Optional[float]]]:
    """Map operational date → (checkouts, stayovers) from daily_logs.

    A value is None when the column is NULL (feed still learning) — the caller
    treats a None inside a window as an incomplete window. Rows without a
    parseable date are skipped.
    """
    idx: Dict[Any, Tuple[Optional[float], Optional[float]]] = {}
    for log in daily_logs or []:
        ld = log.get("date")
        if not ld:
            continue
        try:
            d = pd.to_datetime(ld).date()
        except Exception:
            continue
        co = log.get("checkouts")
        so = log.get("stayovers")
        co_f = None if co is None else _to_float_or_none(co)
        so_f = None if so is None else _to_float_or_none(so)
        idx[d] = (co_f, so_f)
    return idx


def _to_float_or_none(v: Any) -> Optional[float]:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def window_exposure(
    daily_index: Dict[Any, Tuple[Optional[float], Optional[float]]],
    t_prev: pd.Timestamp,
    t_curr: pd.Timestamp,
) -> Optional[Tuple[float, float]]:
    """Sum checkouts + stayovers over the half-open day window (t_prev, t_curr].

    Uses the same disjoint half-open day rule as the occupancy-window helper so
    adjacent windows don't double-count a boundary day: days d with
    start_d < d <= end_d.

    Returns (ΣCO, ΣSO) when EVERY day in the window has non-NULL checkouts AND
    stayovers in daily_logs. Returns None (incomplete window → caller drops it)
    when any day is missing from daily_logs or has a NULL checkouts/stayovers.

    An empty span (start_d == end_d, i.e. sub-day window) returns None too —
    those are already dropped upstream by the < 1.0-day rule, but returning None
    here keeps this function honest if called directly.
    """
    start_d = t_prev.date()
    end_d = t_curr.date()
    if end_d <= start_d:
        return None

    sum_co = 0.0
    sum_so = 0.0
    # Iterate each operational day strictly after start_d, up to and including
    # end_d. Every such day MUST be present + non-NULL, else the window is
    # incomplete.
    day = start_d
    n_days = 0
    while True:
        day = day + pd.Timedelta(days=1).to_pytimedelta()
        if day > end_d:
            break
        n_days += 1
        entry = daily_index.get(day)
        if entry is None:
            return None
        co, so = entry
        if co is None or so is None:
            return None
        sum_co += co
        sum_so += so
    if n_days == 0:
        return None
    return (sum_co, sum_so)


def build_exposure_rows(
    counts: List[Dict[str, Any]],
    orders: List[Dict[str, Any]],
    discards: List[Dict[str, Any]],
    daily_logs: List[Dict[str, Any]],
    kappa: float,
    daily_process_var: float,
    count_noise: float,
    timezone: Optional[str] = None,
) -> Tuple[List[Dict[str, Any]], int]:
    """Build exposure training rows from consecutive count pairs.

    Mirrors the contamination filters of the occupancy trainer's
    `_build_training_rows` (sub-day drop, unexplained-increase drop, auto-stock-
    up zero drop, genuine-zero keep) but the FEATURE is the composite exposure
    x = ΣCO + κ·ΣSO and the TARGET is total window consumption (NOT a daily
    rate — the exposure already carries the time/volume information).

    Returns (rows, n_dropped_incomplete) where each row is:
        {
          "date": ISO date of the later count,
          "consumption": window consumption (units, >= 0),
          "exposure": ΣCO + κ·ΣSO,
          "sum_co": ΣCO, "sum_so": ΣSO,
          "days": window length in days,
          "weight": row weight,
        }
    and n_dropped_incomplete counts windows dropped SOLELY because daily_logs
    was incomplete over the window (so the caller can report it).
    """
    rows: List[Dict[str, Any]] = []
    n_dropped_incomplete = 0
    if len(counts) < 2:
        return (rows, n_dropped_incomplete)

    daily_index = _daily_exposure_index(daily_logs)

    for i in range(1, len(counts)):
        prev = counts[i - 1]
        curr = counts[i]
        try:
            # Property-local clock, so window day-boundaries line up with
            # daily_logs' operational days (see to_local_naive).
            t_prev = to_local_naive(prev["counted_at"], timezone)
            t_curr = to_local_naive(curr["counted_at"], timezone)
        except Exception:
            continue
        days_elapsed = (t_curr - t_prev).total_seconds() / 86400.0
        # Sub-day pairs (same-day recounts) — drop (mirror occupancy trainer).
        if days_elapsed < 1.0:
            continue

        orders_between = sum(
            float(o.get("quantity") or 0)
            for o in orders
            if _in_window(o.get("received_at"), t_prev, t_curr, timezone)
        )
        discards_between = sum(
            float(d.get("quantity") or 0)
            for d in discards
            if _in_window(d.get("discarded_at") or d.get("created_at"), t_prev, t_curr, timezone)
        )

        prev_stock = float(prev.get("counted_stock") or 0)
        curr_stock = float(curr.get("counted_stock") or 0)
        raw_consumption = prev_stock + orders_between - discards_between - curr_stock

        # Same contamination filters as the occupancy trainer:
        #   raw < 0  → unexplained increase (unlogged restock) → drop.
        #   raw == 0 AND count rose → auto-stock-up masking real usage → drop.
        #   raw == 0 AND count flat/down → genuine zero usage → KEEP.
        rose = curr_stock > prev_stock + 1e-9
        if raw_consumption < -1e-9 or (raw_consumption <= 1e-9 and rose):
            continue
        consumption = max(raw_consumption, 0.0)

        # Window completeness: exposure sums require non-NULL daily_logs for
        # every day in the window. Incomplete → drop + count.
        exposure_sums = window_exposure(daily_index, t_prev, t_curr)
        if exposure_sums is None:
            n_dropped_incomplete += 1
            continue
        sum_co, sum_so = exposure_sums
        exposure = compose_exposure(sum_co, sum_so, kappa)

        rows.append({
            "date": t_curr.date().isoformat(),
            "consumption": consumption,
            "exposure": exposure,
            "sum_co": sum_co,
            "sum_so": sum_so,
            "days": days_elapsed,
            "weight": row_weight(days_elapsed, daily_process_var, count_noise),
            # The count that CLOSED this window. prediction_log pairs carry
            # inventory_count_id, so this is the join key that lets the
            # graduation gate compute a per-pair baseline in daily-rate units
            # (prior_s · exposure/days) instead of the old unit-broken
            # prior_s-vs-daily-rate comparison.
            "count_id": str(curr.get("id")) if curr.get("id") else None,
        })
    return (rows, n_dropped_incomplete)


def _in_window(
    ts: Any, t_prev: pd.Timestamp, t_curr: pd.Timestamp, timezone: Optional[str] = None,
) -> bool:
    if ts is None:
        return False
    try:
        # Same clock as the window bounds — mixing UTC events into local
        # bounds would drop orders/discards near the boundary hours.
        t = to_local_naive(ts, timezone)
    except Exception:
        return False
    return bool(t > t_prev and t <= t_curr)
