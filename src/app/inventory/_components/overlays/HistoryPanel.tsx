'use client';

// History v2 (2026-07-18): the feed reads as WHAT THE PERSON DID — "Started a
// count", "Scanned an invoice", "Added a delivery", "Added new items", or a
// finance-only immutable month close. Clicking expands item detail or the
// monthly beginning + purchases - ending equation. Event grouping +
// classification live in ../history-events.ts; this file owns display and UI.

import React, { useMemo, useState } from 'react';
import type { EffectiveInventoryDelivery } from '@/types';
import type { InventoryAuditAction, InventoryAuditEvent } from '@/lib/inventory-audit-history';
import { T, fonts, statusColor } from '../tokens';
import { Overlay } from './Overlay';
import { fmtMoney } from '../format';
import { type Lang } from '../inv-i18n';
import styles from './HistoryPanel.module.css';
import {
  canCorrectEffectiveInventoryDelivery,
  inventoryAuditDeliveryRootOrderId,
  inventoryAuditMoneyFacts,
  type InventoryAuditMoneyKind,
} from './inventory-audit-presentation';
import {
  historyEventsForViewer,
  type HistoryEvent,
  type HistoryEventKind,
  type HistoryLine,
  type HistoryMonthClose,
} from '../history-events';

interface HistoryPanelProps {
  lang: Lang;
  open: boolean;
  onClose: () => void;
  events: HistoryEvent[];
  canViewFinancials: boolean;
  /** IANA timezone from the authorized property row. Invalid/missing → UTC. */
  timezone: string;
  canCorrectDeliveries?: boolean;
  onCorrectDelivery?: (delivery: EffectiveInventoryDelivery) => void;
  onAddDelivery?: () => void;
  /** New cursor-paged audit ledger. `null` means it could not be loaded and
   * the recent operational feed below remains available as a safe fallback. */
  auditEvents?: InventoryAuditEvent[] | null;
  auditLoading?: boolean;
  auditLoadingMore?: boolean;
  auditNextCursor?: string | null;
  auditPropertyId?: string | null;
  onLoadOlder?: () => void;
  onRetryAudit?: () => void;
  onResolveAuditDelivery?: (rootOrderId: string) => Promise<EffectiveInventoryDelivery | null>;
}

