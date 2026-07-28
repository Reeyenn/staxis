import 'server-only';

import {
  createMetricObservation,
  createPropertyProfileSnapshot,
  normalizeObservation,
  stableFingerprint,
  type MetricObservation,
  type NormalizationResult,
  type ObservationWindowInput,
  type PropertyProfileSnapshot,
} from './index';
import {
  SUPPLY_SPEND_METRIC_DEFINITION,
  SUPPLY_SPEND_METRIC_ID,
  SUPPLY_SPEND_METRIC_VERSION,
} from './definitions';
import type {
  ManagementPatternSourceProperty,
  ManagementPatternSourceSnapshot,
} from './source-snapshot';
import { managementPatternMetricSourceRoleFingerprint } from './source-facts';

export type ActivityStreamId = 'inventory_counts' | 'daily_log_closings' | 'work_order_flow';

export const ACTIVITY_STREAM_LABELS: Readonly<Record<ActivityStreamId, string>> = Object.freeze({
  inventory_counts: 'inventory count entries',
  daily_log_closings: 'daily closing records',
  work_order_flow: 'maintenance entries',
});

export interface PreparedSupplyInput {
  readonly observation: MetricObservation | null;
  readonly normalization: NormalizationResult | null;
  readonly reasonCodes: readonly string[];
  readonly sourceFingerprint: string;
}

export interface PreparedActivityInput {
  readonly streamId: ActivityStreamId;
  readonly eventDates: readonly string[];
  readonly observation: MetricObservation | null;
  readonly reasonCodes: readonly string[];
  readonly sourceFingerprint: string;
}

export interface PreparedManagementPatternProperty {
  readonly source: ManagementPatternSourceProperty;
  readonly profile: PropertyProfileSnapshot | null;
  readonly runExclusionCodes: readonly string[];
  readonly supply: PreparedSupplyInput;
  readonly activities: Readonly<Record<ActivityStreamId, PreparedActivityInput>>;
  readonly fingerprint: string;
}

export interface PreparedManagementPatternInputs {
  readonly snapshot: ManagementPatternSourceSnapshot;
  readonly properties: readonly PreparedManagementPatternProperty[];
  readonly includedProperties: readonly PreparedManagementPatternProperty[];
  readonly excludedProperties: readonly PreparedManagementPatternProperty[];
  readonly fingerprint: string;
}

function unique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values.filter(Boolean))].sort());
}

function currencySource(
  sourceKind: ManagementPatternSourceProperty['profile']['source_kind'],
): 'organization_override' | 'property_authoritative' | 'verified_import' {
  if (sourceKind === null) throw new TypeError('currency source is missing');
  return sourceKind;
}

function profileFromSource(
  snapshot: ManagementPatternSourceSnapshot,
  property: ManagementPatternSourceProperty,
): PropertyProfileSnapshot {
  const regionGroups = property.groups.filter((group) => group.kind === 'region');
  const topologyRelationship = {
    id: property.relationship.id,
    relationship_type: property.relationship.relationship_type,
    starts_at: property.relationship.starts_at,
    ends_at: property.relationship.ends_at,
    history_proof_kind: property.relationship.history_proof_kind,
    history_proof_at: property.relationship.history_proof_at,
    organization_active_count: property.relationship.organization_active_count,
    exclusive_governing_relationship: property.relationship.exclusive_governing_relationship,
  };
  const sourceRevision = stableFingerprint({
    // Access-to-facts may end after this topology snapshot. It belongs in the
    // source evidence receipt, not in the identity of the as-of hotel profile.
    relationship: topologyRelationship,
    propertySource: property.property_source,
    profile: property.profile,
    groups: property.groups,
  }, 'management-pattern-property-source');
  const cutoff = property.profile.business_date_cutoff_hour;
  const currencyCode = property.profile.currency_code;
  const currencyScale = property.profile.currency_minor_unit_exponent;
  return createPropertyProfileSnapshot({
    organizationId: snapshot.organization.id,
    propertyId: property.property_id,
    relationshipId: property.relationship.id,
    asOf: snapshot.topology_as_of,
    sourceRevision,
    totalRooms: property.profile.room_count,
    businessDateCutoffHour: cutoff,
    businessDateCutoffProvenance: cutoff === null ? null : {
      source: property.profile.source_kind ?? 'property_authoritative',
      sourceRevision,
    },
    serviceLevel: property.profile.service_level,
    brandClass: property.profile.brand_class,
    marketType: property.profile.market_type,
    regionId: regionGroups.length === 1 ? regionGroups[0].group_id : null,
    operatingModel: property.profile.operating_model,
    amenityTags: property.profile.amenity_tags,
    operatingCurrency: currencyCode === null || currencyScale === null ? null : {
      code: currencyCode,
      source: currencySource(property.profile.source_kind),
      sourceRevision,
      // Existing inventory monetary columns are physically encoded in
      // hundredths. The declared ISO minor-unit exponent is retained in the
      // source profile and separately gates the metric; it is not the storage
      // scale of these legacy columns.
      storageScale: 2,
    },
  });
}

