'use client';

// Room ring — one tick per room, lit by live status (pure move out of
// dashboard/page.tsx — rendering is unchanged).

import React from 'react';
import { RING, type RingKey } from './palette';

// One tick = one specific room. `idx` is a stable unique identity so hover
// highlights only the room under the cursor (matching on room number would
// pop out every room that shares it).
export type RingTick = { idx: number; num: string; status: RingKey };

export const RoomRing = React.memo(function RoomRing({ rooms, onHover, hovered }: {
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
            style={{ cursor: 'pointer', transition: 'stroke-width .12s' }} />
        );
      })}
    </svg>
  );
});
