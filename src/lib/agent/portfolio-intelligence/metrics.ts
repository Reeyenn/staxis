import type { PortfolioMetricId } from './schemas';
import {
  BOOKED_ROOMS_MAX_AGE_MS,
  BOOKED_ROOMS_OTB_METRIC_VERSION,
  FINAL_ROOMS_SOLD_METRIC_VERSION,
  HOUSEKEEPING_ACTIVE_MINUTES_METRIC_VERSION,
  HOUSEKEEPING_ROOMS_CLEANED_METRIC_VERSION,
  LIVE_IN_HOUSE_METRIC_VERSION,
} from './versions';

export type MetricUnit = 'rooms' | 'minutes' | 'count' | 'percent';
export type MetricAggregation = 'sum' | 'weighted_ratio' | 'average' | 'point_in_time';

export interface PortfolioMetricDefinition {
  id: PortfolioMetricId;
  version: string;
  label: string;
  definition: string;
  numerator: string;
  denominator: string | null;
  unit: MetricUnit;
  normalizedUnit: 'percent' | 'minutes_per_room' | null;
  aggregation: MetricAggregation;
  source: {
    table: string;
    grain: string;
    requiredReceipt: string | null;
  };
  window: string;
  maxFreshnessMs: number | null;
  currency: 'not_applicable' | 'required_iso';
  missingPolicy: 'exclude_with_reason';
}

/**
 * Closed metric vocabulary for portfolio plans. These definitions are sent to
 * synthesis and persisted with evidence; the LLM never invents a denominator,
 * converts a unit, or decides that another PMS measure is "close enough".
 */
export const PORTFOLIO_METRICS: Readonly<Record<PortfolioMetricId, PortfolioMetricDefinition>> = Object.freeze({
  rooms_booked_otb: {
    id: 'rooms_booked_otb',
    version: BOOKED_ROOMS_OTB_METRIC_VERSION,
    label: 'Rooms booked on the books',
    definition:
      'Room-nights currently on the books for the hotel\'s current business/stay date. This is not live in-house occupancy and is not a final rooms-sold figure.',
    numerator: 'pms_booking_pace.rooms_otb from the newest successful receipt with as_of_date <= stay_date',
    denominator: 'pms_booking_pace.rooms_available from the same row',
    unit: 'rooms',
    normalizedUnit: 'percent',
    aggregation: 'sum',
    source: {
      table: 'pms_booking_pace',
      grain: 'property_id + as_of_date + stay_date',
      requiredReceipt: 'pms_ingest_runs',
    },
    window: 'Each hotel\'s current business date using its timezone and night-audit cutoff',
    maxFreshnessMs: BOOKED_ROOMS_MAX_AGE_MS,
    currency: 'not_applicable',
    missingPolicy: 'exclude_with_reason',
  },
  live_in_house_rooms: {
    id: 'live_in_house_rooms',
    version: LIVE_IN_HOUSE_METRIC_VERSION,
    label: 'Rooms occupied now',
    definition: 'The newest live PMS observation of occupied/in-house rooms. Never described as rooms booked on the books.',
    numerator: 'pms_occupancy_observation.total_occupied_rooms',
    denominator: 'configured/current room inventory',
    unit: 'rooms',
    normalizedUnit: 'percent',
    aggregation: 'point_in_time',
    source: { table: 'pms_occupancy_observation', grain: 'property_id + observed_at', requiredReceipt: 'pms_ingest_runs' },
    window: 'Newest trusted observation for each hotel',
    maxFreshnessMs: 60 * 60 * 1_000,
    currency: 'not_applicable',
    missingPolicy: 'exclude_with_reason',
  },
  final_rooms_sold: {
    id: 'final_rooms_sold',
    version: FINAL_ROOMS_SOLD_METRIC_VERSION,
    label: 'Final rooms sold',
    definition: 'Rooms sold as printed by the PMS for a completed hotel business day.',
    numerator: 'daily_logs.rooms_sold when occupancy_source is present',
    denominator: 'daily_logs.rooms_available from the same sealed row',
    unit: 'rooms',
    normalizedUnit: 'percent',
    aggregation: 'sum',
    source: { table: 'daily_logs', grain: 'property_id + business date', requiredReceipt: 'daily_logs source and seal receipt' },
    window: 'Completed hotel-local business dates only',
    maxFreshnessMs: null,
    currency: 'not_applicable',
    missingPolicy: 'exclude_with_reason',
  },
  housekeeping_rooms_cleaned: {
    id: 'housekeeping_rooms_cleaned',
    version: HOUSEKEEPING_ROOMS_CLEANED_METRIC_VERSION,
    label: 'Housekeeping rooms cleaned',
    definition: 'Count of cleaning events with status recorded or approved in the hotel-local window.',
    numerator: 'count(cleaning_events) where status in (recorded, approved)',
    denominator: null,
    unit: 'rooms',
    normalizedUnit: null,
    aggregation: 'sum',
    source: { table: 'cleaning_events', grain: 'property_id + event/date', requiredReceipt: null },
    window: 'Hotel-local business date window',
    maxFreshnessMs: null,
    currency: 'not_applicable',
    missingPolicy: 'exclude_with_reason',
  },
  housekeeping_active_minutes: {
    id: 'housekeeping_active_minutes',
    version: HOUSEKEEPING_ACTIVE_MINUTES_METRIC_VERSION,
    label: 'Housekeeping active minutes',
    definition: 'Sum and per-room average of duration_minutes for recorded or approved cleaning events.',
    numerator: 'sum(cleaning_events.duration_minutes) where status in (recorded, approved)',
    denominator: 'housekeeping_rooms_cleaned over the same hotel-local window',
    unit: 'minutes',
    normalizedUnit: 'minutes_per_room',
    aggregation: 'weighted_ratio',
    source: { table: 'cleaning_events', grain: 'property_id + event/date', requiredReceipt: null },
    window: 'Hotel-local business date window',
    maxFreshnessMs: null,
    currency: 'not_applicable',
    missingPolicy: 'exclude_with_reason',
  },
  work_orders_open: {
    id: 'work_orders_open',
    version: 'work-orders-open.v1',
    label: 'Open work orders',
    definition: 'Current unresolved first-party Staxis work orders at each hotel.',
    numerator: 'count(work_orders) where status is not a terminal status',
    denominator: null,
    unit: 'count',
    normalizedUnit: null,
    aggregation: 'sum',
    source: { table: 'work_orders', grain: 'property_id + work_order', requiredReceipt: null },
    window: 'Current state at query time',
    maxFreshnessMs: null,
    currency: 'not_applicable',
    missingPolicy: 'exclude_with_reason',
  },
});

export function metricDefinition(id: PortfolioMetricId): PortfolioMetricDefinition {
  return PORTFOLIO_METRICS[id];
}
