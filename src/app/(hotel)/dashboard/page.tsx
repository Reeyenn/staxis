'use client';

// ════════════════════════════════════════════════════════════════════
// Owner dashboard — "Staxis · Today".
//
// 1:1 port of the Claude Design "Staxis Today" handoff
// (claude.ai/design → project "Staxis wearebrand", file today.jsx).
// Signature: the occupancy figure IS the property — a ring of room-ticks,
// each lit by its live status; hover a room to read its number + status.
// Beside it, a metric chart with a Play-through animation and a
// 30D / 6M / 1Y / All range toggle; a clickable KPI strip re-charts any
// headline; a month-to-date footer.
//
// Restyled for the Concourse shell: transparent root over the app-wide
// radial wash, Geist display type (no serif/italic), Concourse ink/sage/
// amber/rust palette. Kept from the live app: the global navigation shell.
// The ring is wired to live Supabase data. The chart series is the same
// deterministic seam as before (see today-series.ts) — every range + Play
// works today and turns fully real once daily history is stored.
// ════════════════════════════════════════════════════════════════════

export const dynamic = 'force-dynamic';

import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useSectionEnabled } from '@/lib/sections/useSectionEnabled';
import { shouldResumeOnboarding, RESUME_GUARD_KEY } from '@/lib/onboarding/state';
import { C, SANS, MONO, LABEL, RING, STATUS_EN, type RingKey } from '@/app/dashboard/_components/palette';
import { holdLastGoodCounts, occupancyPctFromCounts } from '@/app/dashboard/_components/counts-hold';
import {
  beginScopedFeed,
  emptyScopedFeed,
  failScopedFeed,
  publishScopedFeed,
  scopedFeedView,
} from '@/app/dashboard/_components/operational-feed-state';
import { RoomRing, type RingTick } from '@/app/dashboard/_components/RoomRing';
import { buildRoomRingTicks } from '@/app/dashboard/_components/room-ring-model';
import { MetricChart } from '@/app/dashboard/_components/MetricChart';
import { Sparkline } from '@/app/dashboard/_components/Sparkline';
import { MemoryRecapCard } from '@/app/dashboard/_components/MemoryRecapCard';
import { LogBookCard } from '@/app/dashboard/_components/LogBookCard';
import { CalendarCard } from '@/app/dashboard/_components/CalendarCard';
import { subscribeToRooms } from '@/lib/db';
import { fetchTodayPropertyCounts, type TodayPropertyCounts } from '@/lib/db/today-room-work';
import { useTodayStr } from '@/lib/use-today-str';
import { useFeedStatus } from '@/lib/use-feed-status';
import { useAsOfLabel } from '@/lib/use-as-of-label';
import { FeedAsOfLabel } from '@/components/FeedAsOfLabel';
import type { Room } from '@/types';
import { RouteErrorState, RouteLoadingState } from '@/components/layout/RouteResourceState';
import { useReliableNavigation } from '@/lib/hooks/use-reliable-navigation';
import {
  RANGES, METRIC_DEFS, buildHistory, seriesFor,
  fmtMoney, fmtCompact, fmtVal,
  type TodayMetricKey, type HistRow,
} from '@/lib/dashboard/today-series';

// Palette / fonts / ring status maps live in ./_components/palette.ts;
// RoomRing, MetricChart and Sparkline are pure moves into their own files.

// Shared easing for the page's interaction transitions (pills, KPI cells,
// play button) — Concourse spring curve.
const SPRING = 'cubic-bezier(.22,1,.36,1)';

// ─── tween a row of numbers smoothly toward target (scrub / playback) ──
function useTweenRow(target: Record<string, number>): Record<string, number> {
  const targetRef = useRef(target);
  targetRef.current = target;
  const keysRef = useRef(Object.keys(target));
  // Render settled on mount (no count-up-from-zero) — the tween only smooths
  // subsequent target changes (hover-scrub / playback).
  const [disp, setDisp] = useState<Record<string, number>>(() => {
    const o: Record<string, number> = {};
    keysRef.current.forEach(k => { o[k] = target[k] ?? 0; });
    return o;
  });
  const cur = useRef(disp);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const t = targetRef.current, c = cur.current;
      const o: Record<string, number> = {};
      let moving = false;
      keysRef.current.forEach(k => {
        const d = (t[k] ?? 0) - (c[k] ?? 0);
        if (Math.abs(d) < 0.4) o[k] = t[k] ?? 0;
        else { o[k] = (c[k] ?? 0) + d * 0.14; moving = true; }
      });
      cur.current = o;
      if (moving) setDisp(o);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    // Fallback: rAF is throttled in hidden/background tabs, which would freeze
    // the count-up mid-way. Snap to the target after a beat so the numbers are
    // always correct once the tab is actually viewed.
    const settle = setTimeout(() => {
      const t = { ...targetRef.current };
      cur.current = t;
      setDisp(t);
    }, 1500);
    return () => { cancelAnimationFrame(raf); clearTimeout(settle); };
  }, []);
  return disp;
}

