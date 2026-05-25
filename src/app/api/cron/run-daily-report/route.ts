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
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { captureException } from '@/lib/sentry';
import { buildDailyReport, resolveRecipients, sendDailyReportEmail } from '@/lib/reports';
import type { RecipientOutcome } from '@/lib/reports/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Per-property work is bounded (1 build + N emails); a 5-property fleet
// should run well under 60s. Keep maxDuration generous in case the ML
// service is slow.
export const maxDuration = 60;

/** ±15 min window: a delivery_time_local of 20:00 fires for any tick
 * between 19:46 and 20:15 (boundary-safe). */
const DELIVERY_WINDOW_MIN = 15;

/**
 * Property-local HH:MM string for `now`. Uses Intl.DateTimeFormat with
 * the property's timezone — same pattern as the report aggregator.
 */
function localHHMM(now: Date, timezone: string): string {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    // en-US 24h emits "20:00" but in some Node builds it can emit "20:00"
    // with a leading space — normalize.
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

/**
 * Minimal signed distance from `hhmmA` to `hhmmB`, in minutes, around
 * a 24-hour clock. Returns a value in (-720, +720]. Used for the
 * delivery-window check so a 00:00 delivery time fires correctly for
 * a cron tick at 23:55 (5-minute distance, not 1435-minute distance).
 *
 *   minutesAround('23:55', '00:00') ===  5    // 5 min ahead of A
 *   minutesAround('00:05', '00:00') === -5    // 5 min behind A
 *   minutesAround('20:00', '20:00') ===  0
 *
 * Exported for unit tests only — the cron's runtime callers use it
 * indirectly through `processProperty`.
 */
export function minutesAround(hhmmA: string, hhmmB: string): number {
  const [aH, aM] = hhmmA.split(':').map(Number);
  const [bH, bM] = hhmmB.split(':').map(Number);
  const dayMin = 24 * 60;
  let delta = ((bH * 60 + bM) - (aH * 60 + aM)) % dayMin;
  if (delta > dayMin / 2) delta -= dayMin;
  if (delta < -dayMin / 2) delta += dayMin;
  return delta;
}

/**
 * Default delivery time when a property has no recipient with a
 * preference row yet. 8pm local matches the spec default.
 */
const DEFAULT_DELIVERY_TIME = '20:00';

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
    log.error('[cron/run-daily-report] properties load failed', { err: error?.message });
    return [];
  }
  return data.map(p => ({ id: p.id, name: p.name, timezone: p.timezone ?? 'UTC' }));
}

/**
 * Pick the "earliest" delivery time among the active GMs/owners at the
 * property. If two managers chose 8pm and 10pm, the cron fires once at
 * 8pm and the 10pm preference is ignored — they all share one daily
 * report, so we send at the first time any recipient asked for. Better
 * "too early" than "GM A got it but GM B didn't yet because they want
 * 10pm."
 *
 * Returns null when no preference rows exist; the caller falls back to
 * the default delivery time.
 */
async function pickPropertyDeliveryTime(propertyId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('report_preferences')
    .select('delivery_time_local')
    .eq('property_id', propertyId);
  if (error || !data || data.length === 0) return null;
  const times = data.map(r => r.delivery_time_local).filter(Boolean) as string[];
  if (times.length === 0) return null;
  return times.sort()[0];   // lexicographic sort on HH:MM = time-of-day ascending
}

interface PropertyResult {
  propertyId: string;
  status: 'sent' | 'skipped_not_in_window' | 'skipped_already_sent' | 'skipped_no_recipients' | 'failed';
  detail: string;
  sentCount?: number;
  failedCount?: number;
}

