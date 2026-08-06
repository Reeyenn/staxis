/**
 * READING A PLAIN SENTENCE TYPED INTO THE "ADD A TO-DO" ROW.
 *
 * The parser is the whole bet of the redesigned composer: a person types
 * "check the boiler room every Friday", presses Enter, and never learns that
 * anything clever happened. Every failure mode here is silent by construction —
 * a phrase that stops being recognised does not throw, it just quietly stops
 * being lifted, and the to-do lands with the wrong day or no cadence at all.
 * So this is a table, and the table is the spec.
 *
 * Three classes of bug it is written to catch:
 *
 *   1. LIFTING TOO LITTLE. A phrase class silently stops matching.
 *   2. LIFTING TOO MUCH. The one that actually costs somebody money: a bare
 *      number read as a day of the month ("fix room 214 ac"), or a name
 *      invented for somebody who does not work here. A housekeeper matched
 *      here would route work to a screen they never open.
 *   3. LIFTING BADLY. The phrase comes out but the title is left as
 *      "check the boiler room" with a dangling "on", or re-cased, or emptied.
 *
 * The clock is passed in, so every case below is stable at any hour.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseTodo, type ComposerPerson, type ParseResult } from '@/lib/feed/parse-todo';
import {
  COMPOSER_COPY,
  enterTakesNote,
  repeatWord,
  whenWord,
  whoWord,
} from '@/lib/feed/one-list-copy';

// Thursday 30 July 2026, in the browser's own calendar.
const NOW = new Date(2026, 6, 30, 9, 0, 0);

const MARCUS = 'staff-marcus';
const DANA = 'staff-dana';
const ROSTER: readonly ComposerPerson[] = [
  { staffId: MARCUS, name: 'Marcus Webb' },
  { staffId: DANA, name: 'Dana' },
];

function read(sentence: string, people: readonly ComposerPerson[] = ROSTER): ParseResult {
  return parseTodo(sentence, people, NOW);
}

/** Days from NOW, as the parser would write them. */
function day(offset: number): string {
  const d = new Date(2026, 6, 30 + offset);
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}

// ─── 1. the phrase table ────────────────────────────────────────────────────

