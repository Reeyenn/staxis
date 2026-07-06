"""Tests for HOW the trainer feeds the prospective graduation gate
(_evaluate_inventory_graduation) — the 2026-07-05 accuracy-pass fixes:

  1. GENERATION scoping: pairs logged against cold-start-prior runs or a
     retired model family neither certify nor block the candidate.
  2. NO property-wide pooling: an item with zero qualifying runs gets zero
     pairs (the old `if run_ids and ...` guard silently evaluated the whole
     property's pairs when the set was empty).
  3. RECENCY: pairs older than inventory_graduation_pair_max_age_days drop.
  4. Per-pair BASELINE in daily-rate units: prior_s · (window_exposure/days)
     joined via inventory_count_id — pairs without a matching clean window
     are dropped (their window failed hygiene; the actual isn't trustworthy).

The pure gate math itself is pinned in test_inventory_prospective_gate.py;
these tests pin the plumbing between prediction_log and that gate.
"""
from datetime import datetime, timedelta

from src.config import INVENTORY_EXPOSURE_ALGORITHM, get_settings
from src.training.inventory_rate import (
    _evaluate_inventory_graduation,
    _fetch_item_model_run_ids,
)


def _iso_days_ago(n):
    return (datetime.utcnow() - timedelta(days=n)).date().isoformat()


class FakeClient:
    """Stubs client.fetch_many for the two tables the evaluator reads."""

    def __init__(self, model_runs, prediction_log):
        self._tables = {"model_runs": model_runs, "prediction_log": prediction_log}

    def fetch_many(self, table, filters=None, order_by=None, descending=False, limit=None):
        rows = self._tables.get(table, [])
        out = []
        for r in rows:
            if filters and any(r.get(k) != v for k, v in filters.items()
                               if k in r or k in ("property_id", "layer", "item_id")):
                # emulate exact-match filtering on provided keys
                match = all(r.get(k) == v for k, v in filters.items())
                if not match:
                    continue
            out.append(r)
        return out


PROP = "prop-1"
ITEM = "item-1"


def _run(run_id, algorithm):
    return {
        "id": run_id, "property_id": PROP, "layer": "inventory_rate",
        "item_id": ITEM, "algorithm": algorithm, "trained_at": _iso_days_ago(30),
    }


def _pair(run_id, days_ago, predicted=10.0, actual=10.0, count_id="count-1"):
    return {
        "property_id": PROP, "layer": "inventory_rate",
        "model_run_id": run_id, "predicted_value": predicted,
        "actual_value": actual, "date": _iso_days_ago(days_ago),
        "inventory_count_id": count_id,
    }


def _grade(client, *, windows=None, prior_s=1.5):
    settings = get_settings()
    return _evaluate_inventory_graduation(
        client=client,
        property_id=PROP,
        item_id=ITEM,
        n_training_windows=20,  # gate A satisfied — we're testing pair plumbing
        prior_s=prior_s,
        kappa=0.3,
        settings=settings,
        family_algorithms={INVENTORY_EXPOSURE_ALGORITHM},
        window_baselines=windows if windows is not None else {
            f"count-{i}": (210.0, 7.0) for i in range(1, 40)
        },
    )


def _good_pairs(run_id, n=10):
    # Accurate pairs spaced 3 days apart, all recent, each with its own count
    # window key (count-1..count-n → present in the default window_baselines).
    return [
        _pair(run_id, days_ago=3 * i + 1, predicted=10.0, actual=10.2,
              count_id=f"count-{i + 1}")
        for i in range(n)
    ]


def test_fetch_run_ids_filters_by_algorithm():
    client = FakeClient(
        model_runs=[
            _run("run-exposure", INVENTORY_EXPOSURE_ALGORITHM),
            _run("run-coldstart", "cold-start-cohort-prior"),
            _run("run-legacy", "bayesian"),
        ],
        prediction_log=[],
    )
    all_ids = _fetch_item_model_run_ids(client, PROP, ITEM)
    assert set(all_ids) == {"run-exposure", "run-coldstart", "run-legacy"}
    scoped = _fetch_item_model_run_ids(
        client, PROP, ITEM, algorithms={INVENTORY_EXPOSURE_ALGORITHM},
    )
    assert scoped == ["run-exposure"]


def test_cold_start_pairs_do_not_certify_an_exposure_fit():
    """10 accurate pairs — but all logged against the cold-start prior. The
    exposure candidate has no prospective evidence of its own → gate B."""
    client = FakeClient(
        model_runs=[
            _run("run-exposure", INVENTORY_EXPOSURE_ALGORITHM),
            _run("run-coldstart", "cold-start-cohort-prior"),
        ],
        prediction_log=_good_pairs("run-coldstart"),
    )
    r = _grade(client)
    assert r.passed is False
    assert r.reason == "insufficient_prospective_pairs"
    assert r.n_pairs == 0


