import 'server-only';

import { createHash } from 'node:crypto';
import { z } from 'zod';

import { businessDate } from '@/lib/business-date';
import { scopedDb } from '@/lib/agent/scoped-db';
import {
  MapWithConcurrencyInterruptedError,
  mapWithConcurrency,
} from '@/lib/agent/portfolio/hotels';
import { log } from '@/lib/log';

import { readBookedRoomsOtb } from './booked-rooms';
import type { PropertyMetricEvidenceV1 } from './evidence';
import type { ScopeHotelCandidate } from './schemas';
import {
  BOOKED_ROOMS_MAX_AGE_MS,
  BOOKED_ROOMS_NORMAL_VERSION,
  BOOKED_ROOMS_OTB_METRIC_VERSION,
  PORTFOLIO_PROPERTY_TIMEOUT_MS,
  PORTFOLIO_QUERY_CONCURRENCY,
} from './versions';
import {
  PortfolioQueryInterruptedError,
  runAbortablePostgrest,
} from './cancellation';

const SNAPSHOT_TTL_MS = 5 * 60 * 1_000;

const sourceSchema = z.object({
  sourceTable: z.string().min(1).max(100),
  sourceRecordId: z.string().min(1).max(200),
  ingestRunId: z.string().uuid().nullable(),
  sourceKind: z.string().max(100).nullable(),
  sourceCapturedAt: z.string().datetime({ offset: true }),
  sourceBusinessAsOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  sourceObservedAt: z.string().datetime({ offset: true }).nullable().optional(),
  parserName: z.string().max(200).nullable(),
  parserVersion: z.string().max(200).nullable(),
  knowledgeFileId: z.string().uuid().nullable(),
  reportFileId: z.string().uuid().nullable(),
  queryVersion: z.string().max(200).nullable().optional(),
}).strict();

