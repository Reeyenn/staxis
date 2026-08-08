/**
 * The decisions a findings card makes before any pixel is drawn: what order
 * the cards go in, how many get the manager's attention, what the money line
 * says, and — the one that matters most — whether the screen is entitled to
 * claim anything about having checked.
 *
 * These are unit tests of pure functions on purpose. Every one of them
 * corresponds to a way the screen could lie to a manager:
 *
 *   • rank a $40 card above a $4,000 one            → ordering
 *   • render "$300" for a "$200–400" range          → price formatting
 *   • say "everything looked normal" after a week   → liveness staleness
 *   • say it at all on a hotel that was never run   → liveness 'never'
 *   • render a question as a card                   → disposition filtering
 *   • hide a finding instead of folding it          → cap split
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  DAILY_CARD_CAP,
  RUN_FRESH_HOURS,
  cardEyebrowLabel,
  cardPhrasing,
  closureButtons,
  dataAgeNote,
  distinctDetectors,
  effectiveDisposition,
  formatPriceRange,
  isCardRenderable,
  livenessLine,
  occurrenceLine,
  rankFindings,
  severityChipClass,
  skippedNote,
  sortValueCents,
  splitByCap,
  type QueueFinding,
  type QueueRun,
  MENU_EDGE_MARGIN,
  MENU_GAP,
  menuPlacementIsOnScreen,
  placeCardMenu,
} from '@/components/concourse/finding-cards';

const NOW = new Date('2026-07-25T15:00:00.000Z');

function finding(over: Partial<QueueFinding> & { id: string }): QueueFinding {
  return {
    detectorId: 'det_a',
    dedupeKey: `det_a:${over.id}`,
    summary: 'Something is off.',
    phrasedEn: null,
    phrasedEs: null,
    severity: 'attention',
    disposition: 'recommend',
    status: 'open',
    magnitude: 1,
    price: null,
    evidence: { queryId: 'q', params: {}, values: {}, basis: 'basis line' },
    asOf: null,
    weakestInputAgeDays: null,
    firstSeenAt: '2026-07-12T06:00:00.000Z',
    lastSeenAt: '2026-07-25T06:00:00.000Z',
    occurrenceCount: 1,
    ...over,
  };
}

function usd(lowDollars: number, highDollars: number, basis = 'your last 3 plumber invoices'): QueueFinding['price'] {
  return { lowCents: lowDollars * 100, highCents: highDollars * 100, currency: 'USD', basis };
}

// ─── Ordering ───────────────────────────────────────────────────────────────

describe('ranking: biggest dollars first, then first come first served', () => {
  test('a bigger range midpoint outranks a smaller one regardless of input order', () => {
    const small = finding({ id: 'small', price: usd(40, 60) });
    const big = finding({ id: 'big', price: usd(3000, 5000) });
    const mid = finding({ id: 'mid', price: usd(200, 400) });

    assert.deepEqual(rankFindings([small, big, mid]).map((f) => f.id), ['big', 'mid', 'small']);
    assert.deepEqual(rankFindings([mid, small, big]).map((f) => f.id), ['big', 'mid', 'small']);
  });

  test('a range whose midpoint is larger wins even when its LOW end is smaller', () => {
    // $100–900 (mid 500) must beat $400–500 (mid 450). A sort on `low` would
    // get this backwards, and a sort on `high` would get the reverse case
    // backwards; only the midpoint orders both correctly.
    const wide = finding({ id: 'wide', price: usd(100, 900) });
    const tight = finding({ id: 'tight', price: usd(400, 500) });
    assert.deepEqual(rankFindings([tight, wide]).map((f) => f.id), ['wide', 'tight']);
  });

  test('anything priced outranks anything unpriced, even a critical one', () => {
    const unpricedCritical = finding({ id: 'nocost', severity: 'critical', price: null });
    const pricedInfo = finding({ id: 'cheap', severity: 'info', price: usd(10, 20) });
    assert.deepEqual(
      rankFindings([unpricedCritical, pricedInfo]).map((f) => f.id),
      ['cheap', 'nocost'],
    );
  });

  test('unpriced findings go in arrival order — oldest first, severity gets no vote', () => {
    // FIRST COME, FIRST SERVED. Severity is stacked deliberately AGAINST the
    // expected answer: the newest card is the critical one and the oldest is
    // the info one, so restoring a severity tiebreak reverses this list.
    const oldest = finding({ id: 'waited', severity: 'info', firstSeenAt: '2026-07-10T06:00:00.000Z' });
    const middle = finding({ id: 'wednesday', severity: 'attention', firstSeenAt: '2026-07-18T06:00:00.000Z' });
    const newest = finding({ id: 'fresh', severity: 'critical', firstSeenAt: '2026-07-25T06:00:00.000Z' });
    assert.deepEqual(
      rankFindings([newest, middle, oldest]).map((f) => f.id),
      ['waited', 'wednesday', 'fresh'],
    );
    assert.deepEqual(
      rankFindings([oldest, newest, middle]).map((f) => f.id),
      ['waited', 'wednesday', 'fresh'],
    );
  });

  test('two cards worth the same money go in arrival order, not by severity', () => {
    // $200–400 and $100–500 have the SAME midpoint, so the money says nothing
    // and the queue falls back to who got here first. The louder card is the
    // later one on purpose.
    const waited = finding({
      id: 'waited', severity: 'info', price: usd(200, 400),
      firstSeenAt: '2026-07-11T06:00:00.000Z',
    });
    const justIn = finding({
      id: 'justin', severity: 'critical', price: usd(100, 500),
      firstSeenAt: '2026-07-24T06:00:00.000Z',
    });
    assert.deepEqual(rankFindings([justIn, waited]).map((f) => f.id), ['waited', 'justin']);
    assert.deepEqual(rankFindings([waited, justIn]).map((f) => f.id), ['waited', 'justin']);
  });

  test('a card that arrived first still loses to one with more money on it', () => {
    // Arrival order is the TIEBREAK, not the rule. Dollars still lead.
    const oldCheap = finding({ id: 'old', price: usd(40, 60), firstSeenAt: '2026-07-01T06:00:00.000Z' });
    const newRich = finding({ id: 'new', price: usd(3000, 5000), firstSeenAt: '2026-07-25T06:00:00.000Z' });
    assert.deepEqual(rankFindings([oldCheap, newRich]).map((f) => f.id), ['new', 'old']);
  });

  test('magnitude breaks a tie between two findings that landed in the same instant', () => {
    // Same price (none) and the same first-seen timestamp, so arrival order
    // cannot separate them. The dedupe keys are deliberately ordered AGAINST
    // the expected result, so the alphabetical last-resort tiebreak cannot
    // produce this answer on its own — only magnitude can.
    const sameInstant = '2026-07-12T06:00:00.000Z';
    const smallMag = finding({ id: 'sm', magnitude: 2, dedupeKey: 'det_a:aaa', firstSeenAt: sameInstant });
    const bigMag = finding({ id: 'bg', magnitude: 9, dedupeKey: 'det_a:zzz', firstSeenAt: sameInstant });
    assert.deepEqual(rankFindings([smallMag, bigMag]).map((f) => f.id), ['bg', 'sm']);
    assert.deepEqual(rankFindings([bigMag, smallMag]).map((f) => f.id), ['bg', 'sm']);
  });

  test('a card with no readable arrival time sorts last, never first', () => {
    // "We don't know when this showed up" must not be read as "it has been
    // waiting longest", and it must not produce a random order either.
    const dated = finding({ id: 'dated', firstSeenAt: '2026-07-20T06:00:00.000Z' });
    const undated = finding({ id: 'undated', firstSeenAt: 'not-a-date' });
    assert.deepEqual(rankFindings([undated, dated]).map((f) => f.id), ['dated', 'undated']);
    assert.deepEqual(rankFindings([dated, undated]).map((f) => f.id), ['dated', 'undated']);
  });

  test('a fully-tied pair comes back in the same order every time', () => {
    // A list that reshuffles between two identical loads teaches a manager
    // that position means nothing, which defeats ranking entirely.
    const a = finding({ id: 'one', dedupeKey: 'det_a:aaa', magnitude: 4 });
    const b = finding({ id: 'two', dedupeKey: 'det_a:bbb', magnitude: 4 });
    assert.deepEqual(rankFindings([a, b]).map((f) => f.id), ['one', 'two']);
    assert.deepEqual(rankFindings([b, a]).map((f) => f.id), ['one', 'two']);
  });

  test('ranking does not mutate the caller’s array', () => {
    const list = [finding({ id: 'x', price: usd(1, 2) }), finding({ id: 'y', price: usd(100, 200) })];
    rankFindings(list);
    assert.deepEqual(list.map((f) => f.id), ['x', 'y']);
  });

  test('the midpoint is a SORT key only — it is derived, never a stored figure', () => {
    assert.equal(sortValueCents(finding({ id: 'p', price: usd(200, 400) })), 30_000);
    assert.equal(sortValueCents(finding({ id: 'n', price: null })), null);
  });
});

// ─── The attention cap ──────────────────────────────────────────────────────

describe('the daily cap folds, it never drops', () => {
  const many = Array.from({ length: 9 }, (_, i) =>
    finding({ id: `f${i}`, price: usd(1000 - i * 10, 1100 - i * 10) }),
  );

  test('the first cap-many are prominent and the remainder is still there', () => {
    const split = splitByCap(rankFindings(many), DAILY_CARD_CAP);
    assert.equal(split.prominent.length, DAILY_CARD_CAP);
    assert.equal(split.folded.length, 9 - DAILY_CARD_CAP);
    assert.equal(split.prominent.length + split.folded.length, 9, 'a finding was dropped');
  });

  test('the fold keeps the ranked order — the loudest are the ones on top', () => {
    const ranked = rankFindings(many);
    const split = splitByCap(ranked, 3);
    assert.deepEqual(split.prominent.map((f) => f.id), ranked.slice(0, 3).map((f) => f.id));
    assert.deepEqual(split.folded.map((f) => f.id), ranked.slice(3).map((f) => f.id));
  });

  test('fewer findings than the cap means nothing is folded', () => {
    const split = splitByCap(rankFindings(many.slice(0, 2)), DAILY_CARD_CAP);
    assert.equal(split.folded.length, 0);
  });

  test('a nonsense cap degrades to folding everything, never to hiding it', () => {
    const split = splitByCap(many, -4);
    assert.equal(split.prominent.length, 0);
    assert.equal(split.folded.length, 9);
  });
});

// ─── Money ──────────────────────────────────────────────────────────────────

describe('a price is a range with a basis, or it is nothing', () => {
  test('a range renders as a range', () => {
    assert.equal(formatPriceRange(usd(200, 400)), '$200–$400');
  });

  test('no price renders nothing rather than a zero or a guess', () => {
    assert.equal(formatPriceRange(null), null);
    assert.equal(formatPriceRange(undefined), null);
  });

  test('a degenerate range is refused — "$200–200" is "$200" with extra steps', () => {
    assert.equal(formatPriceRange({ lowCents: 20_000, highCents: 20_000, currency: 'USD', basis: 'x' }), null);
  });

  test('an inverted or negative range is refused rather than silently reordered', () => {
    assert.equal(formatPriceRange({ lowCents: 40_000, highCents: 20_000, currency: 'USD', basis: 'x' }), null);
    assert.equal(formatPriceRange({ lowCents: -100, highCents: 20_000, currency: 'USD', basis: 'x' }), null);
  });

  test('cents survive when they are not round', () => {
    assert.equal(
      formatPriceRange({ lowCents: 12_345, highCents: 67_890, currency: 'USD', basis: 'x' }),
      '$123.45–$678.90',
    );
  });

  test('a non-dollar currency is labelled rather than assumed to be dollars', () => {
    assert.equal(
      formatPriceRange({ lowCents: 10_000, highCents: 20_000, currency: 'GBP', basis: 'x' }),
      'GBP 100–GBP 200',
    );
  });
});

// ─── Which findings become cards ────────────────────────────────────────────

describe('a question is not a card', () => {
  test("an 'ask' finding is not renderable here — the drip-question card owns questions", () => {
    assert.equal(isCardRenderable(finding({ id: 'q', disposition: 'ask' })), false);
  });

  test("a 'drop' finding is kept for audit and never shown", () => {
    assert.equal(isCardRenderable(finding({ id: 'd', disposition: 'drop' })), false);
  });

  test('propose, recommend and fyi all render', () => {
    for (const disposition of ['propose', 'recommend', 'fyi'] as const) {
      assert.equal(isCardRenderable(finding({ id: disposition, disposition })), true);
    }
  });

  // The judge is the only thing that ever reaches 'ask' or 'drop'. Reading the
  // DETECTOR's default here meant a finding the judge turned into a question
  // rendered as a card as well — two surfaces asking the same thing with
  // different rules, which is the exact duplication the split exists to stop.
  test("the judge's verdict wins: a judged-'ask' finding is not a card, whatever its detector said", () => {
    assert.equal(
      effectiveDisposition({ disposition: 'recommend', judgedDisposition: 'ask' }),
      'ask',
    );
    assert.equal(
      isCardRenderable({
        disposition: effectiveDisposition({ disposition: 'recommend', judgedDisposition: 'ask' }),
      }),
      false,
    );
  });

  test('with no judgement, the detector\'s own verdict still governs — a card never goes blank waiting for a model', () => {
    assert.equal(effectiveDisposition({ disposition: 'propose', judgedDisposition: null }), 'propose');
    assert.equal(effectiveDisposition({ disposition: 'fyi' }), 'fyi');
  });

  test('severity picks a distinct chip so the three tiers are not one colour', () => {
    const chips = new Set(
      (['critical', 'attention', 'info'] as const).map(severityChipClass),
    );
    assert.equal(chips.size, 3);
  });
});

// ─── Closure ────────────────────────────────────────────────────────────────

describe('every card can be put down, and the ways of putting it down differ', () => {
  const labels = (disposition: QueueFinding['disposition'], lang: 'en' | 'es' = 'en') =>
    closureButtons({ disposition }, lang).map((b) => b.label);
  const verdicts = (disposition: QueueFinding['disposition']) =>
    closureButtons({ disposition }, 'en').map((b) => b.verdict);

  test('a "worth doing" card offers exactly three closures, and three different ones', () => {
    // The whole feature. Before this, a recommendation had no way to end: it
    // sat there after the manager had already called the repair guy, and the
    // demotion counters read that as a hotel that ignores the check.
    assert.deepEqual(labels('recommend'), ['Handled it', 'Seen', 'Not doing this']);
    assert.deepEqual(verdicts('recommend'), ['resolved', 'known_problem', 'muted']);
    assert.equal(new Set(verdicts('recommend')).size, 3, 'two buttons send the same verdict');
  });

  test('"Seen" is known_problem — it never becomes the button that says it was handled', () => {
    // THE PIN. "I know, stop showing me" is not "it is fixed". The day these
    // two collapse into one verdict is the day Staxis starts telling an owner
    // that a problem is over because a manager wanted quiet.
    const seen = closureButtons({ disposition: 'recommend' }, 'en').find((b) => b.label === 'Seen');
    assert.ok(seen, 'the Seen button vanished');
    assert.equal(seen!.verdict, 'known_problem');
    assert.notEqual(seen!.verdict as string, 'resolved');

    const handled = closureButtons({ disposition: 'recommend' }, 'en')
      .find((b) => b.label === 'Handled it');
    assert.equal(handled!.verdict, 'resolved');
  });

  test('only the unconditional verdict asks a second time', () => {
    const rec = closureButtons({ disposition: 'recommend' }, 'en');
    const asks = rec.filter((b) => b.confirm !== null).map((b) => b.verdict);
    assert.deepEqual(asks, ['muted'], 'the confirm step moved to the wrong button');
    const mute = rec.find((b) => b.verdict === 'muted')!;
    assert.equal(mute.confirm!.prompt, 'Staxis will stop watching this. Sure?');
    assert.ok(mute.confirm!.yes.length > 0);
    // Handled and Seen are recoverable — a problem that recurs comes back, and
    // an escalating one pierces the silence — so neither may grow a dialog.
    assert.equal(rec.find((b) => b.verdict === 'resolved')!.confirm, null);
    assert.equal(rec.find((b) => b.verdict === 'known_problem')!.confirm, null);
  });

  test('a proposal keeps the buttons it always had', () => {
    // Guards the accidental blast radius: this change was meant to touch
    // recommendations only, and a proposal that suddenly says "Handled it"
    // would be a different screen than the one that was signed off.
    assert.deepEqual(labels('propose'), ['Known problem', 'Fixed', 'Mute']);
    assert.deepEqual(verdicts('propose'), ['known_problem', 'resolved', 'muted']);
    assert.deepEqual(
      closureButtons({ disposition: 'propose' }, 'en')
        .filter((b) => b.confirm).map((b) => b.confirm!.yes),
      ['Yes, mute it'],
    );
  });

  test('an FYI still has exactly one quiet way out and nothing that wants a decision', () => {
    const fyi = closureButtons({ disposition: 'fyi' }, 'en');
    assert.deepEqual(fyi.map((b) => b.label), ['Got it']);
    assert.equal(fyi[0].verdict, 'known_problem');
    assert.equal(fyi[0].confirm, null);
    assert.ok(!fyi.some((b) => b.verdict === 'resolved'), 'an FYI grew a "fixed" button');
  });

  test('a question and a dropped finding offer nothing — they are never cards', () => {
    assert.deepEqual(closureButtons({ disposition: 'ask' }, 'en'), []);
    assert.deepEqual(closureButtons({ disposition: 'drop' }, 'en'), []);
  });

  test('one button leads, the irreversible one is the loud-red one', () => {
    for (const disposition of ['propose', 'recommend'] as const) {
      const set = closureButtons({ disposition }, 'en');
      assert.equal(
        set.filter((b) => b.tone === 'primary').length,
        1,
        `${disposition} has no single lead button`,
      );
      assert.equal(set.find((b) => b.verdict === 'muted')!.tone, 'danger', disposition);
    }
    // A "worth doing" card leads with the outcome it is asking for.
    assert.equal(
      closureButtons({ disposition: 'recommend' }, 'en').find((b) => b.tone === 'primary')!.verdict,
      'resolved',
    );
  });

  test('legacy language input cannot re-enable localized product buttons', () => {
    for (const disposition of ['propose', 'recommend', 'fyi'] as const) {
      const en = closureButtons({ disposition }, 'en');
      const es = closureButtons({ disposition }, 'es');
      assert.equal(en.length, es.length, disposition);
      for (let i = 0; i < en.length; i += 1) {
        assert.equal(es[i].label, en[i].label, `${disposition}[${i}] changed with legacy locale`);
        assert.equal(es[i].verdict, en[i].verdict, 'legacy locale changed the verdict');
        if (en[i].hint) assert.equal(es[i].hint, en[i].hint, `${disposition}[${i}] hint`);
        if (en[i].confirm) {
          assert.equal(es[i].confirm!.prompt, en[i].confirm!.prompt);
          assert.equal(es[i].confirm!.yes, en[i].confirm!.yes);
        }
      }
    }
  });

  test('a judge demoting a proposal hands the card the recommendation buttons', () => {
    // /api/findings puts the EFFECTIVE disposition on the card, so a proposal
    // the judge decided is only worth recommending loses its one-tap fix AND
    // gains the closures that fit what it became — from one verdict, together.
    const demoted = effectiveDisposition({ disposition: 'propose', judgedDisposition: 'recommend' });
    assert.deepEqual(labels(demoted), ['Handled it', 'Seen', 'Not doing this']);
  });

  test('the Seen hint promises quiet with an exception, not silence forever', () => {
    // The escalation machinery is what makes this sentence true (silencer.ts:
    // consent at 4 work orders is not consent at 9). If the words stop
    // mentioning the exception, a manager reads a promise Staxis does not keep.
    const seen = closureButtons({ disposition: 'recommend' }, 'en')
      .find((b) => b.verdict === 'known_problem')!;
    assert.match(String(seen.hint), /unless it gets meaningfully worse/);
    assert.equal(
      seen.hint,
      closureButtons({ disposition: 'propose' }, 'en')
        .find((b) => b.verdict === 'known_problem')!.hint,
      'the same verdict promises two different things on two cards',
    );
  });
});

// ─── The eyebrow ────────────────────────────────────────────────────────────

describe('"needs a decision" means the badge is counting it', () => {
  test('a critical card with nothing to answer says URGENT, not NEEDS A DECISION', () => {
    // The mutation this guards: keying the eyebrow on severity again. The nav
    // badge counts `propose` findings and calls them decisions; a recommendation
    // that shouts "NEEDS A DECISION" makes a badge of 1 sit above three cards
    // all claiming to want an answer.
    const loudButNoQuestion = finding({ id: 'u', severity: 'critical', disposition: 'recommend' });
    assert.equal(cardEyebrowLabel(loudButNoQuestion, 'en'), 'URGENT');
    assert.equal(cardEyebrowLabel(loudButNoQuestion, 'es'), 'URGENT');
  });

  test('a propose card says NEEDS A DECISION whatever its severity', () => {
    // The mutation this guards in the other direction: a card Staxis is
    // actually asking about losing the words that say so.
    for (const severity of ['critical', 'attention', 'info'] as const) {
      const asking = finding({ id: `p_${severity}`, severity, disposition: 'propose' });
      assert.equal(cardEyebrowLabel(asking, 'en'), 'NEEDS A DECISION', severity);
      assert.equal(cardEyebrowLabel(asking, 'es'), 'NEEDS A DECISION', severity);
    }
  });

  test('the quieter tiers still read the way they always did', () => {
    assert.equal(
      cardEyebrowLabel(finding({ id: 'a', severity: 'attention', disposition: 'recommend' }), 'en'),
      'WORTH A LOOK',
    );
    assert.equal(
      cardEyebrowLabel(finding({ id: 'i', severity: 'info', disposition: 'fyi' }), 'en'),
      'FOR YOUR INFORMATION',
    );
    assert.equal(
      cardEyebrowLabel(finding({ id: 'i2', severity: 'info', disposition: 'fyi' }), 'es'),
      'FOR YOUR INFORMATION',
    );
  });

  test('a judge demoting a proposal takes the decision wording with it', () => {
    // /api/findings puts the EFFECTIVE disposition on the card, so the eyebrow
    // and the approve button are governed by the same verdict: the judge can
    // take both away, and it takes them away together.
    const demoted = effectiveDisposition({ disposition: 'propose', judgedDisposition: 'recommend' });
    assert.equal(
      cardEyebrowLabel(finding({ id: 'd', severity: 'critical', disposition: demoted }), 'en'),
      'URGENT',
    );
  });
});

// ─── Phrasing ───────────────────────────────────────────────────────────────

describe('judged phrasing when it exists, the detector’s own sentence when it does not', () => {
  test('the judge’s English wording wins regardless of legacy language input', () => {
    const f = finding({
      id: 'p',
      summary: 'raw template sentence',
      phrasedEn: 'Room 214 has eaten four HVAC visits this month.',
      phrasedEs: 'La 214 lleva cuatro visitas de aire este mes.',
    });
    assert.equal(cardPhrasing(f, 'en'), 'Room 214 has eaten four HVAC visits this month.');
    assert.equal(cardPhrasing(f, 'es'), 'Room 214 has eaten four HVAC visits this month.');
  });

  test('an absent judge leaves a card that still says something true', () => {
    const f = finding({ id: 'p', summary: 'raw template sentence' });
    assert.equal(cardPhrasing(f, 'en'), 'raw template sentence');
  });

  test('legacy language input still uses the truthful English detector sentence', () => {
    const f = finding({
      id: 'p',
      summary: 'Room 231 has had 4 work orders in the last 30 days.',
      evidence: {
        queryId: 'q',
        params: { location: 'Room 231' },
        values: {},
        basis: 'b',
      },
    });
    const es = cardPhrasing(f, 'es');
    assert.equal(es, f.summary);
  });

  test('a judge that phrased only English does not leave the Spanish card blank', () => {
    const f = finding({ id: 'p', summary: 'raw template sentence', phrasedEn: 'English wording' });
    const es = cardPhrasing(f, 'es');
    assert.ok(es.trim().length > 0);
    assert.notEqual(es, 'raw template sentence');
  });

  test('a blank or whitespace phrasing is treated as absent, not rendered as an empty card', () => {
    const f = finding({ id: 'p', summary: 'raw template sentence', phrasedEn: '   ' });
    assert.equal(cardPhrasing(f, 'en'), 'raw template sentence');
  });
});

// ─── Occurrence + data age ──────────────────────────────────────────────────

describe('"now 5" and "this rests on old data"', () => {
  test('a first sighting says nothing about repetition', () => {
    assert.equal(occurrenceLine(finding({ id: 'a', occurrenceCount: 1 }), 'en', NOW), null);
  });

  test('a repeat sighting remains English for legacy language input', () => {
    const f = finding({ id: 'a', occurrenceCount: 6, firstSeenAt: '2026-07-12T06:00:00.000Z' });
    const en = occurrenceLine(f, 'en', NOW);
    const es = occurrenceLine(f, 'es', NOW);
    assert.match(String(en), /Seen 6 times since /);
    assert.equal(es, en);
  });

  test('a broken first-seen timestamp still produces a count rather than "Invalid Date"', () => {
    const f = finding({ id: 'a', occurrenceCount: 3, firstSeenAt: 'not-a-date' });
    assert.equal(occurrenceLine(f, 'en', NOW), 'Seen 3 times');
  });

  test('fresh inputs get no age warning; stale ones say how stale', () => {
    assert.equal(dataAgeNote(finding({ id: 'a', weakestInputAgeDays: 0 }), 'en'), null);
    assert.equal(dataAgeNote(finding({ id: 'a', weakestInputAgeDays: 2 }), 'en'), null);
    assert.equal(dataAgeNote(finding({ id: 'a', weakestInputAgeDays: 9 }), 'en'),
      'Based on data that is 9 days old.');
    assert.equal(dataAgeNote(finding({ id: 'a', weakestInputAgeDays: 9 }), 'es'),
      'Based on data that is 9 days old.');
  });

  test('an unknown input age makes no claim either way', () => {
    assert.equal(dataAgeNote(finding({ id: 'a', weakestInputAgeDays: null }), 'en'), null);
  });
});

// ─── The liveness line ──────────────────────────────────────────────────────

function run(hoursAgo: number, over: Partial<QueueRun> = {}): QueueRun {
  return {
    runAt: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString(),
    detectorsChecked: 34,
    detectorsSkipped: 0,
    detectorsFailed: 0,
    ...over,
  };
}

describe('a quiet watcher and a dead one must not look the same', () => {
  test('a recent run reports what it checked and how much was normal', () => {
    const line = livenessLine(run(9), 1, 'en', NOW);
    assert.equal(line.kind, 'fresh');
    assert.equal(line.text, 'Checked 34 things last night. 33 look normal.');
  });

  test('a night that found nothing still says it checked', () => {
    const line = livenessLine(run(9), 0, 'en', NOW);
    assert.equal(line.text, 'Checked 34 things last night. 34 look normal.');
  });

  test('legacy language input keeps the liveness line English', () => {
    const en = livenessLine(run(9), 1, 'en', NOW).text;
    const es = livenessLine(run(9), 1, 'es', NOW).text;
    assert.equal(es, en);
  });

  test('an old run says how old instead of implying it is current', () => {
    const line = livenessLine(run(72), 1, 'en', NOW);
    assert.equal(line.kind, 'stale');
    assert.equal(line.text, 'Last checked 3 days ago. This may not be up to date.');
    assert.doesNotMatch(String(line.text), /normal/, 'a stale line must not recite last week’s all-clear');
  });

  test('the stale line remains English for legacy language input', () => {
    const line = livenessLine(run(72), 1, 'es', NOW);
    assert.equal(line.text, 'Last checked 3 days ago. This may not be up to date.');
  });

  test('the freshness boundary is where it says it is', () => {
    assert.equal(livenessLine(run(RUN_FRESH_HOURS - 0.5), 0, 'en', NOW).kind, 'fresh');
    assert.equal(livenessLine(run(RUN_FRESH_HOURS + 0.5), 0, 'en', NOW).kind, 'stale');
  });

  test('a hotel that has NEVER been checked gets no line at all', () => {
    // The load-bearing one. An empty queue on an unscanned hotel must not read
    // as a clean bill of health, so there is nothing to read.
    const never = livenessLine(null, 0, 'en', NOW);
    assert.equal(never.kind, 'never');
    assert.equal(never.text, null);
    assert.equal(livenessLine(undefined, 0, 'en', NOW).text, null);
  });

  test('a corrupt run timestamp is treated as "never", not as "just now"', () => {
    const line = livenessLine({ ...run(1), runAt: 'nonsense' }, 0, 'en', NOW);
    assert.equal(line.kind, 'never');
    assert.equal(line.text, null);
  });

  test('more findings than checks cannot produce a negative "normal" count', () => {
    // A detector that skipped tonight leaves yesterday's cards standing, so
    // this really happens. Clamped at zero rather than rendering "-3 normal".
    const line = livenessLine(run(2, { detectorsChecked: 2 }), 7, 'en', NOW);
    assert.equal(line.text, 'Checked 2 things last night. 0 look normal.');
  });

  // Mutation: hard-code the plural. A hotel on its first night, or one where
  // every check but one is skipping for want of data, reads "Checked 1 things
  // last night" — which is the sentence that tells a manager nobody looked at
  // this screen before they did.
  test('one check reads as one thing in English for every legacy language input', () => {
    const single = run(1, { detectorsChecked: 1 });
    assert.equal(livenessLine(single, 0, 'en', NOW).text, 'Checked 1 thing last night. 1 look normal.');
    assert.equal(livenessLine(single, 1, 'es', NOW).text, 'Checked 1 thing last night. 0 look normal.');
    assert.equal(livenessLine(single, 0, 'es', NOW).text, 'Checked 1 thing last night. 1 look normal.');
  });

  test('"normal" counts distinct CHECKS, not findings — five cards from one check is one', () => {
    const fromOneDetector = [
      finding({ id: 'a', detectorId: 'det_x' }),
      finding({ id: 'b', detectorId: 'det_x' }),
      finding({ id: 'c', detectorId: 'det_y' }),
    ];
    assert.equal(distinctDetectors(fromOneDetector), 2);
    assert.equal(livenessLine(run(3), distinctDetectors(fromOneDetector), 'en', NOW).text,
      'Checked 34 things last night. 32 look normal.');
  });

  test('checks that could not run for want of data are named, not counted as normal', () => {
    assert.equal(skippedNote(run(3, { detectorsSkipped: 0 }), 'en', NOW), null);
    assert.equal(skippedNote(run(3, { detectorsSkipped: 1 }), 'en', NOW),
      "1 check couldn't run yet. Not enough history.");
    assert.equal(skippedNote(run(3, { detectorsSkipped: 4 }), 'en', NOW),
      "4 checks couldn't run yet. Not enough history.");
    assert.equal(
      skippedNote(run(3, { detectorsSkipped: 4 }), 'es', NOW),
      "4 checks couldn't run yet. Not enough history.",
    );
    assert.equal(skippedNote(null, 'en', NOW), null);
  });

  test('the skipped note goes quiet once the run is stale', () => {
    // "2 checks couldn't run yet" is present tense. Under "last checked 4 days
    // ago" it would re-import a four-day-old fact as a current one.
    assert.ok(skippedNote(run(3, { detectorsSkipped: 2 }), 'en', NOW));
    assert.equal(skippedNote(run(96, { detectorsSkipped: 2 }), 'en', NOW), null);
  });
});

// ─── The card's overflow menu ───────────────────────────────────────────────
//
// The founder's bug: the `···` menu opened downward out of the last row of a
// card whose own rule is `overflow:hidden`, so it was clipped to a sliver under
// the following card and none of the verdicts behind it could be reached.
//
// The component fix is a portal, which no unit test can prove. What CAN be
// proved without a browser is the other half: that the coordinates this
// function hands the portal always keep the whole menu on the screen. Every
// case below is a shape of screen the old code got wrong.

describe('placeCardMenu', () => {
  const PHONE = { width: 390, height: 844 };
  const DESKTOP = { width: 1440, height: 900 };
  const MENU = { width: 206, height: 132 };

  /** A `···` button 36px square, right-aligned inside a card. */
  function moreButton(top: number, right = 1000): { top: number; left: number; right: number; bottom: number } {
    return { top, bottom: top + 36, right, left: right - 36 };
  }

  test('a card with room below opens below, at the gap', () => {
    const placed = placeCardMenu({ anchor: moreButton(200), menu: MENU, viewport: DESKTOP });
    assert.equal(placed.side, 'below');
    assert.equal(placed.top, 236 + MENU_GAP);
    assert.ok(menuPlacementIsOnScreen(placed, DESKTOP));
  });

  test('a card at the BOTTOM of the screen opens upward instead of into nothing', () => {
    // This is the founder's case. The old rule was unconditionally "below",
    // which is why the menu had nowhere to be.
    const placed = placeCardMenu({
      anchor: moreButton(DESKTOP.height - 60), menu: MENU, viewport: DESKTOP,
    });
    assert.equal(placed.side, 'above');
    assert.ok(menuPlacementIsOnScreen(placed, DESKTOP));
    // And it finishes exactly at the gap above the button rather than floating.
    assert.equal(placed.top + placed.maxHeight, DESKTOP.height - 60 - MENU_GAP);
  });

  test('a menu taller than the room it has scrolls rather than running off', () => {
    const tall = { width: 206, height: 700 };
    const placed = placeCardMenu({ anchor: moreButton(500), menu: tall, viewport: PHONE });
    assert.ok(placed.maxHeight < tall.height);
    assert.ok(menuPlacementIsOnScreen(placed, PHONE));
  });

  test('it never goes off the right edge, even anchored at the very edge', () => {
    const placed = placeCardMenu({
      anchor: moreButton(300, PHONE.width), menu: MENU, viewport: PHONE,
    });
    assert.ok(placed.left >= MENU_EDGE_MARGIN);
    assert.ok(menuPlacementIsOnScreen(placed, PHONE));
  });

  test('it never goes off the left edge, even anchored near it', () => {
    const placed = placeCardMenu({
      anchor: moreButton(300, 40), menu: MENU, viewport: PHONE,
    });
    assert.equal(placed.left, MENU_EDGE_MARGIN);
    assert.ok(menuPlacementIsOnScreen(placed, PHONE));
  });

  test('a menu wider than the phone is narrowed to the phone', () => {
    const wide = { width: 600, height: 132 };
    const placed = placeCardMenu({ anchor: moreButton(300, 380), menu: wide, viewport: PHONE });
    assert.equal(placed.maxWidth, PHONE.width - MENU_EDGE_MARGIN * 2);
    assert.ok(menuPlacementIsOnScreen(placed, PHONE));
  });

  test('there is no screen where it lands off the viewport', () => {
    // The property, swept. The old behaviour fails this at every anchor in the
    // bottom third of every viewport.
    for (const viewport of [PHONE, DESKTOP, { width: 320, height: 480 }, { width: 768, height: 400 }]) {
      for (let top = 0; top < viewport.height; top += 17) {
        for (const right of [30, viewport.width / 2, viewport.width, viewport.width + 40]) {
          const placed = placeCardMenu({
            anchor: moreButton(top, right),
            menu: MENU,
            viewport,
          });
          assert.ok(
            menuPlacementIsOnScreen(placed, viewport),
            `off screen at top=${top} right=${right} in ${viewport.width}x${viewport.height}: `
            + JSON.stringify(placed),
          );
        }
      }
    }
  });

  test('a viewport too small for anything still returns a position, never a refusal', () => {
    // A control that opens into nothing is the bug this replaced, so there is
    // deliberately no "it does not fit" branch to fall into.
    const placed = placeCardMenu({
      anchor: moreButton(10, 40), menu: MENU, viewport: { width: 100, height: 60 },
    });
    assert.ok(Number.isFinite(placed.left) && Number.isFinite(placed.top));
    assert.ok(placed.maxHeight >= 0 && placed.maxWidth >= 0);
  });
});
