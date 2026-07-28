import { canonicalize, stableFingerprint, type CanonicalValue } from './canonical';
import {
  buildMetricCohort,
  metricCohortPolicyFingerprint,
  type CohortCandidate,
  type MetricCohortDecision,
  type MetricCohortResult,
} from './cohort';
import {
  compareAgainstPeers,
  peerComparisonPolicyFingerprint,
  type PeerComparison,
} from './comparison';
import {
  consolidatePatternCandidates,
  createConsolidationCandidate,
  stablePatternRootKey,
  type ConsolidatedPattern,
  type ConsolidationCandidate,
  type ConsolidationResult,
} from './consolidation';
import {
  ACTIVITY_HISTORY_DAYS,
  ACTIVITY_MINIMUM_EVIDENCE_COVERAGE,
  ACTIVITY_MINIMUM_AFFECTED_PROPERTIES,
  ACTIVITY_MINIMUM_AFFECTED_SHARE,
  ACTIVITY_MINIMUM_EVENTS,
  ACTIVITY_MINIMUM_TOLERANCE_DAYS,
  ACTIVITY_STREAM_LABELS,
  ACTIVITY_STOPPED_CHECK_ID,
  ACTIVITY_STOPPED_CHECK_VERSION,
  MANAGEMENT_PATTERN_MAX_CANDIDATES,
  MANAGEMENT_PATTERN_MAX_PROPERTIES,
  SUPPLY_SPEND_CHECK_ID,
  SUPPLY_SPEND_CHECK_VERSION,
  SUPPLY_SPEND_COHORT_POLICY,
  SUPPLY_SPEND_COMPARISON_POLICY,
  SUPPLY_SPEND_MATERIALITY_POLICY,
  SUPPLY_SPEND_METRIC_DEFINITION,
  SUPPLY_SPEND_PROFILE_COVERAGE_POLICY,
  SUPPLY_SPEND_HISTORY_MONTHS,
  SUPPLY_SPEND_WINDOW_SAFETY_LAG_HOURS,
  supplySpendMaterialityThreshold,
} from './definitions';
import { metricDefinitionFingerprint, type NormalizedObservation } from './normalization';
import {
  profileDimensionValue,
  type CohortDimension,
} from './profile';
import {
  classifyPatternScope,
  type PatternEvidenceBasis,
  type PeerCohortScopeEvidence,
  type ScopeClassification,
  type ScopeGroupSnapshot,
} from './scope';
import { MANAGEMENT_PATTERN_EVALUATOR_VERSION } from './versions';
import { cadenceOf, daysBetween, type Cadence } from '@/lib/findings/detectors/baseline-math';
import type {
  ActivityStreamId,
  PreparedManagementPatternInputs,
  PreparedManagementPatternProperty,
} from './prepare-inputs';

export type ManagementCheckResult = 'normal' | 'candidate' | 'abstained' | 'skipped';
export type ManagementQualityGate = 'passed' | 'failed' | 'not_applicable';

export interface ManagementPatternCheckOutcome {
  readonly schemaVersion: typeof MANAGEMENT_PATTERN_EVALUATOR_VERSION;
  readonly outcomeKey: string;
  readonly checkId: string;
  readonly checkVersion: string;
  readonly semanticFamily: string;
  readonly rootKey: string;
  readonly rootSubjectKey: string;
  readonly targetPropertyId: string | null;
  readonly result: ManagementCheckResult;
  readonly qualityGate: ManagementQualityGate;
  readonly inputFingerprint: string;
  readonly reasonCodes: readonly string[];
  readonly evidence: CanonicalValue;
  readonly observationFingerprints: readonly string[];
  readonly cohort: MetricCohortDecision | null;
  readonly comparison: PeerComparison | null;
  readonly candidateFingerprints: readonly string[];
  readonly rowsExamined: number;
  readonly fingerprint: string;
}

export interface EvaluatedPatternManifestation {
  readonly schemaVersion: typeof MANAGEMENT_PATTERN_EVALUATOR_VERSION;
  readonly checkId: string;
  readonly checkVersion: string;
  readonly outcomeKey: string;
  readonly consolidationCandidate: ConsolidationCandidate;
  readonly summary: string;
  readonly magnitude: number;
  readonly materialityScore: number;
  readonly evidence: CanonicalValue;
  readonly evidenceBasis: PatternEvidenceBasis;
  readonly evaluatedPropertyIds: readonly string[];
  readonly comparatorPropertyIds: readonly string[];
  readonly peerCohorts: readonly PeerCohortScopeEvidence[];
  readonly fingerprint: string;
}

export interface FinalEvaluatedPattern {
  readonly schemaVersion: typeof MANAGEMENT_PATTERN_EVALUATOR_VERSION;
  readonly pattern: ConsolidatedPattern;
  readonly decision: 'emit' | 'suppress';
  readonly suppressionReasons: readonly string[];
  readonly classification: ScopeClassification | null;
  readonly summary: string;
  readonly magnitude: number;
  readonly materialityScore: number;
  readonly affectedPropertyIds: readonly string[];
  readonly comparatorPropertyIds: readonly string[];
  readonly manifestationFingerprints: readonly string[];
  readonly evidence: CanonicalValue;
  readonly fingerprint: string;
}

export interface FinalizedPatternManifestations {
  readonly consolidation: ConsolidationResult;
  readonly candidates: readonly FinalEvaluatedPattern[];
  readonly budgetSuppressions: readonly CandidateBudgetSuppression[];
  readonly fingerprint: string;
}

export interface CandidateBudgetSuppression {
  readonly schemaVersion: typeof MANAGEMENT_PATTERN_EVALUATOR_VERSION;
  readonly rank: number;
  readonly reason: 'candidate_budget_exceeded';
  readonly candidateFingerprint: string;
  readonly patternFingerprint: string;
  readonly rootKey: string;
  readonly semanticRootFamily: string;
  readonly priorDecision: FinalEvaluatedPattern['decision'];
  readonly materialityScore: number;
  readonly magnitude: number;
  readonly affectedPropertyIds: readonly string[];
  /** Full provenance remains in consolidation + manifestations. */
  readonly manifestationFingerprints: readonly string[];
  readonly fingerprint: string;
}

export interface ManagementPatternEvaluation {
  readonly schemaVersion: typeof MANAGEMENT_PATTERN_EVALUATOR_VERSION;
  readonly organizationId: string;
  readonly evaluatedAt: string;
  readonly inputFingerprint: string;
  readonly policyManifest: ManagementPatternPolicyManifest;
  readonly outcomes: readonly ManagementPatternCheckOutcome[];
  readonly manifestations: readonly EvaluatedPatternManifestation[];
  readonly consolidation: ConsolidationResult;
  readonly candidates: readonly FinalEvaluatedPattern[];
  readonly budgetSuppressions: readonly CandidateBudgetSuppression[];
  readonly rootEvaluations: readonly ManagementPatternRootEvaluation[];
  readonly reasonCodes: readonly string[];
  readonly fingerprint: string;
}

export interface ManagementPatternPolicyManifest {
  readonly schemaVersion: typeof MANAGEMENT_PATTERN_EVALUATOR_VERSION;
  readonly supplyCheckVersion: string;
  readonly activityCheckVersion: string;
  readonly metricDefinitionVersion: string;
  readonly metricDefinitionFingerprint: string;
  readonly cohortPolicyVersion: string;
  readonly cohortPolicyFingerprint: string;
  readonly comparisonPolicyVersion: string;
  readonly comparisonPolicyFingerprint: string;
  readonly profileCoveragePolicyVersion: string;
  readonly profileCoveragePolicyFingerprint: string;
  readonly materialityPolicyVersion: string;
  readonly materialityPolicyFingerprint: string;
  readonly activityPolicyFingerprint: string;
  readonly fingerprint: string;
}

export interface ManagementPatternRootEvaluation {
  readonly schemaVersion: typeof MANAGEMENT_PATTERN_EVALUATOR_VERSION;
  readonly semanticFamily: string;
  readonly rootKey: string;
  readonly rootSubjectKey: string;
  readonly checkIds: readonly string[];
  readonly checkVersions: readonly string[];
  readonly conclusion: 'present' | 'absent' | 'abstained';
  /** Null means the persistence mapper must create an aggregate abstention outcome. */
  readonly primaryOutcomeKey: string | null;
  readonly supportingOutcomeKeys: readonly string[];
  readonly affectedPropertyIds: readonly string[];
  readonly evaluatedPropertyIds: readonly string[];
  readonly unavailablePropertyIds: readonly string[];
  readonly reasonCodes: readonly string[];
  readonly candidateFingerprints: readonly string[];
  readonly fingerprint: string;
}

export interface SupplyProfileCoverageExclusion {
  readonly propertyId: string;
  readonly reasonCodes: readonly string[];
}

export interface SupplyProfileCoverageAttempt {
  readonly level: number;
  readonly levelId: string;
  readonly activeDimensions: readonly CohortDimension[];
  readonly relaxedDimensions: readonly CohortDimension[];
  readonly potentiallyCompatiblePeerCount: number;
  readonly knownCompatiblePeerCount: number;
  readonly dimensionIncompletePotentialPeerCount: number;
  readonly definitivelyMismatchedPeerCount: number;
  readonly usablePeerCount: number;
  readonly profileCompleteCoverageRatio: number;
  readonly effectiveCoverageRatio: number;
  /** Fingerprints the full ID-bearing receipt replayable from persisted run inputs. */
  readonly fingerprint: string;
}

/** A persisted pre-cohort proof that unknown profiles did not vanish. */
export interface SupplyProfileCoverageReceipt {
  readonly status: 'passed' | 'abstained';
  readonly decisionReason:
    | 'target_rung_profile_coverage_sufficient'
    | 'insufficient_target_rung_profile_coverage'
    | 'insufficient_possible_population_deferred_to_cohort';
  readonly organizationId: string;
  readonly targetPropertyId: string;
  readonly policyVersion: string;
  readonly policyFingerprint: string;
  readonly populationBasis: typeof SUPPLY_SPEND_PROFILE_COVERAGE_POLICY.populationBasis;
  readonly requiredDimensions: readonly CohortDimension[];
  readonly selectedLevel: number;
  readonly selectedLevelId: string;
  readonly activeDimensions: readonly CohortDimension[];
  readonly relaxedDimensions: readonly CohortDimension[];
  readonly potentiallyCompatiblePropertyIds: readonly string[];
  readonly knownCompatiblePropertyIds: readonly string[];
  readonly dimensionIncompletePotentialPropertyIds: readonly string[];
  readonly definitivelyMismatchedPropertyIds: readonly string[];
  readonly populationPropertyCount: number;
  readonly completeProfileCount: number;
  readonly excludedProfileCount: number;
  readonly completeRatio: number;
  readonly minimumCompleteRatio: number;
  readonly effectiveCoverageRatio: number;
  readonly cohortCoverageFingerprint: string;
  /** Bounded summaries; the selected rung above retains exact hotel IDs. */
  readonly attempts: readonly SupplyProfileCoverageAttempt[];
  readonly exclusions: readonly SupplyProfileCoverageExclusion[];
  readonly fingerprint: string;
}

