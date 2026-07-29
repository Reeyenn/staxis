import { stableFingerprint } from './canonical';
import type { DenominatorKind, MetricObservation, ObservationWindowInput } from './observation';
import { MANAGEMENT_PATTERN_NORMALIZATION_VERSION } from './versions';

export type CurrencyRequirement = 'required' | 'forbidden' | 'optional';
export type WindowAlignment = 'same_local_dates' | 'same_utc_range';
export type TimeZoneAlignment = 'same_time_zone' | 'property_local';

export interface MetricDefinition {
  readonly metricId: string;
  readonly metricVersion: string;
  readonly definitionVersion: string;
  readonly rawUnit: string;
  readonly currencyRequirement: CurrencyRequirement;
  readonly allowNegativeRaw: boolean;
  readonly numeratorWindowKind: ObservationWindowInput['kind'];
  readonly denominator: {
    readonly kind: DenominatorKind;
    readonly unit: string;
    readonly windowKind: ObservationWindowInput['kind'];
  } | null;
  readonly normalizedUnit: string;
  readonly minimumCompletenessRatio: number;
  readonly denominatorMinimumCompletenessRatio: number;
  readonly maximumAgeMs: number;
  readonly maximumFutureSkewMs?: number;
  readonly blockingQualityFlags?: readonly string[];
  readonly windowAlignment: WindowAlignment;
  readonly timeZoneAlignment: TimeZoneAlignment;
}

export type NormalizationAbstentionReason =
  | 'metric_id_mismatch'
  | 'metric_version_mismatch'
  | 'raw_unit_mismatch'
  | 'numerator_missing'
  | 'currency_missing'
  | 'currency_forbidden'
  | 'negative_raw_value'
  | 'observation_incomplete'
  | 'observation_stale'
  | 'observation_from_future'
  | 'observation_quality_flagged'
  | 'numerator_window_kind_mismatch'
  | 'business_date_cutoff_missing'
  | 'denominator_missing'
  | 'denominator_kind_mismatch'
  | 'denominator_unit_mismatch'
  | 'denominator_currency_mismatch'
  | 'denominator_currency_scale_mismatch'
  | 'denominator_not_positive'
  | 'denominator_incomplete'
  | 'denominator_quality_flagged'
  | 'denominator_window_kind_mismatch'
  | 'denominator_time_zone_mismatch'
  | 'denominator_stale'
  | 'denominator_from_future'
  | 'denominator_window_mismatch';

export interface NormalizedObservation {
  readonly schemaVersion: typeof MANAGEMENT_PATTERN_NORMALIZATION_VERSION;
  readonly observation: MetricObservation;
  readonly definitionFingerprint: string;
  readonly evaluatedAt: string;
  readonly value: number;
  readonly unit: string;
  readonly currency: string | null;
  readonly currencyStorageScale: number | null;
  readonly denominatorKind: DenominatorKind | null;
  readonly fingerprint: string;
}

export type NormalizationResult =
  | { readonly ok: true; readonly value: NormalizedObservation }
  | {
    readonly ok: false;
    readonly status: 'abstain';
    readonly reasons: readonly NormalizationAbstentionReason[];
    readonly observationFingerprint: string;
    readonly definitionFingerprint: string;
  };

export type CompatibilityReason =
  | 'different_organization'
  | 'different_metric_definition'
  | 'different_evaluation_time'
  | 'different_currency'
  | 'different_normalized_unit'
  | 'different_window_kind'
  | 'different_local_window'
  | 'different_utc_window'
  | 'different_time_zone'
  | 'different_business_date_cutoff'
  | 'different_currency_scale';

export type CompatibilityResult =
  | { readonly ok: true; readonly compatibilityFingerprint: string }
  | { readonly ok: false; readonly reasons: readonly CompatibilityReason[] };

function ratio(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${field} must be between 0 and 1`);
  }
  return value;
}

function duration(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${field} must be non-negative`);
  return value;
}

function instant(value: string, field: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || !value.includes('T')) throw new TypeError(`${field} must be an ISO-8601 instant`);
  return new Date(parsed).toISOString();
}