describe('every phrase class the composer promises to understand', () => {
  const CASES: Array<{
    sentence: string;
    title: string;
    when?: string | null;
    repeat?: ParseResult['repeat'];
    weekday?: number | null;
    dayOfMonth?: number | null;
    intervalDays?: number | null;
    atTime?: string | null;
  }> = [
    // when
    { sentence: 'fix the ice machine today', title: 'Fix the ice machine', when: day(0) },
    { sentence: 'lock the pool gate tonight', title: 'Lock the pool gate', when: day(0) },
    { sentence: 'fix room 214 ac tomorrow', title: 'Fix room 214 ac', when: day(1) },
    { sentence: 'call the plumber this Saturday', title: 'Call the plumber', when: day(2), weekday: 6 },
    // Thursday the 30th: "next Tuesday" is the Tuesday of next week, Aug 4.
    { sentence: 'call the plumber next Tuesday', title: 'Call the plumber', when: '2026-08-04', weekday: 2 },
    { sentence: 'change the filters on Monday', title: 'Change the filters', when: '2026-08-03', weekday: 1 },
    { sentence: 'order towels in 3 days', title: 'Order towels', when: day(3) },
    { sentence: 'order towels in two days', title: 'Order towels', when: day(2) },
    { sentence: 'brand audit prep Aug 22', title: 'Brand audit prep', when: '2026-08-22' },
    { sentence: 'brand audit prep August 22', title: 'Brand audit prep', when: '2026-08-22' },
    { sentence: 'brand audit prep 22 August', title: 'Brand audit prep', when: '2026-08-22' },
    { sentence: 'deep clean the lobby 9/14', title: 'Deep clean the lobby', when: '2026-09-14' },
    // how often
    { sentence: 'restock the coffee station every day', title: 'Restock the coffee station', repeat: 'daily' },
    { sentence: 'check the lobby daily', title: 'Check the lobby', repeat: 'daily' },
    { sentence: 'walk the halls every morning', title: 'Walk the halls', repeat: 'daily' },
    { sentence: 'lock the pool every night', title: 'Lock the pool', repeat: 'daily' },
    { sentence: 'count the linen every week', title: 'Count the linen', repeat: 'weekly' },
    { sentence: 'count the linen weekly', title: 'Count the linen', repeat: 'weekly' },
    { sentence: 'check the boiler room every Friday', title: 'Check the boiler room', repeat: 'weekly', weekday: 5 },
    { sentence: 'deep clean the vents every other week', title: 'Deep clean the vents', repeat: 'biweekly' },
    { sentence: 'deep clean the vents biweekly', title: 'Deep clean the vents', repeat: 'biweekly' },
    { sentence: 'test the generator every other Friday', title: 'Test the generator', repeat: 'biweekly', weekday: 5 },
    // every N days: anchored on "every" and "days" with the number between
    { sentence: 'flush the water heater every 3 days', title: 'Flush the water heater', repeat: 'every_n_days', intervalDays: 3 },
    { sentence: 'backwash the sand filter every 5 days', title: 'Backwash the sand filter', repeat: 'every_n_days', intervalDays: 5 },
    { sentence: 'change the filters every 45 days', title: 'Change the filters', repeat: 'every_n_days', intervalDays: 45 },
    { sentence: 'walk the property every three days', title: 'Walk the property', repeat: 'every_n_days', intervalDays: 3 },
    { sentence: 'skim the pool every other day', title: 'Skim the pool', repeat: 'every_n_days', intervalDays: 2 },
    { sentence: 'skim the pool every second day', title: 'Skim the pool', repeat: 'every_n_days', intervalDays: 2 },
    // "every 1 days" is daily said awkwardly, and daily already has a word
    { sentence: 'check the lobby every 1 days', title: 'Check the lobby', repeat: 'daily' },
    { sentence: 'pay the linen invoice every month', title: 'Pay the linen invoice', repeat: 'monthly' },
    { sentence: 'pay the linen invoice monthly', title: 'Pay the linen invoice', repeat: 'monthly' },
    { sentence: 'pay the linen invoice every month on the 3rd', title: 'Pay the linen invoice', repeat: 'monthly', dayOfMonth: 3 },
    { sentence: 'change the air filter once', title: 'Change the air filter', repeat: 'once' },
    // both at once: the day is where the run STARTS
    { sentence: 'check the boiler room every Friday starting tomorrow', title: 'Check the boiler room starting', repeat: 'weekly', when: day(1), weekday: 5 },
    // what time of day. Every one of these is anchored on something that can
    // only be a clock: an am/pm marker, minutes after a colon, or the word noon.
    { sentence: 'set up the meeting room by 3pm', title: 'Set up the meeting room', atTime: '15:00' },
    { sentence: 'set up the meeting room by 3 pm', title: 'Set up the meeting room', atTime: '15:00' },
    { sentence: 'set up the meeting room at 6:30', title: 'Set up the meeting room', atTime: '06:30' },
    { sentence: 'set up the meeting room at 6:30pm', title: 'Set up the meeting room', atTime: '18:30' },
    { sentence: 'call the vendor before noon', title: 'Call the vendor', atTime: '12:00' },
    { sentence: 'call the vendor by noon', title: 'Call the vendor', atTime: '12:00' },
    { sentence: 'run the audit by 15:00', title: 'Run the audit', atTime: '15:00' },
    { sentence: 'run the audit at 9am', title: 'Run the audit', atTime: '09:00' },
    { sentence: 'lock the pool gate 11pm', title: 'Lock the pool gate', atTime: '23:00' },
    { sentence: 'midnight walk at 12am', title: 'Midnight walk', atTime: '00:00' },
    // a part of the day is a DEADLINE, and maps to the end of the span it names
    { sentence: 'strip the beds this morning', title: 'Strip the beds', when: day(0), atTime: '12:00' },
    { sentence: 'strip the beds this afternoon', title: 'Strip the beds', when: day(0), atTime: '17:00' },
    { sentence: 'strip the beds this evening', title: 'Strip the beds', when: day(0), atTime: '21:00' },
    { sentence: 'lock the pool gate tonight', title: 'Lock the pool gate', when: day(0), atTime: '21:00' },
    // a clock and a day and a cadence, all in one sentence
    { sentence: 'check the boiler every day at 3pm', title: 'Check the boiler', repeat: 'daily', atTime: '15:00' },
    { sentence: 'order towels tomorrow by 10am', title: 'Order towels', when: day(1), atTime: '10:00' },
    // an explicit clock beats the vague half of the same sentence
    { sentence: 'strip the beds this morning by 10am', title: 'Strip the beds', when: day(0), atTime: '10:00' },
  ];

  for (const c of CASES) {
    test(`"${c.sentence}"`, () => {
      const result = read(c.sentence);
      assert.equal(result.title, c.title, 'the title is what is left after the lift');
      if (c.when !== undefined) assert.equal(result.when, c.when, 'wrong day');
      if (c.repeat !== undefined) assert.equal(result.repeat, c.repeat, 'wrong cadence');
      if (c.weekday !== undefined) assert.equal(result.weekday, c.weekday, 'wrong weekday');
      if (c.dayOfMonth !== undefined) assert.equal(result.dayOfMonth, c.dayOfMonth, 'wrong day of month');
      if (c.intervalDays !== undefined) assert.equal(result.intervalDays, c.intervalDays, 'wrong gap');
      if (c.atTime !== undefined) assert.equal(result.atTime, c.atTime, 'wrong time of day');
    });
  }
});

