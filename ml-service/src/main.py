"""FastAPI application for ML Service."""
import json
import os
import uuid as _uuid
from datetime import date as DateType  # alias to avoid shadowing the Pydantic field name `date`
from typing import Optional
from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException, status, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, field_validator

# Plan v2 Phase 2 — fleet-wide rate limit. Without this a leaked
# bearer token (or a misfiring cron) can hammer /predict and /train
# endpoints unbounded and rack up Railway CPU. 60 req/min/IP is plenty
# for the cron-driven workload (a few per-property calls per day) and
# tight enough to bound an abuse scenario.
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from slowapi.middleware import SlowAPIMiddleware


def _client_ip_for_rate_limit(request: Request) -> str:
    """Resolve the real client IP for slowapi keying behind Railway's LB.

    Tightened 2026-05-21 (Codex post-shipment review, finding A4): the
    original `key_func=get_remote_address` reads `request.client.host`,
    which behind Railway's load balancer is the LB IP — so every caller
    from anywhere ended up sharing one 60/min bucket. Now read the FIRST
    IP from `X-Forwarded-For`, which Railway sets to the originating
    client. Fall back to `request.client.host` for direct connections
    (e.g. local dev) and a literal "unknown" sentinel for the spoofed-
    empty-headers case so unknown callers share one bucket.

    Safe ONLY because Railway terminates the LB and rewrites XFF before
    forwarding; if we ever move to a setup with arbitrary proxy layers
    in front, we must revisit (allow N hops, trust only the rightmost
    proxy, etc.).
    """
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        first = xff.split(",")[0].strip()
        if first:
            return first
    direct = get_remote_address(request)
    return direct or "unknown"


limiter = Limiter(key_func=_client_ip_for_rate_limit, default_limits=["60/minute"])

# Plan v2 F-AI-4: hard ceiling on `max_rows` so a bearer-token holder
# (or a misfiring cron) can't cause Railway to pull arbitrarily large
# dataframes into memory. The cap lives in env so per-property
# back-fills (5+ years of history) can override without code change.
MAX_ROWS_CAP = int(os.environ.get("ML_MAX_ROWS_CAP", "200000"))

from src.auth import verify_bearer_token
from src.config import get_settings
from src.health import router as health_router
from src.log_scrub import scrub_string
from src.sentry_init import init_sentry, is_initialized as sentry_is_initialized

# Initialize Sentry at module load (idempotent, no-op without SENTRY_DSN).
# Wrapped so any SDK import/init failure NEVER prevents ml-service from
# booting — a crash-looping Python service is worse than one without
# monitoring. init_sentry() also swallows its own errors internally,
# but the outer try is defense in depth.
try:
    init_sentry()
except Exception as _sentry_init_exc:  # pragma: no cover
    print(
        json.dumps({"evt": "ml_service_sentry_init_failed", "exception": str(_sentry_init_exc)[:500]}),
        flush=True,
    )

from src.inference.demand import predict_demand
from src.inference.inventory_rate import predict_inventory_rates
from src.inference.supply import predict_supply
from src.optimizer.monte_carlo import optimize_headcount
from src.training.demand import train_demand_model
from src.training.inventory_priors import aggregate_inventory_priors
from src.training.demand_supply_priors import (
    aggregate_demand_priors,
    aggregate_supply_priors,
)
from src.training.inventory_rate import train_inventory_rate_model
from src.training.supply import train_supply_model
from src.eval.inventory_backtest import run_inventory_backtest
# Phase 7 v2 (2026-05-22) — statistical auto-rollback orchestrator.
# Imported here so the new POST /monitor/run-daily-rollback-pipeline
# endpoint below can call it. The module composes
# ml-service/src/actuals.py (backfill) + ml-service/src/monitoring/
# {shadow_mae,fleet_rollback}.py (decide + execute).
from src.monitoring.fleet_rollback import run_daily_rollback_pipeline


def _validate_uuid_str(value: str) -> str:
    """Pydantic v2 validator: ensure property_id is a real UUID before it
    reaches code that interpolates it into raw SQL. The interior modules also
    validate, but stopping a bad value at the API boundary keeps stack traces
    short and prevents log noise from invalid-by-typo requests.
    """
    try:
        UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        raise ValueError("property_id must be a valid UUID")
    return str(value)


