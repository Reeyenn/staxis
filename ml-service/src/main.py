"""FastAPI application for ML Service."""
import json
from datetime import date as DateType  # alias to avoid shadowing the Pydantic field name `date`
from typing import Optional
from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, field_validator

from src.auth import verify_bearer_token
from src.config import get_settings
from src.health import router as health_router
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


# Request/Response models
class TrainDemandRequest(BaseModel):
    """Request to train demand model."""

    property_id: str
    max_rows: Optional[int] = None

    @field_validator("property_id")
    @classmethod
    def _check_uuid(cls, v: str) -> str:
        return _validate_uuid_str(v)


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
    error: Optional[str] = None


class TrainInventoryRateRequest(BaseModel):
    """Request to train inventory_rate models for a property.

    item_id is optional — when omitted, trains every item in the property.
    The cockpit's "Retrain this item" button passes a specific item_id.
    """

    property_id: str
    item_id: Optional[str] = None

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
) -> TrainDemandResponse:
    """Train demand model for a property.

    Requires bearer token authentication.
    """
    result = await train_demand_model(
        property_id=request.property_id,
        max_rows=request.max_rows,
    )
    return TrainDemandResponse(**result)


@app.post(
    "/train/supply",
    response_model=TrainSupplyResponse,
    tags=["training"],
    summary="Train Layer 2 supply model",
)
async def train_supply_endpoint(
    request: TrainSupplyRequest,
    token: str = Depends(verify_bearer_token),
) -> TrainSupplyResponse:
    """Train supply model for a property.

    Requires bearer token authentication.
    """
    result = await train_supply_model(
        property_id=request.property_id,
        max_rows=request.max_rows,
    )
    return TrainSupplyResponse(**result)


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
) -> TrainInventoryRateResponse:
    """Train per-(property × item) inventory rate models.

    When item_id is provided, retrains just that item. Otherwise iterates
    every inventory.id in the property and trains one model per item that
    has ≥3 count events.

    Requires bearer token authentication.
    """
    result = await train_inventory_rate_model(
        property_id=request.property_id,
        item_id=request.item_id,
    )
    return TrainInventoryRateResponse(**result)


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
async def general_exception_handler(request, exc):
    """Handle unexpected exceptions — return 500 JSON, not a raw dict."""
    return JSONResponse(
        status_code=500,
        content={
            "error": str(exc),
            "status_code": 500,
        },
    )
