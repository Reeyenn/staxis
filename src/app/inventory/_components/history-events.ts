// Builds the History panel's event feed from the raw count + delivery ledgers
// (2026-07-18 rework). One event = one thing a person (or the AI) actually DID
// in the app — a count walk, a quick count, an invoice scan, a typed-in
// delivery, an AI-assistant action, adding new items, or an immutable monthly
// close — with detail kept for the expandable view.
//
// Lang-agnostic on purpose: this module classifies and groups; HistoryPanel
// owns every display string. Classification keys off the shared note-tag
// constants in @/lib/inventory-note-tags — the same constants the writers
// stamp — so a reworded note can't silently break History. Typed-in
// deliveries carry free-text UI copy and simply fall through to the generic
// 'delivery' kind, as do legacy/unknown notes — never dropped.

import type {
  EffectiveInventoryDelivery,
  InventoryCount,
  InventoryDiscard,
  InventoryItem,
  InventoryOrder,
} from '@/types';
import type {
  InventoryCloseAllocationMode,
  InventoryMonthCloseHistoryRow,
  InventoryPurchaseSource,
} from '@/lib/inventory-month-close';
import { groupInventoryCountsByEvent } from '@/lib/inventory-history';
import {
  ASSISTANT_COUNT_NOTE,
  ASSISTANT_ORDER_NOTE,
  INVOICE_SCAN_NOTE_PREFIX,
} from '@/lib/inventory-note-tags';
import { inventoryPurchaseRowValue } from '@/lib/inventory-purchase-cost';
import { inventoryDateKeyInZone } from '@/lib/inventory-month-close';
import { propertyTimezoneOrUTC } from '@/lib/property-timezone';

export type HistoryEventKind =
  | 'count'       // full count walk (2+ items)
  | 'quickcount'  // single-item count (ledger stepper or one-item walk)
  | 'scan'        // delivery added by scanning an invoice
  | 'delivery'    // delivery typed in by hand (or legacy/unknown stock-in)
  | 'assistant'   // AI assistant marked an item ordered
  | 'loss'        // missing / damaged / stained / stolen stock recorded
  | 'itemsAdded'  // new items created that day
  | 'monthClose'; // finance-only immutable monthly accounting snapshot

export interface HistoryMonthClose {
  month: string;
  isPartial: boolean;
  budgetComparisonAvailable: boolean;
  allocationMode: InventoryCloseAllocationMode;
  purchaseSource: InventoryPurchaseSource;
  beginningAmount: number | null;
  /** Pre-existing shelf stock discovered after the opening baseline. */
  openingAdjustmentAmount: number;
  purchasesAmount: number | null;
  /** Null means at least one logged delivery had no usable cost. */
  loggedPurchaseAmount: number | null;
  knownLoggedPurchaseAmount: number;
  endingAmount: number | null;
  actualUsageAmount: number | null;
}

export interface HistoryDeliveryCost {
  /** Sum of every delivery line whose stored total cost is finite. */
  knownSubtotal: number;
  /** False when one or more lines have no usable total cost. */
  complete: boolean;
}

export interface HistoryLine {
  name: string;
  /** Counted stock (counts) or units received (deliveries). Absent for itemsAdded. */
  qty?: number;
  /** Case count when a delivery was received in cases. */
  cases?: number | null;
  /** Count variance vs. the expected number (counted − expected), when known. */
  delta?: number;
  /** $ for the line — delivery line total, or count variance value. */
  amount?: number;
  /** Stable effective delivery state; present only on delivery lines. */
  delivery?: EffectiveInventoryDelivery;
}

export interface HistoryEvent {
  id: string;
  kind: HistoryEventKind;
  date: Date;
  /** Who did it (counter name) or the vendor for deliveries. */
  who: string | null;
  /** True when the rows carry the AI-assistant note (who is then the AI). */
  byAssistant: boolean;
  invoiceNumber: string | null;
  lines: HistoryLine[];
  /** Known delivery subtotal, count variance $, or closed-month actual. */
  amount: number | null;
  /** Present only for delivery/scan/assistant events. */
  deliveryCost?: HistoryDeliveryCost;
  /** Present only for one immutable stock-loss event. */
  loss?: Pick<InventoryDiscard, 'reason' | 'notes' | 'stockBefore' | 'stockAfter'>;
  /** Present only for a finance-gated immutable month-close event. */
  monthClose?: HistoryMonthClose;
}