def _clamp_max_rows(value: Optional[int]) -> Optional[int]:
    """Plan v2 F-AI-4 — clamp max_rows at the API boundary.

    Bearer-token holders or misfiring crons used to be able to send
    max_rows=10_000_000 and force Railway to materialize the entire result
    set in pandas. Now requests beyond MAX_ROWS_CAP are refused with 422.
    None / 0 stay as "no cap" (the training code reads all rows in that
    case, but the DB-level statement_timeout still bounds the work).
    """
    if value is None or value == 0:
        return value
    if value < 0:
        raise ValueError("max_rows must be non-negative")
    if value > MAX_ROWS_CAP:
        raise ValueError(f"max_rows must be ≤ {MAX_ROWS_CAP}")
    return value


# Request/Response models
class TrainDemandRequest(BaseModel):
    """Request to train demand model."""

    property_id: str
    max_rows: Optional[int] = None

    @field_validator("property_id")
    @classmethod
    def _check_uuid(cls, v: str) -> str:
        return _validate_uuid_str(v)

    @field_validator("max_rows")
    @classmethod
    def _check_max_rows(cls, v: Optional[int]) -> Optional[int]:
        return _clamp_max_rows(v)


class TrainDemandResponse(BaseModel):
    """Response from demand training."""

    model_run_id: Optional[str] = None
    is_active: bool
    training_mae: Optional[float] = None
    validation_mae: Optional[float] = None
    baseline_mae: Optional[float] = None
    beats_baseline_pct: Optional[float] = None
    training_row_count: Optional[int] = None
    error: Optional[str] = None


class TrainSupplyRequest(BaseModel):
    """Request to train supply model."""

    property_id: str
    max_rows: Optional[int] = None

    @field_validator("property_id")
    @classmethod
    def _check_uuid(cls, v: str) -> str:
        return _validate_uuid_str(v)

    @field_validator("max_rows")
    @classmethod
    def _check_max_rows(cls, v: Optional[int]) -> Optional[int]:
        return _clamp_max_rows(v)


class TrainSupplyResponse(BaseModel):
    """Response from supply training."""

    model_run_id: Optional[str] = None
    is_active: bool
    training_mae: Optional[float] = None
    validation_mae: Optional[float] = None
    beats_baseline_pct: Optional[float] = None
    training_row_count: Optional[int] = None
    error: Optional[str] = None


class PredictDemandRequest(BaseModel):
    """Request demand prediction."""

    property_id: str
    date: Optional[DateType] = None
    # IANA timezone for the property (e.g. "America/New_York"). REQUIRED
    # when `date` is omitted (the inference function uses it to compute
    # the property-local "tomorrow"). Phase 3.5 (2026-05-13): the
    # America/Chicago fallback was removed; missing timezone is now a
    # PropertyMisconfiguredError that the cron treats as a skipped property.
    property_timezone: Optional[str] = None

    @field_validator("property_id")
    @classmethod
    def _check_uuid(cls, v: str) -> str:
        return _validate_uuid_str(v)


class PredictDemandResponse(BaseModel):
    """Demand prediction response."""

    property_id: str
    date: str
    predicted_minutes_p50: Optional[float] = None
    predicted_minutes_p95: Optional[float] = None
    predicted_headcount_p50: Optional[float] = None
    predicted_headcount_p95: Optional[float] = None
    model_version: Optional[str] = None
    # Honesty fields: callers can distinguish a fitted-from-this-hotel
    # Bayesian/XGBoost prediction from a cohort-prior cold-start prediction
    # without an extra model_runs join.
    algorithm: Optional[str] = None
    is_cold_start: Optional[bool] = None
    error: Optional[str] = None


class PredictSupplyRequest(BaseModel):
    """Request supply prediction."""

    property_id: str
    date: Optional[DateType] = None
    property_timezone: Optional[str] = None  # see PredictDemandRequest

    @field_validator("property_id")
    @classmethod
    def _check_uuid(cls, v: str) -> str:
        return _validate_uuid_str(v)


class PredictSupplyResponse(BaseModel):
    """Supply prediction response."""

    property_id: str
    date: str
    predicted_rooms: Optional[int] = None
    model_version: Optional[str] = None
    # Honesty fields — see PredictDemandResponse.
    algorithm: Optional[str] = None
    is_cold_start: Optional[bool] = None
    error: Optional[str] = None


