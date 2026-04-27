// Split from the housekeeping/page.tsx monolith on 2026-04-27.
// Shared helpers / constants / components are imported from ./_shared.
// Only this tab's section logic lives here.

'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { AppLayout } from '@/components/layout/AppLayout';
import { Modal } from '@/components/ui/Modal';
import { useSyncContext } from '@/contexts/SyncContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import {
  subscribeToRooms, subscribeToAllRooms, updateRoom, addRoom,
  addStaffMember, updateStaffMember, deleteStaffMember,
  getRoomsForDate, getPublicAreas, setPublicArea, deletePublicArea,
  updateProperty,
  getDeepCleanConfig, setDeepCleanConfig, getDeepCleanRecords,
  markRoomDeepCleaned, assignRoomDeepClean, completeRoomDeepClean,
  subscribeToPlanSnapshot,
  subscribeToShiftConfirmations,
  subscribeToScheduleAssignments,
  saveScheduleAssignments,
  subscribeToDashboardNumbers,
  getDashboardForDate,
  subscribeToWorkOrders,
} from '@/lib/db';
import type { PlanSnapshot, ScheduleAssignments, CsvRoomSnapshot, DashboardNumbers } from '@/lib/db';
import { dashboardFreshness, DASHBOARD_STALE_MINUTES } from '@/lib/db';
import { getPublicAreasDueToday, calcPublicAreaMinutes, autoAssignRooms, getOverdueRooms, calcDndFreedMinutes, suggestDeepCleans } from '@/lib/calculations';
import { getDefaultPublicAreas } from '@/lib/defaults';
import type { PublicArea } from '@/types';
import { todayStr, errToString } from '@/lib/utils';
import { useTodayStr } from '@/lib/use-today-str';
import type { Room, RoomStatus, RoomType, RoomPriority, StaffMember, DeepCleanRecord, DeepCleanConfig, ShiftConfirmation, ConfirmationStatus, WorkOrder } from '@/types';
import { format, subDays } from 'date-fns';
import {
  Calendar, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, CheckCircle2, Clock,
  AlertTriangle, Users, Send, Zap, BedDouble, Plus, Pencil, Trash2, Star, Check,
  Trophy, TrendingUp, TrendingDown, Minus, Upload, Settings,
  Search, XCircle, Home, ArrowRightLeft, Sparkles, Ban, RefreshCw,
  Link2, Copy,
} from 'lucide-react';

import {
  TABS,
  schedTodayStr, addDays, defaultShiftDate, formatPulledAt, formatDisplayDate,
  isEligible, PRIORITY_ORDER, snapshotToShiftRooms, autoSelectEligible,
  STAFF_COLORS,
  toDate, fmtMins, HKInitials, buildLive, buildHistory,
  PaceBadge, RankBadge, StatPill,
  EMPTY_FORM, staffInitials,
  getFloor, ROOM_ACTION_COLOR,
  paFloorLabel, freqLabel, FrequencySlider, AREA_NAME_ES, areaDisplayName,
  PublicAreasModal, PA_FLOOR_VALUES, SLIDER_MAX,
} from './_shared';
import type { TabKey, HKLive, HKHistory, StaffFormData } from './_shared';

