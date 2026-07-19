import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from '@/lib/supabase-paginate';
import { validPropertyTimezone } from '@/lib/property-timezone';
import { summarizeEffectivePurchasesForProperty } from './inventory-effective-purchases';
import {
  inventoryCloseWindow,
  inventoryOpeningPosition,
  type InventoryCloseCategory,
  type InventoryCloseIssue,
  type InventoryMonthCloseDashboard,
  type InventoryMonthCloseHistoryRow,
  type InventoryMonthCloseItem,
  type InventoryPurchaseSource,
} from '@/lib/inventory-month-close';

type JsonRecord = Record<string, unknown>;

interface CloseRow {
  id: string;
  property_id: string;
  month_start: string;
  timezone: string;
  status: 'open' | 'closed';
  month_start_at: string;
  end_at: string;
  grace_end_at: string;
  count_window_start_at: string;
  activity_start_at: string;
  is_partial: boolean;
  budget_comparison_available: boolean;
  opening_snapshot_id: string;
  ending_snapshot_id: string | null;
  purchase_source: InventoryPurchaseSource | null;
  allocation_mode: 'itemized' | 'total_only' | null;
  manual_purchase_cents: number | string | null;
  known_logged_purchase_cents: number | string | null;
  logged_purchase_cents: number | string | null;
  confirmed_purchase_cents: number | string | null;
  logged_delivery_count: number | null;
  uncosted_delivery_count: number | null;
  beginning_value_cents: number | string | null;
  opening_adjustment_cents: number | string | null;
  ending_value_cents: number | string | null;
  actual_usage_cents: number | string | null;
  by_category: unknown;
  by_item: unknown;
  by_budget_key: unknown;
  usage_budget_mode: 'total' | 'sections' | null;
  usage_budget_total_cents: number | string | null;
  usage_budget_by_key: unknown;
  quality_flags: unknown;
  baseline_at: string;
  closed_at: string | null;
  closed_by_name: string | null;
  notes: string | null;
}

interface SnapshotItemRow {
  snapshot_id: string;
  item_id: string;
  item_name: string;
  category: InventoryCloseCategory;
  custom_category_id: string | null;
  custom_category_name: string | null;
  budget_key: string;
  budget_section_ids: string[] | null;
  multiple_budget_sections: boolean;
  archived_at: string | null;
  opening_adjustment_quantity: number | string | null;
  opening_adjustment_unit_cost_cents: number | string | null;
  opening_adjustment_value_cents: number | string | null;
  opening_adjustment_at: string | null;
  quantity: number | string;
  set_aside: number | string;
  unit_cost_cents: number | string | null;
  physical_unit_cost_cents: number | string | null;
  value_cents: number | string | null;
  inventory_count_id: string | null;
  counted_at: string | null;
  purchase_quantity: number | string | null;
  purchase_value_cents: number | string | null;
  actual_usage_cents: number | string | null;
}

interface LiveItemRow {
  id: string;
  name: string;
  category: InventoryCloseCategory;
  custom_category_id: string | null;
  current_stock: number | string | null;
  set_aside: number | string | null;
  unit_cost: number | string | null;
  created_at: string | null;
  archived_at: string | null;
  opening_adjustment_quantity: number | string | null;
  opening_adjustment_unit_cost: number | string | null;
  opening_adjustment_at: string | null;
  opening_adjustment_request_id: string | null;
}

interface CountRow {
  id: string;
  item_id: string;
  activity_sequence: number | string;
  count_session_id: string | null;
  counted_stock: number | string;
  unit_cost: number | string | null;
  counted_at: string;
}

interface OrderRow {
  id: string;
  item_id: string;
  activity_sequence: number | string;
  quantity: number | string;
  unit_cost: number | string | null;
  total_cost: number | string | null;
  entry_kind?: 'receipt' | 'correction' | string | null;
  corrects_order_id?: string | null;
  correction_event_id?: string | null;
  received_at: string;
}

interface DiscardRow {
  id: string;
  item_id: string;
  activity_sequence: number | string;
  discarded_at: string;
}

interface CorrectionStockEffectRow {
  id: string;
  stock_effect: unknown;
}

interface ArchiveReadinessRow {
  itemId: string;
  valid: boolean;
  evidenceKind: string;
}

interface OpeningAdjustmentRow {
  item_id: string;
  quantity: number | string;
  value_cents: number | string;
  effective_at: string;
}

interface BudgetSectionRow {
  id: string;
  name: string;
  item_ids: string[] | null;
  sort: number | null;
}

interface CustomCategoryRow { id: string; name: string }

const CLOSE_COLUMNS = [
  'id', 'property_id', 'month_start', 'timezone', 'status',
  'month_start_at', 'end_at', 'grace_end_at', 'count_window_start_at',
  'activity_start_at', 'is_partial', 'budget_comparison_available',
  'opening_snapshot_id', 'ending_snapshot_id', 'purchase_source',
  'allocation_mode', 'manual_purchase_cents', 'known_logged_purchase_cents',
  'logged_purchase_cents', 'confirmed_purchase_cents',
  'logged_delivery_count', 'uncosted_delivery_count',
  'beginning_value_cents', 'opening_adjustment_cents', 'ending_value_cents', 'actual_usage_cents',
  'by_category', 'by_item', 'by_budget_key',
  'usage_budget_mode', 'usage_budget_total_cents', 'usage_budget_by_key',
  'quality_flags',
  'baseline_at', 'closed_at', 'closed_by_name', 'notes',
].join(',');

const SNAPSHOT_COLUMNS = [
  'snapshot_id', 'item_id', 'item_name', 'category', 'custom_category_id',
  'custom_category_name', 'budget_key', 'budget_section_ids',
  'multiple_budget_sections', 'archived_at', 'quantity', 'set_aside',
  'unit_cost_cents', 'physical_unit_cost_cents', 'value_cents',
  'inventory_count_id', 'counted_at', 'purchase_quantity',
  'purchase_value_cents', 'actual_usage_cents', 'opening_adjustment_quantity',
  'opening_adjustment_unit_cost_cents', 'opening_adjustment_value_cents',
  'opening_adjustment_at',
].join(',');

function finite(value: unknown): number | null {
  if (value == null || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function cents(value: unknown): number | null {
  const number = finite(value);
  return number == null ? null : Math.round(number);
}

function numeric(value: unknown, fallback = 0): number {
  return finite(value) ?? fallback;
}

function moneyMap(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as JsonRecord)) {
    const amount = cents(raw);
    if (amount != null) result[key] = amount;
  }
  return result;
}

function categoryMap(value: unknown): Record<InventoryCloseCategory, number> | null {
  const map = moneyMap(value);
  if (map == null) return null;
  return {
    housekeeping: map.housekeeping ?? 0,
    maintenance: map.maintenance ?? 0,
    breakfast: map.breakfast ?? 0,
  };
}

function issues(value: unknown): InventoryCloseIssue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const row = entry as JsonRecord;
    if (typeof row.code !== 'string' || typeof row.message !== 'string') return [];
    return [{
      code: row.code,
      message: row.message,
      ...(typeof row.itemId === 'string' ? { itemId: row.itemId } : {}),
      ...(typeof row.itemName === 'string' ? { itemName: row.itemName } : {}),
      ...(finite(row.count) != null ? { count: finite(row.count)! } : {}),
    }];
  });
}

function monthKey(monthStart: string): string {
  return monthStart.slice(0, 7);
}

function propertyCurrentMonth(timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  if (!year || !month) throw new Error('Could not resolve the property-local month.');
  return `${year}-${month}`;
}

