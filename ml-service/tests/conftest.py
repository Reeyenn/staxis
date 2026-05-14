"""Shared pytest fixtures + factory helpers for ml-service tests.

Phase M3.1 (2026-05-14): consolidated to support inference-level integration
tests (test_demand_inference_cold_start.py + test_supply_inference_cold_start.py)
that mock the supabase client wrapper rather than the raw PostgREST chain.

Provides:
  - reset_supabase_singleton (autouse) — kills SupabaseServiceClient class-attr
    state between tests so the per-file _instance/_client = None boilerplate from
    test_supabase_client_upsert.py becomes unnecessary
  - Placeholder env vars at import time so get_settings() can construct a Settings
    object without a real .env file
  - make_fake_supabase() — builds a MagicMock with parameterized fetch_one,
    fetch_many, execute_sql, upsert dispatch + capture-on-upsert
  - make_demand_cold_start_model_run / make_supply_cold_start_model_run — minimal
    valid model_runs row fixtures
  - make_plan_snapshot — single plan_snapshots row matching what the inference
    path's inline SQL queries select
  - make_schedule_assignment — single schedule_assignments aggregation row for
    the supply path
"""
import os

# Set placeholder env vars BEFORE any src.* import. get_settings() constructs
# a Pydantic Settings object that fails at module load if these are missing,
# which would break inference tests that import predict_demand / predict_supply
# (both transitively call get_settings on first invocation).
os.environ.setdefault("SUPABASE_URL", "https://placeholder.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "placeholder-service-role-key")
os.environ.setdefault("ML_SERVICE_SECRET", "placeholder-secret-12345")

import pytest  # noqa: E402
from unittest.mock import MagicMock  # noqa: E402

from src.supabase_client import SupabaseServiceClient  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_supabase_singleton():
    """Reset SupabaseServiceClient class attrs before AND after every test.

    The wrapper is a singleton — _instance and _client are class attrs. Without
    this reset, a test that wires up a fake client leaks it into the next test,
    which could then silently use stale state. test_supabase_client_upsert.py:28
    used to do this manually; now it's autouse so individual tests don't have to
    remember.
    """
    SupabaseServiceClient._instance = None
    SupabaseServiceClient._client = None
    yield
    SupabaseServiceClient._instance = None
    SupabaseServiceClient._client = None


def make_fake_supabase(*, fetch_one=None, fetch_many=None, execute_sql=None):
    """Build a MagicMock supabase client wrapper.

    Args:
      fetch_one: dict {table_name: row_dict} OR callable(table, filters) -> row
      fetch_many: dict {table_name: list_of_rows} OR callable(table, **kw) -> list
      execute_sql: dict {sql_substring: list_of_rows} (matches first key found
        in the SQL string) OR callable(sql) -> list

    Returns a MagicMock with .fetch_one/.fetch_many/.execute_sql/.upsert side
    effects wired up + a .upserts list attribute that captures every upsert
    call as {"table", "data", "on_conflict"} dicts for assertion.
    """
    client = MagicMock()

    def _fetch_one(table, filters=None):
        if callable(fetch_one):
            return fetch_one(table, filters)
        return (fetch_one or {}).get(table)

    def _fetch_many(table, **kwargs):
        if callable(fetch_many):
            return fetch_many(table, **kwargs)
        return (fetch_many or {}).get(table, [])

    def _execute_sql(sql):
        if callable(execute_sql):
            return execute_sql(sql)
        for substring, rows in (execute_sql or {}).items():
            if substring in sql:
                return rows
        return []

    upserts = []

    def _upsert(table, data, on_conflict=None):
        upserts.append({"table": table, "data": data, "on_conflict": on_conflict})
        # Mirror the wrapper's contract: returns the upserted row dict.
        return data

    client.fetch_one.side_effect = _fetch_one
    client.fetch_many.side_effect = _fetch_many
    client.execute_sql.side_effect = _execute_sql
    client.upsert.side_effect = _upsert
    client.upserts = upserts
    return client


def make_demand_cold_start_model_run(
    *, property_id, prior=22.0, cohort_key="industry-default", model_run_id="demand-mr-uuid",
):
    """Minimal valid model_runs row for an active demand cold-start model.

    Mirrors what install_cold_start writes via the staxis_install_demand_supply_cold_start
    RPC — see ml-service/src/training/_cold_start.py:install_cold_start.
    """
    return {
        "id": model_run_id,
        "property_id": property_id,
        "layer": "demand",
        "is_active": True,
        "is_shadow": False,
        "algorithm": "cold-start-cohort-prior",
        "model_version": "demand-cold-start-v1-test",
        "trained_at": "2026-05-14T00:00:00",
        "training_row_count": 0,
        "posterior_params": {
            "prior_minutes_per_room_per_day": prior,
            "cohort_key": cohort_key,
            "prior_strength": 0.5,
            "source": "industry-benchmark" if cohort_key == "industry-default" else "cohort-aggregate",
        },
        "hyperparameters": {"local_rows_observed": 0, "cohort_key": cohort_key},
    }


def make_supply_cold_start_model_run(
    *, property_id, prior=30.0, cohort_key="industry-default", model_run_id="supply-mr-uuid",
):
    """Minimal valid model_runs row for an active supply cold-start model."""
    return {
        "id": model_run_id,
        "property_id": property_id,
        "layer": "supply",
        "is_active": True,
        "is_shadow": False,
        "algorithm": "cold-start-cohort-prior",
        "model_version": "supply-cold-start-v1-test",
        "trained_at": "2026-05-14T00:00:00",
        "training_row_count": 0,
        "posterior_params": {
            "prior_minutes_per_event": prior,
            "cohort_key": cohort_key,
            "prior_strength": 0.5,
            "source": "industry-benchmark" if cohort_key == "industry-default" else "cohort-aggregate",
        },
        "hyperparameters": {"local_rows_observed": 0, "cohort_key": cohort_key},
    }


def make_plan_snapshot(
    *,
    total_rooms=30,
    checkouts=10,
    stayover_day1=8,
    stayover_day2=5,
    vacant_dirty=2,
    vacant_clean=3,
    ooo=2,
    dow=3,
    checkout_room_numbers=None,
    stayover_day1_room_numbers=None,
    stayover_day2_room_numbers=None,
    stayover_arrival_room_numbers=None,
    arrival_room_numbers=None,
    vacant_dirty_room_numbers=None,
):
    """Single plan_snapshots row matching what the inference SQL queries select.

    Demand path (demand.py:122-137) selects: checkouts, stayover_day_1_count,
    stayover_day_2plus_count, vacant_dirty_count, total_count, occupied_count,
    dow, scraper_cleaning_minutes.

    Supply path (supply.py:216-235) selects: dow, occupancy_pct, checkout_room_numbers,
    stayover_day1_room_numbers, stayover_day2_room_numbers, stayover_arrival_room_numbers,
    arrival_room_numbers, vacant_dirty_room_numbers.
    """
    occupied_count = max(0, total_rooms - vacant_clean - vacant_dirty - ooo)
    occupancy_pct = (
        round(100.0 * occupied_count / total_rooms, 2) if total_rooms > 0 else 50.0
    )
    return {
        # Demand columns
        "checkouts": checkouts,
        "stayover_day_1_count": stayover_day1,
        "stayover_day_2plus_count": stayover_day2,
        "vacant_dirty_count": vacant_dirty,
        "total_count": total_rooms,
        "occupied_count": occupied_count,
        "dow": dow,
        "scraper_cleaning_minutes": 600,
        # Supply columns
        "occupancy_pct": occupancy_pct,
        "checkout_room_numbers": checkout_room_numbers or [],
        "stayover_day1_room_numbers": stayover_day1_room_numbers or [],
        "stayover_day2_room_numbers": stayover_day2_room_numbers or [],
        "stayover_arrival_room_numbers": stayover_arrival_room_numbers or [],
        "arrival_room_numbers": arrival_room_numbers or [],
        "vacant_dirty_room_numbers": vacant_dirty_room_numbers or [],
    }


def make_schedule_assignment(*, staff_id, assigned_rooms):
    """Single row from the supply schedule_assignments aggregation query.

    Matches the SELECT shape at supply.py:189-200.
    """
    return {
        "staff_id": staff_id,
        "assigned_rooms": list(assigned_rooms),
        "room_count": len(assigned_rooms),
    }
