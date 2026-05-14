"""Phase M3 (2026-05-14) — cold-start cohort-prior helpers for demand+supply.

Extracted from demand.py + supply.py so they're testable in isolation
WITHOUT pulling sklearn/pandas/numpy. Same pattern Phase L used for
_streak.py.

Both demand and supply share the same flow:
  1. Look up the most-specific cohort prior (specific → global → industry)
  2. Call the staxis_install_demand_supply_cold_start RPC atomically
  3. Return result dict (success / skipped-because-real-model-active / error)

Differences are just the table name and the value column:
  Demand: demand_priors.prior_minutes_per_room_per_day
  Supply: supply_priors.prior_minutes_per_event
"""
import json
from datetime import datetime
from typing import Tuple


def _slug(s):
    """Match training/inventory_priors._slug for cohort_key consistency."""
    return (s or "").strip().lower().replace(" ", "-")


def _cohort_keys_in_priority_order(prop) -> list:
    """Returns cohort keys to try, most-specific first.

    [<brand-region-size_tier>, 'global', 'industry-default']

    The specific key is only included when ALL three property metadata
    fields are populated (matches the aggregator's same gate).
    """
    keys = []
    if prop:
        brand = _slug(prop.get("brand"))
        region = _slug(prop.get("region"))
        size_tier = _slug(prop.get("size_tier"))
        if brand and region and size_tier:
            keys.append(f"{brand}-{region}-{size_tier}")
    keys.extend(["global", "industry-default"])
    return keys


def lookup_cohort_prior(
    client,
    property_id: str,
    *,
    table: str,
    value_col: str,
    hardcoded_fallback: float,
) -> Tuple[float, float, str, str]:
    """Find the best cohort prior for this property + layer.

    Args:
      client: supabase client
      property_id: UUID
      table: 'demand_priors' or 'supply_priors'
      value_col: 'prior_minutes_per_room_per_day' or 'prior_minutes_per_event'
      hardcoded_fallback: numeric to return if even industry-default seed is missing

    Returns:
      (prior_value, prior_strength, source, cohort_key_used)
    """
    try:
        prop = client.fetch_one("properties", filters={"id": property_id})
    except Exception as exc:
        # Phase L rule #3: never swallow silently. If properties is unreachable,
        # cold-start still works (lookup falls through to global → industry-default)
        # but the operator should know the metadata fetch failed. Mirror the
        # inventory_rate.py:925-932 structured-event shape.
        print(json.dumps({
            "level": "warn",
            "event": "cold_start_lookup_swallowed",
            "stage": "fetch_properties",
            "property_id": property_id,
            "table": table,
            "error": str(exc)[:200],
        }))
        prop = None

    for ck in _cohort_keys_in_priority_order(prop):
        try:
            row = client.fetch_one(table, filters={"cohort_key": ck})
        except Exception as exc:
            # Same Phase L rule. If the priors table is unreachable for one
            # cohort key, log + try the next (don't crash the lookup).
            print(json.dumps({
                "level": "warn",
                "event": "cold_start_lookup_swallowed",
                "stage": "fetch_cohort_prior",
                "property_id": property_id,
                "table": table,
                "cohort_key": ck,
                "error": str(exc)[:200],
            }))
            row = None
        if row:
            return (
                float(row[value_col]),
                float(row.get("prior_strength") or 1.0),
                str(row.get("source") or "industry-benchmark"),
                ck,
            )
    # Defense-in-depth: even the migration 0122 seed is gone. Return a
    # sane number so the cold-start install still succeeds.
    return (hardcoded_fallback, 0.5, "industry-benchmark", "hardcoded-fallback")


def install_cold_start(
    client,
    property_id: str,
    *,
    layer: str,
    prior_value: float,
    prior_strength: float,
    source: str,
    cohort_key: str,
    local_rows_observed: int,
    value_param_name: str,
) -> dict:
    """Atomically install a cold-start model_runs row via RPC.

    Args:
      layer: 'demand' or 'supply'
      value_param_name: the posterior_params key the inference path reads
                        ('prior_minutes_per_room_per_day' for demand,
                         'prior_minutes_per_event' for supply)

    Returns one of:
      {model_run_id, is_active=true, cold_start=true, ...}  — success
      {skipped: true, reason: 'real_model_already_active', ...}  — RPC refused
      {error: '...', model_run_id: None, is_active: False}  — RPC threw
    """
    posterior_params = {
        value_param_name: prior_value,
        "prior_strength": prior_strength,
        "source": source,
        "cohort_key": cohort_key,
    }
    hyperparameters = {
        "local_rows_observed": local_rows_observed,
        "cohort_key": cohort_key,
        "prior_source": source,
    }
    model_version = f"{layer}-cold-start-v1-{datetime.utcnow().isoformat()}"
    try:
        rpc_result = client.client.rpc(
            "staxis_install_demand_supply_cold_start",
            {
                "p_property_id": property_id,
                "p_layer": layer,
                "p_model_version": model_version,
                "p_posterior_params": posterior_params,
                "p_hyperparameters": hyperparameters,
            },
        ).execute()
        new_id = rpc_result.data
        if new_id is None:
            print(json.dumps({
                "evt": f"{layer}_cold_start_skipped",
                "reason": "real_model_already_active",
                "property_id": property_id,
            }))
            return {
                "skipped": True,
                "reason": "real_model_already_active",
                "model_run_id": None,
                "is_active": False,
                "cold_start": False,
            }
        return {
            "model_run_id": new_id,
            "is_active": True,
            "cold_start": True,
            "training_row_count": 0,
            "validation_mae": None,
            "cohort_key": cohort_key,
            "prior_source": source,
        }
    except Exception as exc:
        print(json.dumps({
            "evt": f"{layer}_cold_start_failed",
            "property_id": property_id,
            "error": str(exc)[:200],
        }))
        return {
            "error": f"cold-start install failed: {exc}",
            "model_run_id": None,
            "is_active": False,
        }
