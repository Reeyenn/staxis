// ═══════════════════════════════════════════════════════════════════════════
// ML cockpit data layer for the INVENTORY tab.
//
// Mirrors the existing ml-stubs.ts (housekeeping) helpers but reads from
// inventory-specific tables: inventory_counts, inventory_rate_predictions,
// model_runs (where layer='inventory_rate'), inventory_rate_priors, and
// app_events (for anomaly history once session 2 wires that up).
//
// All queries are scoped by property_id and rely on RLS via the supabase
// browser client (the signed-in user's JWT). The owner gate on the admin ML surface is
// enforced at the page level.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase, logErr } from './_common';
import { ML_PREDICTION_FRESHNESS_DAYS } from '../inventory-predictions';

/**
 * Per-item map for the auto-fill feature. The inventory page reads this to
 * decide whether to pre-fill the count input. Plus the predicted_current_stock
 * to use as the pre-fill value.
 *
 * Returns rows ONLY for items where:
 *   - The active model_runs row has auto_fill_enabled=true (mode='auto'), OR
 *   - The property's inventory_ai_mode='always-on' AND there's any prediction.
 *
 * Caller passes the property's inventory_ai_mode so we can short-circuit when
 * mode='off'.
 */
export interface AutoFillItem {
  itemId: string;
  predictedCurrentStock: number;
  /** Lower bound of the decayed stock band (faster-burn p75 rate × hours).
   *  Codex post-merge review 2026-05-13 (M-5/M-6): the point estimate
   *  alone hides uncertainty that grows with time-since-prediction. UI
   *  can render `predictedCurrentStockLow..predictedCurrentStockHigh`
   *  as a confidence band that widens as the prediction ages. Omitted
   *  for back-compat when the prediction row has no p25/p75 columns. */
  predictedCurrentStockLow?: number;
  /** Upper bound of the decayed stock band (slower-burn p25 rate × hours). */
  predictedCurrentStockHigh?: number;
  algorithm: string | null;
  graduated: boolean;            // true = passed all 3 graduation gates
}

/**
 * Minimal client surface this function uses — for dependency-injecting
 * supabaseAdmin from server-side callers (e.g. doctor's
 * inventory_auto_fill_shape check). Default is the browser/anon client
 * used by the inventory page. Codex follow-up 2026-05-13 (A3): the
 * doctor was hitting RLS-protected tables with the anon client → no
 * rows visible from a server context → silent ok-skip on the Phase 1
 * shape check. Allow admin client injection so the doctor can verify
 * the actual prod shape.
 */
/**
 * Minimal client surface this function uses — for dependency-injecting
 * supabaseAdmin from server-side callers (e.g. doctor's
 * inventory_auto_fill_shape check). Default is the browser/anon client
 * used by the inventory page.
 *
 * Codex round-3 review 2026-05-13 (E4): use PromiseLike instead of
 * Promise so supabase's PostgrestFilterBuilder (thenable, not a real
 * Promise) matches structurally without an `as unknown as any` cast
 * at the doctor call site. The cast was hiding the boundary that
 * matters most.
 */
export interface AutoFillReadClient {
  from(table: 'inventory_rate_predictions' | 'model_runs'): {
    select(cols: string): {
      eq(col: string, val: unknown): {
        gte(col: string, val: unknown): {
          order(col: string, opts: { ascending: boolean }): {
            limit(n: number): PromiseLike<{ data: unknown; error: unknown }>;
          };
        };
      };
      in(col: string, vals: string[]): PromiseLike<{ data: unknown; error: unknown }>;
    };
  };
}

