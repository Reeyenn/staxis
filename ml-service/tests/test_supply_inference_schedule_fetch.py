"""Phase M3.4 (2026-05-14) — behavior tests for the in-memory schedule
parser that replaced the brittle supply-inference schedule SQL.

Module under test: src/inference/supply.py:_parse_schedule_for_inference

Codex adversarial finding #3: the M3.3b SQL cast every room_assignments
value to uuid in the SELECT, throwing on any malformed value and 502'ing
the entire property's inference. It also removed the crew JOIN, so stale
assignments produced ghost predictions for non-existent staff.

The Python parser is the right architectural call: explicit per-entry
validation, skip-and-log on bad data, crew filter as a set lookup, no
brittle SQL surface. These tests pin every code path including the bad
data shapes that previously crashed the SQL.

Phase L discipline: behavior tests with seeded inputs + asserted outputs.
No mocks required — pure function.
"""
from datetime import date

# Don't import predict_supply at module load (transitively imports static_baseline
# which uses Py 3.10+ syntax — fails on local Py 3.9 but works in CI). Test the
# pure parser directly.
from src.inference.supply import _parse_schedule_for_inference


PROPERTY_ID = "8a041d6e-d881-4f19-83e0-7250f0e36eaa"
TOMORROW = date(2026, 5, 15)


def _sa_row(crew, room_assignments):
    return {"crew": crew, "room_assignments": room_assignments}


def test_returns_empty_when_sa_row_is_none():
    """No schedule for the date → no predictions to make. Not an error.

    The supply inference fail-closed path: predicted_rooms=0 with no
    upserts. The cron route should treat this as success, not error.
    """
    result = _parse_schedule_for_inference(None, property_id=PROPERTY_ID, prediction_date=TOMORROW)
    assert result == []


def test_returns_empty_when_room_assignments_empty():
    """Schedule row exists but no rooms assigned yet (GM started a fresh day)."""
    result = _parse_schedule_for_inference(
        _sa_row(crew=["aaaa1111-1111-1111-1111-111111111111"], room_assignments={}),
        property_id=PROPERTY_ID, prediction_date=TOMORROW,
    )
    assert result == []


def test_happy_path_aggregates_per_staff():
    """Multiple rooms per staff, multiple staff. Output groups by staff_id."""
    crew = [
        "aaaa1111-1111-1111-1111-111111111111",
        "bbbb2222-2222-2222-2222-222222222222",
    ]
    sa = _sa_row(
        crew=crew,
        room_assignments={
            "2026-05-15_101": "aaaa1111-1111-1111-1111-111111111111",
            "2026-05-15_102": "aaaa1111-1111-1111-1111-111111111111",
            "2026-05-15_201": "bbbb2222-2222-2222-2222-222222222222",
        },
    )
    result = _parse_schedule_for_inference(sa, property_id=PROPERTY_ID, prediction_date=TOMORROW)
    by_staff = {r["staff_id"]: r for r in result}

    assert set(by_staff.keys()) == set(crew)
    assert sorted(by_staff[crew[0]]["assigned_rooms"]) == ["101", "102"]
    assert by_staff[crew[0]]["room_count"] == 2
    assert by_staff[crew[1]]["assigned_rooms"] == ["201"]
    assert by_staff[crew[1]]["room_count"] == 1


def test_strips_date_prefix_from_keys():
    """Keys are stored as `<YYYY-MM-DD>_<room_number>`. The parser strips
    the date prefix so the room_number reaching predictions is just the
    room (matches the room_number column on cleaning_events).
    """
    staff_id = "aaaa1111-1111-1111-1111-111111111111"
    sa = _sa_row(
        crew=[staff_id],
        room_assignments={"2026-05-15_315": staff_id},
    )
    result = _parse_schedule_for_inference(sa, property_id=PROPERTY_ID, prediction_date=TOMORROW)
    assert result[0]["assigned_rooms"] == ["315"]


