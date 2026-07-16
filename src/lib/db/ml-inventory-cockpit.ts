// ═══════════════════════════════════════════════════════════════════════════
// ML cockpit data layer for the INVENTORY tab.
//
// Mirrors the existing ml-stubs.ts (housekeeping) helpers but reads from
// inventory-specific tables: inventory_counts, inventory_rate_predictions,
// model_runs (where layer='inventory_rate'), inventory_rate_priors, and
// app_events (for anomaly history once session 2 wires that up).
//
// All queries are scoped by property_id and rely on RLS via the supabase
// browser client (the signed-in user's JWT). The owner gate on /admin/ml is
// enforced at the page level.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase, logErr } from './_common';
import { ML_PREDICTION_FRESHNESS_DAYS } from '../inventory-predictions';
import {
  activeInventoryItemIds,
  filterInventoryMlRowsToActiveItems,
} from '../inventory-ml-active';

export interface InventoryDataFuelStats {
  totalCounts: number;
  last7d: number;
  last24h: number;
  itemsTracked: number;
  daysOfHistory: number;
}


export interface InventoryPipelineHealth {
  lastTrainingRunAt: Date | null;
  lastInferenceWriteAt: Date | null;
  lastAnomalyFiredAt: Date | null;
  activeItemCount: number;
  predictionsLast24h: number;
}

/**
 * Top-line stats for the Inventory Data Fuel Gauge.
 * Pulls inventory_counts rows for the property and bucket-sorts in JS — same
 * pattern as the housekeeping fuel gauge. Volumes are tiny (one row per
 * item per count event) so this is comfortably under 100k rows.
 */
export async function getInventoryDataFuelStats(pid: string): Promise<InventoryDataFuelStats> {
  const { data, error } = await supabase
    .from('inventory_counts')
    .select('item_id,counted_at')
    .eq('property_id', pid)
    .limit(100000);
  if (error) {
    logErr('getInventoryDataFuelStats', error);
    return { totalCounts: 0, last7d: 0, last24h: 0, itemsTracked: 0, daysOfHistory: 0 };
  }
  const rows = data ?? [];
  const now = Date.now();
  const ms24h = 86400000;
  const ms7d = 7 * ms24h;
  const itemSet = new Set<string>();
  let last24h = 0;
  let last7d = 0;
  let earliestTs = now;
  for (const r of rows) {
    if (r.item_id) itemSet.add(r.item_id);
    const t = r.counted_at ? new Date(r.counted_at).getTime() : 0;
    const age = now - t;
    if (age <= ms24h) last24h++;
    if (age <= ms7d) last7d++;
    if (t > 0 && t < earliestTs) earliestTs = t;
  }
  const daysOfHistory = rows.length > 0
    ? Math.max(1, Math.ceil((now - earliestTs) / ms24h))
    : 0;
  return {
    totalCounts: rows.length,
    last7d,
    last24h,
    itemsTracked: itemSet.size,
    daysOfHistory,
  };
}

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

/**
 * Live status for the AI Helper page on /inventory/ai-helper.
 *
 * Mirror of the /api/inventory/ai-status response shape. Both this function
 * AND the route compute the same fields against the same tables — keep them
 * in lockstep. Honesty-audit Phase 2 (2026-05-22):
 *
 *   - overfitRatio (renamed from currentMaeRatio) — val_mae/train_mae, the
 *     fit-tightness number. NOT the activation gate.
 *   - currentMaeRatioVsMean (new) — val_mae/mean_observed_rate, the TRUE
 *     activation gate ratio. Reads hyperparameters.mean_observed_rate
 *     populated by the trainer (one-line change in inventory_rate.py).
 *     Null for ~7 days after Phase 2 ships until next weekly retrain.
 *   - lastInferenceStale — true when lastInferenceAt > 26h old (one missed
 *     daily cron + 2h grace).
 *   - predictionsLast7Days — count of recent predictions; 0 with
 *     itemsWithModel > 0 indicates probable cron outage.
 *   - currentMaeRatio (deprecated) — alias for overfitRatio, kept one release.
 */
export interface InventoryAiStatus {
  aiMode: 'off' | 'auto' | 'always-on';
  daysSinceFirstCount: number;
  itemsTotal: number;
  itemsWithModel: number;
  itemsGraduated: number;
  itemsExpectedToGraduate: number;
  overfitRatio: number | null;
  currentMaeRatioVsMean: number | null;
  /** @deprecated Use `overfitRatio` instead. Removed after one release. */
  currentMaeRatio: number | null;
  lastInferenceAt: string | null;
  lastInferenceStale: boolean;
  predictionsLast7Days: number;
}

// Honesty-audit Phase 2: keep aligned with src/app/api/inventory/ai-status/route.ts.
const STALE_INFERENCE_HOURS = 26;

