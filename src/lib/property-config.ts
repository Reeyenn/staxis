/**
 * Per-property operational configuration helper.
 *
 * Reads the columns added in migration 0016 — timezone, dashboard staleness,
 * scraper operating window — for a given property. The values used to be
 * hardcoded constants in db.ts and the doctor; now they're per-property
 * with defaults that match the legacy hardcoded values, so single-property
 * (Comfort Suites) behavior is unchanged.
 *
 * Why a small helper instead of inlining a select() at every call site:
 *   - Consistent shape: every caller gets the same object whether the
 *     property exists or not (the FALLBACK below).
 *   - Caching: short-lived in-memory cache so 10 calls in quick succession
 *     hit the DB once. The properties row changes rarely (Maria edits it
 *     in the Settings tab); 60s of staleness is harmless.
 *   - Future-proof: when we add more per-property knobs (shift hours,
 *     wage tiers, etc.) they slot in here and every caller benefits.
 *
 * Cache invalidation: the cache is process-local (Vercel serverless cold
 * starts give us natural eviction). Mario edits these via the admin UI,
 * which invokes a server route — that route should call invalidateConfig(pid)
 * after the update so callers see fresh values without waiting 60s.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';

export interface PropertyOpsConfig {
  pid: string;
  timezone: string;
  dashboardStaleMinutes: number;
  scraperWindowStartHour: number;
  scraperWindowEndHour: number;
}

// Defaults match the legacy hardcoded values for Comfort Suites Beaumont.
// New properties get these on insert (column defaults at the DB layer).
// Used as a last-resort fallback if the property row is missing or the
// query errors — Mario's banners shouldn't go red because of a transient
// read failure.
export const DEFAULT_PROPERTY_OPS_CONFIG: Omit<PropertyOpsConfig, 'pid'> = {
  timezone: 'America/Chicago',
  dashboardStaleMinutes: 25,
  scraperWindowStartHour: 5,
  scraperWindowEndHour: 23,
};

interface CacheEntry {
  config: PropertyOpsConfig;
  expiresAtMs: number;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

// In-flight deduplication (audit/concurrency #10). Multiple concurrent
// requests on the same Vercel instance for the same `pid` used to each
// fire their own SELECT and stampede the cache; now the first miss
// starts a single shared promise that all later callers await.
//
// Multi-instance SLA: each Vercel function instance has its own `cache`
// Map. A write that calls `invalidateConfig(pid)` only clears the
// in-process cache; other instances continue serving stale config for
// up to CACHE_TTL_MS. Acceptable for the fields here (timezone,
// scraper-window hours, dashboard-staleness) because (a) they change
// rarely and (b) a 60-second eventual-consistency window is harmless
// for everything that reads them. If a future field needs tighter SLA,
// move to a cross-instance KV (Upstash) instead of bolting more in-
// memory state on this Map.
const inflight = new Map<string, Promise<PropertyOpsConfig>>();

export function invalidateConfig(pid: string): void {
  cache.delete(pid);
}

/**
 * Fetch the operational config for a property. Falls back to the legacy
 * hardcoded defaults if the row is missing or the read fails — never throws.
 *
 * Use service-role client because some callers (the doctor, cron jobs) run
 * server-side without a user session.
 */
export async function getPropertyOpsConfig(pid: string): Promise<PropertyOpsConfig> {
  if (!pid) {
    return { pid: '', ...DEFAULT_PROPERTY_OPS_CONFIG };
  }
  const cached = cache.get(pid);
  if (cached && cached.expiresAtMs > Date.now()) {
    return cached.config;
  }

  // Coalesce concurrent misses onto a single DB query.
  const existing = inflight.get(pid);
  if (existing) return existing;

  const pending = (async (): Promise<PropertyOpsConfig> => {
    try {
      const { data, error } = await supabaseAdmin
        .from('properties')
        .select('timezone, dashboard_stale_minutes, scraper_window_start_hour, scraper_window_end_hour')
        .eq('id', pid)
        .maybeSingle();

      if (error || !data) {
        // Don't cache failures — next call retries. But return defaults so
        // the UI doesn't break.
        return { pid, ...DEFAULT_PROPERTY_OPS_CONFIG };
      }

      const config: PropertyOpsConfig = {
        pid,
        timezone: (data.timezone as string) || DEFAULT_PROPERTY_OPS_CONFIG.timezone,
        dashboardStaleMinutes:
          typeof data.dashboard_stale_minutes === 'number'
            ? data.dashboard_stale_minutes
            : DEFAULT_PROPERTY_OPS_CONFIG.dashboardStaleMinutes,
        scraperWindowStartHour:
          typeof data.scraper_window_start_hour === 'number'
            ? data.scraper_window_start_hour
            : DEFAULT_PROPERTY_OPS_CONFIG.scraperWindowStartHour,
        scraperWindowEndHour:
          typeof data.scraper_window_end_hour === 'number'
            ? data.scraper_window_end_hour
            : DEFAULT_PROPERTY_OPS_CONFIG.scraperWindowEndHour,
      };

      cache.set(pid, { config, expiresAtMs: Date.now() + CACHE_TTL_MS });
      return config;
    } catch {
      return { pid, ...DEFAULT_PROPERTY_OPS_CONFIG };
    } finally {
      inflight.delete(pid);
    }
  })();

  inflight.set(pid, pending);
  return pending;
}

/**
 * Returns true if the local time at the given timezone is within the
 * scraper's daily operating window. Used by:
 *   - dashboardFreshness() — to suppress "PMS stale" banners overnight.
 *   - the doctor's pull-latency check — to skip false-alarms outside hours.
 *   - the scraper itself — same gate, but on Railway side.
 *
 * Mirrors the scraper's localHour() exactly: same Intl.DateTimeFormat,
 * same hour parsing, same window semantics ([start, end) — start
 * inclusive, end exclusive).
 */
export function isWithinScraperWindow(
  config: Pick<PropertyOpsConfig, 'timezone' | 'scraperWindowStartHour' | 'scraperWindowEndHour'>,
  nowMs: number = Date.now(),
): boolean {
  const localHour = parseInt(
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: config.timezone,
    }).format(new Date(nowMs)),
    10,
  );
  return localHour >= config.scraperWindowStartHour && localHour < config.scraperWindowEndHour;
}
