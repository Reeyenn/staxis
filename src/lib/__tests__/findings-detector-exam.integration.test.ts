/**
 * THE PRACTICE EXAM — a frozen, labelled corpus of hotel-days that grades the
 * pattern engine's deterministic half every time anybody changes it.
 *
 * WHAT THIS REPLACES
 * "The detectors work" used to be provable only by shipping and waiting. A
 * threshold nudged by one digit, a like-for-like control quietly dropped, a
 * dedupe key that started carrying the measurement — none of those break a
 * build, and all of them surface weeks later as a manager who stopped reading
 * the cards. Now each of them fails a named day with a sentence saying which
 * planted pattern went missing, or which finding was invented.
 *
 * HOW IT WORKS
 * Production migrations applied to PGlite, the PostgREST shim compiling the
 * real query builder into real SQL, one HOTEL PER EXAM DAY, and the REAL runner
 * — real feeds, real detectors, real silencer, real price arithmetic — over
 * each one. No fake client anywhere: the failure this corpus most needs to
 * catch includes "the loader selects a column that does not exist", and a fake
 * answers a misspelling as happily as the right name. (It caught exactly that
 * on its first run; see tests/exam/days/cleaning-plan-health.ts.)
 *
 * WHAT IT DELIBERATELY DOES NOT GRADE
 * The judge and every other model call. `skipJudge` is on for every run in this
 * file, so there is no network, no provider and no non-determinism: a corpus
 * that scored an LLM's phrasing would go amber on a Tuesday for no reason
 * anybody could act on. Prose has its own guards; this grades arithmetic.
 *
 * THE RATCHET
 * The suite enumerates the live registry and fails when a registered detector
 * has no exam days. Adding a detector without adding its exam breaks the build
 * in the same commit — which is the only version of "no detector without its
 * exam" that survives contact with a deadline.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { runDetectorEvalCases } from '@/lib/findings/evals';
import { allDetectors, getDetector } from '@/lib/findings/registry';
import { runFindingsForProperty } from '@/lib/findings/runner';
import { listFindings } from '@/lib/findings/store';
import type { Finding, FindingRunSummary } from '@/lib/findings/types';
// Registering the detectors is a module side effect, and the ratchet below
// reads the registry — so the exam must import them exactly as the runner does.
import '@/lib/findings/detectors';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import { createPglitePostgrest, loadCatalog } from '../../../tests/fixtures/postgrest-pglite';
import {
  EXAM_DAYS,
  POSITIVE_UNREACHABLE_FROM_DATA,
  coverageGaps,
  duplicateDayIds,
} from '../../../tests/exam';
import { gradeDay, summaryLine, type DayResult, type ObservedAction } from '../../../tests/exam/grade';
import { createExamHotel, EXAM_TIMEZONE } from '../../../tests/exam/plant';
import type { ExamPlanter } from '../../../tests/exam/types';

/**
 * One clock for the whole exam. Every seed script and every run reads it, so a
 * day cannot change its verdict because the suite happened to cross midnight
 * between planting and running.
 */
const EXAM_NOW = new Date();

let pg: PGlite;
const results: DayResult[] = [];
let plantedPatterns = 0;
let writtenFindings = 0;

/** The offers the runner attached to tonight's cards, keyed by problem. */
async function loadActions(propertyId: string): Promise<ObservedAction[]> {
  const rows = await pg.query<{ dedupe_key: string; action_kind: string }>(
    `select f.dedupe_key, a.action_kind
       from finding_actions a join findings f on f.id = a.finding_id
      where a.property_id = $1`,
    [propertyId],
  );
  return rows.rows.map((r) => ({ dedupeKey: r.dedupe_key, kind: r.action_kind }));
}

async function totalRows(propertyId: string): Promise<number> {
  const rows = await pg.query<{ n: number }>(
    `select count(*)::int as n from findings where property_id = $1`,
    [propertyId],
  );
  return rows.rows[0]?.n ?? 0;
}

/** Findings a manager would actually see, plus the silenced ones the grader
 *  must NOT count as visible. `listFindings` defaults to open+updated, which is
 *  exactly the set a card renders. */
async function visibleFindings(propertyId: string): Promise<Finding[]> {
  return listFindings(propertyId, { limit: 500 });
}

