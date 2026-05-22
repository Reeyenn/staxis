'use client';

// Owner dashboard — 1:1 port of the second-round V35 Aurora x Spotlight
// design Reeyen locked in claude.ai/design. Source files in the design
// handoff bundle: final/dashboard.jsx, shared.jsx, final/dashboard.html.
// Visual stays EXACTLY as Claude Design shipped it — no extra sections,
// no integrations, no "improvements". The Right Now section is now part
// of the design and is wired to live Supabase data (was static mocks in
// the design's shared.jsx).

export const dynamic = 'force-dynamic';

import React, { useEffect, useState, useRef, useMemo } from 'react';
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

// ─── Palette + per-metric color maps (verbatim from design source) ────

const C = {
  panel:   '#FFFFFF',
  ink:     '#15191A',
  ink2:    '#586056',
  ink3:    '#9CA29C',
  rule:    'rgba(15,20,17,0.07)',
  sage:    '#3F7950',
  sageBg:  '#E8F0E5',
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

const fmtMoney = (n: number) => '$' + n.toLocaleString('en-US');

// ─── Sparkles icon (verbatim from shared.jsx) ────────────────────────

function Sparkles({ size = 14, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.7}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l1.9 4.8L18.7 9l-4.8 1.2L12 15l-1.9-4.8L5.3 9l4.8-1.2L12 3zM18 14l.8 2 2 .8-2 .8L18 20l-.8-2-2-.8 2-.8.8-2zM5 14l.6 1.5 1.5.6-1.5.6L5 18l-.6-1.5L3 16l1.4-.5L5 14z" />
    </svg>
  );
}

// ─── useElementWidth (matches design, with useEffect + RAF for prod) ──

function useElementWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const measure = () => {
      if (ref.current) setW(ref.current.getBoundingClientRect().width);
    };
    measure();
    const obs = new ResizeObserver(measure);
    obs.observe(ref.current);
    const raf = requestAnimationFrame(measure);
    return () => {
      obs.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);
  return [ref, w];
}

