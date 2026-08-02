/**
 * THE MANNERS THE TRACE INHERITS, AND THE ONE IT ADDS.
 *
 * The Trace is not a second system, and the proof of that claim is that a
 * pattern is a `CompanionCandidate` and nothing else. This file exercises the
 * real manners engine with real trace candidates, so the claim is checked
 * rather than asserted in a comment.
 *
 * The plausible bugs it is aimed at:
 *   - a trace that speaks while somebody is typing, or after a No, or twice in
 *     one day, or as the second thing said in ten minutes
 *   - a pattern about a named person reaching an unprompted surface
 *   - the panel ask firing with the panel shut, or over a conversation already
 *     in progress, or on top of something else the companion is saying
 *   - a decline recorded against a key that changes when the pattern is
 *     recomputed, which would make "twice and it is gone" mean nothing
 *   - two patterns offered at once
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  COMPANION_DECLINES_BEFORE_DROP,
  COMPANION_MAX_SPEECH_PER_DAY,
  COMPANION_MIN_GAP_MINUTES,
} from '@/lib/companion/charter';
import {
  EMPTY_COMPANION_MEMORY,
  decideCompanionSpeech,
  decidePanelAsk,
  parseCompanionMemory,
  rememberDeclined,
  rememberSpoke,
  type CompanionMemory,
  type MannersInput,
} from '@/lib/companion/manners';
import { rankTraces, traceCandidate, traceStillStands } from '@/lib/companion/trace';
import {
  detectMaintenanceRuns,
  type TraceWorkOrder,
} from '@/lib/companion/trace/detectors/maintenance-run';
import { detectCalloutWeekday } from '@/lib/companion/trace/detectors/callout-weekday';
import type { TracePattern } from '@/lib/companion/trace/types';

const NOW = new Date('2026-08-02T15:00:00Z');
const TODAY = '2026-08-02';

const RUN: TraceWorkOrder[] = [
  { id: 'a', location: 'Room 222', description: 'AC rattles when it kicks on.', open: true, createdAt: '2026-06-14T12:00:00Z', repairCost: null },
  { id: 'b', location: 'Room 218', description: 'Cools, then stops by evening.', open: true, createdAt: '2026-07-02T12:00:00Z', repairCost: null },
  { id: 'c', location: 'Room 214', description: 'AC blowing warm.', open: true, createdAt: '2026-07-30T12:00:00Z', repairCost: null },
];

/** The real hero pattern, from the real detector. Nothing here is a stub. */
function heroPattern(): TracePattern {
  const found = detectMaintenanceRuns({ now: NOW, workOrders: RUN, knownRooms: [] });
  assert.equal(found.length, 1);
  return found[0];
}

function peoplePattern(): TracePattern {
  const found = detectCalloutWeekday({
    now: NOW,
    callouts: [
      { id: 'a', staffId: 's1', staffName: 'Marisol Reyes', businessDate: '2026-06-24' },
      { id: 'b', staffId: 's1', staffName: 'Marisol Reyes', businessDate: '2026-07-08' },
      { id: 'c', staffId: 's1', staffName: 'Marisol Reyes', businessDate: '2026-07-22' },
    ],
  });
  assert.equal(found.length, 1);
  return found[0];
}

function mannersInput(over: Partial<MannersInput> = {}): MannersInput {
  return {
    now: NOW,
    today: TODAY,
    person: { firstName: 'Reeyen', role: 'general_manager', sharedLogin: false },
    // Day one is over and the tour was answered; otherwise the welcome owns
    // the floor and nothing operational is offered at all.
    memory: { ...EMPTY_COMPANION_MEMORY, welcomedAt: '2026-07-01T09:00:00Z', tourDeclined: true },
    candidates: [traceCandidate(heroPattern())],
    onScreen: [],
    userIsBusy: false,
    quietThisSession: false,
    aiAwake: true,
    wizardAlreadyRan: true,
    multiHotel: false,
    hotelName: 'Comfort Suites Beaumont',
    ...over,
  };
}

