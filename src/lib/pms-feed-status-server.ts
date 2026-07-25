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
// A2 (2026-07-24): also resolves `freshness` — WHEN the numbers were captured
// — for live-mode hotels only (fetchFreshness below). Same 30s cache, same
// last-known-good fail-safe.
//
// Fail-safe: ANY error returns NO_PMS_FEED_STATUS — surfaces render exactly
// as today. This layer may only ever ADD honesty, never block data.
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase-admin';
import { propertyLocalToday } from '@/lib/schedule/local-date';
import {
  deriveFeedStatus,
  NO_FRESHNESS,
  NO_PMS_FEED_STATUS,
  type FeedFreshness,
  type FeedGaps,
  type FeedStatusSessionRow,
  type PropertyFeedStatus,
} from '@/lib/pms/feed-status';
import { feedStatusFromHealth, parseFeedHealthRows } from '@/lib/pms/feed-health';

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
  // D4 (2026-07-24) — THE HEARTBEAT SWAP.
  //
  // Freshness is now grounded on "when did this hotel's last PMS report
  // actually arrive" (pms_feed_health_v1, migration 0339) instead of on the
  // 24/7 robot session that stopped writing on ~2026-07-06.
  //
  // The swap is deliberately a FALL-THROUGH, not a replacement:
  //   • a hotel with report expectations configured → the view answers;
  //   • a hotel with NONE → zero rows → we fall through to the legacy
  //     session derivation below, which returns NO_PMS_FEED_STATUS for a
  //     manual / skip-PMS hotel. That fail-safe (mode 'no_pms', every feed
  //     live, countsTrusted true, surfaces render exactly as today) is
  //     load-bearing and MUST survive: treating "no expectation row" as
  //     "unavailable" would neutralise the dashboard and housekeeper board of
  //     every hotel that was never supposed to have PMS data.
  const health = await fetchFeedHealth(propertyId);
  if (health) {
    const derived = await fetchDerived(propertyId, health);
    return { ...health, derived };
  }

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

  const sessionRow: FeedStatusSessionRow = {
    pms_family: session.pms_family as string,
    status: session.status as string,
    last_successful_read_at: (session.last_successful_read_at as string | null) ?? null,
  };
  const status = deriveFeedStatus(sessionRow, knowledge);
  // Freshness is derived ONLY for live-mode hotels. A manual (no_pms) hotel is
  // its own system of record and an onboarding hotel has no numbers yet — for
  // either, an age claim would be a false staleness warning (A2 review).
  if (status.mode !== 'live') return status;

  const [derived, freshness] = await Promise.all([
    fetchDerived(propertyId, status),
    fetchFreshness(propertyId, sessionRow),
  ]);
  return { ...status, derived, freshness };
}

/**
 * D4 — read the ONE definition of feed freshness.
 *
 * Returns null in exactly two cases, and both mean "this view has nothing to
 * say about this hotel, ask the old path":
 *   • the hotel has no report expectations (zero rows) — the manual-hotel
 *     fail-safe described in fetchFeedStatus;
 *   • the query failed — a broken read must never be mistaken for a hotel
 *     with no PMS.
 *
 * A hotel WITH expectations gets its whole status (including `freshness`,
 * source 'heartbeat' — the seam A2 documented in fetchFreshness below) from
 * this one read.
 */
