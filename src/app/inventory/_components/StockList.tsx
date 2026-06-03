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

interface StockListProps {
  items: DisplayItem[];
  bucket: StockBucket;
  query: string;
  onEdit?: (item: DisplayItem) => void;
  onCount?: () => void;
  onReorder?: () => void;
}

const COLUMNS: Array<{ status: StockStatus; label: string; sub: string }> = [
  { status: 'critical', label: 'Order now', sub: 'below half par' },
  { status: 'low', label: 'Order soon', sub: 'under par' },
  { status: 'good', label: 'Stocked', sub: 'at or above par' },
];

// Items with no real forecast (par/60 fallback or no data) sort to the bottom
// of their column — soonest-to-run-out first otherwise.
function sortKey(it: DisplayItem): number {
  if (it.burnSource === 'fallback-60d' || it.burnSource === 'no-data') return Infinity;
  return it.daysLeft;
}

export function StockList({ items, bucket, query, onEdit, onCount, onReorder }: StockListProps) {
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .filter((it) => inBucket(it.cat, bucket))
      .filter((it) => {
        if (!q) return true;
        return `${it.name} ${it.vendor} ${it.id}`.toLowerCase().includes(q);
      });
  }, [items, bucket, query]);

  const boardRef = useRiseIn<HTMLDivElement>([bucket, query], { step: 14 });

  return (
    <div
      ref={boardRef}
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr 1fr',
        gap: 13,
        alignItems: 'start',
      }}
    >
      {COLUMNS.map((col) => {
        const c = statusColor[col.status];
        const colItems = filtered
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
                  Nothing here.
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
