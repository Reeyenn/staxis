"""Walk-forward backtest for housekeeping ML — Phase 2.1 (2026-05-22).

PURPOSE
-------
Replays the last N weeks of real `cleaning_events` for a property
through the production model code path, retraining weekly to match the
GitHub Actions cron cadence (Sundays at 03:00 CDT). Reports honest
out-of-sample MAE separately for fitted days vs cold-start days.

This is the audit-grade accuracy number the cockpit shows. It is
separate from the 20% holdout MAE that training itself reports
(`model_runs.validation_mae`) — that number is computed during the same
training pass, on the same dataset. Walk-forward is a real over-time
test that catches feature drift.

READ-ONLY CONTRACT (Codex H2 finding — 2026-05-21)
--------------------------------------------------
This script MUST NOT mutate production state. To enforce that at
runtime, the Supabase client is wrapped in a `ReadOnlySupabaseClient`
proxy that raises on `.upsert()`, `.insert()`, `.update()`,
`.delete()`, and `.rpc()` calls. Only one write op is whitelisted: a
single storage upload of the JSON artifact to
`backtest_results/{property_id}/{layer}/{run_date}.json` in the
`ml-models` bucket. The matching unit test
(`tests/test_backtest_is_read_only.py`) asserts that an attempt to
call a non-whitelisted writer raises.

This also means the script does NOT import any of:
  - src.training.demand.train_demand_model
  - src.training.supply.train_supply_model
  - src.inference.demand.predict_demand
  - src.inference.supply.predict_supply
because those paths upsert to `model_runs` /
`demand_predictions` / `supply_predictions`. Instead it imports
the pure feature builder + the in-memory Bayesian regressor.

CLI
---
    python -m scripts.backtest_housekeeping \\
      --property-id <uuid> --layer demand --weeks 8 [--dry-run] [--out PATH]

Refusal contract: if `days_fitted < 14`, the headline `fittedOnlyMae`
is `None` and `refusalReason='INSUFFICIENT_FITTED_DATA'`. No silent
green-pill on a number that's dominated by cohort-prior error.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import uuid
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from src.config import get_settings
from src.features.supply_matrix import build_supply_features
from src.layers.bayesian_regression import BayesianRegression
from src.supabase_client import SupabaseServiceClient, get_supabase_client, safe_uuid


# ─── Read-only Supabase proxy ─────────────────────────────────────────────

class _ReadOnlyViolation(RuntimeError):
    """Raised when a writer method is called on the read-only proxy."""


class ReadOnlySupabaseClient:
    """Wraps SupabaseServiceClient to refuse all writers.

    Whitelisted methods pass through transparently:
      - fetch_one
      - fetch_many
      - execute_sql

    Everything else raises `_ReadOnlyViolation`. The matching test
    (`tests/test_backtest_is_read_only.py`) ensures this proxy is
    actually in use when the backtest runs.

    Storage uploads (the one allowed write) go through the bare
    `_inner.client.storage.from_(...)` path; the proxy intercepts only
    the table-mutation methods. Callers that need to write the artifact
    use `proxy.allow_storage_upload(bucket, path, body)` which is the
    only sanctioned escape hatch.
    """

    _ALLOWED = {"fetch_one", "fetch_many", "execute_sql", "client"}

    def __init__(self, inner: SupabaseServiceClient) -> None:
        self._inner = inner

    def __getattr__(self, name: str) -> Any:
        # Whitelist reads.
        if name in self._ALLOWED:
            return getattr(self._inner, name)
        # Refuse known writers loudly.
        if name in {"upsert", "insert", "update", "delete", "rpc"}:
            raise _ReadOnlyViolation(
                f"backtest may not call Supabase writer .{name}() — see "
                "scripts/backtest_housekeeping.py:ReadOnlySupabaseClient"
            )
        # Anything else (future API surface) — refuse by default.
        raise _ReadOnlyViolation(
            f"backtest may not call .{name}() on the Supabase client "
            "(not in the read whitelist)"
        )

    def allow_storage_upload(
        self,
        bucket: str,
        path: str,
        body: bytes,
        content_type: str = "application/json",
    ) -> Dict[str, Any]:
        """The one sanctioned write — uploads the backtest artifact.

        Returns a small status dict so callers can log success without
        leaking the raw supabase-py response.
        """
        try:
            res = self._inner.client.storage.from_(bucket).upload(
                path,
                body,
                {"content-type": content_type, "x-upsert": "true"},
            )
            return {"ok": True, "path": path, "bytes": len(body), "raw": getattr(res, "data", str(res))[:200]}
        except Exception as exc:
            return {"ok": False, "path": path, "error": str(exc)[:300]}


# ─── Data fetch helpers (mirrors training/demand.py SQL) ─────────────────

def _fetch_demand_rows(client: ReadOnlySupabaseClient, property_id: str) -> pd.DataFrame:
    """Read the per-day aggregated demand data, mirroring training/demand.py.

    Returns a DataFrame indexed by `date` with target_minutes + feature
    columns. Empty DataFrame if the property has no usable rows.
    """
    pid = safe_uuid(property_id)
    query = f"""
        select
          cmpd.date as date,
          cmpd.total_recorded_minutes as target_minutes,
          coalesce(ps.checkouts, 0) as total_checkouts,
          coalesce(ps.stayover_day1, 0) as stayover_day_1_count,
          coalesce(ps.stayover_day2, 0)
            + coalesce(ps.stayover_arrival_day, 0)
            + coalesce(ps.stayover_unknown, 0) as stayover_day_2plus_count,
          coalesce(ps.vacant_dirty, 0) as vacant_dirty_count,
          case
            when coalesce(ps.total_rooms, 0) > 0
            then round((100.0 * (ps.total_rooms
              - coalesce(ps.vacant_clean, 0)
              - coalesce(ps.vacant_dirty, 0)
              - coalesce(ps.ooo, 0))::numeric / ps.total_rooms)::numeric, 2)
            else 50.0
          end as occupancy_pct,
          extract(dow from cmpd.date)::int as day_of_week
        from cleaning_minutes_per_day_view cmpd
        left join plan_snapshots ps
          on ps.property_id = cmpd.property_id and ps.date = cmpd.date
        where cmpd.property_id = '{pid}'
          and cmpd.total_recorded_minutes is not null
          and cmpd.total_recorded_minutes > 0
        order by cmpd.date
    """
    rows = client.execute_sql(query)
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(rows)
    # Normalize types.
    feature_cols = [
        "total_checkouts", "stayover_day_1_count", "stayover_day_2plus_count",
        "vacant_dirty_count", "occupancy_pct", "day_of_week",
    ]
    for c in feature_cols + ["target_minutes"]:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce")
    df["date"] = pd.to_datetime(df["date"]).dt.date
    df = df.dropna(subset=["target_minutes"]).reset_index(drop=True)
    return df


def _fetch_supply_rows(client: ReadOnlySupabaseClient, property_id: str) -> pd.DataFrame:
    """Read raw cleaning_events for the supply backtest.

    Mirrors training/supply.py's SQL — actual_minutes is the duration of
    each cleaning, plus the small set of contextual features
    build_supply_features() needs.
    """
    pid = safe_uuid(property_id)
    query = f"""
        select
            id,
            property_id,
            staff_id,
            room_number,
            room_type,
            created_at,
            date,
            extract(epoch from (completed_at - started_at)) / 60 as actual_minutes,
            day_of_week,
            occupancy_at_start,
            was_dnd_during_clean
        from cleaning_events
        where property_id = '{pid}'
          and completed_at is not null
          and started_at is not null
          and status != 'discarded'
        order by created_at
    """
    rows = client.execute_sql(query)
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(rows)
    df["actual_minutes"] = pd.to_numeric(df.get("actual_minutes"), errors="coerce")
    df = df.dropna(subset=["actual_minutes"])
    # Drop unrealistic outliers (same filter training/supply.py uses).
    df = df[(df["actual_minutes"] > 1) & (df["actual_minutes"] < 180)].reset_index(drop=True)
    if "date" in df.columns:
        df["date"] = pd.to_datetime(df["date"]).dt.date
    return df


# ─── Cohort prior lookup (read-only — borrowed verbatim from training/) ──

def _lookup_demand_prior(client: ReadOnlySupabaseClient, property_id: str) -> float:
    """Get the cohort prior for demand cold-start days. Read-only."""
    try:
        # Use the same shared helper production training uses — it's a
        # pure-read function that doesn't write anything.
        from src.training._cold_start import lookup_cohort_prior
        prior, _strength, _src, _key = lookup_cohort_prior(
            client, property_id,
            table="demand_priors",
            value_col="prior_minutes_per_room_per_day",
            hardcoded_fallback=20.0,
        )
        return float(prior)
    except Exception:
        return 20.0


def _lookup_supply_prior(client: ReadOnlySupabaseClient, property_id: str) -> float:
    try:
        from src.training._cold_start import lookup_cohort_prior
        prior, _strength, _src, _key = lookup_cohort_prior(
            client, property_id,
            table="supply_priors",
            value_col="prior_minutes_per_event",
            hardcoded_fallback=30.0,
        )
        return float(prior)
    except Exception:
        return 30.0


def _fetch_total_rooms(client: ReadOnlySupabaseClient, property_id: str) -> int:
    """Used by the demand cold-start path: cohort prior × room count."""
    pid = safe_uuid(property_id)
    rows = client.execute_sql(
        f"select coalesce(total_rooms, 0) as total_rooms from properties "
        f"where id = '{pid}' limit 1"
    )
    if not rows:
        return 0
    try:
        return int(rows[0].get("total_rooms") or 0)
    except (TypeError, ValueError):
        return 0


# ─── Walk-forward core ────────────────────────────────────────────────────

@dataclass
class DayResult:
    """One day's backtest outcome."""
    date: str
    actual: float
    predicted: float
    abs_error: float
    train_set_size: int
    was_fitted: bool          # train_set_size >= training_row_count_min (200)
    used_cohort_prior: bool


