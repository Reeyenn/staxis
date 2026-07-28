import { stableFingerprint } from './canonical';
import { MANAGEMENT_PATTERN_SCOPE_VERSION } from './versions';

export type PatternScope = 'property_local' | 'peer_cohort' | 'group_region' | 'company_wide';
export type PatternEvidenceBasis = 'property_only' | 'peer_comparison' | 'cross_property_condition';

/** What a caller asked for. This never determines evidence scope. */
export type PatternQueryScope =
  | { readonly kind: 'all_hotels' }
  | { readonly kind: 'selected_hotels'; readonly propertyIds: readonly string[] }
  | { readonly kind: 'single_hotel'; readonly propertyId: string };

/** What a viewer may read. This filters output; it never changes evidence scope. */
export type PatternAccessScope =
  | { readonly kind: 'organization'; readonly organizationId: string }
  | { readonly kind: 'portfolio'; readonly portfolioIds: readonly string[] }
  | { readonly kind: 'property'; readonly propertyIds: readonly string[] };

export interface ScopeGroupSnapshot {
  readonly groupId: string;
  readonly kind: 'region' | 'portfolio' | 'operating_group';
  readonly snapshotFingerprint: string;
  readonly propertyIds: readonly string[];
}

export interface PeerCohortScopeEvidence {
  readonly cohortFingerprint: string;
  readonly targetPropertyId: string;
  readonly peerPropertyIds: readonly string[];
}

export interface ScopeClassifierInput {
  readonly organizationId: string;
  readonly rootKey: string;
  readonly evidenceBasis: PatternEvidenceBasis;
  /** As-of organization membership, not the viewer's grant. */
  readonly eligibleOrganizationPropertyIds: readonly string[];
  /** Properties for which the check produced usable evidence. */
  readonly evaluatedPropertyIds: readonly string[];
  readonly affectedPropertyIds: readonly string[];
  readonly groups?: readonly ScopeGroupSnapshot[];
  readonly peerCohort?: PeerCohortScopeEvidence | null;
  readonly peerCohorts?: readonly PeerCohortScopeEvidence[];
  /** Evidence coverage and prevalence are intentionally independent gates. */
  readonly minimumCompanyEvidenceCoverageRatio?: number;
  readonly minimumCompanyAffectedShare?: number;
  readonly minimumCompanyAffectedProperties?: number;
  /** Required only when prevalence is below 100%. */
  readonly minimumDistinctGroupsForCompany?: number;
  readonly minimumGroupEvidenceCoverageRatio?: number;
  readonly minimumGroupAffectedShare?: number;
  readonly minimumGroupAffectedProperties?: number;
  /** Echoed for audit only and deliberately omitted from classification identity. */
  readonly queryScope?: PatternQueryScope | null;
  /** Echoed for audit only and deliberately omitted from classification identity. */
  readonly accessScope?: PatternAccessScope | null;
}

export type ScopeAbstentionReason =
  | 'no_eligible_properties'
  | 'no_affected_properties'
  | 'affected_outside_eligible_universe'
  | 'evaluated_outside_eligible_universe'
  | 'affected_without_evidence'
  | 'peer_cohort_evidence_invalid'
  | 'ambiguous_multi_property_scope';

export interface ScopeThresholdReceipt {
  readonly minimumCompanyEvidenceCoverageRatio: number;
  readonly minimumCompanyAffectedShare: number;
  readonly minimumCompanyAffectedProperties: number;
  readonly minimumDistinctGroupsForCompany: number;
  readonly minimumGroupEvidenceCoverageRatio: number;
  readonly minimumGroupAffectedShare: number;
  readonly minimumGroupAffectedProperties: number;
}

export interface CompanyDistributionEvidence {
  readonly kind: ScopeGroupSnapshot['kind'];
  readonly groupIds: readonly string[];
  readonly groupSnapshotFingerprints: readonly string[];
  readonly affectedMemberships: readonly {
    readonly propertyId: string;
    readonly groupId: string;
  }[];
}

