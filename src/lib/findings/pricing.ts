// ─── Price ranges ────────────────────────────────────────────────────────────
//
// Founder call, 2026-07-26: "$200-400", never "$340" — "we don't want to lie."
// This module is where the honest width comes from.
//
// THE RULE
// A dollar figure on a finding is derived from THE HOTEL'S OWN NUMBERS or it
// does not exist. Their invoices, the spread of their own normal weeks, what
// they actually paid for the item. There is no fleet average in here, no
// industry benchmark, no constant anybody typed in as "about right". A manager
// who checks the basis line must find the exact rows it names.
//
// WHERE THE WIDTH COMES FROM — this is the part that matters
// A range whose width was invented is a point estimate with a decoration on it,
// so every band in this file is the spread of something real:
//
//   • `sampleBand`  — the spread of the hotel's own recorded amounts. Three
//                     plumber invoices at $210/$260/$390 give $210-390. Three
//                     identical invoices give NO band, because three identical
//                     invoices genuinely do not tell you the spread.
//   • `excessBand`  — the spread of the hotel's own normal. "How much more than
//                     usual" is only knowable to within how much "usual" itself
//                     moves: the low end assumes their normal week was at the
//                     top of its usual band, the high end assumes the bottom.
//
// Multiply two of those and the width compounds honestly. Fail to get either
// and the answer is `unpriced(reason)` — an explicit null carrying the sentence
// that explains it, which the detector puts in the evidence so "no dollar
// figure" is a finding a human can audit rather than a blank.
//
// The database is the backstop: `findings_price_is_a_range` (migration 0360)
// refuses a zero-width or inverted range outright. Nothing here can smuggle a
// point estimate past it — but everything here tries to fail earlier and say
// why.

import { isUsablePriceRange, type PriceRange } from './types';

/** A low/high pair in whatever unit the caller is working in. */
export interface Band {
  low: number;
  high: number;
}

/**
 * A price decision. `price` is a real range or null; `note` is always set —
 * either the basis a manager can check, or the reason there is no number.
 * Detectors put the note in `evidence.values.price_basis`, so a finding with
 * no dollar figure still explains itself.
 */
export interface PricingOutcome {
  price: PriceRange | null;
  note: string;
}

/** The longest basis line the column will store (0360 caps it at 300). */
const MAX_BASIS = 300;

export function unpriced(reason: string): PricingOutcome {
  return { price: null, note: reason.slice(0, MAX_BASIS) };
}

// ─── Statistics on the hotel's own numbers ───────────────────────────────────

/** Linear-interpolated percentile of an ASCENDING array. */
export function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const clamped = Math.min(1, Math.max(0, p));
  const pos = clamped * (sortedAsc.length - 1);
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return sortedAsc[lower];
  return sortedAsc[lower] + (sortedAsc[upper] - sortedAsc[lower]) * (pos - lower);
}

/**
 * The spread of a hotel's own recorded amounts.
 *
 * Small sample (< `wideSampleAt`): min..max, because with three invoices every
 * one of them is signal and discarding the extremes discards the data. Larger
 * sample: the middle half, because by then the extremes are probably the
 * emergency call-out and the one-line touch-up, and quoting them as the range
 * would be technically true and practically useless.
 *
 * Returns null when the samples carry no spread at all — that is a hotel whose
 * records cannot honestly answer the question, not an invitation to widen by an
 * invented percentage.
 */
export function sampleBand(
  samples: readonly number[],
  opts: { minSamples?: number; wideSampleAt?: number } = {},
): Band | null {
  const minSamples = opts.minSamples ?? 3;
  const wideSampleAt = opts.wideSampleAt ?? 6;
  const usable = samples.filter((n) => Number.isFinite(n));
  if (usable.length < minSamples) return null;

  const sorted = [...usable].sort((a, b) => a - b);
  const band =
    sorted.length < wideSampleAt
      ? { low: sorted[0], high: sorted[sorted.length - 1] }
      : { low: percentile(sorted, 0.25), high: percentile(sorted, 0.75) };

  return band.high > band.low ? band : null;
}

/**
 * How much more than normal today is, as a range.
 *
 * The width is the hotel's own normal band: if their usual week runs
 * $820-$1,140 and this week was $2,300, the overspend is $1,160-$1,480 — not
 * "$1,320", because nobody knows which of their normal weeks this one should be
 * compared against.
 *
 * Returns null when the current value does not clear even the top of normal.
 * A range that straddles zero ("somewhere between saving money and losing
 * $400") is not worth a manager's attention and should never reach a card.
 */
export function excessBand(current: number, normal: Band): Band | null {
  const low = current - normal.high;
  const high = current - normal.low;
  if (!(low > 0) || !(high > low)) return null;
  return { low, high };
}

/** Compound two bands. Both must be non-negative — a negative flips the ends. */
export function multiplyBands(a: Band, b: Band): Band | null {
  if (a.low < 0 || b.low < 0) return null;
  const low = a.low * b.low;
  const high = a.high * b.high;
  return high > low ? { low, high } : null;
}

// ─── Turning a band into a stored price ──────────────────────────────────────

