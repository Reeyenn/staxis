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

export interface AvailableProfileCohortCandidate {
  readonly profile: PropertyProfileSnapshot;
  readonly eligibility: CohortEligibility;
}

/**
 * A hotel with no usable profile snapshot still belongs in a target's
 * possible-peer coverage universe. Identity fields are explicit so tenant and
 * as-of boundaries remain enforceable even though no profile can supply them.
 */
export interface UnavailableProfileCohortCandidate {
  readonly profile: null;
  readonly propertyId: string;
  readonly organizationId: string;
  readonly asOf: string;
  /** Fingerprint of the immutable source/preparation evidence for the absence. */
  readonly profileFingerprint: string;
  readonly eligibility: CohortEligibility;
}

export type CohortCandidate = AvailableProfileCohortCandidate | UnavailableProfileCohortCandidate;

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

/** Immutable proof for one target and one declared fallback rung. */
export interface CohortCoverageReceipt {
  readonly populationBasis: 'target_rung_potentially_compatible_leave_one_out_peers';
  readonly cohortPolicyVersion: string;
  readonly cohortPolicyFingerprint: string;
  readonly targetPropertyId: string;
  readonly targetProfileFingerprint: string;
  readonly level: number;
  readonly levelId: string;
  readonly activeDimensions: readonly CohortDimension[];
  readonly relaxedDimensions: readonly CohortDimension[];
  /** No known active dimension disproves membership; unknowns stay included. */
  readonly potentiallyCompatiblePeerIds: readonly string[];
  /** Every active dimension is known and matches. */
  readonly knownCompatiblePeerIds: readonly string[];
  /** Possible peers that cannot be used because at least one active dimension is unknown. */
  readonly dimensionIncompletePotentialPeerIds: readonly string[];
  /** Peers safely removed because a known active dimension mismatches. */
  readonly definitivelyMismatchedPeerIds: readonly string[];
  readonly usablePeerIds: readonly string[];
  readonly potentiallyCompatiblePeerCount: number;
  readonly knownCompatiblePeerCount: number;
  readonly dimensionIncompletePotentialPeerCount: number;
  readonly definitivelyMismatchedPeerCount: number;
  readonly usablePeerCount: number;
  readonly profileCompleteCoverageRatio: number;
  readonly effectiveCoverageRatio: number;
  readonly minimumUsableCoverageRatio: number;
  readonly fingerprint: string;
}

