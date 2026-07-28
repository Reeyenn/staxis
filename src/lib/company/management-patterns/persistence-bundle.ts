import {
  ACTIVITY_STOPPED_CHECK_ID,
  MANAGEMENT_PATTERN_DEDUPE_POLICY_VERSION,
  MANAGEMENT_PATTERN_ENGINE_VERSION,
  MANAGEMENT_PATTERN_EVIDENCE_FORMAT,
  MANAGEMENT_PATTERN_EVIDENCE_SCHEMA_VERSION,
  MANAGEMENT_PATTERN_SCOPE_POLICY_VERSION,
  MANAGEMENT_PATTERN_SOURCE_QUERY_VERSION,
  SUPPLY_SPEND_CHECK_ID,
  SUPPLY_SPEND_COHORT_POLICY,
  SUPPLY_SPEND_MATERIALITY_POLICY,
  SUPPLY_SPEND_METRIC_DEFINITION,
} from './definitions';
import { sha256Text, stableFingerprint } from './canonical';
import type {
  EvaluatedPatternManifestation,
  FinalEvaluatedPattern,
  ManagementPatternCheckOutcome,
  ManagementPatternEvaluation,
  ManagementPatternRootEvaluation,
} from './evaluator';
import { replaySupplyCohortDecision } from './evaluator';
import { deterministicUuidFromFingerprint } from './identity';
import type { MetricObservation } from './observation';
import { managementPatternMetricSourceFactDrafts } from './source-facts';
import type {
  ActivityStreamId,
  PreparedManagementPatternInputs,
  PreparedManagementPatternProperty,
} from './prepare-inputs';
import type { MetricCohortDecision } from './cohort';
import {
  MANAGEMENT_PATTERN_EVALUATOR_VERSION,
  MANAGEMENT_PATTERN_NORMALIZATION_VERSION,
} from './versions';

type JsonObject = Readonly<Record<string, unknown>>;

export interface ManagementPatternInputBatch {
  readonly runProperties: readonly JsonObject[];
  readonly metricObservations: readonly JsonObject[];
  readonly metricSourceFacts: readonly JsonObject[];
}

export interface ManagementPatternResultBatch {
  readonly cohorts: readonly JsonObject[];
  readonly cohort_members: readonly JsonObject[];
  readonly check_outcomes: readonly JsonObject[];
  readonly check_observations: readonly JsonObject[];
  readonly candidates: readonly JsonObject[];
  readonly candidate_outcomes: readonly JsonObject[];
  readonly candidate_properties: readonly JsonObject[];
  readonly candidate_local_instances: readonly JsonObject[];
  readonly run_roots: readonly JsonObject[];
  readonly reconciliations: readonly JsonObject[];
  readonly reconciliation_outcomes: readonly JsonObject[];
}

export interface ManagementPatternPersistenceBundle {
  readonly input: ManagementPatternInputBatch;
  readonly results: ManagementPatternResultBatch;
  readonly counts: Readonly<{
    properties: number;
    includedProperties: number;
    excludedProperties: number;
    cohorts: number;
    cohortMembers: number;
    observations: number;
    sourceFacts: number;
    observationLinks: number;
    checks: number;
    outcomes: number;
    candidates: number;
    abstentions: number;
    qualityFailures: number;
  }>;
  readonly fingerprint: string;
}

const SHA256_RX = /^[0-9a-f]{64}$/;

