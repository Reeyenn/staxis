import { stableFingerprint } from './canonical';
import { MANAGEMENT_PATTERN_CONSOLIDATION_VERSION } from './versions';

export type PatternAssertion = 'issue_present' | 'issue_absent';
export type PatternDirection =
  | 'high'
  | 'low'
  | 'increasing'
  | 'decreasing'
  | 'stopped'
  | 'resumed'
  | 'not_applicable';

export interface LocalPatternInstanceInput {
  readonly instanceId: string;
  readonly propertyId: string;
  readonly evidenceFingerprint: string;
}

export interface LocalPatternInstance extends LocalPatternInstanceInput {
  readonly fingerprint: string;
}

export interface ConsolidationCandidateInput {
  readonly candidateId: string;
  readonly organizationId: string;
  readonly runFingerprint: string;
  readonly detectorId: string;
  readonly detectorVersion: string;
  /** Stable causal/problem family shared intentionally by compatible checks. */
  readonly semanticRootFamily: string;
  /** Stable subject inside the family; never include current scope. */
  readonly rootSubjectKey: string;
  /** Version of the cross-detector agreement about what may be merged. */
  readonly mergeContractVersion: string;
  /** Detectors only share this key after explicitly agreeing their claims are commensurable. */
  readonly compatibilityKey: string;
  /** Exact versioned analysis period/bucket. Different windows remain separate. */
  readonly analysisWindowKey: string;
  readonly assertion: PatternAssertion;
  readonly direction: PatternDirection;
  readonly affectedPropertyIds: readonly string[];
  readonly localInstances?: readonly LocalPatternInstanceInput[];
  readonly evidenceFingerprint: string;
  /** Threshold progress, not a probability. */
  readonly materialityScore: number;
}

export interface ConsolidationCandidate extends Omit<ConsolidationCandidateInput, 'localInstances'> {
  readonly schemaVersion: typeof MANAGEMENT_PATTERN_CONSOLIDATION_VERSION;
  readonly affectedPropertyIds: readonly string[];
  readonly localInstances: readonly LocalPatternInstance[];
  readonly rootKey: string;
  /** Excludes candidateId so a retried event can be recognized as a duplicate. */
  readonly fingerprint: string;
}

export interface ConsolidatedManifestation {
  readonly candidateId: string;
  readonly candidateFingerprint: string;
  readonly detectorId: string;
  readonly detectorVersion: string;
  readonly assertion: PatternAssertion;
  readonly direction: PatternDirection;
  readonly affectedPropertyIds: readonly string[];
  readonly evidenceFingerprint: string;
  readonly materialityScore: number;
}

export type ConsolidationConflictCode =
  | 'contradictory_assertions'
  | 'opposite_directions'
  | 'candidate_id_collision';

export interface ConsolidationConflict {
  readonly code: ConsolidationConflictCode;
  readonly rootKey: string | null;
  readonly occurrenceKey: string | null;
  readonly candidateIds: readonly string[];
  readonly candidateFingerprints: readonly string[];
  readonly affectedPropertyIds: readonly string[];
}

export type ConsolidationSeparationReason =
  | 'different_run'
  | 'different_window'
  | 'different_merge_contract'
  | 'different_compatibility_key';

export interface ConsolidationSeparation {
  readonly rootKey: string;
  readonly occurrenceKeys: readonly [string, string];
  readonly reasons: readonly ConsolidationSeparationReason[];
}

export interface ConsolidationDuplicate {
  readonly candidateFingerprint: string;
  readonly keptCandidateId: string;
  readonly duplicateCandidateIds: readonly string[];
}

export interface ConsolidatedPattern {
  readonly schemaVersion: typeof MANAGEMENT_PATTERN_CONSOLIDATION_VERSION;
  readonly rootKey: string;
  readonly occurrenceKey: string;
  readonly organizationId: string;
  readonly semanticRootFamily: string;
  readonly rootSubjectKey: string;
  readonly runFingerprint: string;
  readonly mergeContractVersion: string;
  readonly compatibilityKey: string;
  readonly analysisWindowKey: string;
  readonly status: 'supported' | 'conflicted';
  readonly assertion: PatternAssertion | 'conflicted';
  readonly directions: readonly PatternDirection[];
  readonly affectedPropertyIds: readonly string[];
  readonly manifestations: readonly ConsolidatedManifestation[];
  readonly localInstances: readonly LocalPatternInstance[];
  readonly conflicts: readonly ConsolidationConflict[];
  readonly maximumMaterialityScore: number;
  readonly fingerprint: string;
}

