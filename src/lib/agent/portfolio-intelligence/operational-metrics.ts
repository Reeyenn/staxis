import 'server-only';

import { businessDate } from '@/lib/business-date';
import { scopedDb, type ScopedDb } from '@/lib/agent/scoped-db';
import {
  MapWithConcurrencyInterruptedError,
  mapWithConcurrency,
} from '@/lib/agent/portfolio/hotels';

import type { PropertyMetricEvidenceV1, SourceReceiptV1 } from './evidence';
import type { PortfolioMetricId, ScopeHotelCandidate } from './schemas';
import {
  HOUSEKEEPING_ACTIVE_MINUTES_METRIC_VERSION,
  HOUSEKEEPING_ROOMS_CLEANED_METRIC_VERSION,
  PORTFOLIO_PROPERTY_TIMEOUT_MS,
  PORTFOLIO_QUERY_CONCURRENCY,
} from './versions';
import {
  PortfolioPropertyReadTimeoutError,
  PortfolioQueryInterruptedError,
  runAbortablePostgrest,
  throwIfPortfolioQueryInterrupted,
} from './cancellation';

const OPERATIONAL_QUERY_VERSION = 'portfolio-operational-read.v1';
const MAX_OPERATIONAL_ROWS_PER_PROPERTY = 5_001;

interface OperationalReadDependencies {
  dbForProperty: (propertyId: string) => ScopedDb;
  timeoutMs: number;
  signal: AbortSignal;
  deadlineAt: number;
}

const DEFAULT_DEPENDENCIES: OperationalReadDependencies = {
  dbForProperty: scopedDb,
  timeoutMs: PORTFOLIO_PROPERTY_TIMEOUT_MS,
  signal: new AbortController().signal,
  deadlineAt: Number.MAX_SAFE_INTEGER,
};

interface CleaningRow {
  id: string;
  duration_minutes: number | string | null;
  completed_at: string | null;
}

interface WorkOrderRow {
  id: string;
  status: string | null;
  created_at: string | null;
  updated_at: string | null;
}

