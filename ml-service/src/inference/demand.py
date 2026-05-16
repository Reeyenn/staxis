"""Inference pipeline for Layer 1 Demand predictions."""
import json
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Optional

import numpy as np
import pandas as pd

from src.config import get_settings
from src.errors import PropertyMisconfiguredError, require_property_timezone
from src.supabase_client import get_supabase_client, safe_uuid, safe_iso_date


# Phase 3.5 (2026-05-13): the `DEFAULT_PROPERTY_TIMEZONE = "America/Chicago"`
# fallback was Beaumont-shaped and silently rolled "tomorrow" at the
# wrong UTC hour for any property east or west of Texas. Callers must
# now pass `properties.timezone`. If missing, the validation helper
# raises PropertyMisconfiguredError which the cron boundary catches +
# logs as a skipped property.
PROPERTY_TZ_OFFSET_HOURS = -6  # used only as a defensive zoneinfo fallback.


def _tomorrow_in_property_tz(tz_name: str) -> date:
    """Return the property's local 'tomorrow' as a date.

    Computing this in UTC silently rolls past the date boundary in the
    wrong place across the 18:00–06:00 UTC window — for a Texas property
    that means "tomorrow" flips at 6pm local instead of midnight. Use
    Intl-equivalent zoneinfo lookup to bucket correctly.
    """
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(tz_name)
    except Exception:  # pragma: no cover — zoneinfo is stdlib on 3.9+
        # Fall back to a fixed-offset CST. Slightly wrong during DST half
        # the year, but better than UTC.
        tz = timezone(timedelta(hours=PROPERTY_TZ_OFFSET_HOURS))
    now_local = datetime.now(timezone.utc).astimezone(tz)
    return (now_local + timedelta(days=1)).date()


def _validate_property_id(property_id: str) -> Optional[str]:
    """Reject any property_id that is not a well-formed UUID."""
    try:
        uuid.UUID(str(property_id))
        return None
    except (ValueError, AttributeError, TypeError):
        return f"Invalid property_id: not a UUID ({property_id!r})"