async function processProperty(args: {
  property: PropertyToCheck;
  now: Date;
  forceForReport?: string | null;        // YYYY-MM-DD override for manual runs
  forcePropertyId?: string | null;       // ditto, lets a manual run target one hotel
}): Promise<PropertyResult> {
  const { property, now } = args;

  // Manual-run path: when /api/cron/run-daily-report?property_id=…&date=…
  // is hit by an admin, skip the time-window check and just build the
  // report for the requested date. Idempotency still applies (a second
  // manual hit returns "already sent").
  const manualReportDate = args.forceForReport ?? null;
  const isManualRun = manualReportDate !== null
    && args.forcePropertyId === property.id;

  let reportDate: string;
  if (isManualRun) {
    reportDate = manualReportDate!;
  } else {
    const desired = (await pickPropertyDeliveryTime(property.id)) ?? DEFAULT_DELIVERY_TIME;
    const localNow = localHHMM(now, property.timezone);
    // Distance is around the 24h clock so a 00:00 delivery still matches
    // a 23:55 tick (5 min ahead, not 1435 min ahead).
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

  // Idempotency guard: try to INSERT the report_runs row first.
  // ON CONFLICT (property_id, report_type, report_date) → DO NOTHING.
  // Supabase's PostgREST upsert with ignoreDuplicates returns the row
  // when inserted, or empty when conflict. We rely on the empty-when-
  // conflict to detect "already sent" without an extra round-trip.
  const { data: inserted, error: insertErr } = await supabaseAdmin
    .from('report_runs')
    .upsert(
      {
        property_id: property.id,
        report_type: 'daily',
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
    log.error('[cron/run-daily-report] report_runs insert failed', { propertyId: property.id, err: insertErr.message });
    return { propertyId: property.id, status: 'failed', detail: `insert: ${insertErr.message}` };
  }
  if (!inserted) {
    return { propertyId: property.id, status: 'skipped_already_sent', detail: `report_runs row exists for ${reportDate}` };
  }
  const runId = inserted.id as string;

  // Build the payload + resolve recipients in parallel.
  const [payload, recipients] = await Promise.all([
    buildDailyReport({ propertyId: property.id, reportDate }),
    resolveRecipients({ propertyId: property.id, reportType: 'daily', now }),
  ]);

  if (!payload) {
    // Roll back the placeholder so a future cron tick can try again.
    await supabaseAdmin.from('report_runs').delete().eq('id', runId);
    return { propertyId: property.id, status: 'failed', detail: 'buildDailyReport returned null' };
  }
  if (recipients.length === 0) {
    // Persist the payload anyway so an admin can browse "what would have
    // been sent" later; but mark the row with an empty outcome list.
    await supabaseAdmin
      .from('report_runs')
      .update({ report_payload: payload, recipients: [], email_send_status: [] })
      .eq('id', runId);
    return { propertyId: property.id, status: 'skipped_no_recipients', detail: 'no active GMs/owners with email channel enabled' };
  }

  const outcomes: RecipientOutcome[] = [];
  let sent = 0;
  let failed = 0;
  // Per-property deadline — leave headroom before Vercel's 60s
  // function timeout so we always finish the report_runs update at
  // the end. If we approach the deadline mid-loop, remaining recipients
  // are marked 'deferred' so the next cron tick (30 min later) sees an
  // already-existing report_runs row and skips re-sending the ones we
  // already delivered. (Idempotency at the per-recipient level: the
  // Resend `Idempotency-Key` is `daily:${runId}:${email}`, identical
  // across cron ticks.)
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
      // SMS channel — deferred to a follow-up integration. Record the
      // intent in outcomes so the admin can see "sms was opted in but
      // not yet delivered" without thinking the email path failed.
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
    // Resend has its own internal retry (Anthropic SDK style) for
    // transient network errors. On rate-limit (429) we record the
    // outcome and move on — the recipient-keyed cap is 5/hour, so a
    // legitimate daily report should never hit it; if we DO hit it,
    // the next cron tick handles the deferred recipient. We do NOT
    // sleep here because a 30s sleep × 5 recipients = 150s, well past
    // maxDuration.
    let lastErr: string | undefined;
    let resendId: string | undefined;
    let okSend = false;
    let attempts = 0;
    try {
      attempts = 1;
      const result = await sendDailyReportEmail({
        to: r.email,
        payload,
        lang: r.lang,
        idempotencyKey: `daily:${runId}:${r.email}`,
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
      captureException(new Error(`daily report send failed: ${lastErr}`), {
        subsystem: 'cron-run-daily-report',
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
        log.error('[cron/run-daily-report] property errored', { propertyId: property.id, err: e });
        captureException(e, { subsystem: 'cron-run-daily-report', propertyId: property.id });
        results.push({
          propertyId: property.id,
          status: 'failed',
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    }

    const anyFailed = results.some(r => r.status === 'failed');
    const anySent = results.some(r => r.status === 'sent');

    await writeCronHeartbeat('run-daily-report', {
      requestId,
      notes: {
        propertiesChecked: filteredProps.length,
        sentCount: results.filter(r => r.status === 'sent').reduce((a, r) => a + (r.sentCount ?? 0), 0),
        failedCount: results.filter(r => r.status === 'sent').reduce((a, r) => a + (r.failedCount ?? 0), 0),
        skippedNotInWindow: results.filter(r => r.status === 'skipped_not_in_window').length,
        skippedAlreadySent: results.filter(r => r.status === 'skipped_already_sent').length,
        skippedNoRecipients: results.filter(r => r.status === 'skipped_no_recipients').length,
      },
      status: anyFailed ? 'degraded' : 'ok',
    });

    return ok({ results, anyFailed, anySent }, { requestId });
  } catch (e) {
    return err(`daily report cron failed: ${e instanceof Error ? e.message : String(e)}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
