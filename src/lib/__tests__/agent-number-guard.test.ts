/**
 * Precision corpus for the number-honesty guard, plus the arithmetic it exists
 * to make unnecessary.
 *
 * The hermetic eval bank proves the guard is WIRED — a real agent turn, real
 * dispatch, the correction reaching the user. It can only afford a handful of
 * sentences. This file is the cheap half: the check as a pure function over
 * many answers, weighted heavily toward the answers that must NOT fire.
 *
 * That weighting is the whole point, and it is the doctrine both this guard and
 * `findings/prose-guard.ts` are built on. The failure mode that gets a guard
 * ripped out is not missing a fabrication — it is retracting a true sentence in
 * front of a manager. Every MUST-NOT-FIRE line below is something a real
 * manager, front-desk agent or maintenance tech could plausibly be shown.
 *
 * The second half pins the DERIVED FIGURES. The guard refuses arithmetic the
 * model did in prose; that is only fair if the figures people ask for are
 * already on the tool result, and only safe if those figures are right. So the
 * three pure functions behind them are pinned here rather than trusted.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAnswerReceipt,
  checkAnswerNumbers,
  detectAnswerLanguage,
  numberGuardCorrection,
  violationTokens,
  CHAT_EXEMPT_NUMBER_WORDS,
  type AnswerReceipt,
} from '@/lib/agent/number-guard';
import { NUMBER_WORDS } from '@/lib/findings/prose-guard';
import { runAgent, type RunAgentOpts } from '@/lib/agent/llm';
import { createFakeModel } from '@/lib/agent/evals/fake-model';
import {
  centsPerOccupiedRoom,
  monthPace,
  pctOfTotal,
  plannedSpendImpact,
} from '@/lib/agent/tools/financials';

// ─── The fixture turn ──────────────────────────────────────────────────────
//
// One realistic turn: a manager asking about a finding, a tool that answered,
// and a hotel snapshot in the dynamic block. Every case below is graded against
// THIS, so "backed" and "unbacked" mean one fixed thing across the file.

const SNAPSHOT = `─── Current hotel snapshot ───
today: 2026-07-27
rooms: total 100, dirty 12, clean 60, checkouts 20, stayovers 18, in-house 40, out of order 1
staff: active today 6, assigned housekeepers 4`;

/** The hotel's own confirmed facts — the `factual` half of the stable block. */
const FACTUAL = `─── What this hotel has confirmed ───
Checkout is 11:00 AM. The pet deposit is $25.00. Breakfast runs 6:00 to 9:30.`;

/** Deliberately full of ILLUSTRATIVE numbers, the way the real role prompts
 *  are. None of these may back a sentence. */
const INSTRUCTIONS = `You are Staxis. Confirm before marking 10+ rooms at once.
Never return more than 5 tool calls. Example: "mark 302 clean", "assign 304 to Maria",
"we have 40 rolls of toilet paper", "schedule Carlos 7am-3pm".`;

const TOOL_PAYLOAD = {
  count: 3,
  findings: [
    {
      summary: 'HVAC work orders keep coming back on room 214',
      price: { range: '$750.00–$1,750.00' },
      timesSeen: 4,
      windowDays: 90,
    },
  ],
  budgetCents: 350000,
};

function receipt(patch: Partial<Parameters<typeof buildAnswerReceipt>[0]> = {}): AnswerReceipt {
  return buildAnswerReceipt({
    systemPrompt: { stable: `${INSTRUCTIONS}\n${FACTUAL}`, dynamic: SNAPSHOT, factual: FACTUAL },
    history: [],
    newUserMessage: 'what has Staxis found on 214?',
    toolPayloads: [TOOL_PAYLOAD],
    ...patch,
  });
}

const R = receipt();

function fires(text: string): string[] {
  return violationTokens(checkAnswerNumbers(text, R).violations);
}

// ─── Must fire ─────────────────────────────────────────────────────────────

