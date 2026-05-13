"""Regression tests for Phase 3 (long-term resilience) fixes.

Each test pins a specific change from the 2026-05-13 Phase 3 plan so the
class of regression can't ship again. When you read this file, the
docstring on each test names the bug it locks down.
"""
import json
import os
from pathlib import Path
from typing import Any, Dict

import pytest

from src.errors import (
    PropertyMisconfiguredError,
    require_property_timezone,
    require_total_rooms,
)


# Source-inspection helpers. These read the source files directly so the
# tests don't pull heavy runtime imports (pandas, sklearn, supabase, ...)
# just to grep for a substring — which made them fail on any environment
# without the full ML deps installed.
SRC_DIR = Path(__file__).resolve().parent.parent / "src"


def _read_module_source(rel_path: str) -> str:
    """Read a source file under ml-service/src/ as text."""
    full = SRC_DIR / rel_path
    return full.read_text(encoding="utf-8")


# ────────────────────────────────────────────────────────────────────────────
# Phase 3.3 + 3.5: PropertyMisconfiguredError + validators
# ────────────────────────────────────────────────────────────────────────────
class TestRequireTotalRooms:
    """Verify the total_rooms validator (3.3)."""

    PROP_ID = "11111111-1111-1111-1111-111111111111"

    def test_valid_total_rooms_returns_int(self) -> None:
        assert require_total_rooms({"total_rooms": 60}, self.PROP_ID) == 60
        assert require_total_rooms({"total_rooms": "200"}, self.PROP_ID) == 200

    def test_zero_raises(self) -> None:
        with pytest.raises(PropertyMisconfiguredError) as exc:
            require_total_rooms({"total_rooms": 0}, self.PROP_ID)
        assert exc.value.field == "total_rooms"
        assert exc.value.property_id == self.PROP_ID

    def test_negative_raises(self) -> None:
        with pytest.raises(PropertyMisconfiguredError):
            require_total_rooms({"total_rooms": -10}, self.PROP_ID)

    def test_none_raises(self) -> None:
        with pytest.raises(PropertyMisconfiguredError):
            require_total_rooms({"total_rooms": None}, self.PROP_ID)

    def test_missing_key_raises(self) -> None:
        with pytest.raises(PropertyMisconfiguredError):
            require_total_rooms({}, self.PROP_ID)

    def test_non_numeric_raises(self) -> None:
        with pytest.raises(PropertyMisconfiguredError):
            require_total_rooms({"total_rooms": "not-a-number"}, self.PROP_ID)

    def test_none_meta_raises(self) -> None:
        with pytest.raises(PropertyMisconfiguredError):
            require_total_rooms(None, self.PROP_ID)


class TestRequirePropertyTimezone:
    """Verify the timezone validator (3.5)."""

    PROP_ID = "22222222-2222-2222-2222-222222222222"

    def test_valid_tz_returns_stripped(self) -> None:
        assert require_property_timezone("America/New_York", self.PROP_ID) == "America/New_York"
        assert require_property_timezone("  America/Chicago  ", self.PROP_ID) == "America/Chicago"

    def test_none_raises(self) -> None:
        with pytest.raises(PropertyMisconfiguredError) as exc:
            require_property_timezone(None, self.PROP_ID)
        assert exc.value.field == "timezone"
        assert exc.value.property_id == self.PROP_ID

    def test_empty_string_raises(self) -> None:
        with pytest.raises(PropertyMisconfiguredError):
            require_property_timezone("", self.PROP_ID)
        with pytest.raises(PropertyMisconfiguredError):
            require_property_timezone("   ", self.PROP_ID)

    def test_non_string_raises(self) -> None:
        with pytest.raises(PropertyMisconfiguredError):
            require_property_timezone(123, self.PROP_ID)  # type: ignore[arg-type]


