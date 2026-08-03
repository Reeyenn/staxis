// ═══════════════════════════════════════════════════════════════════════════
// The executor: run an import plan, and take one back out again.
//
// Service-role only. The three inventory_import_* tables are deny-all to the
// browser (migration 0452), so this module is the only thing that reads or
// writes them, and it is only ever reached through /api/inventory/import
// behind the same finance + capability + section gates the invoice scanner
// uses.
//
// NO TRANSACTION, AND WHY THAT IS SURVIVABLE
// PostgREST gives us no multi-statement transaction, which is why the delivery
// path grew RPCs. An import does not need one for the same reason: every write
// it makes is RECORDED as it is made, in inventory_import_rows, before the next
// one starts. A crash halfway leaves a batch that is half applied AND a row
// ledger that says exactly which half, so the undo button still removes
// precisely what landed. Partial is survivable; unrecorded is not. The order
// below is chosen so nothing is ever written that the ledger does not already
// know about.
// ═══════════════════════════════════════════════════════════════════════════

import 'server-only';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import type { ImportCommitPlan } from '@/lib/inventory-import/commit';
import type { NormalizedOccupancyMonth } from '@/lib/inventory-import/occupancy';
import {
  datesInMonth,
  planOccupancyDayWrites,
  type ExistingDay,
} from '@/lib/inventory-import/occupancy';
import type { ImportSourceKind } from '@/lib/inventory-import/source-text';
import {
  runImportUndo,
  type UndoDayRestore,
  type UndoImportOutcome,
  type UndoOps,
} from '@/lib/inventory-import/undo';

export interface ImportBatchRecord {
  id: string;
  propertyId: string;
  kind: 'inventory' | 'occupancy';
  sourceName: string;
  sourceKind: ImportSourceKind;
  asOfDate: string;
  asOfMode: 'current' | 'history_only';
  importedAt: string;
  importedByName: string | null;
  itemCount: number;
  skippedCount: number;
  skippedSummary: string | null;
  vendorNames: string[];
  fedTraining: boolean;
  undoneAt: string | null;
}

interface BatchRow {
  id: string;
  property_id: string;
  kind: string;
  source_name: string;
  source_kind: string;
  as_of_date: string;
  as_of_mode: string;
  imported_at: string;
  imported_by_name: string | null;
  item_count: number;
  skipped_count: number;
  skipped_summary: string | null;
  vendor_names: string[] | null;
  fed_training: boolean;
  undone_at: string | null;
}

function toBatchRecord(r: BatchRow): ImportBatchRecord {
  return {
    id: r.id,
    propertyId: r.property_id,
    kind: r.kind === 'occupancy' ? 'occupancy' : 'inventory',
    sourceName: r.source_name,
    sourceKind: r.source_kind as ImportSourceKind,
    asOfDate: r.as_of_date,
    asOfMode: r.as_of_mode === 'current' ? 'current' : 'history_only',
    importedAt: r.imported_at,
    importedByName: r.imported_by_name,
    itemCount: r.item_count,
    skippedCount: r.skipped_count,
    skippedSummary: r.skipped_summary,
    vendorNames: Array.isArray(r.vendor_names) ? r.vendor_names : [],
    fedTraining: Boolean(r.fed_training),
    undoneAt: r.undone_at,
  };
}

const BATCH_COLUMNS =
  'id,property_id,kind,source_name,source_kind,as_of_date,as_of_mode,imported_at,imported_by_name,item_count,skipped_count,skipped_summary,vendor_names,fed_training,undone_at';

