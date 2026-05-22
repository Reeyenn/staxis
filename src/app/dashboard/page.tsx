'use client';

// Owner dashboard — Aurora x Spotlight design (locked May 2026 in
// claude.ai/design as V35). The hero is a 30-day metric chart that
// reveals itself under a soft circular spotlight as the cursor moves;
// the aurora-style background blobs cross-fade their palette when the
// active metric changes. Beneath the chart, real-time operational
// counters keep the old dashboard's "what's happening right now" view.
//
// Data shape — the 30-day chart series currently comes from a
// deterministic mock (src/lib/dashboard/use-month-data.ts). Once
// daily_logs carries revenue/ADR/RevPAR/profit, swap the body of
// useMonthData() to read the real series — the visual won't change.

export const dynamic = 'force-dynamic';

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  subscribeToRooms,
  subscribeToWorkOrders,
  subscribeToHandoffLogs,
  subscribeToDashboardNumbers,
  type DashboardNumbers,
} from '@/lib/db';
import { useTodayStr } from '@/lib/use-today-str';
import { useMonthData, METRICS, type MetricKey, type DayRow } from '@/lib/dashboard/use-month-data';
import type { Room, WorkOrder, HandoffEntry } from '@/types';

// ─── Palette + per-metric color maps ───────────────────────────────────

const C = {
  panel:   '#FFFFFF',
  ink:     '#15191A',
  ink2:    '#586056',
  ink3:    '#9CA29C',
  rule:    'rgba(15,20,17,0.07)',
  sage:    '#3F7950',
  caramel: '#B8853A',
  warm:    '#B85C3D',
  profit:  '#2F5840',
} as const;

const METRIC_COLORS: Record<MetricKey, string> = {
  Occupancy: C.sage,
  Revenue:   C.caramel,
  ADR:       C.ink,
  RevPAR:    C.warm,
  Profit:    C.profit,
};

// Three-stop background palette per metric. The dashboard's three
// drifting blurred blobs each take one of these stops, so the page
// reads with that metric's mood when it's active.
const BG_BLOBS: Record<MetricKey, [string, string, string]> = {
  Occupancy: ['#A6D8B0', '#B8E0CB', '#E8F0E5'],
  Revenue:   ['#F5D8A0', '#F0C898', '#FAEED2'],
  ADR:       ['#D2D2D8', '#C6CDD3', '#E8E8EC'],
  RevPAR:    ['#F0BBA8', '#E8B098', '#F8DCC8'],
  Profit:    ['#A0C0A6', '#8FB397', '#D8E6D2'],
};

const FONT_SERIF = "var(--font-fraunces), Georgia, serif";
const FONT_MONO  = "var(--font-geist-mono), ui-monospace, monospace";
const FONT_SANS  = "var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif";

const LABEL: React.CSSProperties = {
  fontFamily: FONT_MONO,
  fontSize: 10,
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: C.ink3,
  fontWeight: 600,
};

// ─── Tiny inline sparkles icon (used in AI suggestion + Forecast pill) ──

function Sparkles({ size = 14, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.7}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l1.9 4.8L18.7 9l-4.8 1.2L12 15l-1.9-4.8L5.3 9l4.8-1.2L12 3zM18 14l.8 2 2 .8-2 .8L18 20l-.8-2-2-.8 2-.8.8-2zM5 14l.6 1.5 1.5.6-1.5.6L5 18l-.6-1.5L3 16l1.4-.5L5 14z" />
    </svg>
  );
}

// ─── ResizeObserver hook so the chart SVG re-fits its container ────────
//
// Critical for the "feels alive at any window size" feel Reeyen called
// out in the design chat. Without this the chart would either overflow
// at small widths or sit cramped at large ones.

function useElementWidth<T extends HTMLElement = HTMLDivElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const measure = () => {
      if (ref.current) setW(ref.current.getBoundingClientRect().width);
    };
    measure();
    const obs = new ResizeObserver(measure);
    obs.observe(ref.current);
    // Belt-and-suspenders: also poll once on the next frame in case the
    // first commit raced past the observer's first fire.
    const raf = requestAnimationFrame(measure);
    return () => {
      obs.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);
  return [ref, w];
}

