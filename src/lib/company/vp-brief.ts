// ═══════════════════════════════════════════════════════════════════════════
// THE PORTFOLIO MORNING BRIEF — the same six-to-eight lines, one level up.
//
//   "Across your 12 hotels: 2 need you. Lufkin's supply spend doubled for the
//    third week ($1,800–2,600). Beaumont has a $3,100 card unresolved for 12
//    days. 9 hotels quiet. Checked 384 things overnight."
//
// WHY IT IS A SEPARATE ASSEMBLY FROM THE HOTEL BRIEF
// The hotel brief's whole vocabulary is "overnight, here": what arrived, what
// changed, what cleared. A portfolio reader does not have a "here" — every one
// of those words would have to be qualified with a hotel name, and a six-line
// summary in which every line names a different building is a list, not a
// summary. So this file asks the questions a portfolio reader actually has —
// how many need me, which are the worst, how many are fine — and answers them
// from the same ranked cards the queue below it shows.
//
// WHAT IT SHARES, DELIBERATELY: the line cap, the highlight cap, the ranking,
// the price formatter, and the decision about what we are entitled to claim
// about recency (`livenessLine`'s fresh/stale/never band). Those are the parts
// where the two briefs disagreeing would be a bug rather than a difference.
//
// NULL IS A REAL ANSWER AND THE MOST IMPORTANT ONE. A company not one of whose
// hotels has ever been checked gets NO brief — not "all quiet", not "nothing
// needs you". Every sentence below is a claim about having looked.
//
// ENGLISH-ONLY, like the hotel brief and for the same founder ruling — see the
// header of src/lib/findings/brief.ts. A `BriefLine` carries one string. The
// portfolio CARDS underneath are unchanged and still bilingual, which is why
// the highlights below ask `cardPhrasing` for English explicitly.
// ═══════════════════════════════════════════════════════════════════════════

import {
  MAX_BRIEF_HIGHLIGHTS,
  MAX_BRIEF_LINES,
  type BriefLine,
} from '@/lib/findings/brief';
import {
  cardPhrasing,
  formatPriceRange,
  livenessLine,
  type QueueRun,
} from '@/components/concourse/finding-cards';
import { rankPortfolio, type PortfolioCard } from './vp-queue';
import type { PortfolioRun } from './vp-queue-server';

export interface PortfolioBrief {
  organizationId: string;
  /** The company's own calendar day this brief belongs to (YYYY-MM-DD). */
  localDate: string;
  generatedAt: string;
  /** 'quiet' is the nothing-needs-you morning. 'report' is everything else. */
  kind: 'quiet' | 'report';
  lines: BriefLine[];
  /** Which cards the brief named, in the order it named them. */
  focusIds: string[];
}

export interface PortfolioBriefInput {
  organizationId: string;
  localDate: string;
  hotelCount: number;
  /** The portfolio queue's cards, in any order — this file ranks them. */
  cards: readonly PortfolioCard[];
  run: PortfolioRun | null;
  now: Date;
  /**
   * Hotels the CHIP rule considers busy — `hotelHasLiveWork` in vp-queue.ts.
   *
   * Without this the brief and the command centre disagreed out loud about the
   * same building on the same morning: the chip said "2 WAITING" and the brief,
   * one tap away, counted that hotel among the "N hotels quiet". Both were
   * computing something defensible; only one of them is checkable against the
   * hotel, so the chip wins and this list is how its answer gets here.
   *
   * Optional so a caller with no chip information degrades to the old, narrower
   * count rather than to a wrong one — and every production caller passes it.
   */
  busyHotelIds?: readonly string[];
}

// ─── Which cards are actually asking for something ──────────────────────────

/**
 * A card that wants a DECISION, as opposed to one that wants to be known about.
 *
 * Two ways in, and they are the same two ways the rest of the product means it:
 * the effective disposition is `propose` (Staxis is asking for an answer — the
 * same test the nav badge counts), or the company's own rulebook routed the
 * signature to this reader. The second is not redundant: a rule can put a card
 * in front of a VP whose disposition the judge had already softened, and "your
 * company says you have to sign this" is a decision whatever else is true.
 */
export function needsADecision(card: PortfolioCard): boolean {
  return card.disposition === 'propose' || card.climbReason === 'sign_off';
}

/** Hotels with at least one card asking for a decision. Company cards have no
 *  hotel and are counted apart — they are the reader's own, not a building's. */
function hotelsNeedingYou(cards: readonly PortfolioCard[]): Set<string> {
  const out = new Set<string>();
  for (const card of cards) {
    if (card.hotel && needsADecision(card)) out.add(card.hotel.propertyId);
  }
  return out;
}

/**
 * Hotels with NOTHING on this screen at all.
 *
 * Deliberately not "hotels with no decisions". A hotel with a $900 card that
 * climbed for being old is not quiet, and calling it quiet because nobody has
 * to press a button would be the portfolio version of saying "all normal" over
 * six open problems. Hotels that are neither needing nor quiet are simply not
 * counted in either sentence, which is why those two numbers do not have to add
 * up to the whole company — and why neither of them can be a lie.
 */
function quietHotelCount(
  cards: readonly PortfolioCard[],
  hotelCount: number,
  busyHotelIds: readonly string[] = [],
): number {
  const withAnything = new Set(
    cards.filter((c) => c.hotel).map((c) => c.hotel!.propertyId),
  );
  // The chip's answer, folded in. A hotel with two live proposals that have not
  // cleared the climbing bar has no card HERE and is emphatically not quiet
  // THERE, and the reader is looking at both.
  for (const id of busyHotelIds) withAnything.add(id);
  return Math.max(0, hotelCount - withAnything.size);
}

