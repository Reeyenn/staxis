"""Rolling 14-day shadow MAE computation and auto-rollback."""
import json
from datetime import datetime, timedelta
from typing import Any, Dict, Optional, Tuple

import numpy as np
import psycopg2
from scipy import stats

from src.advisory_lock import advisory_lock
from src.config import get_settings
from src.supabase_client import SupabaseServiceClient, get_supabase_client, safe_uuid


def _find_fallback_model(
    client: SupabaseServiceClient,
    property_id: str,
    layer: str,
    failed_model_id: str,
) -> Optional[Dict[str, Any]]:
    """Find the best previously-active model to promote when auto-rollback
    fires. We prefer the most recently-activated non-shadow run that hasn't
    itself been auto-rolled-back, and that has a recorded validation MAE
    (so we have at least some evidence it's not garbage).

    Codex audit pass-6 P0 — auto-rollback used to deactivate the bad model
    and stop there. The property would then have ZERO active models for
    that layer and predictions would silently stop. Now we promote the
    previous good run in the same lock window.

    Returns the row to promote, or None if there's no candidate (in which
    case the caller logs a high-priority alert — operators must manually
    restore service).
    """
    candidates = client.fetch_many(
        "model_runs",
        filters={"property_id": property_id, "layer": layer, "is_shadow": False},
        order_by="activated_at",
        descending=True,
        limit=20,
    )
    for row in candidates:
        if row.get("id") == failed_model_id:
            continue
        # Skip prior auto-rolled-back runs — they've already been judged
        # bad once and we shouldn't re-promote them.
        if (row.get("deactivation_reason") or "").lower() == "auto_rollback":
            continue
        # Require a recorded validation MAE so we have at least one
        # quality signal before flipping a property's active model.
        if row.get("validation_mae") is None:
            continue
        # Activated_at must exist — never-activated draft runs aren't
        # valid fallbacks.
        if not row.get("activated_at"):
            continue
        return row
    return None


# *** DEAD CODE NOTICE (Codex post-merge review 2026-05-13, Phase 2.3) ***
# The two functions below (`compute_rolling_shadow_mae` and
# `check_auto_rollback`) have ZERO callers in any cron, route, or task.
# The auto-rollback subsystem is fully built but not wired. Recent fixes
# (M-C1 database_url at line ~266, H-4 Wilcoxon n>=10 at line ~187) keep
# them CORRECT, just unused. Wiring requires:
#   1. A new cron route src/app/api/cron/ml-auto-rollback-check/route.ts
#      that iterates active models per property and calls
#      `check_auto_rollback`.
#   2. BH-FDR correction across the fleet (H-4 step 2 backlog item) to
#      keep false-rollback rate manageable at fleet scale.
#   3. Operator alerts when a rollback fires.
# Each of those is its own multi-day project. Until they land, these
# functions stay correct-but-unused. DO NOT DELETE — they are the
# executable spec for what auto-rollback should do.


