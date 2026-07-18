// Builds the History panel's event feed from the raw count + delivery ledgers
// (2026-07-18 rework). One event = one thing a person (or the AI) actually DID
// in the app — a count walk, a quick count, an invoice scan, a typed-in
// delivery, an AI-assistant action, or adding new items — with the per-item
// lines kept for the expandable detail view.
//
// Lang-agnostic on purpose: this module classifies and groups; HistoryPanel
// owns every display string. The classification keys off the `notes` strings
// each workflow stamps on its rows:
//   • Invoice scan          → "Invoice scan" / "Invoice scan · inv#N@vendor"
//                             (src/lib/inventory-invoice-commit.ts)
//   • Typed-in delivery     → "Delivery — added manually" (EN) /
//                             "Entrega — agregada a mano" (ES) (DeliverySheet)
//   • AI assistant          → "Counted via Staxis assistant" /
//                             "Marked ordered via assistant" (agent tools)
// Unknown/legacy notes fall back to a generic delivery event — never dropped.

import type { InventoryCount, InventoryOrder } from '@/types';
import { groupInventoryCountsByEvent } from '@/lib/inventory-history';
import type { DisplayItem } from './types';

export type HistoryEventKind =
  | 'count'       // full count walk (2+ items)
  | 'quickcount'  // single-item count (ledger stepper or one-item walk)
  | 'scan'        // delivery added by scanning an invoice
  | 'delivery'    // delivery typed in by hand (or legacy/unknown stock-in)
  | 'assistant'   // AI assistant marked an item ordered
  | 'itemsAdded'; // new items created that day

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
  /** Σ delivery cost, or Σ count variance $. Null when no row had a $ figure. */
  amount: number | null;
}

const ASSISTANT_COUNT_NOTE = 'Counted via Staxis assistant';
const ASSISTANT_ORDER_NOTE = 'Marked ordered via assistant';
const MANUAL_DELIVERY_NOTES = ['Delivery — added manually', 'Entrega — agregada a mano'];

function parseInvoiceNumber(notes: string): string | null {
  const m = /inv#([^@]+)@/.exec(notes);
  return m ? m[1] : null;
}

export function buildHistoryEvents(
  counts: InventoryCount[],
  orders: InventoryOrder[],
  display: DisplayItem[],
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
  const deliveryGroups = new Map<string, InventoryOrder[]>();
  for (const o of orders) {
    const when = o.receivedAt ?? o.orderedAt ?? null;
    const key = `${when ? when.getTime() : 'na'}|${o.vendorName ?? ''}|${o.notes ?? ''}`;
    const g = deliveryGroups.get(key);
    if (g) g.push(o);
    else deliveryGroups.set(key, [o]);
  }
  for (const [key, group] of deliveryGroups) {
    const notes = group[0].notes ?? '';
    const kind: HistoryEventKind = notes.startsWith('Invoice scan')
      ? 'scan'
      : notes === ASSISTANT_ORDER_NOTE
        ? 'assistant'
        : 'delivery'; // typed-in + legacy/unknown
    let costSum = 0;
    let sawCost = false;
    const lines: HistoryLine[] = group.map((o) => {
      if (typeof o.totalCost === 'number') { costSum += o.totalCost; sawCost = true; }
      return {
        name: o.itemName,
        qty: o.quantity,
        cases: o.quantityCases ?? null,
        amount: typeof o.totalCost === 'number' ? o.totalCost : undefined,
      };
    });
    out.push({
      id: `delivery:${key}`,
      kind,
      date: group[0].receivedAt ?? group[0].orderedAt ?? new Date(0),
      who: group[0].vendorName || null,
      byAssistant: kind === 'assistant',
      invoiceNumber: kind === 'scan' ? parseInvoiceNumber(notes) : null,
      lines,
      amount: sawCost ? costSum : null,
    });
  }

  // ── New items: group creations by calendar day ───────────────────────────
  // (Archived items drop out of `display`, so their creation events disappear
  // with them — acceptable; the count/delivery history above survives.)
  const addsByDay = new Map<string, DisplayItem[]>();
  for (const d of display) {
    const created = d.raw.createdAt;
    if (!created) continue; // legacy rows predate authorship tracking
    const dayKey = `${created.getFullYear()}-${created.getMonth()}-${created.getDate()}`;
    const g = addsByDay.get(dayKey);
    if (g) g.push(d);
    else addsByDay.set(dayKey, [d]);
  }
  for (const [dayKey, group] of addsByDay) {
    const date = group.reduce(
      (latest, d) => (d.raw.createdAt! > latest ? d.raw.createdAt! : latest),
      group[0].raw.createdAt!,
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

  out.sort((a, b) => b.date.getTime() - a.date.getTime());
  return out;
}