const SUPPLY_SPEND_MATERIALITY_POLICY_FINGERPRINT = stableFingerprint(
  SUPPLY_SPEND_MATERIALITY_POLICY,
  'supply-spend-materiality-policy',
);
const SUPPLY_SPEND_PROFILE_COVERAGE_POLICY_FINGERPRINT = stableFingerprint(
  SUPPLY_SPEND_PROFILE_COVERAGE_POLICY,
  'supply-spend-profile-coverage-policy',
);

function policyManifest(): ManagementPatternPolicyManifest {
  const payload = {
    schemaVersion: MANAGEMENT_PATTERN_EVALUATOR_VERSION,
    supplyCheckVersion: SUPPLY_SPEND_CHECK_VERSION,
    activityCheckVersion: ACTIVITY_STOPPED_CHECK_VERSION,
    metricDefinitionVersion: SUPPLY_SPEND_METRIC_DEFINITION.definitionVersion,
    metricDefinitionFingerprint: metricDefinitionFingerprint(SUPPLY_SPEND_METRIC_DEFINITION),
    cohortPolicyVersion: SUPPLY_SPEND_COHORT_POLICY.policyVersion,
    cohortPolicyFingerprint: metricCohortPolicyFingerprint(SUPPLY_SPEND_COHORT_POLICY),
    comparisonPolicyVersion: SUPPLY_SPEND_COMPARISON_POLICY.policyVersion,
    comparisonPolicyFingerprint: peerComparisonPolicyFingerprint(SUPPLY_SPEND_COMPARISON_POLICY),
    profileCoveragePolicyVersion: SUPPLY_SPEND_PROFILE_COVERAGE_POLICY.policyVersion,
    profileCoveragePolicyFingerprint: SUPPLY_SPEND_PROFILE_COVERAGE_POLICY_FINGERPRINT,
    materialityPolicyVersion: SUPPLY_SPEND_MATERIALITY_POLICY.policyVersion,
    materialityPolicyFingerprint: SUPPLY_SPEND_MATERIALITY_POLICY_FINGERPRINT,
    activityPolicyFingerprint: stableFingerprint({
      checkVersion: ACTIVITY_STOPPED_CHECK_VERSION,
      historyDays: ACTIVITY_HISTORY_DAYS,
      minimumEvents: ACTIVITY_MINIMUM_EVENTS,
      minimumToleranceDays: ACTIVITY_MINIMUM_TOLERANCE_DAYS,
      minimumEvidenceCoverage: ACTIVITY_MINIMUM_EVIDENCE_COVERAGE,
      minimumAffectedProperties: ACTIVITY_MINIMUM_AFFECTED_PROPERTIES,
      minimumAffectedShare: ACTIVITY_MINIMUM_AFFECTED_SHARE,
    }, 'activity-pattern-policy'),
  };
  return Object.freeze({
    ...payload,
    fingerprint: stableFingerprint(payload, 'management-pattern-policy-manifest'),
  });
}

function stableStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values.filter((value) => value.trim()).map((value) => value.trim()))].sort());
}

function expectedSupplyWindow(evaluatedAt: string): { startDate: string; endDate: string } | null {
  const instant = new Date(evaluatedAt);
  if (Number.isNaN(instant.getTime())) return null;
  const safe = new Date(
    instant.getTime() - SUPPLY_SPEND_WINDOW_SAFETY_LAG_HOURS * 60 * 60 * 1000,
  );
  const monthStart = new Date(Date.UTC(safe.getUTCFullYear(), safe.getUTCMonth(), 1));
  const end = new Date(monthStart.getTime() - 86_400_000);
  const start = new Date(Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth() - (SUPPLY_SPEND_HISTORY_MONTHS - 1),
    1,
  ));
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

function inclusiveLocalDays(startDate: string | null, endDate: string | null): number | null {
  if (startDate === null || endDate === null) return null;
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 86_400_000) + 1;
}

/** Fail closed if a prepared object no longer proves the configured source contract. */
function preparedContractReasons(prepared: PreparedManagementPatternInputs): readonly string[] {
  const snapshot = prepared.snapshot;
  const reasons: string[] = [];
  if (snapshot.max_properties !== MANAGEMENT_PATTERN_MAX_PROPERTIES) {
    reasons.push('source_property_budget_version_mismatch');
  }
  if (!snapshot.source_budget_exceeded && snapshot.property_count !== prepared.properties.length) {
    reasons.push('source_property_count_mismatch');
  }
  const expectedWindow = expectedSupplyWindow(snapshot.analysis_window_anchor);
  if (
    expectedWindow === null
    || snapshot.supply_window.start_date !== expectedWindow.startDate
    || snapshot.supply_window.end_date !== expectedWindow.endDate
  ) reasons.push('supply_window_policy_mismatch');
  if (
    snapshot.activity_window.history_days !== ACTIVITY_HISTORY_DAYS
    || inclusiveLocalDays(snapshot.activity_window.start_date, snapshot.activity_window.end_date) !== ACTIVITY_HISTORY_DAYS
  ) reasons.push('activity_window_policy_mismatch');
  for (const property of prepared.properties) {
    const id = propertyId(property);
    const supplyWindow = property.source.windows.supply_inventory;
    if (
      supplyWindow.start_date !== snapshot.supply_window.start_date
      || supplyWindow.end_date !== snapshot.supply_window.end_date
      || property.source.windows.supply_occupancy.start_date !== snapshot.supply_window.start_date
      || property.source.windows.supply_occupancy.end_date !== snapshot.supply_window.end_date
      || property.source.supply.expected_periods !== SUPPLY_SPEND_HISTORY_MONTHS
    ) reasons.push(`property_supply_window_mismatch:${id}`);
    const activityWindow = property.source.windows.activity;
    if (
      activityWindow.start_date !== snapshot.activity_window.start_date
      || activityWindow.end_date !== snapshot.activity_window.end_date
    ) reasons.push(`property_activity_window_mismatch:${id}`);
  }
  return stableStrings(reasons);
}

function propertyId(property: PreparedManagementPatternProperty): string {
  return property.source.property_id;
}

function propertyName(property: PreparedManagementPatternProperty): string {
  return property.source.property_name;
}

function normalizedSupply(property: PreparedManagementPatternProperty): NormalizedObservation | null {
  const result = property.supply.normalization;
  return result?.ok === true ? result.value : null;
}

function supplyRootSubjectKey(input: {
  readonly currency: string;
  readonly currencyStorageScale: number;
  readonly unit: string;
}): string {
  return [
    'inventory_purchase_spend',
    input.currency,
    `scale_${input.currencyStorageScale}`,
    input.unit,
  ].join(':');
}

function propertySupplyRootSubjectKey(
  property: PreparedManagementPatternProperty,
): string | null {
  const currency = property.profile?.operatingCurrency;
  if (currency === null || currency === undefined) return null;
  return supplyRootSubjectKey({
    currency: currency.code,
    currencyStorageScale: currency.storageScale,
    unit: SUPPLY_SPEND_METRIC_DEFINITION.normalizedUnit,
  });
}

function supplyReasons(property: PreparedManagementPatternProperty): readonly string[] {
  const normalizationReasons = property.supply.normalization?.ok === false
    ? property.supply.normalization.reasons
    : [];
  return stableStrings([
    ...property.runExclusionCodes,
    ...property.supply.reasonCodes,
    ...normalizationReasons,
    ...(property.profile === null ? ['profile_missing'] : []),
    ...(property.supply.observation === null ? ['observation_missing'] : []),
  ]);
}

function outcome(input: Omit<ManagementPatternCheckOutcome, 'schemaVersion' | 'fingerprint'>): ManagementPatternCheckOutcome {
  const payload = {
    schemaVersion: MANAGEMENT_PATTERN_EVALUATOR_VERSION,
    ...input,
  };
  return Object.freeze({ ...payload, fingerprint: stableFingerprint(payload, 'management-check-outcome') });
}

function outcomeRoot(
  organizationId: string,
  semanticFamily: string,
  rootSubjectKey: string,
): Pick<ManagementPatternCheckOutcome, 'semanticFamily' | 'rootKey' | 'rootSubjectKey'> {
  return Object.freeze({
    semanticFamily,
    rootSubjectKey,
    rootKey: stablePatternRootKey({ organizationId, semanticRootFamily: semanticFamily, rootSubjectKey }),
  });
}

function manifestation(input: Omit<EvaluatedPatternManifestation, 'schemaVersion' | 'fingerprint'>): EvaluatedPatternManifestation {
  const payload = {
    schemaVersion: MANAGEMENT_PATTERN_EVALUATOR_VERSION,
    ...input,
  };
  return Object.freeze({ ...payload, fingerprint: stableFingerprint(payload, 'evaluated-pattern-manifestation') });
}

function cohortCandidates(prepared: PreparedManagementPatternInputs): readonly CohortCandidate[] {
  return Object.freeze(prepared.properties.map((property): CohortCandidate => {
    const reasons = supplyReasons(property);
    const eligibility = reasons.length === 0 && normalizedSupply(property) !== null
      ? { eligible: true as const }
      : { eligible: false as const, reasons };
    if (property.profile !== null) {
      return {
        profile: property.profile,
        eligibility,
      };
    }
    return {
      profile: null,
      propertyId: propertyId(property),
      organizationId: prepared.snapshot.organization.id,
      asOf: prepared.snapshot.topology_as_of,
      profileFingerprint: stableFingerprint({
        preparedPropertyFingerprint: property.fingerprint,
        profileStatus: 'unavailable',
      }, 'unavailable-cohort-profile'),
      eligibility,
    };
  }));
}

export function supplyProfileCoverageReceipt(
  prepared: PreparedManagementPatternInputs,
  targetPropertyId: string,
): SupplyProfileCoverageReceipt {
  const target = prepared.properties.find((property) => propertyId(property) === targetPropertyId);
  if (target?.profile === null || target?.profile === undefined) {
    throw new TypeError('target profile is required for a target-specific coverage receipt');
  }
  const cohortResult = buildMetricCohort({
    target: target.profile,
    candidates: cohortCandidates(prepared),
    policy: SUPPLY_SPEND_COHORT_POLICY,
  });
  return supplyProfileCoverageReceiptFromCohort(prepared, targetPropertyId, cohortResult);
}