// ─── 2. lifting too much ────────────────────────────────────────────────────

describe('what it must never claim', () => {
  // THE regression this rule exists for. A room number is not a date, and a
  // to-do quietly filed on the 214th of nothing is a to-do nobody sees again.
  test('a bare number is never a day of the month, or a day of anything', () => {
    const result = read('fix room 214 ac');
    assert.equal(result.title, 'Fix room 214 ac');
    assert.equal(result.when, null);
    assert.equal(result.repeat, null);
    assert.equal(result.dayOfMonth, null);
  });

  test('numbers that look like dates are still not dates without a keyword', () => {
    for (const sentence of ['replace 12 bulbs', 'order 30 pillowcases', 'check meter 8']) {
      const result = read(sentence);
      assert.equal(result.when, null, `${sentence} claimed a day`);
      assert.equal(result.dayOfMonth, null, `${sentence} claimed a day of the month`);
    }
  });

  // THE SECOND RULE applied to the newest thing that reads numbers. A gap is
  // only ever claimed off the words "every" and "days" with the number BETWEEN
  // them; every sentence below has a number in it and none of them is a cadence.
  test('a bare number is never a gap between repeats', () => {
    for (const sentence of [
      'order 3 cases of coffee',
      'fix room 214 ac',
      'replace 5 days of linens',
      'the 3 day forecast is bad',
      'check the boiler in 3 days',
      'every 3 weeks call the vendor',
      'every 900 days is not a cadence',
      'every 0 days is not a cadence',
    ]) {
      const result = read(sentence);
      assert.equal(result.repeat === 'every_n_days', false, `"${sentence}" claimed a gap`);
      assert.equal(result.intervalDays, null, `"${sentence}" claimed a number of days`);
    }
  });

  test('a gap outside what the cadence can carry leaves the words in the title', () => {
    // Never an error, never a silent clamp to 2 or 365: the sentence simply
    // stands, which is what THE ONE RULE THAT MATTERS asks for.
    for (const sentence of ['deep clean every 900 days', 'sweep every 0 days']) {
      const result = read(sentence);
      assert.equal(result.repeat, null);
      assert.equal(result.intervalDays, null);
      assert.match(result.title, /days/, `"${sentence}" lost words it did not understand`);
    }
  });

  // The same rule the numbers above are protected by, applied to the clock. A
  // hotel sentence is full of bare numbers, and a job filed for 2:14 in the
  // morning is a job nobody is awake for.
  test('a bare number is never a time, whatever sits next to it', () => {
    for (const sentence of [
      'fix room 214 ac',
      'order 3 cases of coffee',
      'replace 12 bulbs',
      'check meter 8',
      'restock cart 7',
    ]) {
      const result = read(sentence);
      assert.equal(result.atTime, null, `${sentence} claimed a time`);
    }
  });

  test('"at 6" is left alone, because 6am and 6pm are twelve hours apart', () => {
    // Deliberately not lifted. People do write it, and it is also the shape of
    // half the numbers in a hotel. Leaving it in the title is never wrong;
    // guessing the wrong half of the day is.
    const result = read('meet the vendor at 6');
    assert.equal(result.atTime, null);
    assert.match(result.title, /6/, 'and the words stay exactly where they were written');
  });

  test('a fraction or a room number is never read as a clock', () => {
    for (const sentence of ['replace the 1/2 inch elbow', 'fix room 214 ac']) {
      assert.equal(read(sentence).atTime, null, `${sentence} claimed a time`);
    }
  });

  test('an every-morning cadence promises no hour, because none was written', () => {
    // "every morning" is a cadence, not a deadline. Turning it into 12:00 would
    // put a time on the row that nobody typed and nobody agreed to.
    const result = read('walk the halls every morning');
    assert.equal(result.repeat, 'daily');
    assert.equal(result.atTime, null);
  });

  test('a fraction in the middle of a sentence is a size, not a date', () => {
    // Shipped as a bug for exactly one afternoon: "replace the 1/2 inch elbow"
    // was filed on the 2nd of January and left the title "Replace the inch
    // elbow". A slashed pair is only a date at the end of a sentence, which is
    // where somebody writing a date puts it.
    for (const sentence of ['replace the 1/2 inch elbow', 'order 3/4 inch fittings']) {
      const result = read(sentence);
      assert.equal(result.when, null, `${sentence} claimed a day`);
      assert.match(result.title, /inch/, `${sentence} lost its size`);
    }
    // ...and the real thing still works.
    assert.equal(read('deep clean the lobby 9/14').when, '2026-09-14');
    assert.equal(read('deep clean the lobby 9/14.').when, '2026-09-14');
  });

  test('unrecognised text stays in the title, word for word', () => {
    const sentence = 'reseat the breaker in the pump house and bleed the line';
    const result = read(sentence);
    assert.equal(result.title, 'Reseat the breaker in the pump house and bleed the line');
    assert.equal(result.who, null);
    assert.equal(result.when, null);
    assert.equal(result.repeat, null);
    assert.equal(result.question, null);
  });

  test('an empty or blank sentence claims nothing and does not throw', () => {
    for (const sentence of ['', '   ', '\n']) {
      const result = read(sentence);
      assert.equal(result.title, '');
      assert.equal(result.when, null);
      assert.equal(result.repeat, null);
    }
  });

  test('a possessive is part of the task, not a date or a name', () => {
    // "call today's arrivals" is not a to-do due today, it is a to-do ABOUT
    // today's arrivals. Lifting the word leaves the nonsense title "'s arrivals".
    const arrivals = read("call today's arrivals");
    assert.equal(arrivals.when, null);
    assert.equal(arrivals.title, "Call today's arrivals");

    const shift = read("cover Marcus's shift");
    assert.equal(shift.who, null, 'covering somebody\'s shift is work for the reader');
    assert.equal(shift.title, "Cover Marcus's shift");

    const friday = read("redo Friday's count");
    assert.equal(friday.when, null);
    assert.equal(friday.question, null);
  });

  test('"once the guest leaves" is not a cadence', () => {
    // Only a TRAILING "once" is the cadence word. Mid-sentence it is a
    // conjunction, and lifting it would eat half the sentence.
    const result = read('strip the bed once the guest leaves');
    assert.equal(result.repeat, null);
    assert.equal(result.title, 'Strip the bed once the guest leaves');
  });
});