// ─── SpotlightChart (verbatim from dashboard.jsx, typed) ───────────────

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

  useEffect(() => {
    const safe = Math.max(0, Math.min(days.length - 1, scrub));
    setPos({ x: safe * stepX, y: pts[safe]?.[1] ?? height / 2 });
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

  const spotR = Math.min(180, Math.max(110, width * 0.10));

  return (
    <svg ref={svgRef}
      viewBox={`0 0 ${width} ${height + 32}`}
      preserveAspectRatio="none"
      style={{
        overflow: 'visible',
        cursor: 'crosshair',
        userSelect: 'none',
        display: 'block',
        width: '100%',
        height: height + 32,
      }}
      onMouseMove={handleMove} onClick={handleMove} onMouseDown={handleMove}>
      <defs>
        <radialGradient id="v35-spot" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%"  stopColor="#fff" stopOpacity={1} />
          <stop offset="60%" stopColor="#fff" stopOpacity={0.85} />
          <stop offset="100%" stopColor="#fff" stopOpacity={0} />
        </radialGradient>
        <mask id="v35-mask">
          <rect x={0} y={0} width={width} height={height} fill="black" />
          <circle cx={pos.x} cy={pos.y} r={spotR} fill="url(#v35-spot)" />
        </mask>
        <linearGradient id="v35-lit" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.32} />
          <stop offset="100%" stopColor={color} stopOpacity={0.02} />
        </linearGradient>
        <linearGradient id="v35-dim" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#A097A0" stopOpacity={0.18} />
          <stop offset="100%" stopColor="#A097A0" stopOpacity={0.01} />
        </linearGradient>
      </defs>

      <path d={area} fill="url(#v35-dim)" />
      <path d={path} fill="none" stroke={C.ink3} strokeWidth={1.5} strokeLinecap="round" opacity={0.55} />
      {pts.map((p, i) => i % 3 === 0 ? (
        <circle key={`dim-${i}`} cx={p[0]} cy={p[1]} r={2.5} fill={C.ink3} opacity={0.5} />
      ) : null)}

      <g mask="url(#v35-mask)">
        <path d={area} fill="url(#v35-lit)" />
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

      <circle cx={pos.x} cy={pos.y} r={spotR} fill="none" stroke={`${color}33`} strokeWidth={1.5} strokeDasharray="3 5" />
      {todayIdx >= 0 && pts[todayIdx] && (
        <line x1={pts[todayIdx][0]} x2={pts[todayIdx][0]} y1={0} y2={height}
          stroke={C.caramel} strokeWidth={1.2} strokeDasharray="2 4" opacity={0.45} />
      )}
      <circle cx={pos.x} cy={pos.y} r={10} fill={color} stroke="#fff" strokeWidth={4} />
      <circle cx={pos.x} cy={pos.y} r={4} fill="#fff" opacity={0.95} />

      {days.map((d, i) => i % 5 === 0 ? (
        <text key={`xlbl-${i}`} x={i * stepX} y={height + 22} fontSize={10}
          fontFamily={FONT_MONO} fill={C.ink3} fontWeight={400}
          textAnchor="middle" letterSpacing="0.06em">{d.day}</text>
      ) : null)}
    </svg>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { user, loading: authLoading } = useAuth();
  const { activeProperty, activePropertyId, loading: propLoading } = useProperty();
  const { lang } = useLang();
  const router = useRouter();
  const today = useTodayStr();

  useEffect(() => {
    if (!authLoading && !propLoading && !user) router.replace('/signin');
    if (!authLoading && !propLoading && user && !activePropertyId) router.replace('/onboarding');
  }, [user, authLoading, propLoading, activePropertyId, router]);

  const totalRooms = activeProperty?.totalRooms || 108;
  const { days, todayIdx } = useMonthData(totalRooms);
  const [metric, setMetric] = useState<MetricKey>('Occupancy');
  const [scrub, setScrub] = useState<number>(todayIdx);
  useEffect(() => { setScrub(todayIdx); }, [todayIdx]);

  const cur = days[scrub];
  const m = METRICS[metric];
  const accent = METRIC_COLORS[metric];
  const blobs = BG_BLOBS[metric];
  const [chartHostRef, chartHostW] = useElementWidth();
  const chartWidth = Math.max(320, chartHostW || 1200);
  const chartHeight = 250;

  // ── Real-time data for the "Right now" strip ─────────────────────
  const [rooms, setRooms] = useState<Room[]>([]);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [, setHandoffs] = useState<HandoffEntry[]>([]);
  const [dashboardNums, setDashboardNums] = useState<DashboardNumbers | null>(null);

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

  const openOrders   = workOrders.filter(o => o.status === 'open');
  const urgentOrders = openOrders.filter(o => o.priority === 'urgent');
  const cleanRooms   = rooms.filter(r => r.status === 'clean' || r.status === 'inspected').length;
  const dirtyRooms   = rooms.filter(r => r.status === 'dirty').length;
  const inHouse      = dashboardNums?.inHouse ?? 0;
  const arrivals     = dashboardNums?.arrivals ?? 0;
  const departures   = dashboardNums?.departures ?? 0;
  const readyPct     = totalRooms > 0 ? Math.round((cleanRooms / totalRooms) * 100) : 0;

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
        const s = toMs(r.startedAt); const e = toMs(r.completedAt);
        if (!s || !e) return 0;
        return (e - s) / 60000;
      })
      .filter(mins => mins > 0 && mins < 480);
    return timed.length > 0 ? Math.round(timed.reduce((a, b) => a + b, 0) / timed.length) : null;
  }, [rooms]);

  if (authLoading || propLoading || !user || !activePropertyId) {
    return <AppLayout><div /></AppLayout>;
  }

  const dayDelta = todayIdx - scrub;
  const monthShort = new Date().toLocaleDateString('en-US', { month: 'short' }).toUpperCase();

  return (
    <AppLayout>
      <div style={{
        width: '100%', minHeight: '100vh',
        background: '#F8F8F5',
        padding: 'clamp(12px, 1.6vw, 24px) clamp(16px, 2.5vw, 36px)',
        fontFamily: FONT_SANS, color: C.ink,
        overflow: 'hidden', position: 'relative',
      }}>
        <style>{`
          @keyframes aurora-drift-1 { 0%,100% { transform: translate(0,0); } 50% { transform: translate(80px, -50px); } }
          @keyframes aurora-drift-2 { 0%,100% { transform: translate(0,0); } 50% { transform: translate(-60px, 60px); } }
          @keyframes aurora-drift-3 { 0%,100% { transform: translate(0,0); } 50% { transform: translate(40px, 40px); } }
          @media (prefers-reduced-motion: reduce) { .aurora-blob { animation: none !important; } }
        `}</style>

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

          {/* Chart card — card padding removed on the chart's row so the
              SVG goes truly edge-to-edge of the card; the top row keeps
              its 32px side padding so the big number / date / badge
              don't touch the card's rounded corners. */}
          <div style={{
            background: 'rgba(255,255,255,0.85)',
            backdropFilter: 'blur(30px) saturate(140%)',
            WebkitBackdropFilter: 'blur(30px) saturate(140%)',
            border: '1px solid rgba(255,255,255,0.8)', borderRadius: 22,
            padding: '26px 0 22px', marginBottom: 16,
            boxShadow: '0 1px 0 rgba(255,255,255,0.7) inset, 0 30px 60px -30px rgba(15,20,17,0.18)',
          }}>
            {/* 3-column top row: big number left, centered date middle, badge right */}
            <div style={{
              padding: '0 32px',
              display: 'grid',
              gridTemplateColumns: '1fr auto 1fr',
              alignItems: 'flex-start',
              gap: 16, marginBottom: 4,
            }}>
              {/* Left: big italic-serif number */}
              <div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
                  <span style={{
                    fontFamily: FONT_SERIF,
                    fontSize: 76, lineHeight: 1, fontWeight: 500, fontStyle: 'italic',
                    letterSpacing: '-0.035em',
                    color: accent, transition: 'color 0.4s ease',
                  }}>
                    {cur ? m.format(cur[m.key] as number) : '—'}
                  </span>
                  <span style={{ fontSize: 16, color: C.ink2, fontStyle: 'italic', paddingBottom: 12 }}>
                    {metric.toLowerCase()}
                  </span>
                </div>
              </div>

              {/* Middle: centered date, a touch larger */}
              <div style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
                paddingTop: 4, justifySelf: 'center',
              }}>
                <div style={{
                  fontFamily: FONT_MONO,
                  fontSize: 13, letterSpacing: '0.22em', textTransform: 'uppercase',
                  color: C.ink, fontWeight: 600, whiteSpace: 'nowrap',
                }}>
                  {cur ? `${cur.date.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase()} · ${monthShort} ${cur.day}` : ''}
                </div>
              </div>

              {/* Right: Forecast / Today / N days ago pill */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'flex-start', paddingTop: 4 }}>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '7px 16px', borderRadius: 999,
                  background: cur?.isFuture ? 'rgba(63,121,80,0.15)' : cur?.isToday ? 'rgba(184,133,58,0.15)' : 'rgba(0,0,0,0.06)',
                  color: cur?.isFuture ? C.sage : cur?.isToday ? C.caramel : C.ink2,
                  fontSize: 12.5, fontWeight: 700,
                  fontFamily: FONT_MONO, letterSpacing: '0.14em', textTransform: 'uppercase',
                }}>
                  {cur?.isFuture ? <><Sparkles size={12} color={C.sage} /> Forecast</>
                    : cur?.isToday ? 'Today'
                    : `${dayDelta} day${dayDelta === 1 ? '' : 's'} ago`}
                </span>
              </div>
            </div>

            <div ref={chartHostRef} style={{ padding: '16px 0 4px', width: '100%' }}>
              {cur && (
                <SpotlightChart days={days} scrub={scrub} setScrub={setScrub} metric={metric}
                  width={chartWidth} height={chartHeight} todayIdx={todayIdx} />
              )}
            </div>
          </div>

          {/* Stat cards — clicking switches metric */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 12,
          }}>
            {([
              { k: 'Occupancy', v: (cur?.occ ?? 0) + '%',                  sub: (cur?.rooms ?? 0) + ' of ' + totalRooms + ' rooms', color: C.sage },
              { k: 'Revenue',   v: fmtMoney(cur?.revenue ?? 0),            sub: (cur?.rooms ?? 0) + ' × $' + (cur?.adr ?? 0),        color: C.caramel },
              { k: 'ADR',       v: '$' + (cur?.adr ?? 0),                  sub: 'rate this day',                                       color: C.ink },
              { k: 'RevPAR',    v: '$' + (cur?.revpar ?? 0),               sub: 'across all ' + totalRooms,                            color: C.warm },
              { k: 'Profit',    v: fmtMoney(cur?.profit ?? 0),             sub: '37% margin',                                          color: C.profit },
            ] as { k: MetricKey; v: string; sub: string; color: string }[]).map(row => {
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
                    <span style={{ ...LABEL, color: isActive ? row.color : C.ink3 }}>{row.k}</span>
                  </div>
                  <div style={{
                    fontFamily: FONT_SERIF, fontStyle: 'italic',
                    fontSize: 28, fontWeight: 500, letterSpacing: '-0.025em',
                    color: row.color, lineHeight: 1, marginTop: 6,
                  }}>{row.v}</div>
                  <div style={{ fontSize: 11, color: C.ink2, marginTop: 4 }}>{row.sub}</div>
                </button>
              );
            })}

            {/* Staxis AI suggestion card */}
            <div style={{
              background: 'rgba(255,255,255,0.7)',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              border: `1px solid ${accent}33`, borderRadius: 14, padding: '12px 16px',
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
                {cur?.isFuture ? (
                  cur.occ >= 90 ? (
                    <>Strong day, raise rate to <b style={{ color: accent, fontStyle: 'normal' }}>${cur.adr + 10}</b>.</>
                  ) : cur.occ >= 80 ? (
                    <>Steady, hold rate.</>
                  ) : (
                    <>Soft. <b style={{ color: accent, fontStyle: 'normal' }}>$10 discount</b> fills it.</>
                  )
                ) : cur?.isToday ? (
                  <>Today on track for <b style={{ color: accent, fontStyle: 'normal' }}>{cur.occ}%</b>.</>
                ) : (
                  <>Closed at <b style={{ color: accent, fontStyle: 'normal' }}>{cur?.occ ?? 0}%</b>.</>
                )}
              </p>
            </div>
          </div>

          {/* ── Right Now strip — live, point-in-time data, four cards.
              Wired to Supabase subscriptions; the design's static mocks
              from shared.jsx are replaced with real values. ──────── */}
          <div style={{ marginTop: 22 }}>
            <div style={{ ...LABEL, marginBottom: 10, paddingLeft: 4 }}>
              {lang === 'es' ? 'Ahora mismo' : 'Right now'}
            </div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 12,
            }}>
              {/* Guests */}
              <div style={{
                background: 'rgba(255,255,255,0.78)',
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
                border: '1px solid rgba(255,255,255,0.75)',
                borderRadius: 16, padding: '16px 18px',
              }}>
                <div style={LABEL}>{lang === 'es' ? 'Huéspedes' : 'Guests'}</div>
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {([
                    [lang === 'es' ? 'En casa'   : 'In-house',   inHouse],
                    [lang === 'es' ? 'Llegadas'  : 'Arrivals',   arrivals],
                    [lang === 'es' ? 'Salidas'   : 'Departures', departures],
                  ] as [string, number][]).map(([k, v]) => (
                    <div key={k} style={{
                      display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
                      borderBottom: `1px dotted ${C.rule}`, paddingBottom: 6,
                    }}>
                      <span style={{ fontSize: 13.5, color: C.ink2 }}>{k}</span>
                      <span style={{
                        fontFamily: FONT_SERIF, fontStyle: 'italic',
                        fontSize: 22, fontWeight: 500, color: C.ink,
                        letterSpacing: '-0.025em', lineHeight: 1,
                      }}>{v}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Rooms */}
              <div style={{
                background: 'rgba(255,255,255,0.78)',
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
                border: '1px solid rgba(255,255,255,0.75)',
                borderRadius: 16, padding: '16px 18px',
              }}>
                <div style={LABEL}>{lang === 'es' ? 'Habitaciones' : 'Rooms'}</div>
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {([
                    [lang === 'es' ? 'Limpias' : 'Clean', cleanRooms, C.sage],
                    [lang === 'es' ? 'Sucias'  : 'Dirty', dirtyRooms, C.warm],
                  ] as [string, number, string][]).map(([k, v, color]) => (
                    <div key={k} style={{
                      display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
                      borderBottom: `1px dotted ${C.rule}`, paddingBottom: 6,
                    }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13.5, color: C.ink2 }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: color }} />
                        {k}
                      </span>
                      <span style={{
                        fontFamily: FONT_SERIF, fontStyle: 'italic',
                        fontSize: 22, fontWeight: 500, color,
                        letterSpacing: '-0.025em', lineHeight: 1,
                      }}>{v}</span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 11.5, color: C.ink3 }}>
                      {lang === 'es' ? `de ${totalRooms} totales` : `of ${totalRooms} total`}
                    </span>
                    <span style={{ fontSize: 11.5, color: C.ink3, fontFamily: FONT_MONO }}>
                      {readyPct}% {lang === 'es' ? 'listas' : 'ready'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Work orders */}
              <div style={{
                background: 'rgba(255,255,255,0.78)',
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
                border: '1px solid rgba(255,255,255,0.75)',
                borderRadius: 16, padding: '16px 18px',
              }}>
                <div style={LABEL}>{lang === 'es' ? 'Órdenes de trabajo' : 'Work orders'}</div>
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {([
                    [lang === 'es' ? 'Abiertas' : 'Open',   openOrders.length,   C.ink],
                    [lang === 'es' ? 'Urgentes' : 'Urgent', urgentOrders.length, urgentOrders.length > 0 ? C.warm : C.ink],
                  ] as [string, number, string][]).map(([k, v, color]) => (
                    <div key={k} style={{
                      display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
                      borderBottom: `1px dotted ${C.rule}`, paddingBottom: 6,
                    }}>
                      <span style={{ fontSize: 13.5, color: C.ink2 }}>{k}</span>
                      <span style={{
                        fontFamily: FONT_SERIF, fontStyle: 'italic',
                        fontSize: 22, fontWeight: 500, color,
                        letterSpacing: '-0.025em', lineHeight: 1,
                      }}>{v}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Avg turnover */}
              <div style={{
                background: 'rgba(255,255,255,0.78)',
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
                border: '1px solid rgba(255,255,255,0.75)',
                borderRadius: 16, padding: '16px 18px',
                display: 'flex', flexDirection: 'column',
              }}>
                <div style={LABEL}>{lang === 'es' ? 'Tiempo promedio' : 'Avg turnover'}</div>
                <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{
                    fontFamily: FONT_SERIF, fontStyle: 'italic',
                    fontSize: 56, fontWeight: 500, color: C.ink,
                    letterSpacing: '-0.035em', lineHeight: 1,
                  }}>{avgTurnover ?? '—'}</span>
                  <span style={{ fontSize: 18, color: C.ink2, fontStyle: 'italic' }}>min</span>
                </div>
                <div style={{ marginTop: 6, fontSize: 11.5, color: C.ink3, fontFamily: FONT_MONO, letterSpacing: '0.04em' }}>
                  {lang === 'es' ? "por habitación · promedio de hoy" : "per room · today's average"}
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </AppLayout>
  );
}