function hpStrings(lang: Lang) {
  return {
    en: {
      eyebrow: 'History',
      italic: 'Inventory activity',
      event: 'action',
      events: 'actions',
      noHistory: 'Nothing yet — counts, deliveries and new items will show up here.',
      // Event titles
      startedCount: 'Started a count',
      quickCount: (item: string) => `Quick count · ${item}`,
      scannedInvoice: 'Scanned an invoice',
      addedDelivery: 'Added a delivery',
      recordedLoss: 'Recorded stock loss',
      aiMarkedOrdered: 'AI assistant · marked as ordered',
      addedItems: (n: number) => (n === 1 ? 'Added a new item' : `Added ${n} new items`),
      closedMonth: (month: string) => `Closed ${month}`,
      // Pills
      pillCount: 'Count',
      pillQuick: 'Quick count',
      pillScan: 'Invoice',
      pillDelivery: 'Delivery',
      pillLoss: 'Stock loss',
      pillAssistant: 'AI',
      pillItems: 'New items',
      pillMonthClose: 'Month close',
      // Detail
      byAI: 'Staxis AI',
      team: 'team',
      invoiceNo: (n: string) => `invoice #${n}`,
      item: 'item',
      items: 'items',
      counted: 'counted',
      received: 'received',
      removed: 'removed',
      corrected: 'Corrected',
      voided: 'Voided',
      correctDelivery: 'Correct delivery',
      addNewDelivery: 'Add new delivery',
      correctionReason: 'Reason',
      lossReasons: { missing: 'Missing', stained: 'Stained', damaged: 'Damaged', lost: 'Lost', theft: 'Theft', other: 'Other' },
      stockChange: (before: number, after: number) => `On hand ${before} → ${after}`,
      cases: (n: number) => `${n} ${n === 1 ? 'case' : 'cases'}`,
      asExpected: 'as expected',
      monthlyActualFinalized: 'Monthly actual finalized',
      partialPeriod: 'Partial first period',
      noFullBudgetComparison: 'not compared with a full-month budget',
      totalOnly: 'Total only',
      noCategorySplit: 'no category split',
      beginningInventory: 'Beginning inventory',
      openingAdjustment: (amount: string) => `${amount} of pre-existing shelf stock was added after the baseline. It is included in beginning inventory, not purchases or usage.`,
      purchases: 'Purchases',
      sourceLogged: 'logged deliveries',
      sourceManual: 'manual monthly total',
      sourceZero: 'confirmed zero',
      loggedDeliveries: 'Logged deliveries',
      costsIncomplete: 'costs incomplete',
      costsMissing: 'costs missing',
      endingInventory: 'Ending inventory',
      actualUsed: 'Actual used',
      closeEquation: 'Beginning + purchases − ending = actual used',
      close: 'Hide details',
      showDetails: 'Show details',
      completeHistoryUnavailable: 'Complete history could not load. Recent inventory activity is shown below.',
      retryHistory: 'Retry complete history',
      searchHistory: 'Search history',
      allActivity: 'All activity',
      countsActivity: 'Counts',
      deliveriesActivity: 'Deliveries',
      catalogActivity: 'Items',
      monthlyActivity: 'Monthly',
      settingsActivity: 'Setup',
      noAuditMatches: 'No history matches these filters.',
      loadOlder: 'Load older history',
      loadingHistory: 'Loading history…',
      requestId: 'Request ID',
      changed: 'Changed',
      totalCost: 'Total',
      previousTotalCost: 'Previous total',
      currentTotalCost: 'Current total',
      varianceValue: 'Variance value',
      inventoryValue: 'Inventory value',
      actualUsedValue: 'Actual used',
      budgetValue: 'Budget',
      unitCostValue: 'Unit cost',
      loadingDelivery: 'Loading delivery details…',
      deliveryUnavailable: 'Delivery details are unavailable.',
      retryDelivery: 'Retry delivery details',
      existingItemBaseline: 'Existing inventory item',
      actionTitles: {
        'item.created': 'Added inventory item', 'item.updated': 'Updated inventory item', 'item.archived': 'Archived inventory item',
        'count.saved': 'Saved inventory count', 'delivery.received': 'Received delivery', 'order_intent.recorded': 'Marked item as ordered', 'loss.recorded': 'Recorded stock loss',
        'reconciliation.recorded': 'Reconciled inventory', 'delivery.corrected': 'Corrected delivery', 'delivery.voided': 'Voided delivery',
        'opening_adjustment.recorded': 'Adjusted opening inventory', 'month.started': 'Started monthly tracking', 'month.closed': 'Closed inventory month',
        'vendor.created': 'Added vendor', 'vendor.updated': 'Updated vendor', 'vendor.inactivated': 'Inactivated vendor',
        'budget.created': 'Added inventory budget', 'budget.updated': 'Updated inventory budget', 'budget.deleted': 'Deleted inventory budget',
        'category.created': 'Added inventory category', 'category.updated': 'Updated inventory category', 'category.deleted': 'Deleted inventory category',
        'budget_section.created': 'Added budget section', 'budget_section.updated': 'Updated budget section', 'budget_section.deleted': 'Deleted budget section',
        'config.updated': 'Updated inventory setup',
      } satisfies Record<InventoryAuditAction, string>,
    },
    es: {
      eyebrow: 'Historial',
      italic: 'Actividad de inventario',
      event: 'acción',
      events: 'acciones',
      noHistory: 'Nada aún — los conteos, entregas y artículos nuevos aparecerán aquí.',
      startedCount: 'Conteo iniciado',
      quickCount: (item: string) => `Conteo rápido · ${item}`,
      scannedInvoice: 'Factura escaneada',
      addedDelivery: 'Entrega agregada',
      recordedLoss: 'Pérdida de existencias registrada',
      aiMarkedOrdered: 'Asistente IA · marcado como pedido',
      addedItems: (n: number) => (n === 1 ? 'Artículo nuevo agregado' : `${n} artículos nuevos agregados`),
      closedMonth: (month: string) => `Cierre de ${month}`,
      pillCount: 'Conteo',
      pillQuick: 'Conteo rápido',
      pillScan: 'Factura',
      pillDelivery: 'Entrega',
      pillLoss: 'Pérdida',
      pillAssistant: 'IA',
      pillItems: 'Artículos',
      pillMonthClose: 'Cierre mensual',
      byAI: 'Staxis IA',
      team: 'equipo',
      invoiceNo: (n: string) => `factura #${n}`,
      item: 'artículo',
      items: 'artículos',
      counted: 'contado',
      received: 'recibido',
      removed: 'retirado',
      corrected: 'Corregida',
      voided: 'Anulada',
      correctDelivery: 'Corregir entrega',
      addNewDelivery: 'Agregar nueva entrega',
      correctionReason: 'Motivo',
      lossReasons: { missing: 'Faltante', stained: 'Manchado', damaged: 'Dañado', lost: 'Perdido', theft: 'Robo', other: 'Otro' },
      stockChange: (before: number, after: number) => `Existencias ${before} → ${after}`,
      cases: (n: number) => `${n} ${n === 1 ? 'caja' : 'cajas'}`,
      asExpected: 'como se esperaba',
      monthlyActualFinalized: 'Uso real mensual finalizado',
      partialPeriod: 'Primer período parcial',
      noFullBudgetComparison: 'sin comparar con un presupuesto mensual completo',
      totalOnly: 'Solo total',
      noCategorySplit: 'sin desglose por categoría',
      beginningInventory: 'Inventario inicial',
      openingAdjustment: (amount: string) => `Se agregaron ${amount} de inventario preexistente después de la base. Está incluido en el inventario inicial, no en compras ni uso.`,
      purchases: 'Compras',
      sourceLogged: 'entregas registradas',
      sourceManual: 'total mensual manual',
      sourceZero: 'cero confirmado',
      loggedDeliveries: 'Entregas registradas',
      costsIncomplete: 'costos incompletos',
      costsMissing: 'faltan costos',
      endingInventory: 'Inventario final',
      actualUsed: 'Uso real',
      closeEquation: 'Inicial + compras − final = uso real',
      close: 'Ocultar detalle',
      showDetails: 'Ver detalle',
      completeHistoryUnavailable: 'No se pudo cargar el historial completo. La actividad reciente aparece abajo.',
      retryHistory: 'Reintentar historial completo',
      searchHistory: 'Buscar en el historial',
      allActivity: 'Toda la actividad',
      countsActivity: 'Conteos',
      deliveriesActivity: 'Entregas',
      catalogActivity: 'Artículos',
      monthlyActivity: 'Mensual',
      settingsActivity: 'Configuración',
      noAuditMatches: 'Ningún registro coincide con estos filtros.',
      loadOlder: 'Cargar historial anterior',
      loadingHistory: 'Cargando historial…',
      requestId: 'ID de solicitud',
      changed: 'Cambios',
      totalCost: 'Total',
      previousTotalCost: 'Total anterior',
      currentTotalCost: 'Total actual',
      varianceValue: 'Valor de la diferencia',
      inventoryValue: 'Valor del inventario',
      actualUsedValue: 'Uso real',
      budgetValue: 'Presupuesto',
      unitCostValue: 'Costo unitario',
      loadingDelivery: 'Cargando detalles de la entrega…',
      deliveryUnavailable: 'Los detalles de la entrega no están disponibles.',
      retryDelivery: 'Reintentar detalles de la entrega',
      existingItemBaseline: 'Artículo de inventario existente',
      actionTitles: {
        'item.created': 'Artículo de inventario agregado', 'item.updated': 'Artículo de inventario actualizado', 'item.archived': 'Artículo de inventario archivado',
        'count.saved': 'Conteo de inventario guardado', 'delivery.received': 'Entrega recibida', 'order_intent.recorded': 'Artículo marcado como pedido', 'loss.recorded': 'Pérdida de existencias registrada',
        'reconciliation.recorded': 'Inventario conciliado', 'delivery.corrected': 'Entrega corregida', 'delivery.voided': 'Entrega anulada',
        'opening_adjustment.recorded': 'Inventario inicial ajustado', 'month.started': 'Seguimiento mensual iniciado', 'month.closed': 'Mes de inventario cerrado',
        'vendor.created': 'Proveedor agregado', 'vendor.updated': 'Proveedor actualizado', 'vendor.inactivated': 'Proveedor desactivado',
        'budget.created': 'Presupuesto de inventario agregado', 'budget.updated': 'Presupuesto de inventario actualizado', 'budget.deleted': 'Presupuesto de inventario eliminado',
        'category.created': 'Categoría de inventario agregada', 'category.updated': 'Categoría de inventario actualizada', 'category.deleted': 'Categoría de inventario eliminada',
        'budget_section.created': 'Sección de presupuesto agregada', 'budget_section.updated': 'Sección de presupuesto actualizada', 'budget_section.deleted': 'Sección de presupuesto eliminada',
        'config.updated': 'Configuración de inventario actualizada',
      } satisfies Record<InventoryAuditAction, string>,
    },
  }[lang];
}

