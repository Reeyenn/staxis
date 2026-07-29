import 'server-only';

import { businessDate } from '@/lib/business-date';
import { scopedDb, type ScopedDb } from '@/lib/agent/scoped-db';
import {
  MapWithConcurrencyInterruptedError,
  mapWithConcurrency,
} from '@/lib/agent/portfolio/hotels';
import { addDaysInTz } from '@/lib/schedule/local-date';

import type { PropertyMetricEvidenceV1, SourceReceiptV1 } from './evidence';
import type { ScopeHotelCandidate } from './schemas';
import {
  BOOKED_ROOMS_BASELINE_WEEKS,
  BOOKED_ROOMS_MAX_AGE_MS,
  BOOKED_ROOMS_MIN_BASELINE_POINTS,
  BOOKED_ROOMS_NORMAL_VERSION,
  BOOKED_ROOMS_OTB_METRIC_VERSION,
  PORTFOLIO_PROPERTY_TIMEOUT_MS,
  PORTFOLIO_QUERY_CONCURRENCY,
} from './versions';
import {
  PortfolioPropertyReadTimeoutError,
  PortfolioQueryInterruptedError,
  runAbortablePostgrest,
} from './cancellation';

interface PaceRow {
  id: string;
  as_of_date: string;
  stay_date: string;
  rooms_otb: number | null;
  rooms_available: number | null;
  observed_at: string | null;
  ingest_run_id: string;
}

interface RunRow {
  id: string;
  source_kind: string;
  source_captured_at: string;
  parser_name: string;
  parser_version: string;
  knowledge_file_id: string | null;
  report_file_id: string | null;
  status: string;
}

interface PacePointRow {
  point_kind: 'current' | 'baseline';
  target_date: string;
  pace_id: string;
  as_of_date: string;
  stay_date: string;
  rooms_otb: number | null;
  rooms_available: number | null;
  observed_at: string | null;
  ingest_run_id: string;
  source_kind: string;
  source_captured_at: string;
  parser_name: string;
  parser_version: string;
  knowledge_file_id: string | null;
  report_file_id: string | null;
  run_status: string;
}

interface BookedRoomsReadDependencies {
  dbForProperty: (propertyId: string) => ScopedDb;
  timeoutMs: number;
  signal: AbortSignal;
  deadlineAt: number;
}

const DEFAULT_DEPENDENCIES: BookedRoomsReadDependencies = {
  dbForProperty: scopedDb,
  timeoutMs: PORTFOLIO_PROPERTY_TIMEOUT_MS,
  signal: new AbortController().signal,
  deadlineAt: Number.MAX_SAFE_INTEGER,
};

