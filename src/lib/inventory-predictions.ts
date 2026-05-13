// ═══════════════════════════════════════════════════════════════════════════
// Inventory Predictions — days-until-stockout + order-by-date forecasting.
//
// Pure utility (the synchronous parts) so it's testable, reusable across the
// Concierge Insight, Smart Reorder List, Analytics, and Ownership Report,
// and side-effect-free.
//
// Data flow:
//
//   1. fetchDailyAverages(pid, days=14)
//      Pulls the last `days` days of daily_logs (or cleaning_events as
//      fallback) and computes avg checkouts/day + avg stayovers/day.
//      Returns daysOfData so callers can decide whether the sample is
//      large enough to predict reliably (we require ≥7 days).
//
//   2. predictReorder(item, averages, effectiveStock)
//      Given an item's usage rates + the property's daily averages +
//      what the item's effective stock is right now, returns:
//        - dailyBurnRate (units consumed per day)
//        - daysUntilOut  (effectiveStock / dailyBurnRate)
//        - orderByDate   (today + daysUntilOut - reorderLeadDays)
//        - urgency       ('now' | 'soon' | 'ok' | 'unknown')
//
//   3. predictReorders(items, averages, effectiveStockMap)
//      Convenience batch wrapper for #2.
//
// Why daily averages and not occupancy-since-last-count: the estimate-stock
// path needs "events between item.last_counted_at and now". Predictions need
// the steady-state run rate going forward. Mixing the two would either over-
// or under-deduct items counted very recently / very long ago.
// ═══════════════════════════════════════════════════════════════════════════

import type { InventoryItem } from '@/types';
import { supabase } from './supabase';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DailyAverages {
  /** Mean checkouts per day across the lookback window. */
  avgDailyCheckouts: number;
  /** Mean stayovers per day across the lookback window. */
  avgDailyStayovers: number;
  /** Number of distinct days that contributed data. */
  daysOfData: number;
  /** Where the data came from. 'none' when no source had usable rows. */
  source: 'daily_logs' | 'cleaning_events' | 'none';
}

export interface PredictionResult {
  itemId: string;
  /** Units of THIS item consumed per day at current daily averages. */
  dailyBurnRate: number;
  /** Days from today until effectiveStock hits zero. Null when not predictable. */
  daysUntilOut: number | null;
  /** Last day to safely place an order (= stockout - lead days). Null when not predictable. */
  orderByDate: Date | null;
  /** UX bucket. 'unknown' = either no usage rates or <7 days of data. */
  urgency: 'now' | 'soon' | 'ok' | 'unknown';
}

// Minimum days of occupancy data we need before committing to a prediction.
// Below this, we return urgency='unknown' so the UI stays honest instead of
// projecting noise into the future.
const MIN_DAYS_OF_DATA = 7;

// Default lead time when an item doesn't specify. Matches the schema default.
const DEFAULT_LEAD_DAYS = 3;

// ─── Daily averages fetch ──────────────────────────────────────────────────
//
// Tier 1 — daily_logs: Mario's morning-setup numbers (or PMS-pulled ones).
// One row per day, includes zero-occupancy days correctly, fastest.
//
// Tier 2 — cleaning_events: every recorded clean. Accurate when it has
// data, but only covers days the housekeeping module was actually used.
//
// Tier 3 — empty result. Caller treats every item as urgency='unknown'.

export async function fetchDailyAverages(
  pid: string,
  days = 14,
): Promise<DailyAverages> {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceDate = since.toISOString().slice(0, 10);

  // ── Tier 1: daily_logs ────────────────────────────────────────────────
  try {
    const { data, error } = await supabase
      .from('daily_logs')
      .select('date, checkouts, stayovers')
      .eq('property_id', pid)
      .gte('date', sinceDate);

    if (!error && data && data.length > 0) {
      // Distinct days only — guards against duplicate rows for the same date.
      const byDate = new Map<string, { co: number; so: number }>();
      for (const row of data) {
        const d = String(row.date);
        const prev = byDate.get(d) ?? { co: 0, so: 0 };
        byDate.set(d, {
          co: prev.co + Number(row.checkouts ?? 0),
          so: prev.so + Number(row.stayovers ?? 0),
        });
      }
      const distinctDays = byDate.size;
      let totalCo = 0;
      let totalSo = 0;
      byDate.forEach(v => { totalCo += v.co; totalSo += v.so; });
      return {
        avgDailyCheckouts: distinctDays > 0 ? totalCo / distinctDays : 0,
        avgDailyStayovers: distinctDays > 0 ? totalSo / distinctDays : 0,
        daysOfData: distinctDays,
        source: 'daily_logs',
      };
    }
  } catch {
    /* fall through */
  }

  // ── Tier 2: cleaning_events ───────────────────────────────────────────
  try {
    const { data, error } = await supabase
      .from('cleaning_events')
      .select('date, room_type, status')
      .eq('property_id', pid)
      .gte('date', sinceDate)
      .in('status', ['recorded', 'approved']);

    if (!error && data && data.length > 0) {
      const byDate = new Map<string, { co: number; so: number }>();
      for (const r of data) {
        if (r.room_type !== 'checkout' && r.room_type !== 'stayover') continue;
        const d = String(r.date);
        const prev = byDate.get(d) ?? { co: 0, so: 0 };
        if (r.room_type === 'checkout') prev.co += 1; else prev.so += 1;
        byDate.set(d, prev);
      }
      const distinctDays = byDate.size;
      let totalCo = 0;
      let totalSo = 0;
      byDate.forEach(v => { totalCo += v.co; totalSo += v.so; });
      return {
        avgDailyCheckouts: distinctDays > 0 ? totalCo / distinctDays : 0,
        avgDailyStayovers: distinctDays > 0 ? totalSo / distinctDays : 0,
        daysOfData: distinctDays,
        source: 'cleaning_events',
      };
    }
  } catch {
    /* fall through */
  }

  // ── Tier 3: nothing usable ────────────────────────────────────────────
  return { avgDailyCheckouts: 0, avgDailyStayovers: 0, daysOfData: 0, source: 'none' };
}

