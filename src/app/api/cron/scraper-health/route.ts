/**
 * Scraper health check — triggered by GitHub Actions cron
 *
 * Runs every 15 minutes via .github/workflows/scraper-health-cron.yml
 * (NOT vercel.json — Vercel Hobby plan caps crons at once-per-day, which
 * is useless for this endpoint; GitHub Actions has no such cap). This is
 * the **monitoring layer**: it watches the scraper so a silent failure
 * becomes an SMS to Reeyen within the same business day — not a "why are
 * the numbers wrong" phone call from Maria three hours later.
 *
 * Three signals, all fed by the Railway scraper writing to Firestore:
 *
 *   1. scraperStatus/heartbeat.at  — proves the Node process is alive and
 *      looping. Updated every tick (5 min).
 *   2. scraperStatus/dashboard.pulledAt  — proves the CA→Firestore pipeline
 *      is producing fresh numbers. Updated every successful dashboard pull
 *      (should be every 15 min 5am–11pm local).
 *   3. scraperStatus/dashboard.errorCode  — set when the last pull failed.
 *      The code tells us *why* (login_failed vs timeout vs selector_miss)
 *      so we can send an actionable SMS instead of a generic "broken" page.
 *
 * Alert de-duplication:
 *   We don't want to text Reeyen every 30 min while the scraper is down
 *   overnight. State lives in scraperStatus/alertState:
 *     • lastAlertedCode   — which condition we most recently alerted on
 *     • lastAlertedAt     — when that alert fired
 *     • resolvedAt        — when we sent the "resolved" ping
 *   We only re-alert if the condition CHANGES or enough time (6h) has
 *   passed since the last alert of the same kind. We also send a one-time
 *   "recovered" SMS when things come back so he knows he can stop worrying.
 *
 * Auth:
 *   The GitHub Actions workflow sends `Authorization: Bearer $CRON_SECRET`
 *   using the same secret value set as the CRON_SECRET env var in Vercel.
 *   We check that env var and reject otherwise. This prevents anyone on
 *   the public internet from triggering spam alerts.
 */

import { NextRequest, NextResponse } from 'next/server';
import admin from '@/lib/firebase-admin';
import { sendSms } from '@/lib/sms';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// ─── Thresholds ──────────────────────────────────────────────────────────
// A heartbeat older than this means the scraper Node process has stopped
// ticking entirely. Tick is every 5 min, so 20 min is 4 missed ticks — real.
const HEARTBEAT_DEAD_MIN = 20;

// A dashboard pull older than this during business hours means the CA
// pipeline is broken even if the process is alive. Pulls run every 15 min
// 5am–11pm, so 45 min = 3 missed pulls. Tight enough that Maria sees the
// red banner before she's made a bad decision.
const DASHBOARD_STALE_MIN = 45;

// Don't re-alert on the same condition more often than this. Still alerts
// if the CODE changes (timeout → login_failed is worth a second text).
const REALERT_INTERVAL_HR = 6;

// Only send alerts during hotel waking hours. Overnight errors get caught
// by the first morning run instead of buzzing his phone at 3am.
const ALERT_WINDOW_START = 6;   // 6am local
const ALERT_WINDOW_END   = 22;  // 10pm local
const TIMEZONE = 'America/Chicago';

// ─── Message bank ────────────────────────────────────────────────────────
// Each condition maps to a single, action-oriented SMS. The goal is that
// Reeyen can read the text on his phone and know immediately what to do
// without opening Railway logs.
type AlertCondition =
  | 'heartbeat_dead'
  | 'login_failed'
  | 'session_expired_stuck'
  | 'selector_miss'
  | 'timeout_persistent'
  | 'parse_error'
  | 'validation_failed'
  | 'ca_unreachable'
  | 'unknown_error'
  | 'stale_no_error';  // pulledAt is old but no errorCode — suggests scraper hung silently

function alertMessage(cond: AlertCondition, ctx: AlertContext): string {
  const last = ctx.pulledAtStr ? ` (last good numbers ${ctx.pulledAtStr})` : '';
  const stale = ctx.pulledAtMinutesAgo !== null ? ` ${ctx.pulledAtMinutesAgo} min stale.` : '';
  switch (cond) {
    case 'heartbeat_dead':
      return `Staxis scraper DOWN — no heartbeat for ${ctx.heartbeatMinutesAgo ?? '?'} min. Check Railway deployment.${last}`;
    case 'login_failed':
      return `Staxis scraper: Choice Advantage sign-in failed. Password likely changed — update CA_PASSWORD env var on Railway.${last}`;
    case 'session_expired_stuck':
      return `Staxis scraper: CA sessions keep expiring mid-pull and re-login isn't recovering.${stale}${last}`;
    case 'selector_miss':
      return `Staxis scraper: Choice Advantage page layout changed — Room Count label not found. scraper/dashboard-pull.js needs updating.${last}`;
    case 'timeout_persistent':
      return `Staxis scraper: Choice Advantage timing out on every pull.${stale} Could be CA slow or blocked our IP.${last}`;
    case 'parse_error':
      return `Staxis scraper: Found Room Count but couldn't parse a number from it. CA may be showing "—" instead of a digit.${last}`;
    case 'validation_failed':
      return `Staxis scraper: CA returned a Room Count outside 0–500 range. Check what's happening on CA directly.${last}`;
    case 'ca_unreachable':
      return `Staxis scraper: Cannot reach Choice Advantage (network/DNS).${stale} Usually self-resolves — if persistent, Railway may be IP-blocked.${last}`;
    case 'unknown_error':
      return `Staxis scraper: Unknown error pulling PMS data.${stale} Check Railway logs — error: "${ctx.errorMessage ?? ''}".${last}`;
    case 'stale_no_error':
      return `Staxis scraper: PMS numbers haven't refreshed in ${ctx.pulledAtMinutesAgo ?? '?'} min but no error reported. Scraper may be hung. Check Railway.`;
  }
}