class OptimizeRequest(BaseModel):
    """Request headcount optimization."""

    property_id: str
    date: Optional[DateType] = None
    property_timezone: Optional[str] = None  # see PredictDemandRequest

    @field_validator("property_id")
    @classmethod
    def _check_uuid(cls, v: str) -> str:
        return _validate_uuid_str(v)


class OptimizeResponse(BaseModel):
    """Optimization response."""

    property_id: str
    date: str
    recommended_headcount: Optional[int] = None
    achieved_completion_probability: Optional[float] = None
    completion_probability_curve: Optional[list] = None
    # Honesty fields: callers (cron, cockpit, Schedule tab) can tell a fully
    # fitted optimizer recommendation apart from one whose backing layers
    # were cold-start, OR one that fell through to the L1-only path because
    # fewer than 10 supply predictions were available for the date.
    l1_is_cold_start: Optional[bool] = None
    l2_any_cold_start: Optional[bool] = None
    used_l2_supply: Optional[bool] = None
    l2_prediction_count: Optional[int] = None
    error: Optional[str] = None


class TrainInventoryRateRequest(BaseModel):
    """Request to train inventory_rate models for a property.

    item_id is optional — when omitted, trains every item in the property.
    The cockpit's "Retrain this item" button passes a specific item_id.
    """

    property_id: str
    item_id: Optional[str] = None
    # Plan v2.1 MP-2 — symmetric with TrainDemandRequest / TrainSupplyRequest.
    # Inventory training doesn't read max_rows today, but adding the
    # field-validator now keeps the guard-by-default invariant
    # consistent: a future change that wires max_rows into the
    # inventory path cannot accidentally ship unbounded.
    max_rows: Optional[int] = None

    @field_validator("property_id")
    @classmethod
    def _check_pid(cls, v: str) -> str:
        return _validate_uuid_str(v)

    @field_validator("item_id")
    @classmethod
    def _check_iid(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        return _validate_uuid_str(v)

    @field_validator("max_rows")
    @classmethod
    def _check_max_rows(cls, v: Optional[int]) -> Optional[int]:
        return _clamp_max_rows(v)


class TrainInventoryRateResponse(BaseModel):
    """Response for inventory_rate training run.

    Returns aggregate counts across all items trained in this run.
    """

    items_trained: int = 0
    items_skipped_insufficient_data: int = 0
    items_with_active_model: int = 0
    items_with_auto_fill: int = 0
    errors: list = []
    error: Optional[str] = None


class PredictInventoryRateRequest(BaseModel):
    """Request to generate inventory_rate predictions for a property."""

    property_id: str
    date: Optional[DateType] = None  # The operational date predictions are FOR. Default = tomorrow.
    property_timezone: Optional[str] = None  # see PredictDemandRequest

    @field_validator("property_id")
    @classmethod
    def _check_pid(cls, v: str) -> str:
        return _validate_uuid_str(v)


class PredictInventoryRateResponse(BaseModel):
    """Response for inventory_rate prediction run."""

    predicted: int = 0
    skipped_no_active_model: int = 0
    errors: list = []
    target_date: Optional[str] = None
    error: Optional[str] = None
    note: Optional[str] = None


class InventoryBacktestRequest(BaseModel):
    """Request to run a realized-MAE backtest for the inventory layer.

    Honesty-audit Phase 3 (2026-05-22). Read-only — never writes to
    model_runs or inventory_rate_predictions.
    """

    property_id: str
    # Window in days; clamped server-side to [1, 180]. Defaults to 30 days
    # for the typical "how's the model doing recently?" question.
    window_days: Optional[int] = 30

    @field_validator("property_id")
    @classmethod
    def _check_pid(cls, v: str) -> str:
        return _validate_uuid_str(v)


class InventoryBacktestPerItemRow(BaseModel):
    item_id: str
    n_pairs: int
    realized_mae: float
    training_mae: Optional[float] = None
    validation_mae: Optional[float] = None
    drift_ratio: Optional[float] = None


class InventoryBacktestStaleRow(BaseModel):
    item_id: str
    model_run_id: str
    realized_mae: float
    validation_mae: Optional[float] = None
    ratio: float


class InventoryBacktestResponse(BaseModel):
    """Realized-MAE rollup over the prediction_log window. Read-only."""

    property_id: str
    window_days: int = 30
    n_pairs: int = 0
    per_item: list = []
    stale_active_models: list = []
    error: Optional[str] = None


class AggregatePriorsResponse(BaseModel):
    """Response for cohort prior aggregation.

    Phase M3 (2026-05-14): widened with optional fields so the demand +
    supply aggregators can reuse this model. They return hotels_seen +
    skipped_low_n (which inventory doesn't), and don't return
    items_canonical (which only inventory does).
    """

    cohorts_updated: int = 0
    items_canonical: int = 0
    hotels_seen: int = 0
    skipped_low_n: int = 0
    errors: list = []
    note: Optional[str] = None


# FastAPI app
app = FastAPI(
    title="Staxis ML Service",
    description="Housekeeping demand/supply prediction and optimization",
    version="0.1.0",
)

# Wire up slowapi. `app.state.limiter` is read by the SlowAPIMiddleware
# at request time; the exception handler converts a RateLimitExceeded
# raise into a clean 429 response with Retry-After. Default limit is
# 60/minute/IP from the `default_limits` arg above.
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)


