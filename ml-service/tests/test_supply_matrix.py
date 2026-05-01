"""Tests for src/features/supply_matrix.py — the per-room/per-staff
feature engineering helper used by both supply training and inference.

Reeyen, 2026-05-01: 'teach the AI per-room patterns' — these tests pin
the contract so a future refactor can't silently regress the column
list, the inference alignment, or the empty-input handling.
"""

import numpy as np
import pandas as pd
import pytest

from src.features.supply_matrix import build_supply_features


def _row(room_number="101", staff_id="s1", room_type="stayover", stayover_day=1, dow=2, occ=70):
    return {
        "room_number": room_number,
        "staff_id": staff_id,
        "room_type": room_type,
        "stayover_day": stayover_day,
        "day_of_week": dow,
        "occupancy_at_start": occ,
    }


def test_training_emits_room_and_staff_one_hots():
    df = pd.DataFrame([
        _row(room_number="101", staff_id="cindy"),
        _row(room_number="305", staff_id="astri"),
        _row(room_number="412", staff_id="cindy"),
    ])
    X, names = build_supply_features(df, training=True)

    # Core numeric features always present
    for c in ["intercept", "day_of_week", "occupancy_at_start", "is_checkout", "stayover_day_2", "room_floor"]:
        assert c in names, f"core feature {c} missing from training output"

    # Room and staff one-hots emitted for every distinct value
    assert "room_101" in names
    assert "room_305" in names
    assert "room_412" in names
    assert "staff_cindy" in names
    assert "staff_astri" in names

    # Each row's one-hot is exclusive (exactly one room / staff column = 1)
    for i in range(len(X)):
        row_room_cols = [c for c in X.columns if c.startswith("room_") and c != "room_floor"]
        assert int(X.iloc[i][row_room_cols].sum()) == 1


def test_inference_aligns_to_provided_feature_names():
    # Train on rooms 101, 305 — model "knows" only these two rooms
    train_df = pd.DataFrame([
        _row(room_number="101", staff_id="cindy"),
        _row(room_number="305", staff_id="astri"),
    ])
    _, train_names = build_supply_features(train_df, training=True)

    # Inference on a NEW room (412) and a NEW staff (maite) that the
    # model has never seen. They must not crash, and they must end up
    # as all-zero in the relevant one-hot columns (baseline fallback).
    pred_df = pd.DataFrame([_row(room_number="412", staff_id="maite")])
    X, names_used = build_supply_features(
        pred_df, training=False, feature_names=train_names,
    )

    # Column order matches the trained feature_names exactly
    assert list(X.columns) == train_names
    assert names_used == train_names

    # Every column the model knows about exists; unknown room "412" and
    # unknown staff "maite" don't add new columns
    assert "room_412" not in X.columns
    assert "staff_maite" not in X.columns

    # The trained one-hot columns are all 0 for this unknown room/staff
    for c in [col for col in X.columns if col.startswith("room_") and col != "room_floor"]:
        assert float(X.iloc[0][c]) == 0.0
    for c in [col for col in X.columns if col.startswith("staff_")]:
        assert float(X.iloc[0][c]) == 0.0

    # But the numeric features (day/occupancy/floor) are still populated
    assert float(X.iloc[0]["day_of_week"]) == 2.0
    assert float(X.iloc[0]["occupancy_at_start"]) == 70.0
    assert float(X.iloc[0]["room_floor"]) == 4.0


def test_room_floor_parses_first_digit():
    df = pd.DataFrame([
        _row(room_number="101"),
        _row(room_number="305"),
        _row(room_number="412"),
        _row(room_number="A07"),  # non-digit lead → 0
    ])
    X, _ = build_supply_features(df, training=True)
    assert float(X.iloc[0]["room_floor"]) == 1.0
    assert float(X.iloc[1]["room_floor"]) == 3.0
    assert float(X.iloc[2]["room_floor"]) == 4.0
    assert float(X.iloc[3]["room_floor"]) == 0.0


def test_is_checkout_and_stayover_day_2_flags():
    df = pd.DataFrame([
        _row(room_type="checkout", stayover_day=0),
        _row(room_type="stayover", stayover_day=1),
        _row(room_type="stayover", stayover_day=2),
        _row(room_type="stayover", stayover_day=3),  # odd → S1 bucket
    ])
    X, _ = build_supply_features(df, training=True)
    # is_checkout
    assert float(X.iloc[0]["is_checkout"]) == 1.0
    assert float(X.iloc[1]["is_checkout"]) == 0.0
    assert float(X.iloc[2]["is_checkout"]) == 0.0
    # stayover_day_2: 1 only when stayover_day == 2
    assert float(X.iloc[0]["stayover_day_2"]) == 0.0
    assert float(X.iloc[1]["stayover_day_2"]) == 0.0
    assert float(X.iloc[2]["stayover_day_2"]) == 1.0
    assert float(X.iloc[3]["stayover_day_2"]) == 0.0


def test_empty_dataframe_returns_empty_matrix_with_safe_columns():
    # Both training and inference paths must tolerate an empty input
    # rather than raising — caller can decide what to do with it.
    df = pd.DataFrame(columns=["room_number", "staff_id", "room_type", "stayover_day", "day_of_week", "occupancy_at_start"])
    X_train, names_train = build_supply_features(df, training=True)
    assert len(X_train) == 0
    assert "intercept" in names_train

    X_inf, names_inf = build_supply_features(
        df, training=False, feature_names=["intercept", "day_of_week", "occupancy_at_start"],
    )
    assert len(X_inf) == 0
    assert names_inf == ["intercept", "day_of_week", "occupancy_at_start"]


def test_inference_without_feature_names_raises():
    df = pd.DataFrame([_row()])
    with pytest.raises(ValueError, match="feature_names required"):
        build_supply_features(df, training=False)


def test_unobserved_columns_dropped_from_training_output():
    # If every row has the same room_type (all stayover), the is_checkout
    # column is all zeros. The helper should still keep the core numeric
    # features (always present) but trim genuinely-zero one-hot columns
    # so the parameter count doesn't bloat for nothing.
    df = pd.DataFrame([
        _row(room_number="101", staff_id="cindy", room_type="stayover", stayover_day=1),
        _row(room_number="101", staff_id="cindy", room_type="stayover", stayover_day=1),
    ])
    X, names = build_supply_features(df, training=True)
    # is_checkout is all-zero but is in the core list — kept
    assert "is_checkout" in names
    # stayover_day_2 is all-zero but in the core list — kept
    assert "stayover_day_2" in names
    # The single observed room and staff are present
    assert "room_101" in names
    assert "staff_cindy" in names