// ─── Spotlight chart ───────────────────────────────────────────────────
//
// The whole chart is dim by default; an SVG mask carves out a soft
// circular "spotlight" around the cursor that exposes the colored line
// + per-day value labels underneath. Moving the cursor IS the
// interaction — no click required, no toggle. The cursor position maps
// back to chart coordinates by ratio so the spotlight tracks 1:1 even
// when the SVG is downscaled by its container.

interface SpotlightChartProps {
  days: DayRow[];
  scrub: number;
  setScrub: (i: number) => void;
  metric: MetricKey;
  width: number;
  height: number;
  todayIdx: number;
}

function SpotlightChart({ days, scrub, setScrub, metric, width, height, todayIdx }: SpotlightChartProps) {
  const m = METRICS[metric];
  const color = METRIC_COLORS[metric];
  const vals = days.map(d => d[m.key] as number);
  const min = Math.min(...vals) * 0.92;
  const max = Math.max(...vals) * 1.05;
  const span = max - min || 1;
  const stepX = days.length > 1 ? width / (days.length - 1) : width;
  const pts: [number, number][] = days.map((d, i) => [
    i * stepX,
    height - (((d[m.key] as number) - min) / span) * height,
  ]);
  const path = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = `${path} L ${width} ${height} L 0 ${height} Z`;

  const svgRef = useRef<SVGSVGElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    const safe = Math.max(0, Math.min(days.length - 1, scrub));
    return { x: safe * stepX, y: pts[safe]?.[1] ?? height / 2 };
  });

  // Keep the spotlight position in sync when scrub / metric / width
  // changes externally (e.g. user clicks a stat card to switch metric
  // or the window resizes mid-hover).
  useEffect(() => {
    const safe = Math.max(0, Math.min(days.length - 1, scrub));
    setPos({ x: safe * stepX, y: pts[safe]?.[1] ?? height / 2 });
    // pts is derived from days/metric/width — the effect re-runs when
    // those change, which is what we want.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrub, metric, width]);

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const ratio = rect.width > 0 ? width / rect.width : 1;
    const x = (e.clientX - rect.left) * ratio;
    const idx = Math.max(0, Math.min(days.length - 1, Math.round(x / stepX)));
    setScrub(idx);
    setPos({ x: idx * stepX, y: pts[idx][1] });
  };

  // Spotlight radius scales gently with chart width so a narrow phone
  // viewport gets a smaller halo and a wide TV gets a bigger one.
  const spotR = Math.min(180, Math.max(110, width * 0.10));

  return (
    <svg
      ref={svgRef}
      width={width}
      height={height + 32}
      style={{ overflow: 'visible', cursor: 'crosshair', userSelect: 'none', display: 'block' }}
      onMouseMove={handleMove}
      onClick={handleMove}
      onMouseDown={handleMove}
    >
      <defs>
        <radialGradient id="aurora-spot" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stopColor="#fff" stopOpacity={1} />
          <stop offset="60%" stopColor="#fff" stopOpacity={0.85} />
          <stop offset="100%" stopColor="#fff" stopOpacity={0} />
        </radialGradient>
        <mask id="aurora-mask">
          <rect x={0} y={0} width={width} height={height} fill="black" />
          <circle cx={pos.x} cy={pos.y} r={spotR} fill="url(#aurora-spot)" />
        </mask>
        <linearGradient id="aurora-lit" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.32} />
          <stop offset="100%" stopColor={color} stopOpacity={0.02} />
        </linearGradient>
        <linearGradient id="aurora-dim" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#A097A0" stopOpacity={0.18} />
          <stop offset="100%" stopColor="#A097A0" stopOpacity={0.01} />
        </linearGradient>
      </defs>

      {/* Dim background layer — visible outside the spotlight */}
      <path d={area} fill="url(#aurora-dim)" />
      <path d={path} fill="none" stroke={C.ink3} strokeWidth={1.5} strokeLinecap="round" opacity={0.55} />
      {pts.map((p, i) => i % 3 === 0 ? (
        <circle key={`dim-${i}`} cx={p[0]} cy={p[1]} r={2.5} fill={C.ink3} opacity={0.5} />
      ) : null)}

      {/* Lit layer — visible only through the spotlight mask */}
      <g mask="url(#aurora-mask)">
        <path d={area} fill="url(#aurora-lit)" />
        <path d={path} fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" />
        {pts.map((p, i) => (
          <g key={`lit-${i}`}>
            <circle cx={p[0]} cy={p[1]} r={4} fill="#fff" stroke={color} strokeWidth={2} />
            <text x={p[0]} y={p[1] - 12} fontSize={11} textAnchor="middle"
              fontFamily={FONT_MONO} fill={C.ink} fontWeight={600}>
              {m.format(days[i][m.key] as number)}
            </text>
            <text x={p[0]} y={height + 14} fontSize={10} textAnchor="middle"
              fontFamily={FONT_MONO} fill={C.ink2} fontWeight={500} letterSpacing="0.06em">
              {days[i].day}
            </text>
          </g>
        ))}
      </g>

      {/* Soft halo ring at the cursor + the today vertical guide */}
      <circle cx={pos.x} cy={pos.y} r={spotR} fill="none" stroke={`${color}33`} strokeWidth={1.5} strokeDasharray="3 5" />
      {todayIdx >= 0 && pts[todayIdx] && (
        <line x1={pts[todayIdx][0]} x2={pts[todayIdx][0]} y1={0} y2={height}
          stroke={C.caramel} strokeWidth={1.2} strokeDasharray="2 4" opacity={0.45} />
      )}
      <circle cx={pos.x} cy={pos.y} r={10} fill={color} stroke="#fff" strokeWidth={4} />
      <circle cx={pos.x} cy={pos.y} r={4} fill="#fff" opacity={0.95} />

      {/* Always-on day labels (every 5th day) so the chart has X-axis ticks */}
      {days.map((d, i) => i % 5 === 0 ? (
        <text key={`xlbl-${i}`} x={i * stepX} y={height + 22} fontSize={10}
          fontFamily={FONT_MONO} fill={C.ink3} fontWeight={400}
          textAnchor="middle" letterSpacing="0.06em">{d.day}</text>
      ) : null)}
    </svg>
  );
}

