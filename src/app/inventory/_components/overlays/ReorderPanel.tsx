'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import type { InventoryItem, InventoryBudget, InventoryCategory } from '@/types';
import type { DailyAverages } from '@/lib/inventory-predictions';
import type { CartLineInput, OrderingMode } from '@/lib/ordering/types';
import { apiCreateOrders, apiSendOrder } from '../ordering-api';

import { T, fonts, statusColor, catColor, type InvCat } from '../tokens';
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
import { catLabelFor, type Lang } from '../inv-i18n';

interface ReorderPanelProps {
  open: boolean;
  onClose: () => void;
  items: InventoryItem[];
  display: DisplayItem[];
  budgets: InventoryBudget[];
  spendByCat: Record<string, number>;
  averages: DailyAverages | null;
  mlRateMap: Map<string, number>;
  /** Only management can place orders (owner/GM/admin). Non-managers see the
   *  reorder list but the place button is disabled. */
  canManage: boolean;
  /** Money capability (view_financials) — gates the per-category budget-vs-spend
   *  meters. The reorder list itself (what to order) stays visible to staff.
   *  (Access cleanup 2026-06-26.) */
  canViewFinancials: boolean;
  orderingMode: OrderingMode;
  /** Jump to the Orders panel after placing. */
  onViewOrders: () => void;
}

type LineState = { checked: boolean; qty: number };

