import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MANAGEMENT_PATTERN_EVALUATOR_VERSION,
  createConsolidationCandidate,
  evaluateManagementPatterns,
  finalizeEvaluatedManifestations,
  stableFingerprint,
  supplyProfileCoverageReceipt,
  type EvaluatedPatternManifestation,
  type ManagementPatternCheckOutcome,
  type ManagementPatternEvaluation,
  type ManagementPatternRootEvaluation,
} from '@/lib/company/management-patterns';
import {
  MANAGEMENT_PATTERN_MAX_CANDIDATES,
  MANAGEMENT_PATTERN_MAX_EVIDENCE_BYTES,
  MANAGEMENT_PATTERN_MAX_INPUT_BATCH_BYTES,
} from '@/lib/company/management-patterns/definitions';
import { prepareManagementPatternInputs } from '@/lib/company/management-patterns/prepare-inputs';
import { buildManagementPatternPersistenceBundle } from '@/lib/company/management-patterns/persistence-bundle';
import type {
  ManagementPatternSourceProperty,
  ManagementPatternSourceSnapshot,
} from '@/lib/company/management-patterns/source-snapshot';
import { managementPatternSourceSnapshotSchema } from '@/lib/company/management-patterns/source-snapshot';

const EVALUATED_AT = '2026-07-10T12:00:00.000Z';
const SUPPLY_START = '2026-04-01';
const SUPPLY_END = '2026-06-30';
const ACTIVITY_START = '2026-04-03';
const ACTIVITY_END = '2026-07-09';
const ACTIVE_DATES = ['2026-06-23', '2026-06-26', '2026-06-29', '2026-07-02', '2026-07-05', '2026-07-08'];
const STOPPED_DATES = ['2026-04-05', '2026-04-08', '2026-04-11', '2026-04-14', '2026-04-17', '2026-04-20'];
const SOURCE_ACCESS = Object.freeze({
  effective_source_cutoff: EVALUATED_AT,
  effective_source_cutoff_is_exclusive: false,
  effective_source_cutoff_reason: 'requested_source_as_of' as const,
  effective_source_cutoff_proof_kind: 'request' as const,
  effective_source_cutoff_proof_at: EVALUATED_AT,
});
const SOURCE_WATERMARK_ACCESS = Object.freeze({
  source_as_of: EVALUATED_AT,
  requested_source_as_of: EVALUATED_AT,
  ...SOURCE_ACCESS,
});

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function dates(startDate: string, endDate: string): readonly string[] {
  const result: string[] = [];
  for (
    let instant = Date.parse(`${startDate}T00:00:00.000Z`);
    instant <= Date.parse(`${endDate}T00:00:00.000Z`);
    instant += 86_400_000
  ) result.push(new Date(instant).toISOString().slice(0, 10));
  return result;
}

function utcBusinessDateCoverageThrough(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + 86_400_000 - 1).toISOString();
}

const SUPPLY_DATES = dates(SUPPLY_START, SUPPLY_END);

interface PropertyOptions {
  readonly region?: 'north' | 'south';
  readonly supplyRaw?: number;
  readonly missingNumerator?: boolean;
  readonly missingDenominator?: boolean;
  readonly stoppedInventory?: boolean;
  readonly stoppedDailyLogs?: boolean;
  readonly stoppedWorkOrders?: boolean;
  readonly currency?: 'USD' | 'EUR' | 'INR';
  readonly incompleteProfile?: boolean;
  readonly missingProfile?: boolean;
  readonly missingServiceLevel?: boolean;
  readonly missingSizeBand?: boolean;
  readonly missingCurrency?: boolean;
}

function sourceProperty(index: number, options: PropertyOptions = {}): ManagementPatternSourceProperty {
  const propertyId = uuid(index);
  const region = options.region ?? 'north';
  const regionId = uuid(region === 'north' ? 9001 : 9002);
  const supplyRaw = options.missingNumerator ? null : options.supplyRaw ?? 10_000;
  const currency = options.currency ?? 'USD';
  const roomNights = options.missingDenominator ? null : 100;
  const roomsObserved = options.missingDenominator ? 0 : SUPPLY_DATES.length;
  const active = ACTIVE_DATES;
  const inventoryDates = options.stoppedInventory ? STOPPED_DATES : active;
  // The evaluator's activity logic is exercised against a hypothetical future
  // immutable-ledger source. Production v2 parsing intentionally rejects these
  // complete/eligible activity fixtures until the source query version bumps.
  return {
    property_id: propertyId,
    property_name: `Hotel ${index}`,
    relationship: {
      id: uuid(10_000 + index),
      relationship_type: 'operator',
      starts_at: '2025-01-01T00:00:00.000Z',
      ends_at: null,
      history_proof_kind: 'unchanged_current_row',
      history_proof_at: EVALUATED_AT,
      organization_active_count: 1,
      exclusive_governing_relationship: true,
      source_access: SOURCE_ACCESS,
    },
    property_source: {
      updated_at: '2026-07-09T00:00:00.000Z',
      total_rooms: 100,
      timezone: 'UTC',
      business_date_cutoff_hour: 0,
      property_kind: 'hotel',
      brand: 'Example',
      region,
    },
    profile: {
      id: uuid(20_000 + index),
      profile_version: 1,
      effective_from: '2025-01-01T00:00:00.000Z',
      effective_to: null,
      source_kind: options.missingProfile ? null : 'property_authoritative',
      source_reference: `fixture:${index}`,
      created_at: '2025-01-01T00:00:00.000Z',
      room_count: options.incompleteProfile || options.missingSizeBand ? null : 100,
      timezone: 'UTC',
      business_date_cutoff_hour: 0,
      service_level: options.incompleteProfile || options.missingServiceLevel
        ? null
        : 'full_service',
      market_type: 'urban',
      brand_class: 'upper_upscale',
      location_type: 'urban',
      operating_model: 'managed',
      amenity_tags: [],
      currency_code: options.incompleteProfile || options.missingCurrency ? null : currency,
      currency_minor_unit_exponent: options.incompleteProfile || options.missingCurrency ? null : 2,
      comparison_attributes: {},
    },
    groups: [{
      group_id: regionId,
      name: region,
      kind: 'region',
      portfolio_type: 'region',
      parent_id: null,
      group_created_at: '2026-01-01T00:00:00.000Z',
      group_updated_at: '2026-01-01T00:00:00.000Z',
      group_history_proof_kind: 'unchanged_current_row',
      group_history_proof_at: '2026-01-01T00:00:00.000Z',
      assignment_id: uuid(1000 + index),
      assigned_at: '2026-01-01T00:00:00.000Z',
      removed_at: null,
      assignment_created_at: '2026-01-01T00:00:00.000Z',
      assignment_updated_at: '2026-01-01T00:00:00.000Z',
      assignment_history_proof_kind: 'unchanged_current_row',
      assignment_history_proof_at: '2026-01-01T00:00:00.000Z',
    }],
    group_scope_historically_reconstructable: true,
    group_scope_exclusion_codes: [],
    windows: {
      supply_inventory: {
        start_date: SUPPLY_START,
        end_date: SUPPLY_END,
        timezone: 'UTC',
        business_date_cutoff_hour: 0,
        start_utc: '2026-04-01T00:00:00.000Z',
        end_utc: '2026-07-01T00:00:00.000Z',
        date_basis: 'property_local_calendar_month',
      },
      supply_occupancy: {
        start_date: SUPPLY_START,
        end_date: SUPPLY_END,
        timezone: 'UTC',
        business_date_cutoff_hour: 0,
        start_utc: '2026-04-01T00:00:00.000Z',
        end_utc: '2026-07-01T00:00:00.000Z',
        date_basis: 'property_business_date',
      },
      activity: {
        start_date: ACTIVITY_START,
        end_date: ACTIVITY_END,
        timezone: 'UTC',
        business_date_cutoff_hour: 0,
        start_utc: '2026-04-03T00:00:00.000Z',
        end_utc: '2026-07-10T00:00:00.000Z',
      },
    },
    run_exclusion_codes: [],
    supply: {
      query_id: 'management_pattern_inventory_month_closes',
      query_version: 'management-pattern-source-snapshot.v2',
      query_executed: true,
      exclusion_codes: options.missingNumerator ? ['numerator_missing'] : [],
      relationship_covers_inventory_window: true,
      profile_covers_inventory_and_occupancy_windows: true,
      expected_periods: 3,
      observed_periods: 3,
      usable_periods: options.missingNumerator ? 0 : 3,
      incompatible_periods: 0,
      oversized_quality_periods: 0,
      confirmed_purchase_storage_cents: supplyRaw,
      fresh_through: '2026-06-30T23:59:59.999Z',
      source_watermark: {
        max_closed_at: '2026-07-01T00:00:00.000Z',
        ...SOURCE_WATERMARK_ACCESS,
      },
      periods: ['2026-04-01', '2026-05-01', '2026-06-01'].map((monthStart, periodIndex) => ({
        id: uuid(30_000 + index * 10 + periodIndex),
        month_start: monthStart,
        timezone: 'UTC',
        status: 'closed' as const,
        month_start_at: `${monthStart}T00:00:00.000Z`,
        end_at: periodIndex === 0
          ? '2026-05-01T00:00:00.000Z'
          : periodIndex === 1 ? '2026-06-01T00:00:00.000Z' : '2026-07-01T00:00:00.000Z',
        is_partial: false,
        purchase_source: 'manual_total' as const,
        allocation_mode: 'total_only' as const,
        confirmed_purchase_storage_cents: supplyRaw === null
          ? null
          : Math.floor(supplyRaw / 3) + (periodIndex < supplyRaw % 3 ? 1 : 0),
        logged_purchase_storage_cents: null,
        manual_purchase_storage_cents: supplyRaw === null
          ? null
          : Math.floor(supplyRaw / 3) + (periodIndex < supplyRaw % 3 ? 1 : 0),
        logged_delivery_count: 0,
        uncosted_delivery_count: 0,
        quality_flags: [],
        quality_flags_oversize: false,
        source_window_compatible: true,
        closed_at: '2026-07-01T00:00:00.000Z',
        created_at: '2026-04-01T00:00:00.000Z',
        updated_at: '2026-07-01T00:00:00.000Z',
      })),
    },
    rooms_sold: {
      query_id: 'management_pattern_daily_log_occupancy',
      query_version: 'management-pattern-source-snapshot.v2',
      query_executed: true,
      exclusion_codes: options.missingDenominator ? ['denominator_missing'] : [],
      relationship_covers_occupancy_window: true,
      expected_days: SUPPLY_DATES.length,
      sealed_days: roomsObserved,
      observed_days: roomsObserved,
      partial_days: 0,
      room_nights_sold: roomNights,
      fresh_through: options.missingDenominator ? null : '2026-06-30T23:59:59.999Z',
      source_watermark: {
        max_sealed_at: options.missingDenominator ? null : '2026-07-01T00:00:00.000Z',
        max_updated_at: options.missingDenominator ? null : '2026-07-01T00:00:00.000Z',
        ...SOURCE_WATERMARK_ACCESS,
      },
      window_matches_inventory_numerator: true,
      normalization_alignment_basis: 'same_local_dates',
      normalization_eligible: !options.missingDenominator && !options.missingNumerator,
      days: options.missingDenominator ? [] : SUPPLY_DATES.map((date, dayIndex) => ({
        date,
        coverage_through: utcBusinessDateCoverageThrough(date),
        rooms_sold: dayIndex === 0 ? 100 : 0,
        occupancy_source: 'operator' as const,
        sealed_at: '2026-07-01T00:00:00.000Z',
        seal_version: 1,
        source_completeness: { occupancy_complete: true },
        denominator_complete: true,
        source_completeness_oversize: false,
        created_at: '2026-07-01T00:00:00.000Z',
        updated_at: '2026-07-01T00:00:00.000Z',
      })),
    },
    activity: {
      relationship_covers_window: true,
      exclusion_codes: [],
      inventory_counts: {
        query_id: 'management_pattern_inventory_activity',
        query_version: 'management-pattern-source-snapshot.v2',
        query_executed: true,
        query_coverage_status: 'complete',
        coverage_reason_codes: [],
        absence_detection_eligible: true,
        event_dates: inventoryDates,
        source_event_count: inventoryDates.length,
        source_watermark: {
          max_created_at: EVALUATED_AT,
          row_count: inventoryDates.length,
          ...SOURCE_WATERMARK_ACCESS,
        },
      },
      daily_log_closings: {
        query_id: 'management_pattern_daily_log_activity',
        query_version: 'management-pattern-source-snapshot.v2',
        query_executed: true,
        query_coverage_status: 'complete',
        coverage_reason_codes: ['historical_mutability_unavailable'],
        absence_detection_eligible: false,
        event_dates: options.stoppedDailyLogs ? STOPPED_DATES : active,
        source_event_count: options.stoppedDailyLogs ? STOPPED_DATES.length : active.length,
        recording_flow_support: 'historical_mutability_unavailable',
        source_watermark: {
          max_sealed_at: EVALUATED_AT,
          sealed_day_count: options.stoppedDailyLogs ? STOPPED_DATES.length : active.length,
          ...SOURCE_WATERMARK_ACCESS,
        },
      },
      work_order_flow: {
        query_id: 'management_pattern_work_order_activity',
        query_version: 'management-pattern-source-snapshot.v2',
        query_executed: true,
        query_coverage_status: 'complete',
        coverage_reason_codes: [],
        absence_detection_eligible: true,
        event_dates: options.stoppedWorkOrders ? STOPPED_DATES : active,
        source_event_count: options.stoppedWorkOrders ? STOPPED_DATES.length : active.length,
        recording_flow_support: 'live_current_state',
        source_watermark: {
          max_created_at: EVALUATED_AT,
          row_count: options.stoppedWorkOrders ? STOPPED_DATES.length : active.length,
          ...SOURCE_WATERMARK_ACCESS,
        },
      },
    },
  } as unknown as ManagementPatternSourceProperty;
}

