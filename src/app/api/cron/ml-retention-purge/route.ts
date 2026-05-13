/**
 * GET /api/cron/ml-retention-purge
 *
 * Daily purge for high-volume ML observation tables. Honors the retention
 * comments declared in migration 0103. Cutoff is computed in JS as
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

const RETENTION: ReadonlyArray<RetentionEntry> = [
  { table: 'prediction_log',                      column: 'logged_at',    days: 365 },
  { table: 'inventory_rate_prediction_history',   column: 'predicted_at', days: 365 },
  { table: 'app_events',                          column: 'ts',           days:  90 },
  { table: 'agent_costs',                         column: 'created_at',   days:  90 },
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
