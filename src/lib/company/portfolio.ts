// ═══════════════════════════════════════════════════════════════════════════
// THE PORTFOLIO CHECKS — questions only somebody with more than one hotel can
// ask, and which no per-hotel detector can answer even in principle.
//
// A hotel's own detectors compare it against ITSELF: is this week unusual for
// Beaumont? That is the right question at a hotel and the wrong one at a
// company, where the useful comparison is against the hotel next door. Beaumont
// spending $800 is unremarkable on its own and is a completely different fact
// once you know Lufkin spent $1,400 the same week with the same room count.
//
// ─── THE COMPARISON SET IS THE COMPANY. FULL STOP. ────────────────────────
// Every number in this file comes from hotels the caller's own company operates,
// resolved through `propertiesOfOrganization` — the one query in the codebase
// that turns a company into a hotel list, so Wall B has exactly one place to be
// right. There is no industry benchmark here, no anonymised cross-customer
// average, and no way to get one: the context these functions receive contains
// the company's hotels and nothing else, so a leak would have to be typed in
// deliberately rather than forgotten.
//
// ─── "OUTLIER" IS A WORD YOU HAVE TO EARN (founder ruling) ────────────────
// With two hotels there is no outlier — there is a difference, and calling one
// of two numbers an outlier is statistics theatre. So the side-by-side sentence
// ("Beaumont spent $800, Lufkin $1,400 on comparable weeks") is what a company
// of ANY size gets, and the word "outlier" is unlocked only at three hotels or
// more, and only when the arithmetic actually supports it. `usesOutlierWording`
// is the single gate, so this cannot drift.
//
// ─── PURE, LIKE EVERY OTHER DETECTOR ──────────────────────────────────────
// `detect` takes a preloaded context and returns drafts. No database handle, no
// clock of its own. The gathering and the writing are in
// src/lib/company/portfolio-runner.ts, for the same reason the hotel side is
// split that way: the rules that decide what to say must be runnable in a test
// with no Postgres anywhere near them.
// ═══════════════════════════════════════════════════════════════════════════

import type { OperatingRhythmHistory, SupplySpendHistory } from '@/lib/findings/history';
import type {
  EscalationPolicy,
  FindingDisposition,
  FindingDraft,
  FindingSeverity,
} from '@/lib/findings/types';
import { cadenceOf, daysBetween, weeklyWindows } from '@/lib/findings/detectors/baseline-math';
import {
  excessBand,
  formatCents,
  formatCentsBand,
  plural,
  priceFromBand,
  sampleBand,
} from '@/lib/findings/pricing';

// ─── The context ────────────────────────────────────────────────────────────

/** One hotel of the company, with the feeds a portfolio check may read. */
export interface PortfolioHotel {
  propertyId: string;
  /** As the company calls it. Goes straight into the sentence. */
  name: string;
  /** The hotel's own local date — hotels in one company can be in two zones. */
  businessDate: string;
  /** Null when the feed failed to load for this hotel. Never a silent zero. */
  supplySpend: SupplySpendHistory | null;
  rhythm: OperatingRhythmHistory | null;
}

export interface PortfolioContext {
  organizationId: string;
  /** Every hotel the company operates right now. The whole comparison set. */
  hotels: readonly PortfolioHotel[];
  now: Date;
}

export interface PortfolioDetector {
  readonly id: string;
  readonly description: string;
  readonly receiptQueryId: string;
  readonly defaultDisposition: FindingDisposition;
  readonly defaultSeverity: FindingSeverity;
  readonly escalation: EscalationPolicy | null;
  readonly maxPerRun: number;
  readonly staleAfterDays: number;
  detect(ctx: PortfolioContext): FindingDraft[];
}

// ─── Shared bars ────────────────────────────────────────────────────────────

/** Fewer than two hotels is not a portfolio and has nothing to compare. */
export const MIN_HOTELS_TO_COMPARE = 2;