export interface ConsolidationResult {
  readonly schemaVersion: typeof MANAGEMENT_PATTERN_CONSOLIDATION_VERSION;
  readonly patterns: readonly ConsolidatedPattern[];
  readonly conflicts: readonly ConsolidationConflict[];
  readonly duplicates: readonly ConsolidationDuplicate[];
  readonly separations: readonly ConsolidationSeparation[];
  readonly fingerprint: string;
}

function nonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError(`${field} must not be empty`);
  return trimmed;
}

function stableIds(values: readonly string[], field: string): readonly string[] {
  return Object.freeze([...new Set(values.map((value) => nonEmpty(value, field)))].sort());
}

function materiality(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError('materialityScore must be between 0 and 1');
  }
  return value;
}

export function stablePatternRootKey(input: {
  readonly organizationId: string;
  readonly semanticRootFamily: string;
  readonly rootSubjectKey: string;
}): string {
  return stableFingerprint({
    schemaVersion: MANAGEMENT_PATTERN_CONSOLIDATION_VERSION,
    organizationId: nonEmpty(input.organizationId, 'organizationId'),
    semanticRootFamily: nonEmpty(input.semanticRootFamily, 'semanticRootFamily'),
    rootSubjectKey: nonEmpty(input.rootSubjectKey, 'rootSubjectKey'),
  }, 'pattern-root');
}

function occurrenceKey(candidate: ConsolidationCandidate): string {
  return stableFingerprint({
    rootKey: candidate.rootKey,
    runFingerprint: candidate.runFingerprint,
    mergeContractVersion: candidate.mergeContractVersion,
    compatibilityKey: candidate.compatibilityKey,
    analysisWindowKey: candidate.analysisWindowKey,
  }, 'pattern-occurrence');
}

export function createConsolidationCandidate(input: ConsolidationCandidateInput): ConsolidationCandidate {
  const organizationId = nonEmpty(input.organizationId, 'organizationId');
  const semanticRootFamily = nonEmpty(input.semanticRootFamily, 'semanticRootFamily');
  const rootSubjectKey = nonEmpty(input.rootSubjectKey, 'rootSubjectKey');
  const affectedPropertyIds = stableIds(input.affectedPropertyIds, 'affectedPropertyIds');
  const localInstances = (input.localInstances ?? []).map((instance) => {
    const payload = {
      instanceId: nonEmpty(instance.instanceId, 'localInstances.instanceId'),
      propertyId: nonEmpty(instance.propertyId, 'localInstances.propertyId'),
      evidenceFingerprint: nonEmpty(instance.evidenceFingerprint, 'localInstances.evidenceFingerprint'),
    };
    if (!affectedPropertyIds.includes(payload.propertyId)) {
      throw new TypeError('every local instance property must be listed as affected');
    }
    return Object.freeze({ ...payload, fingerprint: stableFingerprint(payload, 'local-pattern-instance') });
  });
  const uniqueInstances = [...new Map(localInstances.map((instance) => [instance.fingerprint, instance])).values()]
    .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
  const rootKey = stablePatternRootKey({ organizationId, semanticRootFamily, rootSubjectKey });
  const payload = {
    schemaVersion: MANAGEMENT_PATTERN_CONSOLIDATION_VERSION,
    organizationId,
    runFingerprint: nonEmpty(input.runFingerprint, 'runFingerprint'),
    detectorId: nonEmpty(input.detectorId, 'detectorId'),
    detectorVersion: nonEmpty(input.detectorVersion, 'detectorVersion'),
    semanticRootFamily,
    rootSubjectKey,
    mergeContractVersion: nonEmpty(input.mergeContractVersion, 'mergeContractVersion'),
    compatibilityKey: nonEmpty(input.compatibilityKey, 'compatibilityKey'),
    analysisWindowKey: nonEmpty(input.analysisWindowKey, 'analysisWindowKey'),
    assertion: input.assertion,
    direction: input.direction,
    affectedPropertyIds,
    localInstances: uniqueInstances,
    evidenceFingerprint: nonEmpty(input.evidenceFingerprint, 'evidenceFingerprint'),
    materialityScore: materiality(input.materialityScore),
    rootKey,
  };
  const fingerprint = stableFingerprint(payload, 'consolidation-candidate');
  return Object.freeze({
    candidateId: nonEmpty(input.candidateId, 'candidateId'),
    ...payload,
    localInstances: Object.freeze(uniqueInstances),
    fingerprint,
  });
}

function overlap(left: readonly string[], right: readonly string[]): readonly string[] {
  const rightSet = new Set(right);
  return Object.freeze(left.filter((value) => rightSet.has(value)).sort());
}

function directionsOppose(left: PatternDirection, right: PatternDirection): boolean {
  return (
    (left === 'high' && right === 'low')
    || (left === 'low' && right === 'high')
    || (left === 'increasing' && right === 'decreasing')
    || (left === 'decreasing' && right === 'increasing')
    || (left === 'stopped' && right === 'resumed')
    || (left === 'resumed' && right === 'stopped')
  );
}