describe('number guard — figures nothing backs', () => {
  const MUST_FIRE: Array<[string, string]> = [
    // The founder's three named classes.
    ['a derived percentage', "That's about 78% of your maintenance budget."],
    ['a derived per-room figure', 'That works out to $21.50 per occupied room.'],
    ['an average', 'On average that is one ticket every 23 days.'],
    // A point estimate inside a real range — every digit "looks" sourced, and
    // this is exactly the defect prose-guard deleted its {price_low} slot for.
    ['a midpoint of a range', 'Budget about $1,200 for the fix.'],
    ['an invented dollar total', 'You have spent $9,340 on that room this year.'],
    ['an invented count', 'There are 37 work orders still open.'],
    ['a spelled-out invented count', 'There are fifteen work orders still open.'],
    ['a Spanish spelled-out count', 'Hay quince órdenes de trabajo abiertas.'],
    ['an invented vague magnitude', 'Replacing the batch will run into the thousands.'],
    ['the same in Spanish', 'Cambiar el lote va a costar mil dólares por unidad.'],
    ['an invented phone number', 'Call the vendor on (409) 555-0182.'],
    ['an invented policy figure', 'The pet fee is $75.00 for the stay.'],
    ['a large ordinal smuggling a count', 'This is the 400th ticket on that unit.'],
  ];

  for (const [label, text] of MUST_FIRE) {
    test(`fires on ${label}`, () => {
      const tokens = fires(text);
      assert.ok(tokens.length > 0, `nothing objected to: "${text}"`);
    });
  }

  test('names every offending token, and only those', () => {
    const tokens = fires('Staxis has 3 findings; the 214 fix is $750.00–$1,750.00, about 78% of budget.');
    assert.deepEqual(tokens, ['78']);
  });
});

// ─── Must NOT fire ─────────────────────────────────────────────────────────

describe('number guard — answers that must survive untouched', () => {
  const MUST_NOT_FIRE: Array<[string, string]> = [
    ['a straight quote of the payload', 'Staxis has 3 findings open; the one on 214 has been seen 4 times.'],
    ['a spelled-out payload number', 'The HVAC issue on 214 has come back four times.'],
    ['the Spanish spelling of it', 'El problema del aire en la habitación 214 ha vuelto cuatro veces.'],
    ['a price kept as its range', 'Staxis puts the fix at $750.00–$1,750.00.'],
    ['the window the tool counted over', 'That is 4 tickets in the last 90 days.'],
    ['a snapshot figure', 'You have 12 dirty rooms and 60 clean right now.'],
    ['a confirmed hotel fact', 'Checkout is 11:00 AM and the pet deposit is $25.00.'],
    ['a confirmed time range', 'Breakfast runs 6:00 to 9:30.'],
    ['a room number the tool returned', 'Room 214 is the one to look at.'],
    ['cents in the payload spoken as dollars', 'The maintenance budget is $3,500.00 this month.'],
    ['a small ordinal', 'The 3rd invoice from that vendor is the one to check.'],
    ['an answer with no numbers at all', "Nothing is flagged — want me to look at the work orders?"],
    ['a numbered list', 'Here is what I would do:\n1. Call the vendor\n2. Check the warranty\n3. Log a ticket'],
    ['a numbered list with a paren', '1) Call the vendor\n2) Check the warranty'],
    ['a bulleted numbered list', '- 1. Call the vendor\n- 2. Check the warranty'],
    // The conversational hedges. `once` is the sharp one — Spanish for eleven
    // and one of the most common adverbs in English.
    ['"once you have..."', "Once you've had someone look at it, ask me again."],
    ['"a couple of things"', 'A couple of things are still open.'],
    ['"half of them"', 'Half of them are waiting on the vendor.'],
    ['"a hundred percent"', "I'm a hundred percent sure that is the same unit."],
    ['the Spanish idiom', 'Estoy cien por ciento seguro de que es la misma unidad.'],
    ['"half an hour"', 'Give it half an hour and check again.'],
    ['a refusal', "I don't have that figure — want me to check?"],
  ];

  for (const [label, text] of MUST_NOT_FIRE) {
    test(`stays silent on ${label}`, () => {
      const tokens = fires(text);
      assert.deepEqual(tokens, [], `retracted a true or harmless sentence: "${text}"`);
    });
  }
});

