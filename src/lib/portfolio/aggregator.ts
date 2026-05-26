/**
 * Portfolio aggregator — turns an array of per-property tile payloads
 * into (1) the totals shown on the summary banner and (2) the per-module
 * average baselines the anomaly detector compares against.
 *
 * All math here is pure and synchronous so it stays trivially testable.
 */

import type {
  PortfolioModuleAverages,
  PortfolioSummary,
  PortfolioTileData,
} from './types';

/**
 * Average a list of (possibly null) numbers. Returns null when every
 * value is null — the caller renders "—" for that metric. Treating null
 * as "no data" rather than zero is what keeps a property with no
 * inspections from dragging the portfolio's average pass rate to 0%.
 */
function avgIgnoringNull(values: ReadonlyArray<number | null>): number | null {
  const real = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (real.length === 0) return null;
  const sum = real.reduce((a, b) => a + b, 0);
  return sum / real.length;
}

/**
 * Sum a list of (possibly null) numbers. Null is treated as 0 here — the
 * banner totals are "what we've measured so far" and the empty properties
 * just contribute zero. The averages function above keeps the
 * comparison-baseline math honest separately.
 */
function sumTreatingNullAsZero(values: ReadonlyArray<number | null>): number {
  return values.reduce<number>((a, b) => a + (b ?? 0), 0);
}

/**
 * Compute per-module averages from a set of tile payloads. Currently the
 * housekeeping module is the only one shipping; future modules will
 * extend the discriminated union and this function will gain a switch
 * branch per new module.
 */
export function computeModuleAverages(
  tiles: ReadonlyArray<PortfolioTileData>,
): PortfolioModuleAverages[] {
  const hkTiles = tiles.filter((t): t is Extract<PortfolioTileData, { module: 'housekeeping' }> => t.module === 'housekeeping');

  const out: PortfolioModuleAverages[] = [];
  if (hkTiles.length > 0) {
    out.push({
      module: 'housekeeping',
      propertiesIncluded: hkTiles.length,
      avgRoomsTurned:           avgIgnoringNull(hkTiles.map(t => t.roomsTurned)),
      avgRoomsRemaining:        avgIgnoringNull(hkTiles.map(t => t.roomsRemaining)),
      avgInspectionPassRate:    avgIgnoringNull(hkTiles.map(t => t.inspectionPassRate)),
      avgMinutesPerDeparture:   avgIgnoringNull(hkTiles.map(t => t.avgMinutesPerDeparture)),
      avgLaborCostTodayCents:   avgIgnoringNull(hkTiles.map(t => t.laborCostTodayCents)),
      avgLaborBudgetTodayCents: avgIgnoringNull(hkTiles.map(t => t.laborBudgetTodayCents)),
      avgStaffActive:           avgIgnoringNull(hkTiles.map(t => t.staffActiveCount)),
      avgStaffScheduled:        avgIgnoringNull(hkTiles.map(t => t.staffScheduledCount)),
    });
  }
  return out;
}

/**
 * Compute the totals shown on the summary banner. Treats null cost /
 * budget as zero so the banner stays informative even when some
 * properties don't have cost data yet — the only metric that needs the
 * "ignore nulls" treatment is the average-based comparison, not the
 * top-line totals.
 */
export function computeSummary(
  tiles: ReadonlyArray<PortfolioTileData>,
  anomalyCount: number,
): PortfolioSummary {
  const hkTiles = tiles.filter((t): t is Extract<PortfolioTileData, { module: 'housekeeping' }> => t.module === 'housekeeping');

  // Properties count is taken from the distinct propertyId set across
  // ALL modules, not just housekeeping, so when a future module adds
  // tiles for a property that has no housekeeping data, the property
  // still shows up in the banner count.
  const distinctPropertyIds = new Set(tiles.map(t => t.propertyId));

  return {
    propertiesCount:           distinctPropertyIds.size,
    totalRoomsTurned:          sumTreatingNullAsZero(hkTiles.map(t => t.roomsTurned)),
    totalRoomsRemaining:       sumTreatingNullAsZero(hkTiles.map(t => t.roomsRemaining)),
    totalLaborCostTodayCents:  sumTreatingNullAsZero(hkTiles.map(t => t.laborCostTodayCents)),
    totalLaborBudgetTodayCents: sumTreatingNullAsZero(hkTiles.map(t => t.laborBudgetTodayCents)),
    totalStaffActive:          sumTreatingNullAsZero(hkTiles.map(t => t.staffActiveCount)),
    totalStaffScheduled:       sumTreatingNullAsZero(hkTiles.map(t => t.staffScheduledCount)),
    anomalyCount,
  };
}