export interface CohortAttempt {
  readonly level: number;
  readonly levelId: string;
  readonly activeDimensions: readonly CohortDimension[];
  readonly relaxedDimensions: readonly CohortDimension[];
  /**
   * Conservative denominator: peers not disproved by a known active
   * dimension. This includes dimension-incomplete possible peers.
   */
  readonly comparablePeerIds: readonly string[];
  readonly potentiallyCompatiblePeerIds: readonly string[];
  /** Peers whose every active dimension is known and matches. */
  readonly knownCompatiblePeerIds: readonly string[];
  readonly dimensionIncompletePotentialPeerIds: readonly string[];
  readonly definitivelyMismatchedPeerIds: readonly string[];
  /** Backward-compatible alias for usablePeerIds. */
  readonly eligiblePeerIds: readonly string[];
  readonly usablePeerIds: readonly string[];
  readonly comparablePeerCount: number;
  readonly potentiallyCompatiblePeerCount: number;
  readonly knownCompatiblePeerCount: number;
  readonly dimensionIncompletePotentialPeerCount: number;
  readonly definitivelyMismatchedPeerCount: number;
  readonly usablePeerCount: number;
  /** All non-target input properties not usable at this level. */
  readonly excludedPeerCount: number;
  readonly usableCoverageRatio: number;
  readonly profileCompleteCoverageRatio: number;
  readonly effectiveCoverageRatio: number;
  readonly minimumUsableCoverageRatio: number;
  readonly coverageReceipt: CohortCoverageReceipt;
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
  readonly potentiallyCompatiblePeerCount: number;
  readonly knownCompatiblePeerCount: number;
  readonly usablePeerCount: number;
  readonly usableCoverageRatio: number;
  readonly profileCompleteCoverageRatio: number;
  readonly effectiveCoverageRatio: number;
  readonly coverageReceipt: CohortCoverageReceipt;
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
  readonly propertyId: string;
  readonly organizationId: string;
  readonly asOf: string;
  readonly profileFingerprint: string;
  readonly relationshipId: string | null;
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

function requiredCandidateIdentity(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError(`${field} must not be empty when profile is unavailable`);
  return trimmed;
}

function candidateIdentity(candidate: CohortCandidate): Pick<
  PreparedCandidate,
  'propertyId' | 'organizationId' | 'asOf' | 'profileFingerprint' | 'relationshipId'
> {
  if (candidate.profile !== null) {
    return {
      propertyId: candidate.profile.propertyId,
      organizationId: candidate.profile.organizationId,
      asOf: candidate.profile.asOf,
      profileFingerprint: candidate.profile.fingerprint,
      relationshipId: candidate.profile.relationshipId,
    };
  }
  return {
    propertyId: requiredCandidateIdentity(candidate.propertyId, 'propertyId'),
    organizationId: requiredCandidateIdentity(candidate.organizationId, 'organizationId'),
    asOf: requiredCandidateIdentity(candidate.asOf, 'asOf'),
    profileFingerprint: requiredCandidateIdentity(candidate.profileFingerprint, 'profileFingerprint'),
    relationshipId: null,
  };
}

function prepareCandidates(
  target: PropertyProfileSnapshot,
  candidates: readonly CohortCandidate[],
): readonly PreparedCandidate[] {
  const byProperty = new Map<string, CohortCandidate[]>();
  for (const candidate of candidates) {
    const propertyId = candidateIdentity(candidate).propertyId;
    const entries = byProperty.get(propertyId) ?? [];
    entries.push(candidate);
    byProperty.set(propertyId, entries);
  }

  const prepared: PreparedCandidate[] = [];
  for (const propertyId of [...byProperty.keys()].sort()) {
    const entries = byProperty.get(propertyId) ?? [];
    const signatures = new Map<string, CohortCandidate>();
    for (const entry of entries) {
      const identity = candidateIdentity(entry);
      const signature = stableFingerprint({
        propertyId: identity.propertyId,
        organizationId: identity.organizationId,
        asOf: identity.asOf,
        profileFingerprint: identity.profileFingerprint,
        eligibility: entry.eligibility,
      }, 'cohort-candidate-record');
      signatures.set(signature, entry);
    }
    // A profile fingerprint alone is not a total order for conflicting input
    // records: unavailable profiles can intentionally share one source
    // fingerprint while their tenant/as-of identity differs, and eligibility
    // can disagree for the same profile. Select by the complete canonical
    // record signature so a reversed input cannot rewrite the abstention
    // receipt or its fingerprint.
    const representative = [...signatures.entries()].sort(([left], [right]) => (
      left.localeCompare(right)
    ))[0]?.[1];
    if (representative === undefined) {
      throw new TypeError(`cohort property ${propertyId} has no candidate record`);
    }
    const identity = candidateIdentity(representative);
    const structuralReasons: CohortExclusionReason[] = [];
    const metricReasons: CohortExclusionReason[] = [];
    const auditReasons: CohortExclusionReason[] = [];
    if (signatures.size > 1) {
      structuralReasons.push({ code: 'conflicting_candidate_records' });
    } else if (entries.length > 1) {
      auditReasons.push({ code: 'duplicate_candidate_ignored' });
    }
    if (identity.propertyId === target.propertyId) {
      structuralReasons.push({ code: 'target_leave_one_out' });
    }
    if (identity.organizationId !== target.organizationId) {
      structuralReasons.push({ code: 'different_organization' });
    }
    if (identity.asOf !== target.asOf) {
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
      ...identity,
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
  knownCompatiblePeerIds: string[];
  dimensionIncompletePotentialPeerIds: string[];
  definitivelyMismatchedPeerIds: string[];
  exclusions: CohortExclusion[];
} {
  const members: CohortMember[] = [];
  // `comparablePeerIds` remains the persisted denominator field. Its v3
  // semantics are deliberately conservative: possible peers stay in it until
  // a known active dimension proves a mismatch.
  const comparablePeerIds: string[] = [];
  const knownCompatiblePeerIds: string[] = [];
  const dimensionIncompletePotentialPeerIds: string[] = [];
  const definitivelyMismatchedPeerIds: string[] = [];
  const exclusions: CohortExclusion[] = [];
  for (const item of prepared) {
    const profile = item.candidate.profile;
    const reasons = [...item.structuralReasons];
    const structurallyComparable = reasons.length === 0;
    const dimensionReasons: CohortExclusionReason[] = [];
    const matchedDimensions: Partial<Record<CohortDimension, CohortDimensionValue>> = {};
    let definitiveMismatch = false;
    if (structurallyComparable) {
      for (const rule of activeRules) {
        const targetValue = profileDimensionValue(target, rule.dimension);
        const candidateValue = profile === null
          ? null
          : profileDimensionValue(profile, rule.dimension);
        if (isMissing(targetValue)) {
          dimensionReasons.push({ code: 'target_dimension_missing', dimension: rule.dimension });
        } else if (isMissing(candidateValue)) {
          dimensionReasons.push({ code: 'candidate_dimension_missing', dimension: rule.dimension });
        } else if (!valuesMatch(targetValue, candidateValue, rule.matcher)) {
          definitiveMismatch = true;
          dimensionReasons.push({ code: 'dimension_mismatch', dimension: rule.dimension });
        } else {
          matchedDimensions[rule.dimension] = candidateValue;
        }
      }
      reasons.push(...dimensionReasons);
    }

    if (structurallyComparable && definitiveMismatch) {
      definitivelyMismatchedPeerIds.push(item.propertyId);
    } else if (structurallyComparable) {
      comparablePeerIds.push(item.propertyId);
      if (dimensionReasons.length === 0) {
        knownCompatiblePeerIds.push(item.propertyId);
      } else {
        dimensionIncompletePotentialPeerIds.push(item.propertyId);
      }
    }

    // Metric eligibility is applied only to profiles whose active dimensions
    // are all known and matching. Unknown profiles remain in the denominator,
    // but can never become usable members by implication.
    if (structurallyComparable && dimensionReasons.length === 0) {
      reasons.push(...item.metricReasons);
    }
    if (reasons.length === 0) {
      if (profile === null) throw new TypeError('unavailable profile became a cohort member');
      members.push(Object.freeze({
        propertyId: item.propertyId,
        relationshipId: item.relationshipId,
        profileFingerprint: item.profileFingerprint,
        matchedDimensions: Object.freeze(matchedDimensions),
      }));
      if (item.auditReasons.length > 0) {
        exclusions.push(Object.freeze({
          propertyId: item.propertyId,
          profileFingerprint: item.profileFingerprint,
          reasons: item.auditReasons,
        }));
      }
    } else {
      exclusions.push(Object.freeze({
        propertyId: item.propertyId,
        profileFingerprint: item.profileFingerprint,
        reasons: sortedReasons(reasons),
      }));
    }
  }
  members.sort((left, right) => left.propertyId.localeCompare(right.propertyId));
  comparablePeerIds.sort();
  knownCompatiblePeerIds.sort();
  dimensionIncompletePotentialPeerIds.sort();
  definitivelyMismatchedPeerIds.sort();
  exclusions.sort((left, right) => left.propertyId.localeCompare(right.propertyId));
  return {
    members,
    comparablePeerIds,
    knownCompatiblePeerIds,
    dimensionIncompletePotentialPeerIds,
    definitivelyMismatchedPeerIds,
    exclusions,
  };
}

function cohortCoverageReceipt(input: {
  readonly target: PropertyProfileSnapshot;
  readonly cohortPolicyVersion: string;
  readonly cohortPolicyFingerprint: string;
  readonly level: number;
  readonly levelId: string;
  readonly activeDimensions: readonly CohortDimension[];
  readonly relaxedDimensions: readonly CohortDimension[];
  readonly potentiallyCompatiblePeerIds: readonly string[];
  readonly knownCompatiblePeerIds: readonly string[];
  readonly dimensionIncompletePotentialPeerIds: readonly string[];
  readonly definitivelyMismatchedPeerIds: readonly string[];
  readonly usablePeerIds: readonly string[];
  readonly minimumUsableCoverageRatio: number;
}): CohortCoverageReceipt {
  const potentiallyCompatiblePeerCount = input.potentiallyCompatiblePeerIds.length;
  const knownCompatiblePeerCount = input.knownCompatiblePeerIds.length;
  const usablePeerCount = input.usablePeerIds.length;
  const profileCompleteCoverageRatio = potentiallyCompatiblePeerCount === 0
    ? 0
    : knownCompatiblePeerCount / potentiallyCompatiblePeerCount;
  const effectiveCoverageRatio = potentiallyCompatiblePeerCount === 0
    ? 0
    : usablePeerCount / potentiallyCompatiblePeerCount;
  const payload = {
    populationBasis: 'target_rung_potentially_compatible_leave_one_out_peers' as const,
    cohortPolicyVersion: input.cohortPolicyVersion,
    cohortPolicyFingerprint: input.cohortPolicyFingerprint,
    targetPropertyId: input.target.propertyId,
    targetProfileFingerprint: input.target.fingerprint,
    level: input.level,
    levelId: input.levelId,
    activeDimensions: Object.freeze([...input.activeDimensions]),
    relaxedDimensions: Object.freeze([...input.relaxedDimensions]),
    potentiallyCompatiblePeerIds: Object.freeze([...input.potentiallyCompatiblePeerIds]),
    knownCompatiblePeerIds: Object.freeze([...input.knownCompatiblePeerIds]),
    dimensionIncompletePotentialPeerIds: Object.freeze([
      ...input.dimensionIncompletePotentialPeerIds,
    ]),
    definitivelyMismatchedPeerIds: Object.freeze([...input.definitivelyMismatchedPeerIds]),
    usablePeerIds: Object.freeze([...input.usablePeerIds]),
    potentiallyCompatiblePeerCount,
    knownCompatiblePeerCount,
    dimensionIncompletePotentialPeerCount: input.dimensionIncompletePotentialPeerIds.length,
    definitivelyMismatchedPeerCount: input.definitivelyMismatchedPeerIds.length,
    usablePeerCount,
    profileCompleteCoverageRatio,
    effectiveCoverageRatio,
    minimumUsableCoverageRatio: input.minimumUsableCoverageRatio,
  };
  return Object.freeze({
    ...payload,
    fingerprint: stableFingerprint(payload, 'target-rung-cohort-coverage'),
  });
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
    const knownCompatiblePeerCount = evaluation.knownCompatiblePeerIds.length;
    const usablePeerCount = usablePeerIds.length;
    const usableCoverageRatio = comparablePeerCount === 0
      ? 0
      : usablePeerCount / comparablePeerCount;
    const profileCompleteCoverageRatio = comparablePeerCount === 0
      ? 0
      : knownCompatiblePeerCount / comparablePeerCount;
    const coverageReceipt = cohortCoverageReceipt({
      target: input.target,
      cohortPolicyVersion: policy.policyVersion,
      cohortPolicyFingerprint: policyFingerprint,
      level,
      levelId,
      activeDimensions: activeRules.map((rule) => rule.dimension),
      relaxedDimensions,
      potentiallyCompatiblePeerIds: evaluation.comparablePeerIds,
      knownCompatiblePeerIds: evaluation.knownCompatiblePeerIds,
      dimensionIncompletePotentialPeerIds: evaluation.dimensionIncompletePotentialPeerIds,
      definitivelyMismatchedPeerIds: evaluation.definitivelyMismatchedPeerIds,
      usablePeerIds,
      minimumUsableCoverageRatio: policy.minimumUsableCoverageRatio,
    });
    const nonTargetPropertyCount = prepared.filter((item) => (
      item.propertyId !== input.target.propertyId
    )).length;
    attempts.push(Object.freeze({
      level,
      levelId,
      activeDimensions: Object.freeze(activeRules.map((rule) => rule.dimension)),
      relaxedDimensions: Object.freeze([...relaxedDimensions]),
      comparablePeerIds: Object.freeze(evaluation.comparablePeerIds),
      potentiallyCompatiblePeerIds: Object.freeze(evaluation.comparablePeerIds),
      knownCompatiblePeerIds: Object.freeze(evaluation.knownCompatiblePeerIds),
      dimensionIncompletePotentialPeerIds: Object.freeze(
        evaluation.dimensionIncompletePotentialPeerIds,
      ),
      definitivelyMismatchedPeerIds: Object.freeze(evaluation.definitivelyMismatchedPeerIds),
      eligiblePeerIds: Object.freeze(usablePeerIds),
      usablePeerIds: Object.freeze(usablePeerIds),
      comparablePeerCount,
      potentiallyCompatiblePeerCount: comparablePeerCount,
      knownCompatiblePeerCount,
      dimensionIncompletePotentialPeerCount:
        evaluation.dimensionIncompletePotentialPeerIds.length,
      definitivelyMismatchedPeerCount: evaluation.definitivelyMismatchedPeerIds.length,
      usablePeerCount,
      excludedPeerCount: Math.max(0, nonTargetPropertyCount - usablePeerCount),
      usableCoverageRatio,
      profileCompleteCoverageRatio,
      effectiveCoverageRatio: usableCoverageRatio,
      minimumUsableCoverageRatio: policy.minimumUsableCoverageRatio,
      coverageReceipt,
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
    potentiallyCompatiblePeerCount: selectedAttempt.potentiallyCompatiblePeerCount,
    knownCompatiblePeerCount: selectedAttempt.knownCompatiblePeerCount,
    usablePeerCount: selectedAttempt.usablePeerCount,
    usableCoverageRatio: selectedAttempt.usableCoverageRatio,
    profileCompleteCoverageRatio: selectedAttempt.profileCompleteCoverageRatio,
    effectiveCoverageRatio: selectedAttempt.effectiveCoverageRatio,
    coverageReceipt: selectedAttempt.coverageReceipt,
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
