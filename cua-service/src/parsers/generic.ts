/**
 * Generic, PMS-AGNOSTIC value parsers (feat/pms-universal-translate).
 *
 * These replace the Choice-Advantage-specific parsers (parsers/ca.ts) as the
 * DEFAULT translation path for every PMS. They take a raw extracted string
 * (CSV cell / DOM text / JSON field) and return the canonical typed value the
 * generic-table-writer expects — with NO per-PMS code:
 *
 *   - generic_currency : any symbol/locale "$1,234.56" / "1.234,56 €" → 123456 cents
 *   - generic_integer  : "12,345" / "12.345" / "1 234"               → 12345
 *   - generic_number   : "12.5" / "12,5"                              → 12.5  (numeric cols)
 *   - generic_boolean  : Y/N/yes/no/true/false/1/0/✓                  → boolean
 *   - generic_date     : driven by a LEARNED format (order MDY/DMY/YMD) saved
 *                        in the knowledge file; falls back to a heuristic when
 *                        no format was learned. Always calendar-validates.
 *   - generic_enum     : maps a raw value through a LEARNED raw→canonical map
 *                        (saved per PMS family in the knowledge file); unknown
 *                        values → a safe default/null + a warn (never throws).
 *
 * The two PMS-specific things — the date ORDER and the enum VOCABULARY — are
 * not hand-coded here; they're learned during mapping (mapper.ts +
 * value-learning.ts), saved in the map, and handed in via `config`
 * (ParserConfig). That's what makes a brand-new PMS translate with zero new
 * hand-written code.
 */

import { registerParser } from './registry.js';
import { log } from '../log.js';
import type { ParserConfig, DateOrder } from '../types.js';

// ─── Shared date helpers (calendar-validating; copied from ca.ts so the ──────
//     generic path no longer depends on the CA module) ─────────────────────

const MONTH_LOOKUP: Record<string, number> = (() => {
  const full = ['january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'];
  const m: Record<string, number> = { sept: 9 };
  full.forEach((name, i) => { m[name] = i + 1; m[name.slice(0, 3)] = i + 1; });
  return m;
})();

const pad2 = (n: number | string): string => String(n).padStart(2, '0');

/** 2-digit year → 4-digit, POSIX-style pivot (00-69 → 2000s, 70-99 → 1900s). */
const pivotYear = (yy: string): number => {
  const n = parseInt(yy, 10);
  return n <= 69 ? 2000 + n : 1900 + n;
};

/**
 * Assemble Y/M/D into an ISO date ONLY if it's a real calendar date — returns
 * null for Feb 30, month 13, day 0, etc. CRITICAL: validateRows' date check is
 * only a `/^\d{4}-\d{2}-\d{2}/` SHAPE regex, so a fake "2026-13-40" passes
 * validation and then THROWS at the Postgres `date` column, losing the ENTIRE
 * write batch. Returning null here rejects only the one offending row.
 */
