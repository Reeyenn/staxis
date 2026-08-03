// ═══════════════════════════════════════════════════════════════════════════
// The confirm screen's brain.
//
// Everything a manager is asked to approve is decided here, in one pure
// function, so the screen can only ever show what the server would actually
// write. Nothing in this module touches the database and nothing auto-commits:
// an import produces a DRAFT, a person reads it, and only then does anything
// land.
//
// The three rules that matter, in order of how much damage getting them wrong
// would do:
//
//  1. THE AS-OF DATE DECIDES EVERYTHING. A sheet that was current last week may
//     set today's counts. A sheet from May may not, ever — its numbers land in
//     history, dated May, and today's stock is untouched. There is no override,
//     because the manager who uploads a May sheet is not claiming it is true
//     today; they are handing us their item list.
//  2. MONEY IS CENTS. See ./money.ts.
//  3. WE SAY WHAT WE SKIPPED. A silent drop is a lie with a good UI.
// ═══════════════════════════════════════════════════════════════════════════

import { matchInvoiceLine, normalizeName, type MatchableItem, type MatchTier } from '@/lib/inventory-match';
import { isPlausibleUnitCostCents, parseMoneyToCents } from './money';
import { displayUnit, findUnitConflicts, type UnitConflict, type UnitObservation } from './units';

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * A sheet as-of this many days ago or fewer is "recent enough to be today's
 * truth". Seven days is one hotel week: the sheet from Monday's count is still
 * roughly what is on the shelf on Friday, and a sheet older than that has had
 * a delivery and a weekend happen to it.
 */
export const RECENT_AS_OF_MAX_AGE_DAYS = 7;

/** Rows past this are not shown; a confirm screen a person reads has a limit. */
export const MAX_DRAFT_LINES = 1_000;

export type BuiltInCategory = 'housekeeping' | 'maintenance' | 'breakfast';
const BUILT_IN_CATEGORIES: readonly BuiltInCategory[] = ['housekeeping', 'maintenance', 'breakfast'];

/** How the batch's quantities are allowed to be used. */
export type AsOfMode = 'current' | 'history_only';

export type SkipReason =
  | 'total_row'
  | 'header_row'
  | 'note_row'
  | 'no_name'
  | 'no_numbers'
  | 'duplicate_in_file'
  | 'over_limit';

const SKIP_REASON_LABEL: Record<SkipReason, string> = {
  total_row: 'totals',
  header_row: 'column headings',
  note_row: 'notes',
  no_name: 'rows with no item name',
  no_numbers: 'rows with no numbers',
  duplicate_in_file: 'repeats of a row already in the list',
  over_limit: 'rows past the import limit',
};

// ── Inputs ─────────────────────────────────────────────────────────────────

/** One row as the reader (model or CSV parser) handed it to us. */
export interface RawImportRow {
  /** 1-based row number in the source, for "we skipped row 14". */
  rowIndex: number;
  name?: string | null;
  unit?: string | null;
  /** Free text; matched against built-in and the hotel's custom categories. */
  category?: string | null;
  /** Money as the sheet spelled it. Converted to cents here, never before. */
  unitCost?: string | number | null;
  vendorName?: string | null;
  quantity?: string | number | null;
  parLevel?: string | number | null;
  /** Per-row as-of date when the source carries one (a monthly workbook). */
  asOfDate?: string | null;
}

export interface ExistingItem extends MatchableItem {
  unit: string | null;
  category: string | null;
  customCategoryId: string | null;
}

export interface CustomCategoryRef {
  id: string;
  name: string;
}

export interface BuildDraftInput {
  rows: readonly RawImportRow[];
  existingItems: readonly ExistingItem[];
  customCategories: readonly CustomCategoryRef[];
  /** Hotel calendar date the sheet was current (YYYY-MM-DD). */
  asOfDate: string;
  /** Today at the hotel (YYYY-MM-DD). Injected so tests are deterministic. */
  todayLocal: string;
  /** Rows the reader itself refused, with its own stated reason. */
  readerSkipped?: ReadonlyArray<{ rowIndex: number; reason: SkipReason; text?: string }>;
}

