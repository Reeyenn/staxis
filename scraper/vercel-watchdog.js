/**
 * Vercel Watchdog — the "other side" of cross-platform monitoring
 *
 * ─── Why this exists ─────────────────────────────────────────────────────
 * Our GitHub Actions scraper-health cron is great at catching "Railway
 * scraper is dead." But who watches the WATCHMAN? If Vercel itself drifts
 * (stale Supabase key, missing env var, expired Twilio token, OOM on a
 * route), GH Actions' scraper-health only notices if its dependencies on
 * Vercel also break — and it shares Vercel's network path.
 *
 * This module runs INSIDE the Railway scraper process. Railway is a
 * completely different cloud in a different network than Vercel or
 * GitHub. Every tick, it pings https://hotelops-ai.vercel.app/api/admin/doctor
 * with the shared CRON_SECRET. If Vercel's doctor returns red — or doesn't
 * respond at all — Railway texts Reeyen directly using the already-
 * configured Twilio account.
 *
 * Result: Vercel watches Railway (GH Actions scraper-health). Railway
 * watches Vercel (this module). Both sides have independent network paths
 * and independent alert delivery. A single platform outage CAN'T hide
 * from us.
 *
 * ─── Design choices ──────────────────────────────────────────────────────
 *
 *   • De-duplication: alert only after N consecutive failures. A single
 *     500 from a cold-starting Lambda isn't worth waking you up — 3 in a
 *     row (15 min of sustained failure) is.
 *
 *   • Alert debouncing: once alerted, stay quiet until we've recovered.
 *     On recovery, send a one-line "Vercel recovered" SMS.
 *
 *   • State in Supabase: scraper_status[key='vercel_watchdog'] stores
 *     consecutive fail count + lastAlertedAt. Survives Railway redeploys
 *     so the counter doesn't reset every time the container cycles.
 *
 *   • Non-blocking: every call is wrapped in try/catch. This module MUST
 *     NEVER crash the main scraper loop — if the watchdog itself breaks,
 *     we log and continue scraping.
 *
 *   • No new dependencies: uses native fetch + basic-auth-encoded Twilio
 *     REST API. Keeps scraper's package.json minimal.
 *
 *   • Graceful degradation: if CRON_SECRET or OPS_ALERT_PHONE aren't set
 *     on Railway, the watchdog logs a warning and no-ops instead of
 *     crashing. Gives Reeyen time to add the env vars without breaking
 *     the rest of the scraper.
 *
 *   • Business-hours gate: overnight Vercel hiccups are caught by GH
 *     Actions email; no need to buzz Reeyen's phone at 3am when he can
 *     only fix it at 8am anyway.
 */

const { mergeStatus, getStatus } = require('./supabase-helpers');

// How many consecutive failures before we alert. 3 * 5-min-tick = 15 min
// of sustained failure. Tight enough that Vercel drift doesn't hide for
// long, loose enough to absorb a single cold-start blip.
const FAILURE_THRESHOLD = 3;

// After alerting, how long before we'll alert again for the same condition.
// Same 6h as scraper-health — don't spam about the same problem.
const REALERT_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Business-hours window (local Central). Matches scraper-health's.
const ALERT_WINDOW_START = 6;
const ALERT_WINDOW_END   = 22;

// Doctor endpoint — Vercel's production URL. We hit this URL from Railway
// specifically because that's the whole point: cross-platform check.
const DOCTOR_URL = process.env.VERCEL_DOCTOR_URL
  || 'https://hotelops-ai.vercel.app/api/admin/doctor';

// Max time to wait for doctor to respond. Doctor itself caps at 30s, so
// 35s covers the round trip with headroom.
const DOCTOR_TIMEOUT_MS = 35_000;

function log(msg) {
  console.log(`[${new Date().toISOString()}] [watchdog] ${msg}`);
}

function localHour(tz) {
  return parseInt(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz })
      .format(new Date()),
    10
  );
}

/**
 * Ping the doctor endpoint. Returns a classified result:
 *   { status: 'ok'       }                        — HTTP 200, ok:true
 *   { status: 'red', detail: '...'  }             — HTTP 503 (checks failed) or ok:false body
 *   { status: 'unreachable', detail: '...' }      — network error, timeout, non-2xx/503
 *   { status: 'auth_mismatch', detail: '...' }    — HTTP 401 (CRON_SECRET drift)
 *
 * We distinguish 'unreachable' from 'red' because their remediation is
 * different: red = fix Vercel config, unreachable = check network/Vercel up.
 */
