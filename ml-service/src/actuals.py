"""Phase 7 v2 (2026-05-22) — daily backfill of `prediction_log` rows.

The producer that migration 0022's header comment promised but never
shipped:

  -- Used by: ml-service/src/actuals.py when backfilling prediction_log
  -- rows after a day's cleaning is complete.

What it does, per call (orchestrator at fleet_rollback.py invokes once
per day at 06:45 CDT):

  1. For each property with at least one active non-cold-start
     housekeeping model, run a 3-day rolling backfill (yesterday,
     2-days-ago, 3-days-ago).
  2. For each (date, layer) pair, pull the matching prediction rows
     from demand_predictions / supply_predictions joined to model_runs
     (cold-start excluded — those predictions are cohort-prior flat
     numbers and have no per-hotel learning to validate).
  3. Look up the APPROVED actuals (not recorded — see Codex h-pri
     finding). For demand that's cleaning_minutes_per_day_view.
     total_approved_minutes; for supply it's sum(cleaning_events.
     duration_minutes) WHERE status='approved' grouped by
     (room_number, staff_id).
  4. UPSERT one prediction_log row per matched pair via the natural
     unique key from migration 0156 (property_id, layer, prediction_id,
     model_run_id). Re-running across the 3-day window propagates
     Maria's late approve/flag/discard corrections into existing rows.
  5. Per-property advisory lock prevents the TOCTOU race when a
     manual workflow_dispatch overlaps the scheduled daily cron.

This module does NOT decide whether a model should be rolled back —
that's monitoring/shadow_mae.py + monitoring/fleet_rollback.py. This
module only fills the table they need to make the decision.
"""
from __future__ import annotations

import json
import os
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import psycopg2

from src.advisory_lock import advisory_lock
from src.config import get_settings
from src.supabase_client import get_supabase_client, safe_uuid


def _format_summary(stats: Dict[str, Any]) -> Dict[str, Any]:
    """Defensive normalization so the orchestrator always sees the same shape."""
    return {
        "rows_upserted_demand": int(stats.get("rows_upserted_demand", 0)),
        "rows_upserted_supply": int(stats.get("rows_upserted_supply", 0)),
        "rows_skipped_no_actual_yet": int(stats.get("rows_skipped_no_actual_yet", 0)),
        "properties_processed": int(stats.get("properties_processed", 0)),
        "properties_locked_out": int(stats.get("properties_locked_out", 0)),
        "errors": stats.get("errors", []),
    }


def _list_properties_with_active_fitted_models(client) -> List[str]:
    """Return the set of property_ids that have at least one active
    non-cold-start housekeeping model (demand or supply). Cold-start
    properties get filtered here AND in the per-row SQL — defense in
    depth so a flag-backfill miss can't leak cohort-prior predictions
    into the rolling MAE.
    """
    rows = client.execute_sql(
        """
        select distinct property_id
        from model_runs
        where is_active = true
          and is_shadow = false
          and layer in ('demand', 'supply')
          and coalesce(is_cold_start, false) = false
          and coalesce(algorithm, '') not like 'cold-start%'
        """
    )
    return [str(r["property_id"]) for r in (rows or []) if r.get("property_id")]


