"""Training pipeline for the inventory_rate ML layer.

Operates per (property × item). Each item is routed to one of two model FAMILIES
(training/_item_family.route_item_family):

  • EXPOSURE family (guest-consumable amenities/linens/breakfast/paper) — the
    REDUCED EXPOSURE MODEL (2026-07-05 rebuild, from the 4-way review):
        window_consumption = s · (ΣCheckouts + κ · ΣStayovers) + ε
    s is the ONE learned coefficient (per-checkout usage scale), fit with the
    conjugate BayesianRegression on the single composite regressor
    x = ΣCO + κ·ΣSO (no intercept — base fixed at 0). κ is FIXED per item from
    its usage_per_stayover / usage_per_checkout config (fallback 0.30), NOT
    learned — a free 2-coefficient (checkout, stayover) split is unidentifiable
    at N=10-30 because the checkout/stayover mix barely varies (collinearity).
    Exposure sums come from daily_logs.checkouts/stayovers over each count
    window; a window is dropped if any day's checkouts/stayovers is NULL.

  • OCCUPANCY family (public-area / staff items whose usage is occupancy-
    INDEPENDENT — bulbs, batteries, cleaning chemicals, office/lobby) — keeps the
    LEGACY affine occupancy model daily_rate = a + b·(occupancy − baseline).

GRADUATION (flips auto_fill_enabled=true) now uses PROSPECTIVE evidence from
prediction_log (genuinely out-of-sample predicted-vs-actual pairs written when a
manager counts) instead of the old retrain-streak. See training/_prospective_gate.
An item graduates when it has ≥15 clean training windows AND ≥8 prospective pairs
spanning ≥14 days AND prospective WAPE < 0.30 AND it beats the cohort-prior
baseline's MAE on those pairs.

We do NOT block training at 3–5 events — the conjugate prior gives meaningful (if
low-confidence) predictions even at N=3, which feed the reorder list invisibly;
graduation is what gates auto-fill trust. The inventory XGBoost branch was removed
in the rebuild (a single-regressor Bayesian fit at N=10-30 can't be improved by
XGBoost).
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
from src.config import (
    INVENTORY_DEFAULT_KAPPA,
    INVENTORY_EXPOSURE_ALGORITHM,
    INVENTORY_EXPOSURE_FEATURE_SET_VERSION,
    INVENTORY_FEATURE_SET_VERSION,
    INVENTORY_OCC_BASELINE_PCT,
    get_settings,
)
from src.errors import PropertyMisconfiguredError, require_total_rooms
from src.layers.bayesian_regression import BayesianRegression
from src.supabase_client import get_supabase_client
from src.training._exposure import build_exposure_rows, compose_exposure
from src.training._gates import should_force_deactivate
from src.training._item_family import resolve_kappa, route_item_family
from src.training._prospective_gate import (
    ProspectivePair,
    evaluate_prospective_gate,
    parse_operational_date,
)


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
    blocking_lock: bool = True,
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
            # Plan v2 F-AI-4: HTTP endpoints pass blocking_lock=False so
            # cron misfires return 409 instead of stacking blocked
            # connections behind a running train.
            with advisory_lock(lock_conn, property_id, "inventory_rate", blocking=blocking_lock) as acquired:
                if not acquired:
                    print(json.dumps({
                        "evt": "training_already_running",
                        "layer": "inventory_rate", "property_id": property_id,
                    }))
                    return {
                        "status": "already_running",
                        "items_trained": 0,
                        "items_skipped_insufficient_data": 0,
                        "items_with_active_model": 0,
                        "items_with_auto_fill": 0,
                        "errors": [],
                        "error": "training_already_running",
                    }
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
            "value": exc.printable_value,
        }))
        return {
            "items_trained": 0,
            "items_skipped_insufficient_data": 0,
            "items_with_active_model": 0,
            "items_with_auto_fill": 0,
            "errors": [],
            "error": f"property_misconfigured: {exc.field}={exc.printable_value}",
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
    items_exposure_family = 0
    items_occupancy_family = 0
    windows_dropped_incomplete = 0
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
            windows_dropped_incomplete += int(result.get("windows_dropped_incomplete") or 0)
            fam = result.get("family")
            if fam == "exposure":
                items_exposure_family += 1
            elif fam == "occupancy":
                items_occupancy_family += 1
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
        "items_exposure_family": items_exposure_family,
        "items_occupancy_family": items_occupancy_family,
        "windows_dropped_incomplete": windows_dropped_incomplete,
        "errors": errors,
    }


def _center_occupancy(X: pd.DataFrame) -> pd.DataFrame:
    """Center the occupancy feature on the shared baseline (single source of
    truth for the train-side transform). The Bayesian posterior is therefore
    learned in centered space; inference MUST center on the same constant in
    `_predict_bayesian_quantiles` or train/serve will skew. Mutates + returns X.
    """
    X["occupancy_pct"] = X["occupancy_pct"] - INVENTORY_OCC_BASELINE_PCT
    return X


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


def _resolve_canonical_name(client, item: Dict[str, Any]) -> str:
    """Resolve the item's canonical bucket via item_canonical_name_view."""
    try:
        canonical_rows = client.fetch_many(
            "item_canonical_name_view",
            filters={"item_id": item["id"]},
            limit=1,
        )
        return (
            canonical_rows[0]["item_canonical_name"]
            if canonical_rows else "unknown"
        )
    except Exception:
        return "unknown"


