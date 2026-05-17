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
 * Three signals, all fed by the Railway scraper writing to Supabase
 * scraper_status rows:
 *
 *   1. scraper_status[heartbeat].value.at  — proves the Node process is
 *      alive and looping. Updated every tick (5 min).
 *   2. scraper_status[dashboard].value.pulledAt  — proves the CA→Supabase
 *      pipeline is producing fresh numbers. Updated every successful
 *      dashboard pull (should be every 15 min 5am–11pm local).
 *   3. scraper_status[dashboard].value.errorCode  — set when the last pull
 *      failed. The code tells us *why* (login_failed vs timeout vs
 *      selector_miss) so we can send an actionable SMS instead of a
 *      generic "broken" page.
 *
 * Alert de-duplication:
 *   We don't want to text Reeyen every 30 min while the scraper is down
 *   overnight. State lives in scraper_status[alertState].value:
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
import { requireCronSecret } from '@/lib/api-auth';
import { supabaseAdmin, verifySupabaseAdmin } from '@/lib/supabase-admin';
import { sendSms } from '@/lib/sms';
import { errToString } from '@/lib/utils';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import { log } from '@/lib/log';
import { env } from '@/lib/env';

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
  | 'stale_no_error'
  | 'csv_pull_failing'    // morning/evening CSV pull errored (Playwright selector miss, timeout, etc.)
  | 'csv_schema_drift';   // CA changed the Housekeeping Check-off List columns — Codex audit 2026-05-12

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
    case 'csv_pull_failing':
      return `Staxis scraper: CSV pull failing (${ctx.csvPullType ?? '?'}). Last good ${ctx.pulledAtStr ?? 'unknown'}. Error: "${(ctx.errorMessage ?? '').slice(0, 120)}". Check Railway logs and Choice Advantage page layout.`;
    case 'csv_schema_drift':
      return `Staxis scraper: Choice Advantage changed the Housekeeping Check-off List columns. We refused to parse rather than save wrong data. Update EXPECTED_CSV_HEADERS in scraper/csv-scraper.js to match CA's new export. Error: "${(ctx.errorMessage ?? '').slice(0, 120)}"`;
  }
}

type AlertContext = {
  pulledAtStr: string | null;
  pulledAtMinutesAgo: number | null;
  heartbeatMinutesAgo: number | null;
  errorMessage: string | null;
  csvPullType?: 'morning' | 'evening';
};

function mapErrorToCondition(code: string | null): AlertCondition | null {
  switch (code) {
    case 'login_failed':       return 'login_failed';
    case 'selector_miss':      return 'selector_miss';
    case 'parse_error':        return 'parse_error';
    case 'validation_failed':  return 'validation_failed';
    case 'session_expired':    return 'session_expired_stuck';
    case 'timeout':            return 'timeout_persistent';
    case 'ca_unreachable':     return 'ca_unreachable';
    case 'csv_schema_drift':   return 'csv_schema_drift';
    case 'unknown':            return 'unknown_error';
    default: return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function localHour(nowMs: number, tz: string): number {
  const h = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', hour12: false, timeZone: tz,
  }).format(new Date(nowMs));
  return parseInt(h, 10) % 24;
}

function minutesAgo(date: Date | null, nowMs: number): number | null {
  if (!date) return null;
  return Math.floor((nowMs - date.getTime()) / 60_000);
}

// Parse an ISO string or Date into a Date. Postgres returns timestamptz
// as ISO strings in JSON responses.
function parseDate(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === 'string') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// Fetch a single scraper_status row's data jsonb. Returns {} if missing.
async function getStatus(key: string): Promise<Record<string, unknown>> {
  const { data, error } = await supabaseAdmin
    .from('scraper_status')
    .select('data, updated_at')
    .eq('key', key)
    .maybeSingle();
  if (error) throw error;
  if (!data) return {};
  const value = (data.data ?? {}) as Record<string, unknown>;
  // Surface updated_at alongside value so callers that want a fallback
  // timestamp (when value.at is absent) can use it.
  return { ...value, _updated_at: data.updated_at };
}

