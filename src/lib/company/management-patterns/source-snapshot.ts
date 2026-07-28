import 'server-only';

import { z } from 'zod';

import { supabaseAdmin } from '@/lib/supabase-admin';

import {
  ACTIVITY_HISTORY_DAYS,
  MANAGEMENT_PATTERN_MAX_PROPERTIES,
  MANAGEMENT_PATTERN_SOURCE_QUERY_VERSION,
  SUPPLY_SPEND_HISTORY_MONTHS,
  SUPPLY_SPEND_WINDOW_SAFETY_LAG_HOURS,
} from './definitions';

const isoInstant = z.string().datetime({ offset: true });
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const uuid = z.string().uuid();
// PostgreSQL bigint/numeric values cross a JSON/JavaScript boundary here.
// Reject anything JS cannot represent exactly instead of rounding evidence.
const safeInteger = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const nonNegativeSafeInteger = safeInteger.nonnegative();
const nonNegativeInteger = nonNegativeSafeInteger;
const nonEmptyReasonCodes = z.array(z.string().min(1));

const sourceAccessShape = {
  effective_source_cutoff: isoInstant,
  effective_source_cutoff_is_exclusive: z.boolean(),
  effective_source_cutoff_reason: z.enum([
    'requested_source_as_of',
    'relationship_interval_end',
    'audited_membership_loss',
  ]),
  effective_source_cutoff_proof_kind: z.enum([
    'request',
    'relationship_state',
    'organization_access_event',
  ]),
  effective_source_cutoff_proof_at: isoInstant,
} as const;

const sourceAccessSchema = z.object(sourceAccessShape).strict();
const sourceWatermarkAccessShape = {
  source_as_of: isoInstant,
  requested_source_as_of: isoInstant,
  ...sourceAccessShape,
} as const;

type SourceAccessReceipt = z.infer<typeof sourceAccessSchema>;

function sameSourceAccess(
  left: SourceAccessReceipt,
  right: SourceAccessReceipt,
): boolean {
  return (
    left.effective_source_cutoff === right.effective_source_cutoff
    && left.effective_source_cutoff_is_exclusive
      === right.effective_source_cutoff_is_exclusive
    && left.effective_source_cutoff_reason === right.effective_source_cutoff_reason
    && left.effective_source_cutoff_proof_kind
      === right.effective_source_cutoff_proof_kind
    && left.effective_source_cutoff_proof_at
      === right.effective_source_cutoff_proof_at
  );
}

function timestampWithinSourceAccess(
  value: string | null,
  receipt: SourceAccessReceipt,
): boolean {
  if (value === null) return true;
  const instant = Date.parse(value);
  const cutoff = Date.parse(receipt.effective_source_cutoff);
  return receipt.effective_source_cutoff_is_exclusive
    ? instant < cutoff
    : instant <= cutoff;
}

const groupSchema = z.object({
  group_id: uuid,
  name: z.string().min(1).max(120),
  kind: z.enum(['region', 'portfolio', 'operating_group']),
  portfolio_type: z.string().min(1),
  parent_id: uuid.nullable(),
  group_created_at: isoInstant,
  group_updated_at: isoInstant,
  group_history_proof_kind: z.enum([
    'event_at_or_before',
    'event_after_before_state',
    'unchanged_current_row',
  ]),
  group_history_proof_at: isoInstant,
  assignment_id: uuid,
  assigned_at: isoInstant,
  removed_at: isoInstant.nullable(),
  assignment_created_at: isoInstant,
  assignment_updated_at: isoInstant,
  assignment_history_proof_kind: z.enum([
    'event_at_or_before',
    'event_after_before_state',
    'unchanged_current_row',
  ]),
  assignment_history_proof_at: isoInstant,
}).strict();

const supplyPeriodSchema = z.object({
  id: uuid,
  month_start: localDate,
  timezone: z.string().min(1),
  status: z.enum(['open', 'closed']),
  month_start_at: isoInstant,
  end_at: isoInstant,
  is_partial: z.boolean(),
  purchase_source: z.enum(['logged_deliveries', 'manual_total', 'zero']).nullable(),
  allocation_mode: z.enum(['itemized', 'total_only']).nullable(),
  confirmed_purchase_storage_cents: nonNegativeSafeInteger.nullable(),
  logged_purchase_storage_cents: nonNegativeSafeInteger.nullable(),
  manual_purchase_storage_cents: nonNegativeSafeInteger.nullable(),
  logged_delivery_count: nonNegativeInteger,
  uncosted_delivery_count: nonNegativeInteger,
  // An oversized source payload is intentionally replaced by null and flagged;
  // the source function never truncates evidence silently.
  quality_flags: z.array(z.unknown()).nullable(),
  quality_flags_oversize: z.boolean(),
  source_window_compatible: z.boolean(),
  closed_at: isoInstant.nullable(),
  created_at: isoInstant,
  updated_at: isoInstant,
}).strict();

