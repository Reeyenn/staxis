/**
 * Server-side pairing helpers + sweep for inventory prediction↔actual pairs.
 *
 * prediction_log pairs are normally written by /api/inventory/post-count-process,
 * which the CountSheet fires-and-forgets after saving counts. A closed tab, bad
 * hotel wifi, or a mid-request sign-out silently loses that call — and every
 * lost pair is graduation evidence the AI never gets credit for. The sweep runs
 * inside the daily predict cron and back-writes any missing pairs from the last
 * SWEEP_LOOKBACK_DAYS.
 *
 * Both writers MUST produce byte-equivalent pairs, so the pieces that determine
 * pair identity live here and are shared:
 *   • fetchWindowPredictions — the daily-prediction query + mapping
 *   • insertFreshPairs        — the row shape + dedup + conflict-safe write
 * The pure window math lives in lib/inventory-window-pairing.
 *
 * Idempotent two ways: an inventory_count_id that already has a pair is skipped
 * up front, and the final write is an ON CONFLICT DO NOTHING upsert on the
 * prediction_log natural key (property_id, layer, prediction_id, model_run_id —
 * migration 0159). A plain insert here would fail the WHOLE batch when the
 * count-time route and the sweep race past each other's recheck, or when a
 * legacy pre-rework row already holds the same natural key.
 *
 * Server-only (imports supabaseAdmin) — call from API routes / cron routes.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  buildWindowPairs,
  localDateOf,
  type CountWindow,
  type DailyPrediction,
  type WindowPair,
} from '@/lib/inventory-window-pairing';
import { log } from '@/lib/log';

const SWEEP_LOOKBACK_DAYS = 14;

// Upper bound on daily-prediction rows per fetch. Without an explicit limit
// PostgREST silently truncates at its default cap and the window means get
// computed from an arbitrary subset — worse than failing. 20k covers ~80
// items × 60-day windows four times over.
const PREDICTION_FETCH_LIMIT = 20000;

/**
 * Daily predictions covering (minDate, maxDate] for the given items — the
 * shared query both pair-writers use. Returns null on fetch error (callers
 * treat that as "no evidence this run", never a partial pair).
 */
export async function fetchWindowPredictions(args: {
  propertyId: string;
  itemIds: string[];
  minDate: string;
  maxDate: string;
  requestId: string;
}): Promise<DailyPrediction[] | null> {
  const { propertyId, itemIds, minDate, maxDate, requestId } = args;
  const { data, error } = await supabaseAdmin
    .from('inventory_rate_predictions')
    .select('id,item_id,predicted_daily_rate,model_run_id,predicted_for_date,predicted_at')
    .eq('property_id', propertyId)
    .eq('is_shadow', false)
    .in('item_id', itemIds)
    .gt('predicted_for_date', minDate)
    .lte('predicted_for_date', maxDate)
    .order('predicted_for_date', { ascending: true })
    .limit(PREDICTION_FETCH_LIMIT);
  if (error) {
    log.warn('inventory-pairing: prediction fetch failed', { requestId, propertyId, err: error });
    return null;
  }
  if ((data ?? []).length >= PREDICTION_FETCH_LIMIT) {
    // Should be unreachable at current catalog sizes; if it ever trips we
    // want a loud signal, not silently-biased window means.
    log.error('inventory-pairing: prediction fetch hit its row cap — window means may be incomplete', {
      requestId, propertyId, cap: PREDICTION_FETCH_LIMIT,
    });
  }
  return (data ?? []).map((p) => ({
    id: String(p.id),
    itemId: String(p.item_id),
    date: String(p.predicted_for_date),
    rate: Number(p.predicted_daily_rate),
    modelRunId: String(p.model_run_id),
    predictedAt: String(p.predicted_at),
  }));
}

/**
 * Write pairs to prediction_log: skip counts that already have a pair, then
 * upsert with ignoreDuplicates so a natural-key collision no-ops that row
 * instead of failing the batch. Returns how many rows actually landed
 * (best-effort — a post-upsert count isn't worth a third query; collisions
 * are rare and only ever subtract).
 */
export async function insertFreshPairs(args: {
  propertyId: string;
  pairs: WindowPair[];
  requestId: string;
}): Promise<number> {
  const { propertyId, pairs, requestId } = args;
  if (pairs.length === 0) return 0;

  const { data: existingPairs, error: existErr } = await supabaseAdmin
    .from('prediction_log')
    .select('inventory_count_id')
    .eq('property_id', propertyId)
    .eq('layer', 'inventory_rate')
    .in('inventory_count_id', pairs.map((p) => p.newerCountId));
  if (existErr) {
    log.warn('inventory-pairing: paired recheck failed', { requestId, propertyId, err: existErr });
    return 0;
  }
  const alreadyPaired = new Set((existingPairs ?? []).map((r) => String(r.inventory_count_id)));
  const nowIso = new Date().toISOString();
  const rows = pairs
    .filter((p) => !alreadyPaired.has(p.newerCountId))
    .map((p) => ({
      property_id: propertyId,
      layer: 'inventory_rate',
      prediction_id: p.predictionId,
      inventory_count_id: p.newerCountId,
      date: p.newerLocalDate,
      predicted_value: p.predictedRate,
      actual_value: p.observedRate,
      model_run_id: p.modelRunId,
      logged_at: nowIso,
    }));
  if (rows.length === 0) return 0;

  const { error: upErr } = await supabaseAdmin
    .from('prediction_log')
    .upsert(rows, {
      onConflict: 'property_id,layer,prediction_id,model_run_id',
      ignoreDuplicates: true,
    });
  if (upErr) {
    log.warn('inventory-pairing: pair upsert failed', { requestId, propertyId, err: upErr });
    return 0;
  }
  return rows.length;
}

