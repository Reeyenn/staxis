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
// Kept from the live app per Reeyen: the page background (#F8F8F5) and
// the global top nav (AppLayout). The ring + "Right now" + "Needs
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
import { AppLayout } from '@/components/layout/AppLayout';
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
import { useTodayStr } from '@/lib/use-today-str';
import { canManageTeam } from '@/lib/roles';
import StaleDataBanner from '@/components/StaleDataBanner';
import type { Room, WorkOrder } from '@/types';
import {
  RANGES, METRIC_DEFS, buildHistory, seriesFor,
  fmtMoney, fmtCompact, fmtVal, smoothPath,
  type TodayMetricKey, type HistRow, type SeriesPoint,
} from '@/lib/dashboard/today-series';

// ─── palette (design colors, on our kept #F8F8F5 background) ──────────
const C = {
  paper:  '#F8F8F5',
  paper2: '#F0EEE9',
  card:   '#FFFFFF',
  ink:    '#20251F',
  ink2:   '#4A5249',
  ink3:   '#8A9187',
  ink4:   '#B4B9AE',
  green:  '#356B4C',
  greenL: '#5C8E6F',
  sage:   '#9DB8A6',
  rust:   '#BC5E37',
  rustD:  '#9A4A29',
  rustBg: '#F4E2D6',
  gold:   '#C09A3C',
  line:   'rgba(32,37,31,0.10)',
  line2:  'rgba(32,37,31,0.16)',
} as const;

const SERIF = 'var(--font-fraunces), Georgia, "Times New Roman", serif';
const SANS  = 'var(--font-geist), system-ui, -apple-system, sans-serif';
const MONO  = 'var(--font-geist-mono), ui-monospace, "SF Mono", Menlo, monospace';

type RingKey = 'occupied' | 'departing' | 'arriving' | 'clean' | 'dirty' | 'inprog' | 'none';

const RING: Record<RingKey, string> = {
  occupied: '#356B4C', departing: '#C79A3C', arriving: '#6FA384',
  clean: '#CBDBCF', dirty: '#C2704E', inprog: '#9DB8A6', none: '#E2E5DE',
};
const STATUS_EN: Record<RingKey, string> = {
  occupied: 'Occupied', departing: 'Departing', arriving: 'Arriving soon',
  clean: 'Clean / ready', dirty: 'Dirty', inprog: 'Being cleaned', none: 'No data yet',
};
const STATUS_ES: Record<RingKey, string> = {
  occupied: 'Ocupada', departing: 'Saliendo', arriving: 'Por llegar',
  clean: 'Limpia / lista', dirty: 'Sucia', inprog: 'En limpieza', none: 'Sin datos',
};

const LABEL: React.CSSProperties = {
  fontFamily: SANS, textTransform: 'uppercase', letterSpacing: '0.14em',
  fontWeight: 600, fontSize: 11, color: C.ink3,
};

// ─── room → ring status ───────────────────────────────────────────────
function ringStatus(r: Room, todayMDY: string): RingKey {
  if (r.status === 'dirty') return 'dirty';
  if (r.status === 'in_progress') return 'inprog';
  if (r.type === 'stayover') return 'occupied';
  if (r.type === 'checkout') return 'departing';
  // vacant + clean/inspected
  if (r.arrival && r.arrival === todayMDY) return 'arriving';
  return 'clean';
}
function todayMDY(): string {
  const n = new Date();
  return `${n.getMonth() + 1}/${n.getDate()}/${String(n.getFullYear()).slice(2)}`;
}

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
    return () => cancelAnimationFrame(raf);
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
function RoomRing({ rooms, onHover, hovered }: {
  rooms: { num: string; status: RingKey }[];
  onHover: (r: { num: string; status: RingKey } | null) => void;
  hovered: { num: string; status: RingKey } | null;
}) {
  const size = 300, cx = size / 2, cy = size / 2, rOut = 140, rIn = 112;
  const n = rooms.length || 1;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} style={{ display: 'block', overflow: 'visible' }}>
      {rooms.map((r, i) => {
        const a = (-90 + (i + 0.5) / n * 360) * Math.PI / 180;
        const isH = hovered != null && hovered.num === r.num;
        const ri = isH ? rIn - 5 : rIn, ro = isH ? rOut + 6 : rOut;
        return (
          <line key={r.num + ':' + i}
            x1={cx + Math.cos(a) * ri} y1={cy + Math.sin(a) * ri}
            x2={cx + Math.cos(a) * ro} y2={cy + Math.sin(a) * ro}
            stroke={RING[r.status]} strokeWidth={isH ? 9 : 6} strokeLinecap="round"
            onMouseEnter={() => onHover(r)} onMouseLeave={() => onHover(null)}
            style={{ cursor: 'pointer', transition: 'stroke-width .12s' }} />
        );
      })}
    </svg>
  );
}