function observationWindow(
  property: ManagementPatternSourceProperty,
  source: 'supply_inventory' | 'supply_occupancy' | 'activity',
  kind: ObservationWindowInput['kind'],
): ObservationWindowInput | null {
  const window = property.windows[source];
  if (
    window.start_date === null
    || window.end_date === null
    || window.timezone === null
    || window.start_utc === null
    || window.end_utc === null
  ) return null;
  return {
    kind,
    localStartDate: window.start_date,
    localEndDate: window.end_date,
    timeZone: window.timezone,
    utcStart: window.start_utc,
    utcEnd: window.end_utc,
  };
}

function supplyQualityReasons(property: ManagementPatternSourceProperty): readonly string[] {
  const reasons: string[] = [
    ...property.supply.exclusion_codes,
    ...property.rooms_sold.exclusion_codes,
  ];
  if (
    !property.supply.relationship_covers_inventory_window
    || !property.rooms_sold.relationship_covers_occupancy_window
  ) reasons.push('relationship_does_not_cover_supply_window');
  if (!property.supply.profile_covers_inventory_and_occupancy_windows) {
    reasons.push('profile_changed_within_window');
  }
  if (!property.rooms_sold.window_matches_inventory_numerator) {
    reasons.push('denominator_window_mismatch');
  }
  const expectedStarts = new Set<string>();
  const start = new Date(`${property.windows.supply_inventory.start_date}T00:00:00.000Z`);
  if (!Number.isNaN(start.getTime())) {
    for (let index = 0; index < property.supply.expected_periods; index += 1) {
      expectedStarts.add(new Date(Date.UTC(
        start.getUTCFullYear(),
        start.getUTCMonth() + index,
        1,
      )).toISOString().slice(0, 10));
    }
  }
  const actualStarts = new Set(property.supply.periods.map((period) => period.month_start));
  if (
    expectedStarts.size !== actualStarts.size
    || [...expectedStarts].some((date) => !actualStarts.has(date))
  ) reasons.push('inventory_close_periods_missing');
  for (const period of property.supply.periods) {
    if (period.status !== 'closed') reasons.push('inventory_close_open');
    if (period.is_partial) reasons.push('inventory_close_partial');
    if (period.closed_at === null || period.confirmed_purchase_storage_cents === null) {
      reasons.push('inventory_close_unconfirmed');
    }
    if (period.timezone !== property.profile.timezone) reasons.push('inventory_close_timezone_mismatch');
    if (
      period.uncosted_delivery_count > 0
      || period.quality_flags_oversize
      || (period.quality_flags?.length ?? 0) > 0
    ) {
      reasons.push('inventory_close_quality_blocked');
    }
    if (!period.source_window_compatible) reasons.push('inventory_close_window_incompatible');
  }
  if (property.profile.currency_code === null) reasons.push('currency_missing');
  // All current inventory monetary columns encode hundredths of a major unit.
  // A differently-scaled profile needs a future explicit conversion adapter.
  if (
    property.profile.currency_minor_unit_exponent !== null
    && property.profile.currency_minor_unit_exponent !== 2
  ) reasons.push('source_currency_scale_mismatch');
  if (property.rooms_sold.observed_days !== property.rooms_sold.expected_days) {
    reasons.push('occupancy_source_missing');
  }
  if (property.rooms_sold.partial_days > 0) reasons.push('occupancy_source_partial');
  if (property.rooms_sold.days.some((day) => (
    day.rooms_sold === null
    || day.rooms_sold < 0
    || (day.occupancy_source !== 'pms_report' && day.occupancy_source !== 'operator')
  ))) reasons.push('occupancy_source_missing');
  if (property.rooms_sold.room_nights_sold === null) reasons.push('denominator_missing');
  return unique(reasons);
}