@dataclass
class BacktestResult:
    """The JSON artifact written to Supabase Storage."""
    property_id: str
    layer: str
    weeks: int
    run_date: str
    all_days_mae: Optional[float]
    fitted_only_mae: Optional[float]
    fitted_only_mae_ratio: Optional[float]
    quantile_coverage_80: Optional[float]
    beats_baseline_pct: Optional[float]
    days_total: int
    days_fitted: int
    days_cold_start: int
    days_insufficient_data: int
    refusal_reason: Optional[str]
    summary: str
    # Per-day audit trail. Useful for debugging "why did Tuesday Apr 9
    # blow up?" without re-running the backtest.
    daily: List[Dict[str, Any]] = field(default_factory=list)


def _weekly_sundays(start: date, end: date) -> List[date]:
    """Returns the Sundays in [start, end], inclusive."""
    out: List[date] = []
    d = start
    # Advance to first Sunday (weekday=6 in Python).
    while d <= end and d.weekday() != 6:
        d += timedelta(days=1)
    while d <= end:
        out.append(d)
        d += timedelta(days=7)
    return out


def _trailing_14d_median(daily: List[DayResult], up_to_excl: date) -> float:
    """Baseline = trailing 14-day median of past actuals. Mirrors training's
    'predict the mean' baseline but uses a rolling window so the
    comparison is honest in the walk-forward setting.
    """
    cutoff = up_to_excl - timedelta(days=14)
    vals = [d.actual for d in daily if cutoff <= date.fromisoformat(d.date) < up_to_excl]
    if not vals:
        return float("nan")
    return float(np.median(vals))