export async function getInventoryAiStatus(pid: string): Promise<InventoryAiStatus> {
  const sevenDaysAgoIso = new Date(Date.now() - 7 * 86400000).toISOString();

  const [propRes, countRes, itemsRes, runsRes, predRes, predsLast7Res] = await Promise.all([
    supabase
      .from('properties')
      .select('inventory_ai_mode')
      .eq('id', pid)
      .maybeSingle(),
    supabase
      .from('inventory_counts')
      .select('counted_at')
      .eq('property_id', pid)
      .order('counted_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('inventory')
      .select('id')
      .eq('property_id', pid)
      .is('archived_at', null)
      .limit(2000),
    supabase
      .from('model_runs')
      // Honesty-audit Phase 2: pull `hyperparameters` so the gate-ratio
      // computation can read mean_observed_rate per active run.
      .select('item_id,validation_mae,training_mae,auto_fill_enabled,training_row_count,consecutive_passing_runs,hyperparameters')
      .eq('property_id', pid)
      .eq('layer', 'inventory_rate')
      .eq('is_active', true)
      .limit(2000),
    supabase
      .from('inventory_rate_predictions')
      .select('item_id,predicted_at')
      .eq('property_id', pid)
      .order('predicted_at', { ascending: false })
      .limit(50000),
    // Pull item ids so archived-item predictions can be excluded.
    supabase
      .from('inventory_rate_predictions')
      .select('item_id')
      .eq('property_id', pid)
      .gte('predicted_at', sevenDaysAgoIso)
      .limit(50000),
  ]);

  const aiMode = (propRes.data?.inventory_ai_mode ?? 'auto') as 'off' | 'auto' | 'always-on';
  const firstCountAt = countRes.data?.counted_at ? new Date(countRes.data.counted_at).getTime() : null;
  const daysSinceFirstCount = firstCountAt
    ? Math.max(0, Math.floor((Date.now() - firstCountAt) / 86400000))
    : 0;
  const activeItemIds = activeInventoryItemIds(itemsRes.data ?? []);
  const itemsTotal = activeItemIds.size;
  const runs = filterInventoryMlRowsToActiveItems(runsRes.data ?? [], activeItemIds);
  const itemsWithModel = runs.length;
  const itemsGraduated = runs.filter((r) => r.auto_fill_enabled).length;
  const itemsExpectedToGraduate = runs.filter((r) => {
    if (r.auto_fill_enabled) return false;
    const passes = Number(r.consecutive_passing_runs ?? 0);
    const enough = Number(r.training_row_count ?? 0) >= 30;
    return passes >= 3 || enough;     // close to graduating
  }).length;

  // overfitRatio: val_mae / train_mae (fit-tightness, NOT activation gate).
  let overfitRatio: number | null = null;
  const overfitRatios: number[] = [];
  for (const r of runs) {
    const mae = r.validation_mae;
    const trainMae = r.training_mae;
    if (mae !== null && mae !== undefined && trainMae !== null && trainMae !== undefined && Number(trainMae) > 0) {
      overfitRatios.push(Number(mae) / Number(trainMae));
    }
  }
  if (overfitRatios.length > 0) {
    overfitRatio = overfitRatios.reduce((a, b) => a + b, 0) / overfitRatios.length;
  }

  // currentMaeRatioVsMean: val_mae / mean_observed_rate (the REAL gate).
  let currentMaeRatioVsMean: number | null = null;
  const gateRatios: number[] = [];
  for (const r of runs) {
    const mae = r.validation_mae;
    const hp = (r.hyperparameters ?? null) as Record<string, unknown> | null;
    const meanRaw = hp ? hp.mean_observed_rate : null;
    const mean = typeof meanRaw === 'number' ? meanRaw : Number(meanRaw);
    if (
      mae !== null &&
      mae !== undefined &&
      Number.isFinite(mean) &&
      mean > 1e-9
    ) {
      gateRatios.push(Number(mae) / mean);
    }
  }
  if (gateRatios.length > 0) {
    currentMaeRatioVsMean = gateRatios.reduce((a, b) => a + b, 0) / gateRatios.length;
  }

  const activePredictions = filterInventoryMlRowsToActiveItems(predRes.data ?? [], activeItemIds);
  const lastInferenceAt = activePredictions[0]?.predicted_at ?? null;
  const lastInferenceStale = (() => {
    if (!lastInferenceAt) return true;
    const ageHours = (Date.now() - new Date(lastInferenceAt).getTime()) / 3600000;
    return ageHours > STALE_INFERENCE_HOURS;
  })();
  const predictionsLast7Days = filterInventoryMlRowsToActiveItems(
    predsLast7Res.data ?? [],
    activeItemIds,
  ).length;

  return {
    aiMode,
    daysSinceFirstCount,
    itemsTotal,
    itemsWithModel,
    itemsGraduated,
    itemsExpectedToGraduate,
    overfitRatio,
    currentMaeRatioVsMean,
    currentMaeRatio: overfitRatio,
    lastInferenceAt,
    lastInferenceStale,
    predictionsLast7Days,
  };
}