function auditEventTitle(
  event: InventoryAuditEvent,
  hp: ReturnType<typeof hpStrings>,
): string {
  if (event.action === 'item.created' && event.details.baseline === true) {
    return hp.existingItemBaseline;
  }
  return hp.actionTitles[event.action];
}

export function HistoryPanel({
  lang,
  open,
  onClose,
  events,
  canViewFinancials,
  timezone,
  canCorrectDeliveries = false,
  onCorrectDelivery,
  onAddDelivery,
  auditEvents,
  auditLoading = false,
  auditLoadingMore = false,
  auditNextCursor = null,
  auditPropertyId = null,
  onLoadOlder,
  onRetryAudit,
  onResolveAuditDelivery,
}: HistoryPanelProps) {
  const hp = useMemo(() => hpStrings(lang), [lang]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const visibleEvents = useMemo(
    () => historyEventsForViewer(events, canViewFinancials),
    [events, canViewFinancials],
  );

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const safeTimezone = useMemo(() => {
    if (!timezone || typeof timezone !== 'string') return 'UTC';
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
      return timezone;
    } catch {
      return 'UTC';
    }
  }, [timezone]);
  const locale = lang === 'es' ? 'es-ES' : 'en-US';
  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric', timeZone: safeTimezone }),
    [locale, safeTimezone],
  );
  const timeFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: safeTimezone }),
    [locale, safeTimezone],
  );
  const monthFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: safeTimezone }),
    [locale, safeTimezone],
  );

  const pill: Record<HistoryEventKind, { label: string; color: string; bg: string }> = {
    count: { label: hp.pillCount, color: T.purple, bg: T.purpleDim },
    quickcount: { label: hp.pillQuick, color: T.purple, bg: T.purpleDim },
    scan: { label: hp.pillScan, color: T.tealText, bg: T.tealDim },
    delivery: { label: hp.pillDelivery, color: T.sageDeep, bg: T.sageDim },
    loss: { label: hp.pillLoss, color: T.terra, bg: T.terraDim },
    assistant: { label: hp.pillAssistant, color: T.goldText, bg: T.goldDim },
    itemsAdded: { label: hp.pillItems, color: T.ink2, bg: T.inkWash },
    monthClose: { label: hp.pillMonthClose, color: T.forestText, bg: T.sageDim },
  };

  const closeMonthLabel = (month: string): string => {
    const [year, month1] = month.split('-').map(Number);
    if (!Number.isInteger(year) || !Number.isInteger(month1)) return month;
    return monthFmt.format(new Date(Date.UTC(year, month1 - 1, 15, 12)));
  };

  const titleFor = (e: HistoryEvent): string => {
    switch (e.kind) {
      case 'count': return hp.startedCount;
      case 'quickcount': return hp.quickCount(e.lines[0]?.name ?? '');
      case 'scan': return hp.scannedInvoice;
      case 'delivery': return hp.addedDelivery;
      case 'loss': return hp.recordedLoss;
      case 'assistant': return hp.aiMarkedOrdered;
      case 'itemsAdded': return hp.addedItems(e.lines.length);
      case 'monthClose': return hp.closedMonth(closeMonthLabel(e.monthClose?.month ?? ''));
    }
  };

  const auditDeliveryById = useMemo(() => {
    const byId = new Map<string, EffectiveInventoryDelivery>();
    for (const event of events) {
      for (const line of event.lines) {
        if (line.delivery) byId.set(line.delivery.rootOrderId, line.delivery);
      }
    }
    return byId;
  }, [events]);

  const suffixCount = auditEvents !== undefined && auditEvents !== null
    ? `${auditEvents.length}${auditNextCursor ? '+' : ''}`
    : String(visibleEvents.length);

  const subFor = (e: HistoryEvent): string => {
    if (e.kind === 'monthClose' && e.monthClose) {
      const parts = [hp.monthlyActualFinalized];
      if (e.monthClose.isPartial) {
        parts.push(`${hp.partialPeriod} · ${hp.noFullBudgetComparison}`);
      }
      if (e.monthClose.allocationMode === 'total_only') {
        parts.push(`${hp.totalOnly} · ${hp.noCategorySplit}`);
      }
      return parts.join(' · ');
    }
    const parts: string[] = [];
    if (e.byAssistant) parts.push(hp.byAI);
    else if (e.who) parts.push(e.who);
    if (e.kind === 'loss' && e.loss) parts.push(hp.lossReasons[e.loss.reason]);
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
      suffix={`${suffixCount} ${(auditEvents?.length ?? visibleEvents.length) === 1 ? hp.event : hp.events}`}
      width={860}
    >
      {auditEvents !== undefined && auditEvents !== null ? (
        <AuditHistoryFeed
          key={auditPropertyId ?? 'no-property'}
          events={auditEvents}
          lang={lang}
          hp={hp}
          timezone={safeTimezone}
          loading={auditLoading}
          loadingMore={auditLoadingMore}
          hasMore={Boolean(auditNextCursor)}
          onLoadOlder={onLoadOlder}
          deliveryById={auditDeliveryById}
          canViewFinancials={canViewFinancials}
          canCorrectDeliveries={canCorrectDeliveries}
          onCorrectDelivery={onCorrectDelivery}
          onAddDelivery={onAddDelivery}
          onResolveAuditDelivery={onResolveAuditDelivery}
        />
      ) : (
        <>
          {auditEvents === null && (
            <div
              role="alert"
              style={{
                alignItems: 'center', background: T.goldDim, border: `1px solid ${T.gold}55`,
                borderRadius: 12, color: T.ink2, display: 'flex', fontFamily: fonts.sans,
                fontSize: 12.5, gap: 12, justifyContent: 'space-between', lineHeight: 1.45,
                marginBottom: 12, padding: '10px 12px',
              }}
            >
              <span>{hp.completeHistoryUnavailable}</span>
              {onRetryAudit && (
                <button
                  type="button"
                  onClick={onRetryAudit}
                  style={{
                    background: T.paper, border: `1px solid ${T.gold}77`, borderRadius: 9,
                    color: T.ink, cursor: 'pointer', flex: 'none', fontFamily: fonts.sans,
                    fontSize: 12, fontWeight: 700, minHeight: 44, padding: '0 13px',
                  }}
                >
                  {hp.retryHistory}
                </button>
              )}
            </div>
          )}
          <div className={styles.eventList} style={{ background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 14, padding: '4px 20px' }}>
        {visibleEvents.length === 0 ? (
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
          visibleEvents.map((e, i) => {
            const k = pill[e.kind];
            const isOpen = expanded.has(e.id);
            // Deliveries show what they cost; counts show their $ variance vs
            // expected (red when stock came up short — the shrinkage signal
            // the old panel carried; losing it was a review finding).
            const isCountKind = e.kind === 'count' || e.kind === 'quickcount';
            const isDeliveryKind = e.kind === 'scan' || e.kind === 'delivery' || e.kind === 'assistant';
            const isLossKind = e.kind === 'loss';
            const deliveryCostIncomplete = isDeliveryKind && e.deliveryCost?.complete === false;
            const showAmount = canViewFinancials && e.amount != null &&
              (isDeliveryKind || isLossKind || e.kind === 'monthClose' ||
                (isCountKind && e.amount !== 0));
            const amountColor = isLossKind || (isCountKind && (e.amount ?? 0) < 0) ? statusColor.critical : T.ink;
            return (
              <div key={e.id} style={{ borderTop: i === 0 ? 'none' : `1px solid ${T.ruleSoft}` }}>
                <button
                  type="button"
                  className={styles.eventButton}
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
                  <span className={styles.eventDate} style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    <span style={{ fontFamily: fonts.sans, fontSize: 15, color: T.ink, fontWeight: 600, letterSpacing: '-0.01em' }}>
                      {dateFmt.format(e.date)}
                    </span>
                    <span style={{ fontFamily: fonts.mono, fontSize: 10, color: T.dim }}>
                      {timeFmt.format(e.date)}
                    </span>
                  </span>
                  <span
                    className={styles.eventPill}
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
                  <span className={styles.eventTitle} style={{ fontFamily: fonts.sans, fontSize: 13.5, color: T.ink, fontWeight: 600 }}>
                    {titleFor(e)}
                  </span>
                  <span className={styles.eventSubtitle} style={{ fontFamily: fonts.sans, fontSize: 12.5, color: T.ink2 }}>
                    {subFor(e)}
                  </span>
                  {canViewFinancials && (
                    <span
                      className={styles.eventAmount}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'flex-end',
                        fontFamily: fonts.sans,
                        fontSize: 13,
                        fontWeight: 600,
                        textAlign: 'right',
                        color: showAmount ? amountColor : T.ink3,
                      }}
                    >
                      <span>{showAmount ? `${deliveryCostIncomplete ? '≥ ' : ''}${fmtMoney(e.amount!)}` : '—'}</span>
                      {deliveryCostIncomplete && (
                        <span style={{ color: T.goldText, fontSize: 9.5, fontWeight: 600, lineHeight: 1.2 }}>
                          {hp.costsMissing}
                        </span>
                      )}
                    </span>
                  )}
                  <span
                    className={styles.eventArrow}
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
                  <div className={styles.eventDetail} style={{ padding: '0 0 14px 106px' }}>
                    <div style={{ background: T.bg, border: `1px solid ${T.ruleSoft}`, borderRadius: 10, padding: '4px 14px' }}>
                      {e.kind === 'monthClose' && e.monthClose ? (
                        <MonthCloseDetail close={e.monthClose} hp={hp} />
                      ) : (
                        <>
                          {e.kind === 'loss' && e.loss && (
                            <div style={{ padding: '10px 0', fontFamily: fonts.sans, fontSize: 12, color: T.ink2, lineHeight: 1.5 }}>
                              {e.loss.stockBefore != null && e.loss.stockAfter != null && (
                                <div>{hp.stockChange(e.loss.stockBefore, e.loss.stockAfter)}</div>
                              )}
                              {e.loss.notes && <div><strong style={{ color: T.ink }}>{hp.correctionReason}:</strong> {e.loss.notes}</div>}
                            </div>
                          )}
                          {e.lines.map((line, j) => (
                            <LineRow
                              key={line.delivery?.rootOrderId ?? j}
                              line={line}
                              kind={e.kind}
                              hp={hp}
                              canViewFinancials={canViewFinancials}
                              canCorrectDeliveries={canCorrectDeliveries}
                              onCorrectDelivery={onCorrectDelivery}
                              onAddDelivery={onAddDelivery}
                              first={j === 0 && e.kind !== 'loss'}
                            />
                          ))}
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
          </div>
        </>
      )}
    </Overlay>
  );
}

type AuditFilter = 'all' | 'counts' | 'deliveries' | 'catalog' | 'monthly' | 'settings';

function auditFilterFor(action: InventoryAuditAction): Exclude<AuditFilter, 'all'> {
  if (action === 'count.saved' || action === 'reconciliation.recorded') return 'counts';
  if (
    action === 'delivery.received' || action === 'order_intent.recorded' || action === 'delivery.corrected'
    || action === 'delivery.voided' || action === 'loss.recorded'
    || action === 'opening_adjustment.recorded'
  ) return 'deliveries';
  if (action.startsWith('item.')) return 'catalog';
  if (action.startsWith('month.')) return 'monthly';
  return 'settings';
}

function auditTone(action: InventoryAuditAction): { color: string; background: string } {
  const group = auditFilterFor(action);
  if (group === 'counts') return { color: T.purple, background: T.purpleDim };
  if (group === 'deliveries') {
    return action === 'loss.recorded' || action === 'delivery.voided'
      ? { color: T.terra, background: T.terraDim }
      : { color: T.sageDeep, background: T.sageDim };
  }
  if (group === 'monthly') return { color: T.forestText, background: T.sageDim };
  if (group === 'catalog') return { color: T.tealText, background: T.tealDim };
  return { color: T.ink2, background: T.inkWash };
}

function humanizeAuditField(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (character) => character.toUpperCase());
}

function auditMoneyLabel(
  kind: InventoryAuditMoneyKind,
  hp: ReturnType<typeof hpStrings>,
): string {
  const labels: Record<InventoryAuditMoneyKind, string> = {
    unitCost: hp.unitCostValue,
    totalCost: hp.totalCost,
    previousTotalCost: hp.previousTotalCost,
    currentTotalCost: hp.currentTotalCost,
    varianceValue: hp.varianceValue,
    inventoryValue: hp.inventoryValue,
    actualUsedValue: hp.actualUsedValue,
    budgetValue: hp.budgetValue,
  };
  return labels[kind];
}

function AuditHistoryFeed({
  events,
  lang,
  hp,
  timezone,
  loading,
  loadingMore,
  hasMore,
  onLoadOlder,
  deliveryById,
  canViewFinancials,
  canCorrectDeliveries,
  onCorrectDelivery,
  onAddDelivery,
  onResolveAuditDelivery,
}: {
  events: InventoryAuditEvent[];
  lang: Lang;
  hp: ReturnType<typeof hpStrings>;
  timezone: string;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  onLoadOlder?: () => void;
  deliveryById: ReadonlyMap<string, EffectiveInventoryDelivery>;
  canViewFinancials: boolean;
  canCorrectDeliveries: boolean;
  onCorrectDelivery?: (delivery: EffectiveInventoryDelivery) => void;
  onAddDelivery?: () => void;
  onResolveAuditDelivery?: (rootOrderId: string) => Promise<EffectiveInventoryDelivery | null>;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<AuditFilter>('all');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [resolvedDeliveries, setResolvedDeliveries] = useState<
    Map<string, EffectiveInventoryDelivery | null>
  >(() => new Map());
  const [resolvingDeliveryIds, setResolvingDeliveryIds] = useState<Set<string>>(() => new Set());
  const [deliveryLookupErrors, setDeliveryLookupErrors] = useState<Set<string>>(() => new Set());
  const resolvingDeliveryIdsRef = React.useRef<Set<string>>(new Set());

  const resolveDelivery = async (rootOrderId: string, retry = false) => {
    if (
      !onResolveAuditDelivery
      || deliveryById.has(rootOrderId)
      || (!retry && resolvedDeliveries.has(rootOrderId))
      || resolvingDeliveryIdsRef.current.has(rootOrderId)
    ) return;
    resolvingDeliveryIdsRef.current.add(rootOrderId);
    setResolvingDeliveryIds((current) => new Set(current).add(rootOrderId));
    setDeliveryLookupErrors((current) => {
      const next = new Set(current);
      next.delete(rootOrderId);
      return next;
    });
    try {
      const delivery = await onResolveAuditDelivery(rootOrderId);
      const safeDelivery = delivery?.rootOrderId === rootOrderId ? delivery : null;
      setResolvedDeliveries((current) => new Map(current).set(rootOrderId, safeDelivery));
    } catch (error) {
      console.error('[inventory] audit delivery lookup failed', error);
      setDeliveryLookupErrors((current) => new Set(current).add(rootOrderId));
    } finally {
      resolvingDeliveryIdsRef.current.delete(rootOrderId);
      setResolvingDeliveryIds((current) => {
        const next = new Set(current);
        next.delete(rootOrderId);
        return next;
      });
    }
  };

  const locale = lang === 'es' ? 'es-ES' : 'en-US';
  const dateTime = useMemo(() => new Intl.DateTimeFormat(locale, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: timezone,
  }), [locale, timezone]);
  const filterLabels: Record<AuditFilter, string> = {
    all: hp.allActivity,
    counts: hp.countsActivity,
    deliveries: hp.deliveriesActivity,
    catalog: hp.catalogActivity,
    monthly: hp.monthlyActivity,
    settings: hp.settingsActivity,
  };
  const normalizedQuery = query.trim().toLocaleLowerCase(locale);
  const visible = events.filter((event) => {
    if (filter !== 'all' && auditFilterFor(event.action) !== filter) return false;
    if (!normalizedQuery) return true;
    return [
      auditEventTitle(event, hp), event.summary.label, event.summary.secondaryLabel,
      event.actorName, event.requestId, ...event.summary.changedFields,
    ].filter(Boolean).join(' ').toLocaleLowerCase(locale).includes(normalizedQuery);
  });

  if (loading && events.length === 0) {
    return (
      <div role="status" aria-live="polite" style={{ color: T.ink2, fontFamily: fonts.sans, padding: '44px 20px', textAlign: 'center' }}>
        {hp.loadingHistory}
      </div>
    );
  }

  return (
    <div>
      <div className={styles.auditTools} style={{ display: 'grid', gap: 10, gridTemplateColumns: 'minmax(0, 1fr) minmax(150px, 210px)', marginBottom: 12 }}>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={hp.searchHistory}
          placeholder={hp.searchHistory}
          style={{
            background: T.paper, border: `1px solid ${T.controlBorder}`, borderRadius: 11,
            color: T.ink, fontFamily: fonts.sans, fontSize: 14, height: 44, minWidth: 0, padding: '0 13px',
          }}
        />
        <select
          value={filter}
          onChange={(event) => setFilter(event.target.value as AuditFilter)}
          aria-label={hp.allActivity}
          style={{
            background: T.paper, border: `1px solid ${T.controlBorder}`, borderRadius: 11,
            color: T.ink, fontFamily: fonts.sans, fontSize: 13, height: 44, padding: '0 12px',
          }}
        >
          {(Object.keys(filterLabels) as AuditFilter[]).map((key) => (
            <option key={key} value={key}>{filterLabels[key]}</option>
          ))}
        </select>
      </div>

      <div className={styles.eventList} style={{ background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 14, overflow: 'hidden' }}>
        {visible.length === 0 ? (
          <div role="status" style={{ color: T.ink3, fontFamily: fonts.sans, fontSize: 14, padding: '40px 20px', textAlign: 'center' }}>
            {hp.noAuditMatches}
          </div>
        ) : visible.map((event, index) => {
          const isOpen = expanded.has(event.id);
          const tone = auditTone(event.action);
          const occurred = new Date(event.occurredAt);
          const when = Number.isFinite(occurred.getTime()) ? dateTime.format(occurred) : event.occurredAt;
          const quantity = event.summary.quantity;
          const quantityLabel = quantity != null
            ? `${quantity} ${event.summary.unit ?? ''}`.trim()
            : event.summary.itemCount != null
              ? `${event.summary.itemCount} ${event.summary.itemCount === 1 ? hp.item : hp.items}`
              : null;
          const rootOrderId = inventoryAuditDeliveryRootOrderId(event);
          const resolvedDelivery = rootOrderId ? resolvedDeliveries.get(rootOrderId) : undefined;
          const delivery = rootOrderId
            ? deliveryById.get(rootOrderId) ?? resolvedDelivery
            : undefined;
          const deliveryLookupAttempted = Boolean(rootOrderId && resolvedDeliveries.has(rootOrderId));
          const deliveryIsResolving = Boolean(rootOrderId && resolvingDeliveryIds.has(rootOrderId));
          const deliveryLookupFailed = Boolean(rootOrderId && deliveryLookupErrors.has(rootOrderId));
          const financialAmounts = inventoryAuditMoneyFacts(event, canViewFinancials);
          const eventTitle = auditEventTitle(event, hp);
          return (
            <div key={event.id} style={{ borderTop: index === 0 ? 0 : `1px solid ${T.ruleSoft}` }}>
              <button
                type="button"
                className={styles.auditEventButton}
                onClick={() => {
                  const opening = !expanded.has(event.id);
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(event.id)) next.delete(event.id); else next.add(event.id);
                    return next;
                  });
                  if (
                    opening
                    && rootOrderId
                    && event.action !== 'delivery.voided'
                    && canCorrectDeliveries
                    && onCorrectDelivery
                    && !delivery
                    && !deliveryLookupAttempted
                  ) void resolveDelivery(rootOrderId);
                }}
                aria-expanded={isOpen}
                style={{
                  alignItems: 'center', background: 'transparent', border: 0, color: T.ink,
                  cursor: 'pointer', display: 'grid', gap: 12,
                  gridTemplateColumns: 'minmax(132px, auto) minmax(0, 1fr) minmax(110px, auto) 20px',
                  minHeight: 68, padding: '11px 16px', textAlign: 'left', width: '100%',
                }}
              >
                <span className={styles.auditDate} style={{ color: T.ink3, fontFamily: fonts.mono, fontSize: 10.5, lineHeight: 1.35 }}>{when}</span>
                <span className={styles.auditSummary} style={{ minWidth: 0 }}>
                  <span style={{ color: T.ink, display: 'block', fontFamily: fonts.sans, fontSize: 13.5, fontWeight: 650, lineHeight: 1.35 }}>
                    {eventTitle}{event.summary.label ? ` · ${event.summary.label}` : ''}
                  </span>
                  <span style={{ color: T.ink2, display: 'block', fontFamily: fonts.sans, fontSize: 11.5, lineHeight: 1.4, marginTop: 2 }}>
                    {[event.actorName ?? hp.team, event.summary.secondaryLabel].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className={styles.auditMeta} style={{ justifySelf: 'end', textAlign: 'right' }}>
                  <span style={{ background: tone.background, borderRadius: 999, color: tone.color, display: 'inline-flex', fontFamily: fonts.sans, fontSize: 10.5, fontWeight: 650, padding: '4px 8px' }}>
                    {filterLabels[auditFilterFor(event.action)]}
                  </span>
                  {quantityLabel && (
                    <span style={{ color: T.ink2, display: 'block', fontFamily: fonts.mono, fontSize: 10.5, marginTop: 4 }}>
                      {quantityLabel}
                    </span>
                  )}
                  {financialAmounts.map((amount) => (
                    <span key={amount.kind} style={{ color: T.ink, display: 'block', fontFamily: fonts.sans, fontSize: 11, fontWeight: 650, marginTop: 4 }}>
                      {auditMoneyLabel(amount.kind, hp)}: {fmtMoney(amount.value)}
                    </span>
                  ))}
                </span>
                <span className={styles.auditArrow} aria-hidden="true" style={{ color: T.dim, transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 180ms cubic-bezier(.2,0,0,1)' }}>›</span>
              </button>
              {isOpen && (
                <div style={{ background: T.bg, borderTop: `1px solid ${T.ruleSoft}`, color: T.ink2, fontFamily: fonts.sans, fontSize: 12, lineHeight: 1.5, padding: '12px 16px 14px' }}>
                  {event.summary.changedFields.length > 0 && (
                    <div><strong style={{ color: T.ink }}>{hp.changed}:</strong> {event.summary.changedFields.map(humanizeAuditField).join(', ')}</div>
                  )}
                  {event.requestId && (
                    <div style={{ marginTop: event.summary.changedFields.length ? 5 : 0 }}>
                      <strong style={{ color: T.ink }}>{hp.requestId}:</strong>{' '}
                      <code style={{ fontFamily: fonts.mono, fontSize: 10.5, overflowWrap: 'anywhere' }}>{event.requestId}</code>
                    </div>
                  )}
                  {canCorrectDeliveries && rootOrderId && deliveryIsResolving && (
                    <div role="status" aria-live="polite" style={{ color: T.ink2, marginTop: 10 }}>
                      {hp.loadingDelivery}
                    </div>
                  )}
                  {canCorrectDeliveries && rootOrderId && !deliveryIsResolving && deliveryLookupFailed && (
                    <button
                      type="button"
                      onClick={() => { void resolveDelivery(rootOrderId, true); }}
                      style={{
                        background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 9,
                        color: T.ink, cursor: 'pointer', fontFamily: fonts.sans, fontSize: 12,
                        fontWeight: 650, marginTop: 10, minHeight: 44, padding: '0 13px',
                      }}
                    >
                      {hp.retryDelivery}
                    </button>
                  )}
                  {canCorrectDeliveries && rootOrderId && !deliveryIsResolving && !deliveryLookupFailed
                    && !delivery && deliveryLookupAttempted && (
                      <div style={{ color: T.ink2, marginTop: 10 }}>
                        {hp.deliveryUnavailable}{' '}
                        {onResolveAuditDelivery && (
                          <button
                            type="button"
                            className={styles.lineAction}
                            onClick={() => { void resolveDelivery(rootOrderId, true); }}
                            style={{ marginLeft: 8 }}
                          >
                            {hp.retryDelivery}
                          </button>
                        )}
                      </div>
                    )}
                  {canCorrectDeliveries && !deliveryIsResolving
                    && (event.action === 'delivery.voided' || delivery?.status === 'voided')
                    && onAddDelivery && (
                      <button type="button" className={styles.lineAction} onClick={onAddDelivery} style={{ marginTop: 10 }}>
                        {hp.addNewDelivery}
                      </button>
                    )}
                  {canCorrectDeliveries && !deliveryIsResolving
                    && event.action !== 'delivery.voided'
                    && canCorrectEffectiveInventoryDelivery(delivery)
                    && onCorrectDelivery && (
                      <button
                        type="button"
                        className={styles.lineAction}
                        onClick={() => onCorrectDelivery(delivery)}
                        style={{ marginTop: 10 }}
                      >
                        {hp.correctDelivery}
                      </button>
                    )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {hasMore && onLoadOlder && (
        <button
          type="button"
          onClick={onLoadOlder}
          disabled={loadingMore}
          aria-busy={loadingMore}
          style={{
            background: T.paper, border: `1px solid ${T.controlBorder}`, borderRadius: 11,
            color: T.ink, cursor: loadingMore ? 'wait' : 'pointer', fontFamily: fonts.sans,
            fontSize: 13, fontWeight: 650, marginTop: 12, minHeight: 44, padding: '0 16px', width: '100%',
          }}
        >
          {loadingMore ? hp.loadingHistory : hp.loadOlder}
        </button>
      )}
    </div>
  );
}

function MonthCloseDetail({
  close,
  hp,
}: {
  close: HistoryMonthClose;
  hp: ReturnType<typeof hpStrings>;
}) {
  const source = close.purchaseSource === 'logged_deliveries'
    ? hp.sourceLogged
    : close.purchaseSource === 'manual_total'
      ? hp.sourceManual
      : hp.sourceZero;
  const rows = [
    {
      key: 'beginning',
      label: hp.beginningInventory,
      amount: close.beginningAmount,
      note: close.openingAdjustmentAmount > 0
        ? hp.openingAdjustment(fmtMoney(close.openingAdjustmentAmount))
        : '',
    },
    { key: 'purchases', label: hp.purchases, amount: close.purchasesAmount, note: source },
    { key: 'ending', label: hp.endingInventory, amount: close.endingAmount, note: '' },
    { key: 'actual', label: hp.actualUsed, amount: close.actualUsageAmount, note: '' },
  ];
  return (
    <div style={{ padding: '8px 0 10px' }}>
      <div style={{ fontFamily: fonts.mono, fontSize: 10, color: T.ink3, letterSpacing: '0.04em', marginBottom: 4 }}>
        {hp.closeEquation}
      </div>
      {rows.map((row, index) => {
        const isActual = row.key === 'actual';
        return (
          <div
            key={row.key}
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr minmax(130px, auto)',
              gap: 16,
              alignItems: 'center',
              minHeight: 40,
              borderTop: index === 0 ? 'none' : `1px solid ${T.ruleSoft}`,
              fontFamily: fonts.sans,
            }}
          >
            <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <span style={{ fontSize: 12.5, color: isActual ? T.ink : T.ink2, fontWeight: isActual ? 700 : 500 }}>
                {row.label}
              </span>
              {row.note && (
                <span style={{ fontSize: 10.5, color: T.ink3 }}>{row.note}</span>
              )}
            </span>
            <span style={{ fontSize: isActual ? 15 : 13, color: T.ink, fontWeight: isActual ? 700 : 600, textAlign: 'right' }}>
              {row.amount == null ? '—' : fmtMoney(row.amount)}
            </span>
          </div>
        );
      })}
      {close.loggedPurchaseAmount == null && (
        <div
          role="note"
          style={{
            marginTop: 8,
            padding: '8px 10px',
            borderRadius: 8,
            background: T.goldDim,
            color: T.goldText,
            fontFamily: fonts.sans,
            fontSize: 11.5,
            lineHeight: 1.4,
          }}
        >
          {hp.loggedDeliveries}: ≥ {fmtMoney(close.knownLoggedPurchaseAmount)} · {hp.costsIncomplete}
        </div>
      )}
    </div>
  );
}

function LineRow({
  line,
  kind,
  hp,
  canViewFinancials,
  canCorrectDeliveries,
  onCorrectDelivery,
  onAddDelivery,
  first,
}: {
  line: HistoryLine;
  kind: HistoryEventKind;
  hp: ReturnType<typeof hpStrings>;
  canViewFinancials: boolean;
  canCorrectDeliveries: boolean;
  onCorrectDelivery?: (delivery: EffectiveInventoryDelivery) => void;
  onAddDelivery?: () => void;
  first: boolean;
}) {
  const isCount = kind === 'count' || kind === 'quickcount';
  const isLoss = kind === 'loss';
  // Counts: "Queen sheets — counted 11" + change chip when we knew what to
  // expect. Deliveries: "Bath towels — received 24 (2 cases)" + line $.
  let qtyLabel = '';
  if (line.qty != null) {
    qtyLabel = isCount ? `${hp.counted} ${line.qty}` : isLoss ? `${hp.removed} ${line.qty}` : `${hp.received} ${line.qty}`;
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
      className={styles.lineRow}
      style={{
        display: 'grid',
        gridTemplateColumns: canViewFinancials ? '1.4fr 1fr 90px 80px' : '1.4fr 1fr 90px',
        gap: 12,
        alignItems: 'center',
        padding: '9px 0',
        borderTop: first ? 'none' : `1px solid ${T.ruleSoft}`,
      }}
    >
      <span className={styles.lineName} style={{ fontFamily: fonts.sans, fontSize: 12.5, color: T.ink, fontWeight: 500 }}>
        {line.name}
      </span>
      <span className={styles.lineQuantity} style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink2 }}>
        {qtyLabel}
      </span>
      <span className={styles.lineDelta} style={{ fontFamily: fonts.mono, fontSize: 11, fontWeight: 600, color: deltaChip?.color ?? T.ink3, textAlign: 'right' }}>
        {deltaChip ? deltaChip.text : ''}
      </span>
      {canViewFinancials && (
        <span className={styles.lineAmount} style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink2, textAlign: 'right' }}>
          {typeof line.amount === 'number' && !isCount ? fmtMoney(line.amount) : ''}
        </span>
      )}
      {line.delivery && (
        <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', paddingTop: 2 }}>
          <div style={{ fontFamily: fonts.sans, fontSize: 11.5, color: T.ink2, lineHeight: 1.4 }}>
            {line.delivery.status !== 'active' && (
              <strong style={{ color: line.delivery.status === 'voided' ? T.terra : T.forestText }}>
                {line.delivery.status === 'voided' ? hp.voided : hp.corrected}
              </strong>
            )}
            {line.delivery.lastCorrection?.reason && (
              <span>{line.delivery.status !== 'active' ? ' · ' : ''}{hp.correctionReason}: {line.delivery.lastCorrection.reason}</span>
            )}
          </div>
          {canCorrectDeliveries && line.delivery.status !== 'voided' && onCorrectDelivery && (
            <button type="button" className={styles.lineAction} onClick={() => onCorrectDelivery(line.delivery!)}>{hp.correctDelivery}</button>
          )}
          {canCorrectDeliveries && line.delivery.status === 'voided' && onAddDelivery && (
            <button type="button" className={styles.lineAction} onClick={onAddDelivery}>{hp.addNewDelivery}</button>
          )}
        </div>
      )}
    </div>
  );
}
