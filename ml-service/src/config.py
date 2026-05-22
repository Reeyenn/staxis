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

    # Sentry DSN for error monitoring. When unset, sentry_init.init_sentry()
    # no-ops and ml-service continues with Railway-logs-only visibility (the
    # pre-monitoring baseline). Set to "" (empty string) on Railway to kill-
    # switch monitoring without a code change.
    sentry_dsn: Optional[str] = None

    # Model training thresholds
    training_row_count_min: int = 200
    training_row_count_activation: int = 500
    # DEPRECATED — kept for one release for backward-compat. Phase 3.2
    # (2026-05-13) replaced the absolute-minutes gate with a size-relative
    # ratio (validation_mae_ratio_threshold) so the threshold scales with
    # property size: at 60 rooms 5min was sensible; at 200 rooms it was
    # 0.08% of mean prediction (implausible, model never activated).
    validation_mae_threshold: float = 5.0
    validation_mae_ratio_threshold: float = 0.10  # validation_mae / mean_predicted must be below this
    validation_mae_floor: float = 1.0             # absolute floor so trivial demands don't auto-activate
    baseline_beat_pct_threshold: float = 0.20
    consecutive_passing_runs_required: int = 2

    # Phase M3.4 (2026-05-14) — minimum hours between two model_runs that
    # both count toward the consecutive-passes activation streak.
    # Codex adversarial finding #1: pre-M3.4 the streak counted ANY 5 prior
    # runs by metric value alone, so 5 retries on identical data minutes
    # apart looked like 5 weekly windows of stability. The weekly cron
    # fires every 168h; 24h is a comfortable lower bound that catches
    # rapid-fire manual retries while accommodating any reasonable
    # scheduled replay. Override in staging/dev tests via env var.
    min_hours_between_passing_runs: int = 24

    # Model architecture
    shift_cap_minutes: int = 420  # 7 hours
    target_completion_probability: float = 0.95
    monte_carlo_draws: int = 1000

    # Monitoring
    auto_rollback_window_days: int = 14
    auto_rollback_pvalue_threshold: float = 0.05
    disagreement_threshold_fallback: float = 0.30
    disagreement_zscore_threshold: float = 2.0

    # Phase 7 v2 (2026-05-22) — statistical auto-rollback for housekeeping
    # demand/supply. The default-true dry-run flag is the safety lever:
    # for the first 30 days, the cron runs backfill + check + BH-FDR
    # end-to-end but only LOGS "would-have-fired" — does NOT touch
    # model_runs. Operators audit the dry-run app_events rows to validate
    # the same-DOW comparator + n>=21 + BH-FDR combination produces ~0
    # false fires across the fleet. Flip to false via Railway env var
    # (get_settings() instantiates fresh per request so env-var changes
    # hot-reload without a redeploy).
    auto_rollback_dry_run: bool = True

    # Benjamini-Hochberg fleet-wide false-discovery rate. 0.05 means at
    # most 5% of fired rollbacks are expected to be spurious.
    auto_rollback_fdr_alpha: float = 0.05

    # Minimum MATURE paired observations before a rollback can fire for
    # a (property, layer). "Mature" = outside the actuals correction
    # window below. Independent of auto_rollback_window_days (lookback
    # range). Codex high-pri finding: n=10 at the 14-day boundary is
    # underpowered; 21 gives the Wilcoxon test real signal.
    auto_rollback_min_paired_days: int = 21

    # Cooldown after a rollback fires for (property, layer). Prevents
    # oscillation if the next-up active also drifts immediately.
    auto_rollback_cooldown_days: int = 14

    # Actuals correction window. prediction_log rows whose date is within
    # this many days of today are excluded from the rolling-MAE check
    # (because their actual_value may still flip when Maria reviews
    # cleaning_events). Also defines the backfill's UPSERT rolling window:
    # each morning's backfill UPSERTs prediction_log rows for today minus
    # 1..N days so corrections propagate.
    auto_rollback_actuals_correction_days: int = 3

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

    # Plan v2 F-AI-4 — API-boundary safety limits. Promoted from
    # os.environ.get(...) reads in main.py so the values flow through
    # Pydantic validation and are documented in .env.example.
    #
    # ml_max_body_bytes: 64 KiB. ML endpoints all carry tiny JSON
    # bodies (UUID + date string); 64 KB is far above anything
    # legitimate and cuts off the obvious DoS vector of POSTing a
    # giant payload. test_main_hardening.py sends an 80 KiB body
    # expecting a 413 — changing this default WILL break that test.
    # ml_max_rows_cap: 200,000. Hard ceiling on per-property training
    # row pulls so a bearer-token holder can't force Railway to
    # materialize arbitrarily large dataframes into memory.
    ml_max_rows_cap: int = 200_000
    ml_max_body_bytes: int = 64 * 1024

    @field_validator("ml_service_secret")
    @classmethod
    def validate_secret(cls, v: str) -> str:
        """Validate that ML_SERVICE_SECRET is set and at least 8 chars.

        Security review 2026-05-16 (Surface 5 P2 — Pattern C): the
        deployed-target is 32+ chars (CSPRNG-grade — see RUNBOOKS.md >
        ML_SERVICE_SECRET rotation). Enforced as a HARD FAIL at the
        doctor's `ml_service_secret_strength` check rather than here,
        so a short legacy value doesn't refuse-to-boot ml-service mid-
        rotation. After Reeyen rotates, tighten this floor to 32 to
        match.
        """
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