// ─── metric chart (draw-in line/area, hover-scrub, today + playhead) ──
function MetricChart({ series, color, onHover, marker }: {
  series: SeriesPoint[];
  color: string;
  onHover: (i: number | null) => void;
  marker: number | null;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const [hi, setHi] = useState<number | null>(null);
  const w = 920, h = 236, pad = { t: 26, r: 10, b: 26, l: 10 };
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
      p.style.transition = 'stroke-dashoffset .9s cubic-bezier(.4,0,.1,1)';
      p.style.strokeDashoffset = '0';
    });
  }, [series, color]);

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
    <svg ref={ref} viewBox={`0 0 ${w} ${h}`} width="100%" height={h} onMouseMove={move} onMouseLeave={leave}
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
}

// ─── ops tile ─────────────────────────────────────────────────────────
function OpsTile({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub: string; tone?: string }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ ...LABEL, marginBottom: 8 }}>{label}</div>
      <div style={{ fontFamily: SERIF, fontStyle: 'italic', fontWeight: 500, fontSize: 34, lineHeight: 1, color: tone || C.ink, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
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

  useEffect(() => {
    if (!authLoading && !propLoading && !user) router.replace('/signin');
    if (!authLoading && !propLoading && user && !activePropertyId) router.replace('/onboarding');
  }, [user, authLoading, propLoading, activePropertyId, router]);

  const totalRooms = activeProperty?.totalRooms || 108;

  // ── live data ──────────────────────────────────────────────────────
  const [rooms, setRooms] = useState<Room[]>([]);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [dashboardNums, setDashboardNums] = useState<DashboardNumbers | null>(null);
  const [compliance, setCompliance] = useState<ComplianceSummary | null>(null);
  const [complaints, setComplaints] = useState<Complaint[]>([]);
  const [lostFound, setLostFound] = useState<LostFoundCounts | null>(null);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeToRooms(user.uid, activePropertyId, today, setRooms);
  }, [user, activePropertyId, today]);
  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeToWorkOrders(user.uid, activePropertyId, setWorkOrders);
  }, [user, activePropertyId]);
  useEffect(() => subscribeToDashboardNumbers(setDashboardNums), []);
  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeToComplaints(user.uid, activePropertyId, setComplaints);
  }, [user, activePropertyId]);
  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeLostFoundCounts(activePropertyId, setLostFound);
  }, [user, activePropertyId]);
  useEffect(() => {
    if (!user || !activePropertyId) return;
    let alive = true;
    const load = () => { void fetchComplianceSummary(activePropertyId).then(s => { if (alive) setCompliance(s); }); };
    load();
    const iv = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(iv); };
  }, [user, activePropertyId]);

  // ── derived live values ──────────────────────────────────────────────
  const openOrders = useMemo(() => workOrders.filter(o => o.status === 'open'), [workOrders]);
  const urgentOrders = useMemo(() => openOrders.filter(o => o.priority === 'urgent'), [openOrders]);
  const dirtyRooms = useMemo(() => rooms.filter(r => r.status === 'dirty').length, [rooms]);
  const inHouse = dashboardNums?.inHouse ?? 0;
  const arrivals = dashboardNums?.arrivals ?? 0;
  const departures = dashboardNums?.departures ?? 0;

  const mdy = todayMDY();
  const ringRooms = useMemo<{ num: string; status: RingKey }[]>(() => {
    if (!rooms.length) {
      const cap = Math.max(1, Math.min(totalRooms, 200));
      return Array.from({ length: cap }, (_, i) => ({ num: 'n' + i, status: 'none' as RingKey }));
    }
    return rooms.map(r => ({ num: r.number, status: ringStatus(r, mdy) }));
  }, [rooms, totalRooms, mdy]);

  // real occupancy = rooms sold (stayover + checkout) / total
  const occPct = useMemo(() => {
    if (!rooms.length || totalRooms <= 0) return null;
    const sold = rooms.filter(r => r.type === 'stayover' || r.type === 'checkout').length;
    return Math.round((sold / totalRooms) * 100);
  }, [rooms, totalRooms]);

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
    if (urgentOrders.length) out.push({ n: urgentOrders.length, text: ES ? `orden${urgentOrders.length > 1 ? 'es' : ''} de trabajo urgente${urgentOrders.length > 1 ? 's' : ''}` : `urgent work order${urgentOrders.length > 1 ? 's' : ''}` });
    if (compliance && compliance.pmOverdueCount > 0) out.push({ n: compliance.pmOverdueCount, text: ES ? 'revisiones de cumplimiento vencidas' : `compliance check${compliance.pmOverdueCount > 1 ? 's' : ''} overdue` });
    if (compliance && compliance.anomalyCount > 0) out.push({ n: compliance.anomalyCount, text: ES ? 'anomalías marcadas' : `anomaly flagged · Maintenance` });
    if (overdueComplaints > 0) out.push({ n: overdueComplaints, text: ES ? 'quejas atrasadas' : `complaint${overdueComplaints > 1 ? 's' : ''} overdue` });
    if (callbacksDueCount > 0) out.push({ n: callbacksDueCount, text: ES ? 'llamadas de seguimiento hoy' : `guest callback${callbacksDueCount > 1 ? 's' : ''} due` });
    if (dirtyRooms > 0) out.push({ n: dirtyRooms, text: ES ? 'habitaciones por limpiar' : `room${dirtyRooms > 1 ? 's' : ''} to clean` });
    if (lostFound && lostFound.nearingDisposal > 0) out.push({ n: lostFound.nearingDisposal, text: ES ? 'objetos por desechar' : 'lost items nearing disposal' });
    return out.slice(0, 5);
  }, [urgentOrders.length, compliance, overdueComplaints, callbacksDueCount, dirtyRooms, lostFound, ES]);
  const attnTotal = attention.reduce((a, x) => a + x.n, 0);

  // ── chart series ─────────────────────────────────────────────────────
  const history = useMemo<HistRow[]>(() => buildHistory(totalRooms, occPct), [totalRooms, occPct]);

  const [metric, setMetric] = useState<TodayMetricKey>('occ');
  const [range, setRange] = useState<typeof RANGES[number]['key']>('30d');
  const [hi, setHi] = useState<number | null>(null);
  const [room, setRoom] = useState<{ num: string; status: RingKey } | null>(null);
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

  // ring center: hovered room → its number+status; else the active metric
  const center = room
    ? { big: room.num, label: ES ? 'HABITACIÓN' : 'ROOM', sub: STATUS[room.status], color: RING[room.status] }
    : metric === 'occ'
      ? { big: Math.round(live.occ) + '%', label: ES ? 'OCUPACIÓN' : 'OCCUPANCY', sub: hov ? hov.d : (ES ? `${soldNow} de ${totalRooms} habitaciones` : `${soldNow} of ${totalRooms} rooms`), color: C.green }
      : { big: def.fmt === 'money' ? fmtCompact(live[metric]) : fmtVal(def.fmt, live[metric]), label: def.label.toUpperCase(), sub: hov ? hov.d : (ES ? 'hoy' : 'today'), color: def.color };

  const pill = (on: boolean): React.CSSProperties => ({
    padding: '6px 12px', borderRadius: 999, border: `1px solid ${C.line2}`, cursor: 'pointer',
    fontFamily: SANS, fontSize: 12, fontWeight: 600,
    background: on ? C.ink : 'transparent', color: on ? C.paper2 : C.ink2, transition: 'all .15s',
  });

  return (
    <AppLayout>
      <div className="stx-today" style={{ width: '100%', minHeight: '100vh', background: C.paper, fontFamily: SANS, color: C.ink, padding: 'clamp(16px, 2vw, 32px) clamp(16px, 3vw, 48px)' }}>
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

        <div style={{ maxWidth: 1440, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 26 }}>

          <StaleDataBanner />

          {/* slim top line: date + Reports */}
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16 }}>
            <span style={{ fontFamily: SERIF, fontStyle: 'italic', fontSize: 22, color: C.ink2, textTransform: 'capitalize' }}>{dateLong}</span>
            {canManageTeam(user.role) && (
              <button type="button" onClick={() => router.push('/settings/reports')}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 15px', borderRadius: 999, border: `1px solid ${C.line2}`, background: C.card, color: C.ink, fontFamily: SANS, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                {ES ? 'Reportes' : 'Reports'} →
              </button>
            )}
          </div>

          {/* hero: ring + chart */}
          <section className="stx-hero">
            <div onClick={() => { setMetric('occ'); setRoom(null); }} title={ES ? 'Graficar ocupación' : 'Chart occupancy'} style={{ position: 'relative', cursor: 'pointer' }}>
              <RoomRing rooms={ringRooms} onHover={setRoom} hovered={room} />
              <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                <div style={{ ...LABEL, fontSize: 10 }}>{center.label}</div>
                <div style={{ fontFamily: SERIF, fontStyle: 'italic', fontWeight: 500, fontSize: room ? 50 : 60, color: center.color, lineHeight: 1, margin: '6px 0 8px' }}>{center.big}</div>
                <div style={{ fontSize: 14, fontWeight: 500, color: C.ink2, whiteSpace: 'nowrap' }}>{center.sub}</div>
              </div>
            </div>

            <div style={{ width: '100%' }}>
              <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 14, gap: 12, flexWrap: 'wrap' }}>
                <div style={{ ...LABEL, marginBottom: 6 }}>{def.label} · {RG.full}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button onClick={togglePlay} title={playing ? (ES ? 'Pausar' : 'Pause') : (ES ? 'Reproducir' : 'Play through ' + RG.full)}
                    style={{ width: 36, height: 36, borderRadius: 18, border: 'none', cursor: 'pointer', flexShrink: 0, background: playing ? C.rust : def.color, color: '#fff', display: 'grid', placeItems: 'center', transition: 'background .15s' }}>
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
            </div>
          </section>

          {/* ring legend */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 20px', marginTop: -10 }}>
            {(['occupied', 'departing', 'arriving', 'clean', 'dirty', 'inprog'] as RingKey[]).filter(k => (ringCounts[k] || 0) > 0).map(k => (
              <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, color: C.ink2 }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: RING[k] }} />
                {STATUS[k]} <span style={{ fontFamily: MONO, color: C.ink3 }}>{ringCounts[k]}</span>
              </span>
            ))}
          </div>

          {/* KPI strip */}
          <section className="stx-kpis">
            {kpis.map((k, i) => {
              const mdef = METRIC_DEFS.find(m => m.key === k.key)!;
              const active = metric === k.key;
              const val = mdef.fmt === 'pct' ? Math.round(live[k.key]) + '%' : fmtMoney(live[k.key]);
              return (
                <div key={k.key} onClick={() => { setMetric(k.key); setRoom(null); }} title={`${ES ? 'Graficar' : 'Chart'} ${k.label}`}
                  style={{ padding: '20px 22px', borderLeft: i ? `1px solid ${C.line}` : 'none', cursor: 'pointer', background: active ? C.paper2 : 'transparent', boxShadow: active ? `inset 0 3px 0 ${mdef.color}` : 'none', transition: 'background .15s' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, minHeight: 14 }}>
                    <span style={LABEL}>{k.label}</span>
                    {active && <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 700, letterSpacing: '.08em', color: C.green }}><span style={{ width: 6, height: 6, borderRadius: 3, background: C.green }} />{ES ? 'EN GRÁFICO' : 'ON CHART'}</span>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                    <span style={{ fontFamily: SERIF, fontStyle: 'italic', fontWeight: 500, fontSize: 'clamp(32px, 3vw, 46px)', lineHeight: .95, color: k.tone, fontVariantNumeric: 'tabular-nums' }}>{val}</span>
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

          {/* right now + needs attention */}
          <section className="stx-now">
            <div>
              <div style={{ ...LABEL, marginBottom: 18 }}>{ES ? 'Ahora mismo' : 'Right now'}</div>
              <div className="stx-ops">
                {([
                  [ES ? 'Huéspedes' : 'Guests', inHouse, ES ? 'en casa' : 'in-house', C.green],
                  [ES ? 'Llegadas' : 'Arrivals', arrivals, ES ? 'esperadas' : 'expected', C.greenL],
                  [ES ? 'Salidas' : 'Departures', departures, ES ? 'saliendo' : 'checking out', C.gold],
                  [ES ? 'Limpieza' : 'Housekeeping', dirtyRooms, ES ? 'por limpiar' : 'rooms to clean', C.rust],
                  [ES ? 'Tiempo' : 'Turnover', avgTurnover ?? '—', ES ? 'min / hab.' : 'min / room', C.ink],
                ] as [string, React.ReactNode, string, string][]).map((o, i) => (
                  <div key={o[0]} style={{ flex: 1, minWidth: 90, paddingLeft: i ? 22 : 0, borderLeft: i ? `1px solid ${C.line}` : 'none' }}>
                    <OpsTile label={o[0]} value={o[1]} sub={o[2]} tone={o[3]} />
                  </div>
                ))}
              </div>
            </div>

            <div style={{ background: attention.length ? C.rustBg : '#E7EFE7', borderRadius: 16, padding: 22 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <span style={{ ...LABEL, color: attention.length ? C.rustD : C.green }}>{ES ? 'Necesita atención' : 'Needs attention'}</span>
                <span style={{ background: attention.length ? C.rust : C.green, color: '#fff', borderRadius: 999, minWidth: 24, height: 24, padding: '0 7px', display: 'grid', placeItems: 'center', fontSize: 13, fontWeight: 700 }}>{attnTotal}</span>
              </div>
              {attention.length ? attention.map((a, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '7px 0', borderTop: i ? '1px solid rgba(188,94,55,.2)' : 'none' }}>
                  <span style={{ fontFamily: SERIF, fontStyle: 'italic', fontWeight: 500, fontSize: 22, color: C.rust, minWidth: 22 }}>{a.n}</span>
                  <span style={{ fontSize: 13, color: C.rustD }}>{a.text}</span>
                </div>
              )) : (
                <div style={{ fontSize: 14, color: C.green, paddingTop: 2 }}>{ES ? 'Todo en orden.' : 'All clear — nothing needs you right now.'}</div>
              )}
            </div>
          </section>

          {/* month to date */}
          {mtd && (
            <section className="stx-mtd" style={{ borderTop: `1px solid ${C.line}`, paddingTop: 22 }}>
              <span style={{ fontFamily: SERIF, fontStyle: 'italic', fontSize: 20, color: C.ink2, width: 200, flexShrink: 0, textTransform: 'capitalize' }}>
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
                  <div style={{ fontFamily: SERIF, fontStyle: 'italic', fontWeight: 500, fontSize: 26, color: m[2], fontVariantNumeric: 'tabular-nums' }}>{m[1]}</div>
                </div>
              ))}
            </section>
          )}

        </div>
      </div>
    </AppLayout>
  );
}