// ── Outputs ────────────────────────────────────────────────────────────────

export interface MergeProposal {
  itemId: string;
  itemName: string;
  score: number;
  tier: MatchTier;
  /** True only for an exact/normalized name match with no unit disagreement.
   *  Anything else is shown ticked-off until a person says yes. */
  confident: boolean;
  /** Set when the existing item's unit disagrees with the sheet's. */
  unitDisagreement: { ours: string; theirs: string } | null;
}

/** One dated observation of an item, from one sheet or tab of the source. */
export interface HistoryPoint {
  asOfDate: string;
  quantity: number;
  rowIndex: number;
}

export interface DraftLine {
  key: string;
  rowIndex: number;
  name: string;
  unit: string;
  category: BuiltInCategory;
  customCategoryId: string | null;
  unitCostCents: number | null;
  vendorName: string | null;
  quantity: number | null;
  parLevel: number | null;
  asOfDate: string;
  /** What this line will do if confirmed as-is. */
  action: 'merge' | 'create';
  merge: MergeProposal | null;
  /** Other plausible existing items, for the change-my-mind picker. */
  alternatives: MergeProposal[];
  /** Where this line's quantity is allowed to go. */
  quantityTarget: 'current_stock' | 'history_only' | 'none';
  /**
   * Every dated observation of this item in the source, oldest first, INCLUDING
   * the one shown on the line. A workbook with one tab per month is the only
   * import that actually teaches the model anything: consumption is learned
   * from the gap between two counts, so a single sheet is worth exactly zero
   * training windows and twelve sheets are worth eleven.
   */
  historyPoints: HistoryPoint[];
}

export interface SkippedRow {
  rowIndex: number;
  reason: SkipReason;
  /** The row's text, trimmed, so the manager can see what we dropped. */
  text: string;
}

export interface ImportDraft {
  mode: AsOfMode;
  asOfDate: string;
  ageDays: number;
  /** The one sentence at the top of the confirm screen. */
  modeSentence: string;
  lines: DraftLine[];
  skipped: SkippedRow[];
  /** "Skipped 7 rows: totals and notes." Empty string when nothing was skipped. */
  skippedSentence: string;
  unitConflicts: UnitConflict[];
  /** Distinct supplier names seen, for the vendor suggestion pool. */
  vendorNames: string[];
  counts: { create: number; merge: number; skipped: number };
}

