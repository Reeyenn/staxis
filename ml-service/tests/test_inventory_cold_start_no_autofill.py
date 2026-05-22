"""Pin the cold-start activation contract.

Cold-start (Bayesian-prior-only, no per-property fit) inventory model_runs
MUST be:
  - is_active=True   (so inference produces predictions on Day 1)
  - auto_fill_enabled=False  (cohort signal is low-confidence; never
    pre-fills Count Mode; only suggests)

This contract lives in two places:
  1. The cold-start path in _train_single_item (training/inventory_rate.py:312-320)
     returns is_active=True + auto_fill_enabled=False after the cold-start RPC.
  2. The cold-start RPC at staxis_install_cold_start_model_run inserts
     model_runs.is_active=True + auto_fill_enabled=False.

This test pins (1). If a future change flips auto_fill_enabled=True for
cold-start, autofill would silently start running on cohort priors with no
per-property validation — producing confident-looking pre-filled count
values from network averages instead of from real local data.
"""
import json
from unittest.mock import MagicMock

from src.training.inventory_rate import _create_cold_start_model_run


def _make_fake_supabase_with_rpc_ok():
    """Fake supabase wrapper whose RPC returns the install-success shape."""
    client = MagicMock()
    rpc_response = MagicMock()
    rpc_response.data = [{"ok": True, "model_run_id": "test-mr-uuid-123"}]
    client.client.rpc.return_value.execute.return_value = rpc_response
    return client


def test_cold_start_posterior_params_carry_prior_metadata():
    """The RPC payload must include cohort_prior_rate, room_count, prior_source,
    cohort_key — the inference path reads these at `_predict_from_cohort_prior`
    to scale the prediction. Missing fields → ValueError at inference time."""
    client = _make_fake_supabase_with_rpc_ok()
    _create_cold_start_model_run(
        client=client,
        property_id="11111111-1111-1111-1111-111111111111",
        property_meta={"total_rooms": 80},
        item={"id": "22222222-2222-2222-2222-222222222222", "name": "Bath Towel"},
        cohort_key="comfort-suites-south-medium",
        prior_rate=0.7,
        prior_strength=2.0,
        prior_source="cohort",
        events_observed=2,
    )
    # Capture the RPC call args.
    rpc_calls = client.client.rpc.call_args_list
    assert len(rpc_calls) == 1, f"expected one RPC call, got {len(rpc_calls)}"
    args, _ = rpc_calls[0]
    assert args[0] == "staxis_install_cold_start_model_run"
    payload = args[1]
    pp = payload["p_posterior_params"]
    assert pp["cohort_prior_rate"] == 0.7
    assert pp["room_count"] == 80
    assert pp["prior_source"] == "cohort"
    assert pp["cohort_key"] == "comfort-suites-south-medium"


def test_cold_start_returns_is_active_true_when_rpc_succeeds():
    """The trainer return-dict reflects is_active=True so the caller knows
    the cold-start row is serving predictions, not just logged."""
    client = _make_fake_supabase_with_rpc_ok()
    result = _create_cold_start_model_run(
        client=client,
        property_id="11111111-1111-1111-1111-111111111111",
        property_meta={"total_rooms": 60},
        item={"id": "22222222-2222-2222-2222-222222222222", "name": "Shampoo"},
        cohort_key="global",
        prior_rate=0.5,
        prior_strength=1.0,
        prior_source="global",
        events_observed=1,
    )
    assert result.get("is_active") is True
    assert result.get("algorithm") == "cold-start-cohort-prior"


def test_cold_start_rpc_refusal_returns_empty_dict():
    """When the RPC refuses (e.g., a graduated model already active for this
    item), the trainer must return {} so the caller treats this as a skip,
    NOT as a successful install. Pre-fix this used to silently clobber the
    graduated model — see migration 0086 / Codex review M-C8."""
    client = MagicMock()
    rpc_response = MagicMock()
    rpc_response.data = [{"ok": False, "reason": "graduated_model_active"}]
    client.client.rpc.return_value.execute.return_value = rpc_response

    result = _create_cold_start_model_run(
        client=client,
        property_id="11111111-1111-1111-1111-111111111111",
        property_meta={"total_rooms": 60},
        item={"id": "22222222-2222-2222-2222-222222222222", "name": "Soap"},
        cohort_key="global",
        prior_rate=0.5,
        prior_strength=1.0,
        prior_source="global",
        events_observed=1,
    )
    assert result == {}, "RPC refusal must produce an empty result, not a fake install"


def test_cold_start_hyperparameters_record_provenance():
    """Hyperparameters must record cohort_key + prior_source + events_observed
    so admin triage can answer 'why did this hotel get a cold-start install
    instead of a real Bayesian fit?'."""
    client = _make_fake_supabase_with_rpc_ok()
    _create_cold_start_model_run(
        client=client,
        property_id="11111111-1111-1111-1111-111111111111",
        property_meta={"total_rooms": 60},
        item={"id": "22222222-2222-2222-2222-222222222222", "name": "Toilet Paper"},
        cohort_key="global",
        prior_rate=0.3,
        prior_strength=5.0,
        prior_source="global",
        events_observed=0,
    )
    payload = client.client.rpc.call_args_list[0][0][1]
    hp = payload["p_hyperparameters"]
    assert hp["cohort_key"] == "global"
    assert hp["prior_source"] == "global"
    assert hp["events_observed"] == 0
    assert hp["prior_rate_used"] == 0.3


# ── Cold-start auto_fill_enabled contract (the load-bearing pin) ─────────


def test_trainer_cold_start_return_dict_pins_auto_fill_false():
    """The cold-start path in `_train_single_item` (lines 312-320) returns
    a dict with `auto_fill_enabled: False`. Pin this contract by parsing
    the trainer source — if a future change flips it to True, this test
    fails loud BEFORE Maria sees Count Mode auto-fill from a low-
    confidence cohort prior.

    Why a static assert: the trainer's full path needs a Supabase RPC mock
    AND the inventory + priors + counts fetches; that's a >100-line setup.
    The contract is a literal in the source; a static check is the
    smallest possible pin without the integration setup.
    """
    import inspect
    from src.training import inventory_rate

    source = inspect.getsource(inventory_rate._train_single_item)
    # Find the cold-start return block. Its `cold_start_run = _create_cold_start_model_run`
    # is followed by a `return {` that includes auto_fill_enabled.
    cs_idx = source.find("cold_start_run = _create_cold_start_model_run")
    assert cs_idx >= 0, "cold-start install call must exist in _train_single_item"
    # The return dict literal lives within ~50 lines after.
    return_block = source[cs_idx : cs_idx + 1500]
    assert '"auto_fill_enabled": False' in return_block, (
        "cold-start return dict must hardcode auto_fill_enabled=False; the "
        "cohort prior is low-confidence and should never drive Count Mode autofill."
    )
    assert '"is_active": True' in return_block, (
        "cold-start return dict must report is_active=True so inference picks it up; "
        "the RPC actually inserts an active row."
    )
