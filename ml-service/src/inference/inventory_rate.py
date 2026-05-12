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


DEFAULT_PROPERTY_TIMEZONE = "America/Chicago"


def _tomorrow_in_property_tz(tz_name: str = DEFAULT_PROPERTY_TIMEZONE) -> date:
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

from src.config import get_settings
from src.supabase_client import get_supabase_client


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
        property_timezone: IANA timezone (e.g. "America/New_York"). When
            omitted the function falls back to the host's date — fine for
            single-property (Texas) deploys but wrong for east/west-coast
            hotels around midnight UTC.

    Returns:
        Summary: {predicted, skipped_no_active_model, errors}.
    """
    err = _validate_property_id(property_id)
    if err:
        return {"error": err, "predicted": 0}

    settings = get_settings()
    client = get_supabase_client()

    if target_date is None:
        target_date = _tomorrow_in_property_tz(
            property_timezone or DEFAULT_PROPERTY_TIMEZONE
        )
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

    # Pull occupancy forecast / current avg for the feature
    daily_logs = client.fetch_many(
        "daily_logs",
        filters={"property_id": property_id},
        order_by="date",  # daily_logs.date (was incorrectly "log_date" — fixed in Tier 2 triple-check)
        descending=True,
        limit=14,
    )
    occ_pct = _recent_avg_occupancy(daily_logs)

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


def _recent_avg_occupancy(daily_logs: List[Dict[str, Any]]) -> float:
    if not daily_logs:
        return 50.0
    vals: List[float] = []
    for log in daily_logs:
        v = log.get("occupancy_pct")
        if v is not None:
            try:
                vals.append(float(v))
            except (ValueError, TypeError):
                continue
    return sum(vals) / len(vals) if vals else 50.0


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

    # Compute predicted_current_stock for auto-fill
    item = client.fetch_one("inventory", filters={"id": item_id})
    item_name = (item or {}).get("name", "")
    predicted_current_stock = _compute_predicted_current_stock(
        property_id=property_id,
        item_id=item_id,
        daily_rate=daily_rate,
        client=client,
    )

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
        "predicted_at": datetime.utcnow().isoformat(),
    })
    return {"predicted": True}


def _predict_bayesian_quantiles(params: Dict[str, Any], occ_pct: float) -> Dict[str, float]:
    """Compute t-distribution quantiles from a serialized Bayesian posterior."""
    mu_n = np.array(params["mu_n"])
    sigma_n = np.array(params["sigma_n"])
    alpha_n = float(params["alpha_n"])
    beta_n = float(params["beta_n"])

    # Feature vector: [intercept, occupancy_pct]
    x = np.array([1.0, occ_pct])
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
                         * (occ_pct / 50.0)   # 50% occupancy is the cohort baseline
    Uncertainty band: ±50% around p50 for p10/p90 (vs the trained model's
    posterior which typically converges to <±20% once mature). The band is
    deliberately wide — auto-fill won't fire for cold-start models anyway
    (`auto_fill_enabled` stays false until the real fit lands), and the
    cockpit's confidence chip can warn Maria that this is a placeholder.
    """
    prior_rate = float(params.get("cohort_prior_rate", 0.0))
    room_count = int(params.get("room_count", 60))
    base = max(prior_rate * room_count, 0.0)
    occ_factor = max(occ_pct, 0.0) / 50.0   # 50% = cohort baseline
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
    last_at_iso = last_at.isoformat()
    try:
        orders_resp = client.client.table("inventory_orders")\
            .select("quantity")\
            .eq("property_id", property_id).eq("item_id", item_id)\
            .gt("ordered_at", last_at_iso).execute()
        orders_sum = sum(float(r.get("quantity") or 0) for r in (orders_resp.data or []))
    except Exception:
        orders_sum = 0.0
    try:
        discards_resp = client.client.table("inventory_discards")\
            .select("quantity")\
            .eq("property_id", property_id).eq("item_id", item_id)\
            .gt("created_at", last_at_iso).execute()
        discards_sum = sum(float(r.get("quantity") or 0) for r in (discards_resp.data or []))
    except Exception:
        discards_sum = 0.0

    predicted = last_stock + orders_sum - discards_sum - daily_rate * days_since
    return max(predicted, 0.0)
