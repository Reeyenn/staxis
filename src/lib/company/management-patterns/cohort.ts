import { stableFingerprint, stableSerialize } from './canonical';
import {
  profileDimensionValue,
  type CohortDimension,
  type CohortDimensionValue,
  type PropertyProfileSnapshot,
} from './profile';
import {
  DEFAULT_MINIMUM_COHORT_PEERS,
  DEFAULT_MINIMUM_USABLE_COHORT_COVERAGE_RATIO,
  MANAGEMENT_PATTERN_COHORT_VERSION,
} from './versions';

export type CohortDimensionMatcher = 'exact' | 'target_tags_subset';

export interface CohortDimensionRule {
  /** Rules are declared in descending importance. */
  readonly dimension: CohortDimension;
  readonly matcher: CohortDimensionMatcher;
  readonly relaxable: boolean;
}

export interface MetricCohortPolicy {
  readonly metricId: string;
  readonly policyVersion: string;
  readonly dimensions: readonly CohortDimensionRule[];
  /** Least-defensible dimensions first; each is dropped at most once. */
  readonly fallbackOrder: readonly CohortDimension[];
  readonly minimumPeers?: number;
  /** Minimum usable share of every dimension-compatible population. */
  readonly minimumUsableCoverageRatio?: number;
  /** Must be explicit before the final fallback is allowed to match every org hotel. */
  readonly allowOrganizationWideFallback?: boolean;
}

export type CohortEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reasons: readonly string[] };

export interface CohortCandidate {
  readonly profile: PropertyProfileSnapshot;
  readonly eligibility: CohortEligibility;
}

export type CohortExclusionCode =
  | 'target_leave_one_out'
  | 'different_organization'
  | 'profile_as_of_mismatch'
  | 'metric_ineligible'
  | 'duplicate_candidate_ignored'
  | 'conflicting_candidate_records'
  | 'target_dimension_missing'
  | 'candidate_dimension_missing'
  | 'dimension_mismatch';

export interface CohortExclusionReason {
  readonly code: CohortExclusionCode;
  readonly dimension?: CohortDimension;
  readonly details?: readonly string[];
}

export interface CohortExclusion {
  readonly propertyId: string;
  readonly profileFingerprint: string;
  readonly reasons: readonly CohortExclusionReason[];
}

export interface CohortMember {
  readonly propertyId: string;
  readonly relationshipId: string | null;
  readonly profileFingerprint: string;
  readonly matchedDimensions: Readonly<Partial<Record<CohortDimension, CohortDimensionValue>>>;
}

export interface CohortAttempt {
  readonly level: number;
  readonly levelId: string;
  readonly activeDimensions: readonly CohortDimension[];
  readonly relaxedDimensions: readonly CohortDimension[];
  /** Peers matching this level's dimensions, including metric-ineligible peers. */
  readonly comparablePeerIds: readonly string[];
  /** Backward-compatible alias for usablePeerIds. */
  readonly eligiblePeerIds: readonly string[];
  readonly usablePeerIds: readonly string[];
  readonly comparablePeerCount: number;
  readonly usablePeerCount: number;
  /** All non-target input properties not usable at this level. */
  readonly excludedPeerCount: number;
  readonly usableCoverageRatio: number;
  readonly minimumUsableCoverageRatio: number;
  /** Backward-compatible alias for usablePeerCount. */
  readonly peerCount: number;
}

export interface MetricCohort {
  readonly schemaVersion: typeof MANAGEMENT_PATTERN_COHORT_VERSION;
  /** Persistence-ready status; fallback is never hidden behind a formed result. */
  readonly status: 'ready' | 'fallback';
  readonly organizationId: string;
  readonly metricId: string;
  readonly targetPropertyId: string;
  readonly targetProfileFingerprint: string;
  readonly asOf: string;
  readonly policyFingerprint: string;
  readonly selectedLevel: number;
  readonly selectedLevelId: string;
  readonly activeDimensions: readonly CohortDimension[];
  readonly relaxedDimensions: readonly CohortDimension[];
  readonly minimumPeers: number;
  readonly minimumUsableCoverageRatio: number;
  readonly comparablePeerCount: number;
  readonly usablePeerCount: number;
  readonly usableCoverageRatio: number;
  readonly members: readonly CohortMember[];
  readonly exclusions: readonly CohortExclusion[];
  readonly attempts: readonly CohortAttempt[];
  readonly fingerprint: string;
}

