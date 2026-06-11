// ═══════════════════════════════════════════════════════════════════════════
// Rooms — the housekeeping board's data source.
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
//   Live updates: a 6s polling loop drives refreshes for the manager
//   board. CUA polls the PMS every 30s±10s, so 6s on the UI is the right
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
//   - Critical: silent no-op writes (no longer throw — RoomsTab handleToggle
//     has no try/catch); monotonic sequence guard in subscribeViaPolling.
//   - Major (this followup): visibility debounce, 403/404 terminate polling
//     so a permission-revoked session stops hammering the API.
//
// Writes (addRoom / updateRoom / deleteRoom / bulkAddRooms) go through
// POST /api/housekeeping/room-action → applyRoom* helpers in
// src/lib/pms-rooms-writes.ts, which upsert pms_housekeeping_assignments
// AND append pms_room_status_log (source='manual') for the audit trail.
// Server bypasses RLS via supabaseAdmin; the route gates on requireSession
// + property access.
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
        if (myReq <= lastPublishedSeq) return;
        lastPublishedSeq = myReq;
        callback(result.rooms, result.feedStatus);
      })
      .catch(err => {
        // M6 — 403/404 means this session can't read this anymore.
        // Stop polling instead of hammering the API every 6s forever.
        // The UI keeps showing the last good snapshot; the user finding
        // out their access was revoked is a follow-up UI concern.
        if (err instanceof RoomsAccessLostError) {
          logErr(`${channelKey} access lost (${err.statusCode}) — polling stopped`, err);
          stopAll();
          return;
        }
        logErr(channelKey, err);
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
): () => void {
  return subscribeViaPolling(
    `rooms:${pid}:${date}`,
    () => fetchRoomsForDate(pid, date),
    callback,
  );
}

export function subscribeToAllRooms(
  _uid: string, pid: string,
  callback: (rooms: Room[], feedStatus?: PropertyFeedStatus) => void,
): () => void {
  // Compute today INSIDE the doFetch closure so a long-running page that
  // crosses midnight starts asking the API for the new day automatically.
  // (Pre-followup version captured today at subscribe time — locked to
  // yesterday after midnight forever. No callers in the tree today, but
  // the bug was real.)
  return subscribeViaPolling(
    `rooms-all:${pid}`,
    () => fetchRoomsForDate(pid, new Date().toISOString().slice(0, 10)),
    callback,
  );
}

export async function getRoomsForDate(_uid: string, pid: string, date: string): Promise<Room[]> {
  try {
    return (await fetchRoomsForDate(pid, date)).rooms;
  } catch (err) {
    logErr('getRoomsForDate', err);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Write functions — wired into /api/housekeeping/room-action.
// ═══════════════════════════════════════════════════════════════════════════
// All writes go through the server route which uses supabaseAdmin to bypass
// RLS on the new pms_* tables. The route:
//   - validates the session + property access
//   - rate-limits per (user, property)
//   - hands off to pms-rooms-writes helpers that upsert into
//     pms_housekeeping_assignments (and pms_rooms_inventory for adds) AND
//     append pms_room_status_log with source='manual' so the audit trail
//     records every PMS-visible state change.
//
// Errors propagate to callers (RoomsTab.handleToggle) rather than being
// silently swallowed — that was the legacy bug class where writes looked
// successful while RLS filtered the UPDATE to zero rows. RoomsTab's
// handleToggle still needs a try/catch around these calls to avoid
// unhandled promise rejections on hard failures; manager-visible toast
// for the failure case ships in the UI branch.

async function postRoomAction<T>(
  action: 'update' | 'add' | 'delete' | 'bulk-add',
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetchWithAuth('/api/housekeeping/room-action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
  });
  // 207 carries a partial-success body and is acceptable for bulk-add.
  if (!res.ok && res.status !== 207) {
    const text = await res.text().catch(() => '');
    throw new Error(`/api/housekeeping/room-action ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json().catch(() => null)) as
    | { ok?: boolean; data?: T; details?: T; error?: string }
    | null;
  if (json?.ok) return json.data as T;
  if (res.status === 207) return (json?.details ?? json?.data) as T;
  throw new Error(`/api/housekeeping/room-action: ${json?.error ?? 'unknown error'}`);
}

export async function addRoom(_uid: string, pid: string, room: Omit<Room, 'id'>): Promise<string> {
  try {
    const data = await postRoomAction<{ id: string }>('add', { pid, room });
    return data.id;
  } catch (err) {
    logErr('addRoom', err);
    throw err;
  }
}

export async function updateRoom(
  _uid: string, pid: string, rid: string, data: Partial<Room>,
): Promise<void> {
  try {
    await postRoomAction('update', { pid, rid, room: data });
  } catch (err) {
    logErr('updateRoom', err);
    throw err;
  }
}

export async function deleteRoom(_uid: string, pid: string, rid: string): Promise<void> {
  try {
    await postRoomAction('delete', { pid, rid });
  } catch (err) {
    logErr('deleteRoom', err);
    throw err;
  }
}

// Result from a bulk-add — exposed so callers can surface partial failure
// rather than treating 207 (partial success) as full success. Codex
// Major #6 — the legacy void return type hid per-row outcomes.
export interface BulkAddRoomsResult {
  requested: number;
  inventoryInserted: number;
  /** Room numbers whose assignment write failed. Empty on full success. */
  assignmentsFailed: string[];
}

export async function bulkAddRooms(
  _uid: string, pid: string, rooms: Omit<Room, 'id'>[],
): Promise<BulkAddRoomsResult> {
  if (rooms.length === 0) {
    return { requested: 0, inventoryInserted: 0, assignmentsFailed: [] };
  }
  try {
    return await postRoomAction<BulkAddRoomsResult>('bulk-add', { pid, rooms });
  } catch (err) {
    logErr('bulkAddRooms', err);
    throw err;
  }
}