// ─── 3. names ───────────────────────────────────────────────────────────────

describe('a name is only ever somebody who works here', () => {
  const HANDOFFS: Array<[string, string]> = [
    ['have Marcus check the pool chemicals', 'Check the pool chemicals'],
    ['ask Marcus to check the pool chemicals', 'Check the pool chemicals'],
    ['tell Marcus to check the pool chemicals', 'Check the pool chemicals'],
    ['Marcus needs to check the pool chemicals', 'Check the pool chemicals'],
    ['check the pool chemicals for Marcus', 'Check the pool chemicals'],
  ];

  for (const [sentence, title] of HANDOFFS) {
    test(`"${sentence}" hands it to Marcus and leaves the task behind`, () => {
      const result = read(sentence);
      assert.equal(result.who, MARCUS);
      assert.equal(result.title, title, 'the handoff words must come out with the name');
    });
  }

  test('a full name matches, and comes out whole', () => {
    const result = read('ask Marcus Webb to check the pool');
    assert.equal(result.who, MARCUS);
    assert.equal(result.title, 'Check the pool');
  });

  test('a person who does not work here is never invented', () => {
    const result = read('ask Priya to check the pool');
    assert.equal(result.who, null);
    // And their name stays in the title, because the sentence still says it.
    assert.match(result.title, /Priya/);
  });

  // The exclusion that matters most. Housekeepers are absent from the roster
  // /api/worklist?view=assignees returns (listAssignees), so a housekeeper can
  // never be matched here — a to-do routed to one would land on a screen they
  // never open, and it would look like it had been handed over.
  test('a housekeeper is never matched, because they are not on the roster', () => {
    const result = parseTodo('have Rosa strip the beds', ROSTER, NOW);
    assert.equal(result.who, null);
    assert.match(result.title, /Rosa/);
  });

  test('an empty roster matches nobody at all', () => {
    assert.equal(read('have Marcus check the pool', []).who, null);
  });

  test('a name and a cadence in one sentence both come out', () => {
    const result = read('have Marcus check the boiler room every Friday');
    assert.equal(result.who, MARCUS);
    assert.equal(result.repeat, 'weekly');
    assert.equal(result.weekday, 5);
    assert.equal(result.title, 'Check the boiler room');
  });

  test('a second person on the roster is reachable too', () => {
    assert.equal(read('ask Dana to count the linen').who, DANA);
  });
});

