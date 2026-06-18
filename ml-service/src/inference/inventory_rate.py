"""Inference pipeline for the inventory_rate ML layer.

For every (property × item) with an active model_runs row, predict tomorrow's
daily usage rate AND today's predicted_current_stock (the value that will
auto-fill into Count Mode if the item has graduated). Writes one row per
(property, item) per nightly run to `inventory_rate_predictions`.

Designed to be idempotent — a re-run on the same day overwrites the
existing row for that date via insert + delete-stale (we don't UPSERT
because we want each prediction tagged with its own model_run_id and
predicted_at timestamp for auditability).
"""
import json
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional


# Phase 3.5 (2026-05-13): America/Chicago default removed — caller must
# pass the property's timezone; see inference/demand.py for context.


def _tomorrow_in_property_tz(tz_name: str) -> date:
    """Property-local tomorrow (matches demand/supply/optimizer)."""
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(tz_name)
    except Exception:  # pragma: no cover
        tz = timezone(timedelta(hours=-6))
    now_local = datetime.now(timezone.utc).astimezone(tz)
    return (now_local + timedelta(days=1)).date()

import numpy as np
import pandas as pd
from scipy import stats

from src.config import (
    INVENTORY_FEATURE_SET_VERSION,
    INVENTORY_OCC_BASELINE_PCT,
    get_settings,
)
from src.errors import PropertyMisconfiguredError, require_property_timezone
from src.supabase_client import get_supabase_client


