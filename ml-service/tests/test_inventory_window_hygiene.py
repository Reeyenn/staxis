"""Regression tests for inventory_rate training-window hygiene.

Locks in the fix that stops contaminated count windows from poisoning the
per-item rate model:
  * sub-day count pairs (same-day recounts) are skipped, not floored to 0.5d
  * windows with no observed consumption (raw <= 0) are dropped, not clamped
    to a fake 0-rate row — this is the auto-stock-up / unlogged-restock case
    that otherwise biases every reorder LATE.

Pure-function tests — no Supabase.
"""
from src.training.inventory_rate import _build_training_rows

LOGS = [{"date": f"2026-01-{d:02d}", "occupied": 48} for d in range(1, 31)]  # 60% of 80
ROOMS = 80


def _count(day, stock, hour=23):
    return {"counted_at": f"2026-01-{day:02d}T{hour:02d}:00:00", "counted_stock": stock}


def test_sub_day_pair_is_skipped():
    # Two counts ~2 hours apart → < 1.0 day → no row (was a 2x-inflated row).
    counts = [_count(1, 100, hour=9), _count(1, 88, hour=11)]
    assert _build_training_rows(counts, [], [], LOGS, ROOMS) == []


def test_normal_depletion_window_kept_with_correct_rate():
    counts = [_count(1, 100), _count(5, 60)]   # 40 used over 4 days = 10/day
    rows = _build_training_rows(counts, [], [], LOGS, ROOMS)
    assert len(rows) == 1
    assert abs(rows[0]["daily_rate"] - 10.0) < 1e-6


def test_auto_stock_up_zero_window_dropped():
    """Count ROSE and an offsetting order makes raw consumption exactly 0
    (the CountSheet auto-stock-up signature) → window dropped (usage masked)."""
    counts = [_count(1, 100), _count(5, 130)]
    orders = [{"received_at": "2026-01-05T12:00:00", "quantity": 30}]  # 100+30-130=0
    assert _build_training_rows(counts, orders, [], LOGS, ROOMS) == []


def test_genuine_zero_usage_window_kept():
    """Count FLAT, no restock → genuine zero-usage window is KEPT at rate 0.
    Dropping these (the prior, too-aggressive rule) over-estimates items that
    are only used some days (learns burn-when-used, not average burn)."""
    counts = [_count(1, 100), _count(5, 100)]  # nothing used, no orders
    rows = _build_training_rows(counts, [], [], LOGS, ROOMS)
    assert len(rows) == 1
    assert rows[0]["daily_rate"] == 0.0


def test_zero_via_discard_on_count_down_kept():
    """Count went DOWN but the drop is fully explained by a discard → zero real
    usage, count did not rise → KEPT at rate 0 (genuine zero usage)."""
    counts = [_count(1, 100), _count(5, 90)]
    discards = [{"discarded_at": "2026-01-03T12:00:00", "quantity": 10}]  # 100+0-10-90=0
    rows = _build_training_rows(counts, [], discards, LOGS, ROOMS)
    assert len(rows) == 1
    assert rows[0]["daily_rate"] == 0.0


def test_unexplained_increase_window_dropped():
    """Count rose with NO order (restock outside the app) → raw consumption
    negative → dropped, not clamped to a fake 0-rate row."""
    counts = [_count(1, 100), _count(5, 140)]
    assert _build_training_rows(counts, [], [], LOGS, ROOMS) == []


def test_legitimate_restock_window_with_real_usage_kept():
    """Stock rose because of a logged restock, but net usage is positive
    (prev 50 + order 100 − curr 120 = 30 over 4 days) → KEPT (real signal)."""
    counts = [_count(1, 50), _count(5, 120)]
    orders = [{"received_at": "2026-01-03T12:00:00", "quantity": 100}]
    rows = _build_training_rows(counts, orders, [], LOGS, ROOMS)
    assert len(rows) == 1
    assert abs(rows[0]["daily_rate"] - (30.0 / 4.0)) < 1e-6


def test_mixed_sequence_keeps_only_clean_windows():
    counts = [
        _count(1, 200),   # ─┐ w1: 200→160 = 40 used /4d → keep (10/day)
        _count(5, 160),   # ─┘
        _count(9, 190),   # w2: rose, no order → drop
        _count(13, 150),  # w3: 190→150 = 40 /4d → keep (10/day)
    ]
    rows = _build_training_rows(counts, [], [], LOGS, ROOMS)
    assert len(rows) == 2
    assert all(abs(r["daily_rate"] - 10.0) < 1e-6 for r in rows)
