export interface BacktestStatusData {
  runDate: string;
  layer: 'demand' | 'supply';
  weeks: number;
  fittedOnlyMae: number | null;
  fittedOnlyMaeRatio: number | null;
  allDaysMae: number | null;
  quantileCoverage80: number | null;
  beatsBaselinePct: number | null;
  daysTotal: number;
  daysFitted: number;
  daysColdStart: number;
  daysInsufficientData: number;
  refusalReason: string | null;
  summary: string;
}

export interface BacktestStatusResponse {
  ok: true;
  requestId: string;
  data: BacktestStatusData | null;
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Parse a stored housekeeping backtest artifact defensively. */
export function parseArtifact(raw: unknown): BacktestStatusData | null {
  if (!isObj(raw)) return null;
  const runDate = strOrNull(raw.run_date);
  const layerRaw = raw.layer;
  if (!runDate || (layerRaw !== 'demand' && layerRaw !== 'supply')) return null;
  const weeks = numOrNull(raw.weeks);
  if (weeks === null) return null;
  return {
    runDate,
    layer: layerRaw,
    weeks: Math.trunc(weeks),
    fittedOnlyMae: numOrNull(raw.fitted_only_mae),
    fittedOnlyMaeRatio: numOrNull(raw.fitted_only_mae_ratio),
    allDaysMae: numOrNull(raw.all_days_mae),
    quantileCoverage80: numOrNull(raw.quantile_coverage_80),
    beatsBaselinePct: numOrNull(raw.beats_baseline_pct),
    daysTotal: Math.trunc(numOrNull(raw.days_total) ?? 0),
    daysFitted: Math.trunc(numOrNull(raw.days_fitted) ?? 0),
    daysColdStart: Math.trunc(numOrNull(raw.days_cold_start) ?? 0),
    daysInsufficientData: Math.trunc(numOrNull(raw.days_insufficient_data) ?? 0),
    refusalReason: strOrNull(raw.refusal_reason),
    summary: strOrNull(raw.summary) ?? '',
  };
}
