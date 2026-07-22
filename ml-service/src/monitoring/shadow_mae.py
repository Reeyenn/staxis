"""Phase 7 v2 (2026-05-22) — statistical auto-rollback for housekeeping ML.

REPLACES the dead-code v1 path (compute_rolling_shadow_mae +
check_auto_rollback + _find_fallback_model) that was structurally
unable to fire — its "compare active to previously-active model"
design needed paired prediction_log rows on the same dates for two
different model_run_ids, but deactivated models stop predicting so
the comparator series was always empty.

v2 design — see /Users/reeyen/.claude/plans/you-are-claude-code-hashed-hellman.md
Phase 7 v2 for the full architectural rationale. Summary:

  Comparator = same-DOW historical actual (median of the last 4
  same-day-of-week actuals before the date being scored). The
  paired Wilcoxon test then asks: "is the active model statistically
  worse than just looking up last week's same-day actual?" If yes,
  the model has earned a rollback — it's no better than naive.

This module exposes four functions consumed by
ml-service/src/monitoring/fleet_rollback.py:

  - compute_same_dow_baseline_errors(property_id, layer)
      Returns the list of (date, active_error, naive_error) tuples
      for the rolling lookback window, EXCLUDING dates inside the
      actuals correction window (because actuals there are still
      mutable). Pure read.

  - compute_rolling_mae_vs_baseline(property_id, layer)
      Wraps the above, requires n>=settings.auto_rollback_min_paired_days
      mature observations, runs scipy.stats.wilcoxon (one-sided,
      paired, zsplit ties). Returns (active_mae, baseline_mae, pvalue)
      or None if underpowered.

  - decide_rollback(active_mae, baseline_mae, pvalue, alpha)
      Pure function. Returns True when the active is statistically
      worse than baseline at the (possibly BH-adjusted) alpha.

  - execute_rollback(property_id, layer, *, dry_run)
      Effectful: in live mode, deactivates the active model under
      an advisory lock. In dry-run mode, emits structured log and
      returns {would_fire: True} without touching model_runs.
      No fallback promotion (Codex high-pri finding) — property
      serves cold-start cohort prior until next training cycle.
"""
from __future__ import annotations

import json
import os
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import psycopg2
from scipy import stats

from src.advisory_lock import advisory_lock
from src.config import get_settings
from src.supabase_client import get_supabase_client, safe_uuid


def _parse_date(value: Any) -> Optional[date]:
    """Coerce a supabase date string / date / datetime to a date."""
    if value is None:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    try:
        return datetime.fromisoformat(str(value)).date()
    except (TypeError, ValueError):
        try:
            return date.fromisoformat(str(value))
        except (TypeError, ValueError):
            return None


