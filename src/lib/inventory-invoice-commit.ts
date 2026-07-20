// ═══════════════════════════════════════════════════════════════════════════
// Invoice commit planner — turn a reviewed invoice (operator-confirmed line
// matches) into a normalized, validated, executable plan.
//
// Pure + dependency-free so it's fully unit-testable. The sheet's executor
// runs the plan against the db/* helpers; this module decides WHAT to write:
//
//   • orders[]        one inventory_orders row per received line (ledger fidelity)
//   • creates[]       one new inventory item per "create" line (stock = received)
//   • stockUpdates[]  legacy review projection of the resulting stock. The
//                     atomic delivery executor intentionally DOES NOT write
//                     these absolute values; Postgres adds each received
//                     quantity to the latest row-locked stock instead.
//
// Stock semantics = re-baseline: finalStock = max(0, round(onHandEstimate)) +
// receivedQty (the manager-visible "on hand → after"), overridable per item
// when the estimate looks stale. See plan §3.
// ═══════════════════════════════════════════════════════════════════════════

import { INVOICE_SCAN_NOTE_PREFIX } from '@/lib/inventory-note-tags';
import {
  localDateTimeToUtc,
  propertyLocalDate,
} from '@/lib/rules-engine/time-utils';

export type LineDecision = 'match' | 'create' | 'skip';
export type InvCategory = 'housekeeping' | 'maintenance' | 'breakfast';

export interface ReviewLineInput {
  /** Stable key for retry tracking + create→order linking. */
  key: string;
  /** Raw invoice line name (snapshotted onto the order). */
  itemName: string;
  decision: LineDecision;
  matchedItemId: string | null;
  /** Required for matched lines. The review UI sets this automatically only
   * for conservative high-confidence matches; every other suggestion requires
   * an explicit manager action. */
  matchConfirmed?: boolean;
  /** Qty received (UI holds a string; coerced here). */
  qty: number | string;
  quantityCases?: number | null;
  unitCost?: number | string | null;
  /** Invoice line total. When present this is the authoritative purchase
   * amount; the per-unit cost is derived from it so discounts/rounding on the
   * invoice are not lost when inventory_orders stores quantity × unit_cost. */
  totalCost?: number | string | null;
  /** Matched lines: current estimated on-hand, for the re-baseline. */
  onHandEstimate?: number;
  /** Matched lines: operator override of the resulting stock (absolute). */
  afterOverride?: number | string | null;
  /** Create lines: new-item fields. */
  newItem?: {
    category: InvCategory;
    customCategoryId?: string | null;
    unit: string;
    parLevel: number | string;
    setAside?: number | string;
  };
}

export interface ReviewDraftInput {
  /** IANA timezone for the hotel receiving the inventory. Invoice dates are
   * hotel calendar dates, never dates in the manager's browser timezone. */
  propertyTimezone: string;
  vendorName?: string | null;
  invoiceDate?: string | null; // YYYY-MM-DD
  invoiceNumber?: string | null;
  lines: ReviewLineInput[];
}

export interface CommitOrder {
  lineKey: string;
  /** Resolved item id for matched lines; null for create lines (resolved at
   *  exec time from the created item via createKey). */
  itemId: string | null;
  createKey?: string;
  itemName: string;
  quantity: number;
  quantityCases: number | null;
  unitCost: number | undefined;
}

export interface CommitStockUpdate {
  /** @deprecated Display/review projection only. Never persist this stale
   * browser-derived absolute value; use additive delivery lines. */
  itemId: string;
  finalStock: number;
}

export interface CommitCreate {
  createKey: string;
  name: string;
  category: InvCategory;
  customCategoryId: string | null;
  unit: string;
  parLevel: number;
  setAside: number;
  unitCost: number | undefined;
  initialStock: number;
}

export interface CommitPlan {
  vendorName: string | undefined;
  receivedAt: Date;
  notesTag: string;
  orders: CommitOrder[];
  stockUpdates: CommitStockUpdate[];
  creates: CommitCreate[];
}

export class InvoiceCommitValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'InvoiceCommitValidationError';
  }
}

export const INVOICE_REFERENCE_MAX_LENGTH = 80;

export type InvoiceReferenceValidationCode =
  | 'invoice_reference_required'
  | 'invoice_reference_invalid';

/**
 * Canonical form used by both the manager-facing field and the durable
 * delivery key. NFKC folds full-width OCR characters, whitespace is made
 * deterministic, and casing is normalized because invoice references are
 * identifiers rather than prose.
 */
export function normalizeInvoiceReference(value?: string | null): string {
  return (value ?? '')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleUpperCase('en-US');
}