function definitionPayload(definition: MetricDefinition) {
  if (!definition.metricId.trim() || !definition.metricVersion.trim() || !definition.definitionVersion.trim()) {
    throw new TypeError('metric definition identifiers must not be empty');
  }
  if (!definition.rawUnit.trim() || !definition.normalizedUnit.trim()) {
    throw new TypeError('metric definition units must not be empty');
  }
  if (definition.denominator !== null && (!definition.denominator.unit.trim())) {
    throw new TypeError('metric definition denominator unit must not be empty');
  }
  if (!['business_dates', 'instant_range'].includes(definition.numeratorWindowKind)) {
    throw new TypeError('metric definition numeratorWindowKind is invalid');
  }
  if (
    definition.denominator !== null
    && !['business_dates', 'instant_range'].includes(definition.denominator.windowKind)
  ) throw new TypeError('metric definition denominator.windowKind is invalid');
  return {
    schemaVersion: MANAGEMENT_PATTERN_NORMALIZATION_VERSION,
    metricId: definition.metricId.trim(),
    metricVersion: definition.metricVersion.trim(),
    definitionVersion: definition.definitionVersion.trim(),
    rawUnit: definition.rawUnit.trim(),
    currencyRequirement: definition.currencyRequirement,
    allowNegativeRaw: definition.allowNegativeRaw,
    numeratorWindowKind: definition.numeratorWindowKind,
    denominator: definition.denominator === null ? null : {
      kind: definition.denominator.kind,
      unit: definition.denominator.unit.trim(),
      windowKind: definition.denominator.windowKind,
    },
    normalizedUnit: definition.normalizedUnit.trim(),
    minimumCompletenessRatio: ratio(definition.minimumCompletenessRatio, 'minimumCompletenessRatio'),
    denominatorMinimumCompletenessRatio: ratio(
      definition.denominatorMinimumCompletenessRatio,
      'denominatorMinimumCompletenessRatio',
    ),
    maximumAgeMs: duration(definition.maximumAgeMs, 'maximumAgeMs'),
    maximumFutureSkewMs: duration(definition.maximumFutureSkewMs ?? 0, 'maximumFutureSkewMs'),
    blockingQualityFlags: [...new Set(definition.blockingQualityFlags ?? [])].sort(),
    windowAlignment: definition.windowAlignment,
    timeZoneAlignment: definition.timeZoneAlignment,
  };
}

export function metricDefinitionFingerprint(definition: MetricDefinition): string {
  return stableFingerprint(definitionPayload(definition), 'metric-definition');
}

function freshnessReasons(
  freshThrough: string,
  evaluatedAt: string,
  maximumAgeMs: number,
  maximumFutureSkewMs: number,
  staleReason: 'observation_stale' | 'denominator_stale',
  futureReason: 'observation_from_future' | 'denominator_from_future',
): NormalizationAbstentionReason[] {
  const ageMs = Date.parse(evaluatedAt) - Date.parse(freshThrough);
  if (ageMs > maximumAgeMs) return [staleReason];
  if (ageMs < -maximumFutureSkewMs) return [futureReason];
  return [];
}

/**
 * Preserve the raw observation while deriving one comparison value. Every
 * insufficient-data state is an abstention; none is converted to zero.
 */