export async function listImportBatches(pid: string, limit = 25): Promise<ImportBatchRecord[]> {
  const { data, error } = await supabaseAdmin
    .from('inventory_import_batches')
    .select(BATCH_COLUMNS)
    .eq('property_id', pid)
    .order('imported_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100));
  if (error) throw error;
  return (data ?? []).map((r) => toBatchRecord(r as unknown as BatchRow));
}

export async function getImportBatch(pid: string, batchId: string): Promise<ImportBatchRecord | null> {
  const { data, error } = await supabaseAdmin
    .from('inventory_import_batches')
    .select(BATCH_COLUMNS)
    .eq('property_id', pid)
    .eq('id', batchId)
    .maybeSingle();
  if (error) throw error;
  return data ? toBatchRecord(data as unknown as BatchRow) : null;
}

/** A prior batch with this request id, when the manager double-tapped Confirm. */
export async function findBatchByRequestId(pid: string, requestId: string): Promise<ImportBatchRecord | null> {
  const { data, error } = await supabaseAdmin
    .from('inventory_import_batches')
    .select(BATCH_COLUMNS)
    .eq('property_id', pid)
    .eq('request_id', requestId)
    .maybeSingle();
  if (error) throw error;
  return data ? toBatchRecord(data as unknown as BatchRow) : null;
}

// ─── Applying an inventory plan ────────────────────────────────────────────

export interface ApplyInventoryImportArgs {
  pid: string;
  plan: ImportCommitPlan;
  sourceName: string;
  sourceKind: ImportSourceKind;
  skippedSummary: string;
  requestId: string | null;
  accountId: string | null;
  actorName: string | null;
  /** False for demo hotels; nothing they import may shape a real model. */
  mayFeedTraining: boolean;
}

export interface ApplyInventoryImportResult {
  batchId: string;
  createdItems: number;
  mergedItems: number;
  historyRows: number;
  stockUpdated: number;
}

export async function applyInventoryImport(
  args: ApplyInventoryImportArgs,
): Promise<ApplyInventoryImportResult> {
  const { pid, plan } = args;

  const { data: batch, error: batchErr } = await supabaseAdmin
    .from('inventory_import_batches')
    .insert({
      property_id: pid,
      kind: 'inventory',
      source_name: args.sourceName.slice(0, 200),
      source_kind: args.sourceKind,
      as_of_date: plan.asOfDate,
      as_of_mode: plan.mode,
      request_id: args.requestId,
      imported_by: args.accountId,
      imported_by_name: args.actorName,
      item_count: plan.itemCount,
      skipped_count: plan.skippedCount,
      skipped_summary: args.skippedSummary || null,
      vendor_names: plan.vendorNames,
      // Dated history is what teaches, and only a real hotel's does.
      fed_training: args.mayFeedTraining && plan.counts.length > 0,
    })
    .select('id')
    .single();
  if (batchErr || !batch) throw batchErr ?? new Error('import batch insert failed');
  const batchId = (batch as { id: string }).id;

  // 1. Create the new items, at zero stock. Recorded row-by-row as we go.
  const createdIdByKey = new Map<string, string>();
  for (const create of plan.creates) {
    const { data, error } = await supabaseAdmin
      .from('inventory')
      .insert({
        property_id: pid,
        name: create.name,
        category: create.category,
        custom_category_id: create.customCategoryId,
        unit: create.unit,
        par_level: create.parLevel,
        current_stock: 0,
        set_aside: 0,
        unit_cost: create.unitCostDollars,
        created_by: args.accountId,
      })
      .select('id')
      .single();
    if (error) {
      // A name collision means the hotel already had this item under the same
      // spelling: the safe answer is to leave their row alone and record that
      // this line did nothing, not to overwrite an item we did not create.
      if ((error as { code?: string }).code === '23505') {
        await recordRow(pid, batchId, {
          row_index: rowIndexFor(plan, create.lineKey),
          raw_name: create.name,
          outcome: 'skipped',
          skip_reason: 'already_exists',
        });
        continue;
      }
      throw error;
    }
    const itemId = (data as { id: string }).id;
    createdIdByKey.set(create.lineKey, itemId);
    await recordRow(pid, batchId, {
      row_index: rowIndexFor(plan, create.lineKey),
      raw_name: create.name,
      outcome: 'created',
      item_id: itemId,
      created_item: true,
      unit: create.unit,
      unit_cost_cents: centsFor(plan, create.lineKey),
      as_of_date: plan.asOfDate,
    });
  }

  // 2. The dated history. This is the half that teaches the model.
  let historyRows = 0;
  for (const count of plan.counts) {
    const itemId = count.itemId ?? createdIdByKey.get(count.createKey ?? '') ?? null;
    if (!itemId) continue;
    const { data, error } = await supabaseAdmin
      .from('inventory_counts')
      .insert({
        property_id: pid,
        item_id: itemId,
        item_name: count.itemName,
        counted_stock: count.countedStock,
        unit_cost: count.unitCostDollars,
        counted_at: count.countedAt,
        counted_by: args.actorName,
        notes: importCountNote(args.sourceName),
        recorded_by_user_id: args.accountId,
        recorded_by_name: args.actorName,
      })
      .select('id')
      .single();
    if (error) throw error;
    const countId = (data as { id: string }).id;
    historyRows += 1;
    // ONE provenance row per count, always — including for items this batch
    // created. A monthly workbook writes twelve counts for one item, and an
    // undo that only remembered the last one would leave eleven months of
    // history behind while claiming the import was removed. `created_item` is
    // false here because the create already has its own row above; these rows
    // exist to name the counts.
    await recordRow(pid, batchId, {
      row_index: rowIndexFor(plan, count.lineKey),
      raw_name: count.itemName,
      outcome: plan.mode === 'current' ? 'merged' : 'history_only',
      item_id: itemId,
      created_item: false,
      count_id: countId,
      quantity: count.countedStock,
      unit: null,
      unit_cost_cents: centsFor(plan, count.lineKey),
      as_of_date: count.asOfDate,
    });
  }

  // 3. Current stock, only ever in `current` mode. The plan simply has no
  //    stock updates in it otherwise, so there is nothing to guard here.
  let stockUpdated = 0;
  for (const update of plan.stockUpdates) {
    const itemId = update.itemId ?? createdIdByKey.get(update.createKey ?? '') ?? null;
    if (!itemId) continue;
    const { error } = await supabaseAdmin
      .from('inventory')
      .update({
        current_stock: update.currentStock,
        last_counted_at: update.lastCountedAt,
        updated_at: new Date().toISOString(),
      })
      .eq('id', itemId)
      .eq('property_id', pid);
    if (error) throw error;
    stockUpdated += 1;
  }

  // 4. The rows nothing was written for, so the ledger accounts for the whole
  //    file rather than only its successes.
  const recordedKeys = new Set([
    ...plan.creates.map((c) => c.lineKey),
    ...plan.counts.map((c) => c.lineKey),
  ]);
  const leftovers = plan.rows.filter((r) => r.lineKey === null || !recordedKeys.has(r.lineKey));
  if (leftovers.length > 0) {
    const { error } = await supabaseAdmin.from('inventory_import_rows').insert(
      leftovers.map((r) => ({
        property_id: pid,
        batch_id: batchId,
        row_index: r.rowIndex,
        raw_name: r.rawName.slice(0, 300),
        outcome: r.outcome,
        skip_reason: r.skipReason,
        item_id: r.mergeItemId,
        quantity: r.quantity,
        unit: r.unit,
        unit_cost_cents: r.unitCostCents,
        vendor_name: r.vendorName,
        as_of_date: r.asOfDate,
      })),
    );
    if (error) throw error;
  }

  return {
    batchId,
    createdItems: createdIdByKey.size,
    mergedItems: plan.counts.filter((c) => c.itemId !== null).length,
    historyRows,
    stockUpdated,
  };
}

function importCountNote(sourceName: string): string {
  return `Imported from ${sourceName}`.slice(0, 200);
}

function rowIndexFor(plan: ImportCommitPlan, lineKey: string): number {
  return plan.rows.find((r) => r.lineKey === lineKey)?.rowIndex ?? 0;
}

function centsFor(plan: ImportCommitPlan, lineKey: string): number | null {
  return plan.rows.find((r) => r.lineKey === lineKey)?.unitCostCents ?? null;
}

async function recordRow(
  pid: string,
  batchId: string,
  row: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from('inventory_import_rows')
    .insert({ property_id: pid, batch_id: batchId, ...row });
  if (error) throw error;
}

// ─── Applying an occupancy plan ────────────────────────────────────────────

export interface ApplyOccupancyImportArgs {
  pid: string;
  months: readonly NormalizedOccupancyMonth[];
  sourceName: string;
  sourceKind: ImportSourceKind;
  skippedSummary: string;
  requestId: string | null;
  accountId: string | null;
  actorName: string | null;
  mayFeedTraining: boolean;
}

export interface ApplyOccupancyImportResult {
  batchId: string;
  monthsSaved: number;
  daysWritten: number;
  daysLeftAlone: number;
}

/**
 * Spread each month across its days in daily_logs, never over the top of a day
 * that already has a real answer.
 *
 * A day is left alone when it is sealed, when its occupancy bucket already
 * names a source, or when it already carries an `occupied` count. Those are the
 * three ways a day can already be true, and an imported monthly average is
 * never more true than any of them.
 */
export async function applyOccupancyImport(
  args: ApplyOccupancyImportArgs,
): Promise<ApplyOccupancyImportResult> {
  const { pid, months } = args;
  const monthStarts = months.map((m) => m.monthStart).sort();

  const { data: batch, error: batchErr } = await supabaseAdmin
    .from('inventory_import_batches')
    .insert({
      property_id: pid,
      kind: 'occupancy',
      source_name: args.sourceName.slice(0, 200),
      source_kind: args.sourceKind,
      // An occupancy import is history by definition; its as-of date is the
      // last month it covers and it can never touch anything current.
      as_of_date: monthStarts[monthStarts.length - 1] ?? new Date().toISOString().slice(0, 10),
      as_of_mode: 'history_only',
      request_id: args.requestId,
      imported_by: args.accountId,
      imported_by_name: args.actorName,
      item_count: months.length,
      skipped_count: 0,
      skipped_summary: args.skippedSummary || null,
      fed_training: args.mayFeedTraining && months.length > 0,
    })
    .select('id')
    .single();
  if (batchErr || !batch) throw batchErr ?? new Error('occupancy batch insert failed');
  const batchId = (batch as { id: string }).id;

  let daysWritten = 0;
  let daysLeftAlone = 0;

  for (const month of months) {
    const dates = datesInMonth(month.monthStart);
    const { data: existing, error: readErr } = await supabaseAdmin
      .from('daily_logs')
      .select('date,occupied,rooms_sold,rooms_available,occupancy_source,sealed_at')
      .eq('property_id', pid)
      .gte('date', dates[0])
      .lte('date', dates[dates.length - 1]);
    if (readErr) throw readErr;

    // Every rule about which days may be touched lives in the pure planner, so
    // "a sealed day is never overwritten" and "a demo hotel writes nothing"
    // are unit-tested rather than asserted in a comment here.
    const plan = planOccupancyDayWrites({
      month,
      existing: ((existing ?? []) as unknown as ExistingDay[]),
      mayFeedTraining: args.mayFeedTraining,
    });
    daysLeftAlone += plan.leaveAlone.length;

    const applied: Array<{ date: string; prior: Record<string, unknown> }> = [];
    for (const day of plan.write) {
      const { error } = await supabaseAdmin
        .from('daily_logs')
        .upsert({
          property_id: pid,
          date: day.date,
          occupied: day.occupied,
          rooms_sold: day.roomsSold,
          rooms_available: day.roomsAvailable,
          occupancy_source: day.occupancySource,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'property_id,date' });
      if (error) throw error;
      daysWritten += 1;
      applied.push({ date: day.date, prior: day.prior });
    }

    const { error: monthErr } = await supabaseAdmin
      .from('inventory_import_occupancy_months')
      .insert({
        property_id: pid,
        batch_id: batchId,
        month_start: month.monthStart,
        rooms_available: month.perDay.roomsAvailable,
        rooms_sold: month.roomsSoldMonth,
        occupancy_pct: month.occupancyPct,
        applied_days: applied,
        applied_day_count: applied.length,
      });
    if (monthErr) throw monthErr;
  }

  return { batchId, monthsSaved: months.length, daysWritten, daysLeftAlone };
}

// ─── Undo ──────────────────────────────────────────────────────────────────

export type UndoImportResult = UndoImportOutcome;

/**
 * The Supabase half of the undo. All order and all judgement live in
 * runImportUndo (src/lib/inventory-import/undo.ts); this only knows how to ask
 * Postgres. Keeping them apart is what lets a test watch the cascade run.
 *
 * The prediction_log delete is not optional and is not merely first by habit:
 * prediction_log.inventory_count_id references inventory_counts ON DELETE NO
 * ACTION (migration 0312), so a count a shadow prediction was paired against
 * CANNOT be deleted until the pairing is. Getting this wrong fails loudly.
 */
export function supabaseUndoOps(pid: string, batchId: string): UndoOps {
  return {
    async loadRows() {
      const { data, error } = await supabaseAdmin
        .from('inventory_import_rows')
        .select('item_id,created_item,count_id')
        .eq('property_id', pid)
        .eq('batch_id', batchId);
      if (error) throw error;
      return ((data ?? []) as Array<{ item_id: string | null; created_item: boolean; count_id: string | null }>)
        .map((r) => ({ itemId: r.item_id, createdItem: Boolean(r.created_item), countId: r.count_id }));
    },
    async deletePredictions(countIds) {
      const { data, error } = await supabaseAdmin
        .from('prediction_log')
        .delete()
        .eq('property_id', pid)
        .in('inventory_count_id', countIds as string[])
        .select('id');
      if (error) throw error;
      return (data ?? []).length;
    },
    async deleteCounts(countIds) {
      const { data, error } = await supabaseAdmin
        .from('inventory_counts')
        .delete()
        .eq('property_id', pid)
        .in('id', countIds as string[])
        .select('id');
      if (error) throw error;
      return (data ?? []).length;
    },
    async loadOccupancyDays() {
      const { data, error } = await supabaseAdmin
        .from('inventory_import_occupancy_months')
        .select('applied_days')
        .eq('property_id', pid)
        .eq('batch_id', batchId);
      if (error) throw error;
      const out: UndoDayRestore[] = [];
      for (const m of (data ?? []) as Array<{ applied_days: unknown }>) {
        const applied = Array.isArray(m.applied_days) ? m.applied_days : [];
        for (const entry of applied as Array<{ date?: string; prior?: Record<string, unknown> }>) {
          if (entry?.date) out.push({ date: entry.date, prior: entry.prior ?? {} });
        }
      }
      return out;
    },
    async restoreDay(day) {
      const { error } = await supabaseAdmin
        .from('daily_logs')
        .update({
          occupied: day.prior.occupied ?? null,
          rooms_sold: day.prior.rooms_sold ?? null,
          rooms_available: day.prior.rooms_available ?? null,
          occupancy_source: day.prior.occupancy_source ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq('property_id', pid)
        .eq('date', day.date);
      if (error) throw error;
    },
    async itemActivity(itemId) {
      const { data: item, error: itemErr } = await supabaseAdmin
        .from('inventory')
        .select('id,current_stock')
        .eq('id', itemId)
        .eq('property_id', pid)
        .maybeSingle();
      if (itemErr) throw itemErr;
      if (!item) return { exists: false, currentStock: 0, remainingCounts: 0, remainingOrders: 0 };
      const [countsRes, ordersRes] = await Promise.all([
        supabaseAdmin.from('inventory_counts').select('id', { count: 'exact', head: true })
          .eq('property_id', pid).eq('item_id', itemId),
        supabaseAdmin.from('inventory_orders').select('id', { count: 'exact', head: true })
          .eq('property_id', pid).eq('item_id', itemId),
      ]);
      return {
        exists: true,
        currentStock: Number((item as { current_stock: number | null }).current_stock ?? 0),
        remainingCounts: countsRes.count ?? 0,
        remainingOrders: ordersRes.count ?? 0,
      };
    },
    async deleteItem(itemId) {
      const { error } = await supabaseAdmin
        .from('inventory')
        .delete()
        .eq('id', itemId)
        .eq('property_id', pid);
      if (error) throw error;
    },
    async stampBatchUndone() {
      const { error } = await supabaseAdmin
        .from('inventory_import_batches')
        .update({ undone_at: new Date().toISOString(), fed_training: false })
        .eq('id', batchId)
        .eq('property_id', pid);
      if (error) throw error;
    },
  };
}

export async function undoImportBatch(pid: string, batchId: string): Promise<UndoImportResult> {
  const result = await runImportUndo(supabaseUndoOps(pid, batchId));
  log.info('[inventory-import] batch removed', { pid, batchId, ...result });
  return result;
}

// ─── Reads used by the companion ───────────────────────────────────────────

/**
 * First-of-month dates this hotel has imported dated inventory history for.
 *
 * Undone batches are excluded explicitly rather than relying on the row
 * pointers going null: an undone batch keeps its receipt, count_id and all, on
 * purpose. "What do I hold" is a question about live batches.
 */
export async function importedInventoryMonths(pid: string): Promise<string[]> {
  const { data: batches, error: batchErr } = await supabaseAdmin
    .from('inventory_import_batches')
    .select('id')
    .eq('property_id', pid)
    .eq('kind', 'inventory')
    .is('undone_at', null)
    .limit(500);
  if (batchErr) throw batchErr;
  const ids = (batches ?? []).map((b) => (b as { id: string }).id);
  if (ids.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from('inventory_import_rows')
    .select('as_of_date')
    .eq('property_id', pid)
    .in('batch_id', ids)
    .not('as_of_date', 'is', null)
    .not('count_id', 'is', null)
    .limit(5_000);
  if (error) throw error;
  const months = new Set<string>();
  for (const r of (data ?? []) as Array<{ as_of_date: string | null }>) {
    if (r.as_of_date) months.add(`${r.as_of_date.slice(0, 7)}-01`);
  }
  return [...months].sort();
}

/** First-of-month dates this hotel has any occupancy for, imported or sealed. */
export async function occupancyMonthsHeld(pid: string, sinceMonth: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from('daily_logs')
    .select('date')
    .eq('property_id', pid)
    .gte('date', sinceMonth)
    .not('occupied', 'is', null)
    .limit(5_000);
  if (error) throw error;
  const months = new Set<string>();
  for (const r of (data ?? []) as Array<{ date: string }>) {
    if (r.date) months.add(`${r.date.slice(0, 7)}-01`);
  }
  return [...months].sort();
}
