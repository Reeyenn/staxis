/**
 * HotelOps AI / Staxis — CSV Schedule Runner
 *
 * Runs on Railway. Stays alive and runs two things off the same tick loop:
 *
 *   1. CSV pulls (hourly, 5am–11pm) — the arrivals/departures CSV from
 *      Choice Advantage. Before 7pm the pull writes to today's snapshot
 *      (pullType='morning'); 7pm and later it writes to tomorrow's snapshot
 *      (pullType='evening') so the next-day plan starts filling in as the
 *      PMS churns through check-ins. csv-scraper upserts each pull into the
 *      same (property_id, date) row, so each hourly pull refines the plan.
 *
 *   2. Dashboard number pulls (every 15 min, 5am–11pm) — grabs in-house,
 *      arrivals, and departures counts from Choice Advantage's View pages
 *      and writes them to scraper_status[key='dashboard'] for the Schedule
 *      tab. See dashboard-pull.js.
 *
 * Removed (intentionally):
 *   • Every-15-min live PMS scrape — was noise on the Rooms tab and is
 *     no longer needed now that Maria's "Send Confirmations" is the
 *     source of truth for which rooms show up in the app.
 *   • 10pm nightly auto-scheduler — Maria builds the schedule herself at
 *     ~7:30pm using the Schedule tab, so this was running after the fact
 *     and writing to a collection nothing in the app ever read.
 *   • 9pm availability-check text blast — superseded by per-crew Send
 *     Confirmations; the underlying API endpoint was already retired.
 *
 * Property: Comfort Suites Beaumont TX (TXA32)
 * PMS: choiceADVANTAGE (SkyTouch Technology)
 * Storage: Supabase Postgres (replaces Firebase/Firestore as of 2026-04-22)
 */

require('dotenv').config();
const http = require('http');
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { runCSVScrape } = require('./csv-scraper');
const { pullDashboardNumbers } = require('./dashboard-pull');
const { pullOOOWorkOrders } = require('./ooo-pull');
const { pullHkCenter } = require('./hk-center-pull');
const { ScraperError, ERROR_CODES } = require('./scraper-errors');
const { runVercelWatchdog } = require('./vercel-watchdog');
const { safeEval, goWithSettle } = require('./page-helpers');
const { clickFirstMatching, fillFirstMatching } = require('./selector-helpers');
const {
  createSupabase,
  verifySupabaseAuth,
  mergeStatus,
  getStatus,
  writePullMetric,
  loadScraperSession,
  saveScraperSession,
} = require('./supabase-helpers');

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  // Choice Advantage
  CA_LOGIN_URL: 'https://www.choiceadvantage.com/choicehotels/Welcome.init',
  CA_USERNAME:  process.env.CA_USERNAME,
  CA_PASSWORD:  process.env.CA_PASSWORD,

  // Supabase — accept either naming convention (see supabase-helpers.js)
  SUPABASE_URL:              process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,

  // HotelOps / Staxis
  // Single property per scraper deploy. PROPERTY_ID is the uuid of the
  // properties row this scraper belongs to.
  PROPERTY_ID: process.env.HOTELOPS_PROPERTY_ID,

  // Timezone — Railway runs UTC; set to hotel's local timezone so date
  // bucketing and the 6am/7pm triggers fire at the right local time.
  TIMEZONE: process.env.TIMEZONE || 'America/Chicago',

  // How often we wake up to check "is it 6am or 7pm yet?" — 5 min is
  // frequent enough to never miss an hour boundary but light on Railway.
  TICK_MINUTES: parseInt(process.env.TICK_MINUTES || '5'),

  // Session state file (persists login cookies between runs)
  SESSION_FILE: path.join(__dirname, '.session.json'),
};

// ─── Supabase init ─────────────────────────────────────────────────────────
// createSupabase throws at module load if SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
// are missing. That's intentional — the scraper has nowhere to write without
// them, so crash-loop + scraper-health SMS alert is the right failure mode.

