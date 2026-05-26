/**
 * Portfolio anomaly detector — flags per-property metrics that deviate
 * meaningfully from the portfolio-wide average for the same module.
 *
 * Pattern: a property is "anomalous" on a metric when its value differs
 * from the portfolio average by ≥ ANOMALY_THRESHOLD_PCT (15% default).
 * Severity escalates to red at SEVERE_THRESHOLD_PCT (30%).
 *
 * Why % deviation and not z-score / std-dev: with 2–4 properties the
 * sample size is tiny and std-dev is noise-dominated. A flat
 * percentage-deviation rule is robust at small N, easy to explain to a
 * non-technical owner, and easy to tune per-metric if we discover
 * specific metrics need different thresholds later.
 *
 * Why "ignore N<2 / avg=0" cases: comparing a property to itself is
 * meaningless, and dividing by zero is undefined. In those cases the
 * detector returns no anomalies for that metric — the tile still
 * renders, the banner just doesn't claim there's an outlier.
 */

import type {
  HousekeepingTileData,
  PortfolioAnomaly,
  PortfolioModuleAverages,
  PortfolioTileData,
} from './types';

/** Default cutoff: 15% deviation surfaces as a yellow flag. */
export const ANOMALY_THRESHOLD_PCT = 0.15;
/** ≥ 30% deviation escalates to red. */
export const SEVERE_THRESHOLD_PCT = 0.30;

/**
 * Compute the absolute fractional deviation of `value` from `baseline`,
 * defensively. Returns null when the comparison would be undefined
 * (baseline is null/0, value is null, sample of 1).
 */
function fractionalDeviation(
  value: number | null,
  baseline: number | null,
  propertiesIncluded: number,
): number | null {
  if (propertiesIncluded < 2) return null;
  if (value === null || baseline === null) return null;
  if (!Number.isFinite(value) || !Number.isFinite(baseline)) return null;
  if (baseline === 0) return null;
  return Math.abs(value - baseline) / Math.abs(baseline);
}

function severityFor(dev: number): PortfolioAnomaly['severity'] {
  return dev >= SEVERE_THRESHOLD_PCT ? 'red' : 'yellow';
}

/**
 * Format a percentage for the explanation text. 0.17 → "17%".
 * Uses round-half-to-even (the JS default) which is fine for display.
 */
function pct(n: number, digits = 0): string {
  return `${(n * 100).toFixed(digits)}%`;
}

/** Lowercase comparison word ("above" / "below"). */
function direction(value: number, baseline: number): 'above' | 'below' {
  return value >= baseline ? 'above' : 'below';
}

/**
 * Detect anomalies for one property's housekeeping tile against the
 * housekeeping portfolio average. The detector intentionally skips
 * metrics where the comparison is ill-defined (n<2, baseline=0, null
 * inputs).
 */
