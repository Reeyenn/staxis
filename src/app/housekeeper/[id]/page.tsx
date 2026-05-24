'use client';


export const dynamic = 'force-dynamic';
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  subscribeToRoomsForStaff,
  getStaffSelfPublic,
  saveStaffLanguagePublic,
  bucketStayoverDay,
} from '@/lib/db';
import * as Sentry from '@sentry/nextjs';
import { supabase } from '@/lib/supabase';
import { useTodayStr } from '@/lib/use-today-str';
import type { Room, RoomStatus } from '@/types';
import { format } from 'date-fns';
import { es as esLocale } from 'date-fns/locale';
import { CheckCircle, AlertTriangle } from 'lucide-react';
import { t } from '@/lib/translations';
import type { Language } from '@/lib/translations';
import { SickReportButton } from './SickReportButton';

// Rooms come off Supabase via `subscribeToRoomsForStaff` fully shaped as our
// canonical Room type — no Firestore DocumentReference to carry around.
// Per-room mutations all go through POST /api/housekeeper/room-action
// (server-side, service-role) because RLS silently blocks anon writes
// from this publicly-linkable page. See route.ts header for context.
type RoomRow = Room;

const PRIORITY_SCORE: Record<string, number> = { vip: 0, early: 1, standard: 2 };

/**
 * Order the housekeeper's room list by physical walking path through the
 * building, not by room type or priority.
 *
 * Previously the sort was: type-first (checkouts → stayovers → vacant),
 * then priority, then number. That meant a HK with rooms 416/417/419 (C/O)
 * AND 101/112 (stayovers) saw 416 → 417 → 419 → 101 → 112: walk to floor
 * 4, then come down to floor 1, then back upstairs for the next assignment.
 * They asked for natural numerical order so they can clean a floor at a
 * time and not zig-zag the building.
 *
 * New order: room number ascending. Type and priority become display
 * concerns only — the card colors and badges still highlight VIP / early /
 * stayover, but the LIST order is purely by number. parseInt handles
 * both "101" and "101A" (treats them as 101; tiebreak by raw string).
 */
function sortRooms(rooms: RoomRow[]): RoomRow[] {
  return [...rooms].sort((a, b) => {
    const an = parseInt(a.number, 10);
    const bn = parseInt(b.number, 10);
    // NaN (e.g., "PH" or some non-numeric room label) goes to the end.
    if (Number.isNaN(an) && Number.isNaN(bn)) return a.number.localeCompare(b.number);
    if (Number.isNaN(an)) return 1;
    if (Number.isNaN(bn)) return -1;
    if (an !== bn) return an - bn;
    // Tiebreak on the raw string for things like "101", "101A", "101B".
    return a.number.localeCompare(b.number);
  });
}

