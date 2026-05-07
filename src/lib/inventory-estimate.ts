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
//   1. fetchOccupancySinceLastCount(pid, since) — return the number of
//      checkouts and stayovers that have happened at this property since
//      a given timestamp. Reads from the cleaning_events table because
//      that's the only table that reliably distinguishes the two.
//      Three-tier fallback documented inline.
//
//   2. calculateEstimatedStock(item, occupancy) — apply the per-item
//      usage rates to the occupancy counts. Pure, no DB. Returns the
//      input stock unchanged when no usage rates are configured.
//
// Why pure utility instead of in-page math: this also gets called from
// /api/inventory/check-alerts (server-side, after Count Mode saves) and
// will get called from a daily cron later for proactive critical alerts
// before anyone touches the page.
// ═══════════════════════════════════════════════════════════════════════════

import type { InventoryItem } from '@/types';
import { supabase } from './supabase';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OccupancySinceLastCount {
  /** Number of checkouts cleaned in the window. */
  checkouts: number;
  /** Number of stayover cleans in the window (light + full combined). */
  stayovers: number;
  /** ISO timestamp of the start of the window. */
  windowStart: string;
  /** Source we pulled the data from — useful for diagnostics. */
  source: 'cleaning_events' | 'daily_logs' | 'none';
}

// ─── Occupancy fetch ────────────────────────────────────────────────────────
//
// Three-tier fallback:
//
//   Tier 1 — cleaning_events table
//     Each completed clean writes a row with room_type ∈ {'checkout','stayover'}.
//     This is the most precise source — it's literally what the housekeepers
//     finished, not what the PMS planned. Used when the property is actively
//     using the housekeeping module (Comfort Suites is).
//
//   Tier 2 — daily_logs table
//     The morning-setup numbers Mario types in (or the PMS-pulled forecast).
//     Less precise — these are predictions of the day's checkouts, not
//     completions. Use when cleaning_events is empty for the window
//     (e.g., the property uses inventory but not housekeeping yet).
//
//   Tier 3 — none
//     If neither table has data, return zeros. The caller should NOT show
//     an "estimated" value in this case — it'd be misleading. Just fall
//     back to the regular currentStock display.

export async function fetchOccupancySinceLastCount(
  pid: string,
  since: Date | null,
): Promise<OccupancySinceLastCount> {
  // No prior count → nothing to estimate against. Caller falls back to
  // raw currentStock display.
  if (!since) {
    return { checkouts: 0, stayovers: 0, windowStart: new Date(0).toISOString(), source: 'none' };
  }

  const sinceISO = since.toISOString();
  const sinceDate = since.toISOString().slice(0, 10); // YYYY-MM-DD

  // ── Tier 1: cleaning_events ─────────────────────────────────────────────
  // Filter on completed_at because that's when the consumable was actually
  // used — sheets/towels swapped out, soap restocked. created_at would
  // double-count rows backfilled from history.
  try {
    const { data: events, error } = await supabase
      .from('cleaning_events')
      .select('room_type, status')
      .eq('property_id', pid)
      .gte('completed_at', sinceISO)
      .in('status', ['recorded', 'approved']); // exclude flagged/rejected/discarded

    if (!error && events && events.length > 0) {
      let checkouts = 0;
      let stayovers = 0;
      for (const e of events) {
        if (e.room_type === 'checkout') checkouts++;
        else if (e.room_type === 'stayover') stayovers++;
      }
      return {
        checkouts,
        stayovers,
        windowStart: sinceISO,
        source: 'cleaning_events',
      };
    }
  } catch {
    // fall through to tier 2
  }

  // ── Tier 2: daily_logs ──────────────────────────────────────────────────
  // Sum the daily morning-setup counts across the window. Less precise but
  // catches properties that bypass the housekeeping module.
  try {
    const { data: logs, error } = await supabase
      .from('daily_logs')
      .select('checkouts, stayovers')
      .eq('property_id', pid)
      .gte('date', sinceDate);

    if (!error && logs && logs.length > 0) {
      const checkouts = logs.reduce((s, l) => s + Number(l.checkouts ?? 0), 0);
      const stayovers = logs.reduce((s, l) => s + Number(l.stayovers ?? 0), 0);
      return {
        checkouts,
        stayovers,
        windowStart: sinceISO,
        source: 'daily_logs',
      };
    }
  } catch {
    // fall through to tier 3
  }

  // ── Tier 3: nothing ─────────────────────────────────────────────────────
  return { checkouts: 0, stayovers: 0, windowStart: sinceISO, source: 'none' };
}

// ─── Estimate calculation ──────────────────────────────────────────────────

export interface EstimatedStockResult {
  /** The estimated current stock. Equals item.currentStock when usage rates aren't configured. */
  estimated: number;
  /** True iff usage rates were configured AND occupancy data was available. */
  hasEstimate: boolean;
  /** How many units were deducted from the last count. 0 when no estimate. */
  deducted: number;
}

/**
 * Apply per-item usage rates to occupancy counts.
 *
 * Returns the original currentStock (with hasEstimate=false) in any of:
 *   - both usage rates are unset (item isn't configured)
 *   - occupancy source is 'none' (no data to estimate against)
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

  // No usage rates configured for this item → caller falls back to raw stock.
  if (perCheckout === 0 && perStayover === 0) {
    return { estimated: item.currentStock, hasEstimate: false, deducted: 0 };
  }

  // No occupancy data → can't estimate honestly. Show raw.
  if (occupancy.source === 'none') {
    return { estimated: item.currentStock, hasEstimate: false, deducted: 0 };
  }

  const deducted =
    occupancy.checkouts * perCheckout + occupancy.stayovers * perStayover;
  const estimated = Math.max(0, item.currentStock - deducted);

  return { estimated, hasEstimate: true, deducted };
}
