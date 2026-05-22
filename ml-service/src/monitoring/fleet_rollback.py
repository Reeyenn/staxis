"""Phase 7 v2 (2026-05-22) — fleet-wide rollback orchestrator with BH-FDR.

Composes ml-service/src/actuals.py (the prediction_log backfill) with
ml-service/src/monitoring/shadow_mae.py (the per-(property, layer)
Wilcoxon decision + execution) into one daily pipeline.

Why BH-FDR matters: at 50 hotels × 2 layers = 100 simultaneous tests,
raw `p < 0.05` fires ~5 spurious rollbacks/day under the null
(random noise alone). Benjamini-Hochberg false-discovery control via
scipy.stats.false_discovery_control caps the expected proportion of
false rollbacks at α among the rollbacks that fire. After BH-FDR,
each fire is trustworthy.

Public entry point:

  - run_daily_rollback_pipeline(property_ids=None)
      Orchestrator that the cron + FastAPI endpoint call. Does:
        1. Backfill prediction_log for the 3-day rolling window
        2. For each (property, layer): compute rolling Wilcoxon
        3. Apply 14-day cooldown filter (skip recently-rolled-back pairs)
        4. Apply BH-FDR fleet-wide at settings.auto_rollback_fdr_alpha
        5. For each surviving rejection: execute_rollback
           (dry-run or live based on settings.auto_rollback_dry_run)
      Returns a structured summary the TS cron route turns into
      per-property app_events rows.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from src.actuals import backfill_prediction_log
from src.config import get_settings
from src.monitoring import shadow_mae
from src.supabase_client import get_supabase_client


def adjusted_alpha_mask(pvalues: List[float], alpha: float = 0.05) -> List[bool]:
    """Apply Benjamini-Hochberg FDR control to a batch of p-values.

    Returns a per-test rejection mask. True = reject the null
    (active model is significantly worse than same-DOW naive baseline);
    False = keep the active.

    Verified against scipy 1.11.4 docs and Codex review: scipy returns
    ADJUSTED p-values from `false_discovery_control`, NOT a rejection
    mask. Standard usage compares adjusted_p < alpha.
    """
    if not pvalues:
        return []
    # Local import so a missing scipy/false_discovery_control doesn't
    # crash module load; tests can stub this.
    from scipy.stats import false_discovery_control
    adjusted = false_discovery_control(pvalues, method="bh")
    return [float(adj) < alpha for adj in adjusted]


def _list_eligible_pairs() -> List[Dict[str, Any]]:
    """Returns [{property_id, layer}, ...] for every (property, layer)
    that has an active fitted (non-cold-start) housekeeping model
    AND has at least one non-cold-start row eligible for the rolling
    test. The orchestrator runs the check for each.
    """
    client = get_supabase_client()
    rows = client.execute_sql(
        """
        select distinct property_id, layer
        from model_runs
        where is_active = true
          and is_shadow = false
          and layer in ('demand', 'supply')
          and coalesce(is_cold_start, false) = false
          and coalesce(algorithm, '') not like 'cold-start%'
        """
    )
    out = []
    for r in (rows or []):
        pid = r.get("property_id")
        layer = r.get("layer")
        if pid and layer:
            out.append({"property_id": str(pid), "layer": str(layer)})
    return out


async def run_daily_rollback_pipeline(
    property_ids: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Daily orchestrator. Backfill → check → cooldown → BH-FDR → execute.

    Args:
      property_ids: optional list to scope the run (testing, manual
        backfill). None means "all properties with active fitted
        housekeeping models".

    Returns a dict with phase summaries and per-(property, layer)
    decisions. The TS cron route turns each rolled-back / would-fire
    pair into one app_events row.
    """
    settings = get_settings()
    client = get_supabase_client()

    # ── Phase 1: backfill prediction_log over the 3-day window ────────
    backfill_summary = await backfill_prediction_log(property_ids=property_ids)

    # ── Phase 2: gather per-pair Wilcoxon decisions ───────────────────
    pairs = _list_eligible_pairs()
    if property_ids is not None:
        pid_set = {str(p) for p in property_ids}
        pairs = [p for p in pairs if p["property_id"] in pid_set]

    pair_results: List[Dict[str, Any]] = []
    for pair in pairs:
        pid = pair["property_id"]
        layer = pair["layer"]
        # Cooldown filter — skip if we rolled back this pair within
        # the cooldown window. Prevents oscillation.
        if shadow_mae.recent_rollback_within_cooldown(client, pid, layer):
            pair_results.append({
                "property_id": pid, "layer": layer,
                "decision": "cooldown_skip",
                "active_mae": None, "baseline_mae": None,
                "pvalue": None, "adjusted_pvalue": None,
            })
            continue
        triple = shadow_mae.compute_rolling_mae_vs_baseline(pid, layer)
        if triple is None:
            pair_results.append({
                "property_id": pid, "layer": layer,
                "decision": "no_data",
                "active_mae": None, "baseline_mae": None,
                "pvalue": None, "adjusted_pvalue": None,
            })
            continue
        active_mae, baseline_mae, pvalue = triple
        pair_results.append({
            "property_id": pid, "layer": layer,
            "decision": "evaluated",
            "active_mae": active_mae,
            "baseline_mae": baseline_mae,
            "pvalue": pvalue,
            "adjusted_pvalue": None,  # filled in next phase
        })

    # ── Phase 3: BH-FDR across all `evaluated` pairs ──────────────────
    evaluated_idx = [
        i for i, p in enumerate(pair_results) if p["decision"] == "evaluated"
    ]
    pvalues = [pair_results[i]["pvalue"] for i in evaluated_idx]
    alpha = float(settings.auto_rollback_fdr_alpha)
    rejection_mask = adjusted_alpha_mask(pvalues, alpha=alpha)
    # Annotate each evaluated pair with its post-BH decision; compute the
    # adjusted p-value for diagnostics (operators want to see why).
    if evaluated_idx and pvalues:
        try:
            from scipy.stats import false_discovery_control
            adjusted_full = list(false_discovery_control(pvalues, method="bh"))
        except Exception:
            adjusted_full = pvalues  # fall back so we still write something
    else:
        adjusted_full = []
    for k, idx in enumerate(evaluated_idx):
        pair_results[idx]["adjusted_pvalue"] = float(adjusted_full[k])
        if rejection_mask[k]:
            # Belt-and-suspenders: also check the decide_rollback gate
            # (rejects when active <= baseline despite p<alpha).
            pr = pair_results[idx]
            if shadow_mae.decide_rollback(
                pr["active_mae"], pr["baseline_mae"], pr["pvalue"], alpha=alpha,
            ):
                pair_results[idx]["decision"] = "rollback_indicated"
            else:
                pair_results[idx]["decision"] = "rejection_dismissed_direction"
        # else: stays as 'evaluated' (BH did not reject)

    # ── Phase 4: execute (or dry-run-log) the rollbacks ───────────────
    dry_run = bool(settings.auto_rollback_dry_run)
    rolled_back_count = 0
    would_fire_count = 0
    execute_failures: List[Dict[str, Any]] = []
    for pr in pair_results:
        if pr["decision"] != "rollback_indicated":
            continue
        exec_result = shadow_mae.execute_rollback(
            pr["property_id"], pr["layer"], dry_run=dry_run,
        )
        pr["execute"] = exec_result
        if exec_result.get("decision") == "rolled_back":
            rolled_back_count += 1
        elif exec_result.get("decision") == "would_fire":
            would_fire_count += 1
        elif exec_result.get("decision") == "execute_failed":
            execute_failures.append({
                "property_id": pr["property_id"], "layer": pr["layer"],
                "error": exec_result.get("error"),
            })

    return {
        "phase_backfill": backfill_summary,
        "phase_check": {
            "pairs_evaluated": len(pair_results),
            "pairs_no_data": sum(1 for p in pair_results if p["decision"] == "no_data"),
            "pairs_cooldown_skip": sum(
                1 for p in pair_results if p["decision"] == "cooldown_skip"
            ),
            "pairs_rollback_indicated": sum(
                1 for p in pair_results if p["decision"] == "rollback_indicated"
            ),
        },
        "rollbacks_fired": rolled_back_count,
        "dry_run_would_fire": would_fire_count,
        "execute_failures": execute_failures,
        "dry_run": dry_run,
        "alpha": alpha,
        "results": pair_results,
    }
