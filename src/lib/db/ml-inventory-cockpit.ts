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

export interface InventoryDataFuelStats {
  totalCounts: number;
  last7d: number;
  last24h: number;
  itemsTracked: number;
  daysOfHistory: number;
}

export interface InventoryDailyCountRow {
  date: string;       // 'MM-DD'
  recorded: number;   // inventory_counts rows on this date
}

export interface InventoryItemModelStatus {
  itemId: string;
  itemName: string;
  algorithm: string | null;        // 'bayesian' | 'xgboost-quantile' | null when no model yet
  modelVersion: string | null;
  trainingRowCount: number;        // 0 when no model
  validationMae: number | null;
  beatsBaselinePct: number | null;
  isActive: boolean;
  autoFillEnabled: boolean;
  autoFillEnabledAt: string | null;
  consecutivePassingRuns: number;
  trainedAt: string | null;
  countsTotal: number;             // event count for this item — drives graduation gate
}

export interface InventoryTodayPrediction {
  itemId: string;
  itemName: string;
  predictedDailyRate: number;
  predictedCurrentStock: number | null;
  currentStockReported: number | null;
  varianceFromReported: number | null;
  daysUntilOutEstimate: number | null;
  modelAlgorithm: string | null;
  predictedAt: string;
}

export interface InventoryPipelineHealth {
  lastTrainingRunAt: Date | null;
  lastInferenceWriteAt: Date | null;
  lastAnomalyFiredAt: Date | null;
  activeItemCount: number;
  predictionsLast24h: number;
}

export interface InventoryAnomalyRow {
  id: string;
  itemId: string | null;
  itemName: string;
  reason: string;
  severity: 'info' | 'warn' | 'critical';
  ts: string;
}

export interface InventoryAdoptionRow {
  countedBy: string;
  countCount: number;
  itemsTouched: number;
  lastCountedAt: string | null;
}

export interface InventoryShadowMAEPoint {
  date: string;        // 'MM-DD'
  itemName: string;
  mae: number;
  n: number;
}

export interface InventoryGraduationStatusRow {
  itemId: string;
  itemName: string;
  events: number;
  maeRatio: number | null;
  consecutivePasses: number;
  graduated: boolean;
}

export interface ItemCanonicalNameRow {
  itemId: string;
  itemName: string;
  itemCanonicalName: string;
}

const isoMinus = (days: number) => new Date(Date.now() - days * 86400000).toISOString();
const dateOnlyMinus = (days: number) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

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
 * Per-day count event volume for the activity chart. N most-recent days,
 * oldest first; days with zero events get a 0 row so the x-axis stays
 * continuous.
 */
export async function getInventoryCountsPerDay(pid: string, days: number): Promise<InventoryDailyCountRow[]> {
  const since = isoMinus(days);
  const { data, error } = await supabase
    .from('inventory_counts')
    .select('counted_at')
    .eq('property_id', pid)
    .gte('counted_at', since)
    .limit(100000);
  if (error) {
    logErr('getInventoryCountsPerDay', error);
    return [];
  }
  const buckets = new Map<string, number>();
  for (const r of data ?? []) {
    if (!r.counted_at) continue;
    const day = String(r.counted_at).slice(0, 10);
    buckets.set(day, (buckets.get(day) ?? 0) + 1);
  }
  const out: InventoryDailyCountRow[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const iso = d.toISOString().slice(0, 10);
    out.push({ date: iso.slice(5), recorded: buckets.get(iso) ?? 0 });
  }
  return out;
}

/**
 * Per-item model status for the LayerStatusPanel / GraduationStatusPanel.
 * Lists every inventory item in the property with its active model_runs row
 * (or nulls when no model exists yet) and its count-event total.
 */
