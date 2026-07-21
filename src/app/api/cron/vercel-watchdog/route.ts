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
 *   job is to catch HARD failures (any check 'fail') within 15 min and
 *   fire SMS — same SLA the Railway watchdog had.
 *
 * Loss of cross-platform redundancy (acknowledged in Plan v4):
 *   The Railway watchdog ran in a different cloud than Vercel, so a
 *   Vercel outage couldn't silence it. This new cron runs ON Vercel, so
 *   a Vercel control-plane outage would silence it too. We accept this:
 *   Railway is being deleted anyway, GitHub Actions scraper-health
 *   continues to provide one external watcher, and adding a third
 *   external monitor (Uptime Robot, Better Stack, etc.) is the right
 *   long-term solution if this matters.
 *
 * De-duplication: tracked via Sentry's event fingerprinting (same
 * failing checks → same fingerprint → grouped). No need to maintain a
 * consecutive-fail counter in the DB.
 *
 * Business-hours-only SMS escalation: matches the Railway watchdog
 * convention. After-hours failures land in Sentry email; SMS waits for
 * 6am Central.
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

/** Hours-of-day (Central) during which a fail-state SMS fires. Outside
 *  this window, failures still go to Sentry (which sends email) but
 *  don't wake Reeyen at 3am. Matches old vercel-watchdog.js policy. */
const BUSINESS_HOURS_START = 6;
const BUSINESS_HOURS_END = 22;
const TIMEZONE = 'America/Chicago';

function inBusinessHours(): boolean {
  const hourStr = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    hour: 'numeric',
    hour12: false,
  }).format(new Date());
  const hour = Number.parseInt(hourStr.replace(/[^0-9]/g, ''), 10);
  return hour >= BUSINESS_HOURS_START && hour < BUSINESS_HOURS_END;
}

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
  const isBusinessHours = inBusinessHours();
  const title = `vercel-watchdog: ${failing.length} failing — ${checkNames.slice(0, 100)}`;

  log.warn('vercel-watchdog detected failing doctor checks', {
    requestId,
    failCount: failing.length,
    warnCount: warning.length,
    checks: failing.map((c) => ({ name: c.name, detail: c.detail })),
    businessHours: isBusinessHours,
  });

  // captureMessage takes (message, extras). Severity goes into extras
  // via the conventional `_level` key — the Sentry integration that
  // routes to SMS looks for failing-check signals + business-hours
  // gating in the extras blob.
  captureMessage(title, {
    requestId,
    cron: 'vercel-watchdog',
    failingChecks: failing.map((c) => ({ name: c.name, detail: c.detail, fix: c.fix })),
    businessHours: isBusinessHours,
    _level: isBusinessHours ? 'error' : 'warning',
  });

  return ok(
    {
      status: 'red',
      checks: report.checks.length,
      failCount: failing.length,
      warnCount: warning.length,
      failingNames: failing.map((c) => c.name),
      alertedBusinessHours: isBusinessHours,
    },
    // A red watchdog must be visible even when Sentry is unconfigured or its
    // transport is down. Non-2xx makes Vercel record the cron invocation as a
    // failure instead of silently presenting a green scheduler history.
    { requestId, status: 503 },
  );
}