function conflictBetween(
  left: ConsolidationCandidate,
  right: ConsolidationCandidate,
  groupOccurrenceKey: string,
): ConsolidationConflict | null {
  const sharedProperties = overlap(left.affectedPropertyIds, right.affectedPropertyIds);
  const contradictoryAssertions = left.assertion !== right.assertion;
  if (
    !contradictoryAssertions
    && sharedProperties.length === 0
    && (left.affectedPropertyIds.length > 0 || right.affectedPropertyIds.length > 0)
  ) return null;
  const code = contradictoryAssertions
    ? 'contradictory_assertions' as const
    : left.assertion === 'issue_present' && directionsOppose(left.direction, right.direction)
      ? 'opposite_directions' as const
      : null;
  if (code === null) return null;
  return Object.freeze({
    code,
    rootKey: left.rootKey,
    occurrenceKey: groupOccurrenceKey,
    candidateIds: Object.freeze([left.candidateId, right.candidateId].sort()),
    candidateFingerprints: Object.freeze([left.fingerprint, right.fingerprint].sort()),
    // A mixed assertion set invalidates the occurrence-level conclusion even
    // when the local manifestations name disjoint hotels. Preserve the union
    // in the receipt so neither side of the contradiction disappears.
    affectedPropertyIds: contradictoryAssertions
      ? stableIds(
        [...left.affectedPropertyIds, ...right.affectedPropertyIds],
        'affectedPropertyIds',
      )
      : sharedProperties,
  });
}

function manifestation(candidate: ConsolidationCandidate): ConsolidatedManifestation {
  return Object.freeze({
    candidateId: candidate.candidateId,
    candidateFingerprint: candidate.fingerprint,
    detectorId: candidate.detectorId,
    detectorVersion: candidate.detectorVersion,
    assertion: candidate.assertion,
    direction: candidate.direction,
    affectedPropertyIds: candidate.affectedPropertyIds,
    evidenceFingerprint: candidate.evidenceFingerprint,
    materialityScore: candidate.materialityScore,
  });
}

function uniqueConflicts(conflicts: readonly ConsolidationConflict[]): readonly ConsolidationConflict[] {
  const unique = new Map<string, ConsolidationConflict>();
  for (const conflict of conflicts) {
    unique.set(stableFingerprint(conflict, 'consolidation-conflict'), conflict);
  }
  return Object.freeze([...unique.values()].sort((left, right) => {
    const leftKey = `${left.rootKey ?? ''}:${left.occurrenceKey ?? ''}:${left.code}:${left.candidateIds.join(',')}`;
    const rightKey = `${right.rootKey ?? ''}:${right.occurrenceKey ?? ''}:${right.code}:${right.candidateIds.join(',')}`;
    return leftKey.localeCompare(rightKey);
  }));
}

/**
 * Consolidate within one explicit merge contract/window. Root identity excludes
 * detector and current scope, while every original manifestation survives.
 */