/**
 * The word "outlier" needs a crowd. Founder ruling, and the reason it is a
 * named constant rather than a `>= 3` buried in a template: this is the kind of
 * rule that gets loosened by accident during a wording tweak.
 */
export const MIN_HOTELS_FOR_OUTLIER_WORDING = 3;

/** How far above the company's own middle a hotel must sit to be called one. */
export const OUTLIER_RATIO = 1.5;

/**
 * True when this company is big enough, and this hotel far enough out, for the
 * word "outlier" to be an honest description rather than a flourish.
 */
export function usesOutlierWording(
  hotelCount: number,
  topValue: number,
  medianValue: number,
): boolean {
  if (hotelCount < MIN_HOTELS_FOR_OUTLIER_WORDING) return false;
  if (!Number.isFinite(topValue) || !Number.isFinite(medianValue) || medianValue <= 0) return false;
  return topValue >= medianValue * OUTLIER_RATIO;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** "Beaumont, Lufkin and Tyler". */
export function listHotelNames(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// ─── 1. Sister supply spend ─────────────────────────────────────────────────

const SUPPLY_RECEIPT = 'portfolio_supply_spend_gap';

/** Below this the whole comparison is noise: nobody escalates $40 against $70. */
export const MIN_COMPARABLE_SPEND_CENTS = 30_000;
/** The high hotel must be at least this many times the low one. */
export const MIN_SPEND_GAP_RATIO = 1.5;
/** …AND the absolute gap must be real money on its own. */
export const MIN_SPEND_GAP_CENTS = 20_000;

interface HotelWeek {
  hotel: PortfolioHotel;
  cents: number;
  startDate: string;
  endDate: string;
}

/**
 * Each hotel's last COMPLETE week of supply spend, for hotels whose records
 * actually cover that week.
 *
 * The coverage check is the honesty floor and it is per-hotel: a hotel that
 * started recording deliveries four days ago has a $0 week that means "we have
 * no data", and putting that zero into a side-by-side would produce the single
 * most damaging sentence this check could write — "Lufkin spent $1,400 and
 * Beaumont spent $0" about a hotel that simply has not been on Staxis long.
 */
export function comparableWeeks(hotels: readonly PortfolioHotel[]): HotelWeek[] {
  const out: HotelWeek[] = [];
  for (const hotel of hotels) {
    const history = hotel.supplySpend;
    if (!history) continue;
    const split = weeklyWindows(history.days, hotel.businessDate, 0);
    const week = split.current;
    // No record reaching back to the start of the window ⇒ this hotel cannot
    // take part in the comparison. Silence, not a zero.
    if (!history.coverageStartDate || history.coverageStartDate > week.startDate) continue;
    out.push({
      hotel,
      cents: Math.max(0, Math.round(week.value)),
      startDate: week.startDate,
      endDate: week.endDate,
    });
  }
  return out;
}

function detectSupplySpendGap(ctx: PortfolioContext): FindingDraft[] {
  const weeks = comparableWeeks(ctx.hotels);
  if (weeks.length < MIN_HOTELS_TO_COMPARE) return [];

  const ranked = [...weeks].sort((a, b) => b.cents - a.cents);
  const top = ranked[0];
  const bottom = ranked[ranked.length - 1];

  if (top.cents < MIN_COMPARABLE_SPEND_CENTS) return [];
  if (top.cents - bottom.cents < MIN_SPEND_GAP_CENTS) return [];
  if (bottom.cents > 0 && top.cents < bottom.cents * MIN_SPEND_GAP_RATIO) return [];

  const all = ranked.map((w) => w.cents);
  const mid = median(all);
  const outlier = usesOutlierWording(ranked.length, top.cents, mid);

  // What the gap is worth, as a RANGE — bounded by the spread of the hotel's
  // own sisters. `minSamples: 2` rather than the usual 3 because a company with
  // three hotels has exactly two comparators, and refusing to price until six
  // would mean pricing nothing for almost every customer this product has.
  const othersBand = sampleBand(ranked.slice(1).map((w) => w.cents), { minSamples: 2 });
  const pricing = priceFromBand(
    othersBand ? excessBand(top.cents, othersBand) : null,
    othersBand
      ? `your other hotels spent ${formatCentsBand(othersBand)} that week`
      : '',
    ranked.length < MIN_HOTELS_FOR_OUTLIER_WORDING
      ? 'no dollar figure: with two hotels there is a difference to look at but no spread to price it against'
      : 'no dollar figure: your other hotels spent too close to the same amount for an honest range',
  );

  const sideBySide = ranked
    .slice(0, 3)
    .map((w) => `${w.hotel.name} ${formatCents(w.cents)}`)
    .join(', ');

  const summary = outlier
    ? `${top.hotel.name} is the outlier on supplies: ${sideBySide} on comparable weeks, ` +
      `against a ${formatCents(mid)} middle across your ${plural(ranked.length, 'hotel')}.`
    : `Supplies, same week, side by side: ${sideBySide}.`;

  return [{
    // Identity is WHICH HOTEL is high, never how high. Next week's bigger gap
    // updates this row instead of stacking a second card beside it.
    key: `supply_spend:${top.hotel.propertyId}`,
    summary: summary.slice(0, 500),
    severity: 'attention',
    magnitude: top.cents - bottom.cents,
    evidence: {
      queryId: SUPPLY_RECEIPT,
      params: {
        week_start: top.startDate,
        week_end: top.endDate,
        // The comparison set, named. A side-by-side claim a VP cannot check
        // against the actual hotels is a rumour.
        hotels: ranked.map((w) => w.hotel.name),
        hotel_ids: ranked.map((w) => w.hotel.propertyId),
      },
      values: {
        spend_cents: Object.fromEntries(ranked.map((w) => [w.hotel.name, w.cents])),
        top_hotel: top.hotel.name,
        low_hotel: bottom.hotel.name,
        gap_cents: top.cents - bottom.cents,
        median_cents: mid,
        hotels_compared: ranked.length,
        outlier_wording_used: outlier,
        price_basis: pricing.note,
      },
      basis:
        `${plural(ranked.length, 'hotel')} in this company with delivery records covering ` +
        `${top.startDate} to ${top.endDate}`,
    },
    price: pricing.price,
  }];
}

export const supplySpendGapDetector: PortfolioDetector = {
  id: 'portfolio_supply_spend_gap',
  description:
    'One hotel in the company is spending far more on supplies than its sisters in the same week.',
  receiptQueryId: SUPPLY_RECEIPT,
  // A comparison is something to look at, not something Staxis can fix, and
  // there is no one-tap action that would make sense across two hotels.
  defaultDisposition: 'recommend',
  defaultSeverity: 'attention',
  escalation: { factor: 2, minDelta: 20_000 },
  maxPerRun: 1,
  staleAfterDays: 10,
  detect: detectSupplySpendGap,
};

// ─── 2. The same thing stopped at several hotels ────────────────────────────

const STOPPED_RECEIPT = 'portfolio_activity_stopped';

/** One hotel going quiet is that hotel's own card. Two is a pattern. */
export const MIN_HOTELS_STOPPED = 2;

/** Same bars the per-hotel absence detector uses, so the two never disagree. */
const MIN_EVENTS = 6;
const MIN_TOLERANCE_DAYS = 3;

interface StoppedAt {
  hotel: PortfolioHotel;
  silentDays: number;
  lastDate: string;
}

/**
 * Which of this company's hotels have gone quiet on a stream they had a real
 * rhythm for.
 *
 * A hotel with no rhythm on record is not counted as stopped — it never
 * started, and "4 of your hotels stopped logging maintenance" about two hotels
 * that opened last month would be a fabrication dressed as an aggregate.
 */
export function hotelsStopped(
  hotels: readonly PortfolioHotel[],
  streamId: string,
): StoppedAt[] {
  const out: StoppedAt[] = [];
  for (const hotel of hotels) {
    const stream = hotel.rhythm?.streams.find((s) => s.id === streamId);
    if (!stream) continue;
    const cadence = cadenceOf(stream.dates, {
      minEvents: MIN_EVENTS,
      minToleranceDays: MIN_TOLERANCE_DAYS,
    });
    if (!cadence) continue;
    const lastDate = [...stream.dates].sort().pop();
    if (!lastDate) continue;
    const silentDays = daysBetween(lastDate, hotel.businessDate);
    if (silentDays < cadence.toleranceDays) continue;
    out.push({ hotel, silentDays, lastDate });
  }
  return out;
}

function detectPortfolioActivityStopped(ctx: PortfolioContext): FindingDraft[] {
  const streamIds = [...new Set(
    ctx.hotels.flatMap((hotel) => hotel.rhythm?.streams.map((s) => s.id) ?? []),
  )].sort();

  const drafts: FindingDraft[] = [];
  for (const streamId of streamIds) {
    const stopped = hotelsStopped(ctx.hotels, streamId);
    if (stopped.length < MIN_HOTELS_STOPPED) continue;

    // The label is the hotels' own word for the activity, taken from the first
    // hotel that has it — every stream carries the same label, and inventing a
    // company-level synonym would make the VP's card and the GM's card describe
    // the same silence in two different vocabularies.
    const label = stopped[0].hotel.rhythm?.streams.find((s) => s.id === streamId)?.label
      ?? streamId;
    const names = stopped.map((s) => s.hotel.name).sort();
    const worst = [...stopped].sort((a, b) => b.silentDays - a.silentDays)[0];

    drafts.push({
      // Identity is the STREAM. A third hotel joining next week updates this
      // row; it does not open a second card about the same silence.
      key: `stopped:${streamId}`,
      summary:
        `${stopped.length} of your hotels stopped ${label}: ${listHotelNames(names)}. ` +
        `The longest silence is ${plural(worst.silentDays, 'day')}, at ${worst.hotel.name}.`,
      severity: 'attention',
      magnitude: stopped.length,
      evidence: {
        queryId: STOPPED_RECEIPT,
        params: { stream: streamId, hotels: names },
        values: {
          hotels_stopped: stopped.length,
          hotels_checked: ctx.hotels.length,
          per_hotel: Object.fromEntries(
            stopped.map((s) => [s.hotel.name, { last_seen: s.lastDate, days_silent: s.silentDays }]),
          ),
          price_basis:
            'no dollar figure: what a stopped stream costs differs at every hotel, and one ' +
            'company-wide number would be an average nobody could check',
        },
        basis:
          `${plural(stopped.length, 'hotel')} of ${ctx.hotels.length} with a rhythm on record ` +
          `for this and no activity past their own usual wait`,
      },
      price: null,
    });
  }
  return drafts;
}

export const portfolioActivityStoppedDetector: PortfolioDetector = {
  id: 'portfolio_activity_stopped',
  description:
    'Several hotels in the company stopped doing the same thing — the shape of a policy change, a departure, or a broken feed, and invisible from any one hotel.',
  receiptQueryId: STOPPED_RECEIPT,
  defaultDisposition: 'recommend',
  defaultSeverity: 'attention',
  escalation: { factor: 2, minDelta: 1 },
  maxPerRun: 3,
  staleAfterDays: 10,
  detect: detectPortfolioActivityStopped,
};

// ─── The registry ───────────────────────────────────────────────────────────

export const PORTFOLIO_DETECTORS: readonly PortfolioDetector[] = Object.freeze([
  supplySpendGapDetector,
  portfolioActivityStoppedDetector,
]);
