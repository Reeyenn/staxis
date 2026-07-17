/**
 * GET /api/cron/run-daily-report
 *
 * Fires every 30 minutes (Vercel native cron). For each property, checks
 * whether NOW (in property-local time) matches that property's configured
 * delivery_time_local within a ±15 min tolerance window. If it does AND
 * no report_runs row exists for the property + today, builds the daily
 * report and emails it to every active GM / owner + their CC list.
 *
 * Why every-30-min instead of "1 cron per property at the right hour":
 *   - Vercel native cron schedules are global (UTC), not per-row.
 *   - Properties live in different timezones, with different preferred
 *     delivery times. A single per-property loop with a ±15 min window
 *     handles all of them with one cron entry.
 *   - The 30-min cadence gives us two shots at every 1-hour delivery slot
 *     (4pm, 6pm, 8pm, 10pm). A missed cron tick (Vercel scheduler hiccup)
 *     is recovered by the next tick within the same window.
 *
 * Idempotency: the unique constraint on report_runs (property, type, date)
 * is the actual guard. We INSERT first, abort on conflict, then build +
 * send. So a second cron tick in the same window sees the row already
 * exists and skips that property entirely.
 *
 * Auth: CRON_SECRET bearer (matches every other Vercel cron).
 *
 * The per-property window/idempotency/send machinery is shared with the
 * weekly cron — see src/lib/reports/cron-runner.ts. `minutesAround` is
 * re-exported here for the existing unit tests.
 */

import { defineRoute, cronGate } from '@/lib/api-route';
import { ApiErrorCode } from '@/lib/api-response';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { runReportCron, minutesAround } from '@/lib/reports/cron-runner';
import { buildDailyReport, sendDailyReportEmail } from '@/lib/reports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Per-property work is bounded (1 build + N emails); a 5-property fleet
// should run well under 60s. Keep maxDuration generous in case the ML
// service is slow.
export const maxDuration = 60;

// Exported for unit tests only.
export { minutesAround };

export const GET = defineRoute({
  resolve: (req) => cronGate(req),
  handler: async (ctx) => {
    try {
      const { results, anyFailed, anySent, baseNotes } = await runReportCron(
        {
          type: 'daily',
          build: buildDailyReport,
          send: sendDailyReportEmail,
          buildNullDetail: 'buildDailyReport returned null',
          noRecipientsDetail: 'no active GMs/owners with email channel enabled',
        },
        ctx.req,
      );

      await writeCronHeartbeat('run-daily-report', {
        requestId: ctx.requestId,
        notes: {
          ...baseNotes,
          skippedNoRecipients: results.filter(r => r.status === 'skipped_no_recipients').length,
        },
        status: anyFailed ? 'degraded' : 'ok',
      });

      return ctx.ok({ results, anyFailed, anySent });
    } catch (e) {
      return ctx.err(`daily report cron failed: ${e instanceof Error ? e.message : String(e)}`, {
        status: 500, code: ApiErrorCode.InternalError,
      });
    }
  },
});
