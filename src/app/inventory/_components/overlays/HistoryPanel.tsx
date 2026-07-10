'use client';

import React, { useMemo } from 'react';
import type { InventoryCount, InventoryOrder } from '@/types';
import { shortDateFromDate } from '@/lib/format-date';
import { T, fonts, statusColor } from '../tokens';
import { Overlay } from './Overlay';
import { fmtMoney } from '../format';
import { type Lang } from '../inv-i18n';

interface HistoryPanelProps {
  lang: Lang;
  open: boolean;
  onClose: () => void;
  counts: InventoryCount[];
  orders: InventoryOrder[];
}

function hpStrings(lang: Lang) {
  return {
    en: {
      eyebrow: 'History',
      italic: "Everything that's happened",
      event: 'event',
      events: 'events',
      noHistory: 'No history yet.',
      order: 'Order',
      count: 'Count',
      physicalCount: 'Physical count',
      vendor: 'Vendor',
      team: 'team',
      unit: 'unit',
      units: 'units',
      item: 'item',
      items: 'items',
    },
    es: {
      eyebrow: 'Historial',
      italic: 'Todo lo que ha pasado',
      event: 'evento',
      events: 'eventos',
      noHistory: 'Aún no hay historial.',
      order: 'Orden',
      count: 'Conteo',
      physicalCount: 'Conteo físico',
      vendor: 'Proveedor',
      team: 'equipo',
      unit: 'unidad',
      units: 'unidades',
      item: 'artículo',
      items: 'artículos',
    },
  }[lang];
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

export function HistoryPanel({ lang, open, onClose, counts, orders }: HistoryPanelProps) {
  const hp = useMemo(() => hpStrings(lang), [lang]);
  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const o of orders) {
      const when = o.receivedAt ?? o.orderedAt ?? new Date();
      out.push({
        kind: 'order',
        date: when,
        label: o.itemName ? `${hp.order} · ${o.itemName}` : hp.order,
        who: o.vendorName || hp.vendor,
        meta: `${o.quantity} ${o.quantity === 1 ? hp.unit : hp.units}`,
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
      const who = first.countedBy || hp.team;
      const variance = group.reduce(
        (s, c) => s + (typeof c.varianceValue === 'number' ? c.varianceValue : 0),
        0,
      );
      out.push({
        kind: 'count',
        date: dt,
        label: hp.physicalCount,
        who,
        meta: `${group.length} ${group.length === 1 ? hp.item : hp.items}`,
        amount: variance,
        varianceSign: variance < 0 ? -1 : variance > 0 ? 1 : 0,
      });
    }
    out.sort((a, b) => b.date.getTime() - a.date.getTime());
    return out;
  }, [counts, orders, hp]);

  const kindStyle = {
    order: {
      color: T.sageDeep,
      bg: T.sageDim,
      border: `${T.forest}48`,
      label: hp.order,
    },
    count: {
      color: T.purple,
      bg: T.purpleDim,
      border: `${T.teal}48`,
      label: hp.count,
    },
  } as const;

  return (
    <Overlay
      open={open}
      onClose={onClose}
      eyebrow={hp.eyebrow}
      italic={hp.italic}
      suffix={`${rows.length} ${rows.length === 1 ? hp.event : hp.events}`}
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
            {hp.noHistory}
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
                  {shortDateFromDate(row.date, lang)}
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
