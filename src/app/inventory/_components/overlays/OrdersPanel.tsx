'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import type { OrderStatus, OrderingMode, PurchaseOrder } from '@/lib/ordering/types';

import { T, fonts, statusColor } from '../tokens';
import { Btn } from '../Btn';
import { Overlay } from './Overlay';
import { fmtMoney } from '../format';
import {
  apiApproveOrder,
  apiListOrders,
  apiReceiveOrder,
  apiSendOrder,
} from '../ordering-api';

interface OrdersPanelProps {
  open: boolean;
  onClose: () => void;
  canManage: boolean;
  orderingMode: OrderingMode;
  onChanged?: () => void;
}

// Display order: action-needed statuses first.
const STATUS_ORDER: OrderStatus[] = [
  'pending_approval',
  'approved',
  'draft',
  'sent',
  'partially_received',
  'received',
  'cancelled',
];

function statusMeta(s: OrderStatus, lang: 'en' | 'es'): { label: string; color: string } {
  const L: Record<OrderStatus, { en: string; es: string; color: string }> = {
    draft: { en: 'Draft', es: 'Borrador', color: T.ink3 },
    pending_approval: { en: 'Needs approval', es: 'Requiere aprobación', color: statusColor.low },
    approved: { en: 'Approved', es: 'Aprobada', color: '#3F5A43' },
    sent: { en: 'Sent', es: 'Enviada', color: statusColor.good },
    partially_received: { en: 'Partially received', es: 'Recibida en parte', color: statusColor.low },
    received: { en: 'Received', es: 'Recibida', color: statusColor.good },
    cancelled: { en: 'Cancelled', es: 'Cancelada', color: statusColor.critical },
  };
  return { label: L[s][lang], color: L[s].color };
}

export function OrdersPanel({ open, onClose, canManage, orderingMode, onChanged }: OrdersPanelProps) {
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  const L = lang === 'es' ? 'es' : 'en';

  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Per-PO inline UI state.
  const [receiveFor, setReceiveFor] = useState<string | null>(null);
  const [receiveDraft, setReceiveDraft] = useState<Record<string, string>>({});
  const [emailFor, setEmailFor] = useState<string | null>(null);
  const [emailDraft, setEmailDraft] = useState('');

  const tt = useMemo(
    () => ({
      eyebrow: { en: 'Purchase orders', es: 'Órdenes de compra' }[L],
      loading: { en: 'Loading orders…', es: 'Cargando órdenes…' }[L],
      empty: { en: 'No orders yet. Place one from the Reorder list.', es: 'Aún no hay órdenes. Crea una desde la lista de reorden.' }[L],
      done: { en: 'Done', es: 'Listo' }[L],
      send: { en: 'Send to vendor', es: 'Enviar al proveedor' }[L],
      sendEmail: { en: 'Email order', es: 'Enviar por correo' }[L],
      resend: { en: 'Resend', es: 'Reenviar' }[L],
      approve: { en: 'Approve', es: 'Aprobar' }[L],
      receive: { en: 'Receive', es: 'Recibir' }[L],
      receiveFull: { en: 'Receive in full', es: 'Recibir completo' }[L],
      confirmReceive: { en: 'Confirm received', es: 'Confirmar recibido' }[L],
      cancel: { en: 'Cancel', es: 'Cancelar' }[L],
      vendor: { en: 'Vendor', es: 'Proveedor' }[L],
      noEmail: { en: 'No vendor email — type one to send:', es: 'Sin correo del proveedor — escribe uno para enviar:' }[L],
      emailPlaceholder: { en: 'vendor@example.com', es: 'proveedor@ejemplo.com' }[L],
      ordered: { en: 'Ordered', es: 'Pedido' }[L],
      received: { en: 'Received', es: 'Recibido' }[L],
      receivedTotal: { en: 'Received total', es: 'Total recibido' }[L],
      short: { en: 'Short delivery', es: 'Entrega incompleta' }[L],
      lines: { en: 'items', es: 'artículos' }[L],
      sentTo: { en: 'sent to', es: 'enviada a' }[L],
    }),
    [L],
  );

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
      void load();
    }
  }, [open, load]);

  const afterAction = useCallback(async () => {
    await load();
    onChanged?.();
  }, [load, onChanged]);

  const doSend = useCallback(
    async (po: PurchaseOrder, overrideEmail?: string) => {
      if (!activePropertyId) return;
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
        setBusyId(null);
      }
    },
    [activePropertyId, L, tt.sentTo, afterAction],
  );

  const doApprove = useCallback(
    async (po: PurchaseOrder) => {
      if (!activePropertyId) return;
      setBusyId(po.id);
      setError(null);
      try {
        await apiApproveOrder(activePropertyId, po.id);
        await afterAction();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Approve failed');
      } finally {
        setBusyId(null);
      }
    },
    [activePropertyId, afterAction],
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
      italic={orderingMode === 'pro' ? 'Pro' : ''}
      suffix={`${orders.length} ${orders.length === 1 ? 'order' : 'orders'}`}
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

        {loading ? (
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
                      onApprove={() => doApprove(po)}
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
        )}
      </div>
    </Overlay>
  );
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
  onApprove,
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
  onApprove: () => void;
  onOpenReceive: () => void;
  onCancelReceive: () => void;
  onReceiveFull: () => void;
  onConfirmReceive: () => void;
}) {
  const canSend = po.status === 'draft' || po.status === 'approved';
  const canResend = po.status === 'sent';
  const canApprove = po.status === 'pending_approval';
  const canReceive = ['sent', 'partially_received', 'approved'].includes(po.status);

  return (
    <div style={{ background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 12, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: fonts.mono, fontSize: 13, fontWeight: 700, color: T.ink }}>{po.poNumber}</span>
        <span style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2 }}>{po.vendorName || '—'}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: fonts.serif, fontSize: 18, fontStyle: 'italic', color: T.ink }}>{fmtMoney(po.subtotalCents / 100)}</span>
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
          {canApprove && <Btn variant="primary" size="sm" disabled={busy} onClick={onApprove}>{tt.approve}</Btn>}
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
  fontFamily: fonts.serif,
  fontSize: 20,
  color: T.ink2,
  fontStyle: 'italic',
};

function banner(color: string): React.CSSProperties {
  return {
    background: T.paper,
    border: `1px solid ${color}`,
    borderLeft: `3px solid ${color}`,
    borderRadius: 10,
    padding: '10px 14px',
    fontFamily: fonts.sans,
    fontSize: 13,
    color: T.ink,
  };
}
