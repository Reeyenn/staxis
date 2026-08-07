// ═══════════════════════════════════════════════════════════════════════════
// Money parsing for imported sheets — text a person typed into Excel, in.
// Integer cents, out.
//
// The dollars-vs-cents confusion has bitten this codebase before (the budgets
// rebuild), and an import is where it bites hardest: nobody re-reads 200 rows
// to notice that "$4.50" became $450. So the rule here is one-directional and
// blunt — EVERY price this feature stores is an integer count of cents in a
// *_cents column (DINV-6), and the only place dollars exist is (a) the text we
// read out of the sheet, and (b) the legacy `inventory.unit_cost` numeric
// column, which predates that rule and is written through centsToDollars().
// ═══════════════════════════════════════════════════════════════════════════

import { centsToDollars, dollarsToCents } from '@/lib/format';

/** Largest per-unit price we will accept from a sheet: $100,000. Anything
 *  above it is a total, a phone number, or an OCR artifact, never a unit
 *  cost for a case of towels. */
export const MAX_UNIT_COST_CENTS = 10_000_000;

/**
 * Parse a money-ish cell into integer cents. Accepts numbers and the shapes
 * people actually type: "$4.50", "4,50" is NOT treated as European decimal
 * (ambiguous with thousands) — only "1,234.56" grouping is understood.
 * Parenthesised negatives ("(4.50)") and leading minus both read as negative
 * and are rejected, since a negative unit price is always a parse mistake.
 *
 * Returns null for anything it cannot read confidently. Null is a fine answer:
 * the confirm screen shows a blank price the manager can fill in, which is
 * honest. A wrong number is not.
 */
export function parseMoneyToCents(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return finiteDollarsToCents(raw);
  if (typeof raw !== 'string') return null;

  let s = raw.trim();
  if (!s) return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1).trim(); }

  // Strip currency symbols and codes, and any trailing per-unit annotation
  // ("$4.50/ea", "4.50 each") which is описание, not part of the number.
  s = s.replace(/[$€£¥]/g, '')
    .replace(/\b(usd|eur|gbp|cad|mxn)\b/gi, '')
    .replace(/\/\s*(ea|each|case|cs|pack|pk|box|unit|roll|bottle|can)\b.*$/i, '')
    .replace(/\s+(ea|each|per\s+\w+)\s*$/i, '')
    .trim();

  if (s.startsWith('-')) { negative = true; s = s.slice(1).trim(); }
  if (s.startsWith('+')) s = s.slice(1).trim();

  // Thousands grouping only: 1,234 / 1,234.56 / 12,345,678.90
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.split(',').join('');
  if (!/^\d*\.?\d+$/.test(s) && !/^\d+\.$/.test(s)) return null;

  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const cents = finiteDollarsToCents(n);
  if (cents === null) return null;
  return negative ? -cents : cents;
}

function finiteDollarsToCents(dollars: number): number | null {
  if (!Number.isFinite(dollars)) return null;
  return dollarsToCents(dollars);
}

// Dollars↔cents conversion now lives in one place for the whole app
// (src/lib/format.ts). This module used to carry its own epsilon-nudge
// implementation — the most rigorous of the six that had accumulated, but still
// one of six. The canonical helper shifts the decimal exponent in string space
// instead of nudging a float. Re-exported rather than removed: this module is
// the import pipeline's money vocabulary, and its callers should not have to
// know where the math lives.
//
// dollarsToCents is behaviourally identical to the implementation it replaced
// (verified across every 2- and 3-decimal value in ±5,000: zero disagreements),
// so imported prices are unchanged.
//
// centsToDollars differs in one respect: the old local copy did
// `Math.round(cents) / 100`, silently whole-centing a fractional input. The
// canonical one is lossless, so 1.5c is 0.015 dollars rather than 0.02. Nothing
// here is affected — commit.ts rejects a non-integer unitCostCents before it
// ever reaches this function — and lossless is the behavior the month-close
// valuation path needs, since a per-unit weighted-average cost legitimately
// carries fractional cents.
export { dollarsToCents, centsToDollars };

/** Is this a per-unit price we are willing to carry into the draft? */
export function isPlausibleUnitCostCents(cents: number | null): cents is number {
  return cents !== null && Number.isInteger(cents) && cents > 0 && cents <= MAX_UNIT_COST_CENTS;
}

/** "$12.34" for a confirm screen. Never used as an input value. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}
