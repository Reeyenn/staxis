/**
 * THE NIGHTLY ROBOT WALKTHROUGH.
 *
 * A browser signs into the live site every night and uses it the way a manager
 * does. This file covers everything about that except the browser: the walk's
 * own control flow, the route the results are handed to, the health check that
 * notices when the robot stops running, and the registration that puts it on
 * Mission Control at all. The Playwright script is exercised by the workflow
 * against the real app, which is the only place it can be exercised honestly.
 *
 * The bar is "would this fail if I introduced a plausible bug here", and the
 * plausible bugs in a nightly robot are all quiet:
 *
 *   • One failing step aborts the walk, so fixing it only reveals the next one
 *     a night later.
 *   • A step that could not run because its prerequisite failed reports itself
 *     as broken too, and one problem becomes five red rows naming four
 *     innocent steps.
 *   • The run is stored but the failure never reaches the box the founder
 *     actually looks at.
 *   • The heartbeat lands on a broken night, so the job row reads "on time"
 *     while the app is unusable.
 *   • A crashed runner sends an empty step list and it reads as a clean night.
 *   • The failure message carries a timestamp, so a step broken for a week
 *     becomes seven rows nobody can count instead of one row saying 7x.
 *   • Retention silently stops, or worse, deletes the run that just arrived.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { NextRequest } from 'next/server';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { env } from '@/lib/env';
import { COMPOSER_COPY, whoWord } from '@/lib/feed/one-list-copy';
import type { ComposerPerson } from '@/lib/feed/parse-todo';
import {
  composerNamesAssignee,
  isRobotWalkArtifact,
  parseRobotWalkReport,
  robotWalkFailureMessage,
  robotWalkStepLabel,
  runRobotWalk,
  summarizeRobotWalk,
  ROBOT_WALK_ERROR_SOURCE,
  ROBOT_WALK_FRESH_HOURS,
  ROBOT_WALK_HEARTBEAT,
  ROBOT_WALK_MARKER,
  ROBOT_WALK_RETENTION_DAYS,
  ROBOT_WALK_STEPS,
  type RobotWalkStepResult,
} from '@/lib/automation/robot-walk';
import { ACTIVE_MISSION_JOBS } from '@/lib/automation/job-catalog';
import { SCHEDULE_REGISTRY } from '@/lib/cron-schedule-registry';
import { EXPECTED_CRONS, EXPECTED_MIGRATIONS_STATIC, runAllChecks } from '@/app/api/admin/doctor/route';
import { POST as reportWalk } from '@/app/api/admin/robot-walk/report/route';

// ═══════════════════════════════════════════════════════════════════════════
// A recording Supabase stub
// ═══════════════════════════════════════════════════════════════════════════
//
// Records what landed rather than whether something was called, so the
// assertions can be about the row a founder would end up reading.

interface Recorded { table: string; op: string; rows?: Record<string, unknown>[]; filters: Array<[string, unknown]> }

let calls: Recorded[] = [];
let rowsByTable: Record<string, Record<string, unknown>[]> = {};
let failingTables = new Set<string>();

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

function installStub(): void {
  (supabaseAdmin as unknown as { from: unknown }).from = (table: string) => {
    const record: Recorded = { table, op: 'select', filters: [] };
    calls.push(record);

    const settle = (resolve: (v: unknown) => unknown) => {
      if (failingTables.has(table)) {
        return resolve({ data: null, error: { message: `stub: ${table} refused`, code: 'XX000' } });
      }
      return resolve({ data: rowsByTable[table] ?? [], error: null });
    };

    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (c: string, v: unknown) => { record.filters.push([c, v]); return chain; },
      lt: (c: string, v: unknown) => { record.filters.push([c, v]); return chain; },
      gte: (c: string, v: unknown) => { record.filters.push([c, v]); return chain; },
      order: () => chain,
      limit: () => chain,
      insert: (rows: unknown) => {
        record.op = 'insert';
        record.rows = (Array.isArray(rows) ? rows : [rows]) as Record<string, unknown>[];
        return chain;
      },
      upsert: (rows: unknown) => {
        record.op = 'upsert';
        record.rows = (Array.isArray(rows) ? rows : [rows]) as Record<string, unknown>[];
        return chain;
      },
      update: (patch: unknown) => {
        record.op = 'update';
        record.rows = [patch as Record<string, unknown>];
        return chain;
      },
      delete: () => { record.op = 'delete'; return chain; },
      maybeSingle: () => ({ then: (r: (v: unknown) => unknown) => r({ data: (rowsByTable[table] ?? [])[0] ?? null, error: null }) }),
      then: settle,
    };
    return chain;
  };
}

beforeEach(() => {
  calls = [];
  rowsByTable = {};
  failingTables = new Set();
  installStub();
});

afterEach(() => {
  (supabaseAdmin as unknown as { from: unknown }).from = originalFrom;
});

function opsOn(table: string, op: string): Recorded[] {
  return calls.filter((c) => c.table === table && c.op === op);
}

function post(body: unknown, authorization = `Bearer ${env.CRON_SECRET}`): NextRequest {
  return new NextRequest('https://staxis.test/api/admin/robot-walk/report', {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const NOW = Date.parse('2026-08-06T10:00:00.000Z');
function reportBody(steps: RobotWalkStepResult[], over: Record<string, unknown> = {}) {
  return {
    startedAt: new Date(NOW - 300_000).toISOString(),
    finishedAt: new Date(NOW).toISOString(),
    steps,
    workflowRunUrl: 'https://github.com/Reeyenn/staxis/actions/runs/1',
    ...over,
  };
}

const ALL_PASSED: RobotWalkStepResult[] = ROBOT_WALK_STEPS.map((s) => ({ name: s.id, ok: true, ms: 10 }));

// ═══════════════════════════════════════════════════════════════════════════
// 1. The walk keeps walking
// ═══════════════════════════════════════════════════════════════════════════

describe('one broken step does not end the night', () => {
  test('every independent step still runs after a failure', async () => {
    const ran: string[] = [];
    const steps = [
      { id: 'staxis-list', run: async () => { ran.push('staxis-list'); throw new Error('list never rendered'); } },
      { id: 'teach-fact', run: async () => { ran.push('teach-fact'); } },
      { id: 'people-roster', run: async () => { ran.push('people-roster'); } },
      { id: 'sign-out', run: async () => { ran.push('sign-out'); } },
    ];

    const results = await runRobotWalk(steps);

    assert.deepEqual(ran, ['staxis-list', 'teach-fact', 'people-roster', 'sign-out']);
    assert.equal(results.find((r) => r.name === 'staxis-list')?.ok, false);
    assert.equal(results.filter((r) => r.ok).length, 3);
  });

  test('a step whose prerequisite failed is recorded as not attempted, not as broken', async () => {
    // The difference decides how many red rows the founder gets: only steps
    // that actually broke are reported, so one problem reads as one problem.
    let addRan = false;
    const results = await runRobotWalk([
      { id: 'staxis-list', run: async () => { throw new Error('list never rendered'); } },
      { id: 'add-todo', run: async () => { addRan = true; } },
      { id: 'complete-todo', run: async () => { throw new Error('should never run'); } },
    ]);

    assert.equal(addRan, false, 'a to-do was composed on a list that never rendered');
    const summary = summarizeRobotWalk(results);
    assert.deepEqual(summary.failed.map((s) => s.name), ['staxis-list']);
    assert.deepEqual(summary.skipped.map((s) => s.name), ['add-todo', 'complete-todo']);
    for (const skipped of summary.skipped) {
      assert.equal(skipped.ok, false, 'a step that never ran must not read as passed');
      assert.match(skipped.error ?? '', /Not attempted/);
    }
  });

  test('a step with no failed prerequisite runs even when something else broke', async () => {
    // teach-fact depends on sign-in, not on the list. A cascade that walked
    // the whole rest of the file would hide it.
    const results = await runRobotWalk([
      { id: 'add-todo', run: async () => { throw new Error('composer gone'); } },
      { id: 'teach-fact', run: async () => {} },
    ]);
    assert.equal(results.find((r) => r.name === 'teach-fact')?.ok, true);
  });

  test('a failure hook that throws does not take the walk down with it', async () => {
    const results = await runRobotWalk(
      [{ id: 'log-book', run: async () => { throw new Error('popup never opened'); } }],
      { onFailure: () => { throw new Error('screenshot failed'); } },
    );
    assert.equal(results[0].error, 'popup never opened');
  });

  test('each step is timed on its own', async () => {
    let clock = 1_000;
    const results = await runRobotWalk(
      [
        { id: 'staxis-list', run: async () => { clock += 250; } },
        { id: 'log-book', run: async () => { clock += 40; } },
      ],
      { now: () => clock },
    );
    assert.deepEqual(results.map((r) => r.ms), [250, 40]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. What the robot may delete
// ═══════════════════════════════════════════════════════════════════════════

describe('the only gate on a destructive click', () => {
  test('only text the robot wrote is its to delete', () => {
    assert.equal(isRobotWalkArtifact(`${ROBOT_WALK_MARKER} spare bulbs`), true);
    assert.equal(isRobotWalkArtifact(`   ${ROBOT_WALK_MARKER} nightly walkthrough`), true);
  });

  test('a real person’s work is never a robot artifact', () => {
    for (const theirs of [
      'Fix the ice machine on 3',
      'Robot vacuum needs a filter',
      `Ask Dana about ${ROBOT_WALK_MARKER}`,
      '',
      null,
      undefined,
    ]) {
      assert.equal(
        isRobotWalkArtifact(theirs),
        false,
        `"${String(theirs)}" would have been deleted from a live hotel`,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Reading the run
// ═══════════════════════════════════════════════════════════════════════════

describe('what counts as a clean night', () => {
  test('every step passed', () => {
    const s = summarizeRobotWalk(ALL_PASSED);
    assert.equal(s.ok, true);
    assert.equal(s.passed, ROBOT_WALK_STEPS.length);
  });

  test('a run with no steps at all is NOT a pass', () => {
    // The shape a runner crashing before its first click produces. Reading it
    // as green would make the loudest failure the most reassuring result.
    assert.equal(summarizeRobotWalk([]).ok, false);
  });

  test('a single skipped step is enough to spoil the night', () => {
    const steps: RobotWalkStepResult[] = [
      { name: 'sign-in', ok: true, ms: 1 },
      { name: 'add-todo', ok: false, ms: 0, skipped: true },
    ];
    assert.equal(summarizeRobotWalk(steps).ok, false);
  });
});

describe('the sentence that lands in Recent errors', () => {
  test('it names the step in words a non-technical reader knows', () => {
    const message = robotWalkFailureMessage({ name: 'add-todo', ok: false, ms: 0 });
    assert.match(message, /add a to-do/);
    assert.doesNotMatch(message, /add-todo/, 'the row should not show an internal id');
  });

  test('it carries nothing that changes between nights', () => {
    // Recent errors groups by (source, message). A timestamp or a duration in
    // here turns "broken for a week, 7x" into seven separate rows.
    const a = robotWalkFailureMessage({ name: 'log-book', ok: false, ms: 812, error: 'timeout at 10:04' });
    const b = robotWalkFailureMessage({ name: 'log-book', ok: false, ms: 15_003, error: 'timeout at 10:07' });
    assert.equal(a, b);
  });

  test('every step in the walk has a label of its own', () => {
    for (const step of ROBOT_WALK_STEPS) {
      assert.notEqual(robotWalkStepLabel(step.id), step.id, `${step.id} has no plain-English label`);
    }
  });

  test('no user-facing label uses an em dash', () => {
    for (const step of ROBOT_WALK_STEPS) {
      assert.doesNotMatch(step.label, /—/);
    }
    assert.doesNotMatch(robotWalkFailureMessage({ name: 'sign-in', ok: false, ms: 0 }), /—/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Parsing what the runner sent
// ═══════════════════════════════════════════════════════════════════════════

describe('the report the runner hands in', () => {
  test('a well-formed report parses', () => {
    const parsed = parseRobotWalkReport(reportBody(ALL_PASSED));
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.value?.steps.length, ROBOT_WALK_STEPS.length);
  });

  test('a finish before the start is refused', () => {
    // A clock bug in the runner would poison every duration derived from the
    // table, and the table is append-only.
    const parsed = parseRobotWalkReport(reportBody(ALL_PASSED, {
      startedAt: '2026-08-06T10:00:00.000Z',
      finishedAt: '2026-08-06T09:00:00.000Z',
    }));
    assert.match(parsed.error ?? '', /before startedAt/);
  });

  test('a step with no name is refused', () => {
    const parsed = parseRobotWalkReport(reportBody([{ name: '  ', ok: false, ms: 1 }]));
    assert.match(parsed.error ?? '', /name/);
  });

  test('an empty walk is STORED, not refused', () => {
    const parsed = parseRobotWalkReport(reportBody([]));
    assert.equal(parsed.error, undefined);
    assert.equal(summarizeRobotWalk(parsed.value!.steps).ok, false);
  });

  test('a workflow link that is not an https URL is dropped rather than stored', () => {
    const parsed = parseRobotWalkReport(reportBody(ALL_PASSED, { workflowRunUrl: 'javascript:alert(1)' }));
    assert.equal(parsed.value?.workflowRunUrl, null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. The report route
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /api/admin/robot-walk/report', () => {
  test('a caller with no bearer gets nowhere', async () => {
    const res = await reportWalk(post(reportBody(ALL_PASSED), 'Bearer nope'));
    assert.equal(res.status, 401);
    assert.equal(opsOn('robot_walk_runs', 'insert').length, 0, 'an unauthorized report was stored');
  });

  test('a clean night is stored, writes no error, and lands the heartbeat', async () => {
    const res = await reportWalk(post(reportBody(ALL_PASSED)));
    assert.equal(res.status, 200);

    const stored = opsOn('robot_walk_runs', 'insert')[0]?.rows?.[0];
    assert.ok(stored, 'the run was not stored');
    assert.equal(stored.ok, true);
    assert.equal((stored.steps as unknown[]).length, ROBOT_WALK_STEPS.length);

    assert.equal(opsOn('error_logs', 'insert').length, 0, 'a clean night wrote to Recent errors');

    const beat = opsOn('cron_heartbeats', 'upsert')[0]?.rows?.[0];
    assert.equal(beat?.cron_name, ROBOT_WALK_HEARTBEAT);
  });

  test('a failed step becomes a Recent-errors row naming the step', async () => {
    const steps: RobotWalkStepResult[] = [
      { name: 'sign-in', ok: true, ms: 5 },
      { name: 'add-todo', ok: false, ms: 900, error: 'the composer never cleared' },
    ];
    await reportWalk(post(reportBody(steps)));

    const written = opsOn('error_logs', 'insert').flatMap((c) => c.rows ?? []);
    assert.equal(written.length, 1);
    assert.equal(written[0].source, ROBOT_WALK_ERROR_SOURCE);
    assert.match(String(written[0].message), /add a to-do/);
    assert.match(String(written[0].stack), /the composer never cleared/);
    assert.match(String(written[0].stack), /actions\/runs\/1/, 'the run log should be one click away');
  });

  test('a broken night does NOT write the heartbeat', async () => {
    // "On time" on this job means a manager could still do all of it. A
    // heartbeat here would leave the row green through an unusable app.
    await reportWalk(post(reportBody([{ name: 'sign-in', ok: false, ms: 12, error: 'bad password' }])));
    assert.equal(opsOn('cron_heartbeats', 'upsert').length, 0);
  });

  test('steps skipped in a failure’s wake do not each get their own red row', async () => {
    const steps: RobotWalkStepResult[] = [
      { name: 'staxis-list', ok: false, ms: 20_000, error: 'the list never rendered' },
      { name: 'add-todo', ok: false, ms: 0, skipped: true, error: 'Not attempted: could not open the hotel list.' },
      { name: 'complete-todo', ok: false, ms: 0, skipped: true, error: 'Not attempted: could not open the hotel list.' },
    ];
    await reportWalk(post(reportBody(steps)));

    const written = opsOn('error_logs', 'insert').flatMap((c) => c.rows ?? []);
    assert.equal(written.length, 1, 'one broken step produced more than one entry');
    assert.match(String(written[0].message), /open the hotel list/);
  });

  test('the run is stored BEFORE anything else, and a storage failure is the only 500', async () => {
    failingTables.add('robot_walk_runs');
    const res = await reportWalk(post(reportBody(ALL_PASSED)));
    assert.equal(res.status, 500);
    assert.equal(opsOn('cron_heartbeats', 'upsert').length, 0);
    assert.equal(opsOn('error_logs', 'insert').length, 0);
  });

  test('retention sweeps only rows older than the window, and never the run that just arrived', async () => {
    await reportWalk(post(reportBody(ALL_PASSED)));

    const purge = opsOn('robot_walk_runs', 'delete')[0];
    assert.ok(purge, 'nothing was swept, so the table grows forever');
    const [column, cutoff] = purge.filters.find(([c]) => c === 'started_at') ?? [];
    assert.equal(column, 'started_at');
    const ageDays = (Date.now() - Date.parse(String(cutoff))) / 86_400_000;
    assert.ok(Math.abs(ageDays - ROBOT_WALK_RETENTION_DAYS) < 1, `cutoff was ${ageDays} days back`);
    assert.ok(Date.parse(String(cutoff)) < NOW, 'the sweep would have deleted tonight’s own run');
  });

  test('a malformed body is a 400 and stores nothing', async () => {
    const res = await reportWalk(post({ startedAt: 'yesterday', finishedAt: 'today', steps: [] }));
    assert.equal(res.status, 400);
    assert.equal(opsOn('robot_walk_runs', 'insert').length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. The doctor check
// ═══════════════════════════════════════════════════════════════════════════

async function robotCheck(rows: Record<string, unknown>[] | null, opts: { failing?: boolean } = {}) {
  rowsByTable.robot_walk_runs = rows ?? [];
  if (opts.failing) failingTables.add('robot_walk_runs');
  // useCache=false: a cached verdict from a sibling case would make every
  // assertion here about the first one.
  const report = await runAllChecks(false);
  const check = report.checks.find((c) => c.name === 'robot_walk_recent');
  assert.ok(check, 'robot_walk_recent is not registered with the doctor');
  return check;
}

describe('the doctor notices when the robot stops', () => {
  test('a recent clean walk is ok, and says how many steps passed', async () => {
    const check = await robotCheck([{
      started_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      ok: true,
      steps: ALL_PASSED,
    }]);
    assert.equal(check.status, 'ok');
    assert.match(check.detail ?? '', new RegExp(`${ROBOT_WALK_STEPS.length} steps passed`));
  });

  test('a recent walk that broke warns and names the step', async () => {
    const check = await robotCheck([{
      started_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      ok: false,
      steps: [
        { name: 'sign-in', ok: true, ms: 1 },
        { name: 'log-book', ok: false, ms: 20_000, error: 'never opened' },
        { name: 'teach-fact', ok: false, ms: 0, skipped: true },
      ],
    }]);
    assert.equal(check.status, 'warn');
    assert.match(check.detail ?? '', /open the log book/);
    assert.doesNotMatch(check.detail ?? '', /teach the companion/, 'a skipped step was blamed');
  });

  test('a robot that stopped running warns, which is the failure nothing else can see', async () => {
    const check = await robotCheck([{
      started_at: new Date(Date.now() - (ROBOT_WALK_FRESH_HOURS + 5) * 3_600_000).toISOString(),
      ok: true,
      steps: ALL_PASSED,
    }]);
    assert.equal(check.status, 'warn');
    assert.match(check.detail ?? '', /over the/);
  });

  test('it never fails, because a flaky click must not 503 the deploy gate', async () => {
    for (const rows of [
      null,
      [{ started_at: new Date(0).toISOString(), ok: false, steps: [] }],
      [{ started_at: new Date().toISOString(), ok: false, steps: 'not an array' }],
    ]) {
      const check = await robotCheck(rows as Record<string, unknown>[] | null);
      assert.notEqual(check.status, 'fail', `${JSON.stringify(rows)} failed the deploy gate`);
    }
  });

  test('a table that is not applied yet is ok, not a warning nobody can fix', async () => {
    rowsByTable.robot_walk_runs = [];
    (supabaseAdmin as unknown as { from: unknown }).from = (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain, eq: () => chain, lt: () => chain, gte: () => chain,
        order: () => chain, limit: () => chain,
        maybeSingle: () => ({ then: (r: (v: unknown) => unknown) => r({ data: null, error: null }) }),
        then: (resolve: (v: unknown) => unknown) => resolve(
          table === 'robot_walk_runs'
            ? { data: null, error: { code: '42P01', message: 'relation "robot_walk_runs" does not exist' } }
            : { data: [], error: null },
        ),
      };
      return chain;
    };
    const report = await runAllChecks(false);
    const check = report.checks.find((c) => c.name === 'robot_walk_recent');
    assert.equal(check?.status, 'ok');
    assert.match(check?.detail ?? '', /0460/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Registered, or it does not exist
// ═══════════════════════════════════════════════════════════════════════════

describe('the robot is on Mission Control', () => {
  const job = ACTIVE_MISSION_JOBS.find((j) => j.id === 'robot-walk');

  test('it is an automatic AI job with a plain-English description', () => {
    assert.ok(job, 'the nightly walk is not in the job catalog, so nothing draws it');
    assert.equal(job!.mission.tier, 'ai', 'it would render under the wrong heading');
    assert.equal(job!.heartbeat.visibility, 'mission-control');
    assert.doesNotMatch(job!.mission.description, /—/);
    assert.doesNotMatch(job!.mission.description, /\bAI\b/, 'the founder’s screens do not say AI at a job');
  });

  test('its schedule, registry entry and doctor expectation all agree', () => {
    // The three registries are derived from the catalog, so this fails only if
    // somebody hand-edits one of them apart from the others.
    const registry = SCHEDULE_REGISTRY.find((e) => e.heartbeatName === ROBOT_WALK_HEARTBEAT);
    assert.ok(registry, 'the walk is not in the schedule registry');
    assert.equal(registry!.cronExpr, job!.schedule);
    const expected = EXPECTED_CRONS.find((c) => c.name === ROBOT_WALK_HEARTBEAT);
    assert.ok(expected, 'the doctor does not expect the walk to run');
    assert.equal(expected!.cadenceHours, 24);
  });

  test('the route it reports to is the route that writes the heartbeat', () => {
    assert.deepEqual(job!.target, { kind: 'route', path: '/api/admin/robot-walk/report' });
  });

  test('the table it stores runs in is on the doctor’s migration list', () => {
    assert.ok(
      EXPECTED_MIGRATIONS_STATIC.includes('0460'),
      'a missing 0460 leaves the doctor unable to notice the table was never applied',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The step that was red every night for a reason that was not the app's
// ═══════════════════════════════════════════════════════════════════════════
//
// PRODUCTION EVIDENCE, 2026-08-07. Every run in `robot_walk_runs` that carries
// a `workflow_run_url` (which is to say every run that actually came from the
// nightly workflow rather than somebody's laptop) is ok=false, and one of the
// two reasons is always the same sentence:
//
//   "Picked Robot Manager but the composer still says "Who: for Robot"."
//
// The walk asserted that the Who button's accessible name contained the FULL
// name it had just clicked. `whoWord` renders a person as their first name
// only, deliberately, so that assertion cannot pass for anybody with a
// surname. The consequences all landed on the founder rather than on an
// engineer: the heartbeat lands only on a clean night, so the job could never
// read "on time"; the doctor's robot_walk_recent warns forever; and "Recent
// errors" carries a standing row that is not true.
//
// These walk the REAL producer. Restating "it says the first name" here would
// pass on the day somebody changes whoWord and re-breaks the walk.
describe('the composer answers the robot in the words the product actually uses', () => {
  const ROBOT: ComposerPerson = { staffId: 'staff-robot', name: 'Robot Manager' };

  /** Exactly what list-rows.tsx puts on the Who button. */
  const whoButtonLabel = (who: string, people: readonly ComposerPerson[]): string =>
    `${COMPOSER_COPY.whoLabel}: ${whoWord(who, people)}`;

  test('picking a person by full name is accepted from the label the app renders', () => {
    const label = whoButtonLabel(ROBOT.staffId, [ROBOT]);
    assert.equal(
      composerNamesAssignee(label, ROBOT.name),
      true,
      `the walk refuses the label the product actually renders ("${label}"), so the `
      + 'assign step fails every night and the heartbeat can never land',
    );
  });

  test('a person with one name still works', () => {
    const solo: ComposerPerson = { staffId: 'staff-ana', name: 'Ana' };
    assert.equal(composerNamesAssignee(whoButtonLabel(solo.staffId, [solo]), 'Ana'), true);
  });

  test('the wrong person is still a failure', () => {
    const other: ComposerPerson = { staffId: 'staff-other', name: 'Marcus Webb' };
    const label = whoButtonLabel(other.staffId, [other, ROBOT]);
    assert.equal(
      composerNamesAssignee(label, ROBOT.name),
      false,
      'a walk that accepts anybody proves nothing about the picker',
    );
  });

  test('the default "for you" is not read as the person having been picked', () => {
    assert.equal(composerNamesAssignee(whoButtonLabel('me', [ROBOT]), ROBOT.name), false);
  });

  test('a longer name that merely starts the same is not a match', () => {
    // "Rob" must not be satisfied by "for Roberta".
    const roberta: ComposerPerson = { staffId: 'staff-roberta', name: 'Roberta Diaz' };
    assert.equal(
      composerNamesAssignee(whoButtonLabel(roberta.staffId, [roberta]), 'Rob Smith'),
      false,
    );
  });

  test('a missing label is a failure rather than a pass', () => {
    assert.equal(composerNamesAssignee(null, ROBOT.name), false);
    assert.equal(composerNamesAssignee('', ROBOT.name), false);
  });
});
