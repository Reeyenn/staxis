"""Day-1 cold-start prediction tests (priority #1 for 300 new hotels).

A brand-new hotel has zero count history, so the only signal is the cohort
prior. `_predict_from_cohort_prior` must give a sane, occupancy-scaled,
non-negative band so the inventory page shows useful day-1 estimates instead of
a blank box.
"""
from src.config import INVENTORY_OCC_BASELINE_PCT
from src.inference.inventory_rate import _predict_from_cohort_prior


def _params(rate=0.4, rooms=80):
    return {"cohort_prior_rate": rate, "room_count": rooms}


def test_p50_at_baseline_equals_rate_times_rooms():
    # At baseline occupancy the occ factor is 1.0 → p50 = prior_rate * room_count.
    q = _predict_from_cohort_prior(_params(0.4, 80), INVENTORY_OCC_BASELINE_PCT)
    assert abs(q["p50"] - 0.4 * 80) < 1e-9


def test_scales_with_occupancy():
    low = _predict_from_cohort_prior(_params(), INVENTORY_OCC_BASELINE_PCT * 0.5)
    base = _predict_from_cohort_prior(_params(), INVENTORY_OCC_BASELINE_PCT)
    high = _predict_from_cohort_prior(_params(), INVENTORY_OCC_BASELINE_PCT * 1.5)
    assert low["p50"] < base["p50"] < high["p50"]
    # proportional: half-occupancy ≈ half the rate
    assert abs(low["p50"] - base["p50"] * 0.5) < 1e-9


def test_band_is_ordered_and_nonnegative():
    q = _predict_from_cohort_prior(_params(), 75.0)
    assert q["p10"] <= q["p25"] <= q["p50"] <= q["p75"] <= q["p90"]
    assert all(q[k] >= 0 for k in ("p10", "p25", "p50", "p75", "p90"))


def test_zero_occupancy_is_nonnegative_not_garbage():
    q = _predict_from_cohort_prior(_params(), 0.0)
    assert all(q[k] >= 0 for k in ("p10", "p25", "p50", "p75", "p90"))


def test_room_count_defaults_when_missing():
    # No room_count in params → defaults to 60, so p50 = rate * 60 at baseline.
    q = _predict_from_cohort_prior({"cohort_prior_rate": 0.5}, INVENTORY_OCC_BASELINE_PCT)
    assert abs(q["p50"] - 0.5 * 60) < 1e-9


def test_band_widens_around_p50():
    # Cold-start band is deliberately wide (±50%) to signal low confidence.
    q = _predict_from_cohort_prior(_params(0.4, 80), INVENTORY_OCC_BASELINE_PCT)
    p50 = q["p50"]
    assert q["p10"] <= p50 * 0.6 and q["p90"] >= p50 * 1.4
