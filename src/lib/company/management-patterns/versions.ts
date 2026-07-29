/**
 * Versions are data, not decoration. Persist these beside every derived value
 * so a later policy change cannot silently rewrite what an old result meant.
 */
export const MANAGEMENT_PATTERN_PROFILE_VERSION = 'management-property-profile.v1' as const;
export const MANAGEMENT_PATTERN_SIZE_BAND_VERSION = 'room-count-band.v1' as const;
export const MANAGEMENT_PATTERN_OBSERVATION_VERSION = 'management-metric-observation.v1' as const;
export const MANAGEMENT_PATTERN_NORMALIZATION_VERSION = 'management-normalization.v1' as const;
export const MANAGEMENT_PATTERN_COHORT_VERSION = 'management-metric-cohort.v2' as const;
export const MANAGEMENT_PATTERN_COMPARISON_VERSION = 'management-peer-comparison.v1' as const;
export const MANAGEMENT_PATTERN_CONSOLIDATION_VERSION = 'management-consolidation.v1' as const;
export const MANAGEMENT_PATTERN_SCOPE_VERSION = 'management-scope-classifier.v1' as const;
export const MANAGEMENT_PATTERN_EVALUATOR_VERSION = 'management-pattern-evaluator.v2' as const;
export const MANAGEMENT_PATTERN_FINGERPRINT_VERSION = 'stable-sha256.v1' as const;

/** The target hotel is excluded; this is the minimum number of usable peers. */
export const DEFAULT_MINIMUM_COHORT_PEERS = 5;

/**
 * A peer claim must describe most of the otherwise comparable population, not
 * merely the handful of hotels whose data happened to be usable.  This value
 * is folded into the cohort-policy fingerprint even when callers omit it.
 */
export const DEFAULT_MINIMUM_USABLE_COHORT_COVERAGE_RATIO = 0.8;
