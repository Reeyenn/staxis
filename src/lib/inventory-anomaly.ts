// ═══════════════════════════════════════════════════════════════════════════
// Inventory Anomaly Detection
//
// "Some claim they lose none, then two months later they need a big order."
//   — Regional director, May 2026
//
// Heuristic flag: when the current month's stained-linen / discard volume
// drops sharply below the rolling 3-month baseline AND consumption is trending
// upward, surface a "suspicious drop in reported losses" badge.
//
// We deliberately keep this dead simple — no ML, no thresholds tuned on a
// single property. The output is a flag plus the relative drop %, and the UI
// presents it as a soft warning the GM can dismiss.
// ═══════════════════════════════════════════════════════════════════════════

import type { InventoryDiscard } from '@/types';

export interface AnomalyFinding {
  itemId: string;
  itemName: string;
  reasonCategory: 'discard-dropoff' | 'rate-divergence';
  baselineQty: number;        // 3-month rolling avg, prior to current month — or predicted rate
  currentMonthQty: number;    // current month qty — or observed rate × days
  dropRatio: number;          // 0..1; 1 = current dropped to zero
  costImpact: number;         // baseline - current, in $-terms (0 for rate-divergence)
  message: string;            // human-readable for the analytics card
}

/**
 * One observed-vs-predicted rate pair. Inputs to detectRateAnomalies; the
 * post-count-process API route builds these from inventory_counts +
 * inventory_rate_predictions. Pure math; no DB access in this module.
 */
export interface RateObservation {
  itemId: string;
  itemName: string;
  predictedDailyRate: number;
  observedDailyRate: number;
  daysSinceLastCount: number;
}

interface MonthlyBucket {
  itemId: string;
  itemName: string;
  monthStart: string;         // YYYY-MM-01
  quantity: number;
  costValue: number;
}

function bucketDiscards(discards: InventoryDiscard[]): MonthlyBucket[] {
  const map = new Map<string, MonthlyBucket>();
  for (const d of discards) {
    const at = d.discardedAt instanceof Date ? d.discardedAt : null;
    if (!at) continue;
    const monthKey = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-01`;
    const k = `${d.itemId}|${monthKey}`;
    const prev = map.get(k) ?? {
      itemId: d.itemId,
      itemName: d.itemName,
      monthStart: monthKey,
      quantity: 0,
      costValue: 0,
    };
    prev.quantity += Number(d.quantity ?? 0);
    prev.costValue += Number(d.costValue ?? 0);
    map.set(k, prev);
  }
  return Array.from(map.values());
}

/**
 * Detect items whose current-month discard volume dropped >= 50% below the
 * prior 3-month rolling average. Items with no prior history are skipped
 * (no baseline to compare against). Items with current-month qty above the
 * baseline are skipped (no anomaly).
 *
 * Pure function over the discard history; consumes whatever the UI fetched.
 */
export function detectDiscardAnomalies(
  discards: InventoryDiscard[],
  now: Date = new Date(),
): AnomalyFinding[] {
  if (discards.length === 0) return [];

  const currentMonthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;

  const buckets = bucketDiscards(discards);
  const byItem = new Map<string, MonthlyBucket[]>();
  for (const b of buckets) {
    const arr = byItem.get(b.itemId) ?? [];
    arr.push(b);
    byItem.set(b.itemId, arr);
  }

  const findings: AnomalyFinding[] = [];

  for (const [itemId, all] of byItem) {
    all.sort((a, b) => a.monthStart.localeCompare(b.monthStart));
    const current = all.find(b => b.monthStart === currentMonthKey);
    const prior = all.filter(b => b.monthStart < currentMonthKey).slice(-3);
    if (prior.length < 2) continue; // not enough history

    const baselineQty = prior.reduce((s, b) => s + b.quantity, 0) / prior.length;
    const baselineCost = prior.reduce((s, b) => s + b.costValue, 0) / prior.length;
    if (baselineQty < 5) continue; // baseline too low to flag a "drop"

    const currentQty = current?.quantity ?? 0;
    if (currentQty >= baselineQty * 0.5) continue; // not a 50%+ drop

    const dropRatio = baselineQty > 0 ? 1 - currentQty / baselineQty : 0;
    findings.push({
      itemId,
      itemName: prior[prior.length - 1].itemName,
      reasonCategory: 'discard-dropoff',
      baselineQty: Math.round(baselineQty),
      currentMonthQty: currentQty,
      dropRatio,
      costImpact: Math.max(0, baselineCost - (current?.costValue ?? 0)),
      message: `Reported losses dropped ${Math.round(dropRatio * 100)}% vs the prior 3-month average. Worth a spot-check.`,
    });
  }

  return findings.sort((a, b) => b.dropRatio - a.dropRatio);
}

/**
 * Flag items whose observed daily consumption rate diverged > 50% from the
 * model's prediction. Only fires for items with predictedDailyRate > 0 and
 * daysSinceLastCount >= 1 (single-count windows are too noisy).
 *
 * Both directions are flagged but with different severities:
 *   • observed >> predicted (more usage than expected) → 'critical'
 *     (could be theft, missed delivery, count error)
 *   • observed << predicted (less usage than expected) → 'warn'
 *     (could be miscount, vendor double-shipped, item not actually being used)
 */
export interface RateAnomalyFinding extends AnomalyFinding {
  severity: 'info' | 'warn' | 'critical';
  predictedDailyRate: number;
  observedDailyRate: number;
}

export function detectRateAnomalies(
  observations: RateObservation[],
  divergenceThreshold = 0.5,
): RateAnomalyFinding[] {
  const findings: RateAnomalyFinding[] = [];
  for (const obs of observations) {
    if (obs.predictedDailyRate <= 0) continue;
    if (obs.daysSinceLastCount < 1) continue;
    const ratio = (obs.observedDailyRate - obs.predictedDailyRate) / obs.predictedDailyRate;
    if (Math.abs(ratio) < divergenceThreshold) continue;
    const severity: 'info' | 'warn' | 'critical' = ratio > 1.0 ? 'critical' : 'warn';
    const direction = ratio > 0 ? 'higher' : 'lower';
    const pct = Math.round(Math.abs(ratio) * 100);
    findings.push({
      itemId: obs.itemId,
      itemName: obs.itemName,
      reasonCategory: 'rate-divergence',
      baselineQty: Math.round(obs.predictedDailyRate * obs.daysSinceLastCount),
      currentMonthQty: Math.round(obs.observedDailyRate * obs.daysSinceLastCount),
      dropRatio: Math.abs(ratio),
      costImpact: 0,
      severity,
      predictedDailyRate: obs.predictedDailyRate,
      observedDailyRate: obs.observedDailyRate,
      message: `Usage was ${pct}% ${direction} than expected over the last ${Math.round(obs.daysSinceLastCount)} day(s). Worth a check.`,
    });
  }
  return findings.sort((a, b) => b.dropRatio - a.dropRatio);
}
