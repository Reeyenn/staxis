/**
 * GET /api/cron/vercel-watchdog
 *
 * Replaces scraper/vercel-watchdog.js (deleted with the Railway scraper
 * during the Plan v4 cutover).
 *
 * Why a SEPARATE cron from /api/cron/doctor-check:
 *   doctor-check runs hourly with full Sentry alerting. It's the
 *   thorough nightly-sweep style watcher.
 *
 *   THIS watchdog runs every 5 minutes. It's the fast-loop alarm. Its
 *   job is to catch HARD failures (any check 'fail') within 15 min.
 *
 * How a red watchdog reaches a human (SMS was removed with Twilio, 2026-07):
 *   1. Sentry — this route calls captureMessage(..., 'error'), raising an
 *      ERROR-level Sentry event. A Sentry issue-alert rule (email/push on
 *      error) must be configured for it to actually notify anyone.
 *   2. Vercel — the route also returns HTTP 503 on red (see below), so
 *      Vercel logs the cron invocation as FAILED even if Sentry is
 *      unconfigured or down. That's the backstop channel.
 *
 * Known gap (acknowledged): this cron runs ON Vercel, so a Vercel
 *   control-plane outage silences it. The real 2am alarm is a third
 *   monitor that pings /api/admin/doctor from OUTSIDE Vercel (Uptime
 *   Robot / Better Stack / Cronitor) → SMS/push. Set that up.
 *
 * De-duplication: tracked via Sentry's event fingerprinting (same
 * failing checks → same fingerprint → grouped). No need to maintain a
 * consecutive-fail counter in the DB.
 *
 * Auth: CRON_SECRET bearer (Vercel auto-attaches).
 */

import { NextRequest } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { ok } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { captureMessage } from '@/lib/sentry';
import { runAllChecks } from '@/app/api/admin/doctor/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const cronGate = requireCronSecret(req);
  if (cronGate) return cronGate;

  const startedAt = Date.now();
  const report = await runAllChecks(/* useCache */ true);
  const failing = report.checks.filter((c) => c.status === 'fail');
  const warning = report.checks.filter((c) => c.status === 'warn');

  // Always write the heartbeat — proves the cron itself is running.
  await writeCronHeartbeat('vercel-watchdog', {
    requestId,
    notes: {
      durationMs: Date.now() - startedAt,
      failCount: failing.length,
      warnCount: warning.length,
      checkCount: report.checks.length,
    },
  });

  if (failing.length === 0) {
    return ok(
      {
        status: 'green',
        checks: report.checks.length,
        warnCount: warning.length,
      },
      { requestId },
    );
  }

  // Failure: alert via Sentry. Sentry de-dupes by fingerprint
  // (failing-check names), so a sustained failure across many 5-min
  // ticks groups into one Sentry issue + one SMS rather than 12/hour.
  const checkNames = failing.map((c) => c.name).join(',');
  const title = `vercel-watchdog: ${failing.length} failing — ${checkNames.slice(0, 100)}`;

  log.warn('vercel-watchdog detected failing doctor checks', {
    requestId,
    failCount: failing.length,
    warnCount: warning.length,
    checks: failing.map((c) => ({ name: c.name, detail: c.detail })),
  });

  // Raise an ERROR-level Sentry event (3rd arg). Sentry de-dupes by
  // fingerprint (failing-check names), so a sustained failure groups into
  // one issue. Configure a Sentry alert rule (email/push on error) for this
  // to notify a human; the 503 return below is the Vercel-side backstop.
  captureMessage(
    title,
    {
      requestId,
      cron: 'vercel-watchdog',
      failingChecks: failing.map((c) => ({ name: c.name, detail: c.detail, fix: c.fix })),
    },
    'error',
  );

  return ok(
    {
      status: 'red',
      checks: report.checks.length,
      failCount: failing.length,
      warnCount: warning.length,
      failingNames: failing.map((c) => c.name),
      sentryLevel: 'error',
    },
    // A red watchdog must be visible even when Sentry is unconfigured or its
    // transport is down. Non-2xx makes Vercel record the cron invocation as a
    // failure instead of silently presenting a green scheduler history.
    { requestId, status: 503 },
  );
}