def _train_single_item(
    property_id: str,
    property_meta: Dict[str, Any],
    item: Dict[str, Any],
    cohort_key: str,
    settings,
    client,
) -> Dict[str, Any]:
    """Train one (property, item) model, routed by item family.

    Guest-consumable items (amenities/linens/breakfast/paper) use the REDUCED
    EXPOSURE model (window_consumption = s·(ΣCO + κ·ΣSO)). Occupancy-independent
    public-area / staff items (bulbs, batteries, cleaning chemicals) keep the
    LEGACY affine occupancy model. See training/_item_family.route_item_family.
    """
    item_id = item["id"]
    item_name = item["name"]

    canonical_name = _resolve_canonical_name(client, item)
    family = route_item_family(item, canonical_name)

    # Pull all count events for this item, ordered by date.
    counts = client.fetch_many(
        "inventory_counts",
        filters={"property_id": property_id, "item_id": item_id},
        order_by="counted_at",
        descending=False,
        limit=2000,
    )

    # Cold-start fast path (both families). When the hotel has too few counts
    # for a real fit, seed predictions from a cohort/global prior so Maria sees
    # autofill from Day 1 instead of empty boxes. Only fires when the item
    # resolves to a canonical name with a real cross-hotel prior row.
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
                "family": family,
            }
        return {"skipped": True, "reason": "insufficient_count_events",
                "events": len(counts), "family": family}

    # Shared data pulls for both families.
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
    # daily_logs carries occupied (occupancy family) AND checkouts/stayovers
    # (exposure family). fetch_many selects '*' so all columns arrive.
    daily_logs = client.fetch_many(
        "daily_logs",
        filters={"property_id": property_id},
        order_by="date",
        descending=True,
        limit=400,
    )

    total_rooms = require_total_rooms(property_meta, property_id)

    if family == "exposure":
        return _train_exposure_item(
            property_id=property_id,
            item=item,
            item_id=item_id,
            item_name=item_name,
            canonical_name=canonical_name,
            cohort_key=cohort_key,
            counts=counts,
            orders=orders,
            discards=discards,
            daily_logs=daily_logs,
            total_rooms=total_rooms,
            settings=settings,
            client=client,
        )
    return _train_occupancy_item(
        property_id=property_id,
        item=item,
        item_id=item_id,
        item_name=item_name,
        cohort_key=cohort_key,
        counts=counts,
        orders=orders,
        discards=discards,
        daily_logs=daily_logs,
        total_rooms=total_rooms,
        settings=settings,
        client=client,
    )


def _existing_graduated_active(client, property_id: str, item_id: str) -> bool:
    """True if a graduated (auto_fill_enabled) active model already serves this
    (property, item) — used to route a retrain into the shadow track."""
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
    return bool(
        existing_active_rows
        and existing_active_rows[0].get("auto_fill_enabled")
    )


def _install_inventory_run(
    client, property_id: str, item_id: str, fields: Dict[str, Any],
    is_active: bool, is_shadow: bool,
) -> Dict[str, Any]:
    """Atomic deactivate-then-insert via the migration 0110 RPC. Returns the
    trainer result dict (or a skip dict on RPC refusal)."""
    rpc_result = client.client.rpc(
        "staxis_install_inventory_model_run",
        {
            "p_property_id": property_id,
            "p_item_id": item_id,
            "p_fields": fields,
            "p_should_activate": is_active,
            "p_should_shadow": is_shadow,
        },
    ).execute()
    rows = rpc_result.data or []
    row = rows[0] if isinstance(rows, list) and rows else (rows or {})
    if not row.get("ok"):
        print(json.dumps({
            "evt": "inventory_model_install_refused",
            "layer": "inventory_rate",
            "property_id": property_id,
            "item_id": item_id,
            "reason": row.get("reason"),
        }))
        return {
            "skipped": True,
            "reason": f"model_install_refused: {row.get('reason', 'unknown')}",
        }
    return {"skipped": False, "model_run_id": row.get("model_run_id")}