function validTimezone(timezone: string | null): timezone is string {
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function emptyFact(
  hotel: ScopeHotelCandidate,
  businessDateValue: string,
  code: PropertyMetricEvidenceV1['exclusionCode'],
  reason: string,
): PropertyMetricEvidenceV1 {
  return {
    propertyId: hotel.propertyId,
    propertyName: hotel.name,
    timezone: hotel.timezone ?? 'unknown',
    businessDate: businessDateValue,
    metricId: 'rooms_booked_otb',
    metricVersion: BOOKED_ROOMS_OTB_METRIC_VERSION,
    numerator: null,
    denominator: null,
    normalizedValue: null,
    unit: 'rooms',
    freshness: 'unknown',
    quality: 'excluded',
    exclusionCode: code,
    exclusionReason: reason,
    comparisonExclusionCode: code,
    comparisonExclusionReason: reason,
    source: null,
    baseline: null,
  };
}

function sourceReceipt(row: PaceRow, run: RunRow): SourceReceiptV1 {
  return {
    sourceTable: 'pms_booking_pace',
    sourceRecordId: row.id,
    ingestRunId: run.id,
    sourceKind: run.source_kind,
    sourceCapturedAt: run.source_captured_at,
    sourceBusinessAsOfDate: row.as_of_date,
    sourceObservedAt: row.observed_at,
    parserName: run.parser_name,
    parserVersion: run.parser_version,
    knowledgeFileId: run.knowledge_file_id,
    reportFileId: run.report_file_id,
  };
}

function newestRow(rows: readonly PaceRow[], receipts: ReadonlyMap<string, RunRow>): PaceRow | null {
  return [...rows]
    .filter((row) => receipts.has(row.ingest_run_id))
    .sort((a, b) => {
      const date = b.as_of_date.localeCompare(a.as_of_date);
      if (date !== 0) return date;
      return (b.observed_at ?? '').localeCompare(a.observed_at ?? '');
    })[0] ?? null;
}

function baselineFor(
  current: PaceRow,
  currentRun: RunRow,
  historicalRows: readonly PaceRow[],
  receipts: ReadonlyMap<string, RunRow>,
  baselineDates: readonly string[],
): {
  baseline: NonNullable<PropertyMetricEvidenceV1['baseline']> | null;
  code: PropertyMetricEvidenceV1['comparisonExclusionCode'];
  reason: string | null;
} {
  const compatible: number[] = [];
  for (const date of baselineDates) {
    const row = newestRow(
      historicalRows.filter((candidate) => candidate.stay_date === date && candidate.as_of_date === date),
      receipts,
    );
    if (!row) continue;
    const run = receipts.get(row.ingest_run_id);
    if (!run) continue;
    if (run.parser_name !== currentRun.parser_name || run.parser_version !== currentRun.parser_version) continue;
    const rooms = finiteNumber(row.rooms_otb);
    const available = finiteNumber(row.rooms_available);
    if (rooms === null || available === null || rooms < 0 || available <= 0 || rooms > available) continue;
    compatible.push((rooms / available) * 100);
  }

  if (compatible.length < BOOKED_ROOMS_MIN_BASELINE_POINTS) {
    const anyHistorical = historicalRows.some((row) => row.as_of_date === row.stay_date);
    return {
      baseline: null,
      code: anyHistorical ? 'incompatible_source_version' : 'insufficient_history',
      reason: anyHistorical
        ? `Only ${compatible.length} same-weekday observations use the current parser version; ${BOOKED_ROOMS_MIN_BASELINE_POINTS} are required.`
        : `Only ${compatible.length} valid same-weekday observations are available; ${BOOKED_ROOMS_MIN_BASELINE_POINTS} are required.`,
    };
  }

  const center = median(compatible);
  const mad = median(compatible.map((value) => Math.abs(value - center)));
  const currentRooms = finiteNumber(current.rooms_otb)!;
  const currentAvailable = finiteNumber(current.rooms_available)!;
  const currentPct = (currentRooms / currentAvailable) * 100;
  const oneRoomPct = 100 / currentAvailable;
  const spread = Math.max(oneRoomPct, 1.4826 * mad);
  const lower = Math.max(0, center - spread);
  const upper = Math.min(100, center + spread);
  return {
    baseline: {
      version: BOOKED_ROOMS_NORMAL_VERSION,
      n: compatible.length,
      median: Math.round(center * 10) / 10,
      mad: Math.round(mad * 10) / 10,
      lower: Math.round(lower * 10) / 10,
      upper: Math.round(upper * 10) / 10,
      classification: currentPct > upper ? 'above' : currentPct < lower ? 'below' : 'typical',
      windowStart: baselineDates[baselineDates.length - 1],
      windowEnd: baselineDates[0],
    },
    code: null,
    reason: null,
  };
}

async function readOneHotel(
  hotel: ScopeHotelCandidate,
  now: Date,
  includeComparison: boolean,
  dependencies: BookedRoomsReadDependencies,
): Promise<PropertyMetricEvidenceV1> {
  if (!validTimezone(hotel.timezone)) {
    return emptyFact(hotel, 'unknown', 'source_incomplete', 'The hotel has no valid IANA timezone, so its business date cannot be resolved safely.');
  }
  const businessDateValue = businessDate({
    timezone: hotel.timezone,
    business_date_cutoff_hour: hotel.businessDateCutoffHour,
  }, now);
  const baselineDates = Array.from(
    { length: BOOKED_ROOMS_BASELINE_WEEKS },
    (_, index) => addDaysInTz(businessDateValue, -7 * (index + 1)),
  );
  const db = dependencies.dbForProperty(hotel.propertyId);

  let rows: PaceRow[];
  let runRows: RunRow[];
  try {
    const query = db.rpc('staxis_portfolio_booked_room_points', {
      p_property_id: hotel.propertyId,
      p_business_date: businessDateValue,
      p_baseline_dates: includeComparison ? baselineDates : [],
    });
    const result = await runAbortablePostgrest({
      query,
      signal: dependencies.signal,
      deadlineAt: dependencies.deadlineAt,
      timeoutMs: dependencies.timeoutMs,
    });
    if (result.error) throw result.error;
    const points = (result.data ?? []) as PacePointRow[];
    rows = points.map((point) => ({
      id: point.pace_id,
      as_of_date: point.as_of_date,
      stay_date: point.stay_date,
      rooms_otb: point.rooms_otb,
      rooms_available: point.rooms_available,
      observed_at: point.observed_at,
      ingest_run_id: point.ingest_run_id,
    }));
    runRows = [...new Map(points.map((point) => [point.ingest_run_id, {
      id: point.ingest_run_id,
      source_kind: point.source_kind,
      source_captured_at: point.source_captured_at,
      parser_name: point.parser_name,
      parser_version: point.parser_version,
      knowledge_file_id: point.knowledge_file_id,
      report_file_id: point.report_file_id,
      status: point.run_status,
    } satisfies RunRow])).values()];
  } catch (error) {
    if (error instanceof PortfolioQueryInterruptedError) {
      if (error.reason === 'cancelled') throw error;
      return emptyFact(
        hotel,
        businessDateValue,
        'timeout',
        'The portfolio query budget expired while this hotel was being read.',
      );
    }
    const timedOut = error instanceof PortfolioPropertyReadTimeoutError
      || (error instanceof Error && error.message.includes('timed out'));
    return emptyFact(
      hotel,
      businessDateValue,
      timedOut ? 'timeout' : 'source_failed',
      timedOut ? 'The PMS booked-rooms point query timed out.' : 'The PMS booked-rooms source and receipts could not be read safely.',
    );
  }

  if (rows.length === 0) {
    return emptyFact(hotel, businessDateValue, 'source_unavailable', 'No on-the-books observation is available for this hotel business date.');
  }

  const receipts = new Map(runRows.map((run) => [run.id, run]));
  const current = newestRow(rows.filter((row) => row.stay_date === businessDateValue), receipts);
  if (!current) {
    return emptyFact(hotel, businessDateValue, 'source_unavailable', 'No successful receipt-backed on-the-books observation is available for this hotel business date.');
  }
  const run = receipts.get(current.ingest_run_id)!;
  const capturedMs = new Date(run.source_captured_at).getTime();
  const observedMs = current.observed_at ? new Date(current.observed_at).getTime() : Number.NaN;
  const captureAgeMs = now.getTime() - capturedMs;
  const observedAgeMs = now.getTime() - observedMs;
  if (
    !Number.isFinite(capturedMs)
    || !Number.isFinite(observedMs)
    || captureAgeMs < -5 * 60 * 1_000
    || observedAgeMs < -5 * 60 * 1_000
  ) {
    return emptyFact(hotel, businessDateValue, 'source_incomplete', 'The PMS receipt has an invalid or future capture time.');
  }

  const rooms = finiteNumber(current.rooms_otb);
  const available = finiteNumber(current.rooms_available);
  const source = sourceReceipt(current, run);
  if (current.as_of_date !== businessDateValue) {
    const fact = emptyFact(
      hotel,
      businessDateValue,
      'source_stale',
      `The latest receipt-backed PMS snapshot is for ${current.as_of_date}, not the current hotel business date ${businessDateValue}.`,
    );
    fact.numerator = rooms;
    fact.denominator = available;
    fact.normalizedValue = rooms !== null && available !== null && available > 0 && rooms <= available
      ? Math.round((rooms / available) * 1_000) / 10
      : null;
    fact.freshness = 'stale';
    fact.source = source;
    return fact;
  }
  if (rooms === null || rooms < 0) {
    const fact = emptyFact(hotel, businessDateValue, 'missing_value', 'The PMS observation did not provide a valid rooms-on-the-books value.');
    fact.source = source;
    return fact;
  }
  const ageMs = Math.max(captureAgeMs, observedAgeMs);
  if (ageMs > BOOKED_ROOMS_MAX_AGE_MS) {
    const fact = emptyFact(
      hotel,
      businessDateValue,
      'source_stale',
      `The latest PMS on-the-books observation is ${Math.floor(ageMs / 60_000)} minutes old, beyond the six-hour freshness limit.`,
    );
    fact.numerator = rooms;
    fact.denominator = available;
    fact.normalizedValue = available && available > 0 ? Math.round((rooms / available) * 1_000) / 10 : null;
    fact.freshness = 'stale';
    fact.source = source;
    return fact;
  }

  const denominatorValid = available !== null && available > 0 && rooms <= available;
  const comparison = includeComparison && denominatorValid
    ? baselineFor(current, run, rows, receipts, baselineDates)
    : {
        baseline: null,
        code: includeComparison ? 'missing_denominator' as const : null,
        reason: includeComparison ? 'A valid rooms-available denominator is required for a comparable occupancy-rate baseline.' : null,
      };

  return {
    propertyId: hotel.propertyId,
    propertyName: hotel.name,
    timezone: hotel.timezone,
    businessDate: businessDateValue,
    metricId: 'rooms_booked_otb',
    metricVersion: BOOKED_ROOMS_OTB_METRIC_VERSION,
    numerator: rooms,
    denominator: denominatorValid ? available : null,
    normalizedValue: denominatorValid ? Math.round((rooms / available) * 1_000) / 10 : null,
    unit: 'rooms',
    freshness: 'fresh',
    quality: denominatorValid ? 'included' : 'partial',
    exclusionCode: denominatorValid ? null : 'missing_denominator',
    exclusionReason: denominatorValid ? null : 'Rooms booked are available, but the PMS did not supply a valid rooms-available denominator.',
    comparisonExclusionCode: comparison.code,
    comparisonExclusionReason: comparison.reason,
    source,
    baseline: comparison.baseline,
  };
}

/** Exact-set, bounded-concurrency OTB adapter shared by portfolio and drill-down plans. */
export async function readBookedRoomsOtb(
  hotels: readonly ScopeHotelCandidate[],
  options: {
    now?: Date;
    includeComparison?: boolean;
    deadlineAt?: number;
    signal?: AbortSignal;
    dependencies?: Partial<BookedRoomsReadDependencies>;
  } = {},
): Promise<PropertyMetricEvidenceV1[]> {
  const now = options.now ?? new Date();
  const timeoutFact = (hotel: ScopeHotelCandidate): PropertyMetricEvidenceV1 => {
    const businessDateValue = validTimezone(hotel.timezone)
      ? businessDate({
          timezone: hotel.timezone,
          business_date_cutoff_hour: hotel.businessDateCutoffHour,
        }, now)
      : 'unknown';
    return emptyFact(
      hotel,
      businessDateValue,
      'timeout',
      'The portfolio query budget expired before this hotel could be read.',
    );
  };
  if (options.signal?.aborted) {
    if (options.deadlineAt !== undefined && options.deadlineAt <= Date.now()) {
      return hotels.map(timeoutFact);
    }
    throw new PortfolioQueryInterruptedError('cancelled');
  }
  if (options.deadlineAt !== undefined && options.deadlineAt <= Date.now()) {
    return hotels.map(timeoutFact);
  }
  const signal = options.signal ?? options.dependencies?.signal ?? DEFAULT_DEPENDENCIES.signal;
  const deadlineAt = options.deadlineAt
    ?? options.dependencies?.deadlineAt
    ?? DEFAULT_DEPENDENCIES.deadlineAt;
  const baseDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...options.dependencies,
    signal,
    deadlineAt,
  };
  try {
    return await mapWithConcurrency(
      hotels,
      PORTFOLIO_QUERY_CONCURRENCY,
      (hotel) => readOneHotel(
        hotel,
        now,
        options.includeComparison === true,
        {
          ...baseDependencies,
          timeoutMs: Math.min(
            baseDependencies.timeoutMs,
            Math.max(1, deadlineAt - Date.now()),
          ),
        },
      ),
      { signal, deadlineAt, onTimedOut: timeoutFact },
    );
  } catch (error) {
    if (error instanceof MapWithConcurrencyInterruptedError) {
      throw new PortfolioQueryInterruptedError(error.reason);
    }
    throw error;
  }
}
