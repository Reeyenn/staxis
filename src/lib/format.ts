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
 * Dollars → cents keeping SIX DECIMAL PLACES of a cent.
 *
 * Not every money number in this app is a whole cent, and rounding one that
 * isn't is a real bug rather than a tidy-up. A per-unit weighted-average cost
 * is derived by division (`total_cost / quantity` — see
 * 0324_inventory_operational_corrections.sql:1114), so $13.365 per unit is a
 * legitimate stored value, and the ending value of 200 of them is $2673.00
 * exactly. Round the per-unit cost to a whole cent first and that becomes
 * $2674.00: the error is multiplied by the quantity.
 *
 * The precision here matches `round(unit_cost * 100, 6)` in
 * 0322_inventory_month_close.sql:1225 EXACTLY, and it has to. That expression
 * computes the committed month close; this one computes the preview the manager
 * reads before committing. If they disagree, the hotel is shown one number and
 * charged another.
 *
 * Use `dollarsToCents` for anything a person typed or that lands in an integer
 * `_cents` column. Use this ONLY for per-unit costs feeding valuation math.
 */
export function dollarsToFractionalCents(dollars: number): number {
  if (!Number.isFinite(dollars)) return 0;
  return Number(shiftDecimalExponent(dollars, 2).toFixed(6));
}

/**
 * Cents → dollars as a number. `1999` → `19.99`. For DISPLAY and for handing to
 * the legacy dollar-storing ledger columns. Never use the result for further
 * money arithmetic — sum in cents, convert once at the edge.
 *
 * Does NOT round: a fractional-cent input returns fractional dollars
 * (`centsToDollars(1.5)` is `0.015`, not `0.02`). That is deliberate, so the
 * weighted-average costs above survive a round trip, but it means this is not a
 * substitute for formatting — use `formatMoney` when a person will read it.
 */
export function centsToDollars(cents: number): number {
  if (!Number.isFinite(cents)) return 0;
  return shiftDecimalExponent(cents, -2);
}

/**
 * Cents → "$12.34", NO thousands separator, for email and purchase-order
 * templates. Null-safe alias of `moneyFromCents`.
 *
 * Pick deliberately — there are three money formatters and they differ:
 *   • this one          → "$1750.50"   (plain templates)
 *   • financials/shared formatCents → "$1,750.50"  (grouped; the UI default)
 *   • findings/pricing  formatMoney   → "$1,751"    (whole dollars, prose)
 * They are not interchangeable, and the names are close enough to grab the
 * wrong one from autocomplete.
 */
export function formatMoney(cents: number): string {
  return moneyFromCents(Number.isFinite(cents) ? cents : 0);
}

// Parsing user-typed dollars lives in `parseDollarsToCents` in
// financials/shared.ts, which owns a deliberately STRICT grammar (it rejects
// "1e3", "0x1f" and other shapes bare Number() would happily accept and turn
// into a four-figure amount). It delegates its arithmetic here. There is no
// second parser in this module on purpose: a laxer sibling one autocomplete
// away from the strict one is exactly how a typo becomes a wrong charge.