const roomSoldDaySchema = z.object({
  date: localDate,
  // Domain-time end of this property business date. This is deliberately
  // distinct from sealed_at/updated_at: a late-arriving or corrected row may
  // be learned later without making its historical occupancy period fresh in
  // the future.
  coverage_through: isoInstant,
  rooms_sold: nonNegativeSafeInteger.nullable(),
  occupancy_source: z.enum(['pms_report', 'operator', 'derived']).nullable(),
  sealed_at: isoInstant,
  seal_version: z.number().int().positive(),
  source_completeness: z.record(z.string(), z.unknown()).nullable(),
  denominator_complete: z.boolean(),
  source_completeness_oversize: z.boolean(),
  created_at: isoInstant,
  updated_at: isoInstant,
}).strict();

type SupplyPeriod = z.infer<typeof supplyPeriodSchema>;
type RoomSoldDay = z.infer<typeof roomSoldDaySchema>;

function supplyPeriodIncluded(period: SupplyPeriod): boolean {
  return (
    period.status === 'closed'
    && !period.is_partial
    && period.source_window_compatible
    && !period.quality_flags_oversize
    && period.confirmed_purchase_storage_cents !== null
    && period.closed_at !== null
  );
}

function roomSoldDayComplete(day: RoomSoldDay): boolean {
  const completeness = objectValue(day.source_completeness);
  const buckets = objectValue(completeness?.buckets);
  return (
    day.rooms_sold !== null
    && day.occupancy_source !== null
    && ['pms_report', 'operator'].includes(day.occupancy_source)
    && !day.source_completeness_oversize
    && (
      completeness?.occupancy_complete === true
      || ['pms_report', 'operator', 'complete'].includes(String(buckets?.occupancy ?? ''))
    )
  );
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function uniqueSorted(values: readonly string[]): boolean {
  return values.every((value, index) => (
    (index === 0 || values[index - 1] < value)
  ));
}

function exactNonNegativeAggregate(
  values: readonly number[],
  aggregate: number | null,
): boolean {
  if (values.length === 0) return aggregate === null;
  let total = 0;
  for (const value of values) {
    if (total > Number.MAX_SAFE_INTEGER - value) return false;
    total += value;
  }
  return aggregate === total;
}

function maximumInstant(values: readonly (string | null)[]): string | null {
  const present = values.filter((value): value is string => value !== null);
  if (present.length === 0) return null;
  return present.reduce((latest, value) => (
    Date.parse(value) > Date.parse(latest) ? value : latest
  ));
}

function sameNullableInstant(
  left: string | null,
  right: string | null,
): boolean {
  return left === null || right === null
    ? left === right
    : Date.parse(left) === Date.parse(right);
}

const activityStreamBaseShape = {
  query_id: z.string().min(1).max(160),
  query_version: z.literal(MANAGEMENT_PATTERN_SOURCE_QUERY_VERSION),
  query_executed: z.literal(true),
  // V2 has no immutable, deletion-resistant activity ledger. Keep this a
  // literal source contract so a same-version SQL drift cannot silently turn
  // on absence detection. Enabling it requires a new source query version.
  query_coverage_status: z.literal('not_evaluated'),
  coverage_reason_codes: nonEmptyReasonCodes,
  absence_detection_eligible: z.literal(false),
  event_dates: z.array(localDate),
  source_event_count: nonNegativeInteger,
};

function validateActivityStream(
  stream: {
    query_coverage_status: 'complete' | 'not_evaluated';
    absence_detection_eligible: boolean;
    event_dates: string[];
    source_event_count: number;
  },
  ctx: z.RefinementCtx,
): void {
  const canonicalDates = [...new Set(stream.event_dates)].sort();
  if (
    canonicalDates.length !== stream.event_dates.length
    || canonicalDates.some((date, index) => date !== stream.event_dates[index])
  ) ctx.addIssue({ code: 'custom', message: 'activity event dates must be unique and sorted' });
  if (stream.source_event_count < stream.event_dates.length) {
    ctx.addIssue({ code: 'custom', message: 'event-date count exceeds source row count' });
  }
  if (
    stream.query_coverage_status !== 'complete'
    && stream.absence_detection_eligible
  ) ctx.addIssue({ code: 'custom', message: 'uncovered query cannot prove absence' });
}

const inventoryActivitySchema = z.object({
  ...activityStreamBaseShape,
  source_watermark: z.object({
    max_created_at: isoInstant.nullable(),
    row_count: nonNegativeInteger,
    ...sourceWatermarkAccessShape,
  }).strict(),
}).strict().superRefine(validateActivityStream);

const dailyLogActivitySchema = z.object({
  ...activityStreamBaseShape,
  recording_flow_support: z.literal('historical_mutability_unavailable'),
  source_watermark: z.object({
    max_sealed_at: isoInstant.nullable(),
    sealed_day_count: nonNegativeInteger,
    ...sourceWatermarkAccessShape,
  }).strict(),
}).strict().superRefine(validateActivityStream);

const workOrderActivitySchema = z.object({
  ...activityStreamBaseShape,
  recording_flow_support: z.literal('historical_mutability_unavailable'),
  source_watermark: z.object({
    max_created_at: isoInstant.nullable(),
    row_count: nonNegativeInteger,
    ...sourceWatermarkAccessShape,
  }).strict(),
}).strict().superRefine((stream, ctx) => {
  validateActivityStream(stream, ctx);
});

const propertyWindowSchema = z.object({
  start_date: localDate.nullable(),
  end_date: localDate.nullable(),
  timezone: z.string().nullable(),
  business_date_cutoff_hour: z.number().int().min(0).max(23).nullable(),
  start_utc: isoInstant.nullable(),
  end_utc: isoInstant.nullable(),
}).strict();

const supplyInventoryWindowSchema = propertyWindowSchema.extend({
  start_date: localDate,
  end_date: localDate,
  date_basis: z.literal('property_local_calendar_month'),
  business_date_cutoff_hour: z.literal(0),
}).strict();

const supplyOccupancyWindowSchema = propertyWindowSchema.extend({
  start_date: localDate,
  end_date: localDate,
  date_basis: z.literal('property_business_date'),
}).strict();

const sourcePropertySchema = z.object({
  property_id: uuid,
  property_name: z.string().min(1).max(200),
  relationship: z.object({
    id: uuid,
    relationship_type: z.enum(['operator', 'owner']),
    starts_at: isoInstant,
    ends_at: isoInstant.nullable(),
    history_proof_kind: z.enum([
      'event_at_or_before',
      'event_after_before_state',
      'unchanged_current_row',
    ]),
    history_proof_at: isoInstant,
    organization_active_count: nonNegativeInteger,
    exclusive_governing_relationship: z.boolean(),
    source_access: sourceAccessSchema,
  }).strict(),
  property_source: z.object({
    updated_at: isoInstant,
    total_rooms: z.number().int().positive().nullable(),
    timezone: z.string().nullable(),
    business_date_cutoff_hour: z.number().int().min(0).max(23).nullable(),
    property_kind: z.string().min(1).nullable(),
    brand: z.string().nullable(),
    region: z.string().nullable(),
  }).strict(),
  profile: z.object({
    id: uuid.nullable(),
    profile_version: z.number().int().positive().nullable(),
    effective_from: isoInstant.nullable(),
    effective_to: isoInstant.nullable(),
    source_kind: z.enum([
      'organization_override',
      'property_authoritative',
      'verified_import',
    ]).nullable(),
    source_reference: z.string().nullable(),
    created_at: isoInstant.nullable(),
    room_count: z.number().int().positive().nullable(),
    timezone: z.string().nullable(),
    business_date_cutoff_hour: z.number().int().min(0).max(23).nullable(),
    service_level: z.string().nullable(),
    market_type: z.string().nullable(),
    brand_class: z.string().nullable(),
    location_type: z.string().nullable(),
    operating_model: z.string().nullable(),
    // Null means the attribute has not been verified. An empty array means the
    // source positively verified that the property has none of these amenities.
    amenity_tags: z.array(z.string()).nullable(),
    currency_code: z.string().regex(/^[A-Z]{3}$/).nullable(),
    currency_minor_unit_exponent: z.number().int().min(0).max(4).nullable(),
    comparison_attributes: z.record(z.string(), z.unknown()).nullable(),
  }).strict().superRefine((profile, ctx) => {
    if ((profile.currency_code === null) !== (profile.currency_minor_unit_exponent === null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'currency code and exponent must both be present or absent',
      });
    }
  }),
  groups: z.array(groupSchema),
  group_scope_historically_reconstructable: z.boolean(),
  group_scope_exclusion_codes: nonEmptyReasonCodes,
  windows: z.object({
    supply_inventory: supplyInventoryWindowSchema,
    supply_occupancy: supplyOccupancyWindowSchema,
    activity: propertyWindowSchema,
  }).strict(),
  run_exclusion_codes: nonEmptyReasonCodes,
  supply: z.object({
    query_id: z.literal('management_pattern_inventory_month_closes'),
    query_version: z.literal(MANAGEMENT_PATTERN_SOURCE_QUERY_VERSION),
    query_executed: z.literal(true),
    exclusion_codes: nonEmptyReasonCodes,
    relationship_covers_inventory_window: z.boolean(),
    profile_covers_inventory_and_occupancy_windows: z.boolean(),
    expected_periods: z.number().int().positive(),
    observed_periods: nonNegativeInteger,
    usable_periods: nonNegativeInteger,
    incompatible_periods: nonNegativeInteger,
    oversized_quality_periods: nonNegativeInteger,
    confirmed_purchase_storage_cents: nonNegativeSafeInteger.nullable(),
    fresh_through: isoInstant.nullable(),
    source_watermark: z.object({
      max_closed_at: isoInstant.nullable(),
      ...sourceWatermarkAccessShape,
    }).strict(),
    periods: z.array(supplyPeriodSchema),
  }).strict(),
  rooms_sold: z.object({
    query_id: z.literal('management_pattern_daily_log_occupancy'),
    query_version: z.literal(MANAGEMENT_PATTERN_SOURCE_QUERY_VERSION),
    query_executed: z.literal(true),
    exclusion_codes: nonEmptyReasonCodes,
    relationship_covers_occupancy_window: z.boolean(),
    expected_days: z.number().int().positive(),
    sealed_days: nonNegativeInteger,
    observed_days: nonNegativeInteger,
    partial_days: nonNegativeInteger,
    room_nights_sold: nonNegativeSafeInteger.nullable(),
    fresh_through: isoInstant.nullable(),
    source_watermark: z.object({
      // These are lifecycle/knowledge-time watermarks. Business-period
      // freshness is reproduced separately from each day's coverage_through.
      max_sealed_at: isoInstant.nullable(),
      max_updated_at: isoInstant.nullable(),
      ...sourceWatermarkAccessShape,
    }).strict(),
    window_matches_inventory_numerator: z.boolean(),
    normalization_alignment_basis: z.literal('same_local_dates'),
    normalization_eligible: z.boolean(),
    days: z.array(roomSoldDaySchema),
  }).strict(),
  activity: z.object({
    relationship_covers_window: z.boolean(),
    exclusion_codes: nonEmptyReasonCodes,
    inventory_counts: inventoryActivitySchema,
    daily_log_closings: dailyLogActivitySchema,
    work_order_flow: workOrderActivitySchema,
  }).strict(),
}).strict().superRefine((property, ctx) => {
  const sourceAccess = property.relationship.source_access;
  const sourceWatermarks = [
    property.supply.source_watermark,
    property.rooms_sold.source_watermark,
    property.activity.inventory_counts.source_watermark,
    property.activity.daily_log_closings.source_watermark,
    property.activity.work_order_flow.source_watermark,
  ];
  const proofKindMatchesReason = (
    (
      sourceAccess.effective_source_cutoff_reason === 'requested_source_as_of'
      && sourceAccess.effective_source_cutoff_proof_kind === 'request'
    )
    || (
      sourceAccess.effective_source_cutoff_reason === 'relationship_interval_end'
      && sourceAccess.effective_source_cutoff_proof_kind === 'relationship_state'
    )
    || (
      sourceAccess.effective_source_cutoff_reason === 'audited_membership_loss'
      && ['relationship_state', 'organization_access_event'].includes(
        sourceAccess.effective_source_cutoff_proof_kind,
      )
    )
  );
  if (
    !proofKindMatchesReason
    || sourceAccess.effective_source_cutoff_is_exclusive
      !== (sourceAccess.effective_source_cutoff_reason !== 'requested_source_as_of')
    || (
      sourceAccess.effective_source_cutoff_reason === 'relationship_interval_end'
      && sourceAccess.effective_source_cutoff !== property.relationship.ends_at
    )
  ) ctx.addIssue({ code: 'custom', message: 'relationship source-access receipt is inconsistent' });
  if (sourceWatermarks.some((watermark) => (
    watermark.source_as_of !== sourceAccess.effective_source_cutoff
    || !sameSourceAccess(watermark, sourceAccess)
  ))) ctx.addIssue({ code: 'custom', message: 'stream source-access receipts disagree' });
  const sourceAccessLimited = (
    sourceAccess.effective_source_cutoff_reason !== 'requested_source_as_of'
  );
  if (sourceAccessLimited && (
    !property.supply.exclusion_codes.includes('relationship_source_access_limited')
    || !property.rooms_sold.exclusion_codes.includes('relationship_source_access_limited')
    || !property.activity.exclusion_codes.includes('relationship_source_access_limited')
  )) ctx.addIssue({ code: 'custom', message: 'limited relationship source access is not excluded' });
  if (
    property.activity.inventory_counts.source_watermark.row_count
      !== property.activity.inventory_counts.source_event_count
    || property.activity.daily_log_closings.source_watermark.sealed_day_count
      !== property.activity.daily_log_closings.source_event_count
    || property.activity.work_order_flow.source_watermark.row_count
      !== property.activity.work_order_flow.source_event_count
    || !timestampWithinSourceAccess(
      property.activity.inventory_counts.source_watermark.max_created_at,
      sourceAccess,
    )
    || !timestampWithinSourceAccess(
      property.activity.daily_log_closings.source_watermark.max_sealed_at,
      sourceAccess,
    )
    || !timestampWithinSourceAccess(
      property.activity.work_order_flow.source_watermark.max_created_at,
      sourceAccess,
    )
  ) ctx.addIssue({ code: 'custom', message: 'activity source watermark is inconsistent' });

  if (
    property.group_scope_historically_reconstructable
    !== (property.group_scope_exclusion_codes.length === 0)
  ) ctx.addIssue({ code: 'custom', message: 'group historical receipt is inconsistent' });
  if (property.supply.expected_periods !== SUPPLY_SPEND_HISTORY_MONTHS) {
    ctx.addIssue({ code: 'custom', message: 'supply expected-period policy drifted' });
  }
  const periodKeys = property.supply.periods.map((period) => period.month_start);
  const includedPeriods = property.supply.periods.filter(supplyPeriodIncluded);
  const includedPeriodValues = includedPeriods.map((period) => (
    period.confirmed_purchase_storage_cents as number
  ));
  const supplyFreshThrough = maximumInstant(includedPeriods.map((period) => (
    new Date(Date.parse(period.end_at) - 1).toISOString()
  )));
  const supplyMaxClosedAt = maximumInstant(
    property.supply.periods.map((period) => period.closed_at),
  );
  if (
    !uniqueSorted(periodKeys)
    || property.supply.observed_periods !== property.supply.periods.length
    || property.supply.usable_periods !== includedPeriods.length
    || property.supply.incompatible_periods !== property.supply.periods.filter((period) => (
      !period.source_window_compatible
    )).length
    || property.supply.oversized_quality_periods !== property.supply.periods.filter((period) => (
      period.quality_flags_oversize
    )).length
    || !exactNonNegativeAggregate(
      includedPeriodValues,
      property.supply.confirmed_purchase_storage_cents,
    )
    || !sameNullableInstant(property.supply.fresh_through, supplyFreshThrough)
    || !sameNullableInstant(
      property.supply.source_watermark.max_closed_at,
      supplyMaxClosedAt,
    )
    || property.supply.periods.some((period) => (
      !timestampWithinSourceAccess(period.created_at, sourceAccess)
      || !timestampWithinSourceAccess(period.updated_at, sourceAccess)
      || !timestampWithinSourceAccess(period.closed_at, sourceAccess)
      || (period.quality_flags_oversize && period.quality_flags !== null)
    ))
  ) ctx.addIssue({ code: 'custom', message: 'supply source summary is not reproducible from periods' });

  const dayKeys = property.rooms_sold.days.map((day) => day.date);
  const completeDays = property.rooms_sold.days.filter(roomSoldDayComplete);
  const partialDays = property.rooms_sold.days.filter((day) => (
    day.rooms_sold !== null
    && day.occupancy_source !== null
    && ['pms_report', 'operator'].includes(day.occupancy_source)
    && !roomSoldDayComplete(day)
  ));
  const roomsFreshThrough = maximumInstant(
    completeDays.map((day) => day.coverage_through),
  );
  const roomsMaxSealedAt = maximumInstant(
    property.rooms_sold.days.map((day) => day.sealed_at),
  );
  const roomsMaxUpdatedAt = maximumInstant(
    property.rooms_sold.days.map((day) => day.updated_at),
  );
  if (
    !uniqueSorted(dayKeys)
    || property.rooms_sold.days.some((day) => (
      day.denominator_complete !== roomSoldDayComplete(day)
      || !timestampWithinSourceAccess(day.created_at, sourceAccess)
      || !timestampWithinSourceAccess(day.updated_at, sourceAccess)
      || !timestampWithinSourceAccess(day.sealed_at, sourceAccess)
      || (day.source_completeness_oversize && day.source_completeness !== null)
    ))
    || property.rooms_sold.sealed_days !== property.rooms_sold.days.length
    || property.rooms_sold.observed_days !== completeDays.length
    || property.rooms_sold.partial_days !== partialDays.length
    || !exactNonNegativeAggregate(
      completeDays.map((day) => day.rooms_sold as number),
      property.rooms_sold.room_nights_sold,
    )
    || !sameNullableInstant(property.rooms_sold.fresh_through, roomsFreshThrough)
    || !sameNullableInstant(
      property.rooms_sold.source_watermark.max_sealed_at,
      roomsMaxSealedAt,
    )
    || property.rooms_sold.source_watermark.max_updated_at !== roomsMaxUpdatedAt
  ) ctx.addIssue({ code: 'custom', message: 'rooms-sold source summary is not reproducible from days' });

  if (
    property.rooms_sold.normalization_eligible
    && (
      !property.rooms_sold.window_matches_inventory_numerator
      || property.supply.usable_periods !== property.supply.expected_periods
      || property.rooms_sold.observed_days !== property.rooms_sold.expected_days
      || property.rooms_sold.partial_days !== 0
    )
  ) ctx.addIssue({ code: 'custom', message: 'normalization eligibility is inconsistent' });
});