export function normalizeObservation(
  observation: MetricObservation,
  definition: MetricDefinition,
  evaluatedAtInput: string,
): NormalizationResult {
  const evaluatedAt = instant(evaluatedAtInput, 'evaluatedAt');
  const policy = definitionPayload(definition);
  const definitionFingerprint = stableFingerprint(policy, 'metric-definition');
  const reasons: NormalizationAbstentionReason[] = [];

  if (observation.metricId !== policy.metricId) reasons.push('metric_id_mismatch');
  if (observation.metricVersion !== policy.metricVersion) reasons.push('metric_version_mismatch');
  if (observation.rawUnit !== policy.rawUnit) reasons.push('raw_unit_mismatch');
  if (observation.rawValue === null) reasons.push('numerator_missing');
  if (policy.currencyRequirement === 'required' && observation.rawCurrency === null) reasons.push('currency_missing');
  if (policy.currencyRequirement === 'forbidden' && observation.rawCurrency !== null) reasons.push('currency_forbidden');
  if (!policy.allowNegativeRaw && observation.rawValue !== null && observation.rawValue < 0) {
    reasons.push('negative_raw_value');
  }
  if (observation.window.kind !== policy.numeratorWindowKind) {
    reasons.push('numerator_window_kind_mismatch');
  }
  if (observation.quality.completenessRatio < policy.minimumCompletenessRatio) {
    reasons.push('observation_incomplete');
  }
  reasons.push(...freshnessReasons(
    observation.quality.freshThrough,
    evaluatedAt,
    policy.maximumAgeMs,
    policy.maximumFutureSkewMs,
    'observation_stale',
    'observation_from_future',
  ));
  if (observation.quality.qualityFlags.some((flag) => policy.blockingQualityFlags.includes(flag))) {
    reasons.push('observation_quality_flagged');
  }
  if (observation.window.kind === 'business_dates' && observation.window.businessDateCutoffHour === null) {
    reasons.push('business_date_cutoff_missing');
  }

  const denominator = observation.denominator;
  if (policy.denominator !== null) {
    if (denominator === null) {
      reasons.push('denominator_missing');
    } else {
      if (denominator.kind !== policy.denominator.kind) reasons.push('denominator_kind_mismatch');
      if (denominator.unit !== policy.denominator.unit) reasons.push('denominator_unit_mismatch');
      if (denominator.window.kind !== policy.denominator.windowKind) {
        reasons.push('denominator_window_kind_mismatch');
      }
      if (denominator.window.timeZone !== observation.window.timeZone) {
        reasons.push('denominator_time_zone_mismatch');
      }
      if (denominator.value === null) reasons.push('denominator_missing');
      else if (denominator.value <= 0) reasons.push('denominator_not_positive');
      if (denominator.quality.completenessRatio < policy.denominatorMinimumCompletenessRatio) {
        reasons.push('denominator_incomplete');
      }
      if (denominator.quality.qualityFlags.some((flag) => policy.blockingQualityFlags.includes(flag))) {
        reasons.push('denominator_quality_flagged');
      }
      reasons.push(...freshnessReasons(
        denominator.quality.freshThrough,
        evaluatedAt,
        policy.maximumAgeMs,
        policy.maximumFutureSkewMs,
        'denominator_stale',
        'denominator_from_future',
      ));
      if (denominator.kind === 'revenue_minor' && denominator.currency !== observation.rawCurrency) {
        reasons.push('denominator_currency_mismatch');
      }
      if (
        denominator.kind === 'revenue_minor'
        && denominator.currencyStorageScale !== observation.rawCurrencyStorageScale
      ) {
        reasons.push('denominator_currency_scale_mismatch');
      }
      if (
        denominator.window.kind === 'business_dates'
        && denominator.window.businessDateCutoffHour === null
      ) reasons.push('business_date_cutoff_missing');
      const denominatorWindowAligned = policy.windowAlignment === 'same_local_dates'
        ? (
          denominator.window.localStartDate === observation.window.localStartDate
          && denominator.window.localEndDate === observation.window.localEndDate
        )
        : (
          denominator.window.utcStart === observation.window.utcStart
          && denominator.window.utcEnd === observation.window.utcEnd
        );
      if (!denominatorWindowAligned) {
        reasons.push('denominator_window_mismatch');
      }
    }
  }

  const uniqueReasons = Object.freeze([...new Set(reasons)].sort()) as readonly NormalizationAbstentionReason[];
  if (uniqueReasons.length > 0) {
    return Object.freeze({
      ok: false as const,
      status: 'abstain' as const,
      reasons: uniqueReasons,
      observationFingerprint: observation.fingerprint,
      definitionFingerprint,
    });
  }

  // The missing/non-positive cases above guarantee this assertion when needed.
  const value = policy.denominator === null
    ? (observation.rawValue as number)
    : (observation.rawValue as number) / (denominator?.value as number);
  if (!Number.isFinite(value)) {
    throw new TypeError('normalization produced a non-finite value after validation');
  }
  const payload = {
    schemaVersion: MANAGEMENT_PATTERN_NORMALIZATION_VERSION,
    observationFingerprint: observation.fingerprint,
    definitionFingerprint,
    evaluatedAt,
    value,
    unit: policy.normalizedUnit,
    currency: observation.rawCurrency,
    currencyStorageScale: observation.rawCurrencyStorageScale,
    denominatorKind: policy.denominator?.kind ?? null,
  };
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      schemaVersion: MANAGEMENT_PATTERN_NORMALIZATION_VERSION,
      observation,
      definitionFingerprint,
      evaluatedAt,
      value,
      unit: policy.normalizedUnit,
      currency: observation.rawCurrency,
      currencyStorageScale: observation.rawCurrencyStorageScale,
      denominatorKind: policy.denominator?.kind ?? null,
      fingerprint: stableFingerprint(payload, 'normalized-observation'),
    }),
  });
}