async function pingDoctor(cronSecret) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOCTOR_TIMEOUT_MS);
  try {
    const res = await fetch(DOCTOR_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${cronSecret}` },
      signal: controller.signal,
    });

    if (res.status === 401) {
      return {
        status: 'auth_mismatch',
        detail: 'Vercel returned 401. CRON_SECRET on Railway differs from Vercel.',
      };
    }

    // 200 (all green) and 503 (some red) both return structured JSON. Anything
    // else is a transport-level issue we classify as unreachable.
    if (res.status !== 200 && res.status !== 503) {
      return {
        status: 'unreachable',
        detail: `Vercel returned HTTP ${res.status} ${res.statusText}`,
      };
    }

    const body = await res.json().catch(() => null);
    if (!body || typeof body.ok !== 'boolean') {
      return {
        status: 'unreachable',
        detail: `Vercel doctor returned malformed JSON (HTTP ${res.status})`,
      };
    }

    if (body.ok) {
      return { status: 'ok' };
    }

    // Red — pick the most informative failing check.
    const failing = Array.isArray(body.checks)
      ? body.checks.filter(c => c && c.status === 'fail').map(c => c.name)
      : [];
    return {
      status: 'red',
      detail: failing.length ? `failing: ${failing.join(', ')}` : 'unknown red check',
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { status: 'unreachable', detail: `timed out after ${DOCTOR_TIMEOUT_MS}ms` };
    }
    return { status: 'unreachable', detail: err.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send SMS directly via Twilio REST API. No twilio-node dependency.
 * Returns { ok: true } on success, { ok: false, detail } on failure.
 */
async function sendTwilioSms(to, body) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  // Support both naming conventions — TWILIO_FROM_NUMBER is the canonical
  // one used by the Next.js sms.ts lib; TWILIO_PHONE_NUMBER is the legacy
  // Railway var. Fall back to either.
  const from  = process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !token || !from) {
    return { ok: false, detail: 'Twilio env vars missing on Railway (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER)' };
  }
  try {
    const form = new URLSearchParams({ From: from, To: to, Body: body });
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      }
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { ok: false, detail: `Twilio HTTP ${res.status}: ${errText.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err.message || String(err) };
  }
}