function parseInvoiceNumber(notes: string): string | null {
  const m = /inv#([^@]+)@/.exec(notes);
  return m ? m[1] : null;
}

export function buildHistoryEvents(
  counts: InventoryCount[],
  deliveries: Array<InventoryOrder | EffectiveInventoryDelivery>,
  items: InventoryItem[],
  monthCloses: readonly InventoryMonthCloseHistoryRow[] = [],
  propertyTimezone: string = 'UTC',
  discards: readonly InventoryDiscard[] = [],
): HistoryEvent[] {
  const out: HistoryEvent[] = [];

  // ── Counts: one event per save session ───────────────────────────────────
  for (const group of groupInventoryCountsByEvent(counts)) {
    const date = group.reduce(
      (latest, c) => (c.countedAt && c.countedAt > latest ? c.countedAt : latest),
      group[0].countedAt ?? new Date(0),
    );
    const byAssistant = group.every((c) => c.notes === ASSISTANT_COUNT_NOTE);
    const who = group.find((c) => c.countedBy)?.countedBy || null;
    let varianceSum = 0;
    let sawVariance = false;
    const lines: HistoryLine[] = group.map((c) => {
      if (typeof c.varianceValue === 'number') { varianceSum += c.varianceValue; sawVariance = true; }
      return {
        name: c.itemName,
        qty: c.countedStock,
        delta: typeof c.variance === 'number' ? c.variance : undefined,
        amount: typeof c.varianceValue === 'number' ? c.varianceValue : undefined,
      };
    });
    out.push({
      id: `count:${group[0].countSessionId ?? group[0].id}`,
      kind: group.length === 1 ? 'quickcount' : 'count',
      date,
      who,
      byAssistant,
      invoiceNumber: null,
      lines,
      amount: sawVariance ? varianceSum : null,
    });
  }

  // ── Deliveries: group ledger rows written by one save ────────────────────
  // One scan/typed-in delivery writes all its rows atomically with the same
  // received_at + vendor + notes — that triple is the event key.
  const effectiveDeliveries: EffectiveInventoryDelivery[] = deliveries.map((entry) => {
    if ('rootOrderId' in entry) return entry;
    const total = inventoryPurchaseRowValue({
      total_cost: entry.totalCost ?? null,
      quantity: entry.quantity,
      unit_cost: entry.unitCost ?? null,
    });
    return {
      rootOrderId: entry.id,
      original: entry,
      status: 'active',
      effectiveItemId: entry.itemId,
      effectiveItemName: entry.itemName,
      effectiveQuantity: entry.quantity,
      effectiveUnitCost: entry.unitCost ?? null,
      effectiveTotalCost: total,
      correctionCount: 0,
      lastCorrection: null,
    };
  });
  const deliveryGroups = new Map<string, EffectiveInventoryDelivery[]>();
  for (const delivery of effectiveDeliveries) {
    const o = delivery.original;
    const when = o.receivedAt ?? o.orderedAt ?? null;
    const key = `${when ? when.getTime() : 'na'}|${o.vendorName ?? ''}|${o.notes ?? ''}`;
    const g = deliveryGroups.get(key);
    if (g) g.push(delivery);
    else deliveryGroups.set(key, [delivery]);
  }
  for (const [key, group] of deliveryGroups) {
    const original = group[0].original;
    const notes = original.notes ?? '';
    const kind: HistoryEventKind = notes.startsWith(INVOICE_SCAN_NOTE_PREFIX)
      ? 'scan'
      : notes === ASSISTANT_ORDER_NOTE
        ? 'assistant'
        : 'delivery'; // typed-in + legacy/unknown
    let knownSubtotal = 0;
    let complete = true;
    const lines: HistoryLine[] = group.map((delivery) => {
      const value = delivery.status === 'voided' ? 0 : delivery.effectiveTotalCost;
      if (value != null) knownSubtotal += value;
      else complete = false;
      return {
        name: delivery.effectiveItemName ?? delivery.original.itemName,
        qty: delivery.effectiveQuantity,
        cases: delivery.status === 'active' ? delivery.original.quantityCases ?? null : null,
        amount: value ?? undefined,
        delivery,
      };
    });
    out.push({
      id: `delivery:${key}`,
      kind,
      date: original.receivedAt ?? original.orderedAt ?? new Date(0),
      who: original.vendorName || null,
      byAssistant: kind === 'assistant',
      invoiceNumber: kind === 'scan' ? parseInvoiceNumber(notes) : null,
      lines,
      // With no known line cost, null means “unavailable.” Returning numeric 0
      // here would make a completely uncosted delivery look like a real $0.
      amount: complete || knownSubtotal > 0 ? knownSubtotal : null,
      deliveryCost: { knownSubtotal, complete },
    });
  }

  // ── Missing / damaged stock: one immutable event per atomic loss ────────
  for (const loss of discards) {
    const amount = loss.costValue != null && Number.isFinite(loss.costValue)
      ? loss.costValue
      : loss.unitCost != null && Number.isFinite(loss.unitCost)
        ? loss.quantity * loss.unitCost
        : null;
    out.push({
      id: `loss:${loss.requestId ?? loss.id}`,
      kind: 'loss',
      date: loss.discardedAt ?? new Date(0),
      who: loss.discardedBy || null,
      byAssistant: false,
      invoiceNumber: null,
      lines: [{ name: loss.itemName, qty: loss.quantity, amount: amount ?? undefined }],
      amount,
      loss: {
        reason: loss.reason,
        notes: loss.notes,
        stockBefore: loss.stockBefore,
        stockAfter: loss.stockAfter,
      },
    });
  }

  // ── New items: group creations by calendar day ───────────────────────────
  // (Archived items drop out of the active item list, so their creation events
  // disappear with them — acceptable; the count/delivery history survives.)
  const addsByDay = new Map<string, InventoryItem[]>();
  const historyTimezone = propertyTimezoneOrUTC(propertyTimezone);
  for (const d of items) {
    const created = d.createdAt;
    if (!created) continue; // legacy rows predate authorship tracking
    const dayKey = inventoryDateKeyInZone(created, historyTimezone);
    const g = addsByDay.get(dayKey);
    if (g) g.push(d);
    else addsByDay.set(dayKey, [d]);
  }
  for (const [dayKey, group] of addsByDay) {
    const date = group.reduce(
      (latest, d) => (d.createdAt! > latest ? d.createdAt! : latest),
      group[0].createdAt!,
    );
    out.push({
      id: `added:${dayKey}`,
      kind: 'itemsAdded',
      date,
      who: null,
      byAssistant: false,
      invoiceNumber: null,
      lines: group
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((d) => ({ name: d.name })),
      amount: null,
    });
  }

  // ── Monthly accounting closes: immutable, finance-only facts ────────
  // The caller passes these only for finance viewers, and HistoryPanel also
  // filters defensively. Open periods are workflow state, not history.
  const dollars = (cents: number | null): number | null =>
    cents == null || !Number.isFinite(cents) ? null : cents / 100;
  for (const close of monthCloses) {
    if (
      close.status !== 'closed' || !close.closedAt ||
      close.allocationMode == null || close.purchaseSource == null
    ) continue;
    const date = new Date(close.closedAt);
    if (!Number.isFinite(date.getTime())) continue;
    const actualUsageAmount = dollars(close.actualUsageCents);
    out.push({
      id: `month-close:${close.closeId}`,
      kind: 'monthClose',
      date,
      who: null,
      byAssistant: false,
      invoiceNumber: null,
      lines: [],
      amount: actualUsageAmount,
      monthClose: {
        month: close.month,
        isPartial: close.isPartial,
        budgetComparisonAvailable: close.budgetComparisonAvailable,
        allocationMode: close.allocationMode,
        purchaseSource: close.purchaseSource,
        beginningAmount: dollars(close.beginningCents),
        openingAdjustmentAmount: dollars(close.openingAdjustmentCents) ?? 0,
        purchasesAmount: dollars(close.purchasesCents),
        loggedPurchaseAmount: dollars(close.loggedPurchaseCents),
        knownLoggedPurchaseAmount: dollars(close.knownLoggedPurchaseCents) ?? 0,
        endingAmount: dollars(close.endingCents),
        actualUsageAmount,
      },
    });
  }

  out.sort((a, b) => b.date.getTime() - a.date.getTime());
  return out;
}

/** Defense in depth: month-close money must never enter a non-finance feed. */
export function historyEventsForViewer(
  events: readonly HistoryEvent[],
  canViewFinancials: boolean,
): HistoryEvent[] {
  return canViewFinancials ? [...events] : events.filter((event) => event.kind !== 'monthClose');
}
