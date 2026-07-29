/**
 * GET /api/cron/findings-janitor
 *
 * Retention for the pattern (findings) engine.
 *
 * ─── DORMANT ON PURPOSE (2026-07-27) ──────────────────────────────────────
 * There is no vercel.json entry. It ships unscheduled, exactly like its two
 * siblings `run-findings` and `findings-sweep`: the founder turns the findings
 * engine on with one master switch, and a janitor for an engine that has never
 * run is worse than useless — it is a job that can only ever surprise you. To
 * enable, four places (the same checklist those two carry):
 *   1. vercel.json                        → { "path": "/api/cron/findings-janitor", "schedule": "40 7 * * 1" }
 *   2. src/lib/cron-schedule-registry.ts  → { heartbeatName: 'findings-janitor', source: { kind: 'vercel', cronPath: '/api/cron/findings-janitor' }, cronExpr: '40 7 * * 1' }
 *   3. src/app/api/admin/doctor/route.ts  → EXPECTED_CRONS entry, cadenceHours: 168
 *   4. src/app/api/admin/mission/workers/route.ts → WORKER_META line
 * Weekly, Monday, after findings-sweep — a janitor should run behind the jobs
 * whose output it tidies, never ahead of them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS JOB REFUSES TO DELETE, AND WHY
 * ═══════════════════════════════════════════════════════════════════════════
 * The brief for this cron asked for "resolved/expired findings + old
 * finding_runs + orphaned finding_actions/findings_ai_spend". Three of those
 * four turned out to be unsafe, and the reasons are specific enough to be worth
 * writing down rather than quietly not doing:
 *
 * ── `findings` rows: NOT DELETED, any status ──────────────────────────────
 * Three independent reasons, any one of which is disqualifying.
 *
 *   1. IT WOULD BREAK THE LEARNING LOOP PERMANENTLY, IN THE LOUD DIRECTION.
 *      `finding_detector_state.baseline_shown` / `baseline_acted` are
 *      CUMULATIVE totals frozen at a detector's last transition. Demotion asks
 *      "how much engagement since the baseline?" via
 *      `Math.max(0, ledger.shown - state.baselineShown)`, where `ledger.shown`
 *      is summed over that detector's findings rows. Delete any of those rows
 *      and the sum drops below the frozen baseline, so the subtraction clamps
 *      to 0 — forever. The detector then looks permanently un-engaged-with and
 *      can never be demoted again. A retention job whose failure mode is "every
 *      detector becomes permanently louder" is not a cleanup, it is a bug.
 *
 *   2. IT WOULD CASCADE THE DECISION CORPUS AWAY. `finding_actions.finding_id`
 *      is ON DELETE CASCADE (0363, and again on the composite FK in 0370). So a
 *      single `delete from findings` silently destroys the receipt, the undo,
 *      and the outcome columns for every action taken on that problem — the
 *      exact "prove the AI was right" evidence INV-26 exists to protect for
 *      `agent_decisions`. `finding_actions` is not on any exemption list, and
 *      an exemption list cannot see a cascade coming through its parent.
 *
 *   3. `muted` ROWS *ARE* THE REFUSAL LEDGER. INV-FIND-7b derives "which
 *      problems did this hotel decline, and when" from `status='muted'` +
 *      `status_changed_at`. There is deliberately no counter column — the
 *      demotion.ts comment explains that a `declined_count` would have been a
 *      second, driftable copy. Delete the rows and the fact is unrecoverable.
 *      `known_problem` is likewise load-bearing: it holds the one-active-row
 *      slot, and deleting it un-silences a problem the manager explicitly
 *      silenced, so the next run re-nags them (INV-FIND-2).
 *
 *   And `resolved`/`expired` are not spare either: `carriedFirstSeenAt` reads
 *   them so a recurrence inherits its original first-seen clock, and their
 *   `shown_count`/`acted_count` feed the same cumulative ledger as (1).
 *
 * ── `finding_sweep_runs`: NOT DELETED ─────────────────────────────────────
 * `loadSignatureSupport` does a fleet-wide `.overlaps('signatures', …)` with NO
 * date filter, to count how many distinct hotels a candidate pattern showed up
 * at. Trimming old sweep rows lowers that count and silently drops candidates
 * back below the two-hotel promotion bar (INV-FIND-6) — a "cleanup" that
 * quietly makes the product learn less, with no error anywhere.
 *
 * ── `finding_detector_state`: NOT DELETED ─────────────────────────────────
 * One row per (hotel, detector). It is state, not history; it does not grow
 * with time, and it is the thing (1) above is protecting.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IT DOES DELETE — the two genuinely disposable things
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   A. `findings_ai_spend`, settled rows past a short window.
 *      This is the GATE, not the books (INV-43): a per-hotel daily ceiling
 *      holding worst-case reservations, most of which were never charged. The
 *      real money for every one of these calls is booked separately in
 *      `agent_costs` — which this job must never touch, and does not.
 *      The gate only ever sums TODAY (`created_at >= date_trunc('day', now())`,
 *      0361), and the doctor's stale-hold check only looks at `reserved`. So a
 *      `finalized` or `cancelled` row older than the window is read by nothing.
 *      `reserved` rows are deliberately left alone at any age — those are the
 *      stale holds the doctor is watching for, and deleting them would hide the
 *      very anomaly it exists to report.
 *
 *   B. `finding_runs`, keeping the most recent per property.
 *      `store.ts` reads only the newest run per property. The rest are the
 *      "we checked, all normal" liveness trail — worth keeping some of, not
 *      worth keeping 365/hotel/year of forever. Keeps KEEP_RUNS_PER_PROPERTY.
 *
 * `finding_actions` is NOT swept directly: its rows are either attached to a
 * findings row (which we never delete, so they are never orphaned) or they are
 * the findings decision corpus. Nothing to collect.
 *
 * Auth: CRON_SECRET bearer.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireCronSecret } from '@/lib/api-auth';
import { ok } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Settled gate rows older than this are unreadable by anything. The gate's own
 * window is one day; 7 gives a week of forensic headroom for "why did this
 * hotel hit its ceiling last Tuesday".
 */
