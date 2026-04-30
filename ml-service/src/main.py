"""FastAPI application for ML Service."""
import json
from datetime import date
from typing import Optional
from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException, status
from pydantic import BaseModel, field_validator

from src.auth import verify_bearer_token
from src.config import get_settings
from src.health import router as health_router
from src.inference.demand import predict_demand
from src.inference.supply import predict_supply
from src.optimizer.monte_carlo import optimize_headcount
from src.training.demand import train_demand_model
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
    date: Optional[date] = None

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
    date: Optional[date] = None

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
    date: Optional[date] = None

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
    )
    return OptimizeResponse(**result)


# Error handlers

@app.exception_handler(HTTPException)
async def http_exception_handler(request, exc):
    """Handle HTTP exceptions."""
    return {
        "error": exc.detail,
        "status_code": exc.status_code,
    }


@app.exception_handler(Exception)
async def general_exception_handler(request, exc):
    """Handle general exceptions."""
    return {
        "error": str(exc),
        "status_code": 500,
    }