function previousMonth(month: string): string {
  const [year, month1] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, month1 - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function historyRow(row: CloseRow): InventoryMonthCloseHistoryRow {
  return {
    closeId: row.id,
    endingSnapshotId: row.ending_snapshot_id,
    month: monthKey(row.month_start),
    status: row.status,
    isPartial: row.is_partial,
    budgetComparisonAvailable: row.budget_comparison_available,
    purchaseSource: row.purchase_source,
    allocationMode: row.allocation_mode,
    beginningCents: cents(row.beginning_value_cents),
    openingAdjustmentCents: cents(row.opening_adjustment_cents) ?? 0,
    purchasesCents: cents(row.confirmed_purchase_cents),
    loggedPurchaseCents: cents(row.logged_purchase_cents),
    knownLoggedPurchaseCents: cents(row.known_logged_purchase_cents) ?? 0,
    endingCents: cents(row.ending_value_cents),
    actualUsageCents: cents(row.actual_usage_cents),
    byCategory: categoryMap(row.by_category),
    byItem: moneyMap(row.by_item),
    byBudgetKey: moneyMap(row.by_budget_key),
    usageBudgetMode: row.usage_budget_mode,
    usageBudgetTotalCents: cents(row.usage_budget_total_cents),
    usageBudgetByKey: moneyMap(row.usage_budget_by_key),
    complete: row.status === 'closed',
    closedAt: row.closed_at,
  };
}

/** Finance-gated callers use this for budgets, reports, and comparisons. */
export async function listInventoryMonthCloseHistory(
  client: SupabaseClient,
  propertyId: string,
  limit = 12,
): Promise<InventoryMonthCloseHistoryRow[]> {
  const boundedLimit = Math.max(1, Math.min(240, Math.trunc(limit)));
  const { data, error } = await client
    .from('inventory_month_closes')
    .select(CLOSE_COLUMNS)
    .eq('property_id', propertyId)
    .order('month_start', { ascending: false })
    .limit(boundedLimit);
  if (error) throw error;
  const rows = (data ?? []) as unknown as CloseRow[];
  const openRows = rows.filter((row) => row.status === 'open');
  if (openRows.length > 0) {
    const start = openRows.reduce(
      (earliest, row) => row.activity_start_at < earliest ? row.activity_start_at : earliest,
      openRows[0].activity_start_at,
    );
    const end = openRows.reduce(
      (latest, row) => row.end_at > latest ? row.end_at : latest,
      openRows[0].end_at,
    );
    const orders = await fetchAllRows<OrderRow>((from, to) => client
      .from('inventory_orders')
      .select('id,item_id,activity_sequence,quantity,unit_cost,total_cost,entry_kind,corrects_order_id,correction_event_id,received_at')
      .eq('property_id', propertyId)
      .gte('received_at', start)
      .lt('received_at', end)
      .order('received_at', { ascending: true })
      .range(from, to));
    for (const row of openRows) {
      const periodOrders = orders.filter(
        (order) => order.received_at >= row.activity_start_at && order.received_at < row.end_at,
      );
      const purchases = await summarizeEffectivePurchasesForProperty(client, propertyId, periodOrders);
      row.known_logged_purchase_cents = purchases.knownLoggedPurchaseCents;
      row.logged_purchase_cents = purchases.loggedPurchaseCents;
      row.logged_delivery_count = purchases.loggedDeliveryCount;
      row.uncosted_delivery_count = purchases.uncostedDeliveryCount;
    }
  }
  return rows.map(historyRow);
}

export async function startInventoryMonthClose(
  client: SupabaseClient,
  args: { propertyId: string; month: string; requestId: string; actorId: string; actorName: string | null },
): Promise<string> {
  const { data, error } = await client.rpc('staxis_start_inventory_month_close', {
    p_property_id: args.propertyId,
    p_month_start: `${args.month}-01`,
    p_request_id: args.requestId,
    p_actor_id: args.actorId,
    p_actor_name: args.actorName,
  });
  if (error) throw error;
  if (typeof data !== 'string') throw new Error('Month-close start returned no close id.');
  return data;
}

export async function closeInventoryMonthClose(
  client: SupabaseClient,
  args: {
    propertyId: string;
    month: string;
    requestId: string;
    purchaseSource: InventoryPurchaseSource;
    manualPurchaseCents: number | null;
    actorId: string;
    actorName: string | null;
    notes: string | null;
  },
): Promise<string> {
  const { data, error } = await client.rpc('staxis_close_inventory_month_close', {
    p_property_id: args.propertyId,
    p_month_start: `${args.month}-01`,
    p_request_id: args.requestId,
    p_purchase_source: args.purchaseSource,
    p_manual_purchase_cents: args.manualPurchaseCents,
    p_actor_id: args.actorId,
    p_actor_name: args.actorName,
    p_notes: args.notes,
  });
  if (error) throw error;
  if (typeof data !== 'string') throw new Error('Month close returned no close id.');
  return data;
}

/** Service-role-only audited classification of stock that existed before the
 * opening baseline but was discovered later. The RPC may also atomically move
 * the live count to `resultingStock`; it never writes a purchase row. */
export async function recordInventoryOpeningAdjustment(
  client: SupabaseClient,
  args: {
    propertyId: string;
    itemId: string;
    requestId: string;
    effectiveAt: string;
    expectedStock: number;
    resultingStock: number;
    adjustmentQuantity: number;
    unitCost: number;
    actorId: string;
    actorName: string | null;
  },
): Promise<unknown> {
  const { data, error } = await client.rpc('staxis_record_inventory_opening_adjustment', {
    p_property_id: args.propertyId,
    p_item_id: args.itemId,
    p_request_id: args.requestId,
    p_effective_at: args.effectiveAt,
    p_expected_stock: args.expectedStock,
    p_resulting_stock: args.resultingStock,
    p_adjustment_quantity: args.adjustmentQuantity,
    p_unit_cost: args.unitCost,
    p_actor_id: args.actorId,
    p_actor_name: args.actorName,
  });
  if (error) throw error;
  return data;
}

interface CountSessionSelection {
  id: string;
  countedAt: string;
  rows: Map<string, CountRow>;
}

function selectCompleteSession(
  rows: CountRow[],
  itemIds: readonly string[],
  valid?: (rows: Map<string, CountRow>) => boolean,
): CountSessionSelection | null {
  if (itemIds.length === 0) return { id: '', countedAt: '', rows: new Map() };
  const required = new Set(itemIds);
  const sessions = new Map<string, Map<string, CountRow>>();
  for (const row of rows) {
    if (!row.count_session_id || !required.has(row.item_id)) continue;
    const byItem = sessions.get(row.count_session_id) ?? new Map<string, CountRow>();
    const current = byItem.get(row.item_id);
    if (!current || row.counted_at > current.counted_at) byItem.set(row.item_id, row);
    sessions.set(row.count_session_id, byItem);
  }
  return [...sessions.entries()]
    .flatMap(([id, byItem]) => {
      if (byItem.size !== required.size || [...required].some((itemId) => !byItem.has(itemId))) return [];
      if (valid && !valid(byItem)) return [];
      return [{
        id,
        countedAt: [...byItem.values()].reduce(
          (latest, row) => row.counted_at > latest ? row.counted_at : latest,
          '',
        ),
        rows: byItem,
      }];
    })
    .sort((a, b) => b.countedAt.localeCompare(a.countedAt) || b.id.localeCompare(a.id))[0] ?? null;
}

function latestCounts(rows: CountRow[]): Map<string, CountRow> {
  const result = new Map<string, CountRow>();
  for (const row of rows) {
    const current = result.get(row.item_id);
    if (!current || row.counted_at > current.counted_at) result.set(row.item_id, row);
  }
  return result;
}

function liveBudgetDimension(
  item: LiveItemRow,
  sections: BudgetSectionRow[],
  categories: Map<string, string>,
): {
  customCategoryName: string | null;
  budgetKey: string;
  sectionIds: string[];
  multiplyMapped: boolean;
} {
  const matches = sections
    .filter((section) => (section.item_ids ?? []).includes(item.id))
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.id.localeCompare(b.id));
  return {
    customCategoryName: item.custom_category_id ? categories.get(item.custom_category_id) ?? null : null,
    budgetKey: matches[0] ? `section:${matches[0].id}` : item.category,
    sectionIds: matches.map((section) => section.id),
    multiplyMapped: matches.length > 1,
  };
}