// ─── The receipt: what counts as evidence ──────────────────────────────────

describe('the receipt', () => {
  test("the user's own number backs the answer", () => {
    const r = receipt({ newUserMessage: "we've set aside $4,800 — is that enough?" });
    assert.deepEqual(
      violationTokens(checkAnswerNumbers('Yes, $4,800 covers it.', r).violations),
      [],
    );
  });

  test('an earlier tool result backs the answer', () => {
    const r = receipt({
      history: [{ role: 'tool', result: { openWorkOrders: 37 } }],
      toolPayloads: [],
    });
    assert.deepEqual(
      violationTokens(checkAnswerNumbers('There were 37 open.', r).violations),
      [],
    );
  });

  test('the assistant CANNOT back its own earlier number', () => {
    // The load-bearing exclusion. If assistant text counted, one fabrication
    // would launder itself into a permanent fact by being repeated.
    const r = receipt({
      history: [{ role: 'assistant', content: "You're at about 78% of budget." }],
      toolPayloads: [],
    });
    assert.deepEqual(
      violationTokens(checkAnswerNumbers('It was 78% of budget.', r).violations),
      ['78'],
    );
  });

  test('the correction the guard itself appended cannot become evidence', () => {
    // The retraction is persisted into the assistant turn, so it replays as
    // history. It names the offending token — "78" — and if assistant rows
    // counted, the guard would be handing the model its own receipt.
    const r = receipt({
      history: [{
        role: 'assistant',
        content: "You're at 78% of budget.\n\n⚠️ **Automatic correction: I can't back those figures.** "
          + "These do not appear in this hotel's records: 78.",
      }],
      toolPayloads: [],
    });
    assert.deepEqual(
      violationTokens(checkAnswerNumbers('As I said, 78% of budget.', r).violations),
      ['78'],
    );
  });

  test('`factual` is preferred over `stable`, so worked examples back nothing', () => {
    // "40 rolls of toilet paper" and "mark 302 clean" live in the INSTRUCTIONS
    // half. Measured on the real base + manager prompt this is 12 stray numbers
    // covering nearly every small count.
    assert.deepEqual(fires('Room 302 is the one, and 304 is next.'), ['302', '304']);
  });

  test('without `factual`, the whole stable block backs numbers — permissive, never louder', () => {
    // The fallback for callers that hand-roll their blocks. It must widen the
    // receipt, not narrow it: a guard that gets LOUDER when a field is missing
    // would fire on honest answers in exactly the places nobody is looking.
    const r = receipt({
      systemPrompt: { stable: `${INSTRUCTIONS}\n${FACTUAL}`, dynamic: SNAPSHOT },
    });
    assert.deepEqual(violationTokens(checkAnswerNumbers('Room 302 is the one.', r).violations), []);
  });

  test('a cents-suffixed field backs the dollar figure spoken from it', () => {
    // Money is stored in cents and spoken in dollars. Getting this wrong would
    // retract every correct money answer built from a raw-cents tool — the
    // loudest possible false positive, on the most consequential number.
    const r = receipt({ toolPayloads: [{ remainingCents: 135000 }] });
    assert.deepEqual(
      violationTokens(checkAnswerNumbers('You have $1,350.00 left.', r).violations),
      [],
    );
  });

  test('either rounding of a fractional payload value is backed, but not a third', () => {
    // The tolerance is prose-guard's, shared on purpose: a payload's 61.4 reads
    // honestly as "61%" or "62%", and a card and a sentence must not disagree
    // about which. Anything further away is a different claim.
    const r = receipt({ toolPayloads: [{ pctUsed: 61.4 }] });
    for (const ok of ['61% used.', '62% used.', '61.4% used.']) {
      assert.deepEqual(violationTokens(checkAnswerNumbers(ok, r).violations), [], ok);
    }
    assert.deepEqual(violationTokens(checkAnswerNumbers('About 55% used.', r).violations), ['55']);
    assert.deepEqual(violationTokens(checkAnswerNumbers('About 65% used.', r).violations), ['65']);
  });
});