def _backfill_demand_one_property(
    client, property_id: str, dates_range: List[date]
) -> Dict[str, int]:
    """UPSERT prediction_log rows for the demand layer for one property
    over the rolling correction window.

    Returns {rows_upserted, rows_skipped_no_actual_yet}.
    """
    pid = safe_uuid(property_id)
    min_date = min(dates_range).isoformat()
    max_date_excl = (max(dates_range) + timedelta(days=1)).isoformat()
    # Pull (prediction, actual, model-state) joined in one SQL call.
    # cleaning_minutes_per_day_view exposes total_approved_minutes — we
    # use approved (NOT recorded) so Maria's flag/discard corrections
    # propagate without poisoning the rolling MAE.
    query = f"""
        select
          dp.id as prediction_id,
          dp.model_run_id::text as model_run_id,
          dp.date::text as date,
          dp.predicted_minutes_p50 as predicted_value,
          cmpd.total_approved_minutes as actual_value
        from demand_predictions dp
        join model_runs mr on mr.id = dp.model_run_id
        left join cleaning_minutes_per_day_view cmpd
          on cmpd.property_id = dp.property_id and cmpd.date = dp.date
        where dp.property_id = '{pid}'
          and dp.date >= date '{min_date}'
          and dp.date <  date '{max_date_excl}'
          and mr.is_active = true
          and coalesce(mr.is_cold_start, false) = false
          and coalesce(mr.algorithm, '') not like 'cold-start%'
        order by dp.date asc
    """
    try:
        rows = client.execute_sql(query)
    except Exception as exc:
        print(json.dumps({
            "evt": "actuals_backfill_demand_query_failed",
            "property_id": property_id, "error": str(exc)[:200],
        }))
        return {"rows_upserted": 0, "rows_skipped_no_actual_yet": 0}

    upserted = 0
    skipped_no_actual = 0
    for row in (rows or []):
        actual = row.get("actual_value")
        if actual is None:
            # Maria hasn't reviewed yet (or the date had zero approved
            # cleanings). Try again on tomorrow's run within the 3-day
            # window. Don't write a row with NULL actual — the rolling
            # MAE would interpret it incorrectly.
            skipped_no_actual += 1
            continue
        try:
            client.upsert(
                "prediction_log",
                {
                    "property_id": property_id,
                    "layer": "demand",
                    "prediction_id": row["prediction_id"],
                    "model_run_id": row["model_run_id"],
                    "date": row["date"],
                    "predicted_value": float(row["predicted_value"]),
                    "actual_value": float(actual),
                    # abs_error / squared_error are STORED generated
                    # columns — Postgres computes them on INSERT and
                    # recomputes on every UPDATE. We do NOT send them.
                },
                on_conflict="property_id,layer,prediction_id,model_run_id",
            )
            upserted += 1
        except Exception as exc:
            print(json.dumps({
                "evt": "actuals_backfill_demand_upsert_failed",
                "property_id": property_id,
                "prediction_id": row.get("prediction_id"),
                "error": str(exc)[:200],
            }))
    return {
        "rows_upserted": upserted,
        "rows_skipped_no_actual_yet": skipped_no_actual,
    }


def _backfill_supply_one_property(
    client, property_id: str, dates_range: List[date]
) -> Dict[str, int]:
    """UPSERT prediction_log rows for the supply layer for one property.

    Per-(room, staff) predictions joined to aggregated
    cleaning_events.duration_minutes where status='approved'. Same
    rationale as demand: approved-only for stability.

    Returns {rows_upserted, rows_skipped_no_actual_yet}.
    """
    pid = safe_uuid(property_id)
    min_date = min(dates_range).isoformat()
    max_date_excl = (max(dates_range) + timedelta(days=1)).isoformat()
    query = f"""
        with supply_actuals as (
          select
            property_id, date, room_number, staff_id,
            sum(duration_minutes) as actual_minutes
          from cleaning_events
          where property_id = '{pid}'
            and date >= date '{min_date}'
            and date <  date '{max_date_excl}'
            and status = 'approved'
            and started_at is not null
            and completed_at is not null
          group by property_id, date, room_number, staff_id
        )
        select
          sp.id as prediction_id,
          sp.model_run_id::text as model_run_id,
          sp.date::text as date,
          sp.predicted_minutes_p50 as predicted_value,
          sa.actual_minutes as actual_value
        from supply_predictions sp
        join model_runs mr on mr.id = sp.model_run_id
        left join supply_actuals sa
          on sa.property_id = sp.property_id
          and sa.date = sp.date
          and sa.room_number = sp.room_number
          and sa.staff_id::text = sp.staff_id::text
        where sp.property_id = '{pid}'
          and sp.date >= date '{min_date}'
          and sp.date <  date '{max_date_excl}'
          and mr.is_active = true
          and coalesce(mr.is_cold_start, false) = false
          and coalesce(mr.algorithm, '') not like 'cold-start%'
        order by sp.date asc
    """
    try:
        rows = client.execute_sql(query)
    except Exception as exc:
        print(json.dumps({
            "evt": "actuals_backfill_supply_query_failed",
            "property_id": property_id, "error": str(exc)[:200],
        }))
        return {"rows_upserted": 0, "rows_skipped_no_actual_yet": 0}

    upserted = 0
    skipped_no_actual = 0
    for row in (rows or []):
        actual = row.get("actual_value")
        if actual is None:
            # Common: housekeeper didn't end up cleaning this room
            # (PMS plan changed, room flipped to OOO, etc.) Not a bug.
            skipped_no_actual += 1
            continue
        try:
            client.upsert(
                "prediction_log",
                {
                    "property_id": property_id,
                    "layer": "supply",
                    "prediction_id": row["prediction_id"],
                    "model_run_id": row["model_run_id"],
                    "date": row["date"],
                    "predicted_value": float(row["predicted_value"]),
                    "actual_value": float(actual),
                },
                on_conflict="property_id,layer,prediction_id,model_run_id",
            )
            upserted += 1
        except Exception as exc:
            print(json.dumps({
                "evt": "actuals_backfill_supply_upsert_failed",
                "property_id": property_id,
                "prediction_id": row.get("prediction_id"),
                "error": str(exc)[:200],
            }))
    return {
        "rows_upserted": upserted,
        "rows_skipped_no_actual_yet": skipped_no_actual,
    }