function prepareSupply(
  snapshot: ManagementPatternSourceSnapshot,
  property: ManagementPatternSourceProperty,
  profile: PropertyProfileSnapshot | null,
): PreparedSupplyInput {
  const sourceFingerprint = stableFingerprint({
    supply: property.supply,
    roomsSold: property.rooms_sold,
    inventoryWindow: property.windows.supply_inventory,
    occupancyWindow: property.windows.supply_occupancy,
  }, 'management-pattern-supply-source');
  const reasons = [...supplyQualityReasons(property)];
  const numeratorWindow = observationWindow(property, 'supply_inventory', 'instant_range');
  const denominatorWindow = observationWindow(property, 'supply_occupancy', 'business_dates');
  if (profile === null) reasons.push('profile_invalid');
  if (numeratorWindow === null) reasons.push('numerator_window_invalid');
  if (denominatorWindow === null) reasons.push('denominator_window_invalid');
  const rawValue = property.supply.confirmed_purchase_storage_cents;
  if (rawValue === null) reasons.push('numerator_missing');
  const sourceCutoff = property.relationship.source_access.effective_source_cutoff;
  const numeratorFreshThrough = property.supply.fresh_through ?? sourceCutoff;
  if (property.supply.fresh_through === null) reasons.push('numerator_freshness_missing');

  if (profile === null || numeratorWindow === null || denominatorWindow === null) {
    return Object.freeze({
      observation: null,
      normalization: null,
      reasonCodes: unique(reasons),
      sourceFingerprint,
    });
  }

  const denominatorValue = property.rooms_sold.room_nights_sold;
  const denominatorFreshThrough = property.rooms_sold.fresh_through ?? sourceCutoff;
  const denominator = {
    kind: 'rooms_sold' as const,
    value: denominatorValue,
    unit: 'room_nights_sold',
    currency: null,
    window: denominatorWindow,
    source: {
      queryId: property.rooms_sold.query_id,
      queryVersion: property.rooms_sold.query_version,
      sourceRevision: stableFingerprint({
        sourceWatermark: property.rooms_sold.source_watermark,
        sourceFactsFingerprint:
          managementPatternMetricSourceRoleFingerprint(property, 'denominator'),
      }, 'rooms-sold-source'),
      extractedAt: sourceCutoff,
      parameters: {
        organization_id: snapshot.organization.id,
        property_id: property.property_id,
        start_date: snapshot.supply_window.start_date,
        end_date: snapshot.supply_window.end_date,
        accepted_sources: ['operator', 'pms_report'],
        requested_source_as_of: snapshot.source_as_of,
        effective_source_cutoff: sourceCutoff,
        effective_source_cutoff_is_exclusive:
          property.relationship.source_access.effective_source_cutoff_is_exclusive,
      },
      recordCount: property.rooms_sold.sealed_days,
    },
    quality: {
      freshThrough: denominatorFreshThrough,
      observedPoints: Math.min(property.rooms_sold.observed_days, property.rooms_sold.expected_days),
      expectedPoints: property.rooms_sold.expected_days,
      coverageBasis: 'sealed daily closing photos with report-stated rooms sold',
      qualityFlags: unique([
        ...property.rooms_sold.exclusion_codes,
        ...reasons.filter((reason) => (
          reason.startsWith('occupancy_')
          || reason === 'denominator_missing'
          || reason === 'denominator_window_mismatch'
        )),
      ]),
    },
  };

  const observation = createMetricObservation({
    profile,
    metricId: SUPPLY_SPEND_METRIC_ID,
    metricVersion: SUPPLY_SPEND_METRIC_VERSION,
    observedAt: snapshot.evaluation_at,
    rawValue,
    rawUnit: 'minor_currency_units',
    rawCurrency: profile.operatingCurrency?.code ?? null,
    window: numeratorWindow,
    source: {
      queryId: property.supply.query_id,
      queryVersion: property.supply.query_version,
      sourceRevision: stableFingerprint({
        sourceWatermark: property.supply.source_watermark,
        sourceFactsFingerprint:
          managementPatternMetricSourceRoleFingerprint(property, 'numerator'),
      }, 'inventory-close-source'),
      extractedAt: sourceCutoff,
      parameters: {
        organization_id: snapshot.organization.id,
        property_id: property.property_id,
        start_date: snapshot.supply_window.start_date,
        end_date: snapshot.supply_window.end_date,
        required_periods: property.supply.expected_periods,
        requested_source_as_of: snapshot.source_as_of,
        effective_source_cutoff: sourceCutoff,
        effective_source_cutoff_is_exclusive:
          property.relationship.source_access.effective_source_cutoff_is_exclusive,
      },
      recordCount: property.supply.observed_periods,
    },
    quality: {
      freshThrough: numeratorFreshThrough,
      observedPoints: Math.min(property.supply.usable_periods, property.supply.expected_periods),
      expectedPoints: property.supply.expected_periods,
      coverageBasis: 'closed non-partial monthly inventory periods',
      qualityFlags: unique([
        ...property.supply.exclusion_codes,
        ...reasons.filter((reason) => (
          reason.startsWith('inventory_')
          || reason.startsWith('profile_')
          || reason.startsWith('relationship_')
          || reason.startsWith('source_')
          || reason === 'numerator_missing'
        )),
      ]),
    },
    denominator,
  });
  const normalization = normalizeObservation(
    observation,
    SUPPLY_SPEND_METRIC_DEFINITION,
    snapshot.evaluation_at,
  );
  if (!normalization.ok) reasons.push(...normalization.reasons);
  return Object.freeze({
    observation,
    normalization,
    reasonCodes: unique(reasons),
    sourceFingerprint,
  });
}

