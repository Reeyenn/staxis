/**
 * Scraper weekly digest — Vercel cron
 *
 * Runs once a week (Saturday 9am CT via vercel.json). Goal: a *positive*
 * heartbeat. The health check (scraper-health) is silent when things are
 * fine — but silence after a long stretch can also mean "alerting is
 * broken." This digest makes Reeyen actively see proof of life every
 * weekend along with the week's numbers.
 *
 * Sends one SMS like:
 *   "Staxis weekly: 672/672 pulls succeeded this week (100%). Last good
 *    pull Sat 8:55 AM. All systems green."
 *
 * Or if there were any failures:
 *   "Staxis weekly: 670/672 pulls succeeded (99.7%). 2 failures this week
 *    (timeout x2). Last good pull Sat 8:55 AM."
 *
 * Implementation:
 *   - Reads scraperStatus/dashboardCounters which the scraper increments
 *     atomically on every success/failure.
 *   - Snapshots the prior week's counter to scraperStatus/digestState so we
 *     can diff (this counter is monotonic; we only ever care about delta).
 *   - On the first run, there's no prior snapshot so we just store one and
 *     skip sending.
 */

import { NextRequest, NextResponse } from 'next/server';
import admin from '@/lib/firebase-admin';
import { sendSms } from '@/lib/sms';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const TIMEZONE = 'America/Chicago';

function tsToDate(v: unknown): Date | null {
  const t = (v as { toDate?: () => Date } | undefined)?.toDate?.();
  return t instanceof Date ? t : null;
}

function fmtDateTime(d: Date | null): string {
  if (!d) return 'unknown';
  return d.toLocaleString('en-US', {
    timeZone: TIMEZONE,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

async function runDigest(): Promise<{ sent: boolean; detail: string }> {
  if (!admin.apps.length) {
    return { sent: false, detail: 'Firebase Admin not configured' };
  }
  const db = admin.firestore();

  const [countersSnap, dashboardSnap, digestSnap] = await Promise.all([
    db.collection('scraperStatus').doc('dashboardCounters').get(),
    db.collection('scraperStatus').doc('dashboard').get(),
    db.collection('scraperStatus').doc('digestState').get(),
  ]);

  const counters = countersSnap.exists ? countersSnap.data() ?? {} : {};
  const dashboard = dashboardSnap.exists ? dashboardSnap.data() ?? {} : {};
  const digest = digestSnap.exists ? digestSnap.data() ?? {} : {};

  const totalSuccesses = typeof counters.totalSuccesses === 'number' ? counters.totalSuccesses : 0;
  const totalFailures = typeof counters.totalFailures === 'number' ? counters.totalFailures : 0;
  const lastFailureCode = typeof counters.lastFailureCode === 'string' ? counters.lastFailureCode : null;

  const prevSuccesses = typeof digest.lastSuccesses === 'number' ? digest.lastSuccesses : null;
  const prevFailures = typeof digest.lastFailures === 'number' ? digest.lastFailures : null;

  const lastGoodPull = tsToDate(dashboard.pulledAt);

  // First run — no baseline yet. Just snapshot and exit.
  if (prevSuccesses === null || prevFailures === null) {
    await db.collection('scraperStatus').doc('digestState').set({
      lastSuccesses: totalSuccesses,
      lastFailures: totalFailures,
      lastDigestAt: new Date(),
    }, { merge: true });
    return { sent: false, detail: 'first run, baseline snapshot stored' };
  }

  const deltaSuccesses = totalSuccesses - prevSuccesses;
  const deltaFailures = totalFailures - prevFailures;
  const totalAttempts = deltaSuccesses + deltaFailures;
  const successRate = totalAttempts > 0
    ? (deltaSuccesses / totalAttempts) * 100
    : 100;

  let message: string;
  if (totalAttempts === 0) {
    // Zero attempts in a week is suspicious — scraper not running at all.
    message = `Staxis weekly: 0 pull attempts this week. Scraper may be offline. Check Railway.`;
  } else if (deltaFailures === 0) {
    message = `Staxis weekly: ${deltaSuccesses}/${totalAttempts} pulls succeeded (100%). Last good pull ${fmtDateTime(lastGoodPull)}. All systems green.`;
  } else {
    const codeNote = lastFailureCode ? ` (most recent failure code: ${lastFailureCode})` : '';
    message = `Staxis weekly: ${deltaSuccesses}/${totalAttempts} pulls succeeded (${successRate.toFixed(1)}%). ${deltaFailures} failure${deltaFailures === 1 ? '' : 's'} this week${codeNote}. Last good pull ${fmtDateTime(lastGoodPull)}.`;
  }

  const alertPhone = process.env.OPS_ALERT_PHONE;
  let smsSent = false;
  if (alertPhone) {
    try {
      await sendSms(alertPhone, message);
      smsSent = true;
    } catch (err) {
      console.error('[scraper-weekly-digest] SMS send failed', (err as Error).message);
    }
  } else {
    console.warn('[scraper-weekly-digest] OPS_ALERT_PHONE env var not set — digest would say:', message);
  }

  await db.collection('scraperStatus').doc('digestState').set({
    lastSuccesses: totalSuccesses,
    lastFailures: totalFailures,
    lastDigestAt: new Date(),
    lastDigestMessage: message,
    lastDigestSmsSent: smsSent,
  }, { merge: true });

  return { sent: smsSent, detail: message };
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  try {
    const result = await runDigest();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error('[scraper-weekly-digest] handler threw', err);
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
