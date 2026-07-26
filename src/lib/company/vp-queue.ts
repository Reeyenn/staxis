// ═══════════════════════════════════════════════════════════════════════════
// WHAT CLIMBS TO THE BOSS — the rules, with no database and no React in them.
//
// THE FOUNDER'S RULE THAT SHAPES EVERY LINE BELOW:
//
//   "The VP queue is built fresh from the underlying reality of their hotels —
//    never from GM tap-states. Seen silences the FEED, never the boss. A GM tap
//    must not add to, hide from, or dress up the VP's view."
//
// So this file never asks "did anybody look at this card". It asks about the
// PROBLEM: how much money is on it, how long it has been true, whether the
// company's own rulebook says somebody upstairs has to sign for it. A manager
// tapping "Seen" at 7am changes what the hotel's screen shows and changes
// nothing here — which is the whole point, because "I know" is exactly the
// state a boss most needs to hear about a $3,100 problem on day twelve.
//
// ─── THE ONE PLACE A HOTEL TAP DOES COUNT, AND WHY ─────────────────────────
// `resolved` and `expired` do not climb, and that is not a tap-state exception.
// Those two mean the problem STOPPED BEING TRUE — a manager fixed it, or the
// detector stopped finding it. Reality, not opinion. Climbing them would put
// solved problems on a VP's screen, which is how a portfolio queue teaches its
// reader to ignore it.
//
// `muted` is the founder's one judgement call and it is pinned here: mute is a
// manager saying "I am not doing this", and it holds — UNTIL the thing they
// declined has grown far past the size they declined at. Then it climbs. The
// alternative in one direction (never climb) lets one tap hide a growing
// problem from the only person who could fund it; in the other (always climb)
// makes "not doing this" mean nothing one level up. The consent point recorded
// at mute time (findings.silenced_at_magnitude) is what makes the middle answer
// computable at all.
// ═══════════════════════════════════════════════════════════════════════════

import type { EscalationPolicy, FindingStatus, PriceRange } from '@/lib/findings/types';
import {
  rankFindings,
  sortValueCents,
  type Lang,
  type QueueFinding,
} from '@/components/concourse/finding-cards';

// ─── The bars ───────────────────────────────────────────────────────────────

/**
 * Big enough to reach the boss on its own, whatever else is true about it.
 *
 * $2,000. Chosen against what a limited-service hotel's GM signs for without
 * thinking: a $300 pump and a $2,400 compressor are different conversations,
 * and only one of them is a conversation the person who owns twelve hotels
 * needs to be in. A constant rather than a setting on purpose — a per-company
 * knob here would be one more thing nobody configures, and a wrong default
 * pretending to be a choice.
 */
export const BIG_DOLLAR_CLIMB_CENTS = 200_000;

/**
 * The lower bar, for things that climb because of TIME rather than size.
 *
 * $500 — real money at a hotel, but not money a GM should be escalating on day
 * one. Below this a problem that sits for a fortnight is a hotel's own business.
 */
export const AGING_CLIMB_CENTS = 50_000;

/**
 * How long a problem worth more than AGING_CLIMB_CENTS may stay true before the
 * company hears about it. Seven days is one full operating week: a GM has had a
 * weekend, a Monday and a vendor call, and the thing is still there.
 */
export const AGING_CLIMB_DAYS = 7;

/**
 * How far past the muted size a problem must grow before it climbs anyway.
 *
 * Deliberately the same SHAPE as a detector's own escalation policy (both
 * conditions must hold) and a deliberately higher bar than any of them: a
 * doubling AND a real absolute move. A manager who said "not doing this" at 4
 * work orders is not overruled at 5. At 9, the person paying for the building
 * gets to know.
 */
export const MUTE_OVERRIDE_ESCALATION: EscalationPolicy = Object.freeze({
  factor: 2,
  minDelta: 2,
});

// ─── The candidate ──────────────────────────────────────────────────────────

/**
 * Everything the climbing rules read, and nothing else.
 *
 * Deliberately NOT `QueueFinding`: the rules need `silencedAtMagnitude`, which
 * a card never renders, and must not need anything a card DOES render. Keeping
 * the input minimal is what makes "no tap-state reaches these rules" checkable
 * by reading the type — `shownCount`, `actedCount` and `ignoredCount` are not
 * on it, so no future edit can quietly start consulting them.
 */