function ScheduleTab() {
  const { user } = useAuth();
  const { activeProperty, activePropertyId, staff, staffLoaded, refreshStaff, refreshProperty } = useProperty();
  const { lang } = useLang();
  const { recordOfflineAction } = useSyncContext();

  const [shiftDate, setShiftDate] = useState(defaultShiftDate);
  const [sending, setSending] = useState(false);
  const [confirmations, setConfirmations] = useState<ShiftConfirmation[]>([]);
  // Per-person outcome from the last Send click: 'sent' | 'skipped' | 'failed'
  // + a reason when it wasn't sent (e.g. 'no_phone'). Powers the badge next
  // to each crew member's name on the Schedule tab.
  type SendResult = { status: 'sent' | 'skipped' | 'failed'; reason?: string };
  const [sendResults, setSendResults] = useState<Map<string, SendResult>>(new Map());
  const [showPredictionSettings, setShowPredictionSettings] = useState(false);
  const [showPublicAreas, setShowPublicAreas] = useState(false);
  const [showAddStaff, setShowAddStaff] = useState(false);
  const [expandedCrew, setExpandedCrew] = useState<string | null>(null);
  const [settingsForm, setSettingsForm] = useState({
    checkoutMinutes: 30,
    stayoverMinutes: 20,
    stayoverDay1Minutes: 15,
    stayoverDay2Minutes: 20,
    prepMinutesPerActivity: 5,
    shiftMinutes: 420,  // per-housekeeper daily cap in minutes (7h default)
  });
  const [savingSettings, setSavingSettings] = useState(false);

  // Plan snapshot from CSV scraper (7pm / 6am pulls) — THE source of truth for Schedule tab.
  const [planSnapshot, setPlanSnapshot] = useState<PlanSnapshot | null>(null);
  const [planSnapshotLoaded, setPlanSnapshotLoaded] = useState(false);

  // Live PMS dashboard numbers (In House / Arrivals / Departures) — pulled off
  // Choice Advantage's View pages every 15 min by the Railway scraper.
  const [dashboardNums, setDashboardNums] = useState<DashboardNumbers | null>(null);

  // Open work orders — used to derive blocked-room numbers so the scheduling
  // page can exclude them from the check-off list, Staff Needed math, and
  // auto-assign. A blocked room isn't cleaned, so it shouldn't eat crew time.
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);

  // Staleness ticker — re-renders the PMS block once a minute so that a
  // Schedule tab left open on screen starts showing "stale" the moment
  // pulledAt crosses the threshold, even without a Firestore update. Without
  // this, the UI could tell Maria "fresh at 4:01" all evening while the
  // scraper has been dead for 3 hours.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Saved assignments (survives CSV overwrites — Maria's Send work persists).
  const [scheduleAssignmentsDoc, setScheduleAssignmentsDoc] = useState<ScheduleAssignments | null>(null);
  const [scheduleAssignmentsLoaded, setScheduleAssignmentsLoaded] = useState(false);

  const [publicAreas, setPublicAreas] = useState<PublicArea[]>([]);

  // Crew assignments
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [crewOverride, setCrewOverride] = useState<string[]>([]); // manually toggled staff IDs
  const [hasAutoSelected, setHasAutoSelected] = useState(false);
  const [showPrioritySettings, setShowPrioritySettings] = useState(false);

  // Refs used by the hydration flow below (declared early so useEffects can flip them)
  const userEditedCrew = useRef(false);
  const manuallyAdded = useRef<Set<string>>(new Set());
  // Room IDs that Maria explicitly dragged onto a specific HK. Auto Assign
  // treats these as "preserved" — never redistributes them. Drag to
  // __unassigned__ clears the flag (she's un-pinning it).
  const manuallyAssignedRooms = useRef<Set<string>>(new Set());
  const hasInitialAssign = useRef(false);

  // Swap dropdown
  const [swapOpenFor, setSwapOpenFor] = useState<string | null>(null);
  const [swapAnchor, setSwapAnchor] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  // "Copied!" flash feedback for the per-housekeeper link copy button
  const [copiedFor, setCopiedFor] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Move toast notification
  const [moveToast, setMoveToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Drag-and-drop state (pointer events — works for both mouse + touch)
  // `floating: true` means the user tapped a pill and it's now stuck to the
  // cursor waiting for a second click to drop. `floating: false|undefined`
  // means a classic press-and-drag is in progress.
  const [dragState, setDragState] = useState<{
    roomId: string; roomNumber: string; roomType: string; stayoverDay?: number;
    ghost: { x: number; y: number }; dropTarget: string | null;
    floating?: boolean;
  } | null>(null);
  const crewCardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const dragRef = useRef<{
    roomId: string | null; roomNumber: string; roomType: string; stayoverDay?: number;
    startX: number; startY: number; active: boolean;
  }>({ roomId: null, roomNumber: '', roomType: '', startX: 0, startY: 0, active: false });

  const uid = user?.uid ?? '';
  const pid = activePropertyId ?? '';

  useEffect(() => {
    if (uid && pid && staff.length === 0) refreshStaff();
  }, [uid, pid]); // eslint-disable-line react-hooks/exhaustive-deps

  // Schedule tab reads ONLY from the CSV pull (planSnapshots). The 15-min rooms scraper
  // is intentionally ignored here — it powers the Rooms tab's live view during the day.
  useEffect(() => {
    if (!uid || !pid) return;
    setPlanSnapshotLoaded(false);
    return subscribeToPlanSnapshot(uid, pid, shiftDate, (snap) => {
      setPlanSnapshot(snap);
      setPlanSnapshotLoaded(true);
    });
  }, [uid, pid, shiftDate]);

  // Synthetic room list derived from CSV — no rooms-collection dependency.
  const shiftRooms = useMemo(() => snapshotToShiftRooms(planSnapshot, pid), [planSnapshot, pid]);

  // Maria's saved assignments for this date. Untouched by CSV refreshes.
  useEffect(() => {
    if (!uid || !pid) return;
    // Clear the previous date's doc AND loaded flag synchronously before
    // re-subscribing. Otherwise the hydration effect below can fire on the
    // date change while `scheduleAssignmentsDoc` still holds the previous
    // date's data — and lock in stale assignments whose room IDs are keyed
    // to the old date (so everything shows as unassigned).
    setScheduleAssignmentsDoc(null);
    setScheduleAssignmentsLoaded(false);
    return subscribeToScheduleAssignments(uid, pid, shiftDate, (sa) => {
      setScheduleAssignmentsDoc(sa);
      setScheduleAssignmentsLoaded(true);
    });
  }, [uid, pid, shiftDate]);

  // Dashboard numbers — TWO modes depending on which date tab is active:
  //
  //   • Today's tab  → live subscription to scraperStatus/dashboard. The doc
  //     refreshes every 15 min from the scraper and the UI reacts instantly.
  //   • Any other date → one-shot read from dashboardByDate/{date}. That doc
  //     was frozen when the scraper did its last pull of that day. No live
  //     updates — past days don't change.
  //
  // Why two modes: before this, we only had a single live doc and it looked
  // like the numbers belonged to whatever date tab was active. Confusing for
  // Maria — she'd see today's 37 in-house while clicking through yesterday's
  // assignments. Per-date reads fix that AND give her real historical data.
  useEffect(() => {
    const today = schedTodayStr();
    if (shiftDate === today) {
      // Live — subscribe and let onSnapshot push updates.
      return subscribeToDashboardNumbers(setDashboardNums);
    }
    // Past or future — one-shot read, no listener. Clear state first so we
    // don't flash stale live numbers while the fetch is in flight.
    setDashboardNums(null);
    let cancelled = false;
    getDashboardForDate(shiftDate).then(nums => {
      if (!cancelled) setDashboardNums(nums);
    });
    return () => { cancelled = true; };
  }, [shiftDate]);

  // Subscribe to work orders so we can exclude blocked rooms from the
  // cleaning workflow. Sourced from either manual toggles in Maintenance or
  // Choice Advantage's OOO feed (ca_ooo work orders).
  useEffect(() => {
    if (!uid || !pid) return;
    return subscribeToWorkOrders(uid, pid, setWorkOrders);
  }, [uid, pid]);

  // One-time hydration per date: when assignments + crew load from Firestore, seed local state.
  const hydratedForDate = useRef<string | null>(null);
  useEffect(() => {
    if (!scheduleAssignmentsLoaded) return;
    if (hydratedForDate.current === shiftDate) return;
    // Guard against a stale subscription emission: if the doc we have isn't
    // for the shiftDate we're now viewing, wait for the real doc to arrive.
    // (Happens when the user switches dates faster than Firestore re-emits.)
    if (scheduleAssignmentsDoc && scheduleAssignmentsDoc.date !== shiftDate) return;
    hydratedForDate.current = shiftDate;
    if (scheduleAssignmentsDoc) {
      setAssignments(scheduleAssignmentsDoc.roomAssignments ?? {});
      setCrewOverride(scheduleAssignmentsDoc.crew ?? []);
      userEditedCrew.current = true;     // respect what Maria already saved
      hasInitialAssign.current = true;   // skip the auto-assign-on-first-load
    } else {
      setAssignments({});
      setCrewOverride([]);
      userEditedCrew.current = false;
      hasInitialAssign.current = false;
    }
  }, [shiftDate, scheduleAssignmentsLoaded, scheduleAssignmentsDoc]);

  const predictionLoading = !planSnapshotLoaded;

  // Subscribe to shift confirmations for this date (for the status panel)
  useEffect(() => {
    if (!uid || !pid) return;
    return subscribeToShiftConfirmations(uid, pid, shiftDate, setConfirmations);
  }, [uid, pid, shiftDate]);

  // When the shift date changes, forget the previous Send outcomes — the
  // badges are per-shift and shouldn't leak across dates.
  useEffect(() => {
    setSendResults(new Map());
  }, [shiftDate]);

  // Map of staffId → confirmation status for this shift date
  const statusByStaff = useMemo(() => {
    const m = new Map<string, ConfirmationStatus>();
    confirmations.forEach(c => m.set(c.staffId, c.status));
    return m;
  }, [confirmations]);
  const alreadySent = confirmations.length > 0;

  // No more confirmation aggregates — the new flow doesn't track replies
  // (Maria confirms in person at 3pm). The post-send pill just says "Links
  // sent" and doesn't count anything.

  useEffect(() => {
    if (!uid || !pid) return;
    const OLD_NAMES = ['stairwell', 'staff / service', 'floor 2 hallway', 'floor 3 hallway', 'floor 4 hallway', 'restrooms (3', 'elevator area (1st', '2nd, 3rd, & 4th floor hallways'];
    const needsReseed = (areas: PublicArea[]) => areas.some(a => OLD_NAMES.some(old => a.name.toLowerCase().includes(old)));
    const seedDefaults = async () => {
      const defaults = getDefaultPublicAreas();
      const seeded: PublicArea[] = [];
      for (const area of defaults) {
        const id = crypto.randomUUID();
        const full = { id, ...area } as PublicArea;
        await setPublicArea(uid, pid, full);
        seeded.push(full);
      }
      return seeded;
    };
    getPublicAreas(uid, pid).then(async (fetched) => {
      if (fetched.length === 0) setPublicAreas(await seedDefaults());
      else if (needsReseed(fetched)) {
        // Parallel deletes — was sequential which made first-login on a
        // property with 20+ public areas drag for several seconds.
        await Promise.all(fetched.map(a => deletePublicArea(uid, pid, a.id)));
        setPublicAreas(await seedDefaults());
      }
      else setPublicAreas(fetched);
    }).catch(err => {
      console.error('Error fetching public areas:', err);
    });
  }, [uid, pid]);

  useEffect(() => {
    if (activeProperty) {
      const legacySo = activeProperty.stayoverMinutes ?? 20;
      setSettingsForm({
        checkoutMinutes: activeProperty.checkoutMinutes ?? 30,
        stayoverMinutes: legacySo,
        stayoverDay1Minutes: activeProperty.stayoverDay1Minutes ?? 15,
        stayoverDay2Minutes: activeProperty.stayoverDay2Minutes ?? legacySo,
        prepMinutesPerActivity: activeProperty.prepMinutesPerActivity ?? 5,
        shiftMinutes: activeProperty.shiftMinutes ?? 420,
      });
    }
  }, [activeProperty]);

  const handleSaveSettings = async () => {
    if (!uid || !pid) return;
    setSavingSettings(true);
    try {
      // Keep legacy `stayoverMinutes` in sync with Day 2 (the fuller clean) so
      // any old consumers still reading the deprecated field get the safer estimate.
      const payload = { ...settingsForm, stayoverMinutes: settingsForm.stayoverDay2Minutes };
      await updateProperty(uid, pid, payload);
      await refreshProperty();
    } finally {
      setSavingSettings(false);
      setShowPredictionSettings(false);
    }
  };

  // ── Prediction model ──
  const coMins = activeProperty?.checkoutMinutes ?? 30;
  const legacySoMins = activeProperty?.stayoverMinutes ?? 20;
  const day1Mins = activeProperty?.stayoverDay1Minutes ?? 15;
  const day2Mins = activeProperty?.stayoverDay2Minutes ?? legacySoMins;
  // soMins kept for legacy call sites (DND/over-time fallbacks) — represents a sensible "blended" stayover estimate.
  const soMins = legacySoMins;
  const prepPerRoom = activeProperty?.prepMinutesPerActivity ?? 5;
  // Per-housekeeper daily cap. Configurable via Prediction Settings →
  // "Max hours per housekeeper" so different operators can dial it to
  // their staffing reality (6h, 7h, 8h, etc.). Default 420m (7h).
  const shiftLen = activeProperty?.shiftMinutes ?? 420;

  // Blocked room numbers — any non-resolved work order with blockedRoom:true,
  // whether it came from CA's OOO feed (source: 'ca_ooo') or was toggled on
  // manually in the Maintenance tab. Rooms in this Set are dropped from every
  // housekeeping calculation below, so they never show up on the check-off
  // list, never count toward Staff Needed, and never get auto-assigned.
  const blockedRoomNumbers = useMemo(() => {
    const s = new Set<string>();
    for (const o of workOrders) {
      if (o.blockedRoom && o.status !== 'resolved') s.add(o.roomNumber);
    }
    return s;
  }, [workOrders]);

  // workShiftRooms = shiftRooms minus anything Maria can't actually put
  // on someone's plate:
  //   1. Blocked (OOO / maintenance) — room is down, nobody enters.
  //   2. DND — guest flagged "do not disturb" ahead of time (e.g. late
  //      sleeper, overnight shift worker). HK can't enter until the flag
  //      comes off, so it shouldn't eat crew capacity at schedule time.
  //      When the HK flips DND off from their phone mid-day, the room
  //      re-appears in the next refresh and gets manually dragged in.
  // shiftRooms (raw CA snapshot) is preserved for the csvRoomSnapshot so
  // the diff-on-refresh logic still compares apples to apples with the
  // next CA pull.
  const workShiftRooms = useMemo(
    () => shiftRooms.filter(r => !blockedRoomNumbers.has(r.number) && !r.isDnd),
    [shiftRooms, blockedRoomNumbers]
  );
  // Count every open blocked work order for the property — NOT just blocked
  // rooms that also happen to be in today's shift. Multi-day OOO blocks (e.g.
  // a room deep-cleaned 4/22 → 4/30) get stripped out of the daily CA CSV, so
  // intersecting with shiftRooms would silently miss them. This stat mirrors
  // the "OOO" counter on ChoiceAdvantage, which counts the whole work-order
  // list regardless of day.
  const blockedCount = blockedRoomNumbers.size;
  const dndCount = shiftRooms.filter(r => r.isDnd && !blockedRoomNumbers.has(r.number)).length;

  const checkouts = workShiftRooms.filter(r => r.type === 'checkout').length;
  const stayovers = workShiftRooms.filter(r => r.type === 'stayover').length;
  const totalRooms = checkouts + stayovers;
  // Per-room cleaning minutes using stayoverDay cycle (Day 1 odd = light, Day 2 even = full).
  // Fall back to legacy stayoverMinutes for arrival-day stayovers (stayoverDay=0 or missing).
  const minsForRoom = (r: { type: string; stayoverDay?: number }): number => {
    if (r.type === 'checkout') return coMins;
    const d = r.stayoverDay;
    if (typeof d !== 'number' || d <= 0) return legacySoMins;
    return d % 2 === 1 ? day1Mins : day2Mins;
  };
  const stayoverRooms = workShiftRooms.filter(r => r.type === 'stayover');
  const stayoverMinutesTotal = stayoverRooms.reduce((sum, r) => sum + minsForRoom(r), 0);
  const roomMinutes = (checkouts * coMins) + stayoverMinutesTotal;
  const prepMinutes = totalRooms * prepPerRoom;

  const [shiftY, shiftM, shiftD] = shiftDate.split('-').map(Number);
  const shiftDateObj = new Date(shiftY, shiftM - 1, shiftD);
  const areasDueToday = getPublicAreasDueToday(publicAreas, shiftDateObj);
  const publicAreaMinutes = calcPublicAreaMinutes(areasDueToday);

  const LAUNDRY_STAFF = 1;
  const workloadMinutes = roomMinutes + prepMinutes;
  const cleaningStaff = workloadMinutes > 0 ? Math.ceil(workloadMinutes / shiftLen) : 0;
  const recommendedStaff = cleaningStaff + LAUNDRY_STAFF;

  // ── Auto-select crew + auto-assign rooms ──
  const eligiblePool = useMemo(() => autoSelectEligible(staff, shiftDate, new Set()), [staff, shiftDate]);
  const assignableRooms = useMemo(() =>
    [...workShiftRooms].filter(r => r.type === 'checkout' || r.type === 'stayover')
      .sort((a, b) => (parseInt(a.number.replace(/\D/g, '')) || 0) - (parseInt(b.number.replace(/\D/g, '')) || 0)),
    [workShiftRooms]
  );

  // The selected crew: auto-pick or manual override.
  // Always strip out anyone who isn't a housekeeper anymore — a saved
  // crew doc from an earlier day can still carry the old IDs, and we
  // don't want a manager who got moved to 'other' to keep showing up
  // on the schedule with rooms assigned.
  const isHousekeeper = (s: StaffMember) => (s.department ?? 'housekeeping') === 'housekeeping';
  const selectedCrew = useMemo(() => {
    if (userEditedCrew.current) {
      // User has made manual changes — respect crewOverride exactly (even if empty)
      return crewOverride
        .map(id => staff.find(s => s.id === id))
        .filter((s): s is StaffMember => !!s && isHousekeeper(s));
    }
    if (crewOverride.length > 0) return crewOverride
      .map(id => staff.find(s => s.id === id))
      .filter((s): s is StaffMember => !!s && isHousekeeper(s));
    if (recommendedStaff > 0 && totalRooms > 0) return eligiblePool.slice(0, recommendedStaff);
    return eligiblePool;
  }, [crewOverride, eligiblePool, recommendedStaff, totalRooms, staff]);

  // Auto-assign: full assign on first load, then only assign unassigned rooms on crew changes
  useEffect(() => {
    if (assignableRooms.length === 0 || selectedCrew.length === 0) { setAssignments({}); hasInitialAssign.current = false; return; }

    if (!hasInitialAssign.current) {
      // First time: full auto-assign
      const fakeScheduled = selectedCrew.map(s => ({ ...s, scheduledToday: true }));
      const auto = autoAssignRooms(assignableRooms, fakeScheduled, {
        checkoutMinutes: coMins,
        stayoverMinutes: legacySoMins,
        stayoverDay1Minutes: day1Mins,
        stayoverDay2Minutes: day2Mins,
        prepMinutesPerRoom: prepPerRoom,
        shiftMinutes: shiftLen,
      });
      setAssignments(auto);
      hasInitialAssign.current = true;

      // Auto-remove staff with 0 rooms (unless manually added)
      const assignedStaffIds = new Set(Object.values(auto));
      const emptyStaff = selectedCrew.filter(s => !assignedStaffIds.has(s.id) && !manuallyAdded.current.has(s.id));
      if (emptyStaff.length > 0) {
        setCrewOverride(prev => {
          const current = prev.length > 0 ? prev : selectedCrew.map(s => s.id);
          return current.filter(id => assignedStaffIds.has(id) || manuallyAdded.current.has(id));
        });
      }
    }
    // On subsequent crew changes, don't re-assign — let unassigned rooms stay unassigned
  }, [selectedCrew, assignableRooms, coMins, soMins, day1Mins, day2Mins, prepPerRoom, shiftLen]);

  const toggleCrewMember = (memberId: string) => {
    userEditedCrew.current = true;
    setCrewOverride(prev => {
      const current = prev.length > 0 ? prev : selectedCrew.map(s => s.id);
      if (current.includes(memberId)) {
        manuallyAdded.current.delete(memberId);
        // Unassign this person's rooms (move to unassigned pool)
        setAssignments(a => {
          const updated = { ...a };
          for (const [roomId, staffId] of Object.entries(updated)) {
            if (staffId === memberId) delete updated[roomId];
          }
          return updated;
        });
        return current.filter(id => id !== memberId);
      } else {
        manuallyAdded.current.add(memberId);
        return [...current, memberId];
      }
    });
  };


  // Snapshot of what the CSV looked like at save time — so the next open can diff.
  const currentCsvSnapshot = useMemo<CsvRoomSnapshot[]>(
    () => shiftRooms.map(r => ({ number: r.number, type: r.type as 'checkout' | 'stayover' })),
    [shiftRooms],
  );
  const currentCsvPulledAt = useMemo<string | null>(
    () => (planSnapshot?.pulledAt ? new Date(planSnapshot.pulledAt).toISOString() : null),
    [planSnapshot?.pulledAt],
  );

  // Ref mirror of assignableRooms so the sync-effect below can read the latest
  // list without becoming a dep (which would cause loops when our own write
  // bumps the rooms snapshot).
  const assignableRoomsRef = useRef(assignableRooms);
  useEffect(() => { assignableRoomsRef.current = assignableRooms; }, [assignableRooms]);

  // ── Persist assignments + crew to scheduleAssignments (debounced) ─────────
  // This is what makes Maria's 7pm work survive the 6am CSV refresh.
  //
  // ALSO fires /api/sync-room-assignments which mirrors the per-room
  // `assignedTo`/`assignedName` field on each rooms doc so the crew-row "Link"
  // button (opens /housekeeper/{id}) shows the current Schedule state before
  // Maria even hits Send. The HK page queries rooms by `assignedTo`, so
  // without this sync the Link preview would show stale data.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!uid || !pid) return;
    if (!scheduleAssignmentsLoaded) return;            // don't save before first load
    if (hydratedForDate.current !== shiftDate) return; // still hydrating this date
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const staffNames: Record<string, string> = {};
      selectedCrew.forEach(s => { staffNames[s.id] = s.name; });
      saveScheduleAssignments(uid, pid, shiftDate, {
        roomAssignments: assignments,
        crew: selectedCrew.map(s => s.id),
        staffNames,
        csvRoomSnapshot: currentCsvSnapshot,
        csvPulledAt: currentCsvPulledAt,
      }).catch(err => console.error('[Schedule] save assignments failed:', err));

      // Mirror the assignments onto each room doc (drives the HK Link preview).
      // Best-effort — a transient failure here is not user-visible; the next
      // autosave or Send will catch it up. Uses an `assignableRoomsRef` so the
      // effect doesn't re-fire every time Firestore's own write bumps the
      // rooms snapshot (which would loop through this effect).
      const currentAssignable = assignableRoomsRef.current;
      const staffPayload = selectedCrew.map(s => ({
        staffId: s.id,
        staffName: s.name,
        assignedRooms: currentAssignable
          .filter(r => assignments[r.id] === s.id)
          .map(r => r.number),
      }));
      fetchWithAuth('/api/sync-room-assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid, pid, shiftDate, staff: staffPayload }),
      }).catch(err => console.error('[Schedule] sync room assignments failed:', err));
    }, 400);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [uid, pid, shiftDate, assignments, selectedCrew, scheduleAssignmentsLoaded, currentCsvSnapshot, currentCsvPulledAt]);

  // ── Morning diff: what changed between Maria's saved CSV and the fresh 6am CSV ──
  // Only fires when (a) she's saved before and (b) a newer CSV has landed.
  const morningDiff = useMemo(() => {
    if (!scheduleAssignmentsDoc) return null;
    const savedSnap = scheduleAssignmentsDoc.csvRoomSnapshot ?? [];
    const savedPulledAt = scheduleAssignmentsDoc.csvPulledAt ?? null;
    if (savedSnap.length === 0) return null;                  // first save — nothing to diff against
    if (!currentCsvPulledAt || !savedPulledAt) return null;
    if (new Date(currentCsvPulledAt) <= new Date(savedPulledAt)) return null; // same or older CSV

    const savedByNumber = new Map(savedSnap.map(r => [r.number, r.type]));
    const currentByNumber = new Map(currentCsvSnapshot.map(r => [r.number, r.type]));

    const added: CsvRoomSnapshot[] = [];
    const removed: CsvRoomSnapshot[] = [];
    const typeChanged: Array<{ number: string; was: 'checkout' | 'stayover'; now: 'checkout' | 'stayover' }> = [];

    for (const r of currentCsvSnapshot) {
      const prev = savedByNumber.get(r.number);
      if (prev === undefined) added.push(r);
      else if (prev !== r.type) typeChanged.push({ number: r.number, was: prev, now: r.type });
    }
    for (const r of savedSnap) {
      if (!currentByNumber.has(r.number)) removed.push(r);
    }

    const hasChanges = added.length > 0 || removed.length > 0 || typeChanged.length > 0;
    if (!hasChanges) return null;
    return { added, removed, typeChanged, savedPulledAt, currentPulledAt: currentCsvPulledAt };
  }, [scheduleAssignmentsDoc, currentCsvSnapshot, currentCsvPulledAt]);

  // ── Morning confirmation: fresh CSV landed since Maria's save but nothing changed ──
  // This gives her a positive signal instead of silence when the 6am pull matches 7pm.
  const morningConfirmation = useMemo(() => {
    if (morningDiff) return null; // yellow callout takes priority
    if (!scheduleAssignmentsDoc) return null;
    const savedSnap = scheduleAssignmentsDoc.csvRoomSnapshot ?? [];
    const savedPulledAt = scheduleAssignmentsDoc.csvPulledAt ?? null;
    if (savedSnap.length === 0) return null;
    if (!currentCsvPulledAt || !savedPulledAt) return null;
    if (new Date(currentCsvPulledAt) <= new Date(savedPulledAt)) return null;
    return { pulledAt: currentCsvPulledAt };
  }, [morningDiff, scheduleAssignmentsDoc, currentCsvPulledAt]);

  // Plain-English sentence describing what changed overnight.
  const morningSummary = useMemo(() => {
    if (!morningDiff) return '';
    const parts: string[] = [];
    const { added, removed, typeChanged } = morningDiff;
    if (added.length) {
      const co = added.filter(r => r.type === 'checkout').map(r => r.number);
      const so = added.filter(r => r.type === 'stayover').map(r => r.number);
      const bits: string[] = [];
      if (co.length) bits.push(`${co.length} new checkout${co.length === 1 ? '' : 's'} (${co.join(', ')})`);
      if (so.length) bits.push(`${so.length} new stayover${so.length === 1 ? '' : 's'} (${so.join(', ')})`);
      parts.push(bits.join(' and ') + ' showed up');
    }
    if (removed.length) {
      parts.push(`${removed.length} room${removed.length === 1 ? '' : 's'} got pulled (${removed.map(r => r.number).join(', ')})`);
    }
    if (typeChanged.length) {
      parts.push(typeChanged.map(c => `${c.number} flipped from ${c.was} to ${c.now}`).join(', '));
    }
    const joined = parts.length === 1 ? parts[0] : parts.slice(0, -1).join(', ') + ', and ' + parts.at(-1);
    return joined.charAt(0).toUpperCase() + joined.slice(1) + '.';
  }, [morningDiff]);

  // Auto Recommend — clean-slate redistribute every dirty room across the crew.
  //
  // Design rules (burned in from the 4/22 incident where Brenda ended at
  // 10h 15m, Cindy at 25m, and Julia at 9h 50m after a button press):
  //
  //   1. HARD CAP at shiftLen — nobody ever exceeds 7h (or whatever the
  //      operator configured). If nobody can fit a room, it stays unassigned
  //      and the "X rooms need a housekeeper" banner surfaces it.
  //   2. CLEAN-SLATE — every dirty room's assignment is wiped and rebuilt.
  //      Rooms already in_progress / clean / inspected are preserved (never
  //      yank a room off an HK mid-clean). This is what prevents stale 10h
  //      distributions from surviving the button press.
  //   3. CONSOLIDATION — after distribution, any HK with <2h of work has
  //      their rooms offered to other HKs who still have capacity under cap.
  //      If all their rooms get absorbed, they're dropped from crew (no more
  //      "Cindy shows up for one room" scenarios).
  //   4. SMART STAFFING — top up only when the current crew genuinely can't
  //      fit the work under cap. Then post-prune anyone who ended up empty.
  const handleAutoRecommend = () => {
    const MIN_WORTHWHILE_MINUTES = 120; // 2h — anything less gets consolidated

    // Preserved rooms — we never move these on a clean-slate pass:
    //   1. Status !== 'dirty' → HK already started, finished, or been
    //      signed off. Pulling it back is chaos.
    //   2. Maria manually dragged this room onto a specific HK. She
    //      overrode the algorithm deliberately, so respect it until she
    //      un-pins by dragging back to Unassigned.
    // Still-unassigned rooms with a manual pin (shouldn't happen, but
    // defensive) get the pin cleared and treated as redistributable.
    const isPinned = (r: Room) => {
      if (!manuallyAssignedRooms.current.has(r.id)) return false;
      const owner = assignments[r.id];
      return !!owner; // only honor pin if there's an actual owner
    };
    const isPreserved = (r: Room) => r.status !== 'dirty' || isPinned(r);
    const preservedRooms = assignableRooms.filter(isPreserved);
    const redistributableRooms = assignableRooms.filter(r => !isPreserved(r));

    // ── Step 1: top up crew to cleaningStaff (rooms-only, no laundry) ──
    const currentIds = new Set(selectedCrew.map(s => s.id));
    const additions: StaffMember[] = [];
    const target = Math.max(cleaningStaff, 1);
    for (const s of eligiblePool) {
      if (currentIds.has(s.id)) continue;
      if (selectedCrew.length + additions.length >= target) break;
      additions.push(s);
    }
    const effectiveCrew = [...selectedCrew, ...additions];
    if (effectiveCrew.length === 0) return;

    // ── Step 2: seed loads ONLY from preserved rooms ──
    // Dirty rooms are about to be rebuilt from zero. Preserved rooms (in
    // progress or done) keep their owner and contribute to that owner's
    // baseline load so the distribution accounts for work already in
    // flight.
    const loadByStaff = new Map<string, number>();
    const floorCountByStaff = new Map<string, Map<string, number>>();
    for (const s of effectiveCrew) {
      loadByStaff.set(s.id, 0);
      floorCountByStaff.set(s.id, new Map());
    }
    const next: Record<string, string> = {};
    // Track which floor each HK is locked to. If a HK has preserved rooms,
    // they're effectively locked to that floor already — record it so the
    // new-floor distribution can't add rooms from a different floor.
    const hkFloor = new Map<string, string>();
    for (const r of preservedRooms) {
      const who = assignments[r.id];
      if (!who || !loadByStaff.has(who)) continue;
      next[r.id] = who;
      const mins = minsForRoom(r) + prepPerRoom;
      loadByStaff.set(who, (loadByStaff.get(who) ?? 0) + mins);
      const f = getFloor(r.number);
      const fmap = floorCountByStaff.get(who)!;
      fmap.set(f, (fmap.get(f) ?? 0) + 1);
      // First preserved room wins the HK's floor lock. If that HK has more
      // preserved rooms on another floor (rare — only happens if Maria
      // manually assigned across floors earlier), they're still locked to
      // the first one seen here and the others stay on whichever HK they
      // already had.
      if (!hkFloor.has(who)) hkFloor.set(who, f);
    }

    // ── Step 3: group redistributable rooms by floor ──
    // Maria's hard rule: each housekeeper works ONE floor. Mixing floors
    // means extra walking between rooms, dragging cart & linen across the
    // building — so we cluster by floor before anything else and only split
    // a floor across multiple HKs if a single HK can't cover it under cap.
    //
    // Within a floor, rooms are sorted so the split (if any) is clean:
    //   1. VIP / early-arrival first — Maria wants those done ASAP
    //   2. Checkouts before stayovers (checkouts dominate cart loadout)
    //   3. Then by room number (natural walking order down the hall)
    const PRI_RANK: Record<string, number> = { vip: 0, early: 1, standard: 2 };
    const roomsByFloor = new Map<string, Room[]>();
    for (const r of redistributableRooms) {
      const f = getFloor(r.number);
      const list = roomsByFloor.get(f) ?? [];
      list.push(r);
      roomsByFloor.set(f, list);
    }
    for (const list of roomsByFloor.values()) {
      list.sort((a, b) => {
        const pA = PRI_RANK[a.priority ?? 'standard'] ?? 2;
        const pB = PRI_RANK[b.priority ?? 'standard'] ?? 2;
        if (pA !== pB) return pA - pB;
        if (a.type !== b.type) return a.type === 'checkout' ? -1 : 1;
        return (parseInt(a.number.replace(/\D/g, '')) || 0) - (parseInt(b.number.replace(/\D/g, '')) || 0);
      });
    }

    // Floor-level metadata: total minutes of dirty work per floor. Used to
    // (a) decide how many HKs a floor needs, (b) order floors biggest-first
    // so the hardest floor claims HKs before smaller ones.
    const minsByFloor = new Map<string, number>();
    for (const [f, list] of roomsByFloor) {
      const total = list.reduce((s, r) => s + minsForRoom(r) + prepPerRoom, 0);
      minsByFloor.set(f, total);
    }
    const sortedFloors = [...roomsByFloor.keys()].sort((a, b) => {
      // Floors with preserved work come first (HKs already locked there need
      // their remaining floor-mates pulled in first). Then biggest load.
      const aLocked = [...hkFloor.values()].includes(a) ? 1 : 0;
      const bLocked = [...hkFloor.values()].includes(b) ? 1 : 0;
      if (aLocked !== bLocked) return bLocked - aLocked;
      return (minsByFloor.get(b) ?? 0) - (minsByFloor.get(a) ?? 0);
    });

    // ── Step 4: assign each floor to HK(s), then split rooms contiguously ──
    //
    // Per floor:
    //   1. Find HKs already locked to this floor (preserved rooms). They're in.
    //   2. If their remaining capacity covers the floor, done — one HK per floor.
    //   3. If not, pull in more HKs from the unassigned pool until covered.
    //   4. Split the floor's sorted room list into contiguous chunks of
    //      roughly equal minutes and assign each chunk to an HK.
    //
    // A chunk can't exceed shiftLen (hard cap). If rooms don't fit even
    // after adding every HK, the leftovers stay unassigned — Maria sees
    // them in the Unassigned bucket and can manually place them or add
    // more crew.
    const hksByFloor = new Map<string, string[]>(); // floor -> ordered HK ids

    for (const f of sortedFloors) {
      const rooms = roomsByFloor.get(f)!;
      const totalMins = minsByFloor.get(f) ?? 0;

      // (1) Pre-locked HKs for this floor (have preserved rooms here).
      const lockedHKs = effectiveCrew.filter(s => hkFloor.get(s.id) === f);

      // (2)+(3) Figure out total HKs needed. Start with locked, add from
      // the unassigned pool until the floor's total mins is covered by
      // remaining capacity.
      const chosen: typeof effectiveCrew = [...lockedHKs];
      const remainingCap = () => chosen.reduce(
        (sum, s) => sum + Math.max(0, shiftLen - (loadByStaff.get(s.id) ?? 0)),
        0,
      );
      const unassignedPool = effectiveCrew
        .filter(s => !hkFloor.has(s.id))
        .sort((a, b) => (loadByStaff.get(a.id) ?? 0) - (loadByStaff.get(b.id) ?? 0));
      for (const hk of unassignedPool) {
        if (remainingCap() >= totalMins) break;
        chosen.push(hk);
        hkFloor.set(hk.id, f);
      }
      // Degenerate case: more floors than HKs. Borrow the least-loaded
      // already-assigned HK as a last resort rather than leaving a whole
      // floor unassigned. Adjacent-floor preference (closer floor numbers
      // = less walking) breaks ties so e.g. an HK on floor 3 picks up
      // floor 4 before an HK on floor 1 does.
      if (chosen.length === 0) {
        const floorNum = parseInt(f) || 0;
        const fallback = effectiveCrew
          .filter(s => (loadByStaff.get(s.id) ?? 0) < shiftLen)
          .sort((a, b) => {
            const aFloor = hkFloor.get(a.id);
            const bFloor = hkFloor.get(b.id);
            const aDist = aFloor ? Math.abs((parseInt(aFloor) || 0) - floorNum) : 99;
            const bDist = bFloor ? Math.abs((parseInt(bFloor) || 0) - floorNum) : 99;
            if (aDist !== bDist) return aDist - bDist;
            return (loadByStaff.get(a.id) ?? 0) - (loadByStaff.get(b.id) ?? 0);
          });
        if (fallback.length > 0) chosen.push(fallback[0]);
      }
      if (chosen.length === 0) continue; // still no HKs — rooms stay unassigned

      // Make sure locked HKs also get the floor-lock registered (in case
      // they weren't already — e.g. they had an in-progress room but we
      // didn't see it in preserved seeding).
      for (const s of lockedHKs) hkFloor.set(s.id, f);
      hksByFloor.set(f, chosen.map(s => s.id));

      // (4) Split the sorted rooms into contiguous chunks. Target: equal
      // minutes per HK, respecting each HK's remaining capacity. Use a
      // simple "fill current HK to target, then advance" approach — keeps
      // each HK's rooms contiguous in the room number order, which matches
      // the physical walking path down the hallway.
      const targetPerHK = chosen.length > 0 ? totalMins / chosen.length : totalMins;
      let hkIdx = 0;
      let chunkMins = 0;
      for (const r of rooms) {
        const mins = minsForRoom(r) + prepPerRoom;
        // Advance to next HK if current chunk has reached its share AND
        // there's another HK to advance to. This is what keeps the split
        // contiguous and balanced.
        if (
          hkIdx + 1 < chosen.length &&
          chunkMins >= targetPerHK
        ) {
          hkIdx++;
          chunkMins = 0;
        }
        // Also advance if adding this room would exceed the current HK's
        // hard cap — prevents cap violations when preserved rooms already
        // ate into one HK's capacity unevenly.
        if (
          hkIdx + 1 < chosen.length &&
          (loadByStaff.get(chosen[hkIdx].id) ?? 0) + mins > shiftLen
        ) {
          hkIdx++;
          chunkMins = 0;
        }

        const pick = chosen[hkIdx];
        if ((loadByStaff.get(pick.id) ?? 0) + mins > shiftLen) {
          // Can't fit even on the current HK and no more HKs to roll onto.
          // Leave the room unassigned — Maria gets to decide.
          continue;
        }
        next[r.id] = pick.id;
        loadByStaff.set(pick.id, (loadByStaff.get(pick.id) ?? 0) + mins);
        chunkMins += mins;
        const fmap = floorCountByStaff.get(pick.id)!;
        fmap.set(f, (fmap.get(f) ?? 0) + 1);
      }
    }

    // ── Step 5: consolidation pass ──
    // If any HK ended up with less than MIN_WORTHWHILE_MINUTES of work,
    // try to move their rooms onto other HKs who still have capacity.
    // We don't touch preserved rooms (in-progress stays put even if it's
    // only 25 minutes of work — can't pull a room off someone mid-clean).
    // If all movable rooms get absorbed, the HK is eligible to be dropped
    // from the crew by Step 6.
    const preservedByStaff = new Map<string, number>();
    for (const r of preservedRooms) {
      const who = next[r.id];
      if (!who) continue;
      preservedByStaff.set(who, (preservedByStaff.get(who) ?? 0) + 1);
    }
    // Also don't let consolidation move manually-pinned rooms off their
    // HK — they were placed there intentionally.
    const pinnedSet = new Set<string>();
    for (const r of assignableRooms) {
      if (isPinned(r)) pinnedSet.add(r.id);
    }

    // Iterate repeatedly: moving rooms can push another HK below the
    // threshold, or free capacity on the recipient. Cap at crew.length
    // iterations to avoid any theoretical loop.
    for (let pass = 0; pass < effectiveCrew.length; pass++) {
      let movedThisPass = false;
      for (const giver of effectiveCrew) {
        const giverLoad = loadByStaff.get(giver.id) ?? 0;
        if (giverLoad >= MIN_WORTHWHILE_MINUTES) continue;
        if (giverLoad === 0) continue; // nothing to move — will be pruned
        if ((preservedByStaff.get(giver.id) ?? 0) > 0) continue; // don't disturb in-progress
        // Find every redistributable, non-pinned room currently assigned
        // to giver. (Pinned rooms survive consolidation too.)
        const giverRooms = redistributableRooms.filter(r =>
          next[r.id] === giver.id && !pinnedSet.has(r.id)
        );
        if (giverRooms.length === 0) continue;
        // Try to move each room to another HK under cap. Sort smallest
        // rooms first so if some fit and some don't, we at least offload
        // the easy wins and drain the giver down.
        const withSize = giverRooms.map(r => ({ r, mins: minsForRoom(r) + prepPerRoom }))
          .sort((a, b) => a.mins - b.mins);
        const moves: Array<{ room: Room; mins: number; to: string; from: string }> = [];
        const simLoad = new Map(loadByStaff);
        const simFloorCount = new Map<string, Map<string, number>>();
        floorCountByStaff.forEach((m, k) => simFloorCount.set(k, new Map(m)));
        let giverEmptied = true;
        for (const { r, mins } of withSize) {
          const f = getFloor(r.number);
          // Pick recipient: someone other than giver, under cap, prefer
          // most floor ownership then least load (same ruleset as Step 4).
          const candidates = effectiveCrew.filter(s =>
            s.id !== giver.id &&
            (simLoad.get(s.id) ?? 0) + mins <= shiftLen
          );
          if (candidates.length === 0) { giverEmptied = false; break; }
          let pick: string | null = null;
          let pickFloor = -1;
          let pickLoad = Infinity;
          for (const s of candidates) {
            const fc = simFloorCount.get(s.id)?.get(f) ?? 0;
            const load = simLoad.get(s.id) ?? 0;
            if (fc > pickFloor || (fc === pickFloor && load < pickLoad)) {
              pickFloor = fc;
              pickLoad = load;
              pick = s.id;
            }
          }
          if (!pick) { giverEmptied = false; break; }
          moves.push({ room: r, mins, to: pick, from: giver.id });
          simLoad.set(pick, (simLoad.get(pick) ?? 0) + mins);
          simLoad.set(giver.id, (simLoad.get(giver.id) ?? 0) - mins);
          const fmapTo = simFloorCount.get(pick)!;
          fmapTo.set(f, (fmapTo.get(f) ?? 0) + 1);
          const fmapFrom = simFloorCount.get(giver.id)!;
          fmapFrom.set(f, Math.max(0, (fmapFrom.get(f) ?? 0) - 1));
        }
        // Only commit the moves if they actually emptied the giver — a
        // partial move would leave the giver with a smaller-still tiny
        // load, which defeats the purpose.
        if (giverEmptied && moves.length > 0) {
          for (const mv of moves) {
            next[mv.room.id] = mv.to;
          }
          // Commit the simulated loads / floor counts.
          simLoad.forEach((v, k) => loadByStaff.set(k, v));
          simFloorCount.forEach((m, k) => floorCountByStaff.set(k, m));
          movedThisPass = true;
        }
      }
      if (!movedThisPass) break;
    }

    // ── Step 5b: aggressive cross-floor consolidation ──
    // Same-floor consolidation (Step 5) keeps everyone on one floor but
    // leaves HKs half-loaded when a floor is light. This pass is willing
    // to break the floor rule *only when doing so eliminates a whole HK*.
    // Scattering rooms across floors for no net HK reduction is worse
    // than sticking to one floor — so we only commit moves that fully
    // empty the giver. Try smallest-load HKs first.
    for (let pass = 0; pass < effectiveCrew.length; pass++) {
      // Recompute sort each pass — loads change as we eliminate HKs.
      const candidates = [...effectiveCrew]
        .filter(s => (loadByStaff.get(s.id) ?? 0) > 0)
        .filter(s => (preservedByStaff.get(s.id) ?? 0) === 0)
        .sort((a, b) => (loadByStaff.get(a.id) ?? 0) - (loadByStaff.get(b.id) ?? 0));
      let eliminatedThisPass = false;
      for (const giver of candidates) {
        const giverRooms = redistributableRooms.filter(r =>
          next[r.id] === giver.id && !pinnedSet.has(r.id),
        );
        if (giverRooms.length === 0) continue;

        // Try to place every giver room on some other HK without ever
        // going over cap. Big rooms first — if there's a tight slot, we
        // want to claim it with the big one while space still exists.
        const withSize = giverRooms
          .map(r => ({ r, mins: minsForRoom(r) + prepPerRoom }))
          .sort((a, b) => b.mins - a.mins);
        const moves: Array<{ room: Room; mins: number; to: string }> = [];
        const simLoad = new Map(loadByStaff);
        const simFloorCount = new Map<string, Map<string, number>>();
        floorCountByStaff.forEach((m, k) => simFloorCount.set(k, new Map(m)));
        let allFit = true;
        for (const { r, mins } of withSize) {
          const f = getFloor(r.number);
          const recipients = effectiveCrew.filter(s =>
            s.id !== giver.id &&
            (simLoad.get(s.id) ?? 0) + mins <= shiftLen,
          );
          if (recipients.length === 0) { allFit = false; break; }
          // Prefer recipient already on this floor (zero walk penalty).
          // Ties broken by lowest current load (spread, not pile).
          let pick: string | null = null;
          let pickFc = -1;
          let pickLoad = Infinity;
          for (const s of recipients) {
            const fc = simFloorCount.get(s.id)?.get(f) ?? 0;
            const load = simLoad.get(s.id) ?? 0;
            if (fc > pickFc || (fc === pickFc && load < pickLoad)) {
              pickFc = fc;
              pickLoad = load;
              pick = s.id;
            }
          }
          if (!pick) { allFit = false; break; }
          moves.push({ room: r, mins, to: pick });
          simLoad.set(pick, (simLoad.get(pick) ?? 0) + mins);
          simLoad.set(giver.id, (simLoad.get(giver.id) ?? 0) - mins);
          const fmapTo = simFloorCount.get(pick)!;
          fmapTo.set(f, (fmapTo.get(f) ?? 0) + 1);
          const fmapFrom = simFloorCount.get(giver.id)!;
          fmapFrom.set(f, Math.max(0, (fmapFrom.get(f) ?? 0) - 1));
        }
        // All of giver's rooms fit on others → commit and mark giver
        // empty. They'll get pruned from the crew by Step 6.
        if (allFit && moves.length > 0) {
          for (const mv of moves) next[mv.room.id] = mv.to;
          simLoad.forEach((v, k) => loadByStaff.set(k, v));
          simFloorCount.forEach((m, k) => floorCountByStaff.set(k, m));
          eliminatedThisPass = true;
          break; // sort order is now stale, restart outer loop
        }
      }
      if (!eliminatedThisPass) break;
    }

    // ── Step 5c: retry previously-unassigned rooms ──
    // Eliminating an HK can free capacity on their former crew-mates.
    // More useful, though: it can free capacity on the *other* HKs on
    // the same floor because the eliminated HK's floor mates no longer
    // have to share with a second HK. Give every unassigned room one
    // more shot at landing somewhere.
    const nowUnassigned = redistributableRooms.filter(r => !next[r.id]);
    for (const r of nowUnassigned) {
      const mins = minsForRoom(r) + prepPerRoom;
      const f = getFloor(r.number);
      const recipients = effectiveCrew.filter(s =>
        (loadByStaff.get(s.id) ?? 0) + mins <= shiftLen,
      );
      if (recipients.length === 0) continue;
      let pick: string | null = null;
      let pickFc = -1;
      let pickLoad = Infinity;
      for (const s of recipients) {
        const fc = floorCountByStaff.get(s.id)?.get(f) ?? 0;
        const load = loadByStaff.get(s.id) ?? 0;
        if (fc > pickFc || (fc === pickFc && load < pickLoad)) {
          pickFc = fc;
          pickLoad = load;
          pick = s.id;
        }
      }
      if (!pick) continue;
      next[r.id] = pick;
      loadByStaff.set(pick, (loadByStaff.get(pick) ?? 0) + mins);
      const fmap = floorCountByStaff.get(pick)!;
      fmap.set(f, (fmap.get(f) ?? 0) + 1);
    }

    // ── Step 6: drop anyone with 0 rooms after distribution + consolidation ──
    const usedStaffIds = new Set(
      Object.values(next).filter((v): v is string => !!v)
    );
    const keep = effectiveCrew.filter(s => usedStaffIds.has(s.id));
    const dropped = effectiveCrew.filter(s => !usedStaffIds.has(s.id));
    const shouldPrune = keep.length > 0 && dropped.length > 0;

    if (additions.length > 0 || shouldPrune) {
      userEditedCrew.current = true;
      additions.forEach(s => {
        if (usedStaffIds.has(s.id)) manuallyAdded.current.add(s.id);
      });
      dropped.forEach(s => manuallyAdded.current.delete(s.id));
      const finalCrew = shouldPrune ? keep : effectiveCrew;
      setCrewOverride(finalCrew.map(s => s.id));
    }
    setAssignments(next);

    // Toast summary — count how many rooms are still unassigned + whether
    // anyone is still over cap (shouldn't happen with hard cap, but a
    // safety signal for dev).
    const stillUnassigned = redistributableRooms.filter(r => !next[r.id]).length;
    const overCapList = effectiveCrew
      .filter(s => (loadByStaff.get(s.id) ?? 0) > shiftLen)
      .map(s => s.name.split(' ')[0]); // first name is enough for a toast

    const parts: string[] = [];
    if (additions.length > 0) {
      parts.push(lang === 'es'
        ? `Agregado${additions.length === 1 ? '' : 's'}: ${additions.length}`
        : `Added ${additions.length}`);
    }
    if (shouldPrune) {
      parts.push(lang === 'es'
        ? `Quitado${dropped.length === 1 ? '' : 's'}: ${dropped.length}`
        : `Removed ${dropped.length}`);
    }
    if (stillUnassigned > 0) {
      parts.push(lang === 'es'
        ? `${stillUnassigned} sin asignar (añade personal)`
        : `${stillUnassigned} unassigned (add staff)`);
    }
    if (overCapList.length > 0) {
      // Hard cap should prevent this. If it fires, a pinned room pushed
      // someone over — show who so Maria can un-pin or stretch manually.
      parts.push(lang === 'es'
        ? `⚠︎ sobre el límite: ${overCapList.join(', ')}`
        : `⚠︎ over cap: ${overCapList.join(', ')}`);
    }
    const toastMsg = parts.length > 0
      ? (lang === 'es'
          ? `Habitaciones redistribuidas (${parts.join(', ')})`
          : `Rooms redistributed (${parts.join(', ')})`)
      : (lang === 'es' ? 'Habitaciones redistribuidas' : 'Rooms redistributed');
    showMoveToast(toastMsg);
  };

  const handleSend = async () => {
    if (!uid || !pid || selectedCrew.length === 0 || sending) return;
    setSending(true);
    try {
      // Make sure the latest assignments are written before we fire SMS.
      // The debounced save above may still be pending.
      const staffNames: Record<string, string> = {};
      selectedCrew.forEach(s => { staffNames[s.id] = s.name; });
      await saveScheduleAssignments(uid, pid, shiftDate, {
        roomAssignments: assignments,
        crew: selectedCrew.map(s => s.id),
        staffNames,
        csvRoomSnapshot: currentCsvSnapshot,
        csvPulledAt: currentCsvPulledAt,
      }).catch(err => console.error('[Schedule] save-before-send failed:', err));

      const baseUrl = window.location.origin;
      // Include EVERYONE on the crew — even people without a phone number.
      // The backend skips the SMS for phoneless staff but keeps their room
      // assignments intact (so the rooms don't fly back to Unassigned). Each
      // person gets a status back (sent / skipped / failed) that we render
      // as a badge next to their name.
      const staffPayload = selectedCrew.map(s => {
        const memberRooms = assignableRooms
          .filter(r => assignments[r.id] === s.id)
          .map(r => r.number);
        return {
          staffId: s.id,
          name: s.name,
          phone: s.phone ?? '',
          language: s.language,
          assignedRooms: memberRooms,
          assignedAreas: [] as string[],
        };
      });
      const res = await fetchWithAuth('/api/send-shift-confirmations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid, pid, shiftDate, baseUrl, staff: staffPayload }),
      });
      // The subscribeToShiftConfirmations effect will pick up the new docs
      // and flip `alreadySent` automatically.

      // Parse the API response so we can tell Maria what actually happened:
      // - `fresh`: HKs who got a brand-new link SMS (no prior doc)
      // - `updated`: HKs whose existing doc was refreshed + re-texted
      // - `skipped`: HKs we couldn't text (no phone / invalid phone)
      // - `failed`: SMS sends that errored (Twilio issue, etc.)
      // - `perStaff`: per-person outcome, drives the badge next to each name
      try {
        const data = (await res.json()) as {
          sent?: number; failed?: number; skipped?: number; updated?: number; fresh?: number;
          perStaff?: Array<{ staffId: string; status: 'sent' | 'skipped' | 'failed'; reason?: string }>;
        };
        const fresh = data.fresh ?? 0;
        const updated = data.updated ?? 0;
        const skipped = data.skipped ?? 0;
        const failed = data.failed ?? 0;

        // Store per-person outcome so each crew card can show its own badge.
        if (data.perStaff) {
          const m = new Map<string, SendResult>();
          data.perStaff.forEach(r => m.set(r.staffId, { status: r.status, reason: r.reason }));
          setSendResults(m);
        }

        const parts: string[] = [];
        if (fresh > 0) parts.push(lang === 'es' ? `${fresh} enlace${fresh === 1 ? '' : 's'}` : `${fresh} link${fresh === 1 ? '' : 's'}`);
        if (updated > 0) parts.push(lang === 'es' ? `${updated} actualización${updated === 1 ? '' : 'es'}` : `${updated} update${updated === 1 ? '' : 's'}`);
        if (skipped > 0) parts.push(lang === 'es' ? `${skipped} omitido${skipped === 1 ? '' : 's'}` : `${skipped} skipped`);
        if (failed > 0) parts.push(lang === 'es' ? `${failed} fallaron` : `${failed} failed`);

        const msg = parts.length
          ? (lang === 'es' ? `Enviado: ${parts.join(' · ')}` : `Sent: ${parts.join(' · ')}`)
          : (lang === 'es' ? 'Enviado' : 'Sent');

        if (toastTimer.current) clearTimeout(toastTimer.current);
        setMoveToast(msg);
        toastTimer.current = setTimeout(() => setMoveToast(null), 5000);
      } catch (err) {
        console.error('[Schedule] send response parse failed:', err);
      }
    } finally { setSending(false); }
  };

  // Room workload per staff member
  const getStaffWorkload = (staffId: string) => {
    const staffRooms = assignableRooms.filter(r => assignments[r.id] === staffId);
    const mins = staffRooms.reduce((sum, r) => sum + minsForRoom(r) + prepPerRoom, 0);
    return { rooms: staffRooms, mins };
  };

  // Unassigned rooms (not assigned to any current crew member)
  const unassignedRooms = useMemo(() => {
    const crewIds = new Set(selectedCrew.map(s => s.id));
    return assignableRooms.filter(r => !assignments[r.id] || !crewIds.has(assignments[r.id]));
  }, [assignableRooms, assignments, selectedCrew]);

  const unassignedRef = useRef<HTMLDivElement | null>(null);

  // ── Drag-and-drop via Pointer Events (mouse + touch) ──
  const DRAG_THRESHOLD = 8;

  const findDropTarget = useCallback((x: number, y: number): string | null => {
    // Check unassigned box first
    if (unassignedRef.current) {
      const r = unassignedRef.current.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return '__unassigned__';
    }
    for (const [staffId, el] of Object.entries(crewCardRefs.current)) {
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return staffId;
    }
    return null;
  }, []);

  const showMoveToast = useCallback((msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setMoveToast(msg);
    toastTimer.current = setTimeout(() => setMoveToast(null), 4000);
  }, []);

  // Shared commit path used by both press-and-drag release and click-to-drop.
  // Reads fromStaffId out of the current assignments, writes the new target,
  // pins the room as a manual placement (so Auto Assign won't move it), and
  // surfaces a move toast. No-op if the target is the same as the source.
  const commitRoomTo = useCallback((roomId: string, roomNumber: string, target: string | null) => {
    if (!roomId || !target) return;
    const fromStaffId = assignments[roomId];
    if (target === '__unassigned__') {
      if (!fromStaffId) return; // already unassigned
      setAssignments(a => { const updated = { ...a }; delete updated[roomId]; return updated; });
      manuallyAssignedRooms.current.delete(roomId);
      const fromName = selectedCrew.find(s => s.id === fromStaffId)?.name ?? '?';
      showMoveToast(lang === 'es' ? `${roomNumber} movida de ${fromName} a Sin Asignar` : `Moved ${roomNumber} from ${fromName} to Unassigned`);
      return;
    }
    if (fromStaffId === target) return; // dropped back on source
    setAssignments(a => ({ ...a, [roomId]: target }));
    manuallyAssignedRooms.current.add(roomId);
    const fromName = fromStaffId ? (selectedCrew.find(s => s.id === fromStaffId)?.name ?? '?') : (lang === 'es' ? 'Sin Asignar' : 'Unassigned');
    const toName = selectedCrew.find(s => s.id === target)?.name ?? '?';
    showMoveToast(lang === 'es' ? `${roomNumber} movida de ${fromName} a ${toName}` : `Moved ${roomNumber} from ${fromName} to ${toName}`);
  }, [assignments, selectedCrew, lang, showMoveToast]);

  const onPillPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>, room: Room) => {
    // Stop the window-level pointerdown (attached while floating) from also
    // running — the pill handler owns this click.
    e.stopPropagation();

    // If we're already floating from a previous click, this click is a drop
    // onto this pill's crew card (or back onto the source pill). Commit and
    // exit floating mode. Do NOT start a new drag.
    if (dragState?.floating && dragState.roomId) {
      const target = findDropTarget(e.clientX, e.clientY);
      commitRoomTo(dragState.roomId, dragState.roomNumber, target);
      setDragState(null);
      dragRef.current = { roomId: null, roomNumber: '', roomType: '', startX: 0, startY: 0, active: false };
      return;
    }

    // Otherwise start press-and-drag tracking. If the pointer moves past the
    // threshold before release, we enter classic drag mode; if it releases
    // without moving, pointerup will switch into click-float mode.
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      roomId: room.id, roomNumber: room.number, roomType: room.type, stayoverDay: room.stayoverDay,
      startX: e.clientX, startY: e.clientY, active: false,
    };
  }, [dragState, findDropTarget, commitRoomTo]);

  const onPillPointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d.roomId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.active) {
      if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
      d.active = true;
    }
    e.preventDefault();
    const dt = findDropTarget(e.clientX, e.clientY);
    setDragState({
      roomId: d.roomId, roomNumber: d.roomNumber, roomType: d.roomType, stayoverDay: d.stayoverDay,
      ghost: { x: e.clientX, y: e.clientY }, dropTarget: dt,
    });
  }, [findDropTarget]);

  const onPillPointerUp = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
    const d = dragRef.current;
    // Press-and-drag path: pointer moved past threshold before release.
    if (d.active && d.roomId) {
      setDragState(prev => {
        if (prev?.roomId && prev.dropTarget) {
          commitRoomTo(prev.roomId, prev.roomNumber, prev.dropTarget);
        }
        return null;
      });
      dragRef.current = { roomId: null, roomNumber: '', roomType: '', startX: 0, startY: 0, active: false };
      return;
    }

    // Click-to-pickup path: pointer released without moving. Enter floating
    // mode — the pill sticks to the cursor until the next click commits it.
    if (d.roomId && !dragState?.floating) {
      setDragState({
        roomId: d.roomId, roomNumber: d.roomNumber, roomType: d.roomType, stayoverDay: d.stayoverDay,
        ghost: { x: e.clientX, y: e.clientY },
        dropTarget: findDropTarget(e.clientX, e.clientY),
        floating: true,
      });
    }
    dragRef.current = { roomId: null, roomNumber: '', roomType: '', startX: 0, startY: 0, active: false };
  }, [dragState, findDropTarget, commitRoomTo]);

  // If the browser cancels the pointer (e.g. interrupted by scroll, app switch),
  // clear any in-flight press-drag state — but leave `floating` mode alone
  // (floating rooms should persist across scroll gestures).
  const onPillPointerCancel = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
    if (dragRef.current.active) {
      setDragState(prev => (prev?.floating ? prev : null));
    }
    dragRef.current = { roomId: null, roomNumber: '', roomType: '', startX: 0, startY: 0, active: false };
  }, []);

  // Floating mode: while a pill is stuck to the cursor, we need window-level
  // listeners so the ghost follows the pointer everywhere (not just over the
  // pill's original crew card) and so clicks on empty space cancel cleanly.
  // Clicks on pills are handled by the pill's own onPointerDown (which stops
  // propagation); this effect picks up everything else.
  useEffect(() => {
    if (!dragState?.floating) return;

    const onMove = (e: PointerEvent) => {
      const dt = findDropTarget(e.clientX, e.clientY);
      setDragState(prev => (prev && prev.floating
        ? { ...prev, ghost: { x: e.clientX, y: e.clientY }, dropTarget: dt }
        : prev));
    };

    const onDown = (e: PointerEvent) => {
      // If the click is on a room pill, the pill's own handler runs and
      // stops propagation; this listener won't fire. So anything that
      // reaches here is a click on empty space or a crew card / unassigned
      // box. findDropTarget tells us which (if any).
      const target = findDropTarget(e.clientX, e.clientY);
      setDragState(prev => {
        if (!prev || !prev.floating) return prev;
        if (target) {
          commitRoomTo(prev.roomId, prev.roomNumber, target);
        }
        return null;
      });
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDragState(null);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [dragState?.floating, findDropTarget, commitRoomTo]);

  return (
    <div style={{ padding: '16px 24px 200px', background: 'var(--bg)', minHeight: 'calc(100dvh - 180px)', display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* ── Date picker ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '16px' }}>
        <button onClick={() => { setShiftDate(d => addDays(d, -1)); setCrewOverride([]); }} style={{ background: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(24px)', border: '1px solid rgba(197,197,212,0.2)', borderRadius: '12px', padding: '8px 12px', cursor: 'pointer', color: '#454652' }} aria-label={lang === 'es' ? 'Día anterior' : 'Previous day'}>
          <ChevronLeft size={18} />
        </button>
        <span style={{ fontSize: '16px', fontWeight: 600, color: '#364262', letterSpacing: '-0.01em' }}>
          {formatDisplayDate(shiftDate, lang)}
        </span>
        <button onClick={() => { setShiftDate(d => addDays(d, 1)); setCrewOverride([]); }} style={{ background: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(24px)', border: '1px solid rgba(197,197,212,0.2)', borderRadius: '12px', padding: '8px 12px', cursor: 'pointer', color: '#454652' }} aria-label={lang === 'es' ? 'Día siguiente' : 'Next day'}>
          <ChevronRight size={18} />
        </button>
      </div>

      {/* ── Last CSV update stamp — always visible so Maria knows the system is alive ── */}
      {currentCsvPulledAt && (() => {
        const ageMs = Date.now() - new Date(currentCsvPulledAt).getTime();
        const ageHours = ageMs / (1000 * 60 * 60);
        const isStale = ageHours > 6; // flag if >6h old
        const isVeryStale = ageHours > 12;
        const accent = isVeryStale ? '#b91c1c' : isStale ? '#b45309' : '#364262';
        const mutedText = isVeryStale ? '#ef4444' : isStale ? '#d97706' : '#94a3b8';
        return (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
            fontSize: '12px', color: isStale ? accent : '#64748b', marginTop: '-12px',
            fontWeight: isStale ? 600 : 400,
          }}>
            {isStale ? <AlertTriangle size={12} style={{ color: accent }} /> : <Clock size={12} style={{ color: '#94a3b8' }} />}
            <span>
              {lang === 'es' ? 'Lista de habitaciones actualizada:' : 'Room list updated:'}{' '}
              <span style={{ color: accent, fontWeight: 600 }}>{formatPulledAt(currentCsvPulledAt, lang)}</span>
              {planSnapshot?.pullType && (
                <span style={{ color: mutedText }}>
                  {' · '}
                  {planSnapshot.pullType === 'evening'
                    ? (lang === 'es' ? 'Plan nocturno' : 'Evening plan')
                    : (lang === 'es' ? 'Plan matutino' : 'Morning plan')}
                </span>
              )}
              {isStale && (
                <span style={{ color: accent, marginLeft: '8px' }}>
                  {lang === 'es'
                    ? `· Datos de hace ${Math.round(ageHours)}h — considera recargar`
                    : `· ${Math.round(ageHours)}h old — consider refreshing`}
                </span>
              )}
            </span>
          </div>
        );
      })()}

      {/* ── Prediction Hero Card (glass) ── */}
      <section className="glass-hero" style={{
        border: '1px solid rgba(197,197,212,0.2)', borderRadius: '16px',
        padding: '24px 32px', position: 'relative', overflow: 'hidden',
        cursor: 'pointer', margin: '0 auto', width: 'fit-content', minWidth: '320px',
      }} onClick={() => setShowPredictionSettings(true)}>
        {/* Background image — same as dashboard hero */}
        <div className="glass-hero-bg">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="https://lh3.googleusercontent.com/aida-public/AB6AXuAUkJ87OGqb9QZ3nLbfCbHYuNgoCRsfcrSTqcfy8LlaEm8_94XXXZc5LvqA_5T36RJJykyAlxUHbasVhW-V52jbgsdVMHhedC17vZk_Y5-TCMq6NWzbrN60mUF_bgeUYq_2wEOltK3e5GIuN5krTVz7lju3NN9ru-gTTwjtEG0ZIRdl1dGDL4FP5KjnJsNm2lw4HNq9nO7C0xSjh0WnhsNEQ0c9rQP5-Bg5ycpesyUdhDiSQPxFLzP6L1vDs-8LjUHCbvH0R4UFxyU"
            alt=""
            aria-hidden="true"
          />
        </div>

        {predictionLoading ? (
          <div style={{ textAlign: 'center' }}>
            <div className="spinner" style={{ width: '28px', height: '28px', margin: '0 auto 12px' }} />
            <p style={{ fontSize: '14px', color: '#454652', margin: 0 }}>{t('roomDataLoading', lang)}</p>
          </div>
        ) : totalRooms === 0 && planSnapshot ? (
          /* ── Plan Snapshot Card (CSV data from 7pm/6am) ── */
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', position: 'relative', zIndex: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
              <span style={{ fontSize: '12px', color: '#64748b', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {planSnapshot.pullType === 'evening' ? (lang === 'es' ? 'Plan Nocturno' : 'Evening Plan') : (lang === 'es' ? 'Plan Matutino' : 'Morning Plan')}
              </span>
              <span style={{ fontSize: '11px', color: '#94a3b8' }}>
                {planSnapshot.pulledAt ? new Date(planSnapshot.pulledAt).toLocaleTimeString(lang === 'es' ? 'es' : 'en', { hour: 'numeric', minute: '2-digit' }) : ''}
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, auto)', gap: '40px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <p style={{ fontSize: '14px', color: '#454652', fontWeight: 500, margin: 0 }}>{lang === 'es' ? 'Salidas' : 'Checkouts'}</p>
                <p style={{ fontFamily: 'var(--font-mono)', fontSize: '36px', fontWeight: 500, color: '#364262', lineHeight: 1, margin: 0 }}>{planSnapshot.checkouts}</p>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <p style={{ fontSize: '14px', color: '#454652', fontWeight: 500, margin: 0 }}>{lang === 'es' ? 'Continuaciones' : 'Stayovers'}</p>
                <p style={{ fontFamily: 'var(--font-mono)', fontSize: '36px', fontWeight: 500, color: '#364262', lineHeight: 1, margin: 0 }}>
                  {planSnapshot.stayovers}
                  <span style={{ fontSize: '14px', color: '#64748b', fontWeight: 400, marginLeft: '6px' }}>
                    ({planSnapshot.stayoverDay1 ?? 0} {lang === 'es' ? 'ligeros' : 'light'} · {planSnapshot.stayoverDay2 ?? 0} {lang === 'es' ? 'completos' : 'full'})
                  </span>
                </p>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <p style={{ fontSize: '14px', color: '#454652', fontWeight: 500, margin: 0 }}>{lang === 'es' ? 'Personal Necesario' : 'Staff Needed'}</p>
                <p style={{ fontFamily: 'var(--font-mono)', fontSize: '36px', fontWeight: 500, color: '#364262', lineHeight: 1, margin: 0 }}>{planSnapshot.recommendedHKs}</p>
              </div>
            </div>
            {/* Workload bar */}
            <div style={{ width: '100%', maxWidth: '400px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                <span style={{ fontSize: '12px', color: '#64748b', fontWeight: 500 }}>{lang === 'es' ? 'Carga Total' : 'Total Workload'}</span>
                <span style={{ fontSize: '12px', fontFamily: 'var(--font-mono)', color: '#454652' }}>
                  {Math.floor(planSnapshot.totalCleaningMinutes / 60)}h {planSnapshot.totalCleaningMinutes % 60}m
                </span>
              </div>
              <div style={{ height: '6px', borderRadius: '3px', background: 'rgba(197,197,212,0.2)', overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: '3px',
                  background: 'linear-gradient(90deg, #3b82f6, #6366f1)',
                  width: `${Math.min(100, (planSnapshot.totalCleaningMinutes / (planSnapshot.recommendedHKs * 480)) * 100)}%`,
                }} />
              </div>
            </div>
            {/* Extra counts row */}
            <div style={{ display: 'flex', gap: '24px', fontSize: '13px', color: '#64748b' }}>
              <span><Sparkles size={13} style={{ display: 'inline', verticalAlign: '-2px', marginRight: '3px' }} />{planSnapshot.vacantClean} {lang === 'es' ? 'Listas' : 'Ready'}</span>
              {planSnapshot.ooo > 0 && <span><Ban size={13} style={{ display: 'inline', verticalAlign: '-2px', marginRight: '3px' }} />{planSnapshot.ooo} OOO</span>}
            </div>
          </div>
        ) : totalRooms === 0 ? (
          <div style={{ textAlign: 'center' }}>
            <p style={{ fontSize: '14px', color: '#454652', margin: 0 }}>{t('noRoomDataYet', lang)}</p>
            <p style={{ fontSize: '12px', color: '#94a3b8', margin: '4px 0 0' }}>{t('pmsSync15Min', lang)}</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px', position: 'relative', zIndex: 10 }}>
            {/* CSV caption — Active Checkouts / Stayovers / Staff Needed all
                come from the hourly CSV pull (see scraper/scraper.js
                maybeRunCSVPull). Three visual states, mirroring the PMS
                block below so Maria sees consistent warnings across both
                data sources:
                  • fresh (≤75 min):   grey "CSV updated X:XX" caption
                  • stale (75–180):    amber banner, numbers may lag (1–2
                                       missed hourly pulls, usually transient)
                  • error (>180 min):  red banner, scraper is probably down
                                       (3+ missed pulls — watchdog SMS will
                                       have already fired by this point) */}
            {planSnapshot?.pulledAt && (() => {
              const CSV_STALE_MINUTES = 75;
              const CSV_ERROR_MINUTES = 180;
              // Supabase timestamptz already comes back as a Date via fromSnapshotRow.
              // The old .toDate() fallback was for Firestore Timestamp; no longer needed.
              const csvPulledAt: Date | null =
                planSnapshot.pulledAt instanceof Date
                  ? planSnapshot.pulledAt
                  : typeof planSnapshot.pulledAt === 'string'
                  ? new Date(planSnapshot.pulledAt)
                  : null;
              if (!csvPulledAt) return null;
              const csvMinutesAgo = Math.max(0, Math.round((nowMs - csvPulledAt.getTime()) / 60_000));
              const timeStr = csvPulledAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
              const csvState: 'fresh' | 'stale' | 'error' =
                csvMinutesAgo > CSV_ERROR_MINUTES ? 'error' :
                csvMinutesAgo > CSV_STALE_MINUTES ? 'stale' :
                'fresh';

              if (csvState === 'fresh') {
                return (
                  <p style={{ fontSize: '11px', color: '#94a3b8', margin: 0 }}>
                    {lang === 'es' ? `CSV actualizado ${timeStr}` : `CSV updated ${timeStr}`}
                  </p>
                );
              }

              if (csvState === 'stale') {
                return (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: '8px',
                    padding: '8px 12px', borderRadius: '8px',
                    background: 'rgba(245, 158, 11, 0.12)',
                    border: '1px solid rgba(217, 119, 6, 0.35)',
                    fontSize: '12px', color: '#78350f', fontWeight: 500,
                    maxWidth: '440px', textAlign: 'center',
                  }}>
                    <AlertTriangle size={14} style={{ color: '#b45309', flexShrink: 0 }} />
                    <span>
                      {lang === 'es'
                        ? `CSV antiguo — última actualización ${timeStr} (hace ${csvMinutesAgo} min). Debería actualizarse cada hora.`
                        : `CSV stale — last updated ${timeStr} (${csvMinutesAgo} min ago). Should pull hourly.`}
                    </span>
                  </div>
                );
              }

              // error state — 3+ missed hourly pulls
              return (
                <div style={{
                  display: 'flex', alignItems: 'flex-start', gap: '8px',
                  padding: '8px 12px', borderRadius: '8px',
                  background: 'rgba(220, 38, 38, 0.10)',
                  border: '1px solid rgba(220, 38, 38, 0.35)',
                  fontSize: '12px', color: '#7f1d1d', fontWeight: 500,
                  maxWidth: '440px',
                }}>
                  <AlertTriangle size={14} style={{ color: '#b91c1c', flexShrink: 0, marginTop: '2px' }} />
                  <div style={{ textAlign: 'left' }}>
                    <div>
                      {lang === 'es'
                        ? 'Falla la actualización del CSV. Avísale a Reeyen.'
                        : 'CSV pull failing. Tell Reeyen.'}
                    </div>
                    <div style={{ fontSize: '11px', color: '#991b1b', fontWeight: 400, marginTop: '2px' }}>
                      {lang === 'es'
                        ? `Últimos números buenos a las ${timeStr} (hace ${csvMinutesAgo} min).`
                        : `Last good numbers at ${timeStr} (${csvMinutesAgo} min ago).`}
                    </div>
                  </div>
                </div>
              );
            })()}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, auto)', gap: '40px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <p style={{ fontSize: '14px', color: '#454652', fontWeight: 500, margin: 0 }}>{lang === 'es' ? 'Salidas Activas' : 'Active Checkouts'}</p>
                <p style={{ fontFamily: 'var(--font-mono)', fontSize: '36px', fontWeight: 500, color: '#364262', lineHeight: 1, margin: 0 }}>{checkouts}</p>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <p style={{ fontSize: '14px', color: '#454652', fontWeight: 500, margin: 0 }}>{lang === 'es' ? 'Continuaciones' : 'Stayovers'}</p>
                <p style={{ fontFamily: 'var(--font-mono)', fontSize: '36px', fontWeight: 500, color: '#364262', lineHeight: 1, margin: 0 }}>{stayovers}</p>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <p style={{ fontSize: '14px', color: '#454652', fontWeight: 500, margin: 0 }}>{lang === 'es' ? 'Hab. Bloqueadas' : 'Blocked Rooms'}</p>
                <p style={{ fontFamily: 'var(--font-mono)', fontSize: '36px', fontWeight: 500, color: '#364262', lineHeight: 1, margin: 0 }}>{blockedCount}</p>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <p style={{ fontSize: '14px', color: '#454652', fontWeight: 500, margin: 0 }}>{lang === 'es' ? 'Personal Necesario' : 'Staff Needed'}</p>
                <p style={{ fontFamily: 'var(--font-mono)', fontSize: '36px', fontWeight: 500, color: '#364262', lineHeight: 1, margin: 0 }}>{recommendedStaff}</p>
              </div>
            </div>

          </div>
        )}

        {/* ── Live PMS numbers from Choice Advantage View pages ───────── */}
        {/* Always rendered — regardless of plan-snapshot / active-rooms /  */}
        {/* empty branch above — because these are CURRENT-MOMENT PMS      */}
        {/* numbers and Maria needs them visible on every view of the      */}
        {/* Schedule tab. Pulled every 15 min 5am–11pm by the Railway      */}
        {/* scraper (see scraper/dashboard-pull.js).                        */}
        {/*                                                                  */}
        {/* Three visual states, driven by dashboardFreshness():            */}
        {/*   • fresh:   normal numbers, grey "PMS updated 4:01 PM" caption */}
        {/*   • stale:   numbers greyed out with amber warning banner;      */}
        {/*              Maria can still see them but knows not to trust    */}
        {/*   • error:   numbers replaced with dashes, red banner with      */}
        {/*              actionable text ("Sign in failed — password may   */}
        {/*              have been changed")                                */}
        {/*                                                                  */}
        {/* We deliberately NEVER show a plausible-looking number without   */}
        {/* also telling Maria how stale it is. The whole point of this     */}
        {/* block is that a silently wrong number is worse than no number. */}
        {!predictionLoading && (() => {
          // Historical mode: when the user is looking at a past or future date
          // tab, these numbers came from dashboardByDate/{date} — a frozen
          // end-of-day snapshot, not a live feed. We skip staleness detection
          // (a frozen snapshot can't go "stale"), hide the error banner, and
          // show a "Last updated 10:45 PM on Apr 22" caption instead of the
          // live-refresh one. If we have no snapshot for that date at all,
          // show an empty-state caption rather than dashes-with-no-context.
          const isHistorical = shiftDate !== schedTodayStr();
          const freshness = isHistorical
            ? (dashboardNums ? 'fresh' : 'unknown')
            : dashboardFreshness(dashboardNums, nowMs);
          // Wrap the numbers-or-dashes choice once so it stays consistent
          // across all three columns. 'error' shows dashes unless we have
          // a pulledAt still in-window (then it's degraded to "stale"
          // visually but we already flagged it in the banner).
          const showDashes = freshness === 'error' || freshness === 'unknown';
          const fmt = (n: number | null | undefined) =>
            showDashes ? '—' : (typeof n === 'number' ? n : '—');
          const numColor =
            freshness === 'fresh' ? '#364262' :
            freshness === 'stale' ? '#94a3b8' :
            '#cbd5e1';
          // Build the caption / banner. Shape depends on state.
          const errorCopy = (code: DashboardNumbers['errorCode'], lang: 'en' | 'es'): string => {
            // Actionable human copy per code. Keep short — this shows in a
            // red banner on a phone screen. "What does Maria do next?" is
            // the guiding question for the wording.
            const en: Record<string, string> = {
              login_failed:      'Choice Advantage sign-in failed — password may have been changed. Tell Reeyen.',
              session_expired:   'Lost Choice Advantage session — retrying. Check back in a minute.',
              selector_miss:     'Choice Advantage page layout changed — Reeyen needs to update the scraper.',
              timeout:           'Choice Advantage was slow to respond — retrying in 15 min.',
              parse_error:       'Could not read numbers from Choice Advantage. Tell Reeyen.',
              validation_failed: 'Choice Advantage returned numbers outside the expected range. Tell Reeyen.',
              ca_unreachable:    'Could not reach Choice Advantage. Check the CA website yourself.',
              unknown:           'Something unexpected happened pulling PMS data. Tell Reeyen.',
            };
            const es: Record<string, string> = {
              login_failed:      'Falló el inicio de sesión en Choice Advantage — la contraseña puede haber cambiado. Avísale a Reeyen.',
              session_expired:   'Sesión de Choice Advantage perdida — reintentando. Revisa en un minuto.',
              selector_miss:     'El diseño de Choice Advantage cambió — Reeyen debe actualizar el scraper.',
              timeout:           'Choice Advantage respondió lento — reintentando en 15 min.',
              parse_error:       'No se pudieron leer los números de Choice Advantage. Avísale a Reeyen.',
              validation_failed: 'Choice Advantage devolvió números fuera de rango. Avísale a Reeyen.',
              ca_unreachable:    'No se pudo conectar con Choice Advantage. Revisa el sitio directamente.',
              unknown:           'Ocurrió algo inesperado al obtener los datos del PMS. Avísale a Reeyen.',
            };
            const dict = lang === 'es' ? es : en;
            return dict[code ?? 'unknown'] ?? dict.unknown;
          };
          // Stale caption shows BOTH last-fresh time and minutes-old count so
          // Maria can eyeball "how out of date is this" without doing math.
          const minutesStale = dashboardNums?.pulledAt
            ? Math.max(0, Math.round((nowMs - dashboardNums.pulledAt.getTime()) / 60_000))
            : null;
          return (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', marginTop: '16px', paddingTop: '16px', borderTop: '1px solid rgba(0,0,0,0.08)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, auto)', gap: '40px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'center' }}>
                  <p style={{ fontSize: '14px', color: '#454652', fontWeight: 500, margin: 0 }}>{lang === 'es' ? 'Llegadas' : 'Arrivals'}</p>
                  <p style={{ fontFamily: 'var(--font-mono)', fontSize: '36px', fontWeight: 500, color: numColor, lineHeight: 1, margin: 0 }}>
                    {fmt(dashboardNums?.arrivals)}
                  </p>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'center' }}>
                  <p style={{ fontSize: '14px', color: '#454652', fontWeight: 500, margin: 0 }}>{lang === 'es' ? 'En Casa' : 'In House'}</p>
                  <p style={{ fontFamily: 'var(--font-mono)', fontSize: '36px', fontWeight: 500, color: numColor, lineHeight: 1, margin: 0 }}>
                    {fmt(dashboardNums?.inHouse)}
                  </p>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'center' }}>
                  <p style={{ fontSize: '14px', color: '#454652', fontWeight: 500, margin: 0 }}>{lang === 'es' ? 'Salidas' : 'Departures'}</p>
                  <p style={{ fontFamily: 'var(--font-mono)', fontSize: '36px', fontWeight: 500, color: numColor, lineHeight: 1, margin: 0 }}>
                    {fmt(dashboardNums?.departures)}
                  </p>
                </div>
              </div>
              {/* Status line / banner — one of four variants. On historical
                  tabs the stale/error banners are skipped (a frozen snapshot
                  can't go stale) and the caption shows the snapshot date. */}
              {freshness === 'fresh' && dashboardNums?.pulledAt && (
                <p style={{ fontSize: '11px', color: '#94a3b8', margin: 0 }}>
                  {isHistorical
                    ? `${lang === 'es' ? 'Última actualización' : 'Last updated'} ${dashboardNums.pulledAt.toLocaleDateString(lang === 'es' ? 'es-ES' : 'en-US', { month: 'short', day: 'numeric' })}, ${dashboardNums.pulledAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                    : `${lang === 'es' ? 'PMS actualizado' : 'PMS updated'} ${dashboardNums.pulledAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}
                </p>
              )}
              {freshness === 'stale' && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '8px 12px', borderRadius: '8px',
                  background: 'rgba(245, 158, 11, 0.12)',
                  border: '1px solid rgba(217, 119, 6, 0.35)',
                  fontSize: '12px', color: '#78350f', fontWeight: 500,
                  maxWidth: '440px', textAlign: 'center',
                }}>
                  <AlertTriangle size={14} style={{ color: '#b45309', flexShrink: 0 }} />
                  <span>
                    {lang === 'es'
                      ? `Datos PMS antiguos — última actualización ${dashboardNums?.pulledAt?.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) ?? '—'}${minutesStale !== null ? ` (hace ${minutesStale} min)` : ''}. Verifica Choice Advantage directamente si necesitas números en vivo.`
                      : `PMS data is stale — last updated ${dashboardNums?.pulledAt?.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) ?? '—'}${minutesStale !== null ? ` (${minutesStale} min ago)` : ''}. Should be every ${DASHBOARD_STALE_MINUTES} min max. Check Choice Advantage directly if you need live numbers.`}
                  </span>
                </div>
              )}
              {freshness === 'error' && (
                <div style={{
                  display: 'flex', alignItems: 'flex-start', gap: '8px',
                  padding: '8px 12px', borderRadius: '8px',
                  background: 'rgba(220, 38, 38, 0.10)',
                  border: '1px solid rgba(220, 38, 38, 0.35)',
                  fontSize: '12px', color: '#7f1d1d', fontWeight: 500,
                  maxWidth: '440px',
                }}>
                  <AlertTriangle size={14} style={{ color: '#b91c1c', flexShrink: 0, marginTop: '2px' }} />
                  <div style={{ textAlign: 'left' }}>
                    <div>{errorCopy(dashboardNums?.errorCode ?? 'unknown', lang === 'es' ? 'es' : 'en')}</div>
                    {dashboardNums?.pulledAt && (
                      <div style={{ fontSize: '11px', color: '#991b1b', fontWeight: 400, marginTop: '2px' }}>
                        {lang === 'es'
                          ? `Últimos números buenos a las ${dashboardNums.pulledAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`
                          : `Last good numbers at ${dashboardNums.pulledAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {freshness === 'unknown' && (
                <p style={{ fontSize: '11px', color: '#94a3b8', margin: 0 }}>
                  {isHistorical
                    ? (lang === 'es' ? 'Sin datos guardados para este día.' : 'No saved data for this day.')
                    : (lang === 'es' ? 'Esperando datos de PMS...' : 'Waiting for PMS data...')}
                </p>
              )}

              {/* ── Room-count reconciliation ("hidden rooms" check) ──
                  Maria's 7pm ritual: at 100% occupancy, in-house + arrivals
                  should equal the property's total rooms. If it's GREATER
                  than total, the front desk has over-counted a group booking
                  (e.g. TDCJ books 25 when they only need 18 → 7 rooms get
                  "hidden" and can't be sold). Brandy is the only one with
                  group-booking access, so the action is "tell Brandy".

                  We deliberately do NOT flag the under-count case (sum <
                  total). On a non-fully-booked night that's just empty
                  rooms — totally normal. The under-count-with-hidden-rooms
                  scenario only matters when CA shows 0 available, and we
                  don't scrape that field yet, so we can't distinguish it
                  from "just empty" without false positives.

                  Rendered only when PMS numbers are actually trustworthy —
                  skipped on 'error' and 'unknown' freshness so we don't flag
                  bogus math on stale/missing data. Property totalRooms (74
                  for Comfort Suites Beaumont) is configured in settings.   */}
              {(freshness === 'fresh' || freshness === 'stale')
                && dashboardNums?.inHouse != null
                && dashboardNums?.arrivals != null
                && (activeProperty?.totalRooms ?? 0) > 0
                && (() => {
                  const totalPropertyRooms = activeProperty!.totalRooms;
                  const inHouseNum = dashboardNums!.inHouse as number;
                  const arrivalsNum = dashboardNums!.arrivals as number;
                  const roomSum = inHouseNum + arrivalsNum;
                  const delta = roomSum - totalPropertyRooms;

                  // Fully booked and everything adds up — subtle green ✓
                  // so Maria can see at a glance that the math is clean.
                  if (delta === 0) {
                    return (
                      <p style={{ fontSize: '11px', color: '#15803d', margin: 0, fontWeight: 500 }}>
                        {lang === 'es'
                          ? `✓ Habitaciones cuadran: ${inHouseNum} en casa + ${arrivalsNum} llegadas = ${totalPropertyRooms}`
                          : `✓ Room count matches: ${inHouseNum} in-house + ${arrivalsNum} arrivals = ${totalPropertyRooms}`}
                      </p>
                    );
                  }

                  // Over-count — red. Group booking has extra rooms that
                  // should be released. The scenario Maria catches most
                  // often (e.g. TDCJ booked 25, needs 18).
                  if (delta > 0) {
                    return (
                      <div style={{
                        display: 'flex', alignItems: 'flex-start', gap: '8px',
                        padding: '8px 12px', borderRadius: '8px',
                        background: 'rgba(220, 38, 38, 0.10)',
                        border: '1px solid rgba(220, 38, 38, 0.35)',
                        fontSize: '12px', color: '#7f1d1d', fontWeight: 500,
                        maxWidth: '460px',
                      }}>
                        <AlertTriangle size={14} style={{ color: '#b91c1c', flexShrink: 0, marginTop: '2px' }} />
                        <div style={{ textAlign: 'left' }}>
                          <div>
                            {lang === 'es'
                              ? `Habitaciones no cuadran: ${inHouseNum} en casa + ${arrivalsNum} llegadas = ${roomSum}, pero la propiedad tiene ${totalPropertyRooms}.`
                              : `Room count mismatch: ${inHouseNum} in-house + ${arrivalsNum} arrivals = ${roomSum}, but property has ${totalPropertyRooms}.`}
                          </div>
                          <div style={{ fontSize: '11px', color: '#991b1b', fontWeight: 400, marginTop: '2px' }}>
                            {lang === 'es'
                              ? `${delta} habitación${delta === 1 ? '' : 'es'} de más — pídele a Brandy que revise las reservas de grupos (probablemente reservaron más de lo necesario).`
                              : `${delta} extra room${delta === 1 ? '' : 's'} showing — ask Brandy to check group bookings (likely over-booked).`}
                          </div>
                        </div>
                      </div>
                    );
                  }

                  // Under-count — silent. Empty rooms on a non-busy night
                  // look identical to hidden rooms on a fully-booked night;
                  // we'd need CA's "available" number to distinguish them.
                  return null;
                })()}
            </div>
          );
        })()}
      </section>

      {/* ── Overnight Changes Callout (6am CSV diff vs Maria's saved plan) ── */}
      {!predictionLoading && morningDiff && (
        <section style={{
          display: 'flex', flexDirection: 'column', gap: '12px',
          padding: '16px 18px',
          borderRadius: '16px',
          background: 'linear-gradient(180deg, rgba(255,236,179,0.45) 0%, rgba(255,236,179,0.2) 100%)',
          border: '1px solid rgba(217,119,6,0.25)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Sparkles size={16} style={{ color: '#b45309' }} />
              <h3 style={{ fontSize: '15px', fontWeight: 700, color: '#78350f', margin: 0, letterSpacing: '0.01em' }}>
                {lang === 'es' ? 'Cambios durante la noche' : 'What changed overnight'}
              </h3>
            </div>
            <button
              onClick={handleAutoRecommend}
              disabled={assignableRooms.length === 0 || selectedCrew.length === 0}
              style={{
                padding: '8px 14px', borderRadius: '9999px',
                background: assignableRooms.length === 0 ? '#e5e7eb' : '#364262',
                color: assignableRooms.length === 0 ? '#9ca3af' : '#ffffff',
                border: 'none',
                fontFamily: 'var(--font-sans)', fontSize: '13px', fontWeight: 600,
                cursor: assignableRooms.length === 0 ? 'not-allowed' : 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: '6px',
              }}
            >
              <Sparkles size={13} />
              {lang === 'es' ? 'Recomendación Automática' : 'Auto Recommend'}
            </button>
          </div>

          <p style={{ fontSize: '14px', color: '#57361f', margin: 0, lineHeight: 1.5 }}>
            {morningSummary}
          </p>

          {unassignedRooms.length > 0 && (
            <p style={{ fontSize: '13px', color: '#92400e', margin: 0, lineHeight: 1.4, fontWeight: 500 }}>
              {lang === 'es'
                ? `${unassignedRooms.length} habitación${unassignedRooms.length === 1 ? '' : 'es'} sin asignar — arrastra manualmente o usa Recomendación Automática para repartirlas.`
                : `${unassignedRooms.length} room${unassignedRooms.length === 1 ? '' : 's'} still need a housekeeper — drag them yourself or hit Auto Recommend to split them across the crew.`}
            </p>
          )}
          {unassignedRooms.length === 0 && (
            <p style={{ fontSize: '13px', color: '#065f46', margin: 0, lineHeight: 1.4, fontWeight: 500 }}>
              {lang === 'es'
                ? '✓ Todas las habitaciones están asignadas. Revisa y pulsa Enviar para actualizar a los limpiadores.'
                : '✓ All rooms are covered. Review and hit Send to update the housekeepers.'}
            </p>
          )}
        </section>
      )}

      {/* ── "No overnight changes" confirmation (6am CSV landed, matched Maria's 7pm save) ── */}
      {!predictionLoading && morningConfirmation && (
        <section style={{
          display: 'flex', flexDirection: 'column', gap: '8px',
          padding: '14px 18px',
          borderRadius: '16px',
          background: 'linear-gradient(180deg, rgba(34,197,94,0.12) 0%, rgba(34,197,94,0.04) 100%)',
          border: '1px solid rgba(34,197,94,0.25)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <CheckCircle2 size={16} style={{ color: '#15803d' }} />
            <h3 style={{ fontSize: '15px', fontWeight: 700, color: '#14532d', margin: 0, letterSpacing: '0.01em' }}>
              {lang === 'es' ? 'Sin cambios durante la noche' : 'No overnight changes'}
            </h3>
          </div>
          <p style={{ fontSize: '14px', color: '#166534', margin: 0, lineHeight: 1.5 }}>
            {lang === 'es'
              ? `El PMS se actualizó (${formatPulledAt(morningConfirmation.pulledAt, lang)}) y coincide con lo que guardaste anoche. Tu plan está bien — pulsa Enviar cuando estés lista.`
              : `The PMS refreshed (${formatPulledAt(morningConfirmation.pulledAt, lang)}) and matches what you saved last night. Your plan is good to go — hit Send when you're ready.`}
          </p>
        </section>
      )}

      {/* ── Unassigned Rooms Pool ── */}
      {!predictionLoading && totalRooms > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#364262', margin: 0 }}>
              {lang === 'es' ? 'Habitaciones Sin Asignar' : 'Unassigned Rooms'}
            </h3>
            <span style={{ fontSize: '14px', fontFamily: 'var(--font-mono)', color: '#454652' }}>
              {unassignedRooms.length} {lang === 'es' ? 'Restantes' : 'Rooms Remaining'}
            </span>
          </div>
          <div
            ref={unassignedRef}
            style={{
              display: 'flex', flexWrap: 'wrap', gap: '12px',
              minHeight: '48px',
              padding: unassignedRooms.length === 0 ? '12px' : '0',
              background: dragState?.dropTarget === '__unassigned__' ? 'rgba(54,66,98,0.04)' : 'transparent',
              borderRadius: '16px',
              border: dragState?.dropTarget === '__unassigned__' ? '2px dashed #364262' : '2px dashed transparent',
              transition: 'all 0.15s',
            }}
          >
            {unassignedRooms.length === 0 && totalRooms > 0 && (
              <p style={{ fontSize: '14px', color: '#10b981', fontWeight: 600, margin: 0 }}>
                ✓ {lang === 'es' ? 'Todas asignadas' : 'All rooms assigned'}
              </p>
            )}
            {unassignedRooms.map(room => (
              <button
                key={room.id}
                onPointerDown={e => onPillPointerDown(e, room)}
                onPointerMove={onPillPointerMove}
                onPointerUp={e => { onPillPointerUp(e); }}
                onPointerCancel={onPillPointerCancel}
                className="sched-room-pill"
                style={{
                  width: '42px', height: '48px',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  gap: '1px',
                  borderRadius: '8px', background: '#eae8e3',
                  border: 'none', cursor: 'grab',
                  opacity: dragState?.roomId === room.id ? 0.3 : 1,
                  touchAction: 'none', userSelect: 'none',
                  WebkitUserSelect: 'none', WebkitTouchCallout: 'none',
                }}
              >
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '14px', color: '#364262', lineHeight: 1 }}>{room.number}</span>
                <span style={{ fontSize: '9px', fontWeight: 700, color: room.type === 'checkout' ? '#93000a' : '#757684', lineHeight: 1, textTransform: 'uppercase' }}>
                  {room.type === 'checkout'
                    ? 'C'
                    : (typeof room.stayoverDay === 'number' && room.stayoverDay > 0
                        ? (room.stayoverDay % 2 === 1 ? 'S1' : 'S2')
                        : 'S')}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* ── Active Crew ── */}
      {!predictionLoading && totalRooms > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#364262', margin: 0 }}>
            {lang === 'es' ? 'Equipo Activo' : 'Active Crew'}
          </h3>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {selectedCrew.map((member, idx) => {
              const { rooms: memberRooms, mins } = getStaffWorkload(member.id);
              const hrs = Math.floor(mins / 60);
              const remMins = mins % 60;
              const timeLabel = hrs > 0 ? `${hrs}h ${remMins > 0 ? `${remMins}m` : ''}`.trim() : `${mins}m`;
              const isDropHover = dragState?.dropTarget === member.id && dragState?.roomId && assignments[dragState.roomId] !== member.id;
              const coCount = memberRooms.filter(r => r.type === 'checkout').length;
              const soCount = memberRooms.length - coCount;
              // Three-state capacity gauge so Maria can see at a glance
              // who's stretched. Over cap should be impossible via Auto
              // Assign (hard cap), but can still happen if a room was
              // manually dragged onto someone already at 6h 55m.
              const isOverCap     = mins > shiftLen;
              const isNearCapacity = !isOverCap && mins > shiftLen * 0.85;
              const statusLabel = memberRooms.length === 0
                ? (lang === 'es' ? 'Disponible' : 'Available')
                : isOverCap
                  ? (lang === 'es' ? 'Sobre el límite' : 'Over Cap')
                  : isNearCapacity
                    ? (lang === 'es' ? 'Casi lleno' : 'Near Capacity')
                    : (lang === 'es' ? 'Asignado' : 'Assigned');
              // Over cap = deep red. Near = amber. Assigned = neutral.
              const statusBg = memberRooms.length === 0
                ? '#d3e4f8'
                : isOverCap ? '#ffdad6'
                : isNearCapacity ? '#fef3c7'
                : '#eae8e3';
              const statusColor = memberRooms.length === 0
                ? '#0c1d2b'
                : isOverCap ? '#7f1d1d'
                : isNearCapacity ? '#92400e'
                : '#454652';

              // The badge next to each crew member's name is simple now:
              //   - sent         → "Link Sent" (green)
              //   - skipped      → "Didn't Send — No Phone Number" (red)
              //   - failed       → "Didn't Send — <reason>"         (red)
              // On page reload, a confirmation doc being present is enough
              // to show "Link Sent" even if we don't have a fresh sendResult.
              const confStatus = statusByStaff.get(member.id);
              const sendResult = sendResults.get(member.id);

              const reasonLabel = (reason?: string): string => {
                switch (reason) {
                  case 'no_phone':      return lang === 'es' ? 'Sin teléfono'        : 'No Phone Number';
                  case 'invalid_phone': return lang === 'es' ? 'Teléfono inválido'   : 'Invalid Phone';
                  case 'sms_error':     return lang === 'es' ? 'Error de SMS'        : 'SMS Error';
                  default:              return reason || (lang === 'es' ? 'Error' : 'Error');
                }
              };

              const confBadge =
                (sendResult?.status === 'skipped' || sendResult?.status === 'failed')
                  ? { label: (lang === 'es' ? 'No se envió — ' : "Didn't Send — ") + reasonLabel(sendResult.reason),
                      bg: 'rgba(239,68,68,0.12)', color: '#b91c1c' }
                : (sendResult?.status === 'sent' || confStatus === 'sent' || confStatus === 'pending')
                  ? { label: lang === 'es' ? 'Enlace enviado' : 'Link Sent',
                      bg: 'rgba(16,185,129,0.15)', color: '#059669' }
                : null;

              return (
                <div
                  key={member.id}
                  ref={el => { crewCardRefs.current[member.id] = el; }}
                  data-crew-id={member.id}
                  className="sched-crew-row"
                  style={{
                    background: isDropHover ? 'rgba(54,66,98,0.04)' : 'rgba(255,255,255,0.7)',
                    backdropFilter: 'blur(24px)',
                    border: isDropHover ? '2px solid #364262' : '1px solid rgba(197,197,212,0.2)',
                    borderRadius: '16px',
                    padding: '24px',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    gap: '24px', transition: 'all 0.15s',
                    // Intentionally NOT wrapping: when a heavy crew member had
                    // 19+ pills, the RIGHT block got too wide to fit next to
                    // LEFT and the whole block wrapped down, making the page
                    // look broken. The RIGHT block now uses flex:1 + min-width:0
                    // so pills wrap internally without punting the whole row.
                    // Mobile (<600px) switches to column direction via CSS.
                  }}
                >
                  {/* Left: avatar + info */}
                  <div className="sched-crew-info" style={{ display: 'flex', alignItems: 'center', gap: '24px', flexShrink: 0 }}>
                    <div style={{ position: 'relative' }}>
                      <div style={{
                        width: '64px', height: '64px', borderRadius: '50%',
                        background: 'linear-gradient(135deg, #364262 0%, #4e5a7a 100%)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: '#dae2ff', fontWeight: 700, fontSize: '20px',
                        fontFamily: 'var(--font-sans)',
                      }}>
                        {member.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                      </div>
                      <div style={{
                        position: 'absolute', bottom: 0, right: 0,
                        width: '16px', height: '16px', borderRadius: '50%',
                        background: memberRooms.length === 0
                          ? '#22c55e'
                          : isOverCap ? '#dc2626'
                          : isNearCapacity ? '#f59e0b'
                          : '#0ea5e9',
                        border: '4px solid #fff',
                      }} />
                    </div>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                        <button
                          className="sched-crew-name"
                          onClick={(e) => {
                            const rect = e.currentTarget.getBoundingClientRect();
                            setSwapAnchor({ top: rect.bottom + 4, left: rect.left });
                            setSwapOpenFor(prev => prev === member.id ? null : member.id);
                          }}
                          style={{
                            background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                            fontFamily: 'var(--font-sans)', fontSize: '20px', fontWeight: 700,
                            color: '#1b1c19', textAlign: 'left',
                          }}
                        >
                          {member.name}
                        </button>
                        {/* HK link + copy — fallback channel if SMS ever breaks.
                            `hkUrl` points to /housekeeper/{staffId}?uid=…&pid=…,
                            identical to what the SMS sends. uid/pid are required
                            for the Need Help / Report Issue buttons on the HK page. */}
                        {(() => {
                          const qs = `?uid=${encodeURIComponent(uid)}&pid=${encodeURIComponent(pid)}`;
                          const hkUrl = typeof window !== 'undefined'
                            ? `${window.location.origin}/housekeeper/${member.id}${qs}`
                            : `/housekeeper/${member.id}${qs}`;
                          const isCopied = copiedFor === member.id;
                          return (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <a
                                href={hkUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={lang === 'es' ? 'Abrir página del limpiador' : "Open housekeeper's page"}
                                style={{
                                  display: 'inline-flex', alignItems: 'center', gap: '4px',
                                  padding: '4px 10px', borderRadius: '9999px',
                                  background: 'rgba(54,66,98,0.08)', color: '#364262',
                                  fontFamily: 'var(--font-sans)', fontSize: '11px', fontWeight: 600,
                                  textDecoration: 'none', cursor: 'pointer',
                                  border: '1px solid rgba(54,66,98,0.15)',
                                }}
                              >
                                <Link2 size={12} />
                                {lang === 'es' ? 'Enlace' : 'Link'}
                              </a>
                              <button
                                onClick={async () => {
                                  try {
                                    await navigator.clipboard.writeText(hkUrl);
                                  } catch {
                                    // Fallback for older browsers / non-HTTPS
                                    const ta = document.createElement('textarea');
                                    ta.value = hkUrl;
                                    document.body.appendChild(ta);
                                    ta.select();
                                    try { document.execCommand('copy'); } catch {}
                                    document.body.removeChild(ta);
                                  }
                                  if (copiedTimer.current) clearTimeout(copiedTimer.current);
                                  setCopiedFor(member.id);
                                  copiedTimer.current = setTimeout(() => setCopiedFor(null), 1500);
                                }}
                                title={lang === 'es' ? 'Copiar enlace' : 'Copy link'}
                                style={{
                                  display: 'inline-flex', alignItems: 'center', gap: '4px',
                                  padding: '4px 10px', borderRadius: '9999px',
                                  background: isCopied ? 'rgba(16,185,129,0.15)' : 'rgba(54,66,98,0.08)',
                                  color: isCopied ? '#059669' : '#364262',
                                  fontFamily: 'var(--font-sans)', fontSize: '11px', fontWeight: 600,
                                  cursor: 'pointer',
                                  border: `1px solid ${isCopied ? 'rgba(16,185,129,0.3)' : 'rgba(54,66,98,0.15)'}`,
                                }}
                              >
                                {isCopied ? <Check size={12} /> : <Copy size={12} />}
                                {isCopied
                                  ? (lang === 'es' ? '¡Copiado!' : 'Copied!')
                                  : (lang === 'es' ? 'Copiar' : 'Copy')}
                              </button>
                            </div>
                          );
                        })()}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                        <span style={{
                          padding: '2px 8px', borderRadius: '9999px',
                          background: statusBg, color: statusColor,
                          fontSize: '12px', fontWeight: 600,
                        }}>
                          {statusLabel}
                        </span>
                        {confBadge && (
                          <span style={{
                            padding: '2px 8px', borderRadius: '9999px',
                            background: confBadge.bg, color: confBadge.color,
                            fontSize: '12px', fontWeight: 600,
                          }}>
                            {confBadge.label}
                          </span>
                        )}
                        <button onClick={() => {
                          const roomCount = Object.values(assignments).filter(sid => sid === member.id).length;
                          const msg = lang === 'es'
                            ? `¿Quitar a ${member.name} y desasignar sus ${roomCount} habitaciones?`
                            : `Remove ${member.name} and unassign their ${roomCount} room${roomCount !== 1 ? 's' : ''}?`;
                          if (confirm(msg)) toggleCrewMember(member.id);
                        }} style={{
                          background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-sans)',
                          fontSize: '11px', fontWeight: 600, color: '#ba1a1a', padding: '0',
                          opacity: 0.5,
                        }}>
                          {lang === 'es' ? 'Quitar' : 'Remove'}
                        </button>
                      </div>
                      {/* Checkouts / Stayovers counts live in the LEFT column
                          (below Link / Copy / status) so they stay anchored to
                          the crew member instead of floating around the pill
                          strip and wrapping awkwardly when the pill count is
                          high. */}
                      {memberRooms.length > 0 && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginTop: '6px' }}>
                          <span style={{ fontSize: '12px', fontWeight: 600, color: '#364262', fontFamily: 'var(--font-sans)' }}>
                            {coCount} {lang === 'es' ? 'Salidas' : 'Checkout'}{coCount !== 1 && lang !== 'es' ? 's' : ''}
                          </span>
                          <span style={{ fontSize: '12px', fontWeight: 600, color: '#757684', fontFamily: 'var(--font-sans)' }}>
                            {soCount} {lang === 'es' ? 'Continuaciones' : 'Stayover'}{soCount !== 1 && lang !== 'es' ? 's' : ''}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Right: workload + room tiles. Uses flex:1, min-width:0 so
                      the block shrinks to the remaining space; pills wrap
                      internally rather than punting the whole right block to
                      a new row. */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '24px', flex: '1 1 0', minWidth: 0, justifyContent: 'flex-end' }}>
                    <div className="sched-crew-stats" style={{ textAlign: 'right', flexShrink: 0 }}>
                      <p style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.15em', fontWeight: 700, color: '#454652', margin: '0 0 2px' }}>
                        {lang === 'es' ? 'Carga' : 'Workload'}
                      </p>
                      <p style={{
                        fontFamily: 'var(--font-mono)', fontSize: '20px', fontWeight: 500,
                        color: isOverCap ? '#7f1d1d' : isNearCapacity ? '#b45309' : '#364262',
                        margin: 0,
                      }}>
                        {timeLabel}
                      </p>
                    </div>
                    <div className="sched-crew-pills" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignContent: 'flex-start', flex: '1 1 0', minWidth: 0, justifyContent: 'flex-end' }}>
                      {memberRooms.map(room => (
                        <button
                          key={room.id}
                          onPointerDown={e => onPillPointerDown(e, room)}
                          onPointerMove={onPillPointerMove}
                          onPointerUp={e => { onPillPointerUp(e); }}
                          onPointerCancel={onPillPointerCancel}
                          className="sched-room-pill"
                          style={{
                            width: '42px', height: '48px',
                            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                            gap: '1px',
                            borderRadius: '8px', background: '#eae8e3',
                            border: 'none', cursor: 'grab',
                            opacity: dragState?.roomId === room.id ? 0.3 : 1,
                            touchAction: 'none', userSelect: 'none',
                            WebkitUserSelect: 'none', WebkitTouchCallout: 'none',
                          }}
                        >
                          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '14px', color: '#364262', lineHeight: 1 }}>{room.number}</span>
                          <span style={{ fontSize: '9px', fontWeight: 700, color: room.type === 'checkout' ? '#93000a' : '#757684', lineHeight: 1, textTransform: 'uppercase' }}>
                            {room.type === 'checkout'
                              ? 'C'
                              : (typeof room.stayoverDay === 'number' && room.stayoverDay > 0
                                  ? (room.stayoverDay % 2 === 1 ? 'S1' : 'S2')
                                  : 'S')}
                          </span>
                        </button>
                      ))}
                      {/* Add room button */}
                      <button
                        onClick={(e) => { e.stopPropagation(); }}
                        style={{
                          width: '40px', height: '40px',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          borderRadius: '8px', border: '2px dashed rgba(197,197,212,0.5)',
                          background: 'transparent', color: '#757684', cursor: 'default',
                        }}
                      >
                        <Plus size={16} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Add staff + Priority row + Send Confirmations centered on same line.
              Tighter gap (10px, uniform) on the left cluster so there's room
              for the Send Confirmations cluster to sit absolutely centered
              without colliding with Unassign All. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', position: 'relative', minHeight: '48px' }}>
            {eligiblePool.filter(s => !selectedCrew.find(c => c.id === s.id)).length > 0 && (
              <button onClick={() => setShowAddStaff(true)} style={{
                padding: '10px 20px', background: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(24px)',
                border: '1px solid rgba(197,197,212,0.2)', borderRadius: '12px',
                cursor: 'pointer', fontFamily: 'var(--font-sans)',
                display: 'flex', alignItems: 'center', gap: '8px',
                fontSize: '14px', fontWeight: 600, color: '#454652',
              }}>
                <Plus size={16} />
                {lang === 'es' ? 'Agregar personal' : 'Add Staff'}
              </button>
            )}
            <button onClick={() => setShowPrioritySettings(true)} style={{
              padding: '10px 20px', background: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(24px)',
              border: '1px solid rgba(197,197,212,0.2)', borderRadius: '12px',
              cursor: 'pointer', fontFamily: 'var(--font-sans)',
              display: 'flex', alignItems: 'center', gap: '8px',
              fontSize: '14px', fontWeight: 600, color: '#454652',
            }}>
              <Settings size={16} />
              {lang === 'es' ? 'Prioridad' : 'Priority'}
            </button>

            {/* Auto Assign — clean-slate redistribute. Wipes every dirty
                room's assignment and rebuilds from zero under the 7h hard
                cap, preserving in-progress rooms and Maria's pinned
                drags. Enabled whenever there are ANY assignable rooms
                (not just unassigned) — the whole point is to let Maria
                click this when a bad distribution needs to be rebuilt
                (e.g. someone over cap after a stale save). Only
                disabled when there's literally nothing to distribute or
                nobody to distribute to. */}
            {(() => {
              const canStaff = selectedCrew.length > 0 || eligiblePool.length > 0;
              const disabled = assignableRooms.length === 0 || !canStaff;
              return (
                <button
                  onClick={handleAutoRecommend}
                  disabled={disabled}
                  title={
                    disabled
                      ? (assignableRooms.length === 0
                          ? (lang === 'es' ? 'No hay habitaciones para asignar' : 'No rooms to assign')
                          : (lang === 'es' ? 'No hay personal elegible' : 'No eligible staff'))
                      : (lang === 'es'
                          ? 'Reconstruye la distribución desde cero respetando el límite de 7h'
                          : 'Rebuild distribution from scratch under the 7h cap')
                  }
                  style={{
                    padding: '10px 20px',
                    background: disabled ? 'rgba(229,231,235,0.6)' : 'rgba(255,255,255,0.7)',
                    backdropFilter: 'blur(24px)',
                    border: '1px solid rgba(197,197,212,0.2)', borderRadius: '12px',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    fontFamily: 'var(--font-sans)',
                    display: 'flex', alignItems: 'center', gap: '8px',
                    fontSize: '14px', fontWeight: 600,
                    color: disabled ? '#9ca3af' : '#454652',
                    opacity: disabled ? 0.7 : 1,
                  }}
                >
                  <Sparkles size={16} />
                  {lang === 'es' ? 'Asignación Automática' : 'Auto Assign'}
                  {unassignedRooms.length > 0 && (
                    <span style={{
                      padding: '1px 7px', borderRadius: '9999px',
                      background: '#364262', color: '#ffffff',
                      fontSize: '11px', fontWeight: 700,
                    }}>
                      {unassignedRooms.length}
                    </span>
                  )}
                </button>
              );
            })()}

            {/* Unassign All — clears every room assignment so the whole pool
                goes back to Unassigned. Useful when the distribution is off
                (one person overloaded, another idle) and Maria wants to reset
                and let Auto Assign rebuild from scratch. Confirms first since
                it wipes local state. */}
            {(() => {
              const assignedCount = Object.keys(assignments).length;
              const disabled = assignedCount === 0;
              return (
                <button
                  onClick={() => {
                    const msg = lang === 'es'
                      ? `¿Quitar la asignación de las ${assignedCount} habitaciones? Todas regresarán al grupo "Sin asignar".`
                      : `Unassign all ${assignedCount} room${assignedCount === 1 ? '' : 's'}? Every room will go back to the Unassigned pool.`;
                    if (!confirm(msg)) return;
                    setAssignments({});
                    // IMPORTANT: do NOT reset hasInitialAssign here. The
                    // initial-auto-assign effect keys off that flag, and if we
                    // flip it back to false, the next crew change (e.g. Maria
                    // clicking Add Staff) will silently re-run the full
                    // auto-assignment. Unassign All should leave the pool
                    // empty and stay empty until the user explicitly hits
                    // Auto Assign — nothing should redistribute on its own.
                    showMoveToast(lang === 'es' ? 'Todas las habitaciones sin asignar' : 'All rooms unassigned');
                  }}
                  disabled={disabled}
                  title={
                    disabled
                      ? (lang === 'es' ? 'No hay habitaciones asignadas' : 'No rooms to unassign')
                      : (lang === 'es' ? 'Desasigna todas las habitaciones' : 'Clear every room assignment')
                  }
                  style={{
                    padding: '10px 20px',
                    background: disabled ? 'rgba(229,231,235,0.6)' : 'rgba(255,255,255,0.7)',
                    backdropFilter: 'blur(24px)',
                    border: '1px solid rgba(197,197,212,0.2)', borderRadius: '12px',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    fontFamily: 'var(--font-sans)',
                    display: 'flex', alignItems: 'center', gap: '8px',
                    fontSize: '14px', fontWeight: 600,
                    color: disabled ? '#9ca3af' : '#ba1a1a',
                    opacity: disabled ? 0.7 : 1,
                  }}
                >
                  <Ban size={16} />
                  {lang === 'es' ? 'Desasignar Todo' : 'Unassign All'}
                  {assignedCount > 0 && (
                    <span style={{
                      padding: '1px 7px', borderRadius: '9999px',
                      background: '#ba1a1a', color: '#ffffff',
                      fontSize: '11px', fontWeight: 700,
                    }}>
                      {assignedCount}
                    </span>
                  )}
                </button>
              );
            })()}

            {/* Send Links — absolutely centered on the same line.
                The left cluster uses a tight 10px gap so there's breathing
                room around this centered block. Before the first send:
                primary "Send Links" button. After: status pill +
                the SAME "Send Links" button so Maria can re-send
                assignments at any time without us calling it something
                different. "Send Updates" / "Send Confirmations" as concepts
                are gone — it's one action, and you can do it as many times
                as you want. Maria confirms availability in person at 3pm,
                so the SMS is just the link to their list. */}
            {!alreadySent && selectedCrew.length > 0 && (
              <button onClick={(e) => { e.stopPropagation(); handleSend(); }} disabled={sending} style={{
                position: 'absolute', left: '50%', transform: 'translateX(-50%)',
                padding: '14px 24px', background: '#006565', color: '#82e2e1',
                borderRadius: '9999px', fontWeight: 600, fontSize: '14px',
                border: 'none', cursor: sending ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', gap: '10px',
                boxShadow: '0 10px 30px -10px rgba(0,101,101,0.3)',
                opacity: sending ? 0.7 : 1,
                fontFamily: 'var(--font-sans)',
                overflow: 'hidden',
              }}>
                <Zap size={18} />
                {sending ? (lang === 'es' ? 'Enviando…' : 'Sending…') : (lang === 'es' ? 'Enviar Enlaces' : 'Send Links')}
              </button>
            )}
            {alreadySent && (
              <div style={{
                position: 'absolute', left: '50%', transform: 'translateX(-50%)',
                display: 'flex', alignItems: 'center', gap: '10px',
                whiteSpace: 'nowrap',
              }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '12px',
                  padding: '10px 20px',
                  background: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(24px)',
                  border: '1px solid rgba(197,197,212,0.3)', borderRadius: '9999px',
                  fontSize: '13px', fontWeight: 600, color: '#454652',
                }}>
                  <CheckCircle2 size={16} color="#10b981" />
                  <span style={{ color: '#10b981' }}>
                    {lang === 'es' ? 'Enlaces enviados' : 'Links sent'}
                  </span>
                </div>
                {selectedCrew.length > 0 && (
                  <button onClick={(e) => { e.stopPropagation(); handleSend(); }} disabled={sending} style={{
                    padding: '10px 16px', background: '#006565', color: '#82e2e1',
                    borderRadius: '9999px', fontWeight: 600, fontSize: '13px',
                    border: 'none', cursor: sending ? 'not-allowed' : 'pointer',
                    display: 'flex', alignItems: 'center', gap: '6px',
                    boxShadow: '0 8px 20px -10px rgba(0,101,101,0.3)',
                    opacity: sending ? 0.7 : 1,
                    fontFamily: 'var(--font-sans)',
                    whiteSpace: 'nowrap',
                  }}>
                    <Zap size={14} />
                    {sending
                      ? (lang === 'es' ? 'Enviando…' : 'Sending…')
                      : (lang === 'es' ? 'Enviar Enlaces' : 'Send Links')}
                  </button>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── Move toast ── */}
      {moveToast && (
        <div style={{
          position: 'fixed', bottom: '100px', left: '50%', transform: 'translateX(-50%)', zIndex: 10000,
          background: '#364262', color: '#fff', padding: '12px 24px', borderRadius: '12px',
          fontSize: '14px', fontWeight: 600, boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
          animation: 'toastIn 0.2s ease-out', whiteSpace: 'nowrap',
        }}>
          {moveToast}
        </div>
      )}
      <style>{`@keyframes toastIn { from { transform: translateX(-50%) translateY(10px); opacity: 0; } to { transform: translateX(-50%) translateY(0); opacity: 1; } }`}</style>

      {/* ── Swap dropdown ── */}
      {swapOpenFor && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 9990 }} onClick={() => setSwapOpenFor(null)} />
          <div style={{
            position: 'fixed', top: swapAnchor.top, left: swapAnchor.left, zIndex: 9991,
            background: '#fff', border: '1px solid rgba(197,197,212,0.2)', borderRadius: '12px',
            boxShadow: '0 8px 30px rgba(0,0,0,0.12)', padding: '4px', minWidth: '180px',
            backdropFilter: 'blur(24px)',
          }}>
            {eligiblePool.filter(s => !selectedCrew.find(c => c.id === s.id)).map(s => (
              <button key={s.id} onClick={() => {
                const oldId = swapOpenFor!;
                setAssignments(a => {
                  const updated = { ...a };
                  for (const [roomId, staffId] of Object.entries(updated)) {
                    if (staffId === oldId) updated[roomId] = s.id;
                  }
                  return updated;
                });
                setCrewOverride(prev => {
                  const current = prev.length > 0 ? prev : selectedCrew.map(c => c.id);
                  return current.map(id => id === oldId ? s.id : id);
                });
                const oldName = selectedCrew.find(c => c.id === oldId)?.name ?? '?';
                showMoveToast(lang === 'es' ? `${oldName} reemplazado por ${s.name}` : `Replaced ${oldName} with ${s.name}`);
                setSwapOpenFor(null);
              }} style={{
                display: 'block', width: '100%', padding: '10px 14px', border: 'none', borderRadius: '8px',
                background: 'transparent', cursor: 'pointer', fontFamily: 'var(--font-sans)',
                fontSize: '14px', fontWeight: 600, color: '#1b1c19', textAlign: 'left',
              }}
                onMouseEnter={e => { (e.target as HTMLElement).style.background = '#f5f3ee'; }}
                onMouseLeave={e => { (e.target as HTMLElement).style.background = 'transparent'; }}
              >
                {s.name}
              </button>
            ))}
            {eligiblePool.filter(s => !selectedCrew.find(c => c.id === s.id)).length === 0 && (
              <div style={{ padding: '10px 14px', fontSize: '13px', color: '#454652' }}>
                {lang === 'es' ? 'Sin personal disponible' : 'No available staff'}
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Staff Priority Settings popup ── */}
      {showPrioritySettings && uid && pid && (
        <>
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9997 }} onClick={() => setShowPrioritySettings(false)} />
          <div style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 9998,
            background: '#fff', borderRadius: '16px', padding: '24px',
            boxShadow: '0 8px 40px rgba(0,0,0,0.2)', width: '380px', maxHeight: '80vh', overflowY: 'auto',
            animation: 'popIn 0.15s ease-out',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <p style={{ fontSize: '18px', fontWeight: 700, color: '#1b1c19', margin: 0 }}>
                {lang === 'es' ? 'Prioridad del Personal' : 'Staff Priority'}
              </p>
              <button onClick={() => setShowPrioritySettings(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px', color: '#454652' }} aria-label="Close">✕</button>
            </div>
            <div style={{ display: 'flex', gap: '6px', marginBottom: '14px', fontSize: '12px', color: '#454652' }}>
              <span style={{ padding: '4px 10px', background: '#d3e4f8', color: '#0c1d2b', borderRadius: '8px', fontWeight: 600 }}>{lang === 'es' ? 'Prioridad' : 'Priority'}</span>
              <span style={{ display: 'flex', alignItems: 'center' }}>{lang === 'es' ? '= primera selección' : '= picked first'}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {staff.filter(s => s.isActive !== false && (s.department === 'housekeeping' || !s.department)).map(s => {
                const pri = s.schedulePriority ?? 'normal';
                return (
                  <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 14px', background: '#f5f3ee', borderRadius: '12px' }}>
                    <span style={{ flex: 1, fontSize: '14px', fontWeight: 600, color: '#1b1c19' }}>{s.name}</span>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      {(['priority', 'normal', 'excluded'] as const).map(level => (
                        <button key={level} onClick={async () => {
                          await updateStaffMember(uid!, pid!, s.id, { schedulePriority: level } as Partial<StaffMember>);
                        }} style={{
                          padding: '4px 10px', borderRadius: '8px', border: 'none', cursor: 'pointer',
                          fontFamily: 'var(--font-sans)', fontSize: '12px', fontWeight: 600,
                          background: pri === level
                            ? level === 'priority' ? '#d3e4f8' : level === 'normal' ? '#eae8e3' : '#ffdad6'
                            : 'transparent',
                          color: pri === level
                            ? level === 'priority' ? '#0c1d2b' : level === 'normal' ? '#454652' : '#93000a'
                            : '#757684',
                        }}>
                          {level === 'priority' ? (lang === 'es' ? 'Prior.' : 'Priority') : level === 'normal' ? 'Normal' : (lang === 'es' ? 'Excluir' : 'Exclude')}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            <p style={{ fontSize: '12px', color: '#757684', margin: '16px 0 0', lineHeight: 1.5 }}>
              {lang === 'es'
                ? 'Prioridad = seleccionado automáticamente primero. Normal = respaldo. Excluir = nunca seleccionado automáticamente.'
                : 'Priority = auto-selected first. Normal = backup when needed. Exclude = never auto-selected.'}
            </p>
          </div>
          <style>{`@keyframes popIn { from { transform: translate(-50%, -50%) scale(0.9); opacity: 0; } to { transform: translate(-50%, -50%) scale(1); opacity: 1; } }`}</style>
        </>
      )}

      {/* ── Add Staff popup ── */}
      {showAddStaff && (
        <>
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9997 }} onClick={() => setShowAddStaff(false)} />
          <div style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 9998,
            background: '#fff', borderRadius: '16px',
            boxShadow: '0 8px 40px rgba(0,0,0,0.2)',
            padding: '24px', width: '520px', maxWidth: 'calc(100vw - 40px)', maxHeight: '70vh', overflowY: 'auto',
            animation: 'popIn 0.15s ease-out',
          }}>
            <p style={{ fontSize: '18px', fontWeight: 700, color: '#1b1c19', margin: '0 0 16px' }}>
              {lang === 'es' ? 'Agregar Personal' : 'Add Staff'}
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px' }}>
              {eligiblePool.filter(s => !selectedCrew.find(c => c.id === s.id)).map(member => (
                <button key={member.id} onClick={() => { toggleCrewMember(member.id); setShowAddStaff(false); }} style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px',
                  padding: '16px 8px', background: '#f5f3ee', border: '1px solid rgba(197,197,212,0.2)',
                  borderRadius: '16px', cursor: 'pointer', fontFamily: 'var(--font-sans)',
                }}>
                  <div style={{
                    width: '48px', height: '48px', borderRadius: '50%',
                    background: 'linear-gradient(135deg, #364262 0%, #4e5a7a 100%)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: '#dae2ff', fontWeight: 700, fontSize: '16px',
                  }}>
                    {member.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                  </div>
                  <span style={{ fontSize: '13px', fontWeight: 600, color: '#1b1c19', textAlign: 'center', lineHeight: 1.2 }}>
                    {member.name}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <style>{`@keyframes popIn { from { transform: translate(-50%, -50%) scale(0.9); opacity: 0; } to { transform: translate(-50%, -50%) scale(1); opacity: 1; } }`}</style>
        </>
      )}

      {/* Prediction Settings Modal */}
      {showPredictionSettings && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }} onClick={() => setShowPredictionSettings(false)}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: '16px', padding: '28px', width: '100%', maxWidth: '400px', boxShadow: '0 20px 60px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div>
              <p style={{ fontWeight: 700, fontSize: '18px', color: '#1b1c19', margin: 0 }}>
                {lang === 'es' ? 'Ajustes de Predicción' : 'Prediction Settings'}
              </p>
              <p style={{ fontSize: '13px', color: '#757684', margin: '6px 0 0' }}>
                {lang === 'es' ? 'Ajusta los tiempos de limpieza.' : 'Adjust cleaning times.'}
              </p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* Max hours per housekeeper — shown in hours for readability,
                  stored as minutes on the property doc (shiftMinutes). This
                  is the cap Auto Assign respects when deciding whether it
                  needs to pull in more crew. */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <span style={{ fontSize: '14px', fontWeight: 500, color: '#1b1c19' }}>
                    {lang === 'es' ? 'Horas máx. por limpiador' : 'Max hours per housekeeper'}
                  </span>
                  <span style={{ fontSize: '11px', color: '#9a9baa', marginTop: '2px' }}>
                    {lang === 'es' ? 'Tope diario por persona' : 'Daily cap per person'}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={24}
                    step={0.25}
                    value={(settingsForm.shiftMinutes / 60).toString()}
                    onChange={e => {
                      const hrs = Number(e.target.value);
                      if (isNaN(hrs) || hrs <= 0) return;
                      setSettingsForm(p => ({ ...p, shiftMinutes: Math.round(hrs * 60) }));
                    }}
                    style={{ width: '64px', textAlign: 'center', padding: '8px 4px' }}
                  />
                  <span style={{ fontSize: '13px', color: '#757684' }}>hr</span>
                </div>
              </div>
              {[
                {
                  label: lang === 'es' ? 'Habitación de salida' : 'Checkout room',
                  sub: lang === 'es' ? 'Limpieza completa al salir' : 'Full clean at check-out',
                  key: 'checkoutMinutes' as const,
                },
                {
                  label: lang === 'es' ? 'Continuación — Día 1' : 'Stayover — Day 1',
                  sub: lang === 'es' ? 'Limpieza ligera (sin cambio de sábanas)' : 'Light clean (no bed change)',
                  key: 'stayoverDay1Minutes' as const,
                },
                {
                  label: lang === 'es' ? 'Continuación — Día 2' : 'Stayover — Day 2',
                  sub: lang === 'es' ? 'Limpieza completa (cambio de sábanas)' : 'Full clean (bed change)',
                  key: 'stayoverDay2Minutes' as const,
                },
                {
                  label: lang === 'es' ? 'Entre habitaciones' : 'Between rooms',
                  sub: lang === 'es' ? 'Tiempo de preparación por hab.' : 'Prep/transition time',
                  key: 'prepMinutesPerActivity' as const,
                },
              ].map(({ label, sub, key }) => (
                <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <span style={{ fontSize: '14px', fontWeight: 500, color: '#1b1c19' }}>{label}</span>
                    <span style={{ fontSize: '11px', color: '#9a9baa', marginTop: '2px' }}>{sub}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                    <input className="input" type="number" min={key === 'prepMinutesPerActivity' ? 0 : 1} value={settingsForm[key]} onChange={e => setSettingsForm(p => ({ ...p, [key]: Number(e.target.value) || 0 }))} style={{ width: '64px', textAlign: 'center', padding: '8px 4px' }} />
                    <span style={{ fontSize: '13px', color: '#757684' }}>min</span>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
              <button onClick={() => setShowPredictionSettings(false)} style={{ flex: 1, padding: '12px', borderRadius: '12px', border: '1px solid rgba(197,197,212,0.2)', background: '#fff', color: '#454652', fontWeight: 600, fontSize: '14px', cursor: 'pointer' }}>{t('cancel', lang)}</button>
              <button onClick={handleSaveSettings} disabled={savingSettings} style={{ flex: 1, padding: '12px', borderRadius: '12px', border: 'none', background: '#364262', color: '#fff', fontWeight: 600, fontSize: '14px', cursor: 'pointer', opacity: savingSettings ? 0.6 : 1 }}>{savingSettings ? t('saving', lang) : t('save', lang)}</button>
            </div>
            <button onClick={() => { setShowPredictionSettings(false); setShowPublicAreas(true); }} style={{
              width: '100%', padding: '16px', marginTop: '4px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              background: '#f5f3ee', border: '1px solid rgba(197,197,212,0.2)', borderRadius: '12px',
              cursor: 'pointer', fontFamily: 'var(--font-sans)',
            }}>
              <span style={{ fontSize: '14px', fontWeight: 600, color: '#1b1c19' }}>{lang === 'es' ? 'Áreas Comunes' : 'Public Areas'}</span>
              <span style={{ fontSize: '12px', color: '#757684' }}>{areasDueToday.length} {lang === 'es' ? 'para hoy' : 'due today'} · {publicAreaMinutes}m →</span>
            </button>
          </div>
        </div>
      )}

      <PublicAreasModal show={showPublicAreas} onClose={() => setShowPublicAreas(false)} />

      {/* Drag ghost — floating room pill that follows your finger */}
      {dragState && (
        <div style={{
          position: 'fixed',
          left: dragState.ghost.x - 28,
          top: dragState.ghost.y - 40,
          zIndex: 10000,
          pointerEvents: 'none',
          padding: '8px 14px',
          background: '#364262',
          border: '2px solid rgba(255,255,255,0.5)',
          borderRadius: '10px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
          transform: 'scale(1.15)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1,
        }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '14px', color: '#fff' }}>{dragState.roomNumber}</span>
          <span style={{ fontSize: '9px', fontWeight: 700, color: 'rgba(255,255,255,0.6)' }}>
            {dragState.roomType === 'checkout'
              ? 'C'
              : (typeof dragState.stayoverDay === 'number' && dragState.stayoverDay > 0
                  ? (dragState.stayoverDay % 2 === 1 ? 'S1' : 'S2')
                  : 'S')}
          </span>
        </div>
      )}

      {/* ── Glass Metrics Footer ── */}
      {!predictionLoading && totalRooms > 0 && (
        <footer style={{
          position: 'fixed', bottom: 0, left: 0, width: '100%', zIndex: 50,
          padding: '16px 24px',
        }}>
          <div style={{
            maxWidth: '768px', margin: '0 auto',
            background: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(24px) saturate(200%)',
            border: '1px solid rgba(197,197,212,0.2)',
            borderRadius: '9999px', padding: '16px 40px',
            boxShadow: '0 20px 60px rgba(0,0,0,0.08)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-around',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <BedDouble size={18} color="#364262" />
              <span style={{ fontSize: '14px', fontWeight: 600, letterSpacing: '0.02em', color: '#454652' }}>{lang === 'es' ? 'Ocupación' : 'Occupancy'}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '18px', fontWeight: 700, color: '#364262' }}>
                {totalRooms > 0 ? Math.round((totalRooms / (activeProperty?.totalRooms ?? totalRooms)) * 100) : 0}%
              </span>
            </div>
            <div style={{ height: '24px', width: '1px', background: 'rgba(197,197,212,0.3)' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <AlertTriangle size={18} color="#ba1a1a" />
              <span style={{ fontSize: '14px', fontWeight: 600, letterSpacing: '0.02em', color: '#454652' }}>{lang === 'es' ? 'Sin Asignar' : 'Unassigned'}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '18px', fontWeight: 700, color: unassignedRooms.length > 0 ? '#ba1a1a' : '#10b981' }}>
                {unassignedRooms.length}
              </span>
            </div>
            <div style={{ height: '24px', width: '1px', background: 'rgba(197,197,212,0.3)' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <Clock size={18} color="#006565" />
              <span style={{ fontSize: '14px', fontWeight: 600, letterSpacing: '0.02em', color: '#454652' }}>{lang === 'es' ? 'Est. Total' : 'Est. Labor'}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '18px', fontWeight: 700, color: '#364262' }}>
                {fmtMins(workloadMinutes)}
              </span>
            </div>
          </div>
        </footer>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ROOMS SECTION (live room status)
// ══════════════════════════════════════════════════════════════════════════════


export { ScheduleTab };
