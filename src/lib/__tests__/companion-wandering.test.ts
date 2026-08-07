/**
 * The wandering offer: the one sentence the companion is allowed to say to
 * somebody who looks lost, and every reason it stays quiet instead.
 *
 * ─── WHAT THIS FILE IS ACTUALLY PROTECTING ─────────────────────────────────
 *
 * A false positive here is the worst thing the companion can do. It is the app
 * interrupting a competent person, mid-task, to imply they cannot find their
 * way around. There is no recovering from that: every later sentence gets read
 * in the same voice. A miss costs nothing, because the ability the offer
 * teaches is still there and the tour still teaches it.
 *
 * So the thresholds ARE the product, and each one is pinned below with the
 * behaviour it exists to refuse. The plausible bug is not a crash. It is a
 * `>=` that should be `>` on the move count, a window that accumulates over a
 * whole shift instead of sliding, a re-render counted as a navigation, or an
 * offer that comes back tomorrow after somebody ignored it once.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { EMPTY_COMPANION_MEMORY, type CompanionMemory } from '@/lib/companion/manners';
import {
  decideWandering,
  recordVisit,
  WANDER_MIN_DISTINCT_PAGES,
  WANDER_MIN_MOVES,
  WANDER_SEED,
  WANDER_TOPIC,
  WANDER_TRAIL_CAP,
  WANDER_WINDOW_MS,
  type WanderVisit,
} from '@/lib/companion/wandering';

const NOW = Date.parse('2026-08-07T14:00:00.000Z');

function welcomed(over: Partial<CompanionMemory> = {}): CompanionMemory {
  return {
    ...EMPTY_COMPANION_MEMORY,
    taught: {},
    topics: {},
    welcomedAt: '2026-07-01T09:00:00.000Z',
    ...over,
  };
}

/** A hunt: `count` different screens, evenly spread across the last 20s. */
function hunt(count: number, now = NOW): WanderVisit[] {
  const pages = ['staxis', 'dashboard', 'maintenance', 'inventory', 'messages', 'settings'];
  return Array.from({ length: count }, (_, i) => ({
    page: pages[i % pages.length],
    at: now - (count - i) * 5_000,
  }));
}

describe('the thresholds are what they say they are', () => {
  test('the window is thirty seconds and the floors are four moves over three screens', () => {
    // Pinned as literals, deliberately. These numbers are a founder decision
    // ("3+ page changes in ~30 seconds", then tuned conservatively upward),
    // and a refactor that quietly loosened one would be a behaviour change
    // wearing a tidy-up's clothes.
    assert.equal(WANDER_WINDOW_MS, 30_000);
    assert.equal(WANDER_MIN_MOVES, 4);
    assert.equal(WANDER_MIN_DISTINCT_PAGES, 3);
  });

  test('the floors are ABOVE the founder\'s minimum, not at it', () => {
    // Three moves is a person going somewhere, looking, and coming back. The
    // extra move is the whole margin between "hunting" and "a round trip".
    assert.ok(WANDER_MIN_MOVES > 3);
  });
});

describe('it fires only on a real hunt', () => {
  test('four screens in twenty seconds with nothing done is a hunt', () => {
    const d = decideWandering({ visits: hunt(4), lastActionAt: null, now: NOW, memory: welcomed() });
    assert.equal(d.wandering, true);
  });

  test('three moves is not enough', () => {
    const d = decideWandering({ visits: hunt(3), lastActionAt: null, now: NOW, memory: welcomed() });
    assert.equal(d.wandering, false);
    assert.equal(d.wandering === false && d.refusal, 'too_few_moves');
  });

  test('four visits bouncing between two screens is a comparison, not a hunt', () => {
    const visits: WanderVisit[] = [
      { page: 'staxis', at: NOW - 20_000 },
      { page: 'dashboard', at: NOW - 15_000 },
      { page: 'staxis', at: NOW - 10_000 },
      { page: 'dashboard', at: NOW - 5_000 },
    ];
    const d = decideWandering({ visits, lastActionAt: null, now: NOW, memory: welcomed() });
    assert.equal(d.wandering, false);
    assert.equal(d.wandering === false && d.refusal, 'too_few_screens');
  });

  test('the window slides: four moves spread over five minutes is a shift, not a hunt', () => {
    const visits: WanderVisit[] = [
      { page: 'staxis', at: NOW - 300_000 },
      { page: 'dashboard', at: NOW - 200_000 },
      { page: 'maintenance', at: NOW - 100_000 },
      { page: 'inventory', at: NOW - 1_000 },
    ];
    const d = decideWandering({ visits, lastActionAt: null, now: NOW, memory: welcomed() });
    assert.equal(d.wandering, false);
    assert.equal(d.wandering === false && d.refusal, 'too_few_moves');
  });

  test('one real action anywhere in the window clears it', () => {
    // Somebody who saved something and then went looking for the next thing is
    // working. This is the check that keeps the offer off the back of a
    // productive minute.
    const d = decideWandering({
      visits: hunt(5), lastActionAt: NOW - 10_000, now: NOW, memory: welcomed(),
    });
    assert.equal(d.wandering, false);
    assert.equal(d.wandering === false && d.refusal, 'acted_recently');
  });

  test('an action older than the window does not clear it', () => {
    const d = decideWandering({
      visits: hunt(5), lastActionAt: NOW - WANDER_WINDOW_MS - 1_000, now: NOW, memory: welcomed(),
    });
    assert.equal(d.wandering, true);
  });

  test('visits stamped in the future are not counted', () => {
    // A browser clock ahead of the server's must not be able to manufacture a
    // hunt out of one navigation.
    const visits: WanderVisit[] = hunt(4).map((v) => ({ ...v, at: NOW + 60_000 }));
    const d = decideWandering({ visits, lastActionAt: null, now: NOW, memory: welcomed() });
    assert.equal(d.wandering, false);
  });
});

