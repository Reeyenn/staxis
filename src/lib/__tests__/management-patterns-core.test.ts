import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MANAGEMENT_PATTERN_FINGERPRINT_VERSION,
  buildMetricCohort,
  checkNormalizedCompatibility,
  classifyPatternScope,
  compareAgainstPeers,
  consolidatePatternCandidates,
  createConsolidationCandidate,
  createMetricObservation,
  createPropertyProfileSnapshot,
  normalizeObservation,
  stableFingerprint,
  stablePatternRootKey,
  stableSerialize,
  type ConsolidationCandidateInput,
  type MetricCohortPolicy,
  type MetricDefinition,
  type MetricObservation,
  type NormalizedObservation,
  type PeerComparisonPolicy,
  type PropertyProfileSnapshot,
} from '@/lib/company/management-patterns';

const AS_OF = '2026-07-08T12:00:00.000Z';
const EVALUATED_AT = '2026-07-10T12:00:00.000Z';

function profile(overrides: Partial<Parameters<typeof createPropertyProfileSnapshot>[0]> = {}): PropertyProfileSnapshot {
  return createPropertyProfileSnapshot({
    organizationId: 'org-a',
    propertyId: 'hotel-a',
    relationshipId: 'relationship-hotel-a',
    asOf: AS_OF,
    sourceRevision: 'property-row-v1',
    totalRooms: 100,
    businessDateCutoffHour: 0,
    businessDateCutoffProvenance: {
      source: 'property_configuration',
      sourceRevision: 'business-date-config-v1',
    },
    serviceLevel: 'Full Service',
    brandClass: 'Upper Upscale',
    marketType: 'Urban',
    regionId: 'North',
    operatingModel: 'Managed',
    amenityTags: ['Pool', 'Restaurant'],
    operatingCurrency: {
      code: 'usd',
      source: 'property_configuration',
      sourceRevision: 'currency-config-v1',
      storageScale: 2,
    },
    ...overrides,
  });
}

interface ObservationOverrides {
  readonly rawValue?: number | null;
  readonly rawUnit?: string;
  readonly rawCurrency?: string | null;
  readonly localStartDate?: string;
  readonly localEndDate?: string;
  readonly timeZone?: string;
  readonly utcStart?: string;
  readonly utcEnd?: string;
  readonly observedPoints?: number;
  readonly expectedPoints?: number;
  readonly freshThrough?: string;
  readonly denominator?: 'default' | 'missing' | 'null_value' | 'zero' | 'partial' | 'stale' | 'wrong_window';
}

function observation(propertyProfile: PropertyProfileSnapshot, overrides: ObservationOverrides = {}): MetricObservation {
  const denominatorKind = overrides.denominator ?? 'default';
  const metricWindow = {
    kind: 'business_dates' as const,
    localStartDate: overrides.localStartDate ?? '2026-07-01',
    localEndDate: overrides.localEndDate ?? '2026-07-07',
    timeZone: overrides.timeZone ?? 'America/Chicago',
    utcStart: overrides.utcStart ?? '2026-07-01T05:00:00.000Z',
    utcEnd: overrides.utcEnd ?? '2026-07-08T05:00:00.000Z',
  };
  const denominator = denominatorKind === 'missing' ? null : {
    kind: 'rooms_sold' as const,
    value: denominatorKind === 'null_value' ? null : denominatorKind === 'zero' ? 0 : 100,
    unit: 'room_nights',
    currency: null,
    window: denominatorKind === 'wrong_window' ? {
      ...metricWindow,
      localStartDate: '2026-06-01',
      localEndDate: '2026-06-30',
      utcStart: '2026-06-01T05:00:00.000Z',
      utcEnd: '2026-07-01T05:00:00.000Z',
    } : metricWindow,
    source: {
      queryId: 'daily-log-denominator',
      queryVersion: 'v1',
      sourceRevision: 'daily-log-revision-1',
      extractedAt: '2026-07-10T10:00:00.000Z',
      parameters: { propertyId: propertyProfile.propertyId },
      recordCount: 7,
    },
    quality: {
      freshThrough: denominatorKind === 'stale'
        ? '2026-06-01T00:00:00.000Z'
        : '2026-07-09T23:59:00.000Z',
      observedPoints: denominatorKind === 'partial' ? 4 : 7,
      expectedPoints: 7,
      coverageBasis: 'complete business dates',
    },
  };
  return createMetricObservation({
    profile: propertyProfile,
    metricId: 'supply_spend',
    metricVersion: 'v2',
    observedAt: '2026-07-10T10:00:00.000Z',
    rawValue: overrides.rawValue === undefined ? 10_000 : overrides.rawValue,
    rawUnit: overrides.rawUnit ?? 'currency_minor',
    rawCurrency: overrides.rawCurrency === undefined
      ? propertyProfile.operatingCurrency?.code ?? null
      : overrides.rawCurrency,
    window: metricWindow,
    source: {
      queryId: 'inventory-close-spend',
      queryVersion: 'v2',
      sourceRevision: 'inventory-close-revision-4',
      extractedAt: '2026-07-10T10:00:00.000Z',
      parameters: { propertyId: propertyProfile.propertyId, end: '2026-07-07', start: '2026-07-01' },
      recordCount: 12,
    },
    quality: {
      freshThrough: overrides.freshThrough ?? '2026-07-09T23:59:00.000Z',
      observedPoints: overrides.observedPoints ?? 7,
      expectedPoints: overrides.expectedPoints ?? 7,
      coverageBasis: 'closed business dates',
    },
    denominator,
  });
}

const METRIC_DEFINITION: MetricDefinition = {
  metricId: 'supply_spend',
  metricVersion: 'v2',
  definitionVersion: 'per-occupied-room.v1',
  rawUnit: 'currency_minor',
  currencyRequirement: 'required',
  allowNegativeRaw: false,
  numeratorWindowKind: 'business_dates',
  denominator: { kind: 'rooms_sold', unit: 'room_nights', windowKind: 'business_dates' },
  normalizedUnit: 'currency_minor_per_occupied_room',
  minimumCompletenessRatio: 0.9,
  denominatorMinimumCompletenessRatio: 0.9,
  maximumAgeMs: 3 * 86_400_000,
  maximumFutureSkewMs: 5 * 60_000,
  blockingQualityFlags: ['partial_close'],
  windowAlignment: 'same_local_dates',
  timeZoneAlignment: 'same_time_zone',
};