const propertyFactSchema = z.object({
  propertyId: z.string().uuid(),
  propertyName: z.string().min(1).max(500),
  timezone: z.string().min(1).max(100),
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  metricId: z.string().min(1).max(100),
  metricVersion: z.string().min(1).max(120),
  numerator: z.number().finite().nullable(),
  denominator: z.number().finite().nullable(),
  normalizedValue: z.number().finite().nullable(),
  unit: z.string().min(1).max(40),
  freshness: z.enum(['fresh', 'stale', 'unknown']),
  quality: z.enum(['included', 'excluded', 'partial']),
  exclusionCode: z.string().max(100).nullable(),
  exclusionReason: z.string().max(1000).nullable(),
  comparisonExclusionCode: z.string().max(100).nullable(),
  comparisonExclusionReason: z.string().max(1000).nullable(),
  source: sourceSchema.nullable(),
  baseline: z.object({
    version: z.string().min(1).max(120),
    n: z.number().int().nonnegative(),
    median: z.number().finite(),
    mad: z.number().finite(),
    lower: z.number().finite(),
    upper: z.number().finite(),
    classification: z.enum(['above', 'typical', 'below', 'unavailable']),
    windowStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    windowEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).strict().nullable().optional(),
}).strict();

function validTimezone(timezone: string | null): timezone is string {
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function comparisonVersion(includeComparison: boolean): string {
  return includeComparison ? BOOKED_ROOMS_NORMAL_VERSION : 'none';
}

async function loadOne(
  hotel: ScopeHotelCandidate,
  date: string,
  includeComparison: boolean,
  now: Date,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<PropertyMetricEvidenceV1 | null> {
  const baseQuery = scopedDb(hotel.propertyId)
    .from('portfolio_metric_snapshots')
    .select('fact, expires_at')
    .eq('metric_id', 'rooms_booked_otb')
    .eq('metric_version', BOOKED_ROOMS_OTB_METRIC_VERSION)
    .eq('business_date', date);
  // A baseline-enriched fact is a strict superset of the same canonical
  // current metric and can satisfy a later factual drill-down. The inverse is
  // forbidden: a no-comparison snapshot can never answer "above normal".
  const versionedQuery = includeComparison
    ? baseQuery.eq('comparison_version', BOOKED_ROOMS_NORMAL_VERSION)
    : baseQuery.in('comparison_version', ['none', BOOKED_ROOMS_NORMAL_VERSION]);
  const query = versionedQuery
    .gt('expires_at', now.toISOString())
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle() as unknown as PromiseLike<{
      data: { fact: unknown; expires_at: string } | null;
      error: { message: string; code?: string } | null;
    }> & { abortSignal?: (signal: AbortSignal) => PromiseLike<{
      data: { fact: unknown; expires_at: string } | null;
      error: { message: string; code?: string } | null;
    }> };
  const { data, error } = await runAbortablePostgrest({
    query,
    signal,
    deadlineAt,
    timeoutMs: PORTFOLIO_PROPERTY_TIMEOUT_MS,
  });
  if (error || !data) return null;
  const parsed = propertyFactSchema.safeParse(data.fact);
  if (!parsed.success) return null;
  const fact = parsed.data as PropertyMetricEvidenceV1;
  if (fact.propertyId !== hotel.propertyId
      || fact.businessDate !== date
      || fact.metricId !== 'rooms_booked_otb'
      || fact.metricVersion !== BOOKED_ROOMS_OTB_METRIC_VERSION
      || fact.freshness !== 'fresh'
      || fact.quality === 'excluded') return null;
  return fact;
}

function snapshotKey(fact: PropertyMetricEvidenceV1, comparison: string): string {
  return createHash('sha256').update(JSON.stringify({
    propertyId: fact.propertyId,
    metricId: fact.metricId,
    metricVersion: fact.metricVersion,
    comparison,
    businessDate: fact.businessDate,
    sourceTable: fact.source?.sourceTable ?? null,
    sourceRecordId: fact.source?.sourceRecordId ?? null,
    ingestRunId: fact.source?.ingestRunId ?? null,
    sourceCapturedAt: fact.source?.sourceCapturedAt ?? null,
    sourceBusinessAsOfDate: fact.source?.sourceBusinessAsOfDate ?? null,
    sourceObservedAt: fact.source?.sourceObservedAt ?? null,
    parserVersion: fact.source?.parserVersion ?? null,
  })).digest('hex');
}

async function rememberOne(
  fact: PropertyMetricEvidenceV1,
  includeComparison: boolean,
  now: Date,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<void> {
  if (fact.freshness !== 'fresh' || fact.quality === 'excluded' || !fact.source) return;
  const sourceMs = Date.parse(fact.source.sourceCapturedAt);
  const expiresAtMs = Math.min(now.getTime() + SNAPSHOT_TTL_MS, sourceMs + BOOKED_ROOMS_MAX_AGE_MS);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime()) return;
  const comparison = comparisonVersion(includeComparison);
  const query = scopedDb(fact.propertyId)
    .from('portfolio_metric_snapshots')
    .upsert({
      metric_id: fact.metricId,
      metric_version: fact.metricVersion,
      comparison_version: comparison,
      business_date: fact.businessDate,
      source_ingest_run_id: fact.source.ingestRunId,
      source_record_id: fact.source.sourceRecordId,
      source_captured_at: fact.source.sourceCapturedAt,
      snapshot_key: snapshotKey(fact, comparison),
      fact,
      generated_at: now.toISOString(),
      expires_at: new Date(expiresAtMs).toISOString(),
    }, { onConflict: 'property_id,snapshot_key', ignoreDuplicates: true });
  const { error } = await runAbortablePostgrest({
    query,
    signal,
    deadlineAt,
    timeoutMs: PORTFOLIO_PROPERTY_TIMEOUT_MS,
  });
  if (error) {
    log.warn('[portfolio-intelligence] metric snapshot acceleration unavailable', {
      propertyId: fact.propertyId,
      metricId: fact.metricId,
      code: error.code ?? 'snapshot_write_failed',
    });
  }
}

/** Read-through materialization for the canonical booked-room adapter. Cache
 * keys are property-only and source/version-bound; exact company scope is never
 * cached and is still asserted by the engine before and after aggregation. */
export async function readBookedRoomsWithSnapshots(
  hotels: readonly ScopeHotelCandidate[],
  options: Parameters<typeof readBookedRoomsOtb>[1] = {},
): Promise<PropertyMetricEvidenceV1[]> {
  const now = options.now ?? new Date();
  const includeComparison = options.includeComparison === true;
  const signal = options.signal ?? new AbortController().signal;
  const deadlineAt = options.deadlineAt ?? Number.MAX_SAFE_INTEGER;
  if (signal.aborted || deadlineAt <= Date.now()) {
    if (deadlineAt <= Date.now()) {
      // The engine signal is shared by client cancellation AND its deterministic
      // deadline. An expired deadline is partial-data semantics: skip snapshot
      // I/O and let the canonical adapter emit one explicit timeout per hotel.
      return readBookedRoomsOtb(hotels, {
        ...options,
        now,
        includeComparison,
        signal,
        deadlineAt,
      });
    }
    throw new PortfolioQueryInterruptedError('cancelled');
  }
  const facts = new Map<string, PropertyMetricEvidenceV1>();
  const misses: ScopeHotelCandidate[] = [];
  try {
    await mapWithConcurrency(hotels, PORTFOLIO_QUERY_CONCURRENCY, async (hotel) => {
      if (!validTimezone(hotel.timezone)) {
        misses.push(hotel);
        return;
      }
      const date = businessDate({
        timezone: hotel.timezone,
        business_date_cutoff_hour: hotel.businessDateCutoffHour,
      }, now);
      try {
        const hit = await loadOne(hotel, date, includeComparison, now, signal, deadlineAt);
        if (hit) facts.set(hotel.propertyId, hit);
        else misses.push(hotel);
      } catch (error) {
        if (error instanceof PortfolioQueryInterruptedError) {
          if (error.reason === 'cancelled') throw error;
          misses.push(hotel);
          return;
        }
        // Migration rollout and transient cache reads must never make the source
        // unavailable; the canonical adapter below remains authoritative.
        misses.push(hotel);
      }
    }, {
      signal,
      deadlineAt,
      onTimedOut: (hotel) => { misses.push(hotel); },
    });
  } catch (error) {
    if (error instanceof MapWithConcurrencyInterruptedError) {
      throw new PortfolioQueryInterruptedError(error.reason);
    }
    throw error;
  }

  if (misses.length > 0) {
    const fresh = await readBookedRoomsOtb(misses, {
      ...options,
      now,
      includeComparison,
      signal,
      deadlineAt,
    });
    // Source evidence is already complete. Snapshot persistence below is only
    // acceleration and must never erase good/explicit-timeout facts when the
    // remaining global budget expires.
    for (const fact of fresh) facts.set(fact.propertyId, fact);
    try {
      await mapWithConcurrency(fresh, PORTFOLIO_QUERY_CONCURRENCY, async (fact) => {
        try {
          await rememberOne(fact, includeComparison, now, signal, deadlineAt);
        } catch (error) {
          if (error instanceof PortfolioQueryInterruptedError) {
            if (error.reason === 'cancelled') throw error;
            return;
          }
          log.warn('[portfolio-intelligence] metric snapshot acceleration unavailable', {
            propertyId: fact.propertyId,
            metricId: fact.metricId,
            code: 'snapshot_write_failed',
          });
        }
      }, { signal, deadlineAt, onTimedOut: () => undefined });
    } catch (error) {
      if (error instanceof MapWithConcurrencyInterruptedError) {
        throw new PortfolioQueryInterruptedError(error.reason);
      }
      throw error;
    }
  }
  return hotels.map((hotel) => facts.get(hotel.propertyId)!).filter(Boolean);
}
