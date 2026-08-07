/**
 * The three traps closed by the 2026-07-27 chore audit, pinned by behaviour.
 *
 *   1. Admin buttons that queued work for a switched-off robot.
 *   2. Chat reminders accepted at hotels that cannot deliver them.
 *   3. ml-retention-purge's re-enable cliff, and its second claim on the AI books.
 *
 * Plus the retirements themselves: the remaining retired chores must be gone from every
 * registry, or the doctor reports a missing heartbeat forever.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { ApiErrorCode } from '@/lib/api-response';
import { robotDecommissionedResponse, CUA_DECOMMISSIONED } from '@/lib/pms/decommission';
import { SCHEDULE_REGISTRY } from '@/lib/cron-schedule-registry';
import { EXPECTED_CRONS } from '@/app/api/admin/doctor/route';
import { getToolsForRole } from '@/lib/agent/tools';
import '@/lib/agent/tools/index';
import {
  EXEMPT_FROM_PURGE,
  GET as retentionPurge,
} from '@/app/api/cron/ml-retention-purge/route';
import {
  FINDINGS_NEVER_PURGE,
  FINDINGS_PURGE_TARGETS,
} from '@/app/api/cron/findings-janitor/route';

const CRON_SECRET = process.env.CRON_SECRET ?? 'placeholder-cron-secret-min-16';

// ═══════════════════════════════════════════════════════════════════════════
// Trap 1 — admin buttons that queued work for a robot nobody is running
// ═══════════════════════════════════════════════════════════════════════════

describe('trap 1: robot-off refusal for admin buttons', () => {
  test('refuses with 503 and an honest, admin-readable message', async () => {
    const res = robotDecommissionedResponse('req-1');
    assert.ok(res, 'the guard must refuse while the robot is decommissioned');

    // 503, not the cron route's ok:true. A person pressing a button must not be
    // shown a success — that is what taught the admin the job was queued.
    assert.equal(res.status, 503);

    const body = (await res.json()) as {
      ok: boolean; error: string; code: string; details?: { decommissioned?: boolean; revive?: string };
    };
    assert.equal(body.ok, false);
    assert.equal(body.code, ApiErrorCode.RobotDecommissioned);

    assert.match(body.error, /unavailable|retired/i);
    assert.match(body.error, /no robot action was performed/i);
    assert.equal(body.details?.decommissioned, true);
    assert.equal(body.details?.revive, undefined);
  });

  test('does not reuse ai_disabled, which owns the knowledge screens\' banner copy', () => {
    // `ai_disabled` is mapped to specific EN/ES banner sentences on the Knows
    // and rulebook screens. Reusing it here would put the wrong sentence there.
    assert.notEqual(ApiErrorCode.RobotDecommissioned, ApiErrorCode.AiDisabled);
    assert.equal(ApiErrorCode.RobotDecommissioned, 'robot_decommissioned');
  });

  /**
   * The ratchet. Same shape as admin-routes-auth-gate.test.ts: walk the route
   * tree and require the guard on anything that queues robot work.
   *
   * This is the part that keeps working after today — the audit found SEVEN
   * routes behind three buttons, and the real risk is the eighth one somebody
   * adds next month.
   */
  test('every route that enqueues workflow_jobs refuses while the robot is off', () => {
    const apiRoot = join(process.cwd(), 'src', 'app', 'api');
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (entry !== 'route.ts') continue;

        const src = readFileSync(full, 'utf8');
        // Does it queue robot work? The `(?!\.from\()` guard stops the match
        // running past this chain into an unrelated `.insert` on a different
        // table. A notes route may SELECT workflow_jobs for context and then
        // insert a mapping_notes row, which is a perfectly fine thing to do
        // while the robot is off and must not be flagged.
        const enqueues =
          /\.from\(\s*['"]workflow_jobs['"]\s*\)((?!\.from\()[\s\S]){0,300}?\.insert\(/.test(src) ||
          /staxis_enqueue_pms_write/.test(src);
        if (!enqueues) continue;

        // Does it refuse first?
        const guarded =
          /robotDecommissionedResponse\s*\(/.test(src) ||
          /\bCUA_DECOMMISSIONED\b/.test(src);
        if (!guarded) offenders.push(full.replace(process.cwd() + '/', ''));
      }
    };
    walk(apiRoot);

    assert.deepEqual(
      offenders, [],
      'These routes insert workflow_jobs with no robot-off guard. The queue\'s only ' +
      'consumer (cua-service) refuses to start while decommissioned, so each row sits ' +
      'queued forever AND permanently holds its (property_id, idempotency_key) slot. ' +
      'Add: const robotOff = robotDecommissionedResponse(requestId); if (robotOff) return robotOff; ' +
      'immediately after the auth gate — BEFORE any rate-limit increment, cooldown stamp or audit write.',
    );
  });

  test('the robot is still off — if this fails, re-read the guards above', () => {
    assert.equal(CUA_DECOMMISSIONED, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Trap 2 — reminders accepted at hotels that cannot deliver them
// ═══════════════════════════════════════════════════════════════════════════

describe('trap 2: reminders at a hotel with Communications off', () => {
  const namesFor = (sections: Record<string, boolean> | undefined) =>
    getToolsForRole('general_manager', 'chat', sections).map((t) => t.name);

  test('create_reminder is not offered when Communications is off', () => {
    const names = namesFor({ communications: false });
    assert.ok(
      !names.includes('create_reminder'),
      'the assistant must not be able to promise a reminder it cannot deliver',
    );
  });

  test('create_reminder IS offered when Communications is on', () => {
    assert.ok(namesFor({ communications: true }).includes('create_reminder'));
  });

  test('fails OPEN when the hotel\'s section map is unknown', () => {
    // Matches isSectionEnabled's contract: only an explicit `false` disables.
    // A lookup failure must not silently remove features from every hotel.
    assert.ok(namesFor(undefined).includes('create_reminder'));
    assert.ok(namesFor({}).includes('create_reminder'));
  });

  test('cancelling and listing reminders still work with Communications off', () => {
    // Creation is gated; management is not. Someone has to be able to see and
    // clear the reminders made before the section was switched off.
    const names = namesFor({ communications: false });
    assert.ok(names.includes('cancel_reminder'), 'must still be able to cancel a paused reminder');
    assert.ok(names.includes('list_scheduled_items'), 'must still be able to see what is pending');
  });

  test('turning Communications off drops exactly the Communications tools', () => {
    const off = new Set(namesFor({ communications: false }));
    const onTools = getToolsForRole('general_manager', 'chat', { communications: true });
    const removed = onTools.filter((t) => !off.has(t.name)).map((t) => t.name).sort();

    // The honest assertion: what disappears is precisely the set of tools that
    // DECLARE section 'communications' — no more (a section toggle must not
    // take unrelated features with it) and no fewer.
    const declared = onTools
      .filter((t) => t.section === 'communications')
      .map((t) => t.name)
      .sort();

    assert.deepEqual(removed, declared);
    assert.ok(declared.includes('create_reminder'), 'create_reminder must be one of them');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Trap 3 — the retention purge's re-enable cliff and its claim on the books
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A chainable Supabase stub that RECORDS what was asked of it. Enough surface
 * for the retention route: .from().select().lt() / .delete().in().
 */
function recordingDb() {
  const calls: string[] = [];
  const rows = Array.from({ length: 2_500 }, (_, i) => ({ id: `id-${i}` }));

  const builder = (table: string) => {
    const state = { op: 'select' as 'select' | 'delete', limit: 0 };
    const thenable = {
      select(_c: string, opts?: { count?: string; head?: boolean }) {
        state.op = 'select';
        if (opts?.head) calls.push(`count(${table})`);
        return thenable;
      },
      delete(_o?: unknown) { state.op = 'delete'; return thenable; },
      lt() { return thenable; },
      order() { return thenable; },
      limit(n: number) { state.limit = n; return thenable; },
      in(_col: string, ids: string[]) {
        calls.push(`delete(${table}, ${ids.length})`);
        return Promise.resolve({ count: ids.length, error: null });
      },
      then(resolve: (v: unknown) => void) {
        if (state.op === 'select') {
          calls.push(`select(${table}, ${state.limit})`);
          return resolve({ data: rows.slice(0, state.limit), count: rows.length, error: null });
        }
        return resolve({ count: 0, error: null });
      },
    };
    return thenable;
  };

  return { calls, builder };
}

async function withStubbedDb<T>(
  builder: (table: string) => unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
  (supabaseAdmin as unknown as { from: unknown }).from = builder;
  try { return await fn(); }
  finally { (supabaseAdmin as unknown as { from: unknown }).from = originalFrom; }
}

const cronReq = (url: string) =>
  new NextRequest(url, { headers: { authorization: `Bearer ${CRON_SECRET}` } });

describe('trap 3: ml-retention-purge', () => {
  test('agent_costs is exempt — the books have exactly one owner', () => {
    assert.ok(
      EXEMPT_FROM_PURGE.has('agent_costs'),
      'agent_costs must be exempt: /api/cron/agent-costs-rollup owns its retention, and ' +
      'only prunes a month after verifying the rollup reproduces the raw sum exactly. ' +
      'An unconditional delete here would drop rows the rollup had not folded in.',
    );
  });

  test('never deletes from an exempt table, even if the lists drift', async () => {
    const { calls, builder } = recordingDb();
    const res = await withStubbedDb(builder, () =>
      retentionPurge(cronReq('https://example.test/api/cron/ml-retention-purge')),
    );
    const body = (await res.json()) as { purged: Record<string, number>; errors?: Record<string, string> };

    for (const table of EXEMPT_FROM_PURGE) {
      assert.ok(
        !calls.some((c) => c.startsWith(`delete(${table}`)),
        `retention purge attempted to delete from exempt table ${table}`,
      );
      assert.ok(!(table in body.purged), `${table} must not appear in the purged report`);
    }
  });

  test('a dry run counts and writes nothing', async () => {
    const { calls, builder } = recordingDb();
    const res = await withStubbedDb(builder, () =>
      retentionPurge(cronReq('https://example.test/api/cron/ml-retention-purge?dryRun=true')),
    );
    const body = (await res.json()) as { dryRun: boolean; purged: Record<string, number> };

    assert.equal(body.dryRun, true);
    assert.deepEqual(
      calls.filter((c) => c.startsWith('delete(')), [],
      'a dry run must not delete anything — it is the intended first move on re-enable',
    );
    // It still reports real numbers, which is the point of running it.
    assert.ok(Object.values(body.purged).some((n) => n > 0));
  });

  test('deletes in bounded batches instead of one unbounded statement', async () => {
    const { calls, builder } = recordingDb();
    await withStubbedDb(builder, () =>
      retentionPurge(cronReq('https://example.test/api/cron/ml-retention-purge')),
    );

    const deletes = calls.filter((c) => c.startsWith('delete('));
    assert.ok(deletes.length > 0, 'expected the purge to delete something');
    for (const call of deletes) {
      const n = Number(/,\s*(\d+)\)$/.exec(call)?.[1]);
      assert.ok(
        n <= 1_000,
        `a single delete touched ${n} rows — batches must stay bounded so the first run ` +
        `after a long dormancy cannot lock the table or nuke months in one statement`,
      );
    }
  });

  test('stops at the per-run ceiling rather than draining everything at once', async () => {
    const { calls, builder } = recordingDb();
    await withStubbedDb(builder, () =>
      retentionPurge(cronReq('https://example.test/api/cron/ml-retention-purge')),
    );
    // The stub always offers 2,500 rows per table; the cap is 5,000 per table.
    // Whatever happens, no single table may exceed the ceiling in one run.
    const perTable = new Map<string, number>();
    for (const c of calls) {
      const m = /^delete\((\w+), (\d+)\)$/.exec(c);
      if (!m) continue;
      perTable.set(m[1], (perTable.get(m[1]) ?? 0) + Number(m[2]));
    }
    for (const [table, n] of perTable) {
      assert.ok(n <= 5_000, `${table}: ${n} rows in one run exceeds MAX_DELETE_PER_RUN_PER_TABLE`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The findings janitor's refusals
// ═══════════════════════════════════════════════════════════════════════════

describe('findings janitor', () => {
  test('never touches the tables that feed learning or hold the decision corpus', () => {
    for (const table of ['findings', 'finding_actions', 'finding_detector_state', 'finding_sweep_runs']) {
      assert.ok(FINDINGS_NEVER_PURGE.has(table), `${table} must be protected`);
    }
    // Deleting findings rows would drop the cumulative shown/acted ledger below
    // finding_detector_state's frozen baseline, clamping engagement to zero
    // forever — every detector becomes permanently louder. And finding_id is
    // ON DELETE CASCADE onto finding_actions, so it would take the receipts too.
  });

  test('never touches the AI books either', () => {
    assert.ok(FINDINGS_NEVER_PURGE.has('agent_costs'), 'findings spend is booked in agent_costs');
  });

  test('what it may delete is disjoint from what it must not', () => {
    for (const t of FINDINGS_PURGE_TARGETS) {
      assert.ok(!FINDINGS_NEVER_PURGE.has(t), `${t} is on both lists`);
    }
  });

  test('runs BEHIND the sweep it tidies, never ahead of it', () => {
    // It shipped dormant until 2026-08-06 and this case asserted that. The
    // founder flipped the AI master switch, so what is worth pinning now is the
    // thing that was always the real requirement: a janitor that ran before the
    // job whose output it cleans would delete a run nobody had read yet.
    //
    // Registered in all three places, or the doctor waits forever on a
    // heartbeat nothing writes.
    assert.ok(SCHEDULE_REGISTRY.some((e) => e.heartbeatName === 'findings-janitor'));
    assert.ok(EXPECTED_CRONS.some((c) => c.name === 'findings-janitor'));
    const vercel = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as {
      crons?: Array<{ path: string; schedule: string }>;
    };
    const janitor = (vercel.crons ?? []).find((c) => c.path.includes('findings-janitor'));
    const sweep = (vercel.crons ?? []).find((c) => c.path.includes('findings-sweep'));
    assert.ok(janitor, 'the janitor is not scheduled');
    assert.ok(sweep, 'the sweep it follows is not scheduled');

    // Same weekday, and the janitor strictly later in the day.
    const parse = (cron: string) => {
      const [minute, hour, , , dow] = cron.trim().split(/\s+/);
      return { minutes: Number(hour) * 60 + Number(minute), dow };
    };
    const j = parse(janitor.schedule);
    const s = parse(sweep.schedule);
    assert.equal(j.dow, s.dow, 'the janitor moved to a different day from the sweep');
    assert.ok(j.minutes > s.minutes, 'the janitor would run before the sweep it tidies');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The retirements
// ═══════════════════════════════════════════════════════════════════════════

describe('retired chores are gone from every registry', () => {
  const RETIRED = ['webhook-dedup-purge', 'claude-sessions-purge'];

  test('not scheduled, not expected, not listed', () => {
    const vercel = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as {
      crons?: Array<{ path: string }>;
    };
    const workers = readFileSync(
      join(process.cwd(), 'src/app/api/admin/mission/workers/route.ts'), 'utf8',
    );

    for (const name of RETIRED) {
      assert.ok(!SCHEDULE_REGISTRY.some((e) => e.heartbeatName === name), `${name} still in SCHEDULE_REGISTRY`);
      assert.ok(!EXPECTED_CRONS.some((c) => c.name === name), `${name} still in EXPECTED_CRONS — the doctor would report a missing heartbeat forever`);
      assert.ok(!(vercel.crons ?? []).some((c) => c.path.endsWith(name)), `${name} still scheduled in vercel.json`);
      assert.ok(!new RegExp(`'${name}':\\s*\\{`).test(workers), `${name} still has a WORKER_META row`);
    }
  });

  test('the remaining retired routes explain their dormant state', () => {
    for (const name of RETIRED) {
      const src = readFileSync(join(process.cwd(), 'src/app/api/cron', name, 'route.ts'), 'utf8');
      assert.match(src, /DORMANT/, `${name}'s route should explain why it is dormant`);
      assert.match(src, /export async function GET/, `${name}'s handler should still exist`);
    }
  });
});
