"""Realized-MAE backtest for the inventory_rate ML layer.

Reads `prediction_log` (predicted vs. observed pairs written by the
post-count-process route after every count) and computes the model's
realized error against ground truth. This is distinct from the
in-sample training/validation MAE the trainer reports — those are
sampled DURING the fit; this is "how is the active model doing in
production, against fresh data the model has never seen?"

Pure read-only. No writes to model_runs, no writes to
inventory_rate_predictions, no auto-rollback. The caller decides what
to do with the rolled-up numbers.

Why prediction_log and not inventory_rate_prediction_history: the
history archive table was dropped in migration 0141. prediction_log
predates it and is the canonical predicted-vs-actual surface
(migration 0021:271, extended for inventory in 0062:99-110).
"""
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
import uuid

from src.supabase_client import get_supabase_client


# When a model's realized MAE drift exceeds this multiple of its
# training-time validation MAE, the model_run is flagged as "stale" in
# the response so admins can decide whether to manually retrain. NOT
# auto-rollback — just a flag. The threshold is intentionally loose
# (1.5x) so we surface real drift but don't yelp on normal noise.
DRIFT_RATIO_THRESHOLD = 1.5

# Minimum number of (predicted, actual) pairs we need before we trust
# the realized-MAE estimate enough to flag a model as stale. Fewer than
# this and the noise floor dominates.
MIN_PAIRS_FOR_STALENESS = 10


def _validate_property_id(property_id: str) -> Optional[str]:
    try:
        uuid.UUID(str(property_id))
        return None
    except (ValueError, AttributeError, TypeError):
        return f"Invalid property_id: not a UUID ({property_id!r})"


