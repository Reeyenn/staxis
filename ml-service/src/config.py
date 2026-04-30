"""Configuration management for ML Service."""
from pydantic import field_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    supabase_url: str
    supabase_service_role_key: str
    ml_service_secret: str
    log_level: str = "INFO"

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

    @field_validator("ml_service_secret")
    @classmethod
    def validate_secret(cls, v: str) -> str:
        """Validate that ML_SERVICE_SECRET is set and at least 8 chars."""
        if not v or len(v) < 8:
            raise ValueError("ML_SERVICE_SECRET must be set and at least 8 chars")
        return v

    class Config:
        env_file = ".env"
        case_sensitive = False


def get_settings() -> Settings:
    """Load and validate settings."""
    return Settings()