async def compute_rolling_shadow_mae(
    property_id: str,
    layer: str,
) -> Optional[Tuple[float, float, float]]:
    """Compute rolling 14-day shadow MAE for active model vs the most
    recent previous active model (the natural rollback target).

    Codex audit pass-6 P1 — three statistical issues fixed here:

    1. The 14-day cutoff was computed but never applied to the fetch,
       so old predictions could influence rollback decisions long after
       the window closed.
    2. The previous "baseline" was every log not from the active model,
       which mixed multiple prior models + shadows + static baseline
       into one comparator. Now we pin the comparator to a single
       model_run_id (the most recent previously-active model) so the
       comparison is between two known cohorts.
    3. Mann-Whitney U is unpaired. Each error pair comes from the same
       day's prediction; the natural test is paired (Wilcoxon signed-
       rank). Paired tests are far more powerful when the two samples
       share day-to-day variation.

    Args:
        property_id: Property UUID
        layer: Layer name (demand, supply)

    Returns:
        Tuple of (active_mae, baseline_mae, pvalue) or None if insufficient data
    """
    client = get_supabase_client()
    settings = get_settings()

    # Find active model
    active_models = client.fetch_many(
        "model_runs",
        filters={"property_id": property_id, "layer": layer, "is_active": True},
        limit=1,
    )

    if not active_models:
        return None

    active_model_id = active_models[0]["id"]

    # Pick the comparator: the most recent previously-active non-shadow
    # run that ISN'T the current active model and wasn't itself rolled
    # back. This is the run we'd roll back TO, so it's the right thing
    # to compare against.
    prior_runs = client.fetch_many(
        "model_runs",
        filters={"property_id": property_id, "layer": layer, "is_shadow": False},
        order_by="activated_at",
        descending=True,
        limit=10,
    )
    comparator_model_id = None
    for row in prior_runs:
        if row.get("id") == active_model_id:
            continue
        if (row.get("deactivation_reason") or "").lower() == "auto_rollback":
            continue
        if not row.get("activated_at"):
            continue
        comparator_model_id = row["id"]
        break

    if comparator_model_id is None:
        # Nothing to compare against — never rolled over from a previous
        # active model. Can't make a rollback decision in that state.
        return None

    # Fetch prediction_log for last `auto_rollback_window_days` days
    # ONLY. Filter on `date` (the operational date the prediction was
    # MADE FOR), not `logged_at` (the moment the actual error was
    # recorded) — otherwise a stale prediction backfilled today pairs
    # against fresh actuals and biases the rollback decision.
    # (Phase L: K mistakenly used `prediction_date`, a column that
    # doesn't exist on prediction_log; the bare except below swallowed
    # the SQL error so the bug hid. The actual operational-date column
    # is `date`, per migration 0021 and the `prediction_log_pld_idx`
    # index added in 0104.)
    cutoff_dt = datetime.utcnow() - timedelta(days=settings.auto_rollback_window_days)
    cutoff_iso = cutoff_dt.isoformat()
    # Layer is bounded to {'demand', 'supply'} at the API boundary; defense-
    # in-depth assert here so a future caller that bypasses the boundary
    # can't inject. cutoff_iso is server-derived (datetime.utcnow()) so it
    # carries no user-input lineage; not wrapped.
    if layer not in ('demand', 'supply'):
        raise ValueError(f"safe_layer: not a valid layer: {layer!r}")
    logs_query = f"""
        select model_run_id, abs_error, date
        from prediction_log
        where property_id = '{safe_uuid(property_id)}'
          and layer = '{layer}'
          and date >= '{cutoff_iso}'
          and model_run_id in ('{safe_uuid(active_model_id)}', '{safe_uuid(comparator_model_id)}')
        order by date asc
    """
    try:
        logs = client.execute_sql(logs_query)
    except Exception as exc:
        # Phase L discipline rule #3: never swallow silently. A future
        # column-name regression here surfaces in logs within one cron
        # cycle instead of hiding for months like Phase K's did.
        print(json.dumps({
            "evt": "shadow_mae_query_failed",
            "property_id": property_id,
            "layer": layer,
            "error": str(exc)[:200],
        }))
        return None

    if not logs or len(logs) < 10:
        return None

    # Bucket errors by date so we can pair them across the two models.
    # Each bucket holds at most one active-error and one comparator-error
    # per date; a date that has both contributes one paired observation.
    by_date: dict = {}
    for log in logs:
        d = log.get("date")
        if d is None:
            continue
        bucket = by_date.setdefault(str(d), {})
        try:
            err = float(log.get("abs_error", 0))
        except (TypeError, ValueError):
            continue
        run_id = log.get("model_run_id")
        if run_id == active_model_id and "active" not in bucket:
            bucket["active"] = err
        elif run_id == comparator_model_id and "comparator" not in bucket:
            bucket["comparator"] = err

    paired_active: list = []
    paired_baseline: list = []
    for bucket in by_date.values():
        if "active" in bucket and "comparator" in bucket:
            paired_active.append(bucket["active"])
            paired_baseline.append(bucket["comparator"])

    # Codex post-merge review 2026-05-13 (H-4): bumped from n=5 to n=10.
    # At n=5 the Wilcoxon signed-rank one-sided minimum achievable p-value
    # is 1/32 ≈ 0.031 — already below the 0.05 trigger at line 229. A
    # single unlucky 5-of-5 comparison favoring "active is worse" would
    # fire a rollback regardless of effect size. n>=10 gives the test a
    # minimum p ~0.001 and makes the alpha=0.05 boundary meaningful.
    # Step 2 (BH-FDR across the cron pass) tracked as backlog — requires
    # pivoting the cron loop, defer until shadow-evaluate has real
    # fleet-scale traffic.
    if len(paired_active) < 10:
        # Not enough paired days yet to make a confident call.
        return None

    active_mae = float(np.mean(paired_active))
    baseline_mae = float(np.mean(paired_baseline))

    # Wilcoxon signed-rank: paired, one-sided test that active errors
    # are GREATER than baseline errors (i.e. the active model is worse).
    # zero_method="zsplit" handles ties (same error on both models)
    # without throwing on Wilcoxon's no-difference fast-path.
    try:
        result = stats.wilcoxon(
            paired_active, paired_baseline,
            alternative="greater",
            zero_method="zsplit",
        )
        pvalue = float(result.pvalue)
    except Exception:
        return None

    return (active_mae, baseline_mae, pvalue)


