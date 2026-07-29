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

import { formatAsOfClock, freshnessTier } from '@/lib/pms/feed-status';
import {
  readPortfolioFeedPulses,
  readPortfolioToolFindings,
  type PortfolioFeedPulse,
  type PortfolioToolRow,
} from '@/lib/company/portfolio-tool-reads';
import {
  portfolioHotelFindingPolicyDecision,
  portfolioSectionDecision,
  type PortfolioQueuePolicy,
} from '@/lib/company/portfolio-data-policy';

import {
  type PortfolioHotel,
} from './hotels';
import { safePortfolioName } from './identity';

/** Statuses that mean "this is a live problem at this hotel right now". */
const LIVE_FINDING_STATUSES = ['open', 'updated'] as const;
const MAX_ROWS_PER_HOTEL = 50;

export interface PortfolioHotelPulse {
  propertyId: string;
  name: string | null;
  totalRooms: number | null;
  timezone: string | null;
  /** Open findings (status open/updated), or null when the read failed. */
  openFindings: number | null;
  /** The subset the manager is being asked to decide on (disposition propose). */
  needsDecision: number | null;
  /** True means the visible count is a known minimum, never an all-clear. */
  findingCountLowerBound?: boolean;
  /** Why a null finding count exists. */
  findingMode?: 'available' | 'disabled' | 'unavailable';
  /** ISO capture time of this hotel's PMS numbers; null when it has none. */
  pmsCapturedAt: string | null;
  /** Present ⇔ this is a live-PMS hotel. Absent means manual/onboarding. */
  pmsSource: string | null;
  /** Manual, onboarding and unavailable are distinct operational facts. */
  pmsMode?: 'live' | 'manual' | 'onboarding' | 'unavailable';
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

function cacheKey(
  organizationId: string,
  hotels: readonly PortfolioHotel[],
  omittedHotelCount: number,
  findingPolicy: PortfolioQueuePolicy,
): string {
  const disabled = hotels
    .filter((hotel) => portfolioSectionDecision(findingPolicy, 'staxis', hotel.id) === 'disabled')
    .map((hotel) => hotel.id);
  const unavailable = hotels
    .filter((hotel) => portfolioSectionDecision(findingPolicy, 'staxis', hotel.id) === 'unavailable')
    .map((hotel) => hotel.id);
  return `${organizationId}::${hotels.map((h) => h.id).join(',')}`
    + `::omitted=${omittedHotelCount}`
    + `::policy=${findingPolicy.fingerprint}`
    + `::staxis-disabled=${disabled.join(',')}`
    + `::staxis-unavailable=${unavailable.join(',')}`;
}

export async function buildPortfolioSnapshot(
  organizationId: string,
  hotels: readonly PortfolioHotel[],
  omittedHotelCount: number,
  findingPolicy: PortfolioQueuePolicy,
): Promise<PortfolioSnapshot> {
  const key = cacheKey(organizationId, hotels, omittedHotelCount, findingPolicy);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.snapshot;
  const existing = inflight.get(key);
  if (existing) return existing;

  const pending = buildPortfolioSnapshotUncached(
    organizationId,
    hotels,
    omittedHotelCount,
    findingPolicy,
  )
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
  findingPolicy: PortfolioQueuePolicy,
): Promise<PortfolioSnapshot> {
  const propertyIds = hotels.map((hotel) => hotel.id);
  const findingPropertyIds = propertyIds.filter(
    (propertyId) => portfolioSectionDecision(findingPolicy, 'staxis', propertyId) === 'enabled',
  );
  const findingRead = await readPortfolioToolFindings(
    organizationId,
    findingPropertyIds,
    LIVE_FINDING_STATUSES,
    MAX_ROWS_PER_HOTEL + 1,
  ).catch(() => ({
    rowsByPropertyId: new Map<string, PortfolioToolRow[]>(),
    unavailablePropertyIds: findingPropertyIds,
  }));
  let feedPulses: PortfolioFeedPulse[];
  try {
    feedPulses = await readPortfolioFeedPulses(organizationId, propertyIds);
  } catch {
    feedPulses = propertyIds.map((propertyId) => ({
      propertyId,
      mode: 'unavailable' as const,
      capturedAt: null,
      source: null,
    }));
  }
  const feedByPropertyId = new Map(
    feedPulses.map((pulse) => [pulse.propertyId, pulse]),
  );
  const unavailablePropertyIds = new Set(findingRead.unavailablePropertyIds);
  for (const pulse of feedPulses) {
    if (pulse.mode === 'unavailable') unavailablePropertyIds.add(pulse.propertyId);
  }

  const pulses: PortfolioHotelPulse[] = hotels.map((hotel) => {
    const propertyId = hotel.id;
    const sectionDecision = portfolioSectionDecision(findingPolicy, 'staxis', propertyId);
    const rows = findingRead.rowsByPropertyId.get(propertyId);
    let openFindings: number | null = null;
    let needsDecision: number | null = null;
    let findingCountLowerBound = false;
    if (sectionDecision === 'enabled' && rows) {
      const findingWindowSaturated = rows.length > MAX_ROWS_PER_HOTEL;
      const policyAllowed = rows.slice(0, MAX_ROWS_PER_HOTEL).filter((row) => {
        const finding = findingForSnapshotPolicy(row, propertyId);
        return finding
          ? portfolioHotelFindingPolicyDecision(finding, findingPolicy) === 'allowed'
          : false;
      });
      if (!(findingWindowSaturated && policyAllowed.length === 0)) {
        openFindings = policyAllowed.length;
        const proposed = policyAllowed.filter((row) => row.disposition === 'propose').length;
        needsDecision = findingWindowSaturated && proposed === 0 ? null : proposed;
        findingCountLowerBound = findingWindowSaturated;
      } else {
        unavailablePropertyIds.add(propertyId);
      }
    } else if (sectionDecision === 'unavailable') {
      unavailablePropertyIds.add(propertyId);
    }
    const feed = feedByPropertyId.get(propertyId) ?? {
      propertyId,
      mode: 'unavailable' as const,
      capturedAt: null,
      source: null,
    };
    return {
      propertyId,
      name: hotel.name ?? null,
      totalRooms: hotel.totalRooms ?? null,
      timezone: hotel.timezone ?? null,
      openFindings,
      needsDecision,
      findingCountLowerBound,
      findingMode: sectionDecision === 'disabled'
        ? 'disabled'
        : openFindings === null
          ? 'unavailable'
          : 'available',
      pmsCapturedAt: feed.mode === 'live' ? feed.capturedAt : null,
      pmsSource: feed.mode === 'live' ? feed.source : null,
      pmsMode: feed.mode,
    };
  });

  return {
    organizationId,
    hotels: pulses,
    omittedHotelCount,
    failedHotelCount: unavailablePropertyIds.size,
  };
}

type PolicyFinding = Parameters<typeof portfolioHotelFindingPolicyDecision>[0];

function numeric(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function findingForSnapshotPolicy(
  row: PortfolioToolRow,
  propertyId: string,
): PolicyFinding | null {
  if (row.property_id !== propertyId
      || typeof row.detector_id !== 'string'
      || typeof row.summary !== 'string'
      || !row.evidence
      || typeof row.evidence !== 'object'
      || Array.isArray(row.evidence)) return null;
  const low = numeric(row.price_low_cents);
  const high = numeric(row.price_high_cents);
  const hasPriceMaterial = row.price_low_cents != null
    || row.price_high_cents != null
    || row.price_basis != null;
  return {
    propertyId,
    detectorId: row.detector_id,
    summary: row.summary,
    judgedSummaryEn: typeof row.judged_summary_en === 'string' ? row.judged_summary_en : null,
    judgedSummaryEs: typeof row.judged_summary_es === 'string' ? row.judged_summary_es : null,
    evidence: row.evidence,
    price: hasPriceMaterial
      ? {
          lowCents: low ?? 0,
          highCents: high != null && high > (low ?? 0) ? high : (low ?? 0) + 1,
          currency: typeof row.price_currency === 'string' ? row.price_currency : 'USD',
          basis: typeof row.price_basis === 'string' ? row.price_basis : '',
        }
      : null,
  } as PolicyFinding;
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
    const pmsMode = hotel.pmsMode ?? (hotel.pmsSource ? 'live' : 'manual');
    if (hotel.findingMode === 'disabled') {
      parts.push('Staxis findings are disabled for this hotel — do not describe that as an all-clear');
    } else if (hotel.openFindings === null) {
      parts.push('open items could not be read this turn — do NOT report this hotel as having none');
    } else if (hotel.openFindings === 0) {
      parts.push('no open items');
    } else {
      parts.push(
        `${hotel.findingCountLowerBound ? 'at least ' : ''}${hotel.openFindings} open item${hotel.openFindings === 1 ? '' : 's'}`
        + (hotel.needsDecision ? ` (${hotel.needsDecision} needing a decision)` : ''),
      );
    }

    if (pmsMode === 'live' && hotel.pmsSource) {
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
    } else if (pmsMode === 'manual') {
      parts.push('manual hotel — its Staxis numbers are its own records, not PMS reports');
    } else if (pmsMode === 'onboarding') {
      parts.push('PMS onboarding is not complete — do not describe its room or occupancy numbers as current');
    } else {
      parts.push('PMS feed status could not be read this turn — do not call this a manual hotel');
    }

    lines.push(`- ${name}: ${parts.join('; ')}`);
  }

  if (snapshot.failedHotelCount > 0) {
    lines.push(
      `CAUTION: ${snapshot.failedHotelCount} of this company's hotels could not be read this turn. `
      + 'Say so rather than leaving them out of a ranking silently.',
    );
    lines.push(
      'A shown count is only a known minimum when marked “at least”; never turn an unread, disabled, or bounded hotel into an all-clear.',
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
