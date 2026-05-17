"""Inference pipeline for Layer 2 Supply predictions."""
import json
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from src.config import get_settings
from src.errors import PropertyMisconfiguredError, require_property_timezone
from src.features.supply_matrix import build_supply_features
from src.supabase_client import get_supabase_client, safe_uuid, safe_iso_date


# Phase M3.4 (2026-05-14) — date prefix that the GM-facing UI prepends to
# room_assignments JSONB keys (e.g. "2026-05-14_315"). Stripped at read time.
_DATE_PREFIX_RE = re.compile(r"^\d{4}-\d{2}-\d{2}_")


def _parse_schedule_for_inference(
    sa_row: Optional[Dict[str, Any]],
    *,
    property_id: str,
    prediction_date: date,
) -> List[Dict[str, Any]]:
    """Build the per-(staff, rooms) aggregation predict_supply needs.

    Phase M3.4 (2026-05-14) — root-cause fix for the supply schedule fetch
    (Codex adversarial finding #3).

    Replaces the previous SQL-side approach that:
      - Cast every room_assignments value to uuid in the SELECT (any malformed
        value threw and 502'd the whole property's inference).
      - Removed the crew JOIN, so stale assignments for staff no longer in
        the day's crew produced ghost predictions for non-existent staff.

    In-memory parsing is the right architectural call: Beaumont has ~70
    entries (negligible wire cost), we get explicit per-entry validation,
    skip-and-log on bad data, and the crew filter becomes a trivial set
    membership check.

    Inputs:
      sa_row: schedule_assignments row dict (from fetch_one), or None.
        Expected shape: {"crew": [<uuid_str>, ...],
                         "room_assignments": {"<date>_<room>": "<staff_uuid>", ...}}
      property_id, prediction_date: passed through to log lines for
        observability.

    Returns:
      List of {"staff_id", "assigned_rooms", "room_count"} aggregations.
      Empty list when sa_row is None or has no usable assignments.
    """
    if not sa_row:
        return []

    crew_set = {str(s) for s in (sa_row.get("crew") or [])}
    room_assignments = sa_row.get("room_assignments") or {}

    by_staff: Dict[str, List[str]] = {}
    skipped_invalid_uuid = 0
    skipped_non_crew = 0
    for key, raw_staff_id in room_assignments.items():
        # Validate the value parses as a UUID. Skip + log; do NOT error
        # the whole property's inference. Pre-M3.4 SQL would 502 here.
        try:
            staff_id = str(uuid.UUID(str(raw_staff_id)))
        except (ValueError, TypeError, AttributeError):
            skipped_invalid_uuid += 1
            continue
        # Filter to staff currently in the day's crew. Pre-M3.4 SQL
        # had this as a JOIN; M3.3b dropped it (introduced ghost
        # predictions). Restored in-memory.
        if staff_id not in crew_set:
            skipped_non_crew += 1
            continue
        room_number = _DATE_PREFIX_RE.sub("", str(key))
        by_staff.setdefault(staff_id, []).append(room_number)

    if skipped_invalid_uuid or skipped_non_crew:
        # Surface skips so the operator can investigate stale assignments
        # without grepping for silence. Non-fatal — predictions still write
        # for the valid entries.
        print(json.dumps({
            "evt": "supply_schedule_skipped_entries",
            "property_id": property_id,
            "date": str(prediction_date),
            "skipped_invalid_uuid": skipped_invalid_uuid,
            "skipped_non_crew": skipped_non_crew,
            "kept": sum(len(rooms) for rooms in by_staff.values()),
        }))

    return [
        {"staff_id": staff_id, "assigned_rooms": rooms, "room_count": len(rooms)}
        for staff_id, rooms in by_staff.items()
    ]


# Phase 3.5 (2026-05-13): the America/Chicago fallback is gone — see
# inference/demand.py for the rationale and the validator contract.