function normalized(
  propertyProfile: PropertyProfileSnapshot,
  rawValue: number,
  definition: MetricDefinition = METRIC_DEFINITION,
  overrides: ObservationOverrides = {},
): NormalizedObservation {
  const result = normalizeObservation(
    observation(propertyProfile, { ...overrides, rawValue }),
    definition,
    EVALUATED_AT,
  );
  if (!result.ok) assert.fail(`normalization unexpectedly abstained: ${result.reasons.join(',')}`);
  return result.value;
}

describe('canonical identity and immutable profile snapshots', () => {
  test('stable serialization and SHA-256 ignore object insertion order, not values', () => {
    const left = { z: [3, 2, 1], a: { y: true, x: 'same' } };
    const right = { a: { x: 'same', y: true }, z: [3, 2, 1] };
    assert.equal(stableSerialize(left), stableSerialize(right));
    assert.equal(stableFingerprint(left, 'test'), stableFingerprint(right, 'test'));
    assert.notEqual(stableFingerprint(left, 'test'), stableFingerprint({ ...right, z: [1, 2, 3] }, 'test'));

    const payload = `${MANAGEMENT_PATTERN_FINGERPRINT_VERSION}\u0000test\u0000${stableSerialize(left)}`;
    const expected = createHash('sha256').update(payload).digest('hex');
    assert.equal(stableFingerprint(left, 'test'), expected);
    assert.match(stableFingerprint(left, 'test'), /^[0-9a-f]{64}$/);
  });

  test('canonical profiles preserve explicit attributes and never invent currency', () => {
    const noCurrency = profile({ operatingCurrency: null, amenityTags: [' Spa ', 'spa', 'Airport Shuttle'] });
    assert.equal(noCurrency.operatingCurrency, null);
    assert.equal(noCurrency.sizeBand, 'medium');
    assert.equal(noCurrency.sizeBandSource, 'room_count_policy');
    assert.deepEqual(noCurrency.amenityTags, ['airport_shuttle', 'spa']);
    assert.equal(noCurrency.serviceLevel, 'full_service');
    assert.equal(profile({ marketType: '東京 都心' }).marketType, '東京_都心');
    assert.throws(
      () => observation(noCurrency, { rawCurrency: 'USD' }),
      /no matching explicit currency/,
    );
    const differentCutoff = profile({
      operatingCurrency: null,
      businessDateCutoffHour: 3,
      businessDateCutoffProvenance: {
        source: 'property_configuration',
        sourceRevision: 'business-date-config-v2',
      },
    });
    assert.notEqual(noCurrency.fingerprint, differentCutoff.fingerprint);
    assert.throws(
      () => observation(profile({
        businessDateCutoffHour: 4,
        businessDateCutoffProvenance: {
          source: 'property_configuration',
          sourceRevision: 'cutoff-four-v1',
        },
      })),
      /does not match the profile time zone and cutoff hour/,
    );
  });

  test('region moves create a new snapshot without mutating the historical profile', () => {
    const before = profile({ regionId: 'North', asOf: '2026-06-01T00:00:00.000Z' });
    const after = profile({ regionId: 'South', asOf: '2026-07-01T00:00:00.000Z', sourceRevision: 'row-v2' });
    assert.equal(before.regionId, 'north');
    assert.equal(after.regionId, 'south');
    assert.notEqual(before.fingerprint, after.fingerprint);
    assert.equal(before.regionId, 'north', 'the earlier snapshot stays reproducible after a move');
  });
});

