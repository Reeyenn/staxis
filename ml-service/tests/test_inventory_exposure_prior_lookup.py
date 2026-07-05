"""Tests for _lookup_exposure_prior_with_source (precision cap + fallbacks)."""
from unittest.mock import MagicMock

from src.training.inventory_rate import (
    EXPOSURE_PRIOR_STRENGTH_CAP,
    _lookup_exposure_prior_with_source,
)


def _client(rows_by_key):
    """rows_by_key: {(cohort_key, canonical): row_dict}."""
    client = MagicMock()

    def fetch_many(table, filters=None, **kwargs):
        if table == "inventory_rate_priors" and filters:
            key = (filters.get("cohort_key"), filters.get("item_canonical_name"))
            row = rows_by_key.get(key)
            return [row] if row else []
        return []

    client.fetch_many.side_effect = fetch_many
    return client


def test_exposure_prior_used_when_present():
    client = _client({
        ("comfort-gulf-small", "shampoo"): {
            "rate_per_checkout_eq": 0.42, "prior_strength": 2.0, "n_hotels": 6,
        }
    })
    s, strength, source = _lookup_exposure_prior_with_source(
        client, "comfort-gulf-small", {}, "shampoo"
    )
    assert s == 0.42
    assert source == "cohort-exposure"
    # n_hotels >= 4 → cap NOT applied → full strength
    assert strength == 2.0


def test_precision_cap_applied_below_4_hotels():
    client = _client({
        ("comfort-gulf-small", "shampoo"): {
            "rate_per_checkout_eq": 0.42, "prior_strength": 5.0, "n_hotels": 2,
        }
    })
    s, strength, source = _lookup_exposure_prior_with_source(
        client, "comfort-gulf-small", {}, "shampoo"
    )
    assert s == 0.42
    # n_hotels < 4 → capped to EXPOSURE_PRIOR_STRENGTH_CAP
    assert strength == EXPOSURE_PRIOR_STRENGTH_CAP


def test_falls_back_to_per_room_when_no_exposure_prior():
    client = _client({
        ("global", "shampoo"): {
            "prior_rate_per_room_per_day": 0.40, "prior_strength": 2.0, "n_hotels": 0,
            "n_hotels_contributing": 8,
        }
    })
    s, strength, source = _lookup_exposure_prior_with_source(
        client, "comfort-gulf-small", {}, "shampoo"  # cohort miss → global hit
    )
    assert s == 0.40
    assert source == "global-perroom"


def test_default_when_unknown_canonical():
    client = _client({})
    s, strength, source = _lookup_exposure_prior_with_source(
        client, "comfort-gulf-small", {}, "unknown"
    )
    assert source == "default"
    assert strength <= 1.0


def test_default_when_no_rows():
    client = _client({})
    s, strength, source = _lookup_exposure_prior_with_source(
        client, "comfort-gulf-small", {}, "shampoo"
    )
    assert source == "default"
