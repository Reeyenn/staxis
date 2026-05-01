"""Feature matrix builder for the Layer 2 supply model.

This module is the single source of truth for what the supply layer
"sees." Both training (src/training/supply.py) and inference
(src/inference/supply.py) call build_supply_features() so their column
order is byte-identical — drift between the two would make the trained
posterior nonsense at inference time.

Features (Reeyen, 2026-05-01: 'teach the AI per-room patterns'):

  intercept                 baseline term, always 1.0
  day_of_week               numeric 0-6 (Sun..Sat) — captures weekly rhythm
  occupancy_at_start        numeric 0-100 — busy hotel ⇒ slower cleans
  is_checkout               1 if checkout, 0 otherwise
  stayover_day_2            1 if S2 (full clean with bed change), else 0
  room_floor                numeric — captures elevator / cart-haul effect
  room_<NUMBER>             one column per distinct room. Each room gets
                            its own coefficient so the model learns
                            'room 305 reliably runs +5 min' or 'room 412
                            consistently quick.' This is the per-room-size
                            effect Reeyen asked for. Rooms not seen in
                            training silently land in the baseline.
  staff_<UUID>              one column per distinct housekeeper. Captures
                            individual pace differences (Cindy is faster
                            on stayovers, Astri slower on checkouts, etc.)
                            without needing an interaction term that would
                            blow up the parameter count.

WHY ONE-HOT WITHOUT DROPPING A BASELINE:
  Classical regression drops one level per categorical to avoid perfect
  multicollinearity. With Bayesian regression and a weak Gaussian prior
  on coefficients, redundancy is fine — the prior pulls each coefficient
  toward zero and the posterior assigns the shared mean to the intercept.
  Keeping ALL one-hot columns is simpler and removes the 'whichever room
  got dropped is now the implicit baseline' trap.

DATA THIN-NESS:
  ~50 rooms × ~6 housekeepers ≈ 60-70 categorical features. Activation
  gate requires ≥500 cleaning_events, so ~8 observations per feature on
  average. Bayesian regression handles this gracefully — under-observed
  rooms keep coefficients near zero and the prediction falls back to the
  intercept + day/occupancy/type effects. As cleaning events accumulate
  per room, that room's coefficient moves away from zero and starts
  capturing its specific characteristics.

USAGE:
  TRAINING:
    X, feature_names = build_supply_features(df, training=True)
    # ... fit model on X ...
    # store feature_names in model_runs.posterior_params

  INFERENCE:
    X, _ = build_supply_features(df, training=False, feature_names=saved_feature_names)
    # ... predict on X ...
"""

from __future__ import annotations

from typing import List, Optional, Tuple

import numpy as np
import pandas as pd


def _floor_of(room_number) -> int:
    """First digit of the room number → floor. Room 305 → 3, room 1A → 1.

    Returns 0 for anything we can't parse — those rows still get a
    consistent (zero) value rather than a NaN that would corrupt the
    feature matrix.
    """
    s = str(room_number)
    if not s:
        return 0
    c = s[0]
    return int(c) if c.isdigit() else 0


def build_supply_features(
    df: pd.DataFrame,
    *,
    training: bool,
    feature_names: Optional[List[str]] = None,
) -> Tuple[pd.DataFrame, List[str]]:
    """Build the supply-model feature matrix.

    Args:
      df: rows with at least the columns
            day_of_week, occupancy_at_start,
            room_type, stayover_day,
            room_number, staff_id
          Missing columns get sensible defaults (NaN→0, room_type→stayover,
          etc.) so the function never raises on partially-populated input.

      training: True at training time (column set is whatever is observed
        in df). False at inference time — `feature_names` MUST be
        provided and the output matrix has exactly those columns in that
        order, with unknown rooms/staff silently mapped to all-zero
        (baseline) rows.

      feature_names: required when training=False. The list saved on
        model_runs.posterior_params from the matching training run.

    Returns:
      (X, feature_names_used)
    """
    n = len(df)
    if n == 0:
        cols = feature_names or [
            "intercept", "day_of_week", "occupancy_at_start",
            "is_checkout", "stayover_day_2", "room_floor",
        ]
        empty = pd.DataFrame({c: pd.Series(dtype=float) for c in cols})
        return empty, cols

    # Coerce / default the input columns so downstream math never sees NaN.
    dow = pd.to_numeric(df.get("day_of_week", pd.Series([0] * n)), errors="coerce").fillna(0).astype(int)
    occ = pd.to_numeric(df.get("occupancy_at_start", pd.Series([50] * n)), errors="coerce").fillna(50).astype(float)
    room_type = df.get("room_type", pd.Series(["stayover"] * n)).astype(str)
    stayover_day = pd.to_numeric(df.get("stayover_day", pd.Series([0] * n)), errors="coerce").fillna(0).astype(int)
    room_number = df.get("room_number", pd.Series([""] * n)).astype(str)
    staff_id = df.get("staff_id", pd.Series([""] * n)).astype(str)

    base = pd.DataFrame({
        "intercept": np.ones(n, dtype=float),
        "day_of_week": dow.astype(float),
        "occupancy_at_start": occ,
        "is_checkout": (room_type == "checkout").astype(float),
        "stayover_day_2": (stayover_day == 2).astype(float),
        "room_floor": room_number.map(_floor_of).astype(float),
    })

    # One-hot encodings. Use prefix='room' / 'staff' so the column names
    # are unambiguous when we later parse them back at inference time.
    # Drop NaN columns get_dummies might emit for empty strings.
    room_dummies = pd.get_dummies(
        room_number.where(room_number.str.len() > 0), prefix="room", dtype=float,
    )
    staff_dummies = pd.get_dummies(
        staff_id.where(staff_id.str.len() > 0), prefix="staff", dtype=float,
    )

    X_full = pd.concat([base.reset_index(drop=True), room_dummies.reset_index(drop=True), staff_dummies.reset_index(drop=True)], axis=1)

    if training:
        # Drop columns that are perfectly zero (never observed) to avoid
        # bloating the parameter count for nothing. The intercept absorbs
        # any constant contribution.
        nonzero_cols = [c for c in X_full.columns if X_full[c].abs().sum() > 0]
        # Always keep core numeric features even if they happen to be all
        # zero on this slice (e.g., a tiny dev dataset where occupancy
        # was never recorded).
        core = ["intercept", "day_of_week", "occupancy_at_start", "is_checkout", "stayover_day_2", "room_floor"]
        kept = [c for c in core if c in X_full.columns] + [c for c in nonzero_cols if c not in core]
        X = X_full[kept].copy()
        return X, kept

    # Inference path: the caller provides the exact column list the model
    # was trained against. Align X to that list — missing columns become
    # zero (a room or staff never seen in training falls into the
    # baseline), extras get dropped (we'd need a retrain to use them).
    if feature_names is None:
        raise ValueError("feature_names required when training=False")
    aligned = pd.DataFrame(index=X_full.index)
    for col in feature_names:
        aligned[col] = X_full[col] if col in X_full.columns else 0.0
    return aligned, feature_names
