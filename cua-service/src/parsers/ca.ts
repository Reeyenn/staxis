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

// ─── Date ──────────────────────────────────────────────────────────────

/**
 * CA emits dates as "M/D/YYYY" or "MM/DD/YYYY". Some report endpoints
 * (Housekeeping Check-off List CSV) format as "MM-DD-YYYY". A few JSON
 * endpoints return ISO already. Handle all three.
 */
registerParser('ca_date', (raw: unknown): string | null => {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  // ISO already.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // M/D/YYYY or MM/DD/YYYY.
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const [, m, d, y] = slash;
    return `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
  }
  // MM-DD-YYYY (dash variant).
  const dash = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dash) {
    const [, m, d, y] = dash;
    return `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
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
  const s = String(raw).trim();
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
  if (s.startsWith('VAC') || s === 'VACANT') return 'vacant_clean';
  if (s === 'OOO' || s === 'OUT OF ORDER' || s === 'OUT-OF-ORDER') return 'out_of_order';
  if (s === 'INSPECTED') return 'inspected';
  return 'unknown';
});

// ─── Integer ──────────────────────────────────────────────────────────

/**
 * Plain integer parser — strips commas + whitespace.
 */
registerParser('ca_integer', (raw: unknown): number | null => {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
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
