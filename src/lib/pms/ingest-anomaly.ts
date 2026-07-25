// ═══════════════════════════════════════════════════════════════════════════
// pms/ingest-anomaly — day-over-day weirdness in an arriving PMS report.
//
// Modelled on the baseline-vs-current-with-a-floor pattern already used by
// src/lib/financials/anomaly.ts and src/lib/inventory-anomaly.ts. Same shape,
// same conservatism (a floor + a minimum history so a 0 → 2 move never
// alerts), so there is one anomaly idiom in this codebase rather than three.
//
// ── THE ALERT / FLAG LINE (the whole reason this module is PURE) ──────────
// An anomaly NEVER blocks a write. Containment for bad data is last-good
// preservation plus honest staleness — and a hotel really can sell out
// overnight, so "occupancy doubled" is a thing to mention, not a thing to
// refuse. This module therefore has no write access at all: it returns
// findings, and its single caller writes them to pms_ingest_anomalies (a
// flag). It structurally CANNOT alert or block.
//
// What alerts instead (doctor fail → the existing 5-minute vercel-watchdog →
// Sentry + business-hours SMS):
//   • a required feed past 2× its grace            → evaluateFeedSlos
//   • a delivery where every row was rejected      → evaluateQuarantineBacklog
//   • quarantine backlog over threshold            → evaluateQuarantineBacklog
// Validator ERRORS quarantine. Anomalies only flag. That line is enforced by
// which sink each detector's caller writes to, and is asserted by the tests.
// ═══════════════════════════════════════════════════════════════════════════

/** Mirror of pms_ingest_anomalies.kind (migration 0339). */
export type IngestAnomalyKind =
  | 'occupancy_jump'
  | 'revenue_collapse'
  | 'row_count_collapse'
  | 'snapshot_room_sum_mismatch';

export interface IngestAnomaly {
  kind: IngestAnomalyKind;
  feedKey: string | null;
  observed: number | null;
  baseline: number | null;
  /** observed / baseline where both are meaningful; null otherwise. */
  ratio: number | null;
  detail: string;
}

/** Median of a numeric series. Median, not mean, so one prior spike does not
 *  desensitise the detector. Returns null for an empty series. */
export function median(values: readonly number[]): number | null {
  const clean = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 === 1 ? clean[mid]! : (clean[mid - 1]! + clean[mid]!) / 2;
}

// ─── 1. Occupancy moved implausibly far in one day ─────────────────────────

export interface OccupancyJumpOpts {
  /** Percentage POINTS of movement that flag. Default 40. */
  thresholdPoints?: number;
}

/**
 * Occupancy is already a percentage, so the comparison is in POINTS, not a
 * ratio — a 40 → 85 move is 45 points regardless of the base, whereas a ratio
 * makes small bases hysterical (2% → 6% is "3× worse" and means nothing).
 *
 * Returns null when either side is missing: no baseline is not an anomaly.
 */
export function detectOccupancyJump(
  currentPct: number | null | undefined,
  previousPct: number | null | undefined,
  opts: OccupancyJumpOpts = {},
): IngestAnomaly | null {
  const threshold = opts.thresholdPoints ?? 40;
  if (typeof currentPct !== 'number' || !Number.isFinite(currentPct)) return null;
  if (typeof previousPct !== 'number' || !Number.isFinite(previousPct)) return null;
  const delta = currentPct - previousPct;
  // Strictly PAST the threshold. A hotel that moves exactly 40 points is the
  // boundary case, and the conservative reading of a boundary is "normal".
  if (Math.abs(delta) <= threshold) return null;
  return {
    kind: 'occupancy_jump',
    feedKey: 'dashboardCounts',
    observed: currentPct,
    baseline: previousPct,
    ratio: previousPct > 0 ? currentPct / previousPct : null,
    detail: `Occupancy moved ${delta > 0 ? 'up' : 'down'} ${Math.abs(Math.round(delta))} points in a day (${Math.round(previousPct)}% → ${Math.round(currentPct)}%). Worth a look before quoting it.`,
  };
}

// ─── 2. Revenue-so-far fell to zero against a real history ─────────────────

export interface RevenueCollapseOpts {
  /** Ignore hotels whose 7-day median revenue is under this. Default $100. */
  floorCents?: number;
}

/**
 * "Today's revenue is $0" is a normal reading at 3am and a red flag at 6pm.
 * The detector only fires when the hotel HAS a revenue history (median above
 * the floor) and today's figure is exactly zero — a partial figure is just an
 * early-in-the-day figure and must not flag.
 */
export function detectRevenueCollapse(
  currentCents: number | null | undefined,
  recentDailyCents: readonly number[],
  opts: RevenueCollapseOpts = {},
): IngestAnomaly | null {
  const floor = opts.floorCents ?? 10_000;
  if (typeof currentCents !== 'number' || !Number.isFinite(currentCents)) return null;
  if (currentCents !== 0) return null;
  const base = median(recentDailyCents);
  if (base === null || base < floor) return null;
  return {
    kind: 'revenue_collapse',
    feedKey: 'dashboardCounts',
    observed: 0,
    baseline: base,
    ratio: 0,
    detail: `Today's revenue reads $0 but this hotel's usual day is about $${(base / 100).toFixed(0)}. The revenue column may have moved or stopped arriving.`,
  };
}

// ─── 3. A feed's row count collapsed against its own history ───────────────

