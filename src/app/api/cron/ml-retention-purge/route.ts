/**
 * GET /api/cron/ml-retention-purge
 *
 * Daily purge for high-volume observation/auth-lifecycle tables. Honors the
 * retention comments declared in migrations 0103 and 0309. Cutoff is computed in JS as
 * `now() - N days` then handed to Supabase as `.lt(column, cutoff)` —
 * NEVER string-interpolated into SQL. The MAX_PURGE_PER_TABLE anomaly
 * guard tags the heartbeat 'degraded' when an unusual number of rows
 * disappear in a single run, so the doctor catches a runaway query
 * before it nukes the table.
 *
 * Auth: Bearer ${CRON_SECRET}.
 *
 * Phase 3.6 (2026-05-13).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

interface RetentionEntry {
  table: string;
  column: string;
  days: number;
}

/**
 * Tables this cron may NEVER delete from, and the test that keeps it true.
 *
 * The decision corpus is the point of the whole A4-RATCHET workstream: a record
 * of what the AI proposed, what the hotel looked like at the time, what the
 * human did about it, and whether it held up. It is the one dataset that cannot
 * be rebuilt after the fact — the state snapshot is gone the moment the turn
 * ends. A future edit that adds `agent_decisions` to RETENTION would quietly
 * delete it 90 days at a time.
 *
 * `src/lib/__tests__/retention-purge-exemptions.test.ts` asserts this set and
 * RETENTION are disjoint AND that every migration-defined table matching
 * /^agent_decision/ appears here. The guarantee is a test, not a comment.
 *
 * NOTE on the schedule: `.github/workflows/ml-retention-purge.yml` has had its
 * `schedule:` block commented out since 2026-05-30, so nothing is being deleted
 * today. The risk is the RE-ENABLE moment — the first run after report
 * ingestion restores data flow deletes everything past the window in one shot.
 * This exemption list must be correct BEFORE that switch is flipped.
 */
export const EXEMPT_FROM_PURGE: ReadonlySet<string> = new Set([
  'agent_decisions',
  'agent_pending_actions',
  'user_feedback',
  'agent_eval_baselines',
]);

const RETENTION: ReadonlyArray<RetentionEntry> = [
  { table: 'prediction_log', column: 'logged_at',  days: 365 },
  { table: 'app_events',     column: 'ts',         days:  90 },
  { table: 'agent_costs',    column: 'created_at', days:  90 },
  // Every pairing capability expires within roughly two minutes. Two days
  // from creation guarantees at least a full day of operational audit after
  // the terminal/expiry event; the daily job then bounds removal to 2–3 days
  // even if this account never starts another pairing.
  { table: 'phone_pairings', column: 'created_at', days:   2 },
];

// Anomaly guard: a single table purging more than this many rows in one
// run should set the heartbeat to 'degraded' so the doctor surfaces it.
// Tune after the first prod run reveals real volume.
const MAX_PURGE_PER_TABLE = 100_000;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const unauth = requireCronSecret(req);
  if (unauth) return unauth;

  const purged: Record<string, number> = {};
  const errors: Record<string, string> = {};
  let degraded = false;

  for (const { table, column, days } of RETENTION) {
    // Runtime twin of the disjointness test: even if the two lists drift in a
    // future edit, this loop refuses to delete from an exempt table.
    if (EXEMPT_FROM_PURGE.has(table)) {
      log.error('retention-purge: refusing to purge an EXEMPT table', { requestId, table });
      errors[table] = 'table is on EXEMPT_FROM_PURGE — refusing to delete';
      degraded = true;
      continue;
    }
    const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();
    try {
      const { count, error } = await supabaseAdmin
        .from(table)
        .delete({ count: 'exact' })
        .lt(column, cutoff);
      if (error) {
        // Missing-table errors (table dropped, RLS blocking, etc) tag
        // 'degraded' but don't crash the route — other tables keep purging.
        log.warn('retention-purge: delete failed', { requestId, table, err: error });
        errors[table] = errToString(error);
        degraded = true;
        continue;
      }
      const purgedCount = count ?? 0;
      purged[table] = purgedCount;
      if (purgedCount > MAX_PURGE_PER_TABLE) {
        log.warn('retention-purge: anomalous purge volume', {
          requestId, table, count: purgedCount, ceiling: MAX_PURGE_PER_TABLE,
        });
        degraded = true;
      }
    } catch (err) {
      log.error('retention-purge: delete threw', { requestId, table, err: err as Error });
      errors[table] = errToString(err);
      degraded = true;
    }
  }

  await writeCronHeartbeat('ml-retention-purge', {
    requestId,
    status: degraded ? 'degraded' : 'ok',
    notes: { purged, errors, max_per_table: MAX_PURGE_PER_TABLE },
  });

  return NextResponse.json(
    { ok: !degraded, requestId, purged, errors: degraded ? errors : undefined },
    { status: degraded ? 207 : 200 },
  );
}
