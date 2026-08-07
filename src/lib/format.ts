// Small, dependency-free formatting helpers shared across server-side
// renderers (email templates, purchase orders) that had grown byte-identical
// private copies. Pure string functions — safe to import from any context.

/**
 * HTML-escape the five entities that matter inside interpolated email/HTML
 * templates: & < > " '. Null/undefined coalesce to '' (matches the
 * null-tolerant `esc` variant these copies converged from).
 *
 * Consolidates the previously-duplicated private copies:
 *   - reports/email-template.ts        escapeHtml()
 *   - email/onboarding-invite.ts       escapeHtml()
 *   - email/phone-pairing-code.ts      escapeHtml()
 *   - ordering/email.ts                esc()
 */
export function escapeHtml(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Cents → "$12.34". Fixed 2-decimal USD, no thousands separator — the exact
 * shape the vendor PO + housekeeping report emails render.
 *
 * Consolidates the byte-identical private copies:
 *   - reports/email-template.ts   fmtMoney()
 *   - ordering/email.ts           money()
 */
export function moneyFromCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ════════════════════════════════════════════════════════════════════════
// Money unit conversion — the ONE place dollars↔cents math is allowed.
// ════════════════════════════════════════════════════════════════════════
// Storage is integer cents; every user-facing display is dollars. The 2026-07-22
// audit counted ~94 hand-coded `* 100` / `/ 100` seams across the app — a single
// missed or doubled conversion silently corrupts money (it already happened once:
// the inventory month-strip divided dollars by 100 again and showed 1% of real
// spend). Route every conversion through these helpers instead of open-coding it.
//
// Why not plain `dollars * 100`: binary floats make that wrong at the half-cent
// boundary. `1.005 * 100` is 100.49999999999999, so Math.round gives 100¢ when
// the user typed $1.005 and meant 101¢. `shiftDecimalExponent` moves the decimal
// point in STRING space instead, so the literal 100.5 is parsed exactly and
// rounds the way a human expects.

/**
 * Multiply `value` by 10^exponent without binary-float drift, by editing the
 * decimal exponent of the number's own string form. Handles values JS already
 * prints in scientific notation ("1e-7").
 */
function shiftDecimalExponent(value: number, exponent: number): number {
  if (!Number.isFinite(value)) return NaN;
  const [mantissa, exp] = String(value).split('e');
  return Number(`${mantissa}e${(exp ? Number(exp) : 0) + exponent}`);
}

/** Round half AWAY FROM ZERO, so -1.5 → -2 rather than JS's -1. */
function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * Dollars → integer cents. `19.99` → `1999`. Rounds to the nearest cent
 * (half away from zero). Non-finite input → 0, so a NaN never reaches storage
 * as a silent null.
 */
export function dollarsToCents(dollars: number): number {
  if (!Number.isFinite(dollars)) return 0;
  return roundHalfAwayFromZero(shiftDecimalExponent(dollars, 2));
}

/**
 * Integer cents → dollars as a number. `1999` → `19.99`. For DISPLAY and for
 * handing to the legacy dollar-storing ledger columns. Never use the result for
 * further money arithmetic — sum in cents, convert once at the edge.
 */
export function centsToDollars(cents: number): number {
  if (!Number.isFinite(cents)) return 0;
  return shiftDecimalExponent(cents, -2);
}

/**
 * Cents → "$12.34" for user-facing copy. Canonical name; `moneyFromCents` is
 * the older alias kept for existing callers.
 */
export function formatMoney(cents: number): string {
  return moneyFromCents(Number.isFinite(cents) ? cents : 0);
}

/**
 * Parse user-typed dollars (a form field, a scanned invoice string) into integer
 * cents. Tolerates "$", thousands separators and surrounding whitespace.
 * Returns null for blank/unparseable input so callers can distinguish
 * "not provided" from "zero" — a real distinction for unit cost, where null
 * means unknown and 0 means free.
 */
export function parseDollarsToCents(input: string | number | null | undefined): number | null {
  if (input == null) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? dollarsToCents(input) : null;
  const cleaned = input.replace(/[$,\s]/g, '');
  if (cleaned === '') return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? dollarsToCents(parsed) : null;
}
