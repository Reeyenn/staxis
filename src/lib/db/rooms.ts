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
//   don't burn requests, and an immediate refetch on visibility return
//   so a foregrounded tab catches up instantly.
//
// Writes are stubbed (see addRoom etc. below) — write-back into the new
// pms_* schema ships on a separate branch.
// ═══════════════════════════════════════════════════════════════════════════

import type { Room } from '@/types';
import { logErr } from './_common';
import { fetchWithAuth } from '../api-fetch';
import { toDate } from '../db-mappers';

// 6 seconds — see header comment for the rationale.
const POLL_INTERVAL_MS = 6_000;

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

async function fetchRoomsForDate(pid: string, date: string): Promise<Room[]> {
  const res = await fetchWithAuth(
    `/api/housekeeping/rooms?pid=${encodeURIComponent(pid)}&date=${encodeURIComponent(date)}`,
    { method: 'GET', headers: { 'Content-Type': 'application/json' } },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`/api/housekeeping/rooms ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json().catch(() => null)) as
    | { ok?: boolean; data?: unknown; error?: string }
    | null;
  if (!json?.ok || !Array.isArray(json.data)) {
    throw new Error(`/api/housekeeping/rooms unexpected body: ${json?.error ?? 'no data'}`);
  }
  return (json.data as Room[]).map(reviveRoomDates);
}

/**
 * Polling subscription: initial fetch + visibility-aware interval +
 * refetch on tab visibility return. Returns an unsubscribe.
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
  doFetch: () => Promise<Room[]>,
  callback: (rooms: Room[]) => void,
): () => void {
  let cancelled = false;

  const publish = (rows: Room[]) => {
    if (!cancelled) callback(rows);
  };

  const fire = () => {
    if (cancelled) return;
    doFetch()
      .then(publish)
      .catch(err => logErr(channelKey, err));
  };

  // Initial fetch.
  fire();

  // Polling interval. Skips work when the tab is hidden — saves request
  // volume for the common "manager leaves the page open between tasks"
  // case. The visibility listener below catches the foreground return
  // and triggers an immediate refetch so the page is correct as soon as
  // the manager looks at it.
  const pollTimer = setInterval(() => {
    if (cancelled) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    fire();
  }, POLL_INTERVAL_MS);

  // Mobile Safari / phone-wake recovery — analogous to subscribeTable's
  // visibilitychange listener. Fires an immediate refetch the moment the
  // tab returns to the foreground, independent of where we are in the
  // polling cycle.
  const onVisibility = () => {
    if (cancelled) return;
    if (typeof document === 'undefined' || document.hidden) return;
    fire();
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }

  return () => {
    cancelled = true;
    clearInterval(pollTimer);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
  };
}

export function subscribeToRooms(
  _uid: string, pid: string, date: string,
  callback: (rooms: Room[]) => void,
): () => void {
  return subscribeViaPolling(
    `rooms:${pid}:${date}`,
    () => fetchRoomsForDate(pid, date),
    callback,
  );
}

export function subscribeToAllRooms(
  _uid: string, pid: string,
  callback: (rooms: Room[]) => void,
): () => void {
  // The legacy implementation pulled every row across every date for the
  // property. The new schema has no "rows per date" concept — the room
  // status is the latest row in pms_room_status_log, the HK assignment is
  // indexed by date. For "today's view across dates" the only meaningful
  // date is today, so anchor here. Consumers that need a historical scan
  // can call getRoomsForDate with explicit dates.
  const today = new Date().toISOString().slice(0, 10);
  return subscribeViaPolling(
    `rooms-all:${pid}`,
    () => fetchRoomsForDate(pid, today),
    callback,
  );
}

export async function getRoomsForDate(_uid: string, pid: string, date: string): Promise<Room[]> {
  try {
    return await fetchRoomsForDate(pid, date);
  } catch (err) {
    logErr('getRoomsForDate', err);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Write functions — stubbed during the Plan v4 cutover.
// ═══════════════════════════════════════════════════════════════════════════
// These used to update the legacy `rooms` table directly via the supabase
// anon client. That table is dropped (migration 0204). The new write path
// must land status/assignment changes into the appropriate pms_* table(s)
// via a server route using supabaseAdmin — same pattern as the read.
//
// Ships on a separate branch. Callers that hit these in the meantime
// surface a clear "write path not yet wired" error rather than silently
// no-op'ing (which would look like the action worked and then revert on
// the next poll).

function unsupportedWriteError(op: string): Error {
  return new Error(
    `${op}: room writes are not yet wired into the new pms_* schema (Plan v4 cutover in progress). ` +
    `The Rooms tab is read-only against live CUA data on this branch.`,
  );
}

export async function addRoom(_uid: string, _pid: string, _room: Omit<Room, 'id'>): Promise<string> {
  // TODO(plan-v4-writes): land row into pms_housekeeping_assignments
  // (for the date) and emit a pms_room_status_log entry with source='manual'.
  throw unsupportedWriteError('addRoom');
}

export async function updateRoom(_uid: string, _pid: string, _rid: string, _data: Partial<Room>): Promise<void> {
  // TODO(plan-v4-writes): map Room.status changes to a new
  // pms_room_status_log row (source='manual') and map assignment fields
  // into pms_housekeeping_assignments.
  throw unsupportedWriteError('updateRoom');
}

export async function deleteRoom(_uid: string, _pid: string, _rid: string): Promise<void> {
  // TODO(plan-v4-writes): not clear deleteRoom has a meaningful target
  // in the new schema — rooms are sourced from PMS inventory, not
  // user-created. May end up no-op or "remove today's assignment."
  throw unsupportedWriteError('deleteRoom');
}

export async function bulkAddRooms(_uid: string, _pid: string, _rooms: Omit<Room, 'id'>[]): Promise<void> {
  // TODO(plan-v4-writes): batch the addRoom semantics above.
  throw unsupportedWriteError('bulkAddRooms');
}