// ── Date helpers ───────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** Whole days between two hotel calendar dates. Negative when `a` is later. */
export function daysBetweenIso(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

export function formatFriendlyDate(iso: string): string {
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  const [y, m, d] = iso.split('-').map(Number);
  const name = names[m - 1];
  if (!name) return iso;
  return `${name} ${d}, ${y}`;
}

/**
 * The single decision the whole feature hangs on. A sheet from the future is
 * treated as old, not current: a typo'd year is not permission to overwrite
 * the shelf.
 */
export function decideAsOfMode(asOfDate: string, todayLocal: string): AsOfMode {
  const age = daysBetweenIso(asOfDate, todayLocal);
  if (age < 0) return 'history_only';
  return age <= RECENT_AS_OF_MAX_AGE_DAYS ? 'current' : 'history_only';
}

/**
 * The as-of date the confirm screen opens with.
 *
 * A date printed on the sheet WINS, because it is evidence and today is a
 * guess. When the reader found nothing we open on today and the screen says
 * so plainly, which makes a manager importing an old sheet change the date
 * rather than be quietly told their May numbers are live. A detected date in
 * the future is discarded for the same reason.
 */
export function pickAsOfDate(detected: string | null | undefined, todayLocal: string): string {
  if (isIsoDate(detected) && detected <= todayLocal) return detected;
  return todayLocal;
}

export function modeSentenceFor(mode: AsOfMode, asOfDate: string, todayLocal: string): string {
  const friendly = formatFriendlyDate(asOfDate);
  if (mode === 'current') {
    const age = daysBetweenIso(asOfDate, todayLocal);
    const when = age === 0 ? 'today' : age === 1 ? 'yesterday' : `${age} days ago`;
    return `This sheet was current ${when}, so these numbers will become your on-hand counts.`;
  }
  return `These counts are from ${friendly}, so they go into your history, not today's stock. Do a fresh count when you are ready.`;
}

// ── Row classification ─────────────────────────────────────────────────────

const HEADER_WORDS = new Set([
  'item', 'items', 'description', 'product', 'name', 'qty', 'quantity', 'unit',
  'units', 'price', 'cost', 'unitcost', 'vendor', 'supplier', 'category', 'par',
  'parlevel', 'onhand', 'count', 'amount', 'total', 'sku', 'notes',
]);

const TOTAL_PREFIX = /^(grand\s+)?(total|subtotal|sub-total|sum|running\s+total)\b/i;
const NOTE_PREFIX = /^(note|notes|comment|comments|remark|remarks|reminder|n\/a)\b/i;

function looksLikeHeaderRow(row: RawImportRow): boolean {
  const cells = [row.name, row.unit, row.category, row.quantity, row.unitCost, row.vendorName]
    .map((c) => (c === null || c === undefined ? '' : String(c)).trim().toLowerCase().replace(/[^a-z]/g, ''))
    .filter(Boolean);
  if (cells.length < 2) return false;
  return cells.every((c) => HEADER_WORDS.has(c));
}

function toFiniteNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const cleaned = v.trim().replace(/,/g, '').replace(/[^0-9.\-]/g, '');
  if (!cleaned || !/^-?\d*\.?\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function resolveCategory(
  raw: string | null | undefined,
  customCategories: readonly CustomCategoryRef[],
  matchedExisting: ExistingItem | null,
): { category: BuiltInCategory; customCategoryId: string | null } {
  // An item we already have keeps the shelf it already lives on. The sheet is
  // not more authoritative than the hotel's own setup.
  if (matchedExisting) {
    const existing = BUILT_IN_CATEGORIES.find((c) => c === matchedExisting.category);
    return {
      category: existing ?? 'housekeeping',
      customCategoryId: matchedExisting.customCategoryId,
    };
  }
  const s = (raw ?? '').trim().toLowerCase();
  if (s) {
    const custom = customCategories.find((c) => c.name.trim().toLowerCase() === s);
    if (custom) return { category: 'housekeeping', customCategoryId: custom.id };
    for (const c of BUILT_IN_CATEGORIES) if (c === s) return { category: c, customCategoryId: null };
    if (/breakfast|food|kitchen|coffee|pantry|beverage/.test(s)) return { category: 'breakfast', customCategoryId: null };
    if (/maint|engineer|repair|tool|bulb|filter|hvac/.test(s)) return { category: 'maintenance', customCategoryId: null };
  }
  return { category: 'housekeeping', customCategoryId: null };
}

// ── The builder ────────────────────────────────────────────────────────────

export function buildImportDraft(input: BuildDraftInput): ImportDraft {
  const { rows, existingItems, customCategories, asOfDate, todayLocal } = input;

  const mode = decideAsOfMode(asOfDate, todayLocal);
  const ageDays = daysBetweenIso(asOfDate, todayLocal);

  const skipped: SkippedRow[] = [];
  for (const s of input.readerSkipped ?? []) {
    skipped.push({ rowIndex: s.rowIndex, reason: s.reason, text: (s.text ?? '').trim().slice(0, 200) });
  }

  const unitObservations: UnitObservation[] = [];
  const vendorNames = new Set<string>();

  const matchPool: ExistingItem[] = existingItems.filter((i) => typeof i.name === 'string' && i.name.trim() !== '');
  const byId = new Map(matchPool.map((i) => [i.id, i]));

  // ── Pass 1: classify every row, and group the survivors by item ──────────
  //
  // Grouping is by item AND date, not by item alone. A monthly workbook
  // repeats the same item on every tab, and calling June's row a duplicate of
  // March's would throw away the whole point of importing history. The same
  // item on the same date IS a duplicate, and those fold.
  interface KeptRow {
    row: RawImportRow;
    key: string;
    rawName: string;
    rawUnit: string;
    hasUnit: boolean;
    quantity: number | null;
    parLevel: number | null;
    unitCostCents: number | null;
    vendorName: string | null;
    asOfDate: string;
  }
  const groups = new Map<string, KeptRow[]>();
  let kept = 0;

  for (const row of rows) {
    const rawName = (row.name ?? '').toString().trim();
    const rowText = [rawName, row.unit, row.quantity, row.unitCost]
      .filter((v) => v !== null && v !== undefined && String(v).trim() !== '')
      .map((v) => String(v).trim())
      .join(' · ')
      .slice(0, 200);

    if (kept >= MAX_DRAFT_LINES) {
      skipped.push({ rowIndex: row.rowIndex, reason: 'over_limit', text: rowText });
      continue;
    }
    if (!rawName) {
      skipped.push({ rowIndex: row.rowIndex, reason: 'no_name', text: rowText });
      continue;
    }
    if (TOTAL_PREFIX.test(rawName)) {
      skipped.push({ rowIndex: row.rowIndex, reason: 'total_row', text: rowText });
      continue;
    }
    if (NOTE_PREFIX.test(rawName)) {
      skipped.push({ rowIndex: row.rowIndex, reason: 'note_row', text: rowText });
      continue;
    }
    if (looksLikeHeaderRow(row)) {
      skipped.push({ rowIndex: row.rowIndex, reason: 'header_row', text: rowText });
      continue;
    }
    // A name with no letters at all is a page number or a stray total.
    if (!/\p{L}/u.test(rawName)) {
      skipped.push({ rowIndex: row.rowIndex, reason: 'no_name', text: rowText });
      continue;
    }

    const quantity = toFiniteNumber(row.quantity);
    const parLevel = toFiniteNumber(row.parLevel);
    const unitCostCents = parseMoneyToCents(row.unitCost ?? null);
    const hasAnyNumber = quantity !== null || parLevel !== null || isPlausibleUnitCostCents(unitCostCents);
    const hasUnit = (row.unit ?? '').toString().trim() !== '';
    // A line with a name and nothing else is a section heading ("HOUSEKEEPING")
    // or a sentence somebody typed in the margin.
    if (!hasAnyNumber && !hasUnit) {
      skipped.push({ rowIndex: row.rowIndex, reason: 'note_row', text: rowText });
      continue;
    }

    const key = normalizeName(rawName);
    const rowAsOf = isIsoDate(row.asOfDate) ? row.asOfDate : asOfDate;
    const rawUnit = (row.unit ?? '').toString();
    // Recorded BEFORE any folding: the whole point of a cross-month conflict is
    // that two rows for the same item disagree, so a fold that ran first would
    // swallow the evidence.
    unitObservations.push({ itemKey: key, itemName: rawName, rawUnit, asOfDate: rowAsOf });

    const group = groups.get(key);
    const sameDate = group?.find((k) => k.asOfDate === rowAsOf);
    if (sameDate) {
      // Genuinely the same row twice: one shelf, one date, two lines.
      if (quantity !== null) sameDate.quantity = (sameDate.quantity ?? 0) + quantity;
      if (sameDate.unitCostCents === null && isPlausibleUnitCostCents(unitCostCents)) {
        sameDate.unitCostCents = unitCostCents;
      }
      skipped.push({ rowIndex: row.rowIndex, reason: 'duplicate_in_file', text: rowText });
      continue;
    }

    const entry: KeptRow = {
      row, key, rawName, rawUnit, hasUnit,
      quantity, parLevel,
      unitCostCents: isPlausibleUnitCostCents(unitCostCents) ? unitCostCents : null,
      vendorName: (row.vendorName ?? '').toString().trim() || null,
      asOfDate: rowAsOf,
    };
    if (entry.vendorName) vendorNames.add(entry.vendorName);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
    kept += 1;
  }

  // ── Pass 2: one line per item, dated history behind it ──────────────────
  const lines: DraftLine[] = [];
  for (const [, entries] of groups) {
    entries.sort((a, b) => (a.asOfDate < b.asOfDate ? -1 : a.asOfDate > b.asOfDate ? 1 : 0));
    // The line shows the NEWEST sheet, because that is the one a manager is
    // deciding about. The older ones ride along as history.
    const newest = entries[entries.length - 1];
    const { rawName, rawUnit, hasUnit } = newest;

    const match = matchInvoiceLine(rawName, matchPool);
    const toProposal = (c: { id: string; name: string; score: number; tier: MatchTier }): MergeProposal => {
      const existing = byId.get(c.id) ?? null;
      const ours = displayUnit(existing?.unit ?? null);
      const theirs = displayUnit(rawUnit);
      const disagrees = hasUnit && existing?.unit != null && ours !== theirs;
      return {
        itemId: c.id,
        itemName: c.name,
        score: c.score,
        tier: c.tier,
        confident: (c.tier === 'exact' || c.tier === 'normalized') && !match.ambiguous && !disagrees,
        unitDisagreement: disagrees ? { ours, theirs } : null,
      };
    };

    const proposals = match.candidates.map(toProposal);
    const best = proposals[0] ?? null;
    const matchedExisting = best ? byId.get(best.itemId) ?? null : null;
    const { category, customCategoryId } = resolveCategory(
      newest.row.category, customCategories, best ? matchedExisting : null,
    );

    // A price or a supplier may only appear on one tab of a workbook. Take the
    // newest one that has it rather than blanking the item because June's tab
    // left the price column empty.
    const newestWith = <T>(pick: (e: KeptRow) => T | null): T | null => {
      for (let i = entries.length - 1; i >= 0; i--) {
        const v = pick(entries[i]);
        if (v !== null && v !== undefined) return v;
      }
      return null;
    };

    const historyPoints: HistoryPoint[] = entries
      .filter((e) => e.quantity !== null)
      .map((e) => ({ asOfDate: e.asOfDate, quantity: e.quantity as number, rowIndex: e.row.rowIndex }));

    lines.push({
      key: `r${newest.row.rowIndex}`,
      rowIndex: newest.row.rowIndex,
      name: rawName,
      unit: displayUnit(rawUnit || matchedExisting?.unit || null),
      category,
      customCategoryId,
      unitCostCents: newestWith((e) => e.unitCostCents),
      vendorName: newestWith((e) => e.vendorName),
      quantity: newest.quantity,
      parLevel: newestWith((e) => e.parLevel),
      asOfDate: newest.asOfDate,
      action: best ? 'merge' : 'create',
      merge: best,
      alternatives: proposals.slice(1),
      quantityTarget: newest.quantity === null
        ? 'none'
        : mode === 'current' ? 'current_stock' : 'history_only',
      historyPoints,
    });
  }

  lines.sort((a, b) => a.rowIndex - b.rowIndex);

  skipped.sort((a, b) => a.rowIndex - b.rowIndex);

  return {
    mode,
    asOfDate,
    ageDays,
    modeSentence: modeSentenceFor(mode, asOfDate, todayLocal),
    lines,
    skipped,
    skippedSentence: buildSkippedSentence(skipped),
    unitConflicts: findUnitConflicts(unitObservations),
    vendorNames: [...vendorNames].sort(),
    counts: {
      create: lines.filter((l) => l.action === 'create').length,
      merge: lines.filter((l) => l.action === 'merge').length,
      skipped: skipped.length,
    },
  };
}

/**
 * "Skipped 7 rows: totals and notes." Names what was dropped, in the manager's
 * words, and never claims a count it does not have.
 */
export function buildSkippedSentence(skipped: readonly SkippedRow[]): string {
  if (skipped.length === 0) return '';
  const order: SkipReason[] = ['total_row', 'header_row', 'note_row', 'no_name', 'no_numbers', 'duplicate_in_file', 'over_limit'];
  const present = order.filter((r) => skipped.some((s) => s.reason === r)).map((r) => SKIP_REASON_LABEL[r]);
  const noun = skipped.length === 1 ? 'row' : 'rows';
  const list = present.length === 1
    ? present[0]
    : present.length === 2
      ? `${present[0]} and ${present[1]}`
      : `${present.slice(0, -1).join(', ')} and ${present[present.length - 1]}`;
  return `Skipped ${skipped.length} ${noun}: ${list}.`;
}
