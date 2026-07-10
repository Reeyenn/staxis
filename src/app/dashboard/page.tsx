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
// headline; "Right now" ops tiles + a "Needs attention" card; a
// month-to-date footer.
//
// Restyled for the Concourse shell: transparent root over the app-wide
// radial wash, Geist display type (no serif/italic), Concourse ink/sage/
// amber/rust palette. Kept from the live app: the global nav (AppLayout).
// The ring + "Right now" + "Needs
// attention" are wired to live Supabase data. The chart series is the
// same deterministic seam as before (see today-series.ts) — every range
// + Play works today and turns fully real once daily history is stored.
// ════════════════════════════════════════════════════════════════════

export const dynamic = 'force-dynamic';

import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { useSectionEnabled } from '@/lib/sections/useSectionEnabled';
import { isOnboardingInProgress, RESUME_GUARD_KEY } from '@/lib/onboarding/state';
import { AppLayout } from '@/components/layout/AppLayout';
import { MemoryRecapCard } from './_components/MemoryRecapCard';
import { WorklistCard } from './_components/WorklistCard';
import { WhatStaxisKnowsCard } from './_components/WhatStaxisKnowsCard';
import { LogBookCard } from './_components/LogBookCard';
import { CalendarCard } from './_components/CalendarCard';
import {
  subscribeToRooms,
  subscribeToWorkOrders,
  subscribeToDashboardNumbers,
  subscribeToComplaints,
  fetchComplianceSummary,
  subscribeLostFoundCounts,
  type DashboardNumbers,
  type LostFoundCounts,
} from '@/lib/db';
import { type Complaint, isOverdue, isCallbackDue, isOpenStatus } from '@/lib/complaints-shared';
import type { ComplianceSummary } from '@/lib/compliance/types';
import { fetchTodayPropertyCounts, type TodayPropertyCounts } from '@/lib/db/today-room-work';
import { useTodayStr } from '@/lib/use-today-str';
import { useFeedStatus } from '@/lib/use-feed-status';
import type { FeedKey } from '@/lib/pms/feed-status';
import type { Room, WorkOrder } from '@/types';
import {
  RANGES, METRIC_DEFS, buildHistory, seriesFor,
  fmtMoney, fmtCompact, fmtVal, smoothPath,
  type TodayMetricKey, type HistRow, type SeriesPoint,
} from '@/lib/dashboard/today-series';

// ─── palette (Concourse tokens, on the app-wide radial wash) ──────────
const C = {
  paper:  '#FFFFFF',   // white — chart marker fills / card surfaces
  paper2: 'rgba(158,183,166,.16)', // sage wash fill for the active KPI cell
  card:   '#FFFFFF',
  ink:    '#1F231C',
  ink2:   '#5C625C',
  ink3:   '#8A9187',
  ink4:   '#A6ABA6',
  green:  '#356B4C',
  greenL: '#5C7A60',
  sage:   '#9EB7A6',
  rust:   '#B85C3D',
  rustD:  '#B85C3D',
  rustBg: 'rgba(184,92,61,.10)',
  gold:   '#C99644',
  line:   'rgba(31,35,28,0.08)',
  line2:  'rgba(31,35,28,0.14)',
} as const;

const SANS  = 'var(--font-geist), system-ui, -apple-system, sans-serif';
const MONO  = 'var(--font-geist-mono), ui-monospace, "SF Mono", Menlo, monospace';
const SPRING = 'cubic-bezier(.22,1,.36,1)';

type RingKey = 'occupied' | 'departing' | 'arriving' | 'clean' | 'dirty' | 'inprog' | 'ooo' | 'none';

const RING: Record<RingKey, string> = {
  occupied: '#356B4C', departing: '#C99644', arriving: '#5C7A60',
  clean: 'rgba(158,183,166,.45)', dirty: '#B85C3D', inprog: '#9EB7A6', ooo: '#A6ABA6', none: 'rgba(31,35,28,.10)',
};
const STATUS_EN: Record<RingKey, string> = {
  occupied: 'Occupied', departing: 'Departing', arriving: 'Arriving soon',
  clean: 'Clean / ready', dirty: 'Dirty', inprog: 'Being cleaned', ooo: 'Out of order', none: 'No data yet',
};
const STATUS_ES: Record<RingKey, string> = {
  occupied: 'Ocupada', departing: 'Saliendo', arriving: 'Por llegar',
  clean: 'Limpia / lista', dirty: 'Sucia', inprog: 'En limpieza', ooo: 'Fuera de servicio', none: 'Sin datos',
};

// One tick = one specific room. `idx` is a stable unique identity so hover
// highlights only the room under the cursor (matching on room number would
// pop out every room that shares it).
type RingTick = { idx: number; num: string; status: RingKey };

const LABEL: React.CSSProperties = {
  fontFamily: MONO, textTransform: 'uppercase', letterSpacing: '0.14em',
  fontWeight: 600, fontSize: 9.5, color: C.ink4,
};