describe('a trace is offered through the manners engine, not around it', () => {
  test('a pattern on this screen becomes the one thing the companion offers', () => {
    const speech = decideCompanionSpeech(mannersInput());
    assert.equal(speech.kind, 'offer');
    if (speech.kind !== 'offer') return;
    assert.equal(speech.topic, heroPattern().key);
    assert.equal(speech.destination, 'maintenance');
    assert.match(speech.sentence, /Mind if I show you\?$/);
  });

  test('nothing is offered while somebody is typing', () => {
    const speech = decideCompanionSpeech(mannersInput({ userIsBusy: true }));
    assert.deepEqual(speech, { kind: 'silent', reason: 'user_is_busy' });
  });

  test('nothing is offered after a request for quiet', () => {
    const speech = decideCompanionSpeech(mannersInput({ quietThisSession: true }));
    assert.deepEqual(speech, { kind: 'silent', reason: 'quiet_this_session' });
  });

  test('nothing is offered while the AI layer is asleep', () => {
    const speech = decideCompanionSpeech(mannersInput({ aiAwake: false }));
    assert.deepEqual(speech, { kind: 'silent', reason: 'ai_asleep' });
  });

  test('a pattern offered today is not offered again today', () => {
    const pattern = heroPattern();
    const memory = rememberSpoke(mannersInput().memory, pattern.key, NOW, TODAY);
    const speech = decideCompanionSpeech(mannersInput({
      memory: { ...memory, lastSpokeAt: null, spokenCount: 0 },
    }));
    assert.deepEqual(speech, { kind: 'silent', reason: 'nothing_to_say' });
  });

  test('turned down twice and this pattern never comes back', () => {
    const pattern = heroPattern();
    let memory: CompanionMemory = mannersInput().memory;
    for (let i = 0; i < COMPANION_DECLINES_BEFORE_DROP; i += 1) {
      memory = rememberDeclined(memory, pattern.key, `2026-07-${20 + i}`);
    }
    assert.equal(memory.topics[pattern.key].dropped, true);
    const speech = decideCompanionSpeech(mannersInput({ memory }));
    assert.deepEqual(speech, { kind: 'silent', reason: 'nothing_to_say' });
  });

  test('the decline survives the pattern being found again with a fourth ticket', () => {
    const before = heroPattern();
    let memory: CompanionMemory = mannersInput().memory;
    memory = rememberDeclined(memory, before.key, '2026-07-20');
    memory = rememberDeclined(memory, before.key, '2026-07-25');

    const after = detectMaintenanceRuns({
      now: NOW,
      workOrders: [...RUN, { id: 'd', location: 'Room 220', description: 'AC noisy.', open: true, createdAt: '2026-08-01T12:00:00Z', repairCost: null }],
      knownRooms: [],
    })[0];
    const speech = decideCompanionSpeech(mannersInput({
      memory, candidates: [traceCandidate(after)],
    }));
    assert.deepEqual(speech, { kind: 'silent', reason: 'nothing_to_say' });
  });

  test('the decline survives a round trip through the stored blob', () => {
    const pattern = heroPattern();
    let memory: CompanionMemory = EMPTY_COMPANION_MEMORY;
    memory = rememberDeclined(memory, pattern.key, TODAY);
    memory = rememberDeclined(memory, pattern.key, TODAY);
    const reparsed = parseCompanionMemory(JSON.parse(JSON.stringify(memory)));
    assert.equal(reparsed.topics[pattern.key].dropped, true);
    // And the key fits inside the cap the parser drops keys at.
    assert.ok(pattern.key.length <= 200);
  });

  test('two patterns are two candidates, and exactly one is offered', () => {
    const first = heroPattern();
    const second = detectMaintenanceRuns({
      now: NOW,
      workOrders: [
        { id: 'p1', location: 'Room 315', description: 'Toilet running.', open: true, createdAt: '2026-07-01T12:00:00Z', repairCost: null },
        { id: 'p2', location: 'Room 317', description: 'Shower drain clogged.', open: true, createdAt: '2026-07-10T12:00:00Z', repairCost: null },
        { id: 'p3', location: 'Room 319', description: 'Faucet leaking.', open: true, createdAt: '2026-07-20T12:00:00Z', repairCost: null },
      ],
      knownRooms: [],
    })[0];
    const speech = decideCompanionSpeech(mannersInput({
      candidates: [traceCandidate(first), traceCandidate(second)],
    }));
    assert.equal(speech.kind, 'offer');
    if (speech.kind !== 'offer') return;
    // One. The other is still there tomorrow.
    assert.equal(speech.topic, first.key);
  });

  test('the daily cap and the minimum gap apply to traces like everything else', () => {
    const capped = decideCompanionSpeech(mannersInput({
      memory: {
        ...mannersInput().memory,
        spokenDay: TODAY,
        spokenCount: COMPANION_MAX_SPEECH_PER_DAY,
      },
    }));
    assert.deepEqual(capped, { kind: 'silent', reason: 'daily_cap_reached' });

    const tooSoon = decideCompanionSpeech(mannersInput({
      memory: {
        ...mannersInput().memory,
        lastSpokeAt: new Date(NOW.getTime() - (COMPANION_MIN_GAP_MINUTES - 5) * 60_000).toISOString(),
      },
    }));
    assert.deepEqual(tooSoon, { kind: 'silent', reason: 'too_soon_after_last' });
  });
});

