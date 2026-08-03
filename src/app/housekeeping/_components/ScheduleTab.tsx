'use client';

// The Board (tab key still `schedule` — see the note in ../page.tsx). Shows
// today's cleaning plan: who is cleaning which rooms, in what order, and
// whether anyone is carrying more than a shift's worth of work. Two alternate
// representations of the SAME assignment, toggled by one control:
//
//   • Board    — one compact row per housekeeper (avatar, workload bar,
//                "rooms · time · status", and their room chips). Drag chips
//                between crew; tap a chip for detail. (ScheduleBoard.tsx)
//   • Timeline — the same assignment as a Gantt strip across the shift,
//                one lane per housekeeper. (ScheduleTimeline.tsx)
//
// ── This screen is on its way to being VIEW-ONLY ──────────────────────────
// It is meant to become a pure view once the AI-built board with approve /
// deny lands: Staxis proposes the day's plan, the manager approves or denies
// it, and nothing is edited chip-by-chip here. On 2026-07-24 everything that
// made this an editing and configuration surface was stripped out —
//
//   • cleaning-time settings modal (gear icon on the PMS data strip) — it
//     wrote `properties` from the browser, which is admin-only RLS, so for a
//     general manager it flashed "Settings saved" and saved NOTHING. The
//     clean times were duplicates of /settings/clean-times (the board reads
//     the cleaning_time_standards table, never those columns); the shift
//     length was real and moved to /settings/clean-times, which saves through
//     the service role.
//   • ★ Staff priority modal — per-housekeeper auto-assign eligibility is
//     staffing configuration, not a view of today, so it MOVED rather than
//     disappearing: it is now the "Automatic room assignment" picker on the
//     staff member's own card in Staff, still writing through
//     POST /api/housekeeping/staff-priority. Removing the editor while
//     leaving this board printing an "EXCLUDED" badge would have been a dead
//     end — the manager could see the state and never change it.
//
// Reassign (drag a room to another housekeeper), Auto-assign and Re-plan day
// are KEPT DELIBERATELY, as the stated exception. Until the approve/deny
// board exists there is no other way anywhere in the app to create or correct
// a room assignment, and removing them would be a regression with no
// replacement. When that board ships, these go with it.
//
// Data backbone = the cleaning_tasks + hk_assignments system (the modern,
// persistent assignment engine), surfaced via:
//   GET  /api/housekeeping/board            (rooms + crew + current assignment)
//   POST /api/housekeeping/reassign         (move one room to a housekeeper)
//   POST /api/housekeeping/reset-assignments(one room — drag-to-unassigned;
//                                            no taskId — clear the day for
//                                            "Re-plan day")
//   POST /api/housekeeping/auto-assign      (balance unassigned rooms across crew)

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import {
  fetchWithAuth,
  INTERACTIVE_ACTION_TIMEOUT_MS,
} from '@/lib/api-fetch';
import { useFeedStatus } from '@/lib/use-feed-status';
import { FeedLearningBanner } from '@/components/FeedLearningBanner';
import { subscribeToDashboardByDate } from '@/lib/db';
import type { DashboardNumbers } from '@/lib/db';
import {
  defaultShiftDate, addDays, formatDisplayDate, formatPulledAt,
} from './_shared';
import {
  T, FONT_SANS, FONT_MONO, Caps, Btn, HousekeeperDot,
} from './_snow';
import {
  ScheduleBoard, type BoardTask, type BoardHk, type CrewSource,
  chipKind, fmtMinutes,
} from './ScheduleBoard';
import { ScheduleTimeline } from './ScheduleTimeline';

type ScheduleView = 'board' | 'timeline';
const VIEW_STORAGE_KEY = 'staxis.schedule.view';

interface BoardData {
  tasks: BoardTask[];
  housekeepers: BoardHk[];
  unassigned: number;
  // 'unscheduled_fallback' = nobody is on the Staff schedule for this
  // date, so the board is showing the whole crew and says so.
  crew_source?: CrewSource;
  // The hotel's shift length, straight off `properties` on the server.
  // Preferred over PropertyContext so the totals here can't drift from
  // the numbers the server used; the context value is the fallback for
  // the moment before the first fetch lands.
  shift_minutes?: number;
}

interface BoardScope {
  propertyId: string;
  date: string;
  key: string;
}

export interface ScheduleBoardRequestStamp {
  scopeKey: string;
  sequence: number;
}

