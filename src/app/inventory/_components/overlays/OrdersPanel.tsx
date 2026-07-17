'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import type { OrderStatus, PurchaseOrder, SpendRollup } from '@/lib/ordering/types';

import { T, fonts, statusColor, type InvCat } from '../tokens';
import { catLabelFor } from '../inv-i18n';
import { Btn } from '../Btn';
import { Overlay } from './Overlay';
import { banner } from './form-kit';
import { fmtMoney } from '../format';
import {
  apiListOrders,
  apiReceiveOrder,
  apiSendOrder,
  apiSpendRollup,
} from '../ordering-api';

interface OrdersPanelProps {
  open: boolean;
  onClose: () => void;
  canManage: boolean;
  onChanged?: () => void;
}

// Display order: action-needed statuses first.
const STATUS_ORDER: OrderStatus[] = [
  'draft',
  'sent',
  'partially_received',
  'received',
  'cancelled',
];

function statusMeta(s: OrderStatus, lang: 'en' | 'es'): { label: string; color: string } {
  const L: Record<OrderStatus, { en: string; es: string; color: string }> = {
    draft: { en: 'Draft', es: 'Borrador', color: T.ink3 },
    sent: { en: 'Sent', es: 'Enviada', color: statusColor.good },
    partially_received: { en: 'Partially received', es: 'Recibida en parte', color: statusColor.low },
    received: { en: 'Received', es: 'Recibida', color: statusColor.good },
    cancelled: { en: 'Cancelled', es: 'Cancelada', color: statusColor.critical },
  };
  return { label: L[s][lang], color: L[s].color };
}

// Co-located strings for the orders panel — same factory convention as the
// other overlays (ssStrings / csStrings / rpStrings…).
function opStrings(lang: 'en' | 'es') {
  return {
    en: {
      eyebrow: 'Purchase orders',
      loading: 'Loading orders…',
      empty: 'No orders yet. Place one from the Reorder list.',
      done: 'Done',
      send: 'Send to vendor',
      sendEmail: 'Email order',
      resend: 'Resend',
      receive: 'Receive',
      receiveFull: 'Receive in full',
      confirmReceive: 'Confirm received',
      cancel: 'Cancel',
      vendor: 'Vendor',
      noEmail: 'No vendor email — type one to send:',
      emailPlaceholder: 'vendor@example.com',
      ordered: 'Ordered',
      received: 'Received',
      receivedTotal: 'Received total',
      short: 'Short delivery',
      lines: 'items',
      sentTo: 'sent to',
      ordersTab: 'Orders',
      spendTab: 'Cross-property spend',
      total: 'Total',
      byProperty: 'By property',
      byVendor: 'By vendor',
      byCategory: 'By category',
      uncategorized: 'Uncategorized',
      noSpend: 'No spend recorded in this window.',
      spendLoading: 'Loading spend…',
      last30: '30 days',
      last90: '90 days',
      last365: '12 months',
      order: 'order',
      orders: 'orders',
    },
    es: {
      eyebrow: 'Órdenes de compra',
      loading: 'Cargando órdenes…',
      empty: 'Aún no hay órdenes. Crea una desde la lista de reorden.',
      done: 'Listo',
      send: 'Enviar al proveedor',
      sendEmail: 'Enviar por correo',
      resend: 'Reenviar',
      receive: 'Recibir',
      receiveFull: 'Recibir completo',
      confirmReceive: 'Confirmar recibido',
      cancel: 'Cancelar',
      vendor: 'Proveedor',
      noEmail: 'Sin correo del proveedor — escribe uno para enviar:',
      emailPlaceholder: 'proveedor@ejemplo.com',
      ordered: 'Pedido',
      received: 'Recibido',
      receivedTotal: 'Total recibido',
      short: 'Entrega incompleta',
      lines: 'artículos',
      sentTo: 'enviada a',
      ordersTab: 'Órdenes',
      spendTab: 'Gasto entre propiedades',
      total: 'Total',
      byProperty: 'Por propiedad',
      byVendor: 'Por proveedor',
      byCategory: 'Por categoría',
      uncategorized: 'Sin categoría',
      noSpend: 'Sin gastos registrados en este período.',
      spendLoading: 'Cargando gasto…',
      last30: '30 días',
      last90: '90 días',
      last365: '12 meses',
      order: 'orden',
      orders: 'órdenes',
    },
  }[lang];
}

