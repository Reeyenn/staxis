// ═══════════════════════════════════════════════════════════════════════════
// What we ask the model, and what we refuse to believe back.
//
// The model's job here is deliberately small: LABEL COLUMNS. It is told what
// the fields mean and asked which cell goes in which one. It is never asked to
// total anything, convert anything, decide what is current, or judge what is a
// duplicate — every one of those is done in code afterwards, where it can be
// tested and where a confident wrong answer is impossible.
//
// The validators below are the trust boundary. Anything that is not the exact
// shape we asked for becomes null or is dropped, and a response with no `rows`
// array at all is a schema failure rather than an empty import.
// ═══════════════════════════════════════════════════════════════════════════

import { VisionSchemaError } from '@/lib/vision-extract';
import type { SkipReason } from './draft';

// ── Inventory ──────────────────────────────────────────────────────────────

export interface ExtractedInventoryRow {
  row_index: number;
  item_name: string;
  unit: string | null;
  category: string | null;
  unit_cost: string | number | null;
  quantity: string | number | null;
  par_level: string | number | null;
  vendor_name: string | null;
  as_of_date: string | null;
}

export interface ExtractedInventorySheet {
  as_of_date: string | null;
  as_of_evidence: string | null;
  rows: ExtractedInventoryRow[];
  skipped: Array<{ row_index: number; reason: string; text: string | null }>;
}

export function inventoryImportPrompt(categoryNames: readonly string[]): string {
  const categories = categoryNames.length > 0
    ? categoryNames.map((c) => `"${c}"`).join(', ')
    : '"housekeeping", "maintenance", "breakfast"';
  return `You are reading a hotel's own inventory paperwork so it can be loaded into their system. It may be a spreadsheet, a printed count sheet, a supply list, or a photo of one.

Return ONE row per inventory ITEM. For each row:
- row_index (number): the row's position in the source, counting from 1. Never reuse a number.
- item_name (string): the product as written. Do not tidy, expand or translate it.
- unit (string or null): the unit of measure as written ("case", "each", "roll", "cs", "12 pk").
- category (string or null): the section the item sits under, if the sheet groups items. Use one of ${categories} when it clearly matches, otherwise copy the sheet's own heading. Null when the sheet has no sections.
- unit_cost (string or null): the PER-UNIT price exactly as printed, including the currency symbol if there is one. If only a line total is printed and you cannot tell the per-unit price, return null. Never compute it.
- quantity (string or null): the count on hand, exactly as printed.
- par_level (string or null): the target / par / minimum level, exactly as printed, if the sheet has such a column.
- vendor_name (string or null): the supplier for this item, if the sheet names one per row.
- as_of_date (string "YYYY-MM-DD" or null): only when THIS ROW carries its own date, for example a workbook with one sheet per month. Otherwise null.

Also return:
- as_of_date (string "YYYY-MM-DD" or null): the date the WHOLE document was current. Look for a printed date, a "count date", a month name in a title or tab name, or a filename-like heading. If a month is named without a day, use the first day of that month. Return null if you genuinely cannot find a date. Do NOT guess today's date.
- as_of_evidence (string or null): the exact text you read the date from, so a person can check it. Null when as_of_date is null.
- skipped: every source row you did NOT turn into an item, with { row_index, reason, text }. Use reason "total_row" for totals and subtotals, "header_row" for column headings, "note_row" for notes, comments and section headings, "no_name" for blank rows. Include them all. Leaving a row out of both lists is worse than a wrong reason.

RULES
- Never invent an item, a number or a price. A blank cell is null.
- Never add up, convert, or spread numbers across rows.
- Copy prices as text; do not round, and do not move a decimal point.
- If the same item appears twice, return it twice with different row_index values.

Return ONLY this JSON object, no prose and no code fences:
{"as_of_date":"YYYY-MM-DD","as_of_evidence":"...","rows":[{"row_index":1,"item_name":"...","unit":"case","category":null,"unit_cost":"$24.50","quantity":"6","par_level":"10","vendor_name":null,"as_of_date":null}],"skipped":[{"row_index":9,"reason":"total_row","text":"Total 412"}]}

If the document is not an inventory list, return {"as_of_date":null,"as_of_evidence":null,"rows":[],"skipped":[]}.`;
}

const READER_SKIP_REASONS: readonly SkipReason[] = [
  'total_row', 'header_row', 'note_row', 'no_name', 'no_numbers', 'duplicate_in_file',
];

export function normalizeReaderSkipReason(raw: unknown): SkipReason {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  const hit = READER_SKIP_REASONS.find((r) => r === s);
  if (hit) return hit;
  if (/total|subtotal|sum/.test(s)) return 'total_row';
  if (/head|column|title/.test(s)) return 'header_row';
  if (/blank|empty|no name/.test(s)) return 'no_name';
  return 'note_row';
}

function asStringOrNull(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = v.trim();
    return t ? t.slice(0, 300) : null;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function asScalarOrNull(v: unknown): string | number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  return asStringOrNull(v);
}

/** Rows past this are dropped before the draft is built; the model is capped
 *  by its own token budget long before this, so hitting it means something
 *  pathological arrived. */
const MAX_EXTRACTED_ROWS = 2_000;