function snapshot(options: readonly PropertyOptions[]): ManagementPatternSourceSnapshot {
  const properties = options.map((entry, index) => sourceProperty(index + 1, entry));
  return {
    schema_version: 'management-pattern-source-snapshot.v2',
    query_id: 'management_pattern_source_snapshot',
    query_version: 'management-pattern-source-snapshot.v2',
    organization: {
      id: uuid(99_999),
      organization_type: 'management_company',
      status: 'active',
    },
    evaluation_at: EVALUATED_AT,
    analysis_window_anchor: EVALUATED_AT,
    source_as_of: EVALUATED_AT,
    topology_as_of: EVALUATED_AT,
    supply_window: { start_date: SUPPLY_START, end_date: SUPPLY_END },
    activity_window: { start_date: ACTIVITY_START, end_date: ACTIVITY_END, history_days: 98 },
    property_count: properties.length,
    max_properties: 50,
    source_budget_exceeded: false,
    properties,
  };
}

function evaluate(options: readonly PropertyOptions[]) {
  const prepared = prepareManagementPatternInputs(snapshot(options));
  return { prepared, result: evaluateManagementPatterns(prepared) };
}

function supplyManifestations(result: ReturnType<typeof evaluateManagementPatterns>) {
  return result.manifestations.filter((item) => item.checkId === 'portfolio_supply_spend_gap');
}

function activityManifestations(result: ReturnType<typeof evaluateManagementPatterns>) {
  return result.manifestations.filter((item) => item.checkId === 'portfolio_activity_stopped');
}

