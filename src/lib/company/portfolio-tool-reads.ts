import 'server-only';

import { feedStatusFromHealth, parseFeedHealthRows } from '@/lib/pms/feed-health';
import type { FreshnessSource } from '@/lib/pms/feed-status';
import { supabaseAdmin } from '@/lib/supabase-admin';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PORTFOLIO_TOOL_HOTELS = 50;
/** 50 payload rows plus one sentinel proving the per-hotel window filled. */
const MAX_PORTFOLIO_TOOL_ROWS_PER_HOTEL = 51;
/** Mirrors migration 0408's full, untruncated JSON bucket ceiling. */
const MAX_PORTFOLIO_TOOL_BUCKET_BYTES = 65_536;

export type PortfolioToolRow = Record<string, unknown>;

export interface PortfolioToolRows {
  rowsByPropertyId: Map<string, PortfolioToolRow[]>;
  /** Requested ids omitted by the DB's live company/hotel intersection. */
  unavailablePropertyIds: string[];
}

export interface PortfolioFeedPulse {
  propertyId: string;
  mode: 'live' | 'manual' | 'onboarding' | 'unavailable';
  capturedAt: string | null;
  source: FreshnessSource | null;
}

interface RpcResult {
  data: unknown;
  error: { message?: string } | null;
}

function boundedScope(
  organizationId: string,
  propertyIds: readonly string[],
): { ids: string[]; allowed: Set<string> } {
  if (!UUID_RX.test(organizationId)) throw new Error('portfolio tool organization id is invalid');
  const ids = [...new Set(propertyIds)];
  if (ids.length > MAX_PORTFOLIO_TOOL_HOTELS) {
    throw new Error(`portfolio tool hotel count exceeds ${MAX_PORTFOLIO_TOOL_HOTELS}`);
  }
  if (ids.some((id) => !UUID_RX.test(id))) {
    throw new Error('portfolio tool property id is invalid');
  }
  return { ids, allowed: new Set(ids) };
}

function boundedRowLimit(limitPerProperty: number): number {
  if (!Number.isSafeInteger(limitPerProperty)
      || limitPerProperty < 1
      || limitPerProperty > MAX_PORTFOLIO_TOOL_ROWS_PER_HOTEL) {
    throw new Error(
      `portfolio tool per-property row limit must be 1..${MAX_PORTFOLIO_TOOL_ROWS_PER_HOTEL}`,
    );
  }
  return limitPerProperty;
}

function rawObjects(value: unknown, what: string): PortfolioToolRow[] {
  if (!Array.isArray(value)) throw new Error(`${what} did not return an array`);
  return value.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`${what} returned a malformed row`);
    }
    return row as PortfolioToolRow;
  });
}

const FINDING_SEVERITIES = new Set(['critical', 'attention', 'info']);
const FINDING_DISPOSITIONS = new Set(['propose', 'recommend', 'fyi', 'ask', 'drop']);
const FINDING_STATUSES = new Set([
  'open',
  'updated',
  'resolved',
  'known_problem',
  'muted',
  'expired',
]);