function supplyProfileCoverageReceiptFromCohort(
  prepared: PreparedManagementPatternInputs,
  targetPropertyId: string,
  cohortResult: MetricCohortResult,
): SupplyProfileCoverageReceipt {
  const attempts = cohortResult.ok
    ? cohortResult.cohort.attempts
    : cohortResult.receipt.attempts;
  const profileCompleteAttempt = attempts.find((attempt) => (
    attempt.knownCompatiblePeerCount >= SUPPLY_SPEND_COHORT_POLICY.minimumPeers
    && attempt.profileCompleteCoverageRatio
      >= SUPPLY_SPEND_PROFILE_COVERAGE_POLICY.minimumCompleteRatio
  ));
  const hasPossibleBaselinePopulation = attempts.some((attempt) => (
    attempt.potentiallyCompatiblePeerCount >= SUPPLY_SPEND_COHORT_POLICY.minimumPeers
  ));
  const selectedAttempt = cohortResult.ok
    ? attempts[cohortResult.cohort.selectedLevel]
    : profileCompleteAttempt ?? attempts.at(-1);
  if (selectedAttempt === undefined) {
    throw new TypeError('cohort evaluation produced no profile coverage attempt');
  }
  const status = profileCompleteAttempt !== undefined || !hasPossibleBaselinePopulation
    ? 'passed' as const
    : 'abstained' as const;
  const decisionReason = profileCompleteAttempt !== undefined
    ? 'target_rung_profile_coverage_sufficient' as const
    : hasPossibleBaselinePopulation
      ? 'insufficient_target_rung_profile_coverage' as const
      : 'insufficient_possible_population_deferred_to_cohort' as const;
  const exclusions: SupplyProfileCoverageExclusion[] = [];
  const incompleteIds = new Set(selectedAttempt.dimensionIncompletePotentialPeerIds);
  for (const property of prepared.properties) {
    if (!incompleteIds.has(propertyId(property))) continue;
    const reasonCodes: string[] = [];
    if (property.profile === null) {
      reasonCodes.push('profile_snapshot_unavailable');
    } else {
      for (const dimension of selectedAttempt.activeDimensions) {
        if (profileDimensionValue(property.profile, dimension) === null) {
          reasonCodes.push(
            SUPPLY_SPEND_PROFILE_COVERAGE_POLICY.requiredNonRelaxableDimensions.includes(
              dimension as typeof SUPPLY_SPEND_PROFILE_COVERAGE_POLICY.requiredNonRelaxableDimensions[number],
            )
              ? `required_profile_dimension_missing:${dimension}`
              : `active_profile_dimension_missing:${dimension}`,
          );
        }
      }
    }
    exclusions.push(Object.freeze({
      propertyId: propertyId(property),
      reasonCodes: stableStrings(reasonCodes),
    }));
  }
  exclusions.sort((left, right) => left.propertyId.localeCompare(right.propertyId));
  const payload = {
    status,
    decisionReason,
    organizationId: prepared.snapshot.organization.id,
    targetPropertyId,
    policyVersion: SUPPLY_SPEND_PROFILE_COVERAGE_POLICY.policyVersion,
    policyFingerprint: SUPPLY_SPEND_PROFILE_COVERAGE_POLICY_FINGERPRINT,
    populationBasis: SUPPLY_SPEND_PROFILE_COVERAGE_POLICY.populationBasis,
    requiredDimensions: SUPPLY_SPEND_PROFILE_COVERAGE_POLICY.requiredNonRelaxableDimensions,
    selectedLevel: selectedAttempt.level,
    selectedLevelId: selectedAttempt.levelId,
    activeDimensions: selectedAttempt.activeDimensions,
    relaxedDimensions: selectedAttempt.relaxedDimensions,
    potentiallyCompatiblePropertyIds: selectedAttempt.potentiallyCompatiblePeerIds,
    knownCompatiblePropertyIds: selectedAttempt.knownCompatiblePeerIds,
    dimensionIncompletePotentialPropertyIds:
      selectedAttempt.dimensionIncompletePotentialPeerIds,
    definitivelyMismatchedPropertyIds: selectedAttempt.definitivelyMismatchedPeerIds,
    populationPropertyCount: selectedAttempt.potentiallyCompatiblePeerCount,
    completeProfileCount: selectedAttempt.knownCompatiblePeerCount,
    excludedProfileCount: exclusions.length,
    completeRatio: selectedAttempt.profileCompleteCoverageRatio,
    minimumCompleteRatio: SUPPLY_SPEND_PROFILE_COVERAGE_POLICY.minimumCompleteRatio,
    effectiveCoverageRatio: selectedAttempt.effectiveCoverageRatio,
    cohortCoverageFingerprint: selectedAttempt.coverageReceipt.fingerprint,
    attempts: Object.freeze(attempts.map((attempt): SupplyProfileCoverageAttempt => Object.freeze({
      level: attempt.level,
      levelId: attempt.levelId,
      activeDimensions: attempt.activeDimensions,
      relaxedDimensions: attempt.relaxedDimensions,
      potentiallyCompatiblePeerCount: attempt.potentiallyCompatiblePeerCount,
      knownCompatiblePeerCount: attempt.knownCompatiblePeerCount,
      dimensionIncompletePotentialPeerCount: attempt.dimensionIncompletePotentialPeerCount,
      definitivelyMismatchedPeerCount: attempt.definitivelyMismatchedPeerCount,
      usablePeerCount: attempt.usablePeerCount,
      profileCompleteCoverageRatio: attempt.profileCompleteCoverageRatio,
      effectiveCoverageRatio: attempt.effectiveCoverageRatio,
      fingerprint: attempt.coverageReceipt.fingerprint,
    }))),
    exclusions: Object.freeze(exclusions),
  };
  return Object.freeze({
    ...payload,
    fingerprint: stableFingerprint(payload, 'supply-profile-coverage-receipt'),
  });
}

function exclusionReasonCounts(
  exclusions: readonly { readonly reasons: readonly (string | { readonly code: string })[] }[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const exclusion of exclusions) {
    for (const reason of exclusion.reasons) {
      const key = typeof reason === 'string' ? reason : reason.code;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  ));
}

function compactCohortReference(cohort: MetricCohortDecision): CanonicalValue {
  const selectedAttempt = cohort.status === 'abstained'
    ? cohort.attempts[cohort.finalLevel]
    : cohort.attempts[cohort.selectedLevel];
  return canonicalize({
    fingerprint: cohort.fingerprint,
    status: cohort.status,
    reason: cohort.status === 'abstained' ? cohort.reason : null,
    policyFingerprint: cohort.policyFingerprint,
    targetPropertyId: cohort.targetPropertyId,
    level: cohort.status === 'abstained' ? cohort.finalLevel : cohort.selectedLevel,
    levelId: cohort.status === 'abstained' ? cohort.finalLevelId : cohort.selectedLevelId,
    activeDimensions: cohort.activeDimensions,
    relaxedDimensions: cohort.relaxedDimensions,
    minimumPeers: cohort.minimumPeers,
    minimumUsableCoverageRatio: cohort.minimumUsableCoverageRatio,
    populationBasis: selectedAttempt?.coverageReceipt.populationBasis ?? null,
    coverageReceiptFingerprint: selectedAttempt?.coverageReceipt.fingerprint ?? null,
    comparablePeerCount: selectedAttempt?.comparablePeerCount ?? 0,
    potentiallyCompatiblePeerCount: selectedAttempt?.potentiallyCompatiblePeerCount ?? 0,
    knownCompatiblePeerCount: selectedAttempt?.knownCompatiblePeerCount ?? 0,
    dimensionIncompletePotentialPeerCount:
      selectedAttempt?.dimensionIncompletePotentialPeerCount ?? 0,
    definitivelyMismatchedPeerCount: selectedAttempt?.definitivelyMismatchedPeerCount ?? 0,
    usablePeerCount: selectedAttempt?.usablePeerCount ?? 0,
    usableCoverageRatio: selectedAttempt?.usableCoverageRatio ?? 0,
    profileCompleteCoverageRatio: selectedAttempt?.profileCompleteCoverageRatio ?? 0,
    effectiveCoverageRatio: selectedAttempt?.effectiveCoverageRatio ?? 0,
    memberCount: cohort.members.length,
    exclusionCount: cohort.exclusions.length,
    exclusionReasonCounts: exclusionReasonCounts(cohort.exclusions),
    attemptsFingerprint: stableFingerprint(cohort.attempts, 'cohort-attempts'),
    membersFingerprint: stableFingerprint(cohort.members, 'cohort-members'),
    exclusionsFingerprint: stableFingerprint(cohort.exclusions, 'cohort-exclusions'),
    replayBasis: 'persisted_run_profiles_and_metric_observations',
  });
}

export function compactSupplyProfileCoverageReceipt(
  receipt: SupplyProfileCoverageReceipt,
): CanonicalValue {
  const reasonCounts: Record<string, number> = {};
  for (const exclusion of receipt.exclusions) {
    for (const reasonCode of exclusion.reasonCodes) {
      reasonCounts[reasonCode] = (reasonCounts[reasonCode] ?? 0) + 1;
    }
  }
  return canonicalize({
    fingerprint: receipt.fingerprint,
    status: receipt.status,
    decisionReason: receipt.decisionReason,
    organizationId: receipt.organizationId,
    targetPropertyId: receipt.targetPropertyId,
    policyVersion: receipt.policyVersion,
    policyFingerprint: receipt.policyFingerprint,
    populationBasis: receipt.populationBasis,
    requiredDimensions: receipt.requiredDimensions,
    selectedLevel: receipt.selectedLevel,
    selectedLevelId: receipt.selectedLevelId,
    activeDimensions: receipt.activeDimensions,
    relaxedDimensions: receipt.relaxedDimensions,
    populationPropertyCount: receipt.populationPropertyCount,
    completeProfileCount: receipt.completeProfileCount,
    excludedProfileCount: receipt.excludedProfileCount,
    completeRatio: receipt.completeRatio,
    minimumCompleteRatio: receipt.minimumCompleteRatio,
    effectiveCoverageRatio: receipt.effectiveCoverageRatio,
    cohortCoverageFingerprint: receipt.cohortCoverageFingerprint,
    potentiallyCompatiblePropertyIdsFingerprint: stableFingerprint(
      receipt.potentiallyCompatiblePropertyIds,
      'supply-profile-coverage-potentially-compatible-properties',
    ),
    knownCompatiblePropertyIdsFingerprint: stableFingerprint(
      receipt.knownCompatiblePropertyIds,
      'supply-profile-coverage-known-compatible-properties',
    ),
    dimensionIncompletePotentialPropertyIdsFingerprint: stableFingerprint(
      receipt.dimensionIncompletePotentialPropertyIds,
      'supply-profile-coverage-dimension-incomplete-properties',
    ),
    definitivelyMismatchedPropertyIdsFingerprint: stableFingerprint(
      receipt.definitivelyMismatchedPropertyIds,
      'supply-profile-coverage-definitively-mismatched-properties',
    ),
    attemptCount: receipt.attempts.length,
    attemptsFingerprint: stableFingerprint(
      receipt.attempts,
      'supply-profile-coverage-attempts',
    ),
    exclusionCount: receipt.exclusions.length,
    exclusionReasonCounts: Object.freeze(Object.fromEntries(
      Object.entries(reasonCounts).sort(([left], [right]) => left.localeCompare(right)),
    )),
    exclusionsFingerprint: stableFingerprint(
      receipt.exclusions,
      'supply-profile-coverage-exclusions',
    ),
    replayBasis: 'persisted_run_profiles_and_metric_observations',
  });
}

/**
 * Deterministically reconstructs the relational cohort receipt from persisted
 * run inputs. Compact evaluator outcomes carry the resulting fingerprint and
 * never duplicate O(targets * peers) membership JSON.
 */