export const managementPatternSourceSnapshotSchema = z.object({
  schema_version: z.literal(MANAGEMENT_PATTERN_SOURCE_QUERY_VERSION),
  query_id: z.literal('management_pattern_source_snapshot'),
  query_version: z.literal(MANAGEMENT_PATTERN_SOURCE_QUERY_VERSION),
  organization: z.object({
    id: uuid,
    organization_type: z.enum(['management_company', 'ownership_group']),
    status: z.literal('active'),
  }).strict(),
  evaluation_at: isoInstant,
  source_as_of: isoInstant,
  topology_as_of: isoInstant,
  // The historical decision boundary that selects the immutable analysis
  // window. For scheduled v2 reads it equals topology_as_of. A later
  // backfill may advance source_as_of/evaluation_at without moving this
  // anchor or silently changing the months under comparison.
  analysis_window_anchor: isoInstant,
  supply_window: z.object({ start_date: localDate, end_date: localDate }).strict(),
  activity_window: z.object({
    start_date: localDate.nullable(),
    end_date: localDate.nullable(),
    history_days: z.number().int().positive(),
  }).strict(),
  property_count: nonNegativeInteger,
  max_properties: z.number().int().positive(),
  source_budget_exceeded: z.boolean(),
  properties: z.array(sourcePropertySchema),
}).strict().superRefine((snapshot, ctx) => {
  if (
    Date.parse(snapshot.topology_as_of) > Date.parse(snapshot.source_as_of)
    || Date.parse(snapshot.source_as_of) > Date.parse(snapshot.evaluation_at)
  ) {
    ctx.addIssue({ code: 'custom', message: 'as-of instants are not ordered' });
  }
  if (snapshot.analysis_window_anchor !== snapshot.topology_as_of) {
    ctx.addIssue({
      code: 'custom',
      path: ['analysis_window_anchor'],
      message: 'v2 analysis anchor must equal the immutable topology boundary',
    });
  }
  if (
    (!snapshot.source_budget_exceeded && snapshot.properties.length !== snapshot.property_count)
    || (snapshot.source_budget_exceeded && snapshot.properties.length !== 0)
  ) {
    ctx.addIssue({ code: 'custom', message: 'property_count does not match properties' });
  }
  const ids = snapshot.properties.map((property) => property.property_id);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: 'custom', message: 'source snapshot contains duplicate properties' });
  }
  if (snapshot.source_budget_exceeded !== (snapshot.property_count > snapshot.max_properties)) {
    ctx.addIssue({ code: 'custom', message: 'source budget flag is inconsistent' });
  }
  for (const [index, property] of snapshot.properties.entries()) {
    const at = (field: string) => ['properties', index, field] as (string | number)[];
    if (
      property.windows.supply_inventory.start_date !== snapshot.supply_window.start_date
      || property.windows.supply_inventory.end_date !== snapshot.supply_window.end_date
      || property.windows.supply_occupancy.start_date !== snapshot.supply_window.start_date
      || property.windows.supply_occupancy.end_date !== snapshot.supply_window.end_date
    ) ctx.addIssue({ code: 'custom', path: at('windows'), message: 'property supply windows drifted' });
    if (
      property.windows.activity.start_date !== snapshot.activity_window.start_date
      || property.windows.activity.end_date !== snapshot.activity_window.end_date
    ) ctx.addIssue({ code: 'custom', path: at('windows'), message: 'property activity window drifted' });
    const sourceAccess = property.relationship.source_access;
    const sourceWatermarks = [
      property.supply.source_watermark,
      property.rooms_sold.source_watermark,
      property.activity.inventory_counts.source_watermark,
      property.activity.daily_log_closings.source_watermark,
      property.activity.work_order_flow.source_watermark,
    ];
    if (
      Date.parse(sourceAccess.effective_source_cutoff) > Date.parse(snapshot.source_as_of)
      || sourceWatermarks.some((watermark) => (
        watermark.requested_source_as_of !== snapshot.source_as_of
        || watermark.source_as_of !== sourceAccess.effective_source_cutoff
        || !sameSourceAccess(watermark, sourceAccess)
      ))
      || (
        sourceAccess.effective_source_cutoff_reason === 'requested_source_as_of'
        && sourceAccess.effective_source_cutoff !== snapshot.source_as_of
      )
    ) ctx.addIssue({ code: 'custom', path: at('source_watermark'), message: 'source watermark drifted' });
    if (
      property.relationship.organization_active_count !== 1
      || !property.relationship.exclusive_governing_relationship
    ) {
      if (!property.run_exclusion_codes.includes('topology_ambiguous')) {
        ctx.addIssue({ code: 'custom', path: at('run_exclusion_codes'), message: 'ambiguous topology is not excluded' });
      }
    }
    const topologyAt = Date.parse(snapshot.topology_as_of);
    const groupProofDirectionIsValid = (
      proofKind: 'event_at_or_before' | 'event_after_before_state' | 'unchanged_current_row',
      proofAt: string,
    ): boolean => (
      proofKind === 'event_after_before_state'
        ? Date.parse(proofAt) > topologyAt
        : Date.parse(proofAt) <= topologyAt
    );
    const groupAssignmentIds = property.groups.map((group) => group.assignment_id);
    const groupIds = property.groups.map((group) => group.group_id);
    if (
      (!property.group_scope_historically_reconstructable && property.groups.length !== 0)
      || new Set(groupAssignmentIds).size !== groupAssignmentIds.length
      || new Set(groupIds).size !== groupIds.length
      || property.groups.some((group) => (
        Date.parse(group.group_created_at) > topologyAt
        || Date.parse(group.group_updated_at) > topologyAt
        || Date.parse(group.assignment_created_at) > topologyAt
        || Date.parse(group.assignment_updated_at) > topologyAt
        || Date.parse(group.assigned_at) > topologyAt
        || (
          group.removed_at !== null
          && Date.parse(group.removed_at) <= topologyAt
        )
        || !groupProofDirectionIsValid(
          group.group_history_proof_kind,
          group.group_history_proof_at,
        )
        || !groupProofDirectionIsValid(
          group.assignment_history_proof_kind,
          group.assignment_history_proof_at,
        )
        || (
          group.group_history_proof_kind === 'unchanged_current_row'
          && Date.parse(group.group_history_proof_at)
            !== Date.parse(group.group_updated_at)
        )
        || (
          group.assignment_history_proof_kind === 'unchanged_current_row'
          && Date.parse(group.assignment_history_proof_at)
            !== Date.parse(group.assignment_updated_at)
        )
        || Date.parse(group.group_history_proof_at)
          < Date.parse(group.group_updated_at)
        || Date.parse(group.assignment_history_proof_at)
          < Date.parse(group.assignment_updated_at)
        || (
          group.portfolio_type === 'region'
            ? group.kind !== 'region'
            : ['portfolio', 'division'].includes(group.portfolio_type)
              ? group.kind !== 'portfolio'
              : group.kind !== 'operating_group'
        )
      ))
    ) ctx.addIssue({
      code: 'custom',
      path: at('groups'),
      message: 'group topology receipt is inconsistent',
    });
  }
});

