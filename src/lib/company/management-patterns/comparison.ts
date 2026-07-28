import { stableFingerprint } from './canonical';
import type { MetricCohort } from './cohort';
import type { DenominatorKind } from './observation';
import {
  checkNormalizedCompatibility,
  type CompatibilityReason,
  type MetricDefinition,
  type NormalizedObservation,
} from './normalization';
import {
  DEFAULT_MINIMUM_COHORT_PEERS,
  MANAGEMENT_PATTERN_COMPARISON_VERSION,
} from './versions';

export type OutlierDirection = 'high' | 'low' | 'two_sided';

export interface PeerComparisonPolicy {
  readonly policyVersion: string;
  readonly direction: OutlierDirection;
  readonly minimumPeers?: number;
  readonly minimumAbsoluteDelta: number;
  /** Fraction over the absolute peer median: 0.5 means 50%. */
  readonly minimumRelativeDelta: number;
  readonly minimumRobustZ: number;
  readonly iqrFenceMultiplier?: number;
  /** Maximum IQR divided by |median| for a trustworthy peer baseline. */
  readonly maximumRelativeInterquartileRange: number;
  /** Maximum MAD divided by |median| for a trustworthy peer baseline. */
  readonly maximumRelativeMedianAbsoluteDeviation: number;
  /** A zero median cannot satisfy a ratio unless this explicit fallback is enabled. */
  readonly zeroMedianPolicy?: 'abstain' | 'absolute_only';
}

export type PeerExclusionReason =
  | CompatibilityReason
  | 'target_leave_one_out'
  | 'duplicate_observation_ignored'
  | 'conflicting_duplicate_observations'
  | 'outside_formed_cohort'
  | 'peer_profile_not_in_cohort_snapshot'
  | 'cohort_member_observation_missing';

export interface PeerExclusion {
  readonly propertyId: string;
  readonly observationFingerprints: readonly string[];
  readonly reasons: readonly PeerExclusionReason[];
}

export interface PeerDistribution {
  readonly count: number;
  readonly minimum: number;
  readonly firstQuartile: number;
  readonly median: number;
  readonly thirdQuartile: number;
  readonly maximum: number;
  readonly interquartileRange: number;
  readonly medianAbsoluteDeviation: number;
  readonly robustScale: number | null;
}

export type PeerBaselineStabilityReason =
  | 'zero_median_with_nonzero_dispersion'
  | 'relative_iqr_exceeds_maximum'
  | 'relative_mad_exceeds_maximum';

/** Versioned, reproducible proof that a peer baseline is sufficiently stable. */
export interface PeerBaselineStability {
  readonly status: 'stable' | 'unstable';
  readonly policyVersion: string;
  readonly medianMagnitude: number;
  readonly relativeInterquartileRange: number | null;
  readonly relativeMedianAbsoluteDeviation: number | null;
  readonly maximumRelativeInterquartileRange: number;
  readonly maximumRelativeMedianAbsoluteDeviation: number;
  readonly reasonCodes: readonly PeerBaselineStabilityReason[];
  readonly fingerprint: string;
}

export interface PeerValueEvidence {
  readonly propertyId: string;
  readonly profileFingerprint: string;
  readonly observationFingerprint: string;
  readonly rawValue: number | null;
  readonly rawUnit: string;
  readonly rawCurrency: string | null;
  readonly rawCurrencyStorageScale: number | null;
  readonly denominatorValue: number | null;
  readonly denominatorKind: DenominatorKind | null;
  readonly normalizedValue: number;
  readonly normalizedUnit: string;
}

export interface PeerComparison {
  readonly schemaVersion: typeof MANAGEMENT_PATTERN_COMPARISON_VERSION;
  readonly status: 'outlier' | 'not_outlier';
  readonly organizationId: string;
  readonly targetPropertyId: string;
  readonly targetObservationFingerprint: string;
  readonly targetEvidence: PeerValueEvidence;
  readonly cohortFingerprint: string;
  readonly peerObservationFingerprints: readonly string[];
  readonly peerPropertyIds: readonly string[];
  readonly peerValues: readonly PeerValueEvidence[];
  readonly policyFingerprint: string;
  readonly definitionFingerprint: string;
  readonly evaluatedAt: string;
  readonly directionEvaluated: 'high' | 'low';
  readonly distribution: PeerDistribution;
  readonly baselineStability: PeerBaselineStability;
  readonly targetValue: number;
  readonly signedDelta: number;
  readonly absoluteDelta: number;
  readonly relativeDelta: number | null;
  readonly robustZ: number | null;
  readonly lowerFence: number;
  readonly upperFence: number;
  readonly passesMateriality: boolean;
  readonly passesStatisticalGate: boolean;
  /** Threshold progress in [0,1], never a probability or confidence claim. */
  readonly materialityScore: number;
  /** Threshold progress in [0,1], never a probability or confidence claim. */
  readonly outlierScore: number;
  readonly scoreKind: 'threshold_progress_not_probability';
  readonly exclusions: readonly PeerExclusion[];
  readonly fingerprint: string;
}

