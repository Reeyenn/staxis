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
  cardPhrasing,
  dataAgeNote,
  distinctDetectors,
  effectiveDisposition,
  formatPriceRange,
  isCardRenderable,
  isQuiet,
  livenessLine,
  occurrenceLine,
  offersResolve,
  rankFindings,
  severityChipClass,
  skippedNote,
  sortValueCents,
  splitByCap,
  type QueueFinding,
  type QueueRun,
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

describe('ranking: biggest dollars first, and stable when they tie', () => {
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

  test('severity breaks a tie between two unpriced findings', () => {
    const info = finding({ id: 'i', severity: 'info' });
    const critical = finding({ id: 'c', severity: 'critical' });
    const attention = finding({ id: 'a', severity: 'attention' });
    assert.deepEqual(
      rankFindings([info, attention, critical]).map((f) => f.id),
      ['c', 'a', 'i'],
    );
  });

  test('magnitude breaks a tie between two equal-severity unpriced findings', () => {
    // The dedupe keys are deliberately ordered AGAINST the expected result, so
    // the alphabetical last-resort tiebreak cannot produce this answer on its
    // own — only magnitude can.
    const smallMag = finding({ id: 'sm', magnitude: 2, dedupeKey: 'det_a:aaa' });
    const bigMag = finding({ id: 'bg', magnitude: 9, dedupeKey: 'det_a:zzz' });
    assert.deepEqual(rankFindings([smallMag, bigMag]).map((f) => f.id), ['bg', 'sm']);
    assert.deepEqual(rankFindings([bigMag, smallMag]).map((f) => f.id), ['bg', 'sm']);
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

  test('an fyi is quiet and offers no "fixed" button; a recommendation offers both', () => {
    const fyi = finding({ id: 'f', disposition: 'fyi' });
    const rec = finding({ id: 'r', disposition: 'recommend' });
    assert.equal(isQuiet(fyi), true);
    assert.equal(offersResolve(fyi), false);
    assert.equal(isQuiet(rec), false);
    assert.equal(offersResolve(rec), true);
  });

  test('severity picks a distinct chip so the three tiers are not one colour', () => {
    const chips = new Set(
      (['critical', 'attention', 'info'] as const).map(severityChipClass),
    );
    assert.equal(chips.size, 3);
  });
});

// ─── Phrasing ───────────────────────────────────────────────────────────────

describe('judged phrasing when it exists, the detector’s own sentence when it does not', () => {
  test('the judge’s wording wins in the manager’s language', () => {
    const f = finding({
      id: 'p',
      summary: 'raw template sentence',
      phrasedEn: 'Room 214 has eaten four HVAC visits this month.',
      phrasedEs: 'La 214 lleva cuatro visitas de aire este mes.',
    });
    assert.equal(cardPhrasing(f, 'en'), 'Room 214 has eaten four HVAC visits this month.');
    assert.equal(cardPhrasing(f, 'es'), 'La 214 lleva cuatro visitas de aire este mes.');
  });

  test('an absent judge leaves a card that still says something true', () => {
    const f = finding({ id: 'p', summary: 'raw template sentence' });
    assert.equal(cardPhrasing(f, 'en'), 'raw template sentence');
    assert.equal(cardPhrasing(f, 'es'), 'raw template sentence');
  });

  test('a judge that phrased only English does not leave the Spanish card blank', () => {
    const f = finding({ id: 'p', summary: 'raw template sentence', phrasedEn: 'English wording' });
    assert.equal(cardPhrasing(f, 'es'), 'raw template sentence');
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

  test('a repeat sighting counts, in both languages', () => {
    const f = finding({ id: 'a', occurrenceCount: 6, firstSeenAt: '2026-07-12T06:00:00.000Z' });
    const en = occurrenceLine(f, 'en', NOW);
    const es = occurrenceLine(f, 'es', NOW);
    assert.match(String(en), /Seen 6 times since /);
    assert.match(String(es), /Visto 6 veces desde el /);
    assert.notEqual(en, es, 'the Spanish string is the English one');
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
      'Basado en datos de hace 9 días.');
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
    assert.equal(line.text, 'Checked 34 things last night — 33 look normal.');
  });

  test('a night that found nothing still says it checked', () => {
    const line = livenessLine(run(9), 0, 'en', NOW);
    assert.equal(line.text, 'Checked 34 things last night — 34 look normal.');
  });

  test('the Spanish line is Spanish, not the English one', () => {
    const en = livenessLine(run(9), 1, 'en', NOW).text;
    const es = livenessLine(run(9), 1, 'es', NOW).text;
    assert.equal(es, 'Se revisaron 34 cosas anoche — 33 se ven normales.');
    assert.notEqual(en, es);
  });

  test('an old run says how old instead of implying it is current', () => {
    const line = livenessLine(run(72), 1, 'en', NOW);
    assert.equal(line.kind, 'stale');
    assert.equal(line.text, 'Last checked 3 days ago — this may not be up to date.');
    assert.doesNotMatch(String(line.text), /normal/, 'a stale line must not recite last week’s all-clear');
  });

  test('the stale line is Spanish in Spanish', () => {
    const line = livenessLine(run(72), 1, 'es', NOW);
    assert.equal(line.text, 'Última revisión hace 3 días. Puede que esto no esté al día.');
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
    assert.equal(line.text, 'Checked 2 things last night — 0 look normal.');
  });

  test('"normal" counts distinct CHECKS, not findings — five cards from one check is one', () => {
    const fromOneDetector = [
      finding({ id: 'a', detectorId: 'det_x' }),
      finding({ id: 'b', detectorId: 'det_x' }),
      finding({ id: 'c', detectorId: 'det_y' }),
    ];
    assert.equal(distinctDetectors(fromOneDetector), 2);
    assert.equal(livenessLine(run(3), distinctDetectors(fromOneDetector), 'en', NOW).text,
      'Checked 34 things last night — 32 look normal.');
  });

  test('checks that could not run for want of data are named, not counted as normal', () => {
    assert.equal(skippedNote(run(3, { detectorsSkipped: 0 }), 'en', NOW), null);
    assert.equal(skippedNote(run(3, { detectorsSkipped: 1 }), 'en', NOW),
      "1 check couldn't run yet — not enough history.");
    assert.equal(skippedNote(run(3, { detectorsSkipped: 4 }), 'en', NOW),
      "4 checks couldn't run yet — not enough history.");
    assert.match(String(skippedNote(run(3, { detectorsSkipped: 4 }), 'es', NOW)), /falta de datos/);
    assert.equal(skippedNote(null, 'en', NOW), null);
  });

  test('the skipped note goes quiet once the run is stale', () => {
    // "2 checks couldn't run yet" is present tense. Under "last checked 4 days
    // ago" it would re-import a four-day-old fact as a current one.
    assert.ok(skippedNote(run(3, { detectorsSkipped: 2 }), 'en', NOW));
    assert.equal(skippedNote(run(96, { detectorsSkipped: 2 }), 'en', NOW), null);
  });
});