// ─── 4. the one question ────────────────────────────────────────────────────

describe('at most one question, and only when both readings are reasonable', () => {
  test('a bare weekday is asked about, and the safer reading is already taken', () => {
    const result = read('fix room 214 ac Friday');
    assert.ok(result.question, 'a bare weekday is genuinely two-sided');
    assert.equal(result.question.prompt, 'Which Friday?');
    assert.equal(result.question.choices.length, 2);
    // Enter always takes the FIRST choice, so the first choice must already be
    // what the row is showing. Otherwise pressing Enter would change the answer.
    assert.deepEqual(result.question.choices[0].patch, { when: day(1), repeat: 'once', weekday: 5 });
    assert.equal(result.when, day(1));
    assert.equal(result.repeat, null, 'the safer reading is a one-off');
    assert.equal(result.title, 'Fix room 214 ac');
  });

  test('the second answer is the other whole reading, not a fragment', () => {
    const question = read('fix room 214 ac Friday').question;
    assert.equal(question?.choices[1].label, 'Every Friday');
    assert.deepEqual(question?.choices[1].patch, { when: null, repeat: 'weekly', weekday: 5 });
  });

  test('every unambiguous phrase asks nothing at all', () => {
    for (const sentence of [
      'check the boiler room every Friday',
      'fix the ac tomorrow',
      'fix the ac today',
      'call the plumber this Friday',
      'call the plumber next Friday',
      'change the filters on Friday',
      'order towels in 3 days',
      'brand audit prep Aug 22',
      'reseat the breaker in the pump house',
    ]) {
      assert.equal(read(sentence).question, null, `${sentence} should not ask anything`);
    }
  });

  test('a cadence beside the weekday settles it without asking', () => {
    const result = read('check the boiler Friday every week');
    assert.equal(result.question, null);
    assert.equal(result.repeat, 'weekly');
  });
});

// ─── 5. the title that is left ──────────────────────────────────────────────

