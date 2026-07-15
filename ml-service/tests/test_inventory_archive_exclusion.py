"""Archived inventory must never be trained or served by the ML pipeline."""
from datetime import date
from unittest.mock import MagicMock, patch

import pytest

from src.inference.inventory_rate import _predict_single_item, predict_inventory_rates
from src.training.inventory_rate import _train_inventory_inner


PROPERTY_ID = "8a041d6e-d881-4f19-83e0-7250f0e36eaa"


def test_training_inventory_census_requires_unarchived_items():
    client = MagicMock()
    client.fetch_many.return_value = []

    result = _train_inventory_inner(PROPERTY_ID, None, MagicMock(), client)

    assert result["note"] == "no items found"
    client.fetch_many.assert_called_once_with(
        "inventory",
        filters={"property_id": PROPERTY_ID, "archived_at": None},
        limit=500,
    )


@pytest.mark.asyncio
async def test_inference_filters_retained_model_runs_to_active_item_ids():
    client = MagicMock()
    client.fetch_many.side_effect = [
        [{"id": "active-item"}],
        [
            {"id": "run-active", "item_id": "active-item"},
            {"id": "run-archived", "item_id": "archived-item"},
        ],
    ]
    client.fetch_one.return_value = {
        "total_rooms": 100,
        "stayovers": 50,
        "arrivals": 10,
        "checkouts": 20,
    }

    with (
        patch("src.inference.inventory_rate.get_settings", return_value=MagicMock()),
        patch("src.inference.inventory_rate.get_supabase_client", return_value=client),
        patch(
            "src.inference.inventory_rate._predict_single_item",
            return_value={"predicted": True},
        ) as predict_one,
    ):
        result = await predict_inventory_rates(
            PROPERTY_ID,
            target_date=date(2026, 7, 16),
        )

    assert result["predicted"] == 1
    assert client.fetch_many.call_args_list[0].args == ("inventory",)
    assert client.fetch_many.call_args_list[0].kwargs == {
        "filters": {"property_id": PROPERTY_ID, "archived_at": None},
        "limit": 1000,
    }
    predict_one.assert_called_once()
    assert predict_one.call_args.kwargs["item_id"] == "active-item"


def test_inference_rechecks_item_before_prediction_write():
    client = MagicMock()
    client.fetch_one.return_value = None
    run = {
        "id": "run-1",
        "algorithm": "cold-start-cohort-prior",
        "posterior_params": {
            "cohort_prior_rate": 0.05,
            "room_count": 50,
        },
    }

    result = _predict_single_item(
        run=run,
        property_id=PROPERTY_ID,
        item_id="archived-item",
        target_date_iso="2026-07-16",
        occ_pct=60.0,
        exposure_co_so=None,
        client=client,
    )

    assert result == {"predicted": False, "reason": "item_archived_or_missing"}
    client.fetch_one.assert_called_once_with(
        "inventory",
        filters={
            "id": "archived-item",
            "property_id": PROPERTY_ID,
            "archived_at": None,
        },
    )
    client.insert.assert_not_called()