def _backtest_demand(
    df: pd.DataFrame,
    client: ReadOnlySupabaseClient,
    property_id: str,
    weeks: int,
    settings,
) -> List[DayResult]:
    """Walk-forward demand backtest. Weekly retrain cadence."""
    feature_cols = [
        "total_checkouts", "stayover_day_1_count", "stayover_day_2plus_count",
        "vacant_dirty_count", "occupancy_pct", "day_of_week",
    ]
    if df.empty:
        return []
    df = df.sort_values("date").reset_index(drop=True)
    last_date = df["date"].max()
    window_start = last_date - timedelta(weeks=weeks)
    sundays = _weekly_sundays(window_start, last_date)
    cohort_prior_per_room = _lookup_demand_prior(client, property_id)
    total_rooms = _fetch_total_rooms(client, property_id)
    results: List[DayResult] = []
    for sun in sundays:
        # Train-set: everything strictly before this Sunday.
        train_mask = df["date"] < sun
        train_df = df[train_mask]
        train_n = len(train_df)
        if train_n >= settings.training_row_count_min:
            # Fitted: in-memory Bayesian fit (no writes).
            X_train = train_df[feature_cols].fillna(0)
            X_train = pd.concat(
                [pd.Series(np.ones(len(X_train)), name="intercept"), X_train.reset_index(drop=True)],
                axis=1,
            )
            y_train = train_df["target_minutes"].fillna(0).reset_index(drop=True)
            model = BayesianRegression()
            try:
                model.fit(X_train, y_train)
                fitted_ok = True
            except Exception:
                fitted_ok = False
        else:
            fitted_ok = False
            model = None  # type: ignore[assignment]
        # Predict each Mon–Sat that week.
        for offset in range(1, 7):
            day = sun + timedelta(days=offset)
            if day > last_date:
                break
            day_rows = df[df["date"] == day]
            if day_rows.empty:
                results.append(DayResult(
                    date=day.isoformat(), actual=0.0, predicted=0.0, abs_error=0.0,
                    train_set_size=train_n, was_fitted=False, used_cohort_prior=False,
                ))
                # Sentinel for "no data this day"; filtered out below.
                continue
            actual = float(day_rows.iloc[0]["target_minutes"])
            if fitted_ok and model is not None:
                X_day = day_rows[feature_cols].fillna(0).reset_index(drop=True)
                X_day = pd.concat(
                    [pd.Series(np.ones(len(X_day)), name="intercept"), X_day], axis=1,
                )
                try:
                    pred_arr = model.predict_quantile(X_day, [0.5])
                    predicted = float(pred_arr[0.5][0])
                    used_prior = False
                except Exception:
                    predicted = cohort_prior_per_room * total_rooms
                    used_prior = True
            else:
                predicted = cohort_prior_per_room * total_rooms
                used_prior = True
            results.append(DayResult(
                date=day.isoformat(), actual=actual, predicted=predicted,
                abs_error=abs(predicted - actual), train_set_size=train_n,
                was_fitted=fitted_ok and not used_prior,
                used_cohort_prior=used_prior,
            ))
    # Drop sentinels (no actual data for that day).
    return [r for r in results if r.actual > 0]


