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
import { EXEMPT_FROM_PURGE } from '@/lib/retention-purge-policy';
import { errToString } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

interface RetentionEntry {
  table: string;
  column: string;
  days: number;
}

// ─── Retention windows ─────────────────────────────────────────────────────
// 2026-07-24: the first three windows were RAISED from 365/90/90 to 5 years.
// (Correction to the note below: the workflow schedule has been commented out
// since 2026-05-30, so nothing was actively being deleted — this defuses the
// re-enable moment rather than stopping a live bleed.)
// They were sized in May 2026 to bound table bloat for a single hotel. That
// reasoning is obsolete: these three tables ARE the longitudinal corpus the
// product's strategy depends on — operational history, AI spend history, and
// predicted-vs-actual accuracy pairs. A 90-day window silently destroys the
// asset. Concretely, app_events' oldest row was 2026-05-09 (76 days) when this
// was caught, i.e. daily deletion of real history was ~2 weeks away.
//
// Volume math (why 5 years is safe): app_events runs ~330 rows/day at one
// property, so 5 years ≈ 600k rows — trivial for Postgres, and the whole DB
// is currently 42 MB. Revisit only if a table passes ~10M rows, and archive
// rather than delete when that happens (see agent_conversations_archived /
// agent_messages_archived, migration 0105, for the established pattern).
//
// NOT a blanket "keep everything" change: phone_pairings stays at 2 days
// because hoarding short-lived auth capability rows is a privacy negative,
// not an asset. Retention is per-table on purpose.
const CORPUS_RETENTION_DAYS = 1825; // 5 years
const RETENTION: ReadonlyArray<RetentionEntry> = [
  { table: 'prediction_log', column: 'logged_at',  days: CORPUS_RETENTION_DAYS },
  { table: 'app_events',     column: 'ts',         days: CORPUS_RETENTION_DAYS },
  { table: 'agent_costs',    column: 'created_at', days: CORPUS_RETENTION_DAYS },
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