def compute_same_dow_baseline_errors(
    property_id: str,
    layer: str,
    *,
    lookback_days: Optional[int] = None,
    exclude_recent_days: Optional[int] = None,
) -> List[Tuple[date, float, float]]:
    """Build the list of (date, active_error, naive_error) tuples for
    the rolling window, excluding dates inside the actuals correction
    window (rows there have mutable actual_value).

    The naive predictor at date D is the median of the last 4 same-DOW
    actuals BEFORE date D. Demand uses the full-property totals from
    cleaning_minutes_per_day_view; supply uses the same per-predicted-pair
    population as its scored prediction_log rows.

    For supply layer, we aggregate the per-(room, staff) prediction_log
    rows to a per-(property, date) total before pairing. This is the
    same daily aggregate grain as demand, while retaining supply's narrower
    population — the test then asks whether the day-aggregate prediction
    beats its matching naive day-aggregate baseline.

    Pure read. Used by compute_rolling_mae_vs_baseline.
    """
    if layer not in ("demand", "supply"):
        raise ValueError(f"layer must be demand or supply, got {layer!r}")
    settings = get_settings()
    client = get_supabase_client()
    lookback_days = int(lookback_days if lookback_days is not None else 28)
    exclude_recent_days = int(
        exclude_recent_days
        if exclude_recent_days is not None
        else settings.auto_rollback_actuals_correction_days
    )

    today = datetime.now(timezone.utc).date()
    window_start = today - timedelta(days=lookback_days)
    # Exclude rows within the correction window (their actual_value
    # may still flip when Maria approves/flags/discards events).
    window_end_excl = today - timedelta(days=exclude_recent_days)

    if window_end_excl <= window_start:
        return []

    # Pull prediction_log + per-date aggregate via the natural key.
    # For supply, aggregate per (property, date) by summing predicted
    # and actual values; abs_error must be recomputed at the aggregate
    # grain (sum of per-row abs_error is NOT equal to abs_error of sums).
    pid = safe_uuid(property_id)
    if layer == "demand":
        sql = f"""
            select
              date::text as date,
              predicted_value,
              actual_value
            from prediction_log
            where property_id = '{pid}'
              and layer = 'demand'
              and date >= date '{window_start.isoformat()}'
              and date <  date '{window_end_excl.isoformat()}'
            order by date asc
        """
    else:  # supply
        sql = f"""
            select
              date::text as date,
              sum(predicted_value)::numeric as predicted_value,
              sum(actual_value)::numeric    as actual_value
            from prediction_log
            where property_id = '{pid}'
              and layer = 'supply'
              and date >= date '{window_start.isoformat()}'
              and date <  date '{window_end_excl.isoformat()}'
            group by date
            order by date asc
        """

    try:
        rows = client.execute_sql(sql)
    except Exception as exc:
        print(json.dumps({
            "evt": "rolling_mae_query_failed",
            "property_id": property_id, "layer": layer,
            "error": str(exc)[:200],
        }))
        return []

    if not rows:
        return []

    # For the naive same-DOW baseline we need approved actuals for the
    # WIDER window — looking back another 28 days to have enough same-DOWs
    # before each prediction date.
    naive_window_start = window_start - timedelta(days=28)
    if layer == "supply":
        # The naive same-DOW baseline MUST be built from the SAME actuals
        # population the active model is scored against. For supply, `actual`
        # (below) is the per-date SUM of prediction_log.actual_value — the
        # approved minutes of the scheduled (room,staff) pairs that were
        # predicted, NOT the property's full-day approved total. Using
        # cleaning_minutes_per_day_view (a full-day total) here would compare
        # active_error and naive_error on different populations and bias the
        # auto-rollback decision. Rebuild the baseline history from the supply
        # prediction_log actuals, aliased to the column name the parser reads.
        naive_sql = f"""
            select
              date::text as date,
              sum(actual_value)::numeric as total_approved_minutes
            from prediction_log
            where property_id = '{pid}'
              and layer = 'supply'
              and date >= date '{naive_window_start.isoformat()}'
              and date <  date '{window_end_excl.isoformat()}'
              and actual_value is not null
            group by date
            order by date asc
        """
    else:  # demand — full-day approved minutes is the matching population
        naive_sql = f"""
            select
              date::text as date,
              total_approved_minutes
            from cleaning_minutes_per_day_view
            where property_id = '{pid}'
              and date >= date '{naive_window_start.isoformat()}'
              and date <  date '{window_end_excl.isoformat()}'
              and total_approved_minutes is not null
            order by date asc
        """
    try:
        actual_rows = client.execute_sql(naive_sql)
    except Exception as exc:
        print(json.dumps({
            "evt": "rolling_mae_naive_query_failed",
            "property_id": property_id, "layer": layer,
            "error": str(exc)[:200],
        }))
        return []

    # date -> approved actual minutes (a property-day total)
    actual_by_date: Dict[date, float] = {}
    for r in (actual_rows or []):
        d = _parse_date(r.get("date"))
        if d is None:
            continue
        try:
            actual_by_date[d] = float(r["total_approved_minutes"])
        except (TypeError, ValueError):
            continue

    out: List[Tuple[date, float, float]] = []
    for r in rows:
        d = _parse_date(r.get("date"))
        if d is None:
            continue
        try:
            predicted = float(r["predicted_value"])
            actual = float(r["actual_value"])
        except (TypeError, ValueError):
            continue
        # Same-DOW median over the last 4 same-DOWs BEFORE date d.
        naive_candidates: List[float] = []
        for k in range(1, 5):
            prior_dow = d - timedelta(weeks=k)
            if prior_dow in actual_by_date:
                naive_candidates.append(actual_by_date[prior_dow])
        if len(naive_candidates) < 2:
            # Need at least 2 same-DOWs to compute a stable median; skip.
            continue
        naive_pred = float(np.median(naive_candidates))
        active_error = abs(predicted - actual)
        naive_error = abs(naive_pred - actual)
        out.append((d, active_error, naive_error))
    return out


