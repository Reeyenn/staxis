// Engineering Compliance v2 — leak/spike anomaly detection (PURE math).
//
// Mirrors the philosophy of src/lib/inventory-anomaly.ts: dead-simple
// statistics, no per-property-tuned ML, honest cold-start (return a "learning"
// state until there's enough history for a stable baseline — no false alarms on
// day 1), and a plain-English (bilingual) reason the UI/SMS shows.
//
// Two modes, chosen by reading category:
//   • POINT (pool / boiler / area_temp / other): the value itself is the
//     signal. Baseline = rolling mean ± stddev → z-score. Detect SPIKE (|z|
//     large), FLATLINE (stuck sensor: recent reads identical when it normally
//     varies), and DRIFT (monotonic trend toward a safe-range threshold).
//   • METER (utility_meter, cumulative): consumption = delta between
//     consecutive readings. Baseline = mean delta. Detect SPIKE (delta ≫
//     normal → possible leak/equipment) and FLATLINE (delta ≈ 0 when it
//     normally consumes → stuck/dead meter or supply off).
//
// No DB access here. The engine (anomaly-engine.ts) fetches history + records
// alerts + notifies.

import type { ReadingCategory } from './types';

export const ANOMALY_KINDS = ['spike', 'drift', 'flatline'] as const;
export type AnomalyKind = (typeof ANOMALY_KINDS)[number];
export type AnomalySeverity = 'info' | 'warn' | 'critical';

// ── Cold-start + sensitivity constants (deliberately conservative) ──────────
export const MIN_POINT_HISTORY = 8;   // point readings needed before a stable baseline
export const MIN_METER_INTERVALS = 5; // consumption deltas needed (→ 6 readings)
const POINT_HISTORY_CAP = 40;         // baseline window (by count, cadence-agnostic)

const Z_SPIKE_WARN = 3.0;
const Z_SPIKE_CRIT = 4.5;
const REL_SPIKE_WARN = 0.5;           // fallback when stddev ≈ 0: |value-mean|/|mean|
const FLATLINE_RUN = 6;               // consecutive ~identical reads ⇒ stuck
const DRIFT_RUN = 4;                  // monotonic reads ⇒ drift
const DRIFT_OUTER_BAND = 0.2;         // "outer 20% of the safe band" toward the limit

const METER_SPIKE_WARN = 2.0;         // delta ≥ 2× normal ⇒ warn
const METER_SPIKE_CRIT = 3.0;         // delta ≥ 3× normal ⇒ critical
const METER_LEAK_RATIO = 3.0;         // ≥ 3× ⇒ high-confidence leak (auto work order)
const METER_FLAT_FRACTION = 0.05;     // delta ≤ 5% of normal ⇒ effectively zero
const METER_FLAT_RUN = 3;             // that many flat intervals ⇒ stuck/dead

const EPS = 1e-9;

export interface AnomalyResult {
  kind: AnomalyKind;
  severity: AnomalySeverity;
  baselineMean: number | null;
  baselineStddev: number | null;
  observed: number;   // value (point) or consumption delta (meter)
  score: number;      // z-score (point) or rate ratio (meter)
  confidence: number; // 0..1
  reasonEn: string;
  reasonEs: string;
  highConfidenceLeak: boolean; // → auto-open a work order
}

export type AnomalyOutcome =
  | { state: 'learning'; have: number; need: number }
  | { state: 'normal' }
  | { state: 'anomaly'; result: AnomalyResult };

export interface AnomalyTypeInfo {
  category: ReadingCategory;
  name: string;
  unit: string;
  minValue: number | null;
  maxValue: number | null;
}

export interface HistoryPoint {
  value: number;
  at: number; // epoch ms
}

// ─── stats ───────────────────────────────────────────────────────────────────

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}
function stddev(xs: number[], m: number): number {
  if (xs.length < 2) return 0;
  const v = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / xs.length;
  return Math.sqrt(v);
}
const round1 = (n: number) => Math.round(n * 10) / 10;
const isMeter = (c: ReadingCategory) => c === 'utility_meter';

// ─── entry point ─────────────────────────────────────────────────────────────

/**
 * Analyze a new reading against its prior history.
 *  - `history`: prior readings (NOT including `current`), any order.
 *  - `current`: the new reading.
 * Returns 'learning' (cold-start), 'normal', or an anomaly result.
 */
export function analyzeReading(
  type: AnomalyTypeInfo,
  history: HistoryPoint[],
  current: HistoryPoint,
): AnomalyOutcome {
  if (!Number.isFinite(current.value)) return { state: 'normal' };
  return isMeter(type.category)
    ? analyzeMeter(type, history, current)
    : analyzePoint(type, history, current);
}

