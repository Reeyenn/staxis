// ═══════════════════════════════════════════════════════════════════════════
// THE PORTFOLIO CHECKS — questions only somebody with more than one hotel can
// ask, and which no per-hotel detector can answer even in principle.
//
// ─── NOT company/portfolio.ts, WHICH IS A DIFFERENT THING ─────────────────
// Two company-scope modules want the word "portfolio" and they do not overlap:
//
//   company/portfolio.ts        the DOOR. May this person ask the copilot about
//                               a whole company, and which hotels does that
//                               mean. Gated on the company having turned
//                               `cross_hotel_ai_chat` on.
//   company/portfolio-checks.ts (this file) the CHECKS. What is worth telling
//                               somebody who owns several hotels, computed from
//                               those hotels' own records.
//
// They are deliberately NOT wired together, and that is a decision rather than
// an oversight. The VP queue is not gated on `cross_hotel_ai_chat`: that switch
// is about letting a MODEL read twenty hotels at once inside a chat turn, and a
// company that has not opted into that has not thereby asked to stop being told
// its ice machine is failing. Folding the two would let a default-off chat
// setting silently switch off a queue nobody connected it to.
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
  formatCentsBandEs,
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

/**
 * A company-level draft carries the exact hotels whose operating state the
 * card asks a person to judge.  This is authorization lineage, not display
 * evidence: the runner persists it into the typed `affected_property_ids`
 * column and the verdict RPC refuses to reconstruct it from prose or JSON.
 */