def _train_exposure_item(
    *,
    property_id, item, item_id, item_name, canonical_name, cohort_key,
    counts, orders, discards, daily_logs, total_rooms, settings, client,
) -> Dict[str, Any]:
    """Reduced-exposure fit: window_consumption = s·(ΣCO + κ·ΣSO), no intercept.

    s is the ONE learned coefficient. κ is fixed per item from its usage config.
    The BayesianRegression fits a single-coefficient posterior on the composite
    exposure regressor, with per-row weights that down-weight long/noisy windows.
    """
    # κ fixed per item (usage_per_stayover / usage_per_checkout; fallback 0.30).
    kappa = resolve_kappa(item, INVENTORY_DEFAULT_KAPPA)

    rows, n_dropped_incomplete = build_exposure_rows(
        counts, orders, discards, daily_logs, kappa,
        settings.inventory_daily_process_var, settings.inventory_count_noise,
    )
    if len(rows) < settings.inventory_min_events_per_item - 1:
        return {"skipped": True, "reason": "insufficient_exposure_windows",
                "pairs": len(rows), "family": "exposure",
                "windows_dropped_incomplete": n_dropped_incomplete}

    df = pd.DataFrame(rows)
    df["consumption"] = pd.to_numeric(df["consumption"], errors="coerce")
    df["exposure"] = pd.to_numeric(df["exposure"], errors="coerce")
    df = df[
        df["consumption"].notna() & (df["consumption"] >= 0)
        & df["exposure"].notna() & (df["exposure"] > 0)
    ].reset_index(drop=True)
    if len(df) < settings.inventory_min_events_per_item - 1:
        return {"skipped": True, "reason": "insufficient_clean_exposure_rows",
                "rows": len(df), "family": "exposure",
                "windows_dropped_incomplete": n_dropped_incomplete}

    # Exposure prior for s (per-checkout-equivalent). Falls back to converting a
    # per-room prior. prior_strength schedule as before, but precision-capped.
    prior_s, prior_strength, prior_source = _lookup_exposure_prior_with_source(
        client, cohort_key, item, canonical_name
    )

    # Design: [intercept, exposure]; target = consumption. The review specifies
    # NO real intercept ("base fixed at 0") for guest consumables. We keep an
    # intercept COLUMN — because BayesianRegression's serving path assumes column
    # 0 is the all-ones bias and injecting/omitting it via a heuristic is fragile
    # — but PIN it at 0 with a near-zero prior variance so it can't absorb signal.
    # The learned coefficient is s (the second one); base stays ≈0. The pin gives
    # exactly the reduced model window_consumption ≈ s·(ΣCO + κ·ΣSO).
    X = df[["exposure"]].astype(float).copy()
    X.insert(0, "intercept", 1.0)
    y = df["consumption"].astype(float)
    weights = df["weight"].astype(float).values

    if len(X) >= 5:
        split_idx = int(len(X) * 0.8)
        X_train, X_test = X.iloc[:split_idx], X.iloc[split_idx:]
        y_train, y_test = y.iloc[:split_idx], y.iloc[split_idx:]
        w_train = weights[:split_idx]
    else:
        X_train, X_test = X, X.iloc[:0]
        y_train, y_test = y, y.iloc[:0]
        w_train = weights

    # Prior per coefficient:
    #   intercept (base): mean 0, variance ~1e-6 → pinned at 0 (no free base).
    #   s (exposure scale): mean prior_s, variance 1/prior_strength → a hotel
    #     with real windows moves s off the cohort seed; stronger cohort (larger
    #     prior_strength) shrinks harder toward the seed at cold-start.
    model = BayesianRegression(
        prior_strength=prior_strength,
        prior_mean=np.array([0.0, prior_s]),
        prior_variance=np.array([1e-6, 1.0 / max(prior_strength, 1e-6)]),
    )
    model.fit(X_train, y_train, sample_weight=w_train)
    model_version = f"inventory-exposure-v1-{item_id}-{datetime.utcnow().isoformat()}"
    algorithm = INVENTORY_EXPOSURE_ALGORITHM

    # Metrics (window-consumption units).
    if len(X_test) > 0:
        pred_test = model.predict(X_test)
        validation_mae = float(np.mean(np.abs(pred_test - y_test.values)))
    else:
        validation_mae = 0.0
    training_mae = float(np.mean(np.abs(model.predict(X_train) - y_train.values)))

    # Baseline = the cohort-prior s applied to the same exposures.
    if len(X_test) > 0:
        baseline_pred = prior_s * X_test["exposure"].values
        baseline_mae = float(np.mean(np.abs(baseline_pred - y_test.values)))
        mean_observed = float(y_test.mean())
    else:
        baseline_pred = prior_s * X_train["exposure"].values
        baseline_mae = float(np.mean(np.abs(baseline_pred - y_train.values)))
        mean_observed = float(y.mean())
    beats_baseline_pct = (
        float(max(0.0, (baseline_mae - validation_mae) / baseline_mae))
        if baseline_mae > 1e-9 else 0.0
    )

    trained_at_iso = datetime.utcnow().isoformat()

    # ── Prospective graduation gate ──────────────────────────────────────
    grad = _evaluate_inventory_graduation(
        client=client,
        property_id=property_id,
        item_id=item_id,
        n_training_windows=len(df),
        prior_s=prior_s,
        kappa=kappa,
        settings=settings,
    )
    auto_fill_candidate = grad.passed

    # Shadow routing: a retrain lands as shadow if a graduated active exists.
    is_shadow = _existing_graduated_active(client, property_id, item_id)
    is_active = not is_shadow
    shadow_started_at = trained_at_iso if is_shadow else None

    # Force-deactivate safety gates (no-validation-set + max-MAE). XGBoost gate
    # is unreachable (algorithm is bayesian-exposure) but harmless.
    mae_reject_notes: Optional[str] = None
    _force_deactivate, _gate_note = should_force_deactivate(
        algorithm=algorithm,
        xgboost_inference_ready=False,
        is_currently_active=is_active,
        validation_holdout_n=len(X_test),
        validation_mae=validation_mae,
        mean_observed_rate=mean_observed,
        training_row_count=len(X_train),
    )
    if _force_deactivate:
        is_active = False
        mae_reject_notes = _gate_note

    auto_fill_enabled = auto_fill_candidate and is_active

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
        # Serving needs κ to recompose tomorrow's exposure.
        "kappa": kappa,
        "family": "exposure",
    }

    fields = {
        "trained_at": trained_at_iso,
        "training_row_count": len(df),
        "feature_set_version": INVENTORY_EXPOSURE_FEATURE_SET_VERSION,
        "model_version": model_version,
        "algorithm": algorithm,
        "training_mae": training_mae,
        "validation_mae": validation_mae,
        "baseline_mae": baseline_mae,
        "beats_baseline_pct": beats_baseline_pct,
        "validation_holdout_n": len(X_test),
        "shadow_started_at": shadow_started_at,
        "consecutive_passing_runs": 0,  # streak retired; kept for column parity
        "auto_fill_enabled": auto_fill_enabled if is_active else False,
        "posterior_params": posterior_params,
        "hyperparameters": {
            "prior_s_used": prior_s,
            "prior_source": prior_source,
            "kappa": kappa,
            "cohort_key": cohort_key,
            "mean_observed_rate": mean_observed,
            "windows_dropped_incomplete": n_dropped_incomplete,
            "graduation_reason": grad.reason,
            "graduation_n_pairs": grad.n_pairs,
            "graduation_span_days": grad.span_days,
            "graduation_wape": grad.wape,
            "graduation_prospective_mae": grad.prospective_mae,
            "graduation_baseline_mae": grad.baseline_mae,
            **(model.get_config() if hasattr(model, "get_config") else {}),
        },
        "notes": mae_reject_notes,
    }
    install = _install_inventory_run(
        client, property_id, item_id, fields, is_active, is_shadow
    )
    install["family"] = "exposure"
    install["windows_dropped_incomplete"] = n_dropped_incomplete
    if install.get("skipped"):
        return install

    # ── Shadow challenger (work item 6) ──────────────────────────────────
    # Keep training the OLD occupancy-form model for exposure-family items as a
    # SHADOW run so the existing shadow-evaluate cron can compare it against the
    # new exposure primary over time. LIMITATION (documented honestly): the
    # migration-0110 install RPC keys the shadow track by (property, item) and
    # allows exactly one active + one in-flight shadow per item. So we can only
    # register the occupancy-form shadow when the exposure run we just installed
    # is the ACTIVE one — if the exposure run itself landed as a shadow (because
    # a graduated active already serves this item), we skip the challenger this
    # cycle rather than clobber the exposure shadow. This matches the review's
    # "simplify: train occupancy-form as shadow only when an active exposure run
    # exists" fallback.
    if is_active:
        try:
            _train_occupancy_shadow_challenger(
                property_id=property_id, item=item, item_id=item_id,
                item_name=item_name, cohort_key=cohort_key, counts=counts,
                orders=orders, discards=discards, daily_logs=daily_logs,
                total_rooms=total_rooms, settings=settings, client=client,
            )
        except Exception as exc:  # never let the challenger fail the primary
            print(json.dumps({
                "evt": "inventory_shadow_challenger_failed",
                "property_id": property_id, "item_id": item_id,
                "error": str(exc),
            }))

    return {
        **install,
        "is_active": is_active,
        "auto_fill_enabled": auto_fill_enabled,
        "validation_mae": validation_mae,
        "training_row_count": len(df),
    }