export interface RowCountCollapseOpts {
  /** Fraction below the median that flags. Default 0.6 (60% below). */
  dropFraction?: number;
  /** Ignore feeds whose median row count is under this. Default 5 rows. */
  floorRows?: number;
}

/**
 * A report that suddenly carries a fraction of its usual rows is either a
 * genuinely quiet day or a report whose filter changed. Flag, never block:
 * both readings are plausible and the honest move is to say so.
 *
 * ZERO rows with a real history is the strongest form of this and is included
 * — but note it FLAGS here; the ALERTING version of "parsed 0 rows when the
 * 7-day median was positive" is the doctor's job, keyed off the ingest ledger.
 */
export function detectRowCountCollapse(
  feedKey: string,
  currentRows: number | null | undefined,
  recentRowCounts: readonly number[],
  opts: RowCountCollapseOpts = {},
): IngestAnomaly | null {
  const dropFraction = opts.dropFraction ?? 0.6;
  const floorRows = opts.floorRows ?? 5;
  if (typeof currentRows !== 'number' || !Number.isFinite(currentRows) || currentRows < 0) return null;
  const base = median(recentRowCounts);
  if (base === null || base < floorRows) return null;
  if (currentRows > base * (1 - dropFraction)) return null;
  const pct = Math.round((1 - currentRows / base) * 100);
  return {
    kind: 'row_count_collapse',
    feedKey,
    observed: currentRows,
    baseline: base,
    ratio: base > 0 ? currentRows / base : null,
    detail: `The ${feedKey} report carried ${currentRows} row(s), ${pct}% below its usual ${base}. Either a quiet day or the report's filter changed.`,
  };
}

// ─── 4. The house counts no longer add up to the hotel's rooms ─────────────

export interface SnapshotRoomSums {
  totalOccupiedRooms?: number | null;
  totalVacantClean?: number | null;
  totalVacantDirty?: number | null;
  totalOoo?: number | null;
}

export interface SnapshotSumOpts {
  /** Absolute slack. Default 2 — a room can change hands between the report's
   *  own sections. */
  tolerance?: number;
}

/**
 * occupied + vacant clean + vacant dirty + out-of-order should equal the
 * hotel's room count. This is the SAME cross-field invariant the ingest
 * validator enforces (cua-service/src/validators.ts, validateInHouseSnapshot)
 * — restated here because the two packages cannot import each other, NOT
 * re-derived. If that rule changes, change both; the test below pins the
 * behaviour so a divergence shows up as a failure.
 *
 * Abstains (returns null) unless every part is present and the hotel's room
 * count is known — a partial snapshot is a missing number, not a wrong one.
 */
export function detectSnapshotRoomSumMismatch(
  sums: SnapshotRoomSums,
  totalRooms: number | null | undefined,
  opts: SnapshotSumOpts = {},
): IngestAnomaly | null {
  const tolerance = opts.tolerance ?? 2;
  if (typeof totalRooms !== 'number' || !Number.isFinite(totalRooms) || totalRooms <= 0) return null;
  const parts = [sums.totalOccupiedRooms, sums.totalVacantClean, sums.totalVacantDirty, sums.totalOoo];
  if (parts.some((p) => typeof p !== 'number' || !Number.isFinite(p))) return null;
  const observed = parts.reduce<number>((sum, p) => sum + (p as number), 0);
  const delta = observed - totalRooms;
  if (Math.abs(delta) <= tolerance) return null;
  return {
    kind: 'snapshot_room_sum_mismatch',
    feedKey: 'dashboardCounts',
    observed,
    baseline: totalRooms,
    ratio: totalRooms > 0 ? observed / totalRooms : null,
    detail: `The house counts add up to ${observed} rooms but this hotel has ${totalRooms}. Off by ${delta > 0 ? '+' : ''}${delta}.`,
  };
}

// ─── The batch entry point ─────────────────────────────────────────────────

export interface IngestAnomalyInput {
  occupancyPct?: number | null;
  previousOccupancyPct?: number | null;
  revenueTodayCents?: number | null;
  recentDailyRevenueCents?: readonly number[];
  /** Per-feed: this delivery's row count and the feed's recent history. */
  feedRowCounts?: ReadonlyArray<{ feedKey: string; rows: number; recent: readonly number[] }>;
  snapshotSums?: SnapshotRoomSums;
  totalRooms?: number | null;
}

/**
 * Run every detector over one delivery's worth of observations. Pure: returns
 * findings. The caller decides what to do with them, and the only correct
 * answer is "write a pms_ingest_anomalies row".
 */
export function detectIngestAnomalies(input: IngestAnomalyInput): IngestAnomaly[] {
  const out: IngestAnomaly[] = [];

  const occ = detectOccupancyJump(input.occupancyPct, input.previousOccupancyPct);
  if (occ) out.push(occ);

  const rev = detectRevenueCollapse(input.revenueTodayCents, input.recentDailyRevenueCents ?? []);
  if (rev) out.push(rev);

  for (const feed of input.feedRowCounts ?? []) {
    const rows = detectRowCountCollapse(feed.feedKey, feed.rows, feed.recent);
    if (rows) out.push(rows);
  }

  if (input.snapshotSums) {
    const sums = detectSnapshotRoomSumMismatch(input.snapshotSums, input.totalRooms);
    if (sums) out.push(sums);
  }

  return out;
}
