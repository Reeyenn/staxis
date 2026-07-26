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
  evaluateDemotion,
  isDormantAt,
} from '@/lib/findings/demotion';
import { findingQuestionTopic, toQuestionCandidate } from '@/lib/findings/ask-drip';
import { selectQuestion, type AskRecord, type QuestionCandidate } from '@/lib/agent/drip-questions';

const T = DEMOTION_THRESHOLDS;

function engagement(over: Partial<{ shown: number; acted: number; spanDays: number }> = {}) {
  return { shown: T.minShown, acted: 0, spanDays: T.minSpanDays, ...over };
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
    assert.match(verdict.reason, /nothing ever acted on/);
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

  test('a single engagement vetoes any amount of ignoring', () => {
    const verdict = evaluateDemotion(engagement({ shown: 500, spanDays: 365, acted: 1 }));
    assert.equal(verdict.demote, false);
    assert.match(verdict.reason, /still useful here/);
  });

  test('the veto is checked FIRST, so the reason a check survived is the true one', () => {
    // A check shown twice and acted on once is kept for the right reason —
    // somebody read it — not for the incidental one that it was shown rarely.
    const verdict = evaluateDemotion({ shown: 2, acted: 1, spanDays: 2 });
    assert.equal(verdict.demote, false);
    assert.match(verdict.reason, /still useful/);
  });

  test('the thresholds themselves stay conservative', () => {
    // Pinned deliberately: loosening these is a product decision about how
    // easily Staxis stops watching something, not a tuning detail.
    assert.ok(T.minShown >= 10, 'fewer than ten shows is not evidence about a check');
    assert.equal(T.maxActed, 0, 'any engagement at all must keep a check at full volume');
    assert.ok(T.minSpanDays >= 21, 'three weeks is the floor for calling something ignored');
  });

  test('every rejection says why in words a person could read back', () => {
    for (const e of [
      engagement({ acted: 3 }),
      engagement({ shown: 0 }),
      engagement({ spanDays: 0 }),
    ]) {
      const verdict = evaluateDemotion(e);
      assert.equal(verdict.demote, false);
      assert.ok(verdict.reason.length > 10, `a bare "no" is not auditable: ${verdict.reason}`);
    }
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