export async function getInventoryAutoFillMap(
  pid: string,
  mode: 'off' | 'auto' | 'always-on',
  client: AutoFillReadClient = supabase as unknown as AutoFillReadClient,
): Promise<AutoFillItem[]> {
  if (mode === 'off') return [];

  // Codex adversarial review 2026-05-13:
  //   (I-C2) Apply freshness gate — match the 7-day window used by
  //          fetchMlPredictedRates so a stale cron doesn't surface
  //          60-day-old predictions as "high confidence".
  //   (I-C1) Also fetch predicted_daily_rate + predicted_at so we can
  //          time-decay the auto-fill value (predicted_current_stock
  //          is snapshot-at-cron, not snapshot-at-now).
  const sinceMs = Date.now() - ML_PREDICTION_FRESHNESS_DAYS * 86400_000;
  const sinceIso = new Date(sinceMs).toISOString();

  // NOTE (2026-07-18 review): .limit(2000) exceeds PostgREST's 1000-row
  // response cap, but this function currently has ZERO callers (the manual
  // inventory tab dropped auto-fill) — page with @/lib/supabase-paginate
  // before wiring it back into a UI.
  const predResp = await client
    .from('inventory_rate_predictions')
    .select('item_id,predicted_current_stock,predicted_daily_rate,predicted_daily_rate_p25,predicted_daily_rate_p75,model_run_id,predicted_at')
    .eq('property_id', pid)
    .gte('predicted_at', sinceIso)
    .order('predicted_at', { ascending: false })
    .limit(2000);
  const predData = predResp.data as Array<Record<string, unknown>> | null;
  const predErr = predResp.error;
  if (predErr) {
    logErr('getInventoryAutoFillMap pred', predErr);
    return [];
  }
  const latestByItem = new Map<string, Record<string, unknown>>();
  for (const r of predData ?? []) {
    const key = String(r.item_id);
    if (!latestByItem.has(key)) latestByItem.set(key, r as Record<string, unknown>);
  }
  if (latestByItem.size === 0) return [];

  const runIds = Array.from(new Set(Array.from(latestByItem.values()).map((p) => String(p.model_run_id))));
  const runsResp = await client
    .from('model_runs')
    .select('id,auto_fill_enabled,algorithm,is_active')
    .in('id', runIds);
  const runsData = runsResp.data as Array<Record<string, unknown>> | null;
  const runsErr = runsResp.error;
  if (runsErr) {
    logErr('getInventoryAutoFillMap runs', runsErr);
    return [];
  }
  const runById = new Map<string, Record<string, unknown>>();
  for (const r of runsData ?? []) runById.set(String(r.id), r as Record<string, unknown>);

  const nowMs = Date.now();
  const out: AutoFillItem[] = [];
  for (const [itemId, p] of latestByItem.entries()) {
    const run = runById.get(String(p.model_run_id));
    if (!run) continue;
    const graduated = !!run.auto_fill_enabled;
    if (mode === 'auto' && !graduated) continue;        // only graduated items in auto mode
    if (mode === 'always-on' && !run.is_active) continue;
    const predStock = p.predicted_current_stock !== null && p.predicted_current_stock !== undefined
      ? Number(p.predicted_current_stock)
      : null;
    if (predStock === null) continue;

    // Time-decay since prediction. predicted_daily_rate is per-item per-day
    // total consumption (see ml-service/src/inference/inventory_rate.py:229).
    // Subtract `rate * hours_since / 24` from the snapshot value, clamp at 0.
    //
    // Codex post-merge review 2026-05-13 (F11a): apply a 48-hour hard cap.
    // The 7-day freshness gate above means anything past 7 days is already
    // excluded, but by 48 hours the decay-by-point-estimate has
    // accumulated enough uncertainty (p10-p90 range × hours) that
    // showing the value with the "high confidence" graduated pip is
    // misleading. Drop the item from auto-fill — manager counts manually.
    const HOURS_DECAY_HARD_CAP = 48;
    const predictedAt = typeof p.predicted_at === 'string' ? new Date(p.predicted_at).getTime() : nowMs;
    const hoursSince = Math.max(0, (nowMs - predictedAt) / 3_600_000);
    if (hoursSince > HOURS_DECAY_HARD_CAP) {
      continue;
    }
    // Codex post-merge review 2026-05-13 (M-5/M-6): decay all three rate
    // quantiles so the UI can render a confidence band, not just the
    // point estimate. Faster burn (p75) → lower stock left = decayedLow.
    // Slower burn (p25) → higher stock left = decayedHigh. The band
    // widens with hoursSince (an old prediction has more uncertainty).
    // Falls back to the p50 rate when p25/p75 columns are null (legacy
    // predictions before quantile columns landed).
    const decayHours = hoursSince / 24;
    const rateP50 = p.predicted_daily_rate !== null && p.predicted_daily_rate !== undefined
      ? Number(p.predicted_daily_rate) : 0;
    const rateP25 = p.predicted_daily_rate_p25 !== null && p.predicted_daily_rate_p25 !== undefined
      ? Number(p.predicted_daily_rate_p25) : rateP50;
    const rateP75 = p.predicted_daily_rate_p75 !== null && p.predicted_daily_rate_p75 !== undefined
      ? Number(p.predicted_daily_rate_p75) : rateP50;
    const decayed     = Math.max(0, predStock - rateP50 * decayHours);
    const decayedHigh = Math.max(0, predStock - rateP25 * decayHours);  // slow burn → more left
    const decayedLow  = Math.max(0, predStock - rateP75 * decayHours);  // fast burn → less left

    out.push({
      itemId,
      predictedCurrentStockLow:  decayedLow,
      predictedCurrentStockHigh: decayedHigh,
      predictedCurrentStock: decayed,
      algorithm: typeof run.algorithm === 'string' ? run.algorithm : null,
      graduated,
    });
  }
  return out;
}

