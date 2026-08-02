/**
 * THE COMPANION'S MANNERS.
 *
 * The companion is the one part of Staxis that talks to somebody who did not
 * ask it anything. Everything that makes that acceptable rather than obnoxious
 * is a rule in src/lib/companion/manners.ts, and every rule in there is here.
 *
 * The engine is pure on purpose — no clock of its own, no fetch, no model call
 * — which is what makes this file possible: each rule is one call with one set
 * of inputs, and the failure mode it prevents is nameable.
 *
 * The bar for every test below: would it fail if I introduced a plausible bug?
 * A plausible bug here is not exotic. It is a `>` that should be `>=` on the
 * frequency cap, a decline counter that resets when a topic is re-offered, a
 * check ordered above the one that was meant to short-circuit it, or a memory
 * parser that trusts a boolean out of a jsonb column. Each of those has a test.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  COMPANION_DECLINES_BEFORE_DROP,
  COMPANION_MAX_SPEECH_PER_DAY,
  COMPANION_MEMORY_TOPIC_CAP,
  COMPANION_MIN_GAP_MINUTES,
} from '@/lib/companion/charter';
import {
  EMPTY_COMPANION_MEMORY,
  decideCompanionSpeech,
  decideTeachMoment,
  parseCompanionMemory,
  rememberAccepted,
  rememberDeclined,
  rememberSpoke,
  rememberTaught,
  rememberTourDeclined,
  rememberTourTaken,
  rememberWelcomed,
  decideDailyHello,
  rememberGreeted,
  type CompanionCandidate,
  type CompanionMemory,
  type HelloInput,
  type MannersInput,
} from '@/lib/companion/manners';
import { todayFact } from '@/lib/companion/copy';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const TODAY = '2026-08-01';
const NOON = new Date('2026-08-01T17:00:00.000Z');

function candidate(over: Partial<CompanionCandidate> = {}): CompanionCandidate {
  return {
    topic: 'finding:linen_below_par',
    text: '3 rooms have no clean bath towels.',
    sensitivity: 'operational',
    covers: ['finding:abc'],
    destination: 'inventory',
    ...over,
  };
}

/** A settled, welcomed, tour-answered person with one thing worth saying. */
function input(over: Partial<MannersInput> = {}): MannersInput {
  return {
    now: NOON,
    today: TODAY,
    person: { firstName: 'Maria', role: 'general_manager', sharedLogin: false },
    memory: {
      ...EMPTY_COMPANION_MEMORY,
      welcomedAt: '2026-07-01T12:00:00.000Z',
      tourDeclined: true,
      topics: {},
      taught: {},
    },
    candidates: [candidate()],
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

// ─── Day one ────────────────────────────────────────────────────────────────

describe('the welcome', () => {
  test('greets a brand-new person by name, once, with a tour offer', () => {
    const speech = decideCompanionSpeech(input({
      memory: { ...EMPTY_COMPANION_MEMORY },
      wizardAlreadyRan: false,
    }));
    assert.equal(speech.kind, 'welcome');
    assert.ok(speech.kind === 'welcome');
    assert.match(speech.greeting, /Maria/);
    assert.match(speech.question, /\?$/);
  });

  test('a shared login is greeted without a personal name', () => {
    const speech = decideCompanionSpeech(input({
      memory: { ...EMPTY_COMPANION_MEMORY },
      wizardAlreadyRan: false,
      person: { firstName: 'Front', role: 'front_desk', sharedLogin: true },
    }));
    assert.ok(speech.kind === 'welcome');
    assert.equal(/Front/.test(speech.greeting), false);
  });

  test('the welcome is sized to the hat: a front desk hire is not told the owner story', () => {
    const forRole = (role: MannersInput['person']['role']) => {
      const s = decideCompanionSpeech(input({
        memory: { ...EMPTY_COMPANION_MEMORY },
        wizardAlreadyRan: false,
        person: { firstName: 'Sam', role, sharedLogin: false },
      }));
      assert.ok(s.kind === 'welcome');
      return s.greeting;
    };
    const owner = forRole('owner');
    const desk = forRole('front_desk');
    const maint = forRole('maintenance');
    assert.notEqual(owner, desk);
    assert.notEqual(desk, maint);
    // The owner is told about the hotel; the desk is told about the desk. If a
    // future edit collapses these into one sentence, this is what notices.
    assert.match(owner, /hotel/i);
    assert.match(desk, /desk/i);
  });

  test('never welcomes twice, even years later', () => {
    const welcomed = rememberWelcomed({ ...EMPTY_COMPANION_MEMORY }, NOON);
    const speech = decideCompanionSpeech(input({
      memory: { ...welcomed, tourDeclined: true },
      wizardAlreadyRan: false,
      candidates: [],
    }));
    assert.equal(speech.kind, 'silent');
  });

  test('rememberWelcomed does not move a stamp that already exists', () => {
    const first = rememberWelcomed({ ...EMPTY_COMPANION_MEMORY }, new Date('2026-01-01T00:00:00Z'));
    const again = rememberWelcomed(first, NOON);
    assert.equal(again.welcomedAt, first.welcomedAt);
  });

  test('the setup wizard owns the welcome: no second greeting stacked on it', () => {
    // The plausible bug is greeting somebody who has just walked through the
    // nine-step wizard, which is the app introducing itself twice in a minute.
    const speech = decideCompanionSpeech(input({
      memory: { ...EMPTY_COMPANION_MEMORY },
      wizardAlreadyRan: true,
    }));
    assert.equal(speech.kind, 'silent');
    assert.ok(speech.kind === 'silent');
    assert.equal(speech.reason, 'welcome_already_given_by_setup');
    // And it asks the caller to burn the stamp, so this branch is taken once
    // rather than on every page load forever.
    assert.equal(speech.markWelcomed, true);
  });

  test('an unanswered welcome owns the floor: no offer stacked on it the same day', () => {
    const speech = decideCompanionSpeech(input({
      memory: {
        ...EMPTY_COMPANION_MEMORY,
        welcomedAt: `${TODAY}T12:00:00.000Z`,
        tourDeclined: false,
        tourTakenAt: null,
      },
    }));
    assert.ok(speech.kind === 'silent');
    assert.equal(speech.reason, 'tour_still_pending');
  });

  test('once the tour is answered, the floor is free again', () => {
    for (const answered of [
      rememberTourDeclined({ ...EMPTY_COMPANION_MEMORY, welcomedAt: `${TODAY}T12:00:00.000Z` }),
      rememberTourTaken({ ...EMPTY_COMPANION_MEMORY, welcomedAt: `${TODAY}T12:00:00.000Z` }, NOON),
    ]) {
      const speech = decideCompanionSpeech(input({ memory: answered }));
      assert.equal(speech.kind, 'offer');
    }
  });
});

// ─── Quiet by default ───────────────────────────────────────────────────────

describe('quiet by default', () => {
  test('says nothing when there is nothing concrete to say', () => {
    const speech = decideCompanionSpeech(input({ candidates: [] }));
    assert.ok(speech.kind === 'silent');
    assert.equal(speech.reason, 'nothing_to_say');
  });

  test('never speaks while somebody is typing or mid-form', () => {
    const speech = decideCompanionSpeech(input({ userIsBusy: true }));
    assert.ok(speech.kind === 'silent');
    assert.equal(speech.reason, 'user_is_busy');
  });

  test('busy beats the welcome too: a first greeting does not land mid-sentence', () => {
    const speech = decideCompanionSpeech(input({
      memory: { ...EMPTY_COMPANION_MEMORY },
      wizardAlreadyRan: false,
      userIsBusy: true,
    }));
    assert.ok(speech.kind === 'silent');
    assert.equal(speech.reason, 'user_is_busy');
  });

  test('asked for quiet means quiet, including on day one', () => {
    const speech = decideCompanionSpeech(input({
      memory: { ...EMPTY_COMPANION_MEMORY },
      wizardAlreadyRan: false,
      quietThisSession: true,
    }));
    assert.ok(speech.kind === 'silent');
    assert.equal(speech.reason, 'quiet_this_session');
  });

  test('one thing at a time: three candidates produce one offer', () => {
    const speech = decideCompanionSpeech(input({
      candidates: [
        candidate({ topic: 'a', covers: ['finding:1'] }),
        candidate({ topic: 'b', covers: ['finding:2'] }),
        candidate({ topic: 'c', covers: ['finding:3'] }),
      ],
    }));
    assert.ok(speech.kind === 'offer');
    assert.equal(speech.topic, 'a');
  });

  test('a candidate with no words is skipped, not spoken as a blank', () => {
    const speech = decideCompanionSpeech(input({
      candidates: [
        candidate({ topic: 'blank', text: '   ' }),
        candidate({ topic: 'real', text: 'The pool pump is overdue.' }),
      ],
    }));
    assert.ok(speech.kind === 'offer');
    assert.equal(speech.topic, 'real');
  });
});

// ─── Frequency ──────────────────────────────────────────────────────────────

describe('the frequency cap', () => {
  test('stops at the cap, not one past it', () => {
    // The plausible bug is `>` where `>=` belongs, which ships a companion that
    // speaks one more time a day than anybody agreed to.
    const atCap = decideCompanionSpeech(input({
      memory: {
        ...EMPTY_COMPANION_MEMORY,
        welcomedAt: '2026-07-01T00:00:00.000Z',
        tourDeclined: true,
        spokenDay: TODAY,
        spokenCount: COMPANION_MAX_SPEECH_PER_DAY,
        lastSpokeAt: '2026-07-31T00:00:00.000Z',
      },
    }));
    assert.ok(atCap.kind === 'silent');
    assert.equal(atCap.reason, 'daily_cap_reached');

    const belowCap = decideCompanionSpeech(input({
      memory: {
        ...EMPTY_COMPANION_MEMORY,
        welcomedAt: '2026-07-01T00:00:00.000Z',
        tourDeclined: true,
        spokenDay: TODAY,
        spokenCount: COMPANION_MAX_SPEECH_PER_DAY - 1,
        lastSpokeAt: '2026-07-31T00:00:00.000Z',
      },
    }));
    assert.equal(belowCap.kind, 'offer');
  });

  test('yesterday\'s count does not spend today\'s budget', () => {
    // The count is stored with the day it belongs to. A companion that read the
    // count without the day would go silent for good after one busy Tuesday.
    const speech = decideCompanionSpeech(input({
      memory: {
        ...EMPTY_COMPANION_MEMORY,
        welcomedAt: '2026-07-01T00:00:00.000Z',
        tourDeclined: true,
        spokenDay: '2026-07-31',
        spokenCount: 99,
        lastSpokeAt: '2026-07-31T00:00:00.000Z',
      },
    }));
    assert.equal(speech.kind, 'offer');
  });

  test('honours the minimum gap between two messages', () => {
    const justSpoke = new Date(NOON.getTime() - (COMPANION_MIN_GAP_MINUTES - 1) * 60_000);
    const tooSoon = decideCompanionSpeech(input({
      memory: {
        ...EMPTY_COMPANION_MEMORY,
        welcomedAt: '2026-07-01T00:00:00.000Z',
        tourDeclined: true,
        lastSpokeAt: justSpoke.toISOString(),
        spokenDay: TODAY,
        spokenCount: 1,
      },
    }));
    assert.ok(tooSoon.kind === 'silent');
    assert.equal(tooSoon.reason, 'too_soon_after_last');

    const longEnough = new Date(NOON.getTime() - (COMPANION_MIN_GAP_MINUTES + 1) * 60_000);
    const ok = decideCompanionSpeech(input({
      memory: {
        ...EMPTY_COMPANION_MEMORY,
        welcomedAt: '2026-07-01T00:00:00.000Z',
        tourDeclined: true,
        lastSpokeAt: longEnough.toISOString(),
        spokenDay: TODAY,
        spokenCount: 1,
      },
    }));
    assert.equal(ok.kind, 'offer');
  });

  test('a clock that jumped backwards does not silence the companion forever', () => {
    // lastSpokeAt in the future produces a negative gap. Treating that as "too
    // soon" would mute somebody until the stamp aged out, which could be days.
    const speech = decideCompanionSpeech(input({
      memory: {
        ...EMPTY_COMPANION_MEMORY,
        welcomedAt: '2026-07-01T00:00:00.000Z',
        tourDeclined: true,
        lastSpokeAt: '2027-01-01T00:00:00.000Z',
        spokenDay: TODAY,
        spokenCount: 1,
      },
    }));
    assert.equal(speech.kind, 'offer');
  });
});

// ─── One voice ──────────────────────────────────────────────────────────────

describe('the one-voice rule', () => {
  test('never announces something a card on this screen is already showing', () => {
    const speech = decideCompanionSpeech(input({
      candidates: [candidate({ covers: ['finding:abc'] })],
      onScreen: ['finding:abc'],
    }));
    assert.ok(speech.kind === 'silent');
    assert.equal(speech.reason, 'nothing_to_say');
  });

  test('falls through to the next candidate rather than going silent', () => {
    const speech = decideCompanionSpeech(input({
      candidates: [
        candidate({ topic: 'onscreen', covers: ['finding:abc'] }),
        candidate({ topic: 'offscreen', covers: ['finding:xyz'] }),
      ],
      onScreen: ['finding:abc'],
    }));
    assert.ok(speech.kind === 'offer');
    assert.equal(speech.topic, 'offscreen');
  });
});

// ─── Shoulder safety ────────────────────────────────────────────────────────

describe('shoulder safety', () => {
  test('people-sensitive things never speak first', () => {
    // Wages, complaints and how one person is doing. Screens get read over
    // shoulders at a front desk, and an unprompted card is the one message
    // nobody chose to open.
    const speech = decideCompanionSpeech(input({
      candidates: [candidate({ topic: 'wages', sensitivity: 'people' })],
    }));
    assert.ok(speech.kind === 'silent');
    assert.equal(speech.reason, 'nothing_to_say');
  });

  test('a people-sensitive candidate does not block the operational one behind it', () => {
    const speech = decideCompanionSpeech(input({
      candidates: [
        candidate({ topic: 'wages', sensitivity: 'people' }),
        candidate({ topic: 'linen', sensitivity: 'operational' }),
      ],
    }));
    assert.ok(speech.kind === 'offer');
    assert.equal(speech.topic, 'linen');
  });
});

// ─── Multi-hotel ────────────────────────────────────────────────────────────

describe('multi-hotel', () => {
  test('names the hotel when this person runs more than one', () => {
    const speech = decideCompanionSpeech(input({
      multiHotel: true,
      hotelName: 'Comfort Suites Beaumont',
    }));
    assert.ok(speech.kind === 'offer');
    assert.match(speech.sentence, /Comfort Suites Beaumont/);
  });

  test('does not name the hotel to somebody who only has one', () => {
    const speech = decideCompanionSpeech(input({ multiHotel: false }));
    assert.ok(speech.kind === 'offer');
    assert.equal(/Comfort Suites/.test(speech.sentence), false);
  });
});

// ─── Asleep ─────────────────────────────────────────────────────────────────

describe('the sleep state', () => {
  test('an asleep companion says nothing at all, including hello', () => {
    for (const memory of [{ ...EMPTY_COMPANION_MEMORY }, { ...EMPTY_COMPANION_MEMORY, welcomedAt: '2026-07-01T00:00:00.000Z', tourDeclined: true }]) {
      const speech = decideCompanionSpeech(input({ memory, aiAwake: false, wizardAlreadyRan: false }));
      assert.ok(speech.kind === 'silent');
      assert.equal(speech.reason, 'ai_asleep');
    }
  });
});

// ─── A No ───────────────────────────────────────────────────────────────────

describe('a No', () => {
  test('the same offer does not come back the same day', () => {
    const spoke = rememberSpoke({
      ...EMPTY_COMPANION_MEMORY,
      welcomedAt: '2026-07-01T00:00:00.000Z',
      tourDeclined: true,
    }, 'finding:linen_below_par', NOON, TODAY);
    const declined = rememberDeclined(spoke, 'finding:linen_below_par', TODAY);

    const later = new Date(NOON.getTime() + (COMPANION_MIN_GAP_MINUTES + 10) * 60_000);
    const speech = decideCompanionSpeech(input({ memory: declined, now: later }));
    assert.ok(speech.kind === 'silent');
    assert.equal(speech.reason, 'nothing_to_say');
  });

  test('two Nos on a topic drop it permanently, on every future day', () => {
    let memory: CompanionMemory = {
      ...EMPTY_COMPANION_MEMORY,
      welcomedAt: '2026-07-01T00:00:00.000Z',
      tourDeclined: true,
    };
    for (let i = 0; i < COMPANION_DECLINES_BEFORE_DROP; i++) {
      memory = rememberDeclined(memory, 'finding:linen_below_par', `2026-07-0${i + 1}`);
    }
    assert.equal(memory.topics['finding:linen_below_par'].dropped, true);

    // A different day, a fresh budget, the same topic. Still nothing.
    const speech = decideCompanionSpeech(input({ memory, today: '2026-09-15' }));
    assert.ok(speech.kind === 'silent');
    assert.equal(speech.reason, 'nothing_to_say');
  });

  test('one No is not two: the topic survives a single decline', () => {
    const memory = rememberDeclined({
      ...EMPTY_COMPANION_MEMORY,
      welcomedAt: '2026-07-01T00:00:00.000Z',
      tourDeclined: true,
    }, 'finding:linen_below_par', '2026-07-20');
    assert.equal(memory.topics['finding:linen_below_par'].dropped, false);
    const speech = decideCompanionSpeech(input({ memory }));
    assert.equal(speech.kind, 'offer');
  });

  test('re-offering a topic does not wipe the declines it already collected', () => {
    // The plausible bug: rememberSpoke rebuilding the topic entry from scratch,
    // which would reset the counter every time the offer came back and make
    // "dropped permanently" unreachable.
    let memory: CompanionMemory = { ...EMPTY_COMPANION_MEMORY };
    memory = rememberDeclined(memory, 'topic', '2026-07-01');
    memory = rememberSpoke(memory, 'topic', NOON, TODAY);
    assert.equal(memory.topics.topic.declines, 1);
    memory = rememberDeclined(memory, 'topic', TODAY);
    assert.equal(memory.topics.topic.dropped, true);
  });

  test('a Yes forgives the declines but cannot resurrect a dropped topic', () => {
    const live = rememberAccepted(
      rememberDeclined({ ...EMPTY_COMPANION_MEMORY }, 'topic', '2026-07-01'),
      'topic',
      TODAY,
    );
    assert.equal(live.topics.topic.declines, 0);

    let dropped: CompanionMemory = { ...EMPTY_COMPANION_MEMORY };
    for (let i = 0; i < COMPANION_DECLINES_BEFORE_DROP; i++) {
      dropped = rememberDeclined(dropped, 'topic', `2026-07-0${i + 1}`);
    }
    const after = rememberAccepted(dropped, 'topic', TODAY);
    assert.equal(after.topics.topic.dropped, true);
  });

  test('a No to the tour is permanent', () => {
    const memory = rememberTourDeclined(rememberWelcomed({ ...EMPTY_COMPANION_MEMORY }, NOON));
    const speech = decideCompanionSpeech(input({ memory, candidates: [] }));
    assert.ok(speech.kind === 'silent');
    assert.notEqual(speech.reason, 'tour_still_pending');
  });
});

// ─── Teach at the moment ────────────────────────────────────────────────────

describe('teach at the moment', () => {
  const teachInput = (over: Partial<Parameters<typeof decideTeachMoment>[0]> = {}) => ({
    flow: 'create_task' as const,
    memory: { ...EMPTY_COMPANION_MEMORY },
    role: 'general_manager' as const,
    userIsBusy: false,
    quietThisSession: false,
    aiAwake: true,
    ...over,
  });

  test('teaches once, with a concrete example somebody could actually say', () => {
    const decision = decideTeachMoment(teachInput());
    assert.ok(decision.teach);
    assert.ok(decision.text.length > 0);
    assert.ok(decision.example.length > 0);
    // A tip that says "you can just tell me" and then shows no example is a tip
    // nobody can act on.
    assert.notEqual(decision.text, decision.example);
  });

  test('never twice: once taught, permanently taught', () => {
    const first = decideTeachMoment(teachInput());
    assert.ok(first.teach);
    const memory = rememberTaught({ ...EMPTY_COMPANION_MEMORY }, 'create_task');
    const second = decideTeachMoment(teachInput({ memory }));
    assert.equal(second.teach, false);
    assert.ok(!second.teach);
    assert.equal(second.refusal, 'already_taught');
  });

  test('being taught one flow does not spend the tip for another', () => {
    const memory = rememberTaught({ ...EMPTY_COMPANION_MEMORY }, 'create_task');
    const other = decideTeachMoment(teachInput({ memory, flow: 'log_book_entry' }));
    assert.equal(other.teach, true);
  });

  test('never while somebody is typing', () => {
    const decision = decideTeachMoment(teachInput({ userIsBusy: true }));
    assert.equal(decision.teach, false);
    assert.ok(!decision.teach);
    assert.equal(decision.refusal, 'user_is_busy');
  });

  test('never after somebody asked for quiet, and never while asleep', () => {
    assert.equal(decideTeachMoment(teachInput({ quietThisSession: true })).teach, false);
    assert.equal(decideTeachMoment(teachInput({ aiAwake: false })).teach, false);
  });

  test('never teaches a hat a sentence its own role would be refused for', () => {
    // post_announcement is a manager act. Telling the front desk "just tell me
    // and I will post it" teaches them to try something that gets turned down,
    // which is worse than teaching them nothing.
    const desk = decideTeachMoment(teachInput({ role: 'front_desk', flow: 'announcement' }));
    assert.equal(desk.teach, false);
    assert.ok(!desk.teach);
    assert.equal(desk.refusal, 'flow_not_available_to_role');
    // But the flows they CAN reach still teach.
    assert.equal(decideTeachMoment(teachInput({ role: 'front_desk', flow: 'create_task' })).teach, true);
  });

  test('rememberTaught is idempotent', () => {
    const once = rememberTaught({ ...EMPTY_COMPANION_MEMORY }, 'create_task');
    assert.equal(rememberTaught(once, 'create_task'), once);
  });
});

// ─── The memory blob ────────────────────────────────────────────────────────

describe('parseCompanionMemory', () => {
  test('anything unreadable becomes the empty memory rather than throwing', () => {
    for (const junk of [null, undefined, 'string', 42, [], true]) {
      const parsed = parseCompanionMemory(junk);
      assert.deepEqual(parsed.topics, {});
      assert.deepEqual(parsed.taught, {});
      assert.equal(parsed.welcomedAt, null);
    }
  });

  test('a forged welcome stamp that is not a date is refused', () => {
    // The column is jsonb and one of its writers is a request body. A stamp of
    // "yes" must not read as "already welcomed" and silently delete somebody's
    // first-run experience.
    assert.equal(parseCompanionMemory({ welcomedAt: 'yes' }).welcomedAt, null);
    assert.equal(parseCompanionMemory({ welcomedAt: 12345 }).welcomedAt, null);
    assert.equal(
      parseCompanionMemory({ welcomedAt: '2026-07-01T00:00:00.000Z' }).welcomedAt,
      '2026-07-01T00:00:00.000Z',
    );
  });

  test('taught only ever accepts true, so a rule cannot be un-taught by a body', () => {
    const parsed = parseCompanionMemory({ taught: { create_task: false, announcement: true, x: 'yes' } });
    assert.deepEqual(parsed.taught, { announcement: true });
  });

  test('a garbage day string does not become a day', () => {
    assert.equal(parseCompanionMemory({ spokenDay: 'today' }).spokenDay, null);
    assert.equal(parseCompanionMemory({ spokenDay: '2026-08-01' }).spokenDay, '2026-08-01');
  });

  test('counters are clamped, never negative, never unbounded', () => {
    assert.equal(parseCompanionMemory({ spokenCount: -5 }).spokenCount, 0);
    assert.equal(parseCompanionMemory({ spokenCount: 1e9 }).spokenCount, 99);
    assert.equal(parseCompanionMemory({ spokenCount: 'lots' }).spokenCount, 0);
  });

  test('an over-long topic key is dropped rather than stored unusably', () => {
    const parsed = parseCompanionMemory({
      topics: { ['x'.repeat(500)]: { declines: 1 }, ok: { declines: 1 } },
    });
    assert.deepEqual(Object.keys(parsed.topics), ['ok']);
  });

  test('the blob stays bounded, and a No survives the pruning', () => {
    // The rule that matters: forgetting somebody said No is the failure that
    // annoys people, so dropped topics outrank live ones when the cap bites.
    const topics: Record<string, unknown> = { keepme: { declines: 2, dropped: true } };
    for (let i = 0; i < COMPANION_MEMORY_TOPIC_CAP + 40; i++) {
      topics[`live${i}`] = { declines: 0, dropped: false };
    }
    const parsed = parseCompanionMemory({ topics });
    assert.equal(Object.keys(parsed.topics).length, COMPANION_MEMORY_TOPIC_CAP);
    assert.equal(parsed.topics.keepme?.dropped, true);
  });

  test('round-trips a real memory without losing anything', () => {
    let memory: CompanionMemory = rememberWelcomed({ ...EMPTY_COMPANION_MEMORY }, NOON);
    memory = rememberTourDeclined(memory);
    memory = rememberSpoke(memory, 'topic', NOON, TODAY);
    memory = rememberDeclined(memory, 'topic', TODAY);
    memory = rememberTaught(memory, 'create_task');
    assert.deepEqual(parseCompanionMemory(JSON.parse(JSON.stringify(memory))), memory);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// One hello a day
// ═══════════════════════════════════════════════════════════════════════════
//
// The companion says hello once per hotel-local day, on the first screen with a
// companion on it, whether or not anything is wrong. Everything that can go
// wrong with that is a repeat: four screens before lunch is one person having
// one day, not four page loads each owed a greeting.
//
// THE DAY IS THE HOTEL'S. `today` arrives from propertyLocalToday(now, the
// hotel's timezone) and never from the browser clock, so a night auditor at 1am
// and a GM at 9am are correctly on different days by the calendar the rest of
// the product already counts by.
//
// And the greeting may contain a number ONLY when it was handed one. There is
// no model call anywhere in this path; it is a template over three values.

function hello(over: Partial<HelloInput> = {}): HelloInput {
  return {
    today: TODAY,
    person: { firstName: 'Maria', sharedLogin: false },
    memory: { ...EMPTY_COMPANION_MEMORY, welcomedAt: '2026-07-01T12:00:00.000Z' },
    hour: 9,
    waiting: 0,
    userIsBusy: false,
    quietThisSession: false,
    aiAwake: true,
    ...over,
  };
}

describe('one hello a day', () => {
  test('says hello on the first screen of the day, even when nothing is wrong', () => {
    const d = decideDailyHello(hello());
    assert.equal(d.hello, true);
    assert.equal(d.hello && d.line, 'Good morning, Maria. All quiet so far.');
  });

  test('the second screen of the same day gets nothing', () => {
    const first = decideDailyHello(hello());
    assert.equal(first.hello, true);
    const after = rememberGreeted(hello().memory, TODAY);
    assert.equal(decideDailyHello(hello({ memory: after })).hello, false);
    // ...and every later load that day, however many.
    for (let i = 0; i < 5; i += 1) {
      assert.equal(decideDailyHello(hello({ memory: after })).hello, false);
    }
  });

  test('tomorrow gets its own hello', () => {
    const after = rememberGreeted(hello().memory, TODAY);
    const tomorrow = decideDailyHello(hello({ memory: after, today: '2026-08-02' }));
    assert.equal(tomorrow.hello, true);
  });

  test('the day that counts is the hotel\'s, not the browser\'s', () => {
    // 1:00am at the hotel is still yesterday's stamp if the hotel says so. The
    // guard compares the string the server resolved from properties.timezone;
    // nothing here may reach for a Date.
    const stamped = rememberGreeted(EMPTY_COMPANION_MEMORY, '2026-08-01');
    assert.equal(stamped.greetedDay, '2026-08-01');
    assert.equal(decideDailyHello(hello({
      memory: { ...stamped, welcomedAt: '2026-07-01T12:00:00.000Z' },
      today: '2026-08-01',
    })).hello, false);
    assert.equal(decideDailyHello(hello({
      memory: { ...stamped, welcomedAt: '2026-07-01T12:00:00.000Z' },
      today: '2026-07-31',
    })).hello, true, 'a different hotel-day is a different day, in either direction');
  });

  test('greets by the hotel\'s clock, not by a guess', () => {
    assert.match((decideDailyHello(hello({ hour: 7 })) as { line: string }).line, /^Good morning/);
    assert.match((decideDailyHello(hello({ hour: 14 })) as { line: string }).line, /^Good afternoon/);
    assert.match((decideDailyHello(hello({ hour: 21 })) as { line: string }).line, /^Good evening/);
    // No timezone means no claim about the time of day.
    assert.match((decideDailyHello(hello({ hour: null })) as { line: string }).line, /^Hello/);
  });

  test('says a number only when it was given one, and never invents it', () => {
    const quiet = decideDailyHello(hello({ waiting: 0 })) as { line: string };
    assert.doesNotMatch(quiet.line, /\d/, `no count may appear: ${quiet.line}`);
    assert.match(quiet.line, /All quiet so far\./);

    assert.match((decideDailyHello(hello({ waiting: 1 })) as { line: string }).line, /1 thing is waiting on you\./);
    assert.match((decideDailyHello(hello({ waiting: 4 })) as { line: string }).line, /4 things are waiting on you\./);
    // The count is the one it was handed, never a rounded or decorated version.
    assert.equal(todayFact({ waiting: 12 }), '12 things are waiting on you.');
    assert.equal(todayFact({ waiting: 0 }), null);
  });

  test('a shared login is greeted without somebody else\'s name', () => {
    const d = decideDailyHello(hello({ person: { firstName: 'Front', sharedLogin: true } })) as { line: string };
    assert.doesNotMatch(d.line, /Front/);
    assert.match(d.line, /^Good morning\./);
  });

  test('never while somebody is typing, never after a quiet, never while asleep', () => {
    assert.deepEqual(decideDailyHello(hello({ userIsBusy: true })), { hello: false, refusal: 'user_is_busy' });
    assert.deepEqual(decideDailyHello(hello({ quietThisSession: true })), { hello: false, refusal: 'quiet_this_session' });
    assert.deepEqual(decideDailyHello(hello({ aiAwake: false })), { hello: false, refusal: 'ai_asleep' });
  });

  test('day one belongs to the welcome: no hello stacked on a first hello', () => {
    const brandNew = decideDailyHello(hello({ memory: EMPTY_COMPANION_MEMORY }));
    assert.deepEqual(brandNew, { hello: false, refusal: 'welcome_owns_today' });
  });

  test('the hello does not spend the day\'s speech budget', () => {
    // The cap exists to stop the companion volunteering findings all day. A
    // greeting is not a finding, and burning a slot on it would silence the
    // thing that actually mattered at 4pm.
    const greeted = rememberGreeted(
      { ...EMPTY_COMPANION_MEMORY, welcomedAt: '2026-07-01T12:00:00.000Z', tourDeclined: true },
      TODAY,
    );
    assert.equal(greeted.spokenCount, 0);
    assert.equal(greeted.lastSpokeAt, null);
    const speech = decideCompanionSpeech(input({ memory: greeted }));
    assert.equal(speech.kind, 'offer', 'the day\'s real message must still be available');
  });

  test('the stamp is idempotent, and survives a round trip through the blob', () => {
    const once = rememberGreeted(EMPTY_COMPANION_MEMORY, TODAY);
    assert.equal(rememberGreeted(once, TODAY), once, 'same day must not churn the memory');
    assert.equal(parseCompanionMemory(JSON.parse(JSON.stringify(once))).greetedDay, TODAY);
  });

  test('a forged day string is refused rather than stored as a day', () => {
    assert.equal(parseCompanionMemory({ greetedDay: 'tomorrow' }).greetedDay, null);
    assert.equal(parseCompanionMemory({ greetedDay: 99 }).greetedDay, null);
    // ...and a memory with no stamp at all still greets.
    assert.equal(decideDailyHello(hello({
      memory: { ...EMPTY_COMPANION_MEMORY, welcomedAt: '2026-07-01T12:00:00.000Z', greetedDay: null },
    })).hello, true);
  });
});