/** Pairwise gate used before a peer value is allowed into a baseline. */
export function checkNormalizedCompatibility(
  target: NormalizedObservation,
  peer: NormalizedObservation,
  definition: MetricDefinition,
): CompatibilityResult {
  const policy = definitionPayload(definition);
  const expectedDefinitionFingerprint = stableFingerprint(policy, 'metric-definition');
  const reasons: CompatibilityReason[] = [];
  if (target.observation.organizationId !== peer.observation.organizationId) reasons.push('different_organization');
  if (
    target.definitionFingerprint !== expectedDefinitionFingerprint
    || peer.definitionFingerprint !== expectedDefinitionFingerprint
  ) reasons.push('different_metric_definition');
  if (target.evaluatedAt !== peer.evaluatedAt) reasons.push('different_evaluation_time');
  if (target.currency !== peer.currency) reasons.push('different_currency');
  if (target.currencyStorageScale !== peer.currencyStorageScale) reasons.push('different_currency_scale');
  if (target.unit !== peer.unit) reasons.push('different_normalized_unit');

  const targetWindow = target.observation.window;
  const peerWindow = peer.observation.window;
  if (targetWindow.kind !== peerWindow.kind) reasons.push('different_window_kind');
  if (policy.windowAlignment === 'same_local_dates') {
    if (
      targetWindow.localStartDate !== peerWindow.localStartDate
      || targetWindow.localEndDate !== peerWindow.localEndDate
    ) reasons.push('different_local_window');
  } else if (targetWindow.utcStart !== peerWindow.utcStart || targetWindow.utcEnd !== peerWindow.utcEnd) {
    reasons.push('different_utc_window');
  }
  if (policy.timeZoneAlignment === 'same_time_zone' && targetWindow.timeZone !== peerWindow.timeZone) {
    reasons.push('different_time_zone');
  }
  if (
    targetWindow.kind === 'business_dates'
    && targetWindow.businessDateCutoffHour !== peerWindow.businessDateCutoffHour
  ) {
    reasons.push('different_business_date_cutoff');
  }

  const uniqueReasons = Object.freeze([...new Set(reasons)].sort()) as readonly CompatibilityReason[];
  if (uniqueReasons.length > 0) return Object.freeze({ ok: false as const, reasons: uniqueReasons });
  return Object.freeze({
    ok: true as const,
    compatibilityFingerprint: stableFingerprint({
      definitionFingerprint: expectedDefinitionFingerprint,
      organizationId: target.observation.organizationId,
      currency: target.currency,
      currencyStorageScale: target.currencyStorageScale,
      unit: target.unit,
      evaluatedAt: target.evaluatedAt,
      window: policy.windowAlignment === 'same_local_dates'
        ? {
          kind: targetWindow.kind,
          localStartDate: targetWindow.localStartDate,
          localEndDate: targetWindow.localEndDate,
          timeZone: policy.timeZoneAlignment === 'same_time_zone' ? targetWindow.timeZone : 'property_local',
          businessDateCutoffHour: targetWindow.businessDateCutoffHour,
        }
        : {
          kind: targetWindow.kind,
          utcStart: targetWindow.utcStart,
          utcEnd: targetWindow.utcEnd,
          timeZone: policy.timeZoneAlignment === 'same_time_zone' ? targetWindow.timeZone : 'property_local',
          businessDateCutoffHour: targetWindow.businessDateCutoffHour,
        },
    }, 'normalized-compatibility'),
  });
}
