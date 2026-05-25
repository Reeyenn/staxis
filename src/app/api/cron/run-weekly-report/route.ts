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
 * skipped on the weekly cron only (still get the daily).
 *
 * Why Sunday at the GM's preferred time:
 *   - The weekly report covers Mon–Sun. Sending it Sunday evening
 *     captures the full week.
 *   - Same time-of-day choice as daily so the GM gets it at a
 *     predictable hour.
 *
 * Auth: CRON_SECRET bearer.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { captureException } from '@/lib/sentry';
import { buildWeeklyReport, resolveRecipients, sendWeeklyReportEmail } from '@/lib/reports';
import type { RecipientOutcome } from '@/lib/reports/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const DELIVERY_WINDOW_MIN = 15;
const DEFAULT_DELIVERY_TIME = '20:00';

function localHHMM(now: Date, timezone: string): string {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return fmt.format(now).replace(/\s/g, '').padStart(5, '0').slice(0, 5);
  } catch {
    return now.toISOString().slice(11, 16);
  }
}

function localDateISO(now: Date, timezone: string): string {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return fmt.format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

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

/**
 * Signed clock distance in minutes — see run-daily-report.ts for the
 * full rationale. Wraps midnight so a 00:00 delivery time still
 * matches a tick at 23:55.
 */
function minutesAround(hhmmA: string, hhmmB: string): number {
  const [aH, aM] = hhmmA.split(':').map(Number);
  const [bH, bM] = hhmmB.split(':').map(Number);
  const dayMin = 24 * 60;
  let delta = ((bH * 60 + bM) - (aH * 60 + aM)) % dayMin;
  if (delta > dayMin / 2) delta -= dayMin;
  if (delta < -dayMin / 2) delta += dayMin;
  return delta;
}

interface PropertyToCheck {
  id: string;
  name: string;
  timezone: string;
}

async function listProperties(): Promise<PropertyToCheck[]> {
  const { data, error } = await supabaseAdmin
    .from('properties')
    .select('id, name, timezone');
  if (error || !data) {
    log.error('[cron/run-weekly-report] properties load failed', { err: error?.message });
    return [];
  }
  return data.map(p => ({ id: p.id, name: p.name, timezone: p.timezone ?? 'UTC' }));
}

async function pickPropertyDeliveryTime(propertyId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('report_preferences')
    .select('delivery_time_local')
    .eq('property_id', propertyId);
  if (error || !data || data.length === 0) return null;
  const times = data.map(r => r.delivery_time_local).filter(Boolean) as string[];
  if (times.length === 0) return null;
  return times.sort()[0];
}

interface PropertyResult {
  propertyId: string;
  status: 'sent' | 'skipped_not_sunday' | 'skipped_not_in_window' | 'skipped_already_sent' | 'skipped_no_recipients' | 'failed';
  detail: string;
  sentCount?: number;
  failedCount?: number;
}

async function processProperty(args: {
  property: PropertyToCheck;
  now: Date;
  forceForReport?: string | null;
  forcePropertyId?: string | null;
}): Promise<PropertyResult> {
  const { property, now } = args;
  const manualReportDate = args.forceForReport ?? null;
  const isManualRun = manualReportDate !== null
    && args.forcePropertyId === property.id;

  let reportDate: string;
  if (isManualRun) {
    reportDate = manualReportDate!;
  } else {
    // Only fire on Sundays in the property's local timezone.
    const dow = localDayOfWeek(now, property.timezone);
    if (dow !== 0) {
      return { propertyId: property.id, status: 'skipped_not_sunday', detail: `local day-of-week=${dow}` };
    }
    const desired = (await pickPropertyDeliveryTime(property.id)) ?? DEFAULT_DELIVERY_TIME;
    const localNow = localHHMM(now, property.timezone);
    const delta = minutesAround(localNow, desired);
    if (Math.abs(delta) > DELIVERY_WINDOW_MIN) {
      return {
        propertyId: property.id,
        status: 'skipped_not_in_window',
        detail: `local ${localNow} vs desired ${desired} (Δ${delta}m around 24h, window ±${DELIVERY_WINDOW_MIN}m)`,
      };
    }
    reportDate = localDateISO(now, property.timezone);
  }

  const { data: inserted, error: insertErr } = await supabaseAdmin
    .from('report_runs')
    .upsert(
      {
        property_id: property.id,
        report_type: 'weekly',
        report_date: reportDate,
        recipients: [],
        email_send_status: [],
        report_payload: null,
      },
      { onConflict: 'property_id,report_type,report_date', ignoreDuplicates: true },
    )
    .select('id')
    .maybeSingle();
  if (insertErr) {
    log.error('[cron/run-weekly-report] report_runs insert failed', { propertyId: property.id, err: insertErr.message });
    return { propertyId: property.id, status: 'failed', detail: `insert: ${insertErr.message}` };
  }
  if (!inserted) {
    return { propertyId: property.id, status: 'skipped_already_sent', detail: `report_runs row exists for ${reportDate}` };
  }
  const runId = inserted.id as string;

  const [payload, recipients] = await Promise.all([
    buildWeeklyReport({ propertyId: property.id, reportDate }),
    resolveRecipients({ propertyId: property.id, reportType: 'weekly', now }),
  ]);

  if (!payload) {
    await supabaseAdmin.from('report_runs').delete().eq('id', runId);
    return { propertyId: property.id, status: 'failed', detail: 'buildWeeklyReport returned null' };
  }
  if (recipients.length === 0) {
    await supabaseAdmin
      .from('report_runs')
      .update({ report_payload: payload, recipients: [], email_send_status: [], insight_text: payload.insightText })
      .eq('id', runId);
    return { propertyId: property.id, status: 'skipped_no_recipients', detail: 'no active GMs/owners with weekly enabled' };
  }

  const outcomes: RecipientOutcome[] = [];
  let sent = 0;
  let failed = 0;
  // Per-property deadline — see run-daily-report.ts for the rationale.
  // Vercel kills the function at 60s; we leave 15s slack for the
  // report_runs UPDATE at the end.
  const deadlineMs = Date.now() + 45_000;
  for (const r of recipients) {
    if (Date.now() > deadlineMs) {
      outcomes.push({
        email: r.email,
        accountId: r.accountId,
        role: r.role,
        channel: r.channel,
        status: 'skipped',
        error: 'deferred_function_deadline',
        attempts: 0,
        lastAttemptAt: new Date().toISOString(),
      });
      continue;
    }
    if (r.channel !== 'email') {
      outcomes.push({
        email: r.email,
        accountId: r.accountId,
        role: r.role,
        channel: r.channel,
        status: 'skipped',
        error: 'sms_channel_not_yet_implemented',
        attempts: 0,
        lastAttemptAt: new Date().toISOString(),
      });
      continue;
    }
    let lastErr: string | undefined;
    let resendId: string | undefined;
    let okSend = false;
    let attempts = 0;
    try {
      attempts = 1;
      const result = await sendWeeklyReportEmail({
        to: r.email,
        payload,
        lang: r.lang,
        idempotencyKey: `weekly:${runId}:${r.email}`,
      });
      if (result.ok) {
        okSend = true;
        resendId = result.id;
      } else {
        lastErr = result.error;
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    if (okSend) {
      sent += 1;
      outcomes.push({
        email: r.email,
        accountId: r.accountId,
        role: r.role,
        channel: r.channel,
        status: 'sent',
        resendId,
        attempts,
        lastAttemptAt: new Date().toISOString(),
      });
    } else {
      failed += 1;
      const isRateLimited = lastErr?.startsWith('rate_limited') ?? false;
      outcomes.push({
        email: r.email,
        accountId: r.accountId,
        role: r.role,
        channel: r.channel,
        status: isRateLimited ? 'rate_limited' : 'failed',
        error: lastErr,
        attempts,
        lastAttemptAt: new Date().toISOString(),
      });
      captureException(new Error(`weekly report send failed: ${lastErr}`), {
        subsystem: 'cron-run-weekly-report',
        failure_mode: 'resend_failed',
        propertyId: property.id,
        to: r.email,
      });
    }
  }

  await supabaseAdmin
    .from('report_runs')
    .update({
      report_payload: payload,
      recipients: recipients.map(r => ({ accountId: r.accountId, email: r.email, role: r.role, channel: r.channel })),
      email_send_status: outcomes,
      insight_text: payload.insightText,
    })
    .eq('id', runId);

  return {
    propertyId: property.id,
    status: 'sent',
    detail: `sent=${sent} failed=${failed}`,
    sentCount: sent,
    failedCount: failed,
  };
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const cronGate = requireCronSecret(req);
  if (cronGate) return cronGate;

  const url = new URL(req.url);
  const forcePropertyId = url.searchParams.get('property_id');
  const forceForReport = url.searchParams.get('date');

  try {
    const properties = await listProperties();
    const now = new Date();

    const filteredProps = forcePropertyId
      ? properties.filter(p => p.id === forcePropertyId)
      : properties;

    const results: PropertyResult[] = [];
    for (const property of filteredProps) {
      try {
        const result = await processProperty({ property, now, forceForReport, forcePropertyId });
        results.push(result);
      } catch (e) {
        log.error('[cron/run-weekly-report] property errored', { propertyId: property.id, err: e });
        captureException(e, { subsystem: 'cron-run-weekly-report', propertyId: property.id });
        results.push({
          propertyId: property.id,
          status: 'failed',
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    }

    const anyFailed = results.some(r => r.status === 'failed');
    const anySent = results.some(r => r.status === 'sent');

    await writeCronHeartbeat('run-weekly-report', {
      requestId,
      notes: {
        propertiesChecked: filteredProps.length,
        sentCount: results.filter(r => r.status === 'sent').reduce((a, r) => a + (r.sentCount ?? 0), 0),
        failedCount: results.filter(r => r.status === 'sent').reduce((a, r) => a + (r.failedCount ?? 0), 0),
        skippedNotSunday: results.filter(r => r.status === 'skipped_not_sunday').length,
        skippedNotInWindow: results.filter(r => r.status === 'skipped_not_in_window').length,
        skippedAlreadySent: results.filter(r => r.status === 'skipped_already_sent').length,
      },
      status: anyFailed ? 'degraded' : 'ok',
    });

    return ok({ results, anyFailed, anySent }, { requestId });
  } catch (e) {
    return err(`weekly report cron failed: ${e instanceof Error ? e.message : String(e)}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