describe('management pattern evaluator supply checks', () => {
  test('records a persistable sparse-cohort abstention instead of losing the decision', () => {
    const { result } = evaluate([
      { supplyRaw: 50_000 }, {}, {}, {}, {},
    ]);
    const target = result.outcomes.find((item) => item.outcomeKey === `supply:${uuid(1)}`);
    assert.equal(target?.result, 'abstained');
    assert.equal(target?.cohort, null);
    const evidence = target?.evidence as {
      cohortReference?: {
        status: string;
        reason: string;
        memberCount: number;
        usablePeerCount: number;
        fingerprint: string;
      };
    } | undefined;
    assert.equal(evidence?.cohortReference?.status, 'abstained');
    assert.equal(evidence?.cohortReference?.reason, 'insufficient_peers');
    assert.equal(evidence?.cohortReference?.memberCount, 4);
    assert.equal(evidence?.cohortReference?.usablePeerCount, 4);
    assert.match(evidence?.cohortReference?.fingerprint ?? '', /^[0-9a-f]{64}$/);
    assert.equal(supplyManifestations(result).length, 0);
  });

  test('forms a leave-one-out fallback cohort and emits only the actual outlier target', () => {
    const { result } = evaluate([
      { region: 'north' },
      { region: 'north' },
      { region: 'north' },
      { region: 'north', supplyRaw: 50_000 },
      { region: 'north' },
      { region: 'south' },
    ]);
    const manifests = supplyManifestations(result);
    assert.equal(manifests.length, 1);
    assert.deepEqual(manifests[0].consolidationCandidate.affectedPropertyIds, [uuid(4)]);
    const outlierOutcome = result.outcomes.find((item) => item.outcomeKey === `supply:${uuid(4)}`);
    assert.equal(outlierOutcome?.result, 'candidate');
    assert.equal(outlierOutcome?.cohort, null);
    const outcomeEvidence = outlierOutcome?.evidence as {
      cohortReference?: {
        status: string;
        level: number;
        relaxedDimensions: string[];
        fingerprint: string;
      };
    } | undefined;
    assert.equal(outcomeEvidence?.cohortReference?.status, 'fallback');
    assert.equal(outcomeEvidence?.cohortReference?.level, 3);
    assert.deepEqual(
      outcomeEvidence?.cohortReference?.relaxedDimensions,
      ['amenityTags', 'brandClass', 'regionId'],
    );
    assert.ok(!manifests[0].peerCohorts[0].peerPropertyIds.includes(uuid(4)));
    assert.equal(result.candidates[0]?.classification?.scope, 'peer_cohort');
  });

  test('abstains on a missing denominator and does not use that hotel as a peer', () => {
    const { result } = evaluate([
      { supplyRaw: 50_000, missingDenominator: true }, {}, {}, {}, {}, {},
    ]);
    const target = result.outcomes.find((item) => item.outcomeKey === `supply:${uuid(1)}`);
    assert.equal(target?.result, 'abstained');
    assert.ok(target?.reasonCodes.includes('denominator_missing'));
    assert.equal(supplyManifestations(result).length, 0);
  });

  test('uses a shared local-date occurrence window and a currency-specific root domain', () => {
    const { prepared, result } = evaluate([
      { supplyRaw: 50_000 }, {}, {}, {}, {}, {},
    ]);
    const manifest = supplyManifestations(result)[0];
    assert.ok(manifest);
    assert.match(manifest.consolidationCandidate.rootSubjectKey, /inventory_purchase_spend:USD:scale_2/);
    assert.notEqual(
      manifest.consolidationCandidate.analysisWindowKey,
      prepared.properties[0].supply.observation?.window.fingerprint,
    );
  });

  test('emits under the explicit USD policy but abstains for same-scale INR materiality', () => {
    const { result } = evaluate([
      { currency: 'USD', supplyRaw: 50_000 },
      ...Array.from({ length: 5 }, () => ({ currency: 'USD' as const })),
      { currency: 'INR', supplyRaw: 50_000 },
      ...Array.from({ length: 5 }, () => ({ currency: 'INR' as const })),
    ]);
    const manifests = supplyManifestations(result);
    assert.equal(manifests.length, 1);
    assert.match(manifests[0].consolidationCandidate.rootSubjectKey, /:USD:scale_2:/);

    const unsupported = result.outcomes.find((item) => (
      item.outcomeKey === `supply:${uuid(7)}`
    ));
    assert.equal(unsupported?.result, 'abstained');
    assert.deepEqual(unsupported?.reasonCodes, ['materiality_threshold_currency_unsupported']);
    const evidence = unsupported?.evidence as Record<string, unknown> | undefined;
    assert.equal(evidence?.currencyCode, 'INR');
    assert.equal(evidence?.currencyStorageScale, 2);
    assert.equal(evidence?.materialityPolicyVersion, 'supply-spend-native-materiality.v1');
    assert.deepEqual(evidence?.supportedCurrencyDomains, ['USD:scale_2']);
    assert.match(String(evidence?.materialityPolicyFingerprint), /^[0-9a-f]{64}$/);

    const inrRoot = result.rootEvaluations.find((root) => root.rootSubjectKey.includes(':INR:'));
    assert.equal(inrRoot?.conclusion, 'abstained');
    assert.ok(inrRoot?.reasonCodes.includes('materiality_threshold_currency_unsupported'));
  });

  test('does not let six complete profiles masquerade as full coverage in a 50-hotel portfolio', () => {
    const { prepared, result } = evaluate(Array.from({ length: 50 }, (_, index) => ({
      supplyRaw: index === 0 ? 50_000 : 10_000,
      incompleteProfile: index >= 6,
    })));
    assert.equal(supplyManifestations(result).length, 0);
    const target = result.outcomes.find((item) => item.outcomeKey === `supply:${uuid(1)}`);
    assert.equal(target?.result, 'abstained');
    assert.deepEqual(target?.reasonCodes, ['insufficient_profile_dimension_coverage']);
    const evidence = target?.evidence as {
      profileCoverage?: {
        status: string;
        populationPropertyCount: number;
        completeProfileCount: number;
        excludedProfileCount: number;
        completeRatio: number;
        minimumCompleteRatio: number;
        exclusionCount: number;
        exclusionsFingerprint: string;
        fingerprint: string;
      };
      cohortReference?: { fingerprint: string };
    } | undefined;
    const receipt = evidence?.profileCoverage;
    assert.equal(receipt?.status, 'abstained');
    assert.equal(receipt?.populationPropertyCount, 49);
    assert.equal(receipt?.completeProfileCount, 5);
    assert.equal(receipt?.excludedProfileCount, 44);
    assert.equal(receipt?.completeRatio, 5 / 49);
    assert.equal(receipt?.minimumCompleteRatio, 0.8);
    assert.equal(receipt?.exclusionCount, 44);
    assert.match(receipt?.exclusionsFingerprint ?? '', /^[0-9a-f]{64}$/);
    assert.match(evidence?.cohortReference?.fingerprint ?? '', /^[0-9a-f]{64}$/);
    const exactReceipt = supplyProfileCoverageReceipt(prepared, uuid(1));
    assert.equal(exactReceipt.exclusions[0]?.propertyId, uuid(7));
    assert.ok(exactReceipt.exclusions[0]?.reasonCodes.includes(
      'required_profile_dimension_missing:operatingCurrency',
    ));
    assert.match(receipt?.fingerprint ?? '', /^[0-9a-f]{64}$/);
    const usdRoot = result.rootEvaluations.find((root) => root.rootSubjectKey.includes(':USD:'));
    assert.equal(usdRoot?.conclusion, 'abstained');
    assert.ok(usdRoot?.reasonCodes.includes('insufficient_profile_dimension_coverage'));
    assert.ok(usdRoot?.supportingOutcomeKeys.includes(`supply:${uuid(1)}`));
    assert.equal(usdRoot?.unavailablePropertyIds.length, 50);
    assert.equal(
      result.rootEvaluations.some((root) => root.rootSubjectKey === 'unassignable_domain'),
      true,
    );
    assert.equal(
      result.policyManifest.profileCoveragePolicyVersion,
      'supply-spend-target-rung-profile-coverage.v2',
    );
    assert.match(result.policyManifest.profileCoveragePolicyFingerprint, /^[0-9a-f]{64}$/);
    assert.match(result.policyManifest.fingerprint, /^[0-9a-f]{64}$/);
    assert.ok(
      Buffer.byteLength(JSON.stringify(result), 'utf8') <= MANAGEMENT_PATTERN_MAX_EVIDENCE_BYTES,
      'profile-coverage abstentions must remain within the evaluation evidence budget',
    );
  });

  test('keeps a max-target profile-coverage abstention set within the evidence budget', () => {
    const { prepared, result } = evaluate(Array.from({ length: 50 }, (_, index) => ({
      // 40 complete profiles is the leave-one-out boundary: each complete
      // target sees 39/49 complete peers, just below the 0.8 gate. At 41,
      // every complete target passes, so this maximizes compact abstentions.
      incompleteProfile: index >= 40,
    })));
    assert.equal(supplyManifestations(result).length, 0);
    assert.equal(
      result.outcomes.filter((item) => (
        item.result === 'abstained'
        && item.reasonCodes.includes('insufficient_profile_dimension_coverage')
      )).length,
      40,
    );
    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    assert.ok(
      bytes <= MANAGEMENT_PATTERN_MAX_EVIDENCE_BYTES,
      `serialized profile-coverage abstentions use ${bytes} bytes; budget is ${MANAGEMENT_PATTERN_MAX_EVIDENCE_BYTES}`,
    );
    const bundle = buildManagementPatternPersistenceBundle(prepared, result);
    assert.equal(bundle.results.cohorts.length, 40);
    assert.ok(
      Buffer.byteLength(JSON.stringify(bundle.results), 'utf8') <= 16 * 1024 * 1024,
      'full replayable cohort receipts must remain within the atomic result-batch budget',
    );
    const drifted = structuredClone(result) as unknown as {
      outcomes: Array<{
        reasonCodes: string[];
        evidence: { profileCoverage?: { completeProfileCount?: number } };
      }>;
    };
    const coverageOutcome = drifted.outcomes.find((item) => (
      item.reasonCodes.includes('insufficient_profile_dimension_coverage')
    ));
    assert.ok(coverageOutcome?.evidence.profileCoverage);
    coverageOutcome.evidence.profileCoverage.completeProfileCount = 0;
    assert.throws(
      () => buildManagementPatternPersistenceBundle(
        prepared,
        drifted as unknown as ManagementPatternEvaluation,
      ),
      /profile coverage replay receipt mismatch/,
    );
  });

  test('abstains when 9 unknown profiles may join 5 known peers despite 35 definitive mismatches', () => {
    const { prepared, result } = evaluate([
      { supplyRaw: 50_000 },
      ...Array.from({ length: 5 }, () => ({})),
      ...Array.from({ length: 35 }, () => ({ currency: 'EUR' as const })),
      ...Array.from({ length: 8 }, () => ({ incompleteProfile: true })),
      { missingProfile: true },
    ]);
    assert.equal(supplyManifestations(result).length, 0);
    const target = result.outcomes.find((item) => item.outcomeKey === `supply:${uuid(1)}`);
    assert.equal(target?.result, 'abstained');
    assert.deepEqual(target?.reasonCodes, ['insufficient_profile_dimension_coverage']);
    const receipt = supplyProfileCoverageReceipt(prepared, uuid(1));
    assert.equal(receipt.status, 'abstained');
    assert.equal(receipt.decisionReason, 'insufficient_target_rung_profile_coverage');
    assert.equal(
      receipt.populationBasis,
      'target_rung_potentially_compatible_leave_one_out_peers',
    );
    assert.equal(receipt.populationPropertyCount, 14);
    assert.equal(receipt.completeProfileCount, 5);
    assert.equal(receipt.excludedProfileCount, 9);
    assert.equal(receipt.completeRatio, 5 / 14);
    assert.equal(receipt.effectiveCoverageRatio, 5 / 14);
    assert.equal(receipt.potentiallyCompatiblePropertyIds.length, 14);
    assert.deepEqual(receipt.knownCompatiblePropertyIds, [
      uuid(2), uuid(3), uuid(4), uuid(5), uuid(6),
    ]);
    assert.equal(receipt.dimensionIncompletePotentialPropertyIds.length, 9);
    assert.equal(receipt.definitivelyMismatchedPropertyIds.length, 35);
    assert.ok(receipt.definitivelyMismatchedPropertyIds.includes(uuid(7)));
    assert.ok(receipt.definitivelyMismatchedPropertyIds.includes(uuid(41)));
    assert.ok(receipt.dimensionIncompletePotentialPropertyIds.includes(uuid(50)));
    assert.deepEqual(
      receipt.exclusions.find((item) => item.propertyId === uuid(50))?.reasonCodes,
      ['profile_snapshot_unavailable'],
    );
    assert.match(receipt.cohortCoverageFingerprint, /^[0-9a-f]{64}$/);
    assert.ok(receipt.attempts.every((attempt) => (
      attempt.potentiallyCompatiblePeerCount === 14
      && attempt.knownCompatiblePeerCount === 5
      && attempt.definitivelyMismatchedPeerCount === 35
      && attempt.effectiveCoverageRatio === 5 / 14
      && /^[0-9a-f]{64}$/.test(attempt.fingerprint)
    )));
    assert.equal(result.policyManifest.supplyCheckVersion, 'completed-month-peer-baseline.v3');
    assert.equal(result.policyManifest.cohortPolicyVersion, 'supply-spend-cohort.v3');
  });

  test('does not count an incomplete profile when another active dimension definitively mismatches', () => {
    const { prepared, result } = evaluate([
      { supplyRaw: 50_000 },
      ...Array.from({ length: 5 }, () => ({})),
      ...Array.from({ length: 10 }, () => ({
        currency: 'EUR' as const,
        missingServiceLevel: true,
      })),
    ]);
    const receipt = supplyProfileCoverageReceipt(prepared, uuid(1));
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.selectedLevelId, 'exact');
    assert.equal(receipt.populationPropertyCount, 5);
    assert.equal(receipt.completeProfileCount, 5);
    assert.equal(receipt.completeRatio, 1);
    assert.equal(receipt.dimensionIncompletePotentialPropertyIds.length, 0);
    assert.equal(receipt.definitivelyMismatchedPropertyIds.length, 10);
    assert.equal(supplyManifestations(result).length, 1);
    assert.equal(
      result.outcomes.find((item) => item.outcomeKey === `supply:${uuid(1)}`)?.result,
      'candidate',
    );
  });

  test('reintroduces possible peers only when fallback relaxes their definitive mismatch', () => {
    const { prepared, result } = evaluate([
      { supplyRaw: 50_000 },
      ...Array.from({ length: 4 }, () => ({})),
      { region: 'south' },
      ...Array.from({ length: 4 }, () => ({
        region: 'south' as const,
        missingServiceLevel: true,
      })),
    ]);
    const receipt = supplyProfileCoverageReceipt(prepared, uuid(1));
    assert.equal(receipt.status, 'abstained');
    const exact = receipt.attempts.find((attempt) => attempt.levelId === 'exact');
    const regionFallback = receipt.attempts.find((attempt) => (
      attempt.levelId === 'fallback:amenityTags+brandClass+regionId'
    ));
    assert.equal(exact?.potentiallyCompatiblePeerCount, 4);
    assert.equal(exact?.definitivelyMismatchedPeerCount, 5);
    assert.equal(regionFallback?.potentiallyCompatiblePeerCount, 9);
    assert.equal(regionFallback?.knownCompatiblePeerCount, 5);
    assert.equal(regionFallback?.dimensionIncompletePotentialPeerCount, 4);
    assert.equal(regionFallback?.profileCompleteCoverageRatio, 5 / 9);
    assert.equal(regionFallback?.effectiveCoverageRatio, 5 / 9);
    assert.equal(supplyManifestations(result).length, 0);
    assert.deepEqual(
      result.outcomes.find((item) => item.outcomeKey === `supply:${uuid(1)}`)?.reasonCodes,
      ['insufficient_profile_dimension_coverage'],
    );
  });
});

