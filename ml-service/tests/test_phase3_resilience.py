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
    """training/supply.py must gate graduation on mae_ratio for the
    current run. The legacy `validation_mae < 10.0` check IS still
    present, but only inside the prior_passes loop — see the
    `test_supply_prior_passes_keeps_legacy_mae_gate` test below for
    why (Codex review 2026-05-13 #3: activation grandfather)."""
    import re

    src = _read_module_source("training/supply.py")
    assert "mae_ratio" in src, "Phase 3.2: supply must compute mae_ratio"
    assert "validation_mae_ratio_threshold" in src
    # The legacy threshold may appear inside the prior_passes loop
    # (intentional, see #3 below). It must NOT appear as the gate for
    # the current run — that's the line we changed in Phase 3.2.
    # Heuristic: the `passes_gates` block uses mae_ratio, not < 10.0.
    passes_gates_block = re.search(
        r"passes_gates\s*=\s*\(([^)]+)\)", src, flags=re.DOTALL,
    )
    assert passes_gates_block, "couldn't find passes_gates expression"
    assert "< 10.0" not in passes_gates_block.group(1), (
        "Phase 3.2 reverted: the current-run gate is using the legacy "
        "absolute 10-min threshold again."
    )


def test_demand_prior_passes_keeps_legacy_mae_gate():
    """Codex 2026-05-13 #3 fix (Option B): prior-run counting must
    still check the legacy absolute MAE threshold, otherwise runs that
    previously failed the gate count as 'passing' toward the activation
    streak.

    Codex review 2026-05-13 (A5) follow-up: the original assertion
    just grep'd for `settings.validation_mae_threshold` in the file,
    but that string also appears in comments/docstrings (config.py's
    DEPRECATED comment). A future PR could revert the actual
    `prior_passes` code and leave only the comment, and this test
    would still pass. Now we extract the prior_passes block by regex
    and assert the threshold reference is INSIDE that block.
    """
    import re

    src = _read_module_source("training/demand.py")
    # Extract the for-prior_run loop body. Use a permissive regex that
    # captures from `for prior_run` to the next blank line + non-indented
    # code (end of loop body).
    block = re.search(
        r"for prior_run in.*?\n(.*?)should_activate\s*=",
        src,
        flags=re.DOTALL,
    )
    assert block, "couldn't locate prior_passes loop body in training/demand.py"
    body = block.group(1)
    assert "settings.validation_mae_threshold" in body, (
        "Codex #3 regression: training/demand.py prior_passes loop no "
        "longer references the legacy MAE threshold; activation "
        "grandfather is back. Loop body found:\n" + body[:500]
    )


def test_supply_prior_passes_keeps_legacy_mae_gate():
    """Same check for supply. Codex 2026-05-13 #3 + A5 follow-up.

    Supply hardcodes the legacy 10-min threshold inline (not via
    settings) — the prior_passes block must contain `< 10.0`
    inside the loop body, not just anywhere in the file.
    """
    import re

    src = _read_module_source("training/supply.py")
    block = re.search(
        r"for prior_run in.*?\n(.*?)should_activate\s*=",
        src,
        flags=re.DOTALL,
    )
    assert block, "couldn't locate prior_passes loop body in training/supply.py"
    body = block.group(1)
    assert "validation_mae" in body and "< 10.0" in body, (
        "Codex #3 regression: training/supply.py prior_passes loop no "
        "longer applies the legacy 10-min MAE gate; activation "
        "grandfather is back. Loop body found:\n" + body[:500]
    )