export function OrdersPanel({ open, onClose, canManage, onChanged }: OrdersPanelProps) {
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  const L = lang === 'es' ? 'es' : 'en';

  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Cross-property spend rollup (Phase E).
  const [view, setView] = useState<'orders' | 'spend'>('orders');
  const [rollup, setRollup] = useState<SpendRollup | null>(null);
  const [rollupDays, setRollupDays] = useState(90);
  const [rollupLoading, setRollupLoading] = useState(false);

  // Per-PO inline UI state.
  const [receiveFor, setReceiveFor] = useState<string | null>(null);
  const [receiveDraft, setReceiveDraft] = useState<Record<string, string>>({});
  const [emailFor, setEmailFor] = useState<string | null>(null);
  const [emailDraft, setEmailDraft] = useState('');

  const tt = useMemo(() => opStrings(L), [L]);

  const load = useCallback(async () => {
    if (!activePropertyId) return;
    setLoading(true);
    setError(null);
    try {
      setOrders(await apiListOrders(activePropertyId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load orders');
    } finally {
      setLoading(false);
    }
  }, [activePropertyId]);

  useEffect(() => {
    if (open) {
      setNotice(null);
      setReceiveFor(null);
      setEmailFor(null);
      setView('orders');
      void load();
    }
  }, [open, load]);

  // Fetch the cross-property spend rollup when the Spend tab is shown / range changes.
  useEffect(() => {
    if (!open || view !== 'spend') return;
    let cancelled = false;
    setRollupLoading(true);
    void apiSpendRollup(rollupDays)
      .then((r) => { if (!cancelled) setRollup(r); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load spend'); })
      .finally(() => { if (!cancelled) setRollupLoading(false); });
    return () => { cancelled = true; };
  }, [open, view, rollupDays]);

  const afterAction = useCallback(async () => {
    await load();
    onChanged?.();
  }, [load, onChanged]);

  // Synchronous in-flight lock: `busyId` state lags one render behind, so a
  // fast double-click on Send could email the vendor twice. (Receive doesn't
  // need this — its RPC is an idempotent cumulative target — but sending is
  // one email per call.)
  const sendLockRef = useRef<string | null>(null);
  const doSend = useCallback(
    async (po: PurchaseOrder, overrideEmail?: string) => {
      if (!activePropertyId) return;
      if (sendLockRef.current === po.id) return;
      sendLockRef.current = po.id;
      setBusyId(po.id);
      setError(null);
      try {
        await apiSendOrder(activePropertyId, po.id, overrideEmail, L);
        setNotice(`${po.poNumber} → ${tt.sentTo} ${overrideEmail || po.vendorEmail}`);
        setEmailFor(null);
        setEmailDraft('');
        await afterAction();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Send failed');
      } finally {
        sendLockRef.current = null;
        setBusyId(null);
      }
    },
    [activePropertyId, L, tt.sentTo, afterAction],
  );

  const openReceive = useCallback((po: PurchaseOrder) => {
    setReceiveFor(po.id);
    const draft: Record<string, string> = {};
    for (const l of po.lines) draft[l.id] = String(l.qtyOrdered);
    setReceiveDraft(draft);
  }, []);

  const doReceive = useCallback(
    async (po: PurchaseOrder) => {
      if (!activePropertyId) return;
      setBusyId(po.id);
      setError(null);
      try {
        const lines = po.lines.map((l) => ({
          lineId: l.id,
          qtyReceived: Math.max(0, Number(receiveDraft[l.id] ?? l.qtyReceived) || 0),
        }));
        const res = await apiReceiveOrder(activePropertyId, po.id, lines);
        setReceiveFor(null);
        if (res.shortLines.length > 0) {
          setNotice(`${po.poNumber}: ${tt.short} (${res.shortLines.length} ${tt.lines})`);
        }
        await afterAction();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Receive failed');
      } finally {
        setBusyId(null);
      }
    },
    [activePropertyId, receiveDraft, tt.short, tt.lines, afterAction],
  );

  const grouped = useMemo(() => {
    const by = new Map<OrderStatus, PurchaseOrder[]>();
    for (const o of orders) {
      const arr = by.get(o.status) ?? [];
      arr.push(o);
      by.set(o.status, arr);
    }
    return STATUS_ORDER.filter((s) => (by.get(s)?.length ?? 0) > 0).map((s) => ({ status: s, pos: by.get(s)! }));
  }, [orders]);

  return (
    <Overlay
      open={open}
      onClose={onClose}
      eyebrow={tt.eyebrow}
      suffix={`${orders.length} ${orders.length === 1 ? tt.order : tt.orders}`}
      accent={statusColor.good}
      width={1080}
      footer={
        <Btn variant="ghost" size="md" onClick={onClose}>
          {tt.done}
        </Btn>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {notice && (
          <div style={banner(statusColor.good)}>{notice}</div>
        )}
        {error && <div style={banner(statusColor.critical)}>{error}</div>}

        {/* Orders | Cross-property spend tabs */}
        <div style={{ display: 'flex', gap: 6 }}>
          {(['orders', 'spend'] as const).map((v) => (
            <button key={v} type="button" onClick={() => setView(v)} style={tabStyle(view === v)}>
              {v === 'orders' ? tt.ordersTab : tt.spendTab}
            </button>
          ))}
        </div>

        {view === 'orders' && (loading ? (
          <div style={emptyBox}>{tt.loading}</div>
        ) : orders.length === 0 ? (
          <div style={emptyBox}>{tt.empty}</div>
        ) : (
          grouped.map(({ status, pos }) => {
            const meta = statusMeta(status, L);
            return (
              <div key={status}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: meta.color }} />
                  <span style={{ fontFamily: fonts.mono, fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: meta.color, fontWeight: 600 }}>
                    {meta.label}
                  </span>
                  <span style={{ fontFamily: fonts.mono, fontSize: 11, color: T.ink3 }}>{pos.length}</span>
                  <span style={{ flex: 1, height: 1, background: T.rule }} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {pos.map((po) => (
                    <OrderCard
                      key={po.id}
                      po={po}
                      tt={tt}
                      canManage={canManage}
                      busy={busyId === po.id}
                      receiveOpen={receiveFor === po.id}
                      receiveDraft={receiveDraft}
                      setReceiveDraft={setReceiveDraft}
                      emailOpen={emailFor === po.id}
                      emailDraft={emailDraft}
                      setEmailDraft={setEmailDraft}
                      onOpenEmail={() => { setEmailFor(po.id); setEmailDraft(po.vendorEmail ?? ''); }}
                      onSend={() => doSend(po)}
                      onSendEmail={() => doSend(po, emailDraft.trim())}
                      onOpenReceive={() => openReceive(po)}
                      onCancelReceive={() => setReceiveFor(null)}
                      onReceiveFull={() => {
                        const d: Record<string, string> = {};
                        for (const l of po.lines) d[l.id] = String(l.qtyOrdered);
                        setReceiveDraft(d);
                      }}
                      onConfirmReceive={() => doReceive(po)}
                    />
                  ))}
                </div>
              </div>
            );
          })
        ))}

        {view === 'spend' && (
          <SpendView rollup={rollup} loading={rollupLoading} days={rollupDays} setDays={setRollupDays} tt={tt} lang={L} />
        )}
      </div>
    </Overlay>
  );
}

function SpendView({
  rollup,
  loading,
  days,
  setDays,
  tt,
  lang,
}: {
  rollup: SpendRollup | null;
  loading: boolean;
  days: number;
  setDays: (d: number) => void;
  tt: Record<string, string>;
  lang: 'en' | 'es';
}) {
  const ranges: Array<{ d: number; label: string }> = [
    { d: 30, label: tt.last30 },
    { d: 90, label: tt.last90 },
    { d: 365, label: tt.last365 },
  ];
  const breakdown = (title: string, rows: SpendRollup['byProperty']) => (
    <div style={{ flex: 1, minWidth: 220 }}>
      <div style={{ fontFamily: fonts.mono, fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.ink3, fontWeight: 600, marginBottom: 8 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {rows.length === 0 ? (
          <span style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink3 }}>—</span>
        ) : rows.map((r) => (
          <div key={r.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontFamily: fonts.sans, fontSize: 13, color: T.ink }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
            <span style={{ fontFamily: fonts.mono, color: T.ink2 }}>{fmtMoney(r.spentCents / 100)}</span>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {ranges.map((r) => (
          <button key={r.d} type="button" onClick={() => setDays(r.d)} style={tabStyle(days === r.d)}>{r.label}</button>
        ))}
      </div>
      {loading ? (
        <div style={emptyBox}>{tt.spendLoading}</div>
      ) : !rollup || rollup.totalCents === 0 ? (
        <div style={emptyBox}>{tt.noSpend}</div>
      ) : (
        <>
          <div style={{ background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 14, padding: '16px 18px', display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ fontFamily: fonts.mono, fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.ink3 }}>{tt.total}</span>
            <span style={{ fontFamily: fonts.sans, fontSize: 30, fontWeight: 600, letterSpacing: '-0.02em', color: T.ink }}>{fmtMoney(rollup.totalCents / 100)}</span>
          </div>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 14, padding: '16px 18px' }}>
            {breakdown(tt.byProperty, rollup.byProperty)}
            {breakdown(tt.byVendor, rollup.byVendor)}
            {/* Server rows carry raw enum keys ('housekeeping') — translate for
                display; the catch-all bucket gets a localized label too. */}
            {breakdown(tt.byCategory, rollup.byCategory.map((r) => ({
              ...r,
              label: (['housekeeping', 'maintenance', 'breakfast'] as const).includes(r.key as InvCat)
                ? catLabelFor(lang, r.key as InvCat)
                : r.label === 'Uncategorized' ? tt.uncategorized : r.label,
            })))}
          </div>
        </>
      )}
    </div>
  );
}

function tabStyle(active: boolean): React.CSSProperties {
  return {
    padding: '6px 14px',
    borderRadius: 999,
    cursor: 'pointer',
    background: active ? T.ink : 'transparent',
    color: active ? T.bg : T.ink2,
    border: `1px solid ${active ? T.ink : T.rule}`,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: 600,
  };
}

function OrderCard({
  po,
  tt,
  canManage,
  busy,
  receiveOpen,
  receiveDraft,
  setReceiveDraft,
  emailOpen,
  emailDraft,
  setEmailDraft,
  onOpenEmail,
  onSend,
  onSendEmail,
  onOpenReceive,
  onCancelReceive,
  onReceiveFull,
  onConfirmReceive,
}: {
  po: PurchaseOrder;
  tt: Record<string, string>;
  canManage: boolean;
  busy: boolean;
  receiveOpen: boolean;
  receiveDraft: Record<string, string>;
  setReceiveDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  emailOpen: boolean;
  emailDraft: string;
  setEmailDraft: (v: string) => void;
  onOpenEmail: () => void;
  onSend: () => void;
  onSendEmail: () => void;
  onOpenReceive: () => void;
  onCancelReceive: () => void;
  onReceiveFull: () => void;
  onConfirmReceive: () => void;
}) {
  const canSend = po.status === 'draft';
  const canResend = po.status === 'sent';
  const canReceive = ['sent', 'partially_received'].includes(po.status);

  return (
    <div style={{ background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 12, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: fonts.mono, fontSize: 13, fontWeight: 700, color: T.ink }}>{po.poNumber}</span>
        <span style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2 }}>{po.vendorName || '—'}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: fonts.sans, fontSize: 18, fontWeight: 600, letterSpacing: '-0.02em', color: T.ink }}>{fmtMoney(po.subtotalCents / 100)}</span>
      </div>
      <div style={{ fontFamily: fonts.mono, fontSize: 10, color: T.ink3, letterSpacing: '0.04em' }}>
        {po.lines.length} {tt.lines}
        {po.sentToEmail ? ` · ${tt.sentTo} ${po.sentToEmail}` : ''}
      </div>

      {/* Receive form */}
      {receiveOpen && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: `1px solid ${T.rule}`, paddingTop: 10 }}>
          {po.lines.map((l) => (
            <div key={l.id} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 110px', gap: 10, alignItems: 'center' }}>
              <span style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink }}>{l.description}</span>
              <span style={{ fontFamily: fonts.mono, fontSize: 11, color: T.ink2 }}>{tt.ordered} {l.qtyOrdered}</span>
              <input
                type="number"
                value={receiveDraft[l.id] ?? ''}
                min={0}
                onChange={(e) => setReceiveDraft((d) => ({ ...d, [l.id]: e.target.value }))}
                aria-label={tt.receivedTotal}
                style={{ height: 30, border: `1px solid ${T.rule}`, borderRadius: 8, padding: '0 8px', fontFamily: fonts.mono, fontSize: 13, background: T.bg, color: T.ink }}
              />
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
            <Btn variant="ghost" size="sm" onClick={onReceiveFull}>{tt.receiveFull}</Btn>
            <Btn variant="ghost" size="sm" onClick={onCancelReceive}>{tt.cancel}</Btn>
            <Btn variant="primary" size="sm" disabled={busy} onClick={onConfirmReceive}>{tt.confirmReceive}</Btn>
          </div>
        </div>
      )}

      {/* Email-to-send form (no vendor email on file) */}
      {emailOpen && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: `1px solid ${T.rule}`, paddingTop: 10 }}>
          <span style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink2 }}>{tt.noEmail}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="email"
              value={emailDraft}
              placeholder={tt.emailPlaceholder}
              onChange={(e) => setEmailDraft(e.target.value)}
              style={{ flex: 1, height: 32, border: `1px solid ${T.rule}`, borderRadius: 8, padding: '0 10px', fontFamily: fonts.sans, fontSize: 13, background: T.bg, color: T.ink }}
            />
            <Btn variant="primary" size="sm" disabled={busy || !emailDraft.trim()} onClick={onSendEmail}>{tt.sendEmail}</Btn>
          </div>
        </div>
      )}

      {/* Actions */}
      {canManage && !receiveOpen && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          {canSend && (po.vendorEmail
            ? <Btn variant="primary" size="sm" disabled={busy} onClick={onSend}>{tt.send}</Btn>
            : <Btn variant="primary" size="sm" disabled={busy} onClick={onOpenEmail}>{tt.send}</Btn>)}
          {canResend && <Btn variant="ghost" size="sm" disabled={busy} onClick={po.vendorEmail ? onSend : onOpenEmail}>{tt.resend}</Btn>}
          {canReceive && <Btn variant="ghost" size="sm" disabled={busy} onClick={onOpenReceive}>{tt.receive}</Btn>}
        </div>
      )}
    </div>
  );
}

const emptyBox: React.CSSProperties = {
  background: T.paper,
  border: `1px solid ${T.rule}`,
  borderRadius: 14,
  padding: '48px 24px',
  textAlign: 'center',
  fontFamily: fonts.sans,
  fontSize: 20,
  fontWeight: 600,
  letterSpacing: '-0.02em',
  color: T.ink2,
};