describe('a pattern about a person can only be said in a panel somebody opened', () => {
  const person = peoplePattern();
  const candidates = [traceCandidate(person)];

  test('it is never an unprompted offer, whatever else is true', () => {
    const speech = decideCompanionSpeech(mannersInput({ candidates }));
    assert.deepEqual(speech, { kind: 'silent', reason: 'nothing_to_say' });
  });

  test('it is refused while the panel is shut', () => {
    const decision = decidePanelAsk({
      today: TODAY,
      memory: EMPTY_COMPANION_MEMORY,
      candidates,
      panelOpen: false,
      threadEmpty: true,
      otherSpeechShowing: false,
      userIsBusy: false,
      quietThisSession: false,
      aiAwake: true,
    });
    assert.deepEqual(decision, { ask: false, refusal: 'panel_not_open' });
  });

  test('it is refused over a conversation already in progress', () => {
    const base = {
      today: TODAY,
      memory: EMPTY_COMPANION_MEMORY,
      candidates,
      panelOpen: true,
      userIsBusy: false,
      quietThisSession: false,
      aiAwake: true,
    };
    assert.deepEqual(
      decidePanelAsk({ ...base, threadEmpty: false, otherSpeechShowing: false }),
      { ask: false, refusal: 'conversation_in_progress' },
    );
    assert.deepEqual(
      decidePanelAsk({ ...base, threadEmpty: true, otherSpeechShowing: true }),
      { ask: false, refusal: 'conversation_in_progress' },
    );
  });

  test('it is said inside an open, empty panel, and it names nobody in the ask', () => {
    const decision = decidePanelAsk({
      today: TODAY,
      memory: EMPTY_COMPANION_MEMORY,
      candidates,
      panelOpen: true,
      threadEmpty: true,
      otherSpeechShowing: false,
      userIsBusy: false,
      quietThisSession: false,
      aiAwake: true,
    });
    assert.equal(decision.ask, true);
    if (!decision.ask) return;
    assert.equal(decision.topic, person.key);
    assert.equal(decision.destination, null);
    assert.equal(decision.sentence.includes('Marisol'), false);
  });

  test('a No in the panel is the same No everywhere else', () => {
    let memory: CompanionMemory = EMPTY_COMPANION_MEMORY;
    memory = rememberDeclined(memory, person.key, '2026-07-20');
    memory = rememberDeclined(memory, person.key, '2026-07-27');
    const decision = decidePanelAsk({
      today: TODAY,
      memory,
      candidates,
      panelOpen: true,
      threadEmpty: true,
      otherSpeechShowing: false,
      userIsBusy: false,
      quietThisSession: false,
      aiAwake: true,
    });
    assert.deepEqual(decision, { ask: false, refusal: 'nothing_to_say' });
  });

  test('the panel ask still refuses to speak over somebody typing, or while asleep', () => {
    const base = {
      today: TODAY,
      memory: EMPTY_COMPANION_MEMORY,
      candidates,
      panelOpen: true,
      threadEmpty: true,
      otherSpeechShowing: false,
      quietThisSession: false,
    };
    assert.deepEqual(
      decidePanelAsk({ ...base, userIsBusy: true, aiAwake: true }),
      { ask: false, refusal: 'user_is_busy' },
    );
    assert.deepEqual(
      decidePanelAsk({ ...base, userIsBusy: false, aiAwake: false }),
      { ask: false, refusal: 'ai_asleep' },
    );
  });
});

describe('the walk from the Staxis list', () => {
  test('a pattern whose rows are all still there survives the walk', () => {
    const pattern = heroPattern();
    const fresh = new Set(['wo:a', 'wo:b', 'wo:c']);
    assert.equal(traceStillStands(pattern, fresh), true);
  });

  test('a pattern whose rows were closed while walking does not get drawn', () => {
    const pattern = heroPattern();
    assert.equal(traceStillStands(pattern, new Set(['wo:a'])), false);
    assert.equal(traceStillStands(pattern, new Set()), false);
  });

  test('a pattern with nothing to draw to is not made stale by having no rows', () => {
    assert.equal(traceStillStands(peoplePattern(), new Set()), true);
  });
});

describe('ranking', () => {
  test('severity leads, because magnitudes from two detectors are not one scale', () => {
    const loud = { ...heroPattern(), severity: 'urgent' as const, magnitude: 3, key: 'a' };
    const big = { ...heroPattern(), severity: 'watch' as const, magnitude: 900, key: 'b' };
    assert.deepEqual(rankTraces([big, loud]).map((p) => p.key), ['a', 'b']);
  });
});
