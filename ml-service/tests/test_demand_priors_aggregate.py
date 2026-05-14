"""Behavior tests for aggregate_demand_priors + aggregate_supply_priors.

Module under test: src/training/demand_supply_priors.py

Phase L discipline: seed inputs (fake properties + view/event rows), assert
outputs (cohort_key + median value upserted to demand_priors / supply_priors).
No source-grep tests.

Phase M3.1 (2026-05-14) — updates after the aggregator quality gates:
  - skip-low-n applies to ALL cohorts (specific too) at MIN_HOTELS_FOR_COHORT
  - SQL-side date filter (replaces python-side post-fetch filter)
  - supply includes status in ('recorded', 'approved')
"""
import asyncio
from datetime import datetime, timedelta
from unittest.mock import MagicMock, patch

from src.training.demand_supply_priors import (
    aggregate_demand_priors,
    aggregate_supply_priors,
)


def _make_client(properties, view_rows, upsert_capture, *, sql_capture=None):
    """Build a fake supabase client.

    properties: list of property dicts (id, brand, region, size_tier, total_rooms)
    view_rows: list of cleaning_minutes_per_day_view OR cleaning_events rows
               returned from execute_sql() regardless of which SQL string the
               aggregator built. Tests that need to assert on the SQL string
               itself pass a sql_capture list — every call appends the SQL.
    upsert_capture: list that accumulates dicts passed to <table>.upsert(...)
    sql_capture: optional list to capture every SQL string passed to execute_sql
    """
    client = MagicMock()

    def fetch_many(table, **kwargs):
        if table == "properties":
            return properties
        return []

    def execute_sql(sql):
        if sql_capture is not None:
            sql_capture.append(sql)
        return view_rows

    client.fetch_many.side_effect = fetch_many
    client.execute_sql.side_effect = execute_sql

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


# ─── demand aggregator ─────────────────────────────────────────────────


def test_aggregate_skips_specific_cohort_with_fewer_than_5_hotels():
    """Phase M3.1 root-cause fix: specific cohorts also need ≥5 hotels.

    A 1-hotel specific cohort persisted to demand_priors becomes the preferred
    lookup for the next same-cohort hotel — self-fulfilling prophecy. The
    aggregator must skip-low-n uniformly across global AND specific cohorts.
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
    cohort_keys = [c["payload"]["cohort_key"] for c in captured]
    # Both global AND specific should be skipped at n=3 < 5.
    assert "comfort-suites-south-small" not in cohort_keys
    assert "global" not in cohort_keys
    assert result["skipped_low_n"] >= 2


def test_aggregate_writes_specific_cohort_at_5_hotel_boundary():
    """5-hotel specific cohort IS upserted (boundary of MIN_HOTELS_FOR_COHORT)."""
    today = datetime.utcnow().date().isoformat()
    properties = [
        {"id": f"p{i}", "brand": "Comfort Suites", "region": "South", "size_tier": "small", "total_rooms": 30}
        for i in range(1, 6)
    ]
    # 5 hotels each 600 min/day on 30 rooms = 20 min/room/day
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
    # Both global AND specific upsert at n=5.
    assert "comfort-suites-south-small" in cohort_keys
    assert "global" in cohort_keys

    specific = next(c for c in captured if c["payload"]["cohort_key"] == "comfort-suites-south-small")
    assert specific["payload"]["prior_minutes_per_room_per_day"] == 20.0
    assert specific["payload"]["n_hotels_contributing"] == 5


def test_aggregate_writes_global_cohort_when_5_plus_hotels():
    """5 distinct hotels in different cohorts → global cohort gets upserted."""
    today = datetime.utcnow().date().isoformat()
    properties = [
        {"id": f"p{i}", "brand": f"Brand{i}", "region": "X", "size_tier": "small", "total_rooms": 30}
        for i in range(1, 6)
    ]
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
    # Each specific brand cohort is n=1 → all skipped per Phase M3.1.
    assert all(not k.startswith("brand") for k in cohort_keys)
    global_row = next(c for c in captured if c["payload"]["cohort_key"] == "global")
    assert global_row["payload"]["prior_minutes_per_room_per_day"] == 20.0
    assert global_row["payload"]["n_hotels_contributing"] == 5


def test_aggregate_uses_sql_side_date_filter():
    """Phase M3.1 N²-scaling fix: aggregator filters date in SQL, not Python.

    Pulling years of view rows just to discard most was wasteful at
    fleet scale. The SQL string must include `date >= 'YYYY-MM-DD'::date`.
    """
    today = datetime.utcnow().date().isoformat()
    properties = [
        {"id": f"p{i}", "brand": "X", "region": "Y", "size_tier": "small", "total_rooms": 30}
        for i in range(1, 6)
    ]
    view_rows = [
        {"property_id": f"p{i}", "date": today, "total_recorded_minutes": 600}
        for i in range(1, 6)
    ]
    captured = []
    sql_seen = []
    client = _make_client(properties, view_rows, captured, sql_capture=sql_seen)

    with patch("src.training.demand_supply_priors.get_supabase_client", return_value=client):
        asyncio.run(aggregate_demand_priors())

    assert len(sql_seen) == 1
    assert "date >=" in sql_seen[0]
    assert "::date" in sql_seen[0]
    # The since cutoff is 90 days ago — verify SOME date string in YYYY-MM-DD form is embedded.
    cutoff = (datetime.utcnow() - timedelta(days=90)).date().isoformat()
    assert cutoff in sql_seen[0]


def test_aggregate_clips_implausibly_high_values():
    """Outlier defense: cohort median clipped to ≤200 min/room/day."""
    today = datetime.utcnow().date().isoformat()
    properties = [
        {"id": f"p{i}", "brand": "Z", "region": "Z", "size_tier": "huge", "total_rooms": 1}
        for i in range(1, 6)
    ]
    # 1 room each, 500 minutes → 500 min/room/day (above 200 clip)
    view_rows = [
        {"property_id": f"p{i}", "date": today, "total_recorded_minutes": 500}
        for i in range(1, 6)
    ]
    captured = []
    client = _make_client(properties, view_rows, captured)

    with patch("src.training.demand_supply_priors.get_supabase_client", return_value=client):
        asyncio.run(aggregate_demand_priors())

    specific = next(c for c in captured if c["payload"]["cohort_key"] == "z-z-huge")
    assert specific["payload"]["prior_minutes_per_room_per_day"] == 200.0


def test_aggregate_skips_properties_without_total_rooms():
    """Null/zero total_rooms can't normalize → excluded from per-room rate."""
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

    # Only p3 contributes (and at n=1, both global + specific are skipped).
    assert result["hotels_seen"] == 1
    assert result["skipped_low_n"] >= 1


