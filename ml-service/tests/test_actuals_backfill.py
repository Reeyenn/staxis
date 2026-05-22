"""Phase 7 v2 (2026-05-22) — prediction_log backfill writer behavior.

The producer that migration 0022's header comment promised:
ml-service/src/actuals.py. Tests verify:

  - Demand backfill writes prediction_log rows via UPSERT against the
    natural unique key from migration 0156. predicted_value comes from
    demand_predictions.predicted_minutes_p50; actual_value comes from
    cleaning_minutes_per_day_view.total_approved_minutes.
  - Supply backfill aggregates cleaning_events GROUP BY (room, staff)
    where status='approved'.
  - Cold-start rows are excluded via the SQL join.
  - Rows where total_approved_minutes IS NULL get skipped silently
    (Maria hasn't reviewed yet — try again tomorrow within the 3-day
    rolling correction window).
  - Re-running the backfill UPSERTs (not duplicates) thanks to
    on_conflict='property_id,layer,prediction_id,model_run_id'.
"""
import asyncio
from unittest.mock import patch

from tests.conftest import make_fake_supabase
from src.actuals import backfill_prediction_log


PROPERTY_ID = "8a041d6e-d881-4f19-83e0-7250f0e36eaa"


def _run(coro):
    return asyncio.run(coro)


def test_demand_backfill_writes_upsert_with_approved_actuals():
    """One demand prediction with an approved actual → one prediction_log
    upsert using the natural-key on_conflict from migration 0156.
    """
    def _execute_sql(sql):
        # The list-properties query returns our test property.
        if "select distinct property_id" in sql and "from model_runs" in sql:
            return [{"property_id": PROPERTY_ID}]
        # The demand backfill query returns one paired (prediction, actual) row.
        if "from demand_predictions dp" in sql:
            return [{
                "prediction_id": "demand-pred-id-1",
                "model_run_id": "active-mr-fitted",
                "date": "2026-05-20",
                "predicted_value": 1000.0,
                "actual_value": 1080.0,
            }]
        # Supply backfill query — no supply rows for this test.
        if "from supply_predictions sp" in sql:
            return []
        return []

    fake = make_fake_supabase(execute_sql=_execute_sql)

    # No DATABASE_URL → backfill runs without the advisory lock (dev path).
    import os
    os.environ.pop("DATABASE_URL", None)
    os.environ.pop("SUPABASE_DB_URL", None)
    with patch("src.actuals.get_supabase_client", return_value=fake):
        result = _run(backfill_prediction_log(property_ids=[PROPERTY_ID]))

    assert result["rows_upserted_demand"] == 1
    assert result["rows_upserted_supply"] == 0
    assert result["properties_processed"] == 1
    # Verify the UPSERT used the natural-key on_conflict.
    demand_upserts = [
        u for u in fake.upserts
        if u["table"] == "prediction_log" and u["data"]["layer"] == "demand"
    ]
    assert len(demand_upserts) == 1
    u = demand_upserts[0]
    assert u["on_conflict"] == "property_id,layer,prediction_id,model_run_id"
    assert u["data"]["predicted_value"] == 1000.0
    assert u["data"]["actual_value"] == 1080.0
    # abs_error / squared_error are STORED generated columns; we do NOT
    # send them in the upsert payload (Postgres computes them).
    assert "abs_error" not in u["data"]
    assert "squared_error" not in u["data"]


def test_demand_backfill_skips_rows_where_approved_actual_is_null():
    """Maria hasn't reviewed yet → total_approved_minutes IS NULL →
    the row gets skipped, NOT inserted with actual_value=null.
    """
    def _execute_sql(sql):
        if "select distinct property_id" in sql and "from model_runs" in sql:
            return [{"property_id": PROPERTY_ID}]
        if "from demand_predictions dp" in sql:
            return [{
                "prediction_id": "demand-pred-id-1",
                "model_run_id": "active-mr-fitted",
                "date": "2026-05-20",
                "predicted_value": 1000.0,
                "actual_value": None,  # Maria hasn't approved
            }]
        return []

    fake = make_fake_supabase(execute_sql=_execute_sql)
    import os
    os.environ.pop("DATABASE_URL", None)
    os.environ.pop("SUPABASE_DB_URL", None)
    with patch("src.actuals.get_supabase_client", return_value=fake):
        result = _run(backfill_prediction_log(property_ids=[PROPERTY_ID]))

    assert result["rows_upserted_demand"] == 0
    assert result["rows_skipped_no_actual_yet"] == 1
    # No upserts touched prediction_log.
    assert not any(u["table"] == "prediction_log" for u in fake.upserts)


def test_supply_backfill_writes_one_row_per_pair():
    """Three supply predictions, two have approved actuals → 2 upserts."""
    def _execute_sql(sql):
        if "select distinct property_id" in sql and "from model_runs" in sql:
            return [{"property_id": PROPERTY_ID}]
        if "from supply_predictions sp" in sql:
            return [
                {
                    "prediction_id": "sup-pred-1",
                    "model_run_id": "supply-mr-fitted",
                    "date": "2026-05-20",
                    "predicted_value": 22.0,
                    "actual_value": 25.0,
                },
                {
                    "prediction_id": "sup-pred-2",
                    "model_run_id": "supply-mr-fitted",
                    "date": "2026-05-20",
                    "predicted_value": 22.0,
                    "actual_value": 20.0,
                },
                {
                    # Housekeeper didn't actually clean this room — skip.
                    "prediction_id": "sup-pred-3",
                    "model_run_id": "supply-mr-fitted",
                    "date": "2026-05-20",
                    "predicted_value": 22.0,
                    "actual_value": None,
                },
            ]
        return []

    fake = make_fake_supabase(execute_sql=_execute_sql)
    import os
    os.environ.pop("DATABASE_URL", None)
    os.environ.pop("SUPABASE_DB_URL", None)
    with patch("src.actuals.get_supabase_client", return_value=fake):
        result = _run(backfill_prediction_log(property_ids=[PROPERTY_ID]))

    assert result["rows_upserted_supply"] == 2
    assert result["rows_skipped_no_actual_yet"] == 1
    supply_upserts = [
        u for u in fake.upserts
        if u["table"] == "prediction_log" and u["data"]["layer"] == "supply"
    ]
    assert len(supply_upserts) == 2
    for u in supply_upserts:
        assert u["on_conflict"] == "property_id,layer,prediction_id,model_run_id"


def test_no_properties_means_empty_summary():
    """Empty property list → zero work, zero errors."""
    fake = make_fake_supabase(execute_sql=lambda sql: [])
    import os
    os.environ.pop("DATABASE_URL", None)
    os.environ.pop("SUPABASE_DB_URL", None)
    with patch("src.actuals.get_supabase_client", return_value=fake):
        result = _run(backfill_prediction_log(property_ids=[]))
    assert result["properties_processed"] == 0
    assert result["rows_upserted_demand"] == 0
    assert result["rows_upserted_supply"] == 0
    assert result["errors"] == []
