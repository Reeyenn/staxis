"""Phase M3 (2026-05-14) — behavior tests for aggregate_demand_priors.

Module under test: src/training/demand_supply_priors.py

Phase L discipline: seed inputs (fake properties + cleaning_minutes_per_day_view
rows), assert outputs (cohort_key + median value upserted to demand_priors).
No source-grep tests.
"""
import asyncio
from datetime import datetime, timedelta
from unittest.mock import MagicMock, patch

from src.training.demand_supply_priors import aggregate_demand_priors


def _make_client(properties, view_rows, upsert_capture):
    """Build a fake supabase client.

    properties: list of property dicts (id, brand, region, size_tier, total_rooms)
    view_rows: list of cleaning_minutes_per_day_view rows
    upsert_capture: list that accumulates dicts passed to demand_priors.upsert(...)
    """
    client = MagicMock()

    def fetch_many(table, **kwargs):
        if table == "properties":
            return properties
        if table == "cleaning_minutes_per_day_view":
            return view_rows
        return []

    client.fetch_many.side_effect = fetch_many

    table_mock = MagicMock()
    upsert_mock = MagicMock()

    def upsert(payload, on_conflict=None):
        upsert_capture.append({"payload": payload, "on_conflict": on_conflict})
        execute_mock = MagicMock()
        execute_mock.execute.return_value = MagicMock(data=[payload])
        return execute_mock

    upsert_mock.upsert.side_effect = upsert
    table_mock.return_value = upsert_mock
    client.client = MagicMock()
    client.client.table = table_mock
    return client


def test_aggregate_writes_one_row_per_cohort_with_correct_median():
    """3 properties in same cohort, each with one day of data → median upserted.

    P1 = 30 rooms × 600 min/day = 20 min/room/day
    P2 = 30 rooms × 750 min/day = 25 min/room/day
    P3 = 30 rooms × 900 min/day = 30 min/room/day
    Cohort median should be 25.0.
    """
    today = datetime.utcnow().date().isoformat()
    properties = [
        {"id": "p1", "brand": "Comfort Suites", "region": "South", "size_tier": "small", "total_rooms": 30},
        {"id": "p2", "brand": "Comfort Suites", "region": "South", "size_tier": "small", "total_rooms": 30},
        {"id": "p3", "brand": "Comfort Suites", "region": "South", "size_tier": "small", "total_rooms": 30},
    ]
    view_rows = [
        {"property_id": "p1", "date": today, "total_recorded_minutes": 600},
        {"property_id": "p2", "date": today, "total_recorded_minutes": 750},
        {"property_id": "p3", "date": today, "total_recorded_minutes": 900},
    ]
    captured = []
    client = _make_client(properties, view_rows, captured)

    with patch("src.training.demand_supply_priors.get_supabase_client", return_value=client):
        result = asyncio.run(aggregate_demand_priors())

    assert result["hotels_seen"] == 3
    # Specific cohort + global cohort should both upsert (n=3 < 5 for
    # global → skipped per the global-only-with-5+-hotels rule).
    cohort_keys = [c["payload"]["cohort_key"] for c in captured]
    assert "comfort-suites-south-small" in cohort_keys
    # Global with only 3 hotels should be skipped.
    assert "global" not in cohort_keys
    assert result["skipped_low_n"] >= 1

    # Verify the cohort median is 25 (the middle of [20, 25, 30]).
    specific = next(c for c in captured if c["payload"]["cohort_key"] == "comfort-suites-south-small")
    assert specific["payload"]["prior_minutes_per_room_per_day"] == 25.0
    assert specific["payload"]["n_hotels_contributing"] == 3
    assert specific["payload"]["source"] == "cohort-aggregate"
    assert specific["on_conflict"] == "cohort_key"


def test_aggregate_writes_global_cohort_when_5_plus_hotels():
    """5 distinct hotels in different cohorts → global cohort gets upserted."""
    today = datetime.utcnow().date().isoformat()
    properties = [
        {"id": f"p{i}", "brand": f"Brand{i}", "region": "X", "size_tier": "small", "total_rooms": 30}
        for i in range(1, 6)
    ]
    # All 5 hotels report 600 min/day on 30 rooms = 20 min/room/day
    view_rows = [
        {"property_id": f"p{i}", "date": today, "total_recorded_minutes": 600}
        for i in range(1, 6)
    ]
    captured = []
    client = _make_client(properties, view_rows, captured)

    with patch("src.training.demand_supply_priors.get_supabase_client", return_value=client):
        result = asyncio.run(aggregate_demand_priors())

    assert result["hotels_seen"] == 5
    cohort_keys = [c["payload"]["cohort_key"] for c in captured]
    assert "global" in cohort_keys
    global_row = next(c for c in captured if c["payload"]["cohort_key"] == "global")
    assert global_row["payload"]["prior_minutes_per_room_per_day"] == 20.0
    assert global_row["payload"]["n_hotels_contributing"] == 5


