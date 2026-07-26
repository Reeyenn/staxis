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