def test_cold_start_history_cannot_block_a_good_fit():
    """The reverse trap: months of BAD cold-start pairs must not poison the
    WAPE of a now-accurate exposure model."""
    bad_history = [
        _pair("run-coldstart", days_ago=20 + i, predicted=50.0, actual=10.0,
              count_id=f"count-{i + 1}")
        for i in range(10)
    ]
    good_current = [
        _pair("run-exposure", days_ago=3 * i + 1, predicted=10.0, actual=10.2,
              count_id=f"count-{20 + i}")
        for i in range(10)
    ]
    windows = {f"count-{i}": (210.0, 7.0) for i in range(1, 40)}
    client = FakeClient(
        model_runs=[
            _run("run-exposure", INVENTORY_EXPOSURE_ALGORITHM),
            _run("run-coldstart", "cold-start-cohort-prior"),
        ],
        prediction_log=bad_history + good_current,
    )
    r = _grade(client, windows=windows)
    assert r.passed is True, f"good fit blocked: {r.reason} wape={r.wape}"
    assert r.n_pairs == 10  # only the exposure generation's pairs


def test_no_qualifying_runs_means_no_pairs_not_property_pooling():
    """MED-4: empty run scope must fail gate B — never evaluate on the whole
    property's prediction_log."""
    client = FakeClient(
        model_runs=[],  # item has no runs at all
        prediction_log=_good_pairs("someone-elses-run"),
    )
    r = _grade(client)
    assert r.passed is False
    assert r.n_pairs == 0


def test_stale_pairs_age_out():
    """Pairs older than the recency window don't count — good or bad."""
    settings = get_settings()
    horizon = settings.inventory_graduation_pair_max_age_days
    stale = [
        _pair("run-exposure", days_ago=horizon + 10 + i, predicted=10.0,
              actual=10.2, count_id=f"count-{i + 1}")
        for i in range(10)
    ]
    client = FakeClient(
        model_runs=[_run("run-exposure", INVENTORY_EXPOSURE_ALGORITHM)],
        prediction_log=stale,
    )
    r = _grade(client)
    assert r.passed is False
    assert r.reason == "insufficient_prospective_pairs"
    assert r.n_pairs == 0


def test_pairs_without_a_clean_window_are_dropped():
    """A pair whose inventory_count_id has no clean training window behind it
    is not evidence (its window failed hygiene)."""
    pairs = _good_pairs("run-exposure")
    windows = {"count-1": (210.0, 7.0)}  # only ONE pair has a clean window
    client = FakeClient(
        model_runs=[_run("run-exposure", INVENTORY_EXPOSURE_ALGORITHM)],
        prediction_log=pairs,
    )
    r = _grade(client, windows=windows)
    assert r.n_pairs == 1
    assert r.reason == "insufficient_prospective_pairs"


def test_baseline_is_in_daily_rate_units():
    """HIGH-1: baseline per pair = prior_s · exposure/days — the same units as
    actual_value. With prior_s=1.5 and a 210-exposure 7-day window, baseline
    = 45/day. A model at ~10% error on a 40/day item must beat it; the OLD
    prior_s-as-rate baseline (1.5/day vs 40/day actual) was unbeatable-ly bad
    and made gate E vacuous."""
    pairs = [
        _pair("run-exposure", days_ago=3 * i + 1, predicted=36.0, actual=40.0,
              count_id=f"count-{i + 1}")
        for i in range(10)
    ]
    windows = {f"count-{i}": (210.0, 7.0) for i in range(1, 11)}
    client = FakeClient(
        model_runs=[_run("run-exposure", INVENTORY_EXPOSURE_ALGORITHM)],
        prediction_log=pairs,
    )
    r = _grade(client, windows=windows, prior_s=1.5)
    # baseline = 1.5 * 210/7 = 45 → baseline_mae = |45-40| = 5
    assert r.baseline_mae is not None and abs(r.baseline_mae - 5.0) < 1e-9
    # model mae = 4 < 5 → beats baseline honestly (not vacuously)
    assert r.prospective_mae is not None and abs(r.prospective_mae - 4.0) < 1e-9
    assert r.passed is True

    # And a model WORSE than the cohort prior must now actually fail gate E —
    # the whole point of fixing the units.
    worse = [
        _pair("run-exposure", days_ago=3 * i + 1, predicted=48.0, actual=40.0,
              count_id=f"count-{i + 1}")
        for i in range(10)
    ]
    client2 = FakeClient(
        model_runs=[_run("run-exposure", INVENTORY_EXPOSURE_ALGORITHM)],
        prediction_log=worse,
    )
    r2 = _grade(client2, windows=windows, prior_s=1.5)
    assert r2.passed is False
    assert r2.reason == "does_not_beat_baseline"