def _train_occupancy_shadow_challenger(
    *,
    property_id, item, item_id, item_name, cohort_key,
    counts, orders, discards, daily_logs, total_rooms, settings, client,
) -> None:
    """Fit the legacy occupancy-form model and install it as a SHADOW run for an
    exposure-family item. Never auto_fill. Best-effort; failures are swallowed by
    the caller. Installed via p_should_shadow=true (the exposure primary stays
    active)."""
    rows = _build_training_rows(counts, orders, discards, daily_logs, total_rooms)
    if len(rows) < settings.inventory_min_events_per_item - 1:
        return
    df = pd.DataFrame(rows)
    df["daily_rate"] = pd.to_numeric(df["daily_rate"], errors="coerce")
    df["occupancy_pct"] = pd.to_numeric(df["occupancy_pct"], errors="coerce").fillna(INVENTORY_OCC_BASELINE_PCT)
    df = df[df["daily_rate"].notna() & (df["daily_rate"] >= 0)].reset_index(drop=True)
    if len(df) < settings.inventory_min_events_per_item - 1:
        return

    prior_rate, prior_strength = _lookup_prior(client, cohort_key, item, item_name)
    X = _center_occupancy(df[INVENTORY_FEATURE_COLS].copy())
    X.insert(0, "intercept", 1.0)
    y = df["daily_rate"].astype(float)
    if len(X) >= 5:
        split_idx = int(len(X) * 0.8)
        X_train, X_test = X.iloc[:split_idx], X.iloc[split_idx:]
        y_train, y_test = y.iloc[:split_idx], y.iloc[split_idx:]
    else:
        X_train, X_test = X, X.iloc[:0]
        y_train, y_test = y, y.iloc[:0]

    model = BayesianRegression(prior_strength=prior_strength)
    _seed_bayesian_intercept(model, prior_rate, total_rooms)
    model.fit(X_train, y_train)
    validation_mae = (
        float(np.mean(np.abs(model.predict(X_test) - y_test.values)))
        if len(X_test) > 0 else 0.0
    )
    training_mae = float(np.mean(np.abs(model.predict(X_train) - y_train.values)))
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
        "family": "occupancy",
    }
    fields = {
        "trained_at": datetime.utcnow().isoformat(),
        "training_row_count": len(df),
        "feature_set_version": INVENTORY_FEATURE_SET_VERSION,
        "model_version": f"inventory-bayesian-shadow-v1-{item_id}-{datetime.utcnow().isoformat()}",
        "algorithm": "bayesian",
        "training_mae": training_mae,
        "validation_mae": validation_mae,
        "baseline_mae": None,
        "beats_baseline_pct": 0.0,
        "validation_holdout_n": len(X_test),
        "shadow_started_at": datetime.utcnow().isoformat(),
        "consecutive_passing_runs": 0,
        "auto_fill_enabled": False,
        "posterior_params": posterior_params,
        "hyperparameters": {
            "prior_rate_used": prior_rate,
            "cohort_key": cohort_key,
            "shadow_challenger": True,
            **(model.get_config() if hasattr(model, "get_config") else {}),
        },
        "notes": "occupancy-form shadow challenger vs exposure primary",
    }
    _install_inventory_run(
        client, property_id, item_id, fields, is_active=False, is_shadow=True
    )