// ─── Assembly ───────────────────────────────────────────────────────────────

function line(text: string, findingId?: string): BriefLine {
  return findingId ? { text, findingId } : { text };
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * The brief, or null.
 *
 * Null when not one of the company's hotels has ever been checked. There is no
 * "we checked nothing" brief, because the card simply should not be there.
 */
export function buildPortfolioBrief(input: PortfolioBriefInput): PortfolioBrief | null {
  const { run } = input;
  if (!run || !run.lastRunAt) return null;

  const cards = rankPortfolio([...input.cards]);
  const needing = hotelsNeedingYou(cards);
  const companyDecisions = cards.filter((c) => !c.hotel && needsADecision(c)).length;
  const decisionCount = needing.size + companyDecisions;
  const quiet = quietHotelCount(cards, input.hotelCount, input.busyHotelIds ?? []);

  // "At your hotel" rather than "Across your 1 hotel". A one-hotel company is a
  // real customer (an owner who has bought their second and not opened it yet),
  // and the counted phrasing reads as machine output.
  const hotels = Math.max(0, Math.round(input.hotelCount));
  const across = hotels === 1 ? 'At your hotel' : `Across your ${hotels} hotels`;

  const liveness = companyLivenessLine(run, input.now);

  const busy = input.busyHotelIds ?? [];

  // ── the quiet morning ──
  // One line, and only when there is genuinely nothing on the screen AND nothing
  // waiting in any of the hotels' own queues. A brief that said "nothing needs
  // you" over four standing cards would be the single most damaging sentence this
  // surface could print — and so, only slightly less so, is one that says it
  // while the picker one tap away shows "2 WAITING" on a building. So the card
  // count and the chips are both part of the condition.
  if (cards.length === 0 && busy.length === 0) {
    const lines = [line(`${across}: nothing needs a decision this morning.`)];
    if (liveness) lines.push(liveness);
    return finish(input, 'quiet', lines);
  }

  const lines: BriefLine[] = [];

  // Nothing CLIMBED, but hotels are working. The honest sentence names both
  // facts, because "nothing needs a decision" on its own is what made the chip
  // look like a contradiction.
  if (cards.length === 0) {
    lines.push(line(
      `${across}: nothing has reached you, but ${busy.length} ${plural(busy.length, 'hotel has', 'hotels have')} something waiting in ${plural(busy.length, 'its', 'their')} own queue.`,
    ));
  } else {
    lines.push(decisionCount > 0
      ? line(`${across}: ${decisionCount} ${plural(decisionCount, 'needs', 'need')} you.`)
      : line(
        `${across}: nothing needs a decision, but ${cards.length} ${plural(cards.length, 'thing is', 'things are')} worth a look.`,
      ));
  }

  // ── the two or three worth the attention ──
  for (const card of cards.slice(0, MAX_BRIEF_HIGHLIGHTS)) {
    lines.push(highlightLine(card));
  }

  // ── how much of the portfolio is fine ──
  if (quiet > 0) {
    lines.push(line(`${quiet} ${plural(quiet, 'hotel', 'hotels')} quiet.`));
  }

  // ── proof the watchers ran ──
  if (liveness) lines.push(liveness);

  return finish(input, 'report', lines);
}

/**
 * "Lufkin — supplies, same week, side by side: … — $1,800–2,600"
 *
 * The hotel's NAME, never an index. A VP who has to translate "#7" into a
 * building before the sentence means anything is reading a database dump. A
 * company card carries no hotel and simply starts with the sentence.
 */
function highlightLine(card: PortfolioCard): BriefLine {
  const price = formatPriceRange(card.price);
  const suffix = price ? ` — ${price}` : '';
  const prefix = card.hotel ? `${card.hotel.name} — ` : '';
  return line(`${prefix}${cardPhrasing(card, 'en')}${suffix}`, card.id);
}

/**
 * "Checked 384 things overnight across 11 of your 12 hotels."
 *
 * The freshness BAND comes from `livenessLine` — the same function the hotel
 * screen uses — so there is exactly one place in the product that decides
 * whether we have earned the word "overnight". A stale rollup says how old it
 * is and recites no counts, because reciting them under "last checked 4 days
 * ago" would smuggle a four-day-old fact back in as a current one.
 */
export function companyLivenessLine(run: PortfolioRun, now: Date): BriefLine | null {
  if (!run.lastRunAt) return null;
  const asHotelRun: QueueRun = {
    runAt: run.lastRunAt,
    detectorsChecked: run.thingsChecked,
    detectorsSkipped: 0,
    detectorsFailed: 0,
  };
  const band = livenessLine(asHotelRun, 0, 'en', now);
  if (band.kind === 'never') return null;

  if (band.kind === 'stale') return band.text ? line(band.text) : null;

  const things = Math.max(0, Math.round(run.thingsChecked));
  const checked = run.hotelsChecked;
  const total = run.hotelsTotal;
  const where = checked >= total
    ? (total === 1 ? 'your hotel' : `all ${total} of your hotels`)
    : `${checked} of your ${total} hotels`;
  return line(`Checked ${things} ${plural(things, 'thing', 'things')} overnight across ${where}.`);
}

/** The hard cap, applied in ONE place so no later section can quietly extend
 *  the brief past the length a busy person will read. */
function finish(
  input: PortfolioBriefInput,
  kind: 'quiet' | 'report',
  lines: BriefLine[],
): PortfolioBrief {
  const kept = lines.slice(0, MAX_BRIEF_LINES);
  return {
    organizationId: input.organizationId,
    localDate: input.localDate,
    generatedAt: input.now.toISOString(),
    kind,
    lines: kept,
    focusIds: kept.map((l) => l.findingId).filter((id): id is string => !!id),
  };
}