describe('normalization is a compatibility and data-quality gate', () => {
  test('aligns calendar-month numerators with cutoff business-date denominators by local labels across DST', () => {
    const targetProfile = profile({
      propertyId: 'cutoff-three-dst',
      businessDateCutoffHour: 3,
      businessDateCutoffProvenance: {
        source: 'property_configuration',
        sourceRevision: 'cutoff-three-dst-v1',
      },
    });
    const makeObservation = (
      propertyProfile: PropertyProfileSnapshot,
      denominatorUtcStart: string,
      denominatorUtcEnd: string,
      denominatorTimeZone = 'America/Chicago',
    ) => createMetricObservation({
      profile: propertyProfile,
      metricId: 'supply_spend',
      metricVersion: 'v2',
      observedAt: '2026-07-10T10:00:00.000Z',
      rawValue: 10_000,
      rawUnit: 'currency_minor',
      rawCurrency: 'USD',
      window: {
        kind: 'instant_range',
        localStartDate: '2026-03-01',
        localEndDate: '2026-03-31',
        timeZone: 'America/Chicago',
        // Local midnight shifts by an hour across the March DST boundary.
        utcStart: '2026-03-01T06:00:00.000Z',
        utcEnd: '2026-04-01T05:00:00.000Z',
      },
      source: {
        queryId: 'calendar-month-inventory',
        queryVersion: 'v1',
        sourceRevision: `calendar-month-${propertyProfile.propertyId}`,
        extractedAt: '2026-07-10T10:00:00.000Z',
        parameters: { propertyId: propertyProfile.propertyId },
        recordCount: 3,
      },
      quality: {
        freshThrough: '2026-07-09T23:59:00.000Z',
        observedPoints: 31,
        expectedPoints: 31,
        coverageBasis: 'completed calendar month',
      },
      denominator: {
        kind: 'rooms_sold',
        value: 100,
        unit: 'room_nights',
        currency: null,
        window: {
          kind: 'business_dates',
          localStartDate: '2026-03-01',
          localEndDate: '2026-03-31',
          timeZone: denominatorTimeZone,
          utcStart: denominatorUtcStart,
          utcEnd: denominatorUtcEnd,
        },
        source: {
          queryId: 'business-date-occupancy',
          queryVersion: 'v1',
          sourceRevision: `business-date-${propertyProfile.propertyId}`,
          extractedAt: '2026-07-10T10:00:00.000Z',
          parameters: { propertyId: propertyProfile.propertyId },
          recordCount: 31,
        },
        quality: {
          freshThrough: '2026-07-09T23:59:00.000Z',
          observedPoints: 31,
          expectedPoints: 31,
          coverageBasis: 'complete business dates',
        },
      },
    });
    const targetObservation = makeObservation(
      targetProfile,
      '2026-03-01T09:00:00.000Z',
      '2026-04-01T08:00:00.000Z',
    );
    assert.equal(targetObservation.window.businessDateCutoffHour, null);
    assert.equal(targetObservation.window.businessDateCutoffProvenanceFingerprint, null);
    assert.equal(targetObservation.denominator?.window.businessDateCutoffHour, 3);
    const calendarMonthDefinition: MetricDefinition = {
      ...METRIC_DEFINITION,
      definitionVersion: 'calendar-month-per-occupied-room.v1',
      numeratorWindowKind: 'instant_range',
      denominator: {
        ...METRIC_DEFINITION.denominator!,
        windowKind: 'business_dates',
      },
    };
    const target = normalizeObservation(targetObservation, calendarMonthDefinition, EVALUATED_AT);
    assert.equal(target.ok, true);
    if (!target.ok) return;

    const exactUtcDefinition: MetricDefinition = {
      ...calendarMonthDefinition,
      definitionVersion: 'per-occupied-room-exact-utc.v1',
      windowAlignment: 'same_utc_range',
    };
    const strict = normalizeObservation(targetObservation, exactUtcDefinition, EVALUATED_AT);
    assert.equal(strict.ok, false);
    if (!strict.ok) assert.ok(strict.reasons.includes('denominator_window_mismatch'));

    const wrongNumeratorKind = normalizeObservation(targetObservation, METRIC_DEFINITION, EVALUATED_AT);
    assert.equal(wrongNumeratorKind.ok, false);
    if (!wrongNumeratorKind.ok) {
      assert.ok(wrongNumeratorKind.reasons.includes('numerator_window_kind_mismatch'));
    }
    const wrongDenominatorKindDefinition: MetricDefinition = {
      ...calendarMonthDefinition,
      definitionVersion: 'wrong-denominator-kind.v1',
      denominator: { ...calendarMonthDefinition.denominator!, windowKind: 'instant_range' },
    };
    const wrongDenominatorKind = normalizeObservation(
      targetObservation,
      wrongDenominatorKindDefinition,
      EVALUATED_AT,
    );
    assert.equal(wrongDenominatorKind.ok, false);
    if (!wrongDenominatorKind.ok) {
      assert.ok(wrongDenominatorKind.reasons.includes('denominator_window_kind_mismatch'));
    }
    const mislabeledZone = normalizeObservation(
      makeObservation(
        targetProfile,
        '2026-03-01T08:00:00.000Z',
        '2026-04-01T07:00:00.000Z',
        'America/New_York',
      ),
      calendarMonthDefinition,
      EVALUATED_AT,
    );
    assert.equal(mislabeledZone.ok, false);
    if (!mislabeledZone.ok) {
      assert.ok(mislabeledZone.reasons.includes('denominator_time_zone_mismatch'));
    }

    const peerProfile = profile({
      propertyId: 'cutoff-four-dst',
      relationshipId: 'relationship-cutoff-four-dst',
      businessDateCutoffHour: 4,
      businessDateCutoffProvenance: {
        source: 'property_configuration',
        sourceRevision: 'cutoff-four-dst-v1',
      },
    });
    const peerResult = normalizeObservation(
      makeObservation(peerProfile, '2026-03-01T10:00:00.000Z', '2026-04-01T09:00:00.000Z'),
      calendarMonthDefinition,
      EVALUATED_AT,
    );
    assert.equal(peerResult.ok, true);
    if (peerResult.ok) {
      assert.equal(
        checkNormalizedCompatibility(target.value, peerResult.value, calendarMonthDefinition).ok,
        true,
      );
    }
  });

  test('preserves raw totals and exact provenance while deriving a denominator value', () => {
    const raw = observation(profile(), { rawValue: 25_000 });
    const result = normalizeObservation(raw, METRIC_DEFINITION, EVALUATED_AT);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.value, 250);
    assert.equal(result.value.observation.rawValue, 25_000);
    assert.equal(result.value.observation.denominator?.value, 100);
    assert.equal(result.value.observation.window.localStartDate, '2026-07-01');
    assert.equal(result.value.observation.window.utcStart, '2026-07-01T05:00:00.000Z');
    assert.equal(result.value.observation.source.queryVersion, 'v2');
  });

  test('abstains on partial or stale numerator data and missing, zero, partial, or stale denominators', () => {
    const cases: readonly [ObservationOverrides, string][] = [
      [{ observedPoints: 4 }, 'observation_incomplete'],
      [{ freshThrough: '2026-06-01T00:00:00.000Z' }, 'observation_stale'],
      [{ denominator: 'missing' }, 'denominator_missing'],
      [{ denominator: 'null_value' }, 'denominator_missing'],
      [{ denominator: 'zero' }, 'denominator_not_positive'],
      [{ denominator: 'partial' }, 'denominator_incomplete'],
      [{ denominator: 'stale' }, 'denominator_stale'],
      [{ denominator: 'wrong_window' }, 'denominator_window_mismatch'],
    ];
    for (const [overrides, expectedReason] of cases) {
      const result = normalizeObservation(observation(profile(), overrides), METRIC_DEFINITION, EVALUATED_AT);
      assert.equal(result.ok, false);
      if (result.ok) continue;
      assert.ok(result.reasons.includes(expectedReason as never), expectedReason);
      if (overrides.denominator === 'null_value') {
        assert.equal(result.observationFingerprint, observation(profile(), overrides).fingerprint);
        assert.equal(observation(profile(), overrides).denominator?.value, null);
        assert.equal(observation(profile(), overrides).denominator?.source.queryId, 'daily-log-denominator');
      }
    }
  });

  test('distinguishes a proven missing numerator from an explicit zero', () => {
    const missingObservation = observation(profile(), { rawValue: null });
    const missing = normalizeObservation(missingObservation, METRIC_DEFINITION, EVALUATED_AT);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.ok(missing.reasons.includes('numerator_missing'));
    assert.equal(missingObservation.rawValue, null);
    assert.equal(missingObservation.source.queryId, 'inventory-close-spend');

    const zero = normalizeObservation(observation(profile(), { rawValue: 0 }), METRIC_DEFINITION, EVALUATED_AT);
    assert.equal(zero.ok, true);
    if (zero.ok) assert.equal(zero.value.value, 0);
  });

  test('hard-gates missing currency and mismatched raw units', () => {
    const noCurrencyProfile = profile({ operatingCurrency: null });
    const missingCurrency = normalizeObservation(
      observation(noCurrencyProfile, { rawCurrency: null }),
      METRIC_DEFINITION,
      EVALUATED_AT,
    );
    assert.equal(missingCurrency.ok, false);
    if (!missingCurrency.ok) assert.ok(missingCurrency.reasons.includes('currency_missing'));

    const wrongUnit = normalizeObservation(
      observation(profile(), { rawUnit: 'dollars' }),
      METRIC_DEFINITION,
      EVALUATED_AT,
    );
    assert.equal(wrongUnit.ok, false);
    if (!wrongUnit.ok) assert.ok(wrongUnit.reasons.includes('raw_unit_mismatch'));

    const unknownCutoff = profile({
      businessDateCutoffHour: null,
      businessDateCutoffProvenance: null,
    });
    const noCutoff = normalizeObservation(observation(unknownCutoff), METRIC_DEFINITION, EVALUATED_AT);
    assert.equal(noCutoff.ok, false);
    if (!noCutoff.ok) assert.ok(noCutoff.reasons.includes('business_date_cutoff_missing'));
  });

  test('mixed currencies never compare', () => {
    const usd = normalized(profile({ propertyId: 'usd-hotel' }), 10_000);
    const eur = normalized(profile({
      propertyId: 'eur-hotel',
      relationshipId: 'relationship-eur',
      operatingCurrency: {
        code: 'EUR',
        source: 'property_configuration',
        sourceRevision: 'currency-eur-v1',
        storageScale: 2,
      },
    }), 10_000);
    const compatibility = checkNormalizedCompatibility(usd, eur, METRIC_DEFINITION);
    assert.equal(compatibility.ok, false);
    if (!compatibility.ok) assert.ok(compatibility.reasons.includes('different_currency'));
  });

  test('same currency code with a different persisted scale is incompatible', () => {
    const scaleTwo = normalized(profile({ propertyId: 'scale-two' }), 10_000);
    const scaleThree = normalized(profile({
      propertyId: 'scale-three',
      operatingCurrency: {
        code: 'USD',
        source: 'property_configuration',
        sourceRevision: 'currency-scale-3',
        storageScale: 3,
      },
    }), 10_000);
    const compatibility = checkNormalizedCompatibility(scaleTwo, scaleThree, METRIC_DEFINITION);
    assert.equal(compatibility.ok, false);
    if (!compatibility.ok) assert.ok(compatibility.reasons.includes('different_currency_scale'));
  });

  test('time-zone and window differences are rejected unless the metric explicitly uses property-local dates', () => {
    const targetProfile = profile({ propertyId: 'chicago' });
    const peerProfile = profile({ propertyId: 'new-york', relationshipId: 'relationship-ny' });
    const target = normalized(targetProfile, 10_000);
    const peer = normalized(peerProfile, 10_000, METRIC_DEFINITION, {
      timeZone: 'America/New_York',
      utcStart: '2026-07-01T04:00:00.000Z',
      utcEnd: '2026-07-08T04:00:00.000Z',
    });
    const strict = checkNormalizedCompatibility(target, peer, METRIC_DEFINITION);
    assert.equal(strict.ok, false);
    if (!strict.ok) assert.ok(strict.reasons.includes('different_time_zone'));

    const propertyLocalDefinition: MetricDefinition = {
      ...METRIC_DEFINITION,
      definitionVersion: 'per-occupied-room-property-local.v1',
      timeZoneAlignment: 'property_local',
    };
    const localTarget = normalized(targetProfile, 10_000, propertyLocalDefinition);
    const localPeer = normalized(peerProfile, 10_000, propertyLocalDefinition, {
      timeZone: 'America/New_York',
      utcStart: '2026-07-01T04:00:00.000Z',
      utcEnd: '2026-07-08T04:00:00.000Z',
    });
    assert.equal(checkNormalizedCompatibility(localTarget, localPeer, propertyLocalDefinition).ok, true);

    const shiftedPeer = normalized(peerProfile, 10_000, propertyLocalDefinition, {
      localStartDate: '2026-07-02',
      localEndDate: '2026-07-08',
      timeZone: 'America/New_York',
      utcStart: '2026-07-02T04:00:00.000Z',
      utcEnd: '2026-07-09T04:00:00.000Z',
    });
    const shifted = checkNormalizedCompatibility(localTarget, shiftedPeer, propertyLocalDefinition);
    assert.equal(shifted.ok, false);
    if (!shifted.ok) assert.ok(shifted.reasons.includes('different_local_window'));

    const differentCutoffProfile = profile({
      propertyId: 'cutoff-three',
      businessDateCutoffHour: 3,
      businessDateCutoffProvenance: {
        source: 'property_configuration',
        sourceRevision: 'cutoff-three-v1',
      },
    });
    const differentCutoff = normalized(differentCutoffProfile, 10_000, propertyLocalDefinition, {
      utcStart: '2026-07-01T08:00:00.000Z',
      utcEnd: '2026-07-08T08:00:00.000Z',
    });
    const cutoffCompatibility = checkNormalizedCompatibility(localTarget, differentCutoff, propertyLocalDefinition);
    assert.equal(cutoffCompatibility.ok, false);
    if (!cutoffCompatibility.ok) {
      assert.ok(cutoffCompatibility.reasons.includes('different_business_date_cutoff'));
    }
  });
});

