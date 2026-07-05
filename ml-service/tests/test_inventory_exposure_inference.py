"""Tests for exposure-family inference serving + exposure/stayover alignment.

Covers:
  * _exposure_for_target_date: stayovers + arrivals (daily_logs-aligned)
  * _recent_avg_exposure fallback (skips NULL days)
  * _predict_single_item routes the exposure algorithm and applies κ
  * stale exposure feature-set version is refused
  * missing exposure input → predicted False (never cross-serves occupancy)
"""
from unittest.mock import MagicMock

from src.config import (
    INVENTORY_EXPOSURE_ALGORITHM,
    INVENTORY_EXPOSURE_FEATURE_SET_VERSION,
)
from src.inference.inventory_rate import (
    _exposure_for_target_date,
    _predict_single_item,
    _recent_avg_exposure,
)


# ── stayover alignment ──

def test_exposure_for_target_date_adds_arrivals_to_stayovers():
    """daily_logs.stayovers INCLUDES arrivals (0224); plan_snapshots splits them,
    so serving exposure stayover = stayovers + arrivals."""
    plan = {"checkouts": 12, "stayovers": 40, "arrivals": 8, "total_rooms": 80}
    co, so = _exposure_for_target_date(plan)
    assert co == 12.0
    assert so == 48.0  # 40 + 8


def test_exposure_for_target_date_missing_arrivals_treated_zero():
    plan = {"checkouts": 12, "stayovers": 40, "total_rooms": 80}
    co, so = _exposure_for_target_date(plan)
    assert (co, so) == (12.0, 40.0)


def test_exposure_for_target_date_none_when_core_missing():
    assert _exposure_for_target_date({"checkouts": 12}) is None
    assert _exposure_for_target_date(None) is None


def test_recent_avg_exposure_skips_null_days():
    logs = [
        {"checkouts": 10, "stayovers": 30},
        {"checkouts": None, "stayovers": 30},  # skipped
        {"checkouts": 14, "stayovers": 34},
    ]
    got = _recent_avg_exposure(logs)
    assert got == ((10 + 14) / 2.0, (30 + 34) / 2.0)


def test_recent_avg_exposure_none_when_all_null():
    assert _recent_avg_exposure([{"checkouts": None, "stayovers": None}]) is None
    assert _recent_avg_exposure([]) is None


# ── serving ──

def _exposure_run(feature_version=INVENTORY_EXPOSURE_FEATURE_SET_VERSION):
    # posterior [base≈0, s=0.5], kappa=0.3
    return {
        "id": "mr",
        "property_id": "p",
        "item_id": "i",
        "algorithm": INVENTORY_EXPOSURE_ALGORITHM,
        "feature_set_version": feature_version,
        "posterior_params": {
            "mu_n": [0.0, 0.5],
            "sigma_n": [[1e-9, 0.0], [0.0, 1e-9]],
            "alpha_n": 1e6,
            "beta_n": 1e6,
            "kappa": 0.3,
        },
    }


def _serving_client():
    client = MagicMock()
    client.fetch_one.return_value = {"id": "i", "name": "Shampoo"}
    client.fetch_many.side_effect = lambda table, **k: []
    client.insert.return_value = {}
    # stock-integration raw chain
    tm = MagicMock()
    sel = MagicMock()
    tm.select.return_value = sel
    sel.eq.return_value = sel
    sel.gt.return_value = sel
    sel.execute.return_value = MagicMock(data=[])
    dm = MagicMock()
    dm.delete.return_value.eq.return_value.eq.return_value.eq.return_value.execute.return_value = None
    def table(name):
        return dm if name == "inventory_rate_predictions" else tm
    client.client = MagicMock()
    client.client.table.side_effect = table
    return client


def test_exposure_serving_applies_kappa_and_predicts():
    client = _serving_client()
    captured = {}
    def insert(table, row):
        captured["row"] = row
        return {}
    client.insert.side_effect = insert
    res = _predict_single_item(
        run=_exposure_run(),
        property_id="p", item_id="i",
        target_date_iso="2026-05-15",
        occ_pct=70.0,
        exposure_co_so=(10.0, 30.0),  # exposure = 10 + 0.3*30 = 19
        client=client,
    )
    assert res.get("predicted") is True
    # p50 ≈ s*exposure = 0.5*19 = 9.5
    assert abs(captured["row"]["predicted_daily_rate"] - 9.5) < 0.2


def test_exposure_stale_feature_version_refused():
    res = _predict_single_item(
        run=_exposure_run(feature_version="wrong-version"),
        property_id="p", item_id="i",
        target_date_iso="2026-05-15",
        occ_pct=70.0,
        exposure_co_so=(10.0, 30.0),
        client=_serving_client(),
    )
    assert res == {"predicted": False, "reason": "stale_feature_set"}


def test_exposure_no_exposure_input_returns_false():
    res = _predict_single_item(
        run=_exposure_run(),
        property_id="p", item_id="i",
        target_date_iso="2026-05-15",
        occ_pct=70.0,
        exposure_co_so=None,  # no exposure at all
        client=_serving_client(),
    )
    assert res == {"predicted": False, "reason": "no_exposure_input"}