export function replaySupplyCohortDecision(
  prepared: PreparedManagementPatternInputs,
  targetPropertyId: string,
): MetricCohortDecision | null {
  const target = prepared.properties.find((property) => propertyId(property) === targetPropertyId);
  if (
    target === undefined
    || target.profile === null
    || normalizedSupply(target) === null
    || supplyReasons(target).length > 0
  ) return null;
  const result = buildMetricCohort({
    target: target.profile,
    candidates: cohortCandidates(prepared),
    policy: SUPPLY_SPEND_COHORT_POLICY,
  });
  return result.ok ? result.cohort : result.receipt;
}

function supplyInputFingerprint(
  prepared: PreparedManagementPatternInputs,
  target: PreparedManagementPatternProperty,
): string {
  return stableFingerprint({
    preparedInputFingerprint: prepared.fingerprint,
    targetPropertyFingerprint: target.fingerprint,
    checkId: SUPPLY_SPEND_CHECK_ID,
    checkVersion: SUPPLY_SPEND_CHECK_VERSION,
    cohortPolicy: SUPPLY_SPEND_COHORT_POLICY,
    comparisonPolicy: SUPPLY_SPEND_COMPARISON_POLICY,
    materialityPolicy: SUPPLY_SPEND_MATERIALITY_POLICY,
    profileCoveragePolicy: SUPPLY_SPEND_PROFILE_COVERAGE_POLICY,
    metricDefinition: SUPPLY_SPEND_METRIC_DEFINITION,
  }, 'supply-check-input');
}

function evaluateSupply(
  prepared: PreparedManagementPatternInputs,
): { outcomes: ManagementPatternCheckOutcome[]; manifestations: EvaluatedPatternManifestation[] } {
  const outcomes: ManagementPatternCheckOutcome[] = [];
  const manifestations: EvaluatedPatternManifestation[] = [];
  const candidates = cohortCandidates(prepared);
  const normalizedByProperty = new Map(
    prepared.properties.flatMap((property) => {
      const normalized = normalizedSupply(property);
      return normalized === null ? [] : [[propertyId(property), normalized] as const];
    }),
  );

  for (const target of [...prepared.properties].sort((left, right) => propertyId(left).localeCompare(propertyId(right)))) {
    const targetId = propertyId(target);
    const outcomeKey = `supply:${targetId}`;
    const targetRoot = outcomeRoot(
      prepared.snapshot.organization.id,
      'supply_spend_control',
      propertySupplyRootSubjectKey(target) ?? 'unassignable_domain',
    );
    const inputFingerprint = supplyInputFingerprint(prepared, target);
    const targetReasons = supplyReasons(target);
    const targetNormalized = normalizedSupply(target);
    if (target.profile === null || targetNormalized === null || targetReasons.length > 0) {
      outcomes.push(outcome({
        outcomeKey,
        checkId: SUPPLY_SPEND_CHECK_ID,
        checkVersion: SUPPLY_SPEND_CHECK_VERSION,
        ...targetRoot,
        targetPropertyId: targetId,
        result: 'abstained',
        qualityGate: 'failed',
        inputFingerprint,
        reasonCodes: targetReasons.length > 0 ? targetReasons : ['target_not_usable'],
        evidence: canonicalize({ targetPropertyId: targetId, targetReasons }),
        observationFingerprints: target.supply.observation ? [target.supply.observation.fingerprint] : [],
        cohort: null,
        comparison: null,
        candidateFingerprints: [],
        rowsExamined: prepared.properties.length,
      }));
      continue;
    }

    const cohortResult = buildMetricCohort({
      target: target.profile,
      candidates,
      policy: SUPPLY_SPEND_COHORT_POLICY,
    });
    const profileCoverage = supplyProfileCoverageReceiptFromCohort(
      prepared,
      targetId,
      cohortResult,
    );
    if (profileCoverage.status === 'abstained') {
      outcomes.push(outcome({
        outcomeKey,
        checkId: SUPPLY_SPEND_CHECK_ID,
        checkVersion: SUPPLY_SPEND_CHECK_VERSION,
        ...targetRoot,
        targetPropertyId: targetId,
        result: 'abstained',
        qualityGate: 'failed',
        inputFingerprint,
        reasonCodes: ['insufficient_profile_dimension_coverage'],
        evidence: canonicalize({
          profileCoverage: compactSupplyProfileCoverageReceipt(profileCoverage),
          cohortReference: compactCohortReference(
            cohortResult.ok ? cohortResult.cohort : cohortResult.receipt,
          ),
        }),
        observationFingerprints: [targetNormalized.observation.fingerprint],
        cohort: null,
        comparison: null,
        candidateFingerprints: [],
        rowsExamined: prepared.properties.length,
      }));
      continue;
    }

    const materialityThreshold = supplySpendMaterialityThreshold(
      targetNormalized.currency,
      targetNormalized.currencyStorageScale,
    );
    if (materialityThreshold === null) {
      outcomes.push(outcome({
        outcomeKey,
        checkId: SUPPLY_SPEND_CHECK_ID,
        checkVersion: SUPPLY_SPEND_CHECK_VERSION,
        ...targetRoot,
        targetPropertyId: targetId,
        result: 'abstained',
        qualityGate: 'failed',
        inputFingerprint,
        reasonCodes: ['materiality_threshold_currency_unsupported'],
        evidence: canonicalize({
          currencyCode: targetNormalized.currency,
          currencyStorageScale: targetNormalized.currencyStorageScale,
          materialityPolicyVersion: SUPPLY_SPEND_MATERIALITY_POLICY.policyVersion,
          materialityPolicyFingerprint: SUPPLY_SPEND_MATERIALITY_POLICY_FINGERPRINT,
          unsupportedCurrencyBehavior:
            SUPPLY_SPEND_MATERIALITY_POLICY.unsupportedCurrencyBehavior,
          supportedCurrencyDomains: Object.keys(
            SUPPLY_SPEND_MATERIALITY_POLICY.thresholds,
          ).sort(),
        }),
        observationFingerprints: [targetNormalized.observation.fingerprint],
        cohort: null,
        comparison: null,
        candidateFingerprints: [],
        rowsExamined: prepared.properties.length,
      }));
      continue;
    }
    if (
      materialityThreshold.minimumNormalizedExcessMinorPerRoomSold
      !== SUPPLY_SPEND_COMPARISON_POLICY.minimumAbsoluteDelta
    ) {
      throw new TypeError('supply comparison and currency materiality policies disagree');
    }

    if (!cohortResult.ok) {
      outcomes.push(outcome({
        outcomeKey,
        checkId: SUPPLY_SPEND_CHECK_ID,
        checkVersion: SUPPLY_SPEND_CHECK_VERSION,
        ...targetRoot,
        targetPropertyId: targetId,
        result: 'abstained',
        qualityGate: 'failed',
        inputFingerprint,
        reasonCodes: [cohortResult.reason],
        evidence: canonicalize({
          cohortReference: compactCohortReference(cohortResult.receipt),
        }),
        observationFingerprints: [targetNormalized.observation.fingerprint],
        cohort: null,
        comparison: null,
        candidateFingerprints: [],
        rowsExamined: prepared.properties.length,
      }));
      continue;
    }

    const peerValues = cohortResult.cohort.members.flatMap((member) => {
      const value = normalizedByProperty.get(member.propertyId);
      return value ? [value] : [];
    });
    const comparisonResult = compareAgainstPeers({
      target: targetNormalized,
      peers: peerValues,
      cohort: cohortResult.cohort,
      definition: SUPPLY_SPEND_METRIC_DEFINITION,
      policy: SUPPLY_SPEND_COMPARISON_POLICY,
    });
    if (!comparisonResult.ok) {
      outcomes.push(outcome({
        outcomeKey,
        checkId: SUPPLY_SPEND_CHECK_ID,
        checkVersion: SUPPLY_SPEND_CHECK_VERSION,
        ...targetRoot,
        targetPropertyId: targetId,
        result: 'abstained',
        qualityGate: 'failed',
        inputFingerprint,
        reasonCodes: comparisonResult.reasons,
        evidence: canonicalize({
          reasons: comparisonResult.reasons,
          compatiblePeerCount: comparisonResult.compatiblePeerCount,
          minimumPeers: comparisonResult.minimumPeers,
          policyFingerprint: comparisonResult.policyFingerprint,
          definitionFingerprint: comparisonResult.definitionFingerprint,
          distribution: comparisonResult.distribution,
          baselineStability: comparisonResult.baselineStability,
          cohortReference: compactCohortReference(cohortResult.cohort),
          exclusionCount: comparisonResult.exclusions.length,
          exclusionReasonCounts: exclusionReasonCounts(comparisonResult.exclusions),
          exclusionsFingerprint: stableFingerprint(
            comparisonResult.exclusions,
            'peer-comparison-exclusions',
          ),
        }),
        observationFingerprints: [targetNormalized.observation.fingerprint],
        cohort: null,
        comparison: null,
        candidateFingerprints: [],
        rowsExamined: prepared.properties.length,
      }));
      continue;
    }

    const comparison = comparisonResult.comparison;
    if (targetNormalized.observation.rawValue === null) {
      throw new TypeError('supply normalization succeeded with a missing numerator');
    }
    const targetDenominator = targetNormalized.observation.denominator?.value ?? 0;
    const expectedRawAtPeerMedian = comparison.distribution.median * targetDenominator;
    const rawExcess = Math.max(0, targetNormalized.observation.rawValue - expectedRawAtPeerMedian);
    if (
      comparison.status !== 'outlier'
      || rawExcess < materialityThreshold.minimumRawExcessMinor
    ) {
      const reasons = comparison.status !== 'outlier'
        ? ['not_a_robust_outlier']
        : ['raw_excess_below_materiality_floor'];
      outcomes.push(outcome({
        outcomeKey,
        checkId: SUPPLY_SPEND_CHECK_ID,
        checkVersion: SUPPLY_SPEND_CHECK_VERSION,
        ...targetRoot,
        targetPropertyId: targetId,
        result: 'normal',
        qualityGate: 'passed',
        inputFingerprint,
        reasonCodes: reasons,
        // Normal peer evaluations are deliberately compact: the run already
        // persists every metric observation once, and the versioned policy +
        // fingerprints below deterministically reproduce membership and math.
        // Embedding every leave-one-out peer value here would be O(n^2).
        evidence: canonicalize({
          cohortFingerprint: cohortResult.cohort.fingerprint,
          cohortStatus: cohortResult.cohort.status,
          cohortLevel: cohortResult.cohort.selectedLevel,
          comparablePeerCount: cohortResult.cohort.comparablePeerCount,
          usablePeerCount: cohortResult.cohort.usablePeerCount,
          usableCoverageRatio: cohortResult.cohort.usableCoverageRatio,
          comparisonFingerprint: comparison.fingerprint,
          peerCount: comparison.peerPropertyIds.length,
          peerMedian: comparison.distribution.median,
          peerInterquartileRange: comparison.distribution.interquartileRange,
          peerMedianAbsoluteDeviation: comparison.distribution.medianAbsoluteDeviation,
          baselineStabilityFingerprint: comparison.baselineStability.fingerprint,
          baselineRelativeInterquartileRange:
            comparison.baselineStability.relativeInterquartileRange,
          baselineRelativeMedianAbsoluteDeviation:
            comparison.baselineStability.relativeMedianAbsoluteDeviation,
          targetNormalizedValue: comparison.targetValue,
          rawExcess,
          materialityPolicyFingerprint: SUPPLY_SPEND_MATERIALITY_POLICY_FINGERPRINT,
          replayBasis: 'persisted_run_profiles_and_metric_observations',
        }),
        observationFingerprints: [targetNormalized.observation.fingerprint],
        cohort: null,
        comparison: null,
        candidateFingerprints: [],
        rowsExamined: prepared.properties.length,
      }));
      continue;
    }

    const comparisonWindow = targetNormalized.observation.window;
    const metricFingerprint = metricDefinitionFingerprint(SUPPLY_SPEND_METRIC_DEFINITION);
    const analysisWindowKey = stableFingerprint({
      metricId: SUPPLY_SPEND_METRIC_DEFINITION.metricId,
      metricVersion: SUPPLY_SPEND_METRIC_DEFINITION.metricVersion,
      localStartDate: comparisonWindow.localStartDate,
      localEndDate: comparisonWindow.localEndDate,
    }, 'supply-analysis-window');
    if (targetNormalized.currency === null || targetNormalized.currencyStorageScale === null) {
      throw new TypeError('supply normalization succeeded without its required currency domain');
    }
    const rootSubjectKey = supplyRootSubjectKey({
      currency: targetNormalized.currency,
      currencyStorageScale: targetNormalized.currencyStorageScale,
      unit: targetNormalized.unit,
    });
    if (rootSubjectKey !== targetRoot.rootSubjectKey) {
      throw new TypeError('supply normalized domain conflicts with the target outcome root');
    }
    const compatibilityKey = stableFingerprint({
      metricDefinitionFingerprint: metricFingerprint,
      materialityPolicyFingerprint: SUPPLY_SPEND_MATERIALITY_POLICY_FINGERPRINT,
      currency: targetNormalized.currency,
      currencyStorageScale: targetNormalized.currencyStorageScale,
      normalizedUnit: targetNormalized.unit,
      localStartDate: comparisonWindow.localStartDate,
      localEndDate: comparisonWindow.localEndDate,
    }, 'supply-consolidation-compatibility');
    const consolidationCandidate = createConsolidationCandidate({
      candidateId: stableFingerprint({ outcomeKey, comparisonFingerprint: comparison.fingerprint }, 'supply-candidate-id'),
      organizationId: prepared.snapshot.organization.id,
      runFingerprint: prepared.fingerprint,
      detectorId: SUPPLY_SPEND_CHECK_ID,
      detectorVersion: SUPPLY_SPEND_CHECK_VERSION,
      semanticRootFamily: 'supply_spend_control',
      // Currency/unit domains are not comparable and must not compete for one
      // active-root projection in the mutable company finding ledger.
      rootSubjectKey,
      mergeContractVersion: 'supply-spend-root-contract.v1',
      compatibilityKey,
      // Local calendar dates are shared across properties; TZ/cutoff receipts
      // remain in compatibility evidence but do not prevent consolidation.
      analysisWindowKey,
      assertion: 'issue_present',
      direction: 'high',
      affectedPropertyIds: [targetId],
      localInstances: [{
        instanceId: `supply:${targetId}:${comparisonWindow.localEndDate}`,
        propertyId: targetId,
        evidenceFingerprint: targetNormalized.observation.fingerprint,
      }],
      evidenceFingerprint: comparison.fingerprint,
      materialityScore: comparison.outlierScore,
    });
    const summary = `${propertyName(target)} has materially high supply purchase spend per room sold.`;
    const manifest = manifestation({
      checkId: SUPPLY_SPEND_CHECK_ID,
      checkVersion: SUPPLY_SPEND_CHECK_VERSION,
      ...targetRoot,
      outcomeKey,
      consolidationCandidate,
      summary,
      magnitude: rawExcess,
      materialityScore: comparison.outlierScore,
      evidence: canonicalize({
        target: comparison.targetEvidence,
        distribution: comparison.distribution,
        baselineStability: comparison.baselineStability,
        peerObservationCount: comparison.peerObservationFingerprints.length,
        peerObservationSetFingerprint: stableFingerprint(
          comparison.peerObservationFingerprints,
          'peer-observation-set',
        ),
        rawExcess,
        materialityPolicyVersion: SUPPLY_SPEND_MATERIALITY_POLICY.policyVersion,
        materialityPolicyFingerprint: SUPPLY_SPEND_MATERIALITY_POLICY_FINGERPRINT,
        materialityThreshold,
        analysisWindowKey,
        rootSubjectKey,
        cohortFingerprint: cohortResult.cohort.fingerprint,
        comparisonFingerprint: comparison.fingerprint,
      }),
      evidenceBasis: 'peer_comparison',
      evaluatedPropertyIds: [targetId],
      comparatorPropertyIds: [],
      peerCohorts: [{
        cohortFingerprint: cohortResult.cohort.fingerprint,
        targetPropertyId: targetId,
        peerPropertyIds: cohortResult.cohort.members.map((member) => member.propertyId),
      }],
    });
    manifestations.push(manifest);
    outcomes.push(outcome({
      outcomeKey,
      checkId: SUPPLY_SPEND_CHECK_ID,
      checkVersion: SUPPLY_SPEND_CHECK_VERSION,
      ...targetRoot,
      targetPropertyId: targetId,
      result: 'candidate',
      qualityGate: 'passed',
      inputFingerprint,
      reasonCodes: [],
      evidence: canonicalize({
        manifestationFingerprint: manifest.fingerprint,
        manifestationEvidenceFingerprint: stableFingerprint(manifest.evidence, 'manifestation-evidence'),
        cohortReference: compactCohortReference(cohortResult.cohort),
        comparisonFingerprint: comparison.fingerprint,
        rawExcess,
      }),
      observationFingerprints: [targetNormalized.observation.fingerprint],
      cohort: null,
      comparison: null,
      candidateFingerprints: [manifest.fingerprint],
      rowsExamined: prepared.properties.length,
    }));
  }
  return { outcomes, manifestations };
}