/**
 * A first-class, immutable receipt for a cohort that could not be formed.  It
 * deliberately has the same persistence-facing status vocabulary as
 * `management_pattern_cohorts`, so sparse cohorts do not disappear into an
 * opaque check-outcome JSON blob.
 */
export interface MetricCohortAbstention {
  readonly schemaVersion: typeof MANAGEMENT_PATTERN_COHORT_VERSION;
  readonly status: 'abstained';
  readonly reason: 'insufficient_peers' | 'insufficient_usable_coverage';
  readonly organizationId: string;
  readonly metricId: string;
  readonly targetPropertyId: string;
  readonly targetProfileFingerprint: string;
  readonly asOf: string;
  readonly minimumPeers: number;
  readonly minimumUsableCoverageRatio: number;
  readonly policyFingerprint: string;
  readonly finalLevel: number;
  readonly finalLevelId: string;
  readonly activeDimensions: readonly CohortDimension[];
  readonly relaxedDimensions: readonly CohortDimension[];
  readonly members: readonly CohortMember[];
  readonly exclusions: readonly CohortExclusion[];
  readonly attempts: readonly CohortAttempt[];
  readonly fingerprint: string;
}

export type MetricCohortDecision = MetricCohort | MetricCohortAbstention;

export type MetricCohortResult =
  | { readonly ok: true; readonly status: 'formed'; readonly cohort: MetricCohort }
  | {
    readonly ok: false;
    readonly status: 'abstain';
    readonly reason: 'insufficient_peers' | 'insufficient_usable_coverage';
    readonly organizationId: string;
    readonly metricId: string;
    readonly targetPropertyId: string;
    readonly minimumPeers: number;
    readonly minimumUsableCoverageRatio: number;
    readonly attempts: readonly CohortAttempt[];
    readonly exclusions: readonly CohortExclusion[];
    readonly policyFingerprint: string;
    readonly receipt: MetricCohortAbstention;
  };

interface ValidatedPolicy {
  readonly metricId: string;
  readonly policyVersion: string;
  readonly dimensions: readonly CohortDimensionRule[];
  readonly fallbackOrder: readonly CohortDimension[];
  readonly minimumPeers: number;
  readonly minimumUsableCoverageRatio: number;
  readonly allowOrganizationWideFallback: boolean;
}

interface PreparedCandidate {
  readonly candidate: CohortCandidate;
  /** Identity/tenant/snapshot failures that make dimensional comparison invalid. */
  readonly structuralReasons: readonly CohortExclusionReason[];
  /** Data-quality failures counted in the comparable-population coverage gate. */
  readonly metricReasons: readonly CohortExclusionReason[];
  readonly auditReasons: readonly CohortExclusionReason[];
}

function validatePolicy(policy: MetricCohortPolicy): ValidatedPolicy {
  const metricId = policy.metricId.trim();
  const policyVersion = policy.policyVersion.trim();
  if (!metricId || !policyVersion) throw new TypeError('cohort policy identifiers must not be empty');
  const minimumPeers = policy.minimumPeers ?? DEFAULT_MINIMUM_COHORT_PEERS;
  if (!Number.isInteger(minimumPeers) || minimumPeers < 2) {
    throw new TypeError('minimumPeers must be an integer of at least 2');
  }
  const minimumUsableCoverageRatio = policy.minimumUsableCoverageRatio
    ?? DEFAULT_MINIMUM_USABLE_COHORT_COVERAGE_RATIO;
  if (
    !Number.isFinite(minimumUsableCoverageRatio)
    || minimumUsableCoverageRatio <= 0
    || minimumUsableCoverageRatio > 1
  ) {
    throw new TypeError('minimumUsableCoverageRatio must be greater than 0 and at most 1');
  }
  const dimensions = [...policy.dimensions];
  const names = dimensions.map((rule) => rule.dimension);
  if (new Set(names).size !== names.length) throw new TypeError('cohort dimensions must be unique');
  for (const rule of dimensions) {
    if (rule.matcher === 'target_tags_subset' && rule.dimension !== 'amenityTags') {
      throw new TypeError('target_tags_subset is only valid for amenityTags');
    }
  }
  const fallbackOrder = [...policy.fallbackOrder];
  if (new Set(fallbackOrder).size !== fallbackOrder.length) throw new TypeError('fallbackOrder must be unique');
  let previousPriorityIndex = Number.POSITIVE_INFINITY;
  for (const dimension of fallbackOrder) {
    const index = dimensions.findIndex((rule) => rule.dimension === dimension);
    if (index < 0) throw new TypeError(`fallback dimension ${dimension} has no declared rule`);
    if (!dimensions[index].relaxable) throw new TypeError(`fallback dimension ${dimension} is not relaxable`);
    if (index >= previousPriorityIndex) {
      throw new TypeError('fallbackOrder must remove lower-priority dimensions before higher-priority dimensions');
    }
    previousPriorityIndex = index;
  }
  const remainingCount = dimensions.length - fallbackOrder.length;
  if (remainingCount === 0 && !policy.allowOrganizationWideFallback) {
    throw new TypeError('dropping every dimension requires allowOrganizationWideFallback');
  }
  return Object.freeze({
    metricId,
    policyVersion,
    dimensions: Object.freeze(dimensions),
    fallbackOrder: Object.freeze(fallbackOrder),
    minimumPeers,
    minimumUsableCoverageRatio,
    allowOrganizationWideFallback: policy.allowOrganizationWideFallback === true,
  });
}