/**
 * Shared by the live board and its deferred-response regression test. A board
 * response owns the UI only while both its hotel/date scope and its request
 * sequence are still current. The signal check also makes an aborted request
 * terminal even before its transport notices the cancellation.
 */
export function isCurrentScheduleBoardRequest(
  currentScopeKey: string | null,
  latestSequence: number,
  stamp: ScheduleBoardRequestStamp,
  signal?: Pick<AbortSignal, 'aborted'>,
): boolean {
  return (
    currentScopeKey === stamp.scopeKey
    && latestSequence === stamp.sequence
    && signal?.aborted !== true
  );
}

const PRIORITY_RANK: Record<string, number> = { priority: 0, normal: 1, excluded: 2 };

export function ScheduleTab() {
  const { user } = useAuth();
  const { activeProperty, activePropertyId } = useProperty();
  const { lang } = useLang();

  const [shiftDate, setShiftDate] = useState(defaultShiftDate);
  const [dashboardNums, setDashboardNums] = useState<DashboardNumbers | null>(null);
  const [dashboardLoaded, setDashboardLoaded] = useState(false);
  const [pmsSummaryRetryKey, setPmsSummaryRetryKey] = useState(0);

  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [view, setView] = useState<ScheduleView>('board');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
      if (stored === 'board' || stored === 'timeline') setView(stored);
    } catch { /* private mode */ }
  }, []);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try { window.localStorage.setItem(VIEW_STORAGE_KEY, view); } catch { /* ignore */ }
  }, [view]);

  // ── Board data ─────────────────────────────────────────────────────────
  const [boardData, setBoardData] = useState<BoardData | null>(null);
  const [boardLoaded, setBoardLoaded] = useState(false);
  const [boardResultScopeKey, setBoardResultScopeKey] = useState<string | null>(null);
  const [boardErr, setBoardErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'auto' | 'replan'>(null);

  // Room detail drawer.
  const [openTask, setOpenTask] = useState<BoardTask | null>(null);

  const pid = activePropertyId ?? '';
  const boardViewerKey = user
    ? JSON.stringify([user.uid, user.role, [...user.propertyAccess].sort()])
    : '';
  const boardScope = useMemo<BoardScope | null>(() => (
    pid && boardViewerKey
      ? {
          propertyId: pid,
          date: shiftDate,
          key: JSON.stringify([boardViewerKey, pid, shiftDate]),
        }
      : null
  ), [boardViewerKey, pid, shiftDate]);
  const boardScopeRef = useRef<BoardScope | null>(boardScope);
  boardScopeRef.current = boardScope;
  const boardRequestSequence = useRef(0);
  const activeBoardRequest = useRef<{
    scope: BoardScope;
    stamp: ScheduleBoardRequestStamp;
    controller: AbortController;
  } | null>(null);

  // feat/cua-partial-promotion — the board classifies rooms (checkout vs
  // stayover) from PMS reservations; while arrivals/departures are still
  // being learned that classification is incomplete, and the In House /
  // Arrivals / Departures strip numbers may have no source. Say so.
  // Review pass: 'pending' (never synced) masks data; 'paused' is
  // banner-only (real-but-stale).
  const feedStatus = useFeedStatus(activePropertyId);
  const fsLive = feedStatus?.mode === 'live';
  const connPending = fsLive && feedStatus.connection === 'pending';
  const connPaused = fsLive && feedStatus.connection === 'paused';
  const reservationsLearning = fsLive &&
    (connPending || feedStatus.feeds.arrivals === 'learning' || feedStatus.feeds.departures === 'learning');
  const stripCountsLive = fsLive && !connPending && feedStatus.feeds.dashboardCounts === 'live';

  const flashToast = useCallback((msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  // Dashboard PMS data (In House / Arrivals / Departures).
  useEffect(() => {
    if (!pid) return;
    setDashboardLoaded(false);
    setDashboardNums(null);
    return subscribeToDashboardByDate(pid, shiftDate, (nums) => {
      setDashboardNums(nums);
      setDashboardLoaded(true);
    });
  }, [pid, shiftDate, pmsSummaryRetryKey]);

  const retryPmsSummary = useCallback(() => {
    setDashboardLoaded(false);
    setDashboardNums(null);
    setPmsSummaryRetryKey((key) => key + 1);
  }, []);

  // Board fetch (rooms + crew + assignment). Callers pass the exact scope
  // they intend to reconcile. A stale callback from hotel/date A cannot
  // silently turn into a read for whichever hotel/date happens to be active
  // when its POST finishes.
  const refreshBoard = useCallback(async (requestedScope?: BoardScope): Promise<boolean> => {
    const scope = requestedScope ?? boardScopeRef.current;
    if (!scope || boardScopeRef.current !== scope) return false;

    const controller = new AbortController();
    const stamp: ScheduleBoardRequestStamp = {
      scopeKey: scope.key,
      sequence: ++boardRequestSequence.current,
    };
    activeBoardRequest.current?.controller.abort();
    activeBoardRequest.current = { scope, stamp, controller };
    const ownsRequest = () => isCurrentScheduleBoardRequest(
      boardScopeRef.current?.key ?? null,
      boardRequestSequence.current,
      stamp,
      controller.signal,
    );

    try {
      const res = await fetchWithAuth(
        `/api/housekeeping/board?propertyId=${encodeURIComponent(scope.propertyId)}&date=${encodeURIComponent(scope.date)}`,
        { signal: controller.signal },
      );
      const body = (await res.json()) as { ok: boolean; data?: BoardData; error?: string };
      if (!res.ok || !body.ok || !body.data) throw new Error(body?.error ?? `HTTP ${res.status}`);
      if (!ownsRequest()) return false;
      setBoardData(body.data);
      setBoardErr(null);
      return true;
    } catch (e) {
      if (!ownsRequest()) return false;
      setBoardErr(e instanceof Error ? e.message : String(e));
      return true;
    } finally {
      if (ownsRequest()) {
        setBoardResultScopeKey(scope.key);
        setBoardLoaded(true);
      }
      if (activeBoardRequest.current?.stamp.sequence === stamp.sequence) {
        activeBoardRequest.current = null;
      }
    }
  }, []);

  useEffect(() => {
    const scope = boardScope;
    boardRequestSequence.current += 1;
    activeBoardRequest.current?.controller.abort();
    activeBoardRequest.current = null;
    setBoardLoaded(false);
    setBoardResultScopeKey(null);
    setBoardData(null);
    setBoardErr(null);
    setBusy(null);
    setOpenTask(null);
    if (!scope) return;
    void refreshBoard(scope);
    return () => {
      const active = activeBoardRequest.current;
      if (active?.scope === scope) {
        boardRequestSequence.current += 1;
        active.controller.abort();
        activeBoardRequest.current = null;
      }
    };
  }, [boardScope, refreshBoard]);
  useEffect(() => () => {
    boardScopeRef.current = null;
    boardRequestSequence.current += 1;
    activeBoardRequest.current?.controller.abort();
    activeBoardRequest.current = null;
  }, []);

  // ── Derived ────────────────────────────────────────────────────────────
  const boardDataMatchesScope = Boolean(
    boardScope && boardResultScopeKey === boardScope.key,
  );
  const currentBoardData = boardDataMatchesScope ? boardData : null;
  const currentBoardLoaded = boardLoaded && boardDataMatchesScope;
  const SHIFT_MINS = Math.max(
    60,
    currentBoardData?.shift_minutes ?? activeProperty?.shiftMinutes ?? 420,
  );

  const tasks = useMemo(() => currentBoardData?.tasks ?? [], [currentBoardData]);
  const crew = useMemo(() => {
    const list = (currentBoardData?.housekeepers ?? []).filter(h => h.is_active);
    return [...list].sort((a, b) => {
      const pr = (PRIORITY_RANK[a.schedule_priority] ?? 1) - (PRIORITY_RANK[b.schedule_priority] ?? 1);
      return pr !== 0 ? pr : a.name.localeCompare(b.name);
    });
  }, [currentBoardData]);

  const checkouts = tasks.filter(t => chipKind(t.cleaning_type) === 'checkout').length;
  const stayovers = tasks.filter(t => chipKind(t.cleaning_type) === 'stayover').length;
  const totalMinutes = tasks.reduce((s, t) => s + t.estimated_minutes_resolved, 0);
  const recommendedHKs = Math.max(1, Math.ceil(totalMinutes / SHIFT_MINS)) + 1;

  const today = useMemo(() => new Date().toLocaleDateString('en-CA'), []);
  const isToday = shiftDate === today;
  const isYesterday = shiftDate === addDays(today, -1);
  const isTomorrow = shiftDate === addDays(today, 1);

  // The dashboard bridge already carries the authoritative PMS capture time.
  // The removed plan subscription always returned pulledAt=null while also
  // issuing two extra RPCs plus a property read on every Schedule navigation.
  const pulledAtIso = dashboardNums?.pulledAt
    ? (dashboardNums.pulledAt instanceof Date ? dashboardNums.pulledAt.toISOString() : String(dashboardNums.pulledAt))
    : null;
  const pulledAtLabel = pulledAtIso
    ? formatPulledAt(pulledAtIso, lang)
    : ('no data');
  const pmsSummaryFailed = dashboardLoaded && dashboardNums === null;

  // ── Mutations ──────────────────────────────────────────────────────────

  // Optimistic single-task assignee patch (hkId or null). A failed write is
  // always reconciled from the server: a timeout can mean the write landed
  // and only its response was lost, so blindly rolling back would lie.
  const patchAssignee = useCallback((taskId: string, assignee: string | null) => {
    setBoardData(d => {
      if (!d) return d;
      return { ...d, tasks: d.tasks.map(t => t.id === taskId ? { ...t, assignee_id: assignee } : t) };
    });
  }, []);

  const onReassign = useCallback(async (taskId: string, toHkId: string) => {
    const scope = boardScopeRef.current;
    if (!scope) return;
    const prev = currentBoardData?.tasks.find(t => t.id === taskId)?.assignee_id ?? null;
    if (prev === toHkId) return;
    patchAssignee(taskId, toHkId);
    try {
      const res = await fetchWithAuth('/api/housekeeping/reassign', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId: scope.propertyId, taskId, toHousekeeperId: toHkId }),
        timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      await refreshBoard(scope);
    } catch (e) {
      await refreshBoard(scope);
      if (boardScopeRef.current === scope) {
        flashToast(('Move failed: ') + (e instanceof Error ? e.message : String(e)));
      }
    }
  }, [currentBoardData, patchAssignee, refreshBoard, flashToast]);

  const onUnassign = useCallback(async (taskId: string) => {
    const scope = boardScopeRef.current;
    if (!scope) return;
    const prev = currentBoardData?.tasks.find(t => t.id === taskId)?.assignee_id ?? null;
    if (prev === null) return;
    patchAssignee(taskId, null);
    try {
      const res = await fetchWithAuth('/api/housekeeping/reset-assignments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId: scope.propertyId, date: scope.date, taskId }),
        timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      await refreshBoard(scope);
    } catch (e) {
      await refreshBoard(scope);
      if (boardScopeRef.current === scope) {
        flashToast(('Unassign failed: ') + (e instanceof Error ? e.message : String(e)));
      }
    }
  }, [currentBoardData, patchAssignee, refreshBoard, flashToast]);

  const onAutoAssign = useCallback(async () => {
    const scope = boardScopeRef.current;
    if (!scope || busy) return;
    setBusy('auto');
    try {
      const res = await fetchWithAuth('/api/housekeeping/auto-assign', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId: scope.propertyId, date: scope.date }),
        timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      const n = body.data?.assigned ?? 0;
      await refreshBoard(scope);
      if (boardScopeRef.current === scope) {
        flashToast(
          n > 0
            ? (`Auto-assigned ${n} rooms`)
            : ('No rooms to assign'),
        );
      }
    } catch (e) {
      await refreshBoard(scope);
      if (boardScopeRef.current === scope) {
        flashToast(('Auto-assign failed: ') + (e instanceof Error ? e.message : String(e)));
      }
    } finally {
      if (boardScopeRef.current === scope) setBusy(null);
    }
  }, [busy, refreshBoard, flashToast]);

  // Re-plan the whole day: clear every assignment that can still be moved,
  // then let the engine spread the rooms across today's crew again.
  //
  // This is NOT a duplicate of Auto-assign. Auto-assign is deliberately
  // non-destructive — it only places rooms that have NO assignment — so the
  // moment the day is planned it becomes a no-op. When two housekeepers call
  // out at 9am, "Auto-assign" does nothing and the manager's only other
  // option is dragging twenty rooms to Unassigned one at a time. That is the
  // gap this fills, and it is the same clear-all shape the server route has
  // always supported.
  //
  // Rooms already in progress / finished keep their housekeeper — the server
  // only resets scheduled / ready_now / deferred (see reset-assignments).
  const onReplan = useCallback(async () => {
    const scope = boardScopeRef.current;
    if (!scope || busy) return;
    const proceed = window.confirm(
      "Spread this day's rooms across today's crew again. Rooms already being cleaned or already finished are left alone. Continue?",
    );
    if (!proceed) return;
    setBusy('replan');
    try {
      const resetRes = await fetchWithAuth('/api/housekeeping/reset-assignments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId: scope.propertyId, date: scope.date }),
        timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS,
      });
      const resetBody = await resetRes.json().catch(() => ({}));
      if (!resetRes.ok || !resetBody.ok) throw new Error(resetBody?.error ?? `HTTP ${resetRes.status}`);

      const assignRes = await fetchWithAuth('/api/housekeeping/auto-assign', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId: scope.propertyId, date: scope.date }),
        timeoutMs: INTERACTIVE_ACTION_TIMEOUT_MS,
      });
      const assignBody = await assignRes.json().catch(() => ({}));
      if (!assignRes.ok || !assignBody.ok) throw new Error(assignBody?.error ?? `HTTP ${assignRes.status}`);

      const n = assignBody.data?.assigned ?? 0;
      await refreshBoard(scope);
      if (boardScopeRef.current === scope) {
        flashToast(
          `Day re-planned · ${n} rooms spread`,
        );
      }
    } catch (e) {
      // Whatever failed, show the board's real state — the clear may have
      // landed even if the re-assign didn't, and the manager needs to see
      // that rather than a stale screen.
      await refreshBoard(scope);
      if (boardScopeRef.current === scope) {
        flashToast(
          ("Couldn't re-plan the day: ")
          + (e instanceof Error ? e.message : String(e)),
        );
      }
    } finally {
      if (boardScopeRef.current === scope) setBusy(null);
    }
  }, [busy, refreshBoard, flashToast]);

  // Removed 2026-07-24: the ★ Staff priority modal. Auto-assign eligibility
  // ("never auto-assign this person") is staffing configuration, so it lives on
  // the person's own card in My Hotel → People — see PersonEmploymentForm
  // (src/app/(hotel)/company/_components/PersonEmploymentForm.tsx), the only editor for
  // it anywhere in the app. This board can show an EXCLUDED badge; it cannot
  // clear one.

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={{
      padding: '24px 48px 130px', background: 'transparent', color: T.ink,
      fontFamily: FONT_SANS, minHeight: 'calc(100dvh - 130px)',
    }}>
      {/* feat/cua-partial-promotion — honesty strips. One banner at a
          time: pending > paused > feed-level. */}
      {connPending && (
        <div style={{ marginBottom: 16 }}>
          <FeedLearningBanner
            variant="strip"
            title={'Waiting for PMS data.'}
            text={'Schedule data will appear after the first report is processed.'}
          />
        </div>
      )}
      {!connPending && connPaused && (
        <div style={{ marginBottom: 16 }}>
          <FeedLearningBanner
            variant="strip"
            title={'PMS data is out of date.'}
            text={'The latest available values remain visible while new data is unavailable.'}
          />
        </div>
      )}
      {!connPending && !connPaused && reservationsLearning && (
        <div style={{ marginBottom: 16 }}>
          <FeedLearningBanner
            variant="strip"
            title={'Waiting for complete PMS data.'}
            text={'The latest data does not include all arrivals and departures. Checkout and stayover labels may be incomplete.'}
          />
        </div>
      )}

      {/* DATE HEADER + STEPPER */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
        marginBottom: 18, gap: 24, flexWrap: 'wrap',
      }}>
        <div>
          <Caps>{(() => {
            if (isToday)     return 'Board · today';
            if (isYesterday) return 'Board · yesterday';
            if (isTomorrow)  return 'Board · tomorrow';
            return 'Board';
          })()}</Caps>
          <h1 style={{
            fontFamily: FONT_SANS, fontSize: 26, color: T.ink, margin: '4px 0 0',
            letterSpacing: '-0.02em', lineHeight: 1.25, fontWeight: 600,
          }}>
            <span>{formatDisplayDate(shiftDate, lang).split(',')[0]}</span>
            <span> · {formatDisplayDate(shiftDate, lang).split(',').slice(1).join(',').trim()}</span>
          </h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Btn variant="ghost" size="sm" onClick={() => setShiftDate(addDays(shiftDate, -1))}>← {'Yesterday'}</Btn>
          <Btn variant={isToday ? 'paper' : 'ghost'} size="sm" onClick={() => setShiftDate(today)}>{'Today'}</Btn>
          <Btn variant="ghost" size="sm" onClick={() => setShiftDate(addDays(shiftDate, 1))}>{'Tomorrow'} →</Btn>
        </div>
      </div>

      {/* PMS DATA STRIP */}
      <div style={{
        background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 16,
        padding: '15px 20px', marginBottom: 16,
        display: 'flex', alignItems: 'center', gap: 26, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 140 }}>
          {/* The gear icon that used to sit beside this label opened a
              cleaning-time settings modal. It saved nothing for anyone but an
              admin (see the file header); its fields now live on
              /settings/clean-times, which saves for real. */}
          <Caps size={9}>{'Latest PMS data'}</Caps>
          <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink, fontWeight: 600, marginTop: 3 }}>
            {!dashboardLoaded
              ? ('Loading…')
              : dashboardNums
                ? pulledAtLabel
                : ('Unavailable')}
          </span>
        </div>
        <span style={{ width: 1, height: 40, background: T.rule }} />
        <div style={{ display: 'flex', gap: 26, flex: 1, flexWrap: 'wrap' }}>
          {([
            // Review pass: the legacy anon snapshot read is RLS-dead (these
            // were always null → '—'); when the counts feed is live the
            // server-derived values give real numbers, otherwise an honest
            // '—'. Checkout/stayover/recommended cells null out while the
            // reservation feeds are untrusted — a confident 0 there reads
            // as "nobody checks out today".
            { l: 'In House',    v: stripCountsLive ? (feedStatus.derived?.snapshotInHouse ?? null) : (fsLive ? null : dashboardNums?.inHouse ?? null), loaded: dashboardLoaded },
            { l: 'Arrivals',    v: stripCountsLive ? (feedStatus.derived?.snapshotArrivalsRemaining ?? null) : (fsLive ? null : dashboardNums?.arrivals ?? null), loaded: dashboardLoaded },
            { l: 'Departures',  v: stripCountsLive ? (feedStatus.derived?.snapshotDeparturesRemaining ?? null) : (fsLive ? null : dashboardNums?.departures ?? null), loaded: dashboardLoaded },
            { l: 'Checkouts',   v: reservationsLearning ? null : checkouts,                loaded: currentBoardLoaded },
            { l: 'Stayovers',   v: reservationsLearning ? null : stayovers,                loaded: currentBoardLoaded },
            { l: 'Total time',  v: reservationsLearning ? null : fmtMinutes(totalMinutes), loaded: currentBoardLoaded },
            { l: 'Recommended', v: reservationsLearning ? null : `${recommendedHKs} HK`,   loaded: currentBoardLoaded, tone: T.sageDeep },
          ] as Array<{ l: string; v: React.ReactNode; loaded: boolean; tone?: string }>).map(n => (
            <div key={n.l} style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 58 }}>
              <Caps size={9}>{n.l}</Caps>
              <span style={{
                fontFamily: FONT_SANS, fontSize: 23, color: n.loaded ? (n.tone || T.ink) : T.ink3,
                lineHeight: 1, letterSpacing: '-0.02em', fontWeight: 600, whiteSpace: 'nowrap',
              }}>{n.loaded && n.v != null ? n.v : '—'}</span>
            </div>
          ))}
        </div>
        {pmsSummaryFailed && (
          <div
            role="alert"
            style={{
              flexBasis: '100%', borderTop: `1px solid ${T.rule}`, paddingTop: 12,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 12, flexWrap: 'wrap', color: T.warm, fontFamily: FONT_SANS, fontSize: 13,
            }}
          >
            <span>
              {'Part of the PMS summary could not load. The room board is still available.'}
            </span>
            <Btn variant="ghost" size="sm" onClick={retryPmsSummary}>
              {'Retry'}
            </Btn>
          </div>
        )}
      </div>

      {/* TOOLBAR — view toggle + actions */}
      {pid && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 14, flexWrap: 'wrap', marginBottom: 16,
        }}>
          {/* Board ⇄ Timeline */}
          <div style={{
            display: 'inline-flex', gap: 4, background: T.ruleSoft,
            border: `1px solid ${T.rule}`, borderRadius: 999, padding: 4,
          }}>
            {([['board', 'Board', '▤'], ['timeline', 'Timeline', '▦']] as const).map(([k, label, icon]) => (
              <button
                key={k}
                onClick={() => setView(k)}
                style={{
                  fontFamily: FONT_SANS, fontSize: 13, fontWeight: 600,
                  border: 'none', borderRadius: 999, padding: '8px 18px', cursor: 'pointer',
                  background: view === k ? T.ink : 'transparent',
                  color: view === k ? T.bg : T.ink2,
                  display: 'inline-flex', alignItems: 'center', gap: 7,
                  transition: 'background 120ms ease, color 120ms ease',
                }}
              >
                <span style={{ fontSize: 13 }}>{icon}</span>{label}
              </button>
            ))}
          </div>

          {/* The two planning actions left on this board — see the file
              header. Auto-assign FILLS the gaps; Re-plan STARTS OVER. */}
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
            <Btn variant="ghost" size="sm" onClick={onReplan} disabled={busy != null}>
              {busy === 'replan'
                ? ('Re-planning…')
                : `⟲ ${'Re-plan day'}`}
            </Btn>
            <Btn variant="primary" size="sm" onClick={onAutoAssign} disabled={busy != null}>
              {busy === 'auto' ? ('Assigning…') : `↻ ${'Auto-assign'}`}
            </Btn>
          </div>
        </div>
      )}

      {/* VIEW */}
      {!pid && (
        <div style={{ padding: '40px 0', textAlign: 'center', color: T.ink2, fontFamily: FONT_SANS, fontSize: 14 }}>
          {'Select a property to see today’s board.'}
        </div>
      )}
      {pid && !currentBoardLoaded && (
        <div style={{ padding: '40px 0', textAlign: 'center' }}>
          <div className="animate-spin" style={{
            width: 26, height: 26, margin: '0 auto',
            border: `2px solid ${T.rule}`, borderTopColor: T.ink, borderRadius: '50%',
          }} />
        </div>
      )}
      {pid && currentBoardLoaded && boardErr && (
        <div style={{
          padding: '18px 20px', border: `1px solid ${T.rule}`, borderRadius: 12,
          background: T.warmDim, color: T.warm, fontFamily: FONT_SANS, fontSize: 13,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
        }}>
          <span>{('Couldn\'t load the board: ') + boardErr}</span>
          <Btn variant="ghost" size="sm" onClick={() => void refreshBoard()}>{'Retry'}</Btn>
        </div>
      )}
      {pid && currentBoardLoaded && !boardErr && crew.length === 0 && (
        <div style={{
          padding: '40px 20px', textAlign: 'center', color: T.ink2,
          fontFamily: FONT_SANS, fontSize: 14, border: `1px dashed ${T.rule}`, borderRadius: 12,
        }}>
          {'No active housekeeping staff yet. Add crew in Staff to start assigning.'}
        </div>
      )}
      {pid && currentBoardLoaded && !boardErr && crew.length > 0 && (
        <>
          {tasks.length === 0 && (
            <div style={{
              marginBottom: 12, padding: '12px 16px',
              border: `1px dashed ${T.rule}`, borderRadius: 12,
              background: T.paper, color: T.ink2, fontFamily: FONT_SANS, fontSize: 13,
            }}>
              {'No rooms to clean for this date yet. They’ll appear here when new PMS data arrives.'}
            </div>
          )}
          {view === 'board' ? (
            <ScheduleBoard
              crew={crew}
              tasks={tasks}
              shiftMinutes={SHIFT_MINS}
              crewSource={currentBoardData?.crew_source ?? 'scheduled'}
              lang={lang}
              onReassign={onReassign}
              onUnassign={onUnassign}
              onOpenTask={setOpenTask}
            />
          ) : (
            <ScheduleTimeline
              crew={crew}
              tasks={tasks}
              shiftMinutes={SHIFT_MINS}
              lang={lang}
              showNow={isToday}
              onReassign={onReassign}
              onOpenTask={setOpenTask}
            />
          )}
        </>
      )}

      {/* TOAST */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          zIndex: 70, padding: '12px 18px',
          background: T.sageDim, color: T.sageDeep,
          border: '1px solid rgba(104,131,114,0.3)', borderRadius: 999,
          fontFamily: FONT_SANS, fontSize: 13, fontWeight: 500,
        }}>{toast}</div>
      )}

      {/* DETAIL DRAWER */}
      {openTask && typeof document !== 'undefined' && createPortal(
        <RoomDetailDrawer
          task={openTask}
          crew={crew}
          lang={lang}
          onReassign={(hkId) => { void onReassign(openTask.id, hkId); setOpenTask(null); }}
          onUnassign={() => { void onUnassign(openTask.id); setOpenTask(null); }}
          onClose={() => setOpenTask(null)}
        />,
        document.body,
      )}

    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Detail drawer — room detail + reassign-to list (design's detailDrawer).
// ───────────────────────────────────────────────────────────────────────

function RoomDetailDrawer({
  task, crew, lang, onReassign, onUnassign, onClose,
}: {
  task: BoardTask;
  crew: BoardHk[];
  lang: 'en' | 'es';
  onReassign: (hkId: string) => void;
  onUnassign: () => void;
  onClose: () => void;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const kind = chipKind(task.cleaning_type);
  const kindColor = kind === 'checkout' ? T.warm : kind === 'stayover' ? T.caramelDeep : T.sageDeep;
  const floor = (() => {
    const d = task.room_number.replace(/\D/g, '');
    return d.length >= 4 ? d.slice(0, 2) : d.length >= 2 ? d.slice(0, 1) : '?';
  })();
  return (
    <div onClick={onClose} role="dialog" aria-modal="true" style={{
      position: 'fixed', inset: 0, background: 'rgba(31,35,28,0.32)',
      display: 'flex', justifyContent: 'flex-end', zIndex: 9999,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 'min(380px, 92vw)', background: T.paper, height: '100%', padding: 22,
        borderLeft: `1px solid ${T.rule}`, display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <Caps>{'Room detail'}</Caps>
            <div style={{ fontFamily: FONT_SANS, fontWeight: 600, fontSize: 32, color: T.ink, lineHeight: 1, letterSpacing: '-0.02em' }}>{task.room_number}</div>
          </div>
          <Btn variant="ghost" size="sm" onClick={onClose}>{'Close'}</Btn>
        </div>
        <DRow label={'Type'} value={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: kindColor }} />
            <span style={{ textTransform: 'capitalize' }}>{task.cleaning_type.replace(/_/g, ' ')}</span>
          </span>
        } />
        <DRow label={'Est. minutes'} value={fmtMinutes(task.estimated_minutes_resolved)} mono />
        <DRow label={'Status'} value={<span style={{ textTransform: 'capitalize' }}>{task.status.replace(/_/g, ' ')}</span>} />
        <DRow label={'Floor'} value={floor} />
        {task.requires_inspection && (
          <DRow label={'Inspection'} value={'Required'} />
        )}
        <div>
          <div style={{ margin: '6px 0 8px' }}><Caps>{'Reassign to'}</Caps></div>
          {crew.map(c => (
            <button key={c.id} onClick={() => onReassign(c.id)} style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 9, justifyContent: 'flex-start',
              padding: '8px 10px', marginBottom: 6, borderRadius: 999,
              border: `1px solid ${task.assignee_id === c.id ? T.sageDeep : T.rule}`,
              background: task.assignee_id === c.id ? T.sageDim : 'transparent',
              cursor: 'pointer', fontFamily: FONT_SANS, fontSize: 13, color: T.ink,
            }}>
              <HousekeeperDot staff={{ id: c.id, name: c.name }} size={22} />
              <span style={{ flex: 1, textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
              {task.assignee_id === c.id && <span style={{ color: T.sageDeep }}>✓</span>}
            </button>
          ))}
          {task.assignee_id && (
            <button onClick={onUnassign} style={{
              width: '100%', padding: '8px 10px', marginTop: 2, borderRadius: 999,
              border: `1px dashed ${T.rule}`, background: 'transparent', cursor: 'pointer',
              fontFamily: FONT_SANS, fontSize: 13, color: T.ink2,
            }}>{'Unassign'}</button>
          )}
        </div>
      </div>
    </div>
  );
}

function DRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderTop: `1px solid ${T.rule}`, gap: 12 }}>
      <Caps>{label}</Caps>
      <span style={{ fontFamily: mono ? FONT_MONO : FONT_SANS, fontSize: 13, color: T.ink }}>{value}</span>
    </div>
  );
}