def test_aggregate_skips_rows_older_than_90_days():
    """Stale rows (>90 days old) must be excluded from aggregation."""
    old_date = (datetime.utcnow() - timedelta(days=120)).date().isoformat()
    today = datetime.utcnow().date().isoformat()
    properties = [
        {"id": "p1", "brand": "X", "region": "Y", "size_tier": "small", "total_rooms": 30},
    ]
    view_rows = [
        # Stale: would push median to 100 if included
        {"property_id": "p1", "date": old_date, "total_recorded_minutes": 3000},
        # Fresh: real signal
        {"property_id": "p1", "date": today, "total_recorded_minutes": 600},
    ]
    captured = []
    client = _make_client(properties, view_rows, captured)

    with patch("src.training.demand_supply_priors.get_supabase_client", return_value=client):
        asyncio.run(aggregate_demand_priors())

    # Only the fresh row should contribute → median is 20.0 (not 60.0)
    specific = next((c for c in captured if c["payload"]["cohort_key"] == "x-y-small"), None)
    assert specific is not None
    assert specific["payload"]["prior_minutes_per_room_per_day"] == 20.0


def test_aggregate_clips_implausibly_high_values():
    """Outlier defense: cohort median clipped to ≤200 min/room/day.

    A misconfigured property logging hours instead of minutes could push
    the cohort median to 600+ min/room/day. The clip prevents one bad
    actor from corrupting the network-wide prior.
    """
    today = datetime.utcnow().date().isoformat()
    properties = [
        {"id": "p1", "brand": "Z", "region": "Z", "size_tier": "huge", "total_rooms": 1},
    ]
    # 1 room, 500 minutes → 500 min/room/day (above 200 clip)
    view_rows = [
        {"property_id": "p1", "date": today, "total_recorded_minutes": 500},
    ]
    captured = []
    client = _make_client(properties, view_rows, captured)

    with patch("src.training.demand_supply_priors.get_supabase_client", return_value=client):
        asyncio.run(aggregate_demand_priors())

    specific = next(c for c in captured if c["payload"]["cohort_key"] == "z-z-huge")
    assert specific["payload"]["prior_minutes_per_room_per_day"] == 200.0


def test_aggregate_skips_properties_without_total_rooms():
    """Property with null/zero total_rooms can't be normalized → excluded.

    Defensive: don't divide by zero, don't include unbounded per-room rate
    in the cohort median.
    """
    today = datetime.utcnow().date().isoformat()
    properties = [
        {"id": "p1", "brand": "X", "region": "Y", "size_tier": "small", "total_rooms": None},
        {"id": "p2", "brand": "X", "region": "Y", "size_tier": "small", "total_rooms": 0},
        {"id": "p3", "brand": "X", "region": "Y", "size_tier": "small", "total_rooms": 30},
    ]
    view_rows = [
        {"property_id": "p1", "date": today, "total_recorded_minutes": 600},
        {"property_id": "p2", "date": today, "total_recorded_minutes": 600},
        {"property_id": "p3", "date": today, "total_recorded_minutes": 600},
    ]
    captured = []
    client = _make_client(properties, view_rows, captured)

    with patch("src.training.demand_supply_priors.get_supabase_client", return_value=client):
        result = asyncio.run(aggregate_demand_priors())

    # Only p3 contributes
    assert result["hotels_seen"] == 1
    specific = next(c for c in captured if c["payload"]["cohort_key"] == "x-y-small")
    assert specific["payload"]["n_hotels_contributing"] == 1


def test_aggregate_handles_empty_network_gracefully():
    """No properties at all → return clean zero-result, no exceptions."""
    captured = []
    client = _make_client([], [], captured)

    with patch("src.training.demand_supply_priors.get_supabase_client", return_value=client):
        result = asyncio.run(aggregate_demand_priors())

    assert result["cohorts_updated"] == 0
    assert result["hotels_seen"] == 0
    assert captured == []