# Plan v2 F-AI-4: refuse oversized bodies BEFORE FastAPI tries to parse
# them. ML endpoints all carry tiny JSON bodies (a UUID + a date string);
# 64 KB is far above anything legitimate and cuts off the obvious DoS
# vector of POSTing a giant payload.
_MAX_BODY_BYTES = int(os.environ.get("ML_MAX_BODY_BYTES", str(64 * 1024)))


@app.middleware("http")
async def body_size_limit(request: Request, call_next):
    """Refuse any request whose Content-Length exceeds the body cap."""
    cl = request.headers.get("content-length")
    if cl is not None:
        try:
            if int(cl) > _MAX_BODY_BYTES:
                return JSONResponse(
                    status_code=413,
                    content={
                        "error": "request_body_too_large",
                        "max_bytes": _MAX_BODY_BYTES,
                    },
                )
        except ValueError:
            return JSONResponse(
                status_code=400,
                content={"error": "invalid_content_length"},
            )
    return await call_next(request)


# Include health check router (no auth)
app.include_router(health_router)


# Training endpoints

@app.post(
    "/train/demand",
    response_model=TrainDemandResponse,
    tags=["training"],
    summary="Train Layer 1 demand model",
)
async def train_demand_endpoint(
    request: TrainDemandRequest,
    token: str = Depends(verify_bearer_token),
) -> JSONResponse:
    """Train demand model for a property.

    Requires bearer token authentication. Plan v2 F-AI-4: uses a
    nonblocking advisory lock so concurrent calls return 409
    `already_running` instead of stacking blocked DB connections.
    """
    result = await train_demand_model(
        property_id=request.property_id,
        max_rows=request.max_rows,
        blocking_lock=False,
    )
    if result.get("status") == "already_running":
        return JSONResponse(status_code=409, content=result)
    return JSONResponse(status_code=200, content=TrainDemandResponse(**result).model_dump())


@app.post(
    "/train/supply",
    response_model=TrainSupplyResponse,
    tags=["training"],
    summary="Train Layer 2 supply model",
)
async def train_supply_endpoint(
    request: TrainSupplyRequest,
    token: str = Depends(verify_bearer_token),
) -> JSONResponse:
    """Train supply model for a property.

    Requires bearer token authentication. Plan v2 F-AI-4: nonblocking
    advisory lock → 409 on contention.
    """
    result = await train_supply_model(
        property_id=request.property_id,
        max_rows=request.max_rows,
        blocking_lock=False,
    )
    if result.get("status") == "already_running":
        return JSONResponse(status_code=409, content=result)
    return JSONResponse(status_code=200, content=TrainSupplyResponse(**result).model_dump())


# Inference endpoints

@app.post(
    "/predict/demand",
    response_model=PredictDemandResponse,
    tags=["inference"],
    summary="Predict demand (Layer 1)",
)
async def predict_demand_endpoint(
    request: PredictDemandRequest,
    token: str = Depends(verify_bearer_token),
) -> PredictDemandResponse:
    """Predict total workload for a property.

    Requires bearer token authentication.
    """
    result = await predict_demand(
        property_id=request.property_id,
        prediction_date=request.date,
        property_timezone=request.property_timezone,
    )
    return PredictDemandResponse(**result)