# ────────────────────────────────────────────────────────────────────────────
# Phase 3.3 + 3.5: cron boundary catches and emits structured event
# ────────────────────────────────────────────────────────────────────────────
def test_training_inventory_rate_catches_property_misconfigured_in_outer_try():
    """Source-of-truth pin: train_inventory_rate_model must wrap
    _do_train() in try/except PropertyMisconfiguredError and emit a
    structured event before returning the error dict. Reading the file
    directly so this test doesn't need the full ML deps (pandas,
    sklearn) installed locally.
    """
    src = _read_module_source("training/inventory_rate.py")
    # The outer boundary at train_inventory_rate_model must catch the
    # error class explicitly.
    assert "except PropertyMisconfiguredError" in src, (
        "Phase 3.3/3.5 regression: outer cron boundary no longer catches "
        "PropertyMisconfiguredError. The TS cron would see a generic 500 "
        "instead of a clean structured error and pollute the doctor surface."
    )
    # And emit a structured event so logs are greppable.
    assert '"evt": "property_misconfigured"' in src
    assert '"layer": "inventory_rate"' in src


def test_inference_modules_catch_property_misconfigured():
    """3.5: all four inference/optimizer modules must catch
    PropertyMisconfiguredError when require_property_timezone raises
    and emit the structured event."""
    for layer, rel in (
        ("demand", "inference/demand.py"),
        ("supply", "inference/supply.py"),
        ("inventory_rate", "inference/inventory_rate.py"),
        ("optimizer", "optimizer/monte_carlo.py"),
    ):
        src = _read_module_source(rel)
        assert "except PropertyMisconfiguredError" in src, (
            f"Phase 3.5 regression: {rel} no longer catches the timezone "
            f"validator's error class."
        )
        assert '"evt": "property_misconfigured"' in src, (
            f"Phase 3.5 regression: {rel} must log a structured event."
        )
        assert f'"layer": "{layer}"' in src, (
            f"Phase 3.5: {rel} should tag its event with layer={layer}"
        )


def test_default_property_timezone_constant_removed():
    """3.5: the America/Chicago default must be gone from all four
    inference + optimizer modules. Checking specifically for the
    *assignment* (not the historical-context comment) — the test pins
    the runtime behavior, not the documentation."""
    import re

    # Matches `DEFAULT_PROPERTY_TIMEZONE = "..."` at the start of a line
    # (i.e. an actual constant binding, not a substring inside a comment).
    pattern = re.compile(r"^DEFAULT_PROPERTY_TIMEZONE\s*=", re.MULTILINE)
    for rel in (
        "inference/demand.py",
        "inference/supply.py",
        "inference/inventory_rate.py",
        "optimizer/monte_carlo.py",
    ):
        src = _read_module_source(rel)
        assert not pattern.search(src), (
            f"Phase 3.5 regression: DEFAULT_PROPERTY_TIMEZONE constant "
            f"reappeared in {rel}. America/Chicago fallback silently "
            f"breaks every non-Texas property's prediction date."
        )
        # The legacy `or DEFAULT_PROPERTY_TIMEZONE` fallback expression
        # is also forbidden — if anyone re-introduces the constant via
        # an import, this catches the consumer side too.
        assert "or DEFAULT_PROPERTY_TIMEZONE" not in src, (
            f"Phase 3.5 regression: `or DEFAULT_PROPERTY_TIMEZONE` fallback "
            f"expression reappeared in {rel}."
        )


# ────────────────────────────────────────────────────────────────────────────
# Phase 3.1: per-property shift_cap_minutes
# ────────────────────────────────────────────────────────────────────────────
def test_optimizer_reads_shift_minutes_from_properties_table():
    """Source-of-truth pin: the optimizer reads `shift_minutes` from
    the properties row, not from settings.shift_cap_minutes."""
    src = _read_module_source("optimizer/monte_carlo.py")
    assert ('fetch_one("properties"' in src or "fetch_one('properties'" in src), (
        "Phase 3.1: optimize_headcount must load the properties row to "
        "read shift_minutes."
    )
    assert "shift_minutes" in src, (
        "Phase 3.1 regression: shift_minutes lookup gone — back to hardcoded 420."
    )
    # The hardcoded settings fallback should still exist as a defensive
    # backstop for legacy property rows without shift_minutes set.
    assert "settings.shift_cap_minutes" in src, (
        "Phase 3.1: settings.shift_cap_minutes fallback must remain for "
        "legacy property rows without shift_minutes."
    )


