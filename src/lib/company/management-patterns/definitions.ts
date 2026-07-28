import type { MetricCohortPolicy } from './cohort';
import type { PeerComparisonPolicy } from './comparison';
import type { MetricDefinition } from './normalization';

/**
 * These identifiers are persisted with every run and receipt. Changing logic
 * without changing the corresponding version would make an old result
 * impossible to reproduce honestly.
 */
export const MANAGEMENT_PATTERN_ENGINE_VERSION = 'management-pattern-engine.v2' as const;
export const MANAGEMENT_PATTERN_EVIDENCE_SCHEMA_VERSION = 2 as const;
export const MANAGEMENT_PATTERN_EVIDENCE_FORMAT = 'management-pattern-evidence.v2' as const;
export const MANAGEMENT_PATTERN_PORTFOLIO_SNAPSHOT_SCHEMA_VERSION = 2 as const;
export const MANAGEMENT_PATTERN_DEDUPE_POLICY_VERSION = 'management-pattern-dedupe.v1' as const;
export const MANAGEMENT_PATTERN_SCOPE_POLICY_VERSION = 'management-pattern-scope.v1' as const;
export const MANAGEMENT_PATTERN_SOURCE_QUERY_VERSION = 'management-pattern-source-snapshot.v2' as const;
export const MANAGEMENT_PATTERN_MAX_INPUT_BATCH_BYTES = 16 * 1024 * 1024;

export const SUPPLY_SPEND_CHECK_ID = 'portfolio_supply_spend_gap' as const;
export const SUPPLY_SPEND_CHECK_VERSION = 'completed-month-peer-baseline.v3' as const;
export const SUPPLY_SPEND_METRIC_ID = 'inventory_purchase_spend' as const;
export const SUPPLY_SPEND_METRIC_VERSION = 'inventory-month-close.v1' as const;
export const SUPPLY_SPEND_HISTORY_MONTHS = 3;
export const SUPPLY_SPEND_WINDOW_SAFETY_LAG_HOURS = 48;

/**
 * Purchase spend is compared per report-stated room sold over the same three
 * completed local calendar months. Three non-partial inventory closes smooth
 * lumpy delivery timing; a daily closing-photo row with an explicit occupancy
 * source proves every denominator day.
 */
export const SUPPLY_SPEND_METRIC_DEFINITION = Object.freeze({
  metricId: SUPPLY_SPEND_METRIC_ID,
  metricVersion: SUPPLY_SPEND_METRIC_VERSION,
  definitionVersion: 'purchase-minor-units-per-occupied-room.v1',
  rawUnit: 'minor_currency_units',
  currencyRequirement: 'required',
  allowNegativeRaw: false,
  numeratorWindowKind: 'instant_range',
  denominator: {
    kind: 'rooms_sold',
    unit: 'room_nights_sold',
    windowKind: 'business_dates',
  },
  normalizedUnit: 'minor_currency_units_per_room_sold',
  minimumCompletenessRatio: 1,
  denominatorMinimumCompletenessRatio: 1,
  // A completed prior month can legitimately be several weeks old when the
  // next evaluation runs. Older evidence abstains rather than being revived.
  maximumAgeMs: 45 * 86_400_000,
  maximumFutureSkewMs: 5 * 60_000,
  blockingQualityFlags: [
    'inventory_close_partial',
    'inventory_close_open',
    'inventory_close_quality_blocked',
    'occupancy_source_missing',
    'occupancy_source_partial',
    'profile_changed_within_window',
    'relationship_does_not_cover_supply_window',
    // The current source columns are encoded in hundredths. A currency whose
    // storage exponent differs must use an explicit future conversion adapter.
    'source_currency_scale_mismatch',
    'source_row_budget_exceeded',
  ],
  windowAlignment: 'same_local_dates',
  timeZoneAlignment: 'property_local',
} as const) satisfies MetricDefinition;

/**
 * Dimensions are declared most-to-least important. The fallback order is the
 * reverse: relax only optional, lower-defensibility attributes, never service
 * level, size, or currency. The organization-wide population is not a fair
 * automatic fallback for this metric.
 */
export const SUPPLY_SPEND_COHORT_POLICY = Object.freeze({
  metricId: SUPPLY_SPEND_METRIC_ID,
  policyVersion: 'supply-spend-cohort.v3',
  dimensions: [
    { dimension: 'serviceLevel', matcher: 'exact', relaxable: false },
    { dimension: 'sizeBand', matcher: 'exact', relaxable: false },
    { dimension: 'operatingCurrency', matcher: 'exact', relaxable: false },
    { dimension: 'operatingModel', matcher: 'exact', relaxable: true },
    { dimension: 'marketType', matcher: 'exact', relaxable: true },
    // Temporal organization region is price-relevant, but may be relaxed
    // after broader market/operating compatibility when a region is sparse.
    { dimension: 'regionId', matcher: 'exact', relaxable: true },
    { dimension: 'brandClass', matcher: 'exact', relaxable: true },
    { dimension: 'amenityTags', matcher: 'target_tags_subset', relaxable: true },
  ],
  fallbackOrder: ['amenityTags', 'brandClass', 'regionId', 'marketType', 'operatingModel'],
  minimumPeers: 5,
  minimumUsableCoverageRatio: 0.8,
  allowOrganizationWideFallback: false,
} as const) satisfies MetricCohortPolicy;