export function metricCohortPolicyFingerprint(policy: MetricCohortPolicy): string {
  return stableFingerprint(validatePolicy(policy), 'metric-cohort-policy');
}

function valuesMatch(
  target: CohortDimensionValue,
  candidate: CohortDimensionValue,
  matcher: CohortDimensionMatcher,
): boolean {
  if (matcher === 'exact') return stableSerialize(target) === stableSerialize(candidate);
  const targetTags = target as readonly string[];
  const candidateTags = new Set(candidate as readonly string[]);
  return targetTags.every((tag) => candidateTags.has(tag));
}

function isMissing(value: CohortDimensionValue): boolean {
  return value === null;
}

function sortedReasons(reasons: readonly CohortExclusionReason[]): readonly CohortExclusionReason[] {
  return Object.freeze([...reasons].sort((left, right) => {
    const leftKey = `${left.code}:${left.dimension ?? ''}:${(left.details ?? []).join(',')}`;
    const rightKey = `${right.code}:${right.dimension ?? ''}:${(right.details ?? []).join(',')}`;
    return leftKey.localeCompare(rightKey);
  }));
}

function prepareCandidates(
  target: PropertyProfileSnapshot,
  candidates: readonly CohortCandidate[],
): readonly PreparedCandidate[] {
  const byProperty = new Map<string, CohortCandidate[]>();
  for (const candidate of candidates) {
    const entries = byProperty.get(candidate.profile.propertyId) ?? [];
    entries.push(candidate);
    byProperty.set(candidate.profile.propertyId, entries);
  }

  const prepared: PreparedCandidate[] = [];
  for (const propertyId of [...byProperty.keys()].sort()) {
    const entries = byProperty.get(propertyId) ?? [];
    const signatures = new Map<string, CohortCandidate>();
    for (const entry of entries) {
      const signature = stableFingerprint({
        profileFingerprint: entry.profile.fingerprint,
        eligibility: entry.eligibility,
      }, 'cohort-candidate-record');
      signatures.set(signature, entry);
    }
    const representative = [...signatures.values()].sort((left, right) => (
      left.profile.fingerprint.localeCompare(right.profile.fingerprint)
    ))[0];
    const structuralReasons: CohortExclusionReason[] = [];
    const metricReasons: CohortExclusionReason[] = [];
    const auditReasons: CohortExclusionReason[] = [];
    if (signatures.size > 1) {
      structuralReasons.push({ code: 'conflicting_candidate_records' });
    } else if (entries.length > 1) {
      auditReasons.push({ code: 'duplicate_candidate_ignored' });
    }
    if (representative.profile.propertyId === target.propertyId) {
      structuralReasons.push({ code: 'target_leave_one_out' });
    }
    if (representative.profile.organizationId !== target.organizationId) {
      structuralReasons.push({ code: 'different_organization' });
    }
    if (representative.profile.asOf !== target.asOf) {
      structuralReasons.push({ code: 'profile_as_of_mismatch' });
    }
    if (!representative.eligibility.eligible) {
      metricReasons.push({
        code: 'metric_ineligible',
        details: Object.freeze([...new Set(representative.eligibility.reasons)].sort()),
      });
    }
    prepared.push(Object.freeze({
      candidate: representative,
      structuralReasons: sortedReasons(structuralReasons),
      metricReasons: sortedReasons(metricReasons),
      auditReasons: sortedReasons(auditReasons),
    }));
  }
  return Object.freeze(prepared);
}

