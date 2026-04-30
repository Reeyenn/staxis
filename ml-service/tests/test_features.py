"""Tests for feature engineering modules."""
import numpy as np
import pytest

from src.features.housekeeper import get_housekeeper_features
from src.features.mix import get_mix_features
from src.features.occupancy import get_occupancy_features
from src.features.pace import get_pace_features
from src.features.room import get_room_features


def test_occupancy_features():
    """Test occupancy feature extraction."""
    features = get_occupancy_features(
        in_house_count=45,
        arrivals_today=10,
        departures_today=8,
        total_rooms=100,
        occupancy_7d_avg=50.0,
    )

    assert features["in_house"] == 45
    assert features["arrivals_today"] == 10
    assert features["departures_today"] == 8
    assert features["occupancy_pct"] == 45.0


def test_mix_features():
    """Test workload mix feature extraction."""
    features = get_mix_features(
        total_checkouts=10,
        stayover_day_1_count=20,
        stayover_day_2plus_count=40,
        vacant_dirty_count=5,
    )

    assert features["total_checkouts"] == 10
    assert features["stayover_day_1_count"] == 20
    assert 0 <= features["pct_checkout"] <= 100
    assert 0 <= features["pct_stayover_day_1"] <= 100


def test_pace_features():
    """Test pace (cleaning speed) features."""
    features = get_pace_features(
        avg_minutes_per_room_7d=24.5,
        avg_minutes_per_room_30d=25.0,
        occupancy_at_start=50,
    )

    assert features["avg_minutes_per_room_7d"] == 24.5
    assert features["occupancy_at_start"] == 50


def test_pace_features_default():
    """Test pace features with defaults."""
    features = get_pace_features()

    assert features["avg_minutes_per_room_7d"] == 25.0  # Default prior
    assert features["occupancy_at_start"] == 0


def test_housekeeper_features_cold_start():
    """Test housekeeper features with cold-start staff."""
    features = get_housekeeper_features(
        staff_id="uuid-1",
        num_cleans_30d=5,  # Cold start (< 20)
    )

    assert features["is_cold_start_staff"] is True
    assert features["num_cleans_30d"] == 5


def test_housekeeper_features_warm():
    """Test housekeeper features with established staff."""
    features = get_housekeeper_features(
        staff_id="uuid-1",
        avg_minutes_per_clean=23.5,
        num_cleans_30d=45,  # Warm (>= 20)
    )

    assert features["is_cold_start_staff"] is False
    assert features["num_cleans_30d"] == 45


def test_room_features():
    """Test room-level features."""
    features = get_room_features(
        room_number="301",
        room_type="double",
        was_dnd=False,
        day_of_stay=2,
    )

    assert features["room_number"] == "301"
    assert features["room_floor"] == 3
    assert features["day_of_stay"] == 2


def test_room_features_floor_parsing():
    """Test floor parsing from room number."""
    # Test various room numbers
    features_4xx = get_room_features("402", "single")
    assert features_4xx["room_floor"] == 4

    features_1xx = get_room_features("105", "single")
    assert features_1xx["room_floor"] == 1