@app.post(
    "/predict/supply",
    response_model=PredictSupplyResponse,
    tags=["inference"],
    summary="Predict supply (Layer 2)",
)
async def predict_supply_endpoint(
    request: PredictSupplyRequest,
    token: str = Depends(verify_bearer_token),
) -> PredictSupplyResponse:
    """Predict per-room × per-housekeeper cleaning times.

    Requires bearer token authentication.
    """
    result = await predict_supply(
        property_id=request.property_id,
        prediction_date=request.date,
        property_timezone=request.property_timezone,
    )
    return PredictSupplyResponse(**result)


# Optimizer endpoint

@app.post(
    "/predict/optimizer",
    response_model=OptimizeResponse,
    tags=["optimizer"],
    summary="Optimize headcount (Layer 3)",
)
async def optimize_endpoint(
    request: OptimizeRequest,
    token: str = Depends(verify_bearer_token),
) -> OptimizeResponse:
    """Recommend optimal headcount via Monte Carlo.

    Requires bearer token authentication.
    """
    result = await optimize_headcount(
        property_id=request.property_id,
        prediction_date=request.date,
        property_timezone=request.property_timezone,
    )
    return OptimizeResponse(**result)


# Inventory-rate endpoints (per-item Bayesian / XGBoost)

@app.post(
    "/train/inventory-rate",
    response_model=TrainInventoryRateResponse,
    tags=["training"],
    summary="Train inventory_rate models (per item)",
)
async def train_inventory_rate_endpoint(
    request: TrainInventoryRateRequest,
    token: str = Depends(verify_bearer_token),
) -> JSONResponse:
    """Train per-(property × item) inventory rate models.

    When item_id is provided, retrains just that item. Otherwise iterates
    every inventory.id in the property and trains one model per item that
    has ≥3 count events.

    Requires bearer token authentication. Plan v2 F-AI-4: nonblocking
    advisory lock → 409 on contention.
    """
    result = await train_inventory_rate_model(
        property_id=request.property_id,
        item_id=request.item_id,
        blocking_lock=False,
    )
    if result.get("status") == "already_running":
        return JSONResponse(status_code=409, content=result)
    return JSONResponse(status_code=200, content=TrainInventoryRateResponse(**result).model_dump())


@app.post(
    "/train/inventory-priors",
    response_model=AggregatePriorsResponse,
    tags=["training"],
    summary="Aggregate cross-hotel cohort priors",
)
async def train_inventory_priors_endpoint(
    token: str = Depends(verify_bearer_token),
) -> AggregatePriorsResponse:
    """Recompute cohort + global inventory_rate_priors from network data.

    No body — operates across all properties. Idempotent: each run replaces
    every (cohort_key, item_canonical_name) row. Industry-benchmark seeds
    from migration 0062 are NOT overwritten because they live under
    cohort_key='global' with source='industry-benchmark', and this endpoint
    only writes rows with source='cohort-aggregate' for cohorts that have
    actual data. Cohorts with no aggregated data don't touch the seeds.

    Requires bearer token authentication.
    """
    result = await aggregate_inventory_priors()
    return AggregatePriorsResponse(**result)


@app.post(
    "/train/demand-priors",
    response_model=AggregatePriorsResponse,
    tags=["training"],
    summary="Aggregate cross-hotel demand cohort priors (Phase M3)",
)
async def train_demand_priors_endpoint(
    token: str = Depends(verify_bearer_token),
) -> AggregatePriorsResponse:
    """Recompute demand_priors from network data.

    Reads cleaning_minutes_per_day_view for the last 90 days, normalizes
    each property's daily total to per-room (so hotels of different sizes
    are comparable), takes per-property median, then per-cohort median.

    Cohort key construction matches inventory_priors:
      ['global', '<brand-region-size_tier>'] when all 3 fields populated.

    'global' cohort needs 5+ hotels before overriding the
    industry-benchmark seed in demand_priors. Specific cohorts always
    upsert (they only exist when there's real cohort data).

    Idempotent — each run replaces every cohort row with source='cohort-aggregate'.
    Industry-benchmark seeds (source='industry-benchmark') are NOT touched.

    Requires bearer token authentication.
    """
    result = await aggregate_demand_priors()
    return AggregatePriorsResponse(**result)