export interface ClimbCandidate {
  status: FindingStatus;
  price: PriceRange | null;
  /** ISO. When Staxis first saw the problem, not when the card was refreshed. */
  firstSeenAt: string;
  magnitude: number;
  /** The size the manager consented to when they silenced it. Null if never. */
  silencedAtMagnitude: number | null;
  /**
   * True when a company rule demands a signature THIS reader holds. Resolved by
   * src/lib/company/signoff.ts; passed in rather than computed here so these
   * rules stay pure.
   */
  awaitingMySignOff: boolean;
}

export type ClimbReason = 'sign_off' | 'big_dollar' | 'unresolved' | 'portfolio';

// ─── The rules ──────────────────────────────────────────────────────────────

/** Has a muted problem outgrown the size it was muted at? */
export function mutedButWorsening(candidate: ClimbCandidate): boolean {
  if (candidate.status !== 'muted') return false;
  const consented = candidate.silencedAtMagnitude;
  if (consented === null || !Number.isFinite(consented)) return false;
  if (!Number.isFinite(candidate.magnitude)) return false;
  return (
    candidate.magnitude >= consented * MUTE_OVERRIDE_ESCALATION.factor
    && candidate.magnitude - consented >= MUTE_OVERRIDE_ESCALATION.minDelta
  );
}

/**
 * Is this problem in a state that can reach the company at all?
 *
 * ONE predicate for every climb reason, deliberately. Writing "big-dollar cards
 * ignore Seen but aging cards respect it" would be four subtly different
 * answers to one question, and the first person to add a fifth reason would pick
 * whichever they read last.
 *
 *   open / updated   yes — the ordinary case
 *   known_problem    YES. "Seen" silences the feed, never the boss.
 *   muted            only when the problem outgrew the mute
 *   resolved         no — it was fixed
 *   expired          no — it stopped being true
 */
export function climbStatusAllows(candidate: ClimbCandidate): boolean {
  switch (candidate.status) {
    case 'open':
    case 'updated':
    case 'known_problem':
      return true;
    case 'muted':
      return mutedButWorsening(candidate);
    case 'resolved':
    case 'expired':
    default:
      return false;
  }
}

/** Whole days between the first sighting and now. Negative clocks read as 0. */
export function daysOpen(firstSeenAt: string, now: Date): number {
  const started = new Date(firstSeenAt).getTime();
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Math.floor((now.getTime() - started) / 86_400_000));
}

/**
 * The money a climb decision is measured against: the MIDDLE of the range.
 *
 * Deliberately different from `routingAmountCents` in signoff.ts, which takes
 * the TOP. That one applies a rule the company WROTE and must not let a plan
 * slip under a threshold it might well exceed; this one is an attention
 * heuristic, and it uses the same number the queue already sorts by, so the
 * card that climbed for being big is also the card sitting at the top.
 */
function climbValueCents(candidate: ClimbCandidate): number | null {
  return sortValueCents({ price: candidate.price });
}

/**
 * WHY this problem is on the company's screen — or null when it is not.
 *
 * Order matters: a card that is both waiting on a signature and expensive is
 * reported as waiting on a signature, because that is the one the reader can do
 * something about in one tap.
 */
export function climbReasonFor(candidate: ClimbCandidate, now: Date): ClimbReason | null {
  if (!climbStatusAllows(candidate)) return null;

  if (candidate.awaitingMySignOff) return 'sign_off';

  const value = climbValueCents(candidate);
  if (value !== null && value >= BIG_DOLLAR_CLIMB_CENTS) return 'big_dollar';

  if (
    value !== null
    && value >= AGING_CLIMB_CENTS
    && daysOpen(candidate.firstSeenAt, now) >= AGING_CLIMB_DAYS
  ) {
    return 'unresolved';
  }

  return null;
}

// ─── The card, as the portfolio screen renders it ───────────────────────────

/**
 * One card on a VP's screen: an ordinary finding card, plus which hotel it came
 * from and why it made it this far.
 *
 * A company-scope card (a cross-hotel comparison) has `hotel: null` and
 * `climbReason: 'portfolio'` — it did not climb from anywhere, it was born
 * here.
 */