# ────────────────────────────────────────────────────────────────────────────
# Phase 3.2: size-relative validation MAE gate
# ────────────────────────────────────────────────────────────────────────────
def test_demand_uses_mae_ratio_gate():
    """training/demand.py must gate graduation on mae_ratio, not
    absolute validation_mae. Phase 3.2 regression."""
    src = _read_module_source("training/demand.py")
    assert "mae_ratio" in src, "Phase 3.2: demand must compute mae_ratio"
    assert "validation_mae_ratio_threshold" in src, (
        "Phase 3.2: demand must gate on validation_mae_ratio_threshold"
    )


def test_supply_uses_mae_ratio_gate():
    """training/supply.py must gate graduation on mae_ratio.
    The old `validation_mae < 10.0` hardcode is now Beaumont-shaped."""
    src = _read_module_source("training/supply.py")
    assert "mae_ratio" in src, "Phase 3.2: supply must compute mae_ratio"
    assert "validation_mae_ratio_threshold" in src
    assert "< 10.0" not in src, (
        "Phase 3.2 reverted: the hardcoded 10.0 absolute threshold came back."
    )


def test_config_exposes_ratio_threshold_and_floor():
    """3.2: config.py must expose validation_mae_ratio_threshold and
    validation_mae_floor. Without these the demand+supply trainers can't
    gate size-relatively."""
    src = _read_module_source("config.py")
    assert "validation_mae_ratio_threshold" in src
    assert "validation_mae_floor" in src


# ────────────────────────────────────────────────────────────────────────────
# Phase 3.9: inventory_orders order_by + limit bump
# ────────────────────────────────────────────────────────────────────────────
def test_inventory_orders_query_has_order_by():
    """training/inventory_rate.py must pull orders newest-first so a
    high-volume property doesn't silently truncate the oldest rows
    when there are >10000 orders for one item."""
    src = _read_module_source("training/inventory_rate.py")
    assert (
        'order_by="received_at"' in src and '"inventory_orders"' in src
    ), "Phase 3.9 regression: inventory_orders fetch missing order_by=received_at"
    assert "limit=10000" in src, (
        "Phase 3.9 regression: inventory_orders limit not bumped to 10000"
    )


def test_inventory_discards_query_has_order_by():
    """Same check for discards (matched the 0096 view migration)."""
    src = _read_module_source("training/inventory_rate.py")
    assert (
        'order_by="discarded_at"' in src and '"inventory_discards"' in src
    ), "Phase 3.9 regression: inventory_discards fetch missing order_by=discarded_at"


# ────────────────────────────────────────────────────────────────────────────
# Phase 3.8: xgboost pin
# ────────────────────────────────────────────────────────────────────────────
def test_xgboost_is_pinned_in_requirements():
    """3.8: xgboost must be pinned tighter than `>=2.0.0` so a future
    major bump can't break the build (2.0 dropped the
    `objective='reg:quantileerror'` constructor kwarg)."""
    requirements = (SRC_DIR.parent / "requirements.txt").read_text(encoding="utf-8")
    # The pin should be either `~=2.X.Y` (compatible release) or `==2.X.Y`.
    has_strict_pin = (
        any(line.startswith("xgboost~=") for line in requirements.splitlines())
        or any(line.startswith("xgboost==") for line in requirements.splitlines())
    )
    assert has_strict_pin, (
        "Phase 3.8 regression: xgboost is unpinned again. Pin to ~=2.1.0 "
        "(compatible release) or ==2.X.Y to lock the major.minor."
    )
    # And the loose >= form must NOT be present.
    assert "xgboost>=" not in requirements, (
        "Phase 3.8 regression: xgboost`>=` returned. A future major bump "
        "can change the public API without warning."
    )