export default function HousekeeperRoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: housekeeperId } = React.use(params);
  const searchParams = useSearchParams();
  const uid = searchParams.get('uid');
  const pid = searchParams.get('pid');
  // Reactive: flips at Central midnight so the rooms subscription rolls
  // over to the new day's bucket if the HK leaves the page open between
  // shifts. The housekeeper rarely closes their browser overnight; without
  // this, the next morning's rooms never appear until they hard-refresh.
  const today = useTodayStr();

  // ── Language is LOCAL to this page ──
  // Previously this called the global setLang() from LanguageContext, which
  // writes to localStorage. That meant when Maria (admin) opened any HK's
  // personal link in her browser to test, the whole admin UI flipped to
  // Spanish permanently. We keep a page-scoped lang state here instead and
  // source the initial value from the staff doc (what Maria set in the
  // staff modal) — falling back to the legacy staffPrefs doc for HKs who
  // self-selected via SMS before we wired up the staff-doc write path.
  const [lang, setLang] = useState<Language>('en');

  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [activeDate, setActiveDate] = useState<string>(today);
  // Suppress subscription callbacks that race a manual refetch
  // (audit/concurrency #14). The realtime/poll callback re-fetches the
  // same table; if its SELECT was already in flight before our refetch
  // started, its result can land second and overwrite our fresh state.
  // Track when the most recent refetch was initiated so the subscription
  // callback can drop briefly-stale snapshots.
  const lastRefetchAtRef = useRef<number>(0);
  const [loading, setLoading] = useState(true);
  const [savingRoomId, setSavingRoomId] = useState<string | null>(null);
  const [issueRoomId, setIssueRoomId] = useState<string | null>(null);
  const [issueNote, setIssueNote] = useState('');
  const [savingIssue, setSavingIssue] = useState(false);
  const [savingDnd, setSavingDnd] = useState<string | null>(null);
  const [resettingRoomId, setResettingRoomId] = useState<string | null>(null);

  // ── Shift Start anchor ─────────────────────────────────────────────────
  // 2026-05-07: Maria asked us to remove the per-room Start button — her
  // housekeepers were skipping it, which meant every Done tap got recorded
  // with started_at = completed_at, duration = 0, and the cleaning_events
  // row was auto-discarded (under_3min). The Performance tab went blank
  // on day 2.
  //
  // The fix is two-part:
  //   1. Server-side derives started_at from the previous Done tap by
  //      this housekeeper today (see /api/housekeeper/room-action).
  //   2. For the FIRST room of the day, the housekeeper taps a single
  //      "Start Shift" button at the top of this page. The timestamp is
  //      kept in localStorage (so it survives refresh) and sent along
  //      with each Done tap as `cleaningContext.shiftStartedAt`. Server
  //      uses it as the anchor for room #1 only — subsequent rooms
  //      anchor to the previous Done timestamp.
  //
  // localStorage key: `staxis:shift_start:${pid}:${staffId}:${YYYY-MM-DD}`.
  // Per-day key so yesterday's anchor doesn't bleed into today.
  const shiftStorageKey = pid && housekeeperId ? `staxis:shift_start:${pid}:${housekeeperId}:${today}` : null;
  const [shiftStartedAt, setShiftStartedAt] = useState<string | null>(null);
  const [shiftStarting, setShiftStarting] = useState(false);
  useEffect(() => {
    if (!shiftStorageKey) return;
    try {
      const stored = window.localStorage.getItem(shiftStorageKey);
      if (!stored) {
        setShiftStartedAt(null);
        return;
      }
      // Defensive parse — if localStorage was tampered with or stores a
      // value that's not a valid ISO timestamp, the banner below would
      // crash the entire page on `format(new Date(...), ...)`. Validate
      // before trusting.
      const parsedMs = Date.parse(stored);
      if (!Number.isFinite(parsedMs)) {
        try { window.localStorage.removeItem(shiftStorageKey); } catch {}
        setShiftStartedAt(null);
        return;
      }
      setShiftStartedAt(stored);
    } catch {
      // private mode / quota — ignore, just won't persist across reload
    }
  }, [shiftStorageKey]);
  const handleStartShift = useCallback(() => {
    if (!shiftStorageKey || shiftStarting) return;
    setShiftStarting(true);
    try {
      const stamp = new Date().toISOString();
      try { window.localStorage.setItem(shiftStorageKey, stamp); } catch {}
      setShiftStartedAt(stamp);
    } finally {
      // brief lockout to absorb double-taps
      setTimeout(() => setShiftStarting(false), 600);
    }
  }, [shiftStorageKey, shiftStarting]);

  // ── Online/offline indicator ────────────────────────────────────────────
  // Hotels have notoriously patchy wifi — basement laundry rooms, dead
  // spots between floors, the back stairwell where the AP doesn't reach.
  // navigator.onLine isn't perfect (it only flips for hard NIC-level
  // disconnects, not captive portals) but it catches the common case
  // where wifi just dropped. The banner is persistent, not a toast,
  // because the HK needs to see "you're offline" the entire time it's
  // true, not for 4 seconds.
  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  // ── Action-failed toast ─────────────────────────────────────────────────
  // Mutations like Start/Stop/Finish/DND/Submit Issue used to silently
  // log to console and leave the user in the dark. On the back-office
  // wifi a "Finish Room" tap could fail with no feedback at all — the HK
  // would assume it saved, walk to the next room, and the manager
  // dashboard would still show the previous room as dirty. The toast
  // below surfaces these failures so the HK knows to retry.
  const [actionError, setActionError] = useState<string | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showActionError = useCallback((msg: string) => {
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    setActionError(msg);
    errorTimerRef.current = setTimeout(() => setActionError(null), 4500);
  }, []);
  useEffect(() => () => {
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
  }, []);

  // ── Magic-link consumption ─────────────────────────────────────────────
  // SMS / Schedule-tab links carry an optional credential in the URL. On
  // first mount we exchange that credential for a real Supabase session
  // via verifyOtp. After that, the supabase browser client has a JWT
  // scoped to this staff member, RLS policies match, and postgres_changes
  // payloads start arriving over realtime — meaning Start/Done taps
  // reflect on screen instantly without leaning on the polling fallback.
  //
  // Two URL formats are accepted:
  //   • ?code=<8-char>  — F-NEW-02 / Batch D. The code is opaque; we POST
  //     it to /api/housekeeper/exchange-code which swaps it for the real
  //     hashed_token and returns the token in the JSON body. The token
  //     never appears in any URL or Referer.
  //   • ?token=<hashed_token>  — LEGACY. The hashed_token sits in the URL
  //     directly. Pre-Batch-D format; still accepted for the transition
  //     window while in-flight SMSes drain. Once those are gone (≥1 week
  //     after Batch D deploys) the ?token= branch can be removed.
  //
  // Failure is non-fatal in either path: page still works through the
  // service-role /api/housekeeper/* routes plus polling. Users see no
  // broken UI; they just don't get the realtime upgrade.
  //
  // We strip the credential from the URL after consuming it so a refresh
  // doesn't try to re-verify (both formats are single-use).
  const [authReady, setAuthReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const code = searchParams.get('code');
    const token = searchParams.get('token');
    if (!code && !token) { setAuthReady(true); return; }

    void (async () => {
      // Resolve the hashed_token. ?code= path does a server-side exchange;
      // ?token= path uses the hashed_token directly.
      let hashedToken: string | null = null;

      if (code) {
        try {
          const res = await fetch('/api/housekeeper/exchange-code', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, pid, staffId: housekeeperId }),
          });
          if (res.ok) {
            const json = await res.json().catch(() => null) as { data?: { hashedToken?: string } } | null;
            hashedToken = json?.data?.hashedToken ?? null;
          } else {
            console.warn('[housekeeper] exchange-code failed', res.status);
            Sentry.captureMessage('housekeeper: exchange-code failed', {
              level: 'warning',
              tags: { surface: 'housekeeper-page', reason: 'exchange-code-rejected' },
              extra: { status: res.status, pid, housekeeperId },
            });
          }
        } catch (err) {
          console.warn('[housekeeper] exchange-code threw', err);
          Sentry.captureException(err, {
            tags: { surface: 'housekeeper-page', reason: 'exchange-code-threw' },
            extra: { pid, housekeeperId },
          });
        }
      } else if (token) {
        // Legacy ?token= path — the URL is the hashed_token directly.
        // Codex review of Batch D flagged that this branch had no
        // telemetry — no way to know when the pre-Batch-D in-flight SMSes
        // have drained so we can delete the branch. Fire-and-forget a
        // count event into /api/housekeeper/log-legacy-token; once the
        // app_events count for `auth.legacy_token_redeemed` stays at zero
        // for ~1 week, the legacy branch and the route both come out.
        void fetch('/api/housekeeper/log-legacy-token', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pid, staffId: housekeeperId }),
          // keepalive lets the request complete even if the user navigates
          // away during the verifyOtp step. No await — telemetry never
          // blocks the actual sign-in.
          keepalive: true,
        }).catch(() => {
          // Telemetry is best-effort; silent on error so flaky cellular
          // doesn't surface as a UX bug.
        });
        hashedToken = token;
      }

      if (hashedToken) {
        try {
          const { error } = await supabase.auth.verifyOtp({
            token_hash: hashedToken,
            type: 'magiclink',
          });
          if (error) {
            console.warn('[housekeeper] magic-link consume failed (falling back to anon):', error.message);
            Sentry.captureMessage('housekeeper: magic-link consume failed', {
              level: 'warning',
              tags: { surface: 'housekeeper-page', reason: 'magic-link-rejected' },
              extra: { errorMessage: error.message, pid, housekeeperId },
            });
          }
        } catch (err) {
          console.warn('[housekeeper] magic-link consume threw:', err);
          Sentry.captureException(err, {
            tags: { surface: 'housekeeper-page', reason: 'magic-link-threw' },
            extra: { pid, housekeeperId },
          });
        }
      }

      if (cancelled) return;
      // Strip the credential params from the URL regardless of success —
      // a second consume call will fail anyway, and we don't want either
      // the legacy token or the (already-consumed) code lingering in
      // browser history / Referer headers.
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('token');
        url.searchParams.delete('code');
        window.history.replaceState({}, '', url.pathname + (url.search || ''));
      } catch {
        // ignore — non-DOM environments don't reach this code
      }
      setAuthReady(true);
    })();

    return () => { cancelled = true; };
    // searchParams is intentionally read once on mount — credential
    // consumption is a one-shot. Don't make this re-fire on every URL change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Seed the page language from the staff row on mount.
  // The staff table has a `language` column that Maria sets via the Staff
  // modal (and that this page writes back to when the HK hits the lang
  // toggle). Legacy `staffPrefs/{id}` doc from the Firestore era is gone.
  useEffect(() => {
    if (!housekeeperId || !pid || !authReady) return;
    let cancelled = false;

    void (async () => {
      try {
        // getStaffSelfPublic routes through /api/housekeeper/me which uses
        // service-role to bypass RLS. The previous getStaffMember() call
        // went directly through the supabase browser client and silently
        // returned null for unauthenticated housekeepers — so the page
        // always defaulted to English regardless of what Maria had set.
        const s = await getStaffSelfPublic(pid, housekeeperId);
        if (!cancelled && s && (s.language === 'es' || s.language === 'en')) {
          setLang(s.language);
        }
      } catch (err) {
        console.error('[housekeeper] staff row lang load failed:', err);
      }
    })();

    return () => { cancelled = true; };
  }, [housekeeperId, pid, authReady]);

  useEffect(() => {
    if (!housekeeperId || !pid || !authReady) return;

    // Subscribe to every room assigned to this HK (any date), then pick the
    // right date bucket to display. Previously we always filtered to
    // today — which broke when Maria sent assignments for tomorrow's shift:
    // the rooms existed but the page saw zero matches.
    //
    // Behavior: prefer today's rooms; else nearest upcoming shift; else the
    // most recent past date (so HKs can still see their just-completed shift).
    const unsub = subscribeToRoomsForStaff(pid, housekeeperId, (all) => {
      // Drop callbacks that arrive in the immediate aftermath of a
      // manual refetch (audit/concurrency #14). The subscription's own
      // re-fetch may have started before our refetch and landed second,
      // which would briefly revert the UI to pre-tap state until the
      // next poll. 1500ms covers a typical end-to-end fetch round-trip.
      if (Date.now() - lastRefetchAtRef.current < 1500) return;

      const byDate = new Map<string, RoomRow[]>();
      for (const r of all) {
        if (!r.date) continue;
        const list = byDate.get(r.date) ?? [];
        list.push(r);
        byDate.set(r.date, list);
      }

      let chosenDate = today;
      if (byDate.has(today)) {
        chosenDate = today;
      } else {
        const future = [...byDate.keys()].filter(d => d > today).sort();
        if (future.length > 0) {
          chosenDate = future[0];
        } else {
          const past = [...byDate.keys()].filter(d => d < today).sort().reverse();
          if (past.length > 0) chosenDate = past[0];
        }
      }

      setActiveDate(chosenDate);
      const newRooms = sortRooms(byDate.get(chosenDate) ?? []);
      setRooms(newRooms);

      setLoading(false);
    });

    return () => { unsub(); };
  }, [housekeeperId, pid, today, authReady]);

  // ── Re-entrancy guard ─────────────────────────────────────────────────────
  // Mobile users on slow connections double-tap buttons constantly. Without
  // this, a "Finish Room" tap that takes 8s on 3G triggers a second tap →
  // two updateRoom calls race, completedAt gets overwritten with the wrong
  // timestamp, room status flickers. The setSavingRoomId state already
  // disables the button, but the `disabled` attribute can lag a render
  // behind a fast tap. A ref check is synchronous and bulletproof.
  const inFlightRoomIds = useRef<Set<string>>(new Set());

  // Wrapper that drops re-entrant calls for the same room. Guarantees only
  // one mutation per room is in flight at a time. Survives slow networks
  // and accidental fat-finger double taps.
  const guardRoomAction = useCallback(
    async (roomId: string, action: () => Promise<void>) => {
      if (inFlightRoomIds.current.has(roomId)) return;
      inFlightRoomIds.current.add(roomId);
      try {
        await action();
      } finally {
        inFlightRoomIds.current.delete(roomId);
      }
    },
    [],
  );

  // ── refetchRooms — trigger a fresh /api/housekeeper/rooms pull ─────────
  // 2026-04-28 fix: ALL room mutations from this page MUST go through the
  // server-side /api/housekeeper/room-action route. Direct
  // supabase.from('rooms').update() silently no-ops in production because
  // the housekeeper opens this URL with no auth session — RLS filters the
  // UPDATE to zero rows but Postgres returns 200 OK so the supabase JS
  // client treats it as success. We were silently losing every Done /
  // Reset / DND tap. The API route uses service-role to bypass RLS.
  // Force a fresh rooms fetch after a successful action so the UI flips
  // immediately instead of waiting up to 4s for the polling tick. Anon
  // sessions don't get postgres_changes events, so without this manual
  // refetch the room card visibly reverts ('Saving…' → back to 'Start')
  // even though the database update succeeded — the user only saw the
  // new state by manually refreshing the tab.
  const refetchRooms = useCallback(async () => {
    if (!pid || !housekeeperId) return;
    lastRefetchAtRef.current = Date.now();
    try {
      const res = await fetch(
        `/api/housekeeper/rooms?pid=${encodeURIComponent(pid)}&staffId=${encodeURIComponent(housekeeperId)}`,
      );
      if (!res.ok) return;
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; data?: RoomRow[] }
        | null;
      if (!json?.ok || !Array.isArray(json.data)) return;

      // Same date-bucket selection logic as the subscribe callback.
      const all = json.data;
      const byDate = new Map<string, RoomRow[]>();
      for (const r of all) {
        if (!r.date) continue;
        const list = byDate.get(r.date) ?? [];
        list.push(r);
        byDate.set(r.date, list);
      }
      let chosenDate = today;
      if (byDate.has(today)) {
        chosenDate = today;
      } else {
        const future = [...byDate.keys()].filter(d => d > today).sort();
        if (future.length > 0) {
          chosenDate = future[0];
        } else {
          const past = [...byDate.keys()].filter(d => d < today).sort().reverse();
          if (past.length > 0) chosenDate = past[0];
        }
      }
      setActiveDate(chosenDate);
      setRooms(sortRooms(byDate.get(chosenDate) ?? []));
    } catch (err) {
      console.error('[housekeeper] manual refetch failed:', err);
    }
  }, [pid, housekeeperId, today]);

  const callRoomActionApi = async (
    room: RoomRow,
    action: 'start' | 'finish' | 'reset' | 'stop',
    cleaningContext?: {
      roomNumber: string;
      roomType: 'checkout' | 'stayover';
      stayoverDayBucket: 1 | 2 | null;
      staffName: string;
      date: string;
      startedAt: string;
      completedAt: string;
    },
  ): Promise<{ ok: boolean; error?: string }> => {
    try {
      const r = await fetch('/api/housekeeper/room-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pid,
          staffId: housekeeperId,
          roomId: room.id,
          action,
          cleaningContext,
        }),
      });
      const j = await r.json().catch(() => ({}));
      const ok = r.ok && j?.ok;
      if (ok) {
        // Kick off an immediate refetch so the card updates within a
        // request round-trip instead of waiting for the next 4s poll.
        // We don't await it — the action handler can return as soon as
        // the mutation is confirmed, and the UI will catch up shortly.
        void refetchRooms();
      }
      return ok ? { ok: true } : { ok: false, error: j?.error || `http ${r.status}` };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  };

  // 2026-05-07: handleStartRoom and handleStopRoom were removed when we
  // collapsed the per-room flow to a single Done tap (Maria's request —
  // her HKs were skipping per-room Start, which silently zero-duration'd
  // every cleaning event). The 'start' and 'stop' API actions still exist
  // on the server route for backward compat with any older client bundle
  // that hasn't roll-deployed yet, but nothing in this page calls them.

  // ── Finish room (dirty → clean, single tap) ───────────────────────────────
  // Server-side route does the room update, the cleaning_events audit
  // insert, AND a 90-second dedupe check (network-retry guard) in one
  // shot. See callRoomActionApi() above for the RLS-bypass rationale.
  const handleFinishRoom = async (room: RoomRow) => {
    if (!pid) return;
    await guardRoomAction(room.id, async () => {
      setSavingRoomId(room.id);
      try {
        const completedAt = new Date();
        const isCleanable = room.type === 'checkout' || room.type === 'stayover';
        // 2026-05-07: With per-room Start gone, room.startedAt is always
        // null at this point — the client no longer has the data needed
        // to compute a sensible started_at. The server derives the
        // canonical value from prior cleanings + the shiftStartedAt
        // anchor below; see deriveStartedAtPure in lib/cleaning-event-derivation.
        // We still send startedAt = completedAt for wire-compat with
        // any in-flight requests on older server versions, but the
        // current server ignores it.
        const ctx = isCleanable ? {
          roomNumber: room.number,
          roomType: room.type as 'checkout' | 'stayover',
          stayoverDayBucket: bucketStayoverDay(room.stayoverDay, room.type),
          staffName: room.assignedName || 'Housekeeper',
          date: room.date ?? today,
          startedAt: completedAt.toISOString(), // server-overridden
          completedAt: completedAt.toISOString(),
          // Shift Start anchor for the first Done of the day. Server uses
          // this only when there's no prior cleaning_event by this staff
          // today — subsequent rooms anchor to the previous Done.
          shiftStartedAt: shiftStartedAt ?? undefined,
        } : undefined;
        const res = await callRoomActionApi(room, 'finish', ctx);
        if (!res.ok) {
          console.error('[housekeeper] finish room error:', res.error);
          showActionError(t('hkErrCouldntMarkClean', lang));
        }
      } finally {
        setSavingRoomId(null);
      }
    });
  };

  // ── Toggle DND on a room ────────────────────────────────────────────────────
  const handleToggleDnd = async (room: RoomRow) => {
    if (!pid) return;
    await guardRoomAction(room.id, async () => {
      setSavingDnd(room.id);
      try {
        const newDnd = !room.isDnd;
        const dndNote = newDnd
          ? `Marked DND by housekeeper at ${new Date().toLocaleTimeString()}`
          : undefined;
        const res = await fetch('/api/housekeeper/room-action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pid,
            staffId: housekeeperId,
            roomId: room.id,
            action: newDnd ? 'dnd_on' : 'dnd_off',
            dndNote,
          }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j?.ok) {
          console.error('[housekeeper] toggle DND error:', j?.error || res.status);
          showActionError(t('hkErrCouldntToggleDnd', lang));
        }
      } finally {
        setSavingDnd(null);
      }
    });
  };

  // ── Report Issue ───────────────────────────────────────────────────────────
  const handleSubmitIssue = async () => {
    if (!issueRoomId || !issueNote.trim()) return;
    if (!pid) return;
    setSavingIssue(true);
    const room = rooms.find(r => r.id === issueRoomId);
    if (!room) {
      console.error('[housekeeper] submit issue: room not found', issueRoomId);
      setSavingIssue(false);
      return;
    }
    try {
      const r = await fetch('/api/housekeeper/room-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pid,
          staffId: housekeeperId,
          roomId: room.id,
          action: 'issue',
          issueNote: issueNote.trim(),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) {
        throw new Error(j?.error || `http ${r.status}`);
      }
      setIssueRoomId(null);
      setIssueNote('');
    } catch (err) {
      console.error('[housekeeper] submit issue error:', err);
      showActionError(t('hkErrCouldntSaveIssue', lang));
    } finally {
      setSavingIssue(false);
    }
  };

  // ── Reset room (clean/inspected → dirty, clear times) ─────────────────────
  // The server-side route also discards the most recent non-discarded
  // cleaning_event for this (HK, room, date) — the "oops, wrong room —
  // undo" path. The 60-second wall-clock cutoff was removed 2026-05-07;
  // Reset is now an explicit user action and respects whatever the user
  // wants to undo regardless of timing.
  const handleResetRoom = async (room: RoomRow) => {
    if (!pid) return;
    setResettingRoomId(room.id);
    try {
      const res = await callRoomActionApi(room, 'reset');
      if (!res.ok) {
        console.error('[housekeeper] reset room error:', res.error);
        showActionError(t('hkErrCouldntResetRoom', lang));
      }
    } finally {
      setResettingRoomId(null);
    }
  };

  // ── Derived state ──────────────────────────────────────────────────────────
  const housekeeperName = rooms[0]?.assignedName ?? '';
  const firstName = housekeeperName.split(' ')[0] || 'Housekeeper';
  const total = rooms.length;
  const done = rooms.filter(r => r.status === 'clean' || r.status === 'inspected' || r.isDnd).length;
  const inProgress = rooms.filter(r => r.status === 'in_progress').length;
  const dndCount = rooms.filter(r => r.isDnd && r.status !== 'clean' && r.status !== 'inspected').length;
  const allDone = total > 0 && done === total;
  const progressPct = total > 0 ? Math.round((done / total) * 100) : 0;

  // Missing pid means the SMS/shared link was mangled or hand-typed without
  // the ?pid=... query string. Without this guard the useEffect above returns
  // early, never calls setLoading(false), and the spinner runs forever —
  // which on a housekeeper's phone reads as "the app is broken." Render a
  // concrete error instead so they can flag it to Maria.
  if (!pid || !housekeeperId) {
    return (
      <div style={{
        minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: '12px', padding: '24px',
        background: 'var(--bg)', fontFamily: 'var(--font-sans, system-ui, -apple-system, sans-serif)',
        textAlign: 'center',
      }}>
        <AlertTriangle size={32} color="var(--red, #EF4444)" />
        <p style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
          {t('cxIncompleteLink', lang)}
        </p>
        <p style={{ fontSize: '14px', color: 'var(--text-muted)', maxWidth: '320px', margin: 0 }}>
          {t('cxIncompleteLinkHelp', lang)}
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{
        minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: '12px',
        background: 'var(--bg)', fontFamily: 'var(--font-sans, system-ui, -apple-system, sans-serif)',
      }}>
        <div style={{
          width: '32px', height: '32px', border: '4px solid var(--border)',
          borderTopColor: 'var(--green)', borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
        }} />
        <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>
          {t('loadingRooms', lang)}
        </p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return (
    <div style={{
      minHeight: '100dvh', background: 'var(--green-bg, #F0FDF4)',
      fontFamily: 'var(--font-sans, system-ui, -apple-system, BlinkMacSystemFont, sans-serif)',
    }}>
    {/* ── Persistent offline banner ── */}
    {!isOnline && (
      <div
        role="status"
        aria-live="polite"
        style={{
          position: 'fixed',
          top: 'env(safe-area-inset-top, 0px)',
          left: 0,
          right: 0,
          zIndex: 999,
          background: '#1F2937',
          color: '#FBBF24',
          padding: '8px 16px',
          fontSize: '13px',
          fontWeight: 600,
          textAlign: 'center',
          letterSpacing: '0.01em',
        }}
      >
        {t('hkOffline', lang)}
      </div>
    )}

    {/* ── Action-failed toast ── */}
    {/* Sits at the top of the viewport; auto-dismisses after 4.5s. We use
        position:fixed so it doesn't shift the layout, and a large red
        background so a HK in a dim room can still tell something went
        wrong. role=alert announces it to screen readers. */}
    {actionError && (
      <div
        role="alert"
        aria-live="assertive"
        style={{
          position: 'fixed',
          top: 'env(safe-area-inset-top, 12px)',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 1000,
          maxWidth: 'calc(100vw - 24px)',
          width: '440px',
          background: '#DC2626',
          color: 'white',
          padding: '12px 16px',
          borderRadius: '12px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
          fontSize: '14px',
          fontWeight: 600,
          lineHeight: 1.35,
          display: 'flex',
          alignItems: 'flex-start',
          gap: '10px',
        }}
      >
        <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: '1px' }} />
        <span style={{ flex: 1 }}>{actionError}</span>
      </div>
    )}
    <div style={{
      maxWidth: '768px',
      margin: '0 auto',
      minHeight: '100dvh',
      background: 'var(--green-bg, #F0FDF4)',
    }}>

      {/* ── Header ── */}
      <div style={{ background: 'linear-gradient(135deg, var(--navy, #0F172A) 0%, var(--navy-light, #2563EB) 100%)', padding: '20px 16px 28px', color: 'white' }}>
        <p style={{
          fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em',
          textTransform: 'uppercase', opacity: 0.55, marginBottom: '6px',
        }}>
          Staxis
        </p>

        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
          <div>
            <h1 style={{ fontSize: '20px', fontWeight: 800, letterSpacing: '-0.02em', marginBottom: '2px', lineHeight: 1.1 }}>
              {`${t('cxHelloPrefix', lang)}, ${firstName}`}
            </h1>
            <p style={{ fontSize: '12px', opacity: 0.7, fontWeight: 500 }}>
              {(() => {
                // Parse activeDate as local-time midnight (avoids the UTC-shift
                // "Saturday Apr 18" getting rendered as "Friday Apr 17" on clients
                // west of UTC).
                const [y, m, d] = activeDate.split('-').map(Number);
                const dateObj = new Date(y, (m ?? 1) - 1, d ?? 1);
                const formatted = format(dateObj, 'EEEE, MMMM d', { locale: lang === 'es' ? esLocale : undefined });
                if (activeDate === today) return formatted;
                // Different date — add a label so HK knows they're looking at a
                // future (or past) shift.
                return activeDate > today
                  ? `${t('hkNextShiftPrefix', lang)}${formatted}`
                  : `${t('hkLastShiftPrefix', lang)}${formatted}`;
              })()}
            </p>
          </div>

          <button
            onClick={async () => {
              const next: Language = lang === 'en' ? 'es' : 'en';
              setLang(next);
              // Persist to the staff row so Maria's staff modal stays in
              // sync with whatever this HK picked. Best-effort; silent on
              // failure since the UI already updated locally.
              if (housekeeperId && pid) {
                // Goes through /api/housekeeper/save-language (service-role)
                // because the public page has no auth session. The previous
                // direct-supabase write silently no-op'd on RLS for every
                // unauthenticated HK — toggle worked locally, never persisted.
                try {
                  await saveStaffLanguagePublic(pid, housekeeperId, next);
                } catch (err) {
                  console.error('[housekeeper] lang persist failed:', err);
                }
              }
            }}
            style={{
              background: 'rgba(255,255,255,0.18)',
              border: '1.5px solid rgba(255,255,255,0.35)',
              borderRadius: '12px', color: 'white',
              fontWeight: 700, fontSize: '14px',
              padding: '10px 16px', cursor: 'pointer',
              letterSpacing: '0.05em', flexShrink: 0,
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            {lang === 'en' ? 'ES' : 'EN'}
          </button>
        </div>

        {/* Progress bar */}
        {total > 0 && (
          <div style={{ marginTop: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
              <span style={{ fontSize: '14px', fontWeight: 600 }}>
                {`${done} ${t('lndProgressOf', lang)} ${total} ${t('lndProgressDone', lang)}`
                  + (dndCount > 0 ? ` · ${dndCount} DND` : '')
                  + (inProgress > 0 ? ` · ${inProgress} ${t('inProgress', lang).toLowerCase()}` : '')}
              </span>
              <span style={{ fontSize: '14px', fontWeight: 700, opacity: 0.9 }}>
                {progressPct}%
              </span>
            </div>
            <div style={{
              height: '10px', background: 'rgba(255,255,255,0.2)',
              borderRadius: '99px', overflow: 'hidden',
            }}>
              <div style={{
                height: '100%', width: `${progressPct}%`,
                background: progressPct === 100 ? 'var(--green)' : 'var(--green-light, #86EFAC)',
                borderRadius: '99px',
                transition: 'width 500ms cubic-bezier(0.4,0,0.2,1)',
              }} />
            </div>
          </div>
        )}
      </div>

      {/* ── Room list ── */}
      <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>

        {/* ── Shift Start ──────────────────────────────────────────────────
            One tap at the start of the day. The timestamp is the anchor for
            the FIRST room's started_at — every subsequent room anchors to
            the previous Done. See server's deriveStartedAt for the
            derivation logic. localStorage-backed so it survives reload. */}
        {total > 0 && !allDone && !shiftStartedAt && (
          <button
            onClick={handleStartShift}
            disabled={shiftStarting}
            style={{
              width: '100%',
              height: '64px',
              border: 'none',
              borderRadius: '14px',
              background: 'var(--green, #006565)',
              color: 'white',
              fontSize: '18px',
              fontWeight: 700,
              cursor: shiftStarting ? 'not-allowed' : 'pointer',
              opacity: shiftStarting ? 0.6 : 1,
              letterSpacing: '0.02em',
              WebkitTapHighlightColor: 'transparent',
              touchAction: 'manipulation',
              boxShadow: '0 2px 8px rgba(0,101,101,0.18)',
              marginBottom: '4px',
            }}
          >
            {shiftStarting
              ? '...'
              : t('hkStartShift', lang)}
          </button>
        )}
        {shiftStartedAt && total > 0 && !allDone && (
          <div style={{
            padding: '10px 14px',
            background: 'var(--green-dim, #DCFCE7)',
            borderRadius: '10px',
            fontSize: '13px',
            fontWeight: 600,
            color: 'var(--green, #006565)',
            textAlign: 'center',
            marginBottom: '4px',
          }}>
            {t('hkShiftStarted', lang)} · {format(new Date(shiftStartedAt), 'h:mm a', lang === 'es' ? { locale: esLocale } : undefined)}
          </div>
        )}

        {/* Sick / callout entry — feature #6. Only render when we have the
            URL ids (pid + housekeeperId) AND the housekeeper actually has
            rooms today. Mid-shift detection uses inProgress > 0 to swap
            the button label and surface the timing picker. */}
        {pid && housekeeperId && total > 0 && !allDone && (
          <SickReportButton
            pid={pid}
            staffId={housekeeperId}
            businessDate={activeDate}
            language={lang}
            isMidShift={inProgress > 0}
            onCalloutChange={() => { lastRefetchAtRef.current = Date.now(); }}
          />
        )}

        {allDone && (
          <div style={{
            textAlign: 'center', padding: '32px 24px', background: 'white',
            borderRadius: '20px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
            marginBottom: '4px',
          }}>
            <div style={{
              width: '64px', height: '64px', borderRadius: '50%',
              background: 'var(--green-dim)', display: 'flex', alignItems: 'center',
              justifyContent: 'center', margin: '0 auto 14px',
            }}>
              <CheckCircle size={32} color="var(--green)" />
            </div>
            <h2 style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '6px' }}>
              {t('allDone', lang)}
            </h2>
            <p style={{ fontSize: '14px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              {`${t('cxGreatWorkToday', lang)}, ${firstName}! 🎉`}
            </p>
          </div>
        )}

        {total === 0 ? (
          <div style={{
            textAlign: 'center', padding: '64px 24px', background: 'white',
            borderRadius: '20px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
          }}>
            <p style={{ fontSize: '16px', color: 'var(--text-muted)', lineHeight: 1.8 }}>
              <><strong>{t('noRoomsAssigned', lang)}</strong><br />{t('checkBackSoon', lang)}</>
            </p>
          </div>
        ) : (
          rooms.map((room, idx) => (
            <RoomCard
              key={room.id}
              room={room}
              lang={lang}
              index={idx + 1}
              isSaving={savingRoomId === room.id}
              isSavingDnd={savingDnd === room.id}
              onFinish={() => handleFinishRoom(room)}
              onReset={() => handleResetRoom(room)}
              isResetting={resettingRoomId === room.id}
              onReportIssue={() => {
                setIssueRoomId(room.id);
                setIssueNote((room as Room & { issueNote?: string }).issueNote ?? '');
              }}
              onToggleDnd={() => handleToggleDnd(room)}
            />
          ))
        )}
      </div>

      {/* ── Report Issue modal ── */}
      {issueRoomId && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(0,0,0,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '16px',
            zIndex: 200,
          }}
          onClick={e => {
            if (e.target === e.currentTarget) {
              setIssueRoomId(null);
              setIssueNote('');
            }
          }}
        >
          <div style={{
            width: '100%', maxWidth: '420px', background: 'white',
            borderRadius: '20px',
            padding: '24px 20px',
          }}>
            <h3 style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>
              {t('reportIssue', lang)}
            </h3>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '16px' }}>
              {t('hkRoomShort', lang)} {rooms.find(r => r.id === issueRoomId)?.number}
            </p>
            <textarea
               
              autoFocus
              placeholder={t('describeIssue', lang)}
              value={issueNote}
              onChange={e => setIssueNote(e.target.value)}
              rows={4}
              style={{
                width: '100%', padding: '14px', boxSizing: 'border-box',
                border: '1.5px solid var(--border)', borderRadius: '12px',
                fontSize: '16px', fontFamily: 'inherit',
                resize: 'none', outline: 'none', lineHeight: 1.5,
              }}
              onFocus={e => { e.target.style.borderColor = 'var(--green-dark, #166534)'; }}
              onBlur={e => { e.target.style.borderColor = 'var(--border)'; }}
            />
            <div style={{ display: 'flex', gap: '10px', marginTop: '14px' }}>
              <button
                onClick={() => { setIssueRoomId(null); setIssueNote(''); }}
                style={{
                  flex: 1, height: '56px', background: 'var(--bg-elevated, #F3F4F6)', border: 'none',
                  borderRadius: '12px', fontSize: '17px', fontWeight: 600,
                  color: 'var(--text-secondary)', cursor: 'pointer',
                  WebkitTapHighlightColor: 'transparent',
                }}
              >
                {t('cancel', lang)}
              </button>
              <button
                onClick={handleSubmitIssue}
                disabled={!issueNote.trim() || savingIssue}
                style={{
                  flex: 1, height: '56px', border: 'none', borderRadius: '12px',
                  fontSize: '17px', fontWeight: 600,
                  cursor: !issueNote.trim() || savingIssue ? 'not-allowed' : 'pointer',
                  background: !issueNote.trim() || savingIssue ? 'var(--border)' : 'var(--green-dark, #166534)',
                  color: !issueNote.trim() || savingIssue ? 'var(--text-muted)' : 'white',
                  transition: 'background 150ms ease',
                  WebkitTapHighlightColor: 'transparent',
                }}
              >
                {savingIssue
                  ? t('savingDots', lang)
                  : t('submit', lang)}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   RoomCard
   States:
     • dirty:       "Start" button (blue)
     • in_progress: "Hold to Finish" button (green, hold-to-confirm)
     • clean/inspected: green "Done ✓" pill
   ───────────────────────────────────────────────────────────────────────── */
function RoomCard({
  room,
  lang,
  index,
  isSaving,
  isSavingDnd,
  onFinish,
  onReset,
  isResetting,
  onReportIssue,
  onToggleDnd,
}: {
  room: RoomRow;
  lang: Language;
  index: number;
  isSaving: boolean;
  isSavingDnd: boolean;
  onFinish: () => void;
  onReset: () => void;
  isResetting: boolean;
  onReportIssue: () => void;
  onToggleDnd: () => void;
}) {
  const isDone = room.status === 'clean' || room.status === 'inspected';
  const isInProgress = room.status === 'in_progress';

  const typeLabel =
    room.type === 'checkout' ? t('hkTypeCheckout', lang)
    : room.type === 'stayover' ? t('hkTypeStayover', lang)
    : t('hkTypeVacant', lang);

  const accentColor =
    isDone ? 'var(--green)'
    : isInProgress ? 'var(--navy-light, #2563EB)'
    : room.priority === 'vip' ? 'var(--red)'
    : room.priority === 'early' ? 'var(--orange, #EA580C)'
    : 'var(--border)';

  const cardBg = isDone ? 'var(--green-bg, #F0FDF4)' : isInProgress ? 'var(--blue-dim, #EFF6FF)' : 'white';
  const cardBorder = isDone ? 'var(--green-light, #86EFAC)' : isInProgress ? 'var(--blue-light, #93C5FD)' : 'var(--border-light, #E5E7EB)';

  return (
    <div style={{
      background: cardBg,
      border: `2px solid ${cardBorder}`,
      borderLeft: `6px solid ${accentColor}`,
      borderRadius: '16px',
      padding: '16px',
      transition: 'background 300ms ease, border-color 300ms ease',
      boxShadow: isDone ? 'none' : '0 1px 6px rgba(0,0,0,0.07)',
    }}>

      {/* DND banner — only show when in-progress, dirty+DND uses the action area instead */}
      {room.isDnd && isInProgress && (
        <div style={{
          background: 'var(--gray-dim, #F3F4F6)', color: 'var(--text-secondary, #4B5563)',
          padding: '10px 14px', borderRadius: '10px',
          fontSize: '14px', fontWeight: 700, marginBottom: '12px',
          border: '1.5px solid var(--border-light, #E5E7EB)',
        }}>
          {`🚫 ${t('doNotDisturb', lang)}`}
        </div>
      )}

      {/* Top row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
        <span style={{
          fontSize: '13px', fontWeight: 700,
          color: isDone ? 'var(--green)' : isInProgress ? 'var(--navy-light, #2563EB)' : 'var(--text-muted)',
          minWidth: '18px', lineHeight: 1, flexShrink: 0,
        }}>
          {index}.
        </span>

        <span style={{
          fontFamily: 'ui-monospace, monospace', fontWeight: 800, fontSize: '34px',
          color: isDone ? 'var(--green)' : isInProgress ? 'var(--navy-light, #2563EB)' : 'var(--text-primary)',
          letterSpacing: '-0.02em', lineHeight: 1,
        }}>
          {room.number}
        </span>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
          <span style={{
            fontSize: '11px', fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '0.07em',
            color: isDone ? 'var(--green)' : isInProgress ? 'var(--navy-light, #2563EB)' : 'var(--text-secondary)',
          }}>
            {isInProgress
              ? `⟳ ${t('inProgress', lang)}`
              : typeLabel}
          </span>
          {room.priority === 'vip' && !isDone && !isInProgress && (
            <span style={{
              fontSize: '11px', fontWeight: 700, color: 'var(--red)',
              background: 'var(--red-dim)', padding: '2px 7px', borderRadius: '5px',
              display: 'inline-block', width: 'fit-content',
            }}>
              ★ VIP
            </span>
          )}
          {room.priority === 'early' && !isDone && !isInProgress && (
            <span style={{
              fontSize: '11px', fontWeight: 700, color: 'var(--orange, #EA580C)',
              background: 'var(--orange-dim, #FFF7ED)', padding: '2px 7px', borderRadius: '5px',
              display: 'inline-block', width: 'fit-content',
            }}>
              ⚡ {t('earlyCheckin', lang)}
            </span>
          )}
          {/* Show startedAt time when in progress */}
          {isInProgress && room.startedAt && (
            <span style={{ fontSize: '11px', color: 'var(--navy-light, #2563EB)', fontWeight: 600 }}>
              {t('start', lang)}: {format(new Date(room.startedAt), 'h:mm a')}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
          {/* DND toggle button — hide when done, when dirty+DND (action area handles it), and when in-progress (can't DND a started room) */}
          {/* min 44x44 tap target per Apple HIG / Android guidelines.
              touch-action: manipulation suppresses iOS double-tap zoom
              on rapid taps so a HK with wet hands doesn't accidentally
              zoom the page when reaching for DND. */}
          {!isDone && !isInProgress && !room.isDnd && (
            <button
              onClick={onToggleDnd}
              disabled={isSavingDnd}
              style={{
                minHeight: '44px',
                minWidth: '44px',
                padding: '0 12px',
                border: `1.5px solid var(--border-light, #E5E7EB)`,
                borderRadius: '10px',
                background: 'transparent',
                cursor: isSavingDnd ? 'not-allowed' : 'pointer',
                flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px',
                opacity: isSavingDnd ? 0.4 : 0.6,
                WebkitTapHighlightColor: 'transparent',
                touchAction: 'manipulation',
                transition: 'all 150ms ease',
              }}
              aria-label={room.isDnd ? t('removeDnd', lang) : t('markDnd', lang)}
            >
              <span style={{ fontSize: '13px', lineHeight: 1 }}>🚫</span>
              <span style={{
                fontSize: '11px', fontWeight: 700,
                color: 'var(--text-muted)',
                whiteSpace: 'nowrap',
              }}>
                DND
              </span>
            </button>
          )}

          {/* Report issue button — same 44x44 minimum + touch-action. */}
          <button
            onClick={onReportIssue}
            style={{
              minHeight: '44px',
              minWidth: '44px',
              padding: '0 12px',
              border: '1.5px solid var(--border-light, #E5E7EB)',
              borderRadius: '10px', background: 'transparent',
              cursor: 'pointer', flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px',
              opacity: 0.6,
              WebkitTapHighlightColor: 'transparent',
              touchAction: 'manipulation',
            }}
            aria-label={t('hkReportIssueAria', lang)}
          >
            <AlertTriangle size={14} color="var(--text-muted)" />
            <span style={{
              fontSize: '11px', fontWeight: 700,
              color: 'var(--text-muted)',
              whiteSpace: 'nowrap',
            }}>
              {t('hkIssueShort', lang)}
            </span>
          </button>
        </div>
      </div>

      {/* Issue note */}
      {(room as Room & { issueNote?: string }).issueNote && (
        <div style={{
          display: 'flex', gap: '6px', alignItems: 'flex-start',
          padding: '9px 11px', background: 'var(--red-dim, #FEF2F2)', borderRadius: '10px',
          marginBottom: '12px', border: '1px solid var(--red-light, #FECACA)',
        }}>
          <AlertTriangle size={13} color="var(--red, #DC2626)" style={{ flexShrink: 0, marginTop: '2px' }} />
          <span style={{ fontSize: '13px', color: 'var(--red-dark, #991B1B)', lineHeight: 1.4 }}>
            {(room as Room & { issueNote?: string }).issueNote}
          </span>
        </div>
      )}

      {/* ── Action area ── */}
      {isDone ? (
        <div style={{
          height: '56px', borderRadius: '14px',
          background: 'var(--green-dim)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
        }}>
          <CheckCircle size={22} color="var(--green)" />
          <span style={{ fontSize: '18px', fontWeight: 800, color: 'var(--green)' }}>
            {t('done', lang)}
          </span>
          {room.completedAt && (
            <span style={{ fontSize: '13px', color: 'var(--green)', opacity: 0.65, marginLeft: '2px' }}>
              {format(new Date(room.completedAt), 'h:mm a')}
            </span>
          )}
          <span style={{ color: 'var(--green)', opacity: 0.3, fontSize: '14px', margin: '0 2px' }}>·</span>
          <button
            onClick={onReset}
            disabled={isResetting}
            style={{
              background: 'none',
              border: 'none',
              // 44x44 minimum tap target — was 4x6 padding which gave a
              // ~25px hit area, well under accessibility guidelines.
              minHeight: '44px',
              minWidth: '44px',
              padding: '0 12px',
              fontSize: '13px',
              fontWeight: 600,
              color: 'var(--green)',
              cursor: isResetting ? 'not-allowed' : 'pointer',
              opacity: isResetting ? 0.4 : 0.55,
              WebkitTapHighlightColor: 'transparent',
              touchAction: 'manipulation',
              textDecoration: 'underline',
              textUnderlineOffset: '2px',
              transition: 'opacity 150ms ease',
            }}
          >
            {isResetting
              ? '...'
              : t('hkResetShort', lang)}
          </button>
        </div>
      ) : room.isDnd ? (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px',
          height: '68px', borderRadius: '14px',
          background: 'var(--gray-dim, #F3F4F6)',
          border: '2px solid var(--border-light, #E5E7EB)',
        }}>
          <span style={{ fontSize: '20px' }}>🚫</span>
          <span style={{ fontSize: '17px', fontWeight: 700, color: 'var(--text-secondary, #4B5563)' }}>
            {t('doNotDisturb', lang)}
          </span>
          <span style={{ color: 'var(--border-light, #E5E7EB)', margin: '0 2px' }}>·</span>
          <button
            onClick={onToggleDnd}
            disabled={isSavingDnd}
            style={{
              background: 'none', border: 'none',
              fontSize: '14px', fontWeight: 600,
              color: 'var(--text-secondary, #4B5563)',
              cursor: isSavingDnd ? 'not-allowed' : 'pointer',
              opacity: isSavingDnd ? 0.4 : 0.7,
              textDecoration: 'underline', textUnderlineOffset: '2px',
              WebkitTapHighlightColor: 'transparent',
              touchAction: 'manipulation',
              // 44x44 minimum tap target. Same accessibility note as the
              // Reset button above.
              minHeight: '44px',
              minWidth: '44px',
              padding: '0 12px',
            }}
          >
            {isSavingDnd ? '...' : t('hkUndoShort', lang)}
          </button>
        </div>
      ) : (
        // 2026-05-07: Maria asked us to remove per-room Start (her HKs
        // skipped it, which silently zero-duration'd every cleaning event
        // and emptied the Performance tab on day 2). The room's Action
        // area now goes straight to "Done" — one tap, room marked clean,
        // server-derived started_at anchored to the previous Done or the
        // shift Start button at the top of the page.
        <CompleteButton lang={lang} isSaving={isSaving} onFinish={onFinish} />
      )}

    </div>
  );
}

/* ── Complete Button - simple tap to mark done ── */
function CompleteButton({
  lang,
  isSaving,
  onFinish,
}: {
  lang: Language;
  isSaving: boolean;
  onFinish: () => void;
}) {
  const [pressed, setPressed] = useState(false);

  return (
    <button
      onClick={onFinish}
      disabled={isSaving}
      onPointerDown={() => !isSaving && setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      style={{
        width: '100%', height: '68px', border: 'none', borderRadius: '14px',
        background: isSaving ? 'var(--border)' : pressed ? 'var(--green-dark, #166534)' : 'var(--green)',
        color: isSaving ? 'var(--text-muted)' : 'white',
        fontSize: '20px', fontWeight: 800,
        cursor: isSaving ? 'not-allowed' : 'pointer',
        letterSpacing: '-0.01em',
        transform: pressed && !isSaving ? 'scale(0.97)' : 'scale(1)',
        transition: 'background 100ms ease, transform 80ms ease',
        WebkitTapHighlightColor: 'transparent',
        boxShadow: pressed || isSaving ? 'none' : '0 4px 12px rgba(22,101,52,0.35)',
      }}
    >
      {isSaving
        ? t('savingDots', lang)
        : `✓ ${t('hkCompleteShort', lang)}`}
    </button>
  );
}
