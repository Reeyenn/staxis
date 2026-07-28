import { canonicalize, stableFingerprint } from './canonical';
import type { ManagementPatternSourceProperty } from './source-snapshot';

export type ManagementPatternMetricSourceFactRole = 'numerator' | 'denominator';
export type ManagementPatternMetricSourceFactKind = 'supply_period' | 'rooms_sold_day';

export interface ManagementPatternMetricSourceFactDraft {
  readonly factRole: ManagementPatternMetricSourceFactRole;
  readonly factKind: ManagementPatternMetricSourceFactKind;
  /** Canonical local month/date; SQL uses this to prove exact calendar coverage. */
  readonly factKey: string;
  readonly sourceQueryId: string;
  readonly sourceQueryVersion: string;
  readonly sourceRecordedAt: string;
  readonly includedInAggregate: boolean;
  /** Null and zero are intentionally distinct source facts. */
  readonly numericValue: number | null;
  readonly factPayload: Readonly<Record<string, unknown>>;
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function canonicalObject(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return canonicalize(value) as Readonly<Record<string, unknown>>;
}

function roomsSoldCompletenessReceipt(value: unknown): Readonly<Record<string, unknown>> {
  const source = objectValue(value);
  const buckets = objectValue(source?.buckets);
  return canonicalObject({
    // Only these fields participate in the current denominator decision. The
    // full arbitrary source JSON is content-addressed rather than copied into
    // every daily fact, keeping the replay plane deterministically bounded.
    occupancy_complete: source?.occupancy_complete ?? null,
    occupancy_bucket: buckets?.occupancy ?? null,
    source_completeness_fingerprint: stableFingerprint(
      value ?? null,
      'rooms-sold-source-completeness',
    ),
  });
}

function supplyPeriodIncluded(
  period: ManagementPatternSourceProperty['supply']['periods'][number],
): boolean {
  return (
    period.status === 'closed'
    && !period.is_partial
    && period.source_window_compatible
    && !period.quality_flags_oversize
    && period.confirmed_purchase_storage_cents !== null
    && period.closed_at !== null
  );
}

/**
 * Exact, decision-complete source facts for replaying the persisted aggregate.
 * Rows are deliberately bounded: arbitrary daily completeness JSON is hashed,
 * while every field that controls inclusion or value remains explicit.
 */
export function managementPatternMetricSourceFactDrafts(
  property: ManagementPatternSourceProperty,
): readonly ManagementPatternMetricSourceFactDraft[] {
  const numerator = property.supply.periods.map((period) => {
    const includedInAggregate = supplyPeriodIncluded(period);
    const numericValue = period.confirmed_purchase_storage_cents;
    const sourceRecordedAt = period.updated_at;
    const factPayload = canonicalObject({
      ...period,
      source_query_id: property.supply.query_id,
      source_query_version: property.supply.query_version,
      source_recorded_at: sourceRecordedAt,
      included_in_aggregate: includedInAggregate,
      numeric_value: numericValue,
    });
    return Object.freeze({
      factRole: 'numerator' as const,
      factKind: 'supply_period' as const,
      factKey: period.month_start,
      sourceQueryId: property.supply.query_id,
      sourceQueryVersion: property.supply.query_version,
      sourceRecordedAt,
      includedInAggregate,
      numericValue,
      factPayload,
    });
  });
  const denominator = property.rooms_sold.days.map((day) => {
    const includedInAggregate = day.denominator_complete;
    const numericValue = day.rooms_sold;
    const sourceRecordedAt = day.updated_at;
    const factPayload = canonicalObject({
      date: day.date,
      rooms_sold: day.rooms_sold,
      occupancy_source: day.occupancy_source,
      sealed_at: day.sealed_at,
      seal_version: day.seal_version,
      source_completeness_receipt: roomsSoldCompletenessReceipt(day.source_completeness),
      source_completeness_oversize: day.source_completeness_oversize,
      denominator_complete: day.denominator_complete,
      created_at: day.created_at,
      updated_at: day.updated_at,
      source_query_id: property.rooms_sold.query_id,
      source_query_version: property.rooms_sold.query_version,
      source_recorded_at: sourceRecordedAt,
      included_in_aggregate: includedInAggregate,
      numeric_value: numericValue,
    });
    return Object.freeze({
      factRole: 'denominator' as const,
      factKind: 'rooms_sold_day' as const,
      factKey: day.date,
      sourceQueryId: property.rooms_sold.query_id,
      sourceQueryVersion: property.rooms_sold.query_version,
      sourceRecordedAt,
      includedInAggregate,
      numericValue,
      factPayload,
    });
  });
  return Object.freeze([...numerator, ...denominator].sort((left, right) => (
    left.factRole.localeCompare(right.factRole)
    || left.factKey.localeCompare(right.factKey)
  )));
}

export function managementPatternMetricSourceRoleFingerprint(
  property: ManagementPatternSourceProperty,
  role: ManagementPatternMetricSourceFactRole,
): string {
  const facts = managementPatternMetricSourceFactDrafts(property)
    .filter((fact) => fact.factRole === role)
    .map((fact) => Object.freeze({
      factKind: fact.factKind,
      factKey: fact.factKey,
      sourceQueryId: fact.sourceQueryId,
      sourceQueryVersion: fact.sourceQueryVersion,
      sourceRecordedAt: fact.sourceRecordedAt,
      includedInAggregate: fact.includedInAggregate,
      numericValue: fact.numericValue,
      factPayload: fact.factPayload,
    }));
  return stableFingerprint(facts, `management-pattern-${role}-source-facts`);
}
