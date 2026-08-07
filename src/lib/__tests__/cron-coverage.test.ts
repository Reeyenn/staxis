/**
 * Drift-prevention test for Vercel-native cron coverage.
 *
 * Why this exists:
 *   Codex adversarial review on 2026-05-13 found that
 *   /api/agent/nudges/check was scheduled in vercel.json but had:
 *   - no writeCronHeartbeat call
 *   - no EXPECTED_CRONS entry
 *   - no SCHEDULE_REGISTRY entry
 *
 *   A follow-up audit found 3 more crons in the same registry-drift
 *   state (writeCronHeartbeat with no registry coverage). The drift
 *   class is "operator adds a Vercel cron entry and forgets to wire
 *   it into both the doctor (EXPECTED_CRONS) and the freshness test
 *   (SCHEDULE_REGISTRY)" — Vercel reports success even when the route
 *   silently failed for every property, and the doctor has no
 *   visibility because the heartbeat name isn't on its expected list.
 *
 *   This test fails at PR time whenever a new vercel.json cron entry
 *   is missing any of:
 *     1. A writeCronHeartbeat('<name>') call in the route file
 *     2. An EXPECTED_CRONS entry with the same '<name>'
 *     3. A SCHEDULE_REGISTRY entry with kind:'vercel' + matching cronPath
 *
 * Companion to cron-cadences.test.ts (which guards cadence drift
 * between sources). Together they cover the four ways a cron can rot
 * out of monitoring.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { EXPECTED_CRONS } from '@/app/api/admin/doctor/route';
import { SCHEDULE_REGISTRY } from '@/lib/cron-schedule-registry';

interface VercelCronEntry {
  path: string;
  schedule: string;
}

const REPO_ROOT = process.cwd();
const VERCEL_JSON = JSON.parse(
  readFileSync(join(REPO_ROOT, 'vercel.json'), 'utf8'),
) as { crons?: VercelCronEntry[] };

test('every vercel.json cron has a route.ts, calls writeCronHeartbeat, and is in both registries', () => {
  const crons = VERCEL_JSON.crons ?? [];
  assert.ok(crons.length > 0, 'vercel.json has no crons[] — expected at least one');

  for (const c of crons) {
    const routePath = join(REPO_ROOT, 'src/app', c.path, 'route.ts');

    // 1) Route file must exist.
    let content: string;
    try {
      content = readFileSync(routePath, 'utf8');
    } catch {
      assert.fail(
        `vercel.json cron path "${c.path}" → expected route at ${routePath}, ` +
        `but the file is missing. Either remove the cron entry or create the route.`,
      );
    }

    // 2) Route must call writeCronHeartbeat with a string-literal name.
    // The regex spans optional whitespace (including newlines) between
    // the opening paren and the literal so multi-line calls match too.
    const match = content.match(/writeCronHeartbeat\(\s*['"]([^'"]+)['"]/);
    assert.ok(
      match,
      `vercel.json cron "${c.path}" → route at ${routePath} does not call ` +
      `writeCronHeartbeat('<name>') with a string-literal name. ` +
      `Without it, the doctor's cron_heartbeats_fresh check cannot monitor this cron.`,
    );
    const heartbeatName = match![1];

    // 3) Heartbeat name must be in EXPECTED_CRONS (doctor monitors it).
    const expected = EXPECTED_CRONS.find((e) => e.name === heartbeatName);
    assert.ok(
      expected,
      `vercel.json cron "${c.path}" uses heartbeat name "${heartbeatName}" but ` +
      `it's missing from EXPECTED_CRONS in src/app/api/admin/doctor/route.ts. ` +
      `Add { name: '${heartbeatName}', cadenceHours: <N>, description: '...' }.`,
    );

    // 4) Same name must be in SCHEDULE_REGISTRY with matching cronPath
    //    (cadence drift test guards the cronExpr).
    const registryEntry = SCHEDULE_REGISTRY.find(
      (e) => e.heartbeatName === heartbeatName,
    );
    assert.ok(
      registryEntry,
      `vercel.json cron "${c.path}" uses heartbeat name "${heartbeatName}" but ` +
      `SCHEDULE_REGISTRY in src/lib/cron-schedule-registry.ts has no matching entry. ` +
      `Add { heartbeatName: '${heartbeatName}', source: { kind: 'vercel', ` +
      `cronPath: '${c.path}' }, cronExpr: '${c.schedule}' }.`,
    );
    assert.equal(
      registryEntry.source.kind,
      'vercel',
      `SCHEDULE_REGISTRY entry for "${heartbeatName}" has source.kind="${registryEntry.source.kind}" ` +
      `but vercel.json schedules it. Change source to { kind: 'vercel', cronPath: '${c.path}' }.`,
    );
    if (registryEntry.source.kind === 'vercel') {
      assert.equal(
        registryEntry.source.cronPath,
        c.path,
        `SCHEDULE_REGISTRY entry for "${heartbeatName}" has cronPath="${registryEntry.source.cronPath}" ` +
        `but vercel.json schedules path "${c.path}". They must match exactly.`,
      );
    }
  }
});

/**
 * The same drift, on the GitHub side: a job that still calls a page that is
 * gone.
 *
 * The vercel.json test above refuses a schedule pointing at a missing route.
 * Nothing did the equivalent for the workflows, and two jobs had rotted into
 * exactly that state: `ml-cron.yml`'s `auto-rollback` and the whole of
 * `ml-shadow-evaluate-cron.yml` both curl routes that were deleted with the
 * housekeeping ML surface. Their `schedule:` lines are commented out, which is
 * how they looked parked, but each `if:` also accepted `workflow_dispatch` --
 * so the DOCUMENTED way to run the parked ML jobs by hand ("Manual runs of ANY
 * job still work via the Actions tab") always ended red on a 404 from a page
 * that no longer exists.
 *
 * That is worse than an unused job. An operator who learns that a red Actions
 * run is normal for this workflow is an operator who will not notice the day a
 * real one goes red.
 *
 * The rule: if any trigger can start the job, the route it calls must exist.
 * A job nothing can start is fine and is left alone, because keeping the code
 * and the history is deliberate here.
 */