// ─── tween a row of numbers smoothly toward target (scrub / playback) ──
function useTweenRow(target: Record<string, number>): Record<string, number> {
  const targetRef = useRef(target);
  targetRef.current = target;
  const keysRef = useRef(Object.keys(target));
  const [disp, setDisp] = useState<Record<string, number>>(() => {
    const o: Record<string, number> = {};
    keysRef.current.forEach(k => { o[k] = 0; });
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

// ─── Sparkline ────────────────────────────────────────────────────────
function Sparkline({ data, w = 56, h = 16, stroke = C.green }: { data: number[]; w?: number; h?: number; stroke?: string }) {
  if (!data.length) return null;
  const min = Math.min(...data), max = Math.max(...data), rng = max - min || 1;
  const pts: [number, number][] = data.map((v, i) => [(i / (data.length - 1 || 1)) * w, h - ((v - min) / rng) * (h - 2) - 1]);
  return (
    <svg width={w} height={h} style={{ display: 'block', overflow: 'visible' }}>
      <path d={smoothPath(pts)} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r={2} fill={stroke} />
    </svg>
  );
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

// ─── Room ring ────────────────────────────────────────────────────────
const RoomRing = React.memo(function RoomRing({ rooms, onHover, hovered }: {
  rooms: RingTick[];
  onHover: (r: RingTick | null) => void;
  hovered: RingTick | null;
}) {
  const size = 300, cx = size / 2, cy = size / 2, rOut = 140, rIn = 112;
  const n = rooms.length || 1;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} style={{ display: 'block', overflow: 'visible' }}>
      {rooms.map((r, i) => {
        const a = (-90 + (i + 0.5) / n * 360) * Math.PI / 180;
        const isH = hovered != null && hovered.idx === r.idx;
        const ri = isH ? rIn - 5 : rIn, ro = isH ? rOut + 6 : rOut;
        return (
          <line key={r.idx}
            x1={cx + Math.cos(a) * ri} y1={cy + Math.sin(a) * ri}
            x2={cx + Math.cos(a) * ro} y2={cy + Math.sin(a) * ro}
            stroke={RING[r.status]} strokeWidth={isH ? 9 : 6} strokeLinecap="round"
            onMouseEnter={() => onHover(r)} onMouseLeave={() => onHover(null)}
            style={{ cursor: 'pointer', transition: `stroke-width .3s ${SPRING}` }} />
        );
      })}
    </svg>
  );
});

// ─── metric chart (draw-in line/area, hover-scrub, today + playhead) ──
const MetricChart = React.memo(function MetricChart({ series, color, onHover, marker }: {
  series: SeriesPoint[];
  color: string;
  onHover: (i: number | null) => void;
  marker: number | null;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const [hi, setHi] = useState<number | null>(null);
  // Measure the real rendered width so the chart fills the full container
  // (a fixed viewBox would scale-to-fit and leave white space on the sides).
  const [w, setW] = useState(1100);
  const h = 236, pad = { t: 26, r: 10, b: 26, l: 10 };
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => { const x = el.getBoundingClientRect().width; if (x > 0) setW(Math.round(x)); };
    measure();
    const obs = new ResizeObserver(measure);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  const vals = series.map(d => d.v);
  const min = Math.min(...vals), max = Math.max(...vals);
  const lo = min - (max - min) * 0.16 - 0.001, span = (max - lo) * 1.16 || 1;
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const X = (i: number) => pad.l + (i / (series.length - 1 || 1)) * iw;
  const Y = (v: number) => pad.t + ih - ((v - lo) / span) * ih;
  const pts: [number, number][] = series.map((d, i) => [X(i), Y(d.v)]);
  const line = smoothPath(pts);
  const area = `${line} L ${X(series.length - 1)},${pad.t + ih} L ${X(0)},${pad.t + ih} Z`;

  useEffect(() => {
    const p = pathRef.current;
    if (!p) return;
    if (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const L = p.getTotalLength();
    p.style.transition = 'none';
    p.style.strokeDasharray = String(L);
    p.style.strokeDashoffset = String(L);
    requestAnimationFrame(() => {
      p.style.transition = `stroke-dashoffset .9s ${SPRING}`;
      p.style.strokeDashoffset = '0';
    });
    // Fallback: rAF is throttled in hidden/background tabs, which would
    // leave the line invisible. Guarantee it reveals regardless.
    const reveal = setTimeout(() => { if (pathRef.current) pathRef.current.style.strokeDashoffset = '0'; }, 700);
    return () => clearTimeout(reveal);
  }, [series, color, w]);

  const move = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (w / rect.width);
    let i = Math.round(((x - pad.l) / iw) * (series.length - 1));
    i = Math.max(0, Math.min(series.length - 1, i));
    setHi(i); onHover(i);
  };
  const leave = () => { setHi(null); onHover(null); };
  const shown = hi != null ? hi : marker;

  return (
    <svg ref={ref} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" width="100%" height={h} onMouseMove={move} onMouseLeave={leave}
      style={{ display: 'block', overflow: 'visible', cursor: 'crosshair' }}>
      <defs>
        <linearGradient id="stx-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.2" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#stx-grad)" />
      <path ref={pathRef} d={line} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {series.map((d, i) => d.today ? (
        <g key="today">
          <line x1={X(i)} y1={pad.t} x2={X(i)} y2={pad.t + ih} stroke={color} strokeWidth="1" strokeDasharray="2 4" opacity=".5" />
          <circle cx={X(i)} cy={Y(d.v)} r="5" fill={C.paper} stroke={color} strokeWidth="2.5" />
        </g>
      ) : null)}
      {shown != null && series[shown] ? (
        <g style={{ pointerEvents: 'none' }}>
          <line x1={X(shown)} y1={pad.t} x2={X(shown)} y2={pad.t + ih} stroke={C.ink} strokeWidth="1" opacity=".25" />
          <circle cx={X(shown)} cy={Y(series[shown].v)} r="5" fill={color} stroke={C.paper} strokeWidth="2" />
        </g>
      ) : null}
      {[0, Math.floor(series.length / 2), series.length - 1].map(i => series[i] ? (
        <text key={i} x={Math.min(Math.max(X(i), 16), w - 16)} y={h - 6} textAnchor="middle" fontSize="10" fontFamily={MONO} fill={C.ink3}>{series[i].d}</text>
      ) : null)}
    </svg>
  );
});

// ─── ops tile ─────────────────────────────────────────────────────────
function OpsTile({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub: string; tone?: string }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ ...LABEL, marginBottom: 8 }}>{label}</div>
      <div style={{ fontFamily: SANS, fontWeight: 600, fontSize: 34, lineHeight: 1, letterSpacing: '-0.02em', color: tone || C.ink, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ fontSize: 12, color: C.ink3, marginTop: 4 }}>{sub}</div>
    </div>
  );
}

