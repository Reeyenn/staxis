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