def _backtest_supply(
    df: pd.DataFrame,
    client: ReadOnlySupabaseClient,
    property_id: str,
    weeks: int,
    settings,
) -> List[DayResult]:
    """Walk-forward supply backtest. Aggregates per-event predictions to
    per-day MAE so the headline matches the demand layer's grain.
    """
    if df.empty:
        return []
    df = df.sort_values("created_at").reset_index(drop=True)
    df["date"] = pd.to_datetime(df["date"]).dt.date
    last_date = df["date"].max()
    window_start = last_date - timedelta(weeks=weeks)
    sundays = _weekly_sundays(window_start, last_date)
    cohort_prior_per_event = _lookup_supply_prior(client, property_id)
    results: List[DayResult] = []
    for sun in sundays:
        train_mask = df["date"] < sun
        train_df = df[train_mask].reset_index(drop=True)
        train_n = len(train_df)
        model = None  # type: ignore[assignment]
        train_feature_names: List[str] = []
        if train_n >= settings.training_row_count_min:
            try:
                X_train, train_feature_names = build_supply_features(train_df, training=True)
                y_train = train_df["actual_minutes"].fillna(25).reset_index(drop=True)
                model = BayesianRegression()
                model.fit(X_train, y_train)
                fitted_ok = True
            except Exception:
                fitted_ok = False
                model = None
        else:
            fitted_ok = False
        for offset in range(1, 7):
            day = sun + timedelta(days=offset)
            if day > last_date:
                break
            day_rows = df[df["date"] == day]
            if day_rows.empty:
                continue
            actual_day_total = float(day_rows["actual_minutes"].sum())
            if fitted_ok and model is not None and train_feature_names:
                try:
                    X_day, _ = build_supply_features(
                        day_rows.reset_index(drop=True),
                        training=False,
                        feature_names=train_feature_names,
                    )
                    pred = model.predict_quantile(X_day, [0.5])
                    predicted_day_total = float(np.sum(pred[0.5]))
                    used_prior = False
                except Exception:
                    predicted_day_total = cohort_prior_per_event * len(day_rows)
                    used_prior = True
            else:
                predicted_day_total = cohort_prior_per_event * len(day_rows)
                used_prior = True
            results.append(DayResult(
                date=day.isoformat(),
                actual=actual_day_total,
                predicted=predicted_day_total,
                abs_error=abs(predicted_day_total - actual_day_total),
                train_set_size=train_n,
                was_fitted=fitted_ok and not used_prior,
                used_cohort_prior=used_prior,
            ))
    return results


# ─── Aggregation + refusal contract ───────────────────────────────────────

INSUFFICIENT_FITTED_DAYS = 14