interface ActivityCadenceEvaluation {
  readonly property: PreparedManagementPatternProperty;
  readonly cadence: Cadence;
  readonly lastDate: string;
  readonly silentDays: number;
  readonly stopped: boolean;
}

function activityCadences(
  prepared: PreparedManagementPatternInputs,
  streamId: ActivityStreamId,
): { eligible: ActivityCadenceEvaluation[]; exclusions: Readonly<Record<string, readonly string[]>> } {
  const eligible: ActivityCadenceEvaluation[] = [];
  const exclusions: Record<string, readonly string[]> = {};
  for (const property of prepared.properties) {
    const activity = property.activities[streamId];
    const reasons = [...property.runExclusionCodes, ...activity.reasonCodes];
    if (activity.observation === null) reasons.push('activity_observation_missing');
    if (activity.observation !== null) {
      const window = activity.observation.window;
      if (activity.eventDates.some((date) => date < window.localStartDate || date > window.localEndDate)) {
        reasons.push('activity_event_outside_window');
      }
    }
    const dates = stableStrings(activity.eventDates);
    const cadence = reasons.length === 0
      ? cadenceOf(dates, {
        minEvents: ACTIVITY_MINIMUM_EVENTS,
        minToleranceDays: ACTIVITY_MINIMUM_TOLERANCE_DAYS,
      })
      : null;
    if (cadence === null || activity.observation === null) {
      exclusions[propertyId(property)] = stableStrings([
        ...reasons,
        ...(cadence === null && reasons.length === 0 ? ['no_established_cadence'] : []),
      ]);
      continue;
    }
    const lastDate = dates.at(-1);
    if (!lastDate) {
      exclusions[propertyId(property)] = ['no_established_cadence'];
      continue;
    }
    const silentDays = daysBetween(lastDate, activity.observation.window.localEndDate);
    if (silentDays < 0) {
      exclusions[propertyId(property)] = ['activity_event_after_window'];
      continue;
    }
    eligible.push(Object.freeze({
      property,
      cadence,
      lastDate,
      silentDays,
      stopped: silentDays >= cadence.toleranceDays,
    }));
  }
  eligible.sort((left, right) => propertyId(left.property).localeCompare(propertyId(right.property)));
  return { eligible, exclusions: Object.freeze(exclusions) };
}

