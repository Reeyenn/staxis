"""Phase K (2026-05-13): the wrapper's upsert() accepts on_conflict but
silently drops it before forwarding to PostgREST. Three callers
(monte_carlo.py, inference/supply.py, inference/demand.py) currently get
whatever PostgREST defaults to, which may not match the table's intended
uniqueness constraint, leading to duplicate rows on retries.

These tests pin the contract: when on_conflict is passed, it MUST reach
the underlying upsert call. When it isn't passed, the call must omit
on_conflict (don't pass on_conflict=None — supabase-py treats None
differently than "missing")."""
from unittest.mock import MagicMock

from src.supabase_client import SupabaseServiceClient


def _build_wrapper_with_fake_client():
    """Construct a SupabaseServiceClient with a mocked underlying client.

    Phase L fix 7: SupabaseServiceClient is a singleton — _instance and
    _client are class attrs, so __new__ returns the SAME object across
    calls. The previous docstring claimed __new__ "bypasses singleton
    state that would otherwise leak between tests"; that was wrong.
    Now we explicitly reset both class attrs first so each test gets a
    truly fresh wrapper, eliminating a tripwire where a future test
    that forgets to overwrite `_client` would silently use whatever the
    previous test wired up.
    """
    SupabaseServiceClient._instance = None
    SupabaseServiceClient._client = None

    fake_table = MagicMock()
    # The chain is: client.table(t).upsert(data, **kw).execute()
    # .execute() returns an object with a `data` attribute (list of rows).
    fake_execute = MagicMock()
    fake_execute.data = [{"id": "fake"}]
    fake_table.upsert.return_value.execute.return_value = fake_execute

    fake_client = MagicMock()
    fake_client.table.return_value = fake_table

    wrapper = SupabaseServiceClient.__new__(SupabaseServiceClient)
    wrapper._client = fake_client
    return wrapper, fake_table


def test_upsert_forwards_on_conflict_when_passed():
    wrapper, fake_table = _build_wrapper_with_fake_client()

    wrapper.upsert(
        "demand_predictions",
        {"id": "x", "property_id": "p1"},
        on_conflict="property_id,date,model_run_id",
    )

    fake_table.upsert.assert_called_once_with(
        {"id": "x", "property_id": "p1"},
        on_conflict="property_id,date,model_run_id",
        ignore_duplicates=False,
    )


def test_upsert_omits_on_conflict_when_not_passed():
    wrapper, fake_table = _build_wrapper_with_fake_client()

    wrapper.upsert("some_table", {"id": "y"})

    fake_table.upsert.assert_called_once_with(
        {"id": "y"},
        ignore_duplicates=False,
    )
    call_kwargs = fake_table.upsert.call_args.kwargs
    assert "on_conflict" not in call_kwargs, (
        "When the caller doesn't pass on_conflict, the wrapper must not "
        "inject it (None vs missing is meaningful to supabase-py)."
    )