/**
 * The rounding step for a range of this size. Rounding OUTWARD to a round
 * number is the one liberty this module takes with the arithmetic, and it is
 * taken in the safe direction: the stored range always CONTAINS the computed
 * one. "$1,160-$1,480" becomes "$1,150-$1,500"; nobody was ever helped by
 * "$1,163.42-$1,479.88", and the false precision would undercut the exact
 * numbers in the basis line right next to it.
 */
function roundingStepCents(highCents: number): number {
  if (highCents < 10_000) return 500; // under $100 → $5
  if (highCents < 100_000) return 1_000; // under $1,000 → $10
  if (highCents < 1_000_000) return 5_000; // under $10,000 → $50
  return 10_000; // $100
}

/**
 * A band of cents plus its basis, as a storable price — or null if it is not
 * honestly a range once rounded. Never returns a zero-width range: the schema
 * would refuse it, and the whole point is that we would deserve it.
 */
export function toPriceRange(
  cents: Band,
  basis: string,
  currency = 'USD',
): PriceRange | null {
  if (!Number.isFinite(cents.low) || !Number.isFinite(cents.high)) return null;
  if (cents.low < 0) return null;

  const measuredWidth = cents.high - cents.low;
  const step = roundingStepCents(Math.max(cents.high, 0));
  let lowCents = Math.max(0, Math.floor(cents.low / step) * step);
  let highCents = Math.ceil(cents.high / step) * step;

  // Rounding may never more than DOUBLE the width the hotel's numbers actually
  // support. A band 3 cents wide rounded out to $10 would be manufactured
  // spread wearing the range format — the same lie as a point estimate, only
  // harder to spot. When the tidy step would overstate, keep the exact figures.
  if (highCents - lowCents > 2 * measuredWidth) {
    lowCents = Math.max(0, Math.floor(cents.low));
    highCents = Math.ceil(cents.high);
  }

  const price: PriceRange = {
    lowCents,
    highCents,
    currency,
    basis: basis.slice(0, MAX_BASIS),
  };
  return isUsablePriceRange(price) ? price : null;
}

/** Band of cents → outcome, keeping the reason when it cannot be priced. */
export function priceFromBand(
  cents: Band | null,
  basis: string,
  noBandReason: string,
): PricingOutcome {
  if (!cents) return unpriced(noBandReason);
  const price = toPriceRange(cents, basis);
  return price ? { price, note: price.basis } : unpriced(noBandReason);
}

// ─── Formatting ──────────────────────────────────────────────────────────────
//
// ONE FORMATTER FOR MONEY, and it lives here because this is the module that
// already owns what a price IS.
//
// Why it is worth a comment: a card used to print the same range twice in two
// different hands — "$750-$1750" inside the sentence (a local helper in
// judge.ts with no thousands separator and a hyphen) and "$750–$1,750" in the
// price chip a centimetre below it. Both were the same two numbers. A reader
// who notices that stops trusting the numbers, which is the one thing this
// whole layer is for. So the separator, the thousands separator and the
// currency prefix are decided in exactly one place, and every surface —
// detector prose, the card chip, the deterministic judge floor — calls it.

/** An EN DASH, never a hyphen: "$200-400" reads as a phone number at a glance. */
export const MONEY_RANGE_DASH = '–';

/** Currency symbols we actually serve. Anything else prints its ISO code. */
export const CURRENCY_PREFIX: Readonly<Record<string, string>> = Object.freeze({
  USD: '$',
  CAD: 'CA$',
  MXN: 'MX$',
  EUR: '€',
});

export function currencyPrefix(currency: string | null | undefined): string {
  const code = (currency ?? 'USD').toUpperCase();
  return CURRENCY_PREFIX[code] ?? `${code} `;
}

/**
 * "$1,750" / "$1,750.50" — thousands separated, cents only when there are any.
 *
 * Cent precision is kept here (unlike `formatCents` below) because this one
 * renders a STORED price, and a stored price came off a real invoice.
 */
export function formatMoney(cents: number, currency: string = 'USD'): string {
  const value = cents / 100;
  const digits = Number.isInteger(value)
    ? value.toLocaleString('en-US')
    : value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${currencyPrefix(currency)}${digits}`;
}

/** "$750–$1,750". The one range string in the product. */
export function formatMoneyRange(
  lowCents: number,
  highCents: number,
  currency: string = 'USD',
): string {
  return `${formatMoney(lowCents, currency)}${MONEY_RANGE_DASH}${formatMoney(highCents, currency)}`;
}

/** "$1,160" — whole dollars, because cents in a STATISTICAL band is false
 *  precision: the band came from arithmetic over a hotel's own weeks, not off
 *  an invoice, and quoting it to the cent would dress a spread as a receipt. */
export function formatCents(cents: number): string {
  const dollars = Math.round(cents / 100);
  return `$${dollars.toLocaleString('en-US')}`;
}

/** "$820–$1,140" — same dash as every other range on the screen. */
export function formatCentsBand(band: Band): string {
  return `${formatCents(band.low)}${MONEY_RANGE_DASH}${formatCents(band.high)}`;
}

/** "3 plumber invoices" / "1 plumber invoice". */
export function plural(count: number, singular: string, pluralWord?: string): string {
  return `${count} ${count === 1 ? singular : pluralWord ?? `${singular}s`}`;
}
