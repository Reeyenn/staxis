// ═══════════════════════════════════════════════════════════════════════════
// Inventory prediction↔actual WINDOW pairing (2026-07-05 accuracy pass)
//
// The graduation scorecard compares "what the AI predicted" against "what the
// hotel actually used". The old pairing compared the SINGLE most recent daily
// prediction (made for one specific day, at whatever age) against the AVERAGE
// daily rate over the whole multi-day window between two shelf counts. With
// normal day-of-week swings (Sunday checkout spikes etc.) that mismatch alone
// injected 10-25% phantom error — enough to block graduation on items the
// model actually predicts well, and it measured the scorecard's artifact, not
// the model.
//
// The fix: integrate over the window. predicted_value = the MEAN of the daily
// predictions the model made for the days inside the window (same days the
// actual was realized over), same units, same horizon. A pair is only written
// when predictions cover enough of the window (MIN_WINDOW_COVERAGE) — a
// predict-cron outage produces "no evidence", never a distorted pair.
//
// Pure module: no DB access, no Next imports. Consumed by
//   • /api/inventory/post-count-process (pairing at count time)
//   • /api/cron/ml-predict-inventory   (server-side sweep for pairs the
//     fire-and-forget browser call lost)
// ═══════════════════════════════════════════════════════════════════════════

/** Minimum fraction of window days that must have a stored daily prediction. */
export const MIN_WINDOW_COVERAGE = 0.7;

/** One stored daily prediction (from inventory_rate_predictions). */
export interface DailyPrediction {
  id: string;
  itemId: string;
  /** The operational date the prediction was FOR (predicted_for_date). */
  date: string;
  rate: number;
  modelRunId: string;
  /** When the prediction was made (predicted_at ISO) — tie-break newest. */
  predictedAt: string;
}

/** A closed count window with its realized (view-computed) actual rate. */
export interface CountWindow {
  itemId: string;
  itemName: string;
  /** The count that CLOSED the window (newer count). */
  newerCountId: string;
  /** Property-local operational dates bounding the window. */
  olderLocalDate: string;
  newerLocalDate: string;
  /** Realized mean daily rate over the window, from inventory_observed_rate_v. */
  observedRate: number;
}

export interface WindowPair {
  itemId: string;
  itemName: string;
  newerCountId: string;
  /** Property-local operational date the window closed on (the pair's date). */
  newerLocalDate: string;
  /** Mean predicted daily rate over the covered window days. */
  predictedRate: number;
  observedRate: number;
  windowDays: number;
  coveredDays: number;
  /** The newest contributing prediction — its id/model_run label the pair. */
  predictionId: string;
  modelRunId: string;
}

export interface PairingResult {
  pairs: WindowPair[];
  /** Windows skipped because predictions covered < MIN_WINDOW_COVERAGE. */
  skippedLowCoverage: number;
  /** Windows skipped because they were sub-day or malformed. */
  skippedInvalidWindow: number;
}

/**
 * YYYY-MM-DD of an ISO timestamp in the property's timezone. The window's day
 * boundaries must be PROPERTY-local: an evening count at 7pm Central is a UTC
 * timestamp on the NEXT calendar day, and slicing UTC would shift the whole
 * window off by a day for evening-counting hotels.
 */
export function localDateOf(iso: string, timeZone: string): string | null {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(t);
  } catch {
    return null;
  }
}

/** Enumerate the half-open day window (older, newer] — matches the trainer. */
export function windowDates(olderLocalDate: string, newerLocalDate: string): string[] {
  const out: string[] = [];
  const start = new Date(`${olderLocalDate}T12:00:00Z`);
  const end = new Date(`${newerLocalDate}T12:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return out;
  const d = new Date(start);
  for (let i = 0; i < 400; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d > end) break;
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Build window-integrated prediction↔actual pairs.
 *
 * For each window: collect the daily predictions whose predicted_for_date
 * falls inside (older, newer], require coverage ≥ MIN_WINDOW_COVERAGE, and
 * average them. Multiple predictions for the same (item, date) keep the
 * newest predicted_at (delete-then-insert makes duplicates rare, but a race
 * shouldn't double-weight a day).
 */
export function buildWindowPairs(
  windows: CountWindow[],
  predictions: DailyPrediction[],
  opts?: { minCoverage?: number },
): PairingResult {
  const minCoverage = opts?.minCoverage ?? MIN_WINDOW_COVERAGE;

  // (itemId, date) → newest prediction for that day.
  const byItemDate = new Map<string, DailyPrediction>();
  for (const p of predictions) {
    if (!Number.isFinite(p.rate)) continue;
    const key = `${p.itemId}|${p.date}`;
    const prev = byItemDate.get(key);
    if (!prev || p.predictedAt > prev.predictedAt) byItemDate.set(key, p);
  }

  const pairs: WindowPair[] = [];
  let skippedLowCoverage = 0;
  let skippedInvalidWindow = 0;

  for (const w of windows) {
    const days = windowDates(w.olderLocalDate, w.newerLocalDate);
    if (days.length === 0) {
      skippedInvalidWindow += 1;
      continue;
    }
    const covered: DailyPrediction[] = [];
    for (const day of days) {
      const p = byItemDate.get(`${w.itemId}|${day}`);
      if (p) covered.push(p);
    }
    if (covered.length === 0 || covered.length / days.length < minCoverage) {
      skippedLowCoverage += 1;
      continue;
    }
    const meanRate = covered.reduce((acc, p) => acc + p.rate, 0) / covered.length;
    // Label the pair with the newest contributing prediction: it belongs to
    // the model generation that was live at window close — the generation the
    // graduation gate scopes by.
    const newest = covered.reduce((a, b) => (b.predictedAt > a.predictedAt ? b : a));
    pairs.push({
      itemId: w.itemId,
      itemName: w.itemName,
      newerCountId: w.newerCountId,
      newerLocalDate: w.newerLocalDate,
      predictedRate: meanRate,
      observedRate: w.observedRate,
      windowDays: days.length,
      coveredDays: covered.length,
      predictionId: newest.id,
      modelRunId: newest.modelRunId,
    });
  }

  return { pairs, skippedLowCoverage, skippedInvalidWindow };
}