export interface PortfolioFindingDraft extends FindingDraft {
  readonly affectedPropertyIds: readonly string[];
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
  detect(ctx: PortfolioContext): PortfolioFindingDraft[];
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

function detectSupplySpendGap(ctx: PortfolioContext): PortfolioFindingDraft[] {
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
    // ═══ IDENTITY IS THE PROBLEM, NOT THE HOTEL THAT CURRENTLY TOPS IT ═══
    //
    // This key used to be `supply_spend:${top.hotel.propertyId}`. The comment
    // above it said the right thing — "next week's bigger gap updates this row
    // instead of stacking a second card" — and the code did the opposite,
    // because the top spender is a MEASUREMENT and this is an IDENTITY. The week
    // Port Arthur overtook Testing Hotel, a second card opened and the first one
    // sat there until its 10-day staleness ran out: two cards, on one screen,
    // naming two different hotels as the company's high spender. Both were
    // written by the same check. That was live.
    //
    // The problem is "one hotel in this company is spending far more on supplies
    // than its sisters", of which there is exactly one per company, and WHICH
    // hotel it is belongs in the sentence and the evidence — where it is
    // re-stated every run, so a change of leader updates this row (evidenceMoved
    // sees the new summary and flips it to `updated`) instead of forking it.
    key: 'supply_spend',
    // The decision is about the high-spend hotel's operating state.  Sister
    // hotels prove the comparison but are not targets of the verdict.
    affectedPropertyIds: [top.hotel.propertyId],
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
        // The comparators' band as NUMBERS, not only inside the English basis
        // sentence. `portfolioSpanish` rebuilds the same claim in Spanish from
        // these, so a Spanish reader gets the figure rather than an English
        // sentence with a Spanish label bolted on the front of it.
        others_band_cents: othersBand ? { low: othersBand.low, high: othersBand.high } : null,
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

function detectPortfolioActivityStopped(ctx: PortfolioContext): PortfolioFindingDraft[] {
  const streamIds = [...new Set(
    ctx.hotels.flatMap((hotel) => hotel.rhythm?.streams.map((s) => s.id) ?? []),
  )].sort();

  const drafts: PortfolioFindingDraft[] = [];
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
      affectedPropertyIds: stopped
        .map((entry) => entry.hotel.propertyId)
        .sort(),
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

// ═══════════════════════════════════════════════════════════════════════════
// THE SPANISH RENDERING, REBUILT FROM THE EVIDENCE
//
// ─── WHY IT IS NOT SIMPLY A SECOND `summary` FIELD ────────────────────────
// `company_findings` stores ONE summary, ONE price_basis and ONE evidence
// basis, and it has no judged_* columns at all — so unlike a hotel finding,
// nothing downstream ever writes a Spanish version of a company card. A
// Spanish-reading VP therefore got English prose on the only cards that are
// BORN on their screen: "según your other hotels spent $700–$2,100 that week"
// under a Spanish heading. That was live.
//
// Rather than a migration for three more text columns, the sentences are
// REBUILT from `evidence.values`, which already carries every number and name
// the English says. That has a property a second column would not: the two
// languages cannot drift, because both are derived from the same receipt. If
// one of them is wrong, the receipt is wrong, and the receipt is the thing a VP
// can check.
//
// Every numeral below comes from the evidence, so this text is backed by the
// same payload the English is.
// ═══════════════════════════════════════════════════════════════════════════

/** The three activity streams a hotel has (see feeds.ts), in Spanish. */
const STREAM_LABEL_ES: Readonly<Record<string, string>> = Object.freeze({
  inventory_counts: 'contar el inventario',
  daily_log_closings: 'registrar los números diarios',
  work_order_flow: 'registrar el mantenimiento',
});

export interface PortfolioSpanish {
  summary: string;
  /** Replaces the money basis under the price chip. Null when unpriced. */
  priceBasis: string | null;
  /** Replaces the evidence basis line. */
  basis: string | null;
}

type Values = Readonly<Record<string, unknown>>;

function num(values: Values | undefined, key: string): number | null {
  const raw = values?.[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function str(values: Values | undefined, key: string): string | null {
  const raw = values?.[key];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/** "Beaumont, Lufkin y Tyler" — the Spanish twin of `listHotelNames`. */
export function listHotelNamesEs(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`;
}

const pluralEs = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function supplySpendSpanish(evidence: {
  params?: Values;
  values?: Values;
}): PortfolioSpanish | null {
  const values = evidence.values;
  const params = evidence.params;
  const spend = values?.spend_cents;
  if (!spend || typeof spend !== 'object' || Array.isArray(spend)) return null;

  const ranked = Object.entries(spend as Record<string, unknown>)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return null;

  const sideBySide = ranked
    .slice(0, 3)
    .map(([name, cents]) => `${name} ${formatCents(cents)}`)
    .join(', ');

  const top = str(values, 'top_hotel') ?? ranked[0][0];
  const mid = num(values, 'median_cents');
  const compared = num(values, 'hotels_compared') ?? ranked.length;
  const outlier = values?.outlier_wording_used === true;

  const summary = outlier && mid !== null
    ? `${top} es el que más gasta en suministros: ${sideBySide} en semanas comparables, `
      + `frente a un punto medio de ${formatCents(mid)} entre tus ${compared} hoteles.`
    : `Suministros, la misma semana, lado a lado: ${sideBySide}.`;

  const band = values?.others_band_cents;
  let priceBasis: string | null = null;
  if (band && typeof band === 'object' && !Array.isArray(band)) {
    const low = num(band as Values, 'low');
    const high = num(band as Values, 'high');
    if (low !== null && high !== null) {
      priceBasis = `tus otros hoteles gastaron ${formatCentsBandEs({ low, high })} esa semana`;
    }
  }

  const start = str(params, 'week_start');
  const end = str(params, 'week_end');
  const basis = start && end
    ? `${pluralEs(compared, 'hotel', 'hoteles')} de esta empresa con registros de entregas `
      + `del ${start} al ${end}`
    : null;

  return { summary: summary.slice(0, 500), priceBasis, basis };
}

function activityStoppedSpanish(evidence: {
  params?: Values;
  values?: Values;
}): PortfolioSpanish | null {
  const values = evidence.values;
  const streamId = str(evidence.params, 'stream');
  const perHotel = values?.per_hotel;
  if (!streamId || !perHotel || typeof perHotel !== 'object' || Array.isArray(perHotel)) return null;

  // A stream we have no Spanish word for is left alone entirely rather than
  // half-translated: an English activity name inside a Spanish sentence is the
  // exact defect this function exists to remove.
  const label = STREAM_LABEL_ES[streamId];
  if (!label) return null;

  const entries = Object.entries(perHotel as Record<string, unknown>);
  const names = entries.map(([name]) => name).sort();
  let worstName: string | null = null;
  let worstDays = -1;
  for (const [name, detail] of entries) {
    const days = detail && typeof detail === 'object' && !Array.isArray(detail)
      ? num(detail as Values, 'days_silent')
      : null;
    if (days !== null && days > worstDays) { worstDays = days; worstName = name; }
  }

  const stopped = num(values, 'hotels_stopped') ?? entries.length;
  const checked = num(values, 'hotels_checked');

  let summary = `${stopped} de tus hoteles dejaron de ${label}: ${listHotelNamesEs(names)}.`;
  if (worstName && worstDays >= 0) {
    summary += ` El silencio más largo es de ${pluralEs(worstDays, 'día', 'días')}, en ${worstName}.`;
  }

  const basis = checked !== null
    ? `${pluralEs(stopped, 'hotel', 'hoteles')} de ${checked} con un ritmo registrado para esto `
      + 'y sin actividad más allá de su propia espera habitual'
    : null;

  return { summary: summary.slice(0, 500), priceBasis: null, basis };
}

/**
 * The Spanish rendering of one company card, or null when this detector has
 * none — in which case the card keeps its English text, because a card with no
 * sentence is worse than a card in the wrong language.
 */
export function portfolioSpanish(
  detectorId: string,
  evidence: { params?: Values; values?: Values } | null | undefined,
): PortfolioSpanish | null {
  if (!evidence) return null;
  try {
    if (detectorId === supplySpendGapDetector.id) return supplySpendSpanish(evidence);
    if (detectorId === portfolioActivityStoppedDetector.id) return activityStoppedSpanish(evidence);
    return null;
  } catch {
    // A malformed receipt costs the translation, never the card.
    return null;
  }
}
