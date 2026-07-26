/**
 * Self-demotion's decision, and the adapter that turns a finding into a
 * question — both as pure functions, with no clock and no database.
 *
 * WHY THE POLICY IS TESTED HERE AND THE MECHANICS ARE TESTED ELSEWHERE
 * `findings-learning-loop.integration.test.ts` proves the state row, the
 * per-hotel isolation, the run summary and the re-arm against a real Postgres,
 * because those are database-shaped guarantees. What is left is the JUDGEMENT —
 * "has this check earned its rest?" — and a judgement should be provable by
 * reading it, so it lives in a pure function and is exercised here.
 *
 * The asymmetry that shapes every threshold below: a wrong demotion is SILENT.
 * A manager never learns that the check which would have caught the leak has
 * been asleep since April. A check that should have demoted and did not merely
 * costs them a scroll. So every case here leans toward keeping the check loud.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEMOTION_LADDER,
  DEMOTION_THRESHOLDS,
  DORMANT,
  demoteDisposition,
  engagementSince,
  evaluateDemotion,
  evaluateRearm,
  isDormantAt,
  positiveEngagement,
  type DetectorEngagement,
  type DetectorLedger,
  type DetectorState,
} from '@/lib/findings/demotion';
import { findingQuestionTopic, toQuestionCandidate } from '@/lib/findings/ask-drip';
import { selectQuestion, type AskRecord, type QuestionCandidate } from '@/lib/agent/drip-questions';

const T = DEMOTION_THRESHOLDS;

/** The silence case: shown enough, ignored long enough, nothing refused. */
function engagement(over: Partial<DetectorEngagement> = {}): DetectorEngagement {
  return {
    shown: T.minShown,
    acted: 0,
    declineActed: 0,
    declinedProblems: 0,
    declineSpanDays: 0,
    spanDays: T.minSpanDays,
    ...over,
  };
}

/**
 * N distinct problems refused, spread over `spanDays`, and nothing else. Each
 * refusal is one tap, so `acted` and `declineActed` move together and the
 * positive half is zero — which is what "they only ever said no" looks like in
 * these counters.
 */
function refusals(count: number, spanDays = T.minDeclineSpanDays): DetectorEngagement {
  return engagement({
    shown: count,
    acted: count,
    declineActed: count,
    declinedProblems: count,
    declineSpanDays: count < 2 ? 0 : spanDays,
    // Short of the silence rule on purpose: any demotion these cases produce
    // has to have come from the refusals, not from being ignored as well.
    spanDays: Math.min(spanDays, T.minSpanDays - 1),
  });
}

// ─── the ladder ─────────────────────────────────────────────────────────────

describe('the ladder a check falls down', () => {
  test('it is propose → recommend → fyi → resting, in that order', () => {
    assert.deepEqual([...DEMOTION_LADDER], ['propose', 'recommend', 'fyi']);
    assert.equal(demoteDisposition('propose', 0), 'propose');
    assert.equal(demoteDisposition('propose', 1), 'recommend');
    assert.equal(demoteDisposition('propose', 2), 'fyi');
    assert.equal(demoteDisposition('propose', 3), DORMANT);
  });

  test('a check that starts quieter has less far to fall', () => {
    assert.equal(demoteDisposition('fyi', 1), DORMANT);
    assert.equal(demoteDisposition('recommend', 1), 'fyi');
    assert.equal(demoteDisposition('recommend', 2), DORMANT);
  });

  test('past the bottom rung there is only rest — a check cannot fall off the ladder', () => {
    assert.equal(demoteDisposition('propose', 99), DORMANT);
    assert.equal(isDormantAt('propose', 3), true);
    assert.equal(isDormantAt('propose', 2), false);
  });

  test("'ask' and 'drop' are not volume settings and never rest", () => {
    // They are the judge's vocabulary for "this is a question" and "do not
    // surface this". Quieting a question is meaningless; resting one would
    // silently disable a detector nobody chose to disable.
    assert.equal(demoteDisposition('ask', 3), 'ask');
    assert.equal(demoteDisposition('drop', 3), 'drop');
    assert.equal(isDormantAt('ask', 99), false);
  });
});

// ─── the judgement ──────────────────────────────────────────────────────────

