/**
 * Shared server-side fetcher for the /api/portfolio/* routes.
 *
 * Fans out per-property tile fetches in parallel via Promise.all, then
 * runs the synchronous aggregator + anomaly detector on the result.
 * Both /tiles and /anomalies call this — the difference is what slice
 * of the bundle the route returns.
 *
 * The function never throws: each per-property fetch is independently
 * wrapped so one property's failure can't take down the whole page.
 */

// NOTE: this file uses supabaseAdmin (server-only). The
// audit-service-role-imports lint script guards against accidental
// client-side imports.
import { supabaseAdmin } from '@/lib/supabase-admin';
import { listAdapters } from './registry';
import { computeModuleAverages, computeSummary } from './aggregator';
import { detectAnomalies } from './anomaly-detector';
import type {
  PortfolioAnomaly,
  PortfolioModuleAverages,
  PortfolioSummary,
  PortfolioTileData,
  PortfolioTileAdapter,
} from './types';

export interface PortfolioSnapshot {
  tiles: PortfolioTileData[];
  averages: PortfolioModuleAverages[];
  anomalies: PortfolioAnomaly[];
  summary: PortfolioSummary;
}

/**
 * Resolve the property ids a given user can access. Accepts an optional
 * `requested` list — when present, the result is the INTERSECTION of
 * requested and accessible. That intersection is the cross-property
 * authorization gate: a caller cannot enumerate IDs they don't own by
 * passing them in the query string.
 */
export async function resolveAccessiblePropertyIds(
  userId: string,
  requested?: ReadonlyArray<string>,
): Promise<string[]> {
  const { data: accountRow, error } = await supabaseAdmin
    .from('accounts')
    .select('role, property_access')
    .eq('data_user_id', userId)
    .maybeSingle();
  if (error || !accountRow) return [];

  const role = String(accountRow.role ?? '');
  const accessArr: string[] = Array.isArray(accountRow.property_access)
    ? (accountRow.property_access as string[])
    : [];
  const isAdmin = role === 'admin' || accessArr.includes('*');

  let accessible: string[];
  if (isAdmin) {
    // Admin → wildcard. Resolve to the actual id list from the table so
    // the downstream tile fetch has a concrete set to iterate.
    const { data: rows } = await supabaseAdmin.from('properties').select('id');
    accessible = (rows as Array<{ id: string }> | null)?.map(r => r.id) ?? [];
  } else {
    accessible = accessArr;
  }
  if (!requested) return accessible;
  const allow = new Set(accessible);
  // Preserve request order — deduplicate while filtering. The page
  // doesn't depend on this order but stable ordering helps with
  // request/response logging and test snapshots.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const pid of requested) {
    if (!allow.has(pid)) continue;
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
  }
  return out;
}

/**
 * Run every registered adapter's `fetchTileData` for every accessible
 * property in parallel. The flat parallelism keeps the slowest single
 * read = total fetch time. For a small portfolio (≤ 10 properties × 1
 * module today) the wall-clock is dominated by Supabase round-trip
 * time, not coordination overhead.
 */
async function fetchTilesForProperties(
  propertyIds: ReadonlyArray<string>,
): Promise<PortfolioTileData[]> {
  const adapters: ReadonlyArray<PortfolioTileAdapter> = listAdapters();
  const jobs: Promise<PortfolioTileData | null>[] = [];
  for (const pid of propertyIds) {
    for (const adapter of adapters) {
      jobs.push(adapter.fetchTileData(pid).catch(() => null));
    }
  }
  const results = await Promise.all(jobs);
  return results.filter((t): t is PortfolioTileData => t !== null);
}

/**
 * Top-level snapshot builder used by /tiles and /anomalies. Filters
 * `propertyIds` to those the caller can access before fanning out.
 */
export async function buildPortfolioSnapshot(
  userId: string,
  requestedPropertyIds?: ReadonlyArray<string>,
): Promise<PortfolioSnapshot> {
  const ids = await resolveAccessiblePropertyIds(userId, requestedPropertyIds);
  if (ids.length === 0) {
    return {
      tiles: [],
      averages: [],
      anomalies: [],
      summary: {
        propertiesCount: 0,
        totalRoomsTurned: 0,
        totalRoomsRemaining: 0,
        totalLaborCostTodayCents: 0,
        totalLaborBudgetTodayCents: 0,
        totalStaffActive: 0,
        totalStaffScheduled: 0,
        anomalyCount: 0,
      },
    };
  }
  const tiles = await fetchTilesForProperties(ids);
  const averages = computeModuleAverages(tiles);
  const anomalies = detectAnomalies(tiles, averages);
  // Add module-specific anomalies via the adapter's own hook (defers
  // when null). The generic detector already runs first; modules
  // optionally supplement.
  for (const adapter of listAdapters()) {
    const avg = averages.find(a => a.module === adapter.moduleId);
    if (!avg) continue;
    for (const t of tiles) {
      if (t.module !== adapter.moduleId) continue;
      const extra = adapter.anomalyFlag(t, avg);
      if (extra === null) continue;
      // detectAnomalies + the adapter's hook would otherwise both return
      // the same set today (the housekeeping adapter just delegates to
      // detectHousekeepingAnomalies). Deduplicate by
      // (propertyId,metric,severity) to avoid double-reporting.
      const key = (a: PortfolioAnomaly) => `${a.propertyId}::${a.metric}::${a.severity}`;
      const seen = new Set(anomalies.map(key));
      for (const a of extra) {
        if (seen.has(key(a))) continue;
        anomalies.push(a);
        seen.add(key(a));
      }
    }
  }
  const summary = computeSummary(tiles, anomalies.length);
  return { tiles, averages, anomalies, summary };
}