test('no reachable workflow job calls an /api/cron route that no longer exists', () => {
  const workflowsDir = join(REPO_ROOT, '.github', 'workflows');
  const problems: string[] = [];

  for (const file of readdirSync(workflowsDir).filter((f) => f.endsWith('.yml'))) {
    const content = readFileSync(join(workflowsDir, file), 'utf8');
    for (const job of workflowJobs(content)) {
      // `if: false` (or a guard naming only a commented-out schedule) means
      // nothing can start it. Those are parked, which is allowed.
      if (!jobIsReachable(job.body, content)) continue;

      // The same shape job-catalog.test.ts uses, so a shell glob such as
      // `src/app/api/cron/ml-*` is not mistaken for a URL.
      const routes = job.body.match(/\/api\/cron\/[a-z0-9]+(?:-[a-z0-9]+)*(?![a-z0-9-])/g) ?? [];
      for (const route of new Set(routes)) {
        const routeFile = join(REPO_ROOT, 'src', 'app', route, 'route.ts');
        if (!existsSync(routeFile)) {
          problems.push(`${file} job "${job.name}" calls ${route}, which has no route.ts`);
        }
      }
    }
  }

  assert.deepEqual(
    problems,
    [],
    `A workflow job somebody can start calls a page that was deleted, so the run `
    + `can only ever fail:\n  ${problems.join('\n  ')}`,
  );
});

/** Split a workflow's `jobs:` block into one entry per top-level job key. */
function workflowJobs(content: string): Array<{ name: string; body: string }> {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start === -1) return [];
  const jobs: Array<{ name: string; body: string }> = [];
  let current: { name: string; body: string[] } | null = null;
  for (const line of lines.slice(start + 1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      if (current) jobs.push({ name: current.name, body: current.body.join('\n') });
      current = { name: header[1], body: [] };
      continue;
    }
    // A non-indented line ends the jobs block.
    if (line.trim() !== '' && !/^\s/.test(line)) break;
    current?.body.push(line);
  }
  if (current) jobs.push({ name: current.name, body: current.body.join('\n') });
  return jobs;
}

/**
 * Can anything actually start this job?
 *
 * Deliberately conservative: anything this cannot prove is unreachable counts
 * as reachable, so the check errs toward asking for a route that exists.
 */
function jobIsReachable(body: string, workflow: string): boolean {
  const guard = /^\s{4}if:\s*(.+)$/m.exec(body)?.[1]?.trim();
  if (!guard) return true;
  if (guard === 'false') return false;
  if (/workflow_dispatch|push|pull_request|workflow_call|repository_dispatch/.test(guard)) return true;
  // A guard that only names cron expressions is reachable exactly when one of
  // those expressions is an UNCOMMENTED schedule in this workflow.
  const named = [...guard.matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2]);
  if (named.length === 0) return true;
  const live = new Set(
    [...workflow.matchAll(/^\s*-\s+cron:\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]),
  );
  return named.some((expr) => live.has(expr));
}
