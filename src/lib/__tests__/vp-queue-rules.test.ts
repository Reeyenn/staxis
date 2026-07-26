/**
 * THE PORTFOLIO RULES, with no database and no React anywhere near them.
 *
 * Everything here is a decision somebody would notice being wrong:
 *
 *   ROUTING     which end of a price range a company's money rule is applied
 *               to, and who counts as holding a signature.
 *   THE LOCK    a card whose fix is not this person's to run shows no button,
 *               and says whose it is, in their language.
 *   CLIMBING    what reaches a boss. "Seen" must not silence them; "fixed"
 *               must; "not doing this" must, until the thing grows.
 *   PORTFOLIO   the word "outlier" is earned at three hotels, never two, and a
 *               hotel with no records must never appear in a side-by-side as a
 *               $0 spender.
 *   THE BRIEF   every number comes from planted reality, the cap holds, and a
 *               company nobody has checked gets no brief at all.
 *
 * The bar for every test below: it fails if a plausible bug is introduced. The
 * comment on each block says which one.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';

import {
  authorityKindForAction,
  hatsSatisfyApprover,
  routingAmountCents,
  ruleLeavesTheHotel,
} from '@/lib/company/signoff';
import type { AuthorityRule } from '@/lib/company/authority';
import type { MembershipHat } from '@/lib/company/access';
import {
  AGING_CLIMB_CENTS,
  AGING_CLIMB_DAYS,
  BIG_DOLLAR_CLIMB_CENTS,
  CRITICAL_CLIMB_DAYS,
  type ClimbReason,
  climbReasonFor,
  climbReasonLine,
  climbStatusAllows,
  daysOpen,
  drillDownHref,
  hotelHasLiveWork,
  mutedButWorsening,
  rankPortfolio,
  type ClimbCandidate,
  type PortfolioCard,
} from '@/lib/company/vp-queue';
import {
  MIN_HOTELS_FOR_OUTLIER_WORDING,
  PORTFOLIO_DETECTORS,
  comparableWeeks,
  hotelsStopped,
  portfolioActivityStoppedDetector,
  portfolioSpanish,
  supplySpendGapDetector,
  usesOutlierWording,
  type PortfolioHotel,
} from '@/lib/company/portfolio-checks';
import { buildPortfolioBrief, needsADecision } from '@/lib/company/vp-brief';
import { MAX_BRIEF_LINES } from '@/lib/findings/brief';
import {
  basisInLang,
  formatPriceRange,
  isSignOffLocked,
  occurrenceLine,
  offersApproval,
  parsePidParam,
  resolveDrillDown,
  signOffNotice,
  type CardSignOff,
  type QueueFinding,
} from '@/components/concourse/finding-cards';
import {
  formatCentsBand,
  formatCentsBandEs,
  formatMoney,
  formatMoneyRange,
  toPriceRange,
} from '@/lib/findings/pricing';
import { templatePriceSentence } from '@/lib/findings/template-phrasing';
import type { PriceRange } from '@/lib/findings/types';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const ORG_A = 'aaaa0000-0000-4000-8000-00000000000a';
const ORG_B = 'bbbb0000-0000-4000-8000-00000000000b';
const PID_1 = 'a1a1a1a1-0000-4000-8000-000000000001';
const PID_2 = 'a2a2a2a2-0000-4000-8000-000000000001';

function hat(over: Partial<MembershipHat> = {}): MembershipHat {
  return {
    membershipId: 'm1',
    organizationId: ORG_A,
    accountId: 'acct',
    scope: 'company',
    role: 'vp',
    jobTitle: null,
    coveredPropertyIds: [PID_1, PID_2],
    ...over,
  };
}

function price(lowCents: number, highCents: number): PriceRange {
  return { lowCents, highCents, currency: 'USD', basis: 'test' };
}

function candidate(over: Partial<ClimbCandidate> = {}): ClimbCandidate {
  return {
    status: 'open',
    price: price(10_000, 20_000),
    // 'attention' by default so the severity rule is opted INTO by the tests
    // that are about it, rather than firing under every other test's feet.
    severity: 'attention',
    firstSeenAt: '2026-07-20T00:00:00.000Z',
    magnitude: 4,
    silencedAtMagnitude: null,
    awaitingMySignOff: false,
    ...over,
  };
}

const NOW = new Date('2026-07-26T12:00:00.000Z');

function card(over: Partial<PortfolioCard> = {}): PortfolioCard {
  const base: PortfolioCard = {
    id: 'f1',
    detectorId: 'd1',
    dedupeKey: 'd1:k',
    summary: 'Something is wrong.',
    severity: 'attention',
    disposition: 'recommend',
    status: 'open',
    magnitude: 3,
    price: null,
    evidence: { queryId: 'q', params: {}, values: {}, basis: 'because' },
    asOf: null,
    weakestInputAgeDays: null,
    firstSeenAt: '2026-07-20T00:00:00.000Z',
    lastSeenAt: '2026-07-26T00:00:00.000Z',
    occurrenceCount: 1,
    hotel: { propertyId: PID_1, name: 'Beaumont' },
    climbReason: 'unresolved',
    daysOpen: 6,
  };
  return { ...base, ...over };
}

function queueCard(over: Partial<QueueFinding> = {}): QueueFinding {
  return { ...card(), ...over };
}

// ═══ ROUTING ═══════════════════════════════════════════════════════════════

describe('sign-off routing: which number the rule is applied to', () => {
  // Mutation: return `lowCents` (or the midpoint) instead. A $400–800 plan
  // would then slip under a $500 rule the company wrote to catch exactly it.
  test('a money rule is applied to the TOP of the range, not the bottom or the middle', () => {
    assert.equal(routingAmountCents(price(40_000, 80_000)), 80_000);
    assert.notEqual(routingAmountCents(price(40_000, 80_000)), 40_000);
    assert.notEqual(routingAmountCents(price(40_000, 80_000)), 60_000);
  });

  // Mutation: return 0 for an unpriced plan. Every "over $0" rule in the
  // product would suddenly gate every unpriced card.
  test('a plan with no price has no amount at all — never zero', () => {
    assert.equal(routingAmountCents(null), null);
    assert.equal(routingAmountCents(undefined), null);
  });

  // Mutation: add a fallback so unknown kinds map to 'purchase_order'. A future
  // action kind would then be silently gated by a rule nobody wrote for it.
  test('only the two catalog kinds map into the rulebook vocabulary', () => {
    assert.equal(authorityKindForAction('create_work_order'), 'expense');
    assert.equal(authorityKindForAction('raise_inventory_reorder_point'), 'purchase_order');
    assert.equal(authorityKindForAction('send_the_gm_a_letter'), null);
    assert.equal(authorityKindForAction(''), null);
  });

  // Mutation: route GM-approval rules upward too. A company that wrote "GMs
  // approve up to $500" would find every card leaving the hotel.
  test('a rule whose signature is the GM\'s own never leaves the hotel', () => {
    const rule = (approverRole: AuthorityRule['approverRole']): AuthorityRule => ({
      id: 'r', organizationId: ORG_A, actionKind: 'expense',
      thresholdCents: 50_000, thresholdInclusive: false, approverRole, sourceFactId: 'f',
    });
    assert.equal(ruleLeavesTheHotel(rule('vp')), true);
    assert.equal(ruleLeavesTheHotel(rule('owner')), true);
    assert.equal(ruleLeavesTheHotel(rule('finance')), true);
    assert.equal(ruleLeavesTheHotel(rule('general_manager')), false);
  });
});

describe('sign-off routing: who holds the signature', () => {
  test('the named role satisfies itself', () => {
    assert.equal(hatsSatisfyApprover([hat({ role: 'vp' })], ORG_A, PID_1, 'vp'), true);
  });

  // Mutation: require an exact role match. The owner of the company would be
  // unable to approve something their own rulebook routed to the VP.
  test('a stronger job may sign for a weaker one', () => {
    assert.equal(hatsSatisfyApprover([hat({ role: 'owner' })], ORG_A, PID_1, 'vp'), true);
    assert.equal(hatsSatisfyApprover([hat({ role: 'vp' })], ORG_A, PID_1, 'general_manager'), true);
  });

  // Mutation: compare strength with `<=` or drop the comparison. A controller
  // could sign for the owner.
  test('a weaker job may NOT sign for a stronger one', () => {
    assert.equal(hatsSatisfyApprover([hat({ role: 'finance' })], ORG_A, PID_1, 'vp'), false);
    assert.equal(hatsSatisfyApprover([hat({ role: 'vp' })], ORG_A, PID_1, 'owner'), false);
  });

  // Mutation: drop the role whitelist. A housekeeper's hat would satisfy a GM
  // approval rule.
  test('line-staff jobs never hold a signature', () => {
    for (const role of ['front_desk', 'maintenance', 'housekeeping'] as const) {
      assert.equal(
        hatsSatisfyApprover([hat({ role })], ORG_A, PID_1, 'general_manager'),
        false,
        `${role} was allowed to approve`,
      );
    }
  });

  // Mutation: drop the coverage check. A GM of Beaumont would be able to sign
  // for Lufkin, which is a different manager's hotel.
  test('a property job satisfies a signature only at the hotels it covers', () => {
    const gm = hat({ scope: 'property', role: 'general_manager', coveredPropertyIds: [PID_1] });
    assert.equal(hatsSatisfyApprover([gm], ORG_A, PID_1, 'general_manager'), true);
    assert.equal(hatsSatisfyApprover([gm], ORG_A, PID_2, 'general_manager'), false);
  });

  // Mutation: drop the organization comparison. Company B's VP could sign for
  // company A the moment a property id happened to appear in both lists.
  test('a hat at another company satisfies nothing here (Wall B)', () => {
    const other = hat({ organizationId: ORG_B, role: 'owner' });
    assert.equal(hatsSatisfyApprover([other], ORG_A, PID_1, 'vp'), false);
  });

  // Mutation: let a property hat sign a company-scope card. A GM would be able
  // to close a cross-hotel comparison about hotels they do not run.
  test('a company-scope card needs a company-scope hat', () => {
    const gm = hat({ scope: 'property', role: 'general_manager', coveredPropertyIds: [PID_1] });
    assert.equal(hatsSatisfyApprover([gm], ORG_A, null, 'general_manager'), false);
    assert.equal(hatsSatisfyApprover([hat({ role: 'vp' })], ORG_A, null, 'vp'), true);
  });
});

// ═══ THE LOCK ══════════════════════════════════════════════════════════════

describe('the locked card', () => {
  const signOff = (over: Partial<CardSignOff> = {}): CardSignOff => ({
    approverRole: 'vp',
    approverNames: ['Maria'],
    thresholdCents: 50_000,
    callerMayApprove: false,
    ...over,
  });

  const proposal = (over: Partial<QueueFinding> = {}): QueueFinding => queueCard({
    disposition: 'propose',
    action: {
      id: 'a1', kind: 'create_work_order', state: 'proposed',
      offerEn: 'Create it?', offerEs: '¿Crearlo?',
      labelEn: 'Create', labelEs: 'Crear',
      receiptEn: null, receiptEs: null, changed: null, failureReason: null,
    },
    ...over,
  });

  // Mutation: make offersApproval ignore signOff. The GM gets the button back
  // and the company's rule is decoration.
  test('a locked proposal offers no approve button', () => {
    const locked = proposal({ signOff: signOff() });
    assert.equal(isSignOffLocked(locked), true);
    assert.equal(offersApproval(locked), false);
  });

  // Mutation: lock whenever a signOff exists. The VP the card was routed TO
  // would find their own card locked, and nobody could ever act.
  test('the person who holds the signature still gets the button', () => {
    const mine = proposal({ signOff: signOff({ callerMayApprove: true }) });
    assert.equal(isSignOffLocked(mine), false);
    assert.equal(offersApproval(mine), true);
  });

  // Mutation: treat a missing signOff as locked. Every hotel in the product
  // today — none of which is in a company — would lose every button.
  test('no rule means no lock', () => {
    const plain = proposal();
    assert.equal(isSignOffLocked(plain), false);
    assert.equal(offersApproval(plain), true);
  });

  // Mutation: build the sentence from an English string the server sent. A
  // Spanish reader gets English, or a stale translation.
  test('the notice is written in the reader\'s own language, from the role', () => {
    const en = signOffNotice(signOff(), 'en');
    const es = signOffNotice(signOff(), 'es');
    assert.match(en, /Needs VP sign-off/);
    assert.match(en, /Maria/);
    assert.match(es, /aprobación/);
    assert.match(es, /Maria/);
    assert.notEqual(en, es);
  });

  // Mutation: return null / render nothing when nobody holds the job. The
  // company wrote a rule and the GM would silently get the button back.
  test('an unnamed approver still produces a notice', () => {
    const notice = signOffNotice(signOff({ approverNames: [] }), 'en');
    assert.match(notice, /Needs VP sign-off/);
    assert.doesNotMatch(notice, /sent to/);
  });

  test('several approvers are listed readably', () => {
    assert.match(signOffNotice(signOff({ approverNames: ['Ana', 'Maria'] }), 'en'), /Ana and Maria/);
    assert.match(signOffNotice(signOff({ approverNames: ['Ana', 'Maria'] }), 'es'), /Ana y Maria/);
  });

  // Mutation: build the Spanish sentence as "de " + the role word. Two of the
  // four roles then read "de el VP" / "de el gerente", which Spanish contracts
  // to "del". Caught on screen, so it is pinned here.
  test('the Spanish notice contracts, for every role', () => {
    const expected: Record<string, RegExp> = {
      owner: /Necesita la aprobación de la propiedad\b/,
      vp: /Necesita la aprobación del VP\b/,
      finance: /Necesita la aprobación de finanzas\b/,
      general_manager: /Necesita la aprobación del gerente\b/,
    };
    for (const [approverRole, pattern] of Object.entries(expected)) {
      const text = signOffNotice(signOff({ approverRole, approverNames: [] }), 'es');
      assert.match(text, pattern, `wrong Spanish for ${approverRole}: ${text}`);
      assert.doesNotMatch(text, /\bde el\b/, `uncontracted "de el" for ${approverRole}`);
    }
  });
});

// ═══ CLIMBING ══════════════════════════════════════════════════════════════

describe('what reaches the boss', () => {
  // THE founder ruling. Mutation: filter known_problem out of the visible set,
  // or add it to the "no" branch. A GM tapping Seen would hide a problem from
  // the only person who could fund fixing it.
  test('"Seen" silences the feed and NOT the boss', () => {
    assert.equal(climbStatusAllows(candidate({ status: 'known_problem' })), true);
  });

  // Mutation: let resolved/expired climb. Solved problems pile onto a VP's
  // screen and the queue teaches its reader to ignore it.
  test('a problem that stopped being true does not climb', () => {
    assert.equal(climbStatusAllows(candidate({ status: 'resolved' })), false);
    assert.equal(climbStatusAllows(candidate({ status: 'expired' })), false);
  });

  // Mutation: let every muted card climb. "Not doing this" would mean nothing
  // one level up, which is the other half of the founder's judgement call.
  test('a plain mute holds', () => {
    assert.equal(
      climbStatusAllows(candidate({ status: 'muted', magnitude: 4, silencedAtMagnitude: 4 })),
      false,
    );
  });

  // Mutation: drop the override. One tap hides a growing problem forever.
  test('a mute that was overtaken by the problem does not hold', () => {
    assert.equal(
      climbStatusAllows(candidate({ status: 'muted', magnitude: 9, silencedAtMagnitude: 4 })),
      true,
    );
  });

  // Mutation: weaken the escalation bar to a single condition. A 4→5 creep
  // would overrule a manager who explicitly declined.
  test('the mute override needs BOTH a doubling and a real absolute move', () => {
    // Doubling, but the absolute move is under the floor.
    assert.equal(mutedButWorsening(candidate({ status: 'muted', magnitude: 2, silencedAtMagnitude: 1 })), false);
    // A big absolute move without a doubling.
    assert.equal(mutedButWorsening(candidate({ status: 'muted', magnitude: 30, silencedAtMagnitude: 20 })), false);
    // Both.
    assert.equal(mutedButWorsening(candidate({ status: 'muted', magnitude: 40, silencedAtMagnitude: 20 })), true);
  });

  // Mutation: default a missing consent point to 0. Every muted card would
  // instantly "outgrow" a zero baseline and climb.
  test('a mute with no recorded consent point never overrides itself', () => {
    assert.equal(
      mutedButWorsening(candidate({ status: 'muted', magnitude: 99, silencedAtMagnitude: null })),
      false,
    );
  });

  // Mutation: reorder the reasons. A card the reader can clear in one tap
  // would be reported as "big" and they would not know it was waiting on them.
  test('a signature outranks every other reason', () => {
    const reason = climbReasonFor(
      candidate({ awaitingMySignOff: true, price: price(500_000, 900_000) }),
      NOW,
    );
    assert.equal(reason, 'sign_off');
  });

  // Mutation: move the threshold, or compare against the range's high end. The
  // bar the constant documents stops being the bar.
  test('the big-dollar bar is the range MIDPOINT against the constant', () => {
    // Midpoint exactly on the bar.
    const onBar = climbReasonFor(
      candidate({ price: price(BIG_DOLLAR_CLIMB_CENTS - 1000, BIG_DOLLAR_CLIMB_CENTS + 1000) }),
      NOW,
    );
    assert.equal(onBar, 'big_dollar');
    // A range whose TOP clears the bar but whose middle does not: not big.
    const straddling = climbReasonFor(
      candidate({
        price: price(1000, BIG_DOLLAR_CLIMB_CENTS + 1000),
        firstSeenAt: NOW.toISOString(),
      }),
      NOW,
    );
    assert.notEqual(straddling, 'big_dollar');
  });

  // Mutation: drop the age condition, or the value floor. Either every cheap
  // card climbs after a week, or nothing ever climbs for being old.
  test('an expensive-enough card climbs only after it has sat for the full window', () => {
    const priced = price(AGING_CLIMB_CENTS, AGING_CLIMB_CENTS * 2);
    const dayBefore = new Date(NOW.getTime() - (AGING_CLIMB_DAYS - 1) * 86_400_000).toISOString();
    const onTheDay = new Date(NOW.getTime() - AGING_CLIMB_DAYS * 86_400_000).toISOString();

    assert.equal(climbReasonFor(candidate({ price: priced, firstSeenAt: dayBefore }), NOW), null);
    assert.equal(
      climbReasonFor(candidate({ price: priced, firstSeenAt: onTheDay }), NOW),
      'unresolved',
    );
  });

  // Mutation: drop the value floor on the aging rule. A $12 card that nobody
  // bothered with would arrive on the owner's desk after a week.
  test('a cheap card never climbs however long it sits', () => {
    const ancient = new Date(NOW.getTime() - 400 * 86_400_000).toISOString();
    assert.equal(
      climbReasonFor(candidate({ price: price(100, 900), firstSeenAt: ancient }), NOW),
      null,
    );
  });

  // Mutation: treat an unpriced card as worth anything. Every FYI in the fleet
  // would climb after a week.
  test('an unpriced ORDINARY card never climbs on money or on age', () => {
    const ancient = new Date(NOW.getTime() - 400 * 86_400_000).toISOString();
    assert.equal(
      climbReasonFor(candidate({ price: null, severity: 'attention', firstSeenAt: ancient }), NOW),
      null,
    );
    assert.equal(
      climbReasonFor(candidate({ price: null, severity: 'info', firstSeenAt: ancient }), NOW),
      null,
    );
  });

  // ═══ THE RULE THAT NEVER LOOKS AT MONEY ═══
  //
  // Every other bar here is a dollar bar, and this product REFUSES to invent a
  // price it cannot derive from the hotel's own records — `preventive_due` emits
  // critical findings with `price: null` by design. So before this rule, a water
  // heater a full cycle overdue was not ranked low on the VP's screen, it was
  // structurally unable to appear on it, and nothing said so.
  //
  // MUTATION PROOF: delete the severity branch in `climbReasonFor` and the first
  // two assertions below both come back null — the exact invisible state.
  test('a CRITICAL card climbs with no price at all, once it has stood for the window', () => {
    const justUnder = new Date(NOW.getTime() - (CRITICAL_CLIMB_DAYS - 1) * 86_400_000).toISOString();
    const onTheDay = new Date(NOW.getTime() - CRITICAL_CLIMB_DAYS * 86_400_000).toISOString();

    assert.equal(
      climbReasonFor(candidate({ price: null, severity: 'critical', firstSeenAt: onTheDay }), NOW),
      'critical',
    );
    // And not on day one: a GM who is already dealing with it is not
    // second-guessed the same morning.
    assert.equal(
      climbReasonFor(candidate({ price: null, severity: 'critical', firstSeenAt: justUnder }), NOW),
      null,
    );
  });

  test('severity does not outrank money — a big-dollar critical still reports the money', () => {
    const onTheDay = new Date(NOW.getTime() - CRITICAL_CLIMB_DAYS * 86_400_000).toISOString();
    assert.equal(
      climbReasonFor(
        candidate({
          price: price(BIG_DOLLAR_CLIMB_CENTS, BIG_DOLLAR_CLIMB_CENTS * 2),
          severity: 'critical',
          firstSeenAt: onTheDay,
        }),
        NOW,
      ),
      'big_dollar',
    );
  });

  test('a resolved critical still does not climb — the status gate is first for every reason', () => {
    const onTheDay = new Date(NOW.getTime() - CRITICAL_CLIMB_DAYS * 86_400_000).toISOString();
    for (const status of ['resolved', 'expired'] as const) {
      assert.equal(
        climbReasonFor(
          candidate({ status, price: null, severity: 'critical', firstSeenAt: onTheDay }),
          NOW,
        ),
        null,
      );
    }
  });

  // The founder's one exception to "mute means gone" was being COMPUTED and then
  // thrown away: `climbStatusAllows` let a worsening muted row through, and then
  // every remaining rule asked for a price it did not have.
  //
  // MUTATION PROOF: delete the trailing `status === 'muted'` branch and the
  // first assertion returns null — a problem that doubled after a manager
  // declined it stays invisible to the only person who could fund it.
  test('a muted card that outgrew its mute climbs even with no price', () => {
    const worsening = candidate({
      status: 'muted',
      price: null,
      severity: 'attention',
      silencedAtMagnitude: 4,
      magnitude: 9,
    });
    assert.equal(climbReasonFor(worsening, NOW), 'outgrew_mute');

    // And a mute that is holding still means what it says.
    assert.equal(
      climbReasonFor({ ...worsening, magnitude: 5 }, NOW),
      null,
      'a problem that crept from 4 to 5 is not an overruled decision',
    );
    assert.equal(
      climbReasonFor({ ...worsening, silencedAtMagnitude: null }, NOW),
      null,
      'with no recorded consent point there is nothing to have outgrown',
    );
  });

  // Mutation: let a resolved card climb because it is expensive. The status
  // gate has to come FIRST, before any money test.
  test('the status gate runs before the money test', () => {
    const rich = candidate({ status: 'resolved', price: price(500_000, 900_000) });
    assert.equal(climbReasonFor(rich, NOW), null);
  });

  test('days open is whole days, and a clock skew reads as zero rather than negative', () => {
    assert.equal(daysOpen('2026-07-20T00:00:00.000Z', NOW), 6);
    assert.equal(daysOpen('2026-08-20T00:00:00.000Z', NOW), 0);
    assert.equal(daysOpen('not a date', NOW), 0);
  });
});

describe('the portfolio queue reads in the standing order', () => {
  // Mutation: sort by severity, or by hotel name. The founder's rule is
  // dollars first, then first-come, and it is the same helper the hotel queue
  // and the brief use.
  test('biggest dollars first, then oldest first', () => {
    const big = card({ id: 'big', price: price(300_000, 400_000), firstSeenAt: '2026-07-25T00:00:00.000Z' });
    const small = card({ id: 'small', price: price(10_000, 20_000), firstSeenAt: '2026-07-01T00:00:00.000Z' });
    const oldFree = card({ id: 'old', price: null, firstSeenAt: '2026-06-01T00:00:00.000Z' });
    const newFree = card({ id: 'new', price: null, firstSeenAt: '2026-07-25T00:00:00.000Z' });

    const ranked = rankPortfolio([newFree, small, oldFree, big]);
    assert.deepEqual(ranked.map((c) => c.id), ['big', 'small', 'old', 'new']);
  });
});

describe('the "why am I seeing this" line', () => {
  // Mutation: drop the number from the aging line. "Still unresolved" is a
  // shrug; the number is the whole argument.
  test('the aging reason carries its real day count, in both languages', () => {
    const c = card({ climbReason: 'unresolved', daysOpen: 12 });
    assert.match(climbReasonLine(c, 'en'), /12 days/);
    assert.match(climbReasonLine(c, 'es'), /12 días/);
  });

  test('one day is singular', () => {
    const c = card({ climbReason: 'unresolved', daysOpen: 1 });
    assert.match(climbReasonLine(c, 'en'), /1 day\b/);
    assert.match(climbReasonLine(c, 'es'), /1 día\b/);
  });

  test('the urgent reason carries its day count too, in both languages', () => {
    const c = card({ climbReason: 'critical', daysOpen: 4 });
    assert.match(climbReasonLine(c, 'en'), /4 days/);
    assert.match(climbReasonLine(c, 'es'), /4 días/);
  });

  // EVERY reason, listed exhaustively rather than sampled: a new climb reason
  // with no copy renders a blank line under a card, and a blank line is how a
  // VP learns the screen is unfinished.
  test('every reason has copy in both languages and they differ', () => {
    const everyReason: readonly ClimbReason[] = [
      'sign_off', 'big_dollar', 'critical', 'unresolved', 'outgrew_mute', 'portfolio',
    ];
    for (const reason of everyReason) {
      const c = card({ climbReason: reason, daysOpen: 5 });
      const en = climbReasonLine(c, 'en');
      const es = climbReasonLine(c, 'es');
      assert.ok(en.length > 0 && es.length > 0, `${reason} had a blank line`);
      assert.notEqual(en, es, `${reason} was not translated`);
      assert.doesNotMatch(en, /undefined/, `${reason} rendered undefined`);
      assert.doesNotMatch(es, /undefined/, `${reason} rendered undefined`);
    }
  });

  // Mutation: build a link for a company card too. It would land on a hotel
  // feed that has never heard of the finding, and appear to do nothing.
  test('only a card that came from a hotel gets a drill-down', () => {
    const fromHotel = drillDownHref(card());
    assert.ok(fromHotel);
    assert.match(fromHotel!, new RegExp(`pid=${PID_1}`));
    assert.match(fromHotel!, /focus=f1/);
    assert.equal(drillDownHref(card({ hotel: null })), null);
  });
});

// ═══ PORTFOLIO CHECKS ══════════════════════════════════════════════════════

const WEEK_DATES = ['2026-07-19', '2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24', '2026-07-25'];

function spendHotel(
  name: string,
  cents: number,
  over: Partial<PortfolioHotel> = {},
): PortfolioHotel {
  return {
    propertyId: `${name.toLowerCase()}-id`,
    name,
    businessDate: '2026-07-26',
    supplySpend: {
      days: WEEK_DATES.map((date, i) => ({ date, value: i === 0 ? cents : 0 })),
      coverageStartDate: '2026-04-01',
      windowDays: 98,
    },
    rhythm: null,
    ...over,
  };
}

describe('cross-hotel comparison: the wording rules', () => {
  // FOUNDER RULING. Mutation: allow the word at two hotels. Calling one of two
  // numbers an outlier is statistics theatre.
  test('two hotels get a side-by-side and NEVER the word "outlier"', () => {
    const drafts = supplySpendGapDetector.detect({
      organizationId: ORG_A,
      hotels: [spendHotel('Beaumont', 80_000), spendHotel('Lufkin', 140_000)],
      now: NOW,
    });
    assert.equal(drafts.length, 1);
    assert.doesNotMatch(drafts[0].summary, /outlier/i);
    assert.match(drafts[0].summary, /Beaumont/);
    assert.match(drafts[0].summary, /Lufkin/);
    assert.match(drafts[0].summary, /\$1,400/);
    assert.match(drafts[0].summary, /\$800/);
    assert.equal(drafts[0].evidence.values.outlier_wording_used, false);
  });

  // Mutation: raise or drop the OUTLIER_RATIO test. The word would appear on
  // three hotels that are all spending about the same.
  test('three hotels earn the word only when the arithmetic supports it', () => {
    const spread = supplySpendGapDetector.detect({
      organizationId: ORG_A,
      hotels: [spendHotel('Beaumont', 60_000), spendHotel('Lufkin', 300_000), spendHotel('Tyler', 70_000)],
      now: NOW,
    });
    assert.match(spread[0].summary, /outlier/i);

    const bunched = supplySpendGapDetector.detect({
      organizationId: ORG_A,
      hotels: [spendHotel('Beaumont', 100_000), spendHotel('Lufkin', 160_000), spendHotel('Tyler', 155_000)],
      now: NOW,
    });
    assert.equal(bunched.length, 1);
    assert.doesNotMatch(bunched[0].summary, /outlier/i);
  });

  test('the gate itself is explicit about both halves', () => {
    assert.equal(usesOutlierWording(MIN_HOTELS_FOR_OUTLIER_WORDING - 1, 1000, 100), false);
    assert.equal(usesOutlierWording(MIN_HOTELS_FOR_OUTLIER_WORDING, 1000, 100), true);
    assert.equal(usesOutlierWording(MIN_HOTELS_FOR_OUTLIER_WORDING, 110, 100), false);
    assert.equal(usesOutlierWording(MIN_HOTELS_FOR_OUTLIER_WORDING, 1000, 0), false);
  });
});

describe('cross-hotel comparison: what may be compared', () => {
  // Mutation: drop the coverage check. A hotel that joined Staxis last week
  // would be reported as spending $0 next to a sister spending $1,400 — the
  // single most damaging sentence this check could write.
  test('a hotel with no records for the week sits the comparison out', () => {
    const newcomer = spendHotel('Newcomer', 0, {
      supplySpend: { days: [], coverageStartDate: '2026-07-24', windowDays: 98 },
    });
    const weeks = comparableWeeks([spendHotel('Lufkin', 140_000), newcomer]);
    assert.deepEqual(weeks.map((w) => w.hotel.name), ['Lufkin']);

    const drafts = supplySpendGapDetector.detect({
      organizationId: ORG_A,
      hotels: [spendHotel('Lufkin', 140_000), newcomer],
      now: NOW,
    });
    assert.deepEqual(drafts, [], 'a one-hotel comparison produced a card');
  });

  // Mutation: drop the failure isolation. One hotel whose feed did not load
  // would appear as a $0 spender.
  test('a hotel whose feed failed to load sits the comparison out', () => {
    const broken = spendHotel('Broken', 0, { supplySpend: null });
    assert.deepEqual(
      comparableWeeks([spendHotel('Lufkin', 140_000), broken]).map((w) => w.hotel.name),
      ['Lufkin'],
    );
  });

  // Mutation: remove the floors. "Beaumont spent $40, Lufkin $70" would reach
  // a VP's morning brief.
  test('small money and small gaps never produce a card', () => {
    const tiny = supplySpendGapDetector.detect({
      organizationId: ORG_A,
      hotels: [spendHotel('Beaumont', 4_000), spendHotel('Lufkin', 7_000)],
      now: NOW,
    });
    assert.deepEqual(tiny, []);

    const close = supplySpendGapDetector.detect({
      organizationId: ORG_A,
      hotels: [spendHotel('Beaumont', 100_000), spendHotel('Lufkin', 110_000)],
      now: NOW,
    });
    assert.deepEqual(close, []);
  });

  // Mutation: put the gap in the dedupe key. Next week's bigger gap would
  // stack a second card about the same problem, which is exactly what the
  // one-row-per-problem index exists to stop.
  test('the problem\'s identity does not contain the measurement', () => {
    const a = supplySpendGapDetector.detect({
      organizationId: ORG_A,
      hotels: [spendHotel('Beaumont', 80_000), spendHotel('Lufkin', 140_000)],
      now: NOW,
    });
    const b = supplySpendGapDetector.detect({
      organizationId: ORG_A,
      hotels: [spendHotel('Beaumont', 80_000), spendHotel('Lufkin', 260_000)],
      now: NOW,
    });
    assert.equal(a[0].key, b[0].key);
    assert.notEqual(a[0].magnitude, b[0].magnitude);
  });

  // Mutation: name only the top hotel. A VP cannot check a side-by-side claim
  // against hotels the receipt does not list.
  test('the receipt names every hotel in the comparison set', () => {
    const drafts = supplySpendGapDetector.detect({
      organizationId: ORG_A,
      hotels: [spendHotel('Beaumont', 60_000), spendHotel('Lufkin', 300_000), spendHotel('Tyler', 70_000)],
      now: NOW,
    });
    const named = drafts[0].evidence.params.hotels as string[];
    assert.deepEqual([...named].sort(), ['Beaumont', 'Lufkin', 'Tyler']);
  });

  // Mutation: price it with a point estimate, or from the top hotel alone.
  test('two hotels carry no price, three-with-spread do — and it is a range', () => {
    const pair = supplySpendGapDetector.detect({
      organizationId: ORG_A,
      hotels: [spendHotel('Beaumont', 80_000), spendHotel('Lufkin', 140_000)],
      now: NOW,
    });
    assert.equal(pair[0].price, null);
    assert.match(String(pair[0].evidence.values.price_basis), /two hotels/);

    const trio = supplySpendGapDetector.detect({
      organizationId: ORG_A,
      hotels: [spendHotel('Beaumont', 60_000), spendHotel('Lufkin', 300_000), spendHotel('Tyler', 90_000)],
      now: NOW,
    });
    assert.ok(trio[0].price, 'a three-hotel comparison with real spread was not priced');
    assert.ok(trio[0].price!.highCents > trio[0].price!.lowCents, 'the price was not a range');
  });
});

describe('several hotels stopped the same thing', () => {
  function rhythmHotel(name: string, silentDays: number, everyNDays = 3): PortfolioHotel {
    const businessDate = '2026-07-26';
    const dates: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const at = new Date(Date.UTC(2026, 6, 26) - (silentDays + i * everyNDays) * 86_400_000);
      dates.push(at.toISOString().slice(0, 10));
    }
    return {
      propertyId: `${name.toLowerCase()}-id`,
      name,
      businessDate,
      supplySpend: null,
      rhythm: {
        streams: [{
          id: 'work_orders',
          label: 'logging maintenance',
          dates: dates.sort(),
          worthCentsSamples: [],
          worthBasis: null,
        }],
        coverageStartDate: '2026-04-01',
        windowDays: 98,
      },
    };
  }

  // Mutation: fire at one hotel. That is the hotel's OWN card, already on its
  // own feed, and repeating it here is a second inbox for the same fact.
  test('one hotel going quiet is not a portfolio pattern', () => {
    const drafts = portfolioActivityStoppedDetector.detect({
      organizationId: ORG_A,
      hotels: [rhythmHotel('Beaumont', 30), rhythmHotel('Lufkin', 0)],
      now: NOW,
    });
    assert.deepEqual(drafts, []);
  });

  test('two hotels going quiet is', () => {
    const drafts = portfolioActivityStoppedDetector.detect({
      organizationId: ORG_A,
      hotels: [rhythmHotel('Beaumont', 30), rhythmHotel('Lufkin', 40), rhythmHotel('Tyler', 0)],
      now: NOW,
    });
    assert.equal(drafts.length, 1);
    assert.match(drafts[0].summary, /2 of your hotels stopped logging maintenance/);
    assert.match(drafts[0].summary, /Beaumont and Lufkin/);
    assert.doesNotMatch(drafts[0].summary, /Tyler/);
    assert.equal(drafts[0].magnitude, 2);
  });

  // Mutation: count a hotel with no rhythm as stopped. "4 of your hotels
  // stopped" about two hotels that opened last month is a fabrication wearing
  // an aggregate's clothes.
  test('a hotel that never established a rhythm has not stopped anything', () => {
    const brandNew: PortfolioHotel = {
      propertyId: 'new-id',
      name: 'Newcomer',
      businessDate: '2026-07-26',
      supplySpend: null,
      rhythm: {
        streams: [{ id: 'work_orders', label: 'logging maintenance', dates: ['2026-07-01', '2026-07-04'], worthCentsSamples: [], worthBasis: null }],
        coverageStartDate: '2026-07-01',
        windowDays: 98,
      },
    };
    assert.deepEqual(hotelsStopped([brandNew], 'work_orders'), []);

    const drafts = portfolioActivityStoppedDetector.detect({
      organizationId: ORG_A,
      hotels: [rhythmHotel('Beaumont', 30), brandNew],
      now: NOW,
    });
    assert.deepEqual(drafts, []);
  });

  // Mutation: put the count in the dedupe key. A third hotel joining would
  // open a second card about the same silence.
  test('the identity is the stream, not how many hotels have it', () => {
    const two = portfolioActivityStoppedDetector.detect({
      organizationId: ORG_A,
      hotels: [rhythmHotel('Beaumont', 30), rhythmHotel('Lufkin', 40)],
      now: NOW,
    });
    const three = portfolioActivityStoppedDetector.detect({
      organizationId: ORG_A,
      hotels: [rhythmHotel('Beaumont', 30), rhythmHotel('Lufkin', 40), rhythmHotel('Tyler', 35)],
      now: NOW,
    });
    assert.equal(two[0].key, three[0].key);
    assert.notEqual(two[0].magnitude, three[0].magnitude);
  });

  // Mutation: invent a company-level price. A number nobody can check is worse
  // than none.
  test('it carries no dollar figure, and says why', () => {
    const drafts = portfolioActivityStoppedDetector.detect({
      organizationId: ORG_A,
      hotels: [rhythmHotel('Beaumont', 30), rhythmHotel('Lufkin', 40)],
      now: NOW,
    });
    assert.equal(drafts[0].price, null);
    assert.match(String(drafts[0].evidence.values.price_basis), /no dollar figure/);
  });
});

// ═══ THE BRIEF ═════════════════════════════════════════════════════════════
//
// ENGLISH-ONLY, by founder ruling (2026-07-26) — the same ruling that governs
// the hotel brief, and for the same reason: this card is written and read in
// English whatever language the reader has the app set to. The tests that used
// to demand a Spanish half of every line now demand that no such half exists.
// The portfolio CARDS below the brief are untouched and still bilingual.

describe('the portfolio morning brief', () => {
  const run = {
    thingsChecked: 384,
    hotelsChecked: 11,
    hotelsTotal: 12,
    lastRunAt: new Date(NOW.getTime() - 6 * 3_600_000).toISOString(),
  };

  const input = (over: Partial<Parameters<typeof buildPortfolioBrief>[0]> = {}) => ({
    organizationId: ORG_A,
    localDate: '2026-07-26',
    hotelCount: 12,
    cards: [] as PortfolioCard[],
    run,
    now: NOW,
    ...over,
  });

  // THE most important behaviour on this surface. Mutation: return a "quiet"
  // brief instead of null. A company nobody has ever checked would be told
  // everything is fine.
  test('a company nobody has checked gets NO brief at all', () => {
    assert.equal(buildPortfolioBrief(input({ run: null })), null);
    assert.equal(buildPortfolioBrief(input({ run: { ...run, lastRunAt: null } })), null);
  });

  // Mutation: print "nothing needs a decision" whenever the decision count is
  // zero. Four standing cards would sit underneath that sentence.
  test('"nothing needs a decision" is only said when the screen is genuinely empty', () => {
    const empty = buildPortfolioBrief(input())!;
    assert.equal(empty.kind, 'quiet');
    assert.match(empty.lines[0].text, /nothing needs a decision/i);

    const withCards = buildPortfolioBrief(input({
      cards: [card({ disposition: 'recommend', climbReason: 'unresolved' })],
    }))!;
    assert.equal(withCards.kind, 'report');
    assert.doesNotMatch(withCards.lines[0].text, /^Across your 12 hotels: nothing needs a decision\.$/);
    assert.match(withCards.lines[0].text, /worth a look/i);
  });

  // Mutation: count every card as "needs you". FYIs and comparisons would be
  // reported as decisions and the number would stop meaning anything.
  test('"N need you" counts DECISIONS, not cards', () => {
    const brief = buildPortfolioBrief(input({
      cards: [
        card({ id: 'a', disposition: 'propose', hotel: { propertyId: PID_1, name: 'Beaumont' } }),
        card({ id: 'b', disposition: 'recommend', hotel: { propertyId: PID_2, name: 'Lufkin' } }),
        card({ id: 'c', disposition: 'fyi', hotel: { propertyId: PID_2, name: 'Lufkin' } }),
      ],
    }))!;
    assert.match(brief.lines[0].text, /Across your 12 hotels: 1 needs you\./);
  });

  // Mutation: make a sign-off card not count. The one card the reader can
  // clear in a single tap would be missing from the number that tells them to
  // look.
  test('a card routed to this reader for signature counts as needing them', () => {
    assert.equal(needsADecision(card({ disposition: 'fyi', climbReason: 'sign_off' })), true);
    assert.equal(needsADecision(card({ disposition: 'propose', climbReason: 'unresolved' })), true);
    assert.equal(needsADecision(card({ disposition: 'recommend', climbReason: 'big_dollar' })), false);
  });

  // Mutation: count "quiet" as "hotels with no decisions". A hotel with a $900
  // card that climbed for being old would be reported as quiet.
  test('"quiet" means nothing on the screen at all, not merely no decisions', () => {
    const brief = buildPortfolioBrief(input({
      hotelCount: 12,
      cards: [
        card({ id: 'a', disposition: 'propose', hotel: { propertyId: PID_1, name: 'Beaumont' } }),
        card({ id: 'b', disposition: 'recommend', hotel: { propertyId: PID_2, name: 'Lufkin' } }),
      ],
    }))!;
    const quiet = brief.lines.find((l) => /quiet/.test(l.text));
    assert.ok(quiet, 'the brief never said how much of the portfolio was fine');
    assert.match(quiet!.text, /10 hotels quiet\./);
  });

  // Mutation: use an index or a property id. A VP translating "#7" into a
  // building is reading a database dump.
  test('a highlight names the hotel, and carries its price as a range', () => {
    const brief = buildPortfolioBrief(input({
      cards: [card({
        id: 'top',
        summary: 'Room 214 has had 4 HVAC work orders.',
        price: price(180_000, 260_000),
        hotel: { propertyId: PID_1, name: 'Beaumont' },
      })],
    }))!;
    const highlight = brief.lines.find((l) => l.findingId === 'top');
    assert.ok(highlight);
    assert.match(highlight!.text, /^Beaumont — /);
    assert.match(highlight!.text, /\$1,800–\$2,600/);
    assert.doesNotMatch(highlight!.text, /\$2,200/, 'a midpoint was rendered as if it were a price');
  });

  // Mutation: use the counted phrasing everywhere. "Across your 1 hotel" reads
  // as machine output — and a one-hotel company is a real customer (an owner
  // mid-way through buying their second).
  test('a one-hotel company reads as a sentence, not as a count', () => {
    const brief = buildPortfolioBrief(input({
      hotelCount: 1,
      run: { ...run, hotelsChecked: 1, hotelsTotal: 1 },
      cards: [card({ disposition: 'propose', hotel: { propertyId: PID_1, name: 'Beaumont' } })],
    }))!;
    assert.match(brief.lines[0].text, /^At your hotel: /);
    const last = brief.lines[brief.lines.length - 1];
    assert.match(last.text, /across your hotel\./);
    for (const l of brief.lines) {
      assert.doesNotMatch(l.text, /your 1 hotel\b/, `stilted English: ${l.text}`);
    }
  });

  // Mutation: remove the slice. Twelve hotels' worth of highlights turns the
  // brief into the queue.
  test('the line cap holds however many hotels are shouting', () => {
    const many = Array.from({ length: 40 }, (_, i) => card({
      id: `c${i}`,
      disposition: 'propose',
      price: price(100_000 + i, 200_000 + i),
      hotel: { propertyId: `p${i}`, name: `Hotel ${i}` },
    }));
    const brief = buildPortfolioBrief(input({ hotelCount: 40, cards: many }))!;
    assert.ok(brief.lines.length <= MAX_BRIEF_LINES, `brief ran to ${brief.lines.length} lines`);
  });

  // Mutation: always say "overnight". A four-day-old rollup would be reported
  // as this morning's.
  test('a stale rollup does not borrow the word "overnight" or recite its counts', () => {
    const stale = buildPortfolioBrief(input({
      run: { ...run, lastRunAt: new Date(NOW.getTime() - 5 * 86_400_000).toISOString() },
      cards: [card({ disposition: 'propose' })],
    }))!;
    const last = stale.lines[stale.lines.length - 1];
    assert.doesNotMatch(last.text, /overnight/i);
    assert.doesNotMatch(last.text, /384/);
    assert.match(last.text, /Last checked 5 days ago/);
  });

  // Mutation: hard-code "all your hotels". A company where one hotel's runner
  // died would be told everything was checked.
  test('the liveness line says how many hotels actually answered', () => {
    const partial = buildPortfolioBrief(input({ cards: [card({ disposition: 'propose' })] }))!;
    const last = partial.lines[partial.lines.length - 1];
    assert.match(last.text, /Checked 384 things overnight across 11 of your 12 hotels\./);

    const complete = buildPortfolioBrief(input({
      run: { ...run, hotelsChecked: 12 },
      cards: [card({ disposition: 'propose' })],
    }))!;
    const completeLast = complete.lines[complete.lines.length - 1];
    assert.match(completeLast.text, /across all 12 of your hotels\./);
  });

  // Mutation: hard-code "things". A company on its first night reads
  // "Checked 1 things overnight", which is the sentence that tells a reader
  // nobody looked at this screen before they did.
  test('one thing checked reads as one thing', () => {
    const one = buildPortfolioBrief(input({
      run: { ...run, thingsChecked: 1, hotelsChecked: 1, hotelsTotal: 1 },
      hotelCount: 1,
      cards: [card({ disposition: 'propose' })],
    }))!;
    const last = one.lines[one.lines.length - 1];
    assert.match(last.text, /Checked 1 thing overnight/);
    assert.doesNotMatch(last.text, /1 things/);
  });

  // THE ENGLISH-ONLY RULING, at this surface. This test used to assert the
  // opposite ("every line exists in both languages"). Mutation: put `es` back
  // on BriefLine and fill it in vp-brief.ts — the key sweep fails on every
  // line, and the Spanish-word sweep fails on the framing sentences.
  test('every line is one English sentence, with no second language', () => {
    const brief = buildPortfolioBrief(input({
      cards: [
        card({ id: 'a', disposition: 'propose', price: price(100_000, 200_000) }),
        card({ id: 'b', disposition: 'recommend', hotel: { propertyId: PID_2, name: 'Lufkin' } }),
      ],
    }))!;
    for (const l of brief.lines) {
      assert.ok(l.text.trim().length > 0, 'a line was blank');
      for (const key of Object.keys(l)) {
        assert.ok(
          key === 'text' || key === 'findingId',
          `a portfolio brief line carried an unexpected field "${key}"`,
        );
      }
    }
    const joined = brief.lines.map((l) => l.text).join(' ');
    for (const word of [
      'En tus', 'En tu hotel', 'necesitan', 'necesita tu atención',
      'hoteles tranquilos', 'hotel tranquilo', 'revisaron', 'revisó', 'anoche',
      'nada requiere', 'nada llegó',
    ]) {
      assert.ok(!joined.includes(word), `Spanish leaked into the portfolio brief: "${word}"`);
    }
  });

  // The card the brief QUOTES is still bilingual — the brief just takes its
  // English. Mutation: `cardPhrasing(card, 'es')` in highlightLine.
  test('a card with judged Spanish is still quoted in English', () => {
    const brief = buildPortfolioBrief(input({
      cards: [card({
        id: 'top',
        summary: 'Room 214 has had 4 HVAC work orders.',
        phrasedEn: 'Room 214 keeps breaking — 4 HVAC calls.',
        phrasedEs: 'La habitación 214 sigue fallando: 4 avisos de clima.',
        hotel: { propertyId: PID_1, name: 'Beaumont' },
      })],
    }))!;
    const highlight = brief.lines.find((l) => l.findingId === 'top')!;
    assert.match(highlight.text, /Room 214 keeps breaking/);
    assert.doesNotMatch(highlight.text, /sigue fallando/);
  });

  // Mutation: let the model-facing focus ids drift from the lines. A brief line
  // would jump to a card it does not describe.
  test('the focus ids are exactly the cards the brief named, in order', () => {
    const brief = buildPortfolioBrief(input({
      cards: [
        card({ id: 'big', price: price(300_000, 400_000) }),
        card({ id: 'small', price: price(10_000, 20_000) }),
      ],
    }))!;
    assert.deepEqual(brief.focusIds, ['big', 'small']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TONIGHT'S TOUR — every defect a tour agent watched happen on the live screen,
// with the mutation that reintroduces it named on each block.
// ═══════════════════════════════════════════════════════════════════════════

describe('"Open in this hotel" actually opens the hotel', () => {
  const HOTELS = [
    { propertyId: PID_1, name: 'Beaumont' },
    { propertyId: PID_2, name: 'Lufkin' },
  ];

  // THE BUG. The card's href carried `pid` and nothing read it, so the page
  // re-rendered the portfolio queue — a view that never shows that card — and
  // the button looked dead. Mutation: return `{ state: 'none' }` whenever a pid
  // is present, which is exactly what the old code did by omission.
  test('a covered hotel resolves to OPEN, carrying the name for the header', () => {
    const drill = resolveDrillDown(PID_2, HOTELS, false);
    assert.equal(drill.state, 'open');
    assert.equal(drill.state === 'open' && drill.propertyId, PID_2);
    assert.equal(drill.state === 'open' && drill.hotelName, 'Lufkin');
  });

  // Mutation: treat "not in my list" as `none` and fall through to the portfolio
  // queue. The reader taps a link and the screen silently does nothing, which is
  // indistinguishable from the bug this whole seam fixes.
  test('a hotel outside the reader’s coverage is REFUSED, never silently ignored', () => {
    const drill = resolveDrillDown('c3c3c3c3-0000-4000-8000-000000000003', HOTELS, false);
    assert.equal(drill.state, 'refused');
  });

  // Mutation: collapse `unavailable` into `refused`. A coverage read that timed
  // out would tell a VP they do not have access to their own hotel.
  test('a failed coverage read is UNAVAILABLE, which is not the same as refused', () => {
    assert.equal(resolveDrillDown(PID_1, undefined, true).state, 'unavailable');
    assert.equal(resolveDrillDown(PID_1, HOTELS, true).state, 'unavailable');
  });

  // Mutation: render the hotel queue (or the portfolio queue) while the coverage
  // read is in flight. Either one flashes and is swapped out from under the tap.
  test('an unanswered coverage read is CHECKING, so nothing is rendered yet', () => {
    assert.equal(resolveDrillDown(PID_1, undefined, false).state, 'checking');
    assert.equal(resolveDrillDown(PID_1, null, false).state, 'checking');
  });

  // ─── THE INTEGRATION SEAM (rebase onto 4c7cce62) ───────────────────────
  // The hat-access sibling landed a read-only company mode: a finance hat covers
  // every hotel her company operates and CANNOT act. /api/findings is
  // manager-gated, so a finance lead following "Open in this hotel" would fetch
  // nothing and render an empty hotel page — the blank-Staxis-tab failure that
  // sibling had just fixed on the tab itself, reappearing one link further in.
  //
  // Mutation: fold the two questions into one (treat "covers it" as "may open
  // it"), or default `canReadHotelFeed` to false. The first blanks the screen for
  // her; the second refuses every VP.
  test('a reader who covers the hotel but cannot open a hotel feed gets a sentence, not a blank page', () => {
    const drill = resolveDrillDown(PID_2, HOTELS, false, false);
    assert.equal(drill.state, 'not_your_screen');
    assert.equal(drill.state === 'not_your_screen' && drill.hotelName, 'Lufkin');
  });

  test('coverage and the manager gate stay two separate questions', () => {
    // Not covered AND not a manager → still REFUSED. Coverage is answered first
    // because it is the one that decides whether the hotel is hers at all.
    assert.equal(resolveDrillDown('c3c3c3c3-0000-4000-8000-000000000003', HOTELS, false, false).state, 'refused');
    // A failed coverage read outranks both, for the same reason: we do not know.
    assert.equal(resolveDrillDown(PID_2, HOTELS, true, false).state, 'unavailable');
    // And the default is unchanged, so every existing caller behaves as before.
    assert.equal(resolveDrillDown(PID_2, HOTELS, false).state, 'open');
  });

  test('no link followed means the ordinary screen', () => {
    assert.equal(resolveDrillDown(null, HOTELS, false).state, 'none');
    assert.equal(resolveDrillDown(null, undefined, true).state, 'none');
  });

  // Mutation: accept any string as a pid. A tenant id belongs in a request URL
  // only when it is shaped like one.
  test('only a UUID-shaped pid is read at all', () => {
    assert.equal(parsePidParam(`?pid=${PID_1}`), PID_1);
    assert.equal(parsePidParam('?pid=../../etc/passwd'), null);
    assert.equal(parsePidParam('?pid=1'), null);
    assert.equal(parsePidParam('?focus=abc'), null);
  });

  // The two halves of the link have to survive together: the card's own href is
  // what the resolver is fed.
  test('the href the card renders resolves to the hotel it names', () => {
    const href = drillDownHref(card())!;
    const search = href.slice(href.indexOf('?'));
    assert.equal(parsePidParam(search), PID_1);
    assert.equal(resolveDrillDown(parsePidParam(search), HOTELS, false).state, 'open');
  });
});

describe('the VP queue does not print GM tap-state', () => {
  // The founder's rule at the top of vp-queue.ts, as a test rather than a
  // comment. Mutation: drop `hideOccurrence` from PortfolioQueueBody. "Seen 6
  // times since Jul 9" reappears on a boss's screen, where it reads as six
  // people looking at a $3,100 problem and doing nothing.
  test('the portfolio screen asks the card list to suppress the "Seen N times" line', () => {
    const view = readFileSync(
      resolve(process.cwd(), 'src/components/concourse/PortfolioQueueView.tsx'),
      'utf8',
    );
    assert.match(view, /hideOccurrence/);
  });

  // …and the suppression is a real switch, not a rename: the line still exists
  // for the HOTEL feed, where a manager's own re-sighting count is theirs.
  test('the occurrence line is still produced for a hotel’s own feed', () => {
    const f = queueCard({ occurrenceCount: 6, firstSeenAt: '2026-07-09T00:00:00.000Z' });
    assert.match(String(occurrenceLine(f, 'en', NOW)), /Seen 6 times/);
  });
});

describe('money is printed one way', () => {
  // THE BUG, on one card, a centimetre apart: "$750-$1750" inside the sentence
  // and "$750–$1,750" in the price chip. Mutation: give any surface its own
  // formatter again.
  test('every surface renders the same range identically', () => {
    const p = { lowCents: 75_000, highCents: 175_000, currency: 'USD', basis: 'b' };
    const chip = formatPriceRange(p)!;
    assert.equal(chip, '$750–$1,750');
    assert.equal(formatMoneyRange(p.lowCents, p.highCents, p.currency), chip);
    assert.match(templatePriceSentence(p, 'en'), /Estimated cost: \$750–\$1,750\./);
    assert.match(templatePriceSentence(p, 'es'), /Costo estimado: \$750–\$1,750\./);
  });

  // Mutation: use a hyphen anywhere. "$200-400" reads as a phone number, and
  // two dashes on one screen read as two different systems talking.
  test('a statistical band uses the same dash as a stored price', () => {
    assert.equal(formatCentsBand({ low: 70_000, high: 210_000 }), '$700–$2,100');
    assert.ok(formatCentsBand({ low: 70_000, high: 210_000 }).includes('–'));
  });

  // ═══ "$1,203–$1,203" IS A POINT ESTIMATE WEARING A DASH ═══
  // `formatCents` rounds to whole dollars, so a band narrower than a dollar
  // printed the same figure twice — inside a basis line whose entire job is to
  // show the reader a spread. It is the $340 bug with extra punctuation.
  //
  // MUTATION PROOF: remove the collapse branch and the first assertion prints
  // "$1,203–$1,203".
  test('a band whose ends round to the same dollar says "about", never a fake range', () => {
    const collapsed = formatCentsBand({ low: 120_301, high: 120_349 });
    assert.equal(collapsed, 'about $1,203');
    assert.ok(!collapsed.includes('–'), 'a dash here would claim a spread we do not have');
    // Spanish gets the same treatment, in Spanish.
    assert.equal(formatCentsBandEs({ low: 120_301, high: 120_349 }), 'unos $1,203');
    // And a band that IS a range is untouched in both languages.
    assert.equal(formatCentsBand({ low: 70_000, high: 210_000 }), '$700–$2,100');
    assert.equal(formatCentsBandEs({ low: 70_000, high: 210_000 }), '$700–$2,100');
  });

  // The other half of the same promise: a STORED price is never approximate, so
  // the collapse rule must not have loosened the schema-level refusal.
  test('the prose hedge did not soften what may be stored as a price', () => {
    assert.equal(toPriceRange({ low: 120_301, high: 120_349 }, 'b')?.lowCents !== undefined, true);
    assert.equal(toPriceRange({ low: 120_301, high: 120_301 }, 'b'), null);
    assert.equal(formatPriceRange({ lowCents: 120_300, highCents: 120_300, currency: 'USD', basis: 'b' }), null);
  });

  // Mutation: drop the thousands separator, which is how "$1750" got on screen.
  test('thousands are separated and cents appear only when there are any', () => {
    assert.equal(formatMoney(175_000), '$1,750');
    assert.equal(formatMoney(175_050), '$1,750.50');
    assert.equal(formatMoney(100_000_00), '$100,000');
  });

  // Mutation: format a degenerate or inverted range instead of refusing it. The
  // refusal is the card's rule and must survive the formatter being shared.
  test('an unusable range is still refused rather than formatted', () => {
    assert.equal(formatPriceRange({ lowCents: 200, highCents: 200, currency: 'USD', basis: 'b' }), null);
    assert.equal(formatPriceRange({ lowCents: 400, highCents: 200, currency: 'USD', basis: 'b' }), null);
    assert.equal(templatePriceSentence({ lowCents: 200, highCents: 200, currency: 'USD' }, 'en'), '');
  });
});

/** A hotel with a real, named activity stream that has gone quiet. Uses a
 *  PRODUCTION stream id (see feeds.ts) so the Spanish label path is genuinely
 *  exercised rather than skipped. */