def _aggregate(
    property_id: str,
    layer: str,
    weeks: int,
    daily: List[DayResult],
) -> BacktestResult:
    """Roll per-day results into the final artifact + apply refusal contract."""
    run_date = datetime.now(timezone.utc).date().isoformat()
    if not daily:
        return BacktestResult(
            property_id=property_id, layer=layer, weeks=weeks, run_date=run_date,
            all_days_mae=None, fitted_only_mae=None, fitted_only_mae_ratio=None,
            quantile_coverage_80=None, beats_baseline_pct=None,
            days_total=0, days_fitted=0, days_cold_start=0, days_insufficient_data=0,
            refusal_reason="NO_DATA_IN_WINDOW",
            summary=f"No cleaning events found in the last {weeks} weeks for this property.",
            daily=[],
        )
    fitted = [d for d in daily if d.was_fitted]
    cold = [d for d in daily if d.used_cohort_prior]
    days_total = len(daily)
    days_fitted = len(fitted)
    days_cold = len(cold)
    days_insuf = days_total - days_fitted - days_cold

    all_days_mae = float(np.mean([d.abs_error for d in daily])) if daily else None

    if days_fitted < INSUFFICIENT_FITTED_DAYS:
        summary = (
            f"INSUFFICIENT_FITTED_DATA — only {days_fitted} fitted days in "
            f"the last {weeks} weeks (need ≥{INSUFFICIENT_FITTED_DAYS}). "
            f"{days_cold} days were cold-start (cohort prior). "
            "Come back when the property has accumulated more cleaning history."
        )
        return BacktestResult(
            property_id=property_id, layer=layer, weeks=weeks, run_date=run_date,
            all_days_mae=all_days_mae,
            fitted_only_mae=None, fitted_only_mae_ratio=None,
            quantile_coverage_80=None, beats_baseline_pct=None,
            days_total=days_total, days_fitted=days_fitted,
            days_cold_start=days_cold, days_insufficient_data=days_insuf,
            refusal_reason="INSUFFICIENT_FITTED_DATA",
            summary=summary,
            daily=[asdict(d) for d in daily],
        )

    fitted_only_mae = float(np.mean([d.abs_error for d in fitted]))
    fitted_actuals = [d.actual for d in fitted]
    mean_actual = float(np.mean(np.abs(fitted_actuals))) or 1.0
    fitted_only_mae_ratio = fitted_only_mae / max(mean_actual, 1.0)
    # Coverage at the 80% interval — for the median-only backtest above
    # we don't have p10/p90 series per day, so coverage is reported as
    # null for now. The Phase 1.2 quantile prediction path would let a
    # future revision compute this; left null rather than fabricated.
    coverage_80: Optional[float] = None
    # Baseline = trailing 14-day median actual at each fitted day. The
    # walk-forward analogue of training's "predict-mean" baseline.
    baselines: List[float] = []
    for d in fitted:
        b = _trailing_14d_median(daily, date.fromisoformat(d.date))
        if not math.isnan(b):
            baselines.append(abs(b - d.actual))
    if baselines:
        baseline_mae = float(np.mean(baselines))
        beats_baseline = max(0.0, (baseline_mae - fitted_only_mae) / baseline_mae) if baseline_mae > 1e-9 else 0.0
    else:
        beats_baseline = None
    summary = (
        f"{layer} walk-forward MAE over the last {weeks} weeks: "
        f"{fitted_only_mae:.1f} min ({fitted_only_mae_ratio * 100:.1f}% of mean actual) "
        f"on {days_fitted} fitted days "
        f"({days_cold} cold-start days excluded from headline)."
    )
    return BacktestResult(
        property_id=property_id, layer=layer, weeks=weeks, run_date=run_date,
        all_days_mae=all_days_mae,
        fitted_only_mae=fitted_only_mae, fitted_only_mae_ratio=fitted_only_mae_ratio,
        quantile_coverage_80=coverage_80,
        beats_baseline_pct=beats_baseline,
        days_total=days_total, days_fitted=days_fitted,
        days_cold_start=days_cold, days_insufficient_data=days_insuf,
        refusal_reason=None,
        summary=summary,
        daily=[asdict(d) for d in daily],
    )


# ─── Output ───────────────────────────────────────────────────────────────