export function detectHousekeepingAnomalies(
  tile: HousekeepingTileData,
  avg: PortfolioModuleAverages,
): PortfolioAnomaly[] {
  const out: PortfolioAnomaly[] = [];
  const n = avg.propertiesIncluded;

  // ── Inspection pass rate (lower = worse) ────────────────────────────
  const passDev = fractionalDeviation(tile.inspectionPassRate, avg.avgInspectionPassRate, n);
  if (passDev !== null && passDev >= ANOMALY_THRESHOLD_PCT) {
    const v  = tile.inspectionPassRate!;
    const b  = avg.avgInspectionPassRate!;
    // Only surface as a problem when the property is BELOW the average.
    // Being above the average on pass rate is good and shouldn't ping.
    if (v < b) {
      out.push({
        module: 'housekeeping',
        propertyId: tile.propertyId,
        propertyName: tile.property.name,
        metric: 'Inspection pass rate',
        severity: severityFor(passDev),
        explanation: `${tile.property.name}'s inspection pass rate (${pct(v, 0)}) is ${pct(passDev, 0)} below portfolio average (${pct(b, 0)}) — investigate.`,
      });
    }
  }

  // ── Average minutes per departure (higher = worse) ──────────────────
  const minutesDev = fractionalDeviation(tile.avgMinutesPerDeparture, avg.avgMinutesPerDeparture, n);
  if (minutesDev !== null && minutesDev >= ANOMALY_THRESHOLD_PCT) {
    const v = tile.avgMinutesPerDeparture!;
    const b = avg.avgMinutesPerDeparture!;
    // Higher than average = slower turnover = anomaly worth flagging.
    if (v > b) {
      out.push({
        module: 'housekeeping',
        propertyId: tile.propertyId,
        propertyName: tile.property.name,
        metric: 'Minutes per departure',
        severity: severityFor(minutesDev),
        explanation: `${tile.property.name}'s departures are taking ${v.toFixed(1)} min — ${pct(minutesDev, 0)} ${direction(v, b)} portfolio average (${b.toFixed(1)} min).`,
      });
    }
  }

  // ── Labor cost vs budget (cost overrun on the property's own budget) ─
  // This is per-property, not vs portfolio average. A property that's
  // 30% above its own daily budget is anomalous regardless of how the
  // other properties are doing.
  if (
    tile.laborCostTodayCents !== null &&
    tile.laborBudgetTodayCents !== null &&
    tile.laborBudgetTodayCents > 0
  ) {
    // Use (cost - budget) / budget rather than (cost/budget) - 1 to
    // avoid floating-point loss on round-number ratios (e.g. 11500/10000
    // = 1.15 exactly, but 11500/10000 - 1 evaluates to 0.149999… in JS,
    // which would silently miss the 0.15 threshold).
    const overrun = (tile.laborCostTodayCents - tile.laborBudgetTodayCents) / tile.laborBudgetTodayCents;
    if (overrun >= ANOMALY_THRESHOLD_PCT) {
      const sev: PortfolioAnomaly['severity'] = overrun >= SEVERE_THRESHOLD_PCT ? 'red' : 'yellow';
      out.push({
        module: 'housekeeping',
        propertyId: tile.propertyId,
        propertyName: tile.property.name,
        metric: 'Labor cost',
        severity: sev,
        explanation: `${tile.property.name} is ${pct(overrun, 0)} over today's labor budget — ${
          (tile.laborCostTodayCents / 100).toFixed(0)
        } spent vs ${
          (tile.laborBudgetTodayCents / 100).toFixed(0)
        } budgeted.`,
      });
    }
  }

  // ── Staff scheduled vs portfolio average (under-staffing) ───────────
  const scheduledDev = fractionalDeviation(tile.staffScheduledCount, avg.avgStaffScheduled, n);
  if (scheduledDev !== null && scheduledDev >= ANOMALY_THRESHOLD_PCT) {
    const v = tile.staffScheduledCount;
    const b = avg.avgStaffScheduled!;
    // Only flag when under-staffed (under-staffing is the operational
    // problem we want to surface; being over-staffed is a cost flag the
    // labor-cost block above already catches).
    if (v < b) {
      out.push({
        module: 'housekeeping',
        propertyId: tile.propertyId,
        propertyName: tile.property.name,
        metric: 'Staff scheduled',
        severity: severityFor(scheduledDev),
        explanation: `${tile.property.name} has ${v} staff scheduled — ${pct(scheduledDev, 0)} below portfolio average (${b.toFixed(1)}).`,
      });
    }
  }

  return out;
}

/**
 * Generic entry point: route a tile + averages pair to the right
 * module-specific detector. Adapters can additionally supplement these
 * via their `anomalyFlag` override.
 */
export function detectAnomalies(
  tiles: ReadonlyArray<PortfolioTileData>,
  averages: ReadonlyArray<PortfolioModuleAverages>,
): PortfolioAnomaly[] {
  const out: PortfolioAnomaly[] = [];
  const hkAvg = averages.find(a => a.module === 'housekeeping');
  if (hkAvg) {
    for (const tile of tiles) {
      if (tile.module !== 'housekeeping') continue;
      out.push(...detectHousekeepingAnomalies(tile, hkAvg));
    }
  }
  return out;
}
