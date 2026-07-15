'use client';

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { T, fonts, type StockBucket } from './tokens';
import { Btn } from './Btn';
import { EASE } from './motion';
import { TickNum } from './fx';
import { t, type Lang } from './inv-i18n';

export type InventoryView = 'ledger' | 'board';

interface FilterBarProps {
  lang: Lang;
  bucket: StockBucket;
  onBucket: (b: StockBucket) => void;
  query: string;
  onQuery: (q: string) => void;
  allCount: number;
  generalCount: number;
  breakfastCount: number;
  view: InventoryView;
  onView: (v: InventoryView) => void;
  onAdd: () => void;
}

export function FilterBar({
  lang,
  bucket,
  onBucket,
  query,
  onQuery,
  allCount,
  generalCount,
  breakfastCount,
  view,
  onView,
  onAdd,
}: FilterBarProps) {
  const tx = t(lang);
  const segments: Array<{ key: StockBucket; label: string; count: number }> = [
    { key: 'all', label: tx.all, count: allCount },
    { key: 'general', label: tx.generalInventory, count: generalCount },
    { key: 'breakfast', label: tx.breakfastInventory, count: breakfastCount },
  ];

  // Sliding ink indicator — measured off the active segment button so it
  // glides between segments instead of repainting. Re-measured when counts or
  // language change the label widths, and on window resize.
  const btnRefs = useRef<Partial<Record<StockBucket, HTMLButtonElement | null>>>({});
  const [ind, setInd] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const measure = () => {
      const b = btnRefs.current[bucket];
      if (b) setInd({ left: b.offsetLeft, width: b.offsetWidth });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [bucket, lang, allCount, generalCount, breakfastCount]);

  // Fonts loading late can shift label widths after the first measure — one
  // re-measure when the document's fonts settle keeps the pill aligned.
  useEffect(() => {
    let cancelled = false;
    void document.fonts?.ready?.then(() => {
      if (cancelled) return;
      const b = btnRefs.current[bucket];
      if (b) setInd({ left: b.offsetLeft, width: b.offsetWidth });
    });
    return () => { cancelled = true; };
  }, [bucket]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      {/* Bucket toggle — one segmented control with a gliding ink pill */}
      <div
        style={{
          display: 'inline-flex',
          position: 'relative',
          border: `1px solid ${T.rule}`,
          borderRadius: 999,
          padding: 3,
          background: T.bg,
        }}
      >
        {ind && (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              top: 3,
              bottom: 3,
              left: ind.left,
              width: ind.width,
              background: T.ink,
              borderRadius: 999,
              transition: `left .32s ${EASE.glide}, width .32s ${EASE.glide}`,
            }}
          />
        )}
        {segments.map((seg) => {
          const active = bucket === seg.key;
          return (
            <button
              key={seg.key}
              ref={(el) => { btnRefs.current[seg.key] = el; }}
              type="button"
              className="inv-seg-btn"
              onClick={() => onBucket(seg.key)}
              style={{
                position: 'relative',
                zIndex: 1,
                padding: '7px 14px',
                cursor: 'pointer',
                background: 'transparent',
                color: active ? T.bg : T.ink2,
                border: 'none',
                borderRadius: 999,
                fontFamily: fonts.sans,
                fontSize: 12.5,
                fontWeight: active ? 600 : 500,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              {seg.label}
              <span
                className="inv-seg-btn"
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 10,
                  fontWeight: 700,
                  color: active ? 'rgba(255,255,255,0.6)' : T.dim,
                }}
              >
                <TickNum>{seg.count}</TickNum>
              </span>
            </button>
          );
        })}
      </div>
      <input
        type="text"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder={tx.search}
        className="inv-search"
        style={{
          flex: 1,
          minWidth: 140,
          height: 38,
          padding: '0 16px',
          borderRadius: 999,
          background: T.bg,
          border: `1px solid ${T.rule}`,
          fontFamily: fonts.sans,
          fontSize: 13,
          color: T.ink,
          outline: 'none',
        }}
      />
      {/* View switch — Ledger table ↔ triage board. Static segmented control. */}
      <div
        style={{
          display: 'inline-flex',
          border: `1px solid ${T.rule}`,
          borderRadius: 999,
          padding: 3,
          background: T.bg,
          flexShrink: 0,
        }}
      >
        {(['ledger', 'board'] as const).map((v) => {
          const active = view === v;
          return (
            <button
              key={v}
              type="button"
              onClick={() => onView(v)}
              aria-pressed={active}
              style={{
                padding: '7px 13px',
                cursor: 'pointer',
                background: active ? T.ink : 'transparent',
                color: active ? T.bg : T.ink2,
                border: 'none',
                borderRadius: 999,
                fontFamily: fonts.sans,
                fontSize: 12.5,
                fontWeight: active ? 600 : 500,
                transition: 'background .18s ease, color .18s ease',
              }}
            >
              {v === 'ledger' ? tx.viewLedger : tx.viewBoard}
            </button>
          );
        })}
      </div>
      <Btn variant="ghost" size="md" onClick={onAdd}>
        {tx.addItem}
      </Btn>
    </div>
  );
}