type AlertContext = {
  pulledAtStr: string | null;
  pulledAtMinutesAgo: number | null;
  heartbeatMinutesAgo: number | null;
  errorMessage: string | null;
};

// Map the scraper's errorCode to an alert condition. Some codes are alert-
// worthy on the first occurrence (login_failed), others only if they persist.
function mapErrorToCondition(code: string | null): AlertCondition | null {
  switch (code) {
    case 'login_failed':       return 'login_failed';
    case 'selector_miss':      return 'selector_miss';
    case 'parse_error':        return 'parse_error';
    case 'validation_failed':  return 'validation_failed';
    case 'session_expired':    return 'session_expired_stuck';
    case 'timeout':            return 'timeout_persistent';
    case 'ca_unreachable':     return 'ca_unreachable';
    case 'unknown':            return 'unknown_error';
    default: return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function localHour(nowMs: number, tz: string): number {
  const h = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', hour12: false, timeZone: tz,
  }).format(new Date(nowMs));
  // en-US formatter returns "0" through "23" or "24" for midnight edge cases
  return parseInt(h, 10) % 24;
}

function minutesAgo(date: Date | null, nowMs: number): number | null {
  if (!date) return null;
  return Math.floor((nowMs - date.getTime()) / 60_000);
}

function tsToDate(v: unknown): Date | null {
  const t = (v as { toDate?: () => Date } | undefined)?.toDate?.();
  return t instanceof Date ? t : null;
}

// ─── Handler ─────────────────────────────────────────────────────────────

