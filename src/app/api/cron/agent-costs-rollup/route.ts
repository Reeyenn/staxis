/**
 * GET /api/cron/agent-costs-rollup
 *
 * The ONLY owner of `agent_costs` retention. Runs monthly.
 *
 * ─── What it is for ───────────────────────────────────────────────────────
 * `agent_costs` is the AI books (INV-43). It grows one row per billable
 * provider call and, before this cron, had exactly one pruner: ml-retention-
 * purge, which issued an unconditional `DELETE … WHERE created_at < cutoff`.
 * That job has been unscheduled since 2026-05-30, so nothing was actually being
 * deleted — but it meant the table only ever grew, and the moment anyone
 * re-enabled that schedule, money would leave the books with no summary behind
 * it. As of 2026-07-27 `agent_costs` is on that route's EXEMPT_FROM_PURGE list
 * and this cron owns it alone.
 *
 * ─── The order of operations is the whole safety story ────────────────────
 *   1. ROLL UP every month from the oldest raw row to the current one. The
 *      Postgres function re-folds a month from scratch each time, so the
 *      current (still-growing) month is simply re-summarised every run.
 *   2. VERIFY. The fold must reproduce the month's raw sum AND raw row count
 *      exactly — decimal equality, no tolerance. Only then is `verified_at`
 *      stamped. That stamp is the interlock.
 *   3. PRUNE, and only then. Raw rows are deleted only for months that are
 *      (a) older than RAW_RETENTION_MONTHS and (b) carry a `verified_at`.
 *      A month that failed verification keeps every raw row forever, which is
 *      the correct failure mode for a ledger: too much data, never too little.
 *
 * ─── Why no screen changed ────────────────────────────────────────────────
 * Every live spend reader is scoped to today or to 30 days. Retention is 6
 * months. So no reader ever reads across the boundary, and each keeps summing
 * raw rows exactly as before. `checkRetentionCoversReadWindows` turns that from
 * a happy accident into a guarantee — it throws if a future edit widens a
 * reader or shortens retention.
 *
 * The one reader that DID break on any prune is /admin/ai-staff's "attributed
 * since" note, which scanned all of history for the oldest attributed row and
 * would have started reporting the oldest SURVIVING row. It now reads the
 * `staxis_agent_costs_attribution_start()` function (0375), which spans the raw
 * rows and the summary.
 *
 * ─── Why daily, for a monthly rollup ──────────────────────────────────────
 * A verified month is frozen (migration 0375, Guard 1), so a daily run does
 * NOT re-scan history: it re-folds only the current, still-open month plus any
 * past month that has not verified yet. That is a handful of cheap statements.
 * Daily buys two things a monthly cadence would not: the summary is never more
 * than a day stale, and a large prune backlog drains steadily under
 * MAX_PRUNE_PER_RUN instead of taking years at one bite per month.
 *
 * Auth: CRON_SECRET bearer.
 * Schedule: daily 05:20 UTC.
 *
 * Query params:
 *   dryRun=true — roll up and verify, but delete nothing. Reports exactly what
 *                 would be pruned. The intended first run.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { fetchAllRows } from '@/lib/supabase-paginate';
import {
  RAW_RETENTION_MONTHS,
  checkRetentionCoversReadWindows,
  pruneCutoffMonth,
} from '@/lib/ai/cost-rollup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** Bound the delete so one run can never hold a long lock on the books. */
const PRUNE_BATCH = 1_000;
/** Ceiling per run. A large backlog drains over several months, visibly. */
const MAX_PRUNE_PER_RUN = 20_000;
/** Never fold more than this many months in one run (guards a bad clock). */
const MAX_MONTHS_PER_RUN = 120;

interface RollupRow {
  month: string;
  grains: number;
  rows_folded: number;
  raw_cost_usd: string;
  rolled_cost_usd: string;
  verified: boolean;
}