// ─── Vocabulary: shared with the card guard, narrowed on purpose ───────────

describe('the chat vocabulary', () => {
  test('every exempted word is a real entry in the shared card vocabulary', () => {
    // Guards against a typo silently exempting nothing — and against the list
    // drifting after someone renames an entry in prose-guard.
    for (const word of CHAT_EXEMPT_NUMBER_WORDS) {
      assert.ok(
        NUMBER_WORDS[word] !== undefined,
        `"${word}" is exempted from the chat guard but is not a card number word`,
      );
    }
  });

  test('the chat guard only ever SUBTRACTS from the shared vocabulary', () => {
    // A number word added for cards must be checked in chat too. The only way
    // out is to be named in CHAT_EXEMPT_NUMBER_WORDS with a reason.
    const empty: AnswerReceipt = { numbers: new Set(), text: '' };
    for (const word of Object.keys(NUMBER_WORDS)) {
      const caught = checkAnswerNumbers(`there are ${word} of them`, empty).violations
        .some(v => v.token === word);
      assert.equal(
        caught,
        !CHAT_EXEMPT_NUMBER_WORDS.has(word),
        `"${word}" is ${caught ? 'checked' : 'not checked'} in chat but ${CHAT_EXEMPT_NUMBER_WORDS.has(word) ? 'is' : 'is not'} on the exempt list`,
      );
    }
  });

  test('the money-magnitude words are deliberately KEPT', () => {
    for (const word of ['thousand', 'thousands', 'million', 'millions', 'mil', 'millones']) {
      assert.ok(!CHAT_EXEMPT_NUMBER_WORDS.has(word), `"${word}" must stay checked — it is a cost estimate`);
    }
  });
});

// ─── The correction ────────────────────────────────────────────────────────

