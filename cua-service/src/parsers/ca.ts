/**
 * Choice Advantage parsers (Plan v7 Phase 2b).
 *
 * Per-field value transformers for CA's specific data shapes. The mapper
 * learns which parser to use per field during the mapping run; runtime
 * composes by name via parsers/registry.ts.
 *
 * Today's CA-specific transforms (matched against the legacy
 * choice-advantage.ts normalizers):
 *   - ca_date: "10/24/2026" → "2026-10-24" ISO
 *   - ca_currency: "$1,234.56" → 123456 (cents as integer)
 *   - ca_status: "OCC" → "occupied"; "VAC" → "vacant_clean"; etc.
 *   - ca_integer: "12,345" → 12345
 *   - ca_boolean_yn: "Y" → true; "N" → false
 *
 * Add a new parser:
 *   1. Write the function below.
 *   2. registerParser('your_name', fn) in the import side-effect.
 *   3. Mapper output references it by name in TableTemplate.fields.parser.
 */

import { registerParser } from './registry.js';
import { log } from '../log.js';

// ─── Shared helpers ─────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const pad2 = (n: number | string): string => String(n).padStart(2, '0');
/** 2-digit year → 4-digit, POSIX-style pivot (00-69 → 2000s, 70-99 → 1900s). */
const pivotYear = (yy: string): number => {
  const n = parseInt(yy, 10);
  return n <= 69 ? 2000 + n : 1900 + n;
};

// ─── Date ──────────────────────────────────────────────────────────────

/**
 * CA emits dates as "M/D/YYYY" or "MM/DD/YYYY". Some report endpoints
 * (Housekeeping Check-off List CSV) format as "MM-DD-YYYY"; some truncate to a
 * 2-digit year ("6/10/26"); a few use a textual month ("Jun 10, 2026" /
 * "10 June 2026"). A few JSON endpoints return ISO already. Handle all of them
 * before giving up — a `null` here rejects a REQUIRED reservation row, so it's
 * worth being generous about input shapes.
 */
registerParser('ca_date', (raw: unknown): string | null => {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  // ISO already.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // M/D/YYYY or MM/DD/YYYY (slash) and MM-DD-YYYY (dash) — 4-digit year.
  const full = s.match(/^(\d{1,2})([/-])(\d{1,2})\2(\d{4})$/);
  if (full) {
    const [, m, , d, y] = full;
    return `${y}-${pad2(m!)}-${pad2(d!)}`;
  }
  // 2-digit year: M/D/YY or M-D-YY (same separator). CA occasionally truncates.
  const short = s.match(/^(\d{1,2})([/-])(\d{1,2})\2(\d{2})$/);
  if (short) {
    const [, m, , d, y] = short;
    return `${pivotYear(y!)}-${pad2(m!)}-${pad2(d!)}`;
  }
  // Textual month, month-first: "Jun 10, 2026" / "June 10 2026".
  const mdY = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (mdY) {
    const mo = MONTHS[mdY[1]!.slice(0, 3).toLowerCase()];
    if (mo) return `${mdY[3]}-${pad2(mo)}-${pad2(mdY[2]!)}`;
  }
  // Textual month, day-first: "10 Jun 2026" / "10 June, 2026".
  const dMY = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/);
  if (dMY) {
    const mo = MONTHS[dMY[2]!.slice(0, 3).toLowerCase()];
    if (mo) return `${dMY[3]}-${pad2(mo)}-${pad2(dMY[1]!)}`;
  }
  // Unrecognized — null (validator will reject if field is required).
  return null;
});

// ─── Currency ──────────────────────────────────────────────────────────

/**
 * CA emits currency as "$1,234.56" or "1,234.56" (sometimes without $).
 * Empty / "--" / null → null. Always converts to integer cents.
 */
registerParser('ca_currency', (raw: unknown): number | null => {
  if (raw == null || raw === '') return null;
  // Trim + uppercase BEFORE the sentinel check so lowercase "n/a" is caught.
  const s = String(raw).trim().toUpperCase();
  if (s === '--' || s === 'N/A' || s === '-') return null;
  // Strip $, commas, whitespace; keep digits + decimal.
  const cleaned = s.replace(/[$,\s]/g, '');
  const f = parseFloat(cleaned);
  if (!Number.isFinite(f)) return null;
  return Math.round(f * 100);
});

// ─── Status enum ──────────────────────────────────────────────────────

/**
 * CA's room-status codes vary by report:
 *   "OCC" / "Occupied" → 'occupied'
 *   "VAC" / "Vacant" → 'vacant_clean' (if condition is Clean)
 *                    → 'vacant_dirty' (if condition is Dirty)
 *   "OOO" / "Out of Order" → 'out_of_order'
 *
 * This parser only handles the status code, NOT the condition. The
 * mapper should set up separate fields for status + condition; the
 * normalizer (or a per-field cross-field validator) does the OCC+CLEAN
 * → vacant_clean derivation.
 */
registerParser('ca_status', (raw: unknown): string | null => {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().toUpperCase();
  if (s.startsWith('OCC') || s === 'OCCUPIED') return 'occupied';
  // Explicit vacant-dirty codes MUST be checked before the VAC* catch-all —
  // "VACANT DIRTY".startsWith('VAC') would otherwise mislabel it vacant_clean.
  if (s === 'VD' || s === 'VACANT DIRTY' || s === 'VACANT-DIRTY') return 'vacant_dirty';
  if (s === 'VC' || s === 'VACANT CLEAN' || s === 'VACANT-CLEAN' || s.startsWith('VAC') || s === 'VACANT') return 'vacant_clean';
  if (s === 'OOO' || s === 'OUT OF ORDER' || s === 'OUT-OF-ORDER') return 'out_of_order';
  if (s === 'INSP' || s === 'INSPECTED') return 'inspected';
  // Unrecognized — surface as a read-health signal instead of silently
  // emitting 'unknown'. 'unknown' is a valid enum value so the row still
  // writes, but a flood of these means the status column drifted or was
  // mis-mapped and needs a new code added above.
  log.warn('ca_status: unrecognized room-status code — defaulting to "unknown"', { raw: s.slice(0, 40) });
  return 'unknown';
});

// ─── Integer ──────────────────────────────────────────────────────────

/**
 * Plain integer parser — strips commas + whitespace.
 */
registerParser('ca_integer', (raw: unknown): number | null => {
  if (raw == null || raw === '') return null;
  // Trim + uppercase BEFORE the sentinel check so lowercase "n/a" is caught.
  const s = String(raw).trim().toUpperCase();
  if (s === '--' || s === 'N/A' || s === '-') return null;
  const cleaned = s.replace(/[,\s]/g, '');
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : null;
});

// ─── Boolean (Y/N) ─────────────────────────────────────────────────────

/**
 * CA's Y/N boolean shorthand. Also handles "true"/"false" + checkbox
 * presence ("✓"/"") in case a future report uses those.
 */
registerParser('ca_boolean_yn', (raw: unknown): boolean | null => {
  if (raw == null) return null;
  if (typeof raw === 'boolean') return raw;
  const s = String(raw).trim().toUpperCase();
  if (s === '') return null;
  if (s === 'Y' || s === 'YES' || s === 'TRUE' || s === '✓' || s === '1') return true;
  if (s === 'N' || s === 'NO' || s === 'FALSE' || s === '' || s === '0') return false;
  return null;
});
