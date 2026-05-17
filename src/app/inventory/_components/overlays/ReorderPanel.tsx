'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { addInventoryOrder } from '@/lib/db';
import type { InventoryItem, InventoryBudget, InventoryCategory } from '@/types';
import type { DailyAverages } from '@/lib/inventory-predictions';

import { T, fonts, statusColor, catColor, catLabel, type InvCat } from '../tokens';
import { CatIcon } from '../CatIcon';
import { ItemThumb } from '../ItemThumb';
import { Caps } from '../Caps';
import { Btn } from '../Btn';
import { StockBar } from '../StockBar';
import { StatusDot } from '../StatusPill';
import { Overlay } from './Overlay';
import { fmtMoney } from '../format';
import { recommendReorder, suggestQuantity } from '../adapter';
import type { DisplayItem, ReorderRec } from '../types';

interface ReorderPanelProps {
  open: boolean;
  onClose: () => void;
  items: InventoryItem[];
  display: DisplayItem[];
  budgets: InventoryBudget[];
  spendByCat: Record<string, number>;
  averages: DailyAverages | null;
  mlRateMap: Map<string, number>;
}

type LineState = { checked: boolean; qty: number };

const URG_LABEL: Record<'now' | 'soon' | 'ok', string> = {
  now: 'Order now',
  soon: 'Order soon',
  ok: 'OK for now',
};
const URG_COLOR: Record<'now' | 'soon' | 'ok', string> = {
  now: statusColor.critical,
  soon: statusColor.low,
  ok: statusColor.good,
};
const URG_STATUS: Record<'now' | 'soon' | 'ok', 'critical' | 'low' | 'good'> = {
  now: 'critical',
  soon: 'low',
  ok: 'good',
};

