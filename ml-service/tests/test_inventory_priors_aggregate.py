"""Behavior tests for aggregate_inventory_priors (cohort cold-start priors).

Covers the cold-start prior-quality fixes:
  * same-canonical SKUs at one hotel ALL contribute (dict append, not overwrite)
  * AI-off hotels are excluded from the contributor SQL
  * window-hygiene filters are present in the rate SQL

No real Supabase — a fake client returns seeded rows.
"""
import asyncio
from unittest.mock import MagicMock, patch

from src.training.inventory_priors import aggregate_inventory_priors


def _make_client(properties, canonical_rows, rate_rows, upsert_capture, *, sql_capture=None):
    client = MagicMock()

    def fetch_many(table, **kwargs):
        if table == "properties":
            return properties
        if table == "item_canonical_name_view":
            return canonical_rows
        return []

    def execute_sql(sql):
        if sql_capture is not None:
            sql_capture.append(sql)
        return rate_rows

    client.fetch_many.side_effect = fetch_many
    client.execute_sql.side_effect = execute_sql

    def upsert(payload, on_conflict=None):
        upsert_capture.append({"payload": payload, "on_conflict": on_conflict})
        ex = MagicMock()
        ex.execute.return_value = MagicMock(data=[payload])
        return ex

    table_mock = MagicMock()
    table_mock.upsert.side_effect = upsert
    client.client = MagicMock()
    client.client.table.return_value = table_mock
    return client


def test_same_canonical_skus_both_contribute():
    """Two SKUs at one hotel both map to 'towel' → the cohort prior is the
    median of BOTH per-SKU rates (0.2, 0.4 → 0.3), not just the last one (0.4).

    Regression for the dict-overwrite bug that silently dropped every
    same-canonical SKU except the last.
    """
    properties = [
        {"id": "p1", "brand": "Comfort", "region": "Gulf", "size_tier": "small", "total_rooms": 60},
    ]
    canonical_rows = [
        {"item_id": "i1", "item_canonical_name": "towel"},
        {"item_id": "i2", "item_canonical_name": "towel"},
    ]
    rate_rows = [
        {"property_id": "p1", "item_id": "i1", "median_rate": 0.2, "n_pairs": 6},
        {"property_id": "p1", "item_id": "i2", "median_rate": 0.4, "n_pairs": 6},
    ]
    captured = []
    client = _make_client(properties, canonical_rows, rate_rows, captured)
    with patch("src.training.inventory_priors.get_supabase_client", return_value=client):
        asyncio.run(aggregate_inventory_priors())

    specific = [c for c in captured
                if c["payload"]["cohort_key"] == "comfort-gulf-small"
                and c["payload"]["item_canonical_name"] == "towel"]
    assert specific, "specific cohort towel prior should be upserted"
    assert abs(specific[0]["payload"]["prior_rate_per_room_per_day"] - 0.3) < 1e-9


def test_rate_sql_has_hygiene_and_ai_off_filters():
    """The contributor SQL must exclude AI-off hotels and contaminated windows."""
    properties = [
        {"id": "p1", "brand": "B", "region": "R", "size_tier": "small", "total_rooms": 60},
    ]
    canonical_rows = [{"item_id": "i1", "item_canonical_name": "towel"}]
    rate_rows = [{"property_id": "p1", "item_id": "i1", "median_rate": 0.3, "n_pairs": 6}]
    captured, sql_seen = [], []
    client = _make_client(properties, canonical_rows, rate_rows, captured, sql_capture=sql_seen)
    with patch("src.training.inventory_priors.get_supabase_client", return_value=client):
        asyncio.run(aggregate_inventory_priors())

    assert len(sql_seen) == 1
    sql = sql_seen[0]
    assert "inventory_ai_mode" in sql and "<> 'off'" in sql
    assert "w.days >= 1.0" in sql
    # consumption > 0 hygiene filter
    assert "- w.curr_stock) > 0" in sql


def test_empty_network_graceful():
    captured = []
    client = _make_client([], [], [], captured)
    with patch("src.training.inventory_priors.get_supabase_client", return_value=client):
        result = asyncio.run(aggregate_inventory_priors())
    assert result["cohorts_updated"] == 0
    assert captured == []
