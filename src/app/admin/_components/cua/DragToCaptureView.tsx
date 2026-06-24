'use client';

/**
 * DragToCaptureView — feature/cua-click-to-map.
 *
 * Renders the source screenshot the robot read, with each captured DATA column
 * drawn as a faint strip. The admin DRAGS a box over the column they want; on
 * release we map the dragged rectangle back to viewport px and ask
 * pickColumnFromDrag which column it covers, then call onPick. No re-map, no
 * driving — just "drag the part you want to capture."
 *
 * Coordinate space: the worker saved boxes in the captured viewport's CSS px
 * (the fullPage:false screenshot's space). The <img> is rendered scaled to fit,
 * so we scale on-image px by geometry.viewport.w / renderedImageWidth.
 */

import React, { useRef, useState } from 'react';
import { MousePointerClick } from 'lucide-react';
import { FONT_MONO } from '@/app/admin/_components/studio/kit';
import { dimWhite } from '@/app/admin/_components/studio/surface-kit';
import { pickColumnFromDrag, type ColumnGeometry, type GeomColumn } from '@/lib/pms/column-geometry';

export function DragToCaptureView({
  url, geometry, onPick,
}: {
  url: string;
  geometry: ColumnGeometry;
  onPick: (c: GeomColumn) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);
  const [picked, setPicked] = useState<GeomColumn | null>(null);

  // px-on-rendered-image → captured-viewport px.
  const scale = (): number => {
    const w = boxRef.current?.getBoundingClientRect().width ?? 0;
    return w > 0 ? geometry.viewport.w / w : 1;
  };
  const localX = (clientX: number): number => {
    const r = boxRef.current?.getBoundingClientRect();
    return r ? clientX - r.left : 0;
  };

  const onMove = (e: React.MouseEvent) => {
    if (!drag) return;
    setDrag({ ...drag, x1: localX(e.clientX) });
  };
  const onUp = () => {
    if (!drag) return;
    const s = scale();
    const left = Math.min(drag.x0, drag.x1) * s;
    const w = Math.abs(drag.x1 - drag.x0) * s;
    const col = pickColumnFromDrag(geometry, { x: left, w });
    setDrag(null);
    if (col) { setPicked(col); onPick(col); }
  };

  const s = scale();
  // Convert a viewport-px column box to on-image px for the overlay strips.
  const strip = (c: GeomColumn) => ({ left: c.x / s, width: c.w / s });

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: 'var(--gold)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
        <MousePointerClick size={11} /> Drag a box over the column you want to capture
      </div>
      <div
        ref={boxRef}
        onMouseDown={(e) => { e.preventDefault(); setPicked(null); setDrag({ x0: localX(e.clientX), x1: localX(e.clientX) }); }}
        onMouseMove={onMove}
        onMouseUp={onUp}
        onMouseLeave={() => setDrag(null)}
        style={{ position: 'relative', width: '100%', maxWidth: 760, border: `1px solid ${dimWhite(.14)}`, borderRadius: 8, overflow: 'hidden', lineHeight: 0, cursor: 'crosshair', userSelect: 'none' }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="Drag a column to capture it" draggable={false} style={{ width: '100%', height: 'auto', display: 'block', pointerEvents: 'none' }} />
        {/* faint per-column strips so the admin sees where columns are */}
        {geometry.columns.map((c) => {
          const st = strip(c);
          const isPicked = picked?.index === c.index;
          return (
            <div key={c.index} title={c.header || `column ${c.index}`} style={{
              position: 'absolute', top: 0, bottom: 0, left: st.left, width: st.width,
              borderLeft: `1px solid ${dimWhite(.12)}`,
              background: isPicked ? 'rgba(60,156,104,.28)' : 'transparent',
            }} />
          );
        })}
        {/* live drag rectangle */}
        {drag && (
          <div style={{
            position: 'absolute', top: 0, bottom: 0,
            left: Math.min(drag.x0, drag.x1), width: Math.abs(drag.x1 - drag.x0),
            background: 'rgba(201,154,46,.22)', border: '1px solid var(--gold)',
          }} />
        )}
      </div>
      {picked && (
        <div style={{ marginTop: 6, fontFamily: FONT_MONO, fontSize: 11, color: 'var(--forest)' }}>
          captured: <b>{picked.header || `column ${picked.index}`}</b>
        </div>
      )}
    </div>
  );
}