async function loadLiveItems(client: SupabaseClient, propertyId: string): Promise<LiveItemRow[]> {
  return fetchAllRows<LiveItemRow>((from, to) => client
    .from('inventory')
    .select('id,name,category,custom_category_id,current_stock,set_aside,unit_cost,created_at,archived_at,opening_adjustment_quantity,opening_adjustment_unit_cost,opening_adjustment_at,opening_adjustment_request_id')
    .eq('property_id', propertyId)
    .order('id', { ascending: true })
    .range(from, to));
}

async function loadCounts(
  client: SupabaseClient,
  propertyId: string,
  start: string,
  end: string,
): Promise<CountRow[]> {
  return fetchAllRows<CountRow>((from, to) => client
    .from('inventory_counts')
    .select('id,item_id,activity_sequence,count_session_id,counted_stock,unit_cost,counted_at')
    .eq('property_id', propertyId)
    .gte('counted_at', start)
    .lt('counted_at', end)
    .order('counted_at', { ascending: true })
    .range(from, to));
}

async function loadOrders(
  client: SupabaseClient,
  propertyId: string,
  start: string,
  end: string,
): Promise<OrderRow[]> {
  return fetchAllRows<OrderRow>((from, to) => client
    .from('inventory_orders')
    .select('id,item_id,activity_sequence,quantity,unit_cost,total_cost,entry_kind,corrects_order_id,correction_event_id,received_at')
    .eq('property_id', propertyId)
    .gte('received_at', start)
    .lt('received_at', end)
    .order('received_at', { ascending: true })
    .range(from, to));
}

async function loadDiscards(
  client: SupabaseClient,
  propertyId: string,
  start: string,
  end: string,
): Promise<DiscardRow[]> {
  return fetchAllRows<DiscardRow>((from, to) => client
    .from('inventory_discards')
    .select('id,item_id,activity_sequence,discarded_at')
    .eq('property_id', propertyId)
    .gte('discarded_at', start)
    .lt('discarded_at', end)
    .order('discarded_at', { ascending: true })
    .range(from, to));
}

function activitySequence(value: number | string | null | undefined): number {
  const parsed = finite(value);
  return parsed == null ? -1 : parsed;
}

export function inventoryMovementConflictsWithCount(args: {
  countedAt: string;
  countActivitySequence: number;
  activityStartAt: string;
  endAt: string;
  orders: Array<{ occurredAt: string; activitySequence: number; changedLiveStock: boolean }>;
  discards: Array<{ occurredAt: string; activitySequence: number }>;
  laterCounts: Array<{ countedAt: string; activitySequence: number }>;
}): boolean {
  const inMonthCount = args.countedAt < args.endAt;
  if (inMonthCount) {
    return args.orders.some((order) => order.changedLiveStock && (
      (order.occurredAt >= args.activityStartAt
        && order.occurredAt < args.endAt
        && order.occurredAt >= args.countedAt)
      || (order.activitySequence > args.countActivitySequence && order.occurredAt < args.endAt)
    )) || args.discards.some((discard) => (
      (discard.occurredAt >= args.activityStartAt
        && discard.occurredAt < args.endAt
        && discard.occurredAt >= args.countedAt)
      || (discard.activitySequence > args.countActivitySequence && discard.occurredAt < args.endAt)
    )) || args.laterCounts.some((count) => count.activitySequence > args.countActivitySequence
      && count.countedAt < args.endAt);
  }
  return args.orders.some((order) => order.changedLiveStock && (
    (order.occurredAt >= args.endAt && order.occurredAt < args.countedAt)
    || (order.activitySequence > args.countActivitySequence && order.occurredAt <= args.countedAt)
  )) || args.discards.some((discard) => (
    (discard.occurredAt >= args.endAt && discard.occurredAt < args.countedAt)
    || (discard.activitySequence > args.countActivitySequence && discard.occurredAt <= args.countedAt)
  )) || args.laterCounts.some((count) => count.activitySequence > args.countActivitySequence
    && count.countedAt <= args.countedAt);
}

export function inventoryBaselineConflictsWithCount(args: {
  countedAt: string;
  countActivitySequence: number;
  orders: Array<{ occurredAt: string; activitySequence: number; changedLiveStock: boolean }>;
  discards: Array<{ occurredAt: string; activitySequence: number }>;
  laterCounts: Array<{ activitySequence: number }>;
}): boolean {
  return args.orders.some((order) => order.changedLiveStock && (
    order.occurredAt >= args.countedAt
    || order.activitySequence > args.countActivitySequence
  )) || args.discards.some((discard) => (
    discard.occurredAt >= args.countedAt
    || discard.activitySequence > args.countActivitySequence
  )) || args.laterCounts.some(
    (count) => count.activitySequence > args.countActivitySequence,
  );
}

async function loadActivityAfterSequence(
  client: SupabaseClient,
  propertyId: string,
  afterSequence: number,
): Promise<{ counts: CountRow[]; orders: OrderRow[]; discards: DiscardRow[] }> {
  const [counts, orders, discards] = await Promise.all([
    fetchAllRows<CountRow>((from, to) => client
      .from('inventory_counts')
      .select('id,item_id,activity_sequence,count_session_id,counted_stock,unit_cost,counted_at')
      .eq('property_id', propertyId)
      .gt('activity_sequence', afterSequence)
      .order('activity_sequence', { ascending: true })
      .range(from, to)),
    fetchAllRows<OrderRow>((from, to) => client
      .from('inventory_orders')
      .select('id,item_id,activity_sequence,quantity,unit_cost,total_cost,entry_kind,corrects_order_id,correction_event_id,received_at')
      .eq('property_id', propertyId)
      .gt('activity_sequence', afterSequence)
      .order('activity_sequence', { ascending: true })
      .range(from, to)),
    fetchAllRows<DiscardRow>((from, to) => client
      .from('inventory_discards')
      .select('id,item_id,activity_sequence,discarded_at')
      .eq('property_id', propertyId)
      .gt('activity_sequence', afterSequence)
      .order('activity_sequence', { ascending: true })
      .range(from, to)),
  ]);
  return { counts, orders, discards };
}

function mergeRowsById<T extends { id: string }>(first: T[], second: T[]): T[] {
  return [...new Map([...first, ...second].map((row) => [row.id, row])).values()];
}