export type ManagementPatternSourceSnapshot = z.infer<typeof managementPatternSourceSnapshotSchema>;
export type ManagementPatternSourceProperty = ManagementPatternSourceSnapshot['properties'][number];

export interface CompletedSupplyWindow {
  /** Inclusive local calendar dates shared by every property's receipt. */
  startDate: string;
  endDate: string;
}

/**
 * Three completed calendar months, with a 48-hour safety lag so a run near a
 * month boundary cannot include a month still open at a far-west hotel or one
 * with a late business-date cutoff.
 */
export function completedSupplyWindow(evaluationAt: Date): CompletedSupplyWindow {
  if (Number.isNaN(evaluationAt.getTime())) throw new TypeError('evaluationAt must be valid');
  const safe = new Date(
    evaluationAt.getTime() - SUPPLY_SPEND_WINDOW_SAFETY_LAG_HOURS * 60 * 60 * 1000,
  );
  const monthStart = new Date(Date.UTC(safe.getUTCFullYear(), safe.getUTCMonth(), 1));
  const end = new Date(monthStart.getTime() - 86_400_000);
  const start = new Date(Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth() - (SUPPLY_SPEND_HISTORY_MONTHS - 1),
    1,
  ));
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

/** One organization-scoped source read; the SQL function rejects all others. */
export async function loadManagementPatternSourceSnapshot(input: {
  organizationId: string;
  evaluationAt: Date;
  sourceAsOf: Date;
  topologyAsOf: Date;
  signal?: AbortSignal;
}): Promise<ManagementPatternSourceSnapshot> {
  for (const [field, value] of [
    ['evaluationAt', input.evaluationAt],
    ['sourceAsOf', input.sourceAsOf],
    ['topologyAsOf', input.topologyAsOf],
  ] as const) {
    if (Number.isNaN(value.getTime())) throw new TypeError(`${field} must be valid`);
  }
  if (
    input.topologyAsOf.getTime() > input.sourceAsOf.getTime()
    || input.sourceAsOf.getTime() > input.evaluationAt.getTime()
  ) throw new TypeError('require topologyAsOf <= sourceAsOf <= evaluationAt');
  // The evidence window is historical topology policy, not the later wall
  // clock at which a correction/backfill is evaluated.
  const window = completedSupplyWindow(input.topologyAsOf);
  const request = supabaseAdmin.rpc('load_management_pattern_source_snapshot', {
    p_organization_id: input.organizationId,
    p_evaluation_at: input.evaluationAt.toISOString(),
    p_source_as_of: input.sourceAsOf.toISOString(),
    p_topology_as_of: input.topologyAsOf.toISOString(),
    p_supply_window_start: window.startDate,
    p_supply_window_end: window.endDate,
    p_activity_history_days: ACTIVITY_HISTORY_DAYS,
    p_max_properties: MANAGEMENT_PATTERN_MAX_PROPERTIES,
  });
  const { data, error } = await (input.signal === undefined
    ? request
    : request.abortSignal(input.signal));
  if (error) throw new Error(`management pattern source snapshot failed: ${error.message}`);
  const parsed = managementPatternSourceSnapshotSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`management pattern source contract failed: ${z.prettifyError(parsed.error)}`);
  }
  if (parsed.data.organization.id !== input.organizationId) {
    throw new Error('management pattern source returned another organization');
  }
  if (
    Date.parse(parsed.data.evaluation_at) !== input.evaluationAt.getTime()
    || Date.parse(parsed.data.source_as_of) !== input.sourceAsOf.getTime()
    || Date.parse(parsed.data.topology_as_of) !== input.topologyAsOf.getTime()
    || Date.parse(parsed.data.analysis_window_anchor) !== input.topologyAsOf.getTime()
    || parsed.data.supply_window.start_date !== window.startDate
    || parsed.data.supply_window.end_date !== window.endDate
    || parsed.data.activity_window.history_days !== ACTIVITY_HISTORY_DAYS
    || parsed.data.max_properties !== MANAGEMENT_PATTERN_MAX_PROPERTIES
  ) throw new Error('management pattern source receipt does not match the requested constants');
  return parsed.data;
}