const COHORT_POLICY: MetricCohortPolicy = {
  metricId: 'supply_spend',
  policyVersion: 'fair-supply-peers.v1',
  dimensions: [
    { dimension: 'serviceLevel', matcher: 'exact', relaxable: false },
    { dimension: 'sizeBand', matcher: 'exact', relaxable: false },
    { dimension: 'operatingCurrency', matcher: 'exact', relaxable: false },
    { dimension: 'regionId', matcher: 'exact', relaxable: true },
    { dimension: 'amenityTags', matcher: 'exact', relaxable: true },
  ],
  fallbackOrder: ['amenityTags', 'regionId'],
  allowOrganizationWideFallback: false,
};

function eligible(candidateProfile: PropertyProfileSnapshot) {
  return { profile: candidateProfile, eligibility: { eligible: true as const } };
}

describe('metric-specific cohorts are tenant-safe, leave-one-out and explicit about fallback', () => {
  test('uses five peers by default, filters another organization, and counts duplicate input once', () => {
    const target = profile({ propertyId: 'target' });
    const peers = Array.from({ length: 5 }, (_, index) => eligible(profile({
      propertyId: `peer-${index}`,
      relationshipId: `relationship-peer-${index}`,
    })));
    const foreign = Array.from({ length: 8 }, (_, index) => eligible(profile({
      organizationId: 'org-b',
      propertyId: `foreign-${index}`,
      relationshipId: `relationship-foreign-${index}`,
    })));
    const result = buildMetricCohort({
      target,
      candidates: [eligible(target), ...peers, peers[0], ...foreign],
      policy: COHORT_POLICY,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.cohort.members.length, 5);
    assert.ok(!result.cohort.members.some((member) => member.propertyId.startsWith('foreign-')));
    assert.ok(result.cohort.exclusions.some((excluded) => (
      excluded.propertyId === 'peer-0'
      && excluded.reasons.some((reason) => reason.code === 'duplicate_candidate_ignored')
    )));
    assert.ok(result.cohort.exclusions.some((excluded) => (
      excluded.reasons.some((reason) => reason.code === 'different_organization')
    )));
  });

  test('orders equal-fingerprint conflicting candidate records independently of input order', () => {
    const target = profile({ propertyId: 'target' });
    const shared = {
      profile: null,
      propertyId: 'ambiguous-peer',
      asOf: target.asOf,
      profileFingerprint: 'shared-unavailable-profile-receipt',
      eligibility: { eligible: false as const, reasons: ['profile_missing'] },
    };
    const candidates = [
      { ...shared, organizationId: target.organizationId },
      { ...shared, organizationId: 'org-b' },
    ];

    const forward = buildMetricCohort({ target, candidates, policy: COHORT_POLICY });
    const reversed = buildMetricCohort({
      target,
      candidates: [...candidates].reverse(),
      policy: COHORT_POLICY,
    });

    assert.deepEqual(reversed, forward);
    assert.equal(reversed.ok, false);
    if (!reversed.ok) {
      assert.match(reversed.receipt.fingerprint, /^[0-9a-f]{64}$/);
      assert.ok(reversed.exclusions.some((excluded) => (
        excluded.propertyId === 'ambiguous-peer'
        && excluded.reasons.some((reason) => reason.code === 'conflicting_candidate_records')
      )));
    }
  });

  test('falls back only in declared order and reports every attempted membership', () => {
    const target = profile({ propertyId: 'target' });
    const peers = [
      profile({ propertyId: 'p1' }),
      profile({ propertyId: 'p2' }),
      profile({ propertyId: 'p3' }),
      profile({ propertyId: 'p4', amenityTags: ['Gym'] }),
      profile({ propertyId: 'p5', regionId: 'South', amenityTags: ['Gym'] }),
      profile({ propertyId: 'p6', regionId: 'South', amenityTags: ['Gym'] }),
    ].map(eligible);
    const result = buildMetricCohort({ target, candidates: peers, policy: COHORT_POLICY });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.cohort.selectedLevel, 2);
    assert.deepEqual(result.cohort.relaxedDimensions, ['amenityTags', 'regionId']);
    assert.deepEqual(result.cohort.attempts.map((attempt) => attempt.peerCount), [3, 4, 6]);
    assert.equal(result.cohort.members.length, 6);
  });

  test('abstains for a sparse cohort rather than presenting a weak baseline', () => {
    const target = profile({ propertyId: 'target' });
    const result = buildMetricCohort({
      target,
      candidates: ['p1', 'p2', 'p3', 'p4'].map((propertyId) => eligible(profile({ propertyId }))),
      policy: COHORT_POLICY,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'insufficient_peers');
      assert.equal(result.minimumPeers, 5);
      assert.equal(result.attempts.at(-1)?.peerCount, 4);
    }
  });

  test('abstains when only five of twenty dimension-compatible peers have usable metric data', () => {
    const target = profile({ propertyId: 'target' });
    const usable = Array.from({ length: 5 }, (_, index) => eligible(profile({
      propertyId: `usable-${index}`,
    })));
    const unusable = Array.from({ length: 15 }, (_, index) => ({
      profile: profile({ propertyId: `unusable-${index}` }),
      eligibility: {
        eligible: false as const,
        reasons: ['denominator_missing'],
      },
    }));
    const result = buildMetricCohort({
      target,
      candidates: [...usable, ...unusable],
      policy: COHORT_POLICY,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'insufficient_usable_coverage');
    const finalAttempt = result.attempts.at(-1);
    assert.equal(finalAttempt?.comparablePeerCount, 20);
    assert.equal(finalAttempt?.usablePeerCount, 5);
    assert.equal(finalAttempt?.excludedPeerCount, 15);
    assert.equal(finalAttempt?.usableCoverageRatio, 0.25);
    assert.equal(finalAttempt?.minimumUsableCoverageRatio, 0.8);
    assert.equal(result.receipt.reason, 'insufficient_usable_coverage');
    assert.ok(result.exclusions.some((excluded) => (
      excluded.propertyId === 'unusable-0'
      && excluded.reasons.some((reason) => reason.code === 'metric_ineligible')
    )));
  });

  test('a region move affects only the new as-of cohort snapshot', () => {
    const beforeAsOf = '2026-06-01T00:00:00.000Z';
    const afterAsOf = '2026-07-01T00:00:00.000Z';
    const beforeTarget = profile({ propertyId: 'target', asOf: beforeAsOf });
    const beforePeer = profile({ propertyId: 'moving', asOf: beforeAsOf, regionId: 'North' });
    const afterTarget = profile({ propertyId: 'target', asOf: afterAsOf, sourceRevision: 'target-v2' });
    const afterPeer = profile({ propertyId: 'moving', asOf: afterAsOf, regionId: 'South', sourceRevision: 'moving-v2' });
    const twoPeerPolicy: MetricCohortPolicy = {
      ...COHORT_POLICY,
      policyVersion: 'historical-region-test.v1',
      fallbackOrder: [],
      minimumPeers: 2,
    };
    const beforeSecond = profile({ propertyId: 'steady', asOf: beforeAsOf });
    const afterSecond = profile({ propertyId: 'steady', asOf: afterAsOf, sourceRevision: 'steady-v2' });
    const before = buildMetricCohort({
      target: beforeTarget,
      candidates: [eligible(beforePeer), eligible(beforeSecond)],
      policy: twoPeerPolicy,
    });
    assert.equal(before.ok, true);
    const after = buildMetricCohort({
      target: afterTarget,
      candidates: [eligible(afterPeer), eligible(afterSecond)],
      policy: twoPeerPolicy,
    });
    assert.equal(after.ok, false);
    if (!after.ok) {
      assert.ok(after.exclusions.some((item) => (
        item.propertyId === 'moving'
        && item.reasons.some((reason) => reason.code === 'dimension_mismatch' && reason.dimension === 'regionId')
      )));
    }
    assert.equal(beforePeer.regionId, 'north');
  });
});

const COMPARISON_POLICY: PeerComparisonPolicy = {
  policyVersion: 'high-material-outlier.v1',
  direction: 'high',
  minimumAbsoluteDelta: 50,
  minimumRelativeDelta: 0.5,
  minimumRobustZ: 3,
  iqrFenceMultiplier: 1.5,
  maximumRelativeInterquartileRange: 0.75,
  maximumRelativeMedianAbsoluteDeviation: 0.35,
  zeroMedianPolicy: 'abstain',
};

function formedCohortFor(
  targetProfile: PropertyProfileSnapshot,
  peerProfiles: readonly PropertyProfileSnapshot[],
) {
  const result = buildMetricCohort({
    target: targetProfile,
    candidates: peerProfiles.map(eligible),
    policy: COHORT_POLICY,
  });
  if (!result.ok) assert.fail(`cohort unexpectedly abstained: ${result.reason}`);
  return result.cohort;
}

describe('robust comparison requires both statistical separation and materiality', () => {
  test('identifies a material outlier and labels scores as threshold progress, not certainty', () => {
    const targetProfile = profile({ propertyId: 'target' });
    const peerProfiles = [95, 100, 100, 105, 110].map((_, index) => profile({
      propertyId: `peer-${index}`,
      relationshipId: `relationship-peer-${index}`,
    }));
    const target = normalized(targetProfile, 30_000);
    const peers = [95, 100, 100, 105, 110].map((value, index) => normalized(peerProfiles[index], value * 100));
    const cohort = formedCohortFor(targetProfile, peerProfiles);
    const result = compareAgainstPeers({
      target,
      peers,
      cohort,
      definition: METRIC_DEFINITION,
      policy: COMPARISON_POLICY,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.comparison.status, 'outlier');
    assert.equal(result.comparison.distribution.median, 100);
    assert.equal(result.comparison.targetValue, 300);
    assert.equal(result.comparison.scoreKind, 'threshold_progress_not_probability');
    assert.equal(result.comparison.outlierScore, 1);
    assert.equal(result.comparison.cohortFingerprint, cohort.fingerprint);
    assert.equal(result.comparison.targetEvidence.rawValue, 30_000);
    assert.equal(result.comparison.peerValues[0].rawValue, 9_500);
    assert.equal(result.comparison.targetObservationFingerprint, target.fingerprint);
    assert.equal(target.observation.rawValue, 30_000);
  });

  test('does not call a small or statistically weak difference an outlier', () => {
    const targetProfile = profile({ propertyId: 'target' });
    const peerProfiles = [95, 100, 100, 105, 110].map((_, index) => profile({
      propertyId: `peer-${index}`,
    }));
    const target = normalized(targetProfile, 11_500);
    const peers = [95, 100, 100, 105, 110].map((value, index) => normalized(peerProfiles[index], value * 100));
    const result = compareAgainstPeers({
      target,
      peers,
      cohort: formedCohortFor(targetProfile, peerProfiles),
      definition: METRIC_DEFINITION,
      policy: COMPARISON_POLICY,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.comparison.status, 'not_outlier');
      assert.equal(result.comparison.passesMateriality, false);
    }
  });

  test('abstains before outlier emission when the peer baseline is too heterogeneous', () => {
    const targetProfile = profile({ propertyId: 'target' });
    const peerProfiles = [10, 50, 100, 150, 200].map((_, index) => profile({
      propertyId: `heterogeneous-peer-${index}`,
    }));
    const result = compareAgainstPeers({
      target: normalized(targetProfile, 100_000),
      peers: [10, 50, 100, 150, 200].map((value, index) => (
        normalized(peerProfiles[index], value * 100)
      )),
      cohort: formedCohortFor(targetProfile, peerProfiles),
      definition: METRIC_DEFINITION,
      policy: COMPARISON_POLICY,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(result.reasons, ['unstable_peer_baseline']);
    assert.equal(result.distribution?.median, 100);
    assert.equal(result.baselineStability?.status, 'unstable');
    assert.equal(result.baselineStability?.relativeInterquartileRange, 1);
    assert.equal(result.baselineStability?.relativeMedianAbsoluteDeviation, 0.5);
    assert.ok(result.baselineStability?.reasonCodes.includes('relative_iqr_exceeds_maximum'));
    assert.ok(result.baselineStability?.reasonCodes.includes('relative_mad_exceeds_maximum'));
    assert.match(result.baselineStability?.fingerprint ?? '', /^[0-9a-f]{64}$/);
  });

  test('abstains when cross-org or conflicting duplicate values reduce compatible N below five', () => {
    const targetProfile = profile({ propertyId: 'target' });
    const ordinaryProfiles = [100, 101, 102, 103].map((_, index) => profile({
      propertyId: `peer-${index}`,
    }));
    const duplicateProfile = profile({ propertyId: 'duplicate' });
    const target = normalized(targetProfile, 30_000);
    const ordinaryPeers = [100, 101, 102, 103].map((value, index) => normalized(ordinaryProfiles[index], value * 100));
    const foreign = normalized(profile({ organizationId: 'org-b', propertyId: 'foreign' }), 10_000);
    const duplicateA = normalized(duplicateProfile, 10_000);
    const duplicateB = normalized(duplicateProfile, 12_000);
    const result = compareAgainstPeers({
      target,
      peers: [...ordinaryPeers, foreign, duplicateA, duplicateB],
      cohort: formedCohortFor(targetProfile, [...ordinaryProfiles, duplicateProfile]),
      definition: METRIC_DEFINITION,
      policy: COMPARISON_POLICY,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.compatiblePeerCount, 4);
      assert.ok(result.exclusions.some((item) => item.reasons.includes('outside_formed_cohort')));
      assert.ok(result.exclusions.some((item) => item.reasons.includes('conflicting_duplicate_observations')));
    }
  });

  test('does not allow an outside peer or a missing formed-cohort member to rewrite the baseline', () => {
    const targetProfile = profile({ propertyId: 'target' });
    const peerProfiles = [0, 1, 2, 3, 4].map((index) => profile({ propertyId: `peer-${index}` }));
    const cohort = formedCohortFor(targetProfile, peerProfiles);
    const target = normalized(targetProfile, 30_000);
    const peers = peerProfiles.map((peerProfile) => normalized(peerProfile, 10_000));
    const outside = normalized(profile({ propertyId: 'outside' }), 9_999_900);
    const withOutside = compareAgainstPeers({
      target,
      peers: [...peers, outside],
      cohort,
      definition: METRIC_DEFINITION,
      policy: COMPARISON_POLICY,
    });
    assert.equal(withOutside.ok, true);
    if (withOutside.ok) {
      assert.equal(withOutside.comparison.distribution.median, 100);
      assert.ok(withOutside.comparison.exclusions.some((item) => item.reasons.includes('outside_formed_cohort')));
    }

    const missing = compareAgainstPeers({
      target,
      peers: peers.slice(0, 4),
      cohort,
      definition: METRIC_DEFINITION,
      policy: COMPARISON_POLICY,
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.ok(missing.reasons.includes('cohort_members_missing'));
      assert.ok(missing.exclusions.some((item) => item.reasons.includes('cohort_member_observation_missing')));
    }

    const tampered = compareAgainstPeers({
      target,
      peers,
      cohort: { ...cohort, fingerprint: 'tampered' },
      definition: METRIC_DEFINITION,
      policy: COMPARISON_POLICY,
    });
    assert.equal(tampered.ok, false);
    if (!tampered.ok) assert.ok(tampered.reasons.includes('cohort_fingerprint_invalid'));
  });
});

function candidate(overrides: Partial<ConsolidationCandidateInput> = {}) {
  const propertyId = overrides.affectedPropertyIds?.[0] ?? 'hotel-a';
  return createConsolidationCandidate({
    candidateId: 'candidate-a',
    organizationId: 'org-a',
    runFingerprint: 'run-2026-07-10',
    detectorId: 'supply-gap-check',
    detectorVersion: 'v2',
    semanticRootFamily: 'supply-cost-control',
    rootSubjectKey: 'housekeeping-supplies',
    mergeContractVersion: 'supply-root-contract.v1',
    compatibilityKey: 'completed-week-supply-control',
    analysisWindowKey: 'business-week:2026-07-01:2026-07-07:v1',
    assertion: 'issue_present',
    direction: 'high',
    affectedPropertyIds: ['hotel-a'],
    localInstances: [{
      instanceId: `local-${propertyId}`,
      propertyId,
      evidenceFingerprint: `local-evidence-${propertyId}`,
    }],
    evidenceFingerprint: 'evidence-a',
    materialityScore: 0.9,
    ...overrides,
  });
}

describe('cross-check consolidation has semantic identity and preserves every manifestation', () => {
  test('merges compatible detectors under one root without detector or scope in identity', () => {
    const first = candidate();
    const second = candidate({
      candidateId: 'candidate-b',
      detectorId: 'purchasing-variance-check',
      detectorVersion: 'v1',
      affectedPropertyIds: ['hotel-b'],
      localInstances: [{ instanceId: 'local-hotel-b', propertyId: 'hotel-b', evidenceFingerprint: 'local-b' }],
      evidenceFingerprint: 'evidence-b',
      materialityScore: 0.8,
    });
    const result = consolidatePatternCandidates([second, first]);
    assert.equal(result.patterns.length, 1);
    assert.equal(result.patterns[0].manifestations.length, 2);
    assert.deepEqual(result.patterns[0].affectedPropertyIds, ['hotel-a', 'hotel-b']);
    assert.equal(result.patterns[0].localInstances.length, 2);
    assert.equal(first.rootKey, second.rootKey);
    assert.equal(first.rootKey, stablePatternRootKey({
      organizationId: 'org-a',
      semanticRootFamily: 'supply-cost-control',
      rootSubjectKey: 'housekeeping-supplies',
    }));
  });

  test('deduplicates retried events but retains their event ids', () => {
    const first = candidate({ candidateId: 'delivery-1' });
    const retry = candidate({ candidateId: 'delivery-2' });
    assert.equal(first.fingerprint, retry.fingerprint);
    const result = consolidatePatternCandidates([retry, first]);
    assert.equal(result.patterns[0].manifestations.length, 1);
    assert.equal(result.duplicates.length, 1);
    assert.deepEqual(result.duplicates[0].duplicateCandidateIds, ['delivery-2']);
  });

  test('surfaces contradictory checks instead of silently choosing one', () => {
    const supporting = candidate({ candidateId: 'supporting' });
    const refuting = candidate({
      candidateId: 'refuting',
      detectorId: 'control-check',
      assertion: 'issue_absent',
      direction: 'not_applicable',
      evidenceFingerprint: 'refuting-evidence',
    });
    const result = consolidatePatternCandidates([supporting, refuting]);
    assert.equal(result.patterns[0].status, 'conflicted');
    assert.equal(result.patterns[0].assertion, 'conflicted');
    assert.ok(result.conflicts.some((conflict) => conflict.code === 'contradictory_assertions'));
    assert.equal(result.patterns[0].manifestations.length, 2);
  });

  test('fails closed on mixed assertions for disjoint hotels and retains both local manifestations', () => {
    const supporting = candidate({ candidateId: 'supporting-hotel-a' });
    const refuting = candidate({
      candidateId: 'refuting-hotel-b',
      detectorId: 'control-check',
      assertion: 'issue_absent',
      direction: 'not_applicable',
      affectedPropertyIds: ['hotel-b'],
      localInstances: [{
        instanceId: 'control-hotel-b',
        propertyId: 'hotel-b',
        evidenceFingerprint: 'control-evidence-hotel-b',
      }],
      evidenceFingerprint: 'refuting-evidence-hotel-b',
    });
    const result = consolidatePatternCandidates([supporting, refuting]);
    const pattern = result.patterns[0];
    assert.equal(pattern.status, 'conflicted');
    assert.equal(pattern.assertion, 'conflicted');
    assert.deepEqual(pattern.affectedPropertyIds, ['hotel-a', 'hotel-b']);
    assert.equal(pattern.manifestations.length, 2);
    assert.deepEqual(
      pattern.localInstances.map((instance) => instance.propertyId).sort(),
      ['hotel-a', 'hotel-b'],
    );
    const conflict = pattern.conflicts.find((item) => item.code === 'contradictory_assertions');
    assert.deepEqual(conflict?.affectedPropertyIds, ['hotel-a', 'hotel-b']);
  });

  test('keeps incompatible windows/contracts separate and never merges organizations', () => {
    const base = candidate({ candidateId: 'base' });
    const otherWindow = candidate({
      candidateId: 'next-week',
      analysisWindowKey: 'business-week:2026-07-08:2026-07-14:v1',
      evidenceFingerprint: 'next-week-evidence',
    });
    const otherOrganization = candidate({
      candidateId: 'foreign',
      organizationId: 'org-b',
      evidenceFingerprint: 'foreign-evidence',
    });
    const result = consolidatePatternCandidates([base, otherWindow, otherOrganization]);
    assert.equal(result.patterns.length, 3);
    assert.ok(result.separations.some((item) => item.reasons.includes('different_window')));
    assert.equal(new Set(result.patterns.map((pattern) => pattern.rootKey)).size, 2);
  });
});

describe('scope classification describes evidence, never query or access breadth', () => {
  const rootKey = stablePatternRootKey({
    organizationId: 'org-a',
    semanticRootFamily: 'staffing-rhythm',
    rootSubjectKey: 'overnight-coverage',
  });

  test('classifies property-local and peer-cohort evidence distinctly', () => {
    const local = classifyPatternScope({
      organizationId: 'org-a',
      rootKey,
      evidenceBasis: 'property_only',
      eligibleOrganizationPropertyIds: ['a', 'b', 'c'],
      evaluatedPropertyIds: ['a'],
      affectedPropertyIds: ['a'],
    });
    assert.equal(local.ok, true);
    if (local.ok) assert.equal(local.classification.scope, 'property_local');

    const peer = classifyPatternScope({
      organizationId: 'org-a',
      rootKey,
      evidenceBasis: 'peer_comparison',
      eligibleOrganizationPropertyIds: ['a', 'b', 'c', 'd'],
      evaluatedPropertyIds: ['a', 'b', 'c'],
      affectedPropertyIds: ['a'],
      peerCohort: { cohortFingerprint: 'cohort-v1', targetPropertyId: 'a', peerPropertyIds: ['b', 'c'] },
    });
    assert.equal(peer.ok, true);
    if (peer.ok) assert.equal(peer.classification.scope, 'peer_cohort');

    const comparatorOnly = classifyPatternScope({
      organizationId: 'org-a',
      rootKey,
      evidenceBasis: 'peer_comparison',
      eligibleOrganizationPropertyIds: ['a', 'b', 'c'],
      evaluatedPropertyIds: ['a', 'b', 'c'],
      affectedPropertyIds: ['b'],
      peerCohort: { cohortFingerprint: 'cohort-v1', targetPropertyId: 'a', peerPropertyIds: ['b', 'c'] },
    });
    assert.equal(comparatorOnly.ok, false);
    if (!comparatorOnly.ok) assert.ok(comparatorOnly.reasons.includes('peer_cohort_evidence_invalid'));
  });

  test('requires evidence coverage for group/region and company-wide labels', () => {
    const group = classifyPatternScope({
      organizationId: 'org-a',
      rootKey,
      evidenceBasis: 'cross_property_condition',
      eligibleOrganizationPropertyIds: ['a', 'b', 'c', 'd'],
      evaluatedPropertyIds: ['a', 'b', 'c', 'd'],
      affectedPropertyIds: ['a', 'b'],
      groups: [{
        groupId: 'north',
        kind: 'region',
        snapshotFingerprint: 'region-snapshot-v2',
        propertyIds: ['a', 'b'],
      }],
    });
    assert.equal(group.ok, true);
    if (group.ok) {
      assert.equal(group.classification.scope, 'group_region');
      assert.equal(group.classification.matchedGroup?.groupId, 'north');
    }

    const company = classifyPatternScope({
      organizationId: 'org-a',
      rootKey,
      evidenceBasis: 'cross_property_condition',
      eligibleOrganizationPropertyIds: ['a', 'b', 'c'],
      evaluatedPropertyIds: ['a', 'b', 'c'],
      affectedPropertyIds: ['a', 'b', 'c'],
    });
    assert.equal(company.ok, true);
    if (company.ok) assert.equal(company.classification.scope, 'company_wide');
  });

  test('query/access changes do not change classified scope or its fingerprint', () => {
    const base = {
      organizationId: 'org-a',
      rootKey,
      evidenceBasis: 'property_only' as const,
      eligibleOrganizationPropertyIds: ['a', 'b'],
      evaluatedPropertyIds: ['a'],
      affectedPropertyIds: ['a'],
    };
    const broad = classifyPatternScope({
      ...base,
      queryScope: { kind: 'all_hotels' },
      accessScope: { kind: 'organization', organizationId: 'org-a' },
    });
    const narrow = classifyPatternScope({
      ...base,
      queryScope: { kind: 'single_hotel', propertyId: 'a' },
      accessScope: { kind: 'property', propertyIds: ['a'] },
    });
    assert.equal(broad.ok, true);
    assert.equal(narrow.ok, true);
    if (broad.ok && narrow.ok) {
      assert.equal(broad.classification.scope, narrow.classification.scope);
      assert.equal(broad.classification.fingerprint, narrow.classification.fingerprint);
      assert.notDeepEqual(broad.classification.queryScope, narrow.classification.queryScope);
    }
  });

  test('scope can transition across occurrences while semantic root identity stays stable', () => {
    const peer = classifyPatternScope({
      organizationId: 'org-a',
      rootKey,
      evidenceBasis: 'peer_comparison',
      eligibleOrganizationPropertyIds: ['a', 'b', 'c'],
      evaluatedPropertyIds: ['a', 'b', 'c'],
      affectedPropertyIds: ['a'],
      peerCohort: { cohortFingerprint: 'week-1-cohort', targetPropertyId: 'a', peerPropertyIds: ['b', 'c'] },
    });
    const company = classifyPatternScope({
      organizationId: 'org-a',
      rootKey,
      evidenceBasis: 'cross_property_condition',
      eligibleOrganizationPropertyIds: ['a', 'b', 'c'],
      evaluatedPropertyIds: ['a', 'b', 'c'],
      affectedPropertyIds: ['a', 'b', 'c'],
    });
    assert.equal(peer.ok, true);
    assert.equal(company.ok, true);
    if (peer.ok && company.ok) {
      assert.equal(peer.classification.rootKey, company.classification.rootKey);
      assert.equal(peer.classification.scope, 'peer_cohort');
      assert.equal(company.classification.scope, 'company_wide');
      assert.notEqual(peer.classification.fingerprint, company.classification.fingerprint);
    }
  });

  test('abstains when affected hotels are outside the as-of organization universe', () => {
    const result = classifyPatternScope({
      organizationId: 'org-a',
      rootKey,
      evidenceBasis: 'property_only',
      eligibleOrganizationPropertyIds: ['a'],
      evaluatedPropertyIds: ['a', 'foreign'],
      affectedPropertyIds: ['foreign'],
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.reasons.includes('affected_outside_eligible_universe'));
      assert.ok(result.reasons.includes('evaluated_outside_eligible_universe'));
    }
  });
});