def _train_occupancy_item(
    *,
    property_id, item, item_id, item_name, cohort_key,
    counts, orders, discards, daily_logs, total_rooms, settings, client,
) -> Dict[str, Any]:
    """LEGACY affine occupancy model for occupancy-independent public-area /
    staff items: daily_rate = a + b·(occupancy − baseline). Unchanged behavior
    from the pre-rebuild model (minus the dead XGBoost branch + retrain streak),
    now scoped to the occupancy family only.
    """
    rows = _build_training_rows(counts, orders, discards, daily_logs, total_rooms)
    if len(rows) < settings.inventory_min_events_per_item - 1:
        return {"skipped": True, "reason": "insufficient_consecutive_pairs",
                "pairs": len(rows), "family": "occupancy"}

    df = pd.DataFrame(rows)
    df["daily_rate"] = pd.to_numeric(df["daily_rate"], errors="coerce")
    df["occupancy_pct"] = pd.to_numeric(df["occupancy_pct"], errors="coerce").fillna(INVENTORY_OCC_BASELINE_PCT)
    df = df[df["daily_rate"].notna() & (df["daily_rate"] >= 0)].reset_index(drop=True)
    if len(df) < settings.inventory_min_events_per_item - 1:
        return {"skipped": True, "reason": "insufficient_clean_rows",
                "rows": len(df), "family": "occupancy"}

    prior_rate, prior_strength = _lookup_prior(client, cohort_key, item, item_name)

    X = _center_occupancy(df[INVENTORY_FEATURE_COLS].copy())
    X.insert(0, "intercept", 1.0)
    y = df["daily_rate"].astype(float)

    if len(X) >= 5:
        split_idx = int(len(X) * 0.8)
        X_train, X_test = X.iloc[:split_idx], X.iloc[split_idx:]
        y_train, y_test = y.iloc[:split_idx], y.iloc[split_idx:]
    else:
        X_train, X_test = X, X.iloc[:0]
        y_train, y_test = y, y.iloc[:0]

    # Reduced-exposure rebuild removed the dead XGBoost branch — the occupancy
    # family is always the conjugate Bayesian fit.
    model = BayesianRegression(prior_strength=prior_strength)
    _seed_bayesian_intercept(model, prior_rate, total_rooms)
    model_version = f"inventory-bayesian-v1-{item_id}-{datetime.utcnow().isoformat()}"
    algorithm = "bayesian"

    model.fit(X_train, y_train)

    if len(X_test) > 0:
        pred_test = model.predict(X_test)
        validation_mae = float(np.mean(np.abs(pred_test - y_test.values)))
    else:
        validation_mae = 0.0
    training_mae = float(np.mean(np.abs(model.predict(X_train) - y_train.values)))

    baseline_rate_abs = prior_rate * float(max(total_rooms, 1))
    baseline_pred = np.full(len(y_test) if len(X_test) > 0 else len(y_train), baseline_rate_abs)
    if len(X_test) > 0:
        baseline_mae = float(np.mean(np.abs(baseline_pred - y_test.values)))
        mean_observed_rate = float(y_test.mean())
    else:
        baseline_mae = float(np.mean(np.abs(baseline_pred - y_train.values)))
        mean_observed_rate = float(y.mean())
    beats_baseline_pct = (
        float(max(0.0, (baseline_mae - validation_mae) / baseline_mae))
        if baseline_mae > 1e-9 else 0.0
    )

    trained_at_iso = datetime.utcnow().isoformat()

    # Occupancy family also graduates via the prospective gate now (streak
    # retired). n_training_windows = clean rows; baseline = per-room prior
    # applied via the exposure-agnostic MAE path (baseline s isn't defined for
    # occupancy items, so the prospective baseline uses the cohort per-room rate
    # scaled to total_rooms — computed inside _evaluate_inventory_graduation
    # falls back to prior_s=0 which makes the beat-baseline gate compare against
    # "predict 0"; for occupancy items we instead reuse the per-room baseline).
    grad = _evaluate_inventory_graduation(
        client=client,
        property_id=property_id,
        item_id=item_id,
        n_training_windows=len(df),
        prior_s=None,  # occupancy items have no per-checkout s; baseline via per-room
        kappa=None,
        settings=settings,
        occupancy_baseline_rate_abs=baseline_rate_abs,
    )
    auto_fill_candidate = grad.passed

    is_shadow = _existing_graduated_active(client, property_id, item_id)
    is_active = not is_shadow
    shadow_started_at = trained_at_iso if is_shadow else None

    mae_reject_notes: Optional[str] = None
    _force_deactivate, _gate_note = should_force_deactivate(
        algorithm=algorithm,
        xgboost_inference_ready=False,
        is_currently_active=is_active,
        validation_holdout_n=len(X_test),
        validation_mae=validation_mae,
        mean_observed_rate=mean_observed_rate,
        training_row_count=len(X_train),
    )
    if _force_deactivate:
        is_active = False
        mae_reject_notes = _gate_note

    auto_fill_enabled = auto_fill_candidate and is_active

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
        "family": "occupancy",
    }

    fields = {
        "trained_at": trained_at_iso,
        "training_row_count": len(df),
        "feature_set_version": INVENTORY_FEATURE_SET_VERSION,
        "model_version": model_version,
        "algorithm": algorithm,
        "training_mae": training_mae,
        "validation_mae": validation_mae,
        "baseline_mae": baseline_mae,
        "beats_baseline_pct": beats_baseline_pct,
        "validation_holdout_n": len(X_test),
        "shadow_started_at": shadow_started_at,
        "consecutive_passing_runs": 0,
        "auto_fill_enabled": auto_fill_enabled if is_active else False,
        "posterior_params": posterior_params,
        "hyperparameters": {
            "prior_rate_used": prior_rate,
            "cohort_key": cohort_key,
            "mean_observed_rate": mean_observed_rate,
            "graduation_reason": grad.reason,
            "graduation_n_pairs": grad.n_pairs,
            **(model.get_config() if hasattr(model, "get_config") else {}),
        },
        "notes": mae_reject_notes,
    }
    install = _install_inventory_run(
        client, property_id, item_id, fields, is_active, is_shadow
    )
    install["family"] = "occupancy"
    if install.get("skipped"):
        return install
    return {
        **install,
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
    total_rooms: int,
) -> List[Dict[str, Any]]:
    """Compute (daily_rate, occupancy_pct) for each consecutive pair of counts.

    daily_rate = (prev.counted + orders_between - discards_between - this.counted) / days_elapsed

    ``total_rooms`` converts each daily_logs ``occupied`` room count into an
    occupancy percentage for the window-average feature.
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
        days_elapsed = (t_curr - t_prev).total_seconds() / 86400.0
        # Skip sub-day pairs (same-day recounts / double-saves). The old
        # 0.5-day floor turned a 30-second recount into a 2x-inflated rate row.
        # The realized-rate view inventory_observed_rate_v (migration 0096) also
        # drops pairs with raw_days_elapsed < 1.0, so trainer + view agree on
        # the sub-day rule. NOTE: they do NOT yet fully agree — the view still
        # CLAMPS count-up / idle / restock windows to a 0 rate (greatest(...,0))
        # whereas the trainer now DROPS them. STAGED_INVENTORY_MIGRATIONS.md
        # migration A redefines the view to match (drop consumption <= 0 except
        # genuine zeros); until it is applied, the view over-feeds 0s into
        # prediction_log / shadow MAE.
        if days_elapsed < 1.0:
            continue

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

        prev_stock = float(prev.get("counted_stock") or 0)
        curr_stock = float(curr.get("counted_stock") or 0)
        raw_consumption = prev_stock + orders_between - discards_between - curr_stock
        # Keep windows with real consumption AND genuine zero-usage windows;
        # drop only the two contamination classes (instead of clamping them to
        # a fake 0-rate row that dilutes the fit):
        #   • raw_consumption < 0  → an unexplained stock INCREASE (a restock
        #     made outside the app, never logged as an order). Corrupt signal.
        #   • raw_consumption == 0 AND the count ROSE → the auto-logged
        #     "stock-up" order CountSheet writes on a surprise-high count
        #     (received_at == counted_at) forces prev + (curr−prev) − curr = 0.
        #     That window's real usage is masked by the restock.
        # A raw_consumption == 0 window where the count did NOT rise is GENUINE
        # zero usage (nothing used that period) — we KEEP it, otherwise
        # intermittently-used items (e.g. used 3 days a week) would be
        # over-estimated ~2x by learning burn-when-used instead of average burn.
        rose = curr_stock > prev_stock + 1e-9
        if raw_consumption < -1e-9 or (raw_consumption <= 1e-9 and rose):
            continue
        daily_rate = max(raw_consumption, 0.0) / days_elapsed

        # Average occupancy over the window (best-effort)
        occ_pct = _avg_occupancy_in_window(daily_logs, t_prev, t_curr, total_rooms)

        rows.append({
            "date": t_curr.date().isoformat(),
            "daily_rate": daily_rate,
            "occupancy_pct": occ_pct,
            "days_elapsed": days_elapsed,
        })
    return rows


def _occ_pct_from_log(log: Dict[str, Any], total_rooms_denom: float) -> Optional[float]:
    """Occupancy percentage (0-100) for one daily_logs row.

    The deployed ``daily_logs`` table has NO ``occupancy_pct`` column — only a
    raw ``occupied`` room count (migration 0001). Occupancy is therefore
    derived as ``100 * occupied / total_rooms``. A pre-computed
    ``occupancy_pct`` (should a future schema add one) takes precedence.
    Returns None when neither is usable so the caller can skip the row rather
    than fold a bogus value into the window average.
    """
    pct = log.get("occupancy_pct")
    if pct is not None:
        try:
            return max(0.0, min(100.0, float(pct)))
        except (TypeError, ValueError):
            pass
    occ = log.get("occupied")
    if occ is None:
        return None
    try:
        return max(0.0, min(100.0, 100.0 * float(occ) / total_rooms_denom))
    except (TypeError, ValueError):
        return None


def _avg_occupancy_in_window(
    daily_logs: List[Dict[str, Any]],
    t_start: pd.Timestamp,
    t_end: pd.Timestamp,
    total_rooms: int,
) -> float:
    """Average occupancy % from daily_logs over a count window.

    Occupancy is derived per row from ``occupied`` / ``total_rooms`` (see
    ``_occ_pct_from_log``). When NO usable log overlaps the window we return the
    centering BASELINE (``INVENTORY_OCC_BASELINE_PCT``), not 50.0: the feature is
    centered on the baseline before the fit, so an unknown-occupancy window must
    map to a centered value of 0 (contributing nothing to the slope). Returning
    50 here would feed the model a constant ``50 − 60 = −10`` and re-introduce
    the intercept/slope collinearity the centering removes.

    Day-window note: ``daily_logs.date`` is a DATE (operational-day bucket)
    while t_start/t_end are wall-clock count timestamps. We use the disjoint
    half-open day rule ``(start_d, end_d]`` so adjacent windows don't double-
    count a boundary day. Which boundary day a window claims is a ~1-day
    smoothing approximation that depends on the hotel's count time-of-day
    (morning vs end-of-shift); occupancy is autocorrelated so the effect is
    small either way. The old code read a non-existent ``occupancy_pct`` column,
    so every window collapsed to the default and occupancy was a dead feature.
    """
    if not daily_logs:
        return INVENTORY_OCC_BASELINE_PCT
    denom = float(max(int(total_rooms or 0), 1))
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
        if not (start_d < ld_parsed <= end_d):
            continue
        occ = _occ_pct_from_log(log, denom)
        if occ is not None:
            matched.append(occ)
    return sum(matched) / len(matched) if matched else INVENTORY_OCC_BASELINE_PCT


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


# ── Reduced-exposure prior lookup + precision cap ────────────────────────────

# Precision cap on the exposure prior strength. With 1-3 contributing hotels the
# between-hotel signal is noise (a single atypical hotel dominates the median),
# so the prior must not be allowed to overwhelm a real hotel's own windows. We
# cap the effective strength at ~1 hotel's worth of evidence. The existing
# 0.5/2.0/5.0 schedule stays as the CEILING SHAPE (bigger cohort → stronger
# prior), but until we have ≥4 hotels — enough to estimate the between-hotel
# variance for real empirical Bayes — we never exceed EXPOSURE_PRIOR_STRENGTH_CAP.
# DEFERRED: variance-based empirical-Bayes shrinkage once n_hotels >= 4.
EXPOSURE_PRIOR_STRENGTH_CAP = 0.5
EXPOSURE_EMPIRICAL_BAYES_MIN_HOTELS = 4

# Fallback conversion factor: if only the legacy per-room-per-day prior exists
# (no rate_per_checkout_eq yet), convert it to a per-checkout-equivalent s.
# Pragmatic mapping: at baseline occupancy a room contributes ~1 checkout-
# equivalent of exposure per stay-cycle, and a hotel of R rooms at ~60% occ
# turns over on the order of its room count over a typical multi-day count
# window. We approximate s ≈ prior_rate_per_room_per_day (units/room/day) since
# the exposure regressor sums checkouts+κ·stayovers which is ~room-scale per day;
# this is a rough seed only — a hotel's own windows dominate after a few counts.
# Documented as an approximation; the faithful producer path writes
# rate_per_checkout_eq directly.
LEGACY_PER_ROOM_TO_S_FACTOR = 1.0


def _lookup_exposure_prior_with_source(
    client, cohort_key: str, item: Dict[str, Any], canonical_name: str
) -> tuple:
    """Look up (prior_s, prior_strength, source) for the exposure coefficient s.

    Reads inventory_rate_priors.rate_per_checkout_eq (0294). Precision-capped so
    a sparse cohort can't overwhelm the hotel's own data. Falls back to
    converting the legacy prior_rate_per_room_per_day, then to a weak default.

    Returns:
      (prior_s, prior_strength, source) where source ∈
      {"cohort-exposure","global-exposure","cohort-perroom","global-perroom","default"}.
    """
    cn = str(canonical_name or "").strip().lower()
    if cn == "unknown" or cn == "":
        return (DEFAULT_GLOBAL_RATE_PER_ROOM_PER_DAY * LEGACY_PER_ROOM_TO_S_FACTOR,
                min(1.0, EXPOSURE_PRIOR_STRENGTH_CAP), "default")

    for ckey in (cohort_key, "global"):
        rows = client.fetch_many(
            "inventory_rate_priors",
            filters={"cohort_key": ckey, "item_canonical_name": cn},
            limit=1,
        )
        if not rows:
            continue
        row = rows[0]
        tier = "cohort" if ckey == cohort_key else "global"
        n_hotels = int(row.get("n_hotels") or row.get("n_hotels_contributing") or 0)
        raw_strength = float(row.get("prior_strength") or 1.0)
        # Precision cap: never exceed ~1 hotel's evidence until we can estimate
        # between-hotel variance (n_hotels >= 4). See constant docstring.
        if n_hotels < EXPOSURE_EMPIRICAL_BAYES_MIN_HOTELS:
            strength = min(raw_strength, EXPOSURE_PRIOR_STRENGTH_CAP)
        else:
            strength = raw_strength
        s_exposure = row.get("rate_per_checkout_eq")
        if s_exposure is not None:
            try:
                s_val = float(s_exposure)
                if s_val > 0:
                    return (s_val, strength, f"{tier}-exposure")
            except (TypeError, ValueError):
                pass
        # No exposure prior yet — convert the legacy per-room-per-day value.
        per_room = row.get("prior_rate_per_room_per_day")
        if per_room is not None:
            try:
                pr = float(per_room)
                if pr > 0:
                    return (pr * LEGACY_PER_ROOM_TO_S_FACTOR, strength, f"{tier}-perroom")
            except (TypeError, ValueError):
                pass

    return (DEFAULT_GLOBAL_RATE_PER_ROOM_PER_DAY * LEGACY_PER_ROOM_TO_S_FACTOR,
            min(1.0, EXPOSURE_PRIOR_STRENGTH_CAP), "default")


def _fetch_item_model_run_ids(client, property_id: str, item_id: str) -> List[str]:
    """All model_run ids for this (property, item) — used to scope prediction_log
    to this item (inventory prediction_log rows carry model_run_id, not a direct
    item_id column; see post-count-process/route.ts)."""
    runs = client.fetch_many(
        "model_runs",
        filters={"property_id": property_id, "layer": "inventory_rate", "item_id": item_id},
        order_by="trained_at",
        descending=True,
        limit=200,
    )
    return [str(r.get("id")) for r in (runs or []) if r.get("id")]


def _evaluate_inventory_graduation(
    *,
    client,
    property_id: str,
    item_id: str,
    n_training_windows: int,
    prior_s,
    kappa,
    settings,
    occupancy_baseline_rate_abs: Optional[float] = None,
):
    """Pull this item's prospective prediction_log pairs and run the pure gate.

    prediction_log inventory rows have no item_id column; they carry model_run_id
    (FK to model_runs, which IS per-item). We scope the pairs by this item's set
    of model_run ids. predicted_value / actual_value are the per-DAY rates the
    post-count-process route logged (predicted vs realized).

    The baseline each pair is compared against:
      • exposure family: prior_s (per-checkout-equivalent) — but prediction_log
        stores daily RATES, and we don't have per-pair exposure here, so we use
        the model's own predicted_value's implied baseline is not recoverable.
        Instead we use the cohort prior's *rate* proxy: for exposure items we
        approximate the baseline daily rate as prior_s (units per checkout-equiv)
        — a conservative floor. When prior_s is None (occupancy family), we use
        occupancy_baseline_rate_abs (the per-room prior scaled to total_rooms).
    """
    run_ids = set(_fetch_item_model_run_ids(client, property_id, item_id))
    log_rows = client.fetch_many(
        "prediction_log",
        filters={"property_id": property_id, "layer": "inventory_rate"},
        order_by="date",
        descending=True,
        limit=5000,
    )
    # Baseline daily-rate proxy per pair.
    if prior_s is not None:
        baseline_rate = float(prior_s)
    elif occupancy_baseline_rate_abs is not None:
        baseline_rate = float(occupancy_baseline_rate_abs)
    else:
        baseline_rate = 0.0

    pairs: List[ProspectivePair] = []
    for row in log_rows or []:
        mr = row.get("model_run_id")
        if run_ids and str(mr) not in run_ids:
            continue
        pv = row.get("predicted_value")
        av = row.get("actual_value")
        if pv is None or av is None:
            continue
        d = parse_operational_date(row.get("date"))
        if d is None:
            continue
        try:
            pairs.append(ProspectivePair(
                predicted=float(pv),
                actual=float(av),
                when=d,
                baseline=baseline_rate,
            ))
        except (TypeError, ValueError):
            continue

    return evaluate_prospective_gate(
        n_training_windows=n_training_windows,
        pairs=pairs,
        min_training_windows=settings.inventory_graduation_min_events,
        min_pairs=settings.inventory_graduation_min_prospective_pairs,
        span_days=settings.inventory_graduation_prospective_span_days,
        wape_threshold=settings.inventory_graduation_prospective_wape,
    )


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
