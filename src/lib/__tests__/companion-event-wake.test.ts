/**
 * The gate, the contract, and the two ceilings.
 *
 * Everything in here is about the half of the feature that must be provable
 * WITHOUT a database and without a provider: whether the companion is allowed
 * to spend money, and what it is allowed to say if it does. The other half, the
 * half that needs real trigger-written rows and a real cursor, lives in
 * companion-event-wake.integration.test.ts.
 *
 * The bar every test here is written to: would it fail if I introduced a
 * plausible bug? Several of these are written adversarially on purpose, because
 * the failure modes they cover (a self-feeding loop, an uncapped background
 * spender, a sentence with an invented number in it) are the ones that are
 * expensive rather than merely wrong.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { MessagesClient, UsageReport } from '@/lib/agent/llm';
import { AGENT_JOURNAL_SOURCE, journalNoticedLine, journalObservedLine } from '@/lib/agent/journal';
import {
  INTERESTING_EVENT_TYPES,
  MAX_LOOKBACK_MINUTES,
  MAX_WAKES_PER_DAY,
  decideWake,
  isInterestingEvent,
  keepEnabledSections,
  wakeTopicFor,
  wakeWindow,
  type WakeEventRow,
} from '@/lib/companion/event-wake/events';
import {
  MAX_NOTICE_CHARS,
  WAKE_RESERVATION_USD,
  askWhatToPrepare,
  parseWakeReplyStrict,
  wakeReceipt,
  type WakeCallDeps,
} from '@/lib/companion/event-wake/notice';
import { checkProse } from '@/lib/findings/prose-guard';
import { FEATURE_CAP_SHARE, featureCapUsd } from '@/lib/findings/judge-budget';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const PID = 'aaaaaaaa-0000-4000-8000-000000000001';

function event(over: Partial<WakeEventRow> = {}): WakeEventRow {
  return {
    occurredAt: '2026-08-06T15:00:00.000Z',
    eventCategory: 'maintenance',
    eventType: 'work_order_created',
    source: 'pms_sync',
    description: 'Work order created on Room 214, other (priority medium)',
    targetType: 'work_order',
    targetLabel: 'Room 214',
    metadata: { room_number: '214' },
    ...over,
  };
}

interface Recorder {
  client: MessagesClient;
  calls: number;
}

/** A scripted model. Replies are returned in order; a function throws. */
function scriptedModel(replies: Array<string | (() => never)>): Recorder {
  const rec: Recorder = {
    calls: 0,
    client: {
      messages: {
        create: async () => {
          const reply = replies[Math.min(rec.calls, replies.length - 1)];
          rec.calls += 1;
          if (typeof reply === 'function') reply();
          return {
            id: 'msg_test',
            model: 'claude-haiku-4-5-20251001',
            role: 'assistant',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: reply as string }],
            usage: { input_tokens: 900, output_tokens: 60 },
          };
        },
        stream: () => { throw new Error('the event sweep never streams'); },
      },
    } as unknown as MessagesClient,
  };
  return rec;
}

interface SpendLog {
  reserved: number;
  finalized: number;
  cancelled: number;
  booked: number;
}

function spendDeps(
  reserve: WakeCallDeps['reserve'],
): { deps: WakeCallDeps; log: SpendLog } {
  const log: SpendLog = { reserved: 0, finalized: 0, cancelled: 0, booked: 0 };
  return {
    log,
    deps: {
      reserve: async (propertyId: string, usd: number) => {
        log.reserved += 1;
        return reserve(propertyId, usd);
      },
      finalize: async () => { log.finalized += 1; },
      cancel: async () => { log.cancelled += 1; },
      bookCost: async () => { log.booked += 1; },
    },
  };
}

const allowingSpend: WakeCallDeps['reserve'] = async () => ({ ok: true, reservationId: 'res-1' });