describe('management pattern evaluator activity checks and scope', () => {
  test('classifies a 30% condition distributed across regions as company-wide', () => {
    const { prepared, result } = evaluate(Array.from({ length: 10 }, (_, index) => ({
      region: index < 5 ? 'north' : 'south',
      stoppedInventory: index === 0 || index === 1 || index === 5,
    })));
    const manifests = activityManifestations(result);
    assert.equal(manifests.length, 1);
    const final = result.candidates.find((item) => item.pattern.semanticRootFamily === 'portfolio_activity_stopped');
    assert.equal(final?.decision, 'emit');
    assert.equal(final?.classification?.scope, 'company_wide');
    assert.equal(final?.classification?.organizationEvidenceCoverageRatio, 1);
    assert.equal(final?.classification?.organizationAffectedShare, 0.3);
    assert.deepEqual(final?.classification?.companyDistribution?.groupIds, [uuid(9001), uuid(9002)]);
    assert.match(manifests[0].summary, /inventory count entries in Staxis/);
    const evidence = manifests[0].evidence as Record<string, unknown>;
    const affectedProperties = evidence.affectedProperties as Record<string, { stopped: boolean }>;
    assert.equal(affectedProperties[uuid(1)].stopped, true);
    assert.equal(uuid(10) in affectedProperties, false);
    assert.ok(manifests[0].evaluatedPropertyIds.includes(uuid(10)));
    assert.deepEqual(
      prepared.properties[0].activities.inventory_counts.observation?.metadata,
      {
        eventDates: STOPPED_DATES,
        sourceEventCount: STOPPED_DATES.length,
        sourceRevisionAt: EVALUATED_AT,
        streamId: 'inventory_counts',
      },
    );
    assert.deepEqual(
      (prepared.properties[9].activities.inventory_counts.observation?.metadata as { eventDates: string[] }).eventDates,
      ACTIVE_DATES,
    );
    assert.equal(manifests[0].evidenceBasis, 'cross_property_condition');
    assert.deepEqual(manifests[0].peerCohorts, []);
    const rootEvaluation = result.rootEvaluations.find((item) => item.rootSubjectKey === 'inventory_counts');
    assert.equal(rootEvaluation?.conclusion, 'present');
    assert.equal(rootEvaluation?.primaryOutcomeKey, 'activity:inventory_counts');
    assert.deepEqual(rootEvaluation?.affectedPropertyIds, [uuid(1), uuid(2), uuid(6)]);
    assert.deepEqual(rootEvaluation?.candidateFingerprints, [final?.fingerprint]);
    assert.equal(
      prepared.properties[0].activities.inventory_counts.observation?.quality.freshThrough,
      '2026-07-09T23:59:59.999Z',
    );
  });

  test('classifies a concentrated partial condition as group/region, not company-wide', () => {
    const { result } = evaluate(Array.from({ length: 10 }, (_, index) => ({
      region: index < 3 ? 'north' : 'south',
      stoppedInventory: index < 3,
    })));
    const final = result.candidates.find((item) => item.pattern.semanticRootFamily === 'portfolio_activity_stopped');
    assert.equal(final?.classification?.scope, 'group_region');
    assert.equal(final?.classification?.matchedGroup?.groupId, uuid(9001));
    assert.equal(final?.classification?.matchedGroup?.affectedShare, 1);
  });

  test('does not fire below affected count and share thresholds', () => {
    const { result } = evaluate(Array.from({ length: 10 }, (_, index) => ({
      region: index < 5 ? 'north' : 'south',
      stoppedInventory: index < 2,
    })));
    assert.equal(activityManifestations(result).length, 0);
    const outcome = result.outcomes.find((item) => item.outcomeKey === 'activity:inventory_counts');
    assert.equal(outcome?.result, 'normal');
    assert.ok(outcome?.reasonCodes.includes('affected_property_floor_not_met'));
    const rootEvaluation = result.rootEvaluations.find((item) => item.rootSubjectKey === 'inventory_counts');
    assert.equal(rootEvaluation?.conclusion, 'absent');
    assert.equal(rootEvaluation?.primaryOutcomeKey, 'activity:inventory_counts');
    assert.deepEqual(rootEvaluation?.affectedPropertyIds, [uuid(1), uuid(2)]);
    assert.deepEqual(rootEvaluation?.unavailablePropertyIds, []);
    assert.ok(rootEvaluation?.reasonCodes.includes('below_portfolio_pattern_threshold'));
  });

  test('suppresses contradictory manifestations on disjoint hotels after consolidation', () => {
    const { prepared, result } = evaluate(Array.from({ length: 10 }, (_, index) => ({
      region: index < 5 ? 'north' : 'south',
      stoppedInventory: index === 0 || index === 1 || index === 5,
    })));
    const supporting = activityManifestations(result)[0];
    assert.ok(supporting);
    const original = supporting.consolidationCandidate;
    const refutingCandidate = createConsolidationCandidate({
      candidateId: 'refuting-control',
      organizationId: original.organizationId,
      runFingerprint: original.runFingerprint,
      detectorId: 'activity_control_check',
      detectorVersion: 'v1',
      semanticRootFamily: original.semanticRootFamily,
      rootSubjectKey: original.rootSubjectKey,
      mergeContractVersion: original.mergeContractVersion,
      compatibilityKey: original.compatibilityKey,
      analysisWindowKey: original.analysisWindowKey,
      assertion: 'issue_absent',
      direction: 'not_applicable',
      affectedPropertyIds: [uuid(10)],
      localInstances: [{
        instanceId: 'control:hotel-10',
        propertyId: uuid(10),
        evidenceFingerprint: 'control-evidence',
      }],
      evidenceFingerprint: 'control-evidence',
      materialityScore: original.materialityScore,
    });
    const refutingPayload = {
      schemaVersion: MANAGEMENT_PATTERN_EVALUATOR_VERSION,
      checkId: 'activity_control_check',
      checkVersion: 'v1',
      outcomeKey: 'activity-control',
      consolidationCandidate: refutingCandidate,
      summary: 'Control check refuted the condition.',
      magnitude: 0,
      materialityScore: refutingCandidate.materialityScore,
      evidence: { control: true },
      evidenceBasis: supporting.evidenceBasis,
      evaluatedPropertyIds: supporting.evaluatedPropertyIds,
      comparatorPropertyIds: supporting.comparatorPropertyIds,
      peerCohorts: supporting.peerCohorts,
    } satisfies Omit<EvaluatedPatternManifestation, 'fingerprint'>;
    const refuting = Object.freeze({
      ...refutingPayload,
      fingerprint: stableFingerprint(refutingPayload, 'evaluated-pattern-manifestation'),
    });
    const finalized = finalizeEvaluatedManifestations(prepared, [supporting, refuting]);
    assert.equal(finalized.candidates.length, 1);
    assert.equal(finalized.candidates[0].decision, 'suppress');
    assert.ok(finalized.candidates[0].suppressionReasons.includes('conflicting_manifestations'));
    assert.equal(finalized.candidates[0].pattern.manifestations.length, 2);
    assert.ok(finalized.candidates[0].pattern.affectedPropertyIds.includes(uuid(10)));
    assert.ok(finalized.candidates[0].pattern.localInstances.some((item) => (
      item.propertyId === uuid(10)
    )));
  });

  test('ranks overflow by materiality and emits explicit budget suppression receipts', () => {
    const { prepared, result } = evaluate(Array.from({ length: 10 }, (_, index) => ({
      region: index < 5 ? 'north' : 'south',
      stoppedInventory: index === 0 || index === 1 || index === 5,
    })));
    const base = activityManifestations(result)[0];
    assert.ok(base);
    const synthetic = Array.from({ length: MANAGEMENT_PATTERN_MAX_CANDIDATES + 2 }, (_, index) => {
      const materialityScore = (index + 1) / (MANAGEMENT_PATTERN_MAX_CANDIDATES + 2);
      const candidate = createConsolidationCandidate({
        candidateId: `synthetic-${index + 1}`,
        organizationId: base.consolidationCandidate.organizationId,
        runFingerprint: base.consolidationCandidate.runFingerprint,
        detectorId: base.checkId,
        detectorVersion: base.checkVersion,
        semanticRootFamily: base.consolidationCandidate.semanticRootFamily,
        rootSubjectKey: `synthetic-stream-${index + 1}`,
        mergeContractVersion: base.consolidationCandidate.mergeContractVersion,
        compatibilityKey: `synthetic-stream-${index + 1}`,
        analysisWindowKey: base.consolidationCandidate.analysisWindowKey,
        assertion: 'issue_present',
        direction: 'stopped',
        affectedPropertyIds: base.consolidationCandidate.affectedPropertyIds,
        localInstances: base.consolidationCandidate.localInstances.map((item) => ({
          instanceId: `synthetic-${index + 1}:${item.propertyId}`,
          propertyId: item.propertyId,
          evidenceFingerprint: `evidence-${index + 1}`,
        })),
        evidenceFingerprint: `evidence-${index + 1}`,
        materialityScore,
      });
      const payload = {
        schemaVersion: MANAGEMENT_PATTERN_EVALUATOR_VERSION,
        checkId: base.checkId,
        checkVersion: base.checkVersion,
        outcomeKey: `synthetic-${index + 1}`,
        consolidationCandidate: candidate,
        summary: `Synthetic ${index + 1}`,
        magnitude: index + 1,
        materialityScore,
        evidence: { synthetic: index + 1 },
        evidenceBasis: base.evidenceBasis,
        evaluatedPropertyIds: base.evaluatedPropertyIds,
        comparatorPropertyIds: base.comparatorPropertyIds,
        peerCohorts: base.peerCohorts,
      } satisfies Omit<EvaluatedPatternManifestation, 'fingerprint'>;
      return Object.freeze({
        ...payload,
        fingerprint: stableFingerprint(payload, 'evaluated-pattern-manifestation'),
      });
    });
    const finalized = finalizeEvaluatedManifestations(prepared, synthetic);
    assert.equal(finalized.consolidation.patterns.length, MANAGEMENT_PATTERN_MAX_CANDIDATES + 2);
    assert.equal(finalized.candidates.length, MANAGEMENT_PATTERN_MAX_CANDIDATES + 2);
    const emitted = finalized.candidates.filter((item) => item.decision === 'emit');
    assert.equal(emitted.length, MANAGEMENT_PATTERN_MAX_CANDIDATES);
    assert.equal(finalized.budgetSuppressions.length, 2);
    assert.ok(emitted.at(-1)!.materialityScore > finalized.budgetSuppressions[0].materialityScore);
    assert.equal(
      finalized.candidates.filter((item) => item.suppressionReasons.includes('candidate_budget_exceeded')).length,
      2,
    );
    assert.ok(finalized.budgetSuppressions.every((item) => (
      finalized.candidates.some((candidate) => candidate.fingerprint === item.candidateFingerprint)
    )));
    assert.ok(finalized.budgetSuppressions.every((item) => item.reason === 'candidate_budget_exceeded'));
    assert.ok(finalized.budgetSuppressions.every((item) => item.priorDecision === 'emit'));

    const syntheticOutcomes = synthetic.map((manifestation) => {
      const payload = {
        schemaVersion: MANAGEMENT_PATTERN_EVALUATOR_VERSION,
        outcomeKey: manifestation.outcomeKey,
        checkId: manifestation.checkId,
        checkVersion: manifestation.checkVersion,
        semanticFamily: manifestation.consolidationCandidate.semanticRootFamily,
        rootKey: manifestation.consolidationCandidate.rootKey,
        rootSubjectKey: manifestation.consolidationCandidate.rootSubjectKey,
        targetPropertyId: null,
        result: 'candidate' as const,
        qualityGate: 'passed' as const,
        inputFingerprint: stableFingerprint({
          preparedFingerprint: prepared.fingerprint,
          outcomeKey: manifestation.outcomeKey,
        }, 'synthetic-budget-outcome-input'),
        reasonCodes: [],
        evidence: manifestation.evidence,
        observationFingerprints: [],
        cohort: null,
        comparison: null,
        candidateFingerprints: [manifestation.fingerprint],
        rowsExamined: prepared.properties.length,
      } satisfies Omit<ManagementPatternCheckOutcome, 'fingerprint'>;
      return Object.freeze({
        ...payload,
        fingerprint: stableFingerprint(payload, 'management-pattern-check-outcome'),
      });
    });
    const candidateByManifestation = new Map(finalized.candidates.flatMap((candidate) => (
      candidate.manifestationFingerprints.map((fingerprint) => [fingerprint, candidate] as const)
    )));
    const syntheticRoots = synthetic.map((manifestation) => {
      const persistedCandidate = candidateByManifestation.get(manifestation.fingerprint);
      assert.ok(persistedCandidate);
      const payload = {
        schemaVersion: MANAGEMENT_PATTERN_EVALUATOR_VERSION,
        semanticFamily: manifestation.consolidationCandidate.semanticRootFamily,
        rootKey: manifestation.consolidationCandidate.rootKey,
        rootSubjectKey: manifestation.consolidationCandidate.rootSubjectKey,
        checkIds: [manifestation.checkId],
        checkVersions: [manifestation.checkVersion],
        conclusion: 'present' as const,
        primaryOutcomeKey: manifestation.outcomeKey,
        supportingOutcomeKeys: [manifestation.outcomeKey],
        affectedPropertyIds: persistedCandidate.affectedPropertyIds,
        evaluatedPropertyIds: manifestation.evaluatedPropertyIds,
        unavailablePropertyIds: [],
        reasonCodes: persistedCandidate.suppressionReasons,
        candidateFingerprints: [persistedCandidate.fingerprint],
      } satisfies Omit<ManagementPatternRootEvaluation, 'fingerprint'>;
      return Object.freeze({
        ...payload,
        fingerprint: stableFingerprint(payload, 'management-pattern-root-evaluation'),
      });
    });
    const syntheticEvaluation = Object.freeze({
      ...result,
      outcomes: Object.freeze(syntheticOutcomes),
      manifestations: Object.freeze(synthetic),
      consolidation: finalized.consolidation,
      candidates: finalized.candidates,
      budgetSuppressions: finalized.budgetSuppressions,
      rootEvaluations: Object.freeze(syntheticRoots),
      reasonCodes: [],
      fingerprint: stableFingerprint({
        preparedFingerprint: prepared.fingerprint,
        finalizedFingerprint: finalized.fingerprint,
        outcomeFingerprints: syntheticOutcomes.map((outcome) => outcome.fingerprint),
        rootFingerprints: syntheticRoots.map((root) => root.fingerprint),
      }, 'synthetic-budget-evaluation'),
    }) satisfies ManagementPatternEvaluation;
    const bundle = buildManagementPatternPersistenceBundle(prepared, syntheticEvaluation);
    assert.equal(bundle.results.run_roots.length, MANAGEMENT_PATTERN_MAX_CANDIDATES + 2);
    assert.equal(bundle.results.reconciliations.length, MANAGEMENT_PATTERN_MAX_CANDIDATES + 2);
    assert.equal(bundle.results.candidates.length, MANAGEMENT_PATTERN_MAX_CANDIDATES + 2);
    const persistedBudgetSuppressions = bundle.results.candidates.filter((row) => (
      row.decision === 'suppress'
      && (row.suppression_reasons as string[]).includes('candidate_budget_exceeded')
    ));
    assert.equal(persistedBudgetSuppressions.length, 2);
    assert.ok(persistedBudgetSuppressions.every((row) => (
      (row.suppression_reasons as string[]).length === 1
    )));
    assert.ok(bundle.results.reconciliations.every((row) => (
      row.conclusion === 'present' && row.candidate_id !== null
    )));
  });

  test('keeps a max-portfolio compact evaluation within the serialized evidence budget', () => {
    const { prepared, result } = evaluate(Array.from({ length: 50 }, (_, index) => ({
      region: index < 25 ? 'north' : 'south',
      stoppedInventory: index < 15,
      stoppedDailyLogs: index < 15,
      stoppedWorkOrders: index < 15,
    })));
    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    assert.ok(
      bytes <= MANAGEMENT_PATTERN_MAX_EVIDENCE_BYTES,
      `serialized evaluation is ${bytes} bytes; budget is ${MANAGEMENT_PATTERN_MAX_EVIDENCE_BYTES}`,
    );
    assert.deepEqual(
      (prepared.properties[0].activities.inventory_counts.observation?.metadata as { eventDates: string[] }).eventDates,
      STOPPED_DATES,
    );
    assert.ok(!JSON.stringify(result).includes(STOPPED_DATES[0]));
    const bundle = buildManagementPatternPersistenceBundle(prepared, result);
    const inputBytes = Buffer.byteLength(JSON.stringify(bundle.input), 'utf8');
    assert.ok(
      inputBytes <= MANAGEMENT_PATTERN_MAX_INPUT_BATCH_BYTES,
      `serialized max-portfolio input is ${inputBytes} bytes; budget is ${MANAGEMENT_PATTERN_MAX_INPUT_BATCH_BYTES}`,
    );
  });

  test('keeps many simultaneous supply outliers within the serialized evidence budget', () => {
    const { result } = evaluate(Array.from({ length: 50 }, (_, index) => ({
      supplyRaw: index < 12 ? 50_000 : 10_000,
    })));
    assert.equal(supplyManifestations(result).length, 12);
    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    assert.ok(
      bytes <= MANAGEMENT_PATTERN_MAX_EVIDENCE_BYTES,
      `serialized multi-outlier evaluation is ${bytes} bytes; budget is ${MANAGEMENT_PATTERN_MAX_EVIDENCE_BYTES}`,
    );
  });
});