export function validateInventorySheet(raw: unknown): ExtractedInventorySheet {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new VisionSchemaError('expected an object at top level');
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.rows)) {
    throw new VisionSchemaError('missing or non-array "rows" field');
  }

  const rows: ExtractedInventoryRow[] = [];
  let fallbackIndex = 0;
  for (const entry of obj.rows.slice(0, MAX_EXTRACTED_ROWS)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    fallbackIndex += 1;
    const declared = typeof e.row_index === 'number' && Number.isFinite(e.row_index)
      ? Math.max(1, Math.trunc(e.row_index))
      : fallbackIndex;
    rows.push({
      row_index: declared,
      item_name: asStringOrNull(e.item_name) ?? '',
      unit: asStringOrNull(e.unit),
      category: asStringOrNull(e.category),
      unit_cost: asScalarOrNull(e.unit_cost),
      quantity: asScalarOrNull(e.quantity),
      par_level: asScalarOrNull(e.par_level),
      vendor_name: asStringOrNull(e.vendor_name),
      as_of_date: asStringOrNull(e.as_of_date),
    });
  }

  const skipped: ExtractedInventorySheet['skipped'] = [];
  if (Array.isArray(obj.skipped)) {
    for (const entry of obj.skipped.slice(0, MAX_EXTRACTED_ROWS)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const e = entry as Record<string, unknown>;
      const idx = typeof e.row_index === 'number' && Number.isFinite(e.row_index)
        ? Math.max(0, Math.trunc(e.row_index))
        : 0;
      skipped.push({
        row_index: idx,
        reason: asStringOrNull(e.reason) ?? 'note_row',
        text: asStringOrNull(e.text),
      });
    }
  }

  return {
    as_of_date: asStringOrNull(obj.as_of_date),
    as_of_evidence: asStringOrNull(obj.as_of_evidence),
    rows,
    skipped,
  };
}

// ── Occupancy ──────────────────────────────────────────────────────────────

export interface ExtractedOccupancyRow {
  month: string;
  occupancy_pct: string | number | null;
  rooms_sold: string | number | null;
  rooms_available: string | number | null;
}

export interface ExtractedOccupancySheet {
  rows: ExtractedOccupancyRow[];
  layout: string | null;
  skipped: Array<{ row_index: number; reason: string; text: string | null }>;
}

export const OCCUPANCY_IMPORT_PROMPT = `You are reading a hotel's occupancy history so it can be loaded into their system. It may be a spreadsheet, a monthly report, a printed summary, or a photo of one.

Occupancy sheets come in two shapes and you must handle both:
  TALL   one row per month, with columns like Month, Occupancy %, Rooms Sold.
  WIDE   one column per month (Jan, Feb, Mar ... across the top) with metrics down the side, OR one row per month spread across a row. A year-by-month grid is the most common shape.
Return the same TALL result either way: one object per month.

For each month return:
- month (string "YYYY-MM"): the calendar month. If the sheet names a month without a year, take the year from the sheet's title, a nearby heading, or the surrounding months. If you cannot establish the year, leave that month out.
- occupancy_pct (string or null): the occupancy percentage exactly as printed. A value written as 0.82 means 82 percent; still copy it exactly as printed and do not convert it.
- rooms_sold (string or null): rooms sold / room nights / occupied room nights for the month, exactly as printed.
- rooms_available (string or null): rooms available for the month, if printed.

Also return:
- layout (string): "tall" or "wide", whichever this sheet was.
- skipped: rows or columns you did not turn into a month, with { row_index, reason, text }. Use "total_row" for year totals and averages, "header_row" for headings, "note_row" for anything else.

RULES
- Never invent a month or a number. A missing value is null.
- A year total, a year-to-date column, and an average column are NOT months. Skip them.
- Never compute occupancy from rooms sold, and never compute rooms sold from occupancy.

Return ONLY this JSON object, no prose and no code fences:
{"layout":"wide","rows":[{"month":"2026-03","occupancy_pct":"71.4%","rooms_sold":"1,240","rooms_available":"1,736"}],"skipped":[{"row_index":14,"reason":"total_row","text":"YTD"}]}

If the document is not an occupancy report, return {"layout":null,"rows":[],"skipped":[]}.`;

export function validateOccupancySheet(raw: unknown): ExtractedOccupancySheet {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new VisionSchemaError('expected an object at top level');
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.rows)) {
    throw new VisionSchemaError('missing or non-array "rows" field');
  }
  const rows: ExtractedOccupancyRow[] = [];
  for (const entry of obj.rows.slice(0, 600)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const month = asStringOrNull(e.month);
    if (!month) continue;
    rows.push({
      month,
      occupancy_pct: asScalarOrNull(e.occupancy_pct),
      rooms_sold: asScalarOrNull(e.rooms_sold),
      rooms_available: asScalarOrNull(e.rooms_available),
    });
  }
  const skipped: ExtractedOccupancySheet['skipped'] = [];
  if (Array.isArray(obj.skipped)) {
    for (const entry of obj.skipped.slice(0, 600)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const e = entry as Record<string, unknown>;
      skipped.push({
        row_index: typeof e.row_index === 'number' && Number.isFinite(e.row_index) ? Math.max(0, Math.trunc(e.row_index)) : 0,
        reason: asStringOrNull(e.reason) ?? 'note_row',
        text: asStringOrNull(e.text),
      });
    }
  }
  return { rows, layout: asStringOrNull(obj.layout), skipped };
}
