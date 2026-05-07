// ═══════════════════════════════════════════════════════════════════════════
// Inventory Intelligence — estimated stock + occupancy data source
//
// The user counts inventory once. Then guests check in, check out, and stay
// over for days/weeks. The actual stock drains continuously, but the value
// in the `inventory.current_stock` column is frozen at whatever was last
// counted. This module bridges the gap.
//
// Two responsibilities:
//
//   1. fetchOccupancyEvents(pid, since)
//      Pulls every cleaning event in the property since `since`. Returns
//      raw events with completed_at timestamps so the caller can compute
//      a per-item window (each item has its own last_counted_at).
//
//   2. computeOccupancyForItem(events, item)
//      Counts checkouts and stayovers in `events` whose completed_at is
//      after the item's lastCountedAt. Returns OccupancySinceLastCount.
//
//   3. calculateEstimatedStock(item, occupancy)
//      Pure deduction: stock - checkouts*usagePerCheckout - stayovers*usagePerStayover.
//      Floors at zero. Returns the input stock unchanged when no usage rates
//      are configured or the source is 'none'.
//
// Why per-item instead of global: each item was last counted at a different
// time. A bath towel counted yesterday should deduct only yesterday's
// occupancy; a coffee pod stockpile counted three weeks ago should deduct
// three weeks. Using a single global window over-deducts items counted
// recently and under-deducts items counted long ago.
// ═══════════════════════════════════════════════════════════════════════════

import type { InventoryItem } from '@/types';
import { supabase } from './supabase';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OccupancySinceLastCount {
  checkouts: number;
  stayovers: number;
  windowStart: string;
  source: 'cleaning_events' | 'daily_logs' | 'none';
}

/** Lightweight row used for per-item windowing. */
export interface OccupancyEvent {
  completedAt: string;        // ISO timestamp
  roomType: 'checkout' | 'stayover';
}

export interface OccupancyBundle {
  events: OccupancyEvent[];
  /** Where the events came from. 'none' means we have nothing reliable. */
  source: 'cleaning_events' | 'daily_logs' | 'none';
  /** When the earliest event in the bundle is from. ISO. */
  windowStart: string;
}

// ─── Bulk occupancy fetch ───────────────────────────────────────────────────
//
// One round-trip, returns every event in the property since `since`. Caller
// then partitions per-item locally — vastly cheaper than N item-scoped fetches.
//
// Three-tier source order, same as before:
//   1. cleaning_events  (precise, per-room completions)
//   2. daily_logs       (PMS / morning-setup totals)
//   3. none             (caller falls back to raw current_stock)
//
// The daily_logs tier is approximate: we don't know which rooms were cleaned
// at what time, so we fan a day's totals out as fake events at noon local.
// Fine for windowing math because day granularity is already the input.

export async function fetchOccupancyBundle(
  pid: string,
  since: Date | null,
): Promise<OccupancyBundle> {
  if (!since) {
    return { events: [], source: 'none', windowStart: new Date(0).toISOString() };
  }

  const sinceISO = since.toISOString();
  const sinceDate = since.toISOString().slice(0, 10);

  // ── Tier 1: cleaning_events ─────────────────────────────────────────────
  try {
    const { data: rows, error } = await supabase
      .from('cleaning_events')
      .select('completed_at, room_type, status')
      .eq('property_id', pid)
      .gte('completed_at', sinceISO)
      .in('status', ['recorded', 'approved'])
      .order('completed_at', { ascending: true });

    if (!error && rows && rows.length > 0) {
      const events: OccupancyEvent[] = rows
        .filter(r => r.room_type === 'checkout' || r.room_type === 'stayover')
        .map(r => ({
          completedAt: String(r.completed_at),
          roomType: r.room_type as 'checkout' | 'stayover',
        }));
      return { events, source: 'cleaning_events', windowStart: sinceISO };
    }
  } catch {
    /* fall through */
  }

  // ── Tier 2: daily_logs ──────────────────────────────────────────────────
  try {
    const { data: rows, error } = await supabase
      .from('daily_logs')
      .select('date, checkouts, stayovers')
      .eq('property_id', pid)
      .gte('date', sinceDate)
      .order('date', { ascending: true });

    if (!error && rows && rows.length > 0) {
      const events: OccupancyEvent[] = [];
      for (const row of rows) {
        // Place all of a day's events at noon local (12:00 UTC ≈ noon-ish for
        // the US Central tz this app cares about). Granularity for windowing
        // is daily anyway.
        const ts = `${row.date}T12:00:00Z`;
        const co = Number(row.checkouts ?? 0);
        const so = Number(row.stayovers ?? 0);
        for (let i = 0; i < co; i++) events.push({ completedAt: ts, roomType: 'checkout' });
        for (let i = 0; i < so; i++) events.push({ completedAt: ts, roomType: 'stayover' });
      }
      return { events, source: 'daily_logs', windowStart: sinceISO };
    }
  } catch {
    /* fall through */
  }

  // ── Tier 3: nothing ─────────────────────────────────────────────────────
  return { events: [], source: 'none', windowStart: sinceISO };
}