export async function getInventoryItemModelStatuses(
  pid: string,
  limit = 200,
): Promise<InventoryItemModelStatus[]> {
  const [itemsRes, runsRes, countsRes] = await Promise.all([
    supabase.from('inventory').select('id,name').eq('property_id', pid).limit(limit),
    supabase
      .from('model_runs')
      .select('item_id,algorithm,model_version,training_row_count,validation_mae,beats_baseline_pct,is_active,auto_fill_enabled,auto_fill_enabled_at,consecutive_passing_runs,trained_at')
      .eq('property_id', pid)
      .eq('layer', 'inventory_rate')
      .eq('is_active', true)
      .limit(2000),
    supabase
      .from('inventory_counts')
      .select('item_id')
      .eq('property_id', pid)
      .limit(100000),
  ]);

  if (itemsRes.error) {
    logErr('getInventoryItemModelStatuses items', itemsRes.error);
    return [];
  }

  const runByItem = new Map<string, Record<string, unknown>>();
  for (const r of runsRes.data ?? []) {
    if (r.item_id) runByItem.set(r.item_id, r as Record<string, unknown>);
  }
  const countsByItem = new Map<string, number>();
  for (const r of countsRes.data ?? []) {
    if (r.item_id) countsByItem.set(r.item_id, (countsByItem.get(r.item_id) ?? 0) + 1);
  }

  return (itemsRes.data ?? []).map((item) => {
    const run = runByItem.get(item.id) ?? null;
    return {
      itemId: item.id,
      itemName: item.name,
      algorithm: run ? String(run.algorithm ?? '') : null,
      modelVersion: run ? String(run.model_version ?? '') : null,
      trainingRowCount: run ? Number(run.training_row_count ?? 0) : 0,
      validationMae: run && run.validation_mae !== null && run.validation_mae !== undefined
        ? Number(run.validation_mae)
        : null,
      beatsBaselinePct: run && run.beats_baseline_pct !== null && run.beats_baseline_pct !== undefined
        ? Number(run.beats_baseline_pct)
        : null,
      isActive: !!(run && run.is_active),
      autoFillEnabled: !!(run && run.auto_fill_enabled),
      autoFillEnabledAt: run && run.auto_fill_enabled_at ? String(run.auto_fill_enabled_at) : null,
      consecutivePassingRuns: run ? Number(run.consecutive_passing_runs ?? 0) : 0,
      trainedAt: run && run.trained_at ? String(run.trained_at) : null,
      countsTotal: countsByItem.get(item.id) ?? 0,
    };
  });
}

/**
 * Most-recent prediction for each item, paired with the current reported stock.
 * Powers the "Today's Predictions" table.
 */
export async function getInventoryTodaysPredictions(
  pid: string,
  limit = 100,
): Promise<InventoryTodayPrediction[]> {
  const [predRes, itemsRes] = await Promise.all([
    supabase
      .from('inventory_rate_predictions')
      .select('item_id,item_name,predicted_daily_rate,predicted_current_stock,predicted_at,model_run_id')
      .eq('property_id', pid)
      .order('predicted_at', { ascending: false })
      .limit(2000),
    supabase
      .from('inventory')
      .select('id,name,current_stock')
      .eq('property_id', pid)
      .limit(limit),
  ]);

  if (predRes.error) {
    logErr('getInventoryTodaysPredictions pred', predRes.error);
    return [];
  }
  const byItem = new Map<string, Record<string, unknown>>();
  for (const r of predRes.data ?? []) {
    const key = String(r.item_id);
    if (!byItem.has(key)) byItem.set(key, r as Record<string, unknown>); // first = most recent because order desc
  }

  const itemMap = new Map<string, { name: string; stock: number }>();
  for (const item of itemsRes.data ?? []) {
    itemMap.set(item.id, { name: item.name, stock: Number(item.current_stock ?? 0) });
  }

  // Algorithm lookup for the active model_run
  const runIds = Array.from(new Set(Array.from(byItem.values()).map((p) => String(p.model_run_id))));
  const algoByRun = new Map<string, string>();
  if (runIds.length > 0) {
    const algoRes = await supabase
      .from('model_runs')
      .select('id,algorithm')
      .in('id', runIds);
    for (const r of algoRes.data ?? []) {
      algoByRun.set(r.id, r.algorithm ?? '');
    }
  }

  const out: InventoryTodayPrediction[] = [];
  for (const [itemId, p] of byItem.entries()) {
    const item = itemMap.get(itemId);
    const predRate = Number(p.predicted_daily_rate ?? 0);
    const predStock = p.predicted_current_stock !== null && p.predicted_current_stock !== undefined
      ? Number(p.predicted_current_stock)
      : null;
    const reportedStock = item?.stock ?? null;
    const variance = predStock !== null && reportedStock !== null
      ? Math.round((reportedStock - predStock) * 100) / 100
      : null;
    const daysUntilOut = predRate > 0 && reportedStock !== null
      ? Math.round((reportedStock / predRate) * 10) / 10
      : null;
    out.push({
      itemId,
      itemName: String(p.item_name ?? item?.name ?? ''),
      predictedDailyRate: predRate,
      predictedCurrentStock: predStock,
      currentStockReported: reportedStock,
      varianceFromReported: variance,
      daysUntilOutEstimate: daysUntilOut,
      modelAlgorithm: algoByRun.get(String(p.model_run_id)) ?? null,
      predictedAt: String(p.predicted_at ?? ''),
    });
  }
  // Sort by daysUntilOut ascending (most-urgent first), nulls last
  out.sort((a, b) => {
    if (a.daysUntilOutEstimate === null && b.daysUntilOutEstimate === null) return 0;
    if (a.daysUntilOutEstimate === null) return 1;
    if (b.daysUntilOutEstimate === null) return -1;
    return a.daysUntilOutEstimate - b.daysUntilOutEstimate;
  });
  return out.slice(0, limit);
}