// ─── point readings ──────────────────────────────────────────────────────────

function analyzePoint(type: AnomalyTypeInfo, history: HistoryPoint[], current: HistoryPoint): AnomalyOutcome {
  // Most-recent-first, capped, finite only.
  const prior = [...history]
    .filter((h) => Number.isFinite(h.value))
    .sort((a, b) => b.at - a.at)
    .slice(0, POINT_HISTORY_CAP);

  if (prior.length < MIN_POINT_HISTORY) {
    return { state: 'learning', have: prior.length, need: MIN_POINT_HISTORY };
  }

  const priorVals = prior.map((p) => p.value);
  const m = mean(priorVals);
  const sd = stddev(priorVals, m);
  const v = current.value;

  // recentDesc = current + most-recent prior, newest first.
  const recentDesc = [v, ...priorVals];

  // ── SPIKE (checked first — most urgent) ──────────────────────────────────
  let z: number;
  let isSpike: boolean;
  if (sd > EPS) {
    z = (v - m) / sd;
    isSpike = Math.abs(z) >= Z_SPIKE_WARN;
  } else {
    // History was flat; a meaningful jump is still a spike.
    const rel = Math.abs(v - m) / Math.max(Math.abs(m), 1);
    z = rel; // report relative magnitude as the score
    isSpike = rel >= REL_SPIKE_WARN && Math.abs(v - m) > EPS;
  }
  if (isSpike) {
    const above = v > m;
    const severity: AnomalySeverity = sd > EPS && Math.abs(z) >= Z_SPIKE_CRIT ? 'critical' : 'warn';
    const pct = Math.round((Math.abs(v - m) / Math.max(Math.abs(m), EPS)) * 100);
    const dir = above ? 'above' : 'below';
    const dirEs = above ? 'por encima de' : 'por debajo de';
    return anomaly('spike', severity, m, sd, v, round1(z),
      severity === 'critical' ? 0.9 : 0.7,
      `${type.name} is ${pct}% ${dir} its recent normal (~${round1(m)}${type.unit}) — possible problem; check the equipment.`,
      `${type.name} está ${pct}% ${dirEs} su nivel normal (~${round1(m)}${type.unit}) — posible problema; revisa el equipo.`,
      false);
  }

  // ── FLATLINE (stuck sensor): recent run identical when history normally varies
  if (sd > EPS) {
    const run = recentDesc.slice(0, FLATLINE_RUN);
    if (run.length >= FLATLINE_RUN && run.every((x) => Math.abs(x - run[0]) <= EPS)) {
      return anomaly('flatline', 'warn', m, sd, v, 0, 0.6,
        `${type.name} hasn't changed across the last ${FLATLINE_RUN} readings — the sensor may be stuck.`,
        `${type.name} no ha cambiado en las últimas ${FLATLINE_RUN} lecturas — el sensor puede estar atascado.`,
        false);
    }
  }

  // ── DRIFT: monotonic trend toward a safe-range limit ─────────────────────
  const drift = detectDrift(type, recentDesc, m);
  if (drift) return drift;

  return { state: 'normal' };
}

function detectDrift(type: AnomalyTypeInfo, recentDesc: number[], m: number): { state: 'anomaly'; result: AnomalyResult } | null {
  if (type.minValue === null && type.maxValue === null) return null;
  const seq = recentDesc.slice(0, DRIFT_RUN);
  if (seq.length < DRIFT_RUN) return null;
  // chronological: oldest → newest
  const chrono = [...seq].reverse();
  const rising = chrono.every((x, i) => i === 0 || x > chrono[i - 1]);
  const falling = chrono.every((x, i) => i === 0 || x < chrono[i - 1]);
  if (!rising && !falling) return null;
  const v = chrono[chrono.length - 1];

  // Toward which limit? rising→max, falling→min.
  if (rising && type.maxValue !== null) {
    const lo = type.minValue ?? (m - (type.maxValue - m)); // synth lower edge if no min
    const band = type.maxValue - lo;
    if (band > EPS && v >= type.maxValue - band * DRIFT_OUTER_BAND && v < type.maxValue) {
      return mkDrift(type, m, v, 'up');
    }
  }
  if (falling && type.minValue !== null) {
    const hi = type.maxValue ?? (m + (m - type.minValue));
    const band = hi - type.minValue;
    if (band > EPS && v <= type.minValue + band * DRIFT_OUTER_BAND && v > type.minValue) {
      return mkDrift(type, m, v, 'down');
    }
  }
  return null;
}