def test_aggregate_handles_empty_network_gracefully():
    """No properties at all → return clean zero-result, no exceptions."""
    captured = []
    client = _make_client([], [], captured)

    with patch("src.training.demand_supply_priors.get_supabase_client", return_value=client):
        result = asyncio.run(aggregate_demand_priors())

    assert result["cohorts_updated"] == 0
    assert result["hotels_seen"] == 0
    assert captured == []


# ─── supply aggregator ─────────────────────────────────────────────────


def test_supply_aggregate_includes_approved_status_in_sql():
    """Phase M3.1: supply aggregator must include both 'recorded' AND 'approved'.

    The production view (migration 0022) treats both as valid signal —
    operator review approves a recorded event. Filtering only 'recorded'
    undercounts. The SQL string must contain `status in ('recorded', 'approved')`.
    """
    today = datetime.utcnow().date().isoformat()
    properties = [
        {"id": f"p{i}", "brand": "X", "region": "Y", "size_tier": "small", "total_rooms": 30}
        for i in range(1, 6)
    ]
    event_rows = [
        {"property_id": f"p{i}", "date": today, "duration_minutes": 30}
        for i in range(1, 6)
    ]
    captured = []
    sql_seen = []
    client = _make_client(properties, event_rows, captured, sql_capture=sql_seen)

    with patch("src.training.demand_supply_priors.get_supabase_client", return_value=client):
        asyncio.run(aggregate_supply_priors())

    assert len(sql_seen) == 1
    sql = sql_seen[0]
    assert "status in ('recorded', 'approved')" in sql
    assert "date >=" in sql
    cutoff = (datetime.utcnow() - timedelta(days=90)).date().isoformat()
    assert cutoff in sql


def test_supply_aggregate_writes_at_5_hotel_boundary():
    """5-hotel cohort IS upserted; below 5 is skipped uniformly."""
    today = datetime.utcnow().date().isoformat()
    properties = [
        {"id": f"p{i}", "brand": "Hilton", "region": "West", "size_tier": "large", "total_rooms": 100}
        for i in range(1, 6)
    ]
    event_rows = [
        {"property_id": f"p{i}", "date": today, "duration_minutes": 32}
        for i in range(1, 6)
    ]
    captured = []
    client = _make_client(properties, event_rows, captured)

    with patch("src.training.demand_supply_priors.get_supabase_client", return_value=client):
        result = asyncio.run(aggregate_supply_priors())

    assert result["hotels_seen"] == 5
    cohort_keys = [c["payload"]["cohort_key"] for c in captured]
    assert "hilton-west-large" in cohort_keys
    assert "global" in cohort_keys
    specific = next(c for c in captured if c["payload"]["cohort_key"] == "hilton-west-large")
    assert specific["payload"]["prior_minutes_per_event"] == 32.0


def test_supply_aggregate_clips_implausibly_long_events():
    """Outlier defense: cohort median clipped to ≤120 min/event."""
    today = datetime.utcnow().date().isoformat()
    properties = [
        {"id": f"p{i}", "brand": "Z", "region": "Z", "size_tier": "huge", "total_rooms": 30}
        for i in range(1, 6)
    ]
    event_rows = [
        {"property_id": f"p{i}", "date": today, "duration_minutes": 200}
        for i in range(1, 6)
    ]
    captured = []
    client = _make_client(properties, event_rows, captured)

    with patch("src.training.demand_supply_priors.get_supabase_client", return_value=client):
        asyncio.run(aggregate_supply_priors())

    specific = next(c for c in captured if c["payload"]["cohort_key"] == "z-z-huge")
    assert specific["payload"]["prior_minutes_per_event"] == 120.0
