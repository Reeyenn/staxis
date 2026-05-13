"""Training pipeline for the inventory_rate ML layer.

Mirrors the demand-layer pipeline (`src/training/demand.py`) but operates
per (property × item) instead of per property. Each item gets its own
Bayesian model with its own posterior. Once a property has ≥100 events on
a single item we activate XGBoost for that item; otherwise it stays
Bayesian.

The graduation gates that flip `auto_fill_enabled=true` on the active
model_runs row:
  • ≥ 30 count events for this (property × item)
  • validation_mae / mean_observed_rate < 0.10 (relative MAE)
  • 5 consecutive passing training runs

When all three hold, the inventory page pre-fills the count input from
`inventory_rate_predictions.predicted_current_stock` instead of leaving
it blank.

We intentionally do NOT block training when there's only 3–5 events.
Bayesian regression with cohort priors gives meaningful (if low-confidence)
predictions even at N=3 — that's the whole point of using a conjugate
prior. The graduation gate prevents low-confidence models from being
trusted for auto-fill; predictions still feed the reorder list invisibly.
"""
import json
import os
import uuid
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
import psycopg2

from src.advisory_lock import advisory_lock
from src.config import get_settings
from src.errors import PropertyMisconfiguredError, require_total_rooms
from src.layers.bayesian_regression import BayesianRegression
from src.layers.xgboost_quantile import XGBoostQuantile, XGBOOST_INFERENCE_READY
from src.supabase_client import get_supabase_client


# Feature columns. v1 keeps it simple — intercept + occupancy_pct. The model
# learns: usage_rate = intercept + occupancy_pct × slope. Day-of-week and
# day-of-stay effects can be added in v2 when we have more data per item.
INVENTORY_FEATURE_COLS = [
    "occupancy_pct",
]

# Default global prior used when no cohort-prior row matches and the item's
# canonical name is "unknown" or the priors table is empty.
DEFAULT_GLOBAL_RATE_PER_ROOM_PER_DAY = 0.20


def _validate_property_id(property_id: str) -> Optional[str]:
    """Reject any property_id that is not a well-formed UUID."""
    try:
        uuid.UUID(str(property_id))
        return None
    except (ValueError, AttributeError, TypeError):
        return f"Invalid property_id: not a UUID ({property_id!r})"


def _validate_item_id(item_id: str) -> Optional[str]:
    try:
        uuid.UUID(str(item_id))
        return None
    except (ValueError, AttributeError, TypeError):
        return f"Invalid item_id: not a UUID ({item_id!r})"


