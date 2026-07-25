/**
 * Drip questions — the policy that keeps Staxis from being obnoxious.
 *
 * This feature has exactly one way to fail badly: ask the same question twice.
 * A manager who answers "no" and gets asked again next Tuesday learns that the
 * card is noise and stops reading it, and every future question is worth less.
 * So the bulk of this file is the never-ask-again matrix, driven through the
 * real `selectQuestion` — the same function the route calls.
 *
 * The phrasing half is tested for one specific regression: a Spanish manager
 * silently getting English. The question is generated, not translated at render
 * time, so "the ES path produces ES" is a property of the builder and is pinned
 * here for every category.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  selectQuestion,
  phraseSignal,
  MAX_ASKS_PER_TOPIC,
  type AskRecord,
} from '@/lib/agent/drip-questions';
import type { OperationalSignal } from '@/lib/agent/operational-signals';
import {
  alreadyAskedThisSession,
  markAskedThisSession,
  dripSessionKey,
  type SessionStore,
} from '@/lib/drip-question-session';

const TODAY = '2026-07-25';
const YESTERDAY = '2026-07-24';

function signal(over: Partial<OperationalSignal> = {}): OperationalSignal {
  return {
    topic: 'op_maint_214_hvac',
    category: 'maintenance',
    severity: 'attention',
    targetLabel: 'Room 214',
    metric: '4 hvac work orders in 30 days',
    count: 4,
    windowDays: 30,
    targetKind: 'room',
    targetValue: '214',
    detail: 'hvac',
    ...over,
  };
}

function record(over: Partial<AskRecord> = {}): AskRecord {
  return {
    topic: 'op_maint_214_hvac',
    status: 'asked',
    lastAskedOn: YESTERDAY,
    askCount: 1,
    ...over,
  };
}

function pick(over: Partial<Parameters<typeof selectQuestion>[0]> = {}) {
  return selectQuestion({
    signals: [signal()],
    records: [],
    deactivatedTopics: [],
    today: TODAY,
    ...over,
  });
}

// ─── one question, never a queue ────────────────────────────────────────────

describe('drip questions: at most one, ever', () => {
  test('five eligible patterns still produce exactly one question', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((k, i) =>
      signal({ topic: `op_maint_${k}`, targetValue: `20${i}` }),
    );
    const chosen = pick({ signals: many });
    assert.ok(chosen, 'something should be asked');
    // The contract is a single object, not a list — there is no shape here that
    // could carry a second question to the client.
    assert.equal(typeof chosen.topic, 'string');
    assert.equal(chosen.topic, 'op_maint_a', 'the highest-ranked signal wins');
  });

  test('no signals at all — a brand-new hotel is never asked anything', () => {
    assert.equal(pick({ signals: [] }), null);
  });
});

// ─── never ask again ────────────────────────────────────────────────────────

describe('drip questions: a question is never asked twice', () => {
  test('an ANSWERED question is never asked again', () => {
    assert.equal(
      pick({ records: [record({ status: 'answered_yes', lastAskedOn: '2026-01-01' })] }),
      null,
      'a confirmed fact must not be re-confirmed',
    );
  });

  test('a DECLINED question is never asked again — the obnoxiousness regression', () => {
    assert.equal(
      pick({ records: [record({ status: 'declined', lastAskedOn: '2026-01-01' })] }),
      null,
      'the manager already said no; asking again is the whole failure mode',
    );
  });

  test('a declined question stays declined even years later', () => {
    assert.equal(
      pick({
        records: [record({ status: 'declined', lastAskedOn: '2020-01-01', askCount: 1 })],
        today: '2030-06-06',
      }),
      null,
    );
  });

  test('an IGNORED question does not reappear the same day', () => {
    assert.equal(
      pick({ records: [record({ status: 'asked', lastAskedOn: TODAY, askCount: 1 })] }),
      null,
    );
  });

  test('an ignored question may return on a LATER day', () => {
    const chosen = pick({ records: [record({ status: 'asked', lastAskedOn: YESTERDAY, askCount: 1 })] });
    assert.ok(chosen, 'a new day is a fair second try');
    assert.equal(chosen.topic, 'op_maint_214_hvac');
  });

  test('after the ask cap it is dropped for good, even on a new day', () => {
    assert.equal(
      pick({
        records: [record({ status: 'asked', lastAskedOn: YESTERDAY, askCount: MAX_ASKS_PER_TOPIC })],
      }),
      null,
      'three unanswered asks is where asking stops being helpful',
    );
    // One below the cap still gets its last try — proves the boundary, not just
    // that some large number is refused.
    assert.ok(
      pick({
        records: [record({ status: 'asked', lastAskedOn: YESTERDAY, askCount: MAX_ASKS_PER_TOPIC - 1 })],
      }),
    );
  });

  test('a topic whose fact a human deleted is never turned into a question', () => {
    assert.equal(pick({ deactivatedTopics: ['op_maint_214_hvac'] }), null);
  });

  test('a blocked topic does not block the OTHERS — the next one is offered', () => {
    const chosen = pick({
      signals: [signal(), signal({ topic: 'op_maint_301_ac', targetValue: '301', detail: 'ac' })],
      records: [record({ status: 'declined' })],
    });
    assert.ok(chosen);
    assert.equal(chosen.topic, 'op_maint_301_ac');
  });

  test('records for OTHER topics never suppress this one', () => {
    const chosen = pick({ records: [record({ topic: 'op_maint_999_other', status: 'declined' })] });
    assert.ok(chosen);
    assert.equal(chosen.topic, 'op_maint_214_hvac');
  });
});

// ─── phrasing: EN and ES, both real ─────────────────────────────────────────

const CATEGORIES: Array<{ sig: OperationalSignal; esMarker: string }> = [
  { sig: signal(), esMarker: 'habitación' },
  {
    sig: signal({
      topic: 'op_complaint_214_noise',
      category: 'complaint',
      detail: 'noise',
      metric: '3 noise complaints in 30 days',
      count: 3,
    }),
    esMarker: 'habitación',
  },
  {
    sig: signal({
      topic: 'op_noise_floor_2',
      category: 'noise',
      targetKind: 'floor',
      targetValue: '2',
      targetLabel: 'Floor 2',
      detail: 'noise',
      count: 5,
    }),
    esMarker: 'piso',
  },
  {
    sig: signal({
      topic: 'op_inspect_fail_214',
      category: 'inspection',
      detail: null,
      count: 3,
    }),
    esMarker: 'habitación',
  },
  {
    sig: signal({ topic: 'op_clean_slow_214', category: 'cleaning', severity: 'info', detail: null }),
    esMarker: 'habitación',
  },
];

describe('drip questions: the Spanish path is Spanish', () => {
  for (const { sig, esMarker } of CATEGORIES) {
    test(`${sig.category}: both languages are produced, and ES is not an English fallback`, () => {
      const p = phraseSignal(sig);
      assert.ok(p, `${sig.category} must be phraseable`);
      assert.notEqual(p.es, p.en, 'ES must not be the English string handed through');
      assert.ok(p.es.includes(esMarker), `ES should say "${esMarker}", got: ${p.es}`);
      assert.ok(
        p.es.includes(String(sig.targetValue)),
        'ES must name the same room/floor the manager sees in EN',
      );
      assert.ok(p.en.includes(String(sig.targetValue)), 'EN must name the room/floor');
      assert.ok(p.en.trim().endsWith('?'), 'EN must actually be a question');
      assert.ok(p.es.trim().endsWith('?'), 'ES must actually be a question');
    });
  }

  test('the question carries the real evidence, not a vague nudge', () => {
    const p = phraseSignal(signal({ count: 4, detail: 'hvac', targetValue: '214' }));
    assert.ok(p);
    assert.ok(p.en.includes('4'), 'the count is the reason the manager should care');
    assert.ok(p.en.includes('hvac'));
    assert.ok(p.en.includes('214'));
    assert.ok(p.es.includes('4') && p.es.includes('214'));
  });

  test('a free-text PMS category is carried verbatim rather than mistranslated', () => {
    const p = phraseSignal(signal({ detail: 'ice machine' }));
    assert.ok(p);
    assert.ok(p.en.includes('ice machine'));
    assert.ok(p.es.includes('ice machine'), 'unknown categories pass through, they are not guessed at');
  });

  test('an uninformative "other" category is dropped from the wording', () => {
    const p = phraseSignal(signal({ detail: 'other' }));
    assert.ok(p);
    assert.ok(!p.en.includes('other'), `should not say "other": ${p.en}`);
    assert.ok(p.en.includes('work orders'));
  });

  test('a pattern with no room or floor is not phrased, and is skipped', () => {
    assert.equal(phraseSignal(signal({ targetKind: null, targetValue: null })), null);
    const chosen = pick({
      signals: [signal({ targetKind: null, targetValue: null }), signal({ topic: 'op_maint_7_ac', targetValue: '7' })],
    });
    assert.ok(chosen, 'an unphraseable signal must not block the next one');
    assert.equal(chosen.topic, 'op_maint_7_ac');
  });

  test('hostile text in a work-order category cannot smuggle markup into the fact', () => {
    const p = phraseSignal(signal({ detail: '<script>alert(1)</script>', targetValue: '2*1/4' }));
    assert.ok(p);
    for (const text of [p.en, p.es, p.fact]) {
      assert.ok(!text.includes('<'), `angle brackets must be stripped: ${text}`);
      assert.ok(!text.includes('>'), `angle brackets must be stripped: ${text}`);
    }
  });
});

// ─── what a "yes" actually stores ───────────────────────────────────────────

describe('drip questions: a "yes" becomes a real, specific fact', () => {
  test('the stored fact names the room and marks it as a manager confirmation', () => {
    const p = phraseSignal(signal({ targetValue: '214', detail: 'hvac', count: 4 }));
    assert.ok(p);
    assert.ok(p.fact.includes('214'), 'a fact that does not name the room is useless to the copilot');
    assert.ok(p.fact.includes('hvac'));
    assert.ok(/confirmed by a manager/i.test(p.fact), 'the copilot must know a human said this');
    assert.ok(p.fact.length <= 500, 'agent_memory.content CHECK is 500');
  });

  test('every category produces a distinct, non-empty fact within the column limits', () => {
    const facts = new Set<string>();
    for (const { sig } of CATEGORIES) {
      const p = phraseSignal(sig);
      assert.ok(p, `${sig.category} must phrase`);
      assert.ok(p.fact.trim().length > 0);
      assert.ok(p.fact.length <= 500);
      assert.ok(p.en.length <= 300 && p.es.length <= 300, 'question_* CHECK is 300');
      facts.add(p.fact);
    }
    assert.equal(facts.size, CATEGORIES.length, 'each category says something different');
  });
});

// ─── the per-session gate ───────────────────────────────────────────────────

function fakeStore(): SessionStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

describe('drip questions: one per session', () => {
  const PID = 'aaaaaaaa-0000-4000-8000-000000000001';
  const OTHER = 'bbbbbbbb-0000-4000-8000-000000000001';

  test('a fresh session may ask; a spent one may not', () => {
    const store = fakeStore();
    assert.equal(alreadyAskedThisSession(store, PID), false);
    markAskedThisSession(store, PID);
    assert.equal(alreadyAskedThisSession(store, PID), true, 'the session gets exactly one');
    markAskedThisSession(store, PID);
    assert.equal(alreadyAskedThisSession(store, PID), true, 'marking twice is harmless');
  });

  test('the gate is per hotel — switching properties is a different question', () => {
    const store = fakeStore();
    markAskedThisSession(store, PID);
    assert.equal(alreadyAskedThisSession(store, OTHER), false);
    assert.notEqual(dripSessionKey(PID), dripSessionKey(OTHER));
  });

  test('no store (SSR, or a browser that blocks it) means ask NOTHING', () => {
    assert.equal(alreadyAskedThisSession(null, PID), true, 'quieter, never chattier');
    assert.doesNotThrow(() => markAskedThisSession(null, PID));
  });

  test('a store that throws is treated as spent rather than crashing the screen', () => {
    const hostile: SessionStore = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceededError'); },
    };
    assert.equal(alreadyAskedThisSession(hostile, PID), true);
    assert.doesNotThrow(() => markAskedThisSession(hostile, PID));
  });
});