async function loadCorrectionStockEffects(
  client: SupabaseClient,
  correctionIds: readonly string[],
): Promise<Map<string, unknown>> {
  const uniqueIds = [...new Set(correctionIds.filter(Boolean))];
  const result = new Map<string, unknown>();
  for (let index = 0; index < uniqueIds.length; index += 400) {
    const { data, error } = await client
      .from('inventory_delivery_corrections')
      .select('id,stock_effect')
      .in('id', uniqueIds.slice(index, index + 400));
    if (error) throw error;
    for (const row of (data ?? []) as unknown as CorrectionStockEffectRow[]) {
      result.set(row.id, row.stock_effect);
    }
  }
  return result;
}

export function inventoryCorrectionEffectAppliedToItem(value: unknown, itemId: string): boolean | null {
  if (!Array.isArray(value)) return null;
  if (value.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) return null;
  const entries = value.map((entry) => entry as JsonRecord);
  if (entries.some((entry) => typeof entry.itemId !== 'string' || typeof entry.applied !== 'boolean')) {
    return null;
  }
  const matches = entries.filter((entry) => entry.itemId === itemId);
  // A valid empty/no-match effect array is how the audited correction records
  // a cost-only paperwork repair. Only absent or malformed evidence fails
  // closed; a valid array with no effect for this item did not move its stock.
  if (matches.length === 0) return false;
  return matches.some((entry) => entry.applied === true);
}

function orderChangedLiveStock(
  order: OrderRow,
  effects: Map<string, unknown>,
): boolean {
  if (order.entry_kind !== 'correction') return true;
  if (!order.correction_event_id) return true;
  // Missing/malformed audit evidence fails closed in the preview.
  return inventoryCorrectionEffectAppliedToItem(
    effects.get(order.correction_event_id),
    order.item_id,
  ) ?? true;
}

async function loadArchiveReadiness(
  client: SupabaseClient,
  propertyId: string,
  itemIds: readonly string[],
): Promise<Map<string, ArchiveReadinessRow>> {
  const uniqueIds = [...new Set(itemIds)];
  const result = new Map<string, ArchiveReadinessRow>();
  for (let index = 0; index < uniqueIds.length; index += 400) {
    const { data, error } = await client.rpc('staxis_list_inventory_archive_readiness', {
      p_property_id: propertyId,
      p_item_ids: uniqueIds.slice(index, index + 400),
    });
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('Inventory archive readiness returned an invalid result.');
    for (const value of data) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const row = value as JsonRecord;
      if (typeof row.itemId !== 'string') continue;
      result.set(row.itemId, {
        itemId: row.itemId,
        valid: row.valid === true,
        evidenceKind: typeof row.evidenceKind === 'string' ? row.evidenceKind : 'invalid',
      });
    }
  }
  return result;
}

async function loadOpeningAdjustments(
  client: SupabaseClient,
  propertyId: string,
  start: string,
  end: string,
): Promise<OpeningAdjustmentRow[]> {
  return fetchAllRows<OpeningAdjustmentRow>((from, to) => client
    .from('inventory_opening_adjustments')
    .select('item_id,quantity,value_cents,effective_at')
    .eq('property_id', propertyId)
    .gte('effective_at', start)
    .lt('effective_at', end)
    .order('effective_at', { ascending: true })
    .range(from, to));
}

async function loadDimensions(
  client: SupabaseClient,
  propertyId: string,
): Promise<{ sections: BudgetSectionRow[]; categories: Map<string, string> }> {
  const [sections, customCategories] = await Promise.all([
    fetchAllRows<BudgetSectionRow>((from, to) => client
      .from('inventory_budget_sections')
      .select('id,name,item_ids,sort')
      .eq('property_id', propertyId)
      .order('sort', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)),
    fetchAllRows<CustomCategoryRow>((from, to) => client
      .from('inventory_custom_categories')
      .select('id,name')
      .eq('property_id', propertyId)
      .order('id', { ascending: true })
      .range(from, to)),
  ]);
  return {
    sections,
    categories: new Map(customCategories.map((category) => [category.id, category.name])),
  };
}

async function loadSnapshotItems(
  client: SupabaseClient,
  snapshotIds: string[],
): Promise<SnapshotItemRow[]> {
  if (snapshotIds.length === 0) return [];
  const { data, error } = await client
    .from('inventory_month_close_snapshot_items')
    .select(SNAPSHOT_COLUMNS)
    .in('snapshot_id', snapshotIds);
  if (error) throw error;
  return (data ?? []) as unknown as SnapshotItemRow[];
}

function closedDashboardItems(openingRows: SnapshotItemRow[], endingRows: SnapshotItemRow[]): InventoryMonthCloseItem[] {
  const opening = new Map(openingRows.map((row) => [row.item_id, row]));
  const ending = new Map(endingRows.map((row) => [row.item_id, row]));
  const ids = new Set([...opening.keys(), ...ending.keys()]);
  return [...ids].map((itemId) => {
    const first = opening.get(itemId);
    const last = ending.get(itemId);
    const dimension = last ?? first;
    if (!dimension) throw new Error('Month-close snapshot item is missing.');
    return {
      itemId,
      itemName: dimension.item_name,
      category: dimension.category,
      customCategoryId: dimension.custom_category_id,
      customCategoryName: dimension.custom_category_name,
      budgetKey: dimension.budget_key,
      sectionIds: dimension.budget_section_ids ?? [],
      archivedAt: dimension.archived_at,
      beginningQuantity: numeric(first?.quantity),
      beginningSetAside: numeric(first?.set_aside),
      beginningUnitCostCents: finite(first?.unit_cost_cents),
      beginningValueCents: first ? cents(first.value_cents) : 0,
      openingAdjustmentQuantity: numeric(last?.opening_adjustment_quantity),
      openingAdjustmentUnitCostCents: finite(last?.opening_adjustment_unit_cost_cents),
      openingAdjustmentValueCents: cents(last?.opening_adjustment_value_cents) ?? 0,
      openingAdjustmentAt: last?.opening_adjustment_at ?? null,
      endingQuantity: last ? numeric(last.quantity) : null,
      endingSetAside: last ? numeric(last.set_aside) : null,
      endingUnitCostCents: finite(last?.unit_cost_cents),
      physicalUnitCostCents: finite(last?.physical_unit_cost_cents),
      endingValueCents: cents(last?.value_cents),
      purchasesCents: cents(last?.purchase_value_cents),
      purchaseQuantity: finite(last?.purchase_quantity),
      actualUsageCents: cents(last?.actual_usage_cents),
      endingCountedAt: last?.counted_at ?? null,
    };
  }).sort((a, b) => a.itemName.localeCompare(b.itemName) || a.itemId.localeCompare(b.itemId));
}