export interface ScopeClassification {
  readonly schemaVersion: typeof MANAGEMENT_PATTERN_SCOPE_VERSION;
  readonly organizationId: string;
  readonly rootKey: string;
  readonly scope: PatternScope;
  readonly evidenceBasis: PatternEvidenceBasis;
  readonly eligiblePropertyIds: readonly string[];
  readonly evaluatedPropertyIds: readonly string[];
  readonly affectedPropertyIds: readonly string[];
  /** Retained as a compatibility alias for evidence coverage. */
  readonly organizationCoverageRatio: number;
  readonly organizationEvidenceCoverageRatio: number;
  readonly organizationAffectedShare: number;
  readonly thresholds: ScopeThresholdReceipt;
  readonly companyDistribution: CompanyDistributionEvidence | null;
  readonly matchedGroup: {
    readonly groupId: string;
    readonly kind: ScopeGroupSnapshot['kind'];
    readonly snapshotFingerprint: string;
    readonly coverageRatio: number;
    readonly evidenceCoverageRatio: number;
    readonly affectedShare: number;
    readonly eligiblePropertyCount: number;
    readonly evaluatedPropertyCount: number;
    readonly affectedPropertyCount: number;
  } | null;
  readonly cohortFingerprint: string | null;
  readonly cohortFingerprints: readonly string[];
  readonly queryScope: PatternQueryScope | null;
  readonly accessScope: PatternAccessScope | null;
  /** Excludes query/access scope, so permissions cannot rewrite evidence truth. */
  readonly fingerprint: string;
}

export type ScopeClassificationResult =
  | { readonly ok: true; readonly classification: ScopeClassification }
  | {
    readonly ok: false;
    readonly status: 'abstain';
    readonly reasons: readonly ScopeAbstentionReason[];
    readonly organizationId: string;
    readonly rootKey: string;
    readonly queryScope: PatternQueryScope | null;
    readonly accessScope: PatternAccessScope | null;
  };

function nonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError(`${field} must not be empty`);
  return trimmed;
}

function stableIds(values: readonly string[], field: string): readonly string[] {
  return Object.freeze([...new Set(values.map((value) => nonEmpty(value, field)))].sort());
}

function ratio(value: number | undefined, fallback: number, field: string): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result <= 0 || result > 1) {
    throw new TypeError(`${field} must be greater than 0 and at most 1`);
  }
  return result;
}

function count(value: number | undefined, fallback: number, field: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 2) {
    throw new TypeError(`${field} must be an integer of at least 2`);
  }
  return result;
}

function intersection(left: readonly string[], right: readonly string[]): readonly string[] {
  const rightSet = new Set(right);
  return Object.freeze(left.filter((value) => rightSet.has(value)).sort());
}

function isSubset(values: readonly string[], universe: readonly string[]): boolean {
  const universeSet = new Set(universe);
  return values.every((value) => universeSet.has(value));
}

function canonicalGroups(
  groups: readonly ScopeGroupSnapshot[],
  eligiblePropertyIds: readonly string[],
): readonly ScopeGroupSnapshot[] {
  const seen = new Set<string>();
  return Object.freeze(groups.map((group) => {
    const groupId = nonEmpty(group.groupId, 'groups.groupId');
    if (seen.has(groupId)) throw new TypeError(`duplicate scope group ${groupId}`);
    seen.add(groupId);
    if (!['region', 'portfolio', 'operating_group'].includes(group.kind)) {
      throw new TypeError(`unsupported scope group kind ${String(group.kind)}`);
    }
    return Object.freeze({
      groupId,
      kind: group.kind,
      snapshotFingerprint: nonEmpty(group.snapshotFingerprint, 'groups.snapshotFingerprint'),
      // A group snapshot cannot enlarge the organization universe supplied by
      // the organization-scoped query boundary.
      propertyIds: intersection(stableIds(group.propertyIds, 'groups.propertyIds'), eligiblePropertyIds),
    });
  }).sort((left, right) => left.kind.localeCompare(right.kind) || left.groupId.localeCompare(right.groupId)));
}

function companyDistribution(
  groups: readonly ScopeGroupSnapshot[],
  affectedPropertyIds: readonly string[],
  minimumDistinctGroups: number,
): CompanyDistributionEvidence | null {
  const kindOrder: readonly ScopeGroupSnapshot['kind'][] = ['region', 'portfolio', 'operating_group'];
  for (const kind of kindOrder) {
    const sameKind = groups.filter((group) => group.kind === kind);
    const affectedMemberships = affectedPropertyIds.map((propertyId) => ({
      propertyId,
      groups: sameKind.filter((group) => group.propertyIds.includes(propertyId)),
    }));
    // Ambiguous overlapping assignments cannot manufacture distribution.
    if (affectedMemberships.some((membership) => membership.groups.length !== 1)) continue;
    const usedGroups = [...new Map(affectedMemberships.map((membership) => {
      const group = membership.groups[0];
      return [group.groupId, group] as const;
    })).values()].sort((left, right) => left.groupId.localeCompare(right.groupId));
    if (usedGroups.length < minimumDistinctGroups) continue;
    return Object.freeze({
      kind,
      groupIds: Object.freeze(usedGroups.map((group) => group.groupId)),
      groupSnapshotFingerprints: Object.freeze(usedGroups.map((group) => group.snapshotFingerprint).sort()),
      affectedMemberships: Object.freeze(affectedMemberships.map((membership) => Object.freeze({
        propertyId: membership.propertyId,
        groupId: membership.groups[0].groupId,
      })).sort((left, right) => left.propertyId.localeCompare(right.propertyId))),
    });
  }
  return null;
}