def compute_rolling_mae_vs_baseline(
    property_id: str,
    layer: str,
) -> Optional[Tuple[float, float, float]]:
    """Compute (active_mae, baseline_mae, pvalue) for the rolling
    window, or None if there's insufficient mature paired data.

    Test: paired one-sided Wilcoxon signed-rank, "active errors are
    GREATER than naive errors". The same test the dead-code v1 used —
    only the comparator has changed.

    zero_method='zsplit' handles ties (same error on both predictors)
    without throwing on Wilcoxon's no-difference fast path.
    """
    settings = get_settings()
    obs = compute_same_dow_baseline_errors(property_id, layer)
    if len(obs) < settings.auto_rollback_min_paired_days:
        return None
    active_errors = np.array([o[1] for o in obs], dtype=float)
    baseline_errors = np.array([o[2] for o in obs], dtype=float)
    try:
        result = stats.wilcoxon(
            active_errors, baseline_errors,
            alternative="greater",
            zero_method="zsplit",
        )
        pvalue = float(result.pvalue)
    except Exception as exc:
        print(json.dumps({
            "evt": "rolling_mae_wilcoxon_failed",
            "property_id": property_id, "layer": layer,
            "error": str(exc)[:200],
        }))
        return None
    return (float(active_errors.mean()), float(baseline_errors.mean()), pvalue)


def decide_rollback(
    active_mae: float,
    baseline_mae: float,
    pvalue: float,
    alpha: float,
) -> bool:
    """Pure function. True iff the test rejects the null at alpha
    (which may be a BH-adjusted threshold passed by the orchestrator)
    AND the effect direction is correct (active > baseline).

    Guard against the perverse case where Wilcoxon rejects but
    active_mae is somehow not actually greater (numerical edge case
    on tied data).
    """
    if pvalue >= alpha:
        return False
    if active_mae <= baseline_mae:
        return False
    return True


def recent_rollback_within_cooldown(client, property_id: str, layer: str) -> bool:
    """Returns True if a rollback fired for this (property, layer)
    within auto_rollback_cooldown_days. Used by the orchestrator to
    skip (property, layer) pairs that just rolled back — prevents
    oscillation. Public so fleet_rollback.py can call it without
    importing a private helper.
    """
    settings = get_settings()
    cutoff_iso = (
        datetime.now(timezone.utc) - timedelta(days=settings.auto_rollback_cooldown_days)
    ).isoformat()
    rows = client.fetch_many(
        "model_runs",
        filters={
            "property_id": property_id,
            "layer": layer,
            "deactivation_reason": "auto_rollback",
        },
        order_by="deactivated_at",
        descending=True,
        limit=1,
    )
    if not rows:
        return False
    deactivated_at = rows[0].get("deactivated_at")
    if not deactivated_at:
        return False
    return str(deactivated_at) >= cutoff_iso


