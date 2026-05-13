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
import { readFileSync } from 'node:fs';
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