describe('has this check earned its rest?', () => {
  test('exactly at the threshold, it demotes', () => {
    const verdict = evaluateDemotion(engagement());
    assert.equal(verdict.demote, true);
    assert.match(verdict.reason, /nothing ever taken up/);
  });

  test('one show short, it does not', () => {
    const verdict = evaluateDemotion(engagement({ shown: T.minShown - 1 }));
    assert.equal(verdict.demote, false);
    assert.match(verdict.reason, /under the/);
  });

  test('one day short of three weeks, it does not — a bad fortnight is not a verdict', () => {
    const verdict = evaluateDemotion(engagement({ spanDays: T.minSpanDays - 1 }));
    assert.equal(verdict.demote, false);
    assert.match(verdict.reason, /days/);
  });

  test('a single POSITIVE engagement vetoes any amount of ignoring', () => {
    const verdict = evaluateDemotion(engagement({ shown: 500, spanDays: 365, acted: 1 }));
    assert.equal(verdict.demote, false);
    assert.match(verdict.reason, /still useful here/);
  });

  test('the veto is checked FIRST, so the reason a check survived is the true one', () => {
    // A check shown twice and acted on once is kept for the right reason —
    // somebody read it — not for the incidental one that it was shown rarely.
    const verdict = evaluateDemotion(engagement({ shown: 2, acted: 1, spanDays: 2 }));
    assert.equal(verdict.demote, false);
    assert.match(verdict.reason, /still useful/);
  });

  test('the thresholds themselves stay conservative', () => {
    // Pinned deliberately: loosening these is a product decision about how
    // easily Staxis stops watching something, not a tuning detail.
    assert.ok(T.minShown >= 10, 'fewer than ten shows is not evidence about a check');
    assert.equal(T.maxPositiveActed, 0, 'anyone taking it up must keep a check at full volume');
    assert.ok(T.minSpanDays >= 21, 'three weeks is the floor for calling something ignored');
    assert.ok(T.minDeclinedProblems >= 5, 'four refusals is a run of bad luck, not a verdict');
    assert.ok(T.minDeclineSpanDays >= 7, 'one annoyed morning must not quieten anything');
  });

  test('every rejection says why in words a person could read back', () => {
    for (const e of [
      engagement({ acted: 3 }),
      engagement({ shown: 0 }),
      engagement({ spanDays: 0 }),
      refusals(1),
    ]) {
      const verdict = evaluateDemotion(e);
      assert.equal(verdict.demote, false);
      assert.ok(verdict.reason.length > 10, `a bare "no" is not auditable: ${verdict.reason}`);
    }
  });
});

// ─── declining is not the same as caring ────────────────────────────────────
//
// Founder ruling, 2026-07-26. The rule these cases replace was "ANY engagement
// vetoes demotion", and because "Not doing this" counts as engagement, the
// loudest way a manager could say STOP was also the surest way to keep a check
// at full volume forever. Every case below exists to keep that from coming back.