def execute_rollback(
    property_id: str,
    layer: str,
    *,
    dry_run: bool,
) -> Dict[str, Any]:
    """Deactivate the active fitted model for (property, layer).

    No fallback promotion — Codex high-priority finding #3 from the
    Phase 7 review. The previous-active fallback might also be drifting
    (it's OLDER, not fresher). Promoting it blind risks oscillation
    and bypasses the Phase 4a 7-day shadow soak that's supposed to
    gate model activations. Instead: property serves cold-start cohort
    prior (already wired in Phase 1.2 of v2) until next Sunday's
    training cycle produces a fresh active.

    Returns:
      {decision: 'no_active' | 'would_fire' | 'rolled_back' | 'execute_failed',
       deactivated_model_run_id: <id|null>,
       dry_run: bool, ...diagnostics...}
    """
    client = get_supabase_client()

    active_rows = client.fetch_many(
        "model_runs",
        filters={
            "property_id": property_id,
            "layer": layer,
            "is_active": True,
            "is_shadow": False,
        },
        limit=1,
    )
    if not active_rows:
        # No active model to roll back — orchestrator should have
        # filtered this case earlier, but defense-in-depth.
        return {
            "decision": "no_active",
            "property_id": property_id,
            "layer": layer,
            "deactivated_model_run_id": None,
            "dry_run": dry_run,
        }
    active = active_rows[0]
    active_id = active.get("id")

    if dry_run:
        print(json.dumps({
            "evt": "auto_rollback_dry_run_would_fire",
            "property_id": property_id,
            "layer": layer,
            "active_model_run_id": active_id,
            "active_model_version": active.get("model_version"),
            "ts": datetime.now(timezone.utc).isoformat(),
        }))
        return {
            "decision": "would_fire",
            "property_id": property_id,
            "layer": layer,
            "deactivated_model_run_id": None,  # nothing deactivated in dry-run
            "active_model_run_id": active_id,
            "dry_run": True,
        }

    # Live mode — deactivate inside a per-(property, layer) advisory lock
    # so concurrent orchestrator runs can't double-deactivate. Same lock
    # helper the training paths use (training/supply.py:71-111).
    db_url = os.environ.get("SUPABASE_DB_URL") or os.environ.get("DATABASE_URL")
    if not db_url:
        print(json.dumps({
            "evt": "auto_rollback_no_database_url",
            "property_id": property_id, "layer": layer,
            "remediation": "Set DATABASE_URL or SUPABASE_DB_URL on ml-service.",
        }))
        return {
            "decision": "execute_failed",
            "property_id": property_id, "layer": layer,
            "deactivated_model_run_id": None,
            "active_model_run_id": active_id,
            "dry_run": False,
            "error": "no_database_url_for_lock",
        }

    conn = None
    try:
        conn = psycopg2.connect(db_url)
        with advisory_lock(conn, property_id, f"auto_rollback_{layer}", blocking=False) as acquired:
            if not acquired:
                print(json.dumps({
                    "evt": "auto_rollback_lock_held_by_other",
                    "property_id": property_id, "layer": layer,
                }))
                return {
                    "decision": "execute_failed",
                    "property_id": property_id, "layer": layer,
                    "deactivated_model_run_id": None,
                    "active_model_run_id": active_id,
                    "dry_run": False,
                    "error": "lock_held_by_other",
                }
            try:
                client.update(
                    "model_runs",
                    {
                        "is_active": False,
                        "deactivated_at": datetime.now(timezone.utc).isoformat(),
                        "deactivation_reason": "auto_rollback",
                    },
                    {"id": active_id},
                )
            except Exception as exc:
                print(json.dumps({
                    "evt": "auto_rollback_update_failed",
                    "property_id": property_id, "layer": layer,
                    "active_model_run_id": active_id,
                    "error": str(exc)[:200],
                }))
                return {
                    "decision": "execute_failed",
                    "property_id": property_id, "layer": layer,
                    "deactivated_model_run_id": None,
                    "active_model_run_id": active_id,
                    "dry_run": False,
                    "error": f"update_failed: {exc!r}"[:300],
                }
        # Loud structured log after lock release (so the lock window stays short).
        print(json.dumps({
            "evt": "auto_rollback_fired",
            "property_id": property_id,
            "layer": layer,
            "deactivated_model_run_id": active_id,
            "deactivated_model_version": active.get("model_version"),
            "ts": datetime.now(timezone.utc).isoformat(),
            "note": "property will serve cold-start cohort prior until next training cycle",
        }))
        return {
            "decision": "rolled_back",
            "property_id": property_id, "layer": layer,
            "deactivated_model_run_id": active_id,
            "active_model_run_id": active_id,
            "dry_run": False,
        }
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