async function buildClosedDashboard(
  client: SupabaseClient,
  row: CloseRow,
  history: InventoryMonthCloseHistoryRow[],
): Promise<InventoryMonthCloseDashboard> {
  const snapshotRows = await loadSnapshotItems(
    client,
    [row.opening_snapshot_id, row.ending_snapshot_id].filter((id): id is string => Boolean(id)),
  );
  const opening = snapshotRows.filter((item) => item.snapshot_id === row.opening_snapshot_id);
  const ending = snapshotRows.filter((item) => item.snapshot_id === row.ending_snapshot_id);
  const warnings = issues(row.quality_flags);
  return {
    propertyId: row.property_id,
    month: monthKey(row.month_start),
    timezone: row.timezone,
    status: 'closed',
    closeId: row.id,
    canStart: false,
    canClose: false,
    closeAvailableOn: inventoryCloseWindow(monthKey(row.month_start), row.timezone).closeAvailableOn,
    window: {
      monthStart: row.month_start_at,
      endExclusive: row.end_at,
      graceEndExclusive: row.grace_end_at,
      activityStartAt: row.activity_start_at,
    },
    isPartial: row.is_partial,
    budgetComparisonAvailable: row.budget_comparison_available,
    baselineAt: row.baseline_at,
    closedAt: row.closed_at,
    closedByName: row.closed_by_name,
    notes: row.notes,
    totals: {
      beginningCents: cents(row.beginning_value_cents),
      openingAdjustmentCents: cents(row.opening_adjustment_cents) ?? 0,
      purchasesCents: cents(row.confirmed_purchase_cents),
      endingCents: cents(row.ending_value_cents),
      actualUsageCents: cents(row.actual_usage_cents),
    },
    purchase: {
      source: row.purchase_source,
      allocationMode: row.allocation_mode,
      loggedDeliveryCount: row.logged_delivery_count ?? 0,
      loggedPurchaseCents: cents(row.logged_purchase_cents),
      knownLoggedPurchaseCents: cents(row.known_logged_purchase_cents) ?? 0,
      uncostedDeliveryCount: row.uncosted_delivery_count ?? 0,
      manualPurchaseCents: cents(row.manual_purchase_cents),
      confirmedPurchaseCents: cents(row.confirmed_purchase_cents),
    },
    completeness: { complete: true, readyToClose: false, blockers: [], warnings },
    items: closedDashboardItems(opening, ending),
    byCategory: categoryMap(row.by_category),
    byItem: moneyMap(row.by_item),
    byBudgetKey: moneyMap(row.by_budget_key),
    usageBudgetMode: row.usage_budget_mode,
    usageBudgetTotalCents: cents(row.usage_budget_total_cents),
    usageBudgetByKey: moneyMap(row.usage_budget_by_key),
    history,
  };
}

function issue(code: string, message: string, extra: Partial<InventoryCloseIssue> = {}): InventoryCloseIssue {
  return { code, message, ...extra };
}

async function buildNotStartedDashboard(
  client: SupabaseClient,
  propertyId: string,
  month: string,
  timezone: string,
  history: InventoryMonthCloseHistoryRow[],
  expiredPrior?: { month: string; graceEndAt: string },
): Promise<InventoryMonthCloseDashboard> {
  const window = inventoryCloseWindow(month, timezone);
  const [allItems, counts, orders, discards, dimensions] = await Promise.all([
    loadLiveItems(client, propertyId),
    loadCounts(client, propertyId, window.monthStart.toISOString(), window.endExclusive.toISOString()),
    loadOrders(client, propertyId, window.monthStart.toISOString(), window.endExclusive.toISOString()),
    loadDiscards(client, propertyId, window.monthStart.toISOString(), window.endExclusive.toISOString()),
    loadDimensions(client, propertyId),
  ]);
  const liveItems = allItems.filter((item) => item.archived_at == null);
  const session = selectCompleteSession(counts, liveItems.map((item) => item.id), (sessionRows) =>
    liveItems.every((item) => numeric(sessionRows.get(item.id)?.counted_stock, Number.NaN) === numeric(item.current_stock, Number.NaN))
  );
  const displayCounts = session?.rows ?? latestCounts(counts);
  const blockers: InventoryCloseIssue[] = [];
  if (liveItems.length === 0) {
    blockers.push(issue('inventory_items_required', 'Add at least one inventory item before starting monthly tracking.'));
  }
  if (liveItems.length > 0 && !session) {
    blockers.push(issue(
      'complete_count_session_required',
      'Run one complete physical count covering every active inventory item.',
      { count: liveItems.length },
    ));
  }
  const missingCost = liveItems.filter((item) => finite(item.unit_cost) == null);
  if (missingCost.length > 0) {
    blockers.push(issue('baseline_cost_missing', 'Every active item needs a saved unit cost.', { count: missingCost.length }));
  }

  let movementCounts = counts;
  let movementOrders = orders;
  let movementDiscards = discards;
  let correctionEffects = new Map<string, unknown>();
  if (session && session.rows.size > 0) {
    const minimumCountSequence = Math.min(
      ...[...session.rows.values()].map((count) => activitySequence(count.activity_sequence)),
    );
    const laterActivity = await loadActivityAfterSequence(client, propertyId, minimumCountSequence);
    movementCounts = mergeRowsById(movementCounts, laterActivity.counts);
    movementOrders = mergeRowsById(movementOrders, laterActivity.orders);
    movementDiscards = mergeRowsById(movementDiscards, laterActivity.discards);
    correctionEffects = await loadCorrectionStockEffects(
      client,
      movementOrders.flatMap((order) => order.entry_kind === 'correction' && order.correction_event_id
        ? [order.correction_event_id]
        : []),
    );
  }
  const movementItems = new Set<string>();
  if (session) {
    for (const item of liveItems) {
      const count = session.rows.get(item.id);
      if (!count) continue;
      if (inventoryBaselineConflictsWithCount({
        countedAt: count.counted_at,
        countActivitySequence: activitySequence(count.activity_sequence),
        orders: movementOrders.filter((order) => order.item_id === item.id).map((order) => ({
          occurredAt: order.received_at,
          activitySequence: activitySequence(order.activity_sequence),
          changedLiveStock: orderChangedLiveStock(order, correctionEffects),
        })),
        discards: movementDiscards.filter((discard) => discard.item_id === item.id).map((discard) => ({
          occurredAt: discard.discarded_at,
          activitySequence: activitySequence(discard.activity_sequence),
        })),
        laterCounts: movementCounts.filter((laterCount) => laterCount.item_id === item.id).map((laterCount) => ({
          activitySequence: activitySequence(laterCount.activity_sequence),
        })),
      })) movementItems.add(item.id);
    }
  }
  if (movementItems.size > 0) {
    blockers.push(issue(
      'activity_after_baseline_count',
      'Inventory activity occurred after the complete count. Count again before starting.',
      { count: movementItems.size },
    ));
  }
  const warnings: InventoryCloseIssue[] = [];
  if (expiredPrior) {
    warnings.push(issue(
      'expired_prior_period_rebaseline_required',
      `${expiredPrior.month} was not closed before its ending-count window expired. It remains unclosed and is excluded; start a fresh current baseline. No usage was fabricated.`,
    ));
  }
  const items: InventoryMonthCloseItem[] = liveItems.map((item) => {
    const count = displayCounts.get(item.id);
    const quantity = numeric(count?.counted_stock);
    const unitCostCents = finite(item.unit_cost) == null ? null : numeric(item.unit_cost) * 100;
    const dimension = liveBudgetDimension(item, dimensions.sections, dimensions.categories);
    if (dimension.multiplyMapped) {
      warnings.push(issue(
        'multiple_budget_sections',
        `${item.name} maps to multiple budget sections; the lowest sort/id will be used.`,
        { itemId: item.id, itemName: item.name },
      ));
    }
    return {
      itemId: item.id,
      itemName: item.name,
      category: item.category,
      customCategoryId: item.custom_category_id,
      customCategoryName: dimension.customCategoryName,
      budgetKey: dimension.budgetKey,
      sectionIds: dimension.sectionIds,
      archivedAt: null,
      beginningQuantity: quantity,
      beginningSetAside: numeric(item.set_aside),
      beginningUnitCostCents: unitCostCents,
      beginningValueCents: unitCostCents == null || !count ? null : Math.round(quantity * unitCostCents),
      openingAdjustmentQuantity: 0,
      openingAdjustmentUnitCostCents: null,
      openingAdjustmentValueCents: 0,
      openingAdjustmentAt: null,
      endingQuantity: null,
      endingSetAside: null,
      endingUnitCostCents: null,
      physicalUnitCostCents: null,
      endingValueCents: null,
      purchasesCents: null,
      purchaseQuantity: null,
      actualUsageCents: null,
      endingCountedAt: count?.counted_at ?? null,
    };
  }).sort((a, b) => a.itemName.localeCompare(b.itemName) || a.itemId.localeCompare(b.itemId));
  const valuesComplete = Boolean(session) && items.every((item) => item.beginningValueCents != null);
  const beginningCents = valuesComplete
    ? items.reduce((sum, item) => sum + (item.beginningValueCents ?? 0), 0)
    : null;
  const canStart = month === propertyCurrentMonth(timezone) && blockers.length === 0 && beginningCents != null;
  const activityStart = session?.countedAt ?? window.monthStart.toISOString();
  const purchaseSummary = await summarizeEffectivePurchasesForProperty(client, propertyId, orders);
  const {
    knownLoggedPurchaseCents,
    loggedPurchaseCents,
    uncostedDeliveryCount,
    loggedDeliveryCount,
  } = purchaseSummary;
  return {
    propertyId,
    month,
    timezone,
    status: 'not_started',
    closeId: null,
    canStart,
    canClose: false,
    closeAvailableOn: window.closeAvailableOn,
    window: {
      monthStart: window.monthStart.toISOString(),
      endExclusive: window.endExclusive.toISOString(),
      graceEndExclusive: window.graceEndExclusive.toISOString(),
      activityStartAt: activityStart,
    },
    isPartial: true,
    budgetComparisonAvailable: false,
    baselineAt: session?.countedAt ?? null,
    closedAt: null,
    closedByName: null,
    notes: null,
    totals: {
      beginningCents,
      openingAdjustmentCents: 0,
      purchasesCents: loggedPurchaseCents,
      endingCents: null,
      actualUsageCents: null,
    },
    purchase: {
      source: null,
      allocationMode: null,
      loggedDeliveryCount,
      loggedPurchaseCents,
      knownLoggedPurchaseCents,
      uncostedDeliveryCount,
      manualPurchaseCents: null,
      confirmedPurchaseCents: null,
    },
    completeness: { complete: false, readyToClose: false, blockers, warnings },
    items,
    byCategory: null,
    byItem: null,
    byBudgetKey: null,
    usageBudgetMode: null,
    usageBudgetTotalCents: null,
    usageBudgetByKey: null,
    history,
  };
}