const toIsoDate = (y: number, mo: number, d: number): string | null => {
  if (!Number.isInteger(y) || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${pad2(mo)}-${pad2(d)}`;
};

// ─── Shared number helpers (locale-agnostic) ─────────────────────────────────

const NUMERIC_SENTINELS = new Set(['', '--', '-', 'N/A', 'NA', 'NULL', 'NONE']);

/**
 * Parse a number written in ANY common locale into a JS float — locale-agnostic
 * decimal/thousands resolution (no Intl locale needed):
 *   "$1,234.56" → 1234.56   "1.234,56 €" → 1234.56   "1 234,5" → 1234.5
 *   "(1,234.56)" → -1234.56  "12.345" (3-grouped) → 12345   "1,5" → 1.5
 * Returns null for blanks / sentinels / unparseable input.
 */
function parseLocaleNumber(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const s0 = String(raw).trim();
  if (NUMERIC_SENTINELS.has(s0.toUpperCase())) return null;

  // Accounting negatives: (1,234.56) or trailing/leading minus.
  const negative = /^\(.*\)$/.test(s0) || /-/.test(s0);

  // Keep only digits and the two grouping characters.
  const cleaned = s0.replace(/[^0-9.,]/g, '');
  if (cleaned === '' || !/[0-9]/.test(cleaned)) return null;

  const hasDot = cleaned.includes('.');
  const hasComma = cleaned.includes(',');
  let normalized: string;

  if (hasDot && hasComma) {
    // The separator that appears LAST is the decimal; the other is thousands.
    const decimalChar = cleaned.lastIndexOf('.') > cleaned.lastIndexOf(',') ? '.' : ',';
    const thousandsChar = decimalChar === '.' ? ',' : '.';
    normalized = cleaned.split(thousandsChar).join('').replace(decimalChar, '.');
  } else if (hasComma || hasDot) {
    const sep = hasComma ? ',' : '.';
    const parts = cleaned.split(sep);
    const lastGroup = parts[parts.length - 1]!;
    // A single separator with a non-3-digit tail → decimal ("1,5", "12.50").
    // Multiple separators, or one with exactly 3 trailing digits → thousands
    // ("1,234", "1.234.567", "12,345"). 3 trailing digits is treated as
    // thousands (the common case for tabular money/counts).
    const isDecimal = parts.length === 2 && lastGroup.length !== 3;
    normalized = isDecimal ? `${parts[0]}.${lastGroup}` : parts.join('');
  } else {
    normalized = cleaned;
  }

  const n = parseFloat(normalized);
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

// ─── Currency → integer cents ────────────────────────────────────────────────

registerParser('generic_currency', (raw: unknown): number | null => {
  const n = parseLocaleNumber(raw);
  if (n == null) return null;
  return Math.round(n * 100);
});

// ─── Integer ─────────────────────────────────────────────────────────────────

registerParser('generic_integer', (raw: unknown): number | null => {
  const n = parseLocaleNumber(raw);
  if (n == null) return null;
  return Math.round(n);
});

// ─── Number (numeric / decimal columns, e.g. percentages) ───────────────────

registerParser('generic_number', (raw: unknown): number | null => {
  return parseLocaleNumber(raw);
});

// ─── Boolean ─────────────────────────────────────────────────────────────────

const TRUE_TOKENS = new Set(['Y', 'YES', 'TRUE', 'T', '1', '✓', '✔', 'X']);
const FALSE_TOKENS = new Set(['N', 'NO', 'FALSE', 'F', '0', '✗', '✘', '']);

registerParser('generic_boolean', (raw: unknown): boolean | null => {
  if (raw == null) return null;
  if (typeof raw === 'boolean') return raw;
  const s = String(raw).trim().toUpperCase();
  if (TRUE_TOKENS.has(s)) return true;
  if (FALSE_TOKENS.has(s)) return false;
  return null;
});

// ─── Date ────────────────────────────────────────────────────────────────────

/** Order the 3 numeric components by a known order → toIsoDate. Handles a
 *  2-digit year via the pivot. Returns null on any non-calendar date. */
function assembleByOrder(parts: number[], rawParts: string[], order: DateOrder): string | null {
  if (parts.length !== 3) return null;
  let y: number, mo: number, d: number;
  if (order === 'YMD') {
    y = parts[0]!; mo = parts[1]!; d = parts[2]!;
    if (rawParts[0]!.length <= 2) y = pivotYear(rawParts[0]!);
  } else {
    // MDY or DMY — the year is the last component.
    y = parts[2]!;
    if (rawParts[2]!.length <= 2) y = pivotYear(rawParts[2]!);
    if (order === 'MDY') { mo = parts[0]!; d = parts[1]!; }
    else { d = parts[0]!; mo = parts[1]!; }
  }
  return toIsoDate(y, mo, d);
}

/**
 * Universal date parser. With a learned `config.dateFormat` (high confidence),
 * parses strictly by the learned order — so "6/10" never has to be guessed.
 * Without one (or low confidence), falls back to a heuristic that resolves
 * M/D-vs-D/M only when a token is unambiguous (>12); otherwise assumes M/D
 * (US-style, matching the legacy ca_date behavior). Always calendar-validates.
 */
registerParser('generic_date', (raw: unknown, config?: ParserConfig): string | null => {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (s === '') return null;

  // ISO already — still calendar-validate (a fake "2026-13-40" must not pass).
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return toIsoDate(+iso[1]!, +iso[2]!, +iso[3]!);

  // Textual month forms are unambiguous regardless of learned order.
  const mdY = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{2,4})$/);
  if (mdY) {
    const mo = MONTH_LOOKUP[mdY[1]!.toLowerCase()];
    if (mo) return toIsoDate(mdY[3]!.length <= 2 ? pivotYear(mdY[3]!) : +mdY[3]!, mo, +mdY[2]!);
  }
  const dMY = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{2,4})$/);
  if (dMY) {
    const mo = MONTH_LOOKUP[dMY[2]!.toLowerCase()];
    if (mo) return toIsoDate(dMY[3]!.length <= 2 ? pivotYear(dMY[3]!) : +dMY[3]!, mo, +dMY[1]!);
  }

  // Numeric, separator-delimited. Split on the first non-digit run.
  const rawParts = s.split(/[^0-9]+/).filter((p) => p !== '');
  if (rawParts.length !== 3) return null;
  const parts = rawParts.map((p) => parseInt(p, 10));
  if (parts.some((n) => !Number.isFinite(n))) return null;

  // Learned, trusted order wins.
  const fmt = config?.dateFormat;
  if (fmt && fmt.confidence === 'high') {
    return assembleByOrder(parts, rawParts, fmt.order);
  }

  // Heuristic fallback. A 4-digit leading token ⇒ YMD.
  if (rawParts[0]!.length === 4) return assembleByOrder(parts, rawParts, 'YMD');
  // Disambiguate M/D vs D/M by a token that can't be a month.
  if (parts[0]! > 12 && parts[1]! <= 12) return assembleByOrder(parts, rawParts, 'DMY');
  if (parts[1]! > 12 && parts[0]! <= 12) return assembleByOrder(parts, rawParts, 'MDY');
  // Both ≤ 12 — genuinely ambiguous. Prefer a learned low-confidence order if
  // present, else assume MDY (US default; matches legacy ca_date).
  return assembleByOrder(parts, rawParts, fmt?.order ?? 'MDY');
});

// ─── Enum (learned vocabulary) ───────────────────────────────────────────────

/** Normalize a raw enum value for lookup: trim + upper + collapse whitespace.
 *  Conservative — does NOT strip separators, so distinct codes don't collide. */
function normEnumKey(s: string): string {
  return s.trim().toUpperCase().replace(/\s+/g, ' ');
}

/**
 * Translate a PMS-specific enum value to its canonical form via the LEARNED
 * mapping (config.mapping, saved per PMS family). An unrecognized value maps to
 * config.onUnknown (default null) and is logged — never throws, so one weird
 * cell can't crash the batch; a required column then rejects only its own row.
 */
registerParser('generic_enum', (raw: unknown, config?: ParserConfig): string | null => {
  if (raw == null || raw === '') return null;
  const onUnknown = config?.onUnknown ?? null;
  const mapping = config?.mapping;
  if (!mapping) return onUnknown;

  const key = normEnumKey(String(raw));
  // Direct hit (exact stored key) first, then normalized comparison.
  if (Object.prototype.hasOwnProperty.call(mapping, String(raw).trim())) {
    return mapping[String(raw).trim()]!;
  }
  for (const [k, v] of Object.entries(mapping)) {
    if (normEnumKey(k) === key) return v;
  }
  log.warn('generic_enum: unrecognized value — using safe default', {
    raw: String(raw).slice(0, 40),
    onUnknown,
  });
  return onUnknown;
});

// Exported for unit tests (the universality test exercises these directly).
export { parseLocaleNumber, toIsoDate, normEnumKey };
