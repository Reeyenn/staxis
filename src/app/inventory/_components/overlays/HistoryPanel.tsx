'use client';

// History v2 (2026-07-18): the feed reads as WHAT THE PERSON DID — "Started a
// count", "Scanned an invoice", "Added a delivery", "Added new items" — one
// row per action, and clicking a row expands the per-item detail (what was
// counted / what arrived, with the change). Event grouping + classification
// live in ../history-events.ts; this file owns only the display strings and
// the accordion UI.

import React, { useMemo, useState } from 'react';
import { shortDateFromDate } from '@/lib/format-date';
import { T, fonts, statusColor } from '../tokens';
import { Overlay } from './Overlay';
import { fmtMoney } from '../format';
import { type Lang } from '../inv-i18n';
import type { HistoryEvent, HistoryEventKind, HistoryLine } from '../history-events';

interface HistoryPanelProps {
  lang: Lang;
  open: boolean;
  onClose: () => void;
  events: HistoryEvent[];
  canViewFinancials: boolean;
}

function hpStrings(lang: Lang) {
  return {
    en: {
      eyebrow: 'History',
      italic: 'What your team did',
      event: 'action',
      events: 'actions',
      noHistory: 'Nothing yet — counts, deliveries and new items will show up here.',
      // Event titles
      startedCount: 'Started a count',
      quickCount: (item: string) => `Quick count · ${item}`,
      scannedInvoice: 'Scanned an invoice',
      addedDelivery: 'Added a delivery',
      aiMarkedOrdered: 'AI assistant · marked as ordered',
      addedItems: (n: number) => (n === 1 ? 'Added a new item' : `Added ${n} new items`),
      // Pills
      pillCount: 'Count',
      pillQuick: 'Quick count',
      pillScan: 'Invoice',
      pillDelivery: 'Delivery',
      pillAssistant: 'AI',
      pillItems: 'New items',
      // Detail
      byAI: 'Staxis AI',
      team: 'team',
      invoiceNo: (n: string) => `invoice #${n}`,
      item: 'item',
      items: 'items',
      counted: 'counted',
      received: 'received',
      cases: (n: number) => `${n} ${n === 1 ? 'case' : 'cases'}`,
      asExpected: 'as expected',
      close: 'Hide details',
      showDetails: 'Show details',
    },
    es: {
      eyebrow: 'Historial',
      italic: 'Lo que hizo su equipo',
      event: 'acción',
      events: 'acciones',
      noHistory: 'Nada aún — los conteos, entregas y artículos nuevos aparecerán aquí.',
      startedCount: 'Conteo iniciado',
      quickCount: (item: string) => `Conteo rápido · ${item}`,
      scannedInvoice: 'Factura escaneada',
      addedDelivery: 'Entrega agregada',
      aiMarkedOrdered: 'Asistente IA · marcado como pedido',
      addedItems: (n: number) => (n === 1 ? 'Artículo nuevo agregado' : `${n} artículos nuevos agregados`),
      pillCount: 'Conteo',
      pillQuick: 'Conteo rápido',
      pillScan: 'Factura',
      pillDelivery: 'Entrega',
      pillAssistant: 'IA',
      pillItems: 'Artículos',
      byAI: 'Staxis IA',
      team: 'equipo',
      invoiceNo: (n: string) => `factura #${n}`,
      item: 'artículo',
      items: 'artículos',
      counted: 'contado',
      received: 'recibido',
      cases: (n: number) => `${n} ${n === 1 ? 'caja' : 'cajas'}`,
      asExpected: 'como se esperaba',
      close: 'Ocultar detalle',
      showDetails: 'Ver detalle',
    },
  }[lang];
}