interface PreviewValue {
  unitCostCents: number | null;
  valueCents: number;
  purchaseQuantity: number | null;
  purchasesCents: number | null;
  actualUsageCents: number | null;
}

async function buildOpenDashboard(
  client: SupabaseClient,
  row: CloseRow,
  history: InventoryMonthCloseHistoryRow[],
): Promise<InventoryMonthCloseDashboard> {
  const openingRows = await loadSnapshotItems(client, [row.opening_snapshot_id]);
  const opening = new Map(openingRows.map((item) => [item.item_id, item]));
  const countStart = row.count_window_start_at > row.activity_start_at
    ? row.count_window_start_at
    : row.activity_start_at;
  const [allItems, counts, loadedOrders, loadedDiscards, dimensions, openingAdjustments] = await Promise.all([
    loadLiveItems(client, row.property_id),
    loadCounts(client, row.property_id, countStart, row.grace_end_at),
    loadOrders(client, row.property_id, row.activity_start_at, row.grace_end_at),
    loadDiscards(client, row.property_id, countStart, row.grace_end_at),
    loadDimensions(client, row.property_id),
    loadOpeningAdjustments(client, row.property_id, row.activity_start_at, row.grace_end_at),
  ]);
  let movementOrders = loadedOrders;
  let movementDiscards = loadedDiscards;
  let movementCounts = counts;
  const adjustmentsByItem = new Map<string, {
    quantity: number;
    valueCents: number;
    unitCostCents: number | null;
    latestAt: string;
    events: OpeningAdjustmentRow[];
  }>();
  for (const adjustment of openingAdjustments) {
    const current = adjustmentsByItem.get(adjustment.item_id) ?? {
      quantity: 0,
      valueCents: 0,
      unitCostCents: null,
      latestAt: adjustment.effective_at,
      events: [],
    };
    current.quantity += numeric(adjustment.quantity);
    current.valueCents += cents(adjustment.value_cents) ?? 0;
    current.latestAt = adjustment.effective_at > current.latestAt
      ? adjustment.effective_at
      : current.latestAt;
    current.events.push(adjustment);
    current.unitCostCents = current.quantity > 0 ? current.valueCents / current.quantity : null;
    adjustmentsByItem.set(adjustment.item_id, current);
  }
  const liveById = new Map(allItems.map((item) => [item.id, item]));
  const periodOrders = loadedOrders.filter(
    (order) => order.received_at >= row.activity_start_at && order.received_at < row.end_at,
  );
  const universeIds = new Set<string>(opening.keys());
  for (const item of allItems) {
    const createdBeforeEnd = item.created_at == null || item.created_at < row.end_at;
    const adjustedDuringEndingWindow = adjustmentsByItem.has(item.id);
    const archivedInPeriod = item.archived_at != null
      && item.archived_at >= row.activity_start_at && item.archived_at < row.end_at;
    const activeAtEnd = item.archived_at == null || item.archived_at >= row.end_at;
    if ((createdBeforeEnd || adjustedDuringEndingWindow) && (activeAtEnd || archivedInPeriod)) {
      universeIds.add(item.id);
    }
  }
  for (const order of periodOrders) universeIds.add(order.item_id);
  const universe = [...universeIds].flatMap((itemId) => {
    const item = liveById.get(itemId);
    return item ? [item] : [];
  });
  const openingPositionFor = (item: LiveItemRow) => {
    const first = opening.get(item.id);
    const adjustment = adjustmentsByItem.get(item.id);
    return inventoryOpeningPosition({
      hasOpeningSnapshot: first != null,
      snapshotQuantity: finite(first?.quantity),
      snapshotUnitCostCents: finite(first?.unit_cost_cents),
      snapshotValueCents: cents(first?.value_cents),
      adjustmentQuantity: adjustment?.quantity ?? null,
      adjustmentUnitCostCents: adjustment?.unitCostCents ?? null,
    });
  };
  const openingPositions = new Map(universe.map((item) => [item.id, openingPositionFor(item)]));
  const requiresCount = universe.filter((item) => item.archived_at == null || item.archived_at >= row.end_at);
  const session = selectCompleteSession(counts, requiresCount.map((item) => item.id));
  const displayCounts = session?.rows ?? latestCounts(counts);
  const blockers: InventoryCloseIssue[] = [];
  if (requiresCount.length > 0 && !session) {
    blockers.push(issue(
      'complete_ending_count_session_required',
      'Run one complete ending count covering every item active at period end.',
      { count: requiresCount.length },
    ));
  }

  let correctionEffects = new Map<string, unknown>();
  if (session && session.rows.size > 0) {
    const minimumCountSequence = Math.min(
      ...[...session.rows.values()].map((count) => activitySequence(count.activity_sequence)),
    );
    const laterActivity = await loadActivityAfterSequence(
      client,
      row.property_id,
      minimumCountSequence,
    );
    movementCounts = mergeRowsById(movementCounts, laterActivity.counts);
    movementOrders = mergeRowsById(movementOrders, laterActivity.orders);
    movementDiscards = mergeRowsById(movementDiscards, laterActivity.discards);
    correctionEffects = await loadCorrectionStockEffects(
      client,
      movementOrders.flatMap((order) => order.entry_kind === 'correction' && order.correction_event_id
        ? [order.correction_event_id]
        : []),
    );
  }

  const movementItems = new Set<string>();
  if (session) {
    for (const item of requiresCount) {
      const count = session.rows.get(item.id);
      if (!count) continue;
      const countSequence = activitySequence(count.activity_sequence);
      const itemOrders = movementOrders.filter((order) => order.item_id === item.id
      );
      const itemDiscards = movementDiscards.filter((discard) => discard.item_id === item.id);
      if (inventoryMovementConflictsWithCount({
        countedAt: count.counted_at,
        countActivitySequence: countSequence,
        activityStartAt: row.activity_start_at,
        endAt: row.end_at,
        orders: itemOrders.map((order) => ({
          occurredAt: order.received_at,
          activitySequence: activitySequence(order.activity_sequence),
          changedLiveStock: orderChangedLiveStock(order, correctionEffects),
        })),
        discards: itemDiscards.map((discard) => ({
          occurredAt: discard.discarded_at,
          activitySequence: activitySequence(discard.activity_sequence),
        })),
        laterCounts: movementCounts.filter((laterCount) => laterCount.item_id === item.id)
          .map((laterCount) => ({
            countedAt: laterCount.counted_at,
            activitySequence: activitySequence(laterCount.activity_sequence),
          })),
      })) {
        movementItems.add(item.id);
      }
      if (adjustmentsByItem.get(item.id)?.events.some(
        (adjustment) => adjustment.effective_at > count.counted_at,
      )) {
        movementItems.add(item.id);
      }
    }
  }
  if (movementItems.size > 0) {
    blockers.push(issue(
      'movement_conflicts_with_ending_count',
      'A delivery or discard makes the selected ending count ineligible. Count again.',
      { count: movementItems.size },
    ));
  }

  const purchaseSummary = await summarizeEffectivePurchasesForProperty(client, row.property_id, periodOrders);
  const {
    knownLoggedPurchaseCents,
    loggedPurchaseCents,
    uncostedDeliveryCount,
    loggedDeliveryCount,
    byItem: purchaseByItem,
  } = purchaseSummary;

  const archivedIds = new Set(universe.filter(
    (item) => item.archived_at != null && item.archived_at < row.end_at,
  ).map((item) => item.id));
  const archiveReadiness = await loadArchiveReadiness(
    client,
    row.property_id,
    [...archivedIds],
  );
  const invalidArchivedIds = new Set([...archivedIds].filter(
    (itemId) => archiveReadiness.get(itemId)?.valid !== true,
  ));
  if (invalidArchivedIds.size > 0) {
    blockers.push(issue(
      'archived_zero_evidence_required',
      'An archived item lacks verified zero-stock evidence. Have a manager verify or repair it before closing.',
      { count: invalidArchivedIds.size },
    ));
  }
  const valueFor = (item: LiveItemRow, source: 'logged' | 'zero' | 'physical'): PreviewValue | null => {
    const first = opening.get(item.id);
    const archived = archivedIds.has(item.id);
    if (archived && invalidArchivedIds.has(item.id)) return null;
    const count = archived ? null : session?.rows.get(item.id) ?? null;
    if (!archived && !count) return null;
    const endingQuantity = archived ? 0 : numeric(count?.counted_stock);
    const openingPosition = openingPositions.get(item.id) ?? inventoryOpeningPosition({ hasOpeningSnapshot: false });
    const openingQuantity = openingPosition.quantity;
    const openingValue = openingPosition.valueCents;
    const purchase = purchaseByItem.get(item.id) ?? { quantity: 0, cents: 0 };
    let unitCostCents: number | null;
    let purchaseQuantity: number | null;
    let purchasesCents: number | null;
    if (source === 'logged') {
      const denominator = openingQuantity + purchase.quantity;
      unitCostCents = denominator > 0 && openingValue != null
        ? (openingValue + purchase.cents) / denominator
        : null;
      purchaseQuantity = purchase.quantity;
      purchasesCents = purchase.cents;
    } else if (source === 'zero') {
      unitCostCents = openingPosition.unitCostCents;
      purchaseQuantity = 0;
      purchasesCents = 0;
    } else {
      unitCostCents = archived ? openingPosition.unitCostCents : finite(count?.unit_cost) == null ? null : numeric(count?.unit_cost) * 100;
      purchaseQuantity = null;
      purchasesCents = null;
    }
    const valueCents = endingQuantity === 0
      ? 0
      : unitCostCents == null
        ? Number.NaN
        : Math.round(endingQuantity * unitCostCents);
    if (!Number.isFinite(valueCents)) return null;
    const actualUsageCents = source === 'physical' || openingValue == null || purchasesCents == null
      ? null
      : openingValue + purchasesCents - valueCents;
    return { unitCostCents, valueCents, purchaseQuantity, purchasesCents, actualUsageCents };
  };

  const optionValues = (source: 'logged' | 'zero' | 'physical') => {
    const values = new Map<string, PreviewValue>();
    for (const item of universe) {
      const value = valueFor(item, source);
      if (!value) return null;
      values.set(item.id, value);
    }
    return values;
  };
  const loggedValues = uncostedDeliveryCount === 0 && loggedDeliveryCount > 0 ? optionValues('logged') : null;
  const loggedEligible = loggedValues != null
    && [...loggedValues.values()].every((value) => value.actualUsageCents == null || value.actualUsageCents >= 0);
  const zeroValues = loggedDeliveryCount === 0 ? optionValues('zero') : null;
  const zeroEligible = zeroValues != null
    && [...zeroValues.values()].every((value) => value.actualUsageCents == null || value.actualUsageCents >= 0);
  const physicalValues = optionValues('physical');
  const valuationEligible = loggedEligible || zeroEligible || physicalValues != null;
  if (session && movementItems.size === 0 && !valuationEligible) {
    blockers.push(issue('ending_valuation_incomplete', 'Counts and saved costs do not provide any complete close valuation.'));
  }
  if (uncostedDeliveryCount > 0) {
    blockers.push(issue(
      'uncosted_deliveries',
      'Logged deliveries are incomplete; add costs or choose the manual-total source.',
      { count: uncostedDeliveryCount, source: 'logged_deliveries' },
    ));
  }
  // No logged rows is source-sensitive, not a physical readiness blocker.
  // MonthClosePanel adds that prompt only while logged_deliveries is selected,
  // so switching to explicit zero can enable the close.
  blockers.push(issue('purchase_source_required', 'Confirm one purchase source before closing.'));

  const preview = loggedEligible ? loggedValues : zeroEligible ? zeroValues : physicalValues;
  const warnings = issues(row.quality_flags);
  const openingAdjustmentCents = [...openingPositions.values()]
    .reduce((sum, position) => sum + position.adjustmentValueCents, 0);
  const openingAdjustmentCount = [...openingPositions.values()]
    .filter((position) => position.adjustmentApplied).length;
  if (openingAdjustmentCount > 0) {
    warnings.push(issue(
      'opening_inventory_adjustment',
      `$${(openingAdjustmentCents / 100).toFixed(2)} of pre-existing shelf stock across ${openingAdjustmentCount} item${openingAdjustmentCount === 1 ? '' : 's'} was added to beginning inventory. It is not a purchase or usage.`,
      { count: openingAdjustmentCount },
    ));
  }
  if (archivedIds.size > 0) {
    warnings.push(issue(
      'archived_item_evidenced_zero',
      'Archived items close at zero only from saved count, loss/correction, or verified never-stocked evidence.',
      { count: archivedIds.size },
    ));
  }
  const items: InventoryMonthCloseItem[] = universe.map((item) => {
    const first = opening.get(item.id);
    const archived = archivedIds.has(item.id);
    const count = archived ? null : displayCounts.get(item.id) ?? null;
    const dimension = liveBudgetDimension(item, dimensions.sections, dimensions.categories);
    if (dimension.multiplyMapped) {
      warnings.push(issue(
        'multiple_budget_sections',
        `${item.name} maps to multiple budget sections; the lowest sort/id will be used.`,
        { itemId: item.id, itemName: item.name },
      ));
    }
    const value = preview?.get(item.id) ?? null;
    const openingPosition = openingPositions.get(item.id) ?? inventoryOpeningPosition({ hasOpeningSnapshot: false });
    const adjustment = adjustmentsByItem.get(item.id);
    const adjustmentAt = openingPosition.adjustmentApplied ? adjustment?.latestAt ?? null : null;
    return {
      itemId: item.id,
      itemName: item.name,
      category: item.category,
      customCategoryId: item.custom_category_id,
      customCategoryName: dimension.customCategoryName ?? first?.custom_category_name ?? null,
      budgetKey: dimension.budgetKey,
      sectionIds: dimension.sectionIds,
      archivedAt: item.archived_at,
      beginningQuantity: openingPosition.quantity,
      beginningSetAside: numeric(first?.set_aside),
      beginningUnitCostCents: openingPosition.unitCostCents,
      beginningValueCents: openingPosition.valueCents,
      openingAdjustmentQuantity: openingPosition.adjustmentApplied
        ? adjustment?.quantity ?? 0
        : 0,
      openingAdjustmentUnitCostCents: openingPosition.adjustmentApplied
        ? adjustment?.unitCostCents ?? null
        : null,
      openingAdjustmentValueCents: openingPosition.adjustmentValueCents,
      openingAdjustmentAt: adjustmentAt,
      endingQuantity: archived ? 0 : count ? numeric(count.counted_stock) : null,
      endingSetAside: archived ? 0 : count ? numeric(item.set_aside) : null,
      endingUnitCostCents: value?.unitCostCents ?? null,
      physicalUnitCostCents: count && finite(count.unit_cost) != null ? numeric(count.unit_cost) * 100 : null,
      endingValueCents: value?.valueCents ?? null,
      purchasesCents: value?.purchasesCents ?? null,
      purchaseQuantity: value?.purchaseQuantity ?? null,
      actualUsageCents: value?.actualUsageCents ?? null,
      endingCountedAt: count?.counted_at ?? null,
    };
  }).sort((a, b) => a.itemName.localeCompare(b.itemName) || a.itemId.localeCompare(b.itemId));
  const endingCents = preview
    ? [...preview.values()].reduce((sum, value) => sum + value.valueCents, 0)
    : null;
  const previewPurchases = loggedEligible ? loggedPurchaseCents : zeroEligible ? 0 : null;
  const beginningCents = [...openingPositions.values()]
    .reduce((sum, position) => sum + (position.valueCents ?? 0), 0);
  const previewActual = endingCents != null && previewPurchases != null
    ? beginningCents + previewPurchases - endingCents
    : null;
  const temporalEligible = Date.now() >= new Date(row.end_at).getTime();
  const physicalReady = (requiresCount.length === 0 || session != null)
    && movementItems.size === 0 && valuationEligible;
  const canClose = temporalEligible && physicalReady;
  return {
    propertyId: row.property_id,
    month: monthKey(row.month_start),
    timezone: row.timezone,
    status: 'open',
    closeId: row.id,
    canStart: false,
    canClose,
    closeAvailableOn: inventoryCloseWindow(monthKey(row.month_start), row.timezone).closeAvailableOn,
    window: {
      monthStart: row.month_start_at,
      endExclusive: row.end_at,
      graceEndExclusive: row.grace_end_at,
      activityStartAt: row.activity_start_at,
    },
    isPartial: row.is_partial,
    budgetComparisonAvailable: row.budget_comparison_available,
    baselineAt: row.baseline_at,
    closedAt: null,
    closedByName: null,
    notes: row.notes,
    totals: {
      beginningCents,
      openingAdjustmentCents,
      purchasesCents: previewPurchases,
      endingCents,
      actualUsageCents: previewActual,
    },
    purchase: {
      source: null,
      allocationMode: null,
      loggedDeliveryCount,
      loggedPurchaseCents,
      knownLoggedPurchaseCents,
      uncostedDeliveryCount,
      manualPurchaseCents: null,
      confirmedPurchaseCents: null,
    },
    completeness: {
      complete: false,
      readyToClose: physicalReady,
      blockers,
      warnings,
    },
    items,
    byCategory: null,
    byItem: null,
    byBudgetKey: null,
    usageBudgetMode: null,
    usageBudgetTotalCents: null,
    usageBudgetByKey: null,
    history,
  };
}

