'use client';

// Snow / simplified Schedule from the Claude Design housekeeping handoff
// (May 2026). The previous version was a 1500-line monolith with public
// areas, drag-to-assign, swap modals, prediction settings, and a Staff
// Priority modal. The user explicitly asked to strip Schedule down to:
//   • PMS pull strip with morning/evening toggle and 5 numbers visible
//   • crew rows with capacity bars + auto-assigned room pills
//   • action band at the bottom: Reset / Auto-assign / Send links
//
// Everything that backs the simpler UI — PlanSnapshot, ShiftConfirmations,
// ScheduleAssignments persistence, work-order blocking, the actual
// /api/send-shift-confirmations POST flow — is preserved. The dropped
// features (public areas, drag-to-assign, swap modals, prediction
// settings, priority modal) are gone from the JSX but their underlying
// data layer is untouched, so we can wire them back into a settings
// modal later if the user misses them.

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import {
  subscribeToPlanSnapshot,
  subscribeToShiftConfirmations,
  subscribeToScheduleAssignments,
  saveScheduleAssignments,
  subscribeToWorkOrders,
  subscribeToDashboardByDate,
  updateStaffMember,
  updateProperty,
} from '@/lib/db';
import type { PlanSnapshot, ScheduleAssignments, DashboardNumbers, CsvRoomSnapshot } from '@/lib/db';
import { autoAssignRooms } from '@/lib/calculations';
import type { ShiftConfirmation, WorkOrder, StaffMember, SchedulePriority } from '@/types';
import {
  defaultShiftDate, addDays, formatDisplayDate, snapshotToShiftRooms, formatPulledAt,
} from './_shared';
import {
  T, FONT_SANS, FONT_MONO, FONT_SERIF,
  Caps, Pill, Btn, HousekeeperDot,
} from './_snow';

type SendResult = { status: 'sent' | 'skipped' | 'failed'; reason?: string };

