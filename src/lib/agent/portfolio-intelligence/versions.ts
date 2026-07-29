/**
 * Portfolio Intelligence versions are persisted with every plan and receipt.
 * Changing semantics means changing the relevant constant; old answers must
 * remain reproducible instead of silently inheriting new definitions.
 */
export const PORTFOLIO_SCOPE_CONTRACT_VERSION = 'portfolio-scope.v1' as const;
export const PORTFOLIO_QUERY_PLAN_VERSION = 'portfolio-query-plan.v1' as const;
export const PORTFOLIO_EVIDENCE_VERSION = 'portfolio-evidence.v1' as const;
export const PORTFOLIO_PROMPT_VERSION = 'portfolio-synthesis.v2' as const;
export const PORTFOLIO_FINDING_CONTRACT_VERSION = 'portfolio-finding.v1' as const;

export const BOOKED_ROOMS_OTB_METRIC_VERSION = 'rooms-booked-otb.v1' as const;
export const BOOKED_ROOMS_NORMAL_VERSION = 'same-weekday-lead0-median-mad.v1' as const;
export const LIVE_IN_HOUSE_METRIC_VERSION = 'live-in-house-rooms.v1' as const;
export const FINAL_ROOMS_SOLD_METRIC_VERSION = 'final-rooms-sold.v1' as const;
export const HOUSEKEEPING_ROOMS_CLEANED_METRIC_VERSION = 'housekeeping-rooms-cleaned.v1' as const;
export const HOUSEKEEPING_ACTIVE_MINUTES_METRIC_VERSION = 'housekeeping-active-minutes.v1' as const;

/** Supported target size, not a permission truncation. Larger exact scopes
 * receive an explicit budget refusal and are never silently sliced. */
export const MAX_EXACT_PORTFOLIO_PROPERTIES = 250;
export const PORTFOLIO_QUERY_CONCURRENCY = 8;
export const PORTFOLIO_PROPERTY_TIMEOUT_MS = 4_000;
export const PORTFOLIO_FINDING_LOAD_TIMEOUT_MS = 5_000;
export const PORTFOLIO_QUERY_TIMEOUT_MS = 25_000;
export const PORTFOLIO_MAX_DETAIL_ROWS = 25;

/** Current OTB must have a receipt captured inside this window. */
export const BOOKED_ROOMS_MAX_AGE_MS = 6 * 60 * 60 * 1_000;
export const BOOKED_ROOMS_BASELINE_WEEKS = 12;
export const BOOKED_ROOMS_MIN_BASELINE_POINTS = 6;