async def backfill_prediction_log(
    property_ids: Optional[List[str]] = None,
    *,
    now_utc: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Run the daily backfill for the supplied properties (or all
    properties with active fitted housekeeping models if None).

    Per-property advisory lock prevents TOCTOU races when a manual
    workflow_dispatch overlaps the scheduled daily cron. Matches the
    training/supply.py:71-111 pattern exactly.
    """
    settings = get_settings()
    client = get_supabase_client()
    now_utc = now_utc or datetime.now(timezone.utc)

    # Window: yesterday, 2-days-ago, 3-days-ago.
    today_utc = now_utc.date()
    correction_days = max(1, int(settings.auto_rollback_actuals_correction_days))
    dates_range = [today_utc - timedelta(days=i) for i in range(1, correction_days + 1)]

    if property_ids is None:
        property_ids = _list_properties_with_active_fitted_models(client)

    stats: Dict[str, Any] = {
        "rows_upserted_demand": 0,
        "rows_upserted_supply": 0,
        "rows_skipped_no_actual_yet": 0,
        "properties_processed": 0,
        "properties_locked_out": 0,
        "errors": [],
    }

    db_url = os.environ.get("SUPABASE_DB_URL") or os.environ.get("DATABASE_URL")

    for property_id in property_ids:
        lock_conn = None
        if db_url:
            try:
                lock_conn = psycopg2.connect(db_url)
            except Exception as exc:
                print(json.dumps({
                    "evt": "actuals_backfill_advisory_lock_connect_failed",
                    "property_id": property_id, "error": str(exc),
                }))
        try:
            if lock_conn is not None:
                # Distinct lock-key namespace from training (which uses
                # the property's layer string). Same advisory_lock helper.
                with advisory_lock(
                    lock_conn, property_id, "prediction_log_backfill",
                    blocking=False,
                ) as acquired:
                    if not acquired:
                        stats["properties_locked_out"] += 1
                        print(json.dumps({
                            "evt": "actuals_backfill_already_running",
                            "property_id": property_id,
                        }))
                        continue
                    _run_one(client, property_id, dates_range, stats)
            else:
                # No DATABASE_URL — run without the lock (dev / one-off).
                _run_one(client, property_id, dates_range, stats)
        finally:
            if lock_conn is not None:
                try:
                    lock_conn.close()
                except Exception:
                    pass

    return _format_summary(stats)


def _run_one(client, property_id: str, dates_range: List[date], stats: Dict[str, Any]) -> None:
    """Inner per-property routine — runs inside the advisory lock."""
    try:
        demand = _backfill_demand_one_property(client, property_id, dates_range)
        supply = _backfill_supply_one_property(client, property_id, dates_range)
        stats["rows_upserted_demand"] += demand["rows_upserted"]
        stats["rows_upserted_supply"] += supply["rows_upserted"]
        stats["rows_skipped_no_actual_yet"] += (
            demand["rows_skipped_no_actual_yet"] + supply["rows_skipped_no_actual_yet"]
        )
        stats["properties_processed"] += 1
    except Exception as exc:
        stats["errors"].append({
            "property_id": property_id, "error": str(exc)[:200],
        })
        print(json.dumps({
            "evt": "actuals_backfill_property_failed",
            "property_id": property_id, "error": str(exc)[:200],
        }))