describe('a check this hotel keeps refusing gets quieter, not louder', () => {
  test('twenty separate problems refused over a week: down a rung', () => {
    const verdict = evaluateDemotion(refusals(20));
    assert.equal(verdict.demote, true);
    assert.match(verdict.reason, /not doing this/i);
    assert.match(verdict.reason, /20 separate problems/);
  });

  test('ONE refusal quietens nothing — muting already silenced that problem', () => {
    const verdict = evaluateDemotion(refusals(1));
    assert.equal(verdict.demote, false, 'one "no" is about one problem, not about the check');
  });

  test('one short of the threshold, still nothing', () => {
    const verdict = evaluateDemotion(refusals(T.minDeclinedProblems - 1));
    assert.equal(verdict.demote, false);
  });

  // The two above move with the constant. These do not, on purpose: the count
  // is a product decision about how fast Staxis stops talking, and lowering it
  // must break something that says a number out loud.
  test('FOUR refusals, spread over a fortnight, is still not a verdict', () => {
    assert.equal(evaluateDemotion(refusals(4, 14)).demote, false);
  });

  test('TWO refusals a month apart is not a verdict either', () => {
    assert.equal(evaluateDemotion(refusals(2, 30)).demote, false);
  });

  test('exactly at the threshold, and exactly at the span, it demotes', () => {
    const verdict = evaluateDemotion(refusals(T.minDeclinedProblems, T.minDeclineSpanDays));
    assert.equal(verdict.demote, true);
  });

  test('a queue cleared in one sitting is a mood, not a verdict', () => {
    // Fifty refusals, all of them today. The manager was annoyed on Tuesday;
    // that is not the same as the check being wrong for this hotel, and the
    // span rule is what tells the two apart.
    const verdict = evaluateDemotion(
      engagement({
        shown: 50,
        acted: 50,
        declineActed: 50,
        declinedProblems: 50,
        declineSpanDays: T.minDeclineSpanDays - 1,
        spanDays: 3,
      }),
    );
    assert.equal(verdict.demote, false);
  });

  test('the same problem refused twenty times is ONE refusal', () => {
    // Counted per problem by construction — `declinedProblems` is a distinct
    // count, so twenty taps on one card cannot reach the threshold. Proven for
    // real against dedupe keys in engagementSince below.
    const verdict = evaluateDemotion(
      engagement({
        shown: 20,
        acted: 20,
        declineActed: 20,
        declinedProblems: 1,
        declineSpanDays: 30,
        spanDays: T.minSpanDays - 1, // short of the silence rule, so only refusals could demote
      }),
    );
    assert.equal(verdict.demote, false);
  });

  test('one "Handled it" beats twenty refusals — positive wins outright', () => {
    const mixed = refusals(20);
    const verdict = evaluateDemotion({ ...mixed, acted: mixed.acted + 1 });
    assert.equal(verdict.demote, false);
    assert.match(verdict.reason, /still useful here/);
    assert.equal(positiveEngagement({ ...mixed, acted: mixed.acted + 1 }), 1);
  });

  test('opening the numbers and THEN refusing is a refusal, not a reading', () => {
    // Two taps on one card that ended in "not doing this". Counting the first
    // as approval would let a single moment of curiosity keep a check loud
    // through twenty refusals — the terminal verdict is what the card meant.
    const verdict = evaluateDemotion(
      engagement({
        shown: 20,
        acted: 40, // twenty cards, receipt opened on each, then refused
        declineActed: 40,
        declinedProblems: 20,
        declineSpanDays: 14,
        spanDays: 14,
      }),
    );
    assert.equal(verdict.demote, true);
    assert.match(verdict.reason, /not doing this/i);
  });

  test('the positive half can never go negative and swing the other way', () => {
    assert.equal(positiveEngagement(engagement({ acted: 2, declineActed: 9 })), 0);
  });

  test('a refusal below the threshold no longer props up a check nobody reads', () => {
    // The old rule let one "no" veto three weeks of silence. Under the ruling a
    // refusal points the same way silence does, so the silence path still runs.
    const verdict = evaluateDemotion(
      engagement({ shown: T.minShown, acted: 1, declineActed: 1, declinedProblems: 1 }),
    );
    assert.equal(verdict.demote, true);
    assert.match(verdict.reason, /nothing ever taken up/);
  });
});

// ─── and back up again ──────────────────────────────────────────────────────

describe('a check somebody takes up again climbs back', () => {
  test('one positive engagement is enough', () => {
    const verdict = evaluateRearm(engagement({ acted: 1 }));
    assert.equal(verdict.rearm, true);
    assert.match(verdict.reason, /taken up/);
  });

  test('refusals do not count as taking it up', () => {
    assert.equal(evaluateRearm(refusals(20)).rearm, false);
  });

  test('nothing at all does not either', () => {
    const verdict = evaluateRearm(engagement({ shown: 90, acted: 0 }));
    assert.equal(verdict.rearm, false);
    assert.ok(verdict.reason.length > 10, `a bare "no" is not auditable: ${verdict.reason}`);
  });

  test('climbing back is deliberately easier than falling — the asymmetry is the point', () => {
    // Too loud costs a scroll. Too quiet costs the leak nobody was told about.
    assert.ok(
      T.minRearmPositiveActed <= T.minDeclinedProblems,
      'earning volume back must never be harder than losing it',
    );
    assert.equal(T.minRearmPositiveActed, 1);
  });
});

// ─── the window the decision is made over ───────────────────────────────────