// ═══════════════════════════════════════════════════════════════════════════
describe('the event gate', () => {
  test('every interesting event type is one a trigger actually writes', () => {
    // The list is short, closed, and every entry is checked against a real
    // trigger-written row in the integration suite. Here we only pin that
    // nothing has crept in that is obviously the wrong SHAPE — a source name, a
    // category, an agent event.
    for (const type of INTERESTING_EVENT_TYPES) {
      assert.ok(type.length > 0 && type === type.toLowerCase(), type);
      assert.ok(!type.startsWith('agent_'), `${type} is one of the companion's own events`);
    }
    assert.equal(new Set(INTERESTING_EVENT_TYPES).size, INTERESTING_EVENT_TYPES.length);
  });

  test('the routine hotel day never wakes anything', () => {
    // Every one of these is a real event_type a 0228 trigger writes, and every
    // one of them is the building working correctly. A watcher that fired on
    // these would interrupt a manager about rooms being cleaned.
    const routine = [
      'room_status_changed',
      'cleaning_task_created',
      'cleaning_task_completed',
      'cleaning_completed',
      'inspection_started',
      'inspection_pass',
      'work_order_resolved',
      'work_order_closed',
      'assignment_created',
      'break_started',
      'break_ended',
      'callout_reverted',
      'role_changed',
      'user_created',
    ];
    for (const eventType of routine) {
      assert.equal(
        isInterestingEvent({ source: 'pms_sync', eventType }),
        false,
        `${eventType} must not wake the companion`,
      );
    }
    const verdict = decideWake({
      rows: routine.map((eventType) => event({ eventType })),
      wakesToday: 0,
    });
    assert.deepEqual(verdict, { wake: false, refusal: 'quiet', events: 0 });
  });

  test('a work order opening wakes it', () => {
    const verdict = decideWake({ rows: [event()], wakesToday: 0 });
    assert.equal(verdict.wake, true);
    assert.equal(verdict.wake && verdict.events.length, 1);
  });

  // ═══ THE SELF-EXCITATION TEST ═══════════════════════════════════════════
  // Written adversarially: the row is given the companion's own source AND an
  // event type from the interesting list, which is a combination the query can
  // never return and application code should never trust anyway. If somebody
  // ever adds an agent event type to INTERESTING_EVENT_TYPES, or drops the
  // `.neq('source', ...)` from the query, this is what catches it.
  test('the companion never wakes on its own journal, however the row is dressed', () => {
    for (const eventType of ['agent_noticed', 'agent_said', ...INTERESTING_EVENT_TYPES]) {
      assert.equal(
        isInterestingEvent({ source: AGENT_JOURNAL_SOURCE, eventType }),
        false,
        `a staxis_agent row typed as "${eventType}" must never pass the gate`,
      );
    }
    const verdict = decideWake({
      rows: [
        event({ source: AGENT_JOURNAL_SOURCE, eventType: 'agent_noticed' }),
        event({ source: AGENT_JOURNAL_SOURCE, eventType: 'work_order_created' }),
      ],
      wakesToday: 0,
    });
    assert.deepEqual(
      verdict,
      { wake: false, refusal: 'quiet', events: 0 },
      'the companion talking to itself is the one loop this feature must not have',
    );
  });

  test('a real event beside the companion\'s own rows still wakes, and only it is carried', () => {
    const verdict = decideWake({
      rows: [
        event({ source: AGENT_JOURNAL_SOURCE, eventType: 'agent_noticed' }),
        event({ eventType: 'callout_reported', eventCategory: 'staff' }),
      ],
      wakesToday: 0,
    });
    assert.equal(verdict.wake, true);
    assert.deepEqual(
      verdict.wake && verdict.events.map((e) => e.eventType),
      ['callout_reported'],
    );
  });

  test('the daily wake ceiling stops it, and a quiet hotel is reported as quiet rather than capped', () => {
    const busy = { rows: [event()], wakesToday: MAX_WAKES_PER_DAY };
    assert.deepEqual(decideWake(busy), {
      wake: false, refusal: 'daily_wake_cap', events: 1,
    });
    assert.equal(decideWake({ rows: [event()], wakesToday: MAX_WAKES_PER_DAY - 1 }).wake, true);
    // A capped hotel with nothing happening reads as quiet. Reporting it as
    // capped would make the counter look like a hotel being silenced.
    assert.deepEqual(
      decideWake({ rows: [event({ eventType: 'room_status_changed' })], wakesToday: 99 }),
      { wake: false, refusal: 'quiet', events: 0 },
    );
  });

  test('a hotel that switched a section off is not interrupted about it', () => {
    const rows = [
      event({ eventCategory: 'housekeeping', eventType: 'inspection_fail' }),
      event({ eventCategory: 'maintenance', eventType: 'work_order_created' }),
      event({ eventCategory: 'staff', eventType: 'callout_reported' }),
    ];
    const kept = keepEnabledSections(rows, { housekeeping: false, staff: false });
    assert.deepEqual(kept.map((r) => r.eventType), ['work_order_created']);
    // DEFAULT ON. A hotel that never touched a toggle hears about everything,
    // and the house rule is never `flags[x] === true`.
    assert.equal(keepEnabledSections(rows, null).length, 3);
    assert.equal(keepEnabledSections(rows, {}).length, 3);
  });

  test('the topic is the department, is stable, and is never authored by a model', () => {
    assert.equal(wakeTopicFor([event(), event()]), 'wake:maintenance');
    assert.equal(
      wakeTopicFor([
        event({ eventCategory: 'housekeeping' }),
        event({ eventCategory: 'housekeeping' }),
        event({ eventCategory: 'maintenance' }),
      ]),
      'wake:housekeeping',
    );
    // Order must not change the answer, or a No would attach to a different
    // handle depending on how the rows came back.
    const rows = [event({ eventCategory: 'staff' }), event({ eventCategory: 'maintenance' })];
    assert.equal(wakeTopicFor(rows), wakeTopicFor([...rows].reverse()));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the window', () => {
  const now = new Date('2026-08-06T15:00:00.000Z');

  test('runs from the last look to now, exclusive at the bottom', () => {
    const w = wakeWindow('2026-08-06T14:50:00.000Z', now);
    assert.equal(w.sinceIso, '2026-08-06T14:50:00.000Z');
    assert.equal(w.untilIso, '2026-08-06T15:00:00.000Z');
    assert.equal(w.clamped, false);
  });

  test('a cursor from last week is clamped, and says so', () => {
    const w = wakeWindow('2026-07-30T09:00:00.000Z', now);
    assert.equal(w.clamped, true);
    assert.equal(
      w.sinceIso,
      new Date(now.getTime() - MAX_LOOKBACK_MINUTES * 60_000).toISOString(),
      'a resumed sweep must not hand a week of failures to the model',
    );
  });

  test('an unreadable cursor falls back to the clamp rather than to the epoch', () => {
    const w = wakeWindow('not a timestamp', now);
    assert.equal(w.sinceIso, new Date(now.getTime() - MAX_LOOKBACK_MINUTES * 60_000).toISOString());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the reply contract', () => {
  const ok = (text: string) => parseWakeReplyStrict(text);
  const refuses = (text: string, why: string) => {
    assert.throws(
      () => parseWakeReplyStrict(text),
      (e: unknown) => e instanceof Error && e.name === 'WakeContractError',
      why,
    );
  };

  test('accepts the three shapes it asked for', () => {
    assert.deepEqual(
      ok('{"do":"nothing","say":"","why":"ordinary day"}'),
      { kind: 'nothing', say: '', why: 'ordinary day' },
    );
    assert.equal(ok('{"do":"observe","say":"Room 214 came back.","why":"pattern"}').kind, 'observe');
    assert.equal(ok('{"do":"note","say":"Room 214 came back.","why":"worth saying"}').kind, 'note');
  });

  test('one extra key refuses the whole reply', () => {
    // The closed key set is the mechanism that stops the model authoring a
    // destination, an action or a severity. There is no field for them.
    refuses(
      '{"do":"note","say":"Room 214 came back.","why":"x","destination":"maintenance"}',
      'an unknown key must refuse the reply, not be ignored',
    );
    refuses('{"do":"note","say":"Room 214.","why":"x","topic":"wake:maintenance"}',
      'the model may not choose the topic a No attaches to');
  });

  test('refuses a verdict it was never offered', () => {
    refuses('{"do":"act","say":"Fixed it.","why":"x"}', 'there is no fourth verdict');
  });

  test('refuses the copy rules rather than repairing them', () => {
    refuses('{"do":"note","say":"Room 214 came back — again.","why":"x"}', 'em dash');
    refuses('{"do":"note","say":"The AI noticed room 214.","why":"x"}', 'names itself AI');
    refuses(`{"do":"note","say":"${'x'.repeat(MAX_NOTICE_CHARS + 1)}","why":"x"}`, 'too long');
    refuses('{"do":"note","say":"","why":"x"}', 'chose note and wrote nothing');
  });

  test('refuses anything that is not the object it asked for', () => {
    refuses('I think you should look at room 214.', 'no JSON at all');
    refuses('{"do":"note","say":"Room 214.","why":5}', 'why is not a string');
    refuses('{"do":"note","say":{"text":"Room 214."},"why":"x"}', 'say is not a string');
    refuses('{"items":[{"do":"note"}]}', 'the judge\'s envelope is not this contract');
    refuses('{"do":"note"}', 'a missing key is not an empty one');
  });

  test('tolerates a model that wrapped the object in prose or fences, and only that', () => {
    // Same leniency the findings judge allows, and for the same reason: the
    // failure it forgives is a code fence, which is a formatting habit rather
    // than a broken contract. Everything INSIDE the braces is still judged in
    // full, which is where the actual enforcement lives.
    assert.equal(
      ok('```json\n{"do":"nothing","say":"","why":"ordinary"}\n```').kind,
      'nothing',
    );
    refuses('```json\n{"do":"nothing","say":"","why":"x","extra":1}\n```', 'fenced or not, the key set is closed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the number guard', () => {
  const events = [
    event({ description: 'Work order created on Room 214, other (priority medium)' }),
    event({ description: 'Work order on Room 214 was deferred', eventType: 'work_order_deferred' }),
  ];

  test('a number that is in the events may be said', () => {
    const verdict = checkProse('Room 214 has had two work orders in the last few minutes.',
      wakeReceipt(events), 'en');
    assert.equal(verdict.ok, true, JSON.stringify(verdict));
  });

  test('a number that is nowhere in the events is caught', () => {
    const verdict = checkProse('Room 214 has had 47 work orders this month.',
      wakeReceipt(events), 'en');
    assert.equal(verdict.ok, false);
    assert.ok(verdict.violations.some((v) => v.token.includes('47')), JSON.stringify(verdict.violations));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the spend ceiling', () => {
  test('the feature has a listed share, and it is the smallest one', () => {
    // Unlisted callers inherit the brief's share by accident. This one is
    // listed, deliberately, at a tenth: it fires up to 144 times a day against
    // the judge's once.
    assert.equal(FEATURE_CAP_SHARE['companion.event_wake'], 0.1);
    const cap = featureCapUsd('companion.event_wake');
    assert.ok(cap > 0 && cap <= 0.25, `the ceiling is $${cap}, and the target is $0.25 or less`);
    for (const other of ['findings.judge', 'findings.sweep', 'findings.brief']) {
      assert.ok(
        FEATURE_CAP_SHARE['companion.event_wake'] <= FEATURE_CAP_SHARE[other],
        `${other} should not have a smaller share than the ten-minute sweep`,
      );
    }
  });

  test('several wakes fit inside one day, so the cheap counter is what bites first', () => {
    // A hold bigger than the ceiling is a feature that silently never runs.
    // MAX_WAKES_PER_DAY must be reachable before the dollars are.
    const cap = featureCapUsd('companion.event_wake');
    assert.ok(
      WAKE_RESERVATION_USD < cap,
      `one reservation ($${WAKE_RESERVATION_USD}) must fit inside the daily cap ($${cap})`,
    );
    // Actual per-call spend is a fraction of the hold, but even priced AT the
    // hold there has to be room for more than one look.
    assert.ok(cap / WAKE_RESERVATION_USD >= 2, 'the ceiling leaves room for at most one call');
  });

  test('an exhausted cap skips loudly and never reaches the model', () => {
    const model = scriptedModel(['{"do":"note","say":"Room 214.","why":"x"}']);
    const { deps, log } = spendDeps(async () => ({ ok: false, reason: 'property_daily_cap' }));
    return askWhatToPrepare({
      propertyId: PID, events: [event()], alreadyKnown: [], journalLines: [],
      deps, modelClient: model.client,
    }).then((outcome) => {
      assert.deepEqual(outcome, { ok: false, reason: 'spend_cap', costUsd: 0 });
      assert.equal(model.calls, 0, 'the cap must be checked before the call, not after');
      assert.deepEqual(log, { reserved: 1, finalized: 0, cancelled: 0, booked: 0 });
    });
  });

  test('a cap that cannot be read is reported as an outage, not as a budget line', async () => {
    const model = scriptedModel(['{"do":"note","say":"Room 214.","why":"x"}']);
    const { deps } = spendDeps(async () => ({ ok: false, reason: 'unavailable' }));
    const outcome = await askWhatToPrepare({
      propertyId: PID, events: [event()], alreadyKnown: [], journalLines: [],
      deps, modelClient: model.client,
    });
    assert.equal(outcome.ok, false);
    assert.equal(
      !outcome.ok && outcome.reason,
      'spend_unavailable',
      'filing an outage as a spend cap is how an outage goes uninvestigated',
    );
    assert.equal(model.calls, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the call', () => {
  const base = { propertyId: PID, events: [event()], alreadyKnown: [], journalLines: [] };

  test('a clean note comes back, and the spend is finalized and booked', async () => {
    const model = scriptedModel([
      '{"do":"note","say":"A work order just opened on Room 214.","why":"fresh"}',
    ]);
    const { deps, log } = spendDeps(allowingSpend);
    const outcome = await askWhatToPrepare({ ...base, deps, modelClient: model.client });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.ok && outcome.decision.kind, 'note');
    assert.equal(model.calls, 1);
    assert.equal(log.finalized, 1);
    assert.equal(log.booked, 1);
    assert.equal(log.cancelled, 0);
  });

  test('a model that throws is a silent skip, never a crash', async () => {
    const model = scriptedModel([() => { throw new Error('provider exploded'); }]);
    const { deps } = spendDeps(allowingSpend);
    const outcome = await askWhatToPrepare({ ...base, deps, modelClient: model.client });
    assert.equal(outcome.ok, false);
    assert.equal(!outcome.ok && outcome.reason, 'model_unavailable');
  });

  test('a reply that breaks the contract prepares nothing rather than something plainer', async () => {
    // Unlike the findings judge, there is no true sentence this feature is
    // obliged to produce, so a refused reply is silence.
    const model = scriptedModel(['{"do":"note","say":"Room 214 — again.","why":"x"}']);
    const { deps } = spendDeps(allowingSpend);
    const outcome = await askWhatToPrepare({ ...base, deps, modelClient: model.client });
    assert.equal(outcome.ok, false);
    assert.equal(!outcome.ok && outcome.reason, 'model_unavailable');
  });

  test('a sentence with an invented number is thrown away whole', async () => {
    const model = scriptedModel([
      '{"do":"note","say":"Room 214 has had 47 work orders this month.","why":"x"}',
    ]);
    const { deps, log } = spendDeps(allowingSpend);
    const outcome = await askWhatToPrepare({ ...base, deps, modelClient: model.client });
    assert.equal(outcome.ok, false);
    assert.equal(!outcome.ok && outcome.reason, 'model_unavailable');
    // The spend still settles. A refused 200 is still billable, and a ledger
    // that records only successes under-reports.
    assert.equal(log.finalized + log.cancelled, 1);
  });

  test('"nothing" is a first-class answer and costs one call', async () => {
    const model = scriptedModel(['{"do":"nothing","say":"","why":"ordinary"}']);
    const { deps } = spendDeps(allowingSpend);
    const outcome = await askWhatToPrepare({ ...base, deps, modelClient: model.client });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.ok && outcome.decision.kind, 'nothing');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the lines it writes about itself', () => {
  // Producer-walking, per the house rule: call the real copy producers and read
  // their output rather than grepping the source for a dash.
  const lines = [
    journalNoticedLine({ summary: 'A work order opened on Room 214.' }),
    journalObservedLine({ summary: 'Two cleans on the third floor were thrown out.' }),
    // The interpolated half is a hotel's own free text, and a person may type
    // anything into it.
    journalNoticedLine({ summary: 'Room 214 — the fan again' }),
  ];

  test('no em dashes, no AI, and something is actually said', () => {
    for (const line of lines) {
      assert.doesNotMatch(line, /[—–]/, line);
      assert.doesNotMatch(line, /\bA\.?I\.?\b/i, line);
      assert.ok(line.startsWith('Staxis noticed this'), line);
      assert.ok(line.length > 20, line);
    }
  });

  test('a note and an observation say different things about what happens next', () => {
    // The distinction is load-bearing: one may be spoken, the other never will
    // be, and a record that described them identically would be claiming a
    // mention the companion may never make.
    assert.notEqual(
      journalNoticedLine({ summary: 'X.' }),
      journalObservedLine({ summary: 'X.' }),
    );
    assert.match(journalNoticedLine({ summary: 'X.' }), /mention/);
  });
});

// Keeps the unused-import checker honest about the type-only import above.
export type { UsageReport };
