import 'server-only';

// ─── The per-turn portfolio snapshot ────────────────────────────────────────
//
// The DYNAMIC half of a portfolio prompt: what is true across the company right
// now, and — the part that matters more — WHEN each hotel's numbers were true.
//
// WHY THIS IS NOT TWENTY HOTEL SNAPSHOTS
// `buildHotelSnapshot` fires ~5 queries per hotel. Twenty hotels would be a
// hundred queries on every keystroke-to-Enter, for numbers the VP did not ask
// for. What a portfolio question actually needs before any tool runs is: which
// hotels exist, whether each one has anything wrong right now, and how old each
// one's PMS numbers are. Everything else is a tool call away.
//
// THE AS-OF LINE IS PER HOTEL, ON PURPOSE
// A portfolio has no single data age. One hotel's reports landed 20 minutes
// ago, another's stopped three days ago, a third is a manual hotel with no
// reports at all. Collapsing that into one "as of" would be the exact dishonesty
// INV-32/33/34 exist to prevent — a fresh-looking number for a hotel that has
// gone dark. So each line carries its own.
//
// CACHE PURITY: every value in here is per-turn, which is why the whole block
// belongs to the DYNAMIC half. Nothing from this module may reach the stable
// block (`portfolio-prompt-assembly.test.ts` and the cache-purity suite both
// police it).

import { getPropertyFeedStatus } from '@/lib/pms-feed-status-server';
import { formatAsOfClock, freshnessTier } from '@/lib/pms/feed-status';

import { forEachHotel, type PortfolioHotel } from './hotels';
import { safePortfolioName } from './identity';

/** How many open findings a hotel's line will summarise. */
const MAX_ROWS_PER_HOTEL = 200;

/** Statuses that mean "this is a live problem at this hotel right now". */
const LIVE_FINDING_STATUSES = ['open', 'updated'] as const;

export interface PortfolioHotelPulse {
  propertyId: string;
  name: string | null;
  totalRooms: number | null;
  timezone: string | null;
  /** Open findings (status open/updated), or null when the read failed. */
  openFindings: number | null;
  /** The subset the manager is being asked to decide on (disposition propose). */
  needsDecision: number | null;
  /** ISO capture time of this hotel's PMS numbers; null when it has none. */
  pmsCapturedAt: string | null;
  /** Present ⇔ this is a live-PMS hotel. Absent means manual/onboarding. */
  pmsSource: string | null;
}

export interface PortfolioSnapshot {
  organizationId: string;
  hotels: PortfolioHotelPulse[];
  /** Hotels covered but not read this turn (the per-turn ceiling). */
  omittedHotelCount: number;
  /** Hotels whose read failed — named as unread, never rendered as quiet. */
  failedHotelCount: number;
}

// 30-second cache, matching `buildHotelSnapshot`'s. A VP firing three questions
// in a minute pays for one portfolio read, and the staleness ceiling is well
// inside the latency of the model's own reply.
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { snapshot: PortfolioSnapshot; expiresAt: number }>();
const inflight = new Map<string, Promise<PortfolioSnapshot>>();

function cacheKey(organizationId: string, hotels: readonly PortfolioHotel[]): string {
  return `${organizationId}::${hotels.map((h) => h.id).join(',')}`;
}