function evaluateActivity(
  prepared: PreparedManagementPatternInputs,
): { outcomes: ManagementPatternCheckOutcome[]; manifestations: EvaluatedPatternManifestation[] } {
  const outcomes: ManagementPatternCheckOutcome[] = [];
  const manifestations: EvaluatedPatternManifestation[] = [];
  const streamIds: readonly ActivityStreamId[] = ['daily_log_closings', 'inventory_counts', 'work_order_flow'];
  for (const streamId of streamIds) {
    const outcomeKey = `activity:${streamId}`;
    const activityRoot = outcomeRoot(
      prepared.snapshot.organization.id,
      'portfolio_activity_stopped',
      streamId,
    );
    const inputFingerprint = stableFingerprint({
      preparedInputFingerprint: prepared.fingerprint,
      streamId,
      checkId: ACTIVITY_STOPPED_CHECK_ID,
      checkVersion: ACTIVITY_STOPPED_CHECK_VERSION,
      historyDays: ACTIVITY_HISTORY_DAYS,
      minimumEvents: ACTIVITY_MINIMUM_EVENTS,
      minimumToleranceDays: ACTIVITY_MINIMUM_TOLERANCE_DAYS,
      minimumEvidenceCoverage: ACTIVITY_MINIMUM_EVIDENCE_COVERAGE,
      minimumAffectedProperties: ACTIVITY_MINIMUM_AFFECTED_PROPERTIES,
      minimumAffectedShare: ACTIVITY_MINIMUM_AFFECTED_SHARE,
    }, 'activity-check-input');
    const cadenceEvaluation = activityCadences(prepared, streamId);
    const stopped = cadenceEvaluation.eligible.filter((entry) => entry.stopped);
    const organizationPropertyCount = prepared.snapshot.property_count;
    const evidenceCoverage = organizationPropertyCount === 0
      ? 0
      : cadenceEvaluation.eligible.length / organizationPropertyCount;
    const affectedShare = cadenceEvaluation.eligible.length === 0
      ? 0
      : stopped.length / cadenceEvaluation.eligible.length;
    const observationFingerprints = cadenceEvaluation.eligible.map((entry) => (
      entry.property.activities[streamId].observation?.fingerprint ?? ''
    )).filter(Boolean);

    if (
      cadenceEvaluation.eligible.length < ACTIVITY_MINIMUM_AFFECTED_PROPERTIES
      || evidenceCoverage < ACTIVITY_MINIMUM_EVIDENCE_COVERAGE
    ) {
      outcomes.push(outcome({
        outcomeKey,
        checkId: ACTIVITY_STOPPED_CHECK_ID,
        checkVersion: ACTIVITY_STOPPED_CHECK_VERSION,
        ...activityRoot,
        targetPropertyId: null,
        result: 'abstained',
        qualityGate: 'failed',
        inputFingerprint,
        reasonCodes: stableStrings([
          ...(cadenceEvaluation.eligible.length < ACTIVITY_MINIMUM_AFFECTED_PROPERTIES
            ? ['insufficient_cadence_baselines']
            : []),
          ...(evidenceCoverage < ACTIVITY_MINIMUM_EVIDENCE_COVERAGE
            ? ['insufficient_portfolio_evidence_coverage']
            : []),
        ]),
        evidence: canonicalize({
          eligibleCadenceProperties: cadenceEvaluation.eligible.length,
          organizationPropertyCount,
          evidenceCoverage,
          minimumEvidenceCoverage: ACTIVITY_MINIMUM_EVIDENCE_COVERAGE,
          exclusions: cadenceEvaluation.exclusions,
        }),
        observationFingerprints,
        cohort: null,
        comparison: null,
        candidateFingerprints: [],
        rowsExamined: prepared.properties.length,
      }));
      continue;
    }
    if (
      stopped.length < ACTIVITY_MINIMUM_AFFECTED_PROPERTIES
      || affectedShare < ACTIVITY_MINIMUM_AFFECTED_SHARE
    ) {
      outcomes.push(outcome({
        outcomeKey,
        checkId: ACTIVITY_STOPPED_CHECK_ID,
        checkVersion: ACTIVITY_STOPPED_CHECK_VERSION,
        ...activityRoot,
        targetPropertyId: null,
        result: 'normal',
        qualityGate: 'passed',
        inputFingerprint,
        reasonCodes: stopped.length < ACTIVITY_MINIMUM_AFFECTED_PROPERTIES
          ? ['affected_property_floor_not_met']
          : ['affected_share_floor_not_met'],
        evidence: canonicalize({
          eligibleProperties: cadenceEvaluation.eligible.length,
          organizationPropertyCount,
          evidenceCoverage,
          stoppedProperties: stopped.length,
          affectedShare,
          exclusions: cadenceEvaluation.exclusions,
        }),
        observationFingerprints,
        cohort: null,
        comparison: null,
        candidateFingerprints: [],
        rowsExamined: prepared.properties.length,
      }));
      continue;
    }

    const affectedPropertyIds = stopped.map((entry) => propertyId(entry.property));
    const evaluatedPropertyIds = cadenceEvaluation.eligible.map((entry) => propertyId(entry.property));
    const longest = [...stopped].sort((left, right) => (
      right.silentDays - left.silentDays || propertyId(left.property).localeCompare(propertyId(right.property))
    ))[0];
    const analysisWindowKey = stableFingerprint({
      streamId,
      startDate: prepared.snapshot.activity_window.start_date,
      endDate: prepared.snapshot.activity_window.end_date,
      historyDays: prepared.snapshot.activity_window.history_days,
    }, 'activity-analysis-window');
    const evidence = canonicalize({
      streamId,
      eligibleProperties: cadenceEvaluation.eligible.length,
      organizationPropertyCount,
      evidenceCoverage,
      stoppedProperties: stopped.length,
      affectedShare,
      // Detailed cadence evidence is retained for affected hotels. Unaffected
      // hotels remain exactly identified by evaluatedPropertyIds and their
      // persisted observation links, avoiding another O(streams * portfolio)
      // copy of data already stored once for the run.
      affectedProperties: Object.fromEntries(stopped.map((entry) => [
        propertyId(entry.property),
        {
          lastDate: entry.lastDate,
          silentDays: entry.silentDays,
          stopped: entry.stopped,
          cadence: entry.cadence,
          observationFingerprint: entry.property.activities[streamId].observation?.fingerprint ?? null,
        },
      ])),
      exclusions: cadenceEvaluation.exclusions,
    });
    const evidenceFingerprint = stableFingerprint(evidence, 'activity-stopped-evidence');
    const consolidationCandidate = createConsolidationCandidate({
      candidateId: stableFingerprint({ outcomeKey, evidenceFingerprint }, 'activity-candidate-id'),
      organizationId: prepared.snapshot.organization.id,
      runFingerprint: prepared.fingerprint,
      detectorId: ACTIVITY_STOPPED_CHECK_ID,
      detectorVersion: ACTIVITY_STOPPED_CHECK_VERSION,
      semanticRootFamily: 'portfolio_activity_stopped',
      rootSubjectKey: streamId,
      mergeContractVersion: 'activity-stop-root-contract.v1',
      compatibilityKey: `activity-stop:${streamId}`,
      analysisWindowKey,
      assertion: 'issue_present',
      direction: 'stopped',
      affectedPropertyIds,
      localInstances: stopped.map((entry) => ({
        instanceId: `${streamId}:${propertyId(entry.property)}:${entry.lastDate}`,
        propertyId: propertyId(entry.property),
        evidenceFingerprint: entry.property.activities[streamId].observation?.fingerprint ?? evidenceFingerprint,
      })),
      evidenceFingerprint,
      // A bounded prevalence score for deterministic priority; it is not a
      // probability or confidence estimate.
      materialityScore: Math.min(1, affectedShare),
    });
    const manifest = manifestation({
      checkId: ACTIVITY_STOPPED_CHECK_ID,
      checkVersion: ACTIVITY_STOPPED_CHECK_VERSION,
      outcomeKey,
      consolidationCandidate,
      summary: `${stopped.length} hotels appear to have stopped recording ${ACTIVITY_STREAM_LABELS[streamId]} in Staxis; the longest silence is ${longest.silentDays} days.`,
      magnitude: stopped.length,
      materialityScore: consolidationCandidate.materialityScore,
      evidence,
      evidenceBasis: 'cross_property_condition',
      evaluatedPropertyIds,
      comparatorPropertyIds: evaluatedPropertyIds.filter((id) => !affectedPropertyIds.includes(id)),
      peerCohorts: [],
    });
    manifestations.push(manifest);
    outcomes.push(outcome({
      outcomeKey,
      checkId: ACTIVITY_STOPPED_CHECK_ID,
      checkVersion: ACTIVITY_STOPPED_CHECK_VERSION,
      ...activityRoot,
      targetPropertyId: null,
      result: 'candidate',
      qualityGate: 'passed',
      inputFingerprint,
      reasonCodes: [],
      evidence: canonicalize({
        manifestationFingerprint: manifest.fingerprint,
        manifestationEvidenceFingerprint: stableFingerprint(evidence, 'manifestation-evidence'),
        organizationPropertyCount,
        evaluatedPropertyCount: evaluatedPropertyIds.length,
        affectedPropertyCount: affectedPropertyIds.length,
        evidenceCoverage,
        affectedShare,
      }),
      observationFingerprints,
      cohort: null,
      comparison: null,
      candidateFingerprints: [manifest.fingerprint],
      rowsExamined: prepared.properties.length,
    }));
  }
  return { outcomes, manifestations };
}

function scopeGroups(prepared: PreparedManagementPatternInputs): readonly ScopeGroupSnapshot[] {
  const groups = new Map<string, {
    groupId: string;
    kind: ScopeGroupSnapshot['kind'];
    records: CanonicalValue[];
    propertyIds: string[];
  }>();
  for (const property of prepared.properties) {
    for (const group of property.source.groups) {
      const existing = groups.get(group.group_id) ?? {
        groupId: group.group_id,
        kind: group.kind,
        records: [],
        propertyIds: [],
      };
      existing.records.push(canonicalize(group));
      existing.propertyIds.push(propertyId(property));
      groups.set(group.group_id, existing);
    }
  }
  return Object.freeze([...groups.values()].map((group) => Object.freeze({
    groupId: group.groupId,
    kind: group.kind,
    snapshotFingerprint: stableFingerprint({
      records: group.records,
      propertyIds: stableStrings(group.propertyIds),
    }, 'scope-group-snapshot'),
    propertyIds: stableStrings(group.propertyIds),
  })).sort((left, right) => left.groupId.localeCompare(right.groupId)));
}