async def check_auto_rollback(
    property_id: str,
    layer: str,
) -> bool:
    """Check if active model should be rolled back.

    Criteria:
    - Wilcoxon p-value < 0.05 AND
    - Active model errors > baseline errors

    Args:
        property_id: Property UUID
        layer: Layer name

    Returns:
        True if rollback should happen
    """
    settings = get_settings()
    result = await compute_rolling_shadow_mae(property_id, layer)

    if result is None:
        return False

    active_mae, baseline_mae, pvalue = result

    # Rollback if statistically worse
    should_rollback = (
        pvalue < settings.auto_rollback_pvalue_threshold
        and active_mae > baseline_mae
    )

    if should_rollback:
        # Look up the active model FIRST so we can log its id even if the lock
        # acquisition or update fails. (Previous version referenced
        # active_models[0]['id'] in the log line BEFORE that variable was
        # ever populated — the log always wrote null.)
        client = get_supabase_client()
        try:
            active_models = client.fetch_many(
                "model_runs",
                filters={"property_id": property_id, "layer": layer, "is_active": True},
                limit=1,
            )
        except Exception as fetch_err:
            print(
                json.dumps(
                    {
                        "level": "error",
                        "event": "auto_rollback_active_model_fetch_failed",
                        "property_id": property_id,
                        "layer": layer,
                        "err": repr(fetch_err),
                        "ts": datetime.utcnow().isoformat(),
                    }
                )
            )
            return should_rollback
        active_model_id = active_models[0]["id"] if active_models else None

        # Acquire advisory lock so concurrent workers don't double-deactivate.
        # Codex adversarial review 2026-05-13 (M-C1): the previous version
        # parsed settings.supabase_url (HTTPS, port 443, PostgREST gateway)
        # as if it were a Postgres host. Every connect failed silently and
        # auto-rollback never actually fired in production. Use the same
        # database_url the training modules use for their advisory locks.
        if not settings.database_url:
            print(
                json.dumps(
                    {
                        "level": "error",
                        "event": "auto_rollback_no_database_url",
                        "property_id": property_id,
                        "layer": layer,
                        "ts": datetime.utcnow().isoformat(),
                        "remediation": "Set DATABASE_URL (or SUPABASE_DB_URL) in the ML service env.",
                    }
                )
            )
            return should_rollback
        conn = None
        try:
            conn = psycopg2.connect(settings.database_url)
            with advisory_lock(conn, property_id, layer, blocking=False) as acquired:
                if not acquired:
                    # Another worker is handling this rollback; skip silently.
                    print(
                        json.dumps(
                            {
                                "level": "info",
                                "event": "auto_rollback_lock_held_by_other",
                                "property_id": property_id,
                                "layer": layer,
                                "ts": datetime.utcnow().isoformat(),
                            }
                        )
                    )
                    return should_rollback

                # Emit structured log before deactivating.
                print(
                    json.dumps(
                        {
                            "level": "error",
                            "event": "auto_rollback_triggered",
                            "property_id": property_id,
                            "layer": layer,
                            "active_model_run_id": active_model_id,
                            "active_mae": float(active_mae),
                            "baseline_mae": float(baseline_mae),
                            "pvalue": float(pvalue),
                            "ts": datetime.utcnow().isoformat(),
                        }
                    )
                )

                # Find a fallback BEFORE we deactivate — if no candidate
                # exists, we still deactivate (predictions on the bad
                # model are worse than no predictions) but we surface a
                # high-priority alert so operators can intervene.
                fallback = _find_fallback_model(
                    client, property_id, layer, active_model_id or "",
                )

                # Deactivate the bad model.
                if active_model_id:
                    try:
                        client.update(
                            "model_runs",
                            {
                                "is_active": False,
                                "deactivated_at": datetime.utcnow().isoformat(),
                                "deactivation_reason": "auto_rollback",
                            },
                            {"id": active_model_id},
                        )
                    except Exception as update_err:
                        print(
                            json.dumps(
                                {
                                    "level": "error",
                                    "event": "auto_rollback_update_failed",
                                    "property_id": property_id,
                                    "layer": layer,
                                    "active_model_run_id": active_model_id,
                                    "err": repr(update_err),
                                    "ts": datetime.utcnow().isoformat(),
                                }
                            )
                        )
                        # If we couldn't even deactivate, don't try to
                        # promote a fallback — the bad model is still
                        # marked active and we'd have two active rows.
                        return should_rollback

                # Promote the fallback if we found one.
                if fallback is not None:
                    fallback_id = fallback["id"]
                    try:
                        client.update(
                            "model_runs",
                            {
                                "is_active": True,
                                "activated_at": datetime.utcnow().isoformat(),
                                "activation_reason": "auto_rollback_restore",
                            },
                            {"id": fallback_id},
                        )
                        print(
                            json.dumps(
                                {
                                    "level": "warning",
                                    "event": "auto_rollback_fallback_promoted",
                                    "property_id": property_id,
                                    "layer": layer,
                                    "deactivated_model_run_id": active_model_id,
                                    "promoted_model_run_id": fallback_id,
                                    "promoted_validation_mae": float(
                                        fallback.get("validation_mae", 0)
                                    ),
                                    "ts": datetime.utcnow().isoformat(),
                                }
                            )
                        )
                    except Exception as promote_err:
                        # Promotion failed → property is left without an
                        # active model. Loud alert so operators can fix
                        # manually before tomorrow's predictions.
                        print(
                            json.dumps(
                                {
                                    "level": "error",
                                    "event": "auto_rollback_no_active_model",
                                    "subevent": "promotion_failed",
                                    "property_id": property_id,
                                    "layer": layer,
                                    "deactivated_model_run_id": active_model_id,
                                    "attempted_promotion_run_id": fallback_id,
                                    "err": repr(promote_err),
                                    "ts": datetime.utcnow().isoformat(),
                                }
                            )
                        )
                else:
                    # No safe fallback exists. Predictions for this
                    # (property, layer) will stop until a human acts.
                    # Loud structured log so monitoring can page.
                    print(
                        json.dumps(
                            {
                                "level": "error",
                                "event": "auto_rollback_no_active_model",
                                "subevent": "no_fallback_found",
                                "property_id": property_id,
                                "layer": layer,
                                "deactivated_model_run_id": active_model_id,
                                "ts": datetime.utcnow().isoformat(),
                            }
                        )
                    )
        except Exception as lock_err:
            # Lock acquisition / connection failed — surface to operators
            # instead of silently skipping (previous version did `pass`).
            print(
                json.dumps(
                    {
                        "level": "error",
                        "event": "auto_rollback_lock_or_conn_failed",
                        "property_id": property_id,
                        "layer": layer,
                        "active_model_run_id": active_model_id,
                        "err": repr(lock_err),
                        "ts": datetime.utcnow().isoformat(),
                    }
                )
            )
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

    return should_rollback
