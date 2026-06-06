'use client';

export const dynamic = 'force-dynamic';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import * as Sentry from '@sentry/nextjs';
import { format } from 'date-fns';
import { es as esLocale } from 'date-fns/locale';
import { AlertTriangle, CheckCircle, Bell } from 'lucide-react';

import {
  subscribeToRoomsForStaff,
  getStaffSelfPublic,
  saveStaffLanguagePublic,
} from '@/lib/db';
import { supabase } from '@/lib/supabase';
import { useTodayStr } from '@/lib/use-today-str';
import type { Room, RoomReservationContext } from '@/types';
import { t } from '@/lib/translations';
import type { HousekeeperLocale } from '@/lib/translations';
import { SUPPORTED_LOCALES, LOCALE_META } from '@/lib/translations';
import { floorFromRoomNumber, inferCleaningType } from '@/lib/housekeeper-workflow/state-machine';
import type { ExceptionType } from '@/lib/housekeeper-workflow/state-machine';

import InspectorView from './_components/InspectorView';
import VoiceIssueButton from './_components/VoiceIssueButton';
import { SickReportButton } from './SickReportButton';
import { LanguageSwitcher } from './_components/LanguageSwitcher';
import { NoticeBoardBanner } from './_components/NoticeBoardBanner';
import { StructuredIssueReporter } from './_components/StructuredIssueReporter';
import { AddNoteButton, MarkForInspectionButton } from './_components/RoomCardActionButtons';
import { ReportFoundItemButton } from './_components/ReportFoundItemButton';
import { ComponentRoomBadge } from './_components/ComponentRoomBadge';
import {
  collapseChildComponents,
  componentForRoom,
  type ComponentRoomLink,
} from '@/lib/housekeeper-workflow/component-rooms';
import { useOfflineSync } from '@/lib/offline-sync/use-offline-sync';
import { ChecklistModal, type ChecklistItem } from './_components/ChecklistModal';
import { ExceptionDropdown } from './_components/ExceptionDropdown';
import { LunchBreakButton } from './_components/LunchBreakButton';
import { DailySummary } from './_components/DailySummary';
import { RoomAccordionCard } from './_components/redesign/RoomAccordionCard';
import { BottomTabBar, type HkTab } from './_components/redesign/BottomTabBar';
import { MessagesTab } from './_components/redesign/MessagesTab';
import { AllRoomsCleanCard } from './_components/redesign/AllRoomsCleanCard';
import { confettiBurst } from './_components/redesign/confetti';

type RoomRow = Room;
type GroupBy = 'floor' | 'number';

/**
 * Order a flat room list by physical walking path or by raw number.
 * Floor-grouping is the default — competitors all do it and it matches the
 * way the housekeeper actually moves through the building.
 */
function sortRooms(rooms: RoomRow[], groupBy: GroupBy): RoomRow[] {
  return [...rooms].sort((a, b) => {
    if (groupBy === 'floor') {
      const af = a.floor ?? floorFromRoomNumber(a.number);
      const bf = b.floor ?? floorFromRoomNumber(b.number);
      const an = parseInt(af, 10);
      const bn = parseInt(bf, 10);
      if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
      if (Number.isFinite(an) && !Number.isFinite(bn)) return -1;
      if (!Number.isFinite(an) && Number.isFinite(bn)) return 1;
      if (af !== bf) return af.localeCompare(bf);
    }
    // Tiebreak: rush rooms first, then room number ascending (alphanumeric tail).
    if (!!a.isRush !== !!b.isRush) return a.isRush ? -1 : 1;
    const an = parseInt(a.number, 10);
    const bn = parseInt(b.number, 10);
    if (Number.isNaN(an) && Number.isNaN(bn)) return a.number.localeCompare(b.number);
    if (Number.isNaN(an)) return 1;
    if (Number.isNaN(bn)) return -1;
    if (an !== bn) return an - bn;
    return a.number.localeCompare(b.number);
  });
}

