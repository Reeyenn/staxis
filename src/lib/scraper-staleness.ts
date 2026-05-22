/**
 * Scraper heartbeat staleness classification — extracted from
 * scraper-health/route.ts so the System Status panel and the watchdog
 * cron share one source of truth.
 *
 * Phase E2E (2026-05-22).
 *
 * The thresholds match the existing cron behavior exactly to avoid
 * surprising Reeyen with two different "yellow" definitions across
 * surfaces. If you change a threshold here, update RUNBOOKS.md too.
 */

/** Dashboard pull older than this during business hours = stale. */
export const DASHBOARD_STALE_MIN = 45;

/** Heartbeat older than this = the Node process has stopped ticking. */
export const HEARTBEAT_DEAD_MIN = 20;

export function minutesAgo(date: Date | null, nowMs: number): number | null {
  if (!date) return null;
  return Math.floor((nowMs - date.getTime()) / 60_000);
}

/**
 * Tolerant ISO/Date parsing. Postgres returns timestamptz as ISO strings
 * in JSON responses but unit tests sometimes pass Date instances directly.
 */
export function parseScraperDate(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === 'string') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export type ScraperHeartbeatStatus = 'green' | 'yellow' | 'red';

export interface ScraperHeartbeatClassification {
  status: ScraperHeartbeatStatus;
  /** Minutes since last heartbeat. Null if no heartbeat row found. */
  heartbeatMinutesAgo: number | null;
  /** Minutes since last successful dashboard pull. Null if no pull found. */
  pulledMinutesAgo: number | null;
  /** Human-friendly summary suitable for showing in admin UI. */
  message: string;
}

/**
 * Classify the scraper's freshness given its heartbeat + dashboard rows.
 * Same thresholds the watchdog cron uses (HEARTBEAT_DEAD_MIN = 20,
 * DASHBOARD_STALE_MIN = 45) so the System Status panel matches what
 * Reeyen would see in an SMS alert.
 *
 * Status ladder:
 *   green   — heartbeat fresh AND pull fresh
 *   yellow  — heartbeat fresh but pull is stale (CA pipeline issue)
 *   red     — heartbeat dead (Node process stopped) OR no rows at all
 */
export function classifyScraperHeartbeat(args: {
  heartbeatAt: unknown;
  pulledAt: unknown;
  nowMs?: number;
}): ScraperHeartbeatClassification {
  const nowMs = args.nowMs ?? Date.now();
  const heartbeatAt = parseScraperDate(args.heartbeatAt);
  const pulledAt = parseScraperDate(args.pulledAt);

  const heartbeatMinutesAgo = minutesAgo(heartbeatAt, nowMs);
  const pulledMinutesAgo = minutesAgo(pulledAt, nowMs);

  if (heartbeatAt === null) {
    return {
      status: 'red',
      heartbeatMinutesAgo,
      pulledMinutesAgo,
      message: 'No heartbeat row found — scraper has never reported.',
    };
  }

  if (heartbeatMinutesAgo !== null && heartbeatMinutesAgo > HEARTBEAT_DEAD_MIN) {
    return {
      status: 'red',
      heartbeatMinutesAgo,
      pulledMinutesAgo,
      message: `Scraper heartbeat ${heartbeatMinutesAgo} min stale (>${HEARTBEAT_DEAD_MIN} min) — Node process likely dead.`,
    };
  }

  if (
    pulledAt !== null &&
    pulledMinutesAgo !== null &&
    pulledMinutesAgo > DASHBOARD_STALE_MIN
  ) {
    return {
      status: 'yellow',
      heartbeatMinutesAgo,
      pulledMinutesAgo,
      message: `Heartbeat fresh but PMS pull is ${pulledMinutesAgo} min stale (>${DASHBOARD_STALE_MIN} min).`,
    };
  }

  return {
    status: 'green',
    heartbeatMinutesAgo,
    pulledMinutesAgo,
    message:
      pulledMinutesAgo !== null
        ? `Last pull ${pulledMinutesAgo} min ago.`
        : 'Heartbeat fresh.',
  };
}