function stoppedHotel(name: string, silentDays: number): PortfolioHotel {
  const dates: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    const at = new Date(Date.UTC(2026, 6, 26) - (silentDays + i) * 86_400_000);
    dates.push(at.toISOString().slice(0, 10));
  }
  return {
    propertyId: `${name.toLowerCase()}-id`,
    name,
    businessDate: '2026-07-26',
    supplySpend: null,
    rhythm: {
      streams: [{
        id: 'daily_log_closings',
        label: 'recording the daily numbers',
        dates: dates.sort(),
        worthCentsSamples: [],
        worthBasis: null,
      }],
      coverageStartDate: '2026-04-01',
      windowDays: 98,
    },
  };
}

describe('a Spanish reader gets Spanish', () => {
  // THE BUG: "según your other hotels spent $700-$2,100 that week" — a Spanish
  // label bolted onto an English sentence, on the only screen a company card
  // ever appears on. Mutation: return the English basis in Spanish.
  test('a basis with a Spanish rendering is preferred in Spanish', () => {
    assert.equal(
      basisInLang('your other hotels spent $700–$2,100 that week', 'tus otros hoteles gastaron $700–$2,100 esa semana', 'es'),
      'tus otros hoteles gastaron $700–$2,100 esa semana',
    );
  });

  // Mutation: render nothing when there is no Spanish. "A price is a RANGE with
  // its basis or it is not mentioned" is the older promise, and a basis nobody
  // can read is a smaller failure than a dollar figure with no receipt.
  test('an English-only basis still shows rather than dropping the receipt', () => {
    assert.equal(basisInLang('your last 3 plumber invoices', null, 'es'), 'your last 3 plumber invoices');
    assert.equal(basisInLang('', '', 'es'), null);
  });

  // Mutation: leave `portfolioSpanish` unwired. Every company card is English.
  test('the supply-spend card has a whole Spanish rendering built from its receipt', () => {
    const drafts = supplySpendGapDetector.detect({
      organizationId: ORG_A,
      hotels: [
        spendHotel('Beaumont', 70_000),
        spendHotel('Lufkin', 210_000),
        spendHotel('Tyler', 90_000),
      ],
      now: NOW,
    });
    assert.equal(drafts.length, 1);
    const es = portfolioSpanish(supplySpendGapDetector.id, drafts[0].evidence)!;
    assert.ok(es, 'no Spanish rendering at all');
    assert.ok(!/hotels|spent|side by side|outlier/i.test(es.summary), `still English: ${es.summary}`);
    assert.match(es.summary, /Lufkin/);
    assert.match(es.summary, /\$2,100/);
    assert.ok(!/spent/i.test(String(es.priceBasis)), `price basis still English: ${es.priceBasis}`);
    assert.match(String(es.basis), /de esta empresa con registros de entregas/);
  });

  // Mutation: translate the activity label with a fallback that leaves the
  // English word in place ("dejaron de recording the daily numbers").
  test('the stopped-activity card is Spanish or is left alone entirely', () => {
    const stopped = portfolioActivityStoppedDetector.detect({
      organizationId: ORG_A,
      hotels: [stoppedHotel('Beaumont', 30), stoppedHotel('Lufkin', 30)],
      now: NOW,
    });
    assert.ok(stopped.length > 0, 'the fixture did not trigger the detector');
    const es = portfolioSpanish(portfolioActivityStoppedDetector.id, stopped[0].evidence)!;
    assert.ok(es, 'a production stream id must have a Spanish label');
    assert.ok(!/stopped|recording|logging|counting/i.test(es.summary), `mixed: ${es.summary}`);
    assert.match(es.summary, /dejaron de registrar los números diarios/);
    assert.match(es.summary, /Beaumont/);
    // An unknown stream produces NOTHING rather than a half-translated sentence.
    assert.equal(
      portfolioSpanish(portfolioActivityStoppedDetector.id, {
        params: { stream: 'something_new' },
        values: { per_hotel: { Beaumont: { days_silent: 4 } } },
      }),
      null,
    );
  });
});