describe('what counts as having happened SINCE the baseline', () => {
  const NOW = new Date('2026-07-26T12:00:00Z');
  const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

  const state = (over: Partial<DetectorState> = {}): DetectorState => ({
    propertyId: 'p1',
    detectorId: 'd1',
    stepsDown: 0,
    dormant: false,
    dormantSince: null,
    baselineShown: 0,
    baselineActed: 0,
    baselineAt: day(30),
    rearmedAt: null,
    ...over,
  });

  const ledger = (over: Partial<DetectorLedger> = {}): DetectorLedger => ({
    shown: 0,
    acted: 0,
    declines: [],
    ...over,
  });

  test('refusals from before the baseline are spent and cannot demote twice', () => {
    const e = engagementSince(
      ledger({
        acted: 9,
        declines: [
          { dedupeKey: 'a', at: day(40), acted: 1 },
          { dedupeKey: 'b', at: day(35), acted: 1 },
          { dedupeKey: 'c', at: day(5), acted: 1 },
        ],
      }),
      state({ baselineAt: day(30) }),
      NOW,
    );
    assert.equal(e.declinedProblems, 1, 'only the one after the baseline is still evidence');
  });

  test('one problem refused twice counts once, and the span keeps the earlier one', () => {
    const e = engagementSince(
      ledger({
        declines: [
          { dedupeKey: 'a', at: day(20), acted: 1 },
          { dedupeKey: 'a', at: day(2), acted: 1 },
          { dedupeKey: 'b', at: day(1), acted: 1 },
        ],
      }),
      state(),
      NOW,
    );
    assert.equal(e.declinedProblems, 2);
    assert.equal(Math.round(e.declineSpanDays), 19, 'from the first sighting of the first refusal');
  });

  test('a single refusal has no span, and a span of one day is not a week', () => {
    assert.equal(
      engagementSince(ledger({ declines: [{ dedupeKey: 'a', at: day(3), acted: 1 }] }), state(), NOW)
        .declineSpanDays,
      0,
    );
    const sameDay = engagementSince(
      ledger({
        declines: [
          { dedupeKey: 'a', at: day(3), acted: 1 },
          { dedupeKey: 'b', at: day(3), acted: 1 },
        ],
      }),
      state(),
      NOW,
    );
    assert.equal(sameDay.declineSpanDays, 0);
  });

  test('an unreadable baseline demotes nothing rather than everything', () => {
    const e = engagementSince(
      ledger({
        shown: 900,
        acted: 0,
        declines: Array.from({ length: 20 }, (_, i) => ({
          dedupeKey: `k${i}`,
          at: day(i),
          acted: 1,
        })),
      }),
      state({ baselineAt: 'not a date' }),
      NOW,
    );
    assert.equal(e.declinedProblems, 0);
    assert.equal(e.spanDays, 0);
    assert.equal(evaluateDemotion(e).demote, false, 'a broken state row must not rest a check');
  });

  test('the counters are measured from the baseline, not from the beginning of time', () => {
    const e = engagementSince(
      ledger({ shown: 40, acted: 6 }),
      state({ baselineShown: 30, baselineActed: 4 }),
      NOW,
    );
    assert.equal(e.shown, 10);
    assert.equal(e.acted, 2);
    assert.equal(Math.round(e.spanDays), 30);
  });
});

// ─── the ask → question adapter ─────────────────────────────────────────────

const ROW = {
  id: 'finding-1',
  detector_id: 'supply_spend_baseline',
  dedupe_key: 'supply_spend_baseline:week',
  summary: 'Supply spend was 3 times this hotel\'s own normal week.',
  judged_summary_en: 'Supply spend is well above normal, and the last count is 9 days old.',
  judged_summary_es: 'El gasto en suministros está muy por encima de lo normal.',
};

describe('a finding becomes a question the existing card can ask', () => {
  test('it is phrased as an actual question, in both languages', () => {
    const candidate = toQuestionCandidate(ROW)!;
    assert.ok(candidate);
    assert.ok(candidate.en.trim().endsWith('?'), `EN must be a question: ${candidate.en}`);
    assert.ok(candidate.es.trim().endsWith('?'), `ES must be a question: ${candidate.es}`);
    assert.notEqual(candidate.es, candidate.en, 'the Spanish path must be Spanish');
    assert.ok(candidate.en.length <= 300 && candidate.es.length <= 300, 'question_* CHECK is 300');
  });

  test('a finding the judge has not phrased in BOTH languages is not asked at all', () => {
    // question_es is NOT NULL and a Spanish speaker must never be handed
    // English wearing a Spanish label. Silence is the honest answer.
    assert.equal(toQuestionCandidate({ ...ROW, judged_summary_es: null }), null);
    assert.equal(toQuestionCandidate({ ...ROW, judged_summary_en: '   ' }), null);
  });

  test('the FACT a "yes" would store comes from the detector, not the model', () => {
    const candidate = toQuestionCandidate(ROW)!;
    assert.ok(
      candidate.fact.includes("own normal week"),
      `the deterministic summary is what gets written down forever: ${candidate.fact}`,
    );
    assert.ok(!candidate.fact.includes('9 days old'), 'the judge\'s phrasing is not the fact');
    assert.match(candidate.fact, /confirmed by a manager/i);
    assert.ok(candidate.fact.length <= 500, 'agent_memory.content CHECK is 500');
  });

  test('the topic is stable, bounded, and does not collide on a shared prefix', () => {
    const a = findingQuestionTopic('supply_spend_baseline', 'supply_spend_baseline:week');
    const again = findingQuestionTopic('supply_spend_baseline', 'supply_spend_baseline:week');
    const sharedPrefix = findingQuestionTopic(
      'supply_spend_baseline',
      'supply_spend_baseline:week_of_july_the_twenty_fifth_two_thousand_and_twenty_six',
    );

    assert.equal(a, again, 'a re-found problem must produce the same topic, or never-twice breaks');
    assert.notEqual(a, sharedPrefix, 'truncating instead of hashing would merge two problems');
    for (const topic of [a, sharedPrefix]) {
      assert.ok(topic.length <= 80, `agent_knowledge_questions.topic CHECK is 80: ${topic}`);
    }

    const longDetector = findingQuestionTopic('d'.repeat(64), 'k'.repeat(200));
    assert.ok(longDetector.length <= 80, `worst case must still fit: ${longDetector.length}`);
  });

  test('it carries the finding it came from, so an answer knows what to resolve', () => {
    assert.equal(toQuestionCandidate(ROW)!.findingId, 'finding-1');
    assert.equal(toQuestionCandidate(ROW)!.category, 'finding');
  });
});