// ─── page ─────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const { user, loading: authLoading } = useAuth();
  const { activeProperty, activePropertyId, loading: propLoading } = useProperty();
  const { lang } = useLang();
  const router = useRouter();
  const today = useTodayStr();
  const ES = lang === 'es';

  // Per-hotel section gates (default-ON while the property loads). Each embed
  // below is owned by another section — when that section is off for the hotel
  // it stops both rendering AND subscribing:
  //   • communications → complaints / callbacks / lost-items
  //   • maintenance    → work orders / compliance
  //   • housekeeping   → dirty-room count
  //   • financials     → the synthetic KPI / chart / month-to-date showcase
  const communicationsEnabled = useSectionEnabled('communications');
  const maintenanceEnabled = useSectionEnabled('maintenance');
  const housekeepingEnabled = useSectionEnabled('housekeeping');
  const financialsEnabled = useSectionEnabled('financials');

  useEffect(() => {
    if (authLoading || propLoading) return;
    if (!user) { router.replace('/signin'); return; }
    if (!activePropertyId) { router.replace('/onboarding'); return; }
    // Backstop for the login-funnel gate: if anything lands a mid-onboarding
    // owner on the dashboard (their hotel has no PMS and an empty board),
    // send them back into the wizard to finish. Legacy/complete hotels have
    // no accountCreatedAt → never gated, so normal login is untouched. Admins
    // are never gated (they manage hotels, not own the signup). One-shot via
    // RESUME_GUARD_KEY so a failed resume degrades here instead of looping.
    if (
      user.role !== 'admin' &&
      activeProperty &&
      isOnboardingInProgress(activeProperty.onboardingCompletedAt, activeProperty.onboardingState) &&
      typeof window !== 'undefined' &&
      !sessionStorage.getItem(RESUME_GUARD_KEY)
    ) {
      sessionStorage.setItem(RESUME_GUARD_KEY, '1');
      window.location.href = `/api/onboard/resume?propertyId=${encodeURIComponent(activeProperty.id)}`;
    }
  }, [user, authLoading, propLoading, activePropertyId, activeProperty, router]);

  // ── live data ──────────────────────────────────────────────────────
  const [rooms, setRooms] = useState<Room[]>([]);
  const [counts, setCounts] = useState<TodayPropertyCounts | null>(null);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [dashboardNums, setDashboardNums] = useState<DashboardNumbers | null>(null);
  const [compliance, setCompliance] = useState<ComplianceSummary | null>(null);
  const [complaints, setComplaints] = useState<Complaint[]>([]);
  const [lostFound, setLostFound] = useState<LostFoundCounts | null>(null);

  // The configured room count is the property's true inventory; the PMS
  // snapshot's total_rooms can be a partial sample, so don't let it shrink
  // the dashboard (it would turn "of 74" into "of 14").
  const totalRooms = activeProperty?.totalRooms || counts?.total_rooms || 108;

  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeToRooms(user.uid, activePropertyId, today, setRooms);
  }, [user, activePropertyId, today]);
  // Property-level room breakdown (sums to total_rooms) — drives the full
  // ring + real occupancy. Polled; the housekeeping feed only carries the
  // cleaning list, not occupied rooms.
  useEffect(() => {
    if (!activePropertyId) return;
    let alive = true;
    const load = () => { void fetchTodayPropertyCounts(activePropertyId, today).then(c => { if (alive) setCounts(c); }); };
    load();
    const iv = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(iv); };
  }, [activePropertyId, today]);
  useEffect(() => {
    if (!user || !activePropertyId || !maintenanceEnabled) return;
    return subscribeToWorkOrders(user.uid, activePropertyId, setWorkOrders);
  }, [user, activePropertyId, maintenanceEnabled]);
  useEffect(() => subscribeToDashboardNumbers(setDashboardNums), []);
  useEffect(() => {
    if (!user || !activePropertyId || !communicationsEnabled) return;
    return subscribeToComplaints(user.uid, activePropertyId, setComplaints);
  }, [user, activePropertyId, communicationsEnabled]);
  useEffect(() => {
    if (!user || !activePropertyId || !communicationsEnabled) return;
    return subscribeLostFoundCounts(activePropertyId, setLostFound);
  }, [user, activePropertyId, communicationsEnabled]);
  useEffect(() => {
    if (!user || !activePropertyId || !maintenanceEnabled) return;
    let alive = true;
    const load = () => { void fetchComplianceSummary(activePropertyId).then(s => { if (alive) setCompliance(s); }); };
    load();
    const iv = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(iv); };
  }, [user, activePropertyId, maintenanceEnabled]);

  // ── derived live values ──────────────────────────────────────────────
  const openOrders = useMemo(() => workOrders.filter(o => o.status === 'open'), [workOrders]);
  const urgentOrders = useMemo(() => openOrders.filter(o => o.priority === 'urgent'), [openOrders]);

  // feat/cua-partial-promotion — per-feed PMS trust. The robot may be live
  // with only SOME feeds learned; a tile whose source feed is missing must
  // say "still learning", never a confident 0. When feed status is unknown
  // (manual hotel / onboarding / hook not yet loaded) every value below
  // keeps its exact pre-existing behavior.
  const feedStatus = useFeedStatus(activePropertyId);
  const fsLive = feedStatus?.mode === 'live';
  // Review pass (Codex #2 / senior #9): a 'pending' connection means this
  // property has NEVER successfully read — every pms_* table is empty, so
  // every PMS-derived number below is a fake zero regardless of per-feed
  // states. ('paused' is deliberately not masked: real-but-stale data;
  // staleness is the doctor/freshness domain.)
  const connPending = fsLive && feedStatus.connection === 'pending';
  const roomStatusLearning = fsLive && (feedStatus.feeds.roomStatus === 'learning' || connPending);
  // 'ok' = at least one source feed is live → render the number (genuine
  // zeros included). 'learning' = being auto-retried. 'unavailable' = this
  // PMS connection doesn't provide it (never claim "retrying").
  // 'connecting' = first sync hasn't landed yet.
  const tileState = (keys: FeedKey[]): 'ok' | 'learning' | 'unavailable' | 'connecting' => {
    if (!fsLive) return 'ok';
    if (connPending) return 'connecting';
    if (keys.some(k => feedStatus.feeds[k] === 'live')) return 'ok';
    if (keys.some(k => feedStatus.feeds[k] === 'learning')) return 'learning';
    return 'unavailable';
  };
  const inHouseState = tileState(['dashboardCounts']);
  const arrivalsState = tileState(['dashboardCounts', 'arrivals']);
  const departuresState = tileState(['departures', 'dashboardCounts']);

  // A room whose status came from the catch-all default is NOT a real dirty
  // while the room-status feed is still learning — counting it would turn a
  // missing feed into a fake "84 rooms to clean". App-originated statuses
  // (assignments, tap-set) always count.
  const dirtyRooms = useMemo(
    () => rooms.filter(r =>
      r.status === 'dirty' && !(roomStatusLearning && r.statusSource === 'default'),
    ).length,
    [rooms, roomStatusLearning],
  );

  // Tile values. The legacy anon snapshot read (dashboardNums) is kept as
  // the no-feed-status fallback only; with live feed status the numbers
  // come from the server-derived block (pms_* is deny-all-browser).
  const inHouse: React.ReactNode = !fsLive
    ? (counts?.in_house ?? dashboardNums?.inHouse ?? 0)
    : inHouseState === 'ok'
      ? (feedStatus.derived?.snapshotInHouse ?? counts?.in_house ?? 0)
      : '—';
  const arrivals: React.ReactNode = !fsLive
    ? (dashboardNums?.arrivals ?? 0)
    : arrivalsState !== 'ok'
      ? '—'
      : feedStatus.feeds.dashboardCounts === 'live'
        ? (feedStatus.derived?.snapshotArrivalsRemaining ?? '—')
        : (feedStatus.derived?.arrivalsToday ?? '—');
  const departures: React.ReactNode = !fsLive
    ? (counts?.checkouts ?? dashboardNums?.departures ?? 0)
    : departuresState !== 'ok'
      ? '—'
      : feedStatus.feeds.departures === 'live'
        ? (counts?.checkouts ?? 0)
        : (feedStatus.derived?.snapshotDeparturesRemaining ?? '—');

  // Real occupancy signal (occupied rooms / inventory). Null when the PMS
  // snapshot carries no occupancy yet — the chart + ring then fall back to
  // the synthetic trend, same as the rest of the dashboard.
  const occPct = useMemo(() => {
    if (counts && (counts.stayovers + counts.checkouts) > 0) {
      const denom = totalRooms || counts.total_rooms || 1;
      return Math.round(((counts.stayovers + counts.checkouts) / denom) * 100);
    }
    return null;
  }, [counts, totalRooms]);

  // ~2y daily history for the chart; today's row anchored to real occupancy
  // when we have it.
  const history = useMemo<HistRow[]>(() => buildHistory(totalRooms, occPct), [totalRooms, occPct]);
  // The occupancy the dashboard is showing for today (real if anchored, else
  // the synthetic trend) — used to keep the ring consistent with the figure.
  const displayOcc = history.length ? history[history.length - 1].occ : 0;

  // ── honesty gate ─────────────────────────────────────────────────────
  // Two distinct signals, because occupancy and the financial showcase have
  // very different "is this real?" answers:
  //
  //  • ringReady — do we have a real occupancy reading (or a demo)? When yes,
  //    the occupancy RING shows a real picture (today's occupied rooms). When
  //    no, the ring goes neutral.
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
  const ringReady = hasRealData || isDemo;
  // Synthetic financial showcase: demo-only AND only when the Financials
  // section is on for the hotel (AND with the existing demo gate, never a
  // replacement). Turning Financials off hides the KPI strip / chart / MTD.
  const showFinancials = isDemo && financialsEnabled;

  // FULL roster of the property's rooms — one tick = one specific room, each
  // with a stable floor-based number (101.., 201..) and a unique idx. Sized to
  // the property's room count (set at onboarding). Real status counts from the
  // PMS snapshot / cleaning feed drive the mix where we have them; the rest is
  // filled toward the occupancy shown. Deterministic shuffle so statuses
  // scatter naturally + stay stable across renders. Becomes fully real
  // per-room as CUA coverage fills in.
  const ringRooms = useMemo<RingTick[]>(() => {
    const total = Math.max(1, Math.min(totalRooms, 400));
    // feat/cua-partial-promotion — while the room-status feed is still being
    // learned, NEVER synthesize a plausible-looking board (the mock fill
    // below would paint clean/occupied rooms out of thin air). Every tick
    // renders the neutral 'none' ("no data") state instead.
    // Honesty gate: also go fully neutral when there's no real occupancy at all
    // (a manual / no-PMS / zero-data hotel where roomStatusLearning is false) —
    // otherwise the fill below would paint a fake ~80%-occupied ring from the
    // synthetic occupancy trend. (ringReady is true on a real-occupancy hotel
    // AND on a demo, so both keep a populated ring.)
    if (roomStatusLearning || !ringReady) {
      const floorsL = Math.max(1, Math.ceil(total / 20));
      const perFloorL = Math.ceil(total / floorsL);
      return Array.from({ length: total }, (_, i) => ({
        idx: i,
        num: String((Math.floor(i / perFloorL) + 1) * 100 + (i % perFloorL) + 1),
        status: 'none' as RingKey,
      }));
    }
    const c = counts;
    const feedDirty = rooms.filter(r => r.status === 'dirty').length;
    const feedClean = rooms.filter(r => r.status === 'clean' || r.status === 'inspected').length;
    let dirty = Math.min(total, Math.max(c?.vacant_dirty ?? 0, feedDirty));
    let clean = Math.min(total, Math.max(c?.vacant_clean ?? 0, feedClean));
    const ooo = Math.min(total, c?.ooo ?? 0);
    const departing = Math.min(total, c?.checkouts ?? 0);
    let occupied = Math.min(total, c?.stayovers ?? 0);
    let known = occupied + departing + dirty + clean + ooo;
    if (known < total) {
      const wantOccupied = Math.round((displayOcc / 100) * total);
      occupied += Math.max(0, wantOccupied - (occupied + departing));
      known = occupied + departing + dirty + clean + ooo;
      clean += Math.max(0, total - known);
    }
    const plan: RingKey[] = [];
    const add = (count: number, s: RingKey) => { for (let i = 0; i < count && plan.length < total; i++) plan.push(s); };
    add(occupied, 'occupied'); add(departing, 'departing'); add(clean, 'clean'); add(dirty, 'dirty'); add(ooo, 'ooo');
    while (plan.length < total) plan.push('clean');
    let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = plan.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [plan[i], plan[j]] = [plan[j], plan[i]]; }
    const floors = Math.max(1, Math.ceil(total / 20));
    const perFloor = Math.ceil(total / floors);
    return plan.map((status, i) => ({
      idx: i,
      num: String((Math.floor(i / perFloor) + 1) * 100 + (i % perFloor) + 1),
      status,
    }));
  }, [counts, rooms, totalRooms, displayOcc, roomStatusLearning, ringReady]);

  // ring distribution for the legend
  const ringCounts = useMemo(() => {
    const c: Partial<Record<RingKey, number>> = {};
    ringRooms.forEach(r => { c[r.status] = (c[r.status] || 0) + 1; });
    return c;
  }, [ringRooms]);

  const avgTurnover = useMemo(() => {
    const toMs = (v: unknown): number | null => {
      if (!v) return null;
      const obj = v as { toDate?: () => Date };
      if (typeof obj.toDate === 'function') return obj.toDate().getTime();
      const d = new Date(v as string | number | Date);
      return isNaN(d.getTime()) ? null : d.getTime();
    };
    const timed = rooms
      .filter(r => r.startedAt && r.completedAt)
      .map(r => { const s = toMs(r.startedAt); const e = toMs(r.completedAt); return s && e ? (e - s) / 60000 : 0; })
      .filter(mins => mins > 0 && mins < 480);
    return timed.length ? Math.round(timed.reduce((a, b) => a + b, 0) / timed.length) : null;
  }, [rooms]);

  // ── needs attention (live alerts) ────────────────────────────────────
  const nowD = new Date();
  const openComplaints = complaints.filter(c => isOpenStatus(c.status)).length;
  const overdueComplaints = complaints.filter(c => isOverdue(c, nowD)).length;
  const callbacksDueCount = complaints.filter(c => isCallbackDue(c, nowD)).length;
  const attention = useMemo(() => {
    const out: { n: number; text: string }[] = [];
    // Each line is filtered by the section that owns it — an off section
    // contributes nothing (and its feed above never subscribed).
    if (maintenanceEnabled && urgentOrders.length) out.push({ n: urgentOrders.length, text: ES ? `orden${urgentOrders.length > 1 ? 'es' : ''} de trabajo urgente${urgentOrders.length > 1 ? 's' : ''}` : `urgent work order${urgentOrders.length > 1 ? 's' : ''}` });
    if (maintenanceEnabled && compliance && compliance.pmOverdueCount > 0) out.push({ n: compliance.pmOverdueCount, text: ES ? 'revisiones de cumplimiento vencidas' : `compliance check${compliance.pmOverdueCount > 1 ? 's' : ''} overdue` });
    if (maintenanceEnabled && compliance && compliance.anomalyCount > 0) out.push({ n: compliance.anomalyCount, text: ES ? 'anomalías marcadas' : `anomaly flagged · Maintenance` });
    if (communicationsEnabled && overdueComplaints > 0) out.push({ n: overdueComplaints, text: ES ? 'quejas atrasadas' : `complaint${overdueComplaints > 1 ? 's' : ''} overdue` });
    if (communicationsEnabled && callbacksDueCount > 0) out.push({ n: callbacksDueCount, text: ES ? 'llamadas de seguimiento hoy' : `guest callback${callbacksDueCount > 1 ? 's' : ''} due` });
    if (housekeepingEnabled && dirtyRooms > 0) out.push({ n: dirtyRooms, text: ES ? 'habitaciones por limpiar' : `room${dirtyRooms > 1 ? 's' : ''} to clean` });
    if (communicationsEnabled && lostFound && lostFound.nearingDisposal > 0) out.push({ n: lostFound.nearingDisposal, text: ES ? 'objetos por desechar' : 'lost items nearing disposal' });
    return out.slice(0, 5);
  }, [urgentOrders.length, compliance, overdueComplaints, callbacksDueCount, dirtyRooms, lostFound, ES, maintenanceEnabled, communicationsEnabled, housekeepingEnabled]);
  const attnTotal = attention.reduce((a, x) => a + x.n, 0);

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
    { key: 'occ',     label: ES ? 'Ocupación' : 'Occupancy', tone: C.green, sub: ES ? `${soldNow} de ${totalRooms}` : `${soldNow} of ${totalRooms} rooms` },
    { key: 'revenue', label: ES ? 'Ingresos' : 'Revenue',    tone: C.rust,  sub: `${soldNow} × $${Math.round(rowNow.adr)}` },
    { key: 'adr',     label: 'ADR',                            tone: C.ink,   sub: ES ? 'tarifa de hoy' : 'rate today' },
    { key: 'revpar',  label: 'RevPAR',                         tone: C.rust,  sub: ES ? `en las ${totalRooms}` : `across all ${totalRooms}` },
    { key: 'profit',  label: ES ? 'Ganancia' : 'Profit',       tone: C.green, sub: `${marginNow}% ${ES ? 'margen' : 'margin'}` },
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
  const monthFull = new Date().toLocaleDateString(ES ? 'es-ES' : 'en-US', { month: 'long' });
  const dateLong = new Date().toLocaleDateString(ES ? 'es-ES' : 'en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  if (authLoading || propLoading || !user || !activePropertyId) {
    return <AppLayout><div /></AppLayout>;
  }

  const STATUS = ES ? STATUS_ES : STATUS_EN;

  // ring center: hovered room → its number+status; else the active metric.
  // When there's no real occupancy (and not a demo) → neutral "—". On a real
  // hotel (occupancy real, financials hidden) ALWAYS show occupancy, regardless
  // of a stale `metric` carried over from a prior demo property — otherwise a
  // leftover "revenue" metric could paint a fabricated "$8.2k" in the center.
  const center = room
    ? (room.num
      ? { big: room.num, label: ES ? 'HABITACIÓN' : 'ROOM', sub: STATUS[room.status], color: RING[room.status] }
      : { big: STATUS[room.status], label: ES ? 'ESTADO' : 'STATUS', sub: '', color: RING[room.status] })
    : !ringReady
      ? { big: '—', label: ES ? 'OCUPACIÓN' : 'OCCUPANCY', sub: ES ? 'aprendiendo del PMS' : 'learning from your PMS', color: C.ink3 }
    : (!showFinancials || metric === 'occ')
      ? { big: Math.round(live.occ) + '%', label: ES ? 'OCUPACIÓN' : 'OCCUPANCY', sub: hov ? hov.d : (ES ? `${soldNow} de ${totalRooms} habitaciones` : `${soldNow} of ${totalRooms} rooms`), color: C.green }
      : { big: def.fmt === 'money' ? fmtCompact(live[metric]) : fmtVal(def.fmt, live[metric]), label: def.label.toUpperCase(), sub: hov ? hov.d : (ES ? 'hoy' : 'today'), color: def.color };

  const pill = (on: boolean): React.CSSProperties => ({
    padding: '6px 12px', borderRadius: 999, border: `1px solid ${C.line2}`, cursor: 'pointer',
    fontFamily: SANS, fontSize: 12, fontWeight: 600,
    background: on ? C.ink : 'transparent', color: on ? '#fff' : C.ink2, transition: `all .3s ${SPRING}`,
  });

  return (
    <AppLayout>
      <div className="stx-today" style={{ width: '100%', minHeight: '100vh', background: 'transparent', fontFamily: SANS, color: C.ink, padding: 'clamp(16px, 2vw, 32px) clamp(16px, 3vw, 48px) 130px' }}>
        <style>{`
          .stx-today .stx-hero { display:grid; grid-template-columns:320px 1fr; gap:48px; align-items:center; }
          .stx-today .stx-kpis { display:grid; grid-template-columns:repeat(5,1fr); border-top:1px solid ${C.line}; border-bottom:1px solid ${C.line}; }
          .stx-today .stx-now { display:grid; grid-template-columns:1.3fr 1fr; gap:40px; align-items:start; }
          .stx-today .stx-ops { display:flex; }
          .stx-today .stx-mtd { display:flex; }
          @media (max-width: 980px) {
            .stx-today .stx-hero { grid-template-columns:1fr; gap:24px; justify-items:center; }
            .stx-today .stx-now { grid-template-columns:1fr; gap:24px; }
          }
          @media (max-width: 720px) {
            .stx-today .stx-kpis { grid-template-columns:repeat(2,1fr); }
            .stx-today .stx-ops { flex-wrap:wrap; gap:18px 0; }
            .stx-today .stx-mtd { flex-wrap:wrap; gap:18px 0; }
          }
          @media (prefers-reduced-motion: reduce) { .stx-today * { animation-duration:.001ms !important; } }
        `}</style>

        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 26 }}>

          {/* date (Reports lives in Settings → Reports) */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
            <span style={{ fontFamily: SANS, fontWeight: 600, fontSize: 26, letterSpacing: '-0.02em', color: C.ink, textTransform: 'capitalize' }}>{dateLong}</span>
          </div>

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
                      <button onClick={togglePlay} title={playing ? (ES ? 'Pausar' : 'Pause') : (ES ? 'Reproducir' : 'Play through ' + RG.full)}
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
                // occupancy ring + "Right now" tiles above still show today's
                // real numbers; only the multi-month financial trend (which has
                // no real source yet) waits for history.
                <div style={{
                  height: 236, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  textAlign: 'center', gap: 10, border: `1px dashed ${C.line2}`, borderRadius: 16, padding: '24px',
                }}>
                  <div style={{ ...LABEL }}>{ES ? 'Aún sin historial' : 'No history yet'}</div>
                  <div style={{ fontFamily: SANS, fontWeight: 500, fontSize: 16, color: C.ink2, maxWidth: 460, lineHeight: 1.5 }}>
                    {ES
                      ? 'Tus tendencias de ocupación e ingresos aparecerán aquí a medida que se acumule el historial diario de tu hotel.'
                      : 'Your occupancy and revenue trends will appear here as your hotel’s daily history builds up.'}
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* ring legend */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 20px', marginTop: -10 }}>
            {(['occupied', 'departing', 'arriving', 'clean', 'dirty', 'inprog', 'ooo'] as RingKey[]).filter(k => (ringCounts[k] || 0) > 0).map(k => (
              <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, color: C.ink2 }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: RING[k] }} />
                {STATUS[k]} <span style={{ fontFamily: MONO, color: C.ink3 }}>{ringCounts[k]}</span>
              </span>
            ))}
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
                <div key={k.key} onClick={() => { setMetric(k.key); setRoom(null); }} title={`${ES ? 'Graficar' : 'Chart'} ${k.label}`}
                  style={{ padding: '20px 22px', borderLeft: i ? `1px solid ${C.line}` : 'none', cursor: 'pointer', background: active ? C.paper2 : 'transparent', boxShadow: active ? `inset 0 3px 0 ${mdef.color}` : 'none', transition: `background .3s ${SPRING}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, minHeight: 14 }}>
                    <span style={LABEL}>{k.label}</span>
                    {active && <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: MONO, fontSize: 10, fontWeight: 600, letterSpacing: '.08em', color: C.green }}><span style={{ width: 6, height: 6, borderRadius: 3, background: C.green }} />{ES ? 'EN GRÁFICO' : 'ON CHART'}</span>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                    <span style={{ fontFamily: SANS, fontWeight: 600, fontSize: 'clamp(32px, 3vw, 46px)', lineHeight: .95, letterSpacing: '-0.02em', color: k.tone, fontVariantNumeric: 'tabular-nums' }}>{val}</span>
                    {!scrubbing && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <Delta v={kpiDelta(k.key)} />
                        <span style={{ fontSize: 10, color: C.ink4 }}>{ES ? 'vs sem.' : 'vs last wk'}</span>
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

          {/* right now + needs attention */}
          <section className="stx-now">
            <div>
              <div style={{ ...LABEL, marginBottom: 18 }}>{ES ? 'Ahora mismo' : 'Right now'}</div>
              <div className="stx-ops">
                {([
                  // feat/cua-partial-promotion — when a tile's source feed
                  // isn't trustworthy the value is '—' and the sub says WHY
                  // ("learning" = auto-retrying daily; "not in this PMS
                  // feed" = the connection doesn't provide it). A live feed
                  // renders exactly as before, genuine zeros included.
                  [ES ? 'Huéspedes' : 'Guests', inHouse,
                    inHouseState === 'connecting' ? (ES ? 'conectando con el PMS…' : 'connecting to your PMS…')
                      : inHouseState === 'learning' ? (ES ? 'aprendiendo del PMS' : 'learning from your PMS')
                      : inHouseState === 'unavailable' ? (ES ? 'no provisto por el PMS' : 'not in this PMS feed')
                      : (ES ? 'en casa' : 'in-house'), C.green],
                  [ES ? 'Llegadas' : 'Arrivals', arrivals,
                    arrivalsState === 'connecting' ? (ES ? 'conectando con el PMS…' : 'connecting to your PMS…')
                      : arrivalsState === 'learning' ? (ES ? 'aprendiendo del PMS' : 'learning from your PMS')
                      : arrivalsState === 'unavailable' ? (ES ? 'no provisto por el PMS' : 'not in this PMS feed')
                      : (ES ? 'esperadas' : 'expected'), C.greenL],
                  [ES ? 'Salidas' : 'Departures', departures,
                    departuresState === 'connecting' ? (ES ? 'conectando con el PMS…' : 'connecting to your PMS…')
                      : departuresState === 'learning' ? (ES ? 'aprendiendo del PMS' : 'learning from your PMS')
                      : departuresState === 'unavailable' ? (ES ? 'no provisto por el PMS' : 'not in this PMS feed')
                      : (ES ? 'saliendo' : 'checking out'), C.gold],
                  // Housekeeping tile is owned by the housekeeping section —
                  // dropped entirely when that section is off for the hotel.
                  ...(housekeepingEnabled ? [[ES ? 'Limpieza' : 'Housekeeping', roomStatusLearning ? '—' : dirtyRooms,
                    connPending ? (ES ? 'conectando con el PMS…' : 'connecting to your PMS…')
                      : roomStatusLearning ? (ES ? 'aprendiendo del PMS' : 'learning from your PMS')
                      : (ES ? 'por limpiar' : 'rooms to clean'), C.rust]] : []),
                  [ES ? 'Tiempo' : 'Turnover', avgTurnover ?? '—', ES ? 'min / hab.' : 'min / room', C.ink],
                ] as [string, React.ReactNode, string, string][]).map((o, i) => (
                  <div key={o[0]} style={{ flex: 1, minWidth: 90, paddingLeft: i ? 22 : 0, borderLeft: i ? `1px solid ${C.line}` : 'none' }}>
                    <OpsTile label={o[0]} value={o[1]} sub={o[2]} tone={o[3]} />
                  </div>
                ))}
              </div>
            </div>

            <div style={{ background: attention.length ? C.rustBg : 'rgba(158,183,166,.16)', borderRadius: 16, padding: 22 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <span style={{ ...LABEL, color: attention.length ? C.rustD : C.green }}>{ES ? 'Necesita atención' : 'Needs attention'}</span>
                <span style={{ background: attention.length ? C.rust : C.green, color: '#fff', borderRadius: 999, minWidth: 24, height: 24, padding: '0 7px', display: 'grid', placeItems: 'center', fontSize: 13, fontWeight: 700 }}>{attnTotal}</span>
              </div>
              {attention.length ? attention.map((a, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '7px 0', borderTop: i ? '1px solid rgba(184,92,61,.2)' : 'none' }}>
                  <span style={{ fontFamily: SANS, fontWeight: 600, fontSize: 22, letterSpacing: '-0.02em', color: C.rust, minWidth: 22 }}>{a.n}</span>
                  <span style={{ fontSize: 13, color: C.rustD }}>{a.text}</span>
                </div>
              )) : (
                <div style={{ fontSize: 14, color: C.green, paddingTop: 2 }}>{ES ? 'Todo en orden.' : 'All clear — nothing needs you right now.'}</div>
              )}
            </div>
          </section>

          {/* month to date — synthetic totals; demo property only (no fabricated totals) */}
          {showFinancials && mtd && (
            <section className="stx-mtd" style={{ borderTop: `1px solid ${C.line}`, paddingTop: 22 }}>
              <span style={{ fontFamily: SANS, fontWeight: 600, fontSize: 16, letterSpacing: '-0.02em', color: C.ink2, width: 200, flexShrink: 0, textTransform: 'capitalize' }}>
                {ES ? `${monthFull}, hasta hoy` : `${monthFull}, month to date`}
              </span>
              {([
                [ES ? 'Ocupación media' : 'Avg occupancy', mtd.occ + '%', C.green],
                [ES ? 'Ingresos' : 'Revenue', fmtCompact(mtd.revenue), C.rust],
                [ES ? 'Ganancia' : 'Profit', fmtCompact(mtd.profit), C.green],
                ['ADR ' + (ES ? 'medio' : 'avg'), '$' + mtd.adr, C.ink],
                [ES ? 'Hab. vendidas' : 'Rooms sold', mtd.soldRooms.toLocaleString(), C.ink],
                [ES ? 'Días' : 'Days in', `${mtd.elapsed} ${ES ? 'de' : 'of'} ${mtd.dim}`, C.ink2],
              ] as [string, string, string][]).map(m => (
                <div key={m[0]} style={{ flex: 1, minWidth: 110, paddingLeft: 22, borderLeft: `1px solid ${C.line}` }}>
                  <div style={{ ...LABEL, marginBottom: 6 }}>{m[0]}</div>
                  <div style={{ fontFamily: SANS, fontWeight: 600, fontSize: 23, letterSpacing: '-0.02em', color: m[2], fontVariantNumeric: 'tabular-nums' }}>{m[1]}</div>
                </div>
              ))}
            </section>
          )}

          {/* Open items — unified worklist window; renders only when there's open work */}
          <WorklistCard />
          {/* Shift Log Book — latest recaps; renders only once there's at least one */}
          <LogBookCard />

          {/* Upcoming team calendar events; renders only once there's at least one upcoming */}
          <CalendarCard />

          {/* What Staxis learned — self-learning Move #2; renders only once populated */}
          <MemoryRecapCard />

          {/* What Staxis knows about your hotel + impact — management view */}
          <WhatStaxisKnowsCard />

        </div>
      </div>
    </AppLayout>
  );
}