export function HistoryPanel({ lang, open, onClose, events, canViewFinancials }: HistoryPanelProps) {
  const hp = useMemo(() => hpStrings(lang), [lang]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const timeFmt = useMemo(
    () => new Intl.DateTimeFormat(lang === 'es' ? 'es' : 'en', { hour: 'numeric', minute: '2-digit' }),
    [lang],
  );

  const pill: Record<HistoryEventKind, { label: string; color: string; bg: string }> = {
    count: { label: hp.pillCount, color: T.purple, bg: T.purpleDim },
    quickcount: { label: hp.pillQuick, color: T.purple, bg: T.purpleDim },
    scan: { label: hp.pillScan, color: T.tealText, bg: T.tealDim },
    delivery: { label: hp.pillDelivery, color: T.sageDeep, bg: T.sageDim },
    assistant: { label: hp.pillAssistant, color: T.goldText, bg: T.goldDim },
    itemsAdded: { label: hp.pillItems, color: T.ink2, bg: T.inkWash },
  };

  const titleFor = (e: HistoryEvent): string => {
    switch (e.kind) {
      case 'count': return hp.startedCount;
      case 'quickcount': return hp.quickCount(e.lines[0]?.name ?? '');
      case 'scan': return hp.scannedInvoice;
      case 'delivery': return hp.addedDelivery;
      case 'assistant': return hp.aiMarkedOrdered;
      case 'itemsAdded': return hp.addedItems(e.lines.length);
    }
  };

  const subFor = (e: HistoryEvent): string => {
    const parts: string[] = [];
    if (e.byAssistant) parts.push(hp.byAI);
    else if (e.who) parts.push(e.who);
    if (e.kind === 'scan' && e.invoiceNumber) parts.push(hp.invoiceNo(e.invoiceNumber));
    if (e.kind !== 'quickcount') {
      parts.push(`${e.lines.length} ${e.lines.length === 1 ? hp.item : hp.items}`);
    }
    return parts.join(' · ');
  };

  return (
    <Overlay
      open={open}
      onClose={onClose}
      eyebrow={hp.eyebrow}
      italic={hp.italic}
      suffix={`${events.length} ${events.length === 1 ? hp.event : hp.events}`}
      width={860}
    >
      <div style={{ background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 14, padding: '4px 20px' }}>
        {events.length === 0 ? (
          <div
            style={{
              padding: '40px 24px',
              textAlign: 'center',
              fontFamily: fonts.sans,
              fontSize: 15,
              color: T.ink3,
              lineHeight: 1.5,
            }}
          >
            {hp.noHistory}
          </div>
        ) : (
          events.map((e, i) => {
            const k = pill[e.kind];
            const isOpen = expanded.has(e.id);
            const showAmount = canViewFinancials && e.amount != null &&
              (e.kind === 'scan' || e.kind === 'delivery' || e.kind === 'assistant');
            return (
              <div key={e.id} style={{ borderTop: i === 0 ? 'none' : `1px solid ${T.ruleSoft}` }}>
                <button
                  type="button"
                  onClick={() => toggle(e.id)}
                  aria-expanded={isOpen}
                  title={isOpen ? hp.close : hp.showDetails}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: canViewFinancials
                      ? '92px 104px 1.2fr 1fr 92px 22px'
                      : '92px 104px 1.2fr 1fr 22px',
                    gap: 14,
                    padding: '14px 0',
                    alignItems: 'center',
                    width: '100%',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    <span style={{ fontFamily: fonts.sans, fontSize: 15, color: T.ink, fontWeight: 600, letterSpacing: '-0.01em' }}>
                      {shortDateFromDate(e.date, lang)}
                    </span>
                    <span style={{ fontFamily: fonts.mono, fontSize: 10, color: T.dim }}>
                      {timeFmt.format(e.date)}
                    </span>
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
                      fontFamily: fonts.sans,
                      fontSize: 11,
                      fontWeight: 600,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <span style={{ display: 'inline-block', width: 5, height: 5, borderRadius: '50%', background: k.color }} />
                    {k.label}
                  </span>
                  <span style={{ fontFamily: fonts.sans, fontSize: 13.5, color: T.ink, fontWeight: 600 }}>
                    {titleFor(e)}
                  </span>
                  <span style={{ fontFamily: fonts.sans, fontSize: 12.5, color: T.ink2 }}>
                    {subFor(e)}
                  </span>
                  {canViewFinancials && (
                    <span style={{ fontFamily: fonts.sans, fontSize: 13, fontWeight: 600, textAlign: 'right', color: showAmount ? T.ink : T.ink3 }}>
                      {showAmount ? fmtMoney(e.amount!) : '—'}
                    </span>
                  )}
                  <span
                    aria-hidden="true"
                    style={{
                      color: T.dim,
                      fontSize: 12,
                      transition: 'transform .18s ease',
                      transform: isOpen ? 'rotate(90deg)' : 'none',
                      justifySelf: 'center',
                    }}
                  >
                    ›
                  </span>
                </button>

                {isOpen && (
                  <div style={{ padding: '0 0 14px 106px' }}>
                    <div style={{ background: T.bg, border: `1px solid ${T.ruleSoft}`, borderRadius: 10, padding: '4px 14px' }}>
                      {e.lines.map((line, j) => (
                        <LineRow
                          key={j}
                          line={line}
                          kind={e.kind}
                          hp={hp}
                          canViewFinancials={canViewFinancials}
                          first={j === 0}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </Overlay>
  );
}

function LineRow({
  line,
  kind,
  hp,
  canViewFinancials,
  first,
}: {
  line: HistoryLine;
  kind: HistoryEventKind;
  hp: ReturnType<typeof hpStrings>;
  canViewFinancials: boolean;
  first: boolean;
}) {
  const isCount = kind === 'count' || kind === 'quickcount';
  // Counts: "Queen sheets — counted 11" + change chip when we knew what to
  // expect. Deliveries: "Bath towels — received 24 (2 cases)" + line $.
  let qtyLabel = '';
  if (line.qty != null) {
    qtyLabel = isCount ? `${hp.counted} ${line.qty}` : `${hp.received} ${line.qty}`;
    if (!isCount && line.cases) qtyLabel += ` (${hp.cases(line.cases)})`;
  }
  const delta = line.delta;
  const deltaChip =
    isCount && typeof delta === 'number'
      ? delta === 0
        ? { text: hp.asExpected, color: T.ink3 }
        : delta > 0
          ? { text: `+${delta}`, color: T.sageDeep }
          : { text: `${delta}`, color: statusColor.critical }
      : null;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: canViewFinancials ? '1.4fr 1fr 90px 80px' : '1.4fr 1fr 90px',
        gap: 12,
        alignItems: 'center',
        padding: '9px 0',
        borderTop: first ? 'none' : `1px solid ${T.ruleSoft}`,
      }}
    >
      <span style={{ fontFamily: fonts.sans, fontSize: 12.5, color: T.ink, fontWeight: 500 }}>
        {line.name}
      </span>
      <span style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink2 }}>
        {qtyLabel}
      </span>
      <span style={{ fontFamily: fonts.mono, fontSize: 11, fontWeight: 600, color: deltaChip?.color ?? T.ink3, textAlign: 'right' }}>
        {deltaChip ? deltaChip.text : ''}
      </span>
      {canViewFinancials && (
        <span style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink2, textAlign: 'right' }}>
          {typeof line.amount === 'number' && !isCount ? fmtMoney(line.amount) : ''}
        </span>
      )}
    </div>
  );
}
