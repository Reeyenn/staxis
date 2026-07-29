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

// Compatibility export for the route-level audit suite; the policy's single
// source of truth remains src/lib/retention-purge-policy.ts.
export { EXEMPT_FROM_PURGE };

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
  // agent_costs deliberately REMOVED 2026-07-27 — see EXEMPT_FROM_PURGE above.
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

/**
 * ─── THE RE-ENABLE CLIFF, AND THE THREE THINGS THAT DEFUSE IT ──────────────
 *
 * This cron's schedule has been commented out since 2026-05-30. The danger was
 * never the steady state — it was the FIRST RUN after the switch is flipped,
 * which would have issued one unbounded `DELETE … WHERE ts < cutoff` per table
 * and removed months of accumulated history in a single statement. On a table
 * that had drifted far past its window that is both a very long-running lock
 * and an irreversible loss, and the operator would find out afterwards.
 *
 * 1. BATCH CAP. Deletes are now issued in bounded batches of BATCH_SIZE, oldest
 *    first, up to MAX_DELETE_PER_RUN_PER_TABLE rows per table per run. A table
 *    that is years past its window drains over several days instead of in one
 *    statement, and each run stays inside the function's time budget. When a
 *    run hits the cap it reports `capped: true` and tags the heartbeat
 *    'degraded', so a table that is not converging is visible rather than
 *    silent.
 *
 * 2. DRY RUN. `?dryRun=true` counts exactly what WOULD be deleted, per table,
 *    and writes nothing. This is the intended first move on re-enable: run it
 *    by hand, read the numbers, then schedule. It is also why the counts are
 *    computed with a real `count: 'exact'` query rather than estimated.
 *
 * 3. SINGLE OWNER. `agent_costs` is gone from RETENTION (see above), so the one
 *    table here that is a financial record can no longer be deleted by this
 *    job at all.
 *
 * DO NOT re-enable the schedule as part of an unrelated change. The re-enable
 * checklist lives in .github/workflows/ml-retention-purge.yml.
 */
/** Rows per DELETE statement. Small enough to never hold a long lock. */
const BATCH_SIZE = 1_000;
/**
 * Ceiling per table per run. At a daily cadence this drains 150k rows/table
 * over a month — fast enough to converge, slow enough that a mistake is caught
 * by a human before the table is gone.
 */
const MAX_DELETE_PER_RUN_PER_TABLE = 5_000;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const unauth = requireCronSecret(req);
  if (unauth) return unauth;

  // Dry run: count what WOULD go, delete nothing. The intended first move when
  // re-enabling after a long dormancy — see the cliff note above.
  const dryRun = new URL(req.url).searchParams.get('dryRun') === 'true';

  const purged: Record<string, number> = {};
  const errors: Record<string, string> = {};
  /** Tables that hit the per-run ceiling and still have rows past the window. */
  const capped: string[] = [];
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
      if (dryRun) {
        const { count, error } = await supabaseAdmin
          .from(table)
          .select('id', { count: 'exact', head: true })
          .lt(column, cutoff);
        if (error) {
          log.warn('retention-purge: dry-run count failed', { requestId, table, err: error });
          errors[table] = errToString(error);
          degraded = true;
          continue;
        }
        purged[table] = count ?? 0;
        continue;
      }

      // ── Batched delete, oldest first ──────────────────────────────────────
      // Select a bounded page of PKs, delete exactly those, repeat. Deleting by
      // PK (rather than re-issuing the range predicate) means each statement
      // touches at most BATCH_SIZE rows and can never run away, even if new
      // rows land past the cutoff mid-run.
      let deletedHere = 0;
      let hitCap = false;
      for (;;) {
        const remaining = MAX_DELETE_PER_RUN_PER_TABLE - deletedHere;
        if (remaining <= 0) { hitCap = true; break; }
        const pageSize = Math.min(BATCH_SIZE, remaining);

        const { data: page, error: selErr } = await supabaseAdmin
          .from(table)
          .select('id')
          .lt(column, cutoff)
          .order(column, { ascending: true })
          .limit(pageSize);
        if (selErr) {
          log.warn('retention-purge: batch select failed', { requestId, table, err: selErr });
          errors[table] = errToString(selErr);
          degraded = true;
          break;
        }
        const ids = ((page ?? []) as Array<{ id: string }>).map((r) => r.id);
        if (ids.length === 0) break; // table is inside its window

        const { count, error } = await supabaseAdmin
          .from(table)
          .delete({ count: 'exact' })
          .in('id', ids);
        if (error) {
          // Missing-table errors (table dropped, RLS blocking, etc) tag
          // 'degraded' but don't crash the route — other tables keep purging.
          log.warn('retention-purge: delete failed', { requestId, table, err: error });
          errors[table] = errToString(error);
          degraded = true;
          break;
        }
        deletedHere += count ?? ids.length;
        // A short page means we drained everything past the cutoff.
        if (ids.length < pageSize) break;
      }

      purged[table] = deletedHere;
      if (hitCap) {
        // Not an error — the cap did its job. But a table that keeps hitting it
        // is not converging, and that should be visible.
        capped.push(table);
        log.warn('retention-purge: hit per-run cap, will continue next run', {
          requestId, table, deleted: deletedHere, cap: MAX_DELETE_PER_RUN_PER_TABLE,
        });
        degraded = true;
      }
      if (deletedHere > MAX_PURGE_PER_TABLE) {
        log.warn('retention-purge: anomalous purge volume', {
          requestId, table, count: deletedHere, ceiling: MAX_PURGE_PER_TABLE,
        });
        degraded = true;
      }
    } catch (err) {
      log.error('retention-purge: delete threw', { requestId, table, err: err as Error });
      errors[table] = errToString(err);
      degraded = true;
    }
  }

  // A dry run must not look like a completed purge to the monitoring layer.
  if (!dryRun) {
    await writeCronHeartbeat('ml-retention-purge', {
      requestId,
      status: degraded ? 'degraded' : 'ok',
      notes: { purged, errors, capped, max_per_table: MAX_PURGE_PER_TABLE },
    });
  }

  return NextResponse.json(
    {
      ok: !degraded,
      requestId,
      dryRun,
      purged,
      capped: capped.length > 0 ? capped : undefined,
      errors: degraded ? errors : undefined,
    },
    { status: degraded ? 207 : 200 },
  );
}