def _print_markdown_summary(result: BacktestResult) -> None:
    """Print a markdown table to stdout — easy to paste into a PR or doc."""
    print(f"## Walk-forward backtest — {result.layer} — property {result.property_id}")
    print(f"_Run date: {result.run_date}; window: last {result.weeks} weeks_\n")
    print("| Metric | Value |")
    print("| --- | --- |")
    if result.refusal_reason:
        print(f"| Headline | **{result.refusal_reason}** |")
    else:
        print(f"| Fitted-only MAE | **{result.fitted_only_mae:.1f} min** |")
        print(f"| MAE / mean actual | {result.fitted_only_mae_ratio * 100:.1f}% |")
        if result.beats_baseline_pct is not None:
            print(f"| Beats trailing-14d-median baseline | {result.beats_baseline_pct * 100:.1f}% |")
    if result.all_days_mae is not None:
        print(f"| All-days MAE (incl. cold-start) | {result.all_days_mae:.1f} min |")
    print(f"| Days total / fitted / cold-start | {result.days_total} / {result.days_fitted} / {result.days_cold_start} |")
    print(f"\n_{result.summary}_")


def _write_artifact(
    client: ReadOnlySupabaseClient,
    result: BacktestResult,
    dry_run: bool,
    out_path: Optional[str],
) -> Dict[str, Any]:
    body = json.dumps(asdict(result), indent=2, default=str).encode("utf-8")
    if out_path:
        # File-system fallback for offline runs / unit tests.
        with open(out_path, "wb") as f:
            f.write(body)
        return {"ok": True, "path": out_path, "bytes": len(body), "kind": "filesystem"}
    if dry_run:
        return {"ok": True, "skipped": "dry-run", "bytes": len(body)}
    storage_path = (
        f"backtest_results/{result.property_id}/{result.layer}/{result.run_date}.json"
    )
    return {**client.allow_storage_upload("ml-models", storage_path, body), "kind": "storage"}


# ─── CLI ──────────────────────────────────────────────────────────────────

def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="backtest_housekeeping",
        description="Read-only walk-forward backtest for housekeeping ML.",
    )
    p.add_argument("--property-id", required=True, help="Property UUID")
    p.add_argument("--layer", required=True, choices=("demand", "supply"))
    p.add_argument("--weeks", type=int, default=8,
                   help="Window length in weeks (default 8)")
    p.add_argument("--dry-run", action="store_true",
                   help="Print + return without writing the storage artifact")
    p.add_argument("--out", default=None,
                   help="Optional local filesystem path for the JSON artifact "
                        "(skips Supabase Storage). Useful for offline runs.")
    return p


def run_backtest(
    property_id: str,
    layer: str,
    weeks: int,
    dry_run: bool = False,
    out_path: Optional[str] = None,
    *,
    client: Optional[ReadOnlySupabaseClient] = None,
) -> BacktestResult:
    """Entry point that the script + tests both call. Tests pass a
    pre-wrapped `ReadOnlySupabaseClient` so the proxy enforcement is
    asserted at the unit-test layer.
    """
    try:
        uuid.UUID(str(property_id))
    except (ValueError, TypeError, AttributeError):
        raise SystemExit(f"property-id must be a valid UUID; got {property_id!r}")
    if layer not in ("demand", "supply"):
        raise SystemExit(f"layer must be 'demand' or 'supply'; got {layer!r}")
    if weeks < 1 or weeks > 52:
        raise SystemExit(f"weeks must be 1..52; got {weeks}")
    settings = get_settings()
    if client is None:
        client = ReadOnlySupabaseClient(get_supabase_client())
    if layer == "demand":
        df = _fetch_demand_rows(client, property_id)
        daily = _backtest_demand(df, client, property_id, weeks, settings)
    else:
        df = _fetch_supply_rows(client, property_id)
        daily = _backtest_supply(df, client, property_id, weeks, settings)
    result = _aggregate(property_id, layer, weeks, daily)
    _print_markdown_summary(result)
    write_status = _write_artifact(client, result, dry_run, out_path)
    # Emit a structured log line so cron operators can grep for this.
    print(json.dumps({
        "evt": "backtest_complete",
        "property_id": property_id,
        "layer": layer,
        "weeks": weeks,
        "refusal_reason": result.refusal_reason,
        "fitted_only_mae": result.fitted_only_mae,
        "days_fitted": result.days_fitted,
        "write_status": write_status,
    }))
    return result


def main(argv: Optional[List[str]] = None) -> int:
    args = _build_parser().parse_args(argv)
    run_backtest(
        property_id=args.property_id,
        layer=args.layer,
        weeks=args.weeks,
        dry_run=args.dry_run,
        out_path=args.out,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