/**
 * Pipeline freshness summary.
 */
export async function getInventoryPipelineHealth(pid: string): Promise<InventoryPipelineHealth> {
  const [trainRes, predRes, anomalyRes, activeCountRes, predLast24Res] = await Promise.all([
    supabase
      .from('model_runs')
      .select('trained_at')
      .eq('property_id', pid)
      .eq('layer', 'inventory_rate')
      .order('trained_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('inventory_rate_predictions')
      .select('predicted_at')
      .eq('property_id', pid)
      .order('predicted_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('app_events')
      .select('ts')
      .eq('property_id', pid)
      .eq('event_type', 'inventory_anomaly')
      .order('ts', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('model_runs')
      .select('id', { count: 'exact', head: true })
      .eq('property_id', pid)
      .eq('layer', 'inventory_rate')
      .eq('is_active', true),
    supabase
      .from('inventory_rate_predictions')
      .select('id', { count: 'exact', head: true })
      .eq('property_id', pid)
      .gte('predicted_at', isoMinus(1)),
  ]);
  return {
    lastTrainingRunAt: trainRes.data?.trained_at ? new Date(trainRes.data.trained_at) : null,
    lastInferenceWriteAt: predRes.data?.predicted_at ? new Date(predRes.data.predicted_at) : null,
    lastAnomalyFiredAt: anomalyRes.data?.ts ? new Date(anomalyRes.data.ts) : null,
    activeItemCount: activeCountRes.count ?? 0,
    predictionsLast24h: predLast24Res.count ?? 0,
  };
}

/**
 * Recent inventory_anomaly app_events for the cockpit. Empty until session 2
 * wires up anomaly detection.
 */
export async function getInventoryAnomalies(pid: string, limit = 20): Promise<InventoryAnomalyRow[]> {
  const { data, error } = await supabase
    .from('app_events')
    .select('id,event_type,metadata,ts')
    .eq('property_id', pid)
    .eq('event_type', 'inventory_anomaly')
    .order('ts', { ascending: false })
    .limit(limit);
  if (error) {
    logErr('getInventoryAnomalies', error);
    return [];
  }
  return (data ?? []).map((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    return {
      id: r.id,
      itemId: typeof meta.item_id === 'string' ? meta.item_id : null,
      itemName: typeof meta.item_name === 'string' ? meta.item_name : '(item)',
      reason: typeof meta.reason === 'string' ? meta.reason : '',
      severity: (typeof meta.severity === 'string' && ['info', 'warn', 'critical'].includes(meta.severity))
        ? (meta.severity as 'info' | 'warn' | 'critical')
        : 'warn',
      ts: r.ts,
    };
  });
}

/**
 * Per-staff (or per-counted_by name) adoption stats — who's actually counting?
 */
export async function getInventoryAdoption(pid: string, days: number): Promise<InventoryAdoptionRow[]> {
  const { data, error } = await supabase
    .from('inventory_counts')
    .select('counted_by,item_id,counted_at')
    .eq('property_id', pid)
    .gte('counted_at', isoMinus(days))
    .limit(50000);
  if (error) {
    logErr('getInventoryAdoption', error);
    return [];
  }
  const byUser = new Map<string, { count: number; items: Set<string>; latest: string | null }>();
  for (const r of data ?? []) {
    const who = r.counted_by ?? '(unknown)';
    if (!byUser.has(who)) byUser.set(who, { count: 0, items: new Set(), latest: null });
    const entry = byUser.get(who)!;
    entry.count += 1;
    if (r.item_id) entry.items.add(r.item_id);
    if (!entry.latest || (r.counted_at && r.counted_at > entry.latest)) entry.latest = r.counted_at;
  }
  return Array.from(byUser.entries())
    .map(([countedBy, e]) => ({
      countedBy,
      countCount: e.count,
      itemsTouched: e.items.size,
      lastCountedAt: e.latest,
    }))
    .sort((a, b) => b.countCount - a.countCount);
}

/**
 * Rolling daily MAE per item from prediction_log (where layer='inventory_rate').
 * Used by the InventoryShadowMAEChart. Empty until session 2 starts pairing
 * predictions with actuals.
 */
export async function getInventoryRollingMAE(
  pid: string,
  days: number,
  topItemsByVolume = 5,
): Promise<InventoryShadowMAEPoint[]> {
  const since = isoMinus(days);
  const { data, error } = await supabase
    .from('prediction_log')
    .select('predicted_value,actual_value,logged_at,prediction_id')
    .eq('property_id', pid)
    .eq('layer', 'inventory_rate')
    .gte('logged_at', since)
    .not('actual_value', 'is', null)
    .limit(50000);
  if (error) {
    logErr('getInventoryRollingMAE', error);
    return [];
  }
  // Lookup item_name via the prediction_id → inventory_rate_predictions
  const predIds = Array.from(new Set((data ?? []).map((r) => r.prediction_id).filter((x): x is string => !!x)));
  const itemMap = new Map<string, string>();
  if (predIds.length > 0) {
    const predRes = await supabase
      .from('inventory_rate_predictions')
      .select('id,item_name,item_id')
      .in('id', predIds);
    for (const r of predRes.data ?? []) {
      itemMap.set(r.id, r.item_name ?? r.item_id ?? 'item');
    }
  }
  // Volume by item to pick top N
  const volumeByItem = new Map<string, number>();
  for (const r of data ?? []) {
    const name = itemMap.get(String(r.prediction_id)) ?? 'item';
    volumeByItem.set(name, (volumeByItem.get(name) ?? 0) + 1);
  }
  const topItems = new Set(
    Array.from(volumeByItem.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topItemsByVolume)
      .map(([name]) => name),
  );
  const buckets = new Map<string, { sum: number; n: number }>();
  for (const r of data ?? []) {
    const name = itemMap.get(String(r.prediction_id)) ?? 'item';
    if (!topItems.has(name)) continue;
    if (r.predicted_value === null || r.actual_value === null || !r.logged_at) continue;
    const day = String(r.logged_at).slice(0, 10);
    const key = `${name}|${day}`;
    const b = buckets.get(key) ?? { sum: 0, n: 0 };
    b.sum += Math.abs(Number(r.predicted_value) - Number(r.actual_value));
    b.n += 1;
    buckets.set(key, b);
  }
  return Array.from(buckets.entries())
    .map(([key, b]) => {
      const [name, day] = key.split('|');
      return { date: day.slice(5), itemName: name, mae: b.n > 0 ? b.sum / b.n : 0, n: b.n };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
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
  algorithm: string | null;
  graduated: boolean;            // true = passed all 3 graduation gates
}

export async function getInventoryAutoFillMap(
  pid: string,
  mode: 'off' | 'auto' | 'always-on',
): Promise<AutoFillItem[]> {
  if (mode === 'off') return [];

  // Fetch most-recent prediction per item
  const { data: predData, error: predErr } = await supabase
    .from('inventory_rate_predictions')
    .select('item_id,predicted_current_stock,model_run_id,predicted_at')
    .eq('property_id', pid)
    .order('predicted_at', { ascending: false })
    .limit(2000);
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
  const { data: runsData, error: runsErr } = await supabase
    .from('model_runs')
    .select('id,auto_fill_enabled,algorithm,is_active')
    .in('id', runIds);
  if (runsErr) {
    logErr('getInventoryAutoFillMap runs', runsErr);
    return [];
  }
  const runById = new Map<string, Record<string, unknown>>();
  for (const r of runsData ?? []) runById.set(r.id, r as Record<string, unknown>);

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
    out.push({
      itemId,
      predictedCurrentStock: predStock,
      algorithm: typeof run.algorithm === 'string' ? run.algorithm : null,
      graduated,
    });
  }
  return out;
}

/**
 * Live status for the AI Helper page on /inventory/ai-helper.
 *
 * Returns:
 *   - daysSinceFirstCount       — how long the AI has been "learning"
 *   - itemsTotal                — total items in inventory
 *   - itemsWithModel            — items that have any active model_runs row
 *   - itemsGraduated            — items with auto_fill_enabled=true
 *   - itemsExpectedToGraduate   — items currently passing 2 of 3 gates
 *   - currentMaeRatio           — average MAE/mean across all active models
 */
export interface InventoryAiStatus {
  aiMode: 'off' | 'auto' | 'always-on';
  daysSinceFirstCount: number;
  itemsTotal: number;
  itemsWithModel: number;
  itemsGraduated: number;
  itemsExpectedToGraduate: number;
  currentMaeRatio: number | null;
  lastInferenceAt: string | null;
}

/**
 * Network-wide cohort summary for the InventoryNetworkHealth panel.
 *
 * Returns:
 *   - cohorts: list of (cohort_key, n_hotels, n_items, prior_strength)
 *   - totalHotels: total hotels across all cohorts
 *   - totalProperties: from properties table
 *   - networkModelActive: true once cohort 'global' has n_hotels >= 5
 *
 * Empty/uninteresting at 1 hotel — but the panel renders so Reeyen can see
 * the infrastructure is in place. Becomes meaningful at ~10+ hotels.
 */
export interface CohortSummaryRow {
  cohortKey: string;
  itemCount: number;
  hotelsContributing: number;
  priorStrength: number;
  source: 'industry-benchmark' | 'cohort-aggregate';
  updatedAt: string;
}

export interface InventoryNetworkSummary {
  totalProperties: number;
  cohorts: CohortSummaryRow[];
  industryBenchmarkItems: number;
  networkModelActive: boolean;
}

export async function getInventoryNetworkSummary(): Promise<InventoryNetworkSummary> {
  const [propsRes, priorsRes] = await Promise.all([
    supabase.from('properties').select('id', { count: 'exact', head: true }),
    supabase
      .from('inventory_rate_priors')
      .select('cohort_key,item_canonical_name,n_hotels_contributing,prior_strength,source,updated_at')
      .limit(2000),
  ]);
  const totalProperties = propsRes.count ?? 0;
  const rows = priorsRes.data ?? [];

  const byCohort = new Map<string, {
    n_hotels: number;
    items: Set<string>;
    strengths: number[];
    sources: Set<string>;
    latest: string;
  }>();
  let industryBenchmarkItems = 0;
  for (const r of rows) {
    const ck = String(r.cohort_key);
    if (r.source === 'industry-benchmark') industryBenchmarkItems += 1;
    if (!byCohort.has(ck)) {
      byCohort.set(ck, { n_hotels: 0, items: new Set(), strengths: [], sources: new Set(), latest: '' });
    }
    const entry = byCohort.get(ck)!;
    entry.n_hotels = Math.max(entry.n_hotels, Number(r.n_hotels_contributing ?? 0));
    entry.items.add(String(r.item_canonical_name));
    entry.strengths.push(Number(r.prior_strength ?? 1.0));
    entry.sources.add(String(r.source ?? 'industry-benchmark'));
    if (!entry.latest || (r.updated_at && r.updated_at > entry.latest)) {
      entry.latest = String(r.updated_at ?? '');
    }
  }

  const cohorts: CohortSummaryRow[] = Array.from(byCohort.entries())
    .map(([cohortKey, e]) => ({
      cohortKey,
      itemCount: e.items.size,
      hotelsContributing: e.n_hotels,
      priorStrength: e.strengths.length > 0
        ? e.strengths.reduce((s, v) => s + v, 0) / e.strengths.length
        : 1.0,
      source: e.sources.has('cohort-aggregate') ? 'cohort-aggregate' as const : 'industry-benchmark' as const,
      updatedAt: e.latest,
    }))
    .sort((a, b) => b.hotelsContributing - a.hotelsContributing);

  // 'Network model active' = global cohort with n_hotels >= 5 (i.e. real data
  // beats the industry-benchmark seeds). Until then we run on seeds + local data.
  const globalCohort = cohorts.find((c) => c.cohortKey === 'global');
  const networkModelActive = !!globalCohort && globalCohort.hotelsContributing >= 5
    && globalCohort.source === 'cohort-aggregate';

  return {
    totalProperties,
    cohorts,
    industryBenchmarkItems,
    networkModelActive,
  };
}

export async function getInventoryAiStatus(pid: string): Promise<InventoryAiStatus> {
  const [propRes, countRes, itemsRes, runsRes, predRes] = await Promise.all([
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
      .select('id', { count: 'exact', head: true })
      .eq('property_id', pid),
    supabase
      .from('model_runs')
      .select('item_id,validation_mae,training_mae,auto_fill_enabled,training_row_count,consecutive_passing_runs')
      .eq('property_id', pid)
      .eq('layer', 'inventory_rate')
      .eq('is_active', true)
      .limit(2000),
    supabase
      .from('inventory_rate_predictions')
      .select('predicted_at')
      .eq('property_id', pid)
      .order('predicted_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const aiMode = (propRes.data?.inventory_ai_mode ?? 'auto') as 'off' | 'auto' | 'always-on';
  const firstCountAt = countRes.data?.counted_at ? new Date(countRes.data.counted_at).getTime() : null;
  const daysSinceFirstCount = firstCountAt
    ? Math.max(0, Math.floor((Date.now() - firstCountAt) / 86400000))
    : 0;
  const itemsTotal = itemsRes.count ?? 0;
  const runs = runsRes.data ?? [];
  const itemsWithModel = runs.length;
  const itemsGraduated = runs.filter((r) => r.auto_fill_enabled).length;
  const itemsExpectedToGraduate = runs.filter((r) => {
    if (r.auto_fill_enabled) return false;
    const passes = Number(r.consecutive_passing_runs ?? 0);
    const enough = Number(r.training_row_count ?? 0) >= 30;
    return passes >= 3 || enough;     // close to graduating
  }).length;

  let currentMaeRatio: number | null = null;
  const ratios: number[] = [];
  for (const r of runs) {
    const mae = r.validation_mae;
    const trainMae = r.training_mae;
    if (mae !== null && mae !== undefined && trainMae !== null && trainMae !== undefined && Number(trainMae) > 0) {
      ratios.push(Number(mae) / Number(trainMae));
    }
  }
  if (ratios.length > 0) {
    currentMaeRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  }

  return {
    aiMode,
    daysSinceFirstCount,
    itemsTotal,
    itemsWithModel,
    itemsGraduated,
    itemsExpectedToGraduate,
    currentMaeRatio,
    lastInferenceAt: predRes.data?.predicted_at ?? null,
  };
}