describe('what is left reads like a task', () => {
  test('lifted phrases are gone and the spaces they left are closed up', () => {
    assert.equal(read('check the boiler room every Friday').title, 'Check the boiler room');
    assert.equal(read('every Friday check the boiler room').title, 'Check the boiler room');
    assert.equal(read('check the boiler room, every Friday').title, 'Check the boiler room');
  });

  test('only the first letter is touched', () => {
    // The rest is the person's own writing, including their capitals.
    assert.equal(read('fix the AC in 214 tomorrow').title, 'Fix the AC in 214');
  });

  test('a sentence that is nothing but a phrase leaves an empty title', () => {
    // Which is correct: there is no task yet, so Enter does nothing. The words
    // on the right still show what was understood.
    const result = read('every Friday');
    assert.equal(result.title, '');
    assert.equal(result.repeat, 'weekly');
  });
});

// ─── 6. the words the row says back ─────────────────────────────────────────

describe('the three words', () => {
  test('the defaults read "for you", "today", "once"', () => {
    assert.equal(whoWord('me', ROSTER), 'for you');
    assert.equal(whenWord(day(0), NOW), 'today');
    assert.equal(repeatWord('once'), 'once');
  });

  test('a person is named by their first name only', () => {
    assert.equal(whoWord(MARCUS, ROSTER), 'for Marcus');
  });

  test('a role reads as a sentence, not as a label', () => {
    assert.equal(whoWord('dept:front_desk', ROSTER), "for whoever's on front desk");
    assert.equal(whoWord('dept:maintenance', ROSTER), 'for maintenance');
    assert.equal(whoWord('dept:all_staff', ROSTER), 'for everyone');
  });

  test('a person who has left the roster falls back to you, never to a blank', () => {
    assert.equal(whoWord('staff-who-left', ROSTER), 'for you');
  });

  test('the day is named the way a person would say it', () => {
    assert.equal(whenWord(day(1), NOW), 'tomorrow');
    assert.equal(whenWord(day(2), NOW), 'Saturday');
    assert.equal(whenWord('2026-08-22', NOW), 'Aug 22');
    assert.equal(whenWord(null, NOW), 'today');
  });

  test('a repeating item says where it starts, because it has no single due day', () => {
    assert.equal(whenWord(day(0), NOW, { repeating: true }), 'from today');
    assert.equal(whenWord('2026-08-03', NOW, { repeating: true }), 'from Monday');
  });

  test('the cadence word keeps the weekday capital it needs', () => {
    // The bug this pins: `repeatLabel().toLowerCase()` reads "every other
    // friday", which is a day of the week nobody writes.
    assert.equal(repeatWord('biweekly', { weekday: 5 }), 'every other Friday');
    assert.equal(repeatWord('weekly', { weekday: 5 }), 'every Friday');
    assert.equal(repeatWord('weekly'), 'every week');
    assert.equal(repeatWord('daily'), 'every day');
    assert.equal(repeatWord('monthly', { dayOfMonth: 3 }), 'every month on the 3rd');
  });

  test('the question note says what Enter would actually do', () => {
    assert.equal(enterTakesNote('This Friday'), 'Enter takes this Friday.');
  });

  test('no sentence the composer says carries an em dash', () => {
    const said = [
      ...Object.values(COMPOSER_COPY),
      whoWord('me', ROSTER), whoWord(MARCUS, ROSTER), whoWord('dept:front_desk', ROSTER),
      whenWord(day(0), NOW), whenWord(day(2), NOW), whenWord('2026-08-22', NOW, { repeating: true }),
      repeatWord('biweekly', { weekday: 5 }), repeatWord('monthly', { dayOfMonth: 11 }),
      enterTakesNote('This Friday'),
      read('fix room 214 ac Friday').question?.prompt ?? '',
    ];
    for (const line of said) {
      assert.ok(!line.includes('—'), `em dash in: ${line}`);
      assert.ok(!/[¿¡ñáéíóú]/i.test(line), `looks like Spanish: ${line}`);
    }
  });

  test('the interface never says "AI"', () => {
    // Founder ruling, and the design's: no AI word, no sparkle. The optional
    // model reading is invisible by design, and this is the guard on it.
    for (const line of Object.values(COMPOSER_COPY)) {
      assert.ok(!/\bAI\b/.test(line), `the word AI reached the interface: ${line}`);
    }
  });
});
