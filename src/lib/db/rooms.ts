// ═══════════════════════════════════════════════════════════════════════════
// Rooms — today's room list, read-only. Consumed by the dashboard.
//
// 2026-05-24 (Plan v4 cutover):
//   The legacy `rooms` table was dropped by migration 0204. The new source
//   of truth is the 15-table `pms_*` schema (migration 0202), written live
//   by the persistent CUA browser per hotel. The pms_* tables are RLS
//   deny-all-browser — the supabase anon / authenticated clients can't
//   read them, and Realtime postgres_changes events can't be delivered
//   to the browser either.
//
//   So the read path now goes:
//     subscribeToRooms (browser)  →  GET /api/housekeeping/rooms
//                                    → mergePmsRoomsForDate() server-side
//                                    → Room[] JSON envelope
//
//   Live updates: a 6s polling loop drives refreshes for the dashboard.
//   CUA polls the PMS every 30s±10s, so 6s on the UI is the right
//   tradeoff between perceived freshness and request volume. The
//   subscribeTable wrapper from _common.ts is intentionally NOT used —
//   it's the right tool when realtime events can fire, which they can't
//   for service-role-only tables. We still mirror its surface: a clean
//   unsubscribe, document.visibilityState gating so backgrounded tabs
//   don't burn requests, and a debounced refetch on visibility return
//   so a foregrounded tab catches up instantly without flooding on
//   rapid tab-switching (M5).
//
// 2026-05-25 (post-merge sweep):
//   - Critical: monotonic sequence guard in subscribeViaPolling.
//   - Major (this followup): visibility debounce, 403/404 terminate polling
//     so a permission-revoked session stops hammering the API.
//
// 2026-07-24 (report-email architecture):
//   READ-ONLY module. The manager Rooms board — the only surface that let a
//   manager flip a room's cleanliness from the whole-hotel grid — was deleted
//   along with its write path (addRoom / updateRoom / POST
//   /api/housekeeping/room-action). The PMS is the source of truth for room
//   status now: a manager-typed status would be silently overwritten by the
//   next report email 30-60 minutes later, so the control was removed rather
//   than left there lying. Room status still changes from the housekeeper's
//   own phone view (POST /api/housekeeper/room-action) and from the agent
//   tools — both real events, not a manager overriding the PMS.
// ═══════════════════════════════════════════════════════════════════════════

import type { Room } from '@/types';
import type { PropertyFeedStatus } from '@/lib/pms/feed-status';
import { logErr } from './_common';
import { fetchWithAuth } from '../api-fetch';
import { toDate } from '../db-mappers';

// 6 seconds — see header comment for the rationale.
const POLL_INTERVAL_MS = 6_000;
// Visibility-change debounce — M5 fix. Below the perceptual threshold for
// "instant update" but wide enough to absorb the typical 50-150ms gap
// between rapid tab switches (cmd-tab through multiple windows).
const VISIBILITY_DEBOUNCE_MS = 300;

// Status codes that terminate the polling subscription. M6 fix.
//   403: user lost property access mid-session (acl change, property removed)
//   404: capability mismatch on (pid, date)
// Both are "this session can't read this anymore — don't keep retrying."
// Other 4xx/5xx are transient and continue polling.
const TERMINAL_HTTP_STATUSES = new Set([403, 404]);

// Custom error so subscribeViaPolling can recognize terminal failures
// without re-parsing the message.
class RoomsAccessLostError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'RoomsAccessLostError';
  }
}

// Re-hydrate JSON dates (ISO strings) back to Date objects so the Room
// type contract is honored for consumers that do `r.startedAt instanceof
// Date`. The server emits Dates via mergePmsRoomsForDate(), but JSON
// stringifies them to ISO; this is the single rehydration point.
function reviveRoomDates(r: Room): Room {
  return {
    ...r,
    ...(r.startedAt !== undefined ? { startedAt: toDate(r.startedAt) } : {}),
    ...(r.completedAt !== undefined ? { completedAt: toDate(r.completedAt) } : {}),
    ...(r.inspectedAt !== undefined ? { inspectedAt: toDate(r.inspectedAt) } : {}),
  };
}

interface RoomsFetchResult {
  rooms: Room[];
  /** feat/cua-partial-promotion — per-feed trust, riding the response as a
   *  top-level sibling of `data` (data itself stays a bare Room[] for stale
   *  bundles). Absent on old server versions or if the lookup failed —
   *  consumers treat absent as "render as today". */
  feedStatus?: PropertyFeedStatus;
}

function parseFeedStatus(raw: unknown): PropertyFeedStatus | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const candidate = raw as PropertyFeedStatus;
  if (candidate.mode !== 'no_pms' && candidate.mode !== 'onboarding' && candidate.mode !== 'live') {
    return undefined;
  }
  if (!candidate.feeds || typeof candidate.feeds !== 'object') return undefined;
  return candidate;
}