function validTimezone(timezone: string | null): timezone is string {
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function sourceReceipt(
  table: string,
  recordId: string,
  sourceCapturedAt: string,
): SourceReceiptV1 {
  return {
    sourceTable: table,
    sourceRecordId: recordId,
    ingestRunId: null,
    sourceKind: 'staxis_first_party',
    sourceCapturedAt,
    parserName: null,
    parserVersion: null,
    knowledgeFileId: null,
    reportFileId: null,
    queryVersion: OPERATIONAL_QUERY_VERSION,
  };
}

function emptyFact(
  hotel: ScopeHotelCandidate,
  businessDateValue: string,
  metricId: PortfolioMetricId,
  metricVersion: string,
  unit: 'rooms' | 'minutes' | 'count',
  code: PropertyMetricEvidenceV1['exclusionCode'],
  reason: string,
): PropertyMetricEvidenceV1 {
  return {
    propertyId: hotel.propertyId,
    propertyName: hotel.name,
    timezone: hotel.timezone ?? 'unknown',
    businessDate: businessDateValue,
    metricId,
    metricVersion,
    numerator: null,
    denominator: null,
    normalizedValue: null,
    unit,
    freshness: 'unknown',
    quality: 'excluded',
    exclusionCode: code,
    exclusionReason: reason,
    comparisonExclusionCode: null,
    comparisonExclusionReason: null,
    source: null,
    baseline: null,
  };
}

function timedOut(error: unknown): boolean {
  return error instanceof Error && error.message.includes('timed out');
}

function newestTimestamp(rows: ReadonlyArray<{ completed_at?: string | null; updated_at?: string | null; created_at?: string | null }>, fallback: string): string {
  return rows
    .flatMap((row) => [row.completed_at, row.updated_at, row.created_at])
    .filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    .sort((a, b) => b.localeCompare(a))[0] ?? fallback;
}

async function readCleaning(
  hotel: ScopeHotelCandidate,
  date: string,
  now: Date,
  dependencies: OperationalReadDependencies,
): Promise<PropertyMetricEvidenceV1[]> {
  const db = dependencies.dbForProperty(hotel.propertyId);
  let rows: CleaningRow[];
  try {
    const query = db.from('cleaning_events')
        .select('id, duration_minutes, completed_at')
        .eq('date', date)
        .in('status', ['recorded', 'approved'])
        .limit(MAX_OPERATIONAL_ROWS_PER_PROPERTY);
    const result = await runAbortablePostgrest({
      query,
      signal: dependencies.signal,
      deadlineAt: dependencies.deadlineAt,
      timeoutMs: dependencies.timeoutMs,
    });
    if (result.error) throw result.error;
    rows = (result.data ?? []) as CleaningRow[];
  } catch (error) {
    if (error instanceof PortfolioQueryInterruptedError) throw error;
    const timeout = error instanceof PortfolioPropertyReadTimeoutError || timedOut(error);
    const code = timeout ? 'timeout' : 'source_failed';
    const reason = timeout
      ? 'The housekeeping query timed out.'
      : 'The housekeeping source could not be read.';
    return [
      emptyFact(hotel, date, 'housekeeping_rooms_cleaned', HOUSEKEEPING_ROOMS_CLEANED_METRIC_VERSION, 'rooms', code, reason),
      emptyFact(hotel, date, 'housekeeping_active_minutes', HOUSEKEEPING_ACTIVE_MINUTES_METRIC_VERSION, 'minutes', code, reason),
    ];
  }

  if (rows.length >= MAX_OPERATIONAL_ROWS_PER_PROPERTY) {
    const reason = `The housekeeping result reached the ${MAX_OPERATIONAL_ROWS_PER_PROPERTY - 1}-row safety limit; no partial total was reported.`;
    return [
      emptyFact(hotel, date, 'housekeeping_rooms_cleaned', HOUSEKEEPING_ROOMS_CLEANED_METRIC_VERSION, 'rooms', 'row_limit_exceeded', reason),
      emptyFact(hotel, date, 'housekeeping_active_minutes', HOUSEKEEPING_ACTIVE_MINUTES_METRIC_VERSION, 'minutes', 'row_limit_exceeded', reason),
    ];
  }

  const durations = rows
    .map((row) => row.duration_minutes === null || row.duration_minutes === ''
      ? Number.NaN
      : Number(row.duration_minutes))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const durationComplete = durations.length === rows.length;
  const rooms = rows.length;
  const minutes = durations.reduce((sum, value) => sum + value, 0);
  const capturedAt = newestTimestamp(rows, now.toISOString());
  const source = sourceReceipt('cleaning_events', `aggregate:${date}`, capturedAt);

  return [
    {
      propertyId: hotel.propertyId,
      propertyName: hotel.name,
      timezone: hotel.timezone!,
      businessDate: date,
      metricId: 'housekeeping_rooms_cleaned',
      metricVersion: HOUSEKEEPING_ROOMS_CLEANED_METRIC_VERSION,
      numerator: rooms,
      denominator: null,
      normalizedValue: null,
      unit: 'rooms',
      freshness: 'fresh',
      quality: 'included',
      exclusionCode: null,
      exclusionReason: null,
      comparisonExclusionCode: null,
      comparisonExclusionReason: null,
      source,
      baseline: null,
    },
    {
      propertyId: hotel.propertyId,
      propertyName: hotel.name,
      timezone: hotel.timezone!,
      businessDate: date,
      metricId: 'housekeeping_active_minutes',
      metricVersion: HOUSEKEEPING_ACTIVE_MINUTES_METRIC_VERSION,
      numerator: durationComplete ? minutes : null,
      denominator: durationComplete ? rooms : null,
      normalizedValue: durationComplete && rooms > 0 ? Math.round((minutes / rooms) * 10) / 10 : null,
      unit: 'minutes',
      freshness: 'fresh',
      quality: durationComplete ? 'included' : 'excluded',
      exclusionCode: durationComplete ? null : 'missing_value',
      exclusionReason: durationComplete ? null : 'One or more approved cleaning events had no valid duration, so no partial labor total was reported.',
      comparisonExclusionCode: null,
      comparisonExclusionReason: null,
      source,
      baseline: null,
    },
  ];
}

async function readWorkOrders(
  hotel: ScopeHotelCandidate,
  date: string,
  now: Date,
  dependencies: OperationalReadDependencies,
): Promise<PropertyMetricEvidenceV1> {
  const db = dependencies.dbForProperty(hotel.propertyId);
  let rows: WorkOrderRow[];
  try {
    const query = db.from('work_orders')
        .select('id, status, created_at, updated_at')
        .limit(MAX_OPERATIONAL_ROWS_PER_PROPERTY);
    const result = await runAbortablePostgrest({
      query,
      signal: dependencies.signal,
      deadlineAt: dependencies.deadlineAt,
      timeoutMs: dependencies.timeoutMs,
    });
    if (result.error) throw result.error;
    rows = (result.data ?? []) as WorkOrderRow[];
  } catch (error) {
    if (error instanceof PortfolioQueryInterruptedError) throw error;
    const timeout = error instanceof PortfolioPropertyReadTimeoutError || timedOut(error);
    return emptyFact(
      hotel,
      date,
      'work_orders_open',
      'work-orders-open.v1',
      'count',
      timeout ? 'timeout' : 'source_failed',
      timeout ? 'The work-order query timed out.' : 'The work-order source could not be read.',
    );
  }

  if (rows.length >= MAX_OPERATIONAL_ROWS_PER_PROPERTY) {
    return emptyFact(
      hotel,
      date,
      'work_orders_open',
      'work-orders-open.v1',
      'count',
      'row_limit_exceeded',
      `The work-order result reached the ${MAX_OPERATIONAL_ROWS_PER_PROPERTY - 1}-row safety limit; no partial total was reported.`,
    );
  }

  const open = rows.filter((row) => String(row.status ?? 'submitted').toLowerCase() !== 'resolved');
  return {
    propertyId: hotel.propertyId,
    propertyName: hotel.name,
    timezone: hotel.timezone!,
    businessDate: date,
    metricId: 'work_orders_open',
    metricVersion: 'work-orders-open.v1',
    numerator: open.length,
    denominator: null,
    normalizedValue: null,
    unit: 'count',
    freshness: 'fresh',
    quality: 'included',
    exclusionCode: null,
    exclusionReason: null,
    comparisonExclusionCode: null,
    comparisonExclusionReason: null,
    source: sourceReceipt('work_orders', 'aggregate:current-open', newestTimestamp(rows, now.toISOString())),
    baseline: null,
  };
}

/** Reads first-party operational facts at hotel grain. No cross-hotel query is
 * ever constructed; aggregation happens only after all scoped reads finish. */
export async function readOperationalMetrics(
  hotels: readonly ScopeHotelCandidate[],
  metricIds: readonly PortfolioMetricId[],
  options: {
    now?: Date;
    deadlineAt?: number;
    signal?: AbortSignal;
    dependencies?: Partial<OperationalReadDependencies>;
  } = {},
): Promise<PropertyMetricEvidenceV1[]> {
  const now = options.now ?? new Date();
  const signal = options.signal ?? options.dependencies?.signal ?? DEFAULT_DEPENDENCIES.signal;
  const deadlineAt = options.deadlineAt
    ?? options.dependencies?.deadlineAt
    ?? DEFAULT_DEPENDENCIES.deadlineAt;
  const base = {
    ...DEFAULT_DEPENDENCIES,
    ...options.dependencies,
    signal,
    deadlineAt,
  };
  const wantsCleaning = metricIds.includes('housekeeping_rooms_cleaned')
    || metricIds.includes('housekeeping_active_minutes');
  const wantsWorkOrders = metricIds.includes('work_orders_open');
  const timeoutFacts = (hotel: ScopeHotelCandidate): PropertyMetricEvidenceV1[] => {
    const date = validTimezone(hotel.timezone)
      ? businessDate({ timezone: hotel.timezone, business_date_cutoff_hour: hotel.businessDateCutoffHour }, now)
      : 'unknown';
    const reason = 'The portfolio query budget expired before this hotel could be read.';
    const facts: PropertyMetricEvidenceV1[] = [];
    if (wantsCleaning) {
      facts.push(
        emptyFact(hotel, date, 'housekeeping_rooms_cleaned', HOUSEKEEPING_ROOMS_CLEANED_METRIC_VERSION, 'rooms', 'timeout', reason),
        emptyFact(hotel, date, 'housekeeping_active_minutes', HOUSEKEEPING_ACTIVE_MINUTES_METRIC_VERSION, 'minutes', 'timeout', reason),
      );
    }
    if (wantsWorkOrders) {
      facts.push(emptyFact(hotel, date, 'work_orders_open', 'work-orders-open.v1', 'count', 'timeout', reason));
    }
    return facts.filter((fact) => metricIds.includes(fact.metricId as PortfolioMetricId));
  };
  if (signal.aborted) {
    if (deadlineAt <= Date.now()) return hotels.flatMap(timeoutFacts);
    throw new PortfolioQueryInterruptedError('cancelled');
  }
  if (deadlineAt <= Date.now()) return hotels.flatMap(timeoutFacts);

  let perHotel: PropertyMetricEvidenceV1[][];
  try {
    perHotel = await mapWithConcurrency(
      hotels,
      PORTFOLIO_QUERY_CONCURRENCY,
      async (hotel): Promise<PropertyMetricEvidenceV1[]> => {
      const timezoneValid = validTimezone(hotel.timezone);
      const date = timezoneValid
        ? businessDate({ timezone: hotel.timezone, business_date_cutoff_hour: hotel.businessDateCutoffHour }, now)
        : 'unknown';
      const metrics: PropertyMetricEvidenceV1[] = [];
      if (!timezoneValid) {
        const reason = 'The hotel has no valid IANA timezone, so its business date cannot be resolved safely.';
        if (wantsCleaning) {
          metrics.push(
            emptyFact(hotel, date, 'housekeeping_rooms_cleaned', HOUSEKEEPING_ROOMS_CLEANED_METRIC_VERSION, 'rooms', 'source_incomplete', reason),
            emptyFact(hotel, date, 'housekeeping_active_minutes', HOUSEKEEPING_ACTIVE_MINUTES_METRIC_VERSION, 'minutes', 'source_incomplete', reason),
          );
        }
        if (wantsWorkOrders) {
          metrics.push(emptyFact(hotel, date, 'work_orders_open', 'work-orders-open.v1', 'count', 'source_incomplete', reason));
        }
        return metrics;
      }

      const remaining = options.deadlineAt === undefined
        ? base.timeoutMs
        : Math.min(base.timeoutMs, Math.max(1, options.deadlineAt - Date.now()));
      if (deadlineAt <= Date.now()) return timeoutFacts(hotel);
      const dependencies = { ...base, timeoutMs: remaining };
      if (wantsCleaning) {
        try {
          metrics.push(...await readCleaning(hotel, date, now, dependencies));
        } catch (error) {
          if (error instanceof PortfolioQueryInterruptedError && error.reason === 'timed_out') {
            return timeoutFacts(hotel);
          }
          throw error;
        }
      }
      if (wantsWorkOrders) {
        try {
          throwIfPortfolioQueryInterrupted({ signal, deadlineAt });
          metrics.push(await readWorkOrders(hotel, date, now, dependencies));
        } catch (error) {
          if (error instanceof PortfolioQueryInterruptedError && error.reason === 'timed_out') {
            metrics.push(timeoutFacts(hotel).find((fact) => fact.metricId === 'work_orders_open')!);
          } else {
            throw error;
          }
        }
      }
      return metrics.filter((fact) => metricIds.includes(fact.metricId as PortfolioMetricId));
      },
      { signal, deadlineAt, onTimedOut: timeoutFacts },
    );
  } catch (error) {
    if (error instanceof MapWithConcurrencyInterruptedError) {
      throw new PortfolioQueryInterruptedError(error.reason);
    }
    throw error;
  }
  return perHotel.flat();
}