// ─── Delta badge ──────────────────────────────────────────────────────
function Delta({ v, size = 12 }: { v: number; size?: number }) {
  const up = v >= 0;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontFamily: MONO, fontSize: size, fontWeight: 600, color: up ? C.green : C.rust }}>
      <svg width={size * 0.7} height={size * 0.7} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth={1.8}
        strokeLinecap="round" strokeLinejoin="round" style={{ transform: up ? 'none' : 'scaleY(-1)' }}>
        <path d="M5 8V2M5 2L2 5M5 2l3 3" />
      </svg>
      {Math.abs(v)}%
    </span>
  );
}

// ─── page ─────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const { activePropertyId } = useProperty();
  // Room hover/playback, selected metrics, cached snapshots and subscriptions
  // all belong to one hotel. A property-keyed workspace makes the switch
  // atomic: no Hotel A interaction state can survive beneath Hotel B's name.
  return <DashboardWorkspace key={activePropertyId ?? 'no-property'} />;
}

function DashboardWorkspace() {
  const { user, loading: authLoading } = useAuth();
  const { activeProperty, activePropertyId, loading: propLoading } = useProperty();
  const { push, replace } = useReliableNavigation();
  // The business day belongs to the hotel, not to the app's default city and
  // not to the viewer's laptop. Everything on this page (the counts read, the
  // rooms subscription and the heading below) must name the same hotel-local
  // day, or a Florida hotel opened from Texas rolls over at the wrong hour.
  const today = useTodayStr(activeProperty?.timezone || undefined);

  // Per-hotel section gates default ON while the property loads.
  const financialsEnabled = useSectionEnabled('financials');

  useEffect(() => {
    if (authLoading || propLoading) return;
    if (!user) { replace('/signin'); return; }
    if (!activePropertyId) { replace('/property-selector'); return; }
    // Backstop for the login-funnel gate: if anything lands a mid-onboarding
    // owner on the dashboard (their hotel has no PMS and an empty board),
    // send them back into the wizard to finish. Legacy/complete hotels have
    // no accountCreatedAt → never gated, so normal login is untouched. Admins
    // are never gated (they manage hotels, not own the signup). One-shot via
    // RESUME_GUARD_KEY so a failed resume degrades here instead of looping.
    if (
      activeProperty
      && shouldResumeOnboarding(user.accountId, user.role, activeProperty.onboardingCompletedAt, activeProperty.onboardingState, activeProperty.onboardingPromptShownAt)
    ) {
      // Never trade a blocked sessionStorage policy for an automatic redirect
      // loop. The dashboard remains usable when the one-shot guard is absent.
      try {
        if (window.sessionStorage.getItem(RESUME_GUARD_KEY) === activeProperty.id) return;
        window.sessionStorage.setItem(RESUME_GUARD_KEY, activeProperty.id);
      } catch { return; }
      window.location.assign(`/api/onboard/resume?propertyId=${encodeURIComponent(activeProperty.id)}`);
    }
  }, [user, authLoading, propLoading, activePropertyId, activeProperty, replace]);

  // ── live data ──────────────────────────────────────────────────────
  const [roomsSnapshot, setRoomsSnapshot] = useState(() => emptyScopedFeed<Room>());
  const [countsSnapshot, setCountsSnapshot] = useState<{ propertyId: string | null; date: string | null; value: TodayPropertyCounts | null }>({ propertyId: null, date: null, value: null });
  const [countsErrorSnapshot, setCountsErrorSnapshot] = useState<{ propertyId: string | null; date: string | null; message: string | null }>({ propertyId: null, date: null, message: null });
  const countsSnapshotRef = useRef(countsSnapshot);
  countsSnapshotRef.current = countsSnapshot;
  const [countsRetryKey, setCountsRetryKey] = useState(0);
  const [operationalRetryKey, setOperationalRetryKey] = useState(0);
  // Mask the previous hotel/day synchronously in render; effect cleanup alone
  // is one paint too late and can flash Hotel A or yesterday's numbers beneath
  // the current hotel/date. The ref also lets subscription callbacks reject an
  // obsolete scope even if they arrive around cleanup.
  const dashboardScopeRef = useRef({ propertyId: activePropertyId, date: today });
  dashboardScopeRef.current = { propertyId: activePropertyId, date: today };
  const roomsFeed = useMemo(
    () => scopedFeedView(roomsSnapshot, activePropertyId, today),
    [roomsSnapshot, activePropertyId, today],
  );
  const rooms = roomsFeed.rows;
  const counts = countsSnapshot.propertyId === activePropertyId && countsSnapshot.date === today
    ? countsSnapshot.value
    : null;
  const countsError = countsErrorSnapshot.propertyId === activePropertyId && countsErrorSnapshot.date === today
    ? countsErrorSnapshot.message
    : null;

  // The configured room count is the property's true inventory; the PMS
  // snapshot's total_rooms can be a partial sample, so don't let it shrink
  // the dashboard (it would turn "of 74" into "of 14").
  const totalRooms = activeProperty?.totalRooms || counts?.total_rooms || 108;

  useEffect(() => {
    if (!user || !activePropertyId) return;
    const propertyId = activePropertyId;
    const date = today;
    let alive = true;
    setRoomsSnapshot((previous) => beginScopedFeed(previous, propertyId, date));
    const unsubscribe = subscribeToRooms(user.uid, propertyId, date, (rows) => {
      const currentScope = dashboardScopeRef.current;
      if (!alive || currentScope.propertyId !== propertyId || currentScope.date !== date) return;
      setRoomsSnapshot(publishScopedFeed(propertyId, date, rows));
    }, (error) => {
      const currentScope = dashboardScopeRef.current;
      if (!alive || currentScope.propertyId !== propertyId || currentScope.date !== date) return;
      console.warn('Dashboard: rooms feed unavailable', error);
      setRoomsSnapshot((previous) => failScopedFeed(previous, propertyId, date));
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [user, activePropertyId, operationalRetryKey, today]);
  // Property-level room breakdown (sums to total_rooms) — drives the full
  // ring + real occupancy. Polled independently from the room feed.
  useEffect(() => {
    if (!activePropertyId) return;
    let alive = true;
    let requestSequence = 0;
    const propertyId = activePropertyId;
    const date = today;
    const previousSnapshot = countsSnapshotRef.current;
    const hasLastGoodAtStart = previousSnapshot.propertyId === propertyId
      && previousSnapshot.date === date
      && previousSnapshot.value !== null;
    // A hotel/day change must blank synchronously. A same-scope retry keeps
    // its last-good values and stale verdict until a successful response
    // lands; pressing Retry must not make old data look current in advance.
    if (!hasLastGoodAtStart) {
      setCountsSnapshot({ propertyId, date, value: null });
      setCountsErrorSnapshot({ propertyId, date, message: null });
    }
    const load = async () => {
      const currentRequest = ++requestSequence;
      try {
        const next = await fetchTodayPropertyCounts(propertyId, date, { throwOnError: true });
        const currentScope = dashboardScopeRef.current;
        if (
          !alive
          || currentRequest !== requestSequence
          || currentScope.propertyId !== propertyId
          || currentScope.date !== date
        ) return;
        setCountsSnapshot((previous) => ({
          propertyId,
          date,
          value: holdLastGoodCounts(
            previous.propertyId === propertyId && previous.date === date ? previous.value : null,
            next,
          ),
        }));
        setCountsErrorSnapshot({ propertyId, date, message: null });
      } catch (error) {
        const currentScope = dashboardScopeRef.current;
        if (
          !alive
          || currentRequest !== requestSequence
          || currentScope.propertyId !== propertyId
          || currentScope.date !== date
        ) return;
        console.warn('Dashboard: today counts unavailable', error);
        setCountsErrorSnapshot({
          propertyId,
          date,
          message: 'unavailable',
        });
      }
    };
    void load();
    const iv = setInterval(() => { void load(); }, 30_000);
    return () => {
      alive = false;
      requestSequence += 1;
      clearInterval(iv);
    };
  }, [activePropertyId, countsRetryKey, today]);
  // ── derived live values ──────────────────────────────────────────────
  const roomsFeedFailed = roomsFeed.error;
  const roomsFeedCurrent = roomsFeed.hasSnapshot && !roomsFeed.error;

  // Room-status feed trust. A report may contain only SOME expected data;
  // default room statuses remain neutral until a real room-status feed lands.
  // That is decided per tick in buildRoomRingTicks, from room-level facts —
  // this page holds no second copy of the rule, and in particular does not use
  // one to suppress the data-age stamp (see the legend row below).
  const feedStatus = useFeedStatus(activePropertyId);
  // Pending and failed are both unknown, never zero. A returned all-zero
  // snapshot remains a legitimate terminal value because `counts` is present.
  const countsUnavailable = !counts;

  // ── data-age stamps ─────────────────────────────────────────────────
  const propertyTz = activeProperty?.timezone ?? null;
  // The occupancy ring is the headline number on this page; it reads the same
  // snapshot as the room summary, so it gets the same stamp.
  const occupancyAsOf = useAsOfLabel({ status: feedStatus, feeds: ['dashboardCounts', 'roomStatus'], timezone: propertyTz });

  // Real occupancy signal (occupied rooms / inventory). Null when the PMS
  // snapshot carries no occupancy yet; real hotels then show an unknown center
  // value. The room ticks below remain independently grounded in room-level
  // facts and never inherit this aggregate percentage.
  // Derivation (in_house, never stayovers + checkouts) lives in counts-hold.ts
  // so it is testable and matches the Home tile and the sealed daily history.
  const occPct = useMemo(
    () => occupancyPctFromCounts(counts, totalRooms),
    [counts, totalRooms],
  );

  // ~2y daily history for the chart; today's row anchored to real occupancy
  // when we have it.
  const history = useMemo<HistRow[]>(() => buildHistory(totalRooms, occPct), [totalRooms, occPct]);
  // ── honesty gate ─────────────────────────────────────────────────────
  // Two distinct signals, because occupancy and the financial showcase have
  // very different "is this real?" answers:
  //
  //  • occupancyReady — do we have a real occupancy reading (or an explicit
  //    demo)? This controls the aggregate center figure only; tick colours are
  //    built separately from room-level facts.
  //
  //  • showFinancials — should we show the synthetic KPI strip / chart /
  //    month-to-date? These are built ENTIRELY from generated numbers
  //    (today-series.ts): revenue / ADR / RevPAR / profit have NO real source
  //    for ANY hotel yet, and the multi-month history is fabricated, not
  //    measured. So we show them ONLY on an explicit demo property. Every real
  //    hotel — even one already running with live occupancy — gets the honest
  //    "trends appear as history builds" state instead of fabricated KPIs.
  //    (A brand-new 1-room hotel reads 100% occupancy, which is REAL, but its
  //    revenue/$ are still invented — gating the showcase on occupancy alone
  //    would let those fabricated dollars through. So the showcase is
  //    demo-only; real occupancy still drives the ring above.)
  const hasRealData = occPct != null;
  const isDemo = !!activeProperty?.isTest;
  const occupancyReady = hasRealData || isDemo;
  // Synthetic financial showcase: demo-only AND only when the Financials
  // section is on for the hotel (AND with the existing demo gate, never a
  // replacement). Turning Financials off hides the KPI strip / chart / MTD.
  const showFinancials = isDemo && financialsEnabled;

  // One tick = one real room identity. The configured inventory supplies the
  // roster; today's room feed supplies only statuses attached to those exact
  // identities. Rooms with no room-level signal stay neutral — aggregate PMS
  // totals still drive the center occupancy figure, but are never scattered
  // across named rooms.
  const ringRooms = useMemo<RingTick[]>(
    () => buildRoomRingTicks(rooms, activeProperty?.roomInventory ?? []),
    [rooms, activeProperty?.roomInventory],
  );

  // ring distribution for the legend
  const ringCounts = useMemo(() => {
    const c: Partial<Record<RingKey, number>> = {};
    ringRooms.forEach(r => { c[r.status] = (c[r.status] || 0) + 1; });
    return c;
  }, [ringRooms]);

  // ── chart series ─────────────────────────────────────────────────────
  const [metric, setMetric] = useState<TodayMetricKey>('occ');
  const [range, setRange] = useState<typeof RANGES[number]['key']>('30d');
  const [hi, setHi] = useState<number | null>(null);
  const [room, setRoom] = useState<RingTick | null>(null);
  const [playIdx, setPlayIdx] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);

  const def = METRIC_DEFS.find(m => m.key === metric)!;
  const RG = RANGES.find(r => r.key === range)!;
  const series = useMemo(() => seriesFor(history, RG, metric), [history, RG, metric]);

  const hov = hi != null ? series[hi] : (playIdx != null ? series[playIdx] : null);
  const scrubbing = hi != null;
  const todayRow = series.find(s => s.today) ?? series[series.length - 1];
  const liveTarget = useMemo<Record<TodayMetricKey, number>>(() => {
    const r = (hov ? hov.row : todayRow?.row) ?? { occ: 0, revenue: 0, adr: 0, revpar: 0, profit: 0 };
    return { occ: r.occ, revenue: r.revenue, adr: r.adr, revpar: r.revpar, profit: r.profit };
  }, [hov, todayRow]);
  const live = useTweenRow(liveTarget) as Record<TodayMetricKey, number>;

  // playback resets when metric/range change
  useEffect(() => { setPlaying(false); setPlayIdx(null); setHi(null); }, [metric, range]);
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      setPlayIdx(i => {
        const next = i == null ? 0 : i + 1;
        if (next >= series.length) { setPlaying(false); return null; }
        return next;
      });
    }, 600);
    return () => clearInterval(t);
  }, [playing, series.length]);
  const togglePlay = () => {
    if (playing) { setPlaying(false); }
    else { setHi(null); setPlayIdx(0); setPlaying(true); }
  };

  // KPI spark + delta from raw daily history
  const kpiSpark = useCallback((field: TodayMetricKey) => history.slice(-7).map(d => d[field]), [history]);
  const kpiDelta = useCallback((field: TodayMetricKey) => {
    const n = history.length;
    if (n < 8) return 0;
    const cur = history[n - 1][field], prev = history[n - 8][field];
    return prev ? Math.round(((cur - prev) / prev) * 100) : 0;
  }, [history]);

  // current row backing the KPI sub-labels (target, not the tween)
  const rowNow = (hov ? hov.row : todayRow?.row) ?? { occ: 0, revenue: 0, adr: 0, revpar: 0, profit: 0 };
  const soldNow = Math.round((rowNow.occ / 100) * totalRooms);
  const marginNow = rowNow.revenue > 0 ? Math.round((rowNow.profit / rowNow.revenue) * 100) : 37;

  const kpis: { key: TodayMetricKey; label: string; tone: string; sub: string }[] = [
    { key: 'occ',     label: 'Occupancy', tone: C.green, sub: `${soldNow} of ${totalRooms} rooms` },
    { key: 'revenue', label: 'Revenue',    tone: C.rust,  sub: `${soldNow} × $${Math.round(rowNow.adr)}` },
    { key: 'adr',     label: 'ADR',                            tone: C.ink,   sub: 'rate today' },
    { key: 'revpar',  label: 'RevPAR',                         tone: C.rust,  sub: `across all ${totalRooms}` },
    { key: 'profit',  label: 'Profit',       tone: C.green, sub: `${marginNow}% ${'margin'}` },
  ];

  // ── month-to-date footer (from the daily history) ────────────────────
  const mtd = useMemo(() => {
    const now = new Date();
    const cur = history.filter(d => d.date.getMonth() === now.getMonth() && d.date.getFullYear() === now.getFullYear() && d.date <= now);
    if (!cur.length) return null;
    const sum = (f: keyof HistRow) => cur.reduce((a, d) => a + (d[f] as number), 0);
    const avg = (f: keyof HistRow) => Math.round(sum(f) / cur.length);
    const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    return { occ: avg('occ'), revenue: sum('revenue'), profit: sum('profit'), adr: avg('adr'), soldRooms: sum('rooms'), elapsed: cur.length, dim };
  }, [history]);
  // Same hotel-local clock as `today` above, so the heading and the numbers
  // beneath it always name the same day.
  const monthFull = new Date().toLocaleDateString('en-US', { month: 'long', timeZone: propertyTz ?? undefined });
  const dateLong = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: propertyTz ?? undefined });

  if (authLoading || propLoading) {
    return <RouteLoadingState title={'Loading Dashboard…'} />;
  }
  if (!user) {
    return <RouteLoadingState title={'Returning to Sign In…'} />;
  }
  if (!activePropertyId) {
    return (

        <RouteErrorState
          title={'No hotel is selected'}
          message={'Choose a hotel before opening Dashboard.'}
          retryLabel={'Choose a hotel'}
          onRetry={() => push('/property-selector')}
        />

    );
  }

  const STATUS = STATUS_EN;

  // ring center: hovered room → its number+status; else the active metric.
  // When there's no real occupancy (and not a demo) → neutral "—". On a real
  // hotel (occupancy real, financials hidden) ALWAYS show occupancy, regardless
  // of a stale `metric` carried over from a prior demo property — otherwise a
  // leftover "revenue" metric could paint a fabricated "$8.2k" in the center.
  const center = room
    ? (room.num
      ? { big: room.num, label: 'ROOM', sub: STATUS[room.status], color: RING[room.status] }
      : { big: STATUS[room.status], label: 'STATUS', sub: '', color: RING[room.status] })
    : !occupancyReady
      ? { big: '—', label: 'OCCUPANCY', sub: 'waiting for PMS data', color: C.ink3 }
    : (!showFinancials || metric === 'occ')
      ? { big: Math.round(live.occ) + '%', label: 'OCCUPANCY', sub: hov ? hov.d : (`${soldNow} of ${totalRooms} rooms`), color: C.green }
      : { big: def.fmt === 'money' ? fmtCompact(live[metric]) : fmtVal(def.fmt, live[metric]), label: def.label.toUpperCase(), sub: hov ? hov.d : ('today'), color: def.color };

  const pill = (on: boolean): React.CSSProperties => ({
    padding: '6px 12px', borderRadius: 999, border: `1px solid ${C.line2}`, cursor: 'pointer',
    fontFamily: SANS, fontSize: 12, fontWeight: 600,
    background: on ? C.ink : 'transparent', color: on ? '#fff' : C.ink2, transition: `all .3s ${SPRING}`,
  });

  return (

      <div className="stx-today" style={{ width: '100%', minHeight: '100vh', background: 'transparent', fontFamily: SANS, color: C.ink, padding: 'clamp(16px, 2vw, 32px) clamp(16px, 3vw, 48px) 130px' }}>
        <style>{`
          .stx-today .stx-hero { display:grid; grid-template-columns:320px 1fr; gap:48px; align-items:center; }
          .stx-today .stx-kpis { display:grid; grid-template-columns:repeat(5,1fr); border-top:1px solid ${C.line}; border-bottom:1px solid ${C.line}; }
          .stx-today .stx-mtd { display:flex; }
          @media (max-width: 980px) {
            .stx-today .stx-hero { grid-template-columns:1fr; gap:24px; justify-items:center; }
          }
          @media (max-width: 720px) {
            .stx-today .stx-kpis { grid-template-columns:repeat(2,1fr); }
            .stx-today .stx-mtd { flex-wrap:wrap; gap:18px 0; }
          }
          @media (prefers-reduced-motion: reduce) { .stx-today * { animation-duration:.001ms !important; } }
        `}</style>

        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 26 }}>

          {/* date (Reports lives in Settings → Reports) */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
            <span style={{ fontFamily: SANS, fontWeight: 600, fontSize: 26, letterSpacing: '-0.02em', color: C.ink, textTransform: 'capitalize' }}>{dateLong}</span>
          </div>

          {(countsUnavailable || countsError) && (
            <div
              role={countsError ? 'alert' : 'status'}
              aria-live="polite"
              aria-busy={countsUnavailable && !countsError}
              style={{
                minHeight: 48,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 16,
                flexWrap: 'wrap',
                padding: '11px 14px',
                borderRadius: 12,
                border: `1px solid ${countsError ? 'rgba(184,92,61,.28)' : C.line2}`,
                background: countsError ? 'rgba(184,92,61,.07)' : 'rgba(255,255,255,.48)',
                color: countsError ? C.rust : C.ink2,
                fontSize: 13,
                lineHeight: 1.45,
              }}
            >
              <span>
                {countsError
                  ? (countsUnavailable
                      ? ("We couldn't load today's room summary.")
                      : ("Today's room summary couldn't refresh. Showing last-known values."))
                  : ('Loading room summary…')}
              </span>
              {countsError && (
                <button
                  type="button"
                  onClick={() => setCountsRetryKey((key) => key + 1)}
                  style={{
                    minHeight: 44,
                    padding: '7px 13px',
                    borderRadius: 999,
                    border: `1px solid ${C.rust}`,
                    background: 'transparent',
                    color: C.rust,
                    fontFamily: SANS,
                    fontSize: 12,
                    fontWeight: 650,
                    cursor: 'pointer',
                  }}
                >
                  {'Try again'}
                </button>
              )}
            </div>
          )}

          {!roomsFeedCurrent && (
            <div
              role={roomsFeedFailed ? 'alert' : 'status'}
              aria-live="polite"
              aria-busy={!roomsFeedFailed}
              style={{
                minHeight: 48,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 16,
                flexWrap: 'wrap',
                padding: '11px 14px',
                borderRadius: 12,
                border: `1px solid ${roomsFeedFailed ? 'rgba(184,92,61,.28)' : C.line2}`,
                background: roomsFeedFailed ? 'rgba(184,92,61,.07)' : 'rgba(255,255,255,.48)',
                color: roomsFeedFailed ? C.rust : C.ink2,
                fontSize: 13,
                lineHeight: 1.45,
              }}
            >
              <span>
                {roomsFeedFailed
                  ? ('Some live operational details are unavailable. Last-known values may be incomplete.')
                  : ('Loading live operational details…')}
              </span>
              {roomsFeedFailed && (
                <button
                  type="button"
                  onClick={() => setOperationalRetryKey((key) => key + 1)}
                  style={{
                    minHeight: 44,
                    padding: '7px 13px',
                    borderRadius: 999,
                    border: `1px solid ${C.rust}`,
                    background: 'transparent',
                    color: C.rust,
                    fontFamily: SANS,
                    fontSize: 12,
                    fontWeight: 650,
                    cursor: 'pointer',
                  }}
                >
                  {'Try again'}
                </button>
              )}
            </div>
          )}

          {/* hero: ring + chart */}
          <section className="stx-hero">
            <div onClick={() => { setMetric('occ'); setRoom(null); }} style={{ position: 'relative', cursor: 'pointer', width: 'fit-content', justifySelf: 'center' }}>
              <RoomRing rooms={ringRooms} onHover={setRoom} hovered={room} />
              <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                <div style={{ ...LABEL, fontSize: 10 }}>{center.label}</div>
                <div style={{ fontFamily: SANS, fontWeight: 600, fontSize: room ? (room.num ? 50 : 28) : 60, letterSpacing: '-0.02em', color: center.color, lineHeight: 1.05, margin: '6px 0 8px', textAlign: 'center', padding: '0 18px' }}>{center.big}</div>
                <div style={{ fontSize: 14, fontWeight: 500, color: C.ink2, whiteSpace: 'nowrap' }}>{center.sub}</div>
              </div>
            </div>

            <div style={{ width: '100%' }}>
              {showFinancials ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 14, gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ ...LABEL, marginBottom: 6 }}>{def.label} · {RG.full}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <button onClick={togglePlay} title={playing ? ('Pause') : ('Play through ' + RG.full)}
                        style={{ width: 36, height: 36, borderRadius: 18, border: 'none', cursor: 'pointer', flexShrink: 0, background: playing ? C.rust : def.color, color: '#fff', display: 'grid', placeItems: 'center', transition: `background .3s ${SPRING}` }}>
                        {playing
                          ? <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="2" width="3.6" height="12" rx="1" /><rect x="9.4" y="2" width="3.6" height="12" rx="1" /></svg>
                          : <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5v11l9-5.5z" /></svg>}
                      </button>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {RANGES.map(r => <button key={r.key} onClick={() => setRange(r.key)} style={pill(range === r.key)}>{r.label}</button>)}
                      </div>
                    </div>
                  </div>
                  <MetricChart key={metric + range} series={series} color={def.color} onHover={setHi} marker={playing ? playIdx : null} />
                </>
              ) : (
                // Honest "no data yet" state — no fabricated trend line. The
                // occupancy ring above still shows today's real numbers;
                // only the multi-month financial trend (which has no real
                // source yet) waits for history.
                <div style={{
                  height: 236, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  textAlign: 'center', gap: 10, border: `1px dashed ${C.line2}`, borderRadius: 16, padding: '24px',
                }}>
                  <div style={{ ...LABEL }}>{'No history yet'}</div>
                  <div style={{ fontFamily: SANS, fontWeight: 500, fontSize: 16, color: C.ink2, maxWidth: 460, lineHeight: 1.5 }}>
                    {'Your occupancy and revenue trends will appear here as your hotel’s daily history builds up.'}
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* ring legend — with the occupancy picture's data-age stamp. The
              ring shows the last real room mix; the chip says when it was
              taken so an hours-old picture is never read as "right now". */}
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 20px', marginTop: -10 }}>
            {(['occupied', 'departing', 'arriving', 'clean', 'dirty', 'inprog', 'ooo'] as RingKey[]).filter(k => (ringCounts[k] || 0) > 0).map(k => (
              <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, color: C.ink2 }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: RING[k] }} />
                {STATUS[k]} <span style={{ fontFamily: MONO, color: C.ink3 }}>{ringCounts[k]}</span>
              </span>
            ))}
            {/* The stamp's OWN module decides whether a stamp is allowed (never
                for a manual hotel, never over a never-synced connection, never
                over a feed with no real source). A second suppression here
                — "hide it while room status is still learning" — was a rule
                nothing documented, and it fired on exactly the case that needs
                the stamp most: a hotel whose room-status feed is learning while
                its counts feed is hours stale showed a confident occupancy
                percentage with nothing saying when it was taken. */}
            {occupancyReady && <FeedAsOfLabel label={occupancyAsOf} variant="pill" />}
          </div>

          {/* KPI strip — synthetic financials; shown on a demo property only,
              never fabricated for a real hotel (no fabricated KPIs) */}
          {showFinancials && (
          <section className="stx-kpis">
            {kpis.map((k, i) => {
              const mdef = METRIC_DEFS.find(m => m.key === k.key)!;
              const active = metric === k.key;
              const val = mdef.fmt === 'pct' ? Math.round(live[k.key]) + '%' : fmtMoney(live[k.key]);
              return (
                <div key={k.key} onClick={() => { setMetric(k.key); setRoom(null); }} title={`${'Chart'} ${k.label}`}
                  style={{ padding: '20px 22px', borderLeft: i ? `1px solid ${C.line}` : 'none', cursor: 'pointer', background: active ? C.paper2 : 'transparent', boxShadow: active ? `inset 0 3px 0 ${mdef.color}` : 'none', transition: `background .3s ${SPRING}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, minHeight: 14 }}>
                    <span style={LABEL}>{k.label}</span>
                    {active && <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: MONO, fontSize: 10, fontWeight: 600, letterSpacing: '.08em', color: C.green }}><span style={{ width: 6, height: 6, borderRadius: 3, background: C.green }} />{'ON CHART'}</span>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                    <span style={{ fontFamily: SANS, fontWeight: 600, fontSize: 'clamp(32px, 3vw, 46px)', lineHeight: .95, letterSpacing: '-0.02em', color: k.tone, fontVariantNumeric: 'tabular-nums' }}>{val}</span>
                    {!scrubbing && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <Delta v={kpiDelta(k.key)} />
                        <span style={{ fontSize: 10, color: C.ink4 }}>{'vs last wk'}</span>
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
                    <span style={{ fontSize: 12, color: C.ink3 }}>{k.sub}</span>
                    <Sparkline data={kpiSpark(k.key)} stroke={k.tone === C.rust ? C.rust : C.green} />
                  </div>
                </div>
              );
            })}
          </section>
          )}

          {/* month to date — synthetic totals; demo property only (no fabricated totals) */}
          {showFinancials && mtd && (
            <section className="stx-mtd" style={{ borderTop: `1px solid ${C.line}`, paddingTop: 22 }}>
              <span style={{ fontFamily: SANS, fontWeight: 600, fontSize: 16, letterSpacing: '-0.02em', color: C.ink2, width: 200, flexShrink: 0, textTransform: 'capitalize' }}>
                {`${monthFull}, month to date`}
              </span>
              {([
                ['Avg occupancy', mtd.occ + '%', C.green],
                ['Revenue', fmtCompact(mtd.revenue), C.rust],
                ['Profit', fmtCompact(mtd.profit), C.green],
                ['ADR ' + ('avg'), '$' + mtd.adr, C.ink],
                ['Rooms sold', mtd.soldRooms.toLocaleString(), C.ink],
                ['Days in', `${mtd.elapsed} ${'of'} ${mtd.dim}`, C.ink2],
              ] as [string, string, string][]).map(m => (
                <div key={m[0]} style={{ flex: 1, minWidth: 110, paddingLeft: 22, borderLeft: `1px solid ${C.line}` }}>
                  <div style={{ ...LABEL, marginBottom: 6 }}>{m[0]}</div>
                  <div style={{ fontFamily: SANS, fontWeight: 600, fontSize: 23, letterSpacing: '-0.02em', color: m[2], fontVariantNumeric: 'tabular-nums' }}>{m[1]}</div>
                </div>
              ))}
            </section>
          )}

          {/* Shift Log Book — latest recaps; renders only once there's at least one */}
          <LogBookCard />

          {/* Upcoming team calendar events; renders only once there's at least one upcoming */}
          <CalendarCard />

          {/* What Staxis learned — self-learning Move #2; renders only once populated */}
          <MemoryRecapCard />

        </div>
      </div>

  );
}