def test_keeps_bare_keys_without_date_prefix():
    """Defensive: if a legacy writer or future code path inserts keys
    WITHOUT the date prefix, the parser keeps them as-is rather than
    silently mangling them. Surfaces as a literal room_number.
    """
    staff_id = "aaaa1111-1111-1111-1111-111111111111"
    sa = _sa_row(
        crew=[staff_id],
        room_assignments={"315": staff_id},  # bare, no date prefix
    )
    result = _parse_schedule_for_inference(sa, property_id=PROPERTY_ID, prediction_date=TOMORROW)
    assert result[0]["assigned_rooms"] == ["315"]


def test_skips_entry_with_invalid_uuid_value(capsys):
    """Anti-regression for Codex finding #3 (a). The SQL pre-M3.4 cast
    every value to uuid in the SELECT, throwing on malformed values and
    502'ing the whole property's inference. Python-side validation
    skips bad entries and KEEPS the good ones.
    """
    good_staff = "aaaa1111-1111-1111-1111-111111111111"
    sa = _sa_row(
        crew=[good_staff],
        room_assignments={
            "2026-05-15_101": good_staff,
            "2026-05-15_102": "not-a-uuid",  # malformed
            "2026-05-15_103": "",             # empty
            "2026-05-15_104": good_staff,
        },
    )
    result = _parse_schedule_for_inference(sa, property_id=PROPERTY_ID, prediction_date=TOMORROW)

    # Good entries kept.
    assert len(result) == 1
    assert sorted(result[0]["assigned_rooms"]) == ["101", "104"]

    # Skips logged (operator can find them).
    out = capsys.readouterr().out
    assert "supply_schedule_skipped_entries" in out
    assert '"skipped_invalid_uuid": 2' in out


def test_skips_staff_not_in_crew(capsys):
    """Anti-regression for Codex finding #3 (b). M3.3b removed the crew
    JOIN, letting stale assignments (HK removed from crew but
    room_assignments not cleaned up) produce ghost predictions. The
    parser's set-membership check restores the filter.
    """
    in_crew = "aaaa1111-1111-1111-1111-111111111111"
    not_in_crew = "ffff9999-9999-9999-9999-999999999999"
    sa = _sa_row(
        crew=[in_crew],
        room_assignments={
            "2026-05-15_101": in_crew,
            "2026-05-15_102": not_in_crew,  # stale — not in today's crew
        },
    )
    result = _parse_schedule_for_inference(sa, property_id=PROPERTY_ID, prediction_date=TOMORROW)

    # Only in-crew assignments produce predictions.
    assert len(result) == 1
    assert result[0]["staff_id"] == in_crew
    assert result[0]["assigned_rooms"] == ["101"]

    out = capsys.readouterr().out
    assert "supply_schedule_skipped_entries" in out
    assert '"skipped_non_crew": 1' in out


def test_handles_uuid_object_not_string():
    """Defensive: the Supabase wrapper might already deserialize uuid
    columns to uuid.UUID instances. str(uuid_obj) round-trips. The
    parser must not crash on UUID-typed values.
    """
    import uuid as _uuid
    staff_id_str = "aaaa1111-1111-1111-1111-111111111111"
    staff_id_obj = _uuid.UUID(staff_id_str)
    sa = _sa_row(
        crew=[staff_id_str],
        room_assignments={"2026-05-15_101": staff_id_obj},
    )
    result = _parse_schedule_for_inference(sa, property_id=PROPERTY_ID, prediction_date=TOMORROW)
    assert len(result) == 1
    assert result[0]["staff_id"] == staff_id_str


def test_does_not_log_skips_when_all_entries_valid(capsys):
    """Don't pollute logs when there's nothing to flag. The skip log
    fires only when something was actually skipped.
    """
    staff_id = "aaaa1111-1111-1111-1111-111111111111"
    sa = _sa_row(
        crew=[staff_id],
        room_assignments={"2026-05-15_101": staff_id},
    )
    _parse_schedule_for_inference(sa, property_id=PROPERTY_ID, prediction_date=TOMORROW)
    out = capsys.readouterr().out
    assert "supply_schedule_skipped_entries" not in out