def _tomorrow_in_property_tz(tz_name: str) -> date:
    """Tomorrow as seen by a property in `tz_name` (matches demand.py).

    Caller must pass a validated IANA timezone — `require_property_timezone`
    enforces this at the entry to the inference function.
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


def _hydrate_bayesian_from_run(model_run: dict):
    """Reconstruct a BayesianRegression instance from saved posterior_params.

    Returns the model, or None if posterior_params is missing/corrupt.
    """
    from src.layers.bayesian_regression import BayesianRegression

    pp_raw = model_run.get("posterior_params")
    if not pp_raw:
        return None

    # Phase M3.3 (2026-05-14) — root-cause fix for supply Bayesian inference.
    # Supabase returns JSONB columns as already-parsed Python dicts in
    # supabase-py, NOT as JSON strings. The previous `json.loads(pp_raw)`
    # assumption silently rejected EVERY Bayesian-active supply property
    # (TypeError → except → return None → predict_supply returns
    # "Active supply model has no usable posterior_params (retrain needed)"
    # → cron 502s). Latent since whenever the JSONB switch happened.
    # Inventory inference already has this guard (inventory_rate.py:237).
    try:
        pp = json.loads(pp_raw) if isinstance(pp_raw, str) else pp_raw
    except Exception as exc:
        print(json.dumps({
            "evt": "supply_posterior_json_invalid",
            "model_run_id": model_run.get("id"), "error": str(exc),
        }))
        return None

    # Phase M3.4 (2026-05-14) — hard-validate the 5 required posterior fields
    # BEFORE constructing the BayesianRegression. Codex adversarial finding #2:
    # the previous code used pp.get(field) which returns None for missing fields.
    # BayesianRegression.predict_quantile (bayesian_regression.py:159-178) has
    # an explicit branch for `mu_n is None` that re-initializes the prior and
    # serves PRIOR predictions. So an active "Bayesian" model row with partial
    # JSONB corruption silently served cold-start-shaped predictions while
    # reporting itself as a fitted Bayesian — operator saw plausible numbers
    # instead of the explicit "retrain needed" failure this path is designed
    # to surface. Fail loud with structured log so operator sees it.
    #
    # mu_0 / sigma_0 / alpha / beta are PRE-FIT priors used in
    # _initialize_prior() before fit. A fitted model legitimately doesn't
    # need them re-loaded — the posterior fields supersede. Don't gate on those.
    REQUIRED_POSTERIOR_FIELDS = ("mu_n", "sigma_n", "alpha_n", "beta_n", "feature_names")
    missing = [k for k in REQUIRED_POSTERIOR_FIELDS if pp.get(k) is None]
    if missing:
        print(json.dumps({
            "evt": "supply_posterior_partial_corruption",
            "model_run_id": model_run.get("id"),
            "missing_fields": missing,
        }))
        return None

    model = BayesianRegression()
    try:
        model.mu_n     = np.array(pp["mu_n"])
        model.sigma_n  = np.array(pp["sigma_n"])
        model.alpha_n  = pp["alpha_n"]
        model.beta_n   = pp["beta_n"]
        model.mu_0     = np.array(pp["mu_0"])     if pp.get("mu_0") is not None else None
        model.sigma_0  = np.array(pp["sigma_0"])  if pp.get("sigma_0") is not None else None
        model.alpha    = pp.get("alpha", 2.0)
        model.beta     = pp.get("beta", 1.0)
        model.feature_names = pp["feature_names"]
        return model
    except Exception as exc:
        print(json.dumps({
            "evt": "supply_posterior_hydrate_failed",
            "model_run_id": model_run.get("id"), "error": str(exc),
        }))
        return None


async def predict_supply(
    property_id: str,
    prediction_date: Optional[date] = None,
    property_timezone: Optional[str] = None,
) -> dict:
    """Predict per-(room × housekeeper) cleaning times for a property.

    Loads the active supply model from `model_runs.posterior_params` (Bayesian)
    or `model_runs.model_blob_path` (XGBoost — not yet implemented). Previously
    this function ignored the trained model entirely and refit a one-row
    "dummy" Bayesian on y=25.0, which made every prediction a flat 25 minutes
    regardless of room or housekeeper.
    """
    err = _validate_property_id(property_id)
    if err:
        return {"error": err, "property_id": property_id, "date": None}

    settings = get_settings()
    client = get_supabase_client()

    if prediction_date is None:
        # Phase 3.5: require timezone — log + skip if missing.
        try:
            tz_name = require_property_timezone(property_timezone, property_id)
        except PropertyMisconfiguredError as exc:
            print(json.dumps({
                "evt": "property_misconfigured",
                "layer": "supply",
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

    # Find active supply model
    active_models = client.fetch_many(
        "model_runs",
        filters={"property_id": property_id, "layer": "supply", "is_active": True},
        limit=1,
    )

    if not active_models:
        return {
            "error": "No active supply model",
            "property_id": property_id,
            "date": str(prediction_date),
        }

    model_run = active_models[0]
    model_run_id = model_run["id"]
    algorithm = model_run.get("algorithm", "bayesian")

    # Hydrate the actual trained model. If we can't, return an explicit error
    # rather than fabricating predictions from a dummy fit.
    model = None
    cold_start_prior_minutes_per_event = None  # Optional[float]
    if algorithm == "bayesian":
        model = _hydrate_bayesian_from_run(model_run)
        if model is None:
            return {
                "error": "Active supply model has no usable posterior_params (retrain needed)",
                "property_id": property_id,
                "date": str(prediction_date),
                "model_version": model_run.get("model_version"),
            }
    elif algorithm == "cold-start-cohort-prior":
        # Phase M3 — cold-start cohort-prior path. Active model exists but
        # has no fitted posterior; use prior_minutes_per_event from the
        # model_runs.posterior_params payload (set by
        # _cold_start.install_cold_start at training time).
        try:
            posterior = model_run.get("posterior_params") or {}
            if isinstance(posterior, str):
                posterior = json.loads(posterior)
            cold_start_prior_minutes_per_event = float(
                posterior.get("prior_minutes_per_event", 30.0)
            )
        except Exception as exc:
            print(json.dumps({
                "evt": "supply_cold_start_inference_payload_bad",
                "model_run_id": model_run_id,
                "error": str(exc)[:200],
            }))
            cold_start_prior_minutes_per_event = 30.0  # industry-default
    elif algorithm == "xgboost-quantile":
        # XGBoost serialization not yet wired up. Fail explicitly so this is
        # visible in the cockpit rather than silently producing flat numbers.
        return {
            "error": "XGBoost supply model deserialization not yet implemented",
            "property_id": property_id,
            "date": str(prediction_date),
            "model_version": model_run.get("model_version"),
        }
    else:
        return {
            "error": f"Unknown supply algorithm: {algorithm}",
            "property_id": property_id,
            "date": str(prediction_date),
        }

    # Fetch schedule for prediction_date.
    #
    # Phase M3.4 (2026-05-14) — Codex adversarial finding #3 root-cause fix.
    # The M3.3b SQL had two structural problems:
    #   (a) ra.value::uuid cast inside the SELECT threw on any malformed
    #       value (empty string, null, non-UUID string from a buggy writer)
    #       → predict_supply returned "Failed to fetch schedule" → route 502s
    #       for the WHOLE property even when 99% of assignments were valid.
    #   (b) Removed the crew JOIN that the original (broken) SQL had, so
    #       stale assignments referencing a staff member no longer in the
    #       day's crew now produced ghost predictions for non-existent staff.
    #
    # Architectural fix: pull the schedule_assignments row as JSON and parse
    # in Python. Beaumont has ~70 entries (negligible wire cost), gets us
    # explicit per-entry validation + skip-and-log on bad data + crew filter
    # as a trivial set lookup + zero remaining brittle SQL. Fully unit-testable
    # without mocking SQL strings.
    try:
        sa_row = client.fetch_one(
            "schedule_assignments",
            filters={"property_id": property_id, "date": str(prediction_date)},
        )
    except Exception as e:
        return {
            "error": f"Failed to fetch schedule: {e}",
            "property_id": property_id,
            "date": str(prediction_date),
        }
    schedule_data = _parse_schedule_for_inference(
        sa_row, property_id=property_id, prediction_date=prediction_date,
    )

    # Pull tomorrow's day-level features AND per-room status arrays. The
    # per-room arrays let us pick the right room_type / stayover_day for
    # each room being predicted, instead of hard-coding everyone to
    # "stayover day 1" (which under-estimated checkout-heavy days and
    # caused systematic understaffing — Codex audit pass-6 P0).
    plan_query = f"""
        select
            extract(dow from date)::int as dow,
            case
                when coalesce(total_rooms, 0) > 0
                then round((100.0 * (total_rooms - coalesce(vacant_clean,0) - coalesce(vacant_dirty,0) - coalesce(ooo,0))::numeric / total_rooms)::numeric, 2)
                else 50.0
            end as occupancy_pct,
            checkout_room_numbers,
            stayover_day1_room_numbers,
            stayover_day2_room_numbers,
            stayover_arrival_room_numbers,
            arrival_room_numbers,
            vacant_dirty_room_numbers
        from plan_snapshots
        where property_id = '{safe_uuid(property_id)}'
          and date = '{safe_iso_date(str(prediction_date))}'::date
        order by pulled_at desc
        limit 1
    """
    try:
        plan_rows = client.execute_sql(plan_query)
    except Exception:
        plan_rows = []
    plan = plan_rows[0] if plan_rows else {}
    dow = int(plan.get("dow", prediction_date.weekday()) or prediction_date.weekday())
    occupancy_at_start = int(round(float(plan.get("occupancy_pct", 50.0) or 50.0)))

    # Build a per-room (room_type, stayover_day) lookup from the plan
    # arrays. Each room is in at most one array; rooms scheduled for
    # cleaning that are missing from all arrays fall back to stayover
    # day 1 (the safest default — under-estimating workload is the
    # failure mode we're trying to avoid).
    #
    # Mapping:
    #   checkout / arrival           → room_type='checkout',  stayover_day=0
    #   stayover_day1 / arrival      → room_type='stayover',  stayover_day=1
    #   stayover_day2                → room_type='stayover',  stayover_day=2
    #   vacant_dirty                 → room_type='checkout',  stayover_day=0
    #     (vacant_dirty rooms need a full reset — workload is checkout-grade,
    #      not stayover-grade; under-estimating these is the same bias we
    #      are trying to remove)
    def _norm_room_list(raw) -> list:
        if isinstance(raw, list):
            return [str(r).strip() for r in raw if r is not None]
        # execute_sql may return PG arrays as a comma-joined string in
        # rare cases; defensive parse.
        if isinstance(raw, str) and raw.startswith("{") and raw.endswith("}"):
            inner = raw[1:-1]
            return [s.strip().strip('"') for s in inner.split(",") if s.strip()]
        return []

    room_state_lookup: dict[str, tuple[str, int]] = {}
    for room in _norm_room_list(plan.get("checkout_room_numbers")):
        room_state_lookup[room] = ("checkout", 0)
    for room in _norm_room_list(plan.get("arrival_room_numbers")):
        # An arrival means the room is being turned over for a new guest,
        # workload-wise indistinguishable from a checkout (full reset).
        room_state_lookup.setdefault(room, ("checkout", 0))
    for room in _norm_room_list(plan.get("vacant_dirty_room_numbers")):
        # Vacant-dirty needs a full reset — checkout-grade workload.
        room_state_lookup.setdefault(room, ("checkout", 0))
    for room in _norm_room_list(plan.get("stayover_day2_room_numbers")):
        room_state_lookup.setdefault(room, ("stayover", 2))
    for room in _norm_room_list(plan.get("stayover_day1_room_numbers")):
        room_state_lookup.setdefault(room, ("stayover", 1))
    for room in _norm_room_list(plan.get("stayover_arrival_room_numbers")):
        # Stayover-arrival = guest arrives same day they're listed as
        # stayover; workload pattern matches a normal day-1 stayover.
        room_state_lookup.setdefault(room, ("stayover", 1))

    # Generate predictions using the trained Bayesian model.
    quantiles = [0.25, 0.5, 0.75, 0.9]
    predictions = []

    # Phase M3.1 (2026-05-14): saved_feature_names is bayesian-only — it
    # only matters for build_supply_features() at line ~388. The cold-start
    # path bypasses model.predict_quantile entirely (line 364) so it has
    # no model and no feature_names. Computing it here unconditionally
    # crashed every cold-start invocation with NoneType.feature_names —
    # caught by test_supply_inference_cold_start.py. Defer the computation
    # into the bayesian-only branch.
    saved_feature_names = None

    # Build the full per-(room, staff) context dataframe up front. Doing
    # the fanout in one pass lets us shape-validate ALL predictions against
    # the model's feature_names BEFORE writing anything — previously the
    # per-room loop could fail mid-schedule and leave half the rooms
    # written with the prior model and half with no row at all.
    pair_rows: list[dict] = []
    fallback_rooms_count = 0
    for sched in schedule_data or []:
        staff_id = sched["staff_id"]
        rooms = sched.get("assigned_rooms", []) or []
        for room_number in rooms:
            # Look up the actual room state from tomorrow's plan_snapshot.
            # Fall back to (stayover, 1) only if the room isn't in any
            # plan array — possible on freshly-onboarded properties before
            # the first plan pull lands. Counted + logged so we know if
            # the fallback is being silently overused.
            room_key = str(room_number).strip()
            room_type, stayover_day = room_state_lookup.get(
                room_key, ("stayover", 1),
            )
            if room_key not in room_state_lookup:
                fallback_rooms_count += 1
            pair_rows.append({
                "room_number": room_number,
                "staff_id": staff_id,
                "day_of_week": dow,
                "occupancy_at_start": occupancy_at_start,
                "room_type": room_type,
                "stayover_day": stayover_day,
            })

    if fallback_rooms_count > 0:
        # Don't fail — predictions still work — but surface that the plan
        # data was incomplete so we can investigate (recipe extraction
        # gap, room not in roster, etc.).
        print(json.dumps({
            "evt": "supply_inference_room_state_fallback",
            "property_id": property_id,
            "date": str(prediction_date),
            "rooms_using_fallback": fallback_rooms_count,
            "rooms_total": len(pair_rows),
            "note": "rooms not found in any plan_snapshot array — defaulted to (stayover, day 1)",
        }))

    if not pair_rows:
        return {
            "property_id": property_id,
            "date": str(prediction_date),
            "predicted_rooms": 0,
            "model_version": model_run.get("model_version"),
        }

    pair_df = pd.DataFrame(pair_rows)

    # Phase M3 — cold-start path bypasses model.predict_quantile entirely
    # because there's no fitted posterior. Every (room, staff) gets the
    # same cohort-prior-derived prediction with wide quantile bands.
    # Replaced by per-(room×staff) Bayesian posterior as soon as the
    # next training run has ≥14 days of data.
    if cold_start_prior_minutes_per_event is not None:
        mu = float(cold_start_prior_minutes_per_event)
        for row in pair_rows:
            predictions.append({
                "room_number": row["room_number"],
                "staff_id": row["staff_id"],
                "predicted_minutes_p25": mu * 0.7,
                "predicted_minutes_p50": mu,
                "predicted_minutes_p75": mu * 1.3,
                "predicted_minutes_p90": mu * 1.6,
                "features_snapshot": json.dumps({
                    "cold_start": True,
                    "prior_minutes_per_event": mu,
                    "cohort_key": (model_run.get("posterior_params") or {}).get("cohort_key", "unknown") if isinstance(model_run.get("posterior_params"), dict) else "unknown",
                }),
            })
    else:
        # Standard Bayesian / posterior-fitted path.
        # The trained model's feature_names list is the column order we MUST
        # build X with. build_supply_features() aligns one-hot columns
        # (room_<number>, staff_<uuid>) to this list — rooms / staff that
        # weren't seen at training time silently fall to all-zero rows
        # (i.e. the baseline intercept + day/occupancy/type effects).
        # Computed here (not at the top of the function) so the cold-start
        # branch above doesn't trip on model=None — Phase M3.1.
        saved_feature_names = list(model.feature_names) if model.feature_names else None
        if not saved_feature_names:
            return {
                "error": "Active supply model has no feature_names — retrain needed",
                "property_id": property_id,
                "date": str(prediction_date),
                "model_version": model_run.get("model_version"),
            }

        # Single matrix build → single shape check. If feature_names is
        # incompatible (e.g. an old v1 model is still active and we trained
        # the page expecting v2 columns), this raises and we bail before
        # touching supply_predictions at all.
        try:
            X_all, _ = build_supply_features(
                pair_df, training=False, feature_names=saved_feature_names,
            )
            all_preds = model.predict_quantile(X_all, quantiles)
        except ValueError as exc:
            return {
                "error": f"Supply posterior incompatible with inference features: {exc}",
                "property_id": property_id,
                "date": str(prediction_date),
                "model_version": model_run.get("model_version"),
            }

        # all_preds is a dict { quantile -> ndarray length N }. Pull row-wise.
        for i, row in enumerate(pair_rows):
            # Per-(room, staff) snapshot of the actual feature values that
            # produced this prediction. Useful for debugging "why did room 305
            # get 35 min when room 412 got 22?" — read this column to see the
            # one-hot encodings and base features at predict time.
            features_snapshot = {
                k: (X_all.iloc[i][k] if k in X_all.columns else 0.0)
                for k in saved_feature_names
            }
            predictions.append({
                "room_number": row["room_number"],
                "staff_id": row["staff_id"],
                "predicted_minutes_p25": float(all_preds[0.25][i]),
                "predicted_minutes_p50": float(all_preds[0.5][i]),
                "predicted_minutes_p75": float(all_preds[0.75][i]),
                "predicted_minutes_p90": float(all_preds[0.9][i]),
                "features_snapshot": json.dumps(features_snapshot),
            })

    # Write all predictions
    for pred in predictions:
        pred.update({
            "property_id": property_id,
            "date": str(prediction_date),
            "model_run_id": model_run_id,
            "predicted_at": datetime.utcnow().isoformat(),
        })

        try:
            # Matches supply_predictions' unique constraint
            # (property_id, date, room_number, staff_id, model_run_id)
            # from migration 0021. Phase K bug 1.
            client.upsert(
                "supply_predictions",
                pred,
                on_conflict="property_id,date,room_number,staff_id,model_run_id",
            )
        except Exception as exc:
            print(json.dumps({
                "evt": "supply_prediction_write_failed",
                "room": pred.get("room_number"), "staff_id": pred.get("staff_id"),
                "error": str(exc),
            }))

    return {
        "property_id": property_id,
        "date": str(prediction_date),
        "predicted_rooms": len(predictions),
        "model_version": model_run.get("model_version"),
    }