export default function HousekeeperRoomPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: housekeeperId } = React.use(params);
  const searchParams = useSearchParams();
  const pid = searchParams.get('pid');
  const today = useTodayStr();

  const [lang, setLang] = useState<HousekeeperLocale>('en');
  const [componentLinks, setComponentLinks] = useState<ComponentRoomLink[]>([]);
  const [managerNotesByRoom, setManagerNotesByRoom] = useState<Record<string, string>>({});
  const offline = useOfflineSync();
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [activeDate, setActiveDate] = useState<string>(today);
  const [reservationsByRoom, setReservationsByRoom] = useState<Record<string, RoomReservationContext>>({});
  // Always sort by room number (the floor/number toggle was removed per design).
  const [groupBy] = useState<GroupBy>('number');

  const lastRefetchAtRef = useRef<number>(0);
  const [loading, setLoading] = useState(true);

  const [savingStart, setSavingStart] = useState<string | null>(null);
  const [savingPause, setSavingPause] = useState<string | null>(null);
  const [savingResume, setSavingResume] = useState<string | null>(null);
  const [savingComplete, setSavingComplete] = useState<string | null>(null);
  const [savingReset, setSavingReset] = useState<string | null>(null);

  const inFlightRoomActionsRef = useRef<Set<string>>(new Set());

  const [checklistRoomId, setChecklistRoomId] = useState<string | null>(null);
  const [exceptionRoomId, setExceptionRoomId] = useState<string | null>(null);
  const [issueRoomId, setIssueRoomId] = useState<string | null>(null);
  const [issueNote, setIssueNote] = useState('');
  const [savingIssue, setSavingIssue] = useState(false);

  const [checklistByType, setChecklistByType] = useState<
    Record<string, { templateId: string | null; items: ChecklistItem[] } | undefined>
  >({});

  const [openBreakStartedAt, setOpenBreakStartedAt] = useState<string | null>(null);

  // ── Online/offline indicator ──────────────────────────────────────────
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

  // ── Action-failed toast ────────────────────────────────────────────────
  const [actionError, setActionError] = useState<string | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showActionError = useCallback((msg: string) => {
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    setActionError(msg);
    errorTimerRef.current = setTimeout(() => setActionError(null), 4500);
  }, []);
  useEffect(
    () => () => {
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    },
    [],
  );

  // ── Magic-link consumption ─────────────────────────────────────────────
  const [authReady, setAuthReady] = useState(false);

  // ── Redesign shell state (Claude Design handoff, June 2026) ──
  const [activeTab, setActiveTab] = useState<HkTab>('rooms');
  const [openRoomId, setOpenRoomId] = useState<string | null>(null); // accordion: one open at a time
  const [messagesUnread, setMessagesUnread] = useState(0);
  const roomsScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    const code = searchParams.get('code');
    const token = searchParams.get('token');
    if (!code && !token) {
      setAuthReady(true);
      return;
    }
    void (async () => {
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
            const json = (await res
              .json()
              .catch(() => null)) as { data?: { hashedToken?: string } } | null;
            hashedToken = json?.data?.hashedToken ?? null;
          } else {
            Sentry.captureMessage('housekeeper: exchange-code failed', {
              level: 'warning',
              tags: { surface: 'housekeeper-page', reason: 'exchange-code-rejected' },
              extra: { status: res.status, pid, housekeeperId },
            });
          }
        } catch (err) {
          Sentry.captureException(err, {
            tags: { surface: 'housekeeper-page', reason: 'exchange-code-threw' },
            extra: { pid, housekeeperId },
          });
        }
      } else if (token) {
        void fetch('/api/housekeeper/log-legacy-token', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pid, staffId: housekeeperId }),
          keepalive: true,
        }).catch(() => {});
        hashedToken = token;
      }
      if (hashedToken) {
        try {
          const { error } = await supabase.auth.verifyOtp({
            token_hash: hashedToken,
            type: 'magiclink',
          });
          if (error) {
            Sentry.captureMessage('housekeeper: magic-link consume failed', {
              level: 'warning',
              tags: { surface: 'housekeeper-page', reason: 'magic-link-rejected' },
              extra: { errorMessage: error.message, pid, housekeeperId },
            });
          }
        } catch (err) {
          Sentry.captureException(err, {
            tags: { surface: 'housekeeper-page', reason: 'magic-link-threw' },
            extra: { pid, housekeeperId },
          });
        }
      }
      if (cancelled) return;
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('token');
        url.searchParams.delete('code');
        window.history.replaceState({}, '', url.pathname + (url.search || ''));
      } catch {
        // non-DOM env
      }
      setAuthReady(true);
    })();
    return () => {
      cancelled = true;
    };
    // searchParams is consumed once; intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Seed lang from staff row.
  useEffect(() => {
    if (!housekeeperId || !pid || !authReady) return;
    let cancelled = false;
    void (async () => {
      try {
        const s = await getStaffSelfPublic(pid, housekeeperId);
        if (!cancelled && s && typeof s.language === 'string') {
          // staff.language now allows the five housekeeper-facing locales
          // (migration 0225). Defensively narrow before assigning so a
          // stale row with an unknown value falls back to EN.
          const lc = s.language as HousekeeperLocale;
          if ((SUPPORTED_LOCALES as readonly string[]).includes(lc)) {
            setLang(lc);
          }
        }
      } catch {
        // best-effort
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [housekeeperId, pid, authReady]);

  // Rooms subscription.
  useEffect(() => {
    if (!housekeeperId || !pid || !authReady) return;
    const unsub = subscribeToRoomsForStaff(pid, housekeeperId, (all) => {
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
        const future = [...byDate.keys()].filter((d) => d > today).sort();
        if (future.length > 0) {
          chosenDate = future[0];
        } else {
          const past = [...byDate.keys()].filter((d) => d < today).sort().reverse();
          if (past.length > 0) chosenDate = past[0];
        }
      }
      setActiveDate(chosenDate);
      setRooms(sortRooms(byDate.get(chosenDate) ?? [], groupBy));
      setLoading(false);
    });
    return () => {
      unsub();
    };
  }, [housekeeperId, pid, today, authReady, groupBy]);

  // Re-sort on groupBy toggle without waiting for a realtime event.
  useEffect(() => {
    setRooms((curr) => sortRooms(curr, groupBy));
  }, [groupBy]);

  // Hydrate the open-break state from server on mount. Without this, a
  // refresh during an active lunch shows "Start lunch" and the next tap
  // accidentally ENDS the still-open break (server toggle is open-or-end,
  // not state-aware). Fixes the cross-midnight case too — the lunch GET
  // searches by (pid, staffId) regardless of business_date.
  useEffect(() => {
    if (!pid || !housekeeperId || !authReady) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/housekeeper/lunch-break?pid=${encodeURIComponent(pid)}&staffId=${encodeURIComponent(housekeeperId)}`,
        );
        const json = (await res.json().catch(() => null)) as
          | { ok?: boolean; data?: { openBreak: { startedAt: string } | null } }
          | null;
        if (!cancelled && res.ok && json?.ok && json.data?.openBreak) {
          setOpenBreakStartedAt(json.data.openBreak.startedAt);
        }
      } catch {
        // silent — button just defaults to "Start lunch"
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pid, housekeeperId, authReady]);

  // Fetch reservation context for the active date.
  useEffect(() => {
    if (!pid || !housekeeperId || !activeDate || !authReady) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/housekeeper/reservations?pid=${encodeURIComponent(pid)}&staffId=${encodeURIComponent(housekeeperId)}&date=${encodeURIComponent(activeDate)}`,
        );
        const json = (await res.json().catch(() => null)) as
          | { ok?: boolean; data?: { reservations: Record<string, RoomReservationContext> } }
          | null;
        if (!cancelled && res.ok && json?.ok && json.data) {
          setReservationsByRoom(json.data.reservations);
        }
      } catch {
        // best effort
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pid, housekeeperId, activeDate, authReady]);

  // Fetch component-room links for the property. Manager-curated, doesn't
  // change often, so a single fetch on mount is fine.
  useEffect(() => {
    if (!pid || !housekeeperId || !authReady) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/housekeeper/component-rooms?pid=${encodeURIComponent(pid)}&staffId=${encodeURIComponent(housekeeperId)}`,
        );
        const json = (await res.json().catch(() => null)) as
          | { ok?: boolean; data?: { links: ComponentRoomLink[] } }
          | null;
        if (!cancelled && res.ok && json?.ok && json.data?.links) {
          setComponentLinks(json.data.links);
        }
      } catch {
        // best effort — no links means every room renders as a regular card
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pid, housekeeperId, authReady]);

  // Register the housekeeper service worker for offline shell + asset
  // caching. The action-queue replay logic lives in useOfflineSync; the
  // SW only handles cache-first asset serving so a brief connectivity
  // drop doesn't leave the housekeeper looking at an empty browser.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    let cancelled = false;
    void (async () => {
      try {
        await navigator.serviceWorker.register('/sw-housekeeper.js', { scope: '/housekeeper/' });
        if (cancelled) return;
        // best-effort — even if registration silently fails, the
        // IndexedDB replay queue still works.
      } catch {
        // ignore registration errors; offline replay still works
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Manual refetch path (also used after every action).
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
        const future = [...byDate.keys()].filter((d) => d > today).sort();
        if (future.length > 0) chosenDate = future[0];
        else {
          const past = [...byDate.keys()].filter((d) => d < today).sort().reverse();
          if (past.length > 0) chosenDate = past[0];
        }
      }
      setActiveDate(chosenDate);
      setRooms(sortRooms(byDate.get(chosenDate) ?? [], groupBy));
    } catch {
      // best-effort
    }
  }, [pid, housekeeperId, today, groupBy]);

  // Generic POST wrapper with re-entrancy guard.
  const guardedPost = useCallback(
    async (lockKey: string, url: string, body: object) => {
      if (inFlightRoomActionsRef.current.has(lockKey)) {
        return { ok: false, data: null as unknown };
      }
      inFlightRoomActionsRef.current.add(lockKey);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = (await res.json().catch(() => null)) as
          | { ok?: boolean; data?: unknown }
          | null;
        const ok = res.ok && !!json?.ok;
        if (ok) void refetchRooms();
        return { ok, data: json?.data ?? null };
      } finally {
        inFlightRoomActionsRef.current.delete(lockKey);
      }
    },
    [refetchRooms],
  );

  // Checklist template loader.
  const ensureChecklistLoaded = useCallback(
    async (cleaningType: string) => {
      if (!pid || !housekeeperId) return;
      if (checklistByType[cleaningType]) return;
      try {
        const res = await fetch(
          `/api/housekeeper/checklist/${cleaningType}?pid=${encodeURIComponent(pid)}&staffId=${encodeURIComponent(housekeeperId)}`,
        );
        const json = (await res.json().catch(() => null)) as
          | { ok?: boolean; data?: { template: { id: string } | null; items: ChecklistItem[] } }
          | null;
        if (res.ok && json?.ok && json.data) {
          setChecklistByType((prev) => ({
            ...prev,
            [cleaningType]: {
              templateId: json.data?.template?.id ?? null,
              items: json.data?.items ?? [],
            },
          }));
        }
      } catch {
        // best-effort
      }
    },
    [pid, housekeeperId, checklistByType],
  );

  // ── Action handlers ────────────────────────────────────────────────────
  const handleStart = useCallback(
    async (room: RoomRow) => {
      if (!pid) return;
      setSavingStart(room.id);
      try {
        void ensureChecklistLoaded(inferCleaningType(room.type));
        const res = await guardedPost(`start:${room.id}`, '/api/housekeeper/start-clean', {
          pid,
          staffId: housekeeperId,
          roomId: room.id,
        });
        if (!res.ok) showActionError(t('hkErrCouldntStart', lang));
      } finally {
        setSavingStart(null);
      }
    },
    [pid, housekeeperId, guardedPost, ensureChecklistLoaded, showActionError, lang],
  );

  const handlePause = useCallback(
    async (room: RoomRow) => {
      if (!pid) return;
      setSavingPause(room.id);
      try {
        const res = await guardedPost(`pause:${room.id}`, '/api/housekeeper/pause-clean', {
          pid,
          staffId: housekeeperId,
          roomId: room.id,
        });
        if (!res.ok) showActionError(t('hkErrCouldntPause', lang));
      } finally {
        setSavingPause(null);
      }
    },
    [pid, housekeeperId, guardedPost, showActionError, lang],
  );

  const handleResume = useCallback(
    async (room: RoomRow) => {
      if (!pid) return;
      setSavingResume(room.id);
      try {
        const res = await guardedPost(`resume:${room.id}`, '/api/housekeeper/resume-clean', {
          pid,
          staffId: housekeeperId,
          roomId: room.id,
        });
        if (!res.ok) showActionError(t('hkErrCouldntResume', lang));
      } finally {
        setSavingResume(null);
      }
    },
    [pid, housekeeperId, guardedPost, showActionError, lang],
  );

  const handleComplete = useCallback(
    async (room: RoomRow) => {
      if (!pid) return;
      setSavingComplete(room.id);
      try {
        const res = await guardedPost(
          `complete:${room.id}`,
          '/api/housekeeper/complete-clean',
          { pid, staffId: housekeeperId, roomId: room.id },
        );
        if (!res.ok) showActionError(t('hkErrCouldntComplete', lang));
      } finally {
        setSavingComplete(null);
      }
    },
    [pid, housekeeperId, guardedPost, showActionError, lang],
  );

  // Reset stays on the legacy room-action endpoint — same operation either
  // way; piece B may consolidate.
  const handleReset = useCallback(
    async (room: RoomRow) => {
      if (!pid) return;
      setSavingReset(room.id);
      try {
        const res = await fetch('/api/housekeeper/room-action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pid,
            staffId: housekeeperId,
            roomId: room.id,
            action: 'reset',
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (res.ok && json?.ok) {
          await refetchRooms();
        } else {
          showActionError(t('hkErrCouldntResetRoom', lang));
        }
      } finally {
        setSavingReset(null);
      }
    },
    [pid, housekeeperId, refetchRooms, showActionError, lang],
  );

  const handleException = useCallback(
    async (roomId: string, next: { type: ExceptionType | null; note: string | null }) => {
      if (!pid) return;
      try {
        const res = await fetch('/api/housekeeper/exception', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pid,
            staffId: housekeeperId,
            roomId,
            exceptionType: next.type,
            note: next.note,
            clear: next.type === null,
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (res.ok && json?.ok) {
          await refetchRooms();
        } else {
          showActionError(t('hkErrCouldntSaveException', lang));
        }
      } catch {
        showActionError(t('hkErrCouldntSaveException', lang));
      }
    },
    [pid, housekeeperId, refetchRooms, showActionError, lang],
  );

  // Issue reporting still uses the legacy route in piece A.
  const handleSubmitIssue = useCallback(async () => {
    if (!issueRoomId || !issueNote.trim() || !pid) return;
    setSavingIssue(true);
    try {
      const res = await fetch('/api/housekeeper/room-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pid,
          staffId: housekeeperId,
          roomId: issueRoomId,
          action: 'issue',
          issueNote: issueNote.trim(),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) throw new Error('save failed');
      setIssueRoomId(null);
      setIssueNote('');
      await refetchRooms();
    } catch {
      showActionError(t('hkErrCouldntSaveIssue', lang));
    } finally {
      setSavingIssue(false);
    }
  }, [issueRoomId, issueNote, pid, housekeeperId, refetchRooms, showActionError, lang]);

  // ── Derived state ──────────────────────────────────────────────────────
  const housekeeperName = rooms[0]?.assignedName ?? '';
  const firstName = housekeeperName.split(' ')[0] || 'Housekeeper';

  const total = rooms.length;
  const done = rooms.filter(
    (r) => r.status === 'clean' || r.status === 'inspected' || r.exceptionType,
  ).length;
  const inProgress = rooms.filter((r) => r.status === 'in_progress').length;
  const exceptionCount = rooms.filter((r) => r.exceptionType).length;
  const allDone = total > 0 && done === total;
  const progressPct = total > 0 ? Math.round((done / total) * 100) : 0;

  /**
   * Build the grouped list AND a stable room → index map in one pass so
   * the JobCard's "1.", "2.", … prefix stays consistent with the actual
   * sort order across renders. Indexes start at 1 to match how the
   * housekeeper counts ("seventh room of the day").
   */
  // Collapse component-room children — they're cleaned as part of their
  // parent so the housekeeper sees ONE card for a suite, not N cards for
  // every sub-room. The componentLinks list comes from the
  // component_rooms table (migration 0225) and is fetched per property.
  const visibleRooms = useMemo(
    () => collapseChildComponents(rooms, componentLinks),
    [rooms, componentLinks],
  );

  const { groups: groupedRooms, indexByRoomId } = useMemo(() => {
    const indexMap = new Map<string, number>();
    visibleRooms.forEach((r, i) => indexMap.set(r.id, i + 1));
    if (groupBy !== 'floor') {
      return {
        groups: [{ floor: null as string | null, rooms: visibleRooms }],
        indexByRoomId: indexMap,
      };
    }
    const map = new Map<string, RoomRow[]>();
    for (const r of visibleRooms) {
      const f = r.floor ?? floorFromRoomNumber(r.number);
      const list = map.get(f) ?? [];
      list.push(r);
      map.set(f, list);
    }
    const groups = Array.from(map.entries())
      .map(([floor, list]) => ({ floor, rooms: list }))
      .sort((a, b) => {
        const an = parseInt(a.floor ?? '', 10);
        const bn = parseInt(b.floor ?? '', 10);
        if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
        if (Number.isFinite(an)) return -1;
        if (Number.isFinite(bn)) return 1;
        return (a.floor ?? '').localeCompare(b.floor ?? '');
      });
    return { groups, indexByRoomId: indexMap };
  }, [visibleRooms, groupBy]);

  const checklistRoom = checklistRoomId ? rooms.find((r) => r.id === checklistRoomId) : null;
  const checklistTypeKey = checklistRoom ? inferCleaningType(checklistRoom.type) : null;
  const checklistData = checklistTypeKey ? checklistByType[checklistTypeKey] : undefined;

  const exceptionRoom = exceptionRoomId ? rooms.find((r) => r.id === exceptionRoomId) : null;

  // Default the accordion to the in-progress room (else the first room), and
  // keep the open id valid as the room list changes. Only auto-picks when the
  // current open id is gone — never fights a deliberate collapse mid-render.
  useEffect(() => {
    if (visibleRooms.length === 0) return;
    setOpenRoomId((cur) => {
      if (cur && visibleRooms.some((r) => r.id === cur)) return cur;
      const active = visibleRooms.find((r) => r.status === 'in_progress');
      return active ? active.id : visibleRooms[0].id;
    });
  }, [visibleRooms]);

  // ── Guards ─────────────────────────────────────────────────────────────
  if (!pid || !housekeeperId) {
    return (
      <div
        style={{
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: '12px',
          padding: '24px',
          background: 'var(--bg)',
          fontFamily: 'var(--font-sans, system-ui, -apple-system, sans-serif)',
          textAlign: 'center',
        }}
      >
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
      <div
        style={{
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: '12px',
          background: 'var(--bg)',
          fontFamily: 'var(--font-sans, system-ui, -apple-system, sans-serif)',
        }}
      >
        <div
          style={{
            width: '32px',
            height: '32px',
            border: '4px solid var(--border)',
            borderTopColor: 'var(--green)',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
          }}
        />
        <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>{t('loadingRooms', lang)}</p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: '100dvh',
        background: 'var(--green-bg, #F0FDF4)',
        fontFamily: 'var(--font-sans, system-ui, -apple-system, BlinkMacSystemFont, sans-serif)',
      }}
    >
      {/* ── Offline banner ── */}
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
          }}
        >
          {t('hkOffline', lang)}
        </div>
      )}

      {/* ── Error toast ── */}
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

      <div
        style={{
          maxWidth: '768px',
          margin: '0 auto',
          width: '100%',
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          background: '#F4F5F7',
        }}
      >
        {activeTab === 'rooms' ? (
        <div
          ref={roomsScrollRef}
          data-confetti-host
          style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: '#F4F5F7' }}
        >
        {/* ── Header (redesign: white) ── */}
        <div
          style={{
            background: 'white',
            padding: 'calc(env(safe-area-inset-top, 0px) + 18px) 16px 14px',
            borderBottom: '1px solid #EDEEF1',
            color: 'var(--text-primary)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
            <div style={{ minWidth: 0 }}>
              <h1
                style={{
                  fontSize: '21px',
                  fontWeight: 800,
                  letterSpacing: '-0.02em',
                  marginBottom: '2px',
                  lineHeight: 1.1,
                }}
              >
                {`${t('cxHelloPrefix', lang)}, ${firstName}`}
              </h1>
              <p style={{ fontSize: '12.5px', color: 'var(--text-muted)', fontWeight: 500, marginTop: 2 }}>
                {(() => {
                  const [y, m, d] = activeDate.split('-').map(Number);
                  const dateObj = new Date(y, (m ?? 1) - 1, d ?? 1);
                  const formatted = format(dateObj, 'EEEE, MMMM d', {
                    locale: lang === 'es' ? esLocale : undefined,
                  });
                  const base =
                    activeDate === today
                      ? formatted
                      : activeDate > today
                        ? `${t('hkNextShiftPrefix', lang)}${formatted}`
                        : `${t('hkLastShiftPrefix', lang)}${formatted}`;
                  return total > 0
                    ? `${base} · ${done}/${total} ${t('lndProgressDone', lang)}`
                    : base;
                })()}
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
              <LanguageSwitcher
                current={lang}
                onChange={async (next) => {
                  setLang(next);
                  if (housekeeperId && pid) {
                    try {
                      // server accepts the wider locale set (migration 0225);
                      // helper is typed to the bilingual Language for legacy callers.
                      await saveStaffLanguagePublic(
                        pid,
                        housekeeperId,
                        next as 'en' | 'es',
                      );
                    } catch {
                      // silent
                    }
                  }
                }}
              />
              <button
                onClick={() => roomsScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
                aria-label={t('hkAlerts', lang)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  height: 38,
                  padding: '0 12px',
                  borderRadius: 11,
                  border: '1px solid #ECEDF0',
                  background: 'white',
                  fontSize: 12.5,
                  fontWeight: 700,
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  WebkitTapHighlightColor: 'transparent',
                }}
              >
                <Bell size={16} /> {t('hkAlerts', lang)}
              </button>
            </div>
          </div>

          {total > 0 && (
            <div style={{ height: 6, borderRadius: 99, background: '#EDEEF1', marginTop: 14, overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  width: `${progressPct}%`,
                  background: progressPct === 100 ? 'var(--green)' : 'var(--teal)',
                  borderRadius: 99,
                  transition: 'width .6s cubic-bezier(.2,.8,.2,1)',
                }}
              />
            </div>
          )}
        </div>

        <InspectorView pid={pid} staffId={housekeeperId} lang={lang} />

        <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {/* Notice board banner — manager broadcasts. Renders nothing
              when there are no active or undismissed notices. */}
          <NoticeBoardBanner pid={pid} staffId={housekeeperId} lang={lang} />

          {/* Offline state surface — banner shows queued count when
              navigator.onLine is false, last drain summary when online. */}
          {!offline.online && offline.queueLength > 0 && (
            <div
              role="status"
              style={{
                padding: '10px 14px',
                background: '#1F2937',
                color: '#FBBF24',
                borderRadius: 10,
                fontSize: 13,
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span>📡</span>
              <span style={{ flex: 1 }}>
                {t('hkOfflineQueueCount', lang)} · {offline.queueLength}
              </span>
            </div>
          )}
          {offline.online && offline.draining && (
            <div
              role="status"
              style={{
                padding: '10px 14px',
                background: '#1E40AF',
                color: 'white',
                borderRadius: 10,
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              {t('hkOfflineSyncing', lang)}
            </div>
          )}
          {offline.online && offline.lastDrain && offline.lastDrain.failed > 0 && (
            <button
              onClick={offline.dismissFailures}
              style={{
                padding: '10px 14px',
                background: '#FEF2F2',
                border: '1px solid #FCA5A5',
                borderRadius: 10,
                fontSize: 13,
                fontWeight: 600,
                color: '#991B1B',
                textAlign: 'left',
                cursor: 'pointer',
              }}
            >
              {t('hkOfflineQueueFailed', lang)} ({offline.lastDrain.failed})
            </button>
          )}

          {/* "Your rooms · tap to open" eyebrow */}
          {total > 0 && !allDone && (
            <div
              style={{
                fontSize: 11.5,
                fontWeight: 800,
                color: '#9CA0A8',
                letterSpacing: '.1em',
                textTransform: 'uppercase',
                padding: '0 2px',
              }}
            >
              {t('hkYourRooms', lang)} · {t('hkTapToOpen', lang)}
            </div>
          )}

          {allDone && <AllRoomsCleanCard count={total} firstName={firstName} lang={lang} />}

          {total === 0 && (
            <div
              style={{
                textAlign: 'center',
                padding: '64px 24px',
                background: 'white',
                borderRadius: '20px',
                boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
              }}
            >
              <p style={{ fontSize: '16px', color: 'var(--text-muted)', lineHeight: 1.8 }}>
                <strong>{t('noRoomsAssigned', lang)}</strong>
                <br />
                {t('checkBackSoon', lang)}
              </p>
            </div>
          )}

          {groupedRooms.map((group) => (
            <div
              key={group.floor ?? 'all'}
              style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
            >
              {group.floor && (
                <div
                  style={{
                    fontSize: '12px',
                    fontWeight: 800,
                    color: '#6B7280',
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    padding: '6px 4px 0',
                  }}
                >
                  {t('hkFloorPrefix', lang)} {group.floor}
                </div>
              )}
              {group.rooms.map((room) => {
                const cleaningTypeKey = inferCleaningType(room.type);
                const checklist = checklistByType[cleaningTypeKey];
                const checklistChecked = (room.checklistProgress ?? []).length;
                const checklistTotal = checklist?.items.length ?? 0;
                const compLink = componentForRoom(room.number, componentLinks);
                return (
                  <RoomAccordionCard
                    key={room.id}
                    room={room}
                    lang={lang}
                    reservation={reservationsByRoom[room.number]}
                    open={openRoomId === room.id}
                    onToggle={() => setOpenRoomId((o) => (o === room.id ? null : room.id))}
                    isSavingStart={savingStart === room.id}
                    isSavingPause={savingPause === room.id}
                    isSavingResume={savingResume === room.id}
                    isSavingComplete={savingComplete === room.id}
                    isResetting={savingReset === room.id}
                    checklistChecked={checklistChecked}
                    checklistTotal={checklistTotal}
                    checklistLabels={(checklist?.items ?? []).map((it) =>
                      lang === 'es' ? it.itemEs : it.itemEn,
                    )}
                    onStart={() => handleStart(room)}
                    onPause={() => handlePause(room)}
                    onResume={() => handleResume(room)}
                    onComplete={(e) => {
                      confettiBurst(e.currentTarget, { count: 24 });
                      void handleComplete(room);
                      // auto-advance: open the next still-dirty room (design behavior)
                      const next = visibleRooms.find(
                        (r) => r.id !== room.id && r.status === 'dirty',
                      );
                      window.setTimeout(() => setOpenRoomId(next ? next.id : null), 420);
                    }}
                    onReset={() => handleReset(room)}
                    onOpenChecklist={() => {
                      void ensureChecklistLoaded(cleaningTypeKey);
                      setChecklistRoomId(room.id);
                    }}
                    onReportIssue={() => {
                      setIssueRoomId(room.id);
                      setIssueNote(room.issueNote ?? '');
                    }}
                    extraTopSlot={compLink ? (
                      <div style={{ marginBottom: 10 }}>
                        <ComponentRoomBadge link={compLink} lang={lang} />
                      </div>
                    ) : undefined}
                    extraActionsSlot={
                      <>
                        <AddNoteButton
                          pid={pid}
                          staffId={housekeeperId}
                          roomId={room.id}
                          lang={lang}
                          enqueueIfOffline={offline.enqueueIfOffline}
                          onError={showActionError}
                          initialNote={room.housekeeperNote ?? null}
                        />
                        <MarkForInspectionButton
                          pid={pid}
                          staffId={housekeeperId}
                          roomId={room.id}
                          lang={lang}
                          enqueueIfOffline={offline.enqueueIfOffline}
                          onError={showActionError}
                          markedAt={
                            room.markedForInspectionAt
                              ? new Date(room.markedForInspectionAt).toISOString()
                              : null
                          }
                        />
                        <ReportFoundItemButton
                          pid={pid}
                          staffId={housekeeperId}
                          roomNumber={room.number}
                          lang={lang}
                          enqueueIfOffline={offline.enqueueIfOffline}
                          onError={showActionError}
                        />
                        {/* exceptions (DND / NSR / late checkout …) — kept reachable
                            from the expanded card since the redesign drops the ⋯ menu */}
                        <button
                          onClick={() => setExceptionRoomId(room.id)}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '6px 10px',
                            border: '1px solid #E5E7EB',
                            borderRadius: 8,
                            background: 'white',
                            fontSize: 12,
                            fontWeight: 700,
                            color: '#6B7280',
                            cursor: 'pointer',
                            WebkitTapHighlightColor: 'transparent',
                          }}
                        >
                          ⋯ {t('hkException', lang)}
                        </button>
                      </>
                    }
                  />
                );
                })}
              </div>
          ))}

          {/* footer — Lunch + Report sick (2-col, moved below the list per redesign) */}
          {total > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9, marginTop: 2 }}>
              <LunchBreakButton
                pid={pid}
                staffId={housekeeperId}
                businessDate={activeDate}
                lang={lang}
                openBreakStartedAt={openBreakStartedAt}
                onChange={({ onBreak, startedAt }) =>
                  setOpenBreakStartedAt(onBreak ? (startedAt ?? new Date().toISOString()) : null)
                }
              />
              {!allDone && (
                <SickReportButton
                  pid={pid}
                  staffId={housekeeperId}
                  businessDate={activeDate}
                  language={lang}
                  isMidShift={inProgress > 0}
                  onCalloutChange={() => {
                    lastRefetchAtRef.current = Date.now();
                  }}
                />
              )}
            </div>
          )}

          {pid && housekeeperId && allDone && (
            <DailySummary
              pid={pid}
              staffId={housekeeperId}
              date={activeDate}
              lang={lang}
              visible={allDone}
            />
          )}
        </div>
        </div>
        ) : (
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: '#fff' }}>
            <MessagesTab lang={lang} onUnreadChange={setMessagesUnread} />
          </div>
        )}

        <BottomTabBar
          active={activeTab}
          unread={messagesUnread}
          onRooms={() => setActiveTab('rooms')}
          onMessages={() => setActiveTab('messages')}
          lang={lang}
        />

        {/* ── Modals ── */}
        {checklistRoom && checklistData && (
          <ChecklistModal
            roomNumber={checklistRoom.number}
            items={checklistData.items}
            initialCheckedIds={checklistRoom.checklistProgress ?? []}
            lang={lang}
            pid={pid}
            staffId={housekeeperId}
            roomId={checklistRoom.id}
            onClose={() => setChecklistRoomId(null)}
            onProgressChange={(ids) => {
              setRooms((curr) =>
                curr.map((r) =>
                  r.id === checklistRoom.id ? { ...r, checklistProgress: ids } : r,
                ),
              );
            }}
          />
        )}

        {exceptionRoom && (
          <ExceptionDropdown
            roomNumber={exceptionRoom.number}
            currentException={exceptionRoom.exceptionType ?? null}
            lang={lang}
            pid={pid}
            staffId={housekeeperId}
            roomId={exceptionRoom.id}
            onClose={() => setExceptionRoomId(null)}
            onSubmit={async (next) => {
              await handleException(exceptionRoom.id, next);
            }}
          />
        )}

        {issueRoomId && (() => {
          const issueRoom = rooms.find((r) => r.id === issueRoomId);
          if (!issueRoom) return null;
          return (
            <StructuredIssueReporter
              pid={pid}
              staffId={housekeeperId}
              roomId={issueRoom.id}
              roomNumber={issueRoom.number}
              lang={lang}
              online={offline.online}
              enqueueIfOffline={offline.enqueueIfOffline}
              onClose={() => {
                setIssueRoomId(null);
                setIssueNote('');
              }}
              onSubmitted={() => {
                void refetchRooms();
              }}
            />
          );
        })()}
      </div>
    </div>
  );
}
