/**
 * GET /api/cron/doctor-check
 *
 * Hourly health watchdog. Runs the doctor's full check battery and
 * fires a Sentry event (→ SMS via the staxis-sms-alerts integration)
 * if ANY check is `fail`. The watchdog Reeyen explicitly asked for
 * after the 2026-05-13 silent ANTHROPIC_API_KEY outage — to make sure
 * that kind of breakage gets a phone buzz instead of waiting for a
 * user to discover it.
 *
 * Round 13, 2026-05-13. Reuses runAllChecks() exported from the
 * admin doctor route so both surfaces share the same battery —
 * change a check there, this cron picks it up automatically.
 *
 * Auth: CRON_SECRET bearer.
 *
 * Cadence: top of every hour UTC (vercel.json: "0 * * * *"). Doctor's
 * checks are cheap (env reads + a few DB queries) — well under 1s
 * typical. Hourly means the worst case is up to 1 hour of brokenness
 * before Reeyen's phone buzzes.
 */

import { NextRequest } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { captureMessage } from '@/lib/sentry';
import { runAllChecks } from '@/app/api/admin/doctor/route';

/** Minimal shape used by the alert decision — keeps the testable
 *  helper independent of next/server + the full DoctorReport type. */
export interface DoctorCheckSummary {
  ok: boolean;
  commitSha?: string;
  vercelEnv?: string;
  checks: Array<{ name: string; status: 'ok' | 'warn' | 'fail' | 'skipped'; detail: string; fix?: string }>;
}

export interface AlertDecision {
  shouldAlert: boolean;
  failCount: number;
  warnCount: number;
  failingChecks: Array<{ name: string; detail: string; fix?: string }>;
  message?: string;
}

/** Pure function — decides whether the cron should fire a Sentry
 *  alert and what payload to send. Exported for unit testing.
 *  Round 13, 2026-05-13. */
export function decideDoctorCheckAlert(report: DoctorCheckSummary): AlertDecision {
  const failingChecks = report.checks
    .filter(c => c.status === 'fail')
    .map(c => ({ name: c.name, detail: c.detail, fix: c.fix }));
  const warnCount = report.checks.filter(c => c.status === 'warn').length;
  const failCount = failingChecks.length;
  const shouldAlert = failCount > 0;
  // Include the failing check names in the alert title (not just the count)
  // so Sentry/email/Slack lists are scannable. Round 16, 2026-05-15: the
  // previous "doctor: 2 checks failing" gave zero signal about WHICH checks
  // broke — operators had to click into Sentry "extra" to find out.
  // Cap at MESSAGE_MAX so we don't overflow Sentry's title field (typical
  // truncation around 200 chars).
  const MESSAGE_MAX = 180;
  let message: string | undefined;
  if (shouldAlert) {
    const prefix = `doctor: ${failCount} failing — `;
    const names = failingChecks.map(c => c.name);
    let joined = names.join(', ');
    if (prefix.length + joined.length > MESSAGE_MAX) {
      // Walk the list and stop once we'd exceed the budget; report the rest
      // as "+N more". Sentry's "extra.failing" still has the full list.
      const budget = MESSAGE_MAX - prefix.length;
      const shown: string[] = [];
      let used = 0;
      for (let i = 0; i < names.length; i++) {
        const sep = shown.length === 0 ? 0 : 2; // ", "
        const tail = `, +${names.length - i} more`;
        if (used + sep + names[i].length + tail.length > budget) break;
        shown.push(names[i]);
        used += sep + names[i].length;
      }
      const hidden = names.length - shown.length;
      joined = shown.join(', ') + (hidden > 0 ? `, +${hidden} more` : '');
    }
    message = prefix + joined;
  }
  return { shouldAlert, failCount, warnCount, failingChecks, message };
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const cronGate = requireCronSecret(req);
  if (cronGate) return cronGate;

  try {
    // Phase M2: hourly cron must always see fresh state — bypass the
    // doctor's per-check cache. Otherwise a "fail" cached for 60s
    // could be served stale and we'd alert based on outdated data.
    const report = await runAllChecks(false);
    const decision = decideDoctorCheckAlert(report);

    if (decision.shouldAlert && decision.message) {
      log.warn('[doctor-check] one or more checks failing', {
        requestId,
        failCount: decision.failCount,
        failingChecks: decision.failingChecks,
      });
      // captureMessage (info-level) not captureException — these are
      // known monitored states, not unhandled exceptions. The Sentry
      // alert rule "high priority issues" fires on either type.
      captureMessage(decision.message, {
        subsystem: 'doctor-check',
        failCount: decision.failCount,
        failing: decision.failingChecks,
        commitSha: report.commitSha,
        vercelEnv: report.vercelEnv,
      });
    }

    await writeCronHeartbeat('doctor-check', {
      requestId,
      notes: {
        failCount: decision.failCount,
        warnCount: decision.warnCount,
        totalChecks: report.summary.total,
      },
    });

    return ok({
      ok: report.ok,
      failCount: decision.failCount,
      warnCount: decision.warnCount,
      failingChecks: decision.failingChecks,
    }, { requestId });
  } catch (e) {
    return err(`doctor-check cron failed: ${e instanceof Error ? e.message : String(e)}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