function nextDate(localDate: string): string {
  const date = new Date(`${localDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function localBoundary(
  date: string,
  cutoffHour: number | null,
): string {
  return `${date}T${String(cutoffHour ?? 0).padStart(2, '0')}:00:00`;
}

function signedAgeSeconds(evaluatedAt: string, freshThrough: string): number {
  return (Date.parse(evaluatedAt) - Date.parse(freshThrough)) / 1_000;
}

function sourceHash(source: MetricObservation['source']): string {
  return SHA256_RX.test(source.sourceRevision)
    ? source.sourceRevision
    : stableFingerprint(source, 'persisted-observation-source');
}

function unique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values.filter(Boolean))].sort());
}

function propertyById(
  prepared: PreparedManagementPatternInputs,
): ReadonlyMap<string, PreparedManagementPatternProperty> {
  return new Map(prepared.properties.map((property) => [property.source.property_id, property]));
}

interface ObservationContext {
  readonly observation: MetricObservation;
  readonly normalizedValue: number | null;
  readonly normalizedUnit: string | null;
  readonly normalizedCurrency: string | null;
  readonly normalizedCurrencyScale: number | null;
  readonly normalizationDefinitionHash: string | null;
  readonly normalizationReasons: readonly string[];
  readonly preparationReasons: readonly string[];
  readonly activityEventDates: readonly string[] | null;
  readonly sourceWatermarkReceipt: JsonObject;
  readonly denominatorWatermarkReceipt: JsonObject | null;
  readonly sourceCoverageReceipt: JsonObject;
}

function observationContexts(
  prepared: PreparedManagementPatternInputs,
): readonly ObservationContext[] {
  const contexts: ObservationContext[] = [];
  for (const property of prepared.properties) {
    if (property.supply.observation !== null) {
      const normalization = property.supply.normalization;
      contexts.push({
        observation: property.supply.observation,
        normalizedValue: normalization?.ok === true ? normalization.value.value : null,
        normalizedUnit: normalization?.ok === true ? normalization.value.unit : null,
        normalizedCurrency: normalization?.ok === true ? normalization.value.currency : null,
        normalizedCurrencyScale: normalization?.ok === true
          ? normalization.value.currencyStorageScale
          : null,
        normalizationDefinitionHash: normalization?.ok === true
          ? normalization.value.definitionFingerprint
          : normalization?.definitionFingerprint ?? null,
        normalizationReasons: normalization?.ok === false ? normalization.reasons : [],
        preparationReasons: property.supply.reasonCodes,
        activityEventDates: null,
        sourceWatermarkReceipt: property.source.supply.source_watermark,
        denominatorWatermarkReceipt: property.source.rooms_sold.source_watermark,
        sourceCoverageReceipt: {
          expected_periods: property.source.supply.expected_periods,
          observed_periods: property.source.supply.observed_periods,
          usable_periods: property.source.supply.usable_periods,
          denominator_expected_days: property.source.rooms_sold.expected_days,
          denominator_observed_days: property.source.rooms_sold.observed_days,
          denominator_partial_days: property.source.rooms_sold.partial_days,
          normalization_eligible: property.source.rooms_sold.normalization_eligible,
        },
      });
    }
    for (const activity of Object.values(property.activities)) {
      if (activity.observation === null) continue;
      contexts.push({
        observation: activity.observation,
        normalizedValue: null,
        normalizedUnit: null,
        normalizedCurrency: null,
        normalizedCurrencyScale: null,
        normalizationDefinitionHash: null,
        normalizationReasons: [],
        preparationReasons: activity.reasonCodes,
        activityEventDates: activity.eventDates,
        sourceWatermarkReceipt: property.source.activity[activity.streamId].source_watermark,
        denominatorWatermarkReceipt: null,
        sourceCoverageReceipt: {
          query_coverage_status:
            property.source.activity[activity.streamId].query_coverage_status,
          coverage_reason_codes:
            property.source.activity[activity.streamId].coverage_reason_codes,
          absence_detection_eligible:
            property.source.activity[activity.streamId].absence_detection_eligible,
          relationship_covers_window: property.source.activity.relationship_covers_window,
        },
      });
    }
  }
  const uniqueContexts = new Map<string, ObservationContext>();
  for (const context of contexts) uniqueContexts.set(context.observation.fingerprint, context);
  return Object.freeze([...uniqueContexts.values()].sort((left, right) => (
    left.observation.fingerprint.localeCompare(right.observation.fingerprint)
  )));
}

function observationQualityStatus(context: ObservationContext): string {
  const reasons = unique([
    ...context.observation.quality.qualityFlags,
    ...context.preparationReasons,
    ...context.normalizationReasons,
  ]);
  if (reasons.some((reason) => reason.includes('future'))) return 'invalid';
  if (reasons.some((reason) => reason.includes('stale'))) return 'stale';
  if (reasons.some((reason) => reason.includes('denominator_missing'))) return 'missing_denominator';
  if (reasons.some((reason) => (
    reason.includes('mismatch') || reason.includes('incompatible') || reason.includes('currency')
  ))) return 'incompatible';
  if (reasons.length > 0 || context.observation.quality.completenessRatio < 1) return 'partial';
  return 'usable';
}

function persistedQualityReasons(context: ObservationContext): readonly string[] {
  const observation = context.observation;
  const reasons = [
    ...observation.quality.qualityFlags,
    ...context.preparationReasons,
    ...context.normalizationReasons,
  ];
  if (signedAgeSeconds(observation.observedAt, observation.quality.freshThrough) < 0) {
    reasons.push('future_source_timestamp');
  }
  if (
    observation.denominator !== null
    && signedAgeSeconds(observation.observedAt, observation.denominator.quality.freshThrough) < 0
  ) reasons.push('future_denominator_source_timestamp');
  return unique(reasons);
}

function observationRow(context: ObservationContext): JsonObject {
  const observation = context.observation;
  const denominator = observation.denominator;
  const qualityStatus = observationQualityStatus(context);
  const normalized = context.normalizedValue !== null && qualityStatus === 'usable';
  return Object.freeze({
    id: deterministicUuidFromFingerprint(observation.fingerprint),
    property_id: observation.propertyId,
    cohort_id: null,
    metric_key: observation.metricId,
    metric_version: observation.metricVersion,
    raw_value: observation.rawValue,
    raw_unit: observation.rawUnit,
    raw_currency_code: observation.rawCurrency,
    raw_currency_minor_unit_exponent: observation.rawCurrencyStorageScale,
    denominator_key: denominator?.kind ?? null,
    denominator_value: denominator?.value ?? null,
    denominator_unit: denominator?.unit ?? null,
    denominator_window_kind: denominator?.window.kind ?? null,
    denominator_window_start_local: denominator === null
      ? null
      : localBoundary(
        denominator.window.localStartDate,
        denominator.window.businessDateCutoffHour,
      ),
    denominator_window_end_local: denominator === null
      ? null
      : localBoundary(
        nextDate(denominator.window.localEndDate),
        denominator.window.businessDateCutoffHour,
      ),
    denominator_window_timezone: denominator?.window.timeZone ?? null,
    denominator_business_date_cutoff_hour:
      denominator?.window.businessDateCutoffHour ?? null,
    denominator_window_start_utc: denominator?.window.utcStart ?? null,
    denominator_window_end_utc: denominator?.window.utcEnd ?? null,
    denominator_as_of: denominator?.source.extractedAt ?? null,
    denominator_completeness_ratio: denominator?.quality.completenessRatio ?? null,
    denominator_freshness_age_seconds: denominator === null
      ? null
      : signedAgeSeconds(observation.observedAt, denominator.quality.freshThrough),
    denominator_source_query_id: denominator?.source.queryId ?? null,
    denominator_source_query_version: denominator?.source.queryVersion ?? null,
    denominator_source_query: denominator === null ? null : {
      parameters: denominator.source.parameters,
      extracted_at: denominator.source.extractedAt,
      record_count: denominator.source.recordCount,
    },
    denominator_source_watermark: denominator === null ? null : {
      fresh_through: denominator.quality.freshThrough,
      source_revision: denominator.source.sourceRevision,
      receipt: context.denominatorWatermarkReceipt,
    },
    denominator_source_snapshot_hash: denominator === null
      ? null
      : sourceHash(denominator.source),
    normalized_value: normalized ? context.normalizedValue : null,
    normalized_unit: normalized ? context.normalizedUnit : null,
    normalized_currency_code: normalized ? context.normalizedCurrency : null,
    normalized_currency_minor_unit_exponent: normalized
      ? context.normalizedCurrencyScale
      : null,
    currency_conversion_rate: null,
    currency_conversion_as_of: null,
    currency_conversion_source_query_id: null,
    currency_conversion_source_query_version: null,
    currency_conversion_source_snapshot_hash: null,
    normalization_method: normalized ? 'divide_by_declared_denominator' : null,
    normalization_policy_version: denominator === null
      ? null
      : MANAGEMENT_PATTERN_NORMALIZATION_VERSION,
    normalization_definition_hash: denominator === null
      ? null
      : context.normalizationDefinitionHash,
    normalization_window_alignment: denominator === null
      ? null
      : SUPPLY_SPEND_METRIC_DEFINITION.windowAlignment,
    window_kind: observation.window.kind,
    window_start_local: localBoundary(
      observation.window.localStartDate,
      observation.window.businessDateCutoffHour,
    ),
    window_end_local: localBoundary(
      nextDate(observation.window.localEndDate),
      observation.window.businessDateCutoffHour,
    ),
    window_timezone: observation.window.timeZone,
    business_date_cutoff_hour: observation.window.businessDateCutoffHour,
    window_start_utc: observation.window.utcStart,
    window_end_utc: observation.window.utcEnd,
    as_of: observation.observedAt,
    completeness_ratio: observation.quality.completenessRatio,
    freshness_age_seconds: signedAgeSeconds(
      observation.observedAt,
      observation.quality.freshThrough,
    ),
    quality_status: qualityStatus,
    quality_reasons: persistedQualityReasons(context),
    source_query_id: observation.source.queryId,
    source_query_version: observation.source.queryVersion,
    source_query: {
      parameters: observation.source.parameters,
      extracted_at: observation.source.extractedAt,
      record_count: observation.source.recordCount,
    },
    source_watermark: {
      fresh_through: observation.quality.freshThrough,
      source_revision: observation.source.sourceRevision,
      receipt: context.sourceWatermarkReceipt,
    },
    source_snapshot_hash: sourceHash(observation.source),
    metadata: {
      evidence_format: MANAGEMENT_PATTERN_EVIDENCE_FORMAT,
      observation_fingerprint: observation.fingerprint,
      profile_fingerprint: observation.profileFingerprint,
      relationship_id: observation.relationshipId,
      source_parameters_fingerprint: observation.source.parametersFingerprint,
      coverage_basis: observation.quality.coverageBasis,
      observed_points: observation.quality.observedPoints,
      expected_points: observation.quality.expectedPoints,
      denominator_fingerprint: denominator?.fingerprint ?? null,
      normalization_reasons: context.normalizationReasons,
      activity_event_dates: context.activityEventDates,
      source_coverage_receipt: context.sourceCoverageReceipt,
    },
  });
}

function runPropertyRow(property: PreparedManagementPatternProperty): JsonObject {
  const source = property.source;
  const profile = property.profile;
  return Object.freeze({
    property_id: source.property_id,
    property_name: source.property_name,
    membership_relationship_id: source.relationship.id,
    membership_snapshot: {
      relationship: source.relationship,
      groups: source.groups,
      topology_exclusions: source.run_exclusion_codes,
    },
    profile_id: source.profile.id,
    profile_snapshot: profile ?? {
      source_profile: source.profile,
      invalid: true,
    },
    timezone_name: source.profile.timezone,
    business_date_cutoff_hour: profile?.businessDateCutoffHour ?? null,
    currency_code: profile?.operatingCurrency?.code ?? null,
    currency_minor_unit_exponent:
      source.profile.currency_minor_unit_exponent ?? null,
    eligibility_status: property.runExclusionCodes.length === 0 ? 'included' : 'excluded',
    exclusion_codes: property.runExclusionCodes,
    property_snapshot_hash: property.fingerprint,
  });
}

export function buildManagementPatternInputBatch(
  prepared: PreparedManagementPatternInputs,
): ManagementPatternInputBatch {
  const runProperties = Object.freeze(prepared.properties.map(runPropertyRow));
  const metricObservations = Object.freeze(observationContexts(prepared).map(observationRow));
  const metricSourceFacts = Object.freeze(prepared.properties.flatMap((property) => {
    if (property.supply.observation === null) return [];
    const observationId = deterministicUuidFromFingerprint(property.supply.observation.fingerprint);
    return managementPatternMetricSourceFactDrafts(property.source).map((fact) => Object.freeze({
      observation_id: observationId,
      fact_role: fact.factRole,
      fact_kind: fact.factKind,
      fact_key: fact.factKey,
      source_query_id: fact.sourceQueryId,
      source_query_version: fact.sourceQueryVersion,
      source_recorded_at: fact.sourceRecordedAt,
      included_in_aggregate: fact.includedInAggregate,
      numeric_value: fact.numericValue,
      fact_payload: fact.factPayload,
    }));
  }).sort((left, right) => (
    String(left.observation_id).localeCompare(String(right.observation_id))
    || String(left.fact_role).localeCompare(String(right.fact_role))
    || String(left.fact_key).localeCompare(String(right.fact_key))
  )));
  return Object.freeze({ runProperties, metricObservations, metricSourceFacts });
}

function cohortId(cohort: MetricCohortDecision): string {
  return deterministicUuidFromFingerprint(cohort.fingerprint);
}

function exclusionCodes(
  reasons: MetricCohortDecision['exclusions'][number]['reasons'],
): readonly string[] {
  return unique(reasons.map((reason) => (
    reason.dimension ? `${reason.code}:${reason.dimension}` : reason.code
  )));
}

function cohortRows(
  prepared: PreparedManagementPatternInputs,
  decisions: readonly MetricCohortDecision[],
): { readonly cohorts: readonly JsonObject[]; readonly members: readonly JsonObject[] } {
  const byFingerprint = new Map<string, MetricCohortDecision>();
  for (const decision of decisions) byFingerprint.set(decision.fingerprint, decision);
  const profiles = propertyById(prepared);
  const cohorts: JsonObject[] = [];
  const members: JsonObject[] = [];
  for (const cohort of [...byFingerprint.values()].sort((left, right) => (
    left.fingerprint.localeCompare(right.fingerprint)
  ))) {
    const id = cohortId(cohort);
    const formed = cohort.status !== 'abstained';
    const memberByProperty = new Map(cohort.members.map((member) => [member.propertyId, member]));
    const exclusionByProperty = new Map(cohort.exclusions.map((exclusion) => (
      [exclusion.propertyId, exclusion] as const
    )));
    const propertyIds = unique([
      cohort.targetPropertyId,
      ...cohort.members.map((member) => member.propertyId),
      ...cohort.exclusions.map((exclusion) => exclusion.propertyId),
    ]);
    let included = 0;
    let excluded = 0;
    for (const propertyId of propertyIds) {
      const member = memberByProperty.get(propertyId);
      const exclusion = exclusionByProperty.get(propertyId);
      const isIncluded = formed && member !== undefined && propertyId !== cohort.targetPropertyId;
      if (isIncluded) included += 1;
      else excluded += 1;
      const profileId = profiles.get(propertyId)?.source.profile.id ?? null;
      const codes = isIncluded ? [] : unique([
        ...(exclusion ? exclusionCodes(exclusion.reasons) : []),
        ...(!formed && member ? ['cohort_below_minimum_peers'] : []),
        ...(propertyId === cohort.targetPropertyId ? ['target_leave_one_out'] : []),
      ]);
      members.push(Object.freeze({
        cohort_id: id,
        property_id: propertyId,
        profile_id: profileId,
        membership_status: isIncluded ? 'included' : 'excluded',
        member_role: propertyId === cohort.targetPropertyId ? 'target' : 'comparator',
        exclusion_codes: codes,
        normalized_dimensions: {
          matched: member?.matchedDimensions ?? {},
          audit_exclusions: isIncluded && exclusion
            ? exclusionCodes(exclusion.reasons)
            : [],
        },
        distance_score: null,
        comparison_weight: isIncluded ? 1 : null,
        decision_reason: isIncluded
          ? `included by ${cohort.status} cohort level`
          : codes.join(',').slice(0, 500) || 'excluded by cohort viability policy',
      }));
    }
    const level = cohort.status === 'abstained' ? cohort.finalLevel : cohort.selectedLevel;
    const dimensions = cohort.activeDimensions;
    cohorts.push(Object.freeze({
      id,
      cohort_key: cohort.fingerprint,
      definition_version: SUPPLY_SPEND_COHORT_POLICY.policyVersion,
      definition_hash: cohort.policyFingerprint,
      target_property_id: cohort.targetPropertyId,
      status: cohort.status,
      fallback_level: level,
      minimum_member_count: cohort.minimumPeers,
      eligible_member_count: propertyIds.length,
      included_member_count: included,
      excluded_member_count: excluded,
      dimension_keys: dimensions,
      definition: {
        metric_id: cohort.metricId,
        policy: SUPPLY_SPEND_COHORT_POLICY,
        coverage_policy: {
          minimum_usable_coverage_ratio: cohort.minimumUsableCoverageRatio,
          population_basis: 'dimension_compatible_leave_one_out_peers',
        },
        active_dimensions: dimensions,
        relaxed_dimensions: cohort.relaxedDimensions,
        attempts: cohort.attempts,
      },
      quality: {
        target_profile_fingerprint: cohort.targetProfileFingerprint,
        as_of: cohort.asOf,
        cohort_fingerprint: cohort.fingerprint,
        comparable_peer_count: cohort.status === 'abstained'
          ? cohort.attempts.at(-1)?.comparablePeerCount ?? 0
          : cohort.comparablePeerCount,
        usable_peer_count: cohort.status === 'abstained'
          ? cohort.attempts.at(-1)?.usablePeerCount ?? 0
          : cohort.usablePeerCount,
        usable_coverage_ratio: cohort.status === 'abstained'
          ? cohort.attempts.at(-1)?.usableCoverageRatio ?? 0
          : cohort.usableCoverageRatio,
        minimum_usable_coverage_ratio: cohort.minimumUsableCoverageRatio,
      },
      abstention_reason: cohort.status === 'abstained' ? cohort.reason : null,
    }));
  }
  return Object.freeze({
    cohorts: Object.freeze(cohorts),
    members: Object.freeze(members),
  });
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function declaredCohortFingerprint(outcome: ManagementPatternCheckOutcome): string | null {
  const evidence = objectValue(outcome.evidence);
  if (evidence === null) return null;
  if (typeof evidence.cohortFingerprint === 'string') return evidence.cohortFingerprint;
  const reference = objectValue(evidence.cohortReference);
  if (reference !== null && typeof reference.fingerprint === 'string') return reference.fingerprint;
  const decision = objectValue(evidence.cohortDecision);
  if (decision !== null && typeof decision.fingerprint === 'string') return decision.fingerprint;
  return null;
}

function declaredComparisonFingerprint(outcome: ManagementPatternCheckOutcome): string | null {
  if (outcome.comparison !== null) return outcome.comparison.fingerprint;
  const evidence = objectValue(outcome.evidence);
  if (evidence === null) return null;
  if (typeof evidence.comparisonFingerprint === 'string') return evidence.comparisonFingerprint;
  const comparison = objectValue(evidence.comparison);
  return comparison !== null && typeof comparison.fingerprint === 'string'
    ? comparison.fingerprint
    : null;
}

/**
 * Compact evaluator JSON references cohorts by fingerprint. Rebuild the exact
 * membership graph from the immutable prepared inputs and fail closed if the
 * replay no longer matches the evaluator's declared receipt.
 */
function replayedCohortDecisions(
  prepared: PreparedManagementPatternInputs,
  outcomes: readonly ManagementPatternCheckOutcome[],
): readonly MetricCohortDecision[] {
  const decisions = new Map<string, MetricCohortDecision>();
  for (const outcome of outcomes) {
    if (outcome.checkId !== SUPPLY_SPEND_CHECK_ID || outcome.targetPropertyId === null) continue;
    const declared = declaredCohortFingerprint(outcome);
    const replayed = replaySupplyCohortDecision(prepared, outcome.targetPropertyId);
    if (declared === null) {
      if (replayed !== null && (
        outcome.result === 'normal' || outcome.result === 'candidate'
      )) {
        throw new TypeError(`supply outcome ${outcome.outcomeKey} omitted its cohort replay receipt`);
      }
      continue;
    }
    if (replayed === null || replayed.fingerprint !== declared) {
      throw new TypeError(`supply outcome ${outcome.outcomeKey} cohort replay fingerprint mismatch`);
    }
    decisions.set(replayed.fingerprint, replayed);
  }
  return Object.freeze([...decisions.values()].sort((left, right) => (
    left.fingerprint.localeCompare(right.fingerprint)
  )));
}

interface OutcomePersistenceContext {
  readonly rows: readonly JsonObject[];
  readonly idByKey: ReadonlyMap<string, string>;
  readonly detectorByKey: ReadonlyMap<string, Readonly<{
    checkId: string;
    checkVersion: string;
  }>>;
  readonly rootByOutcomeKey: ReadonlyMap<string, ManagementPatternRootEvaluation>;
  readonly syntheticPrimaryByRoot: ReadonlyMap<string, string>;
}

function outcomeRootAssignments(
  evaluation: ManagementPatternEvaluation,
): ReadonlyMap<string, ManagementPatternRootEvaluation> {
  const assignments = new Map<string, ManagementPatternRootEvaluation>();
  for (const root of evaluation.rootEvaluations) {
    for (const key of unique([
      ...(root.primaryOutcomeKey === null ? [] : [root.primaryOutcomeKey]),
      ...root.supportingOutcomeKeys,
    ])) {
      const existing = assignments.get(key);
      if (existing && existing.rootKey !== root.rootKey) {
        throw new TypeError(`check outcome ${key} is assigned to more than one root`);
      }
      assignments.set(key, root);
    }
  }
  return assignments;
}

function candidateContributors(
  evaluation: ManagementPatternEvaluation,
  candidate: FinalEvaluatedPattern,
): readonly EvaluatedPatternManifestation[] {
  const wanted = new Set(candidate.manifestationFingerprints);
  return Object.freeze(evaluation.manifestations
    .filter((manifestation) => wanted.has(manifestation.fingerprint))
    .sort((left, right) => (
      left.outcomeKey.localeCompare(right.outcomeKey)
      || left.fingerprint.localeCompare(right.fingerprint)
    )));
}

function candidateCountsByOutcome(
  evaluation: ManagementPatternEvaluation,
): ReadonlyMap<string, number> {
  const candidateIdsByOutcome = new Map<string, Set<string>>();
  for (const candidate of evaluation.candidates) {
    for (const contributor of candidateContributors(evaluation, candidate)) {
      const ids = candidateIdsByOutcome.get(contributor.outcomeKey) ?? new Set<string>();
      ids.add(candidate.fingerprint);
      candidateIdsByOutcome.set(contributor.outcomeKey, ids);
    }
  }
  return new Map([...candidateIdsByOutcome.entries()].map(([key, ids]) => [key, ids.size]));
}

function outcomePersistence(
  evaluation: ManagementPatternEvaluation,
  cohortIds: ReadonlyMap<string, string>,
): OutcomePersistenceContext {
  const rootByOutcomeKey = outcomeRootAssignments(evaluation);
  const candidateCounts = candidateCountsByOutcome(evaluation);
  const idByKey = new Map<string, string>();
  const detectorByKey = new Map<string, Readonly<{
    checkId: string;
    checkVersion: string;
  }>>();
  const rows: JsonObject[] = [];
  for (const outcome of evaluation.outcomes) {
    const root = rootByOutcomeKey.get(outcome.outcomeKey);
    if (!root) {
      throw new TypeError(`check outcome ${outcome.outcomeKey} has no root evaluation lineage`);
    }
    const id = deterministicUuidFromFingerprint(outcome.fingerprint);
    const cohortFingerprint = declaredCohortFingerprint(outcome);
    const persistedCohortId = cohortFingerprint === null
      ? null
      : cohortIds.get(cohortFingerprint);
    if (cohortFingerprint !== null && persistedCohortId === undefined) {
      throw new TypeError(`outcome ${outcome.outcomeKey} references an unpersisted cohort`);
    }
    idByKey.set(outcome.outcomeKey, id);
    detectorByKey.set(outcome.outcomeKey, Object.freeze({
      checkId: outcome.checkId,
      checkVersion: outcome.checkVersion,
    }));
    rows.push(Object.freeze({
      id,
      outcome_key: outcome.outcomeKey,
      check_id: outcome.checkId,
      check_version: outcome.checkVersion,
      semantic_family: root.semanticFamily,
      root_domain_key: root.rootKey,
      target_property_id: outcome.targetPropertyId,
      cohort_id: persistedCohortId ?? null,
      result: outcome.result,
      quality_gate: outcome.qualityGate,
      deterministic: true,
      input_hash: outcome.inputFingerprint,
      outcome_hash: outcome.fingerprint,
      parameters: {
        evaluator_version: MANAGEMENT_PATTERN_EVALUATOR_VERSION,
        root_subject_key: root.rootSubjectKey,
        observation_fingerprints: outcome.observationFingerprints,
        comparison_fingerprint: declaredComparisonFingerprint(outcome),
        policy_manifest_fingerprint: evaluation.policyManifest.fingerprint,
        metric_definition_fingerprint: evaluation.policyManifest.metricDefinitionFingerprint,
        cohort_policy_fingerprint: evaluation.policyManifest.cohortPolicyFingerprint,
        comparison_policy_fingerprint: evaluation.policyManifest.comparisonPolicyFingerprint,
        profile_coverage_policy_fingerprint:
          evaluation.policyManifest.profileCoveragePolicyFingerprint,
        materiality_policy_version: outcome.checkId === SUPPLY_SPEND_CHECK_ID
          ? SUPPLY_SPEND_MATERIALITY_POLICY.policyVersion
          : null,
        materiality_policy_fingerprint: outcome.checkId === SUPPLY_SPEND_CHECK_ID
          ? stableFingerprint(
            SUPPLY_SPEND_MATERIALITY_POLICY,
            'supply-spend-materiality-policy',
          )
          : null,
      },
      evidence: outcome.evidence,
      reason_codes: outcome.reasonCodes,
      candidate_count: candidateCounts.get(outcome.outcomeKey) ?? 0,
      rows_examined: outcome.rowsExamined,
      duration_ms: 0,
    }));
  }

  const syntheticPrimaryByRoot = new Map<string, string>();
  for (const root of evaluation.rootEvaluations) {
    if (root.primaryOutcomeKey !== null) continue;
    const payload = {
      evaluationFingerprint: evaluation.fingerprint,
      rootFingerprint: root.fingerprint,
      outcomeKey: `root-gate:${root.fingerprint}`,
      checkId: root.checkIds[0] ?? 'management_pattern_root_gate',
      checkVersion: root.checkVersions[0] ?? MANAGEMENT_PATTERN_EVALUATOR_VERSION,
      conclusion: root.conclusion,
      reasons: root.reasonCodes,
    };
    const fingerprint = stableFingerprint(payload, 'management-pattern-root-gate-outcome');
    const id = deterministicUuidFromFingerprint(fingerprint);
    syntheticPrimaryByRoot.set(root.rootKey, payload.outcomeKey);
    idByKey.set(payload.outcomeKey, id);
    detectorByKey.set(payload.outcomeKey, Object.freeze({
      checkId: payload.checkId,
      checkVersion: payload.checkVersion,
    }));
    rows.push(Object.freeze({
      id,
      outcome_key: payload.outcomeKey,
      check_id: payload.checkId,
      check_version: payload.checkVersion,
      semantic_family: root.semanticFamily,
      root_domain_key: root.rootKey,
      target_property_id: null,
      cohort_id: null,
      result: 'abstained',
      quality_gate: 'failed',
      deterministic: true,
      input_hash: evaluation.inputFingerprint,
      outcome_hash: fingerprint,
      parameters: {
        evaluator_version: MANAGEMENT_PATTERN_EVALUATOR_VERSION,
        synthetic_root_gate: true,
        root_fingerprint: root.fingerprint,
      },
      evidence: root,
      reason_codes: unique(['root_not_safe_to_reconcile', ...root.reasonCodes]),
      candidate_count: 0,
      rows_examined: root.evaluatedPropertyIds.length,
      duration_ms: 0,
    }));
  }

  return Object.freeze({
    rows: Object.freeze(rows.sort((left, right) => (
      String(left.outcome_key).localeCompare(String(right.outcome_key))
    ))),
    idByKey,
    detectorByKey,
    rootByOutcomeKey,
    syntheticPrimaryByRoot,
  });
}

interface DetectorReceipt {
  readonly detectorIds: readonly string[];
  readonly detectorVersions: JsonObject;
}

/**
 * Build the canonical detector receipt from the outcomes actually linked to a
 * root. This intentionally does not trust a singular primary detector: a root
 * may reconcile evidence from multiple independently versioned checks.
 */
function detectorReceipt(
  root: ManagementPatternRootEvaluation,
  outcomeKeys: readonly string[],
  detectorByKey: OutcomePersistenceContext['detectorByKey'],
): DetectorReceipt {
  const versionsById = new Map<string, Set<string>>();
  for (const key of outcomeKeys) {
    const detector = detectorByKey.get(key);
    if (!detector) throw new TypeError(`root outcome ${key} has no detector identity`);
    if (detector.checkId.length === 0 || detector.checkVersion.length === 0) {
      throw new TypeError(`root outcome ${key} has an empty detector identity`);
    }
    const versions = versionsById.get(detector.checkId) ?? new Set<string>();
    versions.add(detector.checkVersion);
    versionsById.set(detector.checkId, versions);
  }
  const detectorIds = unique([...versionsById.keys()]);
  if (detectorIds.length === 0) throw new TypeError(`root ${root.rootKey} has no linked detectors`);
  const detectorVersions = Object.freeze(Object.fromEntries(detectorIds.map((checkId) => [
    checkId,
    unique([...(versionsById.get(checkId) ?? [])]),
  ])));

  // The evaluator's root declaration is an independent guardrail. Require it
  // to agree with the linked graph so incomplete detector plans fail closed.
  if (JSON.stringify(unique(root.checkIds)) !== JSON.stringify(detectorIds)) {
    throw new TypeError(`root ${root.rootKey} detector IDs do not match its linked outcomes`);
  }
  const linkedVersions = unique([...versionsById.values()].flatMap((versions) => [...versions]));
  if (JSON.stringify(unique(root.checkVersions)) !== JSON.stringify(linkedVersions)) {
    throw new TypeError(`root ${root.rootKey} detector versions do not match its linked outcomes`);
  }
  return Object.freeze({ detectorIds, detectorVersions });
}

function weakestInputAgeDays(
  evaluation: ManagementPatternEvaluation,
  candidate: FinalEvaluatedPattern,
  observationByFingerprint: ReadonlyMap<string, MetricObservation>,
): number | null {
  const outcomeKeys = new Set(candidateContributors(evaluation, candidate).map((item) => item.outcomeKey));
  const ages = evaluation.outcomes
    .filter((outcome) => outcomeKeys.has(outcome.outcomeKey))
    .flatMap((outcome) => outcome.observationFingerprints)
    .flatMap((fingerprint) => {
      const observation = observationByFingerprint.get(fingerprint);
      if (!observation) return [];
      return [Math.max(0, signedAgeSeconds(
        evaluation.evaluatedAt,
        observation.quality.freshThrough,
      ) / 86_400)];
    });
  return ages.length === 0 ? null : Math.max(...ages);
}

function candidateSeverity(candidate: FinalEvaluatedPattern): 'attention' | 'info' {
  return candidate.materialityScore >= 0.75 ? 'attention' : 'info';
}

interface CandidatePersistenceContext {
  readonly rows: readonly JsonObject[];
  readonly lineage: readonly JsonObject[];
  readonly properties: readonly JsonObject[];
  readonly localInstances: readonly JsonObject[];
  readonly idByFingerprint: ReadonlyMap<string, string>;
}

function candidatePersistence(
  prepared: PreparedManagementPatternInputs,
  evaluation: ManagementPatternEvaluation,
  outcomeIds: ReadonlyMap<string, string>,
  observations: readonly ObservationContext[],
): CandidatePersistenceContext {
  const observationByFingerprint = new Map(observations.map((context) => (
    [context.observation.fingerprint, context.observation] as const
  )));
  const propertyMap = propertyById(prepared);
  const budgetByCandidate = new Map(evaluation.budgetSuppressions.map((receipt) => (
    [receipt.candidateFingerprint, receipt] as const
  )));
  const rows: JsonObject[] = [];
  const lineage: JsonObject[] = [];
  const properties: JsonObject[] = [];
  const localInstances: JsonObject[] = [];
  const idByFingerprint = new Map<string, string>();

  for (const candidate of [...evaluation.candidates].sort((left, right) => (
    left.fingerprint.localeCompare(right.fingerprint)
  ))) {
    const contributors = candidateContributors(evaluation, candidate);
    if (contributors.length === 0) {
      throw new TypeError(`candidate ${candidate.fingerprint} has no manifestation lineage`);
    }
    const primary = contributors[0];
    const primaryOutcomeId = outcomeIds.get(primary.outcomeKey);
    if (!primaryOutcomeId) throw new TypeError(`candidate primary outcome ${primary.outcomeKey} is missing`);
    const id = deterministicUuidFromFingerprint(candidate.fingerprint);
    idByFingerprint.set(candidate.fingerprint, id);
    const scopeEvidence = candidate.classification ?? {
      status: 'abstained',
      reasons: candidate.suppressionReasons,
    };
    const budgetReceipt = budgetByCandidate.get(candidate.fingerprint) ?? null;
    rows.push(Object.freeze({
      id,
      check_outcome_id: primaryOutcomeId,
      candidate_key: candidate.fingerprint,
      projection_dedupe_key: `management-pattern:${stableFingerprint({
        semanticFamily: candidate.pattern.semanticRootFamily,
        rootKey: candidate.pattern.rootKey,
      }, 'management-pattern-projection-root')}`,
      semantic_family: candidate.pattern.semanticRootFamily,
      root_key: candidate.pattern.rootKey,
      classified_scope: candidate.classification?.scope ?? null,
      scope_evidence: scopeEvidence,
      decision: candidate.decision,
      suppression_reasons: candidate.suppressionReasons,
      summary: candidate.summary.slice(0, 500),
      severity: candidateSeverity(candidate),
      disposition: 'recommend',
      receipt_query_id: 'management_pattern_source_snapshot',
      evidence: candidate.evidence,
      effective_at: evaluation.evaluatedAt,
      weakest_input_age_days: weakestInputAgeDays(
        evaluation,
        candidate,
        observationByFingerprint,
      ),
      magnitude: candidate.magnitude,
      materiality_score: candidate.materialityScore,
      confidence: Math.min(1, Math.max(0, candidate.materialityScore)),
      confidence_kind: 'threshold_progress_not_probability',
      price_low_cents: null,
      price_high_cents: null,
      price_currency_code: null,
      price_basis: null,
      escalation_factor: 1.5,
      escalation_min_delta: candidate.pattern.semanticRootFamily === 'supply_spend_control'
        ? 20_000
        : 1,
      routing_metadata: {
        schema_version: MANAGEMENT_PATTERN_EVIDENCE_SCHEMA_VERSION,
        scope: candidate.classification?.scope ?? null,
        affected_property_ids: candidate.affectedPropertyIds,
        comparator_property_ids: candidate.comparatorPropertyIds,
        matched_group: candidate.classification?.matchedGroup ?? null,
        downstream_contract: {
          task_routing_supported: true,
          automatic_task_creation: false,
          resolution_tracking_supported: true,
          automatic_assignment: false,
        },
      },
      quality_metadata: {
        evidence_format: MANAGEMENT_PATTERN_EVIDENCE_FORMAT,
        engine_version: MANAGEMENT_PATTERN_ENGINE_VERSION,
        evaluator_version: MANAGEMENT_PATTERN_EVALUATOR_VERSION,
        deterministic: true,
        ai_calls: 0,
        // This is the immutable, decision-complete claim receipt used by
        // bounded downstream readers.  Do not reconstruct direction/window
        // semantics later from prose or from the current detector code: both
        // would make historical runs change meaning after a deploy.
        portfolio_claim_receipt: {
          schema_version: 1,
          status: candidate.pattern.status,
          pattern_key: candidate.pattern.rootKey,
          occurrence_key: candidate.pattern.occurrenceKey,
          assertion: candidate.pattern.assertion,
          directions: candidate.pattern.directions,
          analysis_window_key: candidate.pattern.analysisWindowKey,
        },
        confidence_semantics: 'threshold_progress_not_probability',
        pattern_fingerprint: candidate.pattern.fingerprint,
        manifestation_fingerprints: candidate.manifestationFingerprints,
        budget_suppression: budgetReceipt,
        materiality_policy_version:
          candidate.pattern.semanticRootFamily === 'supply_spend_control'
            ? SUPPLY_SPEND_MATERIALITY_POLICY.policyVersion
            : null,
        materiality_policy_fingerprint:
          candidate.pattern.semanticRootFamily === 'supply_spend_control'
            ? stableFingerprint(
              SUPPLY_SPEND_MATERIALITY_POLICY,
              'supply-spend-materiality-policy',
            )
            : null,
      },
      candidate_hash: candidate.fingerprint,
      candidate_schema_version: MANAGEMENT_PATTERN_EVIDENCE_SCHEMA_VERSION,
    }));

    contributors.forEach((contributor, index) => {
      const outcomeId = outcomeIds.get(contributor.outcomeKey);
      if (!outcomeId) throw new TypeError(`candidate outcome ${contributor.outcomeKey} is missing`);
      lineage.push(Object.freeze({
        candidate_id: id,
        check_outcome_id: outcomeId,
        manifestation_key: contributor.fingerprint,
        lineage_role: index === 0 ? 'primary' : 'supporting',
        manifestation_evidence: {
          manifestation_fingerprint: contributor.fingerprint,
          consolidation_candidate_fingerprint:
            contributor.consolidationCandidate.fingerprint,
          evidence_fingerprint: stableFingerprint(
            contributor.evidence,
            'persisted-manifestation-evidence',
          ),
        },
      }));
    });

    const affected = new Set(candidate.affectedPropertyIds);
    const comparators = new Set(candidate.comparatorPropertyIds.filter((idValue) => !affected.has(idValue)));
    for (const property of prepared.properties) {
      const propertyId = property.source.property_id;
      const role = affected.has(propertyId)
        ? 'affected'
        : comparators.has(propertyId)
          ? 'comparator'
          : 'excluded';
      const codes = role === 'excluded' ? unique([
        ...property.runExclusionCodes,
        ...(candidate.pattern.semanticRootFamily === 'supply_spend_control'
          ? property.supply.reasonCodes
          : []),
        'not_in_candidate_evidence_set',
      ]) : [];
      properties.push(Object.freeze({
        candidate_id: id,
        property_id: propertyId,
        occurrence_role: role,
        exclusion_codes: codes,
        occurrence_evidence: {
          prepared_property_fingerprint: property.fingerprint,
          profile_fingerprint: property.profile?.fingerprint ?? null,
          candidate_fingerprint: candidate.fingerprint,
          role,
        },
      }));
    }

    for (const instance of candidate.pattern.localInstances) {
      if (!propertyMap.has(instance.propertyId)) {
        throw new TypeError(`local instance property ${instance.propertyId} is outside the run`);
      }
      localInstances.push(Object.freeze({
        candidate_id: id,
        property_id: instance.propertyId,
        local_instance_id: deterministicUuidFromFingerprint(instance.fingerprint),
        local_finding_id: null,
        occurrence_at: evaluation.evaluatedAt,
        local_finding_snapshot: {},
        occurrence_evidence: {
          instance_id: instance.instanceId,
          instance_fingerprint: instance.fingerprint,
          source_evidence_fingerprint: instance.evidenceFingerprint,
        },
      }));
    }
  }

  return Object.freeze({
    rows: Object.freeze(rows),
    lineage: Object.freeze(lineage),
    properties: Object.freeze(properties),
    localInstances: Object.freeze(localInstances),
    idByFingerprint,
  });
}

function checkObservationRows(
  evaluation: ManagementPatternEvaluation,
  outcomeIds: ReadonlyMap<string, string>,
  contexts: readonly ObservationContext[],
  cohorts: readonly MetricCohortDecision[],
): readonly JsonObject[] {
  const observations = new Map(contexts.map((context) => (
    [context.observation.fingerprint, context.observation] as const
  )));
  const supplyObservationByProperty = new Map(contexts.flatMap((context) => (
    context.observation.metricId === SUPPLY_SPEND_METRIC_DEFINITION.metricId
      ? [[context.observation.propertyId, context.observation] as const]
      : []
  )));
  const cohortByFingerprint = new Map(cohorts.map((cohort) => (
    [cohort.fingerprint, cohort] as const
  )));
  const rows: JsonObject[] = [];
  for (const outcome of evaluation.outcomes) {
    const outcomeId = outcomeIds.get(outcome.outcomeKey);
    if (!outcomeId) throw new TypeError(`outcome ${outcome.outcomeKey} has no persisted identity`);
    const cohortFingerprint = declaredCohortFingerprint(outcome);
    const replayedCohort = cohortFingerprint === null
      ? null
      : cohortByFingerprint.get(cohortFingerprint) ?? null;
    const baselineFingerprints = replayedCohort === null
      ? []
      : replayedCohort.members.flatMap((member) => {
        const observation = supplyObservationByProperty.get(member.propertyId);
        if (!observation) {
          throw new TypeError(`cohort member ${member.propertyId} has no persisted supply observation`);
        }
        return [observation.fingerprint];
      });
    for (const fingerprint of unique([
      ...outcome.observationFingerprints,
      ...baselineFingerprints,
    ])) {
      const observation = observations.get(fingerprint);
      if (!observation) {
        throw new TypeError(`outcome ${outcome.outcomeKey} references an unpersisted observation`);
      }
      rows.push(Object.freeze({
        check_outcome_id: outcomeId,
        observation_id: deterministicUuidFromFingerprint(fingerprint),
        usage_role: outcome.targetPropertyId === observation.propertyId ? 'target' : 'baseline',
      }));
    }
  }
  return Object.freeze(rows);
}

interface ReconciliationPersistenceContext {
  readonly roots: readonly JsonObject[];
  readonly reconciliations: readonly JsonObject[];
  readonly lineage: readonly JsonObject[];
}

function reconciliationPersistence(
  evaluation: ManagementPatternEvaluation,
  outcomes: OutcomePersistenceContext,
  candidateIds: ReadonlyMap<string, string>,
): ReconciliationPersistenceContext {
  const roots: JsonObject[] = [];
  const reconciliations: JsonObject[] = [];
  const lineage: JsonObject[] = [];
  const coveredOutcomeKeys = new Set<string>();
  for (const root of evaluation.rootEvaluations) {
    const syntheticKey = outcomes.syntheticPrimaryByRoot.get(root.rootKey) ?? null;
    const primaryKey = root.primaryOutcomeKey ?? syntheticKey;
    if (primaryKey === null) throw new TypeError(`root ${root.rootKey} has no primary outcome`);
    const primaryOutcomeId = outcomes.idByKey.get(primaryKey);
    if (!primaryOutcomeId) throw new TypeError(`root primary outcome ${primaryKey} is missing`);
    const outcomeKeys = unique([primaryKey, ...root.supportingOutcomeKeys]);
    for (const key of outcomeKeys) {
      if (!outcomes.idByKey.has(key)) throw new TypeError(`root outcome ${key} is missing`);
      coveredOutcomeKeys.add(key);
    }
    const detectors = detectorReceipt(root, outcomeKeys, outcomes.detectorByKey);
    // The database trigger hashes array_to_json(sorted_keys)::text.  For a
    // text array that representation is byte-for-byte JSON.stringify.
    const expectedOutcomeSetHash = sha256Text(JSON.stringify(outcomeKeys));
    roots.push(Object.freeze({
      semantic_family: root.semanticFamily,
      root_key: root.rootKey,
      root_domain_key: root.rootKey,
      detector_ids: detectors.detectorIds,
      detector_versions: detectors.detectorVersions,
      expected_outcome_count: outcomeKeys.length,
      expected_outcome_keys: outcomeKeys,
      expected_outcome_set_hash: expectedOutcomeSetHash,
      manifest_source: 'detector_plan',
      definition_hash: stableFingerprint({
        semanticFamily: root.semanticFamily,
        rootSubjectKey: root.rootSubjectKey,
        detectorIds: detectors.detectorIds,
        detectorVersions: detectors.detectorVersions,
      }, 'management-pattern-root-definition'),
    }));
    const candidateFingerprints = unique(root.candidateFingerprints);
    const candidateId = root.conclusion === 'present'
      ? candidateIds.get(candidateFingerprints[0] ?? '') ?? null
      : null;
    if (root.conclusion === 'present' && (candidateId === null || candidateFingerprints.length !== 1)) {
      throw new TypeError(`present root ${root.rootKey} must identify exactly one persisted candidate`);
    }
    const reconciliationPayload = {
      rootFingerprint: root.fingerprint,
      primaryOutcomeId,
      candidateId,
      conclusion: root.conclusion,
      outcomeKeys,
      detectorIds: detectors.detectorIds,
      detectorVersions: detectors.detectorVersions,
    };
    const reconciliationHash = stableFingerprint(
      reconciliationPayload,
      'management-pattern-reconciliation',
    );
    const reconciliationId = deterministicUuidFromFingerprint(reconciliationHash);
    reconciliations.push(Object.freeze({
      id: reconciliationId,
      check_outcome_id: primaryOutcomeId,
      candidate_id: candidateId,
      semantic_family: root.semanticFamily,
      root_key: root.rootKey,
      root_domain_key: root.rootKey,
      detector_ids: detectors.detectorIds,
      detector_versions: detectors.detectorVersions,
      conclusion: root.conclusion,
      effective_at: evaluation.evaluatedAt,
      evidence: root,
      reconciliation_hash: reconciliationHash,
    }));
    for (const key of outcomeKeys) {
      lineage.push(Object.freeze({
        reconciliation_id: reconciliationId,
        check_outcome_id: outcomes.idByKey.get(key),
        lineage_role: key === primaryKey ? 'primary' : 'supporting',
      }));
    }
  }
  const unrooted = evaluation.outcomes
    .map((outcome) => outcome.outcomeKey)
    .filter((key) => !coveredOutcomeKeys.has(key));
  if (unrooted.length > 0) {
    throw new TypeError(`evaluation has outcomes without root reconciliation: ${unrooted.join(',')}`);
  }
  return Object.freeze({
    roots: Object.freeze(roots),
    reconciliations: Object.freeze(reconciliations),
    lineage: Object.freeze(lineage),
  });
}

export function buildManagementPatternPersistenceBundle(
  prepared: PreparedManagementPatternInputs,
  evaluation: ManagementPatternEvaluation,
): ManagementPatternPersistenceBundle {
  if (prepared.snapshot.organization.id !== evaluation.organizationId) {
    throw new TypeError('prepared inputs and evaluation belong to different organizations');
  }
  if (prepared.fingerprint !== evaluation.inputFingerprint) {
    throw new TypeError('evaluation does not identify the supplied prepared inputs');
  }
  const input = buildManagementPatternInputBatch(prepared);
  const contexts = observationContexts(prepared);
  const replayedCohorts = replayedCohortDecisions(prepared, evaluation.outcomes);
  const cohort = cohortRows(prepared, replayedCohorts);
  const cohortIds = new Map(replayedCohorts.map((decision) => (
    [decision.fingerprint, cohortId(decision)] as const
  )));
  const outcomes = outcomePersistence(evaluation, cohortIds);
  const candidates = candidatePersistence(
    prepared,
    evaluation,
    outcomes.idByKey,
    contexts,
  );
  const observationLinks = checkObservationRows(
    evaluation,
    outcomes.idByKey,
    contexts,
    replayedCohorts,
  );
  const reconciliation = reconciliationPersistence(
    evaluation,
    outcomes,
    candidates.idByFingerprint,
  );
  const results: ManagementPatternResultBatch = Object.freeze({
    cohorts: cohort.cohorts,
    cohort_members: cohort.members,
    check_outcomes: outcomes.rows,
    check_observations: observationLinks,
    candidates: candidates.rows,
    candidate_outcomes: candidates.lineage,
    candidate_properties: candidates.properties,
    candidate_local_instances: candidates.localInstances,
    run_roots: reconciliation.roots,
    reconciliations: reconciliation.reconciliations,
    reconciliation_outcomes: reconciliation.lineage,
  });
  const counts = Object.freeze({
    properties: input.runProperties.length,
    includedProperties: input.runProperties.filter((row) => (
      row.eligibility_status === 'included'
    )).length,
    excludedProperties: input.runProperties.filter((row) => (
      row.eligibility_status === 'excluded'
    )).length,
    cohorts: results.cohorts.length,
    cohortMembers: results.cohort_members.length,
    observations: input.metricObservations.length,
    sourceFacts: input.metricSourceFacts.length,
    observationLinks: results.check_observations.length,
    checks: new Set(results.check_outcomes.map((row) => String(row.check_id))).size,
    outcomes: results.check_outcomes.length,
    candidates: results.candidates.length,
    abstentions: results.check_outcomes.filter((row) => row.result === 'abstained').length,
    qualityFailures: results.check_outcomes.filter((row) => row.quality_gate === 'failed').length,
  });
  const payload = {
    organizationId: evaluation.organizationId,
    preparedFingerprint: prepared.fingerprint,
    evaluationFingerprint: evaluation.fingerprint,
    input,
    results,
    counts,
  };
  return Object.freeze({
    input,
    results,
    counts,
    fingerprint: stableFingerprint(payload, 'management-pattern-persistence-bundle'),
  });
}

export interface ManagementPatternRunReceipt {
  readonly engineVersion: typeof MANAGEMENT_PATTERN_ENGINE_VERSION;
  readonly evidenceSchemaVersion: typeof MANAGEMENT_PATTERN_EVIDENCE_SCHEMA_VERSION;
  readonly cohortPolicyVersion: string;
  readonly normalizationPolicyVersion: string;
  readonly dedupePolicyVersion: typeof MANAGEMENT_PATTERN_DEDUPE_POLICY_VERSION;
  readonly scopePolicyVersion: typeof MANAGEMENT_PATTERN_SCOPE_POLICY_VERSION;
  readonly modelVersions: Readonly<Record<string, never>>;
}

export const MANAGEMENT_PATTERN_RUN_RECEIPT: ManagementPatternRunReceipt = Object.freeze({
  engineVersion: MANAGEMENT_PATTERN_ENGINE_VERSION,
  evidenceSchemaVersion: MANAGEMENT_PATTERN_EVIDENCE_SCHEMA_VERSION,
  cohortPolicyVersion: SUPPLY_SPEND_COHORT_POLICY.policyVersion,
  normalizationPolicyVersion: MANAGEMENT_PATTERN_NORMALIZATION_VERSION,
  dedupePolicyVersion: MANAGEMENT_PATTERN_DEDUPE_POLICY_VERSION,
  scopePolicyVersion: MANAGEMENT_PATTERN_SCOPE_POLICY_VERSION,
  modelVersions: Object.freeze({}),
});

export function managementPatternTerminalStatus(
  evaluation: ManagementPatternEvaluation,
): 'succeeded' | 'abstained' {
  return evaluation.rootEvaluations.some((root) => root.conclusion !== 'abstained')
    ? 'succeeded'
    : 'abstained';
}

export function managementPatternActivityMetricKey(streamId: ActivityStreamId): string {
  return `activity_event_days:${streamId}`;
}

export function managementPatternSemanticFamilyForCheck(checkId: string): string {
  if (checkId === SUPPLY_SPEND_CHECK_ID) return 'supply_spend_control';
  if (checkId === ACTIVITY_STOPPED_CHECK_ID) return 'portfolio_activity_stopped';
  return 'management_pattern_input_gate';
}