// Upsert a scraper_status row with merged jsonb data. Supabase jsonb
// doesn't have a native "merge" op, so we read-modify-write client-side.
//
// IMPORTANT: don't swallow read failures here. If we can't read the
// existing row but pretend it was empty {}, the dedup logic in
// runHealthCheck() loses its 6-hour quiet-window memory and starts
// re-firing the same alert on every cron tick — Reeyen would get spam
// SMS at 3am for a single underlying problem. Throw, so the GET handler's
// catch returns 500 and GitHub Actions emails about the broken cron
// instead of the cron silently corrupting our alert state.
async function mergeStatus(key: string, patch: Record<string, unknown>): Promise<void> {
  const current: Record<string, unknown> = await getStatus(key);
  // Strip out our synthetic _updated_at before round-tripping.
  const { _updated_at: _, ...currentClean } = current;
  void _;
  const merged = { ...currentClean, ...patch };
  const { error } = await supabaseAdmin
    .from('scraper_status')
    .upsert({ key, data: merged, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
}

// ─── Handler ─────────────────────────────────────────────────────────────

async function runHealthCheck(): Promise<{ alerted: boolean; condition: AlertCondition | 'ok'; detail: string }> {
  // Preflight the service_role key. If this throws, the catch in GET()
  // returns the specific error message to GitHub Actions — which then emails
  // Reeyen the exact fix instead of a generic "workflow failed". Memoized,
  // so only the first request per cold-start pays the round-trip.
  await verifySupabaseAdmin();

  const nowMs = Date.now();

  // Read all the status rows we need in parallel.
  // 'morning' and 'evening' are the CSV pull statuses — these were missing
  // from the original health check, which is how the 2026-04-27
  // 'CSVcheckbox selector miss' bug stayed silent for 3+ hours.
  const [dashboard, heartbeat, alertState, morning, evening] = await Promise.all([
    getStatus('dashboard'),
    getStatus('heartbeat'),
    getStatus('alertState'),
    getStatus('morning'),
    getStatus('evening'),
  ]);

  // heartbeat.at is an ISO string set by the scraper; fall back to row's
  // updated_at if the value payload is malformed.
  const heartbeatAt = parseDate(heartbeat.at) ?? parseDate(heartbeat._updated_at);
  const pulledAt    = parseDate(dashboard.pulledAt) ?? parseDate(dashboard._updated_at);
  const errorCode    = typeof dashboard.errorCode === 'string' ? dashboard.errorCode : null;
  const errorMessage = typeof dashboard.errorMessage === 'string' ? dashboard.errorMessage : null;

  const pulledMinAgo    = minutesAgo(pulledAt, nowMs);
  const heartbeatMinAgo = minutesAgo(heartbeatAt, nowMs);

  // CSV pulls — pick whichever is most recent and look at its status.
  // The scraper only writes one of them per tick (morning before 7pm CT,
  // evening from 7pm). Whichever has the newer `at` is the one we care about.
  const morningAt = parseDate(morning.at);
  const eveningAt = parseDate(evening.at);
  const csvPull   = (morningAt && eveningAt && morningAt > eveningAt) ? morning
                  : (morningAt && !eveningAt) ? morning
                  : (!morningAt && eveningAt) ? evening
                  : (morningAt && eveningAt) ? evening
                  : morning;
  const csvPullType: 'morning' | 'evening' =
    csvPull === morning ? 'morning' : 'evening';
  const csvStatus    = typeof csvPull.status    === 'string' ? csvPull.status    : null;
  const csvError     = typeof csvPull.error     === 'string' ? csvPull.error     : null;
  const csvErrorCode = typeof csvPull.errorCode === 'string' ? csvPull.errorCode : null;
  const csvFailures  = typeof csvPull.consecutiveFailures === 'number' ? csvPull.consecutiveFailures : 0;
  const csvAt        = parseDate(csvPull.at);

  // 2 consecutive misses (= 10 min of failure) is our alerting threshold.
  // Why 2: a single transient blip (CA load spike, Playwright Chromium
  // hiccup) self-recovers on the next 5-min tick, so alerting on 1 would
  // produce noise. The 2026-04-27 silent outage gave us 27 misses before
  // the dashboard staleness threshold kicked in — way too long. 2 is the
  // minimum that distinguishes real failure from transient blip.
  const CSV_FAILURE_THRESHOLD = 2;

  // ── Determine current condition ────────────────────────────────────
  let condition: AlertCondition | null = null;

  if (heartbeatAt === null || (heartbeatMinAgo !== null && heartbeatMinAgo > HEARTBEAT_DEAD_MIN)) {
    condition = 'heartbeat_dead';
  } else if (errorCode) {
    condition = mapErrorToCondition(errorCode);
  } else if (csvStatus === 'error' && csvFailures >= CSV_FAILURE_THRESHOLD) {
    // CSV pull blew up at least CSV_FAILURE_THRESHOLD times in a row. With
    // the typed-error rollout (2026-04-27), csvErrorCode flows through too;
    // login_failed and session_expired on the CSV path map to the same
    // conditions as their dashboard-pull equivalents so the alert text is
    // the actionable one rather than the generic 'csv_pull_failing'.
    condition = csvErrorCode ? mapErrorToCondition(csvErrorCode) ?? 'csv_pull_failing' : 'csv_pull_failing';
  } else if (pulledAt && pulledMinAgo !== null && pulledMinAgo > DASHBOARD_STALE_MIN) {
    const hour = localHour(nowMs, TIMEZONE);
    if (hour >= 5 && hour < 23) {
      condition = 'stale_no_error';
    }
  }

  // ── Recovery detection ─────────────────────────────────────────────
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
    const alertPhone = env.OPS_ALERT_PHONE;
    if (alertPhone) {
      try {
        await sendSms(
          alertPhone,
          `Staxis scraper: recovered. PMS numbers are flowing again${ctx.pulledAtStr ? ` (last pull ${ctx.pulledAtStr})` : ''}.`
        );
      } catch (err) {
        log.error('[scraper-health] recovery SMS failed', { err });
      }
    }
    await mergeStatus('alertState', {
      resolvedAt: new Date().toISOString(),
      lastCheckAt: new Date().toISOString(),
      // Recovery clears any pending "tried but couldn't deliver" markers.
      alertSuppressedReason: null,
      alertSuppressedAt: null,
      lastSmsError: null,
    });
    return { alerted: true, condition: 'ok', detail: 'recovered from ' + prevCondition };
  }

  if (!condition) {
    await mergeStatus('alertState', {
      lastCheckAt: new Date().toISOString(),
    });
    return { alerted: false, condition: 'ok', detail: 'all green' };
  }

  // ── De-duplication ─────────────────────────────────────────────────
  const lastAlertedAt = parseDate(alertState.lastAlertedAt);
  const hoursSinceLastAlert = lastAlertedAt
    ? (nowMs - lastAlertedAt.getTime()) / 3_600_000
    : Infinity;

  const conditionChanged = prevCondition !== condition;
  const enoughTimePassed = hoursSinceLastAlert >= REALERT_INTERVAL_HR;

  if (!conditionChanged && !enoughTimePassed) {
    await mergeStatus('alertState', {
      lastCheckAt: new Date().toISOString(),
    });
    return { alerted: false, condition, detail: 'debounced' };
  }

  // ── Business-hours gate ────────────────────────────────────────────
  const hour = localHour(nowMs, TIMEZONE);
  if (hour < ALERT_WINDOW_START || hour >= ALERT_WINDOW_END) {
    await mergeStatus('alertState', {
      pendingCondition: condition,
      lastCheckAt: new Date().toISOString(),
    });
    return { alerted: false, condition, detail: 'outside alert window' };
  }

  // ── Send the alert ─────────────────────────────────────────────────
  // For csv_pull_failing, prefer the csv pull's own timestamp + error string.
  const isCsvCondition = condition === 'csv_pull_failing';
  const refTime = isCsvCondition ? csvAt : pulledAt;
  const ctx: AlertContext = {
    pulledAtStr: refTime ? refTime.toLocaleString('en-US', { timeZone: TIMEZONE, hour: 'numeric', minute: '2-digit' }) : null,
    pulledAtMinutesAgo: minutesAgo(refTime, nowMs),
    heartbeatMinutesAgo: heartbeatMinAgo,
    errorMessage: isCsvCondition ? csvError : errorMessage,
    csvPullType: isCsvCondition ? csvPullType : undefined,
  };
  const message = alertMessage(condition, ctx);
  const alertPhone = env.OPS_ALERT_PHONE;

  let smsSent = false;
  let suppressedReason: string | null = null;
  let smsError: string | null = null;
  if (alertPhone) {
    try {
      await sendSms(alertPhone, message);
      smsSent = true;
    } catch (err) {
      smsError = errToString(err);
      log.error('[scraper-health] SMS send failed', { err });
      suppressedReason = 'sms_send_failed';
    }
  } else {
    console.warn('[scraper-health] MANAGER_PHONE env var not set — alert would fire:', message);
    suppressedReason = 'no_alert_phone_on_vercel';
  }

  await mergeStatus('alertState', {
    lastAlertedCode: condition,
    lastAlertedAt: new Date().toISOString(),
    lastAlertedMessage: message,
    lastAlertedSmsSent: smsSent,
    // Record why an alert didn't deliver, so /api/admin/doctor's
    // `watchdog_alert_path` check can see "we tried, we couldn't" and
    // surface it as a hard failure. Without this, the 2026-04-27 silent
    // outage repeats: every condition = alert path went to a console.warn
    // that nobody read. Cleared on the next successful send (smsSent=true
    // → suppressedReason=null in the patch).
    alertSuppressedReason: suppressedReason,
    alertSuppressedAt: suppressedReason ? new Date().toISOString() : null,
    lastSmsError: smsError,
    lastCheckAt: new Date().toISOString(),
    resolvedAt: null,  // clear so the NEXT recovery triggers a recovery text
    pendingCondition: null,
  });

  return { alerted: smsSent, condition, detail: message };
}

export async function GET(req: NextRequest) {
  // requireCronSecret: timing-safe Bearer compare via crypto.timingSafeEqual.
  // Same auth gate as before; consolidated into the shared helper so all
  // cron endpoints use a single, correct implementation.
  const unauth = requireCronSecret(req);
  if (unauth) return unauth;

  try {
    const result = await runHealthCheck();
    await writeCronHeartbeat('scraper-health');
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = errToString(err);
    log.error('[scraper-health] handler threw', { err });
    return NextResponse.json(
      { ok: false, error: msg },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
