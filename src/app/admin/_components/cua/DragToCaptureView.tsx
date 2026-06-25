'use client';

/**
 * DragToCaptureView — feature/cua-click-to-map + fix/cua-freeform-capture.
 *
 * Renders the source screenshot the robot read, with each captured DATA column
 * AND each standalone VALUE element drawn as a faint box. The admin DRAGS a box
 * over ANYTHING they want; on release we map the dragged rectangle back to
 * viewport px and ask resolveDragRegion what it covers: a per-row COLUMN (snap
 * to the whole column), a one-off VALUE, or UNKNOWN (→ the host asks the admin).
 * No re-map, no driving — "drag the part you want to capture."
 *
 * Coordinate space: the worker saved boxes in the captured viewport's CSS px
 * (the fullPage:false screenshot's space). The <img> renders scaled to fit with
 * aspect preserved, so on-image px scale to viewport px by one factor
 * (viewport.w / renderedImageWidth) for both axes.
 */

import React, { useRef, useState } from 'react';
import { MousePointerClick } from 'lucide-react';
import { FONT_MONO } from '@/app/admin/_components/studio/kit';
import { dimWhite } from '@/app/admin/_components/studio/surface-kit';
import { resolveDragRegion, type ColumnGeometry, type FreeformResolution } from '@/lib/pms/column-geometry';

export function DragToCaptureView({
  url, geometry, onPick,
}: {
  url: string;
  geometry: ColumnGeometry;
  onPick: (r: FreeformResolution) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [picked, setPicked] = useState<FreeformResolution | null>(null);

  const rect = () => boxRef.current?.getBoundingClientRect();
  const scale = () => { const w = rect()?.width ?? 0; return w > 0 ? geometry.viewport.w / w : 1; };
  const local = (clientX: number, clientY: number) => { const r = rect(); return { x: r ? clientX - r.left : 0, y: r ? clientY - r.top : 0 }; };

  const onUp = () => {
    if (!drag) return;
    const s = scale();
    const vbox = {
      x: Math.min(drag.x0, drag.x1) * s,
      y: Math.min(drag.y0, drag.y1) * s,
      w: Math.abs(drag.x1 - drag.x0) * s,
      h: Math.abs(drag.y1 - drag.y0) * s,
    };
    const res = resolveDragRegion(geometry, vbox);
    setDrag(null);
    setPicked(res);
    onPick(res);
  };

  const s = scale();
  const toImg = (b: { x: number; w: number }) => ({ left: b.x / s, width: b.w / s });

  const label =
    picked?.kind === 'column' ? `column: ${picked.column.header || `#${picked.column.index}`}`
    : picked?.kind === 'value' ? `value: ${picked.value.text}`
    : picked?.kind === 'unknown' ? "couldn't tell what's there — drag over a column of the table, or a labeled value (e.g. a count or a date), then try again"
    : null;

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: 'var(--gold)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
        <MousePointerClick size={11} /> Drag a box over anything you want the bot to capture
      </div>
      <div
        ref={boxRef}
        onMouseDown={(e) => { e.preventDefault(); setPicked(null); const p = local(e.clientX, e.clientY); setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y }); }}
        onMouseMove={(e) => { if (drag) { const p = local(e.clientX, e.clientY); setDrag({ ...drag, x1: p.x, y1: p.y }); } }}
        onMouseUp={onUp}
        onMouseLeave={() => setDrag(null)}
        style={{ position: 'relative', width: '100%', maxWidth: 760, border: `1px solid ${dimWhite(.14)}`, borderRadius: 8, overflow: 'hidden', lineHeight: 0, cursor: 'crosshair', userSelect: 'none' }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="Drag anything to capture it" draggable={false} style={{ width: '100%', height: 'auto', display: 'block', pointerEvents: 'none' }} />
        {/* faint column strips (full height) */}
        {geometry.columns.map((c) => {
          const im = toImg(c);
          const isPicked = picked?.kind === 'column' && picked.column.index === c.index;
          return <div key={`c${c.index}`} title={c.header || `column ${c.index}`} style={{ position: 'absolute', top: 0, bottom: 0, left: im.left, width: im.width, borderLeft: `1px solid ${dimWhite(.1)}`, background: isPicked ? 'rgba(60,156,104,.28)' : 'transparent' }} />;
        })}
        {/* faint value boxes */}
        {(geometry.values ?? []).map((v, i) => {
          const im = toImg(v);
          const isPicked = picked?.kind === 'value' && picked.value.selector === v.selector;
          return <div key={`v${i}`} title={v.text} style={{ position: 'absolute', top: v.y / s, height: v.h / s, left: im.left, width: im.width, border: `1px solid ${isPicked ? 'var(--forest)' : 'rgba(201,154,46,.3)'}`, background: isPicked ? 'rgba(60,156,104,.28)' : 'transparent', borderRadius: 2 }} />;
        })}
        {/* live drag rectangle */}
        {drag && (
          <div style={{ position: 'absolute', left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0), background: 'rgba(201,154,46,.22)', border: '1px solid var(--gold)' }} />
        )}
      </div>
      {label && (
        <div style={{ marginTop: 6, fontFamily: FONT_MONO, fontSize: 11, color: picked?.kind === 'unknown' ? 'var(--gold)' : 'var(--forest)' }}>
          {label}
        </div>
      )}
    </div>
  );
}