export async function buildPortfolioSnapshot(
  organizationId: string,
  hotels: readonly PortfolioHotel[],
  omittedHotelCount: number,
): Promise<PortfolioSnapshot> {
  const key = cacheKey(organizationId, hotels);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.snapshot;
  const existing = inflight.get(key);
  if (existing) return existing;

  const pending = buildPortfolioSnapshotUncached(organizationId, hotels, omittedHotelCount)
    .then((snapshot) => {
      cache.set(key, { snapshot, expiresAt: Date.now() + CACHE_TTL_MS });
      return snapshot;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, pending);
  return pending;
}

async function buildPortfolioSnapshotUncached(
  organizationId: string,
  hotels: readonly PortfolioHotel[],
  omittedHotelCount: number,
): Promise<PortfolioSnapshot> {
  const byId = new Map(hotels.map((h) => [h.id, h]));

  const { results, failedHotelCount } = await forEachHotel(
    hotels.map((h) => h.id),
    async (db, propertyId) => {
      // Deliberately rows-not-count: the PostgREST `count` header is one more
      // thing to be right about in three clients (live, pglite shim, fake), and
      // an open-findings list at one hotel is tens of rows, not thousands.
      const { data, error } = await db
        .from('findings')
        .select('disposition')
        .in('status', [...LIVE_FINDING_STATUSES])
        .limit(MAX_ROWS_PER_HOTEL) as unknown as {
          data: Array<{ disposition: string | null }> | null;
          error: { message: string } | null;
        };
      if (error) throw new Error(`findings read failed for ${propertyId}: ${error.message}`);
      const rows = data ?? [];
      return {
        openFindings: rows.length,
        needsDecision: rows.filter((r) => r.disposition === 'propose').length,
      };
    },
  );

  const pulses: PortfolioHotelPulse[] = [];
  for (const { propertyId, value } of results) {
    const hotel = byId.get(propertyId);
    let pmsCapturedAt: string | null = null;
    let pmsSource: string | null = null;
    try {
      const status = await getPropertyFeedStatus(propertyId);
      if (status.mode === 'live') {
        pmsSource = status.freshness?.source ?? 'none';
        pmsCapturedAt = status.freshness?.capturedAt ?? null;
      }
    } catch {
      // A hotel whose feed status we cannot read is rendered without an as-of
      // line, which reads as "manual hotel". That is the conservative direction
      // here: it removes a freshness CLAIM rather than inventing one.
    }
    pulses.push({
      propertyId,
      name: hotel?.name ?? null,
      totalRooms: hotel?.totalRooms ?? null,
      timezone: hotel?.timezone ?? null,
      openFindings: value?.openFindings ?? null,
      needsDecision: value?.needsDecision ?? null,
      pmsCapturedAt,
      pmsSource,
    });
  }

  return { organizationId, hotels: pulses, omittedHotelCount, failedHotelCount };
}

/** Test seam: forget every portfolio pulse read so far. */
export function clearPortfolioSnapshotCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * Render the dynamic block.
 *
 * Every number here is stated WITH its hotel and, where the hotel has one, with
 * the moment its PMS numbers were captured. A hotel whose read failed says
 * "could not read" — never 0, which the model would report as a good week.
 */
export function formatPortfolioSnapshotForPrompt(
  snapshot: PortfolioSnapshot,
  now: Date = new Date(),
): string {
  const lines: string[] = ['<staxis-portfolio-snapshot trust="system">'];
  lines.push(
    'Live counts across the portfolio, read just now. Staxis\'s own records '
    + '(open items) are current; each hotel\'s PMS numbers are only as new as its last report.',
  );

  for (const hotel of snapshot.hotels) {
    const name = safePortfolioName(hotel.name) ?? 'Unnamed hotel';
    const parts: string[] = [];
    if (hotel.openFindings === null) {
      parts.push('open items could not be read this turn — do NOT report this hotel as having none');
    } else if (hotel.openFindings === 0) {
      parts.push('no open items');
    } else {
      parts.push(
        `${hotel.openFindings} open item${hotel.openFindings === 1 ? '' : 's'}`
        + (hotel.needsDecision ? ` (${hotel.needsDecision} needing a decision)` : ''),
      );
    }

    if (hotel.pmsSource) {
      const tier = freshnessTier(hotel.pmsCapturedAt, hotel.pmsSource as never, now);
      const clock = hotel.pmsCapturedAt
        ? formatAsOfClock(hotel.pmsCapturedAt, hotel.timezone, now)
        : null;
      if (!clock || tier === 'unknown') {
        parts.push('PMS data age unknown — do not state its room or occupancy numbers as current');
      } else if (tier === 'very_stale') {
        parts.push(`PMS reports last landed ${clock.time} (${clock.zone}), ${clock.age} — the connection looks stuck`);
      } else {
        parts.push(`PMS data as of ${clock.time} (${clock.zone}), ${clock.age}`);
      }
    } else {
      parts.push('manual hotel — its Staxis numbers are its own records, not PMS reports');
    }

    lines.push(`- ${name}: ${parts.join('; ')}`);
  }

  if (snapshot.failedHotelCount > 0) {
    lines.push(
      `CAUTION: ${snapshot.failedHotelCount} of this company's hotels could not be read this turn. `
      + 'Say so rather than leaving them out of a ranking silently.',
    );
  }
  if (snapshot.omittedHotelCount > 0) {
    lines.push(
      `CAUTION: ${snapshot.omittedHotelCount} more hotels in this company are outside this `
      + 'conversation\'s reach. Any ranking you give covers only the hotels listed above.',
    );
  }

  lines.push('</staxis-portfolio-snapshot>');
  return lines.join('\n');
}
