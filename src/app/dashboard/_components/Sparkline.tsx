'use client';

// Tiny KPI sparkline (pure move out of dashboard/page.tsx — rendering is
// unchanged). Default stroke is the hero green.

import React from 'react';
import { smoothPath } from '@/lib/dashboard/today-series';
import { C } from './palette';

export function Sparkline({ data, w = 56, h = 16, stroke = C.green }: { data: number[]; w?: number; h?: number; stroke?: string }) {
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