def test_demand_prior_passes_block_distinct_from_current_gate():
    """Sanity check: the prior_passes block must NOT execute the new
    ratio threshold against prior rows (they don't have mae_ratio stored).

    Filters out comment lines so a `# don't reference mae_ratio` style
    note doesn't trip the test. We're checking the actual code, not
    the documentation."""
    import re

    src = _read_module_source("training/demand.py")
    block = re.search(
        r"for prior_run in.*?\n(.*?)should_activate\s*=",
        src,
        flags=re.DOTALL,
    )
    assert block, "couldn't locate prior_passes loop body"
    body = block.group(1)
    # Strip comment-only lines before checking for mae_ratio references.
    code_lines = [
        line for line in body.splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    code = "\n".join(code_lines)
    # The new ratio gate uses `mae_ratio` — that name should NOT appear
    # in the executable code inside the prior_passes loop (prior rows
    # don't have it stored).
    assert "mae_ratio" not in code, (
        "Codex #3 regression risk: prior_passes loop references mae_ratio "
        "in executable code, but prior model_runs rows don't store that "
        "field — this would always evaluate to inf and reject all prior runs.\n"
        f"Loop body (code only):\n{code[:500]}"
    )


def test_demand_passes_gates_does_not_require_activation_row_count():
    """Phase M3.2 (2026-05-14) — root-cause fix for the activation gap.

    Properties with 200-499 events were trapped: cold-start fired only
    at <200, Bayesian activated only at >=500. The fix drops the
    row-count guard from passes_gates because the OTHER gates (holdout,
    mae_ratio, beats_baseline, consecutive_passes) already prevent
    unreliable models from activating.

    This test pins that the row-count guard does NOT come back into
    passes_gates. It MAY still appear inside the for-prior-run loop OR
    in the use_xgboost algorithm-choice gate (those are different
    decisions); we extract just the passes_gates expression.
    """
    import re

    src = _read_module_source("training/demand.py")
    passes_gates_block = re.search(
        r"passes_gates\s*=\s*\(([^)]+)\)", src, flags=re.DOTALL,
    )
    assert passes_gates_block, "couldn't find passes_gates expression in demand.py"
    expr = passes_gates_block.group(1)
    assert "training_row_count_activation" not in expr, (
        "Phase M3.2 reverted: the demand passes_gates expression now "
        "requires training_row_count_activation again, recreating the "
        "200-499 event activation gap.\nExpression:\n" + expr
    )


def test_supply_passes_gates_does_not_require_activation_row_count():
    """Same as above for supply. Mirror the demand structural invariant."""
    import re

    src = _read_module_source("training/supply.py")
    passes_gates_block = re.search(
        r"passes_gates\s*=\s*\(([^)]+)\)", src, flags=re.DOTALL,
    )
    assert passes_gates_block, "couldn't find passes_gates expression in supply.py"
    expr = passes_gates_block.group(1)
    assert "training_row_count_activation" not in expr, (
        "Phase M3.2 reverted: the supply passes_gates expression now "
        "requires training_row_count_activation again, recreating the "
        "200-499 event activation gap.\nExpression:\n" + expr
    )


def test_demand_prior_passes_does_not_require_activation_row_count():
    """The prior_passes loop body must also not gate on the activation
    row count — otherwise a property's prior runs (all under 500 rows)
    never count toward consecutive_passes, and the property never
    accumulates the 2 passing runs needed to activate."""
    import re

    src = _read_module_source("training/demand.py")
    block = re.search(
        r"for prior_run in.*?\n(.*?)should_activate\s*=",
        src, flags=re.DOTALL,
    )
    assert block, "couldn't locate prior_passes loop body in training/demand.py"
    body = block.group(1)
    code_lines = [
        line for line in body.splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    code = "\n".join(code_lines)
    assert "training_row_count_activation" not in code, (
        "Phase M3.2 reverted: training/demand.py prior_passes loop now "
        "gates on training_row_count_activation. Activation gap is back.\n"
        f"Loop body (code only):\n{code[:500]}"
    )


def test_supply_prior_passes_does_not_require_activation_row_count():
    """Same as above for supply."""
    import re

    src = _read_module_source("training/supply.py")
    block = re.search(
        r"for prior_run in.*?\n(.*?)should_activate\s*=",
        src, flags=re.DOTALL,
    )
    assert block, "couldn't locate prior_passes loop body in training/supply.py"
    body = block.group(1)
    code_lines = [
        line for line in body.splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    code = "\n".join(code_lines)
    assert "training_row_count_activation" not in code, (
        "Phase M3.2 reverted: training/supply.py prior_passes loop now "
        "gates on training_row_count_activation. Activation gap is back.\n"
        f"Loop body (code only):\n{code[:500]}"
    )


def test_use_xgboost_keeps_activation_row_count_threshold():
    """Phase M3.2 sanity check: while the activation GATE drops the row
    count, the algorithm-CHOICE gate (use_xgboost) should keep it.
    XGBoost overfits at low N — picking it under 500 rows is a different
    failure mode than activation. This test ensures the M3.2 fix doesn't
    accidentally also broaden XGBoost selection."""
    for module in ("training/demand.py", "training/supply.py"):
        src = _read_module_source(module)
        assert "use_xgboost = len(X_train) >= settings.training_row_count_activation" in src, (
            f"{module} no longer gates XGBoost selection on the activation "
            "row count. Phase M3.2 should have left this alone — XGBoost "
            "overfits at low N."
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
