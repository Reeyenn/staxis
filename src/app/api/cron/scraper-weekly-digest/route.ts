/**
 * Scraper weekly digest — triggered by GitHub Actions cron.
 *
 * Runs once a week (Saturday 14:00 UTC via
 * .github/workflows/scraper-weekly-digest-cron.yml). Vercel Hobby plan caps
 * crons at once-per-day max so we schedule this from GitHub Actions instead.
 * Goal: a *positive* heartbeat. The health check (scraper-health) is silent
 * when things are fine — but silence after a long stretch can also mean
 * "alerting is broken." This digest makes Reeyen actively see proof of life
 * every weekend along with the week's numbers.
 *
 * Sends one SMS like:
 *   "Staxis weekly: 672/672 pulls succeeded this week (100%). Last good
 *    pull Sat 8:55 AM. All systems green."
 *
 * Implementation:
 *   - Reads scraper_status.data[key='dashboard_counters'] which the scraper
 *     increments atomically on every success/failure.
 *   - Snapshots the prior week's counter to scraper_status[key='digest_state']
 *     so we can diff (the counter is monotonic; we only care about delta).
 *   - On the first run, there's no prior snapshot so we just store one and
 *     skip sending.
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { sendSms } from '@/lib/sms';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const TIMEZONE = 'America/Chicago';

/** Parse an ISO string (from a jsonb field) into a Date, or null. */
function parseIsoDate(v: unknown): Date | null {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
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

async function getStatus(key: string): Promise<Record<string, unknown>> {
  const { data, error } = await supabaseAdmin
    .from('scraper_status')
    .select('data, updated_at')
    .eq('key', key)
    .maybeSingle();
  if (error) throw error;
  if (!data) return {};
  return { ...(data.data as Record<string, unknown>), _updated_at: data.updated_at };
}

async function mergeStatus(key: string, patch: Record<string, unknown>): Promise<void> {
  const current: Record<string, unknown> = await getStatus(key).catch(() => ({}));
  const { _updated_at: _, ...clean } = current;
  void _;
  const merged = { ...clean, ...patch };
  const { error } = await supabaseAdmin
    .from('scraper_status')
    .upsert({ key, data: merged, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
}

async function runDigest(): Promise<{ sent: boolean; detail: string }> {
  const [counters, dashboard, digest] = await Promise.all([
    getStatus('dashboard_counters'),
    getStatus('dashboard'),
    getStatus('digest_state'),
  ]);

  const totalSuccesses = typeof counters.totalSuccesses === 'number' ? counters.totalSuccesses : 0;
  const totalFailures = typeof counters.totalFailures === 'number' ? counters.totalFailures : 0;
  const lastFailureCode = typeof counters.lastFailureCode === 'string' ? counters.lastFailureCode : null;

  const prevSuccesses = typeof digest.lastSuccesses === 'number' ? digest.lastSuccesses : null;
  const prevFailures = typeof digest.lastFailures === 'number' ? digest.lastFailures : null;

  const lastGoodPull = parseIsoDate(dashboard.pulledAt);

  // First run — no baseline yet. Just snapshot and exit.
  if (prevSuccesses === null || prevFailures === null) {
    await mergeStatus('digest_state', {
      lastSuccesses: totalSuccesses,
      lastFailures: totalFailures,
      lastDigestAt: new Date().toISOString(),
    });
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
    message = `Staxis weekly: 0 pull attempts this week. Scraper may be offline. Check Railway.`;
  } else if (deltaFailures === 0) {
    message = `Staxis weekly: ${deltaSuccesses}/${totalAttempts} pulls succeeded (100%). Last good pull ${fmtDateTime(lastGoodPull)}. All systems green.`;
  } else {
    const codeNote = lastFailureCode ? ` (most recent failure code: ${lastFailureCode})` : '';
    message = `Staxis weekly: ${deltaSuccesses}/${totalAttempts} pulls succeeded (${successRate.toFixed(1)}%). ${deltaFailures} failure${deltaFailures === 1 ? '' : 's'} this week${codeNote}. Last good pull ${fmtDateTime(lastGoodPull)}.`;
  }

  const alertPhone = process.env.MANAGER_PHONE || process.env.OPS_ALERT_PHONE;
  let smsSent = false;
  if (alertPhone) {
    try {
      await sendSms(alertPhone, message);
      smsSent = true;
    } catch (err) {
      console.error('[scraper-weekly-digest] SMS send failed', (err as Error).message);
    }
  } else {
    console.warn('[scraper-weekly-digest] MANAGER_PHONE/OPS_ALERT_PHONE env var not set — digest would say:', message);
  }

  await mergeStatus('digest_state', {
    lastSuccesses: totalSuccesses,
    lastFailures: totalFailures,
    lastDigestAt: new Date().toISOString(),
    lastDigestMessage: message,
    lastDigestSmsSent: smsSent,
  });

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