/**
 * Selected dashboard + newest 12 persisted periods. With no explicit month,
 * prefer the current local period; if it has not started, expose the immediately
 * preceding open month for close, while ignoring older stale gaps so a manager
 * can establish a fresh current baseline.
 */
export async function getInventoryMonthCloseDashboard(
  client: SupabaseClient,
  propertyId: string,
  requestedMonth?: string,
): Promise<InventoryMonthCloseDashboard> {
  const { data: property, error: propertyError } = await client
    .from('properties')
    .select('timezone')
    .eq('id', propertyId)
    .maybeSingle();
  if (propertyError) throw propertyError;
  if (!property) throw new Error('Property not found.');
  const timezone = validPropertyTimezone(
    typeof property.timezone === 'string' ? property.timezone : null,
  );
  if (!timezone) {
    throw new Error('Property timezone is missing or invalid. Set a valid IANA timezone before month close.');
  }
  const currentMonth = propertyCurrentMonth(timezone);
  let selectedMonth = requestedMonth ?? currentMonth;
  let closeRow: CloseRow | null = null;
  const history = await listInventoryMonthCloseHistory(client, propertyId, 12);

  const loadClose = async (month: string): Promise<CloseRow | null> => {
    const { data, error } = await client
      .from('inventory_month_closes')
      .select(CLOSE_COLUMNS)
      .eq('property_id', propertyId)
      .eq('month_start', `${month}-01`)
      .maybeSingle();
    if (error) throw error;
    return data as unknown as CloseRow | null;
  };

  closeRow = await loadClose(selectedMonth);
  if (!requestedMonth && !closeRow) {
    const priorMonth = previousMonth(currentMonth);
    const prior = await loadClose(priorMonth);
    if (prior?.status === 'open') {
      const priorDashboard = await buildOpenDashboard(client, prior, history);
      const graceExpired = Date.now() >= new Date(prior.grace_end_at).getTime();
      if (!graceExpired || priorDashboard.canClose) return priorDashboard;
      return buildNotStartedDashboard(client, propertyId, currentMonth, timezone, history, {
        month: priorMonth,
        graceEndAt: prior.grace_end_at,
      });
    }
  }
  if (!closeRow) {
    return buildNotStartedDashboard(client, propertyId, selectedMonth, timezone, history);
  }
  if (closeRow.status === 'closed') return buildClosedDashboard(client, closeRow, history);
  return buildOpenDashboard(client, closeRow, history);
}