/**
 * Unknown profile dimensions can still describe a fair peer. Coverage is
 * therefore measured for each target and fallback rung against every peer not
 * disproved by another known, still-active dimension. A portfolio-wide ratio
 * is not sufficient: unrelated hotels must neither rescue nor poison a
 * target's actual comparison domain.
 */
export const SUPPLY_SPEND_PROFILE_COVERAGE_POLICY = Object.freeze({
  policyVersion: 'supply-spend-target-rung-profile-coverage.v2',
  populationBasis: 'target_rung_potentially_compatible_leave_one_out_peers' as const,
  minimumCompleteRatio: 0.8,
  requiredNonRelaxableDimensions: Object.freeze([
    'serviceLevel',
    'sizeBand',
    'operatingCurrency',
  ] as const),
});

export const SUPPLY_SPEND_COMPARISON_POLICY = Object.freeze({
  // This absolute threshold is valid only after the currency-domain policy
  // below has admitted the target. It is not a universal scale-2 threshold.
  policyVersion: 'supply-spend-high-outlier-usd.v2',
  direction: 'high',
  minimumPeers: 5,
  // Values are cents (or the native currency's minor unit) per occupied room.
  minimumAbsoluteDelta: 200,
  minimumRelativeDelta: 0.5,
  minimumRobustZ: 3,
  iqrFenceMultiplier: 1.5,
  // A broad peer distribution is not a reliable benchmark even when a target
  // happens to clear a conventional outlier fence.
  maximumRelativeInterquartileRange: 0.75,
  maximumRelativeMedianAbsoluteDeviation: 0.35,
  zeroMedianPolicy: 'abstain',
} as const) satisfies PeerComparisonPolicy;

export interface SupplySpendMaterialityThreshold {
  readonly currencyCode: string;
  readonly currencyStorageScale: number;
  readonly minimumNormalizedExcessMinorPerRoomSold: number;
  readonly minimumRawExcessMinor: number;
  readonly provenance: Readonly<{
    readonly kind: 'explicit_initial_policy';
    readonly reference: string;
  }>;
}

/**
 * Native-currency materiality is economic policy, not a property of decimal
 * scale. Safe v2 admits only the explicitly configured USD domain; INR, EUR,
 * and every other same-scale currency abstain until reviewed thresholds (or a
 * separately governed FX contract) are added under a new policy version.
 */
export const SUPPLY_SPEND_MATERIALITY_POLICY = Object.freeze({
  policyVersion: 'supply-spend-native-materiality.v1',
  unsupportedCurrencyBehavior: 'abstain' as const,
  thresholds: Object.freeze({
    'USD:scale_2': Object.freeze({
      currencyCode: 'USD',
      currencyStorageScale: 2,
      minimumNormalizedExcessMinorPerRoomSold: 200,
      minimumRawExcessMinor: 20_000,
      provenance: Object.freeze({
        kind: 'explicit_initial_policy' as const,
        reference: 'supply-spend-high-outlier-usd.v2',
      }),
    }),
  }),
});

export function supplySpendMaterialityThreshold(
  currencyCode: string | null,
  currencyStorageScale: number | null,
): SupplySpendMaterialityThreshold | null {
  if (currencyCode === null || currencyStorageScale === null) return null;
  const key = `${currencyCode}:scale_${currencyStorageScale}`;
  return SUPPLY_SPEND_MATERIALITY_POLICY.thresholds[
    key as keyof typeof SUPPLY_SPEND_MATERIALITY_POLICY.thresholds
  ] ?? null;
}

export const ACTIVITY_STOPPED_CHECK_ID = 'portfolio_activity_stopped' as const;
export const ACTIVITY_STOPPED_CHECK_VERSION = 'multi-property-cadence.v2' as const;
export const ACTIVITY_HISTORY_DAYS = 98;
export const ACTIVITY_MINIMUM_EVENTS = 6;
export const ACTIVITY_MINIMUM_TOLERANCE_DAYS = 3;
export const ACTIVITY_MINIMUM_AFFECTED_PROPERTIES = 3;
export const ACTIVITY_MINIMUM_AFFECTED_SHARE = 0.3;
/** Missing cadence proof may not shrink a portfolio condition into 3/3. */
export const ACTIVITY_MINIMUM_EVIDENCE_COVERAGE = 0.9;
export const ACTIVITY_STREAM_LABELS = Object.freeze({
  inventory_counts: 'inventory count entries',
  daily_log_closings: 'daily closing records',
  work_order_flow: 'maintenance entries',
} as const);

export const MANAGEMENT_PATTERN_MAX_PROPERTIES = 50;
export const MANAGEMENT_PATTERN_MAX_EVIDENCE_BYTES = 256 * 1024;
export const MANAGEMENT_PATTERN_MAX_CANDIDATES = 25;
export const MANAGEMENT_PATTERN_HARD_TIMEOUT_MS = 30_000;