describe('one problem, one portfolio card', () => {
  // THE BUG, live: the key was `supply_spend:<top hotel id>`, so the week the
  // leader changed a SECOND card opened while the stale one sat there for its
  // full 10-day staleness — two cards naming two different hotels as the
  // company's high spender. Mutation: put any measurement back in the key.
  test('the supply-spend key does not move when the top spender does', () => {
    const first = supplySpendGapDetector.detect({
      organizationId: ORG_A,
      hotels: [spendHotel('Beaumont', 70_000), spendHotel('Lufkin', 210_000)],
      now: NOW,
    });
    const second = supplySpendGapDetector.detect({
      organizationId: ORG_A,
      hotels: [spendHotel('Beaumont', 260_000), spendHotel('Lufkin', 70_000)],
      now: NOW,
    });
    assert.equal(first[0].key, second[0].key);
    // …and WHICH hotel it is still travels, in the sentence and the receipt, so
    // nothing was lost by taking it out of the identity.
    assert.match(first[0].summary, /Lufkin/);
    assert.match(second[0].summary, /Beaumont/);
    assert.equal(first[0].evidence.values.top_hotel, 'Lufkin');
    assert.equal(second[0].evidence.values.top_hotel, 'Beaumont');
    // The summary moving is what flips the row to `updated` (evidenceMoved).
    assert.notEqual(first[0].summary, second[0].summary);
  });

  // THE AUDIT, as a standing test. Mutation: a new portfolio check keyed on
  // "whichever hotel is worst" would pass review and fail here.
  test('NO portfolio check embeds a hotel id in its dedupe key', () => {
    const hotels = [
      spendHotel('Beaumont', 70_000),
      spendHotel('Lufkin', 210_000),
      spendHotel('Tyler', 90_000),
    ].map((h) => ({ ...h, rhythm: stoppedHotel(h.name, 30).rhythm }));
    const ids = new Set(hotels.map((h) => h.propertyId));
    for (const detector of PORTFOLIO_DETECTORS) {
      for (const draft of detector.detect({ organizationId: ORG_A, hotels, now: NOW })) {
        for (const id of ids) {
          assert.ok(
            !draft.key.includes(id),
            `${detector.id} keyed its card on a hotel id (${draft.key}) — a re-find at a `
            + 'different hotel opens a SECOND card and the stale one lives on',
          );
        }
      }
    }
  });
});