function prepareActivity(
  snapshot: ManagementPatternSourceSnapshot,
  property: ManagementPatternSourceProperty,
  profile: PropertyProfileSnapshot | null,
  streamId: ActivityStreamId,
): PreparedActivityInput {
  const source = property.activity[streamId];
  const sourceCutoff = property.relationship.source_access.effective_source_cutoff;
  // The current source version is deliberately pinned to not_evaluated/false.
  // Keep the downstream gate generic so a future immutable-ledger source can
  // reuse the evaluator only after introducing its own explicit source type.
  const queryCoverageStatus = source.query_coverage_status as 'complete' | 'not_evaluated';
  const absenceDetectionEligible = source.absence_detection_eligible as boolean;
  const sourceRevisionAt = streamId === 'daily_log_closings'
    ? property.activity.daily_log_closings.source_watermark.max_sealed_at
    : streamId === 'inventory_counts'
      ? property.activity.inventory_counts.source_watermark.max_created_at
      : property.activity.work_order_flow.source_watermark.max_created_at;
  const sourceFingerprint = stableFingerprint({
    streamId,
    source,
    window: property.windows.activity,
  }, 'management-pattern-activity-source');
  const reasons: string[] = [
    ...property.activity.exclusion_codes,
    ...source.coverage_reason_codes,
  ];
  if (!property.activity.relationship_covers_window) {
    reasons.push('relationship_does_not_cover_activity_window');
  }
  if (queryCoverageStatus !== 'complete') reasons.push('activity_query_not_complete');
  if (!absenceDetectionEligible) reasons.push('absence_detection_not_eligible');
  const window = observationWindow(property, 'activity', 'business_dates');
  if (profile === null) reasons.push('profile_invalid');
  if (window === null) reasons.push('activity_window_invalid');
  if (profile === null || window === null) {
    return Object.freeze({
      streamId,
      eventDates: Object.freeze([...source.event_dates]),
      observation: null,
      reasonCodes: unique(reasons),
      sourceFingerprint,
    });
  }
  const windowFreshThrough = new Date(Date.parse(window.utcEnd) - 1).toISOString();
  const boundedFreshThrough = Date.parse(windowFreshThrough) <= Date.parse(sourceCutoff)
    ? windowFreshThrough
    : sourceCutoff;
  if (Date.parse(window.utcEnd) > Date.parse(sourceCutoff)) {
    reasons.push('activity_window_incomplete_as_of_source');
  }
  const completeCoverage = (
    queryCoverageStatus === 'complete'
    && absenceDetectionEligible
    && property.activity.relationship_covers_window
    && Date.parse(window.utcEnd) <= Date.parse(sourceCutoff)
  );
  const observation = createMetricObservation({
    profile,
    metricId: `activity_event_days:${streamId}`,
    metricVersion: 'first-party-ledger-dates.v1',
    observedAt: snapshot.evaluation_at,
    rawValue: source.event_dates.length,
    rawUnit: 'event_days',
    rawCurrency: null,
    window,
    source: {
      queryId: source.query_id,
      queryVersion: source.query_version,
      sourceRevision: sourceFingerprint,
      extractedAt: sourceCutoff,
      parameters: {
        organization_id: snapshot.organization.id,
        property_id: property.property_id,
        stream_id: streamId,
        start_date: snapshot.activity_window.start_date,
        end_date: snapshot.activity_window.end_date,
        requested_source_as_of: snapshot.source_as_of,
        effective_source_cutoff: sourceCutoff,
        effective_source_cutoff_is_exclusive:
          property.relationship.source_access.effective_source_cutoff_is_exclusive,
      },
      recordCount: source.source_event_count,
    },
    quality: {
      // Absence is bounded by both the requested window and the frozen read.
      // A partial final business date is retained but explicitly blocked above.
      freshThrough: boundedFreshThrough,
      observedPoints: completeCoverage ? snapshot.activity_window.history_days : 0,
      expectedPoints: snapshot.activity_window.history_days,
      coverageBasis: 'organization-scoped first-party ledger query through the as-of instant',
      qualityFlags: unique(reasons),
    },
    denominator: null,
    metadata: {
      streamId,
      eventDates: source.event_dates,
      sourceEventCount: source.source_event_count,
      sourceRevisionAt,
    },
  });
  return Object.freeze({
    streamId,
    eventDates: Object.freeze([...source.event_dates]),
    observation,
    reasonCodes: unique(reasons),
    sourceFingerprint,
  });
}

