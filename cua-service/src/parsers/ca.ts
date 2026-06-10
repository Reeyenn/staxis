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

// Full month names + their 3-letter abbreviations (and the common "sept"),
// matched against the WHOLE token so "Junuary" doesn't silently resolve to June.
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
  // Date.UTC normalizes overflow (Feb 30 → Mar 2); reject if it rolled over.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${pad2(mo)}-${pad2(d)}`;
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
  // ISO already — still calendar-validate (a fake "2026-13-40" must not pass).
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return toIsoDate(+iso[1]!, +iso[2]!, +iso[3]!);
  // M/D/YYYY or MM/DD/YYYY (slash) and MM-DD-YYYY (dash) — 4-digit year.
  const full = s.match(/^(\d{1,2})([/-])(\d{1,2})\2(\d{4})$/);
  if (full) return toIsoDate(+full[4]!, +full[1]!, +full[3]!);
  // 2-digit year: M/D/YY or M-D-YY (same separator). CA occasionally truncates.
  const short = s.match(/^(\d{1,2})([/-])(\d{1,2})\2(\d{2})$/);
  if (short) return toIsoDate(pivotYear(short[4]!), +short[1]!, +short[3]!);
  // Textual month, month-first: "Jun 10, 2026" / "June 10 2026".
  const mdY = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (mdY) {
    const mo = MONTH_LOOKUP[mdY[1]!.toLowerCase()];
    if (mo) return toIsoDate(+mdY[3]!, mo, +mdY[2]!);
  }
  // Textual month, day-first: "10 Jun 2026" / "10 June, 2026".
  const dMY = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/);
  if (dMY) {
    const mo = MONTH_LOOKUP[dMY[2]!.toLowerCase()];
    if (mo) return toIsoDate(+dMY[3]!, mo, +dMY[1]!);
  }
  // Unrecognized — null (validator rejects only this row if the field is required).
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
  // Separator-agnostic alpha form so "VAC/DIRTY", "VACANT DIRTY", "VACANT\nDIRTY"
  // all compare equal — without over-matching negations (the trap of a bare
  // includes(): "Uninspected"/"Needs Cleaning" must NOT read as inspected/clean).
  const compact = s.replace(/[^A-Z]/g, '');
  if (compact.startsWith('OCC')) return 'occupied';
  if (compact === 'OOO' || compact === 'OUTOFORDER') return 'out_of_order';
  if (compact === 'INSP' || compact === 'INSPECTED') return 'inspected';
  // "DIRTY" as a trailing token wins over the vacant/clean catch-all so a dirty
  // room is never silently shown sellable. endsWith (not includes) so it won't
  // fire on "DIRTYLINENPENDING" or negations like "NOTDIRTY".
  if (compact === 'VD' || compact.endsWith('DIRTY')) return 'vacant_dirty';
  if (compact === 'VC' || compact === 'VACANT' || compact.startsWith('VAC') || compact.endsWith('CLEAN')) return 'vacant_clean';
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
  if (s === 'N' || s === 'NO' || s === 'FALSE' || s === '0') return false;
  return null;
});

// ─── Work-order status enum ────────────────────────────────────────────

/**
 * Normalize a work-order status to the pms_work_orders_v2.status enum
 * {open, in_progress, resolved, cancelled} (migration 0207). Without this, a
 * raw DOM/CSV value like "Open" or "In Progress" fails validateRows' allowed-
 * values check and rejects the WHOLE work-order row. Unrecognized → 'open'
 * (active by default — same fallback as the layer-2 validateWorkOrder), with a
 * warn so genuinely-new states surface instead of silently writing wrong data.
 */
registerParser('ca_work_order_status', (raw: unknown): string | null => {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().toUpperCase().replace(/[_-]/g, ' ');
  if (s === 'OPEN' || s === 'NEW' || s === 'PENDING' || s === 'ACTIVE') return 'open';
  if (s.includes('PROGRESS') || s === 'WIP' || s === 'STARTED' || s === 'ASSIGNED') return 'in_progress';
  if (s === 'RESOLVED' || s === 'CLOSED' || s === 'COMPLETE' || s === 'COMPLETED' || s === 'DONE' || s === 'FIXED') return 'resolved';
  if (s === 'CANCELLED' || s === 'CANCELED' || s === 'VOID' || s === 'VOIDED') return 'cancelled';
  log.warn('ca_work_order_status: unrecognized status — defaulting to "open"', { raw: s.slice(0, 40) });
  return 'open';
});

// ─── Priority enum ─────────────────────────────────────────────────────

/**
 * Normalize a work-order priority to the pms_work_orders_v2.priority enum
 * {low, medium, high, critical, unknown} (migration 0207). priority is
 * OPTIONAL, so a blank → null (field skipped, row survives); an unrecognized
 * value → 'unknown' rather than rejecting the whole row over a non-required
 * field. "urgent"/"emergency" collapse to the nearest enum value, 'critical'.
 */
registerParser('ca_priority', (raw: unknown): string | null => {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase();
  if (s === '') return null;
  if (s === 'LOW') return 'low';
  if (s === 'MEDIUM' || s === 'MED' || s === 'NORMAL' || s === 'STANDARD') return 'medium';
  if (s === 'HIGH') return 'high';
  if (s === 'CRITICAL' || s === 'URGENT' || s === 'EMERGENCY') return 'critical';
  log.warn('ca_priority: unrecognized priority — defaulting to "unknown"', { raw: s.slice(0, 40) });
  return 'unknown';
});