function evaluateLevel(
  target: PropertyProfileSnapshot,
  prepared: readonly PreparedCandidate[],
  activeRules: readonly CohortDimensionRule[],
): {
  members: CohortMember[];
  comparablePeerIds: string[];
  exclusions: CohortExclusion[];
} {
  const members: CohortMember[] = [];
  const comparablePeerIds: string[] = [];
  const exclusions: CohortExclusion[] = [];
  for (const item of prepared) {
    const profile = item.candidate.profile;
    const reasons = [...item.structuralReasons];
    const matchedDimensions: Partial<Record<CohortDimension, CohortDimensionValue>> = {};
    if (reasons.length === 0) {
      for (const rule of activeRules) {
        const targetValue = profileDimensionValue(target, rule.dimension);
        const candidateValue = profileDimensionValue(profile, rule.dimension);
        if (isMissing(targetValue)) {
          reasons.push({ code: 'target_dimension_missing', dimension: rule.dimension });
        } else if (isMissing(candidateValue)) {
          reasons.push({ code: 'candidate_dimension_missing', dimension: rule.dimension });
        } else if (!valuesMatch(targetValue, candidateValue, rule.matcher)) {
          reasons.push({ code: 'dimension_mismatch', dimension: rule.dimension });
        } else {
          matchedDimensions[rule.dimension] = candidateValue;
        }
      }
    }
    // Metric eligibility is intentionally applied only after dimensional
    // compatibility. Otherwise a sparse usable subset can masquerade as full
    // cohort coverage (for example, 5 usable hotels out of 20 fair peers).
    if (reasons.length === 0) {
      comparablePeerIds.push(profile.propertyId);
      reasons.push(...item.metricReasons);
    }
    if (reasons.length === 0) {
      members.push(Object.freeze({
        propertyId: profile.propertyId,
        relationshipId: profile.relationshipId,
        profileFingerprint: profile.fingerprint,
        matchedDimensions: Object.freeze(matchedDimensions),
      }));
      if (item.auditReasons.length > 0) {
        exclusions.push(Object.freeze({
          propertyId: profile.propertyId,
          profileFingerprint: profile.fingerprint,
          reasons: item.auditReasons,
        }));
      }
    } else {
      exclusions.push(Object.freeze({
        propertyId: profile.propertyId,
        profileFingerprint: profile.fingerprint,
        reasons: sortedReasons(reasons),
      }));
    }
  }
  members.sort((left, right) => left.propertyId.localeCompare(right.propertyId));
  comparablePeerIds.sort();
  exclusions.sort((left, right) => left.propertyId.localeCompare(right.propertyId));
  return { members, comparablePeerIds, exclusions };
}