export type PeerComparisonAbstentionReason =
  | 'insufficient_compatible_peers'
  | 'zero_peer_baseline'
  | 'cohort_target_mismatch'
  | 'cohort_metric_mismatch'
  | 'cohort_fingerprint_invalid'
  | 'cohort_members_missing'
  | 'unstable_peer_baseline';

export type PeerComparisonResult =
  | { readonly ok: true; readonly comparison: PeerComparison }
  | {
    readonly ok: false;
    readonly status: 'abstain';
    readonly reasons: readonly PeerComparisonAbstentionReason[];
    readonly minimumPeers: number;
    readonly compatiblePeerCount: number;
    readonly policyFingerprint: string;
    readonly definitionFingerprint: string;
    readonly distribution: PeerDistribution | null;
    readonly baselineStability: PeerBaselineStability | null;
    readonly exclusions: readonly PeerExclusion[];
  };

interface ValidatedPolicy {
  readonly policyVersion: string;
  readonly direction: OutlierDirection;
  readonly minimumPeers: number;
  readonly minimumAbsoluteDelta: number;
  readonly minimumRelativeDelta: number;
  readonly minimumRobustZ: number;
  readonly iqrFenceMultiplier: number;
  readonly maximumRelativeInterquartileRange: number;
  readonly maximumRelativeMedianAbsoluteDeviation: number;
  readonly zeroMedianPolicy: 'abstain' | 'absolute_only';
}

function nonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${field} must be non-negative`);
  return value;
}

function validatePolicy(policy: PeerComparisonPolicy): ValidatedPolicy {
  const policyVersion = policy.policyVersion.trim();
  if (!policyVersion) throw new TypeError('comparison policyVersion must not be empty');
  const minimumPeers = policy.minimumPeers ?? DEFAULT_MINIMUM_COHORT_PEERS;
  if (!Number.isInteger(minimumPeers) || minimumPeers < 3) {
    throw new TypeError('comparison minimumPeers must be an integer of at least 3');
  }
  return Object.freeze({
    policyVersion,
    direction: policy.direction,
    minimumPeers,
    minimumAbsoluteDelta: nonNegative(policy.minimumAbsoluteDelta, 'minimumAbsoluteDelta'),
    minimumRelativeDelta: nonNegative(policy.minimumRelativeDelta, 'minimumRelativeDelta'),
    minimumRobustZ: nonNegative(policy.minimumRobustZ, 'minimumRobustZ'),
    iqrFenceMultiplier: nonNegative(policy.iqrFenceMultiplier ?? 1.5, 'iqrFenceMultiplier'),
    maximumRelativeInterquartileRange: nonNegative(
      policy.maximumRelativeInterquartileRange,
      'maximumRelativeInterquartileRange',
    ),
    maximumRelativeMedianAbsoluteDeviation: nonNegative(
      policy.maximumRelativeMedianAbsoluteDeviation,
      'maximumRelativeMedianAbsoluteDeviation',
    ),
    zeroMedianPolicy: policy.zeroMedianPolicy ?? 'abstain',
  });
}

export function peerComparisonPolicyFingerprint(policy: PeerComparisonPolicy): string {
  return stableFingerprint(validatePolicy(policy), 'peer-comparison-policy');
}

function quantile(sorted: readonly number[], probability: number): number {
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function distributionOf(values: readonly number[]): PeerDistribution {
  const sorted = [...values].sort((left, right) => left - right);
  const median = quantile(sorted, 0.5);
  const firstQuartile = quantile(sorted, 0.25);
  const thirdQuartile = quantile(sorted, 0.75);
  const interquartileRange = thirdQuartile - firstQuartile;
  const medianAbsoluteDeviation = quantile(
    sorted.map((value) => Math.abs(value - median)).sort((left, right) => left - right),
    0.5,
  );
  const robustScale = medianAbsoluteDeviation > 0
    ? medianAbsoluteDeviation * 1.4826
    : interquartileRange > 0
      ? interquartileRange / 1.349
      : null;
  return Object.freeze({
    count: sorted.length,
    minimum: sorted[0],
    firstQuartile,
    median,
    thirdQuartile,
    maximum: sorted[sorted.length - 1],
    interquartileRange,
    medianAbsoluteDeviation,
    robustScale,
  });
}

function baselineStabilityOf(
  distribution: PeerDistribution,
  policy: ValidatedPolicy,
): PeerBaselineStability {
  const medianMagnitude = Math.abs(distribution.median);
  const relativeInterquartileRange = medianMagnitude === 0
    ? (distribution.interquartileRange === 0 ? 0 : null)
    : distribution.interquartileRange / medianMagnitude;
  const relativeMedianAbsoluteDeviation = medianMagnitude === 0
    ? (distribution.medianAbsoluteDeviation === 0 ? 0 : null)
    : distribution.medianAbsoluteDeviation / medianMagnitude;
  const reasonCodes: PeerBaselineStabilityReason[] = [];
  if (relativeInterquartileRange === null || relativeMedianAbsoluteDeviation === null) {
    reasonCodes.push('zero_median_with_nonzero_dispersion');
  }
  if (
    relativeInterquartileRange !== null
    && relativeInterquartileRange > policy.maximumRelativeInterquartileRange
  ) {
    reasonCodes.push('relative_iqr_exceeds_maximum');
  }
  if (
    relativeMedianAbsoluteDeviation !== null
    && relativeMedianAbsoluteDeviation > policy.maximumRelativeMedianAbsoluteDeviation
  ) {
    reasonCodes.push('relative_mad_exceeds_maximum');
  }
  const payload = {
    status: reasonCodes.length === 0 ? 'stable' as const : 'unstable' as const,
    policyVersion: policy.policyVersion,
    medianMagnitude,
    relativeInterquartileRange,
    relativeMedianAbsoluteDeviation,
    maximumRelativeInterquartileRange: policy.maximumRelativeInterquartileRange,
    maximumRelativeMedianAbsoluteDeviation: policy.maximumRelativeMedianAbsoluteDeviation,
    reasonCodes: Object.freeze(reasonCodes),
  };
  return Object.freeze({
    ...payload,
    fingerprint: stableFingerprint(payload, 'peer-baseline-stability'),
  });
}

function progress(value: number, threshold: number): number {
  if (threshold === 0) return 1;
  return Math.max(0, Math.min(1, value / threshold));
}

function preparePeers(
  target: NormalizedObservation,
  peers: readonly NormalizedObservation[],
  definition: MetricDefinition,
  cohort: MetricCohort,
): { included: NormalizedObservation[]; exclusions: PeerExclusion[] } {
  const byProperty = new Map<string, NormalizedObservation[]>();
  for (const peer of peers) {
    const propertyId = peer.observation.propertyId;
    const values = byProperty.get(propertyId) ?? [];
    values.push(peer);
    byProperty.set(propertyId, values);
  }
  const included: NormalizedObservation[] = [];
  const exclusions: PeerExclusion[] = [];
  const cohortMembers = new Map(cohort.members.map((member) => [member.propertyId, member]));
  for (const propertyId of [...byProperty.keys()].sort()) {
    const values = byProperty.get(propertyId) ?? [];
    const unique = new Map(values.map((value) => [value.fingerprint, value]));
    const fingerprints = Object.freeze([...unique.keys()].sort());
    if (propertyId === target.observation.propertyId) {
      exclusions.push(Object.freeze({
        propertyId,
        observationFingerprints: fingerprints,
        reasons: ['target_leave_one_out'] as const,
      }));
      continue;
    }
    const cohortMember = cohortMembers.get(propertyId);
    if (!cohortMember) {
      exclusions.push(Object.freeze({
        propertyId,
        observationFingerprints: fingerprints,
        reasons: ['outside_formed_cohort'] as const,
      }));
      continue;
    }
    if (unique.size > 1) {
      exclusions.push(Object.freeze({
        propertyId,
        observationFingerprints: fingerprints,
        reasons: ['conflicting_duplicate_observations'] as const,
      }));
      continue;
    }
    const representative = [...unique.values()][0];
    if (representative.observation.profileFingerprint !== cohortMember.profileFingerprint) {
      exclusions.push(Object.freeze({
        propertyId,
        observationFingerprints: fingerprints,
        reasons: ['peer_profile_not_in_cohort_snapshot'] as const,
      }));
      continue;
    }
    const compatibility = checkNormalizedCompatibility(target, representative, definition);
    if (!compatibility.ok) {
      exclusions.push(Object.freeze({
        propertyId,
        observationFingerprints: fingerprints,
        reasons: compatibility.reasons,
      }));
      continue;
    }
    included.push(representative);
    if (values.length > 1) {
      exclusions.push(Object.freeze({
        propertyId,
        observationFingerprints: fingerprints,
        reasons: ['duplicate_observation_ignored'] as const,
      }));
    }
  }
  for (const member of cohort.members) {
    if (!byProperty.has(member.propertyId)) {
      exclusions.push(Object.freeze({
        propertyId: member.propertyId,
        observationFingerprints: Object.freeze([]),
        reasons: ['cohort_member_observation_missing'] as const,
      }));
    }
  }
  included.sort((left, right) => left.observation.propertyId.localeCompare(right.observation.propertyId));
  exclusions.sort((left, right) => left.propertyId.localeCompare(right.propertyId));
  return { included, exclusions };
}

function valueEvidence(value: NormalizedObservation): PeerValueEvidence {
  return Object.freeze({
    propertyId: value.observation.propertyId,
    profileFingerprint: value.observation.profileFingerprint,
    observationFingerprint: value.observation.fingerprint,
    rawValue: value.observation.rawValue,
    rawUnit: value.observation.rawUnit,
    rawCurrency: value.observation.rawCurrency,
    rawCurrencyStorageScale: value.observation.rawCurrencyStorageScale,
    denominatorValue: value.observation.denominator?.value ?? null,
    denominatorKind: value.observation.denominator?.kind ?? null,
    normalizedValue: value.value,
    normalizedUnit: value.unit,
  });
}

/** Robust median/MAD/IQR comparison with independent materiality gates. */
export function compareAgainstPeers(input: {
  readonly target: NormalizedObservation;
  readonly peers: readonly NormalizedObservation[];
  readonly cohort: MetricCohort;
  readonly definition: MetricDefinition;
  readonly policy: PeerComparisonPolicy;
}): PeerComparisonResult {
  const policy = validatePolicy(input.policy);
  const policyFingerprint = stableFingerprint(policy, 'peer-comparison-policy');
  const abstain = (
    reasons: readonly PeerComparisonAbstentionReason[],
    compatiblePeerCount: number,
    exclusions: readonly PeerExclusion[],
    distribution: PeerDistribution | null = null,
    baselineStability: PeerBaselineStability | null = null,
  ): Extract<PeerComparisonResult, { readonly ok: false }> => Object.freeze({
    ok: false as const,
    status: 'abstain' as const,
    reasons: Object.freeze([...reasons]),
    minimumPeers: policy.minimumPeers,
    compatiblePeerCount,
    policyFingerprint,
    definitionFingerprint: input.target.definitionFingerprint,
    distribution,
    baselineStability,
    exclusions: Object.freeze([...exclusions]),
  });
  const { fingerprint: storedCohortFingerprint, ...cohortPayload } = input.cohort;
  const cohortFingerprintInvalid = (
    stableFingerprint(cohortPayload, 'metric-cohort') !== storedCohortFingerprint
  );
  const cohortTargetMismatch = (
    input.cohort.organizationId !== input.target.observation.organizationId
    || input.cohort.targetPropertyId !== input.target.observation.propertyId
    || input.cohort.targetProfileFingerprint !== input.target.observation.profileFingerprint
  );
  const cohortMetricMismatch = input.cohort.metricId !== input.target.observation.metricId;
  if (cohortTargetMismatch || cohortMetricMismatch || cohortFingerprintInvalid) {
    return abstain([
      ...(cohortTargetMismatch ? ['cohort_target_mismatch' as const] : []),
      ...(cohortMetricMismatch ? ['cohort_metric_mismatch' as const] : []),
      ...(cohortFingerprintInvalid ? ['cohort_fingerprint_invalid' as const] : []),
    ], 0, []);
  }
  const prepared = preparePeers(input.target, input.peers, input.definition, input.cohort);
  const hasMissingCohortMembers = prepared.exclusions.some((exclusion) => (
    exclusion.reasons.includes('cohort_member_observation_missing')
  ));
  if (hasMissingCohortMembers) {
    return abstain(
      ['cohort_members_missing'],
      prepared.included.length,
      prepared.exclusions,
    );
  }
  if (prepared.included.length < policy.minimumPeers) {
    return abstain(
      ['insufficient_compatible_peers'],
      prepared.included.length,
      prepared.exclusions,
    );
  }

  const distribution = distributionOf(prepared.included.map((peer) => peer.value));
  const baselineStability = baselineStabilityOf(distribution, policy);
  if (baselineStability.status === 'unstable') {
    return abstain(
      ['unstable_peer_baseline'],
      prepared.included.length,
      prepared.exclusions,
      distribution,
      baselineStability,
    );
  }
  const targetValue = input.target.value;
  const observedDirection: 'high' | 'low' = targetValue >= distribution.median ? 'high' : 'low';
  const directionEvaluated = policy.direction === 'two_sided' ? observedDirection : policy.direction;
  const signedDelta = directionEvaluated === 'high'
    ? targetValue - distribution.median
    : distribution.median - targetValue;
  const absoluteDelta = Math.max(0, signedDelta);
  const relativeDelta = distribution.median === 0
    ? null
    : absoluteDelta / Math.abs(distribution.median);

  if (
    distribution.median === 0
    && policy.minimumRelativeDelta > 0
    && policy.zeroMedianPolicy === 'abstain'
  ) {
    return abstain(
      ['zero_peer_baseline'],
      prepared.included.length,
      prepared.exclusions,
      distribution,
      baselineStability,
    );
  }

  const robustZ = distribution.robustScale === null
    ? null
    : (targetValue - distribution.median) / distribution.robustScale;
  const lowerFence = distribution.firstQuartile - policy.iqrFenceMultiplier * distribution.interquartileRange;
  const upperFence = distribution.thirdQuartile + policy.iqrFenceMultiplier * distribution.interquartileRange;
  const zInDirection = robustZ === null
    ? (signedDelta > 0 ? Number.POSITIVE_INFINITY : 0)
    : directionEvaluated === 'high' ? robustZ : -robustZ;
  const outsideFence = directionEvaluated === 'high' ? targetValue > upperFence : targetValue < lowerFence;
  const passesStatisticalGate = signedDelta > 0 && outsideFence && zInDirection >= policy.minimumRobustZ;
  const relativePass = policy.minimumRelativeDelta === 0
    || (relativeDelta !== null && relativeDelta >= policy.minimumRelativeDelta)
    || (relativeDelta === null && policy.zeroMedianPolicy === 'absolute_only');
  const passesMateriality = absoluteDelta >= policy.minimumAbsoluteDelta && relativePass;

  const materialityScore = Math.min(
    progress(absoluteDelta, policy.minimumAbsoluteDelta),
    relativeDelta === null
      ? (policy.zeroMedianPolicy === 'absolute_only' ? 1 : 0)
      : progress(relativeDelta, policy.minimumRelativeDelta),
  );
  const statisticalScore = Math.min(
    outsideFence ? 1 : 0,
    Number.isFinite(zInDirection) ? progress(zInDirection, policy.minimumRobustZ) : 1,
  );
  const outlierScore = Math.min(materialityScore, statisticalScore);
  const status = passesMateriality && passesStatisticalGate ? 'outlier' as const : 'not_outlier' as const;
  const peerObservationFingerprints = Object.freeze(prepared.included.map((peer) => peer.fingerprint).sort());
  const peerPropertyIds = Object.freeze(prepared.included.map((peer) => peer.observation.propertyId).sort());
  const peerValues = Object.freeze(prepared.included.map(valueEvidence));
  const payload = {
    schemaVersion: MANAGEMENT_PATTERN_COMPARISON_VERSION,
    status,
    organizationId: input.target.observation.organizationId,
    targetPropertyId: input.target.observation.propertyId,
    targetObservationFingerprint: input.target.fingerprint,
    targetEvidence: valueEvidence(input.target),
    cohortFingerprint: input.cohort.fingerprint,
    peerObservationFingerprints,
    peerPropertyIds,
    peerValues,
    policyFingerprint,
    definitionFingerprint: input.target.definitionFingerprint,
    evaluatedAt: input.target.evaluatedAt,
    directionEvaluated,
    distribution,
    baselineStability,
    targetValue,
    signedDelta,
    absoluteDelta,
    relativeDelta,
    robustZ,
    lowerFence,
    upperFence,
    passesMateriality,
    passesStatisticalGate,
    materialityScore,
    outlierScore,
    scoreKind: 'threshold_progress_not_probability' as const,
    exclusions: prepared.exclusions,
  };
  return Object.freeze({
    ok: true as const,
    comparison: Object.freeze({ ...payload, fingerprint: stableFingerprint(payload, 'peer-comparison') }),
  });
}