/** Consolidate manifestations first, then classify scope from the merged evidence. */
export function finalizeEvaluatedManifestations(
  prepared: PreparedManagementPatternInputs,
  manifestationsInput: readonly EvaluatedPatternManifestation[],
): FinalizedPatternManifestations {
  const manifestations = [...manifestationsInput].sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
  const consolidation = consolidatePatternCandidates(
    manifestations.map((item) => item.consolidationCandidate),
  );
  const eligiblePropertyIds = prepared.properties.map(propertyId).sort();
  const groups = scopeGroups(prepared);
  const candidates = consolidation.patterns.map((pattern) => {
    const candidateFingerprints = new Set(pattern.manifestations.map((item) => item.candidateFingerprint));
    const contributors = manifestations.filter((item) => (
      candidateFingerprints.has(item.consolidationCandidate.fingerprint)
    ));
    const peerCohorts = [...new Map(
      contributors.flatMap((item) => item.peerCohorts).map((cohort) => [
        stableFingerprint(cohort, 'manifestation-peer-cohort'),
        cohort,
      ]),
    ).values()];
    const comparatorPropertyIds = stableStrings([
      ...contributors.flatMap((item) => item.comparatorPropertyIds),
      ...peerCohorts.flatMap((cohort) => cohort.peerPropertyIds),
    ]);
    // Scope evidence must identify every property's data used to establish the
    // claim, not only the outlier target.  In particular, a peer baseline is
    // evidence from its comparator hotels and the downstream authorization
    // boundary must be able to reject the whole claim if any peer is outside
    // the current receipt.
    const evaluatedPropertyIds = stableStrings([
      ...contributors.flatMap((item) => item.evaluatedPropertyIds),
      ...comparatorPropertyIds,
    ]);
    const evidenceBases = new Set(contributors.map((item) => item.evidenceBasis));
    const evidenceBasis: PatternEvidenceBasis = evidenceBases.size === 1
      ? contributors[0]?.evidenceBasis ?? 'cross_property_condition'
      : 'cross_property_condition';
    const activityCondition = pattern.semanticRootFamily === 'portfolio_activity_stopped';
    const scopeResult = classifyPatternScope({
      organizationId: prepared.snapshot.organization.id,
      rootKey: pattern.rootKey,
      evidenceBasis,
      eligibleOrganizationPropertyIds: eligiblePropertyIds,
      evaluatedPropertyIds,
      affectedPropertyIds: pattern.affectedPropertyIds,
      groups,
      peerCohorts,
      ...(activityCondition ? {
        minimumCompanyEvidenceCoverageRatio: ACTIVITY_MINIMUM_EVIDENCE_COVERAGE,
        minimumCompanyAffectedShare: ACTIVITY_MINIMUM_AFFECTED_SHARE,
        minimumCompanyAffectedProperties: ACTIVITY_MINIMUM_AFFECTED_PROPERTIES,
        minimumDistinctGroupsForCompany: 2,
        minimumGroupEvidenceCoverageRatio: ACTIVITY_MINIMUM_EVIDENCE_COVERAGE,
        minimumGroupAffectedShare: ACTIVITY_MINIMUM_AFFECTED_SHARE,
        minimumGroupAffectedProperties: ACTIVITY_MINIMUM_AFFECTED_PROPERTIES,
      } : {}),
    });
    const suppressionReasons = stableStrings([
      ...(pattern.status === 'conflicted' ? ['conflicting_manifestations'] : []),
      ...(!scopeResult.ok ? scopeResult.reasons : []),
    ]);
    const decision = suppressionReasons.length === 0 ? 'emit' as const : 'suppress' as const;
    const summary = contributors.length === 1
      ? contributors[0].summary
      : `${contributors[0]?.summary ?? pattern.semanticRootFamily} ${pattern.affectedPropertyIds.length} hotels are affected.`;
    const magnitude = Math.max(0, ...contributors.map((item) => item.magnitude));
    const materialityScore = Math.max(0, ...contributors.map((item) => item.materialityScore));
    const evidence = canonicalize({
      patternFingerprint: pattern.fingerprint,
      manifestations: contributors.map((item) => ({
        fingerprint: item.fingerprint,
        checkId: item.checkId,
        checkVersion: item.checkVersion,
        outcomeKey: item.outcomeKey,
        evidenceFingerprint: stableFingerprint(item.evidence, 'manifestation-evidence'),
      })),
      scope: scopeResult.ok ? scopeResult.classification : { abstained: scopeResult.reasons },
      conflicts: pattern.conflicts,
    });
    const payload = {
      schemaVersion: MANAGEMENT_PATTERN_EVALUATOR_VERSION,
      pattern,
      decision,
      suppressionReasons,
      classification: scopeResult.ok ? scopeResult.classification : null,
      summary,
      magnitude,
      materialityScore,
      affectedPropertyIds: pattern.affectedPropertyIds,
      comparatorPropertyIds,
      manifestationFingerprints: contributors.map((item) => item.fingerprint).sort(),
      evidence,
    };
    return Object.freeze({ ...payload, fingerprint: stableFingerprint(payload, 'final-evaluated-pattern') });
  }).sort((left, right) => (
    (left.decision === right.decision ? 0 : left.decision === 'emit' ? -1 : 1)
    || right.materialityScore - left.materialityScore
    || right.affectedPropertyIds.length - left.affectedPropertyIds.length
    || right.magnitude - left.magnitude
    || left.fingerprint.localeCompare(right.fingerprint)
  ));
  let emittedRank = 0;
  const overflow: {
    candidate: FinalEvaluatedPattern;
    rank: number;
    priorDecision: FinalEvaluatedPattern['decision'];
  }[] = [];
  const budgetedCandidates = Object.freeze(candidates.map((candidate) => {
    if (candidate.decision !== 'emit') return candidate;
    emittedRank += 1;
    if (emittedRank <= MANAGEMENT_PATTERN_MAX_CANDIDATES) return candidate;
    const { fingerprint: _priorFingerprint, ...priorPayload } = candidate;
    const payload = {
      ...priorPayload,
      decision: 'suppress' as const,
      suppressionReasons: stableStrings([
        ...candidate.suppressionReasons,
        'candidate_budget_exceeded',
      ]),
    };
    const suppressed = Object.freeze({
      ...payload,
      fingerprint: stableFingerprint(payload, 'final-evaluated-pattern'),
    });
    overflow.push({ candidate: suppressed, rank: emittedRank, priorDecision: candidate.decision });
    return suppressed;
  }));
  const budgetSuppressions = Object.freeze(overflow.map(({ candidate, rank, priorDecision }) => {
      const payload = {
        schemaVersion: MANAGEMENT_PATTERN_EVALUATOR_VERSION,
        rank,
        reason: 'candidate_budget_exceeded' as const,
        candidateFingerprint: candidate.fingerprint,
        patternFingerprint: candidate.pattern.fingerprint,
        rootKey: candidate.pattern.rootKey,
        semanticRootFamily: candidate.pattern.semanticRootFamily,
        priorDecision,
        materialityScore: candidate.materialityScore,
        magnitude: candidate.magnitude,
        affectedPropertyIds: candidate.affectedPropertyIds,
        manifestationFingerprints: candidate.manifestationFingerprints,
      };
      return Object.freeze({
        ...payload,
        fingerprint: stableFingerprint(payload, 'candidate-budget-suppression'),
      });
    }));
  const payload = { consolidation, candidates: budgetedCandidates, budgetSuppressions };
  return Object.freeze({ ...payload, fingerprint: stableFingerprint(payload, 'finalized-pattern-manifestations') });
}

function rootEvaluation(
  input: Omit<ManagementPatternRootEvaluation, 'schemaVersion' | 'fingerprint'>,
): ManagementPatternRootEvaluation {
  const payload = {
    schemaVersion: MANAGEMENT_PATTERN_EVALUATOR_VERSION,
    ...input,
    checkIds: stableStrings(input.checkIds),
    checkVersions: stableStrings(input.checkVersions),
    supportingOutcomeKeys: stableStrings(input.supportingOutcomeKeys),
    affectedPropertyIds: stableStrings(input.affectedPropertyIds),
    evaluatedPropertyIds: stableStrings(input.evaluatedPropertyIds),
    unavailablePropertyIds: stableStrings(input.unavailablePropertyIds),
    reasonCodes: stableStrings(input.reasonCodes),
    candidateFingerprints: stableStrings(input.candidateFingerprints),
  };
  return Object.freeze({ ...payload, fingerprint: stableFingerprint(payload, 'management-pattern-root-evaluation') });
}

function supportedPresentCandidate(candidate: FinalEvaluatedPattern): boolean {
  return (
    candidate.pattern.status === 'supported'
    && (
      candidate.decision === 'emit'
      || (
        candidate.suppressionReasons.length > 0
        && candidate.suppressionReasons.every((reason) => reason === 'candidate_budget_exceeded')
      )
    )
  );
}

function rootEvaluationsFor(
  prepared: PreparedManagementPatternInputs,
  outcomes: readonly ManagementPatternCheckOutcome[],
  candidates: readonly FinalEvaluatedPattern[],
): readonly ManagementPatternRootEvaluation[] {
  const organizationId = prepared.snapshot.organization.id;
  const outcomeByKey = new Map(outcomes.map((item) => [item.outcomeKey, item]));
  const inputGate = outcomeByKey.get('input-gate');
  const result: ManagementPatternRootEvaluation[] = [];

  const propertyDomains = new Map<string, string | null>(prepared.properties.map((property) => [
    propertyId(property),
    propertySupplyRootSubjectKey(property),
  ]));
  const unassignableSupplyPropertyIds = stableStrings([...propertyDomains.entries()].flatMap(
    ([id, domain]) => domain === null ? [id] : [],
  ));
  const supplySubjects = stableStrings([
    ...[...propertyDomains.values()].flatMap((domain) => domain === null ? [] : [domain]),
    ...(unassignableSupplyPropertyIds.length > 0 ? ['unassignable_domain'] : []),
    ...candidates.flatMap((candidate) => (
      candidate.pattern.semanticRootFamily === 'supply_spend_control'
        ? [candidate.pattern.rootSubjectKey]
        : []
    )),
  ]);
  for (const rootSubjectKey of supplySubjects) {
    const rootKey = stablePatternRootKey({
      organizationId,
      semanticRootFamily: 'supply_spend_control',
      rootSubjectKey,
    });
    const relevantPropertyIds = stableStrings([...propertyDomains.entries()].flatMap(
      ([id, domain]) => (
        domain === rootSubjectKey || (domain === null && rootSubjectKey === 'unassignable_domain')
          ? [id]
          : []
      ),
    ));
    const relevantOutcomes = relevantPropertyIds.flatMap((id) => {
      const item = outcomeByKey.get(`supply:${id}`);
      return item ? [item] : [];
    });
    const rootCandidates = candidates.filter((candidate) => (
      candidate.pattern.semanticRootFamily === 'supply_spend_control'
      && candidate.pattern.rootKey === rootKey
    ));
    const presentCandidates = rootCandidates.filter(supportedPresentCandidate);
    const evaluatedPropertyIds = relevantOutcomes.flatMap((item) => (
      item.result === 'normal' || item.result === 'candidate'
        ? item.targetPropertyId ? [item.targetPropertyId] : []
        : []
    ));
    const unavailablePropertyIds = stableStrings([
      ...unassignableSupplyPropertyIds,
      ...relevantPropertyIds.filter((id) => !evaluatedPropertyIds.includes(id)),
    ]);
    const supportingOutcomeKeys = relevantOutcomes.map((item) => item.outcomeKey);
    let conclusion: ManagementPatternRootEvaluation['conclusion'];
    let reasons: readonly string[];
    if (presentCandidates.length > 0) {
      conclusion = 'present';
      reasons = stableStrings(presentCandidates.flatMap((candidate) => candidate.suppressionReasons));
    } else if (rootCandidates.length > 0) {
      conclusion = 'abstained';
      reasons = stableStrings([
        'candidate_not_safe_to_project',
        ...rootCandidates.flatMap((candidate) => candidate.suppressionReasons),
      ]);
    } else if (rootSubjectKey === 'unassignable_domain') {
      conclusion = 'abstained';
      reasons = stableStrings([
        'supply_domain_unassignable',
        ...relevantOutcomes.flatMap((item) => item.reasonCodes),
      ]);
    } else if (
      relevantPropertyIds.length > 0
      && relevantOutcomes.length === relevantPropertyIds.length
      && relevantOutcomes.every((item) => item.result === 'normal' && item.qualityGate === 'passed')
      && unassignableSupplyPropertyIds.length === 0
    ) {
      conclusion = 'absent';
      reasons = ['all_domain_targets_normal'];
    } else {
      conclusion = 'abstained';
      reasons = stableStrings([
        ...(unassignableSupplyPropertyIds.length > 0
          ? ['portfolio_domain_completeness_unproven']
          : []),
        ...relevantOutcomes.flatMap((item) => item.reasonCodes),
      ]);
    }
    const primaryOutcome = conclusion === 'present'
      ? relevantOutcomes.find((item) => item.result === 'candidate')
      : conclusion === 'absent'
        ? relevantOutcomes.find((item) => item.result === 'normal')
        : relevantOutcomes.find((item) => (
          item.result === 'abstained' || item.result === 'skipped'
        ));
    result.push(rootEvaluation({
      semanticFamily: 'supply_spend_control',
      rootKey,
      rootSubjectKey,
      checkIds: [SUPPLY_SPEND_CHECK_ID],
      checkVersions: [SUPPLY_SPEND_CHECK_VERSION],
      conclusion,
      primaryOutcomeKey: primaryOutcome?.outcomeKey ?? null,
      supportingOutcomeKeys,
      affectedPropertyIds: rootCandidates.flatMap((candidate) => candidate.affectedPropertyIds),
      evaluatedPropertyIds,
      unavailablePropertyIds,
      reasonCodes: reasons,
      candidateFingerprints: rootCandidates.map((candidate) => candidate.fingerprint),
    }));
  }

  const streamIds: readonly ActivityStreamId[] = ['daily_log_closings', 'inventory_counts', 'work_order_flow'];
  for (const streamId of streamIds) {
    const rootSubjectKey = streamId;
    const rootKey = stablePatternRootKey({
      organizationId,
      semanticRootFamily: 'portfolio_activity_stopped',
      rootSubjectKey,
    });
    const checkOutcome = outcomeByKey.get(`activity:${streamId}`);
    const cadence = activityCadences(prepared, streamId);
    const evaluatedPropertyIds = cadence.eligible.map((item) => propertyId(item.property));
    const affectedPropertyIds = cadence.eligible.filter((item) => item.stopped).map((item) => propertyId(item.property));
    const unavailablePropertyIds = prepared.properties
      .map(propertyId)
      .filter((id) => !evaluatedPropertyIds.includes(id));
    const rootCandidates = candidates.filter((candidate) => (
      candidate.pattern.semanticRootFamily === 'portfolio_activity_stopped'
      && candidate.pattern.rootKey === rootKey
    ));
    const presentCandidates = rootCandidates.filter(supportedPresentCandidate);
    let conclusion: ManagementPatternRootEvaluation['conclusion'];
    let reasons: readonly string[];
    if (presentCandidates.length > 0) {
      conclusion = 'present';
      reasons = stableStrings(presentCandidates.flatMap((candidate) => candidate.suppressionReasons));
    } else if (rootCandidates.length > 0) {
      conclusion = 'abstained';
      reasons = stableStrings([
        'candidate_not_safe_to_project',
        ...rootCandidates.flatMap((candidate) => candidate.suppressionReasons),
      ]);
    } else if (
      checkOutcome?.result === 'normal'
      && checkOutcome.qualityGate === 'passed'
      && evaluatedPropertyIds.length === prepared.snapshot.property_count
    ) {
      conclusion = 'absent';
      reasons = affectedPropertyIds.length === 0
        ? ['condition_not_present']
        : ['below_portfolio_pattern_threshold'];
    } else {
      conclusion = 'abstained';
      reasons = stableStrings([
        ...(evaluatedPropertyIds.length !== prepared.snapshot.property_count
          ? ['portfolio_domain_completeness_unproven']
          : []),
        ...(checkOutcome?.reasonCodes ?? ['check_outcome_missing']),
      ]);
    }
    const primaryOutcome = conclusion === 'present'
      ? (checkOutcome?.result === 'candidate' ? checkOutcome : undefined)
      : conclusion === 'absent'
        ? (checkOutcome?.result === 'normal' ? checkOutcome : undefined)
        : (
          checkOutcome?.result === 'abstained' || checkOutcome?.result === 'skipped'
            ? checkOutcome
            : undefined
        );
    result.push(rootEvaluation({
      semanticFamily: 'portfolio_activity_stopped',
      rootKey,
      rootSubjectKey,
      checkIds: [ACTIVITY_STOPPED_CHECK_ID],
      checkVersions: [ACTIVITY_STOPPED_CHECK_VERSION],
      conclusion,
      primaryOutcomeKey: primaryOutcome?.outcomeKey ?? null,
      supportingOutcomeKeys: checkOutcome ? [checkOutcome.outcomeKey] : [],
      affectedPropertyIds,
      evaluatedPropertyIds,
      unavailablePropertyIds,
      reasonCodes: reasons,
      candidateFingerprints: rootCandidates.map((candidate) => candidate.fingerprint),
    }));
  }
  if (inputGate) {
    result.push(rootEvaluation({
      semanticFamily: inputGate.semanticFamily,
      rootKey: inputGate.rootKey,
      rootSubjectKey: inputGate.rootSubjectKey,
      checkIds: [inputGate.checkId],
      checkVersions: [inputGate.checkVersion],
      conclusion: 'abstained',
      primaryOutcomeKey: inputGate.outcomeKey,
      supportingOutcomeKeys: [inputGate.outcomeKey],
      affectedPropertyIds: [],
      evaluatedPropertyIds: [],
      unavailablePropertyIds: prepared.properties.map(propertyId),
      reasonCodes: inputGate.reasonCodes,
      candidateFingerprints: [],
    }));
  }
  return Object.freeze(result.sort((left, right) => (
    left.semanticFamily.localeCompare(right.semanticFamily)
    || left.rootKey.localeCompare(right.rootKey)
  )));
}