async def train_inventory_rate_model(
    property_id: str,
    item_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Train inventory_rate models for a property.

    If item_id is None, trains a model per item (intended use). Iterates
    through every inventory.id with ≥ inventory_min_events_per_item count
    events, trains independently. Returns aggregate stats.

    If item_id is set, trains a single model for that item only — used by
    the cockpit's "Retrain this item" button.

    Args:
        property_id: Property UUID
        item_id: Optional inventory item UUID. None = train all items.

    Returns:
        Dict with summary: items_trained, items_skipped_insufficient_data,
        items_with_active_model, items_with_auto_fill, errors.
    """
    err = _validate_property_id(property_id)
    if err:
        return {"error": err, "items_trained": 0}

    if item_id is not None:
        err = _validate_item_id(item_id)
        if err:
            return {"error": err, "items_trained": 0}

    settings = get_settings()
    client = get_supabase_client()

    # Acquire advisory lock once for the property; iterate over items inside.
    db_url = os.environ.get("SUPABASE_DB_URL") or os.environ.get("DATABASE_URL")
    lock_conn = None
    if db_url:
        try:
            lock_conn = psycopg2.connect(db_url)
        except Exception as exc:
            print(json.dumps({
                "evt": "advisory_lock_connect_failed",
                "layer": "inventory_rate",
                "property_id": property_id,
                "error": str(exc),
            }))

    def _do_train() -> Dict[str, Any]:
        return _train_inventory_inner(property_id, item_id, settings, client)

    try:
        if lock_conn is not None:
            with advisory_lock(lock_conn, property_id, "inventory_rate", blocking=True):
                return _do_train()
        else:
            return _do_train()
    except PropertyMisconfiguredError as exc:
        # Phase 3.3/3.5 boundary: log + return structured error so the TS
        # cron sees an HTTP 200 with `error` set and moves to the next
        # property. One misconfigured row never blocks the fleet.
        print(json.dumps({
            "evt": "property_misconfigured",
            "layer": "inventory_rate",
            "property_id": exc.property_id,
            "field": exc.field,
            "value": str(exc.bad_value),
        }))
        return {
            "items_trained": 0,
            "items_skipped_insufficient_data": 0,
            "items_with_active_model": 0,
            "items_with_auto_fill": 0,
            "errors": [],
            "error": f"property_misconfigured: {exc.field}={exc.bad_value!r}",
        }
    finally:
        if lock_conn is not None:
            try:
                lock_conn.close()
            except Exception:
                pass


def _train_inventory_inner(
    property_id: str,
    item_id_filter: Optional[str],
    settings,
    client,
) -> Dict[str, Any]:
    # Fetch the list of items to train. If item_id_filter is set, just that one.
    if item_id_filter:
        items = client.fetch_many(
            "inventory",
            filters={"property_id": property_id, "id": item_id_filter},
            limit=1,
        )
    else:
        items = client.fetch_many(
            "inventory",
            filters={"property_id": property_id},
            limit=500,
        )

    if not items:
        return {"items_trained": 0, "items_skipped_insufficient_data": 0,
                "items_with_active_model": 0, "items_with_auto_fill": 0,
                "errors": [], "note": "no items found"}

    # Property metadata for cohort-prior lookup
    prop = client.fetch_one("properties", filters={"id": property_id})

    # Phase 3.3 (2026-05-13): fail fast on misconfigured properties so the
    # outer cron boundary can log + skip the whole property instead of
    # logging the same `total_rooms` error once per item. Inference reads
    # the same field; catching here keeps the surface area tight.
    require_total_rooms(prop, property_id)

    cohort_key = _build_cohort_key(prop) if prop else "global"

    items_trained = 0
    items_skipped = 0
    items_with_active_model = 0
    items_with_auto_fill = 0
    errors: List[str] = []

    for item in items:
        try:
            result = _train_single_item(
                property_id=property_id,
                property_meta=prop or {},
                item=item,
                cohort_key=cohort_key,
                settings=settings,
                client=client,
            )
            if result.get("skipped"):
                items_skipped += 1
                continue
            items_trained += 1
            if result.get("is_active"):
                items_with_active_model += 1
            if result.get("auto_fill_enabled"):
                items_with_auto_fill += 1
        except Exception as exc:
            errors.append(f"item {item.get('id')}: {exc}")
            print(json.dumps({
                "evt": "inventory_train_item_failed",
                "property_id": property_id,
                "item_id": item.get("id"),
                "error": str(exc),
            }))

    return {
        "items_trained": items_trained,
        "items_skipped_insufficient_data": items_skipped,
        "items_with_active_model": items_with_active_model,
        "items_with_auto_fill": items_with_auto_fill,
        "errors": errors,
    }


def _build_cohort_key(prop: Dict[str, Any]) -> str:
    """Build the cohort_key string used to look up cohort priors.

    Returns 'brand-region-size_tier' if all three are populated, otherwise
    'global'. Lowercased and slug-ified to match how cohort priors are written.
    """
    brand = prop.get("brand")
    region = prop.get("region")
    size_tier = prop.get("size_tier")
    if brand and region and size_tier:
        slug = lambda s: str(s).strip().lower().replace(" ", "-")
        return f"{slug(brand)}-{slug(region)}-{slug(size_tier)}"
    return "global"


def _train_single_item(
    property_id: str,
    property_meta: Dict[str, Any],
    item: Dict[str, Any],
    cohort_key: str,
    settings,
    client,
) -> Dict[str, Any]:
    """Train one (property, item) Bayesian / XGBoost model."""
    item_id = item["id"]
    item_name = item["name"]

    # Pull all count events for this item, ordered by date.
    counts = client.fetch_many(
        "inventory_counts",
        filters={"property_id": property_id, "item_id": item_id},
        order_by="counted_at",
        descending=False,
        limit=2000,
    )

    # Cold-start fast path. When the hotel has too few counts for a real
    # Bayesian fit, try to seed predictions from a cohort/global prior so
    # Maria sees autofill values from Day 1 instead of empty boxes. Only
    # fires when (a) the item resolves to a canonical name, and (b) the
    # priors table actually has a row for that name (real cross-hotel
    # signal — not the DEFAULT_GLOBAL_RATE_PER_ROOM_PER_DAY hardcoded
    # placeholder). Inventory ONLY — housekeeping demand stays as-is
    # because rooms differ in size across hotels.
    if len(counts) < settings.inventory_min_events_per_item:
        prior_rate, prior_strength, prior_source = _lookup_prior_with_source(
            client, cohort_key, item, item_name
        )
        if prior_source != "default":
            cold_start_run = _create_cold_start_model_run(
                client=client,
                property_id=property_id,
                property_meta=property_meta,
                item=item,
                cohort_key=cohort_key,
                prior_rate=prior_rate,
                prior_strength=prior_strength,
                prior_source=prior_source,
                events_observed=len(counts),
            )
            return {
                "skipped": False,
                "model_run_id": cold_start_run.get("id"),
                "is_active": True,
                "auto_fill_enabled": False,
                "validation_mae": None,
                "training_row_count": 0,
                "cold_start": True,
            }
        return {"skipped": True, "reason": "insufficient_count_events",
                "events": len(counts)}

    # Pull orders + discards for this item to compute net consumption between counts.
    # Phase 3.9 (2026-05-13): the prior `limit=2000` had no order_by, so
    # PostgREST returned rows in arbitrary (likely insertion) order. A
    # high-volume property with >2000 orders for a single item would
    # silently lose learning past the truncation point — and the
    # truncated rows could be either oldest or newest depending on
    # internal PG state. Order by the activity timestamp newest-first
    # and bump the ceiling to 10000 (covers ~5 years of daily orders
    # per item before truncation kicks in).
    orders = client.fetch_many(
        "inventory_orders",
        filters={"property_id": property_id, "item_id": item_id},
        order_by="received_at",
        descending=True,
        limit=10000,
    )
    discards = client.fetch_many(
        "inventory_discards",
        filters={"property_id": property_id, "item_id": item_id},
        order_by="discarded_at",
        descending=True,
        limit=10000,
    )

    # Pull daily_logs for occupancy features (most-recent 365 days; small).
    daily_logs = client.fetch_many(
        "daily_logs",
        filters={"property_id": property_id},
        # daily_logs.date is the operational date (per inspection of
        # information_schema). The earlier `log_date` reference would have
        # been correct against an older schema; the deployed table uses
        # `date`. Caught during Tier 2 triple-check after fixing the
        # `descending=` keyword in supabase_client unmasked this layer.
        order_by="date",
        descending=True,
        limit=400,
    )

    # Build training rows: one per CONSECUTIVE pair of counts.
    rows = _build_training_rows(counts, orders, discards, daily_logs)
    if len(rows) < settings.inventory_min_events_per_item - 1:
        return {"skipped": True, "reason": "insufficient_consecutive_pairs",
                "pairs": len(rows)}

    df = pd.DataFrame(rows)
    df["daily_rate"] = pd.to_numeric(df["daily_rate"], errors="coerce")
    df["occupancy_pct"] = pd.to_numeric(df["occupancy_pct"], errors="coerce").fillna(50.0)
    df = df[df["daily_rate"].notna() & (df["daily_rate"] >= 0)].reset_index(drop=True)
    if len(df) < settings.inventory_min_events_per_item - 1:
        return {"skipped": True, "reason": "insufficient_clean_rows",
                "rows": len(df)}

    # Look up cohort prior (mu_0 intercept) + its strength. Falls back to
    # global → default. Strength schedule (set by aggregate_inventory_priors):
    #   <10 hotels → 0.5  (weak — let property data dominate)
    #   10-50      → 2.0  (moderate)
    #   50+        → 5.0  (strong — cohort dominates new-hotel cold-start)
    prior_rate, prior_strength = _lookup_prior(client, cohort_key, item, item_name)

    # Features + target
    X = df[INVENTORY_FEATURE_COLS].copy()
    X.insert(0, "intercept", 1.0)
    y = df["daily_rate"].astype(float)

    # Time-based 80/20 split. With very small N we don't split — use all data.
    if len(X) >= 5:
        split_idx = int(len(X) * 0.8)
        X_train, X_test = X.iloc[:split_idx], X.iloc[split_idx:]
        y_train, y_test = y.iloc[:split_idx], y.iloc[split_idx:]
    else:
        X_train, X_test = X, X.iloc[:0]
        y_train, y_test = y, y.iloc[:0]

    # Choose algorithm based on row count
    use_xgboost = len(X_train) >= settings.inventory_xgboost_activation_events

    if use_xgboost:
        model = XGBoostQuantile(quantiles=[0.1, 0.25, 0.5, 0.75, 0.9])
        model_version = f"inventory-xgboost-v1-{item_id}-{datetime.utcnow().isoformat()}"
        algorithm = "xgboost-quantile"
    else:
        # prior_strength comes from the inventory_rate_priors row — varies by
        # cohort size. Bigger cohort → stronger prior → cold-start hotels lean
        # more on cohort and less on their own (still-noisy) data.
        model = BayesianRegression(prior_strength=prior_strength)
        # Inject the cohort prior as the intercept's mu_0. Scale by the
        # property's total room count: a 200-room hotel uses ~3x as much
        # shampoo as a 60-room hotel at the same per-room rate.
        # Phase 3.3 (2026-05-13): require_total_rooms raises
        # PropertyMisconfiguredError instead of silently falling back to
        # 60 — the cron boundary catches + logs the skip.
        room_count = require_total_rooms(property_meta, property_id)
        _seed_bayesian_intercept(model, prior_rate, room_count)
        model_version = f"inventory-bayesian-v1-{item_id}-{datetime.utcnow().isoformat()}"
        algorithm = "bayesian"

    # Fit
    model.fit(X_train, y_train)

    # Compute metrics
    if len(X_test) > 0:
        pred_test = model.predict(X_test)
        validation_mae = float(np.mean(np.abs(pred_test - y_test.values)))
    else:
        validation_mae = 0.0  # Can't evaluate; mark zero, gate this case below.
    training_mae = float(np.mean(np.abs(model.predict(X_train) - y_train.values)))

    # Baseline = predicting the cohort-prior rate everywhere.
    baseline_pred = np.full(len(y_test) if len(X_test) > 0 else len(y_train), prior_rate)
    if len(X_test) > 0:
        baseline_mae = float(np.mean(np.abs(baseline_pred - y_test.values)))
    else:
        baseline_mae = float(np.mean(np.abs(baseline_pred - y_train.values)))

    if baseline_mae > 1e-9:
        beats_baseline_pct = float(max(0.0, (baseline_mae - validation_mae) / baseline_mae))
    else:
        beats_baseline_pct = 0.0

    # Graduation gates: ≥30 events + MAE/mean<0.10 + 5 consecutive passes
    # Codex follow-up 2026-05-13 (C1): use TEST-set mean (not train-set
    # y.mean()) for the ratio denominator. Train-set leak: a model that
    # overfits a tiny train set with a high mean would flatter mae_ratio
    # against that inflated mean rather than the held-out actuals it
    # was evaluated on. Fall back to y.mean() when the test set is
    # empty (the gate_mae check below already short-circuits empty
    # test sets, so this fallback is purely defensive).
    if len(y_test) > 0:
        mean_observed_rate = float(y_test.mean())
    else:
        mean_observed_rate = float(y.mean())
    mae_ratio = (validation_mae / mean_observed_rate) if mean_observed_rate > 1e-9 else float("inf")
    gate_events = len(df) >= settings.inventory_graduation_min_events
    gate_mae = (
        len(X_test) > 0
        and mae_ratio < settings.inventory_graduation_mae_ratio
    )

    # Count consecutive passing runs from prior model_runs rows for this item.
    prior_runs = client.fetch_many(
        "model_runs",
        filters={"property_id": property_id, "layer": "inventory_rate", "item_id": item_id},
        order_by="trained_at",
        descending=True,
        limit=10,
    )
    this_run_passes = gate_events and gate_mae
    consecutive_passes = 1 if this_run_passes else 0
    for pr in prior_runs or []:
        prior_passes = (
            (pr.get("training_row_count") or 0) >= settings.inventory_graduation_min_events
            and (pr.get("validation_mae") or float("inf")) < settings.inventory_graduation_mae_ratio
                * max(mean_observed_rate, 1e-9)
        )
        if prior_passes and consecutive_passes > 0:
            consecutive_passes += 1
            if consecutive_passes > settings.inventory_graduation_consecutive_passes:
                consecutive_passes = settings.inventory_graduation_consecutive_passes
        else:
            break

    auto_fill_enabled = (
        this_run_passes
        and consecutive_passes >= settings.inventory_graduation_consecutive_passes
    )

    # Shadow mode gate (Tier 2 Phase 5).
    #
    # If there's already a graduated active model for this (property, item),
    # this retrain lands as a shadow run instead of replacing it. The
    # shadow sits at is_active=false, is_shadow=true for 7 days while the
    # daily shadow-evaluate cron compares its validation_mae to the
    # active's. If the shadow performs as well or better, the cron
    # promotes it; otherwise the existing active keeps serving.
    #
    # Only graduated (auto_fill_enabled=true) actives gate shadow mode —
    # early-stage models that haven't earned production trust yet keep
    # replacing each other on every retrain. Cold-start cohort-prior runs
    # never auto_fill_enabled, so they also keep getting replaced.
    existing_active_rows = client.fetch_many(
        "model_runs",
        filters={
            "property_id": property_id,
            "layer": "inventory_rate",
            "item_id": item_id,
            "is_active": True,
        },
        limit=1,
    )
    existing_graduated = bool(
        existing_active_rows
        and existing_active_rows[0].get("auto_fill_enabled")
    )

    is_shadow = existing_graduated
    is_active = not is_shadow
    shadow_started_at = datetime.utcnow().isoformat() if is_shadow else None

    # ── No-validation-set gate (May 2026 audit pass-3) ────────────────
    # When the item has <5 training rows, X_test ends up empty and
    # validation_mae defaults to 0.0 as a sentinel (see line 367).
    # The next gate below checks validation_mae >= max(mean*1.0, 1.0)
    # — 0 < 1.0 so the model passes unconditionally. A model with
    # ZERO validation rows would pass the "this prediction is
    # trustworthy" gate. Catch that case here first.
    #
    # Concrete failure mode: hotel #2 onboards. Maria adds 12
    # inventory items. The first weekly training run sees 2-3 rows
    # per item. All 12 items would have validation_mae=0 and pass
    # this gate, producing confident-looking AI suggestions ("Coffee
    # Pods: predicted 47 today") on essentially no signal.
    #
    # Bayesian cold-start path still works — those models build from
    # cohort priors and don't need an internal validation set to be
    # useful. But they shouldn't be MARKED as validated either;
    # is_active=False keeps them serving via the cold-start prior
    # without claiming "the per-property model has earned trust".
    mae_reject_notes = None
    if is_active and len(X_test) == 0:
        is_active = False
        mae_reject_notes = (
            f"rejected_no_validation_set: only {len(X_train)} training rows "
            f"(need ≥5 for an 80/20 split). Falling back to cold-start prior."
        )

    # ── Max-MAE safety gate (P0-3, May 2026 audit) ────────────────────
    # Reject models whose validation_mae is at or above the mean observed
    # rate — those are no better than a constant "predict the mean"
    # baseline and their per-day predictions look confidently wrong.
    #
    # Threshold: validation_mae must be < max(mean_rate * 1.0, 1.0).
    #   - mean_rate * 1.0 = "model beats the constant-mean baseline".
    #     A model EXACTLY at the mean's level (MAE = mean) is no
    #     information; >= mean is worse than no information.
    #   - 1.0 absolute floor handles items with near-zero mean rates
    #     where the ratio metric is meaningless — even an "MAE of 1
    #     per day" on a cleaning supply with mean usage 0.0007 is
    #     clearly broken.
    #
    # The first audit (May 2026) shipped 1.5×mean threshold; in
    # follow-up testing this still let Coffee Pods through (MAE 49.99
    # vs mean ~50, threshold 75 → passes). Tightened to 1.0×mean.
    # Shadow models skip this gate; the evaluate cron + promote path
    # re-checks before activation.
    if (
        is_active
        and validation_mae is not None
        and validation_mae >= max(mean_observed_rate * 1.0, 1.0)
    ):
        is_active = False
        mae_reject_notes = (
            f"rejected_high_mae: validation_mae={validation_mae:.4f} >= "
            f"threshold={max(mean_observed_rate * 1.0, 1.0):.4f} "
            f"(mean_rate={mean_observed_rate:.4f})"
        )

    # ── XGBoost-not-served gate (Codex audit pass-6 P0) ──────────────────
    # Inventory inference returns predicted=False for any active XGBoost
    # run because artifact deserialization isn't wired up yet. Activating
    # an XGBoost run would silently stop emitting per-day predictions for
    # the item the moment it crosses the 100-event activation threshold.
    # Force is_active=False (run still gets logged with metrics so we can
    # compare XGBoost vs Bayesian quality) until inference is ready.
    if is_active and algorithm == "xgboost-quantile" and not XGBOOST_INFERENCE_READY:
        is_active = False
        mae_reject_notes = (
            (mae_reject_notes + "; " if mae_reject_notes else "")
            + "rejected_xgboost_inference_unavailable: XGBoost graduates "
              "but inference can't deserialize the artifact yet"
        )

    # Posterior params for Bayesian models (so inference can rebuild without the model file)
    posterior_params = None
    if algorithm == "bayesian":
        posterior_params = {
            "mu_n": model.mu_n.tolist() if model.mu_n is not None else None,
            "sigma_n": model.sigma_n.tolist() if model.sigma_n is not None else None,
            "alpha_n": float(model.alpha_n) if model.alpha_n is not None else None,
            "beta_n": float(model.beta_n) if model.beta_n is not None else None,
            "mu_0": model.mu_0.tolist() if model.mu_0 is not None else None,
            "sigma_0": model.sigma_0.tolist() if model.sigma_0 is not None else None,
            "alpha": float(model.alpha),
            "beta": float(model.beta),
            "feature_names": model.feature_names,
        }

    # Deactivate the prior run in the same "slot" so the partial-unique
    # indexes added in migration 0072 hold:
    #   - if this run becomes active: clear the previous active for this
    #     (property, item).
    #   - if this run becomes a shadow: clear any in-flight shadow that
    #     hasn't yet been evaluated/promoted (a senior-review bug —
    #     without this, weekly retrains would accumulate shadows
    #     indefinitely because shadow_promoted_at stays null until the
    #     evaluate cron decides their fate).
    try:
        if is_active:
            client.client.table("model_runs").update({
                "is_active": False,
                "deactivated_at": datetime.utcnow().isoformat(),
                "deactivation_reason": "superseded",
            }).eq("property_id", property_id).eq("layer", "inventory_rate") \
              .eq("item_id", item_id).eq("is_active", True).execute()
        elif is_shadow:
            client.client.table("model_runs").update({
                "is_shadow": False,
                "is_active": False,
                "deactivated_at": datetime.utcnow().isoformat(),
                "deactivation_reason": "superseded_by_new_shadow",
            }).eq("property_id", property_id).eq("layer", "inventory_rate") \
              .eq("item_id", item_id).eq("is_shadow", True) \
              .is_("shadow_promoted_at", "null").execute()
    except Exception as e:
        # Best-effort; partial-unique-index will reject the new insert if needed.
        # But log loudly — May 2026 audit pass-5 found this exception was
        # silently swallowed. If deactivation fails (DB lock contention,
        # transient connection drop), the subsequent insert collides
        # with the partial unique index and the model_run is never
        # written. Operator sees "training succeeded" in logs while the
        # row was actually lost. Structured-print so Railway/Sentry
        # ingest can index it (matches the advisory_lock pattern).
        print(json.dumps({
            "evt": "model_run_deactivate_failed",
            "layer": "inventory_rate",
            "property_id": property_id,
            "item_id": item_id,
            "is_active": is_active,
            "is_shadow": is_shadow,
            "error": str(e),
        }))

    model_run = client.insert("model_runs", {
        "property_id": property_id,
        "layer": "inventory_rate",
        "item_id": item_id,
        "trained_at": datetime.utcnow().isoformat(),
        "training_row_count": len(df),
        "feature_set_version": "v1",
        "model_version": model_version,
        "algorithm": algorithm,
        "training_mae": training_mae,
        "validation_mae": validation_mae,
        "baseline_mae": baseline_mae,
        "beats_baseline_pct": beats_baseline_pct,
        "validation_holdout_n": len(X_test),
        "is_active": is_active,
        "is_shadow": is_shadow,
        "shadow_started_at": shadow_started_at,
        "activated_at": datetime.utcnow().isoformat() if is_active else None,
        "consecutive_passing_runs": consecutive_passes,
        "auto_fill_enabled": auto_fill_enabled if is_active else False,
        "auto_fill_enabled_at": datetime.utcnow().isoformat() if auto_fill_enabled else None,
        "posterior_params": json.dumps(posterior_params) if posterior_params else None,
        "hyperparameters": json.dumps({"prior_rate_used": prior_rate, "cohort_key": cohort_key,
                                       **(model.get_config() if hasattr(model, "get_config") else {})}),
        "notes": mae_reject_notes,
    })

    return {
        "skipped": False,
        "model_run_id": model_run.get("id"),
        "is_active": is_active,
        "auto_fill_enabled": auto_fill_enabled,
        "validation_mae": validation_mae,
        "training_row_count": len(df),
    }


def _build_training_rows(
    counts: List[Dict[str, Any]],
    orders: List[Dict[str, Any]],
    discards: List[Dict[str, Any]],
    daily_logs: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Compute (daily_rate, occupancy_pct) for each consecutive pair of counts.

    daily_rate = (prev.counted + orders_between - discards_between - this.counted) / days_elapsed
    """
    if len(counts) < 2:
        return []

    # Index orders + discards by date for fast range filtering.
    rows: List[Dict[str, Any]] = []
    for i in range(1, len(counts)):
        prev = counts[i - 1]
        curr = counts[i]
        try:
            t_prev = pd.to_datetime(prev["counted_at"]).tz_localize(None)
            t_curr = pd.to_datetime(curr["counted_at"]).tz_localize(None)
        except Exception:
            continue
        days_elapsed = max((t_curr - t_prev).total_seconds() / 86400.0, 0.5)

        # Codex post-merge review 2026-05-13 (N1): use `received_at` (NOT NULL,
        # defaults now() per migration 0026:96), NOT `ordered_at` (nullable —
        # "when PO was placed, often unknown"). The previous code filtered by
        # `ordered_at` so any order without a recorded PO date silently fell
        # out of the consumption window math, inflating the per-property
        # daily-rate target 30–80%. All three consumers of "orders in window"
        # (this Python trainer, inventory_priors.py cohort SQL, the
        # inventory_observed_rate_v view) now use `received_at` consistently.
        orders_between = sum(
            float(o.get("quantity") or 0)
            for o in orders
            if pd.to_datetime(o.get("received_at")).tz_localize(None) > t_prev
            and pd.to_datetime(o.get("received_at")).tz_localize(None) <= t_curr
        )
        # Discards use `discarded_at` (NOT NULL, defaults now() per migration
        # 0061:71). The previous code used `created_at` which is also NOT
        # NULL — same value semantically — but `discarded_at` matches the
        # other consumers (inventory_priors uses `created_at` aliased as
        # `discarded_at` in 0061; both are now-defaulted). Keep
        # `discarded_at` for consistency with the SQL view.
        discards_between = sum(
            float(d.get("quantity") or 0)
            for d in discards
            if pd.to_datetime(d.get("discarded_at") or d.get("created_at")).tz_localize(None) > t_prev
            and pd.to_datetime(d.get("discarded_at") or d.get("created_at")).tz_localize(None) <= t_curr
        )

        consumption = (
            float(prev.get("counted_stock") or 0)
            + orders_between
            - discards_between
            - float(curr.get("counted_stock") or 0)
        )
        # Allow negative consumption (overcounting / inventory found) but cap at 0
        # so downstream stats aren't skewed by data-entry errors.
        consumption = max(consumption, 0.0)
        daily_rate = consumption / days_elapsed

        # Average occupancy over the window (best-effort)
        occ_pct = _avg_occupancy_in_window(daily_logs, t_prev, t_curr)

        rows.append({
            "date": t_curr.date().isoformat(),
            "daily_rate": daily_rate,
            "occupancy_pct": occ_pct,
            "days_elapsed": days_elapsed,
        })
    return rows


def _avg_occupancy_in_window(
    daily_logs: List[Dict[str, Any]],
    t_start: pd.Timestamp,
    t_end: pd.Timestamp,
) -> float:
    """Average occupancy_pct from daily_logs between two timestamps. Defaults to 50.0
    if no logs match (the model handles a constant-feature column gracefully)."""
    if not daily_logs:
        return 50.0
    matched: List[float] = []
    start_d = t_start.date()
    end_d = t_end.date()
    for log in daily_logs:
        ld = log.get("date")  # daily_logs.date — see fetch_many call above
        if not ld:
            continue
        try:
            ld_parsed = pd.to_datetime(ld).date()
        except Exception:
            continue
        if start_d <= ld_parsed <= end_d:
            occ = log.get("occupancy_pct")
            if occ is not None:
                matched.append(float(occ))
    return sum(matched) / len(matched) if matched else 50.0


def _lookup_prior(client, cohort_key: str, item: Dict[str, Any], item_name: str) -> tuple:
    """Look up (rate, strength) for cohort → fall back to 'global' → default.

    Returns (prior_rate_per_room_per_day, prior_strength). When no row matches,
    falls back to DEFAULT_GLOBAL_RATE_PER_ROOM_PER_DAY with a weak strength=1.0.
    """
    rate, strength, _source = _lookup_prior_with_source(client, cohort_key, item, item_name)
    return (rate, strength)


def _lookup_prior_with_source(
    client, cohort_key: str, item: Dict[str, Any], item_name: str
) -> tuple:
    """Same as `_lookup_prior` but also returns a third element, `source`, which
    is one of:

        - "cohort"  : matched a cohort-specific row in inventory_rate_priors
        - "global"  : matched the global-tier row
        - "default" : nothing matched; the returned rate is the hardcoded
                      DEFAULT_GLOBAL_RATE_PER_ROOM_PER_DAY constant — i.e. we
                      have NO real cross-hotel signal for this item.

    Cold-start callers should only trust "cohort" or "global" sources; the
    default is meaningless as a network-derived prior (it's just a number we
    picked for "we don't know yet").
    """
    # Resolve canonical name for this item
    try:
        canonical_rows = client.fetch_many(
            "item_canonical_name_view",
            filters={"item_id": item["id"]},
            limit=1,
        )
        canonical_name = (
            canonical_rows[0]["item_canonical_name"]
            if canonical_rows else "unknown"
        )
    except Exception:
        canonical_name = "unknown"

    if canonical_name == "unknown":
        return (DEFAULT_GLOBAL_RATE_PER_ROOM_PER_DAY, 1.0, "default")

    # Try cohort-specific prior first, then global
    for ckey in (cohort_key, "global"):
        rows = client.fetch_many(
            "inventory_rate_priors",
            filters={"cohort_key": ckey, "item_canonical_name": canonical_name},
            limit=1,
        )
        if rows:
            row = rows[0]
            rate = float(row.get("prior_rate_per_room_per_day") or DEFAULT_GLOBAL_RATE_PER_ROOM_PER_DAY)
            strength = float(row.get("prior_strength") or 1.0)
            source = "cohort" if ckey == cohort_key else "global"
            return (rate, strength, source)

    return (DEFAULT_GLOBAL_RATE_PER_ROOM_PER_DAY, 1.0, "default")


def _create_cold_start_model_run(
    *,
    client,
    property_id: str,
    property_meta: Dict[str, Any],
    item: Dict[str, Any],
    cohort_key: str,
    prior_rate: float,
    prior_strength: float,
    prior_source: str,
    events_observed: int,
) -> Dict[str, Any]:
    """Persist a model_runs row that uses a cohort prior directly, no fit.

    Bayesian cold-start for new hotels (Tier 2 Phase 4). On Day 1 a property
    has zero count events for any item, so the real training path skips and
    inventory predictions never get generated — Maria sees empty boxes
    instead of useful starting estimates. This bypass writes a low-
    confidence "we don't know yet, but the network says ~X/day" prediction
    so the cockpit + Count Mode autofill have something to show.

    The row uses algorithm='cold-start-cohort-prior'; inference reads it
    via the same model_runs.is_active=True query and produces predictions
    from posterior_params.cohort_prior_rate * room_count, adjusted by
    occupancy. No graduation gate: this model never auto-fills, only
    suggests. As soon as the real Bayesian fit becomes possible (≥3 count
    events on next weekly retrain), it supersedes this row.
    """
    item_id = item["id"]
    # Phase 3.3 (2026-05-13): raise instead of silent 60-room fallback;
    # the outer cron boundary turns this into a logged skip event.
    room_count = require_total_rooms(property_meta, property_id)
    posterior_params = {
        "cohort_prior_rate": prior_rate,           # per-room per-day
        "cohort_prior_strength": prior_strength,
        "room_count": room_count,
        "prior_source": prior_source,              # 'cohort' or 'global'
        "cohort_key": cohort_key,
    }

    # Codex adversarial review 2026-05-13 (M-C8): the prior implementation
    # did deactivate-then-insert as TWO separate Supabase calls with NO
    # is_shadow filter and NO atomicity. Three real bugs:
    #   1. A graduated shadow being soaked got killed alongside the prior
    #      active (no is_shadow=False filter on deactivation).
    #   2. Two concurrent trainings could both insert is_active=true.
    #   3. Cold-start could clobber a real graduated model if the gate
    #      condition flipped back to "insufficient data" later.
    # The staxis_install_cold_start_model_run RPC (migration 0086) does
    # both writes in one transaction under an advisory lock, refuses to
    # clobber a real graduated model, and skips is_shadow=true rows.
    #
    # Codex follow-up 2026-05-13 (B5): TWO layers of locking apply here:
    #   1. The Python outer advisory_lock at training/inventory_rate.py:124
    #      serializes all training runs for the same property (lock key
    #      based on (property_id, "inventory_rate")).
    #   2. The RPC's own pg_advisory_xact_lock serializes per (property,
    #      item) — distinct lock space because the SQL key is built from
    #      'inventory_cold_start:' || property_id || ':' || item_id.
    # Defense in depth — direct RPC callers from outside the training
    # path (none today, but possible for ad-hoc backfills) still get the
    # per-item lock without relying on the outer property lock.
    posterior_json = json.dumps(posterior_params)
    hyperparams_json = json.dumps({
        "prior_rate_used": prior_rate,
        "cohort_key": cohort_key,
        "prior_source": prior_source,
        "events_observed": events_observed,
    })
    model_version = (
        f"inventory-cold-start-v1-{item_id}-{datetime.utcnow().isoformat()}"
    )
    try:
        rpc_result = client.client.rpc(
            "staxis_install_cold_start_model_run",
            {
                "p_property_id": property_id,
                "p_item_id": item_id,
                "p_model_version": model_version,
                "p_posterior_params": json.loads(posterior_json),
                "p_hyperparameters": json.loads(hyperparams_json),
            },
        ).execute()
        rows = rpc_result.data or []
        row = rows[0] if isinstance(rows, list) and rows else (rows or {})
        if not row.get("ok"):
            # 'graduated_model_active' is the expected refusal — log info, not error.
            print(json.dumps({
                "level": "info",
                "event": "cold_start_skipped",
                "property_id": property_id,
                "item_id": item_id,
                "reason": row.get("reason"),
                "ts": datetime.utcnow().isoformat(),
            }))
            return {}
        return {
            "id": row.get("model_run_id"),
            "property_id": property_id,
            "item_id": item_id,
            "algorithm": "cold-start-cohort-prior",
            "is_active": True,
        }
    except Exception as exc:
        print(json.dumps({
            "level": "error",
            "event": "cold_start_rpc_failed",
            "property_id": property_id,
            "item_id": item_id,
            "err": repr(exc),
            "ts": datetime.utcnow().isoformat(),
        }))
        return {}


def _seed_bayesian_intercept(model: BayesianRegression, prior_rate: float, room_count: int) -> None:
    """Override BayesianRegression's default mu_0[0]=60.0 with our cohort prior.

    BayesianRegression initializes mu_0 lazily inside fit(). The intercept's
    prior mean should match the units of the target — which is total daily
    consumption (units of the item / day). prior_rate is per-room-per-day,
    so we multiply by the property's total_rooms to get the absolute
    expected daily consumption.

    Why patch the method instead of editing mu_0 directly: BayesianRegression
    only knows X.shape inside _initialize_prior, so we have to wait until
    fit() is called. Wrapping the method runs our override AFTER the parent
    has set up the right-shaped mu_0 array.
    """
    original = model._initialize_prior

    def patched(X: pd.DataFrame) -> None:
        original(X)
        n_features = X.shape[1]
        if model.mu_0 is None or n_features == 0:
            return
        model.mu_0[0] = prior_rate * float(max(room_count, 1))

    model._initialize_prior = patched  # type: ignore[assignment]