export interface SweepResult {
  scanned: number;
  alreadyPaired: number;
  paired: number;
  skippedNoWindow: number;
}

export async function sweepUnpairedCounts(
  propertyId: string,
  timezone: string,
  requestId: string,
): Promise<SweepResult> {
  const result: SweepResult = { scanned: 0, alreadyPaired: 0, paired: 0, skippedNoWindow: 0 };

  const sinceIso = new Date(Date.now() - SWEEP_LOOKBACK_DAYS * 86400000).toISOString();

  // Recent counts that could need a pair.
  const { data: countRows, error: countErr } = await supabaseAdmin
    .from('inventory_counts')
    .select('id,item_id,item_name,counted_at')
    .eq('property_id', propertyId)
    .gte('counted_at', sinceIso)
    .order('counted_at', { ascending: false })
    .limit(5000);
  if (countErr || !countRows) {
    log.warn('pairing-sweep: counts fetch failed', { requestId, propertyId, err: countErr });
    return result;
  }
  const recent = countRows as Array<{ id: string; item_id: string; item_name: string; counted_at: string }>;
  result.scanned = recent.length;
  if (recent.length === 0) return result;

  // Which already have a pair?
  const { data: pairedRows, error: pairedErr } = await supabaseAdmin
    .from('prediction_log')
    .select('inventory_count_id')
    .eq('property_id', propertyId)
    .eq('layer', 'inventory_rate')
    .in('inventory_count_id', recent.map((c) => c.id));
  if (pairedErr) {
    log.warn('pairing-sweep: paired lookup failed', { requestId, propertyId, err: pairedErr });
    return result;
  }
  const paired = new Set((pairedRows ?? []).map((r) => String(r.inventory_count_id)));
  const unpaired = recent.filter((c) => !paired.has(c.id));
  result.alreadyPaired = recent.length - unpaired.length;
  if (unpaired.length === 0) return result;

  // Window bounds + observed rate come from the SAME view row (migration
  // 0293): older_counted_at/newer_counted_at are the exact span the view's
  // observed_rate was computed over, including its (counted_at, id)
  // tie-break for same-instant counts. Re-deriving the predecessor in JS
  // (the first version of this sweep) could pick a DIFFERENT window than
  // the one the actual describes — the view is the single source of truth.
  const { data: rateRows, error: rateErr } = await supabaseAdmin
    .from('inventory_observed_rate_v')
    .select('newer_count_id, observed_rate, older_counted_at, newer_counted_at')
    .in('newer_count_id', unpaired.map((c) => c.id));
  if (rateErr) {
    log.warn('pairing-sweep: observed-rate view failed', { requestId, propertyId, err: rateErr });
    return result;
  }
  const viewByCountId = new Map(
    (rateRows ?? []).map((r) => [String(r.newer_count_id), {
      observedRate: Number(r.observed_rate ?? 0),
      olderAt: String(r.older_counted_at ?? ''),
      newerAt: String(r.newer_counted_at ?? ''),
    }]),
  );

  const windows: CountWindow[] = [];
  for (const c of unpaired) {
    const v = viewByCountId.get(c.id);
    if (!v || !v.olderAt || !v.newerAt) { result.skippedNoWindow += 1; continue; }
    const olderLocalDate = localDateOf(v.olderAt, timezone);
    const newerLocalDate = localDateOf(v.newerAt, timezone);
    if (!olderLocalDate || !newerLocalDate) { result.skippedNoWindow += 1; continue; }
    windows.push({
      itemId: c.item_id,
      itemName: c.item_name,
      newerCountId: c.id,
      olderLocalDate,
      newerLocalDate,
      observedRate: v.observedRate,
    });
  }
  if (windows.length === 0) return result;

  const minDate = windows.reduce((a, w) => (w.olderLocalDate < a ? w.olderLocalDate : a), windows[0].olderLocalDate);
  const maxDate = windows.reduce((a, w) => (w.newerLocalDate > a ? w.newerLocalDate : a), windows[0].newerLocalDate);
  const predictions = await fetchWindowPredictions({
    propertyId,
    itemIds: Array.from(new Set(windows.map((w) => w.itemId))),
    minDate,
    maxDate,
    requestId,
  });
  if (predictions === null) return result;

  const { pairs, skippedLowCoverage } = buildWindowPairs(windows, predictions);
  result.skippedNoWindow += skippedLowCoverage;
  if (pairs.length === 0) return result;

  result.paired = await insertFreshPairs({ propertyId, pairs, requestId });
  if (result.paired > 0) {
    log.info('pairing-sweep: back-wrote missing pairs', {
      requestId, propertyId, paired: result.paired, scanned: result.scanned,
    });
  }
  return result;
}
