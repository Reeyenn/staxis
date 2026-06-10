/**
 * Self-learned value translation (feat/pms-universal-translate).
 *
 * Pure, side-effect-free helpers the mapper uses to turn what it OBSERVES on a
 * PMS page during the first mapping run into translation rules SAVED in the
 * knowledge file:
 *
 *   - inferDateFormat(samples)  → the date ORDER (MDY/DMY/YMD) for this PMS,
 *     deterministically, with a confidence/abstain path for ambiguous samples.
 *   - sanitizeEnumMapping(raw, canonical) → keep only the model-emitted
 *     raw→canonical entries whose target is a REAL canonical value (drops
 *     hallucinations / abstentions).
 *
 * Kept pure (no Playwright, no Claude, no DB) so the universality test can
 * exercise the learning logic on synthetic "PMS X" data with no live run.
 */

import type { LearnedDateFormat, DateOrder } from './types.js';

/** Most-frequent element (first-seen wins ties). */
function mode(xs: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best: string | undefined;
  let bestN = -1;
  for (const [x, n] of counts) {
    if (n > bestN) { best = x; bestN = n; }
  }
  return best;
}

interface NumericSample {
  sep: string;
  tokens: number[];
  firstLen: number;
}

/**
 * Infer a PMS's date ORDER from a handful of raw date strings observed during
 * mapping. Deterministic:
 *   - ISO ("2026-06-13") → YMD, high confidence.
 *   - a 4-digit leading token → YMD, high confidence.
 *   - else the year is last; disambiguate M/D vs D/M by ANY token that exceeds
 *     12 across the samples (a "13" can only be a day) → high confidence.
 *   - if every numeric token is ≤ 12 (all samples ambiguous) → ABSTAIN: returns
 *     the MDY default at LOW confidence so the runtime parser uses its heuristic
 *     rather than trusting a coin-flip order.
 * Textual-month samples ("13 Jun 2026") need no learned order — generic_date
 * handles them unambiguously — so they're ignored here. Returns null when there
 * is nothing numeric to learn from.
 */
export function inferDateFormat(rawSamples: Array<string | null | undefined>): LearnedDateFormat | null {
  const samples = rawSamples.map((s) => String(s ?? '').trim()).filter((s) => s !== '');
  if (samples.length === 0) return null;

  let sawIso = false;
  const numeric: NumericSample[] = [];
  for (const s of samples) {
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) { sawIso = true; continue; }
    if (/[A-Za-z]/.test(s)) continue; // textual month — handled by the heuristic
    const sepMatch = s.match(/[^\d]/);
    if (!sepMatch) continue;
    const parts = s.split(/[^\d]+/).filter((p) => p !== '');
    if (parts.length !== 3) continue;
    const tokens = parts.map((p) => parseInt(p, 10));
    if (tokens.some((n) => !Number.isFinite(n))) continue;
    numeric.push({ sep: sepMatch[0]!, tokens, firstLen: parts[0]!.length });
  }

  const sampleTrail = samples.slice(0, 5);
  if (numeric.length === 0) {
    return sawIso ? { order: 'YMD', confidence: 'high', samples: sampleTrail } : null;
  }

  const sep = mode(numeric.map((n) => n.sep));
  const base = (order: DateOrder, confidence: 'high' | 'low'): LearnedDateFormat =>
    ({ order, confidence, samples: sampleTrail, ...(sep ? { separator: sep } : {}) });

  // A 4-digit leading token anywhere ⇒ YMD.
  if (numeric.some((n) => n.firstLen === 4)) return base('YMD', 'high');

  const maxPos0 = Math.max(...numeric.map((n) => n.tokens[0]!));
  const maxPos1 = Math.max(...numeric.map((n) => n.tokens[1]!));

  if (maxPos0 > 12 && maxPos1 <= 12) return base('DMY', 'high'); // first token can only be a day
  if (maxPos1 > 12 && maxPos0 <= 12) return base('MDY', 'high'); // second token can only be a day
  // All ≤ 12 (genuinely ambiguous) or both > 12 (contradictory garbage) →
  // abstain: low-confidence MDY default; runtime falls back to the heuristic.
  return base('MDY', 'low');
}

/**
 * Keep only the model-emitted raw→canonical enum entries whose TARGET is a real
 * canonical value for this column. Drops hallucinated targets and any value the
 * model abstained on — so an unrecognized PMS code never silently maps to a
 * made-up status; it just isn't in the map (→ generic_enum's safe default).
 */
export function sanitizeEnumMapping(
  rawMapping: unknown,
  canonicalValues: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!rawMapping || typeof rawMapping !== 'object') return out;
  const canon = new Set(canonicalValues);
  for (const [k, v] of Object.entries(rawMapping as Record<string, unknown>)) {
    if (typeof v !== 'string') continue;
    const key = String(k).trim();
    if (key === '') continue;
    if (canon.has(v)) out[key] = v;
  }
  return out;
}

/**
 * Merge a freshly-sanitized per-column mapping into the running
 * valueTranslations accumulator (keyed `${table}.${column}`). Later observations
 * win on key collisions (a richer drill of the same column refines the earlier
 * one). Returns the same object for chaining.
 */
export function mergeValueTranslation(
  acc: Record<string, Record<string, string>>,
  tableCol: string,
  mapping: Record<string, string>,
): Record<string, Record<string, string>> {
  if (Object.keys(mapping).length === 0) return acc;
  acc[tableCol] = { ...(acc[tableCol] ?? {}), ...mapping };
  return acc;
}