function mkDrift(type: AnomalyTypeInfo, m: number, v: number, dir: 'up' | 'down'): { state: 'anomaly'; result: AnomalyResult } {
  return anomaly('drift', 'warn', m, null, v, 0, 0.55,
    `${type.name} has been trending ${dir === 'up' ? 'up' : 'down'} toward its safe limit over the last ${DRIFT_RUN} readings (now ${round1(v)}${type.unit}) — check before it fails.`,
    `${type.name} ha estado ${dir === 'up' ? 'subiendo' : 'bajando'} hacia su límite seguro en las últimas ${DRIFT_RUN} lecturas (ahora ${round1(v)}${type.unit}) — revisa antes de que falle.`,
    false);
}

// ─── meter readings (cumulative) ────────────────────────────────────────────

function analyzeMeter(type: AnomalyTypeInfo, history: HistoryPoint[], current: HistoryPoint): AnomalyOutcome {
  const all = [...history, current]
    .filter((h) => Number.isFinite(h.value))
    .sort((a, b) => a.at - b.at);
  if (all.length < 2) return { state: 'learning', have: 0, need: MIN_METER_INTERVALS };

  // Consumption deltas between consecutive readings; drop negatives (meter
  // rollover / reset) — they aren't real consumption.
  const deltas: number[] = [];
  for (let i = 1; i < all.length; i++) {
    const d = all[i].value - all[i - 1].value;
    if (d >= 0) deltas.push(d);
    else deltas.push(NaN); // mark rollover; excluded below
  }
  const cleanDeltas = deltas.filter((d) => Number.isFinite(d));
  const currentDelta = deltas[deltas.length - 1];
  const priorDeltas = cleanDeltas.slice(0, -1); // exclude current

  if (priorDeltas.length < MIN_METER_INTERVALS || !Number.isFinite(currentDelta)) {
    return { state: 'learning', have: priorDeltas.length, need: MIN_METER_INTERVALS };
  }

  const baseline = mean(priorDeltas);
  const sd = stddev(priorDeltas, baseline);
  if (baseline <= EPS) {
    // Property barely consumes on this meter — can't reason about ratios.
    return { state: 'normal' };
  }
  const ratio = currentDelta / baseline;

  // ── SPIKE (possible leak) ────────────────────────────────────────────────
  if (ratio >= METER_SPIKE_WARN) {
    const highLeak = ratio >= METER_LEAK_RATIO;
    const severity: AnomalySeverity = ratio >= METER_SPIKE_CRIT ? 'critical' : 'warn';
    const x = round1(ratio);
    return anomaly('spike', severity, baseline, sd, currentDelta, x,
      Math.min(0.95, 0.5 + ratio / 10),
      `${type.name} usage is ${x}× its normal rate this interval — possible leak or equipment fault. Check the system.`,
      `El uso de ${type.name} es ${x}× su tasa normal en este intervalo — posible fuga o falla del equipo. Revisa el sistema.`,
      highLeak);
  }

  // ── FLATLINE (stuck / dead meter or supply off) ──────────────────────────
  const tailFlat = cleanDeltas.slice(-METER_FLAT_RUN);
  if (
    tailFlat.length >= METER_FLAT_RUN &&
    tailFlat.every((d) => d <= baseline * METER_FLAT_FRACTION)
  ) {
    return anomaly('flatline', 'warn', baseline, sd, currentDelta, 0, 0.6,
      `${type.name} hasn't moved across the last ${METER_FLAT_RUN} readings (normal use is ~${round1(baseline)}${type.unit}/interval) — the meter may be stuck or the supply is off.`,
      `${type.name} no se ha movido en las últimas ${METER_FLAT_RUN} lecturas (uso normal ~${round1(baseline)}${type.unit}/intervalo) — el medidor puede estar atascado o el suministro apagado.`,
      false);
  }

  return { state: 'normal' };
}

// ─── helper ──────────────────────────────────────────────────────────────────

function anomaly(
  kind: AnomalyKind, severity: AnomalySeverity,
  baselineMean: number | null, baselineStddev: number | null,
  observed: number, score: number, confidence: number,
  reasonEn: string, reasonEs: string, highConfidenceLeak: boolean,
): { state: 'anomaly'; result: AnomalyResult } {
  return {
    state: 'anomaly',
    result: { kind, severity, baselineMean, baselineStddev, observed, score, confidence, reasonEn, reasonEs, highConfidenceLeak },
  };
}