/** All month-starts (UTC, 'YYYY-MM-01') from `from` through `to`, inclusive. */
function monthsBetween(from: Date, to: Date): string[] {
  const out: string[] = [];
  const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  while (cur <= end && out.length < MAX_MONTHS_PER_RUN) {
    out.push(`${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, '0')}-01`);
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return out;
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const cronGate = requireCronSecret(req);
  if (cronGate) return cronGate;

  // Fail loudly and BEFORE touching anything if the retention window no longer
  // covers what the screens read. Silently under-reporting spend is the one
  // outcome this whole design exists to prevent.
  try {
    checkRetentionCoversReadWindows();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.error('[cron/agent-costs-rollup] retention window is unsafe', { requestId, error: message });
    return err(message, { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  const dryRun = new URL(req.url).searchParams.get('dryRun') === 'true';
  const now = new Date();

  // ── Which months exist at all? ─────────────────────────────────────────
  const { data: oldestRows, error: oldestErr } = await supabaseAdmin
    .from('agent_costs')
    .select('created_at')
    .order('created_at', { ascending: true })
    .limit(1);
  if (oldestErr) {
    return err(`Could not read agent_costs: ${oldestErr.message}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
  const oldest = (oldestRows ?? [])[0] as { created_at?: string } | undefined;
  if (!oldest?.created_at) {
    // Empty books — nothing to fold, nothing to prune. Still a successful run.
    await writeCronHeartbeat('agent-costs-rollup', {
      requestId, notes: { months: 0, pruned: 0, empty: true },
    });
    return ok({ months: [], pruned: 0, dryRun, empty: true }, { requestId });
  }

  // ── 1 + 2. Fold and verify every month that is not already frozen ──────
  // A month carrying verified_at is immutable (0375 Guard 1) and cannot gain
  // rows, so re-folding it would be pure waste — and for a month whose raw
  // rows are already pruned the RPC would have to short-circuit anyway. Skip
  // them here so a five-year-old ledger costs a couple of statements a night,
  // not sixty.
  // PAGED. `agent_costs_monthly` is one row per (month, property, feature,
  // model, kind, state, swept), so a single month of a real fleet is already
  // thousands of rows and PostgREST caps every response at 1000 whatever
  // .limit() says (src/lib/supabase-paginate.ts). A short read here does not
  // fail safe: months that ARE frozen drop out of `frozen`, get re-folded, and
  // 0375 Guard 1 refuses them, so the books cron goes permanently degraded for
  // a reason nothing in the response explains.
  const frozenRows = await fetchAllRows<{ month: string }>((from, to) => (
    supabaseAdmin
      .from('agent_costs_monthly')
      .select('month')
      .not('verified_at', 'is', null)
      .order('month', { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: { month: string }[] | null; error: unknown }>
  )).catch(() => [] as Array<{ month: string }>);
  const frozen = new Set(frozenRows.map((r) => String(r.month).slice(0, 10)));

  const allMonths = monthsBetween(new Date(oldest.created_at), now);
  const months = allMonths.filter((m) => !frozen.has(m));
  const results: RollupRow[] = [];
  const failedVerification: string[] = [];

  for (const month of months) {
    const { data, error } = await supabaseAdmin
      .rpc('staxis_rollup_agent_costs_month', { p_month: month });
    if (error) {
      log.error('[cron/agent-costs-rollup] fold failed', { requestId, month, error: error.message });
      failedVerification.push(month);
      continue;
    }
    const row = ((data ?? []) as RollupRow[])[0];
    if (row) {
      results.push(row);
      if (!row.verified) {
        // Not fatal to the run — but this month is now permanently un-prunable
        // until it folds cleanly, which is exactly what we want.
        log.error('[cron/agent-costs-rollup] month did NOT verify — refusing to prune it', {
          requestId, month, raw: row.raw_cost_usd, rolled: row.rolled_cost_usd,
        });
        failedVerification.push(month);
      }
    }
  }

  // ── 3. Prune — verified months only, past the retention window ─────────
  const cutoffMonth = pruneCutoffMonth(now, RAW_RETENTION_MONTHS);
  let pruned = 0;
  let pruneCapped = false;
  const prunedMonths: string[] = [];

  // Prunable months come from the TABLE, not from this run's `results` — a
  // month verified on an earlier run is frozen and therefore skipped above, so
  // reading `results` here would mean a month became prunable for exactly one
  // night and then never again.
  const verifiedRead = await fetchAllRows<{ month: string }>((from, to) => (
    supabaseAdmin
      .from('agent_costs_monthly')
      .select('month')
      .not('verified_at', 'is', null)
      .lt('month', cutoffMonth)
      .order('month', { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: { month: string }[] | null; error: unknown }>
  )).then(
    (rows) => ({ rows, message: null as string | null }),
    (e: unknown) => ({ rows: null, message: errToString(e) }),
  );
  if (verifiedRead.message !== null || verifiedRead.rows === null) {
    return err(`Could not read the rollup: ${verifiedRead.message ?? 'unknown error'}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
  const prunable = [
    ...new Set(verifiedRead.rows.map((r) => String(r.month).slice(0, 10))),
  ].sort();

  for (const month of prunable) {
    // Re-read the stamp from the table rather than trusting the in-memory
    // result: the prune must be gated on what is durably recorded, so a
    // half-applied migration or a concurrent write cannot talk us into a
    // delete. No stamp, no delete.
    const { data: stamped, error: stampErr } = await supabaseAdmin
      .from('agent_costs_monthly')
      .select('month')
      .eq('month', month)
      .not('verified_at', 'is', null)
      .limit(1);
    if (stampErr || (stamped ?? []).length === 0) {
      log.error('[cron/agent-costs-rollup] no verified_at stamp — skipping prune', { requestId, month });
      continue;
    }

    const monthStart = `${month}T00:00:00.000Z`;
    const next = new Date(monthStart);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const monthEnd = next.toISOString();

    if (dryRun) {
      const { count, error: cErr } = await supabaseAdmin
        .from('agent_costs')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', monthStart)
        .lt('created_at', monthEnd);
      if (!cErr) { pruned += count ?? 0; prunedMonths.push(month); }
      continue;
    }

    let deletedThisMonth = 0;
    for (;;) {
      if (pruned >= MAX_PRUNE_PER_RUN) { pruneCapped = true; break; }
      const pageSize = Math.min(PRUNE_BATCH, MAX_PRUNE_PER_RUN - pruned);
      const { data: page, error: selErr } = await supabaseAdmin
        .from('agent_costs')
        .select('id')
        .gte('created_at', monthStart)
        .lt('created_at', monthEnd)
        .limit(pageSize);
      if (selErr) {
        log.error('[cron/agent-costs-rollup] prune select failed', { requestId, month, error: selErr.message });
        break;
      }
      const ids = ((page ?? []) as Array<{ id: string }>).map((r) => r.id);
      if (ids.length === 0) break;

      const { count, error: delErr } = await supabaseAdmin
        .from('agent_costs')
        .delete({ count: 'exact' })
        .in('id', ids);
      if (delErr) {
        log.error('[cron/agent-costs-rollup] prune delete failed', { requestId, month, error: delErr.message });
        break;
      }
      const n = count ?? ids.length;
      deletedThisMonth += n;
      pruned += n;
      if (ids.length < pageSize) break;
    }
    if (deletedThisMonth > 0) prunedMonths.push(month);
    if (pruneCapped) break;
  }

  const degraded = failedVerification.length > 0 || pruneCapped;

  if (!dryRun) {
    await writeCronHeartbeat('agent-costs-rollup', {
      requestId,
      status: degraded ? 'degraded' : 'ok',
      notes: {
        months: results.length,
        pruned,
        prunedMonths,
        failedVerification,
        pruneCapped,
      },
    });
  }

  return ok({
    dryRun,
    retentionMonths: RAW_RETENTION_MONTHS,
    cutoffMonth,
    months: results,
    pruned,
    prunedMonths,
    failedVerification,
    pruneCapped,
  }, { requestId });
}