export interface PortfolioCard extends QueueFinding {
  hotel: { propertyId: string; name: string } | null;
  climbReason: ClimbReason;
  /** Days since the first sighting. Carried so the reason line can say it. */
  daysOpen: number;
}

/**
 * Biggest dollars first, then first-come-first-served. The SAME function the
 * hotel queue and the morning brief rank with, so a VP and a GM looking at the
 * same problem see it in the same relative position — and so there is one place
 * for "what does this screen consider important" to be right.
 */
export function rankPortfolio(cards: readonly PortfolioCard[]): PortfolioCard[] {
  return rankFindings([...cards]);
}

// ─── Copy ───────────────────────────────────────────────────────────────────

type Bi = { en: string; es: string };
const pick = (b: Bi, lang: Lang) => (lang === 'es' ? b.es : b.en);

const REASON_COPY: Record<Exclude<ClimbReason, 'unresolved'>, Bi> = {
  sign_off: { en: 'Waiting for your sign-off', es: 'Esperando tu aprobación' },
  big_dollar: {
    en: 'Big enough to reach the company queue',
    es: 'Lo bastante grande para llegar a la cola de la empresa',
  },
  portfolio: { en: 'Across your hotels', es: 'En varios de tus hoteles' },
};

/**
 * The one line under a portfolio card that answers "why am I seeing this?".
 *
 * The aging reason carries its real number because the number IS the argument —
 * "still open" is a shrug and "still open 12 days after Staxis first saw it" is
 * a question for somebody. Every other reason is self-explanatory in three
 * words, and padding them with a figure would just be a figure to check.
 */
export function climbReasonLine(card: PortfolioCard, lang: Lang): string {
  if (card.climbReason === 'unresolved') {
    const days = Math.max(1, Math.round(card.daysOpen));
    return lang === 'es'
      ? `Sigue sin resolverse ${days} ${days === 1 ? 'día' : 'días'} después de que Staxis lo vio`
      : `Still unresolved ${days} ${days === 1 ? 'day' : 'days'} after Staxis first saw it`;
  }
  return pick(REASON_COPY[card.climbReason], lang);
}

/**
 * The deep link back into the hotel's own feed, focused on this exact card.
 *
 * Only for cards that came FROM a hotel — a company-scope comparison has no
 * hotel feed to land on, and offering a link that goes nowhere is worse than
 * offering none. The property switcher already exists, so the link only has to
 * name the hotel and the card.
 */
