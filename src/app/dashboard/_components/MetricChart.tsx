'use client';

// Metric chart — draw-in line/area, hover-scrub, today marker + playhead
// (pure move out of dashboard/page.tsx — rendering is unchanged).

import React, { useEffect, useRef, useState } from 'react';
import { smoothPath, type SeriesPoint } from '@/lib/dashboard/today-series';
import { C, MONO } from './palette';

export const MetricChart = React.memo(function MetricChart({ series, color, onHover, marker }: {
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
      p.style.transition = 'stroke-dashoffset .9s cubic-bezier(.4,0,.1,1)';
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
