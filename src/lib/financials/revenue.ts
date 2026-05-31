// ════════════════════════════════════════════════════════════════════════════
// Financials — PMS revenue & occupancy (SINGLE SOURCE OF TRUTH with Dashboard).
//
// Revenue/occupancy come from pms_revenue_daily — the canonical PMS table the
// owner Dashboard is wired to read (migration 0202). We do NOT invent a second
// revenue number anywhere: the Financials summary AND the Dashboard finance tile
// both call getMonthRevenue(), so they can never disagree.
//
// Cold-start honesty: the first paying hotel is on a Choice Advantage franchise
// PMS that does not expose financials, so pms_revenue_daily is empty today. When
// there are no rows for the month we return revenueCents = null (NOT 0) so the
// UI says "no PMS revenue yet" instead of implying $0 of real sales. Profit is
// likewise null until revenue is known.
// ════════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import { monthStartISO, nextMonthStartISO } from './shared';

function toFiniteNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface MonthRevenue {
  revenueCents: number | null; // sum of pms_revenue_daily.total_revenue_cents, or null (cold start)
  revenueIsLive: boolean; // true once any PMS revenue row exists for the month
  occupiedRoomNights: number | null; // sum of occupied_rooms, or null
}

/**
 * Sum the month's PMS revenue + occupied room-nights for one property.
 * Reads the same table the Dashboard's revenue is sourced from.
 */
export async function getMonthRevenue(pid: string, month: string): Promise<MonthRevenue> {
  const start = monthStartISO(month);
  const endExcl = nextMonthStartISO(month);
  try {
    const { data, error } = await supabaseAdmin
      .from('pms_revenue_daily')
      .select('total_revenue_cents, occupied_rooms, date')
      .eq('property_id', pid)
      .gte('date', start)
      .lt('date', endExcl);
    if (error) {
      log.warn('[financials/revenue] getMonthRevenue read failed', { pid, month, err: error.message });
      return { revenueCents: null, revenueIsLive: false, occupiedRoomNights: null };
    }
    const rows = data ?? [];
    if (rows.length === 0) {
      return { revenueCents: null, revenueIsLive: false, occupiedRoomNights: null };
    }
    let revenue = 0;
    let hasRevenue = false;
    let nights = 0;
    let hasNights = false;
    for (const r of rows) {
      const tr = toFiniteNumber((r as Record<string, unknown>).total_revenue_cents);
      if (tr != null) {
        revenue += tr;
        hasRevenue = true;
      }
      const occ = toFiniteNumber((r as Record<string, unknown>).occupied_rooms);
      if (occ != null) {
        nights += occ;
        hasNights = true;
      }
    }
    return {
      revenueCents: hasRevenue ? Math.round(revenue) : null,
      revenueIsLive: hasRevenue,
      occupiedRoomNights: hasNights ? Math.round(nights) : null,
    };
  } catch (e) {
    log.warn('[financials/revenue] getMonthRevenue threw', {
      pid,
      month,
      err: e instanceof Error ? e.message : String(e),
    });
    return { revenueCents: null, revenueIsLive: false, occupiedRoomNights: null };
  }
}

/**
 * Occupancy pacing factor for the overspend forecast: ratio of the property's
 * forecast average daily occupancy for the REMAINING days of the month to its
 * actual average for the elapsed days. >1 means the back half of the month is
 * busier (so spend will pace up); <1 means it slows down. Returns null when the
 * PMS forecast feed (pms_forecast_daily) has no usable data — the forecast then
 * falls back to pure linear pacing (honest cold start, no fabricated trend).
 */
export async function getOccupancyPacingFactor(
  pid: string,
  month: string,
  todayISO: string,
): Promise<number | null> {
  const start = monthStartISO(month);
  const endExcl = nextMonthStartISO(month);
  try {
    const { data, error } = await supabaseAdmin
      .from('pms_forecast_daily')
      .select('forecast_date, projected_occupancy_pct')
      .eq('property_id', pid)
      .gte('forecast_date', start)
      .lt('forecast_date', endExcl);
    if (error || !data || data.length === 0) return null;

    let elapsedSum = 0;
    let elapsedN = 0;
    let remainingSum = 0;
    let remainingN = 0;
    for (const r of data) {
      const occ = toFiniteNumber((r as Record<string, unknown>).projected_occupancy_pct);
      const d = (r as Record<string, unknown>).forecast_date as string | undefined;
      if (occ == null || !d) continue;
      if (d < todayISO) {
        elapsedSum += occ;
        elapsedN++;
      } else {
        remainingSum += occ;
        remainingN++;
      }
    }
    if (elapsedN === 0 || remainingN === 0) return null;
    const elapsedAvg = elapsedSum / elapsedN;
    const remainingAvg = remainingSum / remainingN;
    if (elapsedAvg <= 0) return null;
    const factor = remainingAvg / elapsedAvg;
    // Clamp to a sane band so a noisy forecast can't wildly distort the pacing.
    return Math.max(0.5, Math.min(1.5, factor));
  } catch {
    return null;
  }
}