describe('never on somebody who has not been welcomed', () => {
  test('a person on their first minutes is exploring, not lost', () => {
    const d = decideWandering({
      visits: hunt(6), lastActionAt: null, now: NOW,
      memory: { ...EMPTY_COMPANION_MEMORY, taught: {}, topics: {} },
    });
    assert.equal(d.wandering, false);
    assert.equal(d.wandering === false && d.refusal, 'never_welcomed');
  });
});

describe('once, ever', () => {
  test('a dropped topic is never offered again, however lost they look', () => {
    const memory = welcomed({
      topics: { [WANDER_TOPIC]: { declines: 2, dropped: true, lastOfferedDay: '2026-07-04' } },
    });
    const d = decideWandering({ visits: hunt(6), lastActionAt: null, now: NOW, memory });
    assert.equal(d.wandering, false);
    assert.equal(d.wandering === false && d.refusal, 'already_offered');
  });

  test('a decline that has not yet reached the drop threshold still blocks nothing else', () => {
    // Deliberate: the client drops this topic the moment it is SHOWN, so a
    // half-declined state is not reachable in production. If it ever were, the
    // right behaviour is the ordinary one, and this pins that it is.
    const memory = welcomed({
      topics: { [WANDER_TOPIC]: { declines: 1, dropped: false, lastOfferedDay: '2026-07-04' } },
    });
    const d = decideWandering({ visits: hunt(4), lastActionAt: null, now: NOW, memory });
    assert.equal(d.wandering, true);
  });
});

describe('what it actually offers', () => {
  test('a candidate, not a decision to speak', () => {
    // Everything about interrupting is the manners engine's. This module
    // cannot produce a peek, cannot bypass the daily budget, and cannot skip
    // the minimum gap, because it does not decide any of those things.
    const d = decideWandering({ visits: hunt(4), lastActionAt: null, now: NOW, memory: welcomed() });
    assert.equal(d.wandering, true);
    if (!d.wandering) return;
    assert.equal(d.candidate.topic, WANDER_TOPIC);
    assert.equal(d.candidate.sensitivity, 'operational');
    assert.deepEqual(d.candidate.covers, []);
    assert.equal(d.candidate.destination, null, 'walking a lost person to a ninth screen is the problem');
    assert.equal(d.candidate.seed, WANDER_SEED);
  });

  test('the sentence is a question about what they want, not a verdict on them', () => {
    const d = decideWandering({ visits: hunt(4), lastActionAt: null, now: NOW, memory: welcomed() });
    if (!d.wandering) throw new Error('expected a candidate');
    const text = d.candidate.text;
    assert.ok(text.endsWith('point at it.'), text);
    assert.ok(!/\byou seem\b|\blost\b|\bstruggling\b/i.test(text), `it diagnoses the person: ${text}`);
    assert.ok(!text.includes('—'), 'em dash');
    assert.ok(!text.includes('!'));
  });

  test('the seed is an unfinished question, so they finish it themselves', () => {
    assert.ok(!WANDER_SEED.endsWith('?'), 'a complete question would answer itself');
    assert.ok(WANDER_SEED.toLowerCase().startsWith('where'));
  });
});

describe('keeping the trail', () => {
  test('a repeat of the screen they are already on is not a move', () => {
    // Next.js re-renders a route on a query change. Counting those would let
    // one screen with a tab strip look like a hunt across four.
    let trail: WanderVisit[] = [];
    trail = recordVisit(trail, { page: 'staxis', at: NOW - 4_000 });
    trail = recordVisit(trail, { page: 'staxis', at: NOW - 3_000 });
    trail = recordVisit(trail, { page: 'staxis', at: NOW - 2_000 });
    assert.equal(trail.length, 1);
  });

  test('it drops anything past the window', () => {
    let trail: WanderVisit[] = [{ page: 'old', at: NOW - 120_000 }];
    trail = recordVisit(trail, { page: 'staxis', at: NOW });
    assert.deepEqual(trail.map((v) => v.page), ['staxis']);
  });

  test('it is bounded, so a tab open all shift never grows', () => {
    let trail: WanderVisit[] = [];
    for (let i = 0; i < 100; i++) {
      trail = recordVisit(trail, { page: `p${i}`, at: NOW + i });
    }
    assert.ok(trail.length <= WANDER_TRAIL_CAP, `${trail.length} visits kept`);
  });

  test('a real hunt survives the trail bookkeeping end to end', () => {
    let trail: WanderVisit[] = [];
    const pages = ['staxis', 'dashboard', 'maintenance', 'inventory'];
    pages.forEach((page, i) => {
      trail = recordVisit(trail, { page, at: NOW - (pages.length - i) * 4_000 });
    });
    const d = decideWandering({ visits: trail, lastActionAt: null, now: NOW, memory: welcomed() });
    assert.equal(d.wandering, true);
  });
});