function parseIso(v) {
  if (!v || typeof v !== 'string') return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Main entry — called once per tick from scraper.js.
 *
 * Every tick:
 *  1. Ping doctor.
 *  2. Read watchdog state from scraper_status.
 *  3. On failure: increment counter. If counter >= threshold and enough time
 *     has passed since last alert and we're inside business hours, SMS.
 *  4. On success: if we'd alerted and this is the first success, SMS recovery.
 *     Always reset counter on success.
 *
 * All errors swallowed and logged — the caller is the main scraper tick and
 * must never crash because of watchdog issues.
 */
async function runVercelWatchdog({ supabase, timezone }) {
  const cronSecret = process.env.CRON_SECRET;
  const alertPhone = process.env.MANAGER_PHONE || process.env.OPS_ALERT_PHONE;

  if (!cronSecret) {
    log('CRON_SECRET not set on Railway — watchdog is a no-op. Add CRON_SECRET env var on Railway to enable.');
    return;
  }

  // Ping first so network errors are always visible in Railway logs even if
  // Supabase is unhappy.
  const result = await pingDoctor(cronSecret);

  // Load & update state. Wrapped in try/catch so Supabase blips don't silence
  // the watchdog — we can still log.
  let state = {};
  try {
    state = await getStatus(supabase, 'vercel_watchdog');
  } catch (err) {
    log(`state read failed: ${err.message} — continuing with empty state`);
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const prevCount = Number.isFinite(state.consecutiveFailures) ? state.consecutiveFailures : 0;
  const prevAlertedAt = parseIso(state.lastAlertedAt);
  const wasAlerted = state.alertActive === true;

  // ── SUCCESS path ───────────────────────────────────────────────────────
  if (result.status === 'ok') {
    log(`doctor ok (prevCount=${prevCount}${wasAlerted ? ', was alerted' : ''})`);

    const patch = {
      lastCheckAt: nowIso,
      lastStatus: 'ok',
      // Clear the stale detail string from whatever prior failure was the last
      // thing to set it. Without this, a recovered row shows
      //   lastStatus: 'ok', lastDetail: 'failing: foo_check'
      // which is contradictory and scares whoever's staring at scraper_status.
      lastDetail: null,
      consecutiveFailures: 0,
      alertActive: false,
      // Also clear the suppressed-alert markers — recovery means whatever
      // alert we couldn't send is now moot.
      alertSuppressedReason: null,
      alertSuppressedAt: null,
    };

    // Send recovery SMS only once — transitioning from alerted to ok.
    if (wasAlerted && alertPhone) {
      const smsRes = await sendTwilioSms(
        alertPhone,
        'Staxis Vercel: recovered. /api/admin/doctor is green again.'
      );
      if (!smsRes.ok) log(`recovery SMS failed: ${smsRes.detail}`);
      patch.lastRecoverySmsAt = nowIso;
      patch.lastRecoverySmsOk = smsRes.ok;
    }

    try { await mergeStatus(supabase, 'vercel_watchdog', patch); }
    catch (err) { log(`state write (ok) failed: ${err.message}`); }
    return;
  }

  // ── FAILURE path ───────────────────────────────────────────────────────
  const newCount = prevCount + 1;
  log(`doctor ${result.status}: ${result.detail} (consecutive=${newCount})`);

  const patch = {
    lastCheckAt: nowIso,
    lastStatus: result.status,
    lastDetail: result.detail,
    consecutiveFailures: newCount,
  };

  // Short-circuit: auth_mismatch means Vercel env var ≠ Railway env var for
  // CRON_SECRET. That's a configuration bug that won't self-heal — escalate
  // on the FIRST occurrence, bypassing the 3-failure threshold.
  const shouldAlert = result.status === 'auth_mismatch' || newCount >= FAILURE_THRESHOLD;

  if (!shouldAlert) {
    try { await mergeStatus(supabase, 'vercel_watchdog', patch); }
    catch (err) { log(`state write (fail) failed: ${err.message}`); }
    return;
  }

  // Debounce & business-hours gate.
  //
  // Clock-skew safety: prevAlertedAt comes from Postgres `now()` (server
  // time), but `now` on this side is Railway's local clock. If Railway's
  // clock drifts AHEAD of the database, hoursSinceAlert can be negative
  // and the `< REALERT_INTERVAL_MS` check trivially passes — we'd alert
  // every tick instead of every 6 hours, hammering Twilio. Floor at 0
  // before the comparison so any negative skew degrades to "alert now"
  // (correct on first alert, debounced on subsequent ones once Postgres
  // catches up).
  const rawSinceAlert = prevAlertedAt
    ? (now.getTime() - prevAlertedAt.getTime())
    : Infinity;
  const hoursSinceAlert = rawSinceAlert < 0 ? 0 : rawSinceAlert;
  const hour = localHour(timezone);
  const insideWindow = hour >= ALERT_WINDOW_START && hour < ALERT_WINDOW_END;

  if (wasAlerted && hoursSinceAlert < REALERT_INTERVAL_MS) {
    // Already alerted about this recently — stay quiet.
    patch.alertActive = true;
    try { await mergeStatus(supabase, 'vercel_watchdog', patch); }
    catch (err) { log(`state write (debounce) failed: ${err.message}`); }
    return;
  }

  if (!insideWindow) {
    // Track that we'd have alerted, but don't send. Next in-window check
    // will pick this up.
    patch.alertActive = true;
    patch.pendingAlertSinceCount = newCount;
    try { await mergeStatus(supabase, 'vercel_watchdog', patch); }
    catch (err) { log(`state write (offhours) failed: ${err.message}`); }
    log(`alert suppressed (outside business hours ${ALERT_WINDOW_START}:00–${ALERT_WINDOW_END}:00)`);
    return;
  }

  // Send alert.
  if (!alertPhone) {
    // CRITICAL: alert phone missing on Railway means every "alert" is silent.
    // This is exactly the failure mode the alerting system exists to catch.
    // Write a typed marker so /api/admin/doctor can see this from Vercel
    // (Vercel can't read Railway's process.env, but it CAN read shared
    // Postgres) and surface it as a hard failure on the dashboard.
    // See doctor's `watchdog_alert_path` check.
    log(`ALERT would have fired but MANAGER_PHONE/OPS_ALERT_PHONE is not set: ${result.detail}`);
    patch.alertActive = true;
    patch.alertSuppressedReason = 'no_alert_phone_on_railway';
    patch.alertSuppressedAt = nowIso;
    try { await mergeStatus(supabase, 'vercel_watchdog', patch); }
    catch (err) { log(`state write (no-phone) failed: ${err.message}`); }
    return;
  }

  const body = result.status === 'auth_mismatch'
    ? `Staxis Vercel watchdog: CRON_SECRET mismatch between Railway and Vercel. Update one to match the other, then redeploy.`
    : result.status === 'red'
    ? `Staxis Vercel watchdog: doctor RED (${result.detail}). Hit /api/admin/doctor for the fix message.`
    : `Staxis Vercel watchdog: Vercel unreachable from Railway for ${newCount * 5}+ min. ${result.detail}`;

  const smsRes = await sendTwilioSms(alertPhone, body);
  patch.alertActive = true;
  patch.lastAlertedBody = body;
  patch.lastAlertSmsOk = smsRes.ok;
  // Only stamp lastAlertedAt if the SMS actually went out. Previously we
  // wrote the timestamp unconditionally, which meant a Twilio outage at
  // the moment of alert would burn the entire 6-hour debounce window:
  // the next 71 ticks all see "we alerted recently" and stay silent,
  // even though no human ever got the SMS. By only persisting the
  // timestamp on success, a failed send re-attempts on the next tick
  // (every 5 min) until it lands.
  if (smsRes.ok) {
    patch.lastAlertedAt = nowIso;
    // Clear the no-phone marker if it was set on a previous tick — the
    // operator just fixed the env var.
    patch.alertSuppressedReason = null;
    patch.alertSuppressedAt = null;
    log(`ALERT sent: ${body}`);
  } else {
    log(`ALERT SMS FAILED: ${smsRes.detail}. Will retry on next tick. Body: ${body}`);
  }

  try { await mergeStatus(supabase, 'vercel_watchdog', patch); }
  catch (err) { log(`state write (alert) failed: ${err.message}`); }
}

module.exports = { runVercelWatchdog };
