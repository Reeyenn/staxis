"""Configuration management for ML Service."""
import os
from typing import Optional

from pydantic import field_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    supabase_url: str
    supabase_service_role_key: str
    ml_service_secret: str
    log_level: str = "INFO"

    # Direct Postgres connection string for psycopg2 (used by advisory locks
    # and the auto-rollback path). NOT the Supabase HTTPS URL — that's the
    # PostgREST gateway on 443. Codex adversarial review 2026-05-13 (M-C1):
    # shadow_mae.py was building a host string from supabase_url and
    # connecting to PostgREST as if it were Postgres, which always failed
    # silently and made auto-rollback dead code.
    database_url: Optional[str] = None

    # Model training thresholds
    training_row_count_min: int = 200
    training_row_count_activation: int = 500
    validation_mae_threshold: float = 5.0
    baseline_beat_pct_threshold: float = 0.20
    consecutive_passing_runs_required: int = 2

    # Model architecture
    shift_cap_minutes: int = 420  # 7 hours
    target_completion_probability: float = 0.95
    monte_carlo_draws: int = 1000

    # Monitoring
    auto_rollback_window_days: int = 14
    auto_rollback_pvalue_threshold: float = 0.05
    disagreement_threshold_fallback: float = 0.30
    disagreement_zscore_threshold: float = 2.0

    # Inventory rate model
    # Inventory has way less data per (property × item) than housekeeping has
    # per property — typically 12–50 count events per item per year vs ~365
    # operational days for housekeeping. So thresholds are an order of
    # magnitude lower across the board.
    inventory_min_events_per_item: int = 3              # Need at least 3 consecutive counts to fit anything
    inventory_xgboost_activation_events: int = 100      # Per-item event count above which XGBoost beats Bayesian
    inventory_graduation_min_events: int = 30           # Auto-fill graduation gate #1
    inventory_graduation_mae_ratio: float = 0.10        # Auto-fill graduation gate #2 (MAE/mean must be < this)
    inventory_graduation_consecutive_passes: int = 5    # Auto-fill graduation gate #3

    @field_validator("ml_service_secret")
    @classmethod
    def validate_secret(cls, v: str) -> str:
        """Validate that ML_SERVICE_SECRET is set and at least 8 chars."""
        if not v or len(v) < 8:
            raise ValueError("ML_SERVICE_SECRET must be set and at least 8 chars")
        return v

    @field_validator("database_url", mode="before")
    @classmethod
    def fallback_database_url(cls, v: Optional[str]) -> Optional[str]:
        """Allow either DATABASE_URL or SUPABASE_DB_URL env vars (the training
        modules already check both — keep that compatibility)."""
        if v:
            return v
        return os.environ.get("DATABASE_URL") or os.environ.get("SUPABASE_DB_URL")

    class Config:
        env_file = ".env"
        case_sensitive = False


def get_settings() -> Settings:
    """Load and validate settings."""
    return Settings()
