'use client';

import React, { useMemo } from 'react';
import type { InventoryCount, InventoryOrder } from '@/types';
import { T, fonts, statusColor } from '../tokens';
import { Overlay } from './Overlay';
import { fmtMoney } from '../format';

interface HistoryPanelProps {
  open: boolean;
  onClose: () => void;
  counts: InventoryCount[];
  orders: InventoryOrder[];
}

type Row = {
  kind: 'order' | 'count';
  date: Date;
  label: string;
  who: string;
  meta: string;
  amount?: number;       // order total or count $ variance
  varianceSign?: -1 | 0 | 1;
};

export function HistoryPanel({ open, onClose, counts, orders }: HistoryPanelProps) {
  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const o of orders) {
      const when = o.receivedAt ?? o.orderedAt ?? new Date();
      out.push({
        kind: 'order',
        date: when,
        label: o.itemName ? `Order · ${o.itemName}` : 'Order',
        who: o.vendorName || 'Vendor',
        meta: `${o.quantity} ${o.quantity === 1 ? 'unit' : 'units'}`,
        amount: o.totalCost,
      });
    }
    // Bucket counts by countedAt date — multiple items recorded at the same second
    // logically belong to one "Physical count" event.
    const byCountedAt = new Map<string, InventoryCount[]>();
    for (const c of counts) {
      const k = c.countedAt ? c.countedAt.toISOString() : 'unknown';
      const list = byCountedAt.get(k) ?? [];
      list.push(c);
      byCountedAt.set(k, list);
    }
    for (const [k, group] of byCountedAt.entries()) {
      if (k === 'unknown') continue;
      const first = group[0];
      const dt = first.countedAt!;
      const who = first.countedBy || 'team';
      const variance = group.reduce(
        (s, c) => s + (typeof c.varianceValue === 'number' ? c.varianceValue : 0),
        0,
      );
      out.push({
        kind: 'count',
        date: dt,
        label: 'Physical count',
        who,
        meta: `${group.length} item${group.length === 1 ? '' : 's'}`,
        amount: variance,
        varianceSign: variance < 0 ? -1 : variance > 0 ? 1 : 0,
      });
    }
    out.sort((a, b) => b.date.getTime() - a.date.getTime());
    return out;
  }, [counts, orders]);

  const kindStyle = {
    order: {
      color: T.sageDeep,
      bg: T.sageDim,
      border: 'rgba(92,122,96,0.28)',
      label: 'Order',
    },
    count: {
      color: T.purple,
      bg: T.purpleDim,
      border: 'rgba(123,106,151,0.28)',
      label: 'Count',
    },
  } as const;

  return (
    <Overlay
      open={open}
      onClose={onClose}
      eyebrow="History"
      italic="Everything that's happened"
      suffix={`${rows.length} event${rows.length === 1 ? '' : 's'}`}
      width={820}
    >
      <div style={{ background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 14, padding: '4px 20px' }}>
        {rows.length === 0 ? (
          <div
            style={{
              padding: '40px 0',
              textAlign: 'center',
              fontFamily: fonts.serif,
              fontSize: 22,
              color: T.ink3,
              fontStyle: 'italic',
            }}
          >
            No history yet.
          </div>
        ) : (
          rows.map((row, i) => {
            const k = kindStyle[row.kind];
            return (
              <div
                key={i}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '88px 80px 1fr 1fr 100px',
                  gap: 14,
                  padding: '14px 0',
                  alignItems: 'center',
                  borderTop: i === 0 ? 'none' : `1px solid ${T.ruleSoft}`,
                }}
              >
                <span
                  style={{
                    fontFamily: fonts.serif,
                    fontSize: 16,
                    color: T.ink,
                    fontStyle: 'italic',
                    fontWeight: 400,
                    letterSpacing: '-0.01em',
                  }}
                >
                  {shortDate(row.date)}
                </span>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '3px 9px',
                    borderRadius: 999,
                    justifySelf: 'flex-start',
                    background: k.bg,
                    color: k.color,
                    border: `1px solid ${k.border}`,
                    fontFamily: fonts.sans,
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                >
                  <span
                    style={{
                      display: 'inline-block',
                      width: 5,
                      height: 5,
                      borderRadius: '50%',
                      background: k.color,
                    }}
                  />
                  {k.label}
                </span>
                <span style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink, fontWeight: 500 }}>
                  {row.label}
                </span>
                <span style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2 }}>
                  {row.who} · {row.meta}
                </span>
                <span
                  style={{
                    fontFamily: fonts.sans,
                    fontSize: 13,
                    fontWeight: 600,
                    textAlign: 'right',
                  }}
                >
                  {row.kind === 'order' && typeof row.amount === 'number' && row.amount > 0 ? (
                    <span style={{ color: T.ink }}>{fmtMoney(row.amount)}</span>
                  ) : row.kind === 'count' && typeof row.amount === 'number' ? (
                    <span
                      style={{
                        color: (row.varianceSign ?? 0) < 0 ? statusColor.critical : T.ink2,
                        fontWeight: 500,
                      }}
                    >
                      {fmtMoney(row.amount)}
                    </span>
                  ) : (
                    <span style={{ color: T.ink3 }}>—</span>
                  )}
                </span>
              </div>
            );
          })
        )}
      </div>
    </Overlay>
  );
}

function shortDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