@app.post(
    "/train/supply-priors",
    response_model=AggregatePriorsResponse,
    tags=["training"],
    summary="Aggregate cross-hotel supply cohort priors (Phase M3)",
)
async def train_supply_priors_endpoint(
    token: str = Depends(verify_bearer_token),
) -> AggregatePriorsResponse:
    """Recompute supply_priors from network data.

    Reads cleaning_events.duration_minutes for the last 90 days
    (status='recorded' only — flagged events are operator-marked outliers
    that would skew the median). Per-property median, then per-cohort.

    Same cohort key construction + skip-low-n logic as demand-priors above.

    Idempotent — each run replaces every cohort row with source='cohort-aggregate'.
    Industry-benchmark seeds (source='industry-benchmark') are NOT touched.

    Requires bearer token authentication.
    """
    result = await aggregate_supply_priors()
    return AggregatePriorsResponse(**result)


@app.post(
    "/predict/inventory-rate",
    response_model=PredictInventoryRateResponse,
    tags=["inference"],
    summary="Predict inventory daily rates (per item)",
)
async def predict_inventory_rate_endpoint(
    request: PredictInventoryRateRequest,
    token: str = Depends(verify_bearer_token),
) -> PredictInventoryRateResponse:
    """Generate inventory_rate predictions for tomorrow (or a specified date).

    Iterates every active model_runs row of layer='inventory_rate' for the
    property, predicts daily_rate via the cached posterior, computes
    predicted_current_stock for Count Mode auto-fill, and writes one row
    per item to inventory_rate_predictions.

    Requires bearer token authentication.
    """
    result = await predict_inventory_rates(
        property_id=request.property_id,
        target_date=request.date,
        property_timezone=request.property_timezone,
    )
    return PredictInventoryRateResponse(**result)


@app.post(
    "/eval/inventory-backtest",
    response_model=InventoryBacktestResponse,
    tags=["evaluation"],
    summary="Realized-MAE backtest from prediction_log (read-only, admin)",
)
async def inventory_backtest_endpoint(
    request: InventoryBacktestRequest,
    token: str = Depends(verify_bearer_token),
) -> InventoryBacktestResponse:
    """Compute realized-MAE rollups for the inventory layer.

    Honesty-audit Phase 3 (2026-05-22). Reads prediction_log rows for the
    given property + window, joins to model_runs (single batched
    `.in_('id', ...)` round-trip — no N+1), and returns per-item realized
    MAE plus a list of active model_runs whose realized error has drifted
    beyond 1.5× their training-time validation_mae.

    PURE READ. Never writes to model_runs or inventory_rate_predictions.
    The caller decides what to do with the stale-models flag — no
    auto-rollback. Bearer-authenticated, no TS proxy: admin-only via
    curl with ML_SERVICE_SECRET.

    Window clamped server-side to [1, 180] days. Default 30.
    """
    result = run_inventory_backtest(
        property_id=request.property_id,
        window_days=request.window_days or 30,
    )
    return InventoryBacktestResponse(**result)


# Error handlers
#
# Round 16 (2026-05-15): these handlers used to return a raw dict, which
# is NOT a valid ASGI response. Starlette's ServerErrorMiddleware then
# tried to call the dict as an ASGI app and crashed with
#   TypeError: 'dict' object is not callable
# That secondary error replaced the original exception in the logs and
# made every 5xx in the ML service unreadable. It also made the cron's
# /api/cron/ml-run-inference look like a Vercel 502 (the ML service was
# returning a broken response body that the TS route couldn't parse).
# FastAPI exception handlers MUST return a Response — wrap the dict.

# Phase 7 v2 (2026-05-22) — auto-rollback orchestration endpoint.
#
# Single endpoint that runs the full daily pipeline: prediction_log
# backfill → per-(property, layer) Wilcoxon → cooldown filter →
# BH-FDR fleet-wide → execute (or dry-run-log) rollbacks. The TS
# cron route /api/cron/ml-auto-rollback hits this once per day at
# 06:45 CDT. Bearer-gated like the other /train and /predict routes.

class FleetRollbackRequest(BaseModel):
    """Request for the daily rollback pipeline.

    `property_ids` is optional — None means "all properties with at
    least one active fitted (non-cold-start) housekeeping model".
    Tests + manual triggers can scope down.
    """

    property_ids: Optional[list] = None


class FleetRollbackResponse(BaseModel):
    """Response for the daily rollback pipeline.

    Mirrors what `run_daily_rollback_pipeline` returns. The TS cron
    route iterates `results` to write per-property app_events rows.
    Permissive shape (Dict-of-anything) so future additions to the
    orchestrator don't require a Pydantic-schema bump at every cron.
    """

    phase_backfill: Optional[dict] = None
    phase_check: Optional[dict] = None
    rollbacks_fired: int = 0
    dry_run_would_fire: int = 0
    execute_failures: list = []
    dry_run: bool = True
    alpha: Optional[float] = None
    results: list = []
    error: Optional[str] = None