const URG_LABEL: Record<Lang, Record<'now' | 'soon' | 'ok', string>> = {
  en: { now: 'Order now', soon: 'Order soon', ok: 'OK for now' },
  es: { now: 'Pedir ahora', soon: 'Pedir pronto', ok: 'Bien por ahora' },
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
  canManage,
  canViewFinancials,
  orderingMode,
  onViewOrders,
}: ReorderPanelProps) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  const L = lang === 'es' ? 'es' : 'en';

  // Build recommendations once per (open, data) cycle.
  const recs: Array<ReorderRec & { display: DisplayItem }> = useMemo(() => {
    if (!open) return [];
    const out: Array<ReorderRec & { display: DisplayItem }> = [];
    for (const d of display) {
      // Never-counted items (new-hotel day 1: 0 stock, no count) have no real
      // signal — don't recommend ordering "par" of something nobody has
      // counted. They appear in the board's neutral "not counted yet" section
      // instead; count them first, then they rejoin the reorder list.
      if (d.uncounted) continue;
      const { urgency, reason } = recommendReorder(d, averages, mlRateMap, L);
      // Hide truly fine items (status=good AND urgency=ok AND not below par) from the panel.
      if (urgency === 'ok' && d.status === 'good') continue;
      const sq = suggestQuantity(d, L);
      out.push({
        itemId: d.id,
        suggestQty: sq.qty,
        packs: sq.packsLabel,
        cost: sq.qty * (d.unitCost || 0),
        reason,
        urgency,
        burnSource: d.burnSource,
        display: d,
      });
    }
    // Stable ordering: now first, then soon, then ok; within group sort by daysLeft asc.
    const ord = { now: 0, soon: 1, ok: 2 } as const;
    out.sort((a, b) =>
      ord[a.urgency] - ord[b.urgency] || a.display.daysLeft - b.display.daysLeft,
    );
    return out;
  }, [open, display, averages, mlRateMap, L]);

  // Honesty-audit Phase 4: detect newly-onboarded hotel (every rec is
  // fallback-60d or no-data) so we can render the onboarding banner instead
  // of letting the GM stare at a list of unchecked items with no explanation.
  const allRecsAreFallback =
    recs.length > 0 &&
    recs.every((r) => r.burnSource === 'fallback-60d' || r.burnSource === 'no-data');

  const [state, setState] = useState<Record<string, LineState>>({});
  const [saving, setSaving] = useState(false);
  const [placeResult, setPlaceResult] = useState<
    { placed: number; sent: number; draft: number; errors: string[] } | null
  >(null);

  // Reset state whenever recs change (e.g. panel reopens with new data).
  // Honesty-audit Phase 4: only pre-check items that have REAL signal
  // (ML prediction or operator-configured rule). Items that ended up in
  // the panel via the par/60 fallback don't have enough evidence to
  // auto-include in the cart — the GM should explicitly opt them in.
  useEffect(() => {
    if (!open) return;
    setPlaceResult(null);
    const next: Record<string, LineState> = {};
    for (const r of recs) {
      const hasRealSignal = r.burnSource === 'ml' || r.burnSource === 'rule-occupancy';
      next[r.itemId] = { checked: r.urgency === 'now' && hasRealSignal, qty: r.suggestQty };
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

  // Place orders: create real purchase_orders grouped BY VENDOR (server-side),
  // then — in simple mode — auto-email each vendor that has an address on file.
  // Pro mode stops at 'pending_approval' (approve from the Orders panel).
  const handlePlaceOrders = async () => {
    if (!user || !activePropertyId || saving || cartItems.length === 0 || !canManage) return;
    setSaving(true);
    try {
      const lines: CartLineInput[] = cartItems.map((r) => ({
        itemId: r.itemId,
        description: r.display.name,
        qtyOrdered: state[r.itemId]?.qty || 0,
        // dollars → cents at the boundary
        unitCostCents: Math.round((r.display.unitCost || 0) * 100),
        vendorName: r.display.vendor || null,
        vendorId: null,
      }));
      const { orders, mode } = await apiCreateOrders(activePropertyId, lines);

      let sent = 0;
      let draft = 0;
      const errors: string[] = [];
      if (mode === 'simple') {
        // Auto-send to any vendor with an email; others stay as drafts to send
        // from the Orders panel once an address is added.
        for (const po of orders) {
          if (po.vendorEmail) {
            try {
              await apiSendOrder(activePropertyId, po.id, undefined, L);
              sent++;
            } catch (e) {
              draft++;
              errors.push(`${po.poNumber}: ${e instanceof Error ? e.message : 'send failed'}`);
            }
          } else {
            draft++;
          }
        }
      }
      // Clear the cart so re-clicking can't double-order.
      setState((s) => {
        const next = { ...s };
        for (const r of cartItems) if (next[r.itemId]) next[r.itemId] = { ...next[r.itemId], checked: false };
        return next;
      });
      setPlaceResult({ placed: orders.length, sent, draft, errors });
    } catch (err) {
      setPlaceResult({
        placed: 0,
        sent: 0,
        draft: 0,
        errors: [err instanceof Error ? err.message : 'Placing the orders failed.'],
      });
    } finally {
      setSaving(false);
    }
  };

  const TT = {
    place: orderingMode === 'pro'
      ? { en: 'Submit for approval →', es: 'Enviar a aprobación →' }[L]
      : { en: 'Place & email orders →', es: 'Crear y enviar órdenes →' }[L],
    placing: { en: 'Placing…', es: 'Creando…' }[L],
    close: { en: 'Close', es: 'Cerrar' }[L],
    viewOrders: { en: 'View orders →', es: 'Ver órdenes →' }[L],
    managerOnly: { en: 'Only managers can place orders.', es: 'Solo gerentes pueden crear órdenes.' }[L],
    proNote: { en: 'Orders will need approval before they can be sent.', es: 'Las órdenes necesitarán aprobación antes de enviarse.' }[L],
    reorder: { en: 'Reorder', es: 'Pedido' }[L],
    item: { en: 'item', es: 'artículo' }[L],
    items: { en: 'items', es: 'artículos' }[L],
    inCart: { en: 'in cart', es: 'en carrito' }[L],
    vendor: { en: 'vendor', es: 'proveedor' }[L],
    vendors: { en: 'vendors', es: 'proveedores' }[L],
    noUsageDataYet: { en: 'No usage data yet.', es: 'Aún no hay datos de uso.' }[L],
    onboardingBanner: {
      en: ' These suggestions are based on par levels, not real usage. Add a few counts so the AI can learn how fast each item moves — once it’s seen ~3 counts per item it’ll start predicting daily rates and pre-checking what’s actually low.',
      es: ' Estas sugerencias se basan en niveles par, no en uso real. Agrega algunos conteos para que la IA aprenda qué tan rápido se mueve cada artículo — tras ~3 conteos por artículo empezará a predecir tasas diarias y a preseleccionar lo que está bajo.',
    }[L],
    nothingToReorder: { en: 'Nothing to reorder — every item is above par.', es: 'Nada que pedir — todos los artículos están sobre el par.' }[L],
    thisMonth: { en: 'this month', es: 'este mes' }[L],
    overBudget: { en: 'over budget', es: 'sobre presupuesto' }[L],
    headroom: { en: 'headroom', es: 'disponible' }[L],
    noCap: { en: 'no cap', es: 'sin límite' }[L],
    spent: { en: 'spent', es: 'gastado' }[L],
    cap: { en: 'cap', es: 'límite' }[L],
    daysLeftSuffix: { en: 'd left', es: 'd restantes' }[L],
    lead: { en: 'lead', es: 'entrega' }[L],
  };

  const resultMsg = placeResult
    ? (placeResult.placed === 0
        ? (placeResult.errors[0] ?? '—')
        : orderingMode === 'pro'
          ? { en: `${placeResult.placed} order(s) created — pending approval.`, es: `${placeResult.placed} orden(es) creada(s) — pendientes de aprobación.` }[L]
          : { en: `${placeResult.placed} order(s) placed · ${placeResult.sent} emailed${placeResult.draft ? `, ${placeResult.draft} saved as draft (add a vendor email to send)` : ''}.`, es: `${placeResult.placed} orden(es) creada(s) · ${placeResult.sent} enviada(s)${placeResult.draft ? `, ${placeResult.draft} en borrador (agrega un correo del proveedor para enviar)` : ''}.` }[L])
    : null;

  return (
    <Overlay
      open={open}
      onClose={onClose}
      eyebrow={`${TT.reorder} · ${recs.length} ${recs.length === 1 ? TT.item : TT.items}`}
      italic={canViewFinancials ? fmtMoney(cartTotal) : ''}
      suffix={`${cartItems.length} ${TT.inCart} · ${distinctVendors} ${distinctVendors === 1 ? TT.vendor : TT.vendors}`}
      accent={statusColor.critical}
      width={1080}
      footer={
        <>
          <Btn variant="ghost" size="md" onClick={onClose}>
            {TT.close}
          </Btn>
          {placeResult && placeResult.placed > 0 && (
            <Btn variant="ghost" size="md" onClick={onViewOrders}>
              {TT.viewOrders}
            </Btn>
          )}
          <Btn
            variant="primary"
            size="md"
            disabled={saving || cartItems.length === 0 || !canManage}
            onClick={handlePlaceOrders}
            style={{ opacity: canManage && cartItems.length ? 1 : 0.4 }}
          >
            {saving ? TT.placing : TT.place}
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        {/* Place-orders result / manager-only / pro-mode notices */}
        {resultMsg && (
          <div
            style={{
              background: T.paper,
              border: `1px solid ${placeResult && placeResult.placed > 0 ? statusColor.good : statusColor.critical}`,
              borderLeft: `3px solid ${placeResult && placeResult.placed > 0 ? statusColor.good : statusColor.critical}`,
              borderRadius: 10,
              padding: '12px 14px',
              fontFamily: fonts.sans,
              fontSize: 13,
              color: T.ink,
            }}
          >
            {resultMsg}
          </div>
        )}
        {!canManage && (
          <div style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink2 }}>{TT.managerOnly}</div>
        )}
        {canManage && orderingMode === 'pro' && !placeResult && (
          <div style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink2 }}>{TT.proNote}</div>
        )}

        {/* Budget meters — budget vs spend dollars, money-capability only.
            Line staff still see the reorder list below; just not the budget. */}
        {canViewFinancials && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            {(['housekeeping', 'maintenance', 'breakfast'] as InvCat[]).map((cat) => {
              const monthly = budgetFor(budgets, cat as InventoryCategory);
              const spentCents = spendByCat[cat] ?? 0;
              return (
                <BudgetMeter
                  key={cat}
                  lang={L}
                  tt={TT}
                  cat={cat}
                  capDollars={monthly}
                  spentDollars={spentCents / 100}
                  projectedDollars={projectedByCat[cat]}
                />
              );
            })}
          </div>
        )}

        {/* Honesty-audit Phase 4 onboarding banner: when EVERY rec is from
            the par/60 fallback (no ML model AND no operator-configured
            usage rule), tell the GM why nothing is pre-checked instead of
            leaving them to guess. */}
        {allRecsAreFallback && (
          <div
            style={{
              background: T.paper,
              border: `1px solid ${T.rule}`,
              borderRadius: 12,
              padding: '14px 16px',
              fontFamily: fonts.sans,
              fontSize: 13,
              color: T.ink2,
              lineHeight: 1.5,
            }}
          >
            <b style={{ color: T.ink }}>{TT.noUsageDataYet}</b>
            {TT.onboardingBanner}
          </div>
        )}

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
            {TT.nothingToReorder}
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
                  {URG_LABEL[L][g.urgency]}
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
                    daysLeftSuffix={TT.daysLeftSuffix}
                    leadLabel={TT.lead}
                    showCost={canViewFinancials}
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
  lang,
  tt,
  cat,
  capDollars,
  spentDollars,
  projectedDollars,
}: {
  lang: Lang;
  tt: { thisMonth: string; overBudget: string; headroom: string; noCap: string; spent: string; cap: string };
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
          {catLabelFor(lang, cat)}
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
          {tt.thisMonth}
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
          {capDollars > 0 ? (over ? tt.overBudget : tt.headroom) : tt.noCap}
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
        <span>{tt.spent} {fmtMoney(spentDollars)}</span>
        {projectedDollars > 0 && <span>+ {fmtMoney(projectedDollars)}</span>}
        <span>{tt.cap} {capDollars > 0 ? fmtMoney(capDollars) : '—'}</span>
      </div>
    </div>
  );
}

function ReorderRow({
  daysLeftSuffix,
  leadLabel,
  showCost,
  rec,
  line,
  onToggle,
  onQty,
}: {
  daysLeftSuffix: string;
  leadLabel: string;
  /** Show the per-line dollar cost. False for non-financial roles — they still
   *  see the item, quantity, urgency and days-left, just not the money. */
  showCost: boolean;
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
          {(d.vendor || '—')} · {leadLabel} {d.leadDays}d
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
          <span style={{ color: c, fontWeight: 600 }}>{d.daysLeft}{daysLeftSuffix}</span>
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
      {/* Per-line cost ($) — money-capability only. The grid cell stays so the
          row layout is unchanged; only the dollar amount is withheld. */}
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
        {showCost ? fmtMoney(lineTotal) : ''}
      </span>
    </div>
  );
}