function attachAggregateRootAbstentions(
  prepared: PreparedManagementPatternInputs,
  outcomesInput: readonly ManagementPatternCheckOutcome[],
  rootEvaluationsInput: readonly ManagementPatternRootEvaluation[],
): {
  outcomes: readonly ManagementPatternCheckOutcome[];
  rootEvaluations: readonly ManagementPatternRootEvaluation[];
} {
  const outcomes = [...outcomesInput];
  const rootEvaluations = rootEvaluationsInput.map((evaluation) => {
    if (evaluation.primaryOutcomeKey !== null) return evaluation;
    if (evaluation.conclusion !== 'abstained') {
      throw new TypeError('present/absent root evaluation is missing a compatible primary outcome');
    }
    const checkId = evaluation.checkIds[0];
    const checkVersion = evaluation.checkVersions[0];
    if (!checkId || !checkVersion) throw new TypeError('root evaluation has no detector identity');
    const outcomeKey = `root-abstention:${evaluation.rootKey}`;
    const supportingOutcomes = outcomes.filter((item) => (
      evaluation.supportingOutcomeKeys.includes(item.outcomeKey)
    ));
    outcomes.push(outcome({
      outcomeKey,
      checkId,
      checkVersion,
      semanticFamily: evaluation.semanticFamily,
      rootKey: evaluation.rootKey,
      rootSubjectKey: evaluation.rootSubjectKey,
      targetPropertyId: null,
      result: 'abstained',
      qualityGate: 'failed',
      inputFingerprint: stableFingerprint({
        preparedInputFingerprint: prepared.fingerprint,
        rootKey: evaluation.rootKey,
        supportingOutcomeKeys: evaluation.supportingOutcomeKeys,
      }, 'aggregate-root-abstention-input'),
      reasonCodes: stableStrings([
        'aggregate_root_abstention',
        ...evaluation.reasonCodes,
      ]),
      evidence: canonicalize({
        rootEvaluationFingerprint: evaluation.fingerprint,
        supportingOutcomeKeys: evaluation.supportingOutcomeKeys,
        affectedPropertyIds: evaluation.affectedPropertyIds,
        evaluatedPropertyIds: evaluation.evaluatedPropertyIds,
        unavailablePropertyIds: evaluation.unavailablePropertyIds,
      }),
      observationFingerprints: stableStrings(supportingOutcomes.flatMap((item) => (
        item.observationFingerprints
      ))),
      cohort: null,
      comparison: null,
      candidateFingerprints: [],
      rowsExamined: prepared.properties.length,
    }));
    const {
      schemaVersion: _schemaVersion,
      fingerprint: _fingerprint,
      ...evaluationPayload
    } = evaluation;
    return rootEvaluation({
      ...evaluationPayload,
      primaryOutcomeKey: outcomeKey,
      supportingOutcomeKeys: [...evaluation.supportingOutcomeKeys, outcomeKey],
    });
  });
  outcomes.sort((left, right) => left.outcomeKey.localeCompare(right.outcomeKey));
  rootEvaluations.sort((left, right) => (
    left.semanticFamily.localeCompare(right.semanticFamily)
    || left.rootKey.localeCompare(right.rootKey)
  ));
  const coveredOutcomeKeys = new Set(rootEvaluations.flatMap((item) => item.supportingOutcomeKeys));
  for (const item of outcomes) {
    if (!coveredOutcomeKeys.has(item.outcomeKey)) {
      throw new TypeError(`management pattern outcome ${item.outcomeKey} has no root evaluation`);
    }
    const roots = rootEvaluations.filter((evaluation) => (
      evaluation.supportingOutcomeKeys.includes(item.outcomeKey)
    ));
    if (roots.some((evaluation) => (
      evaluation.semanticFamily !== item.semanticFamily
      || evaluation.rootKey !== item.rootKey
      || evaluation.rootSubjectKey !== item.rootSubjectKey
    ))) {
      throw new TypeError(`management pattern outcome ${item.outcomeKey} crosses root domains`);
    }
  }
  return {
    outcomes: Object.freeze(outcomes),
    rootEvaluations: Object.freeze(rootEvaluations),
  };
}

export function evaluateManagementPatterns(
  prepared: PreparedManagementPatternInputs,
): ManagementPatternEvaluation {
  const sourceBudgetExceeded = (
    prepared.snapshot.source_budget_exceeded
    || prepared.snapshot.property_count > MANAGEMENT_PATTERN_MAX_PROPERTIES
    || prepared.properties.length > MANAGEMENT_PATTERN_MAX_PROPERTIES
  );
  const contractReasons = preparedContractReasons(prepared);
  let outcomes: ManagementPatternCheckOutcome[] = [];
  let manifestations: EvaluatedPatternManifestation[] = [];
  const reasonCodes: string[] = [];
  if (sourceBudgetExceeded || contractReasons.length > 0) {
    reasonCodes.push(...(
      sourceBudgetExceeded ? ['source_property_budget_exceeded'] : []
    ), ...contractReasons);
    outcomes = [outcome({
      outcomeKey: 'input-gate',
      checkId: 'management_pattern_input_gate',
      checkVersion: MANAGEMENT_PATTERN_EVALUATOR_VERSION,
      ...outcomeRoot(
        prepared.snapshot.organization.id,
        'management_pattern_input_gate',
        'portfolio_input_contract',
      ),
      targetPropertyId: null,
      result: 'abstained',
      qualityGate: 'failed',
      inputFingerprint: prepared.fingerprint,
      reasonCodes: stableStrings([
        ...(sourceBudgetExceeded ? ['source_property_budget_exceeded'] : []),
        ...contractReasons,
      ]),
      evidence: canonicalize({
        snapshotPropertyCount: prepared.snapshot.property_count,
        preparedPropertyCount: prepared.properties.length,
        sourceMaximumProperties: prepared.snapshot.max_properties,
        maximumProperties: MANAGEMENT_PATTERN_MAX_PROPERTIES,
        contractReasons,
      }),
      observationFingerprints: [],
      cohort: null,
      comparison: null,
      candidateFingerprints: [],
      rowsExamined: 0,
    })];
  } else {
    const supply = evaluateSupply(prepared);
    const activity = evaluateActivity(prepared);
    outcomes = [...supply.outcomes, ...activity.outcomes];
    manifestations = [...supply.manifestations, ...activity.manifestations];
  }
  outcomes.sort((left, right) => left.outcomeKey.localeCompare(right.outcomeKey));
  manifestations.sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
  const finalized = finalizeEvaluatedManifestations(prepared, manifestations);
  if (finalized.budgetSuppressions.length > 0) {
    reasonCodes.push('candidate_budget_exceeded');
  }
  const initialRootEvaluations = rootEvaluationsFor(prepared, outcomes, finalized.candidates);
  const rooted = attachAggregateRootAbstentions(prepared, outcomes, initialRootEvaluations);
  outcomes = [...rooted.outcomes];
  const rootEvaluations = rooted.rootEvaluations;
  const payload = {
    schemaVersion: MANAGEMENT_PATTERN_EVALUATOR_VERSION,
    organizationId: prepared.snapshot.organization.id,
    evaluatedAt: prepared.snapshot.analysis_window_anchor,
    inputFingerprint: prepared.fingerprint,
    policyManifest: policyManifest(),
    outcomes,
    manifestations,
    consolidation: finalized.consolidation,
    candidates: finalized.candidates,
    budgetSuppressions: finalized.budgetSuppressions,
    rootEvaluations,
    reasonCodes: stableStrings(reasonCodes),
  };
  return Object.freeze({ ...payload, fingerprint: stableFingerprint(payload, 'management-pattern-evaluation') });
}