def _is_finite_nonneg(v: Any) -> bool:
    """True iff v is a real, finite, non-negative number (not NaN / inf)."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return False
    return bool(np.isfinite(f) and f >= 0.0)


def _validate_property_id(property_id: str) -> Optional[str]:
    try:
        uuid.UUID(str(property_id))
        return None
    except (ValueError, AttributeError, TypeError):
        return f"Invalid property_id: not a UUID ({property_id!r})"


async def predict_inventory_rates(
    property_id: str,
    target_date: Optional[date] = None,
    property_timezone: Optional[str] = None,
) -> Dict[str, Any]:
    """Generate inventory_rate predictions for every active model.

    Args:
        property_id: Property UUID.
        target_date: The operational date these predictions are FOR. Defaults
            to tomorrow in the property's local timezone.
        property_timezone: IANA timezone (e.g. "America/New_York"). REQUIRED
            when target_date is None — Phase 3.5 dropped the
            America/Chicago fallback; missing timezone raises
            PropertyMisconfiguredError which the cron logs + skips.

    Returns:
        Summary: {predicted, skipped_no_active_model, errors}.
    """
    err = _validate_property_id(property_id)
    if err:
        return {"error": err, "predicted": 0}

    settings = get_settings()
    client = get_supabase_client()

    if target_date is None:
        # Phase 3.5: require timezone — log + skip if missing.
        try:
            tz_name = require_property_timezone(property_timezone, property_id)
        except PropertyMisconfiguredError as exc:
            print(json.dumps({
                "evt": "property_misconfigured",
                "layer": "inventory_rate",
                "property_id": exc.property_id,
                "field": exc.field,
                "value": exc.printable_value,
            }))
            return {
                "predicted": 0,
                "skipped_no_active_model": 0,
                "errors": [],
                "error": f"property_misconfigured: {exc.field}={exc.printable_value}",
            }
        target_date = _tomorrow_in_property_tz(tz_name)
    target_date_iso = target_date.isoformat()

    # Find every active inventory_rate model_runs row for this property
    active_runs = client.fetch_many(
        "model_runs",
        filters={"property_id": property_id, "layer": "inventory_rate", "is_active": True},
        limit=1000,
    )
    if not active_runs:
        return {
            "predicted": 0,
            "skipped_no_active_model": 0,
            "errors": [],
            "note": "no active inventory_rate models for this property",
        }

    # Codex post-merge review 2026-05-13 (C-2 + C-3): use tomorrow's
    # projected occupancy from the PMS plan snapshot, NOT the historic
    # 14-day mean. The Bayesian model was trained as
    # `daily_rate = a + b × occupancy_pct` so serving it the historic mean
    # at inference time queries the model at the wrong x. On peak weekends
    # the predicted daily rate was 30-40% too low, days_until_out was
    # 2-3× over-stated, and reorders fired late.
    #
    # Same data source the housekeeping optimizer reads for "tomorrow's
    # workload" — identical staleness profile + trust boundary.
    plan_snap = client.fetch_one(
        "plan_snapshots",
        filters={"property_id": property_id, "date": target_date_iso},
    )
    occ_pct = _occupancy_for_target_date(plan_snap)
    if occ_pct is None:
        # Fall back to historic mean for cold-start hotels (no PMS
        # snapshot yet) or PMS-outage days. Log the fallback so the
        # doctor can flag it if it becomes routine.
        print(json.dumps({
            "evt": "occupancy_source_fallback",
            "property_id": property_id,
            "target_date": target_date_iso,
            "reason": "no_plan_snapshot",
        }))
        daily_logs = client.fetch_many(
            "daily_logs",
            filters={"property_id": property_id},
            order_by="date",
            descending=True,
            limit=14,
        )
        # daily_logs stores a raw `occupied` room count, so we need the
        # property's room count to convert it to an occupancy %.
        prop_row = client.fetch_one("properties", filters={"id": property_id})
        total_rooms = (prop_row or {}).get("total_rooms")
        occ_pct = _recent_avg_occupancy(daily_logs, total_rooms)

    predicted = 0
    skipped_no_active = 0
    errors: List[str] = []

    for run in active_runs:
        try:
            item_id = run.get("item_id")
            if not item_id:
                skipped_no_active += 1
                continue
            result = _predict_single_item(
                run=run,
                property_id=property_id,
                item_id=item_id,
                target_date_iso=target_date_iso,
                occ_pct=occ_pct,
                client=client,
            )
            if result.get("predicted"):
                predicted += 1
        except Exception as exc:
            errors.append(f"item {run.get('item_id')}: {exc}")
            print(json.dumps({
                "evt": "inventory_predict_item_failed",
                "property_id": property_id,
                "item_id": run.get("item_id"),
                "error": str(exc),
            }))

    return {
        "predicted": predicted,
        "skipped_no_active_model": skipped_no_active,
        "errors": errors,
        "target_date": target_date_iso,
    }


def _recent_avg_occupancy(daily_logs: List[Dict[str, Any]], total_rooms: Optional[int]) -> float:
    """Recent mean occupancy % from daily_logs.

    daily_logs has no occupancy_pct column — only a raw `occupied` count — so
    occupancy is derived as 100·occupied/total_rooms (must match the trainer's
    `_avg_occupancy_in_window`). Returns the centering BASELINE
    (INVENTORY_OCC_BASELINE_PCT), not 50, when there are no logs or total_rooms
    is unusable — so an unknown-occupancy day centers to 0 at serve time exactly
    as it does at train time. This is the cold-start / PMS-outage fallback; the
    primary path is tomorrow's projected occupancy from plan_snapshots.
    """
    if not daily_logs:
        return INVENTORY_OCC_BASELINE_PCT
    try:
        denom = float(int(total_rooms or 0))
    except (ValueError, TypeError):
        denom = 0.0
    vals: List[float] = []
    for log in daily_logs:
        pct = log.get("occupancy_pct")
        if pct is None:
            occ = log.get("occupied")
            if occ is None or denom <= 0:
                # No usable room count → can't convert occupied → %; skip row.
                continue
            try:
                pct = 100.0 * float(occ) / denom
            except (ValueError, TypeError):
                continue
        try:
            vals.append(max(0.0, min(100.0, float(pct))))
        except (ValueError, TypeError):
            continue
    return sum(vals) / len(vals) if vals else INVENTORY_OCC_BASELINE_PCT


def _occupancy_for_target_date(plan: Optional[Dict[str, Any]]) -> Optional[float]:
    """Occupancy % for the target date, derived from a plan_snapshots row.

    Codex post-merge review 2026-05-13 (C-2 + C-3): the Bayesian inventory
    model learns `daily_rate = a + b × occupancy_pct`. Serving the model
    the rolling 14-day historic mean at inference time queries the wrong
    x for tomorrow's prediction. Pulling from plan_snapshots gives us the
    PMS-projected occupancy for the same date the prediction is FOR.

    Returns None when the snapshot is missing or unusable (cold-start
    hotels, PMS-outage days). Caller falls back to the historic mean
    and logs the fallback so we can monitor it.
    """
    if not plan:
        return None
    try:
        total = int(plan.get("total_rooms") or 0)
        if total <= 0:
            return None
        stayovers = int(plan.get("stayovers") or 0)
        arrivals = int(plan.get("arrivals") or 0)
        return max(0.0, min(100.0, 100.0 * (stayovers + arrivals) / total))
    except (TypeError, ValueError):
        return None


def _predict_single_item(
    run: Dict[str, Any],
    property_id: str,
    item_id: str,
    target_date_iso: str,
    occ_pct: float,
    client,
) -> Dict[str, Any]:
    """Predict daily rate + current stock for one (property, item)."""
    algorithm = run.get("algorithm", "bayesian")
    posterior_params_json = run.get("posterior_params")

    if algorithm == "bayesian" and posterior_params_json:
        # Refuse to serve a posterior trained before occupancy became a
        # CENTERED feature: its coefficients live in raw-occupancy space, so
        # feeding them the centered vector [1, occ-baseline] would bias every
        # prediction. Skip → the model gets retrained into the current feature
        # set rather than served wrong. (Cold-start cohort runs don't use the
        # posterior, so they're exempt.)
        if run.get("feature_set_version") != INVENTORY_FEATURE_SET_VERSION:
            print(json.dumps({
                "evt": "inventory_predict_stale_feature_set_skipped",
                "item_id": item_id,
                "feature_set_version": run.get("feature_set_version"),
                "expected": INVENTORY_FEATURE_SET_VERSION,
            }))
            return {"predicted": False, "reason": "stale_feature_set"}
        # Rebuild posterior in-memory and predict
        try:
            params = json.loads(posterior_params_json) if isinstance(posterior_params_json, str) else posterior_params_json
            quantiles = _predict_bayesian_quantiles(params, occ_pct)
        except Exception as exc:
            print(json.dumps({
                "evt": "bayesian_rebuild_failed",
                "item_id": item_id,
                "error": str(exc),
            }))
            return {"predicted": False}
    elif algorithm == "cold-start-cohort-prior" and posterior_params_json:
        # Cold-start hotels: derive a daily rate directly from the cohort
        # prior (no posterior to rebuild). Tier 2 Phase 4 — gives Maria a
        # useful Day-1 prediction instead of an empty box, even before
        # the Bayesian fit becomes possible.
        try:
            params = json.loads(posterior_params_json) if isinstance(posterior_params_json, str) else posterior_params_json
            quantiles = _predict_from_cohort_prior(params, occ_pct)
        except Exception as exc:
            print(json.dumps({
                "evt": "cold_start_rebuild_failed",
                "item_id": item_id,
                "error": str(exc),
            }))
            return {"predicted": False}
    else:
        # XGBoost path: would load the model artifact from storage. v1 not implemented;
        # falls back to the run's training_mae as p50 and ±2*MAE as p10/p90.
        # When XGBoost activates at 100+ events we'll wire this up in session 3.
        return {"predicted": False, "reason": "xgboost_inference_not_implemented_in_v1"}

    daily_rate = float(quantiles["p50"])

    # Robustness gate: never let a NaN / inf / negative reach the NOT NULL
    # numeric prediction columns. A degenerate posterior (near-singular
    # covariance, bad serialized params) can produce NaN quantiles —
    # `max(nan, 0.0)` returns nan in Python, so the existing non-negative clip
    # does NOT catch them. Writing one would either fail the insert or poison
    # every downstream days-left / reorder calc with NaN. Skip + log instead.
    quantile_values = [quantiles.get(k) for k in ("p10", "p25", "p50", "p75", "p90")]
    if not all(_is_finite_nonneg(v) for v in [daily_rate, *quantile_values]):
        print(json.dumps({
            "evt": "inventory_predict_nonfinite_skipped",
            "property_id": property_id,
            "item_id": item_id,
            "algorithm": algorithm,
            "p50": str(quantiles.get("p50")),
        }))
        return {"predicted": False, "reason": "non_finite_prediction"}

    # A COLD-START cohort prediction of exactly 0/day means the occupancy input
    # was 0 (a closed / zero-occupancy target date: _occupancy_for_target_date
    # returns 0.0, not None, when stayovers+arrivals=0). An all-zero rate isn't
    # actionable and the card vs reorder-panel consumers disagree on what a 0 ML
    # rate means — so don't write it. Scoped to cold-start ONLY: a FITTED
    # Bayesian model can legitimately predict ~0 for a genuinely-unused item, and
    # dropping those would lose real signal.
    if algorithm == "cold-start-cohort-prior" and daily_rate <= 0.0:
        print(json.dumps({
            "evt": "inventory_predict_zero_cohort_skipped",
            "property_id": property_id,
            "item_id": item_id,
        }))
        return {"predicted": False, "reason": "zero_occupancy_cohort"}

    # Compute predicted_current_stock for auto-fill
    item = client.fetch_one("inventory", filters={"id": item_id})
    item_name = (item or {}).get("name", "")
    predicted_current_stock = _compute_predicted_current_stock(
        property_id=property_id,
        item_id=item_id,
        daily_rate=daily_rate,
        client=client,
    )
    # _compute_predicted_current_stock already clamps to >= 0, but if a
    # non-finite anchor stock ever leaks in, write SQL NULL ("no estimate")
    # rather than 0.0 — a 0 here reads downstream as "you have nothing, reorder
    # now" / auto-fills 0 into the count input, laundering a data-quality
    # failure into a confident-but-wrong signal. NULL makes the cockpit drop the
    # item from auto-fill (manager counts it manually). The finite daily_rate +
    # quantiles are still written, so the rate prediction is preserved.
    if not _is_finite_nonneg(predicted_current_stock):
        print(json.dumps({
            "evt": "inventory_stock_anchor_nonfinite",
            "property_id": property_id,
            "item_id": item_id,
        }))
        predicted_current_stock = None

    # Delete any earlier prediction we made for this exact (property, item, target_date)
    # so the cockpit shows the freshest one. Best-effort.
    try:
        client.client.table("inventory_rate_predictions")\
            .delete()\
            .eq("property_id", property_id)\
            .eq("item_id", item_id)\
            .eq("predicted_for_date", target_date_iso)\
            .execute()
    except Exception:
        pass

    client.insert("inventory_rate_predictions", {
        "property_id": property_id,
        "item_id": item_id,
        "item_name": item_name,
        "predicted_for_date": target_date_iso,
        "predicted_daily_rate": daily_rate,
        "predicted_daily_rate_p10": float(quantiles["p10"]),
        "predicted_daily_rate_p25": float(quantiles["p25"]),
        "predicted_daily_rate_p50": daily_rate,
        "predicted_daily_rate_p75": float(quantiles["p75"]),
        "predicted_daily_rate_p90": float(quantiles["p90"]),
        "predicted_current_stock": predicted_current_stock,
        "model_run_id": run["id"],
        # Tag the prediction with its model's shadow state. Active runs are
        # never shadow today (is_active ⊥ is_shadow), so this is always false —
        # but making it explicit keeps the consumer-side is_shadow=false filter
        # load-bearing-by-design rather than by accident, so a future change
        # that serves shadow runs can't silently leak them to the reorder list.
        "is_shadow": bool(run.get("is_shadow", False)),
        "predicted_at": datetime.utcnow().isoformat(),
    })
    return {"predicted": True}


def _predict_bayesian_quantiles(params: Dict[str, Any], occ_pct: float) -> Dict[str, float]:
    """Compute t-distribution quantiles from a serialized Bayesian posterior."""
    mu_n = np.array(params["mu_n"])
    sigma_n = np.array(params["sigma_n"])
    alpha_n = float(params["alpha_n"])
    beta_n = float(params["beta_n"])

    # Feature vector: [intercept, occupancy_pct − baseline]. The trainer
    # centers occupancy on INVENTORY_OCC_BASELINE_PCT before fitting, so the
    # posterior coefficients live in centered space; serve at the same center
    # or every prediction is biased by slope·baseline.
    x = np.array([1.0, occ_pct - INVENTORY_OCC_BASELINE_PCT])
    # ── Strict shape match (May 2026 audit pass-4) ─────────────────────
    # Previously: silently pad with zeros or truncate. Pad is dangerous
    # — adding a third feature to training (e.g. day_of_week) would
    # leave the inference vector as [1.0, occ, 0.0] forever, with the
    # third coefficient multiplied by 0 every prediction. Predictions
    # are numerically valid but semantically wrong: the feature the
    # model learned to use is permanently zeroed at serve time.
    # Truncation has the symmetric problem (drops new features).
    # Fail loud so the predict cron's anyError accumulator surfaces it
    # in the doctor — much better than silently bad predictions.
    if mu_n.shape[0] != x.shape[0]:
        raise ValueError(
            f"Bayesian feature shape mismatch: model posterior has "
            f"{mu_n.shape[0]} dims, inference built {x.shape[0]} dims. "
            f"This means features were added or removed between training "
            f"and now. Retrain the model, or update the inference feature "
            f"vector to match the model's training schema."
        )

    pred_mean = float(x @ mu_n)
    pred_var = (beta_n / alpha_n) * (1 + x @ sigma_n @ x)
    pred_std = float(np.sqrt(max(pred_var, 1e-9)))
    nu = 2 * alpha_n

    out: Dict[str, float] = {}
    for label, q in (("p10", 0.10), ("p25", 0.25), ("p50", 0.50), ("p75", 0.75), ("p90", 0.90)):
        t_q = stats.t.ppf(q, df=nu)
        out[label] = max(pred_mean + pred_std * t_q, 0.0)  # Clip non-negative
    return out


def _predict_from_cohort_prior(params: Dict[str, Any], occ_pct: float) -> Dict[str, float]:
    """Quantiles for a cold-start (Day-1) model that has no count history.

    No posterior to sample from — just the cohort/global prior rate scaled to
    the property's room count and adjusted for occupancy. We surface this as
    p50 with a wide uncertainty band so the cockpit / autofill can clearly
    show "this is a network estimate, not your own data."

    Math:
        rate_hotel_today = prior_rate_per_room_per_day
                         * room_count
                         * (occ_pct / baseline)   # baseline = cohort reference occ

    APPROXIMATIONS (intentional — don't "fix" without reading):
    1. Occupancy reference. inventory_priors.py produces prior_rate as the
       median per-room rate over the contributing hotels' windows AT THEIR
       ACTUAL occupancy — it is NOT per-window normalized to the baseline. Here
       we consume it as if it were the rate at baseline occupancy. For the
       limited-service target market (typical occupancy ≈ 60%) the error is
       small; it grows for cohorts running well off 60%. The faithful fix
       (normalize each window's rate by occ/baseline in the producer SQL) is
       staged in STAGED_INVENTORY_MIGRATIONS.md as a follow-up — it needs
       daily_logs occupancy data flowing and can't be validated without a DB.
    2. Shape. This cold-start response is purely PROPORTIONAL through the origin
       (usage → 0 at 0% occupancy), whereas the fitted Bayesian path is AFFINE
       (intercept + slope·(occ−baseline), non-zero baseline usage). So an item's
       days-left can visibly SHIFT when it graduates from this placeholder to a
       fitted model — that is expected (placeholder → real data), not a bug.

    The baseline is the shared INVENTORY_OCC_BASELINE_PCT the trainer/inference
    Bayesian path centers on (was a hard-coded 50.0).

    Uncertainty band: ±50% around p50 for p10/p90 (vs the trained model's
    posterior which typically converges to <±20% once mature). The band is
    deliberately wide — auto-fill won't fire for cold-start models anyway
    (`auto_fill_enabled` stays false until the real fit lands), and the
    cockpit's confidence chip can warn Maria that this is a placeholder.
    """
    prior_rate = float(params.get("cohort_prior_rate", 0.0))
    room_count = int(params.get("room_count", 60))
    base = max(prior_rate * room_count, 0.0)
    occ_factor = max(occ_pct, 0.0) / INVENTORY_OCC_BASELINE_PCT   # cohort baseline
    p50 = base * occ_factor
    spread = p50 * 0.5
    return {
        "p10": max(p50 - spread,        0.0),
        "p25": max(p50 - spread * 0.6,  0.0),
        "p50": max(p50,                  0.0),
        "p75": max(p50 + spread * 0.6,  0.0),
        "p90": max(p50 + spread,        0.0),
    }


def _compute_predicted_current_stock(
    property_id: str,
    item_id: str,
    daily_rate: float,
    client,
) -> float:
    """predicted_current_stock = last_counted + orders_since − discards_since − rate × days_since.

    Returns 0.0 if no prior count exists (the model has nothing to anchor to).
    """
    last_count_rows = client.fetch_many(
        "inventory_counts",
        filters={"property_id": property_id, "item_id": item_id},
        order_by="counted_at",
        descending=True,
        limit=1,
    )
    if not last_count_rows:
        return 0.0
    last = last_count_rows[0]
    last_stock = float(last.get("counted_stock") or 0)
    last_at = pd.to_datetime(last.get("counted_at"))
    if pd.isna(last_at):
        return last_stock

    last_at = last_at.tz_localize(None) if last_at.tzinfo else last_at
    now = pd.Timestamp.utcnow().tz_localize(None) if pd.Timestamp.utcnow().tzinfo else pd.Timestamp.utcnow()
    days_since = max((now - last_at).total_seconds() / 86400.0, 0.0)

    # Sum orders + discards between last count and now
    #
    # Codex post-merge review 2026-05-13:
    #   C-1: switched orders filter from `ordered_at` (nullable — "PO placed
    #        time, often unknown") to `received_at` (NOT NULL DEFAULT now()
    #        per migration 0026:96). The training path was fixed at
    #        training/inventory_rate.py:657 (N1); this inference path was
    #        missed. Auto-fill predicted_current_stock was silently
    #        under-counting every order with no recorded ordered_at —
    #        biasing Maria toward over-counting / over-ordering.
    #   2.1: switched discards filter from `created_at` to `discarded_at`
    #        for consistency with view 0096 + trainer + cohort SQL. Both
    #        columns are NOT NULL DEFAULT now() so the change is
    #        semantically safe today, but matters the moment someone
    #        backdates a discard.
    last_at_iso = last_at.isoformat()
    try:
        orders_resp = client.client.table("inventory_orders")\
            .select("quantity")\
            .eq("property_id", property_id).eq("item_id", item_id)\
            .gt("received_at", last_at_iso).execute()
        orders_sum = sum(float(r.get("quantity") or 0) for r in (orders_resp.data or []))
    except Exception:
        orders_sum = 0.0
    try:
        discards_resp = client.client.table("inventory_discards")\
            .select("quantity")\
            .eq("property_id", property_id).eq("item_id", item_id)\
            .gt("discarded_at", last_at_iso).execute()
        discards_sum = sum(float(r.get("quantity") or 0) for r in (discards_resp.data or []))
    except Exception:
        discards_sum = 0.0

    predicted = last_stock + orders_sum - discards_sum - daily_rate * days_since
    return max(predicted, 0.0)
