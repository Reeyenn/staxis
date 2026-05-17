// ═══════════════════════════════════════════════════════════════════════════
// Housekeeper / Laundry staff-facing helpers
//
// These power /housekeeper/[id] and /laundry/[id] — the HK-facing pages
// where one staff member sees only their own assigned rooms (across any
// date, not just today). Previously the pages ran a Firestore
// collectionGroup('rooms') query with where('assignedTo','==',staffId).
// Here we expose the equivalent on top of the `rooms` Postgres table.
// ═══════════════════════════════════════════════════════════════════════════

import type { Room, StaffMember } from '@/types';
import { supabase, logErr, subscribeTable } from './_common';
import { fromRoomRow, fromStaffRow } from '../db-mappers';
import { STAFF_FIELDS } from './staff';

/**
 * Subscribe to every room (across all dates) assigned to a given staff
 * member at a given property. Callback is invoked with the initial
 * snapshot and again on every INSERT/UPDATE/DELETE to `rooms`.
 */
export function subscribeToRoomsForStaff(
  pid: string,
  staffId: string,
  callback: (rooms: Room[]) => void,
): () => void {
  // Initial fetch + refetch-on-change goes through /api/housekeeper/rooms
  // (server-side, service-role) instead of supabase.from('rooms') directly.
  //
  // Why: this helper powers the public /housekeeper/[id] page. Housekeepers
  // open it via SMS link with no Staxis login. The browser supabase client
  // is anon for them, RLS's user_owns_property check returns false, and
  // every SELECT silently returns []. Worked for Maria (signed in) but
  // returned zero rooms for every actual housekeeper — the original
  // 2026-04-30 "no rooms show up" bug. The /api/housekeeper/rooms route
  // bypasses RLS via supabaseAdmin and applies its own capability check
  // (staffId must belong to pid). See route.ts header for the full story.
  //
  // The realtime channel is still subscribed because Maria/admin sessions
  // do receive events and benefit from instant updates. For unauthenticated
  // housekeepers postgres_changes don't fire (RLS blocks the payload), so
  // we ALSO poll every few seconds — that's how a HK on the SMS link sees
  // their own Start/Done tap reflect on the page. Without the poll the UI
  // appeared to revert ("Saving…" → back to "Start") because the state
  // change was happening server-side but no event reached the client.
  const fetchRooms = async (): Promise<Room[]> => {
    const res = await fetch(
      `/api/housekeeper/rooms?pid=${encodeURIComponent(pid)}&staffId=${encodeURIComponent(staffId)}`,
      { method: 'GET', headers: { 'Content-Type': 'application/json' } },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`/api/housekeeper/rooms ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json().catch(() => null)) as
      | { ok?: boolean; data?: unknown; error?: string }
      | null;
    if (!json?.ok || !Array.isArray(json.data)) {
      throw new Error(`/api/housekeeper/rooms unexpected body: ${json?.error ?? 'no data'}`);
    }
    // Server already returned camel-cased Room shape via fromRoomRow().
    return json.data as Room[];
  };

  const unsub = subscribeTable<Room>(
    `rooms-hk:${pid}:${staffId}`,
    'rooms',
    // Single-filter only on realtime — see subscribeToRooms note.
    `property_id=eq.${pid}`,
    fetchRooms,
    callback,
  );

  // Polling fallback for unauthenticated callers. 4s is the sweet spot:
  // fast enough that a tap → server update → UI flip feels nearly
  // immediate, slow enough not to hammer the API. Page-visibility check
  // skips the poll while the tab is backgrounded so a HK leaving the
  // page open all shift doesn't burn requests.
  let cancelled = false;
  const pollInterval = setInterval(() => {
    if (cancelled) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    fetchRooms()
      .then(rows => { if (!cancelled) callback(rows); })
      .catch(err => logErr(`poll rooms-hk:${pid}:${staffId}`, err));
  }, 4000);

  return () => {
    cancelled = true;
    clearInterval(pollInterval);
    unsub();
  };
}

/**
 * Fetch a single staff member by id, scoped to a property.
 * Returns null if not found.
 *
 * NOTE: This goes through the supabase browser client and therefore needs
 * an authenticated session (Maria / admin) to work. The publicly-linkable
 * /housekeeper/[id] page must NOT call this — for unauthenticated housekeepers
 * RLS silently filters the SELECT to zero rows and you get null back. Use
 * `getStaffSelfPublic()` from that page instead.
 */
export async function getStaffMember(pid: string, sid: string): Promise<StaffMember | null> {
  const { data, error } = await supabase
    .from('staff').select(STAFF_FIELDS)
    .eq('property_id', pid).eq('id', sid).maybeSingle<Record<string, unknown>>();
  if (error) { logErr('getStaffMember', error); throw error; }
  return data ? fromStaffRow(data) : null;
}

/**
 * Public-page fetch for the housekeeper's own minimal profile (id, name,
 * language). Routes through /api/housekeeper/me which uses service-role to
 * bypass RLS, so it works from the publicly-linkable /housekeeper/[id]
 * page where the visitor has no Staxis session.
 *
 * Returns null on 404 (staff not on property) or any error — the page just
 * falls back to default language ('en'). Errors are logged for diagnosis
 * but never throw, because failing to load language should not block the
 * room list from rendering.
 */
export async function getStaffSelfPublic(
  pid: string,
  sid: string,
): Promise<{ id: string; name: string; language: 'en' | 'es' | null } | null> {
  try {
    const res = await fetch(
      `/api/housekeeper/me?pid=${encodeURIComponent(pid)}&staffId=${encodeURIComponent(sid)}`,
      { method: 'GET', headers: { 'Content-Type': 'application/json' } },
    );
    if (!res.ok) {
      // 404 = unknown staff; any other status = server error. Either way
      // we just want to return null and let the caller default.
      return null;
    }
    const json = (await res.json().catch(() => null)) as
      | { ok?: boolean; data?: { id: string; name: string; language: 'en' | 'es' | null } }
      | null;
    return json?.ok && json.data ? json.data : null;
  } catch (err) {
    logErr('getStaffSelfPublic', err);
    return null;
  }
}

/**
 * Persist a staff member's language choice (admin / authenticated path).
 *
 * NOTE: Like getStaffMember(), this routes through the browser supabase
 * client and only works when the caller has an auth session that satisfies
 * the staff RLS policy. The publicly-linkable /housekeeper/[id] and
 * /laundry/[id] pages must use `saveStaffLanguagePublic()` below — this
 * one silently no-ops for unauthenticated housekeepers (RLS filters the
 * UPDATE to zero rows but the supabase client returns 200 OK).
 */
export async function saveStaffLanguage(sid: string, language: 'en' | 'es'): Promise<void> {
  const { error } = await supabase.from('staff').update({ language }).eq('id', sid);
  if (error) { logErr('saveStaffLanguage', error); throw error; }
}

/**
 * Public-page write for the housekeeper's language preference. Routes
 * through /api/housekeeper/save-language which uses service-role to
 * bypass RLS, so the toggle on the publicly-linkable /housekeeper/[id]
 * page actually persists. Errors are non-fatal (logged, swallowed) —
 * the local UI state has already updated, and the worst outcome is the
 * preference doesn't carry across sessions.
 */
export async function saveStaffLanguagePublic(
  pid: string,
  sid: string,
  language: 'en' | 'es',
): Promise<void> {
  try {
    const res = await fetch('/api/housekeeper/save-language', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid, staffId: sid, language }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logErr('saveStaffLanguagePublic', new Error(`http ${res.status}: ${body.slice(0, 200)}`));
    }
  } catch (err) {
    logErr('saveStaffLanguagePublic', err);
  }
}