describe('management pattern persistence graph', () => {
  test('maps a real multi-outcome evaluation with exact root and receipt lineage', () => {
    const { prepared, result } = evaluate([
      { supplyRaw: 50_000 },
      { supplyRaw: 0 },
      { missingNumerator: true },
      {}, {}, {}, {}, {},
    ]);
    const assignmentCounts = new Map<string, number>();
    for (const root of result.rootEvaluations) {
      for (const outcomeKey of new Set(root.supportingOutcomeKeys)) {
        assignmentCounts.set(outcomeKey, (assignmentCounts.get(outcomeKey) ?? 0) + 1);
      }
    }
    assert.deepEqual(
      result.outcomes.map((outcome) => [outcome.outcomeKey, assignmentCounts.get(outcome.outcomeKey)]),
      result.outcomes.map((outcome) => [outcome.outcomeKey, 1]),
    );

    const bundle = buildManagementPatternPersistenceBundle(prepared, result);
    assert.equal(bundle.counts.properties, 8);
    assert.equal(bundle.counts.outcomes, result.outcomes.length);
    assert.equal(bundle.counts.candidates, 1);
    assert.equal(bundle.counts.sourceFacts, 8 * (3 + SUPPLY_DATES.length));
    assert.equal(bundle.input.metricSourceFacts.length, bundle.counts.sourceFacts);
    assert.equal(bundle.counts.cohorts, 7);
    assert.equal(bundle.counts.cohortMembers, 56);
    assert.equal(bundle.results.run_roots.length, result.rootEvaluations.length);
    assert.ok(bundle.results.run_roots.every((row) => row.manifest_source === 'detector_plan'));

    const supplyCohort = bundle.results.cohorts.find((row) => row.status !== 'abstained');
    const definition = supplyCohort?.definition as Record<string, unknown> | undefined;
    const coveragePolicy = definition?.coverage_policy as Record<string, unknown> | undefined;
    const quality = supplyCohort?.quality as Record<string, unknown> | undefined;
    assert.equal(coveragePolicy?.minimum_usable_coverage_ratio, 0.8);
    assert.equal(
      coveragePolicy?.population_basis,
      'target_rung_potentially_compatible_leave_one_out_peers',
    );
    assert.equal(quality?.usable_coverage_ratio, 6 / 7);

    const supplyCandidateOutcome = bundle.results.check_outcomes.find((row) => (
      row.outcome_key === `supply:${uuid(1)}`
    ));
    const parameters = supplyCandidateOutcome?.parameters as Record<string, unknown> | undefined;
    assert.equal(parameters?.materiality_policy_version, 'supply-spend-native-materiality.v1');
    assert.match(String(parameters?.materiality_policy_fingerprint), /^[0-9a-f]{64}$/);
    assert.match(String(parameters?.profile_coverage_policy_fingerprint), /^[0-9a-f]{64}$/);
    assert.notEqual(supplyCandidateOutcome?.cohort_id, null);

    const supplyRows = bundle.input.metricObservations.filter((row) => (
      row.metric_key === 'inventory_purchase_spend'
    ));
    const zero = supplyRows.find((row) => row.property_id === uuid(2));
    const missing = supplyRows.find((row) => row.property_id === uuid(3));
    assert.equal(zero?.raw_value, 0);
    assert.equal(zero?.normalized_value, 0);
    assert.equal(missing?.raw_value, null);
    assert.equal(missing?.normalized_value, null);
    assert.ok((missing?.quality_reasons as string[]).includes('numerator_missing'));

    const includedAggregate = (propertyId: string, role: string): number | null => {
      const observation = supplyRows.find((row) => row.property_id === propertyId);
      assert.ok(observation);
      const includedFacts = bundle.input.metricSourceFacts.filter((fact) => (
        fact.observation_id === observation.id
        && fact.fact_role === role
        && fact.included_in_aggregate === true
      ));
      return includedFacts.length === 0
        ? null
        : includedFacts.reduce((sum, fact) => sum + Number(fact.numeric_value), 0);
    };
    assert.equal(includedAggregate(uuid(1), 'numerator'), 50_000);
    assert.equal(includedAggregate(uuid(1), 'denominator'), 100);
    assert.equal(includedAggregate(uuid(2), 'numerator'), 0);
    assert.equal(includedAggregate(uuid(3), 'numerator'), null);
    const firstObservation = supplyRows.find((row) => row.property_id === uuid(1));
    const firstFacts = bundle.input.metricSourceFacts.filter((fact) => (
      fact.observation_id === firstObservation?.id
    ));
    assert.equal(firstFacts.filter((fact) => fact.fact_role === 'numerator').length, 3);
    assert.equal(firstFacts.filter((fact) => fact.fact_role === 'denominator').length, SUPPLY_DATES.length);
    assert.deepEqual(
      firstFacts.filter((fact) => fact.fact_role === 'numerator').map((fact) => fact.fact_key).sort(),
      [SUPPLY_START, '2026-05-01', '2026-06-01'],
    );
    const firstFactPayload = firstFacts[0]?.fact_payload as Record<string, unknown> | undefined;
    assert.equal(firstFactPayload?.source_query_id, firstFacts[0]?.source_query_id);
    assert.equal(firstFactPayload?.source_query_version, firstFacts[0]?.source_query_version);
    assert.equal(firstFactPayload?.included_in_aggregate, firstFacts[0]?.included_in_aggregate);
    assert.equal(firstFactPayload?.numeric_value, firstFacts[0]?.numeric_value);
    const persistedFactBeforeSourceMutation = JSON.stringify(firstFactPayload);
    const mutableSourcePeriod = prepared.properties[0].source.supply.periods[0] as unknown as {
      confirmed_purchase_storage_cents: number | null;
    };
    mutableSourcePeriod.confirmed_purchase_storage_cents = 999_999;
    assert.equal(JSON.stringify(firstFactPayload), persistedFactBeforeSourceMutation);
    assert.ok(Object.isFrozen(firstFactPayload));

    for (const root of bundle.results.run_roots) {
      const keys = root.expected_outcome_keys as string[];
      const expected = createHash('sha256').update(JSON.stringify(keys), 'utf8').digest('hex');
      assert.equal(root.expected_outcome_set_hash, expected);

      const linkedOutcomes = keys.map((key) => {
        const outcome = bundle.results.check_outcomes.find((row) => row.outcome_key === key);
        assert.ok(outcome, `root ${String(root.root_key)} references persisted outcome ${key}`);
        return outcome;
      });
      const expectedDetectorIds = [...new Set(linkedOutcomes.map((row) => String(row.check_id)))].sort();
      const expectedDetectorVersions = Object.fromEntries(expectedDetectorIds.map((checkId) => [
        checkId,
        [...new Set(linkedOutcomes
          .filter((row) => row.check_id === checkId)
          .map((row) => String(row.check_version)))].sort(),
      ]));
      assert.deepEqual(root.detector_ids, expectedDetectorIds);
      assert.deepEqual(root.detector_versions, expectedDetectorVersions);
      assert.ok(!('detector_id' in root));

      const reconciliation = bundle.results.reconciliations.find((row) => (
        row.root_key === root.root_key
      ));
      assert.ok(reconciliation);
      assert.deepEqual(reconciliation.detector_ids, root.detector_ids);
      assert.deepEqual(reconciliation.detector_versions, root.detector_versions);
      assert.ok(!('detector_id' in reconciliation));
    }
  });

  test('derives a multi-detector root receipt from every linked outcome and fails closed on drift', () => {
    const { prepared, result } = evaluate(Array.from({ length: 8 }, () => ({})));
    const activityRoot = result.rootEvaluations.find((root) => (
      root.semanticFamily === 'portfolio_activity_stopped'
      && root.rootSubjectKey === 'inventory_counts'
    ));
    assert.ok(activityRoot);
    const activityOutcome = result.outcomes.find((outcome) => (
      outcome.outcomeKey === activityRoot.primaryOutcomeKey
    ));
    assert.ok(activityOutcome);
    const controlPayload = {
      ...activityOutcome,
      outcomeKey: 'activity-control:inventory_counts',
      checkId: 'activity_control_check',
      checkVersion: 'activity-control.v2',
      inputFingerprint: stableFingerprint({
        preparedFingerprint: prepared.fingerprint,
        outcomeKey: 'activity-control:inventory_counts',
      }, 'activity-control-input'),
      evidence: { control: true },
      observationFingerprints: [],
      candidateFingerprints: [],
    } satisfies ManagementPatternCheckOutcome;
    const controlOutcome = Object.freeze({
      ...controlPayload,
      fingerprint: stableFingerprint(controlPayload, 'management-pattern-check-outcome'),
    });
    const rootPayload = {
      ...activityRoot,
      checkIds: [...new Set([...activityRoot.checkIds, controlOutcome.checkId])].sort(),
      checkVersions: [...new Set([...activityRoot.checkVersions, controlOutcome.checkVersion])].sort(),
      supportingOutcomeKeys: [
        ...new Set([...activityRoot.supportingOutcomeKeys, controlOutcome.outcomeKey]),
      ].sort(),
    } satisfies ManagementPatternRootEvaluation;
    const multiDetectorRoot = Object.freeze({
      ...rootPayload,
      fingerprint: stableFingerprint(rootPayload, 'management-pattern-root-evaluation'),
    });
    const evaluation = Object.freeze({
      ...result,
      outcomes: Object.freeze([...result.outcomes, controlOutcome]),
      rootEvaluations: Object.freeze(result.rootEvaluations.map((root) => (
        root.rootKey === activityRoot.rootKey ? multiDetectorRoot : root
      ))),
      fingerprint: stableFingerprint({
        evaluationFingerprint: result.fingerprint,
        controlOutcomeFingerprint: controlOutcome.fingerprint,
        rootFingerprint: multiDetectorRoot.fingerprint,
      }, 'multi-detector-evaluation'),
    }) satisfies ManagementPatternEvaluation;
    const bundle = buildManagementPatternPersistenceBundle(prepared, evaluation);
    const persistedRoot = bundle.results.run_roots.find((row) => (
      row.root_key === activityRoot.rootKey
    ));
    const persistedReconciliation = bundle.results.reconciliations.find((row) => (
      row.root_key === activityRoot.rootKey
    ));
    assert.deepEqual(persistedRoot?.detector_ids, [
      activityOutcome.checkId,
      controlOutcome.checkId,
    ].sort());
    assert.deepEqual(persistedRoot?.detector_versions, {
      [activityOutcome.checkId]: [activityOutcome.checkVersion],
      [controlOutcome.checkId]: [controlOutcome.checkVersion],
    });
    assert.deepEqual(persistedReconciliation?.detector_ids, persistedRoot?.detector_ids);
    assert.deepEqual(persistedReconciliation?.detector_versions, persistedRoot?.detector_versions);

    const driftedRoot = Object.freeze({
      ...multiDetectorRoot,
      checkIds: activityRoot.checkIds,
      checkVersions: activityRoot.checkVersions,
    });
    const driftedEvaluation = Object.freeze({
      ...evaluation,
      rootEvaluations: Object.freeze(evaluation.rootEvaluations.map((root) => (
        root.rootKey === activityRoot.rootKey ? driftedRoot : root
      ))),
    });
    assert.throws(
      () => buildManagementPatternPersistenceBundle(prepared, driftedEvaluation),
      /detector IDs do not match its linked outcomes/,
    );
  });
});