export function prepareManagementPatternInputs(
  snapshot: ManagementPatternSourceSnapshot,
): PreparedManagementPatternInputs {
  const properties = snapshot.properties.map((source) => {
    let profile: PropertyProfileSnapshot | null = null;
    const runExclusionCodes = [...source.run_exclusion_codes];
    try {
      profile = profileFromSource(snapshot, source);
    } catch {
      runExclusionCodes.push('profile_invalid');
    }
    const supply = prepareSupply(snapshot, source, profile);
    const activities = Object.freeze(Object.fromEntries(
      (Object.keys(ACTIVITY_STREAM_LABELS) as ActivityStreamId[]).map((streamId) => [
        streamId,
        prepareActivity(snapshot, source, profile, streamId),
      ]),
    ) as Record<ActivityStreamId, PreparedActivityInput>);
    const payload = {
      propertyId: source.property_id,
      sourceFingerprint: stableFingerprint(source, 'management-pattern-source-property'),
      profileFingerprint: profile?.fingerprint ?? null,
      runExclusionCodes: unique(runExclusionCodes),
      supplyFingerprint: supply.sourceFingerprint,
      activityFingerprints: Object.fromEntries(
        Object.entries(activities).map(([key, value]) => [key, value.sourceFingerprint]),
      ),
    };
    return Object.freeze({
      source,
      profile,
      runExclusionCodes: payload.runExclusionCodes,
      supply,
      activities,
      fingerprint: stableFingerprint(payload, 'prepared-management-pattern-property'),
    });
  }).sort((left, right) => left.source.property_id.localeCompare(right.source.property_id));

  const includedProperties = properties.filter((property) => property.runExclusionCodes.length === 0);
  const excludedProperties = properties.filter((property) => property.runExclusionCodes.length > 0);
  const payload = {
    sourceFingerprint: stableFingerprint(snapshot, 'management-pattern-source-snapshot'),
    properties: properties.map((property) => property.fingerprint),
  };
  return Object.freeze({
    snapshot,
    properties: Object.freeze(properties),
    includedProperties: Object.freeze(includedProperties),
    excludedProperties: Object.freeze(excludedProperties),
    fingerprint: stableFingerprint(payload, 'prepared-management-pattern-inputs'),
  });
}
