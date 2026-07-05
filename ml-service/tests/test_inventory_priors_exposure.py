"""Tests for the reduced-exposure priors rework in aggregate_inventory_priors.

Covers:
  * is_test properties excluded from the Python property fetch
  * the rate SQL carries the exposure denominator + is_test + daily_logs joins
  * rate_per_checkout_eq + n_hotels are written to inventory_rate_priors
  * per-checkout-equivalent median is pooled across same-canonical SKUs

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


def test_is_test_property_excluded_from_python_fetch():
    """A test/demo property must not appear in the cohort aggregation."""
    properties = [
        {"id": "p1", "brand": "Comfort", "region": "Gulf", "size_tier": "small",
         "total_rooms": 60, "is_test": False},
        {"id": "pTest", "brand": "Comfort", "region": "Gulf", "size_tier": "small",
         "total_rooms": 60, "is_test": True},
    ]
    canonical_rows = [{"item_id": "i1", "item_canonical_name": "towel bath"}]
    # SQL would already filter is_test, but even if a test-property row leaked in,
    # prop_meta must not contain it → its cohort keys never form.
    rate_rows = [
        {"property_id": "p1", "item_id": "i1", "median_rate": 0.3, "median_s": 0.4,
         "n_pairs": 6, "n_pairs_s": 6},
        {"property_id": "pTest", "item_id": "i1", "median_rate": 9.9, "median_s": 9.9,
         "n_pairs": 6, "n_pairs_s": 6},
    ]
    captured = []
    client = _make_client(properties, canonical_rows, rate_rows, captured)
    with patch("src.training.inventory_priors.get_supabase_client", return_value=client):
        asyncio.run(aggregate_inventory_priors())

    # The specific cohort towel prior should reflect ONLY p1's 0.3, not pTest's 9.9.
    specific = [c for c in captured
                if c["payload"]["cohort_key"] == "comfort-gulf-small"
                and c["payload"]["item_canonical_name"] == "towel bath"]
    assert specific, "cohort prior should be written for the real property"
    assert abs(specific[0]["payload"]["prior_rate_per_room_per_day"] - 0.3) < 1e-9


def test_rate_sql_has_exposure_and_is_test_filters():
    properties = [
        {"id": "p1", "brand": "B", "region": "R", "size_tier": "small",
         "total_rooms": 60, "is_test": False},
    ]
    canonical_rows = [{"item_id": "i1", "item_canonical_name": "towel bath"}]
    rate_rows = [{"property_id": "p1", "item_id": "i1", "median_rate": 0.3,
                  "median_s": 0.4, "n_pairs": 6, "n_pairs_s": 6}]
    captured, sql_seen = [], []
    client = _make_client(properties, canonical_rows, rate_rows, captured, sql_capture=sql_seen)
    with patch("src.training.inventory_priors.get_supabase_client", return_value=client):
        asyncio.run(aggregate_inventory_priors())

    assert len(sql_seen) == 1
    sql = sql_seen[0]
    # is_test exclusion
    assert "is_test" in sql
    # exposure denominator + daily_logs join
    assert "s_per_checkout_eq" in sql
    assert "daily_logs" in sql
    assert "sum_checkouts" in sql and "sum_stayovers" in sql
    # kappa from inventory usage config
    assert "usage_per_stayover" in sql and "usage_per_checkout" in sql
    # kept legacy filters
    assert "inventory_ai_mode" in sql and "<> 'off'" in sql
    assert "w.days >= 1.0" in sql


def test_exposure_prior_written():
    """rate_per_checkout_eq + n_hotels land in the upsert payload."""
    properties = [
        {"id": "p1", "brand": "B", "region": "R", "size_tier": "small",
         "total_rooms": 60, "is_test": False},
    ]
    canonical_rows = [
        {"item_id": "i1", "item_canonical_name": "towel bath"},
        {"item_id": "i2", "item_canonical_name": "towel bath"},
    ]
    rate_rows = [
        {"property_id": "p1", "item_id": "i1", "median_rate": 0.2, "median_s": 0.3,
         "n_pairs": 6, "n_pairs_s": 6},
        {"property_id": "p1", "item_id": "i2", "median_rate": 0.4, "median_s": 0.5,
         "n_pairs": 6, "n_pairs_s": 6},
    ]
    captured = []
    client = _make_client(properties, canonical_rows, rate_rows, captured)
    with patch("src.training.inventory_priors.get_supabase_client", return_value=client):
        asyncio.run(aggregate_inventory_priors())

    specific = [c for c in captured
                if c["payload"]["cohort_key"] == "b-r-small"
                and c["payload"]["item_canonical_name"] == "towel bath"]
    assert specific
    payload = specific[0]["payload"]
    # per-room prior = median(0.2, 0.4) = 0.3
    assert abs(payload["prior_rate_per_room_per_day"] - 0.3) < 1e-9
    # exposure prior = median(0.3, 0.5) = 0.4
    assert "rate_per_checkout_eq" in payload
    assert abs(payload["rate_per_checkout_eq"] - 0.4) < 1e-9
    assert payload["n_hotels"] == 1


def test_missing_exposure_leaves_rate_per_checkout_eq_absent():
    """When no window had complete daily_logs exposure (median_s NULL), the
    upsert must NOT carry rate_per_checkout_eq (stays NULL in DB)."""
    properties = [
        {"id": "p1", "brand": "B", "region": "R", "size_tier": "small",
         "total_rooms": 60, "is_test": False},
    ]
    canonical_rows = [{"item_id": "i1", "item_canonical_name": "towel bath"}]
    rate_rows = [{"property_id": "p1", "item_id": "i1", "median_rate": 0.3,
                  "median_s": None, "n_pairs": 6, "n_pairs_s": 0}]
    captured = []
    client = _make_client(properties, canonical_rows, rate_rows, captured)
    with patch("src.training.inventory_priors.get_supabase_client", return_value=client):
        asyncio.run(aggregate_inventory_priors())

    specific = [c for c in captured
                if c["payload"]["cohort_key"] == "b-r-small"]
    assert specific
    assert "rate_per_checkout_eq" not in specific[0]["payload"]
    assert specific[0]["payload"]["n_hotels"] == 0