export function invoiceReferenceValidationCode(
  value?: string | null,
): InvoiceReferenceValidationCode | null {
  const reference = normalizeInvoiceReference(value);
  if (!reference) return 'invoice_reference_required';
  // @ and · delimit the reference/vendor components in the durable business
  // key. Controls/formatting characters could make visually identical keys
  // compare differently, while a punctuation-only value is not an identifier.
  if (
    reference.length > INVOICE_REFERENCE_MAX_LENGTH
    || /[@·\p{Cc}\p{Cf}\p{Cs}]/u.test(reference)
    || !/[\p{L}\p{N}]/u.test(reference)
  ) return 'invoice_reference_invalid';
  return null;
}

function requireInvoiceReference(value?: string | null): string {
  const reference = normalizeInvoiceReference(value);
  const code = invoiceReferenceValidationCode(reference);
  if (code === 'invoice_reference_required') {
    throw new InvoiceCommitValidationError(
      code,
      'Enter an invoice number or unique reference before saving.',
    );
  }
  if (code === 'invoice_reference_invalid') {
    throw new InvoiceCommitValidationError(
      code,
      `Use an invoice reference of ${INVOICE_REFERENCE_MAX_LENGTH} characters or fewer without control characters, “@”, or “·”.`,
    );
  }
  return reference;
}

function toFiniteNumber(x: unknown): number | undefined {
  if (x === null || x === undefined || x === '') return undefined;
  const n = typeof x === 'number' ? x : Number(x);
  return Number.isFinite(n) ? n : undefined;
}

function toPositiveQty(x: unknown): number | null {
  const n = toFiniteNumber(x);
  return n !== undefined && n > 0 ? n : null;
}

function toCases(x: unknown): number | null {
  const n = toFiniteNumber(x);
  return n !== undefined && n > 0 ? n : null;
}

function normalizeInvoiceTagVendor(value?: string | null): string {
  return (value ?? '')
    .normalize('NFKC')
    .replace(/[@·\p{Cc}\p{Cf}\p{Cs}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
}

/** Durable business-key marker stamped on the order notes. Blank input keeps
 *  the legacy generic tag for parsing old rows, but buildCommitPlan rejects it
 *  before any new scanned delivery can be committed. */
export function buildNotesTag(invoiceNumber?: string | null, vendorName?: string | null): string {
  const num = normalizeInvoiceReference(invoiceNumber);
  if (!num) return INVOICE_SCAN_NOTE_PREFIX;
  if (invoiceReferenceValidationCode(num) !== null) {
    throw new InvoiceCommitValidationError(
      'invoice_reference_invalid',
      `Use an invoice reference of ${INVOICE_REFERENCE_MAX_LENGTH} characters or fewer without control characters, “@”, or “·”.`,
    );
  }
  const vendor = normalizeInvoiceTagVendor(vendorName);
  return `${INVOICE_SCAN_NOTE_PREFIX} · inv#${num}@${vendor}`;
}

/** Warning-only duplicate check: true when an existing order note already
 *  carries this invoice's (numbered) tag. Not a hard guarantee — see plan §4. */
export function invoiceAlreadyRecorded(existingNotes: readonly (string | null | undefined)[], notesTag: string): boolean {
  if (!notesTag.startsWith(`${INVOICE_SCAN_NOTE_PREFIX} · inv#`)) return false; // unnumbered → can't dedupe
  const canonicalize = (value: string) => value
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
  const canonicalTag = canonicalize(notesTag);
  return existingNotes.some((n) => typeof n === 'string'
    && canonicalize(n) === canonicalTag);
}

export function isInvoiceCalendarDate(value: string): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value;
}

/** Recover the hotel-local calendar date from a persisted delivery instant.
 * This deliberately does not slice the UTC ISO timestamp: hotels east of UTC
 * can have a local invoice date that is one day ahead of that UTC date. */
export function invoiceDateFromReceivedAt(
  receivedAt: Date | string,
  propertyTimezone: string,
): string | null {
  const instant = receivedAt instanceof Date ? receivedAt : new Date(receivedAt);
  if (Number.isNaN(instant.getTime())) return null;
  return propertyLocalDate(instant, propertyTimezone);
}

function parseReceivedAt(
  invoiceDate: string | null | undefined,
  propertyTimezone: string,
  now: Date,
): Date {
  const raw = (invoiceDate ?? '').trim();
  if (!isInvoiceCalendarDate(raw)) {
    throw new InvoiceCommitValidationError(
      'invoice_date_required',
      'Confirm a valid invoice date before saving.',
    );
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: propertyTimezone }).format(new Date());
  } catch {
    throw new InvoiceCommitValidationError(
      'invoice_timezone_invalid',
      'The hotel timezone is invalid, so the invoice date cannot be saved safely.',
    );
  }
  const hotelToday = propertyLocalDate(now, propertyTimezone);
  if (raw > hotelToday) {
    throw new InvoiceCommitValidationError(
      'invoice_date_future',
      'The invoice date cannot be later than today at this hotel.',
    );
  }
  // Noon is an unambiguous civil time on DST transition days. The shared
  // converter asks Intl for the offset at this hotel-local date, so the
  // result is independent of both the browser timezone and DST season.
  const receivedAt = localDateTimeToUtc(raw, '12:00:00', propertyTimezone);
  if (receivedAt && invoiceDateFromReceivedAt(receivedAt, propertyTimezone) === raw) return receivedAt;
  throw new InvoiceCommitValidationError(
    'invoice_date_invalid',
    'The invoice date could not be placed in the hotel timezone. Check it and try again.',
  );
}