async function runHealthCheck(): Promise<{ alerted: boolean; condition: AlertCondition | 'ok'; detail: string }> {
  if (!admin.apps.length) {
    return { alerted: false, condition: 'ok', detail: 'Firebase Admin not configured' };
  }
  const db = admin.firestore();
  const nowMs = Date.now();

  // Read all three status docs in parallel.
  const [dashboardSnap, heartbeatSnap, alertStateSnap] = await Promise.all([
    db.collection('scraperStatus').doc('dashboard').get(),
    db.collection('scraperStatus').doc('heartbeat').get(),
    db.collection('scraperStatus').doc('alertState').get(),
  ]);

  const dashboard  = dashboardSnap.exists  ? dashboardSnap.data()  ?? {} : {};
  const heartbeat  = heartbeatSnap.exists  ? heartbeatSnap.data()  ?? {} : {};
  const alertState = alertStateSnap.exists ? alertStateSnap.data() ?? {} : {};

  const pulledAt   = tsToDate(dashboard.pulledAt);
  const heartbeatAt = tsToDate(heartbeat.at);
  const errorCode  = typeof dashboard.errorCode === 'string' ? dashboard.errorCode : null;
  const errorMessage = typeof dashboard.errorMessage === 'string' ? dashboard.errorMessage : null;

  const pulledMinAgo    = minutesAgo(pulledAt, nowMs);
  const heartbeatMinAgo = minutesAgo(heartbeatAt, nowMs);

  // ── Determine current condition ────────────────────────────────────
  // Priority order: heartbeat-dead beats everything (if process is dead,
  // everything else is consequence). Then explicit errorCode wins. Then
  // stale-without-error as the fallback.
  let condition: AlertCondition | null = null;

  if (heartbeatAt === null || (heartbeatMinAgo !== null && heartbeatMinAgo > HEARTBEAT_DEAD_MIN)) {
    condition = 'heartbeat_dead';
  } else if (errorCode) {
    condition = mapErrorToCondition(errorCode);
  } else if (pulledAt && pulledMinAgo !== null && pulledMinAgo > DASHBOARD_STALE_MIN) {
    // Only flag stale-no-error during active hours — the scraper legitimately
    // stops pulling at 11pm, so "last pull 8 hours ago" at 7am is expected.
    const hour = localHour(nowMs, TIMEZONE);
    if (hour >= 5 && hour < 23) {
      condition = 'stale_no_error';
    }
  }

  // ── Recovery detection ─────────────────────────────────────────────
  // If we previously alerted but things are healthy now, send one recovery
  // text and clear the state. This is the one case where we DO send a text
  // without an error — Reeyen asked for confirmation that things are back.
  const prevCondition = typeof alertState.lastAlertedCode === 'string'
    ? alertState.lastAlertedCode as AlertCondition : null;
  const alreadyResolved = alertState.resolvedAt != null;

  if (!condition && prevCondition && !alreadyResolved) {
    const ctx: AlertContext = {
      pulledAtStr: pulledAt ? pulledAt.toLocaleString('en-US', { timeZone: TIMEZONE, hour: 'numeric', minute: '2-digit' }) : null,
      pulledAtMinutesAgo: pulledMinAgo,
      heartbeatMinutesAgo: heartbeatMinAgo,
      errorMessage,
    };
    const alertPhone = process.env.OPS_ALERT_PHONE;
    if (alertPhone) {
      try {
        await sendSms(
          alertPhone,
          `Staxis scraper: recovered. PMS numbers are flowing again${ctx.pulledAtStr ? ` (last pull ${ctx.pulledAtStr})` : ''}.`
        );
      } catch (err) {
        console.error('[scraper-health] recovery SMS failed', (err as Error).message);
      }
    }
    await db.collection('scraperStatus').doc('alertState').set({
      resolvedAt: new Date(),
      lastCheckAt: new Date(),
    }, { merge: true });
    return { alerted: true, condition: 'ok', detail: 'recovered from ' + prevCondition };
  }

  // No condition and nothing to recover — bump lastCheckAt and exit.
  if (!condition) {
    await db.collection('scraperStatus').doc('alertState').set({
      lastCheckAt: new Date(),
    }, { merge: true });
    return { alerted: false, condition: 'ok', detail: 'all green' };
  }

  // ── De-duplication ─────────────────────────────────────────────────
  // Only send if (a) no alert yet for this condition, (b) condition
  // changed, or (c) enough time has passed since the last alert of the
  // same condition.
  const lastAlertedAt = tsToDate(alertState.lastAlertedAt);
  const hoursSinceLastAlert = lastAlertedAt
    ? (nowMs - lastAlertedAt.getTime()) / 3_600_000
    : Infinity;

  const conditionChanged = prevCondition !== condition;
  const enoughTimePassed = hoursSinceLastAlert >= REALERT_INTERVAL_HR;

  if (!conditionChanged && !enoughTimePassed) {
    // Same problem we already alerted about, less than 6h ago → stay quiet.
    await db.collection('scraperStatus').doc('alertState').set({
      lastCheckAt: new Date(),
    }, { merge: true });
    return { alerted: false, condition, detail: 'debounced' };
  }

  // ── Business-hours gate ────────────────────────────────────────────
  // Don't buzz his phone overnight. If the problem persists, we'll catch
  // it on the 6am run.
  const hour = localHour(nowMs, TIMEZONE);
  if (hour < ALERT_WINDOW_START || hour >= ALERT_WINDOW_END) {
    // Track the condition internally so that when we DO send an alert at
    // 6am, de-dup still works.
    await db.collection('scraperStatus').doc('alertState').set({
      pendingCondition: condition,
      lastCheckAt: new Date(),
    }, { merge: true });
    return { alerted: false, condition, detail: 'outside alert window' };
  }

  // ── Send the alert ─────────────────────────────────────────────────
  const ctx: AlertContext = {
    pulledAtStr: pulledAt ? pulledAt.toLocaleString('en-US', { timeZone: TIMEZONE, hour: 'numeric', minute: '2-digit' }) : null,
    pulledAtMinutesAgo: pulledMinAgo,
    heartbeatMinutesAgo: heartbeatMinAgo,
    errorMessage,
  };
  const message = alertMessage(condition, ctx);
  const alertPhone = process.env.OPS_ALERT_PHONE;

  let smsSent = false;
  if (alertPhone) {
    try {
      await sendSms(alertPhone, message);
      smsSent = true;
    } catch (err) {
      console.error('[scraper-health] SMS send failed', (err as Error).message);
    }
  } else {
    console.warn('[scraper-health] OPS_ALERT_PHONE env var not set — alert would fire:', message);
  }

  await db.collection('scraperStatus').doc('alertState').set({
    lastAlertedCode: condition,
    lastAlertedAt:   new Date(),
    lastAlertedMessage: message,
    lastAlertedSmsSent: smsSent,
    lastCheckAt:     new Date(),
    resolvedAt:      null,  // clear so the NEXT recovery triggers a recovery text
    pendingCondition: null,
  }, { merge: true });

  return { alerted: smsSent, condition, detail: message };
}

export async function GET(req: NextRequest) {
  // Auth — Vercel cron sets Authorization: Bearer $CRON_SECRET when
  // CRON_SECRET is configured. If unset, allow the route for manual testing
  // (we want a way to ping it from the browser during setup).
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  try {
    const result = await runHealthCheck();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error('[scraper-health] handler threw', err);
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

// Allow manual POST trigger too — useful for "test my alert config" from curl.
export async function POST(req: NextRequest) {
  return GET(req);
}
