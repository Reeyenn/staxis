// ═══════════════════════════════════════════════════════════════════════════
// Loading the fuel, once, for the screen somebody is standing on.
//
// EVERY READ IN THIS FILE IS SCOPED TO ONE PROPERTY AND IS READ-ONLY. The
// detectors below it are pure functions with no database handle, so a detector
// cannot reach another hotel's rows because it cannot reach any rows.
//
// ONE PAGE, ONE SET OF READS. The route asks for the page a person is on and
// nothing else loads. Standing on Maintenance costs one query for the board and
// one for the room list; standing on the Staxis list costs the maintenance and
// inventory reads, because that is the screen where a pattern found elsewhere
// is allowed to turn up as a line.
//
// NO MODEL CALL, ANYWHERE. Not here and not underneath. Every sentence a trace
// carries was written by code in ./detectors from numbers off these rows.
// ═══════════════════════════════════════════════════════════════════════════

import 'server-only';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canManageTeam, type AppRole } from '@/lib/roles';
import { workOrderIsSettled } from '@/lib/db-mappers';
import { rankTraces } from './index';
import {
  detectMaintenanceRuns,
  WINDOW_DAYS as MAINTENANCE_WINDOW_DAYS,
  type TraceWorkOrder,
} from './detectors/maintenance-run';
import {
  detectInventoryDrift,
  type TraceCountPoint,
  type TraceDelivery,
  type TraceInventoryItem,
} from './detectors/inventory-drift';
import {
  detectCalloutWeekday,
  WINDOW_WEEKS as CALLOUT_WINDOW_WEEKS,
  type TraceCallout,
} from './detectors/callout-weekday';
import type { TracePage, TracePattern } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Ceilings, so a busy hotel cannot turn a page load into a table scan. */
const MAX_WORK_ORDERS = 600;
const MAX_ROOMS = 600;
const MAX_ITEMS = 400;
const MAX_COUNTS = 1500;
const MAX_DELIVERIES = 1500;
const MAX_CALLOUTS = 400;

/** How far back the inventory reads go. Wide enough for three counts. */
const INVENTORY_WINDOW_DAYS = 240;

function isoDaysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

// ─── Maintenance ────────────────────────────────────────────────────────────

async function loadWorkOrders(propertyId: string, now: Date): Promise<TraceWorkOrder[]> {
  const { data, error } = await supabaseAdmin
    .from('work_orders')
    .select('id, room_number, description, status, created_at, repair_cost')
    .eq('property_id', propertyId)
    .gte('created_at', isoDaysAgo(now, MAINTENANCE_WINDOW_DAYS))
    .order('created_at', { ascending: false })
    .limit(MAX_WORK_ORDERS);
  if (error || !data) return [];
  return data.flatMap((row) => {
    const location = typeof row.room_number === 'string' ? row.room_number.trim() : '';
    const description = typeof row.description === 'string' ? row.description.trim() : '';
    if (!location || !description || !row.created_at) return [];
    const cost = typeof row.repair_cost === 'number' ? row.repair_cost : null;
    return [{
      id: String(row.id),
      location,
      description,
      // The settled-status rule, from db-mappers.ts. `closed` joins `resolved`
      // as an ending (see WORK_ORDER_SETTLED_STATUSES) because a ticket somebody
      // judged to be a non-issue is off the board too; everything else,
      // including the 'deferred' that "Waiting on parts" writes, is still live.
      // Imported rather than mirrored: this used to be an inline
      // `!== 'resolved'`, and the moment a second ending existed the copy here
      // would have kept reporting closed tickets as open.
      open: !workOrderIsSettled(row.status),
      createdAt: String(row.created_at),
      repairCost: cost,
    }];
  });
}

/**
 * Every room number this hotel is known to have.
 *
 * Two sources, unioned, because neither is reliably populated on its own:
 * `pms_rooms_inventory` is the canonical list and is empty at a hotel whose PMS
 * has never been read, while `room_work` is the housekeeping board and only
 * knows about rooms that were cleaned recently. An empty result is a real
 * answer: the sibling-room claim simply never gets made.
 */
async function loadKnownRooms(propertyId: string, now: Date): Promise<string[]> {
  const [inventory, board] = await Promise.all([
    supabaseAdmin
      .from('pms_rooms_inventory')
      .select('room_number')
      .eq('property_id', propertyId)
      .limit(MAX_ROOMS),
    supabaseAdmin
      .from('room_work')
      .select('room_number')
      .eq('property_id', propertyId)
      .gte('date', isoDaysAgo(now, 30).slice(0, 10))
      .limit(MAX_ROOMS),
  ]);
  const rooms = new Set<string>();
  for (const source of [inventory.data, board.data]) {
    for (const row of source ?? []) {
      const value = typeof row.room_number === 'string' ? row.room_number.trim() : '';
      if (value) rooms.add(value);
    }
  }
  return [...rooms];
}

async function maintenancePatterns(propertyId: string, now: Date): Promise<TracePattern[]> {
  const [workOrders, knownRooms] = await Promise.all([
    loadWorkOrders(propertyId, now),
    loadKnownRooms(propertyId, now),
  ]);
  if (workOrders.length === 0) return [];
  return detectMaintenanceRuns({ now, workOrders, knownRooms });
}

// ─── Inventory ──────────────────────────────────────────────────────────────