describe('the detector practice exam', () => {
  before(async () => {
    const migrated = await applyMigrationsToPglite();
    pg = migrated.pg;
    const catalog = await loadCatalog(pg);
    const shim = createPglitePostgrest(pg, catalog);
    // @ts-expect-error installing the pglite-backed client on the singleton
    supabaseAdmin.from = shim.from;
    // @ts-expect-error installing the pglite-backed client on the singleton
    supabaseAdmin.rpc = shim.rpc;
  });

  after(async () => {
    await pg.close().catch(() => undefined);
  });

  // ── the ratchet ─────────────────────────────────────────────────────────

  describe('the exam still covers the library', () => {
    test('every registered detector has exam days, a firing day and a silent day', () => {
      const registered = allDetectors().map((d) => d.declaration.id);
      const gaps = coverageGaps(registered);
      assert.deepEqual(
        gaps.map((g) => `${g.detectorId}: ${g.because}`),
        [],
        'A detector without its exam is a detector nobody can prove anything about. ' +
          'Add days to tests/exam/days/ and register them in tests/exam/index.ts.',
      );
    });

    test('exam day ids are unique — every failure sentence quotes one', () => {
      assert.deepEqual(duplicateDayIds(), []);
    });

    test('a waived detector still proves its firing branch some other way', () => {
      for (const [detectorId, reason] of Object.entries(POSITIVE_UNREACHABLE_FROM_DATA)) {
        assert.ok(reason.length > 40, `${detectorId}'s waiver has no real reason on it`);
        const detector = getDetector(detectorId);
        assert.ok(detector, `${detectorId} is waived but not registered`);
        const cases = runDetectorEvalCases(detector!);
        const positives = cases.filter((c) => c.expected.length > 0);
        assert.ok(
          positives.length > 0,
          `${detectorId} is waived from a firing exam day AND ships no frozen case where it ` +
            'fires. Nothing in the repo then proves it can speak at all.',
        );
        assert.deepEqual(
          positives.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`),
          [],
        );
      }
    });
  });

  // ── the corpus ──────────────────────────────────────────────────────────

  describe('every labelled hotel-day', () => {
    for (const [index, day] of EXAM_DAYS.entries()) {
      test(`${day.id} — ${day.title}`, async () => {
        const ctx: ExamPlanter = await createExamHotel({
          pg,
          dayIndex: index,
          now: EXAM_NOW,
          timezone: day.timezone ?? EXAM_TIMEZONE,
          enabledSections: day.enabledSections,
        });
        await day.seed(ctx);

        const subs = {
          businessDate: ctx.businessDate,
          itemId: (slot: number) => ctx.itemId(slot),
        };

        const runOnce = async (): Promise<FindingRunSummary> =>
          runFindingsForProperty(ctx.propertyId, {
            now: EXAM_NOW,
            skipJudge: true,
            skipDemotion: true,
          });

        const first = await runOnce();
        const firstFindings = await visibleFindings(ctx.propertyId);
        plantedPatterns += day.expect.length;
        writtenFindings += firstFindings.length;

        const nightOne = gradeDay({
          day,
          pass: 'night one',
          expected: day.expect,
          silent: day.silent,
          summary: first,
          findings: firstFindings,
          actions: await loadActions(ctx.propertyId),
          subs,
          totalRows: await totalRows(ctx.propertyId),
        });
        results.push(nightOne);

        if (day.secondNight) {
          await day.secondNight.handOfTheManager?.(ctx);
          await day.secondNight.mutate(ctx);
          const second = await runOnce();
          const secondFindings = await visibleFindings(ctx.propertyId);
          plantedPatterns += day.secondNight.expect.length;
          writtenFindings += secondFindings.length;

          results.push(
            gradeDay({
              day,
              pass: 'night two',
              expected: day.secondNight.expect,
              silent: day.silent,
              summary: second,
              findings: secondFindings,
              actions: await loadActions(ctx.propertyId),
              subs,
              totalRows: await totalRows(ctx.propertyId),
              maxTotalRows: day.secondNight.maxTotalRows,
            }),
          );
        }

        const failures = results
          .filter((r) => r.dayId === day.id)
          .flatMap((r) => r.failures);
        assert.deepEqual(
          failures.map((f) => `[${f.kind}] ${f.message}`),
          [],
          `${day.id} — ${day.why}`,
        );
      });
    }
  });

  // ── the score ───────────────────────────────────────────────────────────

  describe('the whole exam', () => {
    test('recall and precision are both 100%, and the corpus says how big it is', () => {
      const failures = results.flatMap((r) => r.failures);
      const score = {
        days: EXAM_DAYS.length,
        assertions: results.reduce((sum, r) => sum + r.assertions, 0),
        recallFailures: failures.filter((f) => f.kind === 'recall').length,
        precisionFailures: failures.filter((f) => f.kind === 'precision').length,
      };
      console.log(summaryLine(score, { planted: plantedPatterns, written: writtenFindings }));
      assert.deepEqual(failures.map((f) => f.message), []);
      assert.ok(plantedPatterns > 20, 'a corpus this small proves less than it costs to run');
    });
  });
});