// ─── ML-learned rate fetch ─────────────────────────────────────────────────
//
// The Bayesian / XGBoost models in ml-service write a row per (property × item)
// per nightly inference run to inventory_rate_predictions. When a fresh
// prediction (< 7 days old) exists, we use its rate as the source of truth
// instead of the manager-typed usagePerCheckout × avgDailyCheckouts math.
//
// Returns a Map<itemId, dailyRate>. Empty when no predictions exist or the
// ai_mode is 'off'. The caller passes this map to predictReorders().

// Freshness window for ML predictions: anything older than this is treated
// as stale (cron broken, model not retraining, etc.) and excluded from
// consumer surfaces. Exported so getInventoryAutoFillMap can reuse the
// same constant — Codex adversarial review 2026-05-13 (I-C2) called out
// that the auto-fill map had NO freshness gate while this fetcher did.
export const ML_PREDICTION_FRESHNESS_DAYS = 7;

export async function fetchMlPredictedRates(pid: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const since = new Date();
    since.setDate(since.getDate() - ML_PREDICTION_FRESHNESS_DAYS);

    // ── Filter to predictions from ACTIVE models (May 2026 audit pass-5) ──
    // The MAE-gate fixes deactivate models that fail validation. Their
    // prior predictions (with rates that could be off 10-50x) stay in
    // the table for up to 7 days. Without this filter, deactivated
    // models still feed the reorder list, leading to over-ordering on
    // items the AI just decided it can't predict reliably.
    //
    // Also filters out is_shadow=true rows: shadow models write
    // predictions for comparison only — operators should never see them.
    //
    // Two-query approach because supabase-js doesn't support a true
    // INNER JOIN with WHERE in one round-trip. Fetch the small set of
    // active run IDs first, then filter the prediction stream client-
    // side. At fleet scale this is ~10 IDs per property × 1 query, cheap.
    const { data: activeRuns } = await supabase
      .from('model_runs')
      .select('id')
      .eq('property_id', pid)
      .eq('layer', 'inventory_rate')
      .eq('is_active', true);
    const activeRunIds = new Set((activeRuns ?? []).map((r) => String(r.id)));
    if (activeRunIds.size === 0) return out;  // no active models → no rates

    const { data, error } = await supabase
      .from('inventory_rate_predictions')
      .select('item_id, predicted_daily_rate, predicted_at, model_run_id, is_shadow')
      .eq('property_id', pid)
      .eq('is_shadow', false)
      .gte('predicted_at', since.toISOString())
      .order('predicted_at', { ascending: false })
      .limit(2000);
    if (error || !data) return out;
    // Most-recent first; first hit per item wins (post active-model filter).
    for (const r of data) {
      if (!activeRunIds.has(String(r.model_run_id))) continue;
      const id = String(r.item_id);
      if (out.has(id)) continue;
      const rate = Number(r.predicted_daily_rate);
      if (Number.isFinite(rate) && rate >= 0) out.set(id, rate);
    }
  } catch {
    // Silent fall-through — caller still has the rule-based path.
  }
  return out;
}

// ─── Single-item prediction ────────────────────────────────────────────────