const supabase = (() => {
  try {
    return createSupabase();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] FATAL: ${err.message}`);
    process.exit(1);
  }
})();

// ─── Helpers ───────────────────────────────────────────────────────────────

function todayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.TIMEZONE }).format(new Date());
}

function localHour() {
  return parseInt(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: CONFIG.TIMEZONE }).format(new Date()),
    10
  );
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ─── Status reporting ──────────────────────────────────────────────────────
// Scraper writes to scraper_status so the app can warn users when the scraper
// is down or a scrape has failed. Keys:
//   scraper_status[key='heartbeat']  — bumped every tick (proves the loop is alive)
//   scraper_status[key='morning']    — last morning scrape result (success or error)
//   scraper_status[key='evening']    — last evening scrape result (success or error)
// All writes are best-effort (try/catch) — status reporting must never crash
// the main loop.

/**
 * First 8 hex chars of sha256(CRON_SECRET). Used as a cross-platform identity
 * fingerprint — Railway writes it to scraper_status[heartbeat], Vercel's
 * /api/admin/doctor compares it to Vercel's own hash. Mismatch = the secrets
 * drifted between platforms (rotation only updated one side), and every
 * cron-secret-protected call between Railway and Vercel will silently 401.
 *
 * 8 hex chars = 32 bits of entropy = effectively zero collision risk for
 * "is the same shared secret on both sides", while leaking nothing about the
 * actual value if scraper_status ever gets exposed.
 */
function cronSecretFingerprint() {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return null;
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 8);
}

async function writeHeartbeat() {
  try {
    await mergeStatus(supabase, 'heartbeat', {
      at:              new Date().toISOString(),
      localHour:       localHour(),
      today:           todayISO(),
      // Version string so future-me can tell "is this an old scraper deploy
      // still running somehow?" at a glance without digging into Railway.
      scraperVersion:  'supabase-v1',
      timezone:        CONFIG.TIMEZONE,
      tickMinutes:     CONFIG.TICK_MINUTES,
      cronSecretFingerprint: cronSecretFingerprint(),
    });
  } catch (err) {
    log(`Heartbeat write failed: ${err.message}`);
  }
}

async function writeScrapeStatus(pullType, status, extra = {}) {
  try {
    // Track consecutive failures so the cron can alert on the SECOND miss
    // (10 min) instead of waiting for the 'pull is too stale' threshold to
    // trip — the latter took 27+ ticks to surface today's outage. Read
    // the current count, increment-or-reset, then merge.
    const prev = await getStatus(supabase, pullType).catch(() => ({}));
    const prevCount = (prev && typeof prev.consecutiveFailures === 'number')
      ? prev.consecutiveFailures
      : 0;
    const nextCount = status === 'error' ? prevCount + 1 : 0;
    await mergeStatus(supabase, pullType, {
      at:     new Date().toISOString(),
      status, // 'success' | 'error'
      consecutiveFailures: nextCount,
      ...extra,
    });
  } catch (err) {
    log(`Status write (${pullType}) failed: ${err.message}`);
  }
}

// ─── Login ─────────────────────────────────────────────────────────────────

async function login(page) {
  log('Logging into Choice Advantage...');

  // Always clear cookies before login. CA's session-cookie state can land us
  // in a "partial session" that's valid for Welcome.init (the page returns
  // 'no login form present' so login() bails as 'already logged in') but
  // expired for the View*.init dashboard URLs and ReportViewStart.init —
  // produces an infinite session_expired loop where every dashboard / CSV
  // pull bounces to Login.do, triggers re-login, re-login sees the partial
  // session and skips the form, dashboard pull bounces again, etc. Clearing
  // cookies guarantees we always render the login form on first hit.
  // Observed on 2026-04-27.
  try {
    await page.context().clearCookies();
  } catch (err) {
    log(`Could not clear cookies (continuing anyway): ${err.message}`);
  }

  try {
    // goWithSettle = page.goto + load + networkidle. The single correct way
    // to navigate CA in this scraper. See scraper/page-helpers.js header.
    await goWithSettle(page, CONFIG.CA_LOGIN_URL);
  } catch (err) {
    throw new ScraperError(ERROR_CODES.CA_UNREACHABLE, `Login page unreachable: ${err.message}`);
  }
  log(`Login page URL: ${page.url()}`);

  // Detect whether we're actually at the login form via DOM — CA's login
  // URL and authenticated URLs both contain "Welcome", so URL-based
  // detection was returning early without authenticating.
  const hasLoginForm = await safeEval(page, () => {
    return !!document.querySelector('input[name="j_username"]');
  });
  if (!hasLoginForm) {
    // After a clearCookies + goto the login form should always render.
    // If it doesn't, we're either on a different unexpected page (CA URL
    // change?) or CA recovered our session from elsewhere. Log and continue
    // — the downstream pulls will bounce back through here on session_expired
    // if this assumption is wrong.
    log('No login form present after fresh navigation — assuming already authenticated by another mechanism');
    return;
  }

  // Guard against missing credentials — if the env var is empty, the fill
  // below would submit blank fields and we'd misclassify the resulting
  // rejection as a password-change. Be explicit.
  if (!CONFIG.CA_USERNAME || !CONFIG.CA_PASSWORD) {
    throw new ScraperError(
      ERROR_CODES.LOGIN_FAILED,
      'Missing CA_USERNAME / CA_PASSWORD env vars'
    );
  }

  try {
    // Username + password fields. CA has used `j_username` / `j_password`
    // historically, but downstream pulls all depend on this step — list
    // fallbacks for resilience and let fillFirstMatching escalate.
    try {
      await fillFirstMatching(page, [
        'input[name="j_username"]',
        'input[name="username"]',
        'input[name="user"]',
        'input[id="username"]',
        'input[id="userId"]',
        'input[type="text"][autocomplete="username"]',
        'label:has-text("Username") >> input',
        'label:has-text("User") >> input[type="text"]',
      ], CONFIG.CA_USERNAME, 'username', log, { required: true });
    } catch (err) {
      throw new ScraperError(ERROR_CODES.LOGIN_FAILED, err.message);
    }
    try {
      await fillFirstMatching(page, [
        'input[name="j_password"]',
        'input[name="password"]',
        'input[type="password"]',
        'input[id="password"]',
        'input[type="password"][autocomplete="current-password"]',
        'label:has-text("Password") >> input',
      ], CONFIG.CA_PASSWORD, 'password', log, { required: true });
    } catch (err) {
      throw new ScraperError(ERROR_CODES.LOGIN_FAILED, err.message);
    }

    // Find and click the login button. clickFirstMatching escalates click
    // through plain → force → JS-direct, same pattern as before but shared
    // with csv-scraper. On total miss, falls back to form.submit() via JS.
    const LOGIN_BUTTON_SELECTORS = [
      'a#greenButton',           // legacy id
      'a.greenButton',
      '#greenButton',
      'button[type="submit"]:visible',
      'input[type="submit"]:visible',
      'button:has-text("Login"):visible',
      'button:has-text("Log in"):visible',
      'button:has-text("Sign in"):visible',
      'a:has-text("Login"):visible',
      'a:has-text("Log in"):visible',
      'a:has-text("Sign in"):visible',
      'a:has-text("Submit"):visible',
    ];
    const clickAndNavigate = async () => {
      try {
        await clickFirstMatching(page, LOGIN_BUTTON_SELECTORS, 'login button', log);
      } catch (clickErr) {
        // Last-ditch: submit the form directly.
        const submitted = await safeEval(page, () => {
          const pw = document.querySelector('input[type="password"]');
          const form = pw ? pw.closest('form') : (document.forms[0] || null);
          if (form && typeof form.submit === 'function') { form.submit(); return true; }
          return false;
        }).catch(() => false);
        if (submitted) {
          log('Submitted login form directly via JS');
          return;
        }
        throw new ScraperError(ERROR_CODES.LOGIN_FAILED, clickErr.message);
      }
    };
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }).catch(() => {}),
      clickAndNavigate(),
    ]);
    log(`After login click — now at: ${page.url()}`);

    if (page.url().includes('j_security_check')) {
      try {
        await page.waitForURL(url => !url.toString().includes('j_security_check'), { timeout: 15000 });
        log(`Redirected away from j_security_check — now at: ${page.url()}`);
      } catch (e) {
        log('Still on j_security_check after 15s — login may have failed or credentials are wrong');
      }
    }

    // Wait for the post-login page to fully settle (load + networkidle) before
    // we touch the DOM. This is the same pattern as settlePage but with longer
    // timeouts because post-login redirects can take longer than the initial
    // page load.
    await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    log(`After settle — now at: ${page.url()}`);

    // ── CA migration consent screen (added 2026-04-27) ────────────────────
    // CA started gating post-login navigation behind a SkyTouch / Salesforce
    // migration notice. The post-login page lands on /Login.do with three
    // visible links: Logout, "training bulletin" (skytouch.salesforce.com),
    // and a "Continue" button (id=migrationSubmit). Without clicking
    // Continue, every downstream View*.init / ReportViewStart.init bounces
    // back to /Login.do as session_expired. Detect via the presence of
    // #migrationSubmit and click it. Do NOT throw if it's missing — pre-
    // migration users won't see this screen and we still want login() to
    // succeed for them.
    try {
      const migrationBtn = page.locator('#migrationSubmit').first();
      const hasMigration = await migrationBtn.count();
      if (hasMigration > 0) {
        log('CA migration consent screen detected — clicking #migrationSubmit (Continue)');
        let clicked = false;
        try { await migrationBtn.click({ timeout: 5000 }); clicked = true; } catch {}
        if (!clicked) {
          try { await migrationBtn.click({ timeout: 3000, force: true }); clicked = true; } catch {}
        }
        if (!clicked) {
          // JS-direct click as last resort. Same pattern as the login button
          // fallback — works when overlays are intercepting pointer events.
          try {
            await migrationBtn.evaluate((el) => { if (el && typeof el.click === 'function') el.click(); });
            clicked = true;
          } catch {}
        }
        if (clicked) {
          // Migration dismiss triggers a navigation back to the actual
          // dashboard. Wait for it to settle.
          await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
          await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
          log(`After migration dismiss — now at: ${page.url()}`);
        } else {
          log('Failed to click #migrationSubmit after multiple attempts — downstream pulls will likely fail until CA migration UX changes');
        }
      }
    } catch (err) {
      log(`Migration consent check non-fatal error: ${err.message}`);
    }

    // VERIFY login actually worked. If the login form is still present on the
    // page after a submit, CA rejected our credentials — password was changed
    // or the account was locked. This used to be a silent failure: the scraper
    // would loop forever hitting "session expired" because every View page
    // bounced back to the login form. Now it surfaces as a typed error the
    // health-check cron can alert on with "CA password changed".
    const stillOnLoginForm = await safeEval(page, () =>
      !!document.querySelector('input[name="j_username"]')
    );
    if (stillOnLoginForm) {
      // Grab the error message CA displays so we can distinguish "wrong
      // password" from "account locked" from "too many attempts" later.
      const caMessage = await safeEval(page, () => {
        const el = document.querySelector('.CHI_Error, .error, [class*="rror"]');
        return el ? el.textContent.trim().slice(0, 200) : null;
      }).catch(() => null);
      throw new ScraperError(
        ERROR_CODES.LOGIN_FAILED,
        `Credentials rejected at ${page.url()}${caMessage ? ` — CA said: "${caMessage}"` : ''}`,
        { diagnostics: { caMessage, url: page.url() } }
      );
    }
  } catch (err) {
    if (err instanceof ScraperError) throw err;
    log(`Login error: ${err.message}`);
    throw new ScraperError(ERROR_CODES.UNKNOWN, `Login threw: ${err.message}`);
  }
}

// ─── CSV pull scheduler ────────────────────────────────────────────────────
// Runs hourly during the active window (5am–11pm local). `lastCSVPullAt` is
// only bumped on success so a failed pull is retried on the next tick.
let lastCSVPullAt = 0;
const CSV_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Run a scheduled CSV scrape. Always re-logs in *right before* the scrape so
 * the session cookie is guaranteed fresh — CA expires sessions after a few
 * hours of idle, and the runner goes idle between scheduled windows. A single
 * login at startup isn't good enough.
 *
 * If the re-login itself fails or the scrape still fails, we return false so
 * the caller leaves `lastCSVPullAt` unchanged and the next tick retries.
 */
async function runCSVScrapeFresh(page, pullType, relogin) {
  // Latency tracking — best-effort emit to pull_metrics so we can see
  // 'pulls take 45s instead of 15s' before it becomes a reliability issue.
  const t0 = Date.now();
  let loginMs = null;

  // Always re-login right before — sessions die between scheduled windows.
  try {
    const tLogin = Date.now();
    await relogin();
    loginMs = Date.now() - tLogin;
  } catch (loginErr) {
    log(`${pullType} pre-scrape login FAILED: ${loginErr.message}`);
    const code = loginErr instanceof ScraperError ? loginErr.code : ERROR_CODES.LOGIN_FAILED;
    await writeScrapeStatus(pullType, 'error', {
      errorCode: code,
      error: `login failed: ${loginErr.message}`,
      date: todayISO(),
    });
    await writePullMetric(supabase, {
      property_id: CONFIG.PROPERTY_ID,
      pull_type: pullType === 'morning' ? 'csv_morning' : 'csv_evening',
      ok: false,
      error_code: code,
      total_ms: Date.now() - t0,
      login_ms: null,
    }, log);
    return false;
  }

  const scrapeConfig = {
    PROPERTY_ID: CONFIG.PROPERTY_ID,
    TIMEZONE:    CONFIG.TIMEZONE,
  };

  try {
    const snapshot = await runCSVScrape(page, supabase, scrapeConfig, pullType, log);
    await writeScrapeStatus(pullType, 'success', {
      date: snapshot?.date || todayISO(),
      totalRooms: snapshot?.totalRooms ?? null,
      checkouts: snapshot?.checkouts ?? null,
      stayovers: snapshot?.stayovers ?? null,
      recommendedHKs: snapshot?.recommendedHKs ?? null,
      errorCode: null,
      error: null,
    });
    await writePullMetric(supabase, {
      property_id: CONFIG.PROPERTY_ID,
      pull_type: pullType === 'morning' ? 'csv_morning' : 'csv_evening',
      ok: true,
      error_code: null,
      total_ms: Date.now() - t0,
      login_ms: loginMs,
      rows: snapshot?.totalRooms ?? null,
    }, log);
    return true;
  } catch (err) {
    // Read the typed code if available (csv-scraper now throws ScraperError
    // with codes from scraper-errors.js). Fall back to UNKNOWN for any raw
    // Error that escapes from a code path that hasn't been migrated yet.
    const code = err instanceof ScraperError ? err.code : ERROR_CODES.UNKNOWN;
    // Belt-and-suspenders: if CA killed the session *during* the scrape itself
    // (rare but observed), retry once with another fresh login. Match on the
    // typed code now, with the substring fallback for raw errors.
    const isSessionExpired = code === ERROR_CODES.SESSION_EXPIRED
      || (err.message || '').toLowerCase().includes('session expired');
    if (isSessionExpired) {
      log(`${pullType} scrape lost session mid-run — re-logging and retrying once...`);
      try {
        await relogin();
        const snapshot = await runCSVScrape(page, supabase, scrapeConfig, pullType, log);
        await writeScrapeStatus(pullType, 'success', {
          date: snapshot?.date || todayISO(),
          totalRooms: snapshot?.totalRooms ?? null,
          errorCode: null,
          error: null,
        });
        return true;
      } catch (retryErr) {
        const retryCode = retryErr instanceof ScraperError ? retryErr.code : ERROR_CODES.UNKNOWN;
        log(`${pullType} scrape retry FAILED [${retryCode}]: ${retryErr.message}`);
        await writeScrapeStatus(pullType, 'error', {
          errorCode: retryCode,
          error: `retry failed: ${retryErr.message}`,
          date: todayISO(),
        });
        return false;
      }
    }
    log(`${pullType} CSV pull error [${code}]: ${err.message}`);
    await writeScrapeStatus(pullType, 'error', {
      errorCode: code,
      error: err.message,
      date: todayISO(),
    });
    await writePullMetric(supabase, {
      property_id: CONFIG.PROPERTY_ID,
      pull_type: pullType === 'morning' ? 'csv_morning' : 'csv_evening',
      ok: false,
      error_code: code,
      total_ms: Date.now() - t0,
      login_ms: loginMs,
    }, log);
    return false;
  }
}

// ─── Dashboard number pull scheduler ───────────────────────────────────────
// Every 15 min between 5am and 11pm local, grab in-house/arrivals/departures
// counts off Choice Advantage's View pages and write them to
// scraper_status[key='dashboard'] for the Schedule tab to display live.
//
// Uses the same logged-in page as the CSV pull. On session expiry, calls
// relogin() and retries once (mirrors the CSV pull's retry pattern).
let lastDashboardPullAt = 0;
const DASHBOARD_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Run the dashboard pull with one layer of retry for recoverable failures.
 *
 * Retry policy is deliberately narrow:
 *   • session_expired → re-login, try once more. Sessions legitimately expire
 *     between the 15-min tick windows and re-login is the correct response.
 *   • login_failed    → re-login would just fail the same way. Don't retry.
 *   • everything else → one-shot. Retrying a selector_miss or validation
 *     failure gives us the same wrong answer 2x, masked as "flaky".
 *
 * The inner pullDashboardNumbers already wrote the error state on the first
 * throw, so we don't need to re-write it here — we just need to decide
 * whether a retry makes sense.
 */
async function runDashboardPullFresh(page, relogin) {
  try {
    return await pullDashboardNumbers(page, supabase, log);
  } catch (err) {
    const code = err instanceof ScraperError ? err.code : ERROR_CODES.UNKNOWN;

    if (code === ERROR_CODES.SESSION_EXPIRED) {
      log(`Dashboard pull lost session — re-logging and retrying once...`);
      try {
        await relogin();
      } catch (loginErr) {
        // Re-login itself failed (likely login_failed). Leave the original
        // session_expired error in scraper_status — but surface the login
        // failure too, because that's the real underlying problem now.
        log(`Re-login FAILED after session expiry: ${loginErr.message}`);
        await mergeStatus(supabase, 'dashboard', {
          errorCode:    loginErr instanceof ScraperError ? loginErr.code : ERROR_CODES.UNKNOWN,
          errorMessage: `Re-login failed after session expiry: ${loginErr.message}`.slice(0, 500),
          erroredAt:    new Date().toISOString(),
        }).catch(() => {});
        return null;
      }

      // Retry the pull — if this one fails, its error state overwrites the
      // first and we don't retry again. (Don't want infinite loops on a
      // persistently sad CA.)
      try {
        return await pullDashboardNumbers(page, supabase, log);
      } catch (retryErr) {
        log(`Dashboard pull retry FAILED: [${retryErr.code || 'unknown'}] ${retryErr.message}`);
        return null;
      }
    }

    // Non-retryable code paths. pullDashboardNumbers already wrote the error
    // to scraper_status, so we just log and return.
    log(`Dashboard pull error [${code}]: ${err.message}`);
    return null;
  }
}

async function maybeRunDashboardPull(page, relogin) {
  const hour = localHour();
  // 5am–10:59pm active window. Staff aren't looking at these numbers
  // overnight and CA is quiet then — no reason to hammer the site.
  if (hour < 5 || hour >= 23) return;

  const now = Date.now();
  if (now - lastDashboardPullAt < DASHBOARD_INTERVAL_MS) return;

  const t0 = now;
  let lastError = null;
  let pull = null;
  try {
    pull = await runDashboardPullFresh(page, relogin);
  } catch (err) {
    lastError = err;
  }
  // Best-effort latency emit — total wall time and ok flag. Per-step
  // breakdown isn't threaded in; if we want navigate_ms / parse_ms
  // separately, instrument inside pullDashboardNumbers.
  await writePullMetric(supabase, {
    property_id: CONFIG.PROPERTY_ID,
    pull_type: 'dashboard',
    ok: pull != null && lastError == null,
    error_code: lastError instanceof ScraperError ? lastError.code : (lastError ? ERROR_CODES.UNKNOWN : null),
    total_ms: Date.now() - t0,
    rows: pull && typeof pull.inHouse === 'number' ? 3 : null, // 3 fields when populated
  }, log);

  // Mark the timestamp whether success or failure — a failed pull is logged
  // to scraper_status and we don't want to retry every 5 min tick on a down CA.
  lastDashboardPullAt = now;
  return pull;
}

// ─── OOO Work Order Sync (15-min cadence, piggybacks on dashboard tick) ────
//
// Mirrors CA's room-level Out-of-Order list into our own work_orders table
// so Maria sees rooms blocked by the front desk (deep clean, AC broken,
// maintenance) alongside housekeeper-submitted tickets.
//
// Isolated from the dashboard pull in its own try/catch so a CA OOO outage
// (or a Supabase write blip) can never take the dashboard numbers down.
// Same cadence (15 min) — which means its own timestamp tracker so a
// failure on one pull doesn't cost us a dashboard pull or vice versa.
let lastOOOPullAt = 0;
const OOO_INTERVAL_MS = 15 * 60 * 1000;

async function maybeRunOOOPull(page, relogin) {
  const hour = localHour();
  if (hour < 5 || hour >= 23) return;

  const now = Date.now();
  if (now - lastOOOPullAt < OOO_INTERVAL_MS) return;

  const config = {
    PROPERTY_ID: CONFIG.PROPERTY_ID,
  };

  const t0 = now;
  let metricCode = null;
  let metricOk = true;

  try {
    await pullOOOWorkOrders(page, supabase, config, log);
  } catch (err) {
    metricOk = false;
    const code = err instanceof ScraperError ? err.code : ERROR_CODES.UNKNOWN;
    metricCode = code;
    // Same narrow retry as dashboard: only re-login on session_expired.
    if (code === ERROR_CODES.SESSION_EXPIRED) {
      log(`OOO pull lost session — re-logging and retrying once...`);
      try {
        await relogin();
        await pullOOOWorkOrders(page, supabase, config, log);
        metricOk = true;
        metricCode = null;
      } catch (retryErr) {
        log(`OOO pull retry FAILED: [${retryErr.code || 'unknown'}] ${retryErr.message}`);
        metricCode = retryErr instanceof ScraperError ? retryErr.code : ERROR_CODES.UNKNOWN;
      }
    } else {
      log(`OOO pull error [${code}]: ${err.message}`);
    }
  }

  await writePullMetric(supabase, {
    property_id: CONFIG.PROPERTY_ID,
    pull_type: 'ooo',
    ok: metricOk,
    error_code: metricCode,
    total_ms: Date.now() - t0,
  }, log);

  lastOOOPullAt = now;
}

async function maybeRunCSVPull(page, relogin) {
  const hour = localHour();
  // 5am–10:59pm active window. Same as dashboard pulls — staff aren't
  // looking at the data overnight and CA is quiet then.
  if (hour < 5 || hour >= 23) return;

  const now = Date.now();
  if (now - lastCSVPullAt < CSV_INTERVAL_MS) return;

  // Before 7pm → 'morning' (writes to today's plan_snapshot).
  // 7pm and later → 'evening' (writes to tomorrow's plan_snapshot so the next
  // day's plan starts filling in as the PMS churns through check-ins).
  const pullType = hour < 19 ? 'morning' : 'evening';

  const ok = await runCSVScrapeFresh(page, pullType, relogin);
  // Only bump the timestamp on success — a failed pull should retry next tick.
  if (ok) lastCSVPullAt = now;
}

// ─── Main loop ─────────────────────────────────────────────────────────────

async function run() {
  log('=== HotelOps AI / Staxis CSV Runner starting ===');
  log(`Property: ${CONFIG.PROPERTY_ID}`);
  log(`Timezone: ${CONFIG.TIMEZONE} | Local hour: ${localHour()} | Today: ${todayISO()}`);
  log(`Tick every ${CONFIG.TICK_MINUTES} min — CSV pulls hourly 5am–11pm, dashboard numbers + OOO work orders every 15 min 5am–11pm`);

  // ─── Required env var preflight ─────────────────────────────────────────
  // If HOTELOPS_PROPERTY_ID is missing on Railway, every write ends up with
  // property_id=undefined and Maria's dashboard silently shows zero rooms
  // with no error. Fail LOUD here so Railway crash-loops and scraper-health
  // SMS fires within 15 min instead of quietly writing garbage all night.
  // CA_USERNAME / CA_PASSWORD check the same class of silent-drift bug.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const preflightFailures = [];
  if (!CONFIG.PROPERTY_ID) {
    preflightFailures.push('HOTELOPS_PROPERTY_ID is not set');
  } else if (!UUID_RE.test(CONFIG.PROPERTY_ID)) {
    preflightFailures.push(`HOTELOPS_PROPERTY_ID is not a valid UUID (got "${CONFIG.PROPERTY_ID}")`);
  }
  if (!CONFIG.CA_USERNAME) preflightFailures.push('CA_USERNAME is not set');
  if (!CONFIG.CA_PASSWORD) preflightFailures.push('CA_PASSWORD is not set');
  if (preflightFailures.length > 0) {
    console.error(`[${new Date().toISOString()}] FATAL: missing/invalid required env vars:`);
    for (const f of preflightFailures) console.error(`  • ${f}`);
    console.error('Fix: set these in Railway → Variables → Redeploy. See RUNBOOKS.md § "Railway env var drift".');
    process.exit(1);
  }

  // Verify Supabase credentials BEFORE launching Playwright. If creds are
  // stale/revoked, crash loud now instead of writing garbage for hours.
  await verifySupabaseAuth(supabase, log);

  const browser = await chromium.launch({
    headless: process.env.HEADED !== 'true',
    args: ['--no-sandbox', '--disable-setuid-sandbox'], // needed on Railway/Linux
  });

  // Persistent session: prefer Supabase-backed scraper_session row so a Railway
  // redeploy doesn't lose the CA login. Fall back to the on-disk session file
  // (which only survives within a single container's lifetime) if Supabase is
  // unreachable on boot. Either way, login() will refresh on a stale session.
  const persistedState = await loadScraperSession(supabase, CONFIG.PROPERTY_ID, log);
  const contextOptions = persistedState
    ? { storageState: persistedState }
    : (fs.existsSync(CONFIG.SESSION_FILE)
        ? { storageState: CONFIG.SESSION_FILE }
        : {});
  const context = await browser.newContext(contextOptions);

  const page = await context.newPage();

  await login(page);
  // Write to BOTH places: file-on-disk (legacy, useful for local dev) AND
  // Supabase (survives Railway redeploys). Writes are tolerant of failure.
  await context.storageState({ path: CONFIG.SESSION_FILE });
  const stateBlob = await context.storageState();
  await saveScraperSession(supabase, CONFIG.PROPERTY_ID, stateBlob, log);

  // Optional: on startup, pull today's CSV immediately — useful for smoke tests.
  if (process.env.CSV_TEST_ON_STARTUP === 'true') {
    log('CSV_TEST_ON_STARTUP enabled — running immediate CSV scrape...');
    try {
      await runCSVScrape(page, supabase, {
        PROPERTY_ID: CONFIG.PROPERTY_ID,
        TIMEZONE:    CONFIG.TIMEZONE,
      }, 'morning', log);
      log('CSV test scrape complete!');
    } catch (err) {
      log(`CSV test scrape FAILED: ${err.message}`);
    }
  }

  // ── CA login circuit breaker ────────────────────────────────────────────
  // If we ever hit a sustained run of login failures (CA blocked our IP,
  // password rotated, account locked), naive every-5-min retries become
  // abusive — both to CA's auth endpoint and to our own log volume. After
  // 3 consecutive failures, the breaker opens and we sleep 30 min between
  // attempts until either a login succeeds or a human resets it via the
  // Railway env var BREAKER_RESET=true.
  //
  // State is in-process only. Railway redeploys reset it to closed, which
  // is fine — a redeploy is a human signal that something changed and a
  // fresh attempt is warranted.
  const LOGIN_BREAKER = {
    consecutiveFailures: 0,
    openSinceMs:         null,        // ms timestamp when breaker tripped
    OPEN_AFTER_FAILURES: 3,
    OPEN_DURATION_MS:    30 * 60 * 1000,
  };

  // Fresh login helper. Called right before every scheduled CSV scrape to
  // guarantee the CA session cookie is valid — sessions die between the
  // morning/evening windows so we can't rely on startup login alone.
  async function relogin() {
    // Breaker check — if open and the cooldown isn't done, refuse the call
    // so the caller writes a typed error and the cron escalates.
    if (LOGIN_BREAKER.openSinceMs != null) {
      const sinceMs = Date.now() - LOGIN_BREAKER.openSinceMs;
      if (sinceMs < LOGIN_BREAKER.OPEN_DURATION_MS) {
        const remainingMin = Math.ceil((LOGIN_BREAKER.OPEN_DURATION_MS - sinceMs) / 60_000);
        throw new ScraperError(
          ERROR_CODES.LOGIN_FAILED,
          `Login circuit breaker open after ${LOGIN_BREAKER.consecutiveFailures} consecutive failures. Cooling down for another ${remainingMin}m before retry.`,
        );
      }
      // Cooldown elapsed — half-open: try one login. If it fails, breaker
      // re-opens. If it succeeds, fully close.
      log(`Login breaker cooldown elapsed; attempting half-open login...`);
      LOGIN_BREAKER.openSinceMs = null;
    }
    try {
      await login(page);
      // Success — reset the counter and persist the fresh session to
      // both file and Supabase so a redeploy can resume.
      LOGIN_BREAKER.consecutiveFailures = 0;
      await context.storageState({ path: CONFIG.SESSION_FILE });
      const stateBlob = await context.storageState();
      await saveScraperSession(supabase, CONFIG.PROPERTY_ID, stateBlob, log);
    } catch (err) {
      LOGIN_BREAKER.consecutiveFailures += 1;
      if (LOGIN_BREAKER.consecutiveFailures >= LOGIN_BREAKER.OPEN_AFTER_FAILURES) {
        LOGIN_BREAKER.openSinceMs = Date.now();
        log(`Login breaker OPEN after ${LOGIN_BREAKER.consecutiveFailures} consecutive failures. Suppressing login attempts for ${LOGIN_BREAKER.OPEN_DURATION_MS / 60_000}m.`);
      }
      throw err;
    }
  }

  // ── Page lock — serialize all Playwright operations on `page` ──────────
  // The tick loop runs scheduled pulls. The HTTP server (added below)
  // accepts on-demand HK Center pulls from Vercel. Both touch the same
  // Playwright page, and Playwright does not support concurrent
  // operations on a single page (you'll get "navigation interrupted" or
  // worse, partial DOM reads). This mutex makes every page-touching
  // call wait its turn — FIFO via promise chaining.
  //
  // The chain stays a single promise so memory doesn't grow with call
  // volume. Each wrapped fn() runs inside a try/catch so a failure
  // doesn't poison the chain for the next caller.
  let pageLock = Promise.resolve();
  function withPageLock(fn) {
    const next = pageLock.then(() => fn());
    pageLock = next.catch(() => {}); // ignore failures for chain purposes
    return next;
  }

  async function tick() {
    try {
      // Heartbeat first so the app knows the scraper is alive even if the
      // scheduled pull didn't run this tick. Heartbeat is a Supabase write
      // only — doesn't touch `page` — so it can run outside the lock.
      await writeHeartbeat();

      // All page-touching work goes through the lock so an in-flight
      // HTTP scrape (e.g., Mario hitting "Load Rooms from CSV") doesn't
      // race with us.
      await withPageLock(async () => {
        await maybeRunCSVPull(page, relogin);
        await maybeRunDashboardPull(page, relogin);
        await maybeRunOOOPull(page, relogin);
        // Refresh session cookie so we stay logged in. Best-effort
        // Supabase mirror so Railway redeploy doesn't force a fresh login.
        await context.storageState({ path: CONFIG.SESSION_FILE });
        const stateBlob = await context.storageState();
        await saveScraperSession(supabase, CONFIG.PROPERTY_ID, stateBlob, log);
      });
    } catch (err) {
      log(`ERROR during tick: ${err.message}`);
    }

    // Cross-platform watchdog: from Railway, ping Vercel's doctor endpoint
    // and SMS Reeyen if it's been red for ≥3 ticks (~15 min). This is the
    // OPPOSITE of GH Actions' scraper-health (which watches Railway from
    // outside) — same pattern, opposite direction. Together they cover both
    // platforms with independent alerting paths.
    //
    // Wrapped in its own try/catch so a watchdog bug NEVER takes down the
    // scraper tick. Watchdog already swallows its own errors internally;
    // this is belt-and-suspenders.
    try {
      await runVercelWatchdog({ supabase, timezone: CONFIG.TIMEZONE });
    } catch (err) {
      log(`watchdog crashed (non-fatal): ${err.message}`);
    }
  }

  // First tick immediately, then schedule recursively.
  //
  // We INTENTIONALLY do not use setInterval here. setInterval fires every
  // N ms regardless of whether the previous tick is still running. If a
  // single tick takes longer than the interval (Playwright hang, slow
  // CA login, network blip), setInterval queues a second tick that
  // executes concurrently with the first. Two ticks running at once means
  // two concurrent Playwright operations on the same browser context,
  // which is unsupported and produces non-deterministic crashes.
  //
  // Instead: run the tick to completion, then schedule the next one. If
  // the tick took more than the interval, the next tick fires immediately
  // (still serialized). Worst case is the schedule slowly drifts; that's
  // fine because each tick is idempotent.
  const tickMs = CONFIG.TICK_MINUTES * 60 * 1000;
  let tickInProgress = false;

  const scheduleTick = () => {
    if (tickInProgress) {
      // Defensive: should never happen because we only call scheduleTick
      // from the tick's own finally. But if some future code path adds a
      // second scheduler, this guard keeps us serial.
      log('scheduleTick called while a tick is already in progress; skipping');
      return;
    }
    tickInProgress = true;
    const startedAt = Date.now();
    Promise.resolve()
      .then(tick)
      .catch(err => {
        // tick() already has its own try/catch, but catch any re-thrown
        // promise rejections at this boundary so they can't kill the
        // process via unhandledRejection.
        log(`tick rejected at scheduler: ${err && err.message ? err.message : err}`);
      })
      .finally(() => {
        tickInProgress = false;
        const elapsed = Date.now() - startedAt;
        // Subtract elapsed time so a 3-min tick on a 5-min interval lands
        // 2 min later, not 5. Floor at 1s so we never hot-loop if a tick
        // ever takes longer than the interval.
        const next = Math.max(tickMs - elapsed, 1000);
        setTimeout(scheduleTick, next);
      });
  };

  await tick();
  setTimeout(scheduleTick, tickMs);

  log(`CSV runner running. Next tick in ${CONFIG.TICK_MINUTES} minutes.`);

  // ── HTTP server — on-demand HK Center pulls from Vercel ────────────────
  // Mario clicks "Load Rooms from CSV" → Vercel POSTs here → we run the
  // HK Center pull using the existing Playwright session (fast, no fresh
  // login) and return JSON. Same `page` as the tick loop, serialized
  // through `withPageLock` so we don't race.
  //
  // Auth: Bearer ${CRON_SECRET}. Same secret used by GitHub Actions cron
  // and Vercel watchdog, so credential drift surfaces in one place.
  // Without the secret set, the endpoint refuses every request — better
  // to fail closed than to leak access to anyone who finds the URL.
  //
  // Health endpoint: GET /health. Used by Railway's own probe (and useful
  // for debugging "is the server alive but the scraper stuck?"). No auth
  // required because it returns nothing sensitive.
  const HTTP_PORT = parseInt(process.env.PORT || '3000', 10);
  const httpServer = http.createServer(async (req, res) => {
    const url = req.url || '/';
    const method = req.method || 'GET';
    const requestId = Math.random().toString(36).slice(2, 8);

    // Health check — unauthenticated, returns scraper liveness.
    if (method === 'GET' && (url === '/health' || url === '/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        service: 'hotelops-scraper',
        propertyId: CONFIG.PROPERTY_ID,
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    // Everything else requires auth.
    const auth = req.headers.authorization || '';
    const expected = `Bearer ${process.env.CRON_SECRET || ''}`;
    if (!process.env.CRON_SECRET) {
      // Misconfigured. Don't allow blanket access.
      log(`[http ${requestId}] CRON_SECRET not set — refusing ${method} ${url}`);
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'CRON_SECRET not configured on Railway' }));
      return;
    }
    if (auth !== expected) {
      // Don't include the expected value in the error — that'd leak it
      // to anyone who could see the response body.
      log(`[http ${requestId}] auth mismatch for ${method} ${url}`);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }

    // POST /scrape/hk-center — pull live HK Center page state.
    if (method === 'POST' && url === '/scrape/hk-center') {
      const t0 = Date.now();
      try {
        const rooms = await withPageLock(async () => {
          try {
            return await pullHkCenter(page, log);
          } catch (err) {
            // Same recovery as runDashboardPullFresh: re-login once on
            // session expiry, retry, give up if that fails too.
            if (err.code === ERROR_CODES.SESSION_EXPIRED) {
              log(`[http ${requestId}] HK Center session expired — re-logging`);
              await relogin();
              return await pullHkCenter(page, log);
            }
            throw err;
          }
        });
        const elapsed = Date.now() - t0;
        log(`[http ${requestId}] HK Center pull OK — ${rooms.length} rooms in ${elapsed}ms`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          pulledAt: new Date().toISOString(),
          elapsedMs: elapsed,
          rooms,
        }));
        // Best-effort metric write so the doctor's pull-latency check
        // sees this pull type.
        await writePullMetric(supabase, {
          property_id: CONFIG.PROPERTY_ID,
          pull_type: 'hk_center_on_demand',
          ok: true,
          error_code: null,
          total_ms: elapsed,
          rows: rooms.length,
        }, log).catch(() => {});
      } catch (err) {
        const code = err instanceof ScraperError ? err.code : ERROR_CODES.UNKNOWN;
        const msg = err && err.message ? err.message : String(err);
        log(`[http ${requestId}] HK Center pull FAILED [${code}]: ${msg}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: msg, code }));
        await writePullMetric(supabase, {
          property_id: CONFIG.PROPERTY_ID,
          pull_type: 'hk_center_on_demand',
          ok: false,
          error_code: code,
          total_ms: Date.now() - t0,
          rows: null,
        }, log).catch(() => {});
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
  });

  httpServer.on('error', err => {
    log(`HTTP server error: ${err.message}`);
  });

  httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
    log(`HTTP server listening on 0.0.0.0:${HTTP_PORT}`);
  });
}

// ─── Entry point ───────────────────────────────────────────────────────────

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
