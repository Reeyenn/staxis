/**
 * GET /api/cron/run-scheduled-reports
 *
 * Fires due report schedules (report_schedules, migration 0236). Runs hourly
 * (Vercel native cron, top of each hour). For each enabled schedule it checks
 * the property-local clock against the schedule's cadence + hour + day, and —
 * if due and not already sent today — builds the report, generates the AI
 * summary, and emails it to the configured recipients via the existing Resend
 * report-email infra.
 *
 * Idempotency: report_schedules.last_run_date (property-local) gates one send
 * per delivery day; Resend idempotency keys dedupe per recipient too.
 *
 * Auth: CRON_SECRET (requireCronSecret). Heartbeat written for the doctor.
 */

import type { NextRequest } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { err, ok } from '@/lib/api-response';
import { getReportDefinition } from '@/lib/reports/catalog';
import { getPropertyMeta, localNowParts, scheduleDateRange } from '@/lib/reports/catalog/helpers';
import { generateReportSummary } from '@/lib/reports/catalog/ai-summary';
import { sendReportEmail } from '@/lib/reports/catalog/email';
import { listEnabledSchedules, markScheduleRun, type ReportSchedule } from '@/lib/reports/catalog/store';
import { getOrMintRequestId, log } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const HARD_DEADLINE_MS = 55_000;

function isDue(s: ReportSchedule, parts: { date: string; hour: number; dow: number; dom: number }): boolean {
  if (s.lastRunDate === parts.date) return false; // already sent today
  if (parts.hour !== s.hourLocal) return false;   // only in the scheduled hour
  if (s.cadence === 'weekly') return s.dayOfWeek === parts.dow;
  if (s.cadence === 'monthly') return s.dayOfMonth === parts.dom;
  return true; // daily
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const cronGate = requireCronSecret(req);
  if (cronGate) return cronGate;

  const startedAt = Date.now();
  const results: Array<{ id: string; status: string; detail?: string }> = [];

  try {
    const schedules = await listEnabledSchedules();

    // Cache property meta (timezone/name) per property across schedules.
    const metaCache = new Map<string, { timezone: string; totalRooms: number; name: string }>();
    const getMeta = async (propertyId: string) => {
      const cached = metaCache.get(propertyId);
      if (cached) return cached;
      const m = await getPropertyMeta(propertyId);
      metaCache.set(propertyId, m);
      return m;
    };

    for (const s of schedules) {
      if (Date.now() - startedAt > HARD_DEADLINE_MS) {
        results.push({ id: s.id, status: 'deferred', detail: 'deadline' });
        continue;
      }
      try {
        const meta = await getMeta(s.propertyId);
        const parts = localNowParts(meta.timezone);
        if (!isDue(s, parts)) continue;

        const def = getReportDefinition(s.reportKey);
        if (!def) {
          await markScheduleRun(s.id, parts.date, 'skipped_unknown_report');
          results.push({ id: s.id, status: 'skipped_unknown_report' });
          continue;
        }
        if (s.recipients.length === 0) {
          await markScheduleRun(s.id, parts.date, 'skipped_no_recipients');
          results.push({ id: s.id, status: 'skipped_no_recipients' });
          continue;
        }

        const { from, to } = scheduleDateRange(s.rangeKind, parts.date);
        const result = await def.run({ propertyId: s.propertyId, from, to, timezone: meta.timezone });
        const aiSummary = await generateReportSummary(def, result, 'en');

        let sent = 0;
        let failed = 0;
        for (const to_email of s.recipients) {
          const r = await sendReportEmail({
            to: to_email,
            def,
            result,
            propertyName: meta.name,
            propertyId: s.propertyId,
            from,
            to_date: to,
            aiSummary,
            lang: 'en',
            idempotencyKey: `sched:${s.id}:${parts.date}:${to_email}`,
            scheduleId: s.id,
          });
          if (r.ok) sent += 1; else failed += 1;
        }
        const status = failed === 0 ? 'sent' : sent === 0 ? 'failed' : 'partial';
        await markScheduleRun(s.id, parts.date, status);
        results.push({ id: s.id, status, detail: `sent ${sent}, failed ${failed}` });
      } catch (e) {
        log.error('scheduled report failed', { requestId, scheduleId: s.id, error: e instanceof Error ? e.message : String(e) });
        results.push({ id: s.id, status: 'error', detail: e instanceof Error ? e.message : String(e) });
      }
    }

    await writeCronHeartbeat('run-scheduled-reports');
    const fired = results.filter((r) => r.status === 'sent' || r.status === 'partial' || r.status === 'failed').length;
    return ok({ checked: schedules.length, fired, results }, { requestId });
  } catch (e) {
    log.error('run-scheduled-reports failed', { requestId, error: e instanceof Error ? e.message : String(e) });
    // Still write a heartbeat so the doctor sees the cron ran.
    try { await writeCronHeartbeat('run-scheduled-reports'); } catch { /* noop */ }
    return err('Scheduled reports run failed.', { requestId, status: 500, code: 'internal_error' });
  }
}