export function predictReorder(
  item: Pick<InventoryItem, 'id' | 'usagePerCheckout' | 'usagePerStayover' | 'reorderLeadDays'>,
  averages: DailyAverages,
  effectiveStock: number,
  overrideDailyRate?: number,
): PredictionResult {
  const perCheckout = item.usagePerCheckout ?? 0;
  const perStayover = item.usagePerStayover ?? 0;
  // ML-learned rate wins when supplied (>= 0 covers items the model genuinely
  // predicts as zero usage). Otherwise fall back to rule-based math.
  const dailyBurnRate = overrideDailyRate !== undefined && overrideDailyRate >= 0
    ? overrideDailyRate
    : averages.avgDailyCheckouts * perCheckout + averages.avgDailyStayovers * perStayover;

  // ML-learned rates are honest at any sample size — the Bayesian posterior
  // already encodes uncertainty. Only the rule-based path needs the
  // MIN_DAYS_OF_DATA gate to avoid noise. Skip the gate when ML rate is in use.
  const usingMlRate = overrideDailyRate !== undefined && overrideDailyRate >= 0;

  // Sample too small to predict honestly (rule-based path only).
  if (!usingMlRate && averages.daysOfData < MIN_DAYS_OF_DATA) {
    return {
      itemId: item.id,
      dailyBurnRate,
      daysUntilOut: null,
      orderByDate: null,
      urgency: 'unknown',
    };
  }

  // No usage rates configured for this item, or zero burn rate (fully
  // unused — e.g., a maintenance item that's never been counted-down).
  // We can't derive a meaningful order-by date.
  if (dailyBurnRate <= 0) {
    return {
      itemId: item.id,
      dailyBurnRate: 0,
      daysUntilOut: null,
      orderByDate: null,
      urgency: 'unknown',
    };
  }

  const daysUntilOut = effectiveStock / dailyBurnRate;
  const leadDays = item.reorderLeadDays ?? DEFAULT_LEAD_DAYS;

  // Clamp at 0 — if we're already past the safe order-by date, the answer
  // is "today, maybe yesterday". Don't show negative day counts.
  const daysFromNowToOrderBy = Math.max(0, daysUntilOut - leadDays);

  const orderByDate = new Date();
  orderByDate.setHours(0, 0, 0, 0);
  orderByDate.setDate(orderByDate.getDate() + Math.floor(daysFromNowToOrderBy));

  // Re-derive the calendar gap so urgency reflects "today is past order-by"
  // instead of "burn rate × stock < 0" (which can bake in fractional noise).
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const calendarDaysToOrderBy =
    (orderByDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24);

  let urgency: PredictionResult['urgency'];
  // Past-due trigger: either we're already behind, OR the order-by would
  // be today AND we're already inside the lead-time window (i.e. daysUntilOut
  // <= leadDays — order today or you'll stock out before delivery).
  if (calendarDaysToOrderBy <= 0 || daysUntilOut <= leadDays) {
    urgency = 'now';
  } else if (calendarDaysToOrderBy <= 7) {
    urgency = 'soon';
  } else {
    urgency = 'ok';
  }

  return {
    itemId: item.id,
    dailyBurnRate,
    daysUntilOut,
    orderByDate,
    urgency,
  };
}

// ─── Batch prediction ──────────────────────────────────────────────────────

export function predictReorders(
  items: InventoryItem[],
  averages: DailyAverages,
  effectiveStockMap?: Map<string, number>,
  mlRateMap?: Map<string, number>,
): PredictionResult[] {
  return items.map(item => {
    const eff = effectiveStockMap?.get(item.id) ?? item.currentStock;
    const override = mlRateMap?.get(item.id);
    return predictReorder(item, averages, eff, override);
  });
}

// ─── Convenience for callers that already have a prediction array ──────────

export function predictionByItem(
  predictions: PredictionResult[],
): Map<string, PredictionResult> {
  const m = new Map<string, PredictionResult>();
  for (const p of predictions) m.set(p.itemId, p);
  return m;
}

// ─── Budget headroom ───────────────────────────────────────────────────────
//
// Pure helper for the Smart Reorder List + accounting view. Given a spend
// total (already aggregated month-to-date) and a budget cap, compute the
// remaining headroom and a fits-in-budget flag for a proposed order.
//
// Returning a record per category keeps the UI loop simple — index by item's
// category to render the badge. Categories without a configured budget show
// up as `budgetCents: null`, which the UI renders as "no budget set".

import type { InventoryCategory } from '@/types';

export interface BudgetStatus {
  category: InventoryCategory;
  budgetCents: number | null;       // null = not configured for this month
  spentCents: number;                // month-to-date
  remainingCents: number | null;     // null when no budget; can go negative
}

export function computeBudgetStatuses(
  spendByCategory: Record<InventoryCategory, number>,           // dollars (numeric)
  budgetByCategory: Partial<Record<InventoryCategory, number>>, // cents
): Record<InventoryCategory, BudgetStatus> {
  const cats: InventoryCategory[] = ['housekeeping', 'maintenance', 'breakfast'];
  const out = {} as Record<InventoryCategory, BudgetStatus>;
  for (const cat of cats) {
    const spent = Math.round((spendByCategory[cat] ?? 0) * 100);
    const budget = budgetByCategory[cat];
    out[cat] = {
      category: cat,
      budgetCents: budget ?? null,
      spentCents: spent,
      remainingCents: budget != null ? budget - spent : null,
    };
  }
  return out;
}

export function fitsInBudget(
  status: BudgetStatus,
  proposedSpendCents: number,
): boolean {
  if (status.remainingCents == null) return true; // no budget configured = no constraint
  return proposedSpendCents <= status.remainingCents;
}
