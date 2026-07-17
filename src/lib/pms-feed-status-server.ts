// ═══════════════════════════════════════════════════════════════════════════
// pms-feed-status-server — server-only lookup: which PMS feeds can this
// property trust right now? (feat/cua-partial-promotion)
//
// Wraps the pure derivation in src/lib/pms/feed-status.ts with the actual
// queries: property_sessions (property → pms_family + connection state) and
// the family's ACTIVE pms_knowledge_files row (actions + feedGaps from the
// signed envelope — READ ONLY; the app never writes envelopes, it can't
// re-sign them). Also fetches the small `derived` tile values that the
// dashboard can't read browser-side (pms_* tables are RLS deny-all-browser;
// the legacy anon read of pms_in_house_snapshot was silently dead — the
// repo's #1 bug class).
//
// Server-only: imports supabaseAdmin. Never import from a client component.
// Delivery to clients:
//   - session UIs → GET /api/pms/feed-status (requireSession)
//   - PUBLIC pages (housekeeper / laundry) → riding their existing rooms /
//     bootstrap responses as a top-level sibling key (ok()'s `extra`)
//
// Fail-safe: ANY error returns NO_PMS_FEED_STATUS — surfaces render exactly
// as today. This layer may only ever ADD honesty, never block data.
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase-admin';
import { propertyLocalToday } from '@/lib/schedule/local-date';
import {
  deriveFeedStatus,
  NO_PMS_FEED_STATUS,
  type FeedGaps,
  type PropertyFeedStatus,
} from '@/lib/pms/feed-status';

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: PropertyFeedStatus }>();

export async function getPropertyFeedStatus(propertyId: string): Promise<PropertyFeedStatus> {
  const hit = cache.get(propertyId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  try {
    const value = await fetchFeedStatus(propertyId);
    cache.set(propertyId, { at: Date.now(), value });
    return value;
  } catch (err) {
    console.warn('[pms-feed-status-server] derivation failed — serving stale/fail-safe', {
      propertyId,
      msg: err instanceof Error ? err.message : String(err),
    });
    // Review-pass fix (fake-empty hunter #9): a transient error must not be
    // indistinguishable from a real manual hotel — the containment value
    // would briefly flip neutral "No data" boards back to confident Dirty
    // for one poll cycle. Serve the last-known-good value (even past TTL)
    // when we have one; NO_PMS only when this property has never resolved.
    if (hit) return hit.value;
    return NO_PMS_FEED_STATUS;
  }
}

async function fetchFeedStatus(propertyId: string): Promise<PropertyFeedStatus> {
  const { data: session, error: sessErr } = await supabaseAdmin
    .from('property_sessions')
    .select('pms_family, status, last_successful_read_at')
    .eq('property_id', propertyId)
    .maybeSingle();
  if (sessErr) throw sessErr;
  if (!session) return NO_PMS_FEED_STATUS;

  const { data: kf, error: kfErr } = await supabaseAdmin
    .from('pms_knowledge_files')
    .select('knowledge')
    .eq('pms_family', session.pms_family as string)
    .eq('status', 'active')
    .is('deleted_at', null)
    .maybeSingle();
  if (kfErr) throw kfErr;

  const knowledge = kf
    ? {
        actions: ((kf.knowledge as Record<string, unknown> | null)?.actions ?? null) as Record<string, unknown> | null,
        feedGaps: ((kf.knowledge as Record<string, unknown> | null)?.feedGaps ?? null) as FeedGaps | null,
      }
    : null;

  const status = deriveFeedStatus(
    {
      pms_family: session.pms_family as string,
      status: session.status as string,
      last_successful_read_at: (session.last_successful_read_at as string | null) ?? null,
    },
    knowledge,
  );
  if (status.mode !== 'live') return status;

  return { ...status, derived: await fetchDerived(propertyId, status) };
}

/**
 * Tile values for feeds whose numbers are trustworthy. Each query is small,
 * indexed, and only runs when its source feed is live. Best-effort: a failed
 * derived query degrades that tile to its "—" state, never the whole status.
 */
async function fetchDerived(
  propertyId: string,
  status: PropertyFeedStatus,
): Promise<NonNullable<PropertyFeedStatus['derived']>> {
  const derived: NonNullable<PropertyFeedStatus['derived']> = {};

  if (status.feeds.dashboardCounts === 'live') {
    try {
      const { data } = await supabaseAdmin
        .from('pms_in_house_snapshot')
        .select('arrivals_remaining_today, departures_remaining_today, total_occupied_rooms')
        .eq('property_id', propertyId)
        .maybeSingle();
      derived.snapshotArrivalsRemaining =
        typeof data?.arrivals_remaining_today === 'number' ? data.arrivals_remaining_today : null;
      derived.snapshotDeparturesRemaining =
        typeof data?.departures_remaining_today === 'number' ? data.departures_remaining_today : null;
      derived.snapshotInHouse =
        typeof data?.total_occupied_rooms === 'number' ? data.total_occupied_rooms : null;
    } catch {
      /* tile degrades to "—" */
    }
  }

  if (status.feeds.arrivals === 'live') {
    try {
      const { data: prop } = await supabaseAdmin
        .from('properties')
        .select('timezone')
        .eq('id', propertyId)
        .maybeSingle();
      const today = propertyLocalToday(new Date(), (prop?.timezone as string | null) ?? 'America/Chicago');
      // Mirrors pms-rooms-server's arrival flag: active stays only —
      // cancelled / no_show / checked_out rows must not inflate the tile.
      const { count } = await supabaseAdmin
        .from('pms_reservations')
        .select('id', { count: 'exact', head: true })
        .eq('property_id', propertyId)
        .eq('arrival_date', today)
        .in('status', ['booked', 'checked_in']);
      if (typeof count === 'number') derived.arrivalsToday = count;
    } catch {
      /* tile degrades to "—" */
    }
  }

  return derived;
}