// ─── Per-item occupancy computation ────────────────────────────────────────

/**
 * Count checkouts/stayovers in `bundle.events` whose completed_at is at or
 * after the item's lastCountedAt. Returns 'none' source if bundle source is
 * 'none' OR if the item has no last-count timestamp (so we can't define a
 * window).
 */
export function computeOccupancyForItem(
  bundle: OccupancyBundle,
  item: Pick<InventoryItem, 'lastCountedAt' | 'updatedAt'>,
): OccupancySinceLastCount {
  // Use lastCountedAt if available; fall back to updatedAt for backward
  // compatibility (existing rows pre-migration 0027 only have updated_at).
  const itemAnchor = item.lastCountedAt ?? item.updatedAt;
  if (!itemAnchor || bundle.source === 'none') {
    return {
      checkouts: 0, stayovers: 0,
      windowStart: bundle.windowStart, source: 'none',
    };
  }

  const anchorMs = itemAnchor.getTime();
  let checkouts = 0;
  let stayovers = 0;
  for (const e of bundle.events) {
    if (new Date(e.completedAt).getTime() >= anchorMs) {
      if (e.roomType === 'checkout') checkouts++;
      else stayovers++;
    }
  }

  return {
    checkouts,
    stayovers,
    windowStart: itemAnchor.toISOString(),
    source: bundle.source,
  };
}

// ─── Estimate calculation ──────────────────────────────────────────────────

export interface EstimatedStockResult {
  estimated: number;
  hasEstimate: boolean;
  deducted: number;
}

/**
 * Apply per-item usage rates to occupancy counts.
 *
 * Returns the original currentStock (with hasEstimate=false) when:
 *   - both usage rates are unset/zero (item isn't configured)
 *   - occupancy source is 'none' (no data, or no last-count anchor)
 *
 * Floors at zero — we don't show negative stock; if the math says we're at
 * -5, we show 0 and the status logic flags it as critical anyway.
 */
export function calculateEstimatedStock(
  item: Pick<InventoryItem, 'currentStock' | 'usagePerCheckout' | 'usagePerStayover'>,
  occupancy: OccupancySinceLastCount,
): EstimatedStockResult {
  const perCheckout = item.usagePerCheckout ?? 0;
  const perStayover = item.usagePerStayover ?? 0;

  if (perCheckout === 0 && perStayover === 0) {
    return { estimated: item.currentStock, hasEstimate: false, deducted: 0 };
  }
  if (occupancy.source === 'none') {
    return { estimated: item.currentStock, hasEstimate: false, deducted: 0 };
  }

  const deducted =
    occupancy.checkouts * perCheckout + occupancy.stayovers * perStayover;
  const estimated = Math.max(0, item.currentStock - deducted);
  return { estimated, hasEstimate: true, deducted };
}

// ─── Backward-compatible single-item helper ────────────────────────────────
//
// Kept so callers that only need one item (server routes, future cron) don't
// have to deal with the bundle dance. Just calls the bundle path under the
// hood.

export async function fetchOccupancySinceLastCount(
  pid: string,
  since: Date | null,
): Promise<OccupancySinceLastCount> {
  const bundle = await fetchOccupancyBundle(pid, since);
  if (bundle.source === 'none' || !since) {
    return { checkouts: 0, stayovers: 0, windowStart: bundle.windowStart, source: 'none' };
  }
  // Treat the entire bundle as one item's worth of events (caller passed `since`
  // = that item's last count timestamp).
  let checkouts = 0;
  let stayovers = 0;
  for (const e of bundle.events) {
    if (e.roomType === 'checkout') checkouts++;
    else stayovers++;
  }
  return { checkouts, stayovers, windowStart: since.toISOString(), source: bundle.source };
}
