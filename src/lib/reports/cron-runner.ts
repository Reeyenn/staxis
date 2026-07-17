/**
 * Shared runtime for the two report-delivery crons (run-daily-report and
 * run-weekly-report).
 *
 * Both crons fire every 30 minutes and, per property, check whether NOW (in
 * property-local time) is within a ±15 min window of that property's chosen
 * delivery time; if so, and no report_runs row exists for that property+date
 * yet, they build the report and email it to every active GM/owner + CC.
 *
 * The two routes were byte-for-byte identical apart from five things, all of
 * which are the parameters of {@link makeReportCronRoute}:
 *
 *   - `type`           — 'daily' | 'weekly'. Drives report_type, the
 *                        idempotency-key prefix, log/sentry/heartbeat names.
 *   - `build`          — buildDailyReport | buildWeeklyReport.
 *   - `send`           — sendDailyReportEmail | sendWeeklyReportEmail.
 *   - `preGate`        — weekly's "only fire on Sundays" gate (daily has none).
 *   - `extraUpdate`    — weekly writes `insight_text` onto report_runs; daily
 *                        writes nothing extra.
 *
 * See run-daily-report/route.ts for the fuller design commentary (idempotency,
 * the ±15 min window, the per-property deadline, per-recipient idempotency
 * keys) — that behaviour is unchanged and lives here now.
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import { captureException } from '@/lib/sentry';
import { resolveRecipients } from '@/lib/reports';
import type { RecipientOutcome } from '@/lib/reports/types';
import type { ResolvedRecipient } from '@/lib/reports/recipients';
import type { SendEmailResult } from '@/lib/email/resend';

/** ±15 min window: a delivery_time_local of 20:00 fires for any tick
 * between 19:46 and 20:15 (boundary-safe). */
export const DELIVERY_WINDOW_MIN = 15;

/**
 * Default delivery time when a property has no recipient with a
 * preference row yet. 8pm local matches the spec default.
 */
export const DEFAULT_DELIVERY_TIME = '20:00';

/**
 * Property-local HH:MM string for `now`. Uses Intl.DateTimeFormat with
 * the property's timezone — same pattern as the report aggregator.
 */