export function buildMetricCohort(input: {
  readonly target: PropertyProfileSnapshot;
  readonly candidates: readonly CohortCandidate[];
  readonly policy: MetricCohortPolicy;
}): MetricCohortResult {
  const policy = validatePolicy(input.policy);
  const policyFingerprint = stableFingerprint(policy, 'metric-cohort-policy');
  const prepared = prepareCandidates(input.target, input.candidates);
  const attempts: CohortAttempt[] = [];
  let selected: {
    level: number;
    activeRules: readonly CohortDimensionRule[];
    relaxedDimensions: readonly CohortDimension[];
    members: CohortMember[];
    exclusions: CohortExclusion[];
  } | null = null;
  let lastMembers: CohortMember[] = [];
  let lastExclusions: CohortExclusion[] = [];

  const relaxedDimensions: CohortDimension[] = [];
  for (let level = 0; level <= policy.fallbackOrder.length; level += 1) {
    if (level > 0) relaxedDimensions.push(policy.fallbackOrder[level - 1]);
    const relaxed = new Set(relaxedDimensions);
    const activeRules = policy.dimensions.filter((rule) => !relaxed.has(rule.dimension));
    const evaluation = evaluateLevel(input.target, prepared, activeRules);
    const levelId = level === 0 ? 'exact' : `fallback:${relaxedDimensions.join('+')}`;
    const usablePeerIds = evaluation.members.map((member) => member.propertyId);
    const comparablePeerCount = evaluation.comparablePeerIds.length;
    const usablePeerCount = usablePeerIds.length;
    const usableCoverageRatio = comparablePeerCount === 0
      ? 0
      : usablePeerCount / comparablePeerCount;
    const nonTargetPropertyCount = prepared.filter((item) => (
      item.candidate.profile.propertyId !== input.target.propertyId
    )).length;
    attempts.push(Object.freeze({
      level,
      levelId,
      activeDimensions: Object.freeze(activeRules.map((rule) => rule.dimension)),
      relaxedDimensions: Object.freeze([...relaxedDimensions]),
      comparablePeerIds: Object.freeze(evaluation.comparablePeerIds),
      eligiblePeerIds: Object.freeze(usablePeerIds),
      usablePeerIds: Object.freeze(usablePeerIds),
      comparablePeerCount,
      usablePeerCount,
      excludedPeerCount: Math.max(0, nonTargetPropertyCount - usablePeerCount),
      usableCoverageRatio,
      minimumUsableCoverageRatio: policy.minimumUsableCoverageRatio,
      peerCount: usablePeerCount,
    }));
    lastMembers = evaluation.members;
    lastExclusions = evaluation.exclusions;
    if (
      usablePeerCount >= policy.minimumPeers
      && usableCoverageRatio >= policy.minimumUsableCoverageRatio
    ) {
      selected = {
        level,
        activeRules,
        relaxedDimensions: [...relaxedDimensions],
        members: evaluation.members,
        exclusions: evaluation.exclusions,
      };
      break;
    }
  }

  const frozenAttempts = Object.freeze(attempts);
  if (selected === null) {
    const finalAttempt = attempts.at(-1);
    if (!finalAttempt) throw new TypeError('cohort policy produced no evaluation levels');
    const abstentionReason = finalAttempt.usablePeerCount >= policy.minimumPeers
      ? 'insufficient_usable_coverage' as const
      : 'insufficient_peers' as const;
    const receiptPayload = {
      schemaVersion: MANAGEMENT_PATTERN_COHORT_VERSION,
      status: 'abstained' as const,
      reason: abstentionReason,
      organizationId: input.target.organizationId,
      metricId: policy.metricId,
      targetPropertyId: input.target.propertyId,
      targetProfileFingerprint: input.target.fingerprint,
      asOf: input.target.asOf,
      minimumPeers: policy.minimumPeers,
      minimumUsableCoverageRatio: policy.minimumUsableCoverageRatio,
      policyFingerprint,
      finalLevel: finalAttempt.level,
      finalLevelId: finalAttempt.levelId,
      activeDimensions: finalAttempt.activeDimensions,
      relaxedDimensions: finalAttempt.relaxedDimensions,
      // The final attempted membership is retained even though it was too
      // small; persistence may record these as excluded by viability policy.
      members: Object.freeze(lastMembers),
      exclusions: Object.freeze(lastExclusions),
      attempts: frozenAttempts,
    };
    const receipt = Object.freeze({
      ...receiptPayload,
      fingerprint: stableFingerprint(receiptPayload, 'metric-cohort-abstention'),
    });
    return Object.freeze({
      ok: false as const,
      status: 'abstain' as const,
      reason: abstentionReason,
      organizationId: input.target.organizationId,
      metricId: policy.metricId,
      targetPropertyId: input.target.propertyId,
      minimumPeers: policy.minimumPeers,
      minimumUsableCoverageRatio: policy.minimumUsableCoverageRatio,
      attempts: frozenAttempts,
      exclusions: Object.freeze(lastExclusions),
      policyFingerprint,
      receipt,
    });
  }

  const selectedAttempt = attempts[selected.level];
  const payload = {
    schemaVersion: MANAGEMENT_PATTERN_COHORT_VERSION,
    status: selected.level === 0 ? 'ready' as const : 'fallback' as const,
    organizationId: input.target.organizationId,
    metricId: policy.metricId,
    targetPropertyId: input.target.propertyId,
    targetProfileFingerprint: input.target.fingerprint,
    asOf: input.target.asOf,
    policyFingerprint,
    selectedLevel: selected.level,
    selectedLevelId: selectedAttempt.levelId,
    activeDimensions: selected.activeRules.map((rule) => rule.dimension),
    relaxedDimensions: selected.relaxedDimensions,
    minimumPeers: policy.minimumPeers,
    minimumUsableCoverageRatio: policy.minimumUsableCoverageRatio,
    comparablePeerCount: selectedAttempt.comparablePeerCount,
    usablePeerCount: selectedAttempt.usablePeerCount,
    usableCoverageRatio: selectedAttempt.usableCoverageRatio,
    members: selected.members,
    exclusions: selected.exclusions,
    attempts,
  };
  return Object.freeze({
    ok: true as const,
    status: 'formed' as const,
    cohort: Object.freeze({ ...payload, fingerprint: stableFingerprint(payload, 'metric-cohort') }),
  });
}