describe('the correction', () => {
  const violations = checkAnswerNumbers(
    'About 78% of budget, so roughly $1,200, over 23 days, on 5 units.',
    R,
  ).violations;

  test('names the offending figures so the reader knows what to distrust', () => {
    const en = numberGuardCorrection('en', violations);
    assert.match(en, /can't back those figures/i);
    assert.match(en, /78/);
    assert.match(en, /1,200/);
  });

  test('caps the list and says how many more there are', () => {
    const en = numberGuardCorrection('en', violations);
    assert.match(en, /and 1 more/);
  });

  test('introduces no number the answer did not already contain', () => {
    // A retraction that itself printed an unbacked figure would be the bug
    // wearing a warning label. Every numeral in it must come from the tokens.
    const en = numberGuardCorrection('en', violations);
    const tokens = new Set(violationTokens(violations));
    const listed = en.split('records or in anything I looked up just now:')[1] ?? '';
    for (const m of listed.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
      const raw = m[0];
      assert.ok(
        tokens.has(raw) || /and \d+ more/.test(listed),
        `the correction printed "${raw}", which the answer never said`,
      );
    }
  });

  test('is bilingual, and the two are not the same string', () => {
    const en = numberGuardCorrection('en', violations);
    const es = numberGuardCorrection('es', violations);
    assert.match(es, /no puedo respaldar esas cifras/i);
    assert.notEqual(en, es);
  });

  test('an empty violation list still produces a well-formed line', () => {
    assert.match(numberGuardCorrection('en', []), /can't back those figures/i);
  });
});

describe('picking the language of the retraction', () => {
  test('Spanish answers get Spanish', () => {
    assert.equal(
      detectAnswerLanguage('Staxis tiene tres cosas abiertas; la habitación 214 es la que hay que revisar.'),
      'es',
    );
  });

  test('English answers get English', () => {
    assert.equal(detectAnswerLanguage('Staxis has 3 findings open; 214 is the one to look at.'), 'en');
  });

  test('one Spanish word inside an English answer does not flip it', () => {
    // A quoted room note is not a change of language.
    assert.equal(detectAnswerLanguage('The note on 214 says "para revisar" — worth a look.'), 'en');
  });
});

// ─── The derived figures the guard makes the tools responsible for ─────────

describe('derived finance figures are computed in code', () => {
  test('month pace: a current month is counted to today, in the hotel timezone', () => {
    // 2026-07-15T12:00Z is the 15th in Chicago. July has 31 days.
    const pace = monthPace('2026-07', 'America/Chicago', new Date('2026-07-15T12:00:00Z'));
    assert.deepEqual(pace, { dayOfMonth: 15, daysInMonth: 31, pctElapsed: 48 });
  });

  test('month pace: the hotel timezone decides the day, not the server', () => {
    // 04:00Z on the 1st is still 23:00 on the 30th in Chicago. A server-clock
    // implementation reports a fresh month here; the hotel is still closing the
    // old one. Same bug class as resolveMonth's own timezone note.
    const pace = monthPace('2026-06', 'America/Chicago', new Date('2026-07-01T04:00:00Z'));
    assert.deepEqual(pace, { dayOfMonth: 30, daysInMonth: 30, pctElapsed: 100 });
  });

  test('month pace: a month that is not the current one is complete', () => {
    const pace = monthPace('2026-06', 'America/Chicago', new Date('2026-07-15T12:00:00Z'));
    assert.deepEqual(pace, { dayOfMonth: 30, daysInMonth: 30, pctElapsed: 100 });
  });

  test('month pace: February leap years are not hand-waved', () => {
    assert.equal(monthPace('2028-02', 'America/Chicago', new Date('2028-03-05T12:00:00Z'))?.daysInMonth, 29);
    assert.equal(monthPace('2026-02', 'America/Chicago', new Date('2026-03-05T12:00:00Z'))?.daysInMonth, 28);
  });

  test('month pace: a malformed key returns nothing rather than a guess', () => {
    for (const bad of ['2026-13', 'July 2026', '2026', '']) {
      assert.equal(monthPace(bad, 'America/Chicago', new Date('2026-07-15T12:00:00Z')), null, bad);
    }
  });

  test('share of total: whole percent, and absent when there is no denominator', () => {
    assert.equal(pctOfTotal(215000, 842000), 26);
    assert.equal(pctOfTotal(0, 842000), 0);
    assert.equal(pctOfTotal(842000, 842000), 100);
    // "0% of nothing" reads as a fact about spending; it is a fact about there
    // being no denominator. An absent field cannot be misread.
    assert.equal(pctOfTotal(215000, 0), null);
    assert.equal(pctOfTotal(215000, -1), null);
  });

  test('spend per occupied room: rounded cents, and absent at zero occupancy', () => {
    assert.equal(centsPerOccupiedRoom(215000, 100), 2150);
    assert.equal(centsPerOccupiedRoom(215000, 3), 71667);
    assert.equal(centsPerOccupiedRoom(215000, 0), null);
    assert.equal(centsPerOccupiedRoom(215000, -4), null);
  });

  test('planned spend: the share, what is left after, and whether it breaks the budget', () => {
    // $600 against a $3,500 budget with $2,150 already spent. The live smoke
    // that motivated this field had the model REFUSE this question and tell the
    // manager to do the arithmetic themselves.
    assert.deepEqual(plannedSpendImpact(60000, 350000, 215000), {
      pctOfBudget: 17,
      remainingAfterCents: 75000,
      wouldExceed: false,
    });
  });

  test('planned spend: exactly exhausting the budget is not exceeding it', () => {
    const impact = plannedSpendImpact(135000, 350000, 215000);
    assert.equal(impact?.remainingAfterCents, 0);
    assert.equal(impact?.wouldExceed, false);
    assert.equal(plannedSpendImpact(135001, 350000, 215000)?.wouldExceed, true);
  });

  test('planned spend: a department already over budget goes further under', () => {
    // $4,180 spent against $4,000. Another $200 must read as deeper in the red,
    // not as a fresh percentage of an untouched budget.
    const impact = plannedSpendImpact(20000, 400000, 418000);
    assert.equal(impact?.remainingAfterCents, -38000);
    assert.equal(impact?.wouldExceed, true);
  });

  test('planned spend: no budget means no percentage, not a zero', () => {
    assert.equal(plannedSpendImpact(60000, 0, 0), null);
    assert.equal(plannedSpendImpact(-1, 350000, 0), null);
    assert.equal(plannedSpendImpact(Number.NaN, 350000, 0), null);
  });

  test('a figure the tool computed is one the model may quote', () => {
    // The two halves have to meet: code computes it, it lands in the payload,
    // and the guard therefore backs it. If this fails, the derived metrics are
    // decoration and the model is still doing the arithmetic.
    const r = receipt({
      toolPayloads: [{
        monthProgress: { dayOfMonth: 15, daysInMonth: 31, pctElapsed: '48%' },
        byDepartment: [{ department: 'Maintenance', pctUsed: '61%', pctOfHotelSpend: '26%' }],
        plannedSpend: { amount: '$600.00', pctOfBudget: '17%', remainingAfter: '$750.00', wouldExceed: false },
      }],
    });
    assert.deepEqual(
      violationTokens(checkAnswerNumbers(
        'Maintenance is at 61% of its budget and you are 48% through the month — 26% of everything spent. '
        + 'The $600.00 is 17% of the budget and would leave $750.00.',
        r,
      ).violations),
      [],
    );
  });
});

// ─── The gate: who is graded at all ────────────────────────────────────────

describe('the guard runs on conversations and nowhere else', () => {
  const toolContext = {
    user: {
      uid: '33333333-3333-4333-8333-333333333333',
      accountId: '33333333-3333-4333-8333-333333333333',
      username: 'probe',
      displayName: 'Probe',
      role: 'general_manager' as const,
      propertyAccess: ['11111111-1111-4111-8111-111111111111'],
    },
    propertyId: '11111111-1111-4111-8111-111111111111',
    staffId: null,
    requestId: 'number-guard-test',
    surface: 'chat' as const,
  };

  /** The unbacked sentence both cases below hand back. */
  const UNBACKED = 'Occupancy averaged 78% across the period.';

  async function runWith(tools: RunAgentOpts['tools']): Promise<string> {
    const fake = createFakeModel([{ blocks: [{ type: 'text', text: UNBACKED }] }]);
    const result = await runAgent({
      systemPrompt: { stable: 'You are a test agent.', dynamic: '', factual: '' },
      history: [],
      newUserMessage: 'summarise the week',
      tools,
      toolContext,
      modelClient: fake.client,
    });
    return result.text;
  }

  test('a conversational turn IS graded', async () => {
    const text = await runWith([
      {
        name: 'number_guard_probe_tool',
        description: 'Test-only read tool.',
        inputSchema: { type: 'object', properties: {} },
        allowedRoles: ['general_manager'],
        mutates: false,
        handler: async () => ({ ok: true as const, data: {} }),
      },
    ]);
    assert.match(text, /can't back those figures/i, 'a chat turn escaped the guard');
    assert.match(text, /78/);
  });

  test('a background caller with no tools is NOT graded', async () => {
    // Every background caller in the codebase runs with `tools: []` — the
    // summarizer, the findings judge, the nightly sweep, the memory
    // consolidator, both knowledge-intake routes, the brief writer. Several
    // exist precisely to RESTATE earlier assistant text, which this guard
    // treats as unbacked by construction. Grading them would append a
    // correction to every summary the product writes.
    const text = await runWith([]);
    assert.equal(text, UNBACKED, 'a background one-shot was corrected as if it were a chat answer');
  });
});