describe('the brief and the chips agree about "quiet"', () => {
  const run = {
    thingsChecked: 384, hotelsChecked: 3, hotelsTotal: 3,
    lastRunAt: '2026-07-26T06:00:00.000Z',
  };
  const briefInput = (over: Partial<Parameters<typeof buildPortfolioBrief>[0]> = {}) => ({
    organizationId: ORG_A,
    localDate: '2026-07-26',
    hotelCount: 3,
    cards: [] as PortfolioCard[],
    run,
    now: NOW,
    ...over,
  });

  // THE BUG: the command centre chip said "2 WAITING" on a hotel and the brief,
  // one tap away, counted it among "3 hotels quiet". Mutation: drop
  // `busyHotelIds` from quietHotelCount.
  test('a hotel the chip calls busy is never counted quiet', () => {
    const brief = buildPortfolioBrief(briefInput({
      cards: [card({ hotel: { propertyId: PID_1, name: 'Beaumont' } })],
      busyHotelIds: [PID_2],
    }))!;
    const quietLine = brief.lines.find((l) => /quiet/.test(l.text));
    // 3 hotels, one with a card, one busy by chip → at most one may be quiet.
    assert.match(String(quietLine?.text), /^1 hotel quiet\./);
  });

  // Mutation: keep the old "nothing needs a decision this morning" whenever the
  // card list is empty. That sentence over a picker showing "2 WAITING" is the
  // contradiction the reader actually saw.
  test('no climbed cards but a busy hotel is not a quiet morning', () => {
    const brief = buildPortfolioBrief(briefInput({ busyHotelIds: [PID_1, PID_2] }))!;
    assert.equal(brief.kind, 'report');
    assert.match(brief.lines[0].text, /nothing has reached you, but 2 hotels have something waiting/);
  });

  // …and a genuinely quiet company still gets the quiet morning. Mutation:
  // always take the busy branch, and a company with nothing wrong is told two
  // hotels are working.
  test('nothing anywhere is still a quiet morning', () => {
    const brief = buildPortfolioBrief(briefInput({ busyHotelIds: [] }))!;
    assert.equal(brief.kind, 'quiet');
    assert.match(brief.lines[0].text, /nothing needs a decision this morning/);
  });

  // The chip's own rule, as the predicate both surfaces now share. Mutation:
  // drop any of the three terms and one screen starts disagreeing with the other.
  test('any of climbed, critical or waiting counts as live work', () => {
    assert.equal(hotelHasLiveWork({ climbedCount: 0, waitingCount: 0, criticalCount: 0 }), false);
    assert.equal(hotelHasLiveWork({ climbedCount: 1, waitingCount: 0, criticalCount: 0 }), true);
    assert.equal(hotelHasLiveWork({ climbedCount: 0, waitingCount: 2, criticalCount: 0 }), true);
    assert.equal(hotelHasLiveWork({ climbedCount: 0, waitingCount: 0, criticalCount: 1 }), true);
  });
});