// ─── Page component ───────────────────────────────────────────────────

export default function DashboardPage() {
  const { user, loading: authLoading } = useAuth();
  const { activeProperty, activePropertyId, loading: propLoading } = useProperty();
  const { lang } = useLang();
  const router = useRouter();
  const today = useTodayStr();

  const totalRooms = activeProperty?.totalRooms || 108;
  const { days, todayIdx } = useMonthData(totalRooms);
  const [metric, setMetric] = useState<MetricKey>('Occupancy');
  const [scrub, setScrub] = useState<number>(todayIdx);

  // Reset scrub when the underlying month re-builds (e.g. property
  // changes mid-session → totalRooms changes → days regenerate).
  useEffect(() => {
    setScrub(todayIdx);
  }, [todayIdx]);

  const cur = days[scrub];
  const m = METRICS[metric];
  const accent = METRIC_COLORS[metric];
  const blobs = BG_BLOBS[metric];

  const [chartHostRef, chartHostW] = useElementWidth<HTMLDivElement>();
  // Fall back to a sensible default while ResizeObserver hasn't fired yet
  // (first commit, suspended hydration, etc.) — without this, the chart
  // would render conditionally and a slow first measure would leave the
  // card visually empty.
  const chartWidth = Math.max(320, chartHostW || 1200);
  const chartHeight = 250;

  // ── Real-time subscriptions (preserved from the old Snow dashboard) ──

  const [rooms, setRooms] = useState<Room[]>([]);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [handoffs, setHandoffs] = useState<HandoffEntry[]>([]);
  const [dashboardNums, setDashboardNums] = useState<DashboardNumbers | null>(null);

  useEffect(() => {
    if (!authLoading && !propLoading && !user) router.replace('/signin');
    if (!authLoading && !propLoading && user && !activePropertyId) router.replace('/onboarding');
  }, [user, authLoading, propLoading, activePropertyId, router]);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeToRooms(user.uid, activePropertyId, today, setRooms);
  }, [user, activePropertyId, today]);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeToWorkOrders(user.uid, activePropertyId, setWorkOrders);
  }, [user, activePropertyId]);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeToHandoffLogs(user.uid, activePropertyId, setHandoffs);
  }, [user, activePropertyId]);

  useEffect(() => subscribeToDashboardNumbers(setDashboardNums), []);

  // ── Computed ops counters ────────────────────────────────────────────

  const openOrders   = workOrders.filter(o => o.status === 'open');
  const urgentOrders = openOrders.filter(o => o.priority === 'urgent');
  const clean        = rooms.filter(r => r.status === 'clean' || r.status === 'inspected').length;
  const inProgress   = rooms.filter(r => r.status === 'in_progress').length;
  const dirty        = rooms.filter(r => r.status === 'dirty').length;
  const inHouse      = dashboardNums?.inHouse ?? 0;
  const arrivals     = dashboardNums?.arrivals ?? 0;
  const departures   = dashboardNums?.departures ?? 0;

  // Average turnover (minutes) across rooms with both startedAt + completedAt.
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
      .map(r => {
        const s = toMs(r.startedAt);
        const e = toMs(r.completedAt);
        if (!s || !e) return 0;
        return (e - s) / 60000;
      })
      .filter(mins => mins > 0 && mins < 480);
    return timed.length > 0 ? Math.round(timed.reduce((a, b) => a + b, 0) / timed.length) : null;
  }, [rooms]);

  // Briefing — top 4 most recent items from handoffs + open work orders.
  const briefingItems = useMemo(() => {
    type Item = { id: string; time: Date; tone: 'sage' | 'caramel' | 'warm'; text: string };
    const items: Item[] = [];
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const safeDate = (raw: unknown): Date | null => {
      if (!raw) return null;
      if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;
      if (typeof raw === 'object' && raw !== null && 'toDate' in raw &&
          typeof (raw as { toDate?: unknown }).toDate === 'function') {
        const d = (raw as { toDate: () => Date }).toDate();
        return isNaN(d.getTime()) ? null : d;
      }
      if (typeof raw === 'string' || typeof raw === 'number') {
        const d = new Date(raw);
        return isNaN(d.getTime()) ? null : d;
      }
      return null;
    };

    handoffs.forEach(h => {
      const d = safeDate(h.createdAt);
      if (!d || d < cutoff) return;
      items.push({ id: `h-${h.id}`, time: d, tone: 'sage', text: `${h.shiftType}: ${h.notes}` });
    });

    openOrders.forEach(o => {
      const d = safeDate(o.createdAt);
      if (!d) return;
      const tone: 'warm' | 'caramel' = o.priority === 'urgent' ? 'warm' : 'caramel';
      const where = /^\d{1,4}$/.test(o.location.trim()) ? `Rm ${o.location.trim()}` : o.location;
      items.push({ id: `wo-${o.id}`, time: d, tone, text: `${where}: ${o.description}` });
    });

    return items.sort((a, b) => b.time.getTime() - a.time.getTime()).slice(0, 4);
  }, [handoffs, openOrders]);

  // ── Localized strings ────────────────────────────────────────────────

  const locale = lang === 'es' ? 'es-MX' : 'en-US';
  const monthName = new Date().toLocaleDateString(locale, { month: 'long' });
  const monthCap = monthName.charAt(0).toUpperCase() + monthName.slice(1);
  const headerTitle = lang === 'es' ? `${monthCap} de un vistazo.` : `${monthCap} at a glance.`;
  const cursorHint  = lang === 'es' ? 'Mueve el cursor por el gráfico' : 'Move your cursor across the chart';
  const tForecast   = lang === 'es' ? 'Pronóstico' : 'Forecast';
  const tToday      = lang === 'es' ? 'Hoy' : 'Today';
  const tDaysAgo    = (n: number) => lang === 'es' ? `Hace ${n} día${n === 1 ? '' : 's'}` : `${n} day${n === 1 ? '' : 's'} ago`;
  const tRightNow   = lang === 'es' ? 'Ahora mismo' : 'Right now';
  const tGuests     = lang === 'es' ? 'Huéspedes' : 'Guests';
  const tInHouse    = lang === 'es' ? 'En casa' : 'In-house';
  const tArrivals   = lang === 'es' ? 'Llegadas' : 'Arrivals';
  const tDepartures = lang === 'es' ? 'Salidas' : 'Departures';
  const tRoomsLabel = lang === 'es' ? 'Habitaciones' : 'Rooms';
  const tClean      = lang === 'es' ? 'Limpias' : 'Clean';
  const tDirty      = lang === 'es' ? 'Sucias' : 'Dirty';
  const tInProgress = lang === 'es' ? 'En curso' : 'In progress';
  const tWorkOrders = lang === 'es' ? 'Órdenes de trabajo' : 'Work orders';
  const tOpen       = lang === 'es' ? 'Abiertas' : 'Open';
  const tUrgent     = lang === 'es' ? 'Urgentes' : 'Urgent';
  const tAvgTurn    = lang === 'es' ? 'Tiempo promedio' : 'Avg turnover';
  const tMin        = lang === 'es' ? 'min' : 'min';
  const tBriefing   = lang === 'es' ? 'Resumen' : 'Briefing';
  const tEmptyBrief = lang === 'es' ? 'Sin novedades en las últimas 24 horas.' : 'Nothing new in the last 24 hours.';
  const metricLabels: Record<MetricKey, string> = lang === 'es'
    ? { Occupancy: 'Ocupación', Revenue: 'Ingresos', ADR: 'ADR', RevPAR: 'RevPAR', Profit: 'Beneficio' }
    : { Occupancy: 'Occupancy', Revenue: 'Revenue', ADR: 'ADR', RevPAR: 'RevPAR', Profit: 'Profit' };
  const metricSublabel = metricLabels[metric].toLowerCase();

  // ── Auth gate before rendering anything ──────────────────────────────

  if (authLoading || propLoading) {
    return (
      <AppLayout>
        <div style={{ padding: 24, fontFamily: FONT_SANS, color: C.ink3 }} />
      </AppLayout>
    );
  }
  if (!user || !activePropertyId) {
    return (
      <AppLayout>
        <div style={{ padding: 24, fontFamily: FONT_SANS, color: C.ink3 }} />
      </AppLayout>
    );
  }

  // ── Big-day badge (Forecast / Today / X days ago) ────────────────────

  const dayDelta = todayIdx - scrub;
  const badgeText = cur?.isFuture ? tForecast : cur?.isToday ? tToday : tDaysAgo(Math.max(1, dayDelta));
  const badgeBg = cur?.isFuture ? 'rgba(63,121,80,0.15)'
                 : cur?.isToday ? 'rgba(184,133,58,0.15)'
                 : 'rgba(0,0,0,0.05)';
  const badgeColor = cur?.isFuture ? C.sage : cur?.isToday ? C.caramel : C.ink2;

  // ── AI suggestion copy (varies past / today / future) ────────────────

  const aiCopy = (() => {
    if (!cur) return null;
    if (cur.isFuture) {
      if (cur.occ >= 90) {
        return lang === 'es'
          ? <>Día fuerte — sube la tarifa a <b style={{ color: accent, fontStyle: 'normal' }}>${cur.adr + 10}</b>.</>
          : <>Strong day — raise rate to <b style={{ color: accent, fontStyle: 'normal' }}>${cur.adr + 10}</b>.</>;
      }
      if (cur.occ >= 80) {
        return lang === 'es' ? 'Estable — mantén la tarifa.' : 'Steady — hold rate.';
      }
      return lang === 'es'
        ? <>Bajo. Un descuento de <b style={{ color: accent, fontStyle: 'normal' }}>$10</b> lo llena.</>
        : <>Soft. <b style={{ color: accent, fontStyle: 'normal' }}>$10 discount</b> fills it.</>;
    }
    if (cur.isToday) {
      return lang === 'es'
        ? <>Hoy en camino a <b style={{ color: accent, fontStyle: 'normal' }}>{cur.occ}%</b>.</>
        : <>Today on track for <b style={{ color: accent, fontStyle: 'normal' }}>{cur.occ}%</b>.</>;
    }
    return lang === 'es'
      ? <>Cerró en <b style={{ color: accent, fontStyle: 'normal' }}>{cur.occ}%</b>.</>
      : <>Closed at <b style={{ color: accent, fontStyle: 'normal' }}>{cur.occ}%</b>.</>;
  })();

  // ── Stat cards definition ───────────────────────────────────────────

  const statCards: { k: MetricKey; v: string; sub: string; color: string }[] = [
    {
      k: 'Occupancy',
      v: `${cur?.occ ?? 0}%`,
      sub: lang === 'es' ? `${cur?.rooms ?? 0} de ${totalRooms} habitaciones` : `${cur?.rooms ?? 0} of ${totalRooms} rooms`,
      color: C.sage,
    },
    {
      k: 'Revenue',
      v: `$${((cur?.revenue ?? 0)).toLocaleString('en-US')}`,
      sub: `${cur?.rooms ?? 0} × $${cur?.adr ?? 0}`,
      color: C.caramel,
    },
    {
      k: 'ADR',
      v: `$${cur?.adr ?? 0}`,
      sub: lang === 'es' ? 'tarifa este día' : 'rate this day',
      color: C.ink,
    },
    {
      k: 'RevPAR',
      v: `$${cur?.revpar ?? 0}`,
      sub: lang === 'es' ? `en las ${totalRooms}` : `across all ${totalRooms}`,
      color: C.warm,
    },
    {
      k: 'Profit',
      v: `$${((cur?.profit ?? 0)).toLocaleString('en-US')}`,
      sub: lang === 'es' ? 'margen del 37%' : '37% margin',
      color: C.profit,
    },
  ];

  // Bottom ops cards — real-time, no aurora animation, calm glass surface.
  const opsCards = [
    {
      label: tGuests,
      lines: [
        { k: tInHouse, v: inHouse },
        { k: tArrivals, v: arrivals },
        { k: tDepartures, v: departures },
      ],
    },
    {
      label: tRoomsLabel,
      lines: [
        { k: tClean, v: clean },
        { k: tDirty, v: dirty },
        { k: tInProgress, v: inProgress },
      ],
    },
    {
      label: tWorkOrders,
      lines: [
        { k: tOpen, v: openOrders.length },
        { k: tUrgent, v: urgentOrders.length },
      ],
    },
    {
      label: tAvgTurn,
      lines: [
        { k: tMin, v: avgTurnover ?? '—' },
      ],
    },
  ];

  // ── Render ──────────────────────────────────────────────────────────

  return (
    <AppLayout>
      <div style={{
        width: '100%',
        minHeight: 'calc(100vh - 56px)',
        background: '#F8F8F5',
        padding: 'clamp(16px, 2.5vw, 36px)',
        fontFamily: FONT_SANS,
        color: C.ink,
        overflow: 'hidden',
        position: 'relative',
      }}>
        <style>{`
          @keyframes aurora-drift-1 { 0%, 100% { transform: translate(0, 0); } 50% { transform: translate(80px, -50px); } }
          @keyframes aurora-drift-2 { 0%, 100% { transform: translate(0, 0); } 50% { transform: translate(-60px, 60px); } }
          @keyframes aurora-drift-3 { 0%, 100% { transform: translate(0, 0); } 50% { transform: translate(40px, 40px); } }
          @media (prefers-reduced-motion: reduce) {
            .aurora-blob { animation: none !important; }
          }
        `}</style>

        {/* Three drifting aurora blobs, color-fading on metric change */}
        <div className="aurora-blob" style={{
          position: 'absolute', top: -160, left: -120, width: 700, height: 700,
          background: `radial-gradient(circle, ${blobs[0]} 0%, transparent 65%)`,
          filter: 'blur(40px)', pointerEvents: 'none',
          animation: 'aurora-drift-1 18s ease-in-out infinite',
          transition: 'background 1.2s ease',
        }} />
        <div className="aurora-blob" style={{
          position: 'absolute', top: -100, right: -120, width: 760, height: 760,
          background: `radial-gradient(circle, ${blobs[1]} 0%, transparent 60%)`,
          filter: 'blur(40px)', pointerEvents: 'none',
          animation: 'aurora-drift-2 22s ease-in-out infinite',
          transition: 'background 1.2s ease',
        }} />
        <div className="aurora-blob" style={{
          position: 'absolute', bottom: -240, left: '30%', width: 800, height: 800,
          background: `radial-gradient(circle, ${blobs[2]} 0%, transparent 60%)`,
          filter: 'blur(40px)', pointerEvents: 'none',
          animation: 'aurora-drift-3 26s ease-in-out infinite',
          transition: 'background 1.2s ease',
        }} />

        <div style={{ position: 'relative', maxWidth: 1600, margin: '0 auto' }}>

          {/* Header strip — matches the Claude Design layout: empty-left
              spacer (AppLayout already shows the Staxis chevron + property
              name in the top nav, so we drop the design's redundant left
              cluster), centered italic-serif title, right cursor hint. */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 22, gap: 16, flexWrap: 'wrap',
          }}>
            <span style={LABEL} aria-hidden />
            <h1 style={{
              margin: 0, fontFamily: FONT_SERIF, fontSize: 26, fontWeight: 400,
              fontStyle: 'italic', color: C.ink2, letterSpacing: '-0.01em',
            }}>
              {headerTitle}
            </h1>
            <span style={LABEL}>{cursorHint}</span>
          </div>

          {/* Chart card */}
          <div style={{
            background: 'rgba(255,255,255,0.85)',
            backdropFilter: 'blur(30px) saturate(140%)',
            WebkitBackdropFilter: 'blur(30px) saturate(140%)',
            border: '1px solid rgba(255,255,255,0.8)',
            borderRadius: 22,
            padding: '26px 32px 22px',
            marginBottom: 16,
            boxShadow: '0 1px 0 rgba(255,255,255,0.7) inset, 0 30px 60px -30px rgba(15,20,17,0.18)',
          }}>
            {/* Top row — exact layout from the locked Claude Design JSX:
                small uppercase mono date label + big italic-serif number on
                the LEFT, small Today/Forecast/X-days-ago pill on the RIGHT. */}
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-end',
              marginBottom: 4,
              gap: 12,
              flexWrap: 'wrap',
            }}>
              <div>
                <div style={LABEL}>
                  {cur
                    ? `${cur.date.toLocaleDateString(locale, { weekday: 'long' }).toUpperCase()} · ${cur.date.toLocaleDateString(locale, { month: 'short' }).toUpperCase()} ${cur.day}`
                    : ''}
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginTop: 6 }}>
                  <span style={{
                    fontFamily: FONT_SERIF,
                    fontSize: 76, lineHeight: 1, fontWeight: 500, fontStyle: 'italic',
                    letterSpacing: '-0.035em',
                    color: accent, transition: 'color 0.4s ease',
                  }}>
                    {cur ? m.format(cur[m.key] as number) : '—'}
                  </span>
                  <span style={{ fontSize: 16, color: C.ink2, fontStyle: 'italic', paddingBottom: 12 }}>
                    {metricSublabel}
                  </span>
                </div>
              </div>
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '5px 12px', borderRadius: 999,
                background: badgeBg, color: badgeColor,
                fontSize: 11, fontWeight: 700, fontFamily: FONT_MONO,
                letterSpacing: '0.14em', textTransform: 'uppercase',
              }}>
                {cur?.isFuture && <Sparkles size={11} color={C.sage} />}
                {badgeText}
              </span>
            </div>

            {/* Host div is what the chart fits to */}
            <div ref={chartHostRef} style={{ padding: '16px 0 4px', width: '100%' }}>
              {cur && (
                <SpotlightChart
                  days={days}
                  scrub={scrub}
                  setScrub={setScrub}
                  metric={metric}
                  width={chartWidth}
                  height={chartHeight}
                  todayIdx={todayIdx}
                />
              )}
            </div>
          </div>

          {/* Stat cards — clicking switches metric */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 12,
          }}>
            {statCards.map(row => {
              const isActive = row.k === metric;
              return (
                <button key={row.k} type="button" onClick={() => setMetric(row.k)} style={{
                  textAlign: 'left', cursor: 'pointer',
                  background: isActive ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.7)',
                  backdropFilter: 'blur(20px)',
                  WebkitBackdropFilter: 'blur(20px)',
                  border: `1px solid ${isActive ? `${row.color}66` : 'rgba(255,255,255,0.7)'}`,
                  borderRadius: 14, padding: '14px 16px',
                  boxShadow: isActive
                    ? `0 8px 18px -8px ${row.color}66, 0 1px 0 rgba(255,255,255,0.7) inset`
                    : '0 1px 0 rgba(255,255,255,0.6) inset',
                  transition: 'all 0.25s ease',
                  fontFamily: FONT_SANS,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: row.color }} />
                    <span style={{ ...LABEL, color: isActive ? row.color : C.ink3 }}>{metricLabels[row.k]}</span>
                  </div>
                  <div style={{
                    fontFamily: FONT_SERIF, fontStyle: 'italic',
                    fontSize: 28, fontWeight: 500, letterSpacing: '-0.025em',
                    color: row.color, lineHeight: 1, marginTop: 6,
                  }}>
                    {row.v}
                  </div>
                  <div style={{ fontSize: 11, color: C.ink2, marginTop: 4 }}>{row.sub}</div>
                </button>
              );
            })}

            {/* Staxis AI suggestion card */}
            <div style={{
              background: 'rgba(255,255,255,0.7)',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              border: `1px solid ${accent}33`,
              borderRadius: 14, padding: '12px 16px',
              transition: 'border-color 0.4s ease',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Sparkles size={11} color={accent} />
                <span style={{ ...LABEL, color: accent, transition: 'color 0.4s ease' }}>Staxis</span>
              </div>
              <p style={{
                margin: '6px 0 0',
                fontFamily: FONT_SERIF, fontStyle: 'italic',
                fontSize: 14, color: C.ink, lineHeight: 1.35, letterSpacing: '-0.005em',
              }}>
                {aiCopy}
              </p>
            </div>
          </div>

          {/* ── Operational counters (real-time) ───────────────────── */}
          <div style={{ marginTop: 28 }}>
            <div style={{ ...LABEL, marginBottom: 12 }}>{tRightNow}</div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 12,
            }}>
              {opsCards.map(card => (
                <div key={card.label} style={{
                  background: 'rgba(255,255,255,0.7)',
                  backdropFilter: 'blur(20px)',
                  WebkitBackdropFilter: 'blur(20px)',
                  border: '1px solid rgba(255,255,255,0.7)',
                  borderRadius: 14, padding: '14px 16px',
                  boxShadow: '0 1px 0 rgba(255,255,255,0.6) inset',
                }}>
                  <div style={LABEL}>{card.label}</div>
                  <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {card.lines.map(line => (
                      <div key={line.k} style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                        fontFamily: FONT_SANS, fontSize: 13, color: C.ink2,
                      }}>
                        <span>{line.k}</span>
                        <span style={{
                          fontFamily: FONT_MONO, fontSize: 16, fontWeight: 600, color: C.ink,
                          letterSpacing: '-0.01em',
                        }}>
                          {line.v}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Briefing — recent activity from handoffs + work orders */}
            <div style={{
              marginTop: 16,
              background: 'rgba(255,255,255,0.7)',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              border: '1px solid rgba(255,255,255,0.7)',
              borderRadius: 14, padding: '14px 18px',
              boxShadow: '0 1px 0 rgba(255,255,255,0.6) inset',
            }}>
              <div style={LABEL}>{tBriefing}</div>
              {briefingItems.length === 0 ? (
                <div style={{ marginTop: 10, fontSize: 13, color: C.ink3, fontStyle: 'italic' }}>
                  {tEmptyBrief}
                </div>
              ) : (
                <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {briefingItems.map(item => {
                    const dotColor = item.tone === 'warm' ? C.warm : item.tone === 'caramel' ? C.caramel : C.sage;
                    return (
                      <li key={item.id} style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                        <span style={{
                          width: 8, height: 8, borderRadius: '50%', background: dotColor,
                          flexShrink: 0, marginTop: 2,
                        }} />
                        <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: C.ink, lineHeight: 1.45 }}>
                          {item.text}
                        </span>
                        <span style={{
                          marginLeft: 'auto', fontFamily: FONT_MONO, fontSize: 11, color: C.ink3,
                          letterSpacing: '0.04em', flexShrink: 0,
                        }}>
                          {item.time.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>

        </div>
      </div>
    </AppLayout>
  );
}