async function inventoryPatterns(propertyId: string, now: Date): Promise<TracePattern[]> {
  const since = isoDaysAgo(now, INVENTORY_WINDOW_DAYS);
  const [itemRows, countRows, deliveryRows] = await Promise.all([
    supabaseAdmin
      .from('inventory')
      .select('id, name, par_level, archived_at')
      .eq('property_id', propertyId)
      .limit(MAX_ITEMS),
    supabaseAdmin
      .from('inventory_counts')
      .select('item_id, counted_stock, counted_at')
      .eq('property_id', propertyId)
      .gte('counted_at', since)
      .limit(MAX_COUNTS),
    supabaseAdmin
      .from('inventory_orders')
      .select('id, item_id, quantity, unit_cost, vendor_name, received_at, corrects_order_id')
      .eq('property_id', propertyId)
      .gte('received_at', since)
      .limit(MAX_DELIVERIES),
  ]);

  const items: TraceInventoryItem[] = (itemRows.data ?? [])
    .filter((row) => !row.archived_at && typeof row.name === 'string' && row.name.trim() !== '')
    .map((row) => ({
      id: String(row.id),
      name: String(row.name).trim(),
      parLevel: typeof row.par_level === 'number' ? row.par_level : null,
    }));
  if (items.length === 0) return [];

  const counts: TraceCountPoint[] = (countRows.data ?? []).flatMap((row) => {
    if (!row.item_id || typeof row.counted_stock !== 'number' || !row.counted_at) return [];
    return [{
      itemId: String(row.item_id),
      countedStock: row.counted_stock,
      countedAt: String(row.counted_at),
    }];
  });

  // Corrections in this schema are ADDITIVE: a correcting row points at the row
  // it replaces rather than editing it. Reading both would count one delivery
  // twice and would compare a price against its own retraction.
  const superseded = new Set(
    (deliveryRows.data ?? [])
      .map((row) => (typeof row.corrects_order_id === 'string' ? row.corrects_order_id : null))
      .filter((id): id is string => id !== null),
  );
  const deliveries: TraceDelivery[] = (deliveryRows.data ?? []).flatMap((row) => {
    if (!row.item_id || !row.received_at) return [];
    if (superseded.has(String(row.id))) return [];
    const quantity = typeof row.quantity === 'number' ? row.quantity : 0;
    return [{
      id: String(row.id),
      itemId: String(row.item_id),
      quantity,
      unitCost: typeof row.unit_cost === 'number' ? row.unit_cost : null,
      vendorName: typeof row.vendor_name === 'string' ? row.vendor_name : null,
      receivedAt: String(row.received_at),
    }];
  });

  return detectInventoryDrift({ now, items, counts, deliveries });
}

// ─── Attendance ─────────────────────────────────────────────────────────────

async function calloutPatterns(propertyId: string, now: Date): Promise<TracePattern[]> {
  const since = new Date(now.getTime() - CALLOUT_WINDOW_WEEKS * 7 * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const { data, error } = await supabaseAdmin
    .from('callout_events')
    .select('id, staff_id, business_date')
    .eq('property_id', propertyId)
    .eq('status', 'active')
    .gte('business_date', since)
    .limit(MAX_CALLOUTS);
  if (error || !data || data.length === 0) return [];

  const staffIds = Array.from(new Set(data.map((row) => String(row.staff_id))));
  const { data: staffRows } = await supabaseAdmin
    .from('staff')
    .select('id, name')
    .eq('property_id', propertyId)
    .in('id', staffIds);
  const names = new Map<string, string>();
  for (const row of staffRows ?? []) {
    if (typeof row.name === 'string' && row.name.trim()) names.set(String(row.id), row.name.trim());
  }

  const callouts: TraceCallout[] = data.flatMap((row) => {
    const staffId = String(row.staff_id);
    const staffName = names.get(staffId);
    // No name, no card. A pattern about "somebody" is not worth showing, and
    // printing a uuid where a person's name goes would be worse than silence.
    if (!staffName || typeof row.business_date !== 'string') return [];
    return [{ id: String(row.id), staffId, staffName, businessDate: row.business_date }];
  });
  if (callouts.length === 0) return [];
  return detectCalloutWeekday({ now, callouts });
}

// ─── The whole job ──────────────────────────────────────────────────────────

/**
 * Which detectors a screen is allowed to run.
 *
 * The Staxis list runs the drawable ones because it is the screen where a
 * pattern found elsewhere turns up as a line and offers to walk somebody over.
 * The attendance detector is on every page's list because it is never drawn on
 * any of them: it reaches a person only through the panel they opened.
 */
const DETECTORS_BY_PAGE: Readonly<Record<TracePage, readonly ('maintenance' | 'inventory')[]>> = {
  maintenance: ['maintenance'],
  inventory: ['inventory'],
  staxis: ['maintenance', 'inventory'],
};

export interface TraceRequest {
  readonly propertyId: string;
  readonly page: TracePage | null;
  readonly role: AppRole;
  readonly now?: Date;
}

/**
 * Every pattern this person may be shown on this screen, worst first.
 *
 * Fails soft, per detector: one broken read produces one missing pattern and
 * never an empty page. A companion that could not think of anything to say is
 * the correct degraded state.
 */
export async function buildTracePatterns(request: TraceRequest): Promise<TracePattern[]> {
  const now = request.now ?? new Date();
  const wanted = request.page ? DETECTORS_BY_PAGE[request.page] : [];
  const jobs: Array<Promise<TracePattern[]>> = [];

  if (wanted.includes('maintenance')) jobs.push(maintenancePatterns(request.propertyId, now));
  if (wanted.includes('inventory')) jobs.push(inventoryPatterns(request.propertyId, now));
  // Only a manager sees anything about how one person is turning up, on every
  // screen and in every venue. The venue rule (`decidePanelAsk`) is the second
  // gate, not the only one.
  if (canManageTeam(request.role)) jobs.push(calloutPatterns(request.propertyId, now));

  const settled = await Promise.allSettled(jobs);
  const patterns = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  return rankTraces(patterns);
}