def run_inventory_backtest(
    property_id: str,
    window_days: int = 30,
) -> Dict[str, Any]:
    """Compute realized-MAE rollups over the prediction_log window.

    Args:
        property_id: Property UUID.
        window_days: Backtest window. Default 30 days. Capped at 180.

    Returns:
        {
          property_id,
          window_days,
          n_pairs,                  # total (predicted, actual) pairs in window
          per_item: [
            {
              item_id,
              n_pairs,
              realized_mae,         # mean |predicted - actual| in window
              training_mae,         # from the latest active model_run
              validation_mae,       # from the latest active model_run
              drift_ratio,          # realized_mae / validation_mae (or null)
            }
          ],
          stale_active_models: [
            {
              item_id,
              model_run_id,
              realized_mae,
              validation_mae,
              ratio,
            }
          ],
          error?,                   # set if property_id is invalid
        }

    The function NEVER writes to any table. Caller decides what (if
    anything) to do with the stale-models list.
    """
    err = _validate_property_id(property_id)
    if err:
        return {"error": err, "property_id": property_id, "n_pairs": 0,
                "per_item": [], "stale_active_models": []}

    # Clamp window to 180 days — bigger windows risk a slow query and the
    # admin should be specific about what they're looking at.
    window_days = max(1, min(int(window_days), 180))

    client = get_supabase_client()
    since = datetime.now(timezone.utc) - timedelta(days=window_days)

    # ── 1. Read prediction_log within the window ───────────────────────
    log_rows = client.fetch_many(
        "prediction_log",
        filters={"property_id": property_id, "layer": "inventory_rate"},
        order_by="logged_at",
        descending=True,
        limit=50000,
    )
    pairs: List[Dict[str, Any]] = []
    for row in log_rows or []:
        ts_raw = row.get("logged_at")
        if not ts_raw:
            continue
        try:
            ts = _parse_iso(ts_raw)
        except Exception:
            continue
        if ts < since:
            continue
        item_id = row.get("item_id") or _extract_item_id(row)
        if not item_id:
            continue
        predicted = row.get("predicted_value")
        actual = row.get("actual_value")
        if predicted is None or actual is None:
            continue
        try:
            pred_f = float(predicted)
            actual_f = float(actual)
        except (TypeError, ValueError):
            continue
        pairs.append({
            "item_id": str(item_id),
            "predicted": pred_f,
            "actual": actual_f,
            "model_run_id": row.get("model_run_id"),
            "logged_at": ts_raw,
        })

    # ── 2. Batch-fetch ALL model_runs referenced by those pairs ────────
    # Codex + senior-eng review: `client.fetch_many` only supports `.eq()`
    # filters (verified at supabase_client.py:75-76). Looping fetch_many
    # per run_id is N+1 and times out for hotels with many distinct runs.
    # Use the raw client's `.in_("id", [...])` for a single round-trip.
    run_ids = list({p["model_run_id"] for p in pairs if p.get("model_run_id")})
    runs_by_id: Dict[str, Dict[str, Any]] = {}
    if run_ids:
        try:
            resp = (
                client.client.table("model_runs")
                .select("id, algorithm, validation_mae, training_mae, is_active, item_id")
                .in_("id", run_ids)
                .execute()
            )
            for r in resp.data or []:
                runs_by_id[str(r["id"])] = r
        except Exception:
            # Defensive: backtest is read-only and should never crash the
            # endpoint. Empty runs_by_id → all per_item rows report null
            # training/validation MAE, drift_ratio = null. The
            # operator-visible signal is "couldn't enrich with model
            # metadata", not a 500.
            runs_by_id = {}

    # ── 3. Group pairs by item; compute realized MAE per item ──────────
    pairs_by_item: Dict[str, List[Dict[str, Any]]] = {}
    for p in pairs:
        pairs_by_item.setdefault(p["item_id"], []).append(p)

    per_item: List[Dict[str, Any]] = []
    stale_active_models: List[Dict[str, Any]] = []

    for item_id, group in pairs_by_item.items():
        n = len(group)
        realized_mae = sum(abs(p["predicted"] - p["actual"]) for p in group) / n

        # Pick the LATEST run referenced by this item's pairs (highest
        # logged_at). Used to compare realized vs. validation MAE.
        latest_pair = max(group, key=lambda p: p["logged_at"])
        run = runs_by_id.get(str(latest_pair.get("model_run_id") or ""))
        training_mae = run.get("training_mae") if run else None
        validation_mae = run.get("validation_mae") if run else None
        drift_ratio = None
        if (
            validation_mae is not None
            and isinstance(validation_mae, (int, float))
            and validation_mae > 1e-9
        ):
            drift_ratio = realized_mae / float(validation_mae)

        per_item.append({
            "item_id": item_id,
            "n_pairs": n,
            "realized_mae": realized_mae,
            "training_mae": _coerce_optional_float(training_mae),
            "validation_mae": _coerce_optional_float(validation_mae),
            "drift_ratio": drift_ratio,
        })

        # ── 4. Stale-model flag ────────────────────────────────────────
        # Only flag when (a) the latest run is still active, (b) we have
        # enough pairs to trust the estimate, and (c) drift exceeds the
        # threshold. Pure read — no auto-rollback.
        if (
            run is not None
            and run.get("is_active") is True
            and n >= MIN_PAIRS_FOR_STALENESS
            and drift_ratio is not None
            and drift_ratio > DRIFT_RATIO_THRESHOLD
        ):
            stale_active_models.append({
                "item_id": item_id,
                "model_run_id": run["id"],
                "realized_mae": realized_mae,
                "validation_mae": _coerce_optional_float(validation_mae),
                "ratio": drift_ratio,
            })

    # Sort per_item by realized_mae desc so admins see worst-fitting first.
    per_item.sort(key=lambda r: r["realized_mae"], reverse=True)
    # Stale models by drift descending — worst first.
    stale_active_models.sort(key=lambda r: r["ratio"], reverse=True)

    return {
        "property_id": property_id,
        "window_days": window_days,
        "n_pairs": len(pairs),
        "per_item": per_item,
        "stale_active_models": stale_active_models,
    }


def _parse_iso(ts: Any) -> datetime:
    """Parse an ISO timestamp into a tz-aware datetime.

    PostgREST returns timestamps as ISO 8601 strings; rarely they include
    a `Z` suffix (UTC) which `fromisoformat` rejects pre-3.11. Normalize.
    """
    s = str(ts)
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _extract_item_id(row: Dict[str, Any]) -> Optional[str]:
    """Fallback: try to pull item_id from prediction_log.metadata if the
    direct column wasn't populated. Inventory rows write item_id at the
    top level (see post-count-process/route.ts:185-200), but the
    column-vs-metadata split has been a footgun before; defensive.
    """
    meta = row.get("metadata") or {}
    if isinstance(meta, dict):
        v = meta.get("item_id")
        if v:
            return str(v)
    return None


def _coerce_optional_float(v: Any) -> Optional[float]:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None
