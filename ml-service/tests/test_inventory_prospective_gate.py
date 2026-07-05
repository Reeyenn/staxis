"""Tests for the prospective inventory graduation gate (pure function).

Pins training/_prospective_gate.evaluate_prospective_gate — the replacement for
the retired retrain-streak graduation. Each gate (A-E) is exercised, plus the
happy path and the all-zero-actuals guard.
"""
from datetime import date

from src.training._prospective_gate import (
    ProspectivePair,
    evaluate_prospective_gate,
    parse_operational_date,
)


def _pairs(n, *, pred, act, baseline, start_day=1, step=2):
    return [
        ProspectivePair(predicted=pred, actual=act,
                        when=date(2026, 1, start_day + step * i), baseline=baseline)
        for i in range(n)
    ]


def _gate(**over):
    base = dict(
        n_training_windows=20,
        pairs=_pairs(10, pred=10.0, act=10.2, baseline=15.0),
        min_training_windows=15,
        min_pairs=8,
        span_days=14,
        wape_threshold=0.30,
    )
    base.update(over)
    return evaluate_prospective_gate(**base)


def test_happy_path_passes():
    r = _gate()
    assert r.passed is True
    assert r.reason == "ok"
    assert r.wape < 0.30
    assert r.prospective_mae < r.baseline_mae


def test_gate_a_insufficient_training_windows():
    r = _gate(n_training_windows=10)
    assert r.passed is False
    assert r.reason == "insufficient_training_windows"


def test_gate_b_insufficient_pairs():
    r = _gate(pairs=_pairs(5, pred=10.0, act=10.2, baseline=15.0))
    assert r.passed is False
    assert r.reason == "insufficient_prospective_pairs"


def test_gate_c_span_too_short():
    # 8 pairs but all within 7 days (step=1)
    r = _gate(pairs=_pairs(8, pred=10.0, act=10.2, baseline=15.0, step=1))
    assert r.passed is False
    assert r.reason == "prospective_span_too_short"
    assert r.span_days == 7


def test_gate_d_wape_too_high():
    r = _gate(pairs=_pairs(10, pred=10.0, act=20.0, baseline=15.0))
    assert r.passed is False
    assert r.reason == "prospective_wape_too_high"
    assert r.wape >= 0.30


def test_gate_e_does_not_beat_baseline():
    # Model MAE (|12-10|=2) worse than baseline MAE (|10-10|=0)
    r = _gate(pairs=_pairs(10, pred=12.0, act=10.0, baseline=10.0), wape_threshold=0.90)
    assert r.passed is False
    assert r.reason == "does_not_beat_baseline"


def test_all_zero_actuals_fails_closed():
    r = _gate(pairs=_pairs(10, pred=0.5, act=0.0, baseline=0.0))
    assert r.passed is False
    assert r.reason == "prospective_actuals_all_zero"


def test_wape_boundary_is_strict_less_than():
    # WAPE exactly at threshold must FAIL (>= threshold).
    # 10 pairs, |pred-act| sums to 0.30*Σ|act|. Use pred=13, act=10 → err 3, wape 0.3
    r = _gate(pairs=_pairs(10, pred=13.0, act=10.0, baseline=99.0), wape_threshold=0.30)
    assert r.passed is False
    assert r.reason == "prospective_wape_too_high"


# ── date parsing ──

def test_parse_operational_date_forms():
    assert parse_operational_date("2026-01-05") == date(2026, 1, 5)
    assert parse_operational_date("2026-01-05T00:00:00Z") == date(2026, 1, 5)
    assert parse_operational_date(date(2026, 1, 5)) == date(2026, 1, 5)
    assert parse_operational_date(None) is None
    assert parse_operational_date("garbage") is None