describe('management pattern evaluator input contracts', () => {
  test('rejects imprecise or internally inconsistent source receipts', () => {
    type PrecisionSnapshot = {
      properties: Array<{
        relationship: {
          source_access: { effective_source_cutoff: string };
        };
        supply: {
          confirmed_purchase_storage_cents: number | null;
          source_watermark: { effective_source_cutoff: string };
          periods: Array<{
            confirmed_purchase_storage_cents: number | null;
            updated_at: string;
          }>;
        };
        rooms_sold: {
          room_nights_sold: number | null;
          days: Array<{
            rooms_sold: number | null;
            denominator_complete: boolean;
          }>;
        };
        activity: {
          inventory_counts: {
            query_coverage_status: string;
            absence_detection_eligible: boolean;
          };
          daily_log_closings: {
            query_coverage_status: string;
            absence_detection_eligible: boolean;
          };
          work_order_flow: {
            query_coverage_status: string;
            absence_detection_eligible: boolean;
            recording_flow_support: string;
          };
        };
      }>;
    };
    const baseline = structuredClone(snapshot([{}])) as unknown as PrecisionSnapshot;
    for (const property of baseline.properties) {
      property.activity.inventory_counts.query_coverage_status = 'not_evaluated';
      property.activity.inventory_counts.absence_detection_eligible = false;
      property.activity.daily_log_closings.query_coverage_status = 'not_evaluated';
      property.activity.daily_log_closings.absence_detection_eligible = false;
      property.activity.work_order_flow.query_coverage_status = 'not_evaluated';
      property.activity.work_order_flow.absence_detection_eligible = false;
      property.activity.work_order_flow.recording_flow_support = 'historical_mutability_unavailable';
    }
    assert.equal(managementPatternSourceSnapshotSchema.safeParse(baseline).success, true);

    const cases: Array<(value: PrecisionSnapshot) => void> = [
      (value) => {
        value.properties[0]!.supply.confirmed_purchase_storage_cents = Number.MAX_SAFE_INTEGER + 1;
      },
      (value) => {
        value.properties[0]!.supply.periods[0]!.confirmed_purchase_storage_cents = 1.5;
      },
      (value) => {
        value.properties[0]!.rooms_sold.room_nights_sold = Number.MAX_SAFE_INTEGER + 1;
      },
      (value) => {
        value.properties[0]!.rooms_sold.days[0]!.rooms_sold = 1.5;
      },
      (value) => {
        const period = value.properties[0]!.supply.periods[0]!;
        period.confirmed_purchase_storage_cents = (
          period.confirmed_purchase_storage_cents ?? 0
        ) + 1;
      },
      (value) => {
        value.properties[0]!.rooms_sold.days[0]!.denominator_complete = false;
      },
      (value) => {
        value.properties[0]!.supply.periods[0]!.updated_at = '2026-07-11T00:00:00.000Z';
      },
      (value) => {
        value.properties[0]!.supply.source_watermark.effective_source_cutoff =
          '2026-07-09T00:00:00.000Z';
      },
    ];
    for (const mutate of cases) {
      const unsafe = structuredClone(baseline);
      mutate(unsafe);
      assert.equal(managementPatternSourceSnapshotSchema.safeParse(unsafe).success, false);
    }
  });

  test('propagates an audited relationship cutoff into queries, facts, and membership evidence', () => {
    type MutableStream = {
      query_coverage_status: string;
      absence_detection_eligible: boolean;
      recording_flow_support?: string;
      event_dates: string[];
      source_event_count: number;
      source_watermark: Record<string, unknown>;
    };
    type MutableProperty = {
      relationship: { source_access: Record<string, unknown> };
      supply: {
        exclusion_codes: string[];
        source_watermark: Record<string, unknown>;
      };
      rooms_sold: {
        exclusion_codes: string[];
        source_watermark: Record<string, unknown>;
      };
      activity: {
        exclusion_codes: string[];
        inventory_counts: MutableStream;
        daily_log_closings: MutableStream;
        work_order_flow: MutableStream;
      };
    };
    const source = structuredClone(snapshot([{}])) as unknown as {
      properties: MutableProperty[];
    };
    const property = source.properties[0]!;
    const cutoff = '2026-07-05T00:00:00.000Z';
    const access = {
      effective_source_cutoff: cutoff,
      effective_source_cutoff_is_exclusive: true,
      effective_source_cutoff_reason: 'audited_membership_loss',
      effective_source_cutoff_proof_kind: 'organization_access_event',
      effective_source_cutoff_proof_at: '2026-07-06T00:00:00.000Z',
    };
    Object.assign(property.relationship.source_access, access);
    const streams = [
      property.activity.inventory_counts,
      property.activity.daily_log_closings,
      property.activity.work_order_flow,
    ];
    for (const stream of streams) {
      stream.query_coverage_status = 'not_evaluated';
      stream.absence_detection_eligible = false;
      if ('recording_flow_support' in stream) {
        stream.recording_flow_support = 'historical_mutability_unavailable';
      }
      stream.event_dates = STOPPED_DATES;
      stream.source_event_count = STOPPED_DATES.length;
      Object.assign(stream.source_watermark, {
        ...access,
        source_as_of: cutoff,
        requested_source_as_of: EVALUATED_AT,
      });
      if ('max_created_at' in stream.source_watermark) {
        stream.source_watermark.max_created_at = '2026-07-01T00:00:00.000Z';
      }
      if ('max_sealed_at' in stream.source_watermark) {
        stream.source_watermark.max_sealed_at = '2026-07-01T00:00:00.000Z';
      }
      if ('row_count' in stream.source_watermark) {
        stream.source_watermark.row_count = STOPPED_DATES.length;
      }
      if ('sealed_day_count' in stream.source_watermark) {
        stream.source_watermark.sealed_day_count = STOPPED_DATES.length;
      }
    }
    for (const watermark of [property.supply.source_watermark, property.rooms_sold.source_watermark]) {
      Object.assign(watermark, {
        ...access,
        source_as_of: cutoff,
        requested_source_as_of: EVALUATED_AT,
      });
    }
    property.supply.exclusion_codes.push('relationship_source_access_limited');
    property.rooms_sold.exclusion_codes.push('relationship_source_access_limited');
    property.activity.exclusion_codes.push('relationship_source_access_limited');

    const parsed = managementPatternSourceSnapshotSchema.parse(source);
    const prepared = prepareManagementPatternInputs(parsed);
    const preparedProperty = prepared.properties[0]!;
    assert.equal(preparedProperty.supply.observation?.source.extractedAt, cutoff);
    assert.equal(preparedProperty.supply.observation?.denominator?.source.extractedAt, cutoff);
    assert.ok(preparedProperty.supply.reasonCodes.includes('relationship_source_access_limited'));
    const evaluation = evaluateManagementPatterns(prepared);
    const bundle = buildManagementPatternPersistenceBundle(prepared, evaluation);
    const membership = bundle.input.runProperties[0]?.membership_snapshot as {
      relationship: { source_access: Record<string, unknown> };
    };
    assert.deepEqual(membership.relationship.source_access, access);
    assert.ok(bundle.input.metricSourceFacts.every((fact) => (
      Date.parse(String(fact.source_recorded_at)) < Date.parse(cutoff)
    )));
  });

  test('bounds absence freshness and abstains on a partial final business date', () => {
    const source = snapshot(Array.from({ length: 6 }, () => ({})));
    const partial: ManagementPatternSourceSnapshot = {
      ...source,
      activity_window: { start_date: '2026-04-04', end_date: '2026-07-10', history_days: 98 },
      properties: source.properties.map((property) => ({
        ...property,
        windows: {
          ...property.windows,
          activity: {
            ...property.windows.activity,
            start_date: '2026-04-04',
            end_date: '2026-07-10',
            start_utc: '2026-04-04T00:00:00.000Z',
            end_utc: '2026-07-11T00:00:00.000Z',
          },
        },
      })),
    };
    const prepared = prepareManagementPatternInputs(partial);
    const activity = prepared.properties[0].activities.inventory_counts;
    assert.equal(activity.observation?.quality.freshThrough, EVALUATED_AT);
    assert.ok(activity.reasonCodes.includes('activity_window_incomplete_as_of_source'));
    const result = evaluateManagementPatterns(prepared);
    const outcome = result.outcomes.find((item) => item.outcomeKey === 'activity:inventory_counts');
    assert.equal(outcome?.result, 'abstained');
    assert.ok(outcome?.reasonCodes.includes('insufficient_portfolio_evidence_coverage'));
    const rootEvaluation = result.rootEvaluations.find((item) => item.rootSubjectKey === 'inventory_counts');
    assert.equal(rootEvaluation?.conclusion, 'abstained');
    assert.equal(rootEvaluation?.primaryOutcomeKey, 'activity:inventory_counts');
    assert.equal(rootEvaluation?.unavailablePropertyIds.length, 6);
  });

  test('fails closed when configured history is changed after source extraction', () => {
    const source = snapshot(Array.from({ length: 6 }, () => ({})));
    const prepared = prepareManagementPatternInputs({
      ...source,
      activity_window: { ...source.activity_window, history_days: 97 },
    });
    const result = evaluateManagementPatterns(prepared);
    assert.deepEqual(result.manifestations, []);
    assert.ok(result.reasonCodes.includes('activity_window_policy_mismatch'));
    assert.equal(result.outcomes[0].outcomeKey, 'input-gate');
  });

  test('reports the true snapshot property count when the source budget abstains', () => {
    const source = snapshot([]);
    const budgeted: ManagementPatternSourceSnapshot = {
      ...source,
      property_count: 51,
      source_budget_exceeded: true,
      properties: [],
    };
    const result = evaluateManagementPatterns(prepareManagementPatternInputs(budgeted));
    assert.ok(result.reasonCodes.includes('source_property_budget_exceeded'));
    const evidence = result.outcomes[0].evidence as Record<string, unknown>;
    assert.equal(evidence.snapshotPropertyCount, 51);
    assert.equal(evidence.preparedPropertyCount, 0);
  });
});