async def predict_demand(
    property_id: str,
    prediction_date: Optional[date] = None,
    property_timezone: Optional[str] = None,
) -> dict:
    """Predict total workload (demand) for a property on a given date.

    Args:
        property_id: Property UUID
        prediction_date: Date to predict for (defaults to tomorrow in property TZ)
        property_timezone: IANA timezone (e.g. "America/New_York"). REQUIRED
            when prediction_date is None — Phase 3.5 (2026-05-13) dropped
            the America/Chicago fallback; missing timezone raises
            PropertyMisconfiguredError which the cron logs + skips.

    Returns:
        Dictionary with predictions
    """
    err = _validate_property_id(property_id)
    if err:
        return {"error": err, "property_id": property_id, "date": None}

    settings = get_settings()
    client = get_supabase_client()

    if prediction_date is None:
        # Phase 3.5: require timezone when we have to compute "tomorrow"
        # ourselves. PropertyMisconfiguredError → log + structured error
        # so the TS cron skips this property without crashing the batch.
        try:
            tz_name = require_property_timezone(property_timezone, property_id)
        except PropertyMisconfiguredError as exc:
            print(json.dumps({
                "evt": "property_misconfigured",
                "layer": "demand",
                "property_id": exc.property_id,
                "field": exc.field,
                "value": exc.printable_value,
            }))
            return {
                "error": f"property_misconfigured: {exc.field}={exc.printable_value}",
                "property_id": property_id,
                "date": None,
            }
        prediction_date = _tomorrow_in_property_tz(tz_name)

    # Find active demand model
    active_models = client.fetch_many(
        "model_runs",
        filters={"property_id": property_id, "layer": "demand", "is_active": True},
        limit=1,
    )

    if not active_models:
        return {
            "error": "No active demand model",
            "property_id": property_id,
            "date": str(prediction_date),
        }

    model_run = active_models[0]
    model_run_id = model_run["id"]

    # Fetch plan for prediction_date.
    # plan_snapshots is one row per (property, date) with already-aggregated
    # counts (the scraper sums by room_state and writes the totals). The
    # earlier query referenced a column "room_status" that does not exist on
    # this table — every inference call would have failed at the SQL layer.
    # Read the pre-aggregated columns directly. Take the freshest pull if
    # multiple rows exist for the same date.
    plan_query = f"""
        select
            coalesce(checkouts, 0) as checkouts,
            coalesce(stayover_day1, 0) as stayover_day_1_count,
            coalesce(stayover_day2, 0) + coalesce(stayover_arrival_day, 0) + coalesce(stayover_unknown, 0) as stayover_day_2plus_count,
            coalesce(vacant_dirty, 0) as vacant_dirty_count,
            coalesce(total_rooms, 0) as total_count,
            coalesce(total_rooms, 0) - coalesce(vacant_clean, 0) - coalesce(vacant_dirty, 0) - coalesce(ooo, 0) as occupied_count,
            extract(dow from date)::int as dow,
            coalesce(total_cleaning_minutes, 0) as scraper_cleaning_minutes
        from plan_snapshots
        where property_id = '{safe_uuid(property_id)}'
          and date = '{safe_iso_date(prediction_date)}'::date
        order by pulled_at desc
        limit 1
    """

    try:
        plan_data = client.execute_sql(plan_query)
        if not plan_data:
            return {
                "error": "No plan snapshot for prediction date",
                "property_id": property_id,
                "date": str(prediction_date),
            }
        plan = plan_data[0]
    except Exception as e:
        return {
            "error": f"Failed to fetch plan: {e}",
            "property_id": property_id,
            "date": str(prediction_date),
        }

    # Compute real occupancy_pct from plan snapshot
    occupied_count = plan.get("occupied_count", 0) or 0
    total_count = plan.get("total_count", 1) or 1
    occupancy_pct = float(occupied_count) / max(total_count, 1) * 100.0
    if occupancy_pct < 0 or occupancy_pct > 100:
        occupancy_pct = 50.0  # Fallback if something is wrong

    # Build features matching the training column order exactly. The training
    # query in src/training/demand.py produces these column names; we mirror
    # them here so the saved posterior aligns with X at inference time.
    features_dict = {
        "intercept": 1.0,
        "total_checkouts": float(plan.get("checkouts", 0) or 0),
        "stayover_day_1_count": float(plan.get("stayover_day_1_count", 0) or 0),
        "stayover_day_2plus_count": float(plan.get("stayover_day_2plus_count", 0) or 0),
        "vacant_dirty_count": float(plan.get("vacant_dirty_count", 0) or 0),
        "occupancy_pct": round(occupancy_pct, 2),
        "day_of_week": int(plan.get("dow", 3) or 3),
    }

    feature_cols = [
        "intercept",
        "total_checkouts",
        "stayover_day_1_count",
        "stayover_day_2plus_count",
        "vacant_dirty_count",
        "occupancy_pct",
        "day_of_week",
    ]
    X = pd.DataFrame([features_dict])[feature_cols]

    # Load and run model based on algorithm
    algorithm = model_run.get("algorithm", "bayesian")
    # Codex post-merge review 2026-05-13 (Phase 2.4): added 0.8 so we can
    # write `predicted_headcount_p80` for the Schedule tab consumer that
    # was silently getting null. The training-side Bayesian/XGBoost
    # quantile models can be evaluated at any q in (0, 1); 0.8 was simply
    # missing from this list.
    quantiles = [0.1, 0.25, 0.5, 0.75, 0.8, 0.9, 0.95]
    predictions = None

    # Phase M3 (2026-05-14) — cold-start cohort-prior path. Active when a
    # new hotel hasn't accumulated 14+ days of training data yet. Reads
    # the prior_minutes_per_room_per_day from posterior_params (set by
    # _cold_start.install_cold_start) and produces a wide-band prediction.
    if algorithm == "cold-start-cohort-prior":
        try:
            posterior = model_run.get("posterior_params") or {}
            if isinstance(posterior, str):
                posterior = json.loads(posterior)
            prior_per_room = float(posterior.get("prior_minutes_per_room_per_day", 20.0))
        except Exception as exc:
            print(json.dumps({
                "evt": "demand_cold_start_inference_payload_bad",
                "model_run_id": model_run_id,
                "error": str(exc)[:200],
            }))
            prior_per_room = 20.0  # industry-default fallback

        # Phase M3.1 (2026-05-14): use the plan snapshot's total_count
        # column (already loaded above from the plan_snapshots SQL query
        # at line 128 — `coalesce(total_rooms, 0) as total_count`). The
        # original M3 code referenced `property_meta` which was never
        # fetched in this function — first cold-start invocation crashed
        # with NameError. Caught by test_demand_inference_cold_start.py.
        total_rooms = plan.get("total_count") or 0
        # Mean prediction = prior × room count. Cohort priors are
        # already empirically averaged across many days with varied
        # occupancy, so we don't try to scale by today's occupancy
        # pct (would double-count the prior's embedded average).
        mu = float(prior_per_room) * float(total_rooms)
        # Wide quantile bands reflect cold-start uncertainty. The
        # posterior tightens these as soon as a real Bayesian fit
        # replaces this row (next training run with ≥14 days of data).
        predictions = {
            0.1:  np.array([mu * 0.5]),
            0.25: np.array([mu * 0.7]),
            0.5:  np.array([mu]),
            0.75: np.array([mu * 1.3]),
            0.8:  np.array([mu * 1.4]),
            0.9:  np.array([mu * 1.6]),
            0.95: np.array([mu * 1.8]),
        }

    elif algorithm == "bayesian":
        from src.layers.bayesian_regression import BayesianRegression

        model = BayesianRegression()

        # Load posterior params if available, else fall back to prior.
        # Phase M3.3 (2026-05-14) — supabase JSONB columns deserialize to
        # dicts in supabase-py, NOT JSON strings; json.loads() on a dict
        # threw TypeError → except below silently fell back to prior →
        # every Bayesian-active demand property invisibly served cold-start
        # prior predictions instead of its trained posterior.
        #
        # Phase M3.4 (2026-05-14) — Codex adversarial finding #2: a partial
        # corruption (mu_n missing but other fields present) had the SAME
        # silent-prior-fallback failure mode. BayesianRegression.predict_quantile
        # re-initializes the prior when mu_n is None and serves prior
        # predictions. Hard-validate required fields BEFORE constructing
        # the posterior and return an explicit error if any are missing —
        # operator must see "retrain needed" instead of plausible-looking
        # prior numbers from an "active Bayesian" model.
        posterior_params_raw = model_run.get("posterior_params")
        if posterior_params_raw:
            try:
                posterior_params = (
                    json.loads(posterior_params_raw)
                    if isinstance(posterior_params_raw, str)
                    else posterior_params_raw
                )
            except Exception as exc:
                print(json.dumps({
                    "evt": "demand_posterior_json_invalid",
                    "model_run_id": model_run_id,
                    "error": str(exc),
                }))
                return {
                    "error": "Active demand model has unparseable posterior_params (retrain needed)",
                    "property_id": property_id,
                    "date": str(prediction_date),
                    "model_version": model_run.get("model_version"),
                }

            # Hard-validate the 5 required fields. mu_0/sigma_0/alpha/beta
            # are PRE-FIT priors (used by _initialize_prior before fit);
            # a fitted model legitimately doesn't need them re-loaded.
            REQUIRED_POSTERIOR_FIELDS = ("mu_n", "sigma_n", "alpha_n", "beta_n", "feature_names")
            missing = [k for k in REQUIRED_POSTERIOR_FIELDS if posterior_params.get(k) is None]
            if missing:
                print(json.dumps({
                    "evt": "demand_posterior_partial_corruption",
                    "model_run_id": model_run_id,
                    "missing_fields": missing,
                }))
                return {
                    "error": f"Active demand model has incomplete posterior_params (missing: {','.join(missing)}) — retrain needed",
                    "property_id": property_id,
                    "date": str(prediction_date),
                    "model_version": model_run.get("model_version"),
                }

            try:
                model.mu_n = np.array(posterior_params["mu_n"])
                model.sigma_n = np.array(posterior_params["sigma_n"])
                model.alpha_n = posterior_params["alpha_n"]
                model.beta_n = posterior_params["beta_n"]
                model.mu_0 = (
                    np.array(posterior_params["mu_0"])
                    if posterior_params.get("mu_0") is not None else None
                )
                model.sigma_0 = (
                    np.array(posterior_params["sigma_0"])
                    if posterior_params.get("sigma_0") is not None else None
                )
                model.alpha = posterior_params.get("alpha", 2.0)
                model.beta = posterior_params.get("beta", 1.0)
                model.feature_names = posterior_params["feature_names"]
            except Exception as exc:
                print(json.dumps({
                    "evt": "demand_posterior_construct_failed",
                    "model_run_id": model_run_id,
                    "error": str(exc),
                }))
                return {
                    "error": f"Failed to construct demand posterior from saved params: {exc}",
                    "property_id": property_id,
                    "date": str(prediction_date),
                    "model_version": model_run.get("model_version"),
                }
        else:
            # No posterior saved; use prior-only inference. This is the
            # legitimate "model was just installed, never fit" path.
            model._initialize_prior(X)

        try:
            predictions = model.predict_quantile(X, quantiles)
        except ValueError as exc:
            # Feature-shape mismatch between trained posterior and inference X.
            # bayesian_regression now raises rather than silently reverting to
            # the prior. Surface as a structured error so it shows up red in
            # the /admin/ml cockpit and somebody retrains the model.
            return {
                "error": f"Bayesian posterior incompatible with inference features: {exc}",
                "property_id": property_id,
                "date": str(prediction_date),
                "model_version": model_run.get("model_version"),
            }

    elif algorithm == "xgboost-quantile":
        from src.layers.xgboost_quantile import XGBoostQuantile

        # Try to download model blob; fall back to prior-only if not available
        model_blob_path = model_run.get("model_blob_path")
        if model_blob_path:
            try:
                # Download from Supabase Storage (placeholder: assumes storage helper exists)
                # This is where model blob would be downloaded and deserialized
                # For now, return prior-only with note
                return {
                    "property_id": property_id,
                    "date": str(prediction_date),
                    "algorithm": "prior_only",
                    "error": "XGBoost blob download not yet implemented",
                    "model_version": model_run.get("model_version"),
                }
            except Exception:
                pass  # Fall through to error

        # XGBoost blob not available; return prior-only prediction
        return {
            "property_id": property_id,
            "date": str(prediction_date),
            "algorithm": "prior_only",
            "error": "XGBoost model blob unavailable; using prior",
            "model_version": model_run.get("model_version"),
        }

    else:
        # Unknown algorithm; use prior-only
        from src.layers.bayesian_regression import BayesianRegression

        model = BayesianRegression()
        model._initialize_prior(X)
        predictions = model.predict_quantile(X, quantiles)

    # Write predictions
    prediction_row = {
        "property_id": property_id,
        "date": str(prediction_date),
        "predicted_minutes_p10": float(predictions[0.1][0]),
        "predicted_minutes_p25": float(predictions[0.25][0]),
        "predicted_minutes_p50": float(predictions[0.5][0]),
        "predicted_minutes_p75": float(predictions[0.75][0]),
        # Phase L (2026-05-14): predicted_minutes_p80 was being written
        # but `demand_predictions` schema (migration 0021) has no such
        # column — only p10/p25/p50/p75/p90/p95 minutes columns exist.
        # PostgREST raised "column does not exist" on every insert; the
        # `except Exception` below caught it and returned an error JSON
        # that nobody was reading. Result: ZERO demand_predictions rows
        # in prod. Verified `select count(*) from demand_predictions` = 0
        # before this fix. The headcount p80 written below IS in the
        # schema and IS read by the Schedule tab — that line stays.
        "predicted_minutes_p90": float(predictions[0.9][0]),
        "predicted_minutes_p95": float(predictions[0.95][0]),
        "predicted_headcount_p50": float(
            np.ceil(predictions[0.5][0] / settings.shift_cap_minutes)
        ),
        # Codex post-merge review 2026-05-13 (Phase 2.4): the Schedule tab
        # at src/lib/ml-schedule-helpers.ts:78 reads predicted_headcount_p80
        # for the confidence band but inference wasn't writing it →
        # silent null. Now written alongside p50 + p95.
        "predicted_headcount_p80": float(
            np.ceil(predictions[0.8][0] / settings.shift_cap_minutes)
        ),
        "predicted_headcount_p95": float(
            np.ceil(predictions[0.95][0] / settings.shift_cap_minutes)
        ),
        "features_snapshot": json.dumps(features_dict),
        "model_run_id": model_run_id,
        "predicted_at": datetime.utcnow().isoformat(),
    }

    try:
        # on_conflict matches demand_predictions' unique constraint
        # (property_id, date, model_run_id) from migration 0021. Without
        # this, retries inserted duplicate rows instead of updating —
        # the wrapper used to drop on_conflict (Phase K bug 1, 2026-05-13).
        result = client.upsert(
            "demand_predictions",
            prediction_row,
            on_conflict="property_id,date,model_run_id",
        )
        return {
            "property_id": property_id,
            "date": str(prediction_date),
            "predicted_minutes_p50": prediction_row["predicted_minutes_p50"],
            "predicted_minutes_p95": prediction_row["predicted_minutes_p95"],
            "predicted_headcount_p50": prediction_row["predicted_headcount_p50"],
            "predicted_headcount_p95": prediction_row["predicted_headcount_p95"],
            "model_version": model_run.get("model_version"),
        }
    except Exception as e:
        # Phase L discipline rule #3: never swallow silently. Returning
        # an error dict is not enough — the cron caller may or may not
        # surface it. Emit a structured event so a future column-name
        # mismatch (or any PostgREST error) shows up in Vercel logs
        # within one cron cycle.
        print(json.dumps({
            "evt": "demand_prediction_write_failed",
            "property_id": property_id,
            "date": str(prediction_date),
            "model_run_id": model_run_id,
            "error": str(e)[:200],
        }))
        return {
            "error": f"Failed to write prediction: {e}",
            "property_id": property_id,
            "date": str(prediction_date),
        }
