'use client';

import React from 'react';
import { T } from './tokens';

// Tiny inline-SVG sparkline used in KPI cards.
export function Sparkline({
  values,
  width = 80,
  height = 22,
  color,
  fill = true,
}: {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  fill?: boolean;
}) {
  const c = color || T.ink2;
  if (!values || values.length < 2) {
    return <svg width={width} height={height} aria-hidden />;
  }
  const mn = Math.min(...values);
  const mx = Math.max(...values);
  const range = mx - mn || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = height - ((v - mn) / range) * (height - 2) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const path = `M ${pts.join(' L ')}`;
  const fillPath = `${path} L ${width},${height} L 0,${height} Z`;
  const lastY = height - ((values[values.length - 1] - mn) / range) * (height - 2) - 1;
  return (
    <svg width={width} height={height} style={{ display: 'block', overflow: 'visible' }} aria-hidden>
      {fill && <path d={fillPath} fill={c} opacity="0.10" />}
      <path d={path} stroke={c} strokeWidth="1.5" fill="none" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={width} cy={lastY} r="2" fill={c} />
    </svg>
  );
}