export const SPEND_RETENTION_DAYS = 7;

/** How many `finding_runs` to keep per property. Only the newest is read. */
export const KEEP_RUNS_PER_PROPERTY = 30;

/** Bound every delete so one run can never hold a long lock. */
const BATCH = 500;

/**
 * Tables this janitor must NEVER delete from, with the runtime refusal to match
 * — the same belt-and-braces shape as EXEMPT_FROM_PURGE in ml-retention-purge.
 * The header explains each one. This set is asserted by the tests, so adding a
 * delete against any of these fails at PR time rather than in production.
 */
export const FINDINGS_NEVER_PURGE: ReadonlySet<string> = new Set([
  'findings',
  'finding_actions',
  'finding_detector_state',
  'finding_sweep_runs',
  'agent_costs',
]);

/**
 * The only tables this job is allowed to touch. Exported so a test can assert
 * it is disjoint from FINDINGS_NEVER_PURGE.
 */
export const FINDINGS_PURGE_TARGETS = ['findings_ai_spend', 'finding_runs'] as const;

/** Runtime twin of the disjointness test — refuses regardless of caller. */
function assertPurgeable(table: string): void {
  if (FINDINGS_NEVER_PURGE.has(table)) {
    throw new Error(
      `findings-janitor: refusing to delete from "${table}" — it is on FINDINGS_NEVER_PURGE. ` +
      `See the route header for why.`,
    );
  }
}

/** Delete by primary key in bounded pages. Returns how many rows went. */
async function deleteByIds(table: string, ids: string[]): Promise<number> {
  assertPurgeable(table);
  let deleted = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const page = ids.slice(i, i + BATCH);
    const { count, error } = await supabaseAdmin
      .from(table)
      .delete({ count: 'exact' })
      .in('id', page);
    if (error) throw new Error(`${table}: ${error.message}`);
    deleted += count ?? page.length;
  }
  return deleted;
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const cronGate = requireCronSecret(req);
  if (cronGate) return cronGate;

  const errors: Record<string, string> = {};
  let spendPurged = 0;
  let runsPurged = 0;

  // ── A. Settled gate rows past the window ────────────────────────────────
  // `reserved` is deliberately excluded at every age — see the header.
  try {
    const cutoff = new Date(Date.now() - SPEND_RETENTION_DAYS * 86_400_000).toISOString();
    const { data, error } = await supabaseAdmin
      .from('findings_ai_spend')
      .select('id')
      .in('state', ['finalized', 'cancelled'])
      .lt('created_at', cutoff)
      .limit(BATCH * 10);
    if (error) throw new Error(error.message);
    const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (ids.length > 0) spendPurged = await deleteByIds('findings_ai_spend', ids);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.error('[cron/findings-janitor] spend sweep failed', { requestId, error: message });
    errors.findings_ai_spend = message;
  }

  // ── B. finding_runs, keeping the newest N per property ──────────────────
  try {
    const { data: props, error: propErr } = await supabaseAdmin
      .from('finding_runs')
      .select('property_id');
    if (propErr) throw new Error(propErr.message);
    const propertyIds = [
      ...new Set(((props ?? []) as Array<{ property_id: string }>).map((r) => r.property_id)),
    ];

    for (const propertyId of propertyIds) {
      // Newest-first, skip the keepers, delete the tail. Reading ids rather
      // than computing a date cutoff because "keep the last N" is the actual
      // rule — a hotel that ran once a year should not lose its only history.
      const { data: olds, error: oldErr } = await supabaseAdmin
        .from('finding_runs')
        .select('id')
        .eq('property_id', propertyId)
        .order('created_at', { ascending: false })
        .range(KEEP_RUNS_PER_PROPERTY, KEEP_RUNS_PER_PROPERTY + BATCH * 10 - 1);
      if (oldErr) throw new Error(oldErr.message);
      const ids = ((olds ?? []) as Array<{ id: string }>).map((r) => r.id);
      if (ids.length > 0) runsPurged += await deleteByIds('finding_runs', ids);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.error('[cron/findings-janitor] runs sweep failed', { requestId, error: message });
    errors.finding_runs = message;
  }

  const degraded = Object.keys(errors).length > 0;

  await writeCronHeartbeat('findings-janitor', {
    requestId,
    status: degraded ? 'degraded' : 'ok',
    notes: { spendPurged, runsPurged, errors },
  });

  return ok({
    spendPurged,
    runsPurged,
    keptRunsPerProperty: KEEP_RUNS_PER_PROPERTY,
    spendRetentionDays: SPEND_RETENTION_DAYS,
    errors,
  }, { requestId });
}
