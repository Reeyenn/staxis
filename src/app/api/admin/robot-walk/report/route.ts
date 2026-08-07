/**
 * POST /api/admin/robot-walk/report
 *
 * Where the nightly robot hands in its homework.
 *
 * A real browser on a GitHub runner (`.github/workflows/robot-walk.yml`) signs
 * into the live site as a manager at the seeded robot hotel, walks it step by
 * step, and POSTs what happened here. This route is the only writer of
 * `robot_walk_runs`, and it is what turns a step result into the two things a
 * person ever sees:
 *
 *   1. A FAILED step becomes an `error_logs` row, which is what Mission
 *      Control's "Recent errors" box reads. The step is named in the message,
 *      because the founder's rule is that a failure has to say what broke, and
 *      "the robot failed" is not something anybody can act on.
 *
 *   2. A run where EVERY step passed writes the heartbeat, which is what makes
 *      the robot one calm "on time" row in the Automatic AI jobs list and
 *      nothing more. Deliberately not written on a partial run: on this one job
 *      "on time" is meant to read as "a manager could still do all of it last
 *      night", so two broken nights in a row also turn the row amber, under the
 *      Recent-errors entry that named the step on the first night.
 *
 * AUTH is CRON_SECRET, the same bearer the other GitHub-scheduled jobs use, and
 * it is already a repository secret. The route mutates nothing a hotel owns.
 *
 * RETENTION lives here too — 90 days, swept after each insert. One row a night
 * does not earn a cron, and a janitor cron is one more thing that can silently
 * stop.
 *
 * ORDER MATTERS, and it is: store the run, then report the failures, then the
 * heartbeat, then sweep. The record of what happened must survive a failure of
 * anything downstream of it.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { defineRoute, cronGate } from '@/lib/api-route';
import { ApiErrorCode } from '@/lib/api-response';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { writeErrorLog } from '@/lib/error-log';
import { log } from '@/lib/log';
import {
  parseRobotWalkReport,
  robotWalkFailureDetail,
  robotWalkFailureMessage,
  summarizeRobotWalk,
  ROBOT_WALK_ERROR_SOURCE,
  ROBOT_WALK_RETENTION_DAYS,
} from '@/lib/automation/robot-walk';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export const POST = defineRoute({
  body: 'empty',
  resolve: (req) => cronGate(req),
  handler: async (ctx) => {
    const parsed = parseRobotWalkReport(ctx.body);
    if (parsed.error || !parsed.value) {
      return ctx.err(parsed.error ?? 'invalid report', {
        status: 400,
        code: ApiErrorCode.ValidationFailed,
      });
    }
    const report = parsed.value;
    const summary = summarizeRobotWalk(report.steps);

    // ── 1. The record ────────────────────────────────────────────────────
    // First, and the only step whose failure is a 500. Everything below is a
    // consequence of this row; losing it means the night never happened.
    const { error: insertError } = await supabaseAdmin.from('robot_walk_runs').insert({
      started_at: report.startedAt,
      finished_at: report.finishedAt,
      ok: summary.ok,
      steps: report.steps,
      workflow_run_url: report.workflowRunUrl,
    });
    if (insertError) {
      log.error('[robot-walk] could not store the run', {
        requestId: ctx.requestId,
        err: insertError,
      });
      return ctx.err(`could not store the run: ${insertError.message}`, {
        status: 500,
        code: ApiErrorCode.InternalError,
      });
    }

    // ── 2. The failures, to the box the founder actually looks at ────────
    // One row per step that ACTUALLY broke. Steps skipped in its wake are in
    // the stored run and deliberately not here: one broken step should produce
    // one entry naming it, not a cascade naming its innocent neighbours.
    for (const step of summary.failed) {
      await writeErrorLog({
        source: ROBOT_WALK_ERROR_SOURCE,
        message: robotWalkFailureMessage(step),
        stack: report.workflowRunUrl
          ? `${robotWalkFailureDetail(step)}\n\n${report.workflowRunUrl}`
          : robotWalkFailureDetail(step),
      });
    }

    // ── 3. The heartbeat, only on a clean night ──────────────────────────
    if (summary.ok) {
      // The name is spelled out rather than passed as ROBOT_WALK_HEARTBEAT on
      // purpose: the standing job-catalog test reads every route's
      // writeCronHeartbeat call as SOURCE to prove the catalog's heartbeat name
      // matches the one the route actually writes, and it cannot follow an
      // imported constant. A drift between this literal and the catalog fails
      // that test; a drift between the catalog and the constant fails the one
      // in robot-walk.test.ts.
      await writeCronHeartbeat('robot-walk', {
        requestId: ctx.requestId,
        notes: { stepsPassed: summary.passed, stepsTotal: summary.total },
      });
    }

    // ── 4. Retention ─────────────────────────────────────────────────────
    // Best-effort on purpose. A sweep that cannot run is a table that grows by
    // 365 rows a year; a sweep that fails the request would throw away the
    // report that just arrived, which is the thing worth keeping.
    const cutoff = new Date(
      Date.now() - ROBOT_WALK_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const { error: purgeError } = await supabaseAdmin
      .from('robot_walk_runs')
      .delete()
      .lt('started_at', cutoff);
    if (purgeError) {
      log.warn('[robot-walk] retention sweep failed', {
        requestId: ctx.requestId,
        err: purgeError,
      });
    }

    return ctx.ok({
      ok: summary.ok,
      stepsPassed: summary.passed,
      stepsTotal: summary.total,
      reportedFailures: summary.failed.length,
      skippedSteps: summary.skipped.length,
      heartbeatWritten: summary.ok,
      purged: !purgeError,
    });
  },
});