async function fetchRoomsForDate(pid: string, date: string): Promise<RoomsFetchResult> {
  const res = await fetchWithAuth(
    `/api/housekeeping/rooms?pid=${encodeURIComponent(pid)}&date=${encodeURIComponent(date)}`,
    { method: 'GET', headers: { 'Content-Type': 'application/json' } },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (TERMINAL_HTTP_STATUSES.has(res.status)) {
      throw new RoomsAccessLostError(
        res.status,
        `/api/housekeeping/rooms ${res.status}: ${body.slice(0, 200)}`,
      );
    }
    throw new Error(`/api/housekeeping/rooms ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json().catch(() => null)) as
    | { ok?: boolean; data?: unknown; feedStatus?: unknown; error?: string }
    | null;
  if (!json?.ok || !Array.isArray(json.data)) {
    throw new Error(`/api/housekeeping/rooms unexpected body: ${json?.error ?? 'no data'}`);
  }
  return {
    rooms: (json.data as Room[]).map(reviveRoomDates),
    feedStatus: parseFeedStatus(json.feedStatus),
  };
}

/**
 * Polling subscription: initial fetch + visibility-aware interval +
 * debounced refetch on tab visibility return. Returns an unsubscribe.
 *
 * Why polling instead of subscribeTable: the underlying pms_* tables are
 * service-role only (RLS deny-all-browser). A postgres_changes channel
 * would error or silently drop every event for the browser caller. We
 * also can't piggyback on a different RLS-permitted table because the
 * CUA worker writes only into the pms_* schema.
 *
 * If a future migration grants authenticated read access to pms_room_status_log
 * / pms_housekeeping_assignments, the right follow-up is to swap this for
 * a subscribeTable() on those tables (driving the same fetchRoomsForDate
 * function as the doFetch loader) and keep the polling as a slower
 * fallback like housekeeper-helpers does.
 */
function subscribeViaPolling(
  channelKey: string,
  doFetch: () => Promise<RoomsFetchResult>,
  callback: (rooms: Room[], feedStatus?: PropertyFeedStatus) => void,
  onError?: (error: unknown) => void,
): () => void {
  let cancelled = false;

  // ── Monotonic sequence guard ───────────────────────────────────────────
  // Post-merge adversarial sweep — every poll fires its own doFetch
  // with no ordering. If poll A starts, poll B starts before A resolves
  // (slow API, visibilitychange burst, 6s tick landing mid-flight), and
  // A resolves AFTER B, we'd publish A's older snapshot on top of B's
  // newer one — UI briefly reverts to stale state. Same sequence guard
  // as legacy subscribeTable in _common.ts: any fetch whose ID is less
  // than the latest published ID is silently discarded.
  let requestSeq = 0;
  let lastPublishedSeq = -1;

  // Visibility-debounce timer (M5).
  let visibilityTimer: ReturnType<typeof setTimeout> | null = null;

  const stopAll = () => {
    cancelled = true;
    if (visibilityTimer !== null) {
      clearTimeout(visibilityTimer);
      visibilityTimer = null;
    }
  };

  const fire = () => {
    if (cancelled) return;
    const myReq = ++requestSeq;
    doFetch()
      .then(result => {
        if (cancelled) return;
        // A newer request owns both success and failure. Without this
        // latest-started check, B could fail visibly and then a slower A
        // success could publish afterward, falsely clearing the stale/error
        // verdict that the newest request established.
        if (myReq !== requestSeq || myReq <= lastPublishedSeq) return;
        lastPublishedSeq = myReq;
        callback(result.rooms, result.feedStatus);
      })
      .catch(err => {
        // A failed older request is irrelevant once a newer poll has started;
        // its successor owns the visible freshness verdict. The newest
        // failure, however, must reach consumers so an initial failure is not
        // misrepresented as an empty room list.
        const ownsLatestRequest = myReq === requestSeq;
        // M6 — 403/404 means this session can't read this anymore.
        // Stop polling instead of hammering the API every 6s forever.
        // Consumers keep a last-good snapshot when one exists, but still get
        // an explicit stale/error signal and retry path.
        if (err instanceof RoomsAccessLostError) {
          logErr(`${channelKey} access lost (${err.statusCode}) — polling stopped`, err);
          // This terminal failure cancels every successor too. Even when an
          // older request discovers the access loss while a newer poll is in
          // flight, the consumer must receive a terminal verdict before we
          // stop; otherwise its first-load state can remain busy forever.
          if (!cancelled) onError?.(err);
          stopAll();
          return;
        }
        logErr(channelKey, err);
        if (ownsLatestRequest && !cancelled) onError?.(err);
      });
  };

  // Initial fetch.
  fire();

  // Polling interval. Skips work when the tab is hidden — saves request
  // volume for the common "manager leaves the page open between tasks"
  // case.
  const pollTimer = setInterval(() => {
    if (cancelled) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    fire();
  }, POLL_INTERVAL_MS);

  // Mobile Safari / phone-wake recovery. M5 fix — debounce so rapid
  // tab-switching doesn't burst the API. Each visibility-change resets
  // the timer; only the final settled-on-visible state triggers a fetch.
  const onVisibility = () => {
    if (cancelled) return;
    if (typeof document === 'undefined' || document.hidden) return;
    if (visibilityTimer !== null) clearTimeout(visibilityTimer);
    visibilityTimer = setTimeout(() => {
      visibilityTimer = null;
      fire();
    }, VISIBILITY_DEBOUNCE_MS);
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }

  return () => {
    stopAll();
    clearInterval(pollTimer);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
  };
}

export function subscribeToRooms(
  _uid: string, pid: string, date: string,
  callback: (rooms: Room[], feedStatus?: PropertyFeedStatus) => void,
  onError?: (error: unknown) => void,
): () => void {
  return subscribeViaPolling(
    `rooms:${pid}:${date}`,
    () => fetchRoomsForDate(pid, date),
    callback,
    onError,
  );
}