export function consolidatePatternCandidates(
  candidatesInput: readonly ConsolidationCandidate[],
): ConsolidationResult {
  const idFingerprints = new Map<string, Set<string>>();
  for (const candidate of candidatesInput) {
    const fingerprints = idFingerprints.get(candidate.candidateId) ?? new Set<string>();
    fingerprints.add(candidate.fingerprint);
    idFingerprints.set(candidate.candidateId, fingerprints);
  }
  const globalConflicts: ConsolidationConflict[] = [];
  for (const [candidateId, fingerprints] of idFingerprints) {
    if (fingerprints.size > 1) {
      globalConflicts.push(Object.freeze({
        code: 'candidate_id_collision',
        rootKey: null,
        occurrenceKey: null,
        candidateIds: Object.freeze([candidateId]),
        candidateFingerprints: Object.freeze([...fingerprints].sort()),
        affectedPropertyIds: Object.freeze([]),
      }));
    }
  }

  const byFingerprint = new Map<string, ConsolidationCandidate[]>();
  for (const candidate of candidatesInput) {
    const values = byFingerprint.get(candidate.fingerprint) ?? [];
    values.push(candidate);
    byFingerprint.set(candidate.fingerprint, values);
  }
  const duplicates: ConsolidationDuplicate[] = [];
  const candidates: ConsolidationCandidate[] = [];
  for (const fingerprint of [...byFingerprint.keys()].sort()) {
    const values = (byFingerprint.get(fingerprint) ?? []).sort((left, right) => left.candidateId.localeCompare(right.candidateId));
    candidates.push(values[0]);
    if (values.length > 1) {
      duplicates.push(Object.freeze({
        candidateFingerprint: fingerprint,
        keptCandidateId: values[0].candidateId,
        duplicateCandidateIds: Object.freeze(values.slice(1).map((value) => value.candidateId)),
      }));
    }
  }

  const groups = new Map<string, ConsolidationCandidate[]>();
  for (const candidate of candidates) {
    const key = occurrenceKey(candidate);
    const values = groups.get(key) ?? [];
    values.push(candidate);
    groups.set(key, values);
  }

  const patterns: ConsolidatedPattern[] = [];
  for (const key of [...groups.keys()].sort()) {
    const group = (groups.get(key) ?? []).sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
    const first = group[0];
    const groupConflicts: ConsolidationConflict[] = [];
    for (let leftIndex = 0; leftIndex < group.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < group.length; rightIndex += 1) {
        const conflict = conflictBetween(group[leftIndex], group[rightIndex], key);
        if (conflict) groupConflicts.push(conflict);
      }
    }
    groupConflicts.push(...globalConflicts.filter((conflict) => (
      group.some((candidate) => conflict.candidateIds.includes(candidate.candidateId))
    )));
    const frozenConflicts = uniqueConflicts(groupConflicts);
    globalConflicts.push(...groupConflicts);
    const assertions = [...new Set(group.map((candidate) => candidate.assertion))];
    const affectedPropertyIds = stableIds(group.flatMap((candidate) => candidate.affectedPropertyIds), 'affectedPropertyIds');
    const instances = [...new Map(
      group.flatMap((candidate) => candidate.localInstances).map((instance) => [instance.fingerprint, instance]),
    ).values()].sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
    const payload = {
      schemaVersion: MANAGEMENT_PATTERN_CONSOLIDATION_VERSION,
      rootKey: first.rootKey,
      occurrenceKey: key,
      organizationId: first.organizationId,
      semanticRootFamily: first.semanticRootFamily,
      rootSubjectKey: first.rootSubjectKey,
      runFingerprint: first.runFingerprint,
      mergeContractVersion: first.mergeContractVersion,
      compatibilityKey: first.compatibilityKey,
      analysisWindowKey: first.analysisWindowKey,
      status: frozenConflicts.length > 0 ? 'conflicted' as const : 'supported' as const,
      assertion: assertions.length === 1 ? assertions[0] : 'conflicted' as const,
      directions: [...new Set(group.map((candidate) => candidate.direction))].sort(),
      affectedPropertyIds,
      manifestations: group.map(manifestation),
      localInstances: instances,
      conflicts: frozenConflicts,
      maximumMaterialityScore: Math.max(...group.map((candidate) => candidate.materialityScore)),
    };
    patterns.push(Object.freeze({ ...payload, fingerprint: stableFingerprint(payload, 'consolidated-pattern') }));
  }

  const separations: ConsolidationSeparation[] = [];
  const byRoot = new Map<string, ConsolidatedPattern[]>();
  for (const pattern of patterns) {
    const values = byRoot.get(pattern.rootKey) ?? [];
    values.push(pattern);
    byRoot.set(pattern.rootKey, values);
  }
  for (const [rootKey, rootPatterns] of byRoot) {
    rootPatterns.sort((left, right) => left.occurrenceKey.localeCompare(right.occurrenceKey));
    for (let leftIndex = 0; leftIndex < rootPatterns.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < rootPatterns.length; rightIndex += 1) {
        const left = rootPatterns[leftIndex];
        const right = rootPatterns[rightIndex];
        const reasons: ConsolidationSeparationReason[] = [];
        if (left.runFingerprint !== right.runFingerprint) reasons.push('different_run');
        if (left.analysisWindowKey !== right.analysisWindowKey) reasons.push('different_window');
        if (left.mergeContractVersion !== right.mergeContractVersion) reasons.push('different_merge_contract');
        if (left.compatibilityKey !== right.compatibilityKey) reasons.push('different_compatibility_key');
        separations.push(Object.freeze({
          rootKey,
          occurrenceKeys: Object.freeze([left.occurrenceKey, right.occurrenceKey]) as readonly [string, string],
          reasons: Object.freeze(reasons),
        }));
      }
    }
  }

  const conflicts = uniqueConflicts(globalConflicts);
  patterns.sort((left, right) => left.occurrenceKey.localeCompare(right.occurrenceKey));
  duplicates.sort((left, right) => left.candidateFingerprint.localeCompare(right.candidateFingerprint));
  separations.sort((left, right) => left.occurrenceKeys.join(':').localeCompare(right.occurrenceKeys.join(':')));
  const payload = {
    schemaVersion: MANAGEMENT_PATTERN_CONSOLIDATION_VERSION,
    patterns,
    conflicts,
    duplicates,
    separations,
  };
  return Object.freeze({ ...payload, fingerprint: stableFingerprint(payload, 'consolidation-result') });
}