/**
 * Build the executable commit plan. `now` is injectable for deterministic
 * tests; in the app it defaults to the current time.
 */
export function buildCommitPlan(draft: ReviewDraftInput, now: Date = new Date()): CommitPlan {
  const vendorName = (draft.vendorName ?? '').trim() || undefined;
  const invoiceReference = requireInvoiceReference(draft.invoiceNumber);
  const receivedAt = parseReceivedAt(draft.invoiceDate, draft.propertyTimezone, now);
  const notesTag = buildNotesTag(invoiceReference, vendorName);

  const orders: CommitOrder[] = [];
  const creates: CommitCreate[] = [];
  // Coalesce matched lines by itemId.
  const byItem = new Map<string, { qty: number; onHand: number; override: number | undefined }>();

  for (const line of draft.lines) {
    if (line.decision === 'skip') continue;
    if (line.decision === 'match' && line.matchConfirmed !== true) {
      throw new InvoiceCommitValidationError(
        'invoice_match_confirmation_required',
        `Confirm or rematch “${line.itemName.trim() || 'invoice line'}” before saving.`,
      );
    }
    const qty = toPositiveQty(line.qty);
    if (qty === null) {
      throw new InvoiceCommitValidationError(
        'invoice_quantity_invalid',
        `Enter a quantity greater than zero for “${line.itemName.trim() || 'invoice line'}.”`,
      );
    }
    const unitCost = (() => {
      const lineTotal = toFiniteNumber(line.totalCost);
      if (lineTotal !== undefined && lineTotal >= 0) return lineTotal / qty;
      const n = toFiniteNumber(line.unitCost);
      return n !== undefined && n >= 0 ? n : undefined;
    })();
    if (unitCost === undefined) {
      throw new InvoiceCommitValidationError(
        'invoice_cost_required',
        `Enter a unit cost for “${line.itemName.trim() || 'invoice line'}.”`,
      );
    }
    const quantityCases = toCases(line.quantityCases);

    if (line.decision === 'create') {
      const name = line.itemName.trim();
      const unit = line.newItem?.unit.trim() ?? '';
      const parLevel = toFiniteNumber(line.newItem?.parLevel);
      const setAside = toFiniteNumber(line.newItem?.setAside ?? 0);
      if (
        !line.newItem
        || !name
        || !unit
        || parLevel === undefined
        || parLevel < 0
        || setAside === undefined
        || !Number.isInteger(setAside)
        || setAside < 0
        || setAside > qty
      ) {
        throw new InvoiceCommitValidationError(
          'invoice_new_item_incomplete',
          'Complete the new item name, category, unit, non-negative par level, and whole-number set-aside amount before saving.',
        );
      }
      creates.push({
        createKey: line.key,
        name,
        category: line.newItem.category,
        customCategoryId: line.newItem.customCategoryId?.trim() || null,
        unit,
        parLevel,
        setAside,
        unitCost,
        initialStock: qty,
      });
      orders.push({ lineKey: line.key, itemId: null, createKey: line.key, itemName: name, quantity: qty, quantityCases, unitCost });
      continue;
    }

    // decision === 'match'
    if (!line.matchedItemId) {
      throw new InvoiceCommitValidationError(
        'invoice_match_item_required',
        `Choose an inventory item for “${line.itemName.trim() || 'invoice line'}” before saving.`,
      );
    }
    orders.push({ lineKey: line.key, itemId: line.matchedItemId, itemName: line.itemName.trim(), quantity: qty, quantityCases, unitCost });

    const prev = byItem.get(line.matchedItemId);
    const onHand = Math.max(0, Math.round(line.onHandEstimate ?? 0));
    const override = toFiniteNumber(line.afterOverride);
    if (prev) {
      prev.qty += qty;
      if (override !== undefined) prev.override = override; // last explicit override wins
    } else {
      byItem.set(line.matchedItemId, { qty, onHand, override: override !== undefined ? override : undefined });
    }
  }

  const stockUpdates: CommitStockUpdate[] = [];
  for (const [itemId, g] of byItem) {
    const finalStock = g.override !== undefined ? Math.max(0, g.override) : g.onHand + g.qty;
    stockUpdates.push({ itemId, finalStock });
  }

  return { vendorName, receivedAt, notesTag, orders, stockUpdates, creates };
}