@app.post(
    "/monitor/run-daily-rollback-pipeline",
    response_model=FleetRollbackResponse,
    tags=["monitoring"],
    summary="Daily auto-rollback orchestrator (Phase 7 v2)",
)
async def run_daily_rollback_pipeline_endpoint(
    request: FleetRollbackRequest,
    token: str = Depends(verify_bearer_token),
) -> FleetRollbackResponse:
    """Run the full daily rollback pipeline.

    Pipeline (see fleet_rollback.run_daily_rollback_pipeline for the
    implementation):
      1. Backfill prediction_log over the 3-day rolling correction
         window using UPSERT against the natural key from migration
         0156. Uses cleaning_minutes_per_day_view.total_approved_minutes
         (NOT recorded) so Maria's flag/discard corrections propagate.
      2. For each (property, layer) with an active fitted model and
         n>=21 mature paired observations, run the paired Wilcoxon
         signed-rank test (active model vs same-DOW historical actual).
      3. Skip pairs that rolled back within the last 14 days
         (cooldown — prevents oscillation).
      4. Apply Benjamini-Hochberg false-discovery correction fleet-wide
         at settings.auto_rollback_fdr_alpha.
      5. For each surviving rejection: call execute_rollback in either
         dry-run mode (default — logs only, no model_runs touched) or
         live mode (deactivates the active fitted model; property
         falls through to cold-start cohort prior until next training).

    Bearer-gated. Body-size capped by the global middleware.
    """
    result = await run_daily_rollback_pipeline(
        property_ids=request.property_ids,
    )
    return FleetRollbackResponse(**result)


@app.exception_handler(HTTPException)
async def http_exception_handler(request, exc):
    """Handle HTTP exceptions — return JSON with the proper status code."""
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error": exc.detail,
            "status_code": exc.status_code,
        },
    )


@app.exception_handler(Exception)
async def general_exception_handler(request: Request, exc: Exception):
    """Handle unexpected exceptions — return 500 JSON with a sanitized body.

    Plan v2 F-AI-12: the previous version returned `str(exc)` to the
    caller, which would leak psycopg2 error text + partial PII on
    internal failures. The thrown exception details now go to stdout for
    the operator (Railway logs) and Sentry (when wired), and the
    response body is a generic error + correlation id the caller can
    match against the logs.

    Two PII-defense layers:
      1. str(exc) goes through scrub_string before being printed or
         shipped to Sentry — psycopg2 errors regularly include row
         values (e.g. a constraint violation embeds the offending row).
      2. sentry_sdk.init runs with include_local_variables=False and
         before_send=scrub_event so frame locals + the full event get
         redacted before transport.
    """
    incident_id = _uuid.uuid4().hex
    # Scrub before BOTH print and Sentry capture — same string lands in
    # Railway logs and (eventually) the Sentry message text, so a single
    # scrub here covers both downstream surfaces.
    message_scrubbed = scrub_string(str(exc))[:2000]
    path = str(request.url.path)

    # Logged to stdout — Railway's log aggregator + grep-by-incident_id.
    print(json.dumps({
        "evt": "ml_service_unhandled_exception",
        "incident_id": incident_id,
        "path": path,
        "exception": type(exc).__name__,
        "message": message_scrubbed,
    }), flush=True)

    # Sentry capture is best-effort. The SDK's transport is async, so a
    # network hiccup here can't block the response. Tag with endpoint +
    # incident_id so the Sentry event correlates to the Railway log line.
    if sentry_is_initialized():
        try:
            import sentry_sdk  # type: ignore
            with sentry_sdk.push_scope() as scope:
                scope.set_tag("endpoint", path)
                scope.set_tag("incident_id", incident_id)
                sentry_sdk.capture_exception(exc)
        except Exception:
            # Never let Sentry capture failures bubble — they'd replace
            # the original 500 response with a 5xx that has no
            # incident_id, breaking the correlate-by-id contract above.
            pass

    return JSONResponse(
        status_code=500,
        content={
            "error": "internal_error",
            "incident_id": incident_id,
            "status_code": 500,
        },
    )
