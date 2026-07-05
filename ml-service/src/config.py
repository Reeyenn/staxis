"""Configuration management for ML Service."""
import os
from typing import Optional

from pydantic import field_validator
from pydantic_settings import BaseSettings


# Reference occupancy (percentage points) that the inventory_rate model
# centers its occupancy feature on. The Bayesian model learns
# ``daily_rate = intercept + slope·(occupancy_pct − baseline)``; centering the
# feature (rather than feeding raw 0-100 occupancy, which is never near 0)
# decouples the intercept from the slope so the slope is estimable from the
# handful of windows a real hotel produces. The intercept then means "expected
# daily consumption at baseline occupancy", which is exactly what the per-room
# cohort prior encodes — so the prior seeds the intercept correctly. Training
# (training/inventory_rate.py) and serving (inference/inventory_rate.py) MUST
# use this same constant or train/serve will skew. 60% is a representative
# limited-service occupancy. Changing it requires a full retrain.
INVENTORY_OCC_BASELINE_PCT: float = 60.0

# Feature-set version stamped on every inventory_rate model_run and checked at
# serve time. A posterior is only served when its feature_set_version matches the
# value below for its FAMILY; a stale model is skipped (and retrained) rather than
# served wrong. Bump the relevant family's version whenever that family's feature
# vector's MEANING changes.
#
# Two model families now coexist (2026-07-05, reduced-exposure rebuild):
#   • exposure family (guest-consumable amenities/linens/breakfast/paper):
#       window_consumption = s · (ΣCO + κ·ΣSO), no intercept, base fixed at 0.
#       feature_set_version = INVENTORY_EXPOSURE_FEATURE_SET_VERSION.
#   • occupancy family (public-area / staff supplies whose usage is occupancy-
#       independent — light bulbs, batteries, cleaning chemicals, office/lobby):
#       the LEGACY affine occupancy model daily_rate = a + b·(occ − baseline).
#       feature_set_version = INVENTORY_FEATURE_SET_VERSION (unchanged "v2-centered").
#
# INVENTORY_FEATURE_SET_VERSION stays "v2-centered" so existing occupancy-family
# posteriors keep serving; the exposure family gets its own marker so its
# single-regressor posterior can never be served through the 2-D occupancy
# inference path (or vice-versa) — the shape guard + version guard both fire.
INVENTORY_FEATURE_SET_VERSION: str = "v2-centered"
INVENTORY_EXPOSURE_FEATURE_SET_VERSION: str = "exposure-v1"

# Model-version algorithm tag for the reduced exposure Bayesian fit. Distinct
# from the legacy "bayesian" (occupancy-form) tag so inference routes to the
# single-regressor serving path and the shadow-evaluate cron can tell the two
# families apart.
INVENTORY_EXPOSURE_ALGORITHM: str = "bayesian-exposure"

# Default kappa (usage_per_stayover / usage_per_checkout) when an exposure-family
# item has no usable per-checkout / per-stayover config on the inventory row.
# Represents "a stayover room consumes ~30% of what a checkout room does" —
# a stayover guest reuses towels/linens and only tops up amenities, whereas a
# checkout triggers a full replacement. Documented default from the converged
# review; persisted in hyperparameters as the kappa actually used.
INVENTORY_DEFAULT_KAPPA: float = 0.30


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
    # DEPRECATED (2026-07-05 reduced-exposure rebuild): the inventory XGBoost
    # branch was removed — the exposure model is a single-regressor Bayesian
    # fit that XGBoost can't improve on at N=10-30. Kept only so any config
    # override in the environment still parses. Gate #3 in _gates.py is now
    # unreachable for inventory (the trainer never sets algorithm='xgboost-
    # quantile' for inventory) but remains harmless.
    inventory_xgboost_activation_events: int = 100      # DEPRECATED — no longer read by the inventory trainer

    # ── Graduation gates ──────────────────────────────────────────────────
    # 2026-07-05 reduced-exposure rebuild: the retrain-STREAK graduation
    # (30 events + val_MAE/mean<0.10 + 5 consecutive 24h-apart passing
    # retrains) was statistically hollow — the streak re-evaluates the SAME
    # windows, and 0.10 sits below the count noise floor. Graduation now uses
    # PROSPECTIVE evidence from prediction_log (genuinely out-of-sample pairs
    # written when a manager counts). See training/_prospective_gate.py.
    #
    # inventory_graduation_min_events is the min CLEAN training windows (gate A).
    # Lowered 30 → 15: with 20-60 items/hotel counted every 2-7 days, 15 clean
    # windows is ~3-6 months of real signal; 30 blocked every item indefinitely.
    inventory_graduation_min_events: int = 15
    # Prospective gate thresholds (gates B-D):
    inventory_graduation_min_prospective_pairs: int = 8    # ≥8 predicted-vs-actual pairs
    inventory_graduation_prospective_span_days: int = 14   # pairs must span ≥14 days
    inventory_graduation_prospective_wape: float = 0.30    # Σ|pred−actual|/Σ|actual| < 0.30
    # DEPRECATED — the streak gate is gone. mae_ratio + consecutive_passes are
    # no longer consulted for graduation (they gated the removed retrain streak).
    # Kept so environment overrides still parse and _streak.py (shared unit-test
    # target) keeps its constants; NOT read by the graduation decision anymore.
    inventory_graduation_mae_ratio: float = 0.10        # DEPRECATED — see prospective gate
    inventory_graduation_consecutive_passes: int = 5    # DEPRECATED — retrain streak removed

    # ── Reduced-exposure row-weight noise constants ───────────────────────
    # Row weight w_i = 1 / (σ_d²·d_i + 2·τ²) down-weights long windows (more
    # accumulated daily-process noise) and always-present count-read noise at
    # both endpoints (the 2·τ² term = variance of the two boundary counts).
    #   inventory_daily_process_var (σ_d²): per-day variance of consumption
    #     unexplained by the exposure regressor. 1.0 = "±1 unit/day of drift".
    #   inventory_count_noise (τ²): variance of a single physical count read.
    #     1.0 = "±1 unit of miscount per count". Two counts bound each window,
    #     hence 2·τ².
    # Pragmatic unit-scale constants (not fit) — the review's converged choice.
    # A window of d days weights 1/(d + 2); a 2-day window weighs 2× a 6-day one.
    inventory_daily_process_var: float = 1.0
    inventory_count_noise: float = 1.0

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