export function ReorderPanel({
  open,
  onClose,
  display,
  budgets,
  spendByCat,
  averages,
  mlRateMap,
}: ReorderPanelProps) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();

  // Build recommendations once per (open, data) cycle.
  const recs: Array<ReorderRec & { display: DisplayItem }> = useMemo(() => {
    if (!open) return [];
    const out: Array<ReorderRec & { display: DisplayItem }> = [];
    for (const d of display) {
      const { urgency, reason } = recommendReorder(d, averages, mlRateMap);
      // Hide truly fine items (status=good AND urgency=ok AND not below par) from the panel.
      if (urgency === 'ok' && d.status === 'good') continue;
      const sq = suggestQuantity(d);
      out.push({
        itemId: d.id,
        suggestQty: sq.qty,
        packs: sq.packsLabel,
        cost: sq.qty * (d.unitCost || 0),
        reason,
        urgency,
        display: d,
      });
    }
    // Stable ordering: now first, then soon, then ok; within group sort by daysLeft asc.
    const ord = { now: 0, soon: 1, ok: 2 } as const;
    out.sort((a, b) =>
      ord[a.urgency] - ord[b.urgency] || a.display.daysLeft - b.display.daysLeft,
    );
    return out;
  }, [open, display, averages, mlRateMap]);

  const [state, setState] = useState<Record<string, LineState>>({});
  const [saving, setSaving] = useState(false);

  // Reset state whenever recs change (e.g. panel reopens with new data).
  useEffect(() => {
    if (!open) return;
    const next: Record<string, LineState> = {};
    for (const r of recs) {
      next[r.itemId] = { checked: r.urgency === 'now', qty: r.suggestQty };
    }
    setState(next);
  }, [open, recs]);

  const cartItems = recs.filter((r) => state[r.itemId]?.checked);
  const cartTotal = cartItems.reduce(
    (s, r) => s + (state[r.itemId]?.qty || 0) * (r.display.unitCost || 0),
    0,
  );

  // Per-category $ projection from cart.
  const projectedByCat: Record<InvCat, number> = useMemo(() => {
    const out: Record<InvCat, number> = { housekeeping: 0, maintenance: 0, breakfast: 0 };
    for (const r of cartItems) {
      const qty = state[r.itemId]?.qty || 0;
      out[r.display.cat] += qty * (r.display.unitCost || 0);
    }
    return out;
  }, [cartItems, state]);

  const groups = (['now', 'soon', 'ok'] as const)
    .map((u) => ({ urgency: u, recs: recs.filter((r) => r.urgency === u) }))
    .filter((g) => g.recs.length > 0);

  const distinctVendors = new Set(cartItems.map((r) => r.display.vendor || '—')).size;

  const handlePlaceOrders = async () => {
    if (!user || !activePropertyId || saving || cartItems.length === 0) return;
    setSaving(true);
    try {
      const now = new Date();
      await Promise.all(
        cartItems.map((r) => {
          const qty = state[r.itemId]?.qty || 0;
          const unitCost = r.display.unitCost || undefined;
          return addInventoryOrder(user.uid, activePropertyId, {
            propertyId: activePropertyId,
            itemId: r.itemId,
            itemName: r.display.name,
            quantity: qty,
            unitCost,
            totalCost: unitCost ? unitCost * qty : undefined,
            vendorName: r.display.vendor || undefined,
            orderedAt: now,
            receivedAt: null,
            notes: 'Reorder list',
          });
        }),
      );
      onClose();
    } catch (err) {
      console.error('[reorder] place orders failed', err);
      alert('Placing the orders failed. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Overlay
      open={open}
      onClose={onClose}
      eyebrow={`Reorder · ${recs.length} item${recs.length === 1 ? '' : 's'}`}
      italic={fmtMoney(cartTotal)}
      suffix={`${cartItems.length} in cart · ${distinctVendors} vendor${distinctVendors === 1 ? '' : 's'}`}
      accent={statusColor.critical}
      width={1080}
      footer={
        <>
          <Btn variant="ghost" size="md" onClick={onClose}>
            Save draft
          </Btn>
          <Btn
            variant="primary"
            size="md"
            disabled={saving || cartItems.length === 0}
            onClick={handlePlaceOrders}
            style={{ opacity: cartItems.length ? 1 : 0.4 }}
          >
            {saving ? 'Placing…' : 'Place orders by vendor →'}
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        {/* Budget meters */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          {(['housekeeping', 'maintenance', 'breakfast'] as InvCat[]).map((cat) => {
            const monthly = budgetFor(budgets, cat as InventoryCategory);
            const spentCents = spendByCat[cat] ?? 0;
            return (
              <BudgetMeter
                key={cat}
                cat={cat}
                capDollars={monthly}
                spentDollars={spentCents / 100}
                projectedDollars={projectedByCat[cat]}
              />
            );
          })}
        </div>

        {/* Urgency groups */}
        {recs.length === 0 ? (
          <div
            style={{
              background: T.paper,
              border: `1px solid ${T.rule}`,
              borderRadius: 14,
              padding: '48px 24px',
              textAlign: 'center',
              fontFamily: fonts.serif,
              fontSize: 22,
              color: T.ink2,
              fontStyle: 'italic',
            }}
          >
            Nothing to reorder — every item is above par.
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.urgency}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <StatusDot s={URG_STATUS[g.urgency]} size={10} />
                <span
                  style={{
                    fontFamily: fonts.mono,
                    fontSize: 10,
                    color: URG_COLOR[g.urgency],
                    letterSpacing: '0.14em',
                    textTransform: 'uppercase',
                    fontWeight: 600,
                  }}
                >
                  {URG_LABEL[g.urgency]}
                </span>
                <span style={{ fontFamily: fonts.mono, fontSize: 11, color: T.ink3 }}>
                  {g.recs.length}
                </span>
                <span style={{ flex: 1, height: 1, background: T.rule }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {g.recs.map((rec) => (
                  <ReorderRow
                    key={rec.itemId}
                    rec={rec}
                    line={state[rec.itemId] || { checked: false, qty: rec.suggestQty }}
                    onToggle={() =>
                      setState((s) => ({
                        ...s,
                        [rec.itemId]: {
                          ...(s[rec.itemId] ?? { checked: false, qty: rec.suggestQty }),
                          checked: !s[rec.itemId]?.checked,
                        },
                      }))
                    }
                    onQty={(v) =>
                      setState((s) => ({
                        ...s,
                        [rec.itemId]: {
                          ...(s[rec.itemId] ?? { checked: false, qty: rec.suggestQty }),
                          qty: Math.max(0, v),
                        },
                      }))
                    }
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </Overlay>
  );
}

function budgetFor(budgets: InventoryBudget[], cat: InventoryCategory): number {
  const now = new Date();
  for (const b of budgets) {
    if (b.category !== cat || !b.monthStart) continue;
    if (
      b.monthStart.getUTCFullYear() === now.getUTCFullYear() &&
      b.monthStart.getUTCMonth() === now.getUTCMonth()
    ) {
      return b.budgetCents / 100;
    }
  }
  return 0;
}

function BudgetMeter({
  cat,
  capDollars,
  spentDollars,
  projectedDollars,
}: {
  cat: InvCat;
  capDollars: number;
  spentDollars: number;
  projectedDollars: number;
}) {
  const total = spentDollars + projectedDollars;
  const over = capDollars > 0 && total > capDollars;
  const spentPct = capDollars > 0 ? Math.min(1, spentDollars / capDollars) : 0;
  const projPct = capDollars > 0 ? Math.min(1, total / capDollars) : 0;
  return (
    <div
      style={{
        background: T.paper,
        border: `1px solid ${T.rule}`,
        borderRadius: 14,
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <CatIcon cat={cat} size={22} />
        <span style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink, fontWeight: 600 }}>
          {catLabel[cat]}
        </span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            fontFamily: fonts.mono,
            fontSize: 10,
            color: T.ink3,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
          }}
        >
          this month
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span
          style={{
            fontFamily: fonts.serif,
            fontSize: 22,
            color: T.ink,
            letterSpacing: '-0.02em',
            fontWeight: 400,
            fontStyle: 'italic',
            lineHeight: 1,
          }}
        >
          {capDollars > 0 ? fmtMoney(capDollars - total) : '—'}
        </span>
        <span
          style={{
            fontFamily: fonts.sans,
            fontSize: 11,
            color: over ? statusColor.critical : T.ink2,
          }}
        >
          {capDollars > 0 ? (over ? 'over budget' : 'headroom') : 'no cap'}
        </span>
      </div>
      <span
        style={{
          position: 'relative',
          display: 'block',
          height: 7,
          borderRadius: 7,
          background: T.rule,
          overflow: 'hidden',
        }}
      >
        <span
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${spentPct * 100}%`,
            background: catColor[cat],
          }}
        />
        <span
          style={{
            position: 'absolute',
            left: `${spentPct * 100}%`,
            top: 0,
            bottom: 0,
            width: `${Math.max(0, projPct - spentPct) * 100}%`,
            background: `repeating-linear-gradient(135deg, ${catColor[cat]} 0 4px, ${catColor[cat]}66 4px 8px)`,
          }}
        />
      </span>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontFamily: fonts.mono,
          fontSize: 10,
          color: T.ink2,
          letterSpacing: '0.04em',
        }}
      >
        <span>spent {fmtMoney(spentDollars)}</span>
        {projectedDollars > 0 && <span>+ {fmtMoney(projectedDollars)}</span>}
        <span>cap {capDollars > 0 ? fmtMoney(capDollars) : '—'}</span>
      </div>
    </div>
  );
}

function ReorderRow({
  rec,
  line,
  onToggle,
  onQty,
}: {
  rec: ReorderRec & { display: DisplayItem };
  line: LineState;
  onToggle: () => void;
  onQty: (v: number) => void;
}) {
  const d = rec.display;
  const c = URG_COLOR[rec.urgency];
  const lineTotal = line.qty * (d.unitCost || 0);
  const step = rec.suggestQty >= 24 ? 12 : 1;
  return (
    <div
      style={{
        background: T.paper,
        border: `1px solid ${T.rule}`,
        borderRadius: 12,
        padding: '12px 14px 12px 18px',
        display: 'grid',
        gridTemplateColumns: '26px 40px minmax(140px, 1.2fr) minmax(120px, 1fr) 96px minmax(140px, 1.1fr) 86px',
        gap: 14,
        alignItems: 'center',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: c }} />
      <button
        type="button"
        onClick={onToggle}
        aria-label="Toggle"
        style={{
          width: 20,
          height: 20,
          borderRadius: 5,
          cursor: 'pointer',
          padding: 0,
          background: line.checked ? T.ink : 'transparent',
          border: `1.5px solid ${line.checked ? T.ink : T.rule}`,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: T.bg,
          fontSize: 12,
          lineHeight: 1,
        }}
      >
        {line.checked && '✓'}
      </button>
      <ItemThumb thumb={d.thumb} cat={d.cat} size={36} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink, fontWeight: 600 }}>
          {d.name}
        </span>
        <span
          style={{
            fontFamily: fonts.mono,
            fontSize: 10,
            color: T.ink3,
            letterSpacing: '0.04em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {(d.vendor || '—')} · lead {d.leadDays}d
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        <StockBar current={d.estimated} par={d.par} status={d.status} height={5} />
        <span
          style={{
            fontFamily: fonts.mono,
            fontSize: 10,
            color: T.ink2,
            letterSpacing: '0.04em',
            whiteSpace: 'nowrap',
          }}
        >
          {d.estimated}/{d.par} ·{' '}
          <span style={{ color: c, fontWeight: 600 }}>{d.daysLeft}d left</span>
        </span>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 30,
          border: `1px solid ${T.rule}`,
          borderRadius: 8,
          background: T.bg,
          overflow: 'hidden',
        }}
      >
        <button
          type="button"
          onClick={() => onQty(Math.max(0, line.qty - step))}
          style={{
            width: 28,
            height: '100%',
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            color: T.ink2,
            fontSize: 14,
          }}
        >
          −
        </button>
        <input
          type="number"
          value={line.qty}
          onChange={(e) => onQty(Number(e.target.value) || 0)}
          style={{
            width: 0,
            flex: 1,
            height: '100%',
            textAlign: 'center',
            border: 'none',
            background: 'transparent',
            outline: 'none',
            fontFamily: fonts.serif,
            fontSize: 15,
            fontStyle: 'italic',
            color: T.ink,
          }}
        />
        <button
          type="button"
          onClick={() => onQty(line.qty + step)}
          style={{
            width: 28,
            height: '100%',
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            color: T.ink2,
            fontSize: 14,
          }}
        >
          +
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span
          style={{
            fontFamily: fonts.sans,
            fontSize: 12,
            color: T.ink2,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {rec.packs}
        </span>
        <span
          style={{
            fontFamily: fonts.mono,
            fontSize: 10,
            color: c,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            fontWeight: 600,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {rec.reason}
        </span>
      </div>
      <span
        style={{
          fontFamily: fonts.serif,
          fontSize: 17,
          color: T.ink,
          letterSpacing: '-0.02em',
          fontWeight: 400,
          fontStyle: 'italic',
          textAlign: 'right',
        }}
      >
        {fmtMoney(lineTotal)}
      </span>
    </div>
  );
}