function nullableFindingText(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function findingCents(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** The policy classifier must see the full, correctly typed persisted shape. */
function assertFindingPolicyRows(result: PortfolioToolRows): void {
  for (const [propertyId, rows] of result.rowsByPropertyId) {
    for (const row of rows) {
      const low = findingCents(row.price_low_cents);
      const high = findingCents(row.price_high_cents);
      const evidenceIsObject = row.evidence !== null
        && typeof row.evidence === 'object'
        && !Array.isArray(row.evidence);
      if (!UUID_RX.test(String(row.id ?? ''))
          || row.property_id !== propertyId
          || typeof row.detector_id !== 'string'
          || row.detector_id.length === 0
          || typeof row.summary !== 'string'
          || !nullableFindingText(row.judged_summary_en)
          || !nullableFindingText(row.judged_summary_es)
          || !evidenceIsObject
          || !FINDING_SEVERITIES.has(String(row.severity ?? ''))
          || !FINDING_DISPOSITIONS.has(String(row.disposition ?? ''))
          || !FINDING_STATUSES.has(String(row.status ?? ''))
          || low === undefined
          || high === undefined
          || (low === null) !== (high === null)
          || typeof row.price_currency !== 'string'
          || row.price_currency.length !== 3
          || !nullableFindingText(row.price_basis)
          || typeof row.first_seen_at !== 'string'
          || !Number.isFinite(Date.parse(row.first_seen_at))
          || typeof row.last_seen_at !== 'string'
          || !Number.isFinite(Date.parse(row.last_seen_at))) {
        throw new Error(`staxis_portfolio_tool_findings returned malformed policy fields for ${propertyId}`);
      }
    }
  }
}

function nullableTimestamp(value: unknown, what: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${what} returned a malformed timestamp`);
  }
  return value;
}

function unavailableFeedPulse(propertyId: string): PortfolioFeedPulse {
  return { propertyId, mode: 'unavailable', capturedAt: null, source: null };
}

function pulseFromBucket(bucket: PortfolioToolRow, propertyId: string): PortfolioFeedPulse {
  const healthRows = rawObjects(
    bucket.health_rows,
    `staxis_portfolio_feed_pulses@${propertyId}`,
  );
  for (const row of healthRows) {
    if (row.property_id !== propertyId) {
      throw new Error('staxis_portfolio_feed_pulses returned a health row outside its property bucket');
    }
  }
  if (typeof bucket.session_present !== 'boolean'
      || typeof bucket.active_knowledge_present !== 'boolean') {
    throw new Error(`staxis_portfolio_feed_pulses returned malformed legacy state for ${propertyId}`);
  }
  if (bucket.active_knowledge_present && !bucket.session_present) {
    throw new Error(`staxis_portfolio_feed_pulses returned knowledge without a session for ${propertyId}`);
  }
  const snapshotCapturedAt = nullableTimestamp(
    bucket.snapshot_captured_at,
    `staxis_portfolio_feed_pulses@${propertyId}`,
  );
  const sessionReadAt = nullableTimestamp(
    bucket.session_last_successful_read_at,
    `staxis_portfolio_feed_pulses@${propertyId}`,
  );
  const roomStatusSyncedAt = nullableTimestamp(
    bucket.room_status_last_synced_at,
    `staxis_portfolio_feed_pulses@${propertyId}`,
  );
  const parsedHealth = parseFeedHealthRows(healthRows);
  if (parsedHealth.length !== healthRows.length) {
    throw new Error(`staxis_portfolio_feed_pulses returned malformed health for ${propertyId}`);
  }
  const healthStatus = feedStatusFromHealth(parsedHealth);
  if (healthStatus) {
    const capturedAt = nullableTimestamp(
      healthStatus.freshness?.capturedAt ?? null,
      `staxis_portfolio_feed_pulses@${propertyId}`,
    );
    return {
      propertyId,
      mode: 'live',
      capturedAt,
      source: healthStatus.freshness?.source ?? 'none',
    };
  }

  if (!bucket.session_present) {
    return { propertyId, mode: 'manual', capturedAt: null, source: null };
  }
  if (!bucket.active_knowledge_present) {
    return { propertyId, mode: 'onboarding', capturedAt: null, source: null };
  }

  if (snapshotCapturedAt) {
    return { propertyId, mode: 'live', capturedAt: snapshotCapturedAt, source: 'snapshot_capture' };
  }
  if (sessionReadAt) {
    return { propertyId, mode: 'live', capturedAt: sessionReadAt, source: 'session_read' };
  }
  if (roomStatusSyncedAt) {
    return { propertyId, mode: 'live', capturedAt: roomStatusSyncedAt, source: 'room_status_sync' };
  }
  return { propertyId, mode: 'live', capturedAt: null, source: 'none' };
}

async function rowsRpc(
  fn: string,
  organizationId: string,
  propertyIds: readonly string[],
  args: Record<string, unknown>,
): Promise<PortfolioToolRows> {
  const { ids, allowed } = boundedScope(organizationId, propertyIds);
  if (ids.length === 0) {
    return { rowsByPropertyId: new Map(), unavailablePropertyIds: [] };
  }

  const { data, error } = await supabaseAdmin.rpc(fn, {
    p_organization_id: organizationId,
    p_property_ids: ids,
    ...args,
  }) as unknown as RpcResult;
  if (error) throw new Error(`${fn} failed: ${error.message ?? 'unknown database error'}`);

  const buckets = rawObjects(data, fn);
  const rowsByPropertyId = new Map<string, PortfolioToolRow[]>();
  const seenBuckets = new Set<string>();
  for (const bucket of buckets) {
    const propertyId = typeof bucket.property_id === 'string' ? bucket.property_id : null;
    if (!propertyId || !allowed.has(propertyId)) {
      throw new Error(`${fn} crossed the requested property scope`);
    }
    if (seenBuckets.has(propertyId)) {
      throw new Error(`${fn} returned duplicate property buckets`);
    }
    seenBuckets.add(propertyId);
    if (typeof bucket.bucket_available !== 'boolean') {
      throw new Error(`${fn} returned a malformed bucket availability marker`);
    }
    if (!bucket.bucket_available) {
      if (bucket.rows_json !== null) {
        throw new Error(`${fn} returned payload for an unavailable property bucket`);
      }
      continue;
    }
    const rows = rawObjects(bucket.rows_json, `${fn}@${propertyId}`);
    const requestedLimit = args.p_limit_per_property;
    if (typeof requestedLimit !== 'number'
        || rows.length > requestedLimit
        || rows.length > MAX_PORTFOLIO_TOOL_ROWS_PER_HOTEL) {
      throw new Error(`${fn} exceeded its per-property row contract`);
    }
    if (Buffer.byteLength(JSON.stringify(rows)) > MAX_PORTFOLIO_TOOL_BUCKET_BYTES) {
      throw new Error(`${fn} exceeded its per-property byte contract`);
    }
    for (const row of rows) {
      if (row.property_id !== propertyId) {
        throw new Error(`${fn} returned a row outside its property bucket`);
      }
    }
    rowsByPropertyId.set(propertyId, rows);
  }

  return {
    rowsByPropertyId,
    unavailablePropertyIds: ids.filter((id) => !rowsByPropertyId.has(id)),
  };
}

/**
 * One narrow company-intersected read for the portfolio prompt's per-hotel
 * PMS mode and as-of stamp. This intentionally does not populate the hotel
 * feed-status helper's derived dashboard tiles; sharing that partial value with
 * its cache would make a later hotel page lose real tile data for 30 seconds.
 */
export async function readPortfolioFeedPulses(
  organizationId: string,
  propertyIds: readonly string[],
): Promise<PortfolioFeedPulse[]> {
  const { ids, allowed } = boundedScope(organizationId, propertyIds);
  if (ids.length === 0) return [];

  const { data, error } = await supabaseAdmin.rpc('staxis_portfolio_feed_pulses', {
    p_organization_id: organizationId,
    p_property_ids: ids,
  }) as unknown as RpcResult;
  if (error) {
    throw new Error(`staxis_portfolio_feed_pulses failed: ${error.message ?? 'unknown database error'}`);
  }

  const byPropertyId = new Map<string, PortfolioFeedPulse>();
  for (const bucket of rawObjects(data, 'staxis_portfolio_feed_pulses')) {
    const propertyId = typeof bucket.property_id === 'string' ? bucket.property_id : null;
    if (!propertyId || !allowed.has(propertyId)) {
      throw new Error('staxis_portfolio_feed_pulses crossed the requested property scope');
    }
    if (byPropertyId.has(propertyId)) {
      throw new Error('staxis_portfolio_feed_pulses returned duplicate property buckets');
    }
    byPropertyId.set(propertyId, pulseFromBucket(bucket, propertyId));
  }

  // Input order is the receipt order. A missing bucket is a current
  // relationship denial/outage, not evidence that the hotel is manual.
  return ids.map((propertyId) => byPropertyId.get(propertyId) ?? unavailableFeedPulse(propertyId));
}

export async function readPortfolioToolFindings(
  organizationId: string,
  propertyIds: readonly string[],
  statuses: readonly string[],
  limitPerProperty: number,
): Promise<PortfolioToolRows> {
  const result = await rowsRpc('staxis_portfolio_tool_findings', organizationId, propertyIds, {
    p_statuses: [...statuses],
    p_limit_per_property: boundedRowLimit(limitPerProperty),
  });
  assertFindingPolicyRows(result);
  return result;
}
