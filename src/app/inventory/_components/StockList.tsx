'use client';

import React, { useMemo } from 'react';
import {
  T,
  fonts,
  statusColor,
  statusTint,
  inBucket,
  type StockStatus,
  type StockBucket,
} from './tokens';
import { StatusDot } from './StatusPill';
import { Serif } from './Serif';
import { Caps } from './Caps';
import { useRiseIn } from './motion';
import { BoardCard } from './BoardCard';
import type { DisplayItem } from './types';
import { t, type Lang } from './inv-i18n';

interface StockListProps {
  lang: Lang;
  items: DisplayItem[];
  bucket: StockBucket;
  query: string;
  onEdit?: (item: DisplayItem) => void;
  onCount?: () => void;
  onReorder?: () => void;
}

function columnsFor(lang: Lang): Array<{ status: StockStatus; label: string; sub: string }> {
  const tx = t(lang);
  return [
    { status: 'critical', label: tx.colOrderNow, sub: tx.subBelowHalfPar },
    { status: 'low', label: tx.colOrderSoon, sub: tx.subUnderPar },
    { status: 'good', label: tx.colStocked, sub: tx.subAtOrAbovePar },
  ];
}

// Items with no real forecast (par/60 fallback or no data) sort to the bottom
// of their column — soonest-to-run-out first otherwise.
function sortKey(it: DisplayItem): number {
  if (it.burnSource === 'fallback-60d' || it.burnSource === 'no-data') return Infinity;
  return it.daysLeft;
}

export function StockList({ lang, items, bucket, query, onEdit, onCount, onReorder }: StockListProps) {
  const tx = t(lang);
  const COLUMNS = columnsFor(lang);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .filter((it) => inBucket(it.cat, bucket))
      .filter((it) => {
        if (!q) return true;
        return `${it.name} ${it.vendor} ${it.id}`.toLowerCase().includes(q);
      });
  }, [items, bucket, query]);

  // Never-counted items are pulled OUT of the triage columns (where a 0-stock
  // seeded item would otherwise read as red "Order now") into a neutral
  // "not counted yet" section. Counted items keep the normal triage.
  const counted = useMemo(() => filtered.filter((it) => !it.uncounted), [filtered]);
  const uncounted = useMemo(() => filtered.filter((it) => it.uncounted), [filtered]);

  const boardRef = useRiseIn<HTMLDivElement>([bucket, query], { step: 14 });

  // Brand-new hotel (nothing counted at all, in the unfiltered "All" view) →
  // skip the empty triage board and show only the friendly "count to get
  // started" panel. A filtered-empty bucket on an established hotel keeps the
  // normal empty columns (scoped so the day-1 CTA never shows there).
  const dayOne = counted.length === 0 && bucket === 'all' && !query.trim();

  return (
    <div ref={boardRef} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {!dayOne && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            gap: 13,
            alignItems: 'start',
          }}
        >
          {COLUMNS.map((col) => {
            const c = statusColor[col.status];
            const colItems = counted
              .filter((it) => it.status === col.status)
              .slice()
              .sort((a, b) => sortKey(a) - sortKey(b));
            return (
              <div
                key={col.status}
                style={{
                  background: statusTint[col.status],
                  borderRadius: 15,
                  padding: 12,
                  border: `1px solid ${c}22`,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 6px 12px' }}>
                  <StatusDot s={col.status} size={10} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: fonts.sans, fontSize: 14, fontWeight: 700, color: c }}>
                      {col.label}
                    </div>
                    <Caps size={8.5} color={T.dim}>{col.sub}</Caps>
                  </div>
                  <Serif size={24} color={c}>{colItems.length}</Serif>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                  {colItems.map((it) => (
                    <BoardCard
                      key={it.id}
                      lang={lang}
                      it={it}
                      onEdit={onEdit}
                      onCount={onCount}
                      onReorder={onReorder}
                    />
                  ))}
                  {colItems.length === 0 && (
                    <div
                      style={{
                        padding: '22px 0',
                        textAlign: 'center',
                        fontFamily: fonts.sans,
                        fontSize: 12.5,
                        color: T.dim,
                        fontStyle: 'italic',
                      }}
                    >
                      {tx.nothingHere}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {uncounted.length > 0 && (
        <NotCountedSection
          lang={lang}
          items={uncounted}
          dayOne={dayOne}
          onEdit={onEdit}
          onCount={onCount}
          onReorder={onReorder}
        />
      )}
    </div>
  );
}

// Neutral "not counted yet" group — brand-new items with no physical count.
// Rendered grey (never red), excluded from the triage columns above.
function NotCountedSection({
  lang, items, dayOne, onEdit, onCount, onReorder,
}: {
  lang: Lang;
  items: DisplayItem[];
  dayOne: boolean;
  onEdit?: (item: DisplayItem) => void;
  onCount?: () => void;
  onReorder?: () => void;
}) {
  const tx = t(lang);
  return (
    <div style={{ background: T.inkWash, borderRadius: 15, padding: 12, border: `1px solid ${T.rule}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 6px 12px', flexWrap: 'wrap' }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: T.dim, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: fonts.sans, fontSize: 14, fontWeight: 700, color: T.ink2 }}>
            {tx.notCountedTitle}
          </div>
          <Caps size={8.5} color={T.dim}>{tx.notCountedSub}</Caps>
        </div>
        <Serif size={24} color={T.ink3}>{items.length}</Serif>
        {onCount && (
          <button
            type="button"
            onClick={onCount}
            style={{
              border: 'none', borderRadius: 8, padding: '7px 12px', cursor: 'pointer',
              background: T.ink, color: T.bg, fontFamily: fonts.sans, fontSize: 12, fontWeight: 600,
              flexShrink: 0,
            }}
          >
            {tx.countInventory}
          </button>
        )}
      </div>
      {dayOne && (
        <div style={{ padding: '0 6px 12px', fontFamily: fonts.sans, fontSize: 12.5, color: T.ink2, fontStyle: 'italic' }}>
          {tx.notCountedHint}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 9 }}>
        {items.map((it) => (
          <BoardCard key={it.id} lang={lang} it={it} onEdit={onEdit} onCount={onCount} onReorder={onReorder} />
        ))}
      </div>
    </div>
  );
}