export function localHHMM(now: Date, timezone: string): string {
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

export function localDateISO(now: Date, timezone: string): string {
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

export interface PropertyToCheck {
  id: string;
  name: string;
  timezone: string;
}

export async function listProperties(logPrefix: string): Promise<PropertyToCheck[]> {
  const { data, error } = await supabaseAdmin
    .from('properties')
    .select('id, name, timezone');
  if (error || !data) {
    log.error(`${logPrefix} properties load failed`, { err: error?.message });
    return [];
  }
  return data.map(p => ({ id: p.id, name: p.name, timezone: p.timezone ?? 'UTC' }));
}

/**
 * Pick the "earliest" delivery time among the active GMs/owners at the
 * property. If two managers chose 8pm and 10pm, the cron fires once at
 * 8pm and the 10pm preference is ignored — they all share one report,
 * so we send at the first time any recipient asked for.
 *
 * Returns null when no preference rows exist; the caller falls back to
 * the default delivery time.
 */
export async function pickPropertyDeliveryTime(propertyId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('report_preferences')
    .select('delivery_time_local')
    .eq('property_id', propertyId);
  if (error || !data || data.length === 0) return null;
  const times = data.map(r => r.delivery_time_local).filter(Boolean) as string[];
  if (times.length === 0) return null;
  return times.sort()[0];   // lexicographic sort on HH:MM = time-of-day ascending
}

export interface PropertyResult {
  propertyId: string;
  status: string;
  detail: string;
  sentCount?: number;
  failedCount?: number;
}

/** Minimal shape the runner needs from a report payload. */
interface HasPropertyAndDate {
  propertyId: string;
  reportDate: string;
}

export interface ReportCronConfig<P extends HasPropertyAndDate> {
  /** 'daily' | 'weekly' — drives report_type, key prefix, log/heartbeat names. */
  type: 'daily' | 'weekly';
  /** Build the report payload for a property+date; null → build failed. */
  build: (args: { propertyId: string; reportDate: string }) => Promise<P | null>;
  /** Send one report email. */
  send: (args: {
    to: string;
    payload: P;
    lang?: ResolvedRecipient['lang'];
    idempotencyKey?: string;
  }) => Promise<SendEmailResult>;
  /** Detail string for the "build returned null" failure result. */
  buildNullDetail: string;
  /** Detail string for the "no recipients" skip result. */
  noRecipientsDetail: string;
  /**
   * Optional pre-window gate (weekly uses it for the Sunday-only check).
   * Return a PropertyResult to short-circuit that property, or null to
   * proceed into the window/idempotency logic. Skipped for manual runs.
   */
  preGate?: (property: PropertyToCheck, now: Date) => PropertyResult | null;
  /** Extra columns to write onto the report_runs row (weekly: insight_text). */
  extraUpdate?: (payload: P) => Record<string, unknown>;
}

export interface ReportCronRunResult {
  results: PropertyResult[];
  anyFailed: boolean;
  anySent: boolean;
  /**
   * The counters common to both crons, ready to spread into the
   * writeCronHeartbeat notes. Each route adds its own per-type skip
   * counter (skippedNoRecipients / skippedNotSunday) alongside.
   */
  baseNotes: {
    propertiesChecked: number;
    sentCount: number;
    failedCount: number;
    skippedNotInWindow: number;
    skippedAlreadySent: number;
  };
}

/**
 * Run one report-delivery cron pass: list properties, apply the manual-run
 * filter, and process each property (window/idempotency/build/send). Returns
 * the per-property results plus the shared heartbeat counters.
 *
 * The caller (the route) owns the cron gate, the `writeCronHeartbeat` call —
 * whose string-literal name the cron-coverage failsafe checks for — and the
 * response envelope.
 */
export async function runReportCron<P extends HasPropertyAndDate>(
  config: ReportCronConfig<P>,
  req: NextRequest,
): Promise<ReportCronRunResult> {
  const logPrefix = `[cron/run-${config.type}-report]`;
  const subsystem = `cron-run-${config.type}-report`;

  async function processProperty(args: {
    property: PropertyToCheck;
    now: Date;
    forceForReport?: string | null;   // YYYY-MM-DD override for manual runs
    forcePropertyId?: string | null;  // ditto, lets a manual run target one hotel
  }): Promise<PropertyResult> {
    const { property, now } = args;

    // Manual-run path: when ?property_id=…&date=… is hit by an admin, skip
    // the pre-gate + time-window check and just build the report for the
    // requested date. Idempotency still applies.
    const manualReportDate = args.forceForReport ?? null;
    const isManualRun = manualReportDate !== null
      && args.forcePropertyId === property.id;

    let reportDate: string;
    if (isManualRun) {
      reportDate = manualReportDate!;
    } else {
      if (config.preGate) {
        const gated = config.preGate(property, now);
        if (gated) return gated;
      }
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
    const { data: inserted, error: insertErr } = await supabaseAdmin
      .from('report_runs')
      .upsert(
        {
          property_id: property.id,
          report_type: config.type,
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
      log.error(`${logPrefix} report_runs insert failed`, { propertyId: property.id, err: insertErr.message });
      return { propertyId: property.id, status: 'failed', detail: `insert: ${insertErr.message}` };
    }
    if (!inserted) {
      return { propertyId: property.id, status: 'skipped_already_sent', detail: `report_runs row exists for ${reportDate}` };
    }
    const runId = inserted.id as string;

    // Build the payload + resolve recipients in parallel.
    const [payload, recipients] = await Promise.all([
      config.build({ propertyId: property.id, reportDate }),
      resolveRecipients({ propertyId: property.id, reportType: config.type, now }),
    ]);

    if (!payload) {
      // Roll back the placeholder so a future cron tick can try again.
      await supabaseAdmin.from('report_runs').delete().eq('id', runId);
      return { propertyId: property.id, status: 'failed', detail: config.buildNullDetail };
    }
    const extraUpdate = config.extraUpdate ? config.extraUpdate(payload) : {};
    if (recipients.length === 0) {
      // Persist the payload anyway so an admin can browse "what would have
      // been sent" later; but mark the row with an empty outcome list.
      await supabaseAdmin
        .from('report_runs')
        .update({ report_payload: payload, recipients: [], email_send_status: [], ...extraUpdate })
        .eq('id', runId);
      return { propertyId: property.id, status: 'skipped_no_recipients', detail: config.noRecipientsDetail };
    }

    const outcomes: RecipientOutcome[] = [];
    let sent = 0;
    let failed = 0;
    // Per-property deadline — leave headroom before Vercel's 60s function
    // timeout so we always finish the report_runs update at the end. If we
    // approach the deadline mid-loop, remaining recipients are marked
    // 'deferred' so the next cron tick sees an already-existing report_runs
    // row and skips re-sending the ones we already delivered. (Per-recipient
    // idempotency: the Resend key is `${type}:${runId}:${email}`, identical
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
      // Resend has its own internal retry for transient network errors. On
      // rate-limit (429) we record the outcome and move on. We do NOT sleep
      // here because a 30s sleep × N recipients would blow past maxDuration.
      let lastErr: string | undefined;
      let resendId: string | undefined;
      let okSend = false;
      let attempts = 0;
      try {
        attempts = 1;
        const result = await config.send({
          to: r.email,
          payload,
          lang: r.lang,
          idempotencyKey: `${config.type}:${runId}:${r.email}`,
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
        captureException(new Error(`${config.type} report send failed: ${lastErr}`), {
          subsystem,
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
        ...extraUpdate,
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

  const url = new URL(req.url);
  const forcePropertyId = url.searchParams.get('property_id');
  const forceForReport = url.searchParams.get('date');

  const properties = await listProperties(logPrefix);
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
      log.error(`${logPrefix} property errored`, { propertyId: property.id, err: e });
      captureException(e, { subsystem, propertyId: property.id });
      results.push({
        propertyId: property.id,
        status: 'failed',
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const anyFailed = results.some(r => r.status === 'failed');
  const anySent = results.some(r => r.status === 'sent');

  return {
    results,
    anyFailed,
    anySent,
    baseNotes: {
      propertiesChecked: filteredProps.length,
      sentCount: results.filter(r => r.status === 'sent').reduce((a, r) => a + (r.sentCount ?? 0), 0),
      failedCount: results.filter(r => r.status === 'sent').reduce((a, r) => a + (r.failedCount ?? 0), 0),
      skippedNotInWindow: results.filter(r => r.status === 'skipped_not_in_window').length,
      skippedAlreadySent: results.filter(r => r.status === 'skipped_already_sent').length,
    },
  };
}
