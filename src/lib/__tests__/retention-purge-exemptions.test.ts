/**
 * The decision corpus must survive the retention purge.
 *
 * This is the partial-order warning from the workstream made executable:
 * landing the corpus (migration 0350) WITHOUT this protection would be the
 * worst possible half — a moat that a re-enabled cron deletes 90 days at a
 * time. The purge workflow's schedule has been commented out since 2026-05-30,
 * so nothing is being deleted today; the danger is the moment somebody turns it
 * back on after report ingestion restores data flow.
 *
 * These tests assert BEHAVIOUR, not source text: they read the route's exported
 * sets and drive its handler with a stubbed admin client, then check which
 * tables it actually tried to delete from.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EXEMPT_FROM_PURGE } from '@/lib/retention-purge-policy';

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');

/** Every table any migration creates whose name starts with `agent_decision`. */
function migrationDecisionTables(): string[] {
  const names = new Set<string>();
  for (const file of readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql'))) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    const rx = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?(agent_decision[a-z0-9_]*)"?/gi;
    let m;
    while ((m = rx.exec(sql)) !== null) names.add(m[1].toLowerCase());
  }
  return [...names];
}

describe('retention purge — corpus exemption', () => {
  test('every agent_decision* table in the schema is exempt', () => {
    const found = migrationDecisionTables();
    assert.ok(found.length > 0, 'no agent_decision* table found in migrations — did 0350 land?');
    for (const t of found) {
      assert.ok(
        EXEMPT_FROM_PURGE.has(t),
        `${t} exists in the schema but is not in EXEMPT_FROM_PURGE — a cron can delete the corpus`,
      );
    }
  });

  test('the corpus tables are exempt', () => {
    for (const t of ['agent_decisions', 'agent_pending_actions', 'user_feedback', 'agent_eval_baselines']) {
      assert.ok(EXEMPT_FROM_PURGE.has(t), `${t} must be exempt from the retention purge`);
    }
  });

  test('the purge handler never issues a delete against an exempt table', async () => {
    // Drive the real handler with a stubbed admin client and record every
    // table it tried to delete from. This catches the case the disjointness
    // check alone would miss: someone adding an exempt table to RETENTION.
    //
    // 2026-07-27: the stub gained a select/order/limit surface because the
    // purge now deletes in bounded batches (select a page of ids, delete by
    // id) rather than issuing one unbounded `delete().lt()`. The batching
    // exists to defuse the re-enable cliff — see the route header. The
    // assertion below is unchanged in intent: whatever shape the delete takes,
    // it must never name an exempt table.
    const attempted: string[] = [];
    const supabaseAdminModule = await import('@/lib/supabase-admin');
    const original = supabaseAdminModule.supabaseAdmin.from;
    (supabaseAdminModule.supabaseAdmin as unknown as { from: unknown }).from = (table: string) => {
      // One page of rows, then empty — so the batch loop terminates.
      let served = false;
      const chain = {
        // read path (batch page + dry-run count)
        select: () => chain,
        lt: () => chain,
        order: () => chain,
        limit: () => chain,
        // write path
        delete: () => chain,
        in: async () => {
          attempted.push(table);
          return { count: 1, error: null };
        },
        // the heartbeat writer
        upsert: async () => ({ error: null }),
        then: (resolve: (v: unknown) => void) => {
          const data = served ? [] : [{ id: `${table}-row-1` }];
          served = true;
          return resolve({ data, count: data.length, error: null });
        },
      };
      return chain;
    };

    // The heartbeat writer also goes through supabaseAdmin; it lands in
    // `attempted` harmlessly and is filtered out below.
    try {
      const { GET } = await import('@/app/api/cron/ml-retention-purge/route');
      const req = new Request('https://example.test/api/cron/ml-retention-purge', {
        headers: { authorization: 'Bearer placeholder-cron-secret-min-16' },
      });
      await GET(req as never);
    } finally {
      (supabaseAdminModule.supabaseAdmin as unknown as { from: unknown }).from = original;
    }

    assert.ok(attempted.length > 0, 'the purge issued no deletes at all — the stub did not take');
    for (const table of attempted) {
      assert.equal(
        EXEMPT_FROM_PURGE.has(table),
        false,
        `the purge attempted to delete from EXEMPT table ${table}`,
      );
    }
  });
});