async function fetchFeedHealth(propertyId: string): Promise<PropertyFeedStatus | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('pms_feed_health_v1')
      .select(
        'property_id, feed_key, label, required, target_table, legacy_target, report_type, enabled, ' +
          'cadence_kind, expected_every_minutes, expected_at_local, timezone, grace_minutes, alert_channel, ' +
          'last_report_at, last_delivery_at, last_signal_at, minutes_late, ' +
          'open_quarantine_count, open_unmapped_count, state',
      )
      .eq('property_id', propertyId);
    if (error) throw error;
    return feedStatusFromHealth(parseFeedHealthRows(data));
  } catch (err) {
    // Expected for the window between deploy and the hand-applied migration
    // 0339 (relation does not exist) — the legacy derivation covers it, so
    // this is a note, not an incident.
    console.warn('[pms-feed-status-server] feed-health read failed — using the legacy derivation', {
      propertyId,
      msg: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * A2 — WHEN did this property's PMS numbers get captured?
 *
 * Ordered chain, first hit wins. Each step is a genuinely different signal,
 * and the `source` we return says which one answered so a wrong age can be
 * traced instead of guessed at:
 *
 *   1. D4's per-run ingest heartbeat — THE seam. When the report-email
 *      intake lands, it plugs in here and nothing else in A2 moves. If its
 *      writer only stamps on change, it reports source 'row_change' and the
 *      classifier degrades to 'change_only' rather than inventing confidence.
 *   2. pms_in_house_snapshot.captured_at — PK (property_id), rewritten every
 *      ingest, NOT NULL.
 *   3. property_sessions.last_successful_read_at — already in hand, no query.
 *   4. max(pms_room_status_log.last_synced_at) — a real per-sync stamp for the
 *      room-status feed, which is where the snapshot's room numbers come from.
 *
 * Best-effort throughout: a failed lookup degrades to the next source and
 * ultimately to NO_FRESHNESS ("age unknown"), never to a confident wrong age.
 */
async function fetchFreshness(
  propertyId: string,
  session: FeedStatusSessionRow,
): Promise<FeedFreshness> {
  // (1) D4 ingest heartbeat — WIRED (2026-07-24). It is resolved one level up,
  // in fetchFeedHealth: a hotel with report expectations gets
  // `freshness = { capturedAt: newest report signal, source: 'heartbeat' }`
  // straight off pms_feed_health_v1 and never reaches this function. The chain
  // below is now the LEGACY path — hotels with no expectations configured yet.

  // (2) in-house snapshot capture time.
  try {
    const { data } = await supabaseAdmin
      .from('pms_in_house_snapshot')
      .select('captured_at')
      .eq('property_id', propertyId)
      .maybeSingle();
    const capturedAt = typeof data?.captured_at === 'string' ? data.captured_at : null;
    if (capturedAt) return { capturedAt, source: 'snapshot_capture' };
  } catch {
    /* fall through to the next source */
  }

  // (3) last successful session read — free, already fetched above.
  if (session.last_successful_read_at) {
    return { capturedAt: session.last_successful_read_at, source: 'session_read' };
  }

  // (4) newest room-status sync.
  try {
    const { data } = await supabaseAdmin
      .from('pms_room_status_log')
      .select('last_synced_at')
      .eq('property_id', propertyId)
      .order('last_synced_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const syncedAt = typeof data?.last_synced_at === 'string' ? data.last_synced_at : null;
    if (syncedAt) return { capturedAt: syncedAt, source: 'room_status_sync' };
  } catch {
    /* fall through */
  }

  return NO_FRESHNESS;
}

/**
 * Tile values for feeds whose numbers are trustworthy. Each query is small,
 * indexed, and only runs when its source feed has a real source. Best-effort:
 * a failed derived query degrades that tile to its "—" state, never the whole
 * status.
 *
 * D4: 'stale' counts as a real source. The whole point of the fourth state is
 * that the number came from a genuine report and is merely old — fetching it
 * and letting the surface stamp it "as of 6:40 AM" is the honest render.
 * Gating these queries on 'live' alone would blank the tiles the moment a
 * report ran late, which is the behaviour 'stale' exists to replace.
 */
function hasRealSource(state: PropertyFeedStatus['feeds'][keyof PropertyFeedStatus['feeds']]): boolean {
  return state === 'live' || state === 'stale';
}

async function fetchDerived(
  propertyId: string,
  status: PropertyFeedStatus,
): Promise<NonNullable<PropertyFeedStatus['derived']>> {
  const derived: NonNullable<PropertyFeedStatus['derived']> = {};

  if (hasRealSource(status.feeds.dashboardCounts)) {
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

  if (hasRealSource(status.feeds.arrivals)) {
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