export function drillDownHref(card: PortfolioCard): string | null {
  if (!card.hotel) return null;
  return `/feed?pid=${encodeURIComponent(card.hotel.propertyId)}&focus=${encodeURIComponent(card.id)}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE HEALTH CHIP — one hotel, three words, on the picker.
//
// The command centre shows a company-scope person every hotel they cover as a
// card, and each card carries at most ONE chip. It is not a dashboard: a chip
// answers "does this building want me this morning?" and nothing else.
//
// ─── THE HONESTY RULE, WHICH IS THE WHOLE DESIGN ──────────────────────────
// "Quiet" is a CLAIM — it says Staxis looked and found nothing. A hotel that
// has never been checked, or was last checked days ago, has not earned it, and
// `chipForHotel` cannot produce it for them however hard a caller tries: the
// only input that can return 'quiet' is a run that happened inside
// RUN_FRESH_HOURS. A never-checked hotel gets `null` (no chip at all, because
// there is nothing true to say), and a stale one says so in as many words.
//
// "Needs you" and "N waiting" are the opposite kind of statement — they report
// findings that EXIST — so they stand on their own whether or not a run row
// was ever written. A hotel with a real $4,000 problem and a dead watcher must
// not go quiet just because the liveness read came back empty.
// ═══════════════════════════════════════════════════════════════════════════

export type HotelChipKind =
  /** Something climbed, or something is critical. Open this one first. */
  | 'needs_you'
  /** N decisions are sitting in this hotel's own queue. */
  | 'waiting'
  /** Checked recently, nothing waiting. The only chip that is a claim. */
  | 'quiet'
  /** Checked, but not lately. Says so rather than implying all-clear. */
  | 'stale';

export interface HotelChip {
  kind: HotelChipKind;
  /** Only meaningful for 'waiting'. Zero for every other kind. */
  count: number;
}

/**
 * What the chip rule reads. Deliberately tiny and tap-state-free, for the same
 * reason `ClimbCandidate` is: a future edit cannot quietly start consulting
 * `shownCount` to decide whether a hotel looks calm, because it is not here.
 */
export interface HotelHealthInput {
  /** Findings at this hotel that climbed — see `climbReasonFor`. */
  climbedCount: number;
  /** Renderable, live findings whose effective disposition is `propose`. */
  waitingCount: number;
  /** Renderable, live findings marked critical by the detector or the judge. */
  criticalCount: number;
  /** Hours since the hotel's last run. Null when it has never run. */
  hoursSinceRun: number | null;
}

/** How old a run may be before a hotel stops being allowed to look "quiet". */
export const HOTEL_CHIP_FRESH_HOURS = 48;

/**
 * The chip for one hotel, or null for "say nothing".
 *
 * Order of the questions matters and mirrors what a VP would ask out loud:
 * is anything on fire, is anything waiting on a person, and only then, has
 * anybody even looked.
 */
export function chipForHotel(input: HotelHealthInput): HotelChip | null {
  if (input.climbedCount > 0 || input.criticalCount > 0) {
    return { kind: 'needs_you', count: 0 };
  }
  if (input.waitingCount > 0) {
    return { kind: 'waiting', count: input.waitingCount };
  }
  const hours = input.hoursSinceRun;
  // Never run → NOTHING. Not "quiet", not "unknown", not a grey pill implying
  // we had a look. The card shows a hotel name and no claim at all.
  if (hours === null || !Number.isFinite(hours)) return null;
  if (hours > HOTEL_CHIP_FRESH_HOURS) return { kind: 'stale', count: 0 };
  return { kind: 'quiet', count: 0 };
}

/**
 * Where a chip sorts. Needs-you first, then waiting, then quiet — the founder's
 * order, and the order a person reads a list in.
 *
 * `stale` and no-chip sit at the BOTTOM rather than near needs-you, which is a
 * judgement call worth naming: they mean "Staxis has nothing to tell you about
 * this building", and a screen that pushed silence to the top would put the
 * hotels with the least information above the ones with a live problem.
 */
export const HOTEL_CHIP_RANK: Record<HotelChipKind | 'none', number> = Object.freeze({
  needs_you: 0,
  waiting: 1,
  quiet: 2,
  stale: 3,
  none: 4,
});

export interface RankableHotel {
  name: string;
  chip: HotelChip | null;
}

/**
 * Ranked by need, then alphabetical inside each band.
 *
 * The alphabetical tiebreak is `localeCompare` so "Ángel" files where a Spanish
 * reader expects it, and it is applied to hotels with the SAME chip only — a
 * quiet hotel never outranks a waiting one for being called "Abilene".
 */
export function rankHotels<T extends RankableHotel>(hotels: readonly T[]): T[] {
  return [...hotels].sort((a, b) => {
    const ar = HOTEL_CHIP_RANK[a.chip?.kind ?? 'none'];
    const br = HOTEL_CHIP_RANK[b.chip?.kind ?? 'none'];
    if (ar !== br) return ar - br;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

const CHIP_COPY: Record<Exclude<HotelChipKind, 'waiting'>, Bi> = {
  needs_you: { en: 'Needs you', es: 'Te necesita' },
  quiet: { en: 'Quiet', es: 'Tranquilo' },
  stale: { en: 'Not checked lately', es: 'Sin revisar hace días' },
};

/** The words on the chip. Plural handled in both languages, because "1 waiting"
 *  and "1 esperando" are the sentences a two-hotel company sees most. */
export function hotelChipLabel(chip: HotelChip, lang: Lang): string {
  if (chip.kind === 'waiting') {
    const n = Math.max(1, Math.round(chip.count));
    return lang === 'es'
      ? `${n} ${n === 1 ? 'espera' : 'esperan'}`
      : `${n} waiting`;
  }
  return pick(CHIP_COPY[chip.kind], lang);
}