export function ScheduleTab() {
  const { user } = useAuth();
  const { activeProperty, activePropertyId, staff, refreshProperty } = useProperty();
  const { lang } = useLang();

  const [shiftDate, setShiftDate] = useState(defaultShiftDate);
  const [planSnapshot, setPlanSnapshot] = useState<PlanSnapshot | null>(null);
  // Flips true after the first plan-snapshot callback fires (with data or
  // null), so the PMS strip can show a skeleton during the initial fetch
  // instead of zero-counts that read like real data.
  const [planLoaded, setPlanLoaded] = useState(false);
  // 15-min Choice Advantage dashboard pull (In House / Arrivals /
  // Departures). Independent of the hourly CSV plan-snapshot above — each
  // refreshes on its own cadence and has its own loaded flag.
  const [dashboardNums, setDashboardNums] = useState<DashboardNumbers | null>(null);
  const [dashboardLoaded, setDashboardLoaded] = useState(false);
  const [confirmations, setConfirmations] = useState<ShiftConfirmation[]>([]);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [crewIds, setCrewIds] = useState<string[]>([]);
  // `crewExplicit` distinguishes "user has actively set the crew (even
  // to empty)" from "no saved crew yet, fall back to all housekeeping
  // staff." Without this flag, a user who removes everyone via the
  // Remove buttons would have their empty list silently overridden
  // with the full default crew on the next render — the "manager can't
  // clear everyone" regression.
  const [crewExplicit, setCrewExplicit] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendResults, setSendResults] = useState<Map<string, SendResult>>(new Map());
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track which date our local state has been hydrated for. Without this,
  // the debounced persist effect can fire while we're mid-date-switch and
  // overwrite the new date's saved doc with the previous date's
  // assignments. Same class of bug as the 2026-05-07 "Maria's rooms
  // reshuffled" incident — re-introduced when the tab was rewritten, now
  // re-fixed.
  const hydratedDate = useRef<string | null>(null);

  // Tracks the (assignments, crew) snapshot we last persisted. Realtime
  // echoes our own writes back through the subscription, which without
  // this guard would re-trigger the persist effect and create a save
  // loop — the cause of the "Auto-assign is laggy / kind of works" bug.
  // Compared as JSON strings since both are plain objects/arrays.
  const lastWrittenRef = useRef<{ a: string; c: string } | null>(null);

  // Click-to-move + drag-to-move. floatingRoomId is the picked-up room
  // (a tap or a drag on a pill sets it). cursorPos drives the floating
  // ghost that follows the pointer so Maria sees what she's holding.
  // dragStartRef tracks the press so we can distinguish a tap (no move)
  // from a drag (>8px move) — taps stay floating until the next tap on
  // a target; drags commit at the element under the cursor on release.
  const [floatingRoomId, setFloatingRoomId] = useState<string | null>(null);
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  const [floatingRoomMeta, setFloatingRoomMeta] = useState<{ number: string; type: string } | null>(null);
  const dragStartRef = useRef<{ x: number; y: number; roomId: string; meta: { number: string; type: string }; crossed: boolean } | null>(null);
  // Set immediately after a drag-and-drop commit so the synthesized
  // click that follows pointerup is treated as a no-op. Without this,
  // the click would bubble to the pill / card the cursor was over and
  // re-toggle floating or re-commit on top of the drop.
  const wasDragRef = useRef(false);

  // Staff Priority modal — frozen order captured at open so re-saving
  // doesn't re-sort the list under the user's cursor.
  const [showPriority, setShowPriority] = useState(false);
  const frozenStaffOrder = useRef<string[]>([]);

  // Swap dropdown: which housekeeper's name was clicked to open the
  // "swap with..." menu. Keyed by staff ID.
  const [swapOpenFor, setSwapOpenFor] = useState<string | null>(null);

  // Frozen room snapshot from the last save. Used to detect overnight
  // CSV changes — if today's planSnapshot.rooms differs from what was
  // captured when Maria last saved (typically yesterday at 7pm), the
  // PMS strip surfaces an "overnight" badge with the +/− counts so
  // she knows to re-run auto-assign.
  const [savedCsvSnapshot, setSavedCsvSnapshot] = useState<CsvRoomSnapshot[]>([]);

  // Prediction Settings modal — lets the user tune per-property cleaning
  // minutes (checkout / stayover Day 1 / stayover Day 2 / prep) and the
  // shift cap, which all feed the auto-assign algorithm and the per-HK
  // capacity bars. Form state is seeded from activeProperty when the
  // modal opens so the inputs always reflect the current persisted values.
  const [showSettings, setShowSettings] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsForm, setSettingsForm] = useState({
    checkoutMinutes: 30,
    stayoverDay1Minutes: 15,
    stayoverDay2Minutes: 20,
    prepMinutesPerActivity: 5,
    shiftMinutes: 420,
  });

  const uid = user?.uid ?? '';
  const pid = activePropertyId ?? '';

  // Switching dates: clear local state immediately and mark un-hydrated
  // so the persist guard below skips the next debounced save until the
  // subscription callback re-fires for the new date.
  useEffect(() => {
    hydratedDate.current = null;
    lastWrittenRef.current = null;
    setAssignments({});
    setCrewIds([]);
    setCrewExplicit(false);
    setSendResults(new Map());
    setFloatingRoomId(null);
    setFloatingRoomMeta(null);
    setCursorPos(null);
    setSwapOpenFor(null);
    setSavedCsvSnapshot([]);
  }, [shiftDate]);

  // ── Subscriptions ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!pid) return;
    setDashboardLoaded(false);
    return subscribeToDashboardByDate(pid, shiftDate, (nums) => {
      setDashboardNums(nums);
      setDashboardLoaded(true);
    });
  }, [pid, shiftDate]);

  useEffect(() => {
    if (!uid || !pid) return;
    setPlanLoaded(false);
    return subscribeToPlanSnapshot(uid, pid, shiftDate, (snap) => {
      setPlanSnapshot(snap);
      setPlanLoaded(true);
    });
  }, [uid, pid, shiftDate]);

  // Hydrate from saved doc inside the subscription callback so we know
  // exactly when the doc for the current date has loaded — required by
  // the persist guard above.
  //
  // Anti-echo: realtime fires after our own writes, delivering the same
  // data we just saved with a brand-new object reference. Without the
  // JSON-key compare below, setAssignments(newRef) re-renders → persist
  // effect re-fires → another save → another echo → save loop ("Auto-
  // assign laggy" bug). The setState callback form lets React bail out
  // when the payload hasn't actually changed.
  useEffect(() => {
    if (!uid || !pid) return;
    return subscribeToScheduleAssignments(uid, pid, shiftDate, (doc) => {
      const newAssignments = doc?.roomAssignments ?? {};
      const newCrew = doc?.crew ?? [];
      const newSnapshot = doc?.csvRoomSnapshot ?? [];

      setAssignments(prev => {
        const prevKey = JSON.stringify(prev);
        const nextKey = JSON.stringify(newAssignments);
        return prevKey === nextKey ? prev : newAssignments;
      });
      setCrewIds(prev => {
        const prevKey = JSON.stringify(prev);
        const nextKey = JSON.stringify(newCrew);
        return prevKey === nextKey ? prev : newCrew;
      });
      setSavedCsvSnapshot(prev => {
        const prevKey = JSON.stringify(prev);
        const nextKey = JSON.stringify(newSnapshot);
        return prevKey === nextKey ? prev : newSnapshot;
      });
      // A saved doc is by definition an explicit choice — respect the
      // crew list even when it's empty.
      setCrewExplicit(!!doc);

      // Seed lastWrittenRef so the persist effect doesn't immediately
      // try to save what we just hydrated.
      lastWrittenRef.current = {
        a: JSON.stringify(newAssignments),
        c: JSON.stringify(newCrew),
      };
      hydratedDate.current = shiftDate;
    });
  }, [uid, pid, shiftDate]);

  useEffect(() => {
    if (!uid || !pid) return;
    return subscribeToShiftConfirmations(uid, pid, shiftDate, setConfirmations);
  }, [uid, pid, shiftDate]);

  useEffect(() => {
    if (!uid || !pid) return;
    return subscribeToWorkOrders(uid, pid, setWorkOrders);
  }, [uid, pid]);

  // ── Derived: shift rooms from CSV pull ────────────────────────────────
  const shiftRooms = useMemo(() => snapshotToShiftRooms(planSnapshot, pid), [planSnapshot, pid]);

  const blockedRoomNumbers = useMemo(() => {
    const set = new Set<string>();
    for (const o of workOrders) if (o.status !== 'resolved' && o.blockedRoom) set.add(o.roomNumber);
    return set;
  }, [workOrders]);

  // Rooms eligible for cleaning. Excludes:
  //   1. Blocked rooms (open work orders with blockedRoom=true).
  //   2. DND rooms — guest flagged "do not disturb" so the housekeeper
  //      can't enter. They re-appear next refresh once the HK clears
  //      DND from their phone. Without this filter, auto-assign would
  //      hand someone a room they physically can't service today.
  const assignableRooms = useMemo(
    () => shiftRooms.filter(r => !blockedRoomNumbers.has(r.number) && !r.isDnd),
    [shiftRooms, blockedRoomNumbers],
  );

  const checkouts = assignableRooms.filter(r => r.type === 'checkout').length;
  const stayoverDay1 = assignableRooms.filter(r => r.type === 'stayover' && r.stayoverDay === 1).length;
  const stayoverDay2 = assignableRooms.filter(r => r.type === 'stayover' && r.stayoverDay === 2).length;

  // Time math — checkout 30m + stayoverDay1 15m + stayoverDay2 20m by default,
  // or whatever Maria has set in Property settings.
  const ckMin   = activeProperty?.checkoutMinutes      ?? 30;
  const so1Min  = activeProperty?.stayoverDay1Minutes  ?? 15;
  const so2Min  = activeProperty?.stayoverDay2Minutes  ?? 20;
  const totalMinutes = checkouts * ckMin + stayoverDay1 * so1Min + stayoverDay2 * so2Min;
  // Per-housekeeper shift cap. Property setting (default 420 = 7h),
  // not a hardcoded 8h — the auto-assign algorithm and the capacity
  // bars MUST agree on the same number, or the bars will misrepresent
  // what auto-assign actually produced.
  const SHIFT_MINS = activeProperty?.shiftMinutes ?? 420;
  // Recommended housekeeping headcount = cleaning crew needed to cover
  // the total cleaning minutes within shift hours, plus 1 dedicated to
  // laundry. Matches the previous version's `recommendedStaff` formula.
  const LAUNDRY_STAFF = 1;
  const recommendedHKs = Math.max(1, Math.ceil(totalMinutes / SHIFT_MINS)) + LAUNDRY_STAFF;

  // Crew = the staff IDs we're scheduling today. Default to active
  // housekeeping staff if no override has been saved yet. Using
  // `s.isActive !== false` (rather than `=== true`) and a permissive
  // department check means seeded rows with undefined fields still
  // appear — matches the historical behavior on the staff page.
  const housekeepingStaff = useMemo(
    () => staff.filter(s => s.isActive !== false && (!s.department || s.department === 'housekeeping')),
    [staff],
  );

  const activeCrew: StaffMember[] = useMemo(() => {
    // Use the user's explicit crew list once they've made any change
    // (including emptying it). Otherwise fall back to the default.
    const ids = crewExplicit ? crewIds : housekeepingStaff.map(s => s.id);
    return ids.map(id => staff.find(s => s.id === id)).filter((s): s is StaffMember => Boolean(s));
  }, [crewIds, crewExplicit, housekeepingStaff, staff]);

  const offCrew = useMemo(
    () => housekeepingStaff.filter(s => !activeCrew.some(c => c.id === s.id)),
    [housekeepingStaff, activeCrew],
  );

  // Overnight diff. Compares the room list from the current planSnapshot
  // against the snapshot Maria captured the last time she saved (typically
  // the prior evening's plan). Returns null when there's nothing to flag —
  // either no saved snapshot exists yet, or the lists are identical — so
  // the strip stays clean on a normal day.
  const morningDiff = useMemo(() => {
    if (!planSnapshot || savedCsvSnapshot.length === 0) return null;
    const current = new Map<string, 'checkout' | 'stayover'>(
      planSnapshot.rooms.map(r => [
        r.number,
        r.stayType === 'C/O' ? 'checkout' : 'stayover',
      ]),
    );
    const saved = new Map<string, 'checkout' | 'stayover'>(
      savedCsvSnapshot.map(r => [r.number, r.type]),
    );
    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];
    for (const [num] of current) if (!saved.has(num)) added.push(num);
    for (const [num] of saved) if (!current.has(num)) removed.push(num);
    for (const [num, t] of current) {
      const prev = saved.get(num);
      if (prev && prev !== t) changed.push(num);
    }
    if (added.length === 0 && removed.length === 0 && changed.length === 0) return null;
    return { added, removed, changed };
  }, [planSnapshot, savedCsvSnapshot]);

  // Rooms not currently assigned to a member of the active crew. Catches
  // both genuinely unassigned rooms (assignments[id] is undefined) and
  // orphaned rooms whose previously-assigned housekeeper has been
  // removed from today's roster — both flavours need to show up in the
  // "Unassigned" strip so the user can re-place them.
  const unassignedRooms = useMemo(() => {
    const activeIds = new Set(activeCrew.map(s => s.id));
    return assignableRooms.filter(r => {
      const assigned = assignments[r.id];
      return !assigned || !activeIds.has(assigned);
    });
  }, [assignableRooms, assignments, activeCrew]);

  const fmtTime = (mins: number) => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ''}` : `${m}m`;
  };

  // ── Persist (debounced) ───────────────────────────────────────────────
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persist = useCallback(() => {
    if (!uid || !pid) return;
    // Only save once we've confirmed the saved doc for the current date
    // has loaded. Without this, the initial-mount empty state would
    // clobber an existing doc within 500ms of opening the tab.
    if (hydratedDate.current !== shiftDate) return;

    // Skip if state hasn't changed since the last save. Realtime echoes
    // our own writes back through the subscription; without this check
    // we'd save → echo → setState → persist effect re-fires → save…
    // (the "Auto-assign laggy" infinite loop).
    const crewIdList = activeCrew.map(s => s.id);
    const aKey = JSON.stringify(assignments);
    const cKey = JSON.stringify(crewIdList);
    if (lastWrittenRef.current?.a === aKey && lastWrittenRef.current?.c === cKey) return;

    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const staffNames: Record<string, string> = {};
      activeCrew.forEach(s => { staffNames[s.id] = s.name; });
      // Capture the room list at save time so the next morning's diff
      // can detect which rooms were added/removed/type-flipped between
      // last night's plan and the morning's fresh CSV pull. Map from
      // PlanSnapshot's `stayType` field to the CsvRoomSnapshot enum
      // the schedule_assignments table expects.
      const csvSnapshot: CsvRoomSnapshot[] = (planSnapshot?.rooms ?? []).map(r => ({
        number: r.number,
        type: r.stayType === 'C/O' ? 'checkout' : 'stayover',
      }));
      const csvPulledAtIso = planSnapshot?.pulledAt
        ? (planSnapshot.pulledAt instanceof Date
            ? planSnapshot.pulledAt.toISOString()
            : String(planSnapshot.pulledAt))
        : null;
      lastWrittenRef.current = { a: aKey, c: cKey };
      saveScheduleAssignments(uid, pid, shiftDate, {
        roomAssignments: assignments,
        crew: crewIdList,
        staffNames,
        csvRoomSnapshot: csvSnapshot,
        csvPulledAt: csvPulledAtIso,
      }).catch(err => console.error('[Schedule] save failed:', err));
    }, 500);
    // planSnapshot IS in the dep array — when the CSV refreshes mid-edit
    // we want a subsequent save (triggered by an assignment change) to
    // capture the latest room list. The lastWrittenRef check above
    // means a CSV-only refresh (no assignment change) re-creates this
    // callback but bails out at save time, so no spurious writes.
  }, [uid, pid, shiftDate, assignments, activeCrew, planSnapshot]);

  useEffect(() => {
    persist();
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [persist]);

  // ── Handlers ──────────────────────────────────────────────────────────
  // Once-loaded gate: assignment-mutating handlers are disabled (and
  // refuse to fire) until the saved doc for the current date has
  // finished hydrating. Without this, a click on Auto-assign or Reset
  // immediately after switching dates can be silently overwritten by
  // the in-flight subscription callback that arrives a moment later.
  const ready = hydratedDate.current === shiftDate;

  const handleAutoAssign = () => {
    if (!ready) return;
    // Pass the SAME shift cap the UI uses for capacity bars / recommended-HK
    // math. Hardcoding 420 here while the UI reads activeProperty.shiftMinutes
    // would produce bars that disagree with what the algorithm actually
    // distributed (audit finding #1).
    const config = {
      checkoutMinutes:    ckMin,
      stayoverDay1Minutes: so1Min,
      stayoverDay2Minutes: so2Min,
      stayoverMinutes:     activeProperty?.stayoverMinutes      ?? 20,
      prepMinutesPerActivity: activeProperty?.prepMinutesPerActivity ?? 5,
      shiftMinutes:        SHIFT_MINS,
    };
    const next = autoAssignRooms(assignableRooms, activeCrew, config);
    setAssignments(next);
    flashToast(lang === 'es' ? 'Cuartos auto-asignados' : 'Rooms auto-assigned');
  };

  const handleReset = () => {
    if (!ready) return;
    setAssignments({});
    flashToast(lang === 'es' ? 'Asignaciones reseteadas' : 'Assignments reset');
  };

  const handleSend = async () => {
    if (sending || !uid || !pid) return;
    setSending(true);
    try {
      const baseUrl = window.location.origin;
      const staffPayload = activeCrew.map(s => ({
        staffId: s.id,
        name: s.name,
        phone: s.phone ?? '',
        language: s.language,
        assignedRooms: assignableRooms.filter(r => assignments[r.id] === s.id).map(r => r.number),
        assignedAreas: [] as string[],
      }));
      const idempotencyKey = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `send-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

      const res = await fetchWithAuth('/api/send-shift-confirmations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ uid, pid, shiftDate, baseUrl, staff: staffPayload }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        data?: {
          sent?: number; failed?: number; skipped?: number; updated?: number; fresh?: number;
          perStaff?: Array<{ staffId: string; status: 'sent' | 'skipped' | 'failed'; reason?: string }>;
        };
      };
      const data = body?.data ?? {};
      if (data.perStaff) {
        const m = new Map<string, SendResult>();
        data.perStaff.forEach(r => m.set(r.staffId, { status: r.status, reason: r.reason }));
        setSendResults(m);
      }
      const parts: string[] = [];
      if ((data.fresh ?? 0)   > 0) parts.push(`${data.fresh} ${lang === 'es' ? 'enlaces' : 'links'}`);
      if ((data.updated ?? 0) > 0) parts.push(`${data.updated} ${lang === 'es' ? 'actualizados' : 'updates'}`);
      if ((data.skipped ?? 0) > 0) parts.push(`${data.skipped} ${lang === 'es' ? 'omitidos' : 'skipped'}`);
      if ((data.failed ?? 0)  > 0) parts.push(`${data.failed} ${lang === 'es' ? 'fallaron' : 'failed'}`);
      flashToast(parts.length
        ? `${lang === 'es' ? 'Enviado' : 'Sent'}: ${parts.join(' · ')}`
        : (lang === 'es' ? 'Enviado' : 'Sent'));
    } catch (err) {
      console.error('[Schedule] send failed:', err);
      flashToast(lang === 'es' ? 'Error al enviar' : 'Send failed');
    } finally {
      setSending(false);
    }
  };

  const flashToast = (msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  };

  // Mint a single-use magic-link URL for a housekeeper. Goes through the
  // /api/staff-link endpoint so the URL carries a fresh token. Falls
  // back to the tokenless route if the API fails — Maria can still open
  // the page on a signed-in device.
  const mintLink = useCallback(async (staffId: string): Promise<string> => {
    try {
      const res = await fetchWithAuth('/api/staff-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffId, pid }),
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: { url?: string } } | null;
      if (json?.data?.url) return json.data.url;
    } catch (err) {
      console.error('[Schedule] mintLink failed:', err);
    }
    return `${window.location.origin}/housekeeper/${staffId}?pid=${pid}`;
  }, [pid]);

  // Click-to-move handlers. The floating room is the one the user just
  // tapped or started dragging; the next tap on a housekeeper card or
  // the unassigned strip (or releasing a drag over one) commits the
  // move. Tapping the same pill again cancels; ESC also cancels.
  const moveRoomTo = useCallback((roomId: string, targetStaffId: string | null) => {
    setAssignments(prev => {
      const next = { ...prev };
      if (targetStaffId) next[roomId] = targetStaffId;
      else delete next[roomId];
      return next;
    });
    setFloatingRoomId(null);
    setFloatingRoomMeta(null);
    setCursorPos(null);
  }, []);

  // Swap one housekeeper for another. ALL of A's rooms transfer to B,
  // and B replaces A in the crew list. If B was off-crew today they
  // join the crew automatically.
  const swapStaff = useCallback((oldId: string, newId: string) => {
    setAssignments(prev => {
      const next: Record<string, string> = {};
      for (const [roomId, staffId] of Object.entries(prev)) {
        next[roomId] = staffId === oldId ? newId : staffId;
      }
      return next;
    });
    const baseline = crewExplicit ? crewIds : housekeepingStaff.map(s => s.id);
    const swapped = baseline.includes(newId)
      ? baseline.filter(id => id !== oldId)
      : baseline.map(id => id === oldId ? newId : id);
    setCrewIds(swapped);
    setCrewExplicit(true);
    setSwapOpenFor(null);
  }, [crewExplicit, crewIds, housekeepingStaff]);

  // ESC cancels a floating room, closes the swap dropdown, and closes
  // the priority modal — keyboard escape hatch out of any open overlay.
  useEffect(() => {
    if (!floatingRoomId && !swapOpenFor && !showPriority) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setFloatingRoomId(null);
      setFloatingRoomMeta(null);
      setCursorPos(null);
      setSwapOpenFor(null);
      setShowPriority(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [floatingRoomId, swapOpenFor, showPriority]);

  // Document-level pointer tracking. Drives the floating ghost (so the
  // pill follows the cursor while held / floating) AND the drag-and-drop
  // commit (release over a target hands the room off; release over
  // empty space leaves it floating for a click-to-drop). Watches for
  // both the in-progress drag (dragStartRef) and the standing floating
  // state (when the user just clicked a pill).
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      // While floating (after a click), keep the ghost glued to the cursor.
      if (floatingRoomId) {
        setCursorPos({ x: e.clientX, y: e.clientY });
      }
      // While a press is in progress, watch for the threshold crossing —
      // 8px of movement promotes the press into a drag, which seeds the
      // floating state and lights up the ghost without waiting for the
      // user to release.
      const start = dragStartRef.current;
      if (!start) return;
      if (!start.crossed) {
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (Math.hypot(dx, dy) > 8) {
          start.crossed = true;
          setFloatingRoomId(start.roomId);
          setFloatingRoomMeta(start.meta);
          setCursorPos({ x: e.clientX, y: e.clientY });
        }
      } else {
        setCursorPos({ x: e.clientX, y: e.clientY });
      }
    };

    const onUp = (e: PointerEvent) => {
      const start = dragStartRef.current;
      dragStartRef.current = null;
      // Pure-click case is handled by the pill's own onClick handler
      // (synthesized after pointerup). The document handler is only
      // responsible for resolving drag drops.
      if (!start || !start.crossed) return;

      // Drag end. Resolve the drop target via what the cursor is over.
      // We tag valid targets with data-drop-target=<staffId> (or the
      // sentinel "__unassigned__") so this lookup needs no React refs.
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const dropEl = el?.closest('[data-drop-target]') as HTMLElement | null;
      const targetAttr = dropEl?.getAttribute('data-drop-target') ?? null;
      if (targetAttr) {
        const targetId = targetAttr === '__unassigned__' ? null : targetAttr;
        moveRoomTo(start.roomId, targetId);
        flashToast(targetId === null
          ? (lang === 'es' ? 'Cuarto sin asignar' : 'Room moved to Unassigned')
          : (lang === 'es' ? 'Cuarto movido' : 'Room moved'));
      }
      // else: dropped on empty space — keep floating so the next
      // tap on a card commits.

      // Suppress the synthesized click that's about to fire on
      // whatever element the cursor is over (otherwise it'd re-toggle
      // floating on a pill, or re-commit via a card's onClick).
      wasDragRef.current = true;
      window.setTimeout(() => { wasDragRef.current = false; }, 120);
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
  }, [floatingRoomId, moveRoomTo, lang]);

  // Click outside the open swap dropdown closes it. Detected by walking
  // the event target's ancestors looking for `data-swap-dropdown` (the
  // dropdown itself) or `data-swap-trigger` (the name button — that
  // button toggles via its own onClick, so we must let it through).
  useEffect(() => {
    if (!swapOpenFor) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('[data-swap-dropdown]')) return;
      if (target.closest('[data-swap-trigger]')) return;
      setSwapOpenFor(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [swapOpenFor]);

  // Clear any pending toast timer on unmount so a delayed setToast(null)
  // can't fire after the component is gone (React warns + leaks state).
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  // Shift back/forward controls — date stepper
  const today = useMemo(() => new Date().toLocaleDateString('en-CA'), []);
  const isToday = shiftDate === today;
  const isYesterday = shiftDate === addDays(today, -1);
  const isTomorrow = shiftDate === addDays(today, 1);

  // formatPulledAt prefixes "Today" vs the weekday so a 2-day-old pull
  // and a 1-min-old pull don't both show the same time-of-day. Coerce
  // pulledAt to ISO string for the helper (it can come through as Date
  // from Supabase or string from a cached snapshot).
  const pulledAtIso = planSnapshot?.pulledAt
    ? (planSnapshot.pulledAt instanceof Date
        ? planSnapshot.pulledAt.toISOString()
        : String(planSnapshot.pulledAt))
    : null;
  const pulledAtLabel = pulledAtIso
    ? formatPulledAt(pulledAtIso, lang)
    : (lang === 'es' ? 'sin datos' : 'no data');

  // Confirmation status pill helper. Returns null when the status is
  // unknown / no confirmation row exists — the old "No reply" fallback
  // was a defensive pill that just added visual noise (Reeyen never wants
  // to see it).
  const confPill = (staffId: string) => {
    const conf = confirmations.find(c => c.staffId === staffId);
    if (!conf) return null;
    if (conf.status === 'confirmed') return <Pill tone="sage">✓ {lang === 'es' ? 'Confirmado' : 'Confirmed'}</Pill>;
    if (conf.status === 'declined')  return <Pill tone="warm">{lang === 'es' ? 'Rechazado' : 'Declined'}</Pill>;
    if (conf.status === 'pending')   return <Pill tone="neutral">{lang === 'es' ? 'Pendiente' : 'Pending'}</Pill>;
    return null;
  };

  // Send result badge
  const sendBadge = (staffId: string) => {
    const r = sendResults.get(staffId);
    if (!r) return null;
    if (r.status === 'sent')    return <Pill tone="sage">→ {lang === 'es' ? 'Enviado' : 'Link sent'}</Pill>;
    if (r.status === 'skipped') return <Pill tone="caramel">{lang === 'es' ? 'Omitido' : 'Skipped'}{r.reason ? ` · ${r.reason}` : ''}</Pill>;
    if (r.status === 'failed')  return <Pill tone="warm">{lang === 'es' ? 'Falló' : 'Failed'}</Pill>;
    return null;
  };

  return (
    <div style={{
      padding: '24px 48px 48px', background: T.bg, color: T.ink,
      fontFamily: FONT_SANS, minHeight: 'calc(100dvh - 130px)',
    }}>

      {/* DATE STEPPER */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
        marginBottom: 18, gap: 24, flexWrap: 'wrap',
      }}>
        <div>
          <Caps>{
            // Show "Schedule" alone for arbitrary past/future dates so we
            // don't render "Schedule · " with a dangling middle-dot.
            (() => {
              if (isToday)     return lang === 'es' ? 'Horario · hoy'     : 'Schedule · today';
              if (isYesterday) return lang === 'es' ? 'Horario · ayer'    : 'Schedule · yesterday';
              if (isTomorrow)  return lang === 'es' ? 'Horario · mañana'  : 'Schedule · tomorrow';
              return lang === 'es' ? 'Horario' : 'Schedule';
            })()
          }</Caps>
          <h1 style={{
            fontFamily: FONT_SERIF, fontSize: 36, color: T.ink, margin: '4px 0 0',
            letterSpacing: '-0.03em', lineHeight: 1.25, fontWeight: 400,
          }}>
            <span style={{ fontStyle: 'italic' }}>{formatDisplayDate(shiftDate, lang).split(',')[0]}</span>
            <span> · {formatDisplayDate(shiftDate, lang).split(',').slice(1).join(',').trim()}</span>
          </h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Btn variant="ghost" size="sm" onClick={() => setShiftDate(addDays(shiftDate, -1))}>← {lang === 'es' ? 'Ayer' : 'Yesterday'}</Btn>
          <Btn variant={isToday ? 'paper' : 'ghost'} size="sm" onClick={() => setShiftDate(today)}>{lang === 'es' ? 'Hoy' : 'Today'}</Btn>
          <Btn variant="ghost" size="sm" onClick={() => setShiftDate(addDays(shiftDate, 1))}>{lang === 'es' ? 'Mañana' : 'Tomorrow'} →</Btn>
        </div>
      </div>

      {/* PMS PULL STRIP — current pull's numbers in plain sight.
          The design also showed ‹/› buttons toggling between morning and
          evening pulls, but the underlying subscription only gives us the
          most-recent pull for the date. Rather than render lying buttons
          we just show the current pull's freshness; we'll add real
          history navigation when the data layer supports it. */}
      <div style={{
        background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18,
        padding: '18px 22px', marginBottom: 18,
        display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 160 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Caps size={9}>{lang === 'es' ? 'Última carga PMS' : 'Latest PMS pull'}</Caps>
            {/* Cleaning-time settings live behind the gear so the strip
                stays uncluttered. Opens the Prediction Settings modal,
                seeded from activeProperty. */}
            <button
              onClick={() => {
                setSettingsForm({
                  checkoutMinutes:        activeProperty?.checkoutMinutes        ?? 30,
                  stayoverDay1Minutes:    activeProperty?.stayoverDay1Minutes    ?? 15,
                  stayoverDay2Minutes:    activeProperty?.stayoverDay2Minutes    ?? 20,
                  prepMinutesPerActivity: activeProperty?.prepMinutesPerActivity ?? 5,
                  shiftMinutes:           activeProperty?.shiftMinutes           ?? 420,
                });
                setShowSettings(true);
              }}
              title={lang === 'es' ? 'Ajustes de cuartos / turno' : 'Cleaning-time settings'}
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                padding: 2, borderRadius: 4, color: T.ink3,
                display: 'inline-flex', alignItems: 'center',
              }}
              aria-label={lang === 'es' ? 'Ajustes' : 'Settings'}
            >
              <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </div>
          <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink, fontWeight: 500, marginTop: 2 }}>
            {planLoaded ? pulledAtLabel : (lang === 'es' ? 'Cargando…' : 'Loading…')}
          </span>
        </div>
        <span style={{ width: 1, height: 42, background: T.rule }} />
        <div style={{ display: 'flex', gap: 32, flex: 1, flexWrap: 'wrap' }}>
          {/* Skeleton dashes until each source's first callback fires
              — without this, the strip momentarily reads "Checkouts: 0
              · Stay·light: 0 · Recommended: 1 HKs" which looks like real
              data on a slow pull. The first five cells come from the
              hourly CSV plan snapshot; the last three come from the
              15-min Choice Advantage dashboard pull. Each cell uses
              its own `loaded` flag so a slow dashboard pull doesn't
              hold back the CSV numbers (or vice versa). */}
          {([
            { l: lang === 'es' ? 'En Casa'      : 'In House',    v: dashboardNums?.inHouse    ?? null, loaded: dashboardLoaded },
            { l: lang === 'es' ? 'Llegadas'     : 'Arrivals',    v: dashboardNums?.arrivals   ?? null, loaded: dashboardLoaded },
            { l: lang === 'es' ? 'Salen'        : 'Departures',  v: dashboardNums?.departures ?? null, loaded: dashboardLoaded },
            { l: lang === 'es' ? 'Salidas'      : 'Checkouts',   v: checkouts,             loaded: planLoaded },
            { l: lang === 'es' ? 'Estadía·1'    : 'Stay · light',v: stayoverDay1,          loaded: planLoaded },
            { l: lang === 'es' ? 'Estadía·2+'   : 'Stay · full', v: stayoverDay2,          loaded: planLoaded },
            { l: lang === 'es' ? 'Tiempo total' : 'Total time',  v: fmtTime(totalMinutes), loaded: planLoaded },
            { l: lang === 'es' ? 'Recomendado'  : 'Recommended', v: `${recommendedHKs} HKs`, loaded: planLoaded, tone: T.sageDeep },
          ] as Array<{ l: string; v: React.ReactNode; loaded: boolean; tone?: string }>).map(n => (
            <div key={n.l} style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 80 }}>
              <Caps size={9}>{n.l}</Caps>
              <span style={{
                fontFamily: FONT_SERIF, fontSize: 30, color: n.loaded ? (n.tone || T.ink) : T.ink3,
                lineHeight: 1, letterSpacing: '-0.02em', fontWeight: 400, whiteSpace: 'nowrap',
              }}>{n.loaded && n.v != null ? n.v : '—'}</span>
            </div>
          ))}
          {/* Overnight diff — only renders when today's CSV differs from
              the room list captured at last save. Shows compact +/− counts
              with a hover-tooltip listing the affected room numbers, so
              Maria knows whether to re-run auto-assign without scanning
              the rooms by eye. Stays absent on a normal day. */}
          {morningDiff && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 110 }}>
              <Caps size={9}>{lang === 'es' ? 'Cambio nocturno' : 'Overnight'}</Caps>
              <span
                title={[
                  morningDiff.added.length   ? `+${morningDiff.added.length}: ${morningDiff.added.join(', ')}` : null,
                  morningDiff.removed.length ? `−${morningDiff.removed.length}: ${morningDiff.removed.join(', ')}` : null,
                  morningDiff.changed.length ? `↔${morningDiff.changed.length}: ${morningDiff.changed.join(', ')}` : null,
                ].filter(Boolean).join('   ')}
                style={{
                  fontFamily: FONT_SANS, fontSize: 14, color: T.caramelDeep,
                  fontWeight: 600, whiteSpace: 'nowrap', marginTop: 6,
                }}
              >
                {morningDiff.added.length   > 0 && <span>+{morningDiff.added.length}</span>}
                {morningDiff.removed.length > 0 && <span style={{ marginLeft: morningDiff.added.length ? 8 : 0 }}>−{morningDiff.removed.length}</span>}
                {morningDiff.changed.length > 0 && <span style={{ marginLeft: 8 }}>↔{morningDiff.changed.length}</span>}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* UNASSIGNED STRIP — sits between the PMS strip and the crew so
          rooms that come off Reset, or rooms whose previously-assigned
          housekeeper got removed from today's crew, always have a
          visible home. Also acts as a drop zone when a room is floating:
          tapping it returns the floating room to the pool. Hidden when
          there's nothing unassigned AND no room is floating (so the page
          stays clean for the common case). */}
      {(unassignedRooms.length > 0 || floatingRoomId) && (
        <div
          data-drop-target="__unassigned__"
          onClick={() => {
            if (floatingRoomId) {
              moveRoomTo(floatingRoomId, null);
              flashToast(lang === 'es' ? 'Cuarto sin asignar' : 'Room moved to Unassigned');
            }
          }}
          style={{
            background: floatingRoomId ? T.sageDim : T.paper,
            border: `${floatingRoomId ? 2 : 1}px solid ${floatingRoomId ? T.sageDeep : T.rule}`,
            borderRadius: 16, padding: '14px 22px', marginBottom: 10,
            display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
            cursor: floatingRoomId ? 'pointer' : 'default',
            transition: 'background 120ms ease, border-color 120ms ease',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 140 }}>
            <Caps size={9}>{lang === 'es' ? 'Sin asignar' : 'Unassigned'}</Caps>
            <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: T.ink2 }}>
              {unassignedRooms.length} {lang === 'es' ? 'cuartos' : 'rooms'}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', flex: 1 }}>
            {unassignedRooms.length === 0 ? (
              <span style={{ fontFamily: FONT_SERIF, fontSize: 14, color: T.ink2, fontStyle: 'italic' }}>
                {lang === 'es'
                  ? 'Toca aquí para devolver el cuarto al grupo.'
                  : 'Tap here to drop the room back to the pool.'}
              </span>
            ) : unassignedRooms.map(r => {
              const floating = floatingRoomId === r.id;
              return (
                <button
                  key={r.id}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    // No preventDefault — the browser needs to synthesize
                    // the click event from this pointer interaction, and
                    // we handle the tap-to-toggle path in onClick below.
                    dragStartRef.current = {
                      x: e.clientX, y: e.clientY,
                      roomId: r.id,
                      meta: { number: r.number, type: r.type },
                      crossed: false,
                    };
                  }}
                  onClick={(e) => {
                    e.stopPropagation(); // don't let the click bubble to the strip's onClick
                    if (wasDragRef.current) return; // ignore the click that follows a drag
                    setFloatingRoomId(prev => {
                      if (prev === r.id) {
                        setFloatingRoomMeta(null);
                        setCursorPos(null);
                        return null;
                      }
                      setFloatingRoomMeta({ number: r.number, type: r.type });
                      setCursorPos({ x: e.clientX, y: e.clientY });
                      return r.id;
                    });
                  }}
                  style={{
                    padding: '5px 11px', borderRadius: 8,
                    background: floating ? T.sageDim : T.bg,
                    border: `${floating ? 2 : 1}px solid ${floating ? T.sageDeep : T.rule}`,
                    color: T.ink, fontFamily: FONT_MONO, fontSize: 13, fontWeight: 600,
                    letterSpacing: '-0.02em', whiteSpace: 'nowrap',
                    cursor: floating ? 'grabbing' : 'grab',
                    opacity: floating ? 0.4 : 1,
                    touchAction: 'none',
                    transition: 'background 120ms ease, border-color 120ms ease, opacity 120ms ease',
                  }}
                  title={floating
                    ? (lang === 'es' ? 'Toca un destino o suelta sobre uno para mover' : 'Tap or drop on a target to move')
                    : (lang === 'es' ? 'Toca o arrastra para mover' : 'Tap or drag to move')}
                >
                  {r.number}
                  {r.type === 'checkout' && <span style={{ color: T.ink3, fontWeight: 400 }}> ↗</span>}
                  {r.type === 'stayover' && <span style={{ color: T.ink3, fontWeight: 400 }}> ◐</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* CREW ROWS */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {activeCrew.map(c => {
          const myRooms = assignableRooms.filter(r => assignments[r.id] === c.id);
          const minsLoaded = myRooms.reduce((sum, r) => {
            if (r.type === 'checkout') return sum + ckMin;
            if (r.type === 'stayover') return sum + (r.stayoverDay === 1 ? so1Min : so2Min);
            return sum;
          }, 0);
          const pct = Math.min(100, (minsLoaded / SHIFT_MINS) * 100);
          const isOver = minsLoaded > SHIFT_MINS;
          const isNear = !isOver && minsLoaded > SHIFT_MINS * 0.85;
          const status = myRooms.length === 0 ? 'available' : isOver ? 'over' : isNear ? 'near' : 'assigned';
          const dotColor = status === 'over' ? T.warm : status === 'near' ? T.caramelDeep : status === 'available' ? T.sageDeep : T.ink2;
          const isDropTarget = !!floatingRoomId;
          const swapOpen = swapOpenFor === c.id;

          return (
            <div
              key={c.id}
              data-drop-target={c.id}
              onClick={() => {
                if (floatingRoomId) {
                  moveRoomTo(floatingRoomId, c.id);
                  flashToast(lang === 'es' ? `Cuarto movido a ${c.name}` : `Room moved to ${c.name}`);
                }
              }}
              style={{
                background: isDropTarget ? T.sageDim : T.paper,
                border: `${isDropTarget ? 2 : 1}px solid ${isDropTarget ? T.sageDeep : T.rule}`,
                borderRadius: 16, padding: '18px 22px', display: 'grid',
                gridTemplateColumns: 'auto 1fr auto', gap: 20, alignItems: 'center',
                cursor: isDropTarget ? 'pointer' : 'default',
                position: 'relative',
                transition: 'background 120ms ease, border-color 120ms ease',
              }}
            >
              {/* Avatar + name + capacity */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <span style={{ position: 'relative' }}>
                  <HousekeeperDot staff={c} size={48} />
                  <span style={{
                    position: 'absolute', bottom: -2, right: -2,
                    width: 12, height: 12, borderRadius: '50%',
                    background: dotColor, border: `2px solid ${T.paper}`,
                  }} />
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 160 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, position: 'relative' }}>
                    {/* Name button — click to open the swap dropdown.
                        Tap the same name again (or anywhere outside the
                        dropdown) to close it. */}
                    <button
                      data-swap-trigger
                      onClick={(e) => {
                        e.stopPropagation();
                        // If a room is currently held, prefer dropping
                        // it on this housekeeper over opening the swap
                        // dropdown. Clicking a name is the most obvious
                        // "give the room to this person" affordance, so
                        // it would be surprising to instead get a
                        // staff-swap menu while you're holding a room.
                        if (floatingRoomId) {
                          moveRoomTo(floatingRoomId, c.id);
                          flashToast(lang === 'es' ? `Cuarto movido a ${c.name}` : `Room moved to ${c.name}`);
                          return;
                        }
                        setSwapOpenFor(prev => prev === c.id ? null : c.id);
                      }}
                      title={lang === 'es' ? 'Cambiar por otro' : 'Swap with another'}
                      style={{
                        background: 'transparent', border: 'none', cursor: 'pointer',
                        padding: 0, fontFamily: FONT_SANS, fontSize: 15, color: T.ink,
                        fontWeight: 600, textAlign: 'left',
                      }}
                    >
                      {c.name}
                    </button>
                    {/* Open the housekeeper's personal page in a new tab.
                        Uses the per-staff magic link if /api/staff-link
                        is healthy, otherwise falls back to the tokenless
                        route. */}
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        const url = await mintLink(c.id);
                        window.open(url, '_blank', 'noopener,noreferrer');
                      }}
                      title={lang === 'es' ? 'Abrir página personal' : 'Open personal page'}
                      style={{
                        background: 'transparent', border: 'none', cursor: 'pointer',
                        padding: 2, borderRadius: 4, color: T.ink3,
                        display: 'inline-flex', alignItems: 'center',
                      }}
                    >
                      <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                      </svg>
                    </button>

                    {/* Swap dropdown — anchored to the name. Lists every
                        housekeeping staff member NOT already on the
                        crew. Picking one transfers all of c's rooms to
                        the new person and replaces them in the crew. */}
                    {swapOpen && (
                      <div
                        data-swap-dropdown
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          position: 'absolute', top: '100%', left: 0, marginTop: 4,
                          background: T.paper, border: `1px solid ${T.rule}`,
                          borderRadius: 12, boxShadow: '0 8px 24px rgba(0,0,0,0.10)',
                          padding: 6, zIndex: 60, minWidth: 220, maxHeight: 280, overflow: 'auto',
                        }}
                      >
                        <div style={{ padding: '6px 10px 4px' }}>
                          <Caps size={9}>{lang === 'es' ? 'Cambiar por' : 'Swap with'}</Caps>
                        </div>
                        {offCrew.length === 0 ? (
                          <p style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink2, margin: 0, padding: '8px 10px' }}>
                            {lang === 'es' ? 'No hay personal disponible.' : 'No staff available.'}
                          </p>
                        ) : offCrew.map(s => (
                          <button
                            key={s.id}
                            onClick={() => {
                              swapStaff(c.id, s.id);
                              flashToast(lang === 'es' ? `${c.name} → ${s.name}` : `${c.name} → ${s.name}`);
                            }}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 10,
                              width: '100%', padding: '6px 10px', border: 'none',
                              background: 'transparent', cursor: 'pointer', borderRadius: 8,
                              fontFamily: FONT_SANS, fontSize: 13, color: T.ink,
                            }}
                            onMouseEnter={e => { e.currentTarget.style.background = T.bg; }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                          >
                            <HousekeeperDot staff={s} size={24} />
                            <span>{s.name}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink2, whiteSpace: 'nowrap' }}>
                      {myRooms.length} {lang === 'es' ? 'cuartos' : 'rooms'} · {fmtTime(minsLoaded)} / {Math.floor(SHIFT_MINS / 60)}h
                    </span>
                    {status === 'over'      && <Pill tone="warm">{lang === 'es' ? 'Sobre cupo' : 'Over cap'}</Pill>}
                    {status === 'near'      && <Pill tone="caramel">{lang === 'es' ? 'Casi lleno' : 'Near full'}</Pill>}
                    {status === 'available' && <Pill tone="sage">{lang === 'es' ? 'Disponible' : 'Available'}</Pill>}
                  </div>
                  <div style={{ width: 200, height: 4, background: T.ruleSoft, borderRadius: 2, overflow: 'hidden' }}>
                    <span style={{
                      display: 'block', height: '100%', width: `${pct}%`,
                      background: status === 'over' ? T.warm : status === 'near' ? T.caramelDeep : T.sageDeep,
                    }} />
                  </div>
                </div>
              </div>

              {/* Room pills — tap to pick up, tap again to cancel. */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                {myRooms.length === 0 ? (
                  <span style={{ fontFamily: FONT_SERIF, fontSize: 14, color: T.ink2, fontStyle: 'italic' }}>
                    {lang === 'es'
                      ? 'Sin asignar — toca Auto-asignar.'
                      : 'No rooms assigned yet — tap Auto-assign.'}
                  </span>
                ) : myRooms.map(r => {
                  const floating = floatingRoomId === r.id;
                  return (
                    <button
                      key={r.id}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        // No preventDefault — see the unassigned-pill
                        // handler above for the rationale.
                        dragStartRef.current = {
                          x: e.clientX, y: e.clientY,
                          roomId: r.id,
                          meta: { number: r.number, type: r.type },
                          crossed: false,
                        };
                      }}
                      onClick={(e) => {
                        e.stopPropagation(); // don't let the click bubble to the card's onClick
                        if (wasDragRef.current) return; // ignore the click that follows a drag
                        setFloatingRoomId(prev => {
                          if (prev === r.id) {
                            setFloatingRoomMeta(null);
                            setCursorPos(null);
                            return null;
                          }
                          setFloatingRoomMeta({ number: r.number, type: r.type });
                          setCursorPos({ x: e.clientX, y: e.clientY });
                          return r.id;
                        });
                      }}
                      title={floating
                        ? (lang === 'es' ? 'Toca un destino o suelta sobre uno para mover' : 'Tap or drop on a target to move')
                        : (lang === 'es' ? 'Toca o arrastra para mover' : 'Tap or drag to move')}
                      style={{
                        padding: '5px 11px', borderRadius: 8,
                        background: floating ? T.sageDim : T.bg,
                        border: `${floating ? 2 : 1}px solid ${floating ? T.sageDeep : T.rule}`,
                        color: T.ink, fontFamily: FONT_MONO, fontSize: 13, fontWeight: 600,
                        letterSpacing: '-0.02em', whiteSpace: 'nowrap',
                        cursor: floating ? 'grabbing' : 'grab',
                        opacity: floating ? 0.4 : 1,
                        touchAction: 'none',
                        transition: 'background 120ms ease, border-color 120ms ease, opacity 120ms ease',
                      }}
                    >
                      {r.number}
                      {r.type === 'checkout' && <span style={{ color: T.ink3, fontWeight: 400 }}> ↗</span>}
                      {r.type === 'stayover' && <span style={{ color: T.ink3, fontWeight: 400 }}> ◐</span>}
                    </button>
                  );
                })}
              </div>

              {/* Status pills + per-row actions */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                {sendBadge(c.id) ?? confPill(c.id)}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    const baseline = crewExplicit ? crewIds : housekeepingStaff.map(s => s.id);
                    setCrewIds(baseline.filter(id => id !== c.id));
                    setCrewExplicit(true);
                    // Drop their assignments too — otherwise they'd persist
                    // pinned to a person no longer on today's roster.
                    setAssignments(prev => {
                      const next: Record<string, string> = {};
                      for (const [roomId, staffId] of Object.entries(prev)) {
                        if (staffId !== c.id) next[roomId] = staffId;
                      }
                      return next;
                    });
                  }}
                  title={lang === 'es' ? 'Quitar de hoy' : 'Remove from today'}
                  style={{
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    padding: '2px 6px', borderRadius: 4,
                    fontFamily: FONT_SANS, fontSize: 11, color: T.ink3,
                  }}
                >
                  {lang === 'es' ? 'Quitar' : 'Remove'}
                </button>
              </div>
            </div>
          );
        })}

        {/* Off-today crew strip — keeps recently-removed staff one tap away */}
        {offCrew.length > 0 && (
          <div style={{
            marginTop: 4, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            padding: '10px 14px', background: T.bg,
          }}>
            <Caps>{lang === 'es' ? 'Disponibles hoy' : 'Available today'}</Caps>
            {offCrew.map(s => (
              <button
                key={s.id}
                onClick={() => {
                  // First add: seed crewIds from the implicit default
                  // (housekeepingStaff) so we don't lose the others.
                  const baseline = crewExplicit ? crewIds : housekeepingStaff.map(x => x.id);
                  setCrewIds([...baseline, s.id]);
                  setCrewExplicit(true);
                }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '4px 12px 4px 4px', borderRadius: 999,
                  background: 'transparent', border: `1px dashed ${T.rule}`, cursor: 'pointer',
                  fontFamily: FONT_SANS, fontSize: 12, color: T.ink2,
                }}
              >
                <HousekeeperDot staff={s} size={22} />
                <span>{s.name}</span>
                <span style={{ color: T.ink3 }}>+ {lang === 'es' ? 'añadir' : 'add'}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ACTION BAND — bottom */}
      <div style={{
        marginTop: 18,
        background: `linear-gradient(135deg, ${T.sageDim}, rgba(201,150,68,0.06))`,
        border: '1px solid rgba(92,122,96,0.18)', borderRadius: 18,
        padding: '14px 22px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 18, flexWrap: 'wrap',
      }}>
        <div>
          <Caps c={T.sageDeep}>{lang === 'es' ? 'Listo para asignar' : 'Ready to assign'}</Caps>
          <p style={{
            fontFamily: FONT_SERIF, fontSize: 22, color: T.ink,
            margin: '4px 0 0', lineHeight: 1.3, fontWeight: 400,
          }}>
            <span style={{ fontStyle: 'italic' }}>
              {assignableRooms.length} {lang === 'es' ? 'cuartos' : 'rooms'}
            </span>
            {' '}{lang === 'es' ? 'entre' : 'across'} {activeCrew.length} {lang === 'es' ? 'limpiadoras activas' : 'active housekeepers'}.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Btn variant="ghost" size="md" onClick={() => {
            // Freeze the current sort order so the list doesn't shuffle
            // when the user toggles a priority level mid-modal.
            frozenStaffOrder.current = [...housekeepingStaff]
              .sort((a, b) => {
                const order: Record<string, number> = { priority: 0, normal: 1, excluded: 2 };
                return (order[a.schedulePriority ?? 'normal'] ?? 1) - (order[b.schedulePriority ?? 'normal'] ?? 1);
              })
              .map(s => s.id);
            setShowPriority(true);
          }}>
            ★ {lang === 'es' ? 'Prioridad' : 'Priority'}
          </Btn>
          <Btn variant="ghost" size="md" onClick={handleReset} disabled={!ready}>
            {lang === 'es' ? 'Resetear todo' : 'Reset all'}
          </Btn>
          <Btn variant="primary" size="md" onClick={handleAutoAssign} disabled={!ready || activeCrew.length === 0}>
            ↻ {lang === 'es' ? 'Auto-asignar' : 'Auto-assign'} {assignableRooms.length} {lang === 'es' ? 'cuartos' : 'rooms'}
          </Btn>
          <Btn variant="sage" size="md" onClick={handleSend} disabled={sending || activeCrew.length === 0}>
            → {sending ? (lang === 'es' ? 'Enviando…' : 'Sending…') : `${lang === 'es' ? 'Enviar' : 'Send'} ${activeCrew.length} ${lang === 'es' ? 'enlaces' : 'links'}`}
          </Btn>
        </div>
      </div>

      {/* FLOATING GHOST — follows the cursor while a room is held.
          pointerEvents: 'none' so the cursor still hits drop targets
          underneath; positioned via fixed coords from cursorPos. Only
          renders when both the room is floating AND we have a cursor
          position (set by either the click-pick or the drag threshold). */}
      {floatingRoomId && floatingRoomMeta && cursorPos && typeof document !== 'undefined' && createPortal(
        <div
          style={{
            position: 'fixed',
            top: cursorPos.y,
            left: cursorPos.x,
            transform: 'translate(-50%, -50%)',
            pointerEvents: 'none',
            zIndex: 9999,
          }}
        >
          <span style={{
            padding: '5px 11px', borderRadius: 8,
            background: T.paper, border: `2px solid ${T.sageDeep}`, color: T.ink,
            fontFamily: FONT_MONO, fontSize: 13, fontWeight: 600,
            letterSpacing: '-0.02em', whiteSpace: 'nowrap',
            boxShadow: '0 6px 18px rgba(0,0,0,0.15)',
            display: 'inline-block',
          }}>
            {floatingRoomMeta.number}
            {floatingRoomMeta.type === 'checkout' && <span style={{ color: T.ink3, fontWeight: 400 }}> ↗</span>}
            {floatingRoomMeta.type === 'stayover' && <span style={{ color: T.ink3, fontWeight: 400 }}> ◐</span>}
          </span>
        </div>,
        document.body,
      )}

      {/* TOAST */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          zIndex: 70, padding: '12px 18px',
          background: T.sageDim, color: T.sageDeep,
          border: '1px solid rgba(104,131,114,0.3)',
          borderRadius: 999, fontFamily: FONT_SANS, fontSize: 13, fontWeight: 500,
        }}>{toast}</div>
      )}

      {/* PREDICTION SETTINGS MODAL — Maria's per-property cleaning-time
          knobs. Saves directly to the property record; auto-assign and
          the per-HK capacity bars both read these fields, so changes
          propagate the moment refreshProperty() finishes. Triggered by
          the gear next to "Latest PMS pull" in the strip above. */}
      {showSettings && typeof document !== 'undefined' && createPortal(
        <div
          onClick={() => { if (!settingsSaving) setShowSettings(false); }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
            zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18,
              padding: '20px 24px', maxWidth: 480, width: '100%',
              maxHeight: '85vh', overflow: 'auto',
              boxShadow: '0 20px 60px rgba(0,0,0,0.20)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <h2 style={{ fontFamily: FONT_SERIF, fontSize: 24, margin: 0, color: T.ink, fontWeight: 400 }}>
                <span style={{ fontStyle: 'italic' }}>{lang === 'es' ? 'Ajustes de Predicción' : 'Cleaning-time Settings'}</span>
              </h2>
              <button
                onClick={() => setShowSettings(false)}
                disabled={settingsSaving}
                style={{
                  background: 'transparent', border: 'none', cursor: settingsSaving ? 'default' : 'pointer',
                  fontSize: 20, color: T.ink3, padding: '0 6px',
                }}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <p style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink2, margin: '0 0 14px' }}>
              {lang === 'es'
                ? 'Estos minutos definen cuánto tarda cada tipo de limpieza. Auto-asignar y las barras de capacidad usan estos valores.'
                : 'How long each clean takes, by type. Auto-assign and the per-housekeeper capacity bars both read these values.'}
            </p>
            {/* 4 minute fields + 1 hour-cap field. shiftMinutes is shown
                in hours for sanity, converted to minutes on save. */}
            {([
              { key: 'checkoutMinutes',        label: lang === 'es' ? 'Salida (limpieza completa)'  : 'Checkout (full clean)',      unit: 'min', step: 1,    min: 1,   max: 240 },
              { key: 'stayoverDay1Minutes',    label: lang === 'es' ? 'Estadía día 1 (ligera)'      : 'Stayover Day 1 (light)',      unit: 'min', step: 1,    min: 1,   max: 240 },
              { key: 'stayoverDay2Minutes',    label: lang === 'es' ? 'Estadía día 2+ (completa)'   : 'Stayover Day 2+ (full)',      unit: 'min', step: 1,    min: 1,   max: 240 },
              { key: 'prepMinutesPerActivity', label: lang === 'es' ? 'Preparación entre cuartos'   : 'Prep between rooms',          unit: 'min', step: 1,    min: 0,   max: 60  },
              { key: 'shiftMinutes',           label: lang === 'es' ? 'Turno máximo por persona'    : 'Max shift hours per person',   unit: 'h',   step: 0.25, min: 1,   max: 24, asHours: true },
            ] as Array<{ key: keyof typeof settingsForm; label: string; unit: string; step: number; min: number; max: number; asHours?: boolean }>).map(f => {
              const raw = settingsForm[f.key];
              const display = f.asHours ? raw / 60 : raw;
              return (
                <div key={f.key} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '12px 0', borderTop: `1px solid ${T.rule}`, gap: 12,
                }}>
                  <label htmlFor={`pred-${f.key}`} style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink, flex: 1 }}>
                    {f.label}
                  </label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input
                      id={`pred-${f.key}`}
                      type="number"
                      step={f.step}
                      min={f.min}
                      max={f.max}
                      value={display}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (Number.isNaN(n)) return;
                        setSettingsForm(prev => ({
                          ...prev,
                          [f.key]: f.asHours ? Math.round(n * 60) : Math.round(n),
                        }));
                      }}
                      style={{
                        width: 70, padding: '6px 8px', borderRadius: 8,
                        border: `1px solid ${T.rule}`, background: T.bg,
                        fontFamily: FONT_MONO, fontSize: 13, color: T.ink, textAlign: 'right',
                      }}
                    />
                    <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink2, minWidth: 24 }}>{f.unit}</span>
                  </div>
                </div>
              );
            })}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
              <Btn variant="ghost" size="sm" onClick={() => setShowSettings(false)} disabled={settingsSaving}>
                {lang === 'es' ? 'Cancelar' : 'Cancel'}
              </Btn>
              <Btn
                variant="primary"
                size="sm"
                disabled={settingsSaving || !uid || !pid}
                onClick={async () => {
                  if (!uid || !pid) return;
                  setSettingsSaving(true);
                  try {
                    await updateProperty(uid, pid, {
                      checkoutMinutes:        settingsForm.checkoutMinutes,
                      stayoverDay1Minutes:    settingsForm.stayoverDay1Minutes,
                      stayoverDay2Minutes:    settingsForm.stayoverDay2Minutes,
                      // Mirror Day 2 to the legacy stayoverMinutes field
                      // so older callers (DND/over-time fallbacks) still
                      // get a sensible value.
                      stayoverMinutes:        settingsForm.stayoverDay2Minutes,
                      prepMinutesPerActivity: settingsForm.prepMinutesPerActivity,
                      shiftMinutes:           settingsForm.shiftMinutes,
                    });
                    await refreshProperty();
                    flashToast(lang === 'es' ? 'Ajustes guardados' : 'Settings saved');
                    setShowSettings(false);
                  } catch (err) {
                    console.error('[Schedule] settings save failed:', err);
                    flashToast(lang === 'es' ? 'Error al guardar' : 'Save failed');
                  } finally {
                    setSettingsSaving(false);
                  }
                }}
              >
                {settingsSaving
                  ? (lang === 'es' ? 'Guardando…' : 'Saving…')
                  : (lang === 'es' ? 'Guardar' : 'Save')}
              </Btn>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* STAFF PRIORITY MODAL — rendered via portal so it always sits
          above the rest of the page. Tap each level to update the
          housekeeper's schedulePriority on the staff record; the auto-
          assign algorithm reads this field directly to gate who gets
          rooms first ('priority'), who's backup ('normal'), and who
          shouldn't be auto-assigned at all ('excluded'). */}
      {showPriority && typeof document !== 'undefined' && createPortal(
        <div
          onClick={() => setShowPriority(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
            zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18,
              padding: '20px 24px', maxWidth: 560, width: '100%',
              maxHeight: '80vh', overflow: 'auto',
              boxShadow: '0 20px 60px rgba(0,0,0,0.20)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <h2 style={{ fontFamily: FONT_SERIF, fontSize: 24, margin: 0, color: T.ink, fontWeight: 400 }}>
                <span style={{ fontStyle: 'italic' }}>{lang === 'es' ? 'Prioridad del Personal' : 'Staff Priority'}</span>
              </h2>
              <button
                onClick={() => setShowPriority(false)}
                style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  fontSize: 20, color: T.ink3, padding: '0 6px',
                }}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <p style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink2, margin: '0 0 14px' }}>
              {lang === 'es'
                ? 'Prioridad = se asigna primero. Normal = respaldo. Excluido = nunca se asigna automáticamente.'
                : 'Priority = auto-assigned first. Normal = backup. Excluded = never auto-assigned.'}
            </p>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {frozenStaffOrder.current.map(id => {
                const s = staff.find(x => x.id === id);
                if (!s) return null;
                const level: SchedulePriority = s.schedulePriority ?? 'normal';
                const levels: Array<{ value: SchedulePriority; label: string }> = [
                  { value: 'priority', label: lang === 'es' ? 'Prioridad' : 'Priority' },
                  { value: 'normal',   label: lang === 'es' ? 'Normal'    : 'Normal' },
                  { value: 'excluded', label: lang === 'es' ? 'Excluido'  : 'Excluded' },
                ];
                return (
                  <div key={s.id} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '12px 0', borderTop: `1px solid ${T.rule}`,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <HousekeeperDot staff={s} size={32} />
                      <span style={{ fontFamily: FONT_SANS, fontSize: 14, color: T.ink, fontWeight: 500 }}>{s.name}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {levels.map(lvl => {
                        const active = level === lvl.value;
                        return (
                          <button
                            key={lvl.value}
                            onClick={async () => {
                              if (!uid || !pid) return;
                              try {
                                await updateStaffMember(uid, pid, s.id, { schedulePriority: lvl.value });
                              } catch (err) {
                                console.error('[Schedule] priority update failed:', err);
                                flashToast(lang === 'es' ? 'Error al guardar' : 'Save failed');
                              }
                            }}
                            style={{
                              padding: '5px 11px', borderRadius: 999, cursor: 'pointer',
                              fontFamily: FONT_SANS, fontSize: 11, fontWeight: 500,
                              background: active ? T.sageDeep : 'transparent',
                              color: active ? '#fff' : T.ink2,
                              border: `1px solid ${active ? T.sageDeep : T.rule}`,
                            }}
                          >
                            {lvl.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>,
        document.body,
      )}

    </div>
  );
}