/**
 * Classify only what the evidence proves. Query breadth and viewer grants are
 * carried beside the result for audit, but cannot promote or demote scope.
 */
export function classifyPatternScope(input: ScopeClassifierInput): ScopeClassificationResult {
  const organizationId = nonEmpty(input.organizationId, 'organizationId');
  const rootKey = nonEmpty(input.rootKey, 'rootKey');
  const eligiblePropertyIds = stableIds(input.eligibleOrganizationPropertyIds, 'eligibleOrganizationPropertyIds');
  const evaluatedPropertyIds = stableIds(input.evaluatedPropertyIds, 'evaluatedPropertyIds');
  const affectedPropertyIds = stableIds(input.affectedPropertyIds, 'affectedPropertyIds');
  const queryScope = input.queryScope ?? null;
  const accessScope = input.accessScope ?? null;
  const reasons: ScopeAbstentionReason[] = [];
  if (eligiblePropertyIds.length === 0) reasons.push('no_eligible_properties');
  if (affectedPropertyIds.length === 0) reasons.push('no_affected_properties');
  if (!isSubset(affectedPropertyIds, eligiblePropertyIds)) reasons.push('affected_outside_eligible_universe');
  if (!isSubset(evaluatedPropertyIds, eligiblePropertyIds)) reasons.push('evaluated_outside_eligible_universe');
  if (!isSubset(affectedPropertyIds, evaluatedPropertyIds)) reasons.push('affected_without_evidence');
  if (reasons.length > 0) {
    return Object.freeze({
      ok: false as const,
      status: 'abstain' as const,
      reasons: Object.freeze([...new Set(reasons)].sort()),
      organizationId,
      rootKey,
      queryScope,
      accessScope,
    });
  }

  const thresholds = Object.freeze({
    minimumCompanyEvidenceCoverageRatio: ratio(
      input.minimumCompanyEvidenceCoverageRatio,
      1,
      'minimumCompanyEvidenceCoverageRatio',
    ),
    minimumCompanyAffectedShare: ratio(input.minimumCompanyAffectedShare, 1, 'minimumCompanyAffectedShare'),
    minimumCompanyAffectedProperties: count(
      input.minimumCompanyAffectedProperties,
      2,
      'minimumCompanyAffectedProperties',
    ),
    minimumDistinctGroupsForCompany: count(
      input.minimumDistinctGroupsForCompany,
      2,
      'minimumDistinctGroupsForCompany',
    ),
    minimumGroupEvidenceCoverageRatio: ratio(
      input.minimumGroupEvidenceCoverageRatio,
      1,
      'minimumGroupEvidenceCoverageRatio',
    ),
    minimumGroupAffectedShare: ratio(input.minimumGroupAffectedShare, 1, 'minimumGroupAffectedShare'),
    minimumGroupAffectedProperties: count(
      input.minimumGroupAffectedProperties,
      2,
      'minimumGroupAffectedProperties',
    ),
  });
  const groups = canonicalGroups(input.groups ?? [], eligiblePropertyIds);
  const organizationEvidenceCoverageRatio = evaluatedPropertyIds.length / eligiblePropertyIds.length;
  const organizationAffectedShare = affectedPropertyIds.length / evaluatedPropertyIds.length;
  const fullEvaluatedPrevalence = affectedPropertyIds.length === evaluatedPropertyIds.length;
  const distribution = companyDistribution(
    groups,
    affectedPropertyIds,
    thresholds.minimumDistinctGroupsForCompany,
  );
  let scope: PatternScope | null = null;
  let matchedGroup: ScopeClassification['matchedGroup'] = null;
  let matchedDistribution: CompanyDistributionEvidence | null = null;
  let cohortFingerprint: string | null = null;
  let cohortFingerprints: readonly string[] = Object.freeze([]);

  if (
    input.evidenceBasis === 'cross_property_condition'
    && eligiblePropertyIds.length >= 2
    && organizationEvidenceCoverageRatio >= thresholds.minimumCompanyEvidenceCoverageRatio
    && organizationAffectedShare >= thresholds.minimumCompanyAffectedShare
    && affectedPropertyIds.length >= thresholds.minimumCompanyAffectedProperties
    && (fullEvaluatedPrevalence || distribution !== null)
  ) {
    scope = 'company_wide';
    matchedDistribution = fullEvaluatedPrevalence ? null : distribution;
  }

  if (scope === null && input.evidenceBasis === 'cross_property_condition') {
    const groupMatches = groups.flatMap((group) => {
      const groupEligible = group.propertyIds;
      const groupEvaluated = intersection(groupEligible, evaluatedPropertyIds);
      const groupAffected = intersection(groupEligible, affectedPropertyIds);
      const evidenceCoverageRatio = groupEligible.length === 0 ? 0 : groupEvaluated.length / groupEligible.length;
      const affectedShare = groupEvaluated.length === 0 ? 0 : groupAffected.length / groupEvaluated.length;
      if (
        groupEligible.length >= 2
        && evidenceCoverageRatio >= thresholds.minimumGroupEvidenceCoverageRatio
        && affectedShare >= thresholds.minimumGroupAffectedShare
        && groupAffected.length >= thresholds.minimumGroupAffectedProperties
        && affectedPropertyIds.every((id) => groupEligible.includes(id))
      ) {
        return [{
          groupId: group.groupId,
          kind: group.kind,
          snapshotFingerprint: group.snapshotFingerprint,
          coverageRatio: evidenceCoverageRatio,
          evidenceCoverageRatio,
          affectedShare,
          eligiblePropertyCount: groupEligible.length,
          evaluatedPropertyCount: groupEvaluated.length,
          affectedPropertyCount: groupAffected.length,
        }];
      }
      return [];
    }).sort((left, right) => (
      right.affectedShare - left.affectedShare
      || left.eligiblePropertyCount - right.eligiblePropertyCount
      || left.kind.localeCompare(right.kind)
      || left.groupId.localeCompare(right.groupId)
    ));
    const groupMatch = groupMatches[0];
    if (groupMatch) {
      scope = 'group_region';
      matchedGroup = Object.freeze(groupMatch);
    }
  }

  if (scope === null && input.evidenceBasis === 'peer_comparison') {
    const cohorts = [
      ...(input.peerCohort == null ? [] : [input.peerCohort]),
      ...(input.peerCohorts ?? []),
    ];
    if (cohorts.length === 0) {
      reasons.push('peer_cohort_evidence_invalid');
    } else {
      const cohortIds = cohorts.map((cohort) => stableIds(
        [cohort.targetPropertyId, ...cohort.peerPropertyIds],
        'peerCohorts.propertyIds',
      ));
      const unionIds = stableIds(cohortIds.flat(), 'peerCohorts.propertyIds');
      const targetIds = stableIds(cohorts.map((cohort) => cohort.targetPropertyId), 'peerCohorts.targetPropertyId');
      const invalidCohort = cohorts.some((cohort, index) => (
        cohortIds[index].length < 2
        || !isSubset(cohortIds[index], eligiblePropertyIds)
        || !cohort.cohortFingerprint.trim()
      ));
      if (
        invalidCohort
        || !isSubset(affectedPropertyIds, unionIds)
        || !isSubset(affectedPropertyIds, targetIds)
      ) {
        reasons.push('peer_cohort_evidence_invalid');
      } else {
        scope = 'peer_cohort';
        cohortFingerprints = stableIds(
          cohorts.map((cohort) => cohort.cohortFingerprint),
          'peerCohorts.cohortFingerprint',
        );
        cohortFingerprint = cohortFingerprints.length === 1 ? cohortFingerprints[0] : null;
      }
    }
  }

  if (scope === null && input.evidenceBasis === 'property_only' && affectedPropertyIds.length === 1) {
    scope = 'property_local';
  }
  if (scope === null && reasons.length === 0) reasons.push('ambiguous_multi_property_scope');
  if (scope === null) {
    return Object.freeze({
      ok: false as const,
      status: 'abstain' as const,
      reasons: Object.freeze([...new Set(reasons)].sort()),
      organizationId,
      rootKey,
      queryScope,
      accessScope,
    });
  }

  const identityPayload = {
    schemaVersion: MANAGEMENT_PATTERN_SCOPE_VERSION,
    organizationId,
    rootKey,
    scope,
    evidenceBasis: input.evidenceBasis,
    eligiblePropertyIds,
    evaluatedPropertyIds,
    affectedPropertyIds,
    organizationCoverageRatio: organizationEvidenceCoverageRatio,
    organizationEvidenceCoverageRatio,
    organizationAffectedShare,
    thresholds,
    companyDistribution: matchedDistribution,
    matchedGroup,
    cohortFingerprint,
    cohortFingerprints,
  };
  return Object.freeze({
    ok: true as const,
    classification: Object.freeze({
      ...identityPayload,
      queryScope,
      accessScope,
      fingerprint: stableFingerprint(identityPayload, 'scope-classification'),
    }),
  });
}