// ─── and the existing rules still hold ──────────────────────────────────────

describe('finding questions obey the drip rules rather than bringing their own', () => {
  const fromFinding = (topic: string): QuestionCandidate => ({
    topic,
    category: 'finding',
    en: 'Is that a known problem here?',
    es: '¿Es un problema conocido aquí?',
    fact: 'A fact.',
    findingId: 'f1',
  });

  const TODAY = '2026-07-25';
  const YESTERDAY = '2026-07-24';

  const signal = {
    topic: 'op_maint_214_hvac',
    category: 'maintenance' as const,
    severity: 'attention' as const,
    targetLabel: 'Room 214',
    metric: '4 hvac work orders in 30 days',
    count: 4,
    windowDays: 30,
    targetKind: 'room' as const,
    targetValue: '214',
    detail: 'hvac',
  };

  function pick(over: Partial<Parameters<typeof selectQuestion>[0]> = {}) {
    return selectQuestion({
      signals: [signal],
      records: [],
      deactivatedTopics: [],
      today: TODAY,
      ...over,
    });
  }

  test('five finding questions still produce exactly one', () => {
    const chosen = pick({
      extra: ['a', 'b', 'c', 'd', 'e'].map((k) => fromFinding(`finding:det:${k}`)),
    });
    assert.ok(chosen);
    // The contract is a single object, not a list — there is no shape here that
    // could carry a second question to the client.
    assert.equal(chosen.topic, 'finding:det:a');
  });

  test('a finding question already answered is never asked again', () => {
    const records: AskRecord[] = [
      { topic: 'finding:det:a', status: 'answered_yes', lastAskedOn: YESTERDAY, askCount: 1 },
    ];
    const chosen = pick({ extra: [fromFinding('finding:det:a')], records });
    assert.equal(chosen?.topic, signal.topic, 'it falls through to the signal, not back to itself');
  });

  test('a finding question declined is never asked again either', () => {
    const records: AskRecord[] = [
      { topic: 'finding:det:a', status: 'declined', lastAskedOn: YESTERDAY, askCount: 1 },
    ];
    assert.notEqual(pick({ extra: [fromFinding('finding:det:a')], records })?.topic, 'finding:det:a');
  });

  test('served today, it is gone for the rest of the day', () => {
    const records: AskRecord[] = [
      { topic: 'finding:det:a', status: 'asked', lastAskedOn: TODAY, askCount: 1 },
    ];
    assert.notEqual(pick({ extra: [fromFinding('finding:det:a')], records })?.topic, 'finding:det:a');
  });

  test('after enough unanswered asks it gives up for good', () => {
    const records: AskRecord[] = [
      { topic: 'finding:det:a', status: 'asked', lastAskedOn: YESTERDAY, askCount: 3 },
    ];
    assert.notEqual(pick({ extra: [fromFinding('finding:det:a')], records })?.topic, 'finding:det:a');
  });

  test('a finding question wins over a speculative pattern question', () => {
    // The judge already established something is off and concluded the data was
    // too thin to say what to DO. Asking is the correct response there; the
    // signal question is a guess looking for confirmation.
    const chosen = pick({ extra: [fromFinding('finding:det:a')] });
    assert.equal(chosen?.topic, 'finding:det:a');
  });

  test('with no finding questions, nothing about the old behaviour changes', () => {
    assert.equal(pick()?.topic, signal.topic);
    assert.equal(pick({ extra: [] })?.topic, signal.topic);
  });
});
