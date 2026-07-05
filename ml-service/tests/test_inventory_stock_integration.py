"""Tests for the day-by-day exposure stock integration.

Pins _compute_predicted_current_stock_exposure:
  * integrates s·Σ_days(CO_d + κ·SO_d) using real daily_logs since the count
  * NULL-gapped days fall back to the window mean
  * no known exposure days → flat-rate fallback
  * orders/discards since count are applied
  * result clamps >= 0

Fake supabase client returns seeded rows.
"""
from unittest.mock import MagicMock

import pandas as pd

from src.inference.inventory_rate import _compute_predicted_current_stock_exposure


def _client(*, last_count, orders=None, discards=None, daily_logs=None):
    client = MagicMock()

    def fetch_many(table, **kwargs):
        if table == "inventory_counts":
            return [last_count]
        if table == "daily_logs":
            return daily_logs or []
        return []

    client.fetch_many.side_effect = fetch_many

    # orders/discards via the raw table().select().eq().eq().gt().execute() chain
    def table(name):
        tm = MagicMock()
        sel = MagicMock()
        tm.select.return_value = sel
        sel.eq.return_value = sel
        sel.gt.return_value = sel
        if name == "inventory_orders":
            sel.execute.return_value = MagicMock(data=orders or [])
        elif name == "inventory_discards":
            sel.execute.return_value = MagicMock(data=discards or [])
        else:
            sel.execute.return_value = MagicMock(data=[])
        return tm

    client.client = MagicMock()
    client.client.table.side_effect = table
    return client


def _days_ago(n):
    return (pd.Timestamp.utcnow().tz_localize(None) - pd.Timedelta(days=n))


def test_integrates_real_exposure_days():
    """3 days since count, each with CO=10 SO=20, κ=0.3, s=0.5.
    per-day exposure = 10 + 0.3*20 = 16 → 3 days = 48 → consumed = 24.
    predicted = 100 - 24 = 76 (± the fractional last day)."""
    last_at = _days_ago(3)
    last_count = {"counted_stock": 100, "counted_at": last_at.isoformat()}
    logs = []
    for i in range(1, 4):
        d = (last_at + pd.Timedelta(days=i)).date()
        logs.append({"date": d.isoformat(), "checkouts": 10, "stayovers": 20})
    client = _client(last_count=last_count, daily_logs=logs)
    got = _compute_predicted_current_stock_exposure(
        property_id="p", item_id="i", s_coef=0.5, kappa=0.3,
        fallback_daily_rate=99.0, client=client,
    )
    # ~76; allow tolerance for day rounding
    assert 70 <= got <= 82


def test_null_gap_day_uses_window_mean():
    """One of the 3 days is missing from daily_logs → filled with window mean
    (equal to the other days here) → same total as if present."""
    last_at = _days_ago(3)
    last_count = {"counted_stock": 100, "counted_at": last_at.isoformat()}
    d1 = (last_at + pd.Timedelta(days=1)).date()
    d3 = (last_at + pd.Timedelta(days=3)).date()
    logs = [
        {"date": d1.isoformat(), "checkouts": 10, "stayovers": 20},
        # day 2 missing
        {"date": d3.isoformat(), "checkouts": 10, "stayovers": 20},
    ]
    client = _client(last_count=last_count, daily_logs=logs)
    got = _compute_predicted_current_stock_exposure(
        property_id="p", item_id="i", s_coef=0.5, kappa=0.3,
        fallback_daily_rate=99.0, client=client,
    )
    assert 70 <= got <= 82


def test_no_known_days_uses_flat_fallback():
    """No usable daily_logs → flat-rate fallback: 100 - fallback_daily_rate*3."""
    last_at = _days_ago(3)
    last_count = {"counted_stock": 100, "counted_at": last_at.isoformat()}
    client = _client(last_count=last_count, daily_logs=[])
    got = _compute_predicted_current_stock_exposure(
        property_id="p", item_id="i", s_coef=0.5, kappa=0.3,
        fallback_daily_rate=5.0, client=client,
    )
    # 100 - 5*3 = 85
    assert 84 <= got <= 86


def test_orders_and_discards_applied():
    last_at = _days_ago(2)
    last_count = {"counted_stock": 50, "counted_at": last_at.isoformat()}
    logs = []
    for i in range(1, 3):
        d = (last_at + pd.Timedelta(days=i)).date()
        logs.append({"date": d.isoformat(), "checkouts": 0, "stayovers": 0})  # zero exposure
    client = _client(
        last_count=last_count, daily_logs=logs,
        orders=[{"quantity": 30}], discards=[{"quantity": 5}],
    )
    got = _compute_predicted_current_stock_exposure(
        property_id="p", item_id="i", s_coef=0.5, kappa=0.3,
        fallback_daily_rate=1.0, client=client,
    )
    # zero exposure consumed → 50 + 30 - 5 - 0 = 75
    assert abs(got - 75.0) < 1e-6


def test_clamps_non_negative():
    last_at = _days_ago(10)
    last_count = {"counted_stock": 5, "counted_at": last_at.isoformat()}
    logs = []
    for i in range(1, 11):
        d = (last_at + pd.Timedelta(days=i)).date()
        logs.append({"date": d.isoformat(), "checkouts": 100, "stayovers": 100})
    client = _client(last_count=last_count, daily_logs=logs)
    got = _compute_predicted_current_stock_exposure(
        property_id="p", item_id="i", s_coef=1.0, kappa=0.3,
        fallback_daily_rate=1.0, client=client,
    )
    assert got == 0.0


def test_no_prior_count_returns_zero():
    client = MagicMock()
    client.fetch_many.side_effect = lambda table, **k: []
    got = _compute_predicted_current_stock_exposure(
        property_id="p", item_id="i", s_coef=0.5, kappa=0.3,
        fallback_daily_rate=1.0, client=client,
    )
    assert got == 0.0
