/**
 * GET /api/cron/run-weekly-report
 *
 * Fires every 30 minutes on Sundays only. Per-property check that
 * "now" (property-local) is within ±15 min of the property's chosen
 * delivery time. Same idempotency + recipient/email mechanics as
 * the daily cron.
 *
 * The weekly cron *also* respects each user's weekly_enabled flag in
 * report_preferences — users who toggled the Sunday digest off are
 * skipped on the weekly cron only (still get the daily). That gating
 * lives in resolveRecipients(reportType: 'weekly').
 *
 * Why Sunday at the GM's preferred time:
 *   - The weekly report covers Mon–Sun. Sending it Sunday evening
 *     captures the full week.
 *   - Same time-of-day choice as daily so the GM gets it at a
 *     predictable hour.
 *
 * Auth: CRON_SECRET bearer.
 *
 * The per-property window/idempotency/send machinery is shared with the
 * daily cron — see src/lib/reports/cron-runner.ts. The weekly-only bits
 * are the Sunday pre-gate and the `insight_text` column write.
 */

import { defineRoute, cronGate } from '@/lib/api-route';
import { ApiErrorCode } from '@/lib/api-response';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import {
  runReportCron,
  type PropertyToCheck,
  type PropertyResult,
} from '@/lib/reports/cron-runner';
import { buildWeeklyReport, sendWeeklyReportEmail } from '@/lib/reports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function localDayOfWeek(now: Date, timezone: string): number {
  // 0 = Sunday, 6 = Saturday. Uses Intl.DateTimeFormat with weekday:short
  // and a tiny lookup since Intl doesn't expose a numeric day of week.
  try {
    const wd = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
    }).format(now);
    const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return map[wd] ?? now.getUTCDay();
  } catch {
    return now.getUTCDay();
  }
}

/** Only fire on Sundays in the property's local timezone. */
function sundayGate(property: PropertyToCheck, now: Date): PropertyResult | null {
  const dow = localDayOfWeek(now, property.timezone);
  if (dow !== 0) {
    return { propertyId: property.id, status: 'skipped_not_sunday', detail: `local day-of-week=${dow}` };
  }
  return null;
}

export const GET = defineRoute({
  resolve: (req) => cronGate(req),
  handler: async (ctx) => {
    try {
      const { results, anyFailed, anySent, baseNotes } = await runReportCron(
        {
          type: 'weekly',
          // Deadline covers report construction + the AI insight; mirrors the
          // 45s recipient-loop headroom inside runReportCron (60s Vercel cap).
          build: (args) => buildWeeklyReport({ ...args, deadlineAt: Date.now() + 45_000 }),
          send: sendWeeklyReportEmail,
          buildNullDetail: 'buildWeeklyReport returned null',
          noRecipientsDetail: 'no active GMs/owners with weekly enabled',
          preGate: sundayGate,
          extraUpdate: (payload) => ({ insight_text: payload.insightText }),
        },
        ctx.req,
      );

      await writeCronHeartbeat('run-weekly-report', {
        requestId: ctx.requestId,
        notes: {
          ...baseNotes,
          skippedNotSunday: results.filter(r => r.status === 'skipped_not_sunday').length,
        },
        status: anyFailed ? 'degraded' : 'ok',
      });

      return ctx.ok({ results, anyFailed, anySent });
    } catch (e) {
      return ctx.err(`weekly report cron failed: ${e instanceof Error ? e.message : String(e)}`, {
        status: 500, code: ApiErrorCode.InternalError,
      });
    }
  },
});
