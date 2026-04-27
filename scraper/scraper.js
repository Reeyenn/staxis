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
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { runCSVScrape } = require('./csv-scraper');
const { pullDashboardNumbers, ScraperError, ERROR_CODES } = require('./dashboard-pull');
const { pullOOOWorkOrders } = require('./ooo-pull');
const { runVercelWatchdog } = require('./vercel-watchdog');
const {
  safeEval,
  settlePage,
  isExecutionContextDestroyed,
} = require('./page-helpers');
const {
  createSupabase,
  verifySupabaseAuth,
  mergeStatus,
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
    });
  } catch (err) {
    log(`Heartbeat write failed: ${err.message}`);
  }
}

async function writeScrapeStatus(pullType, status, extra = {}) {
  try {
    await mergeStatus(supabase, pullType, {
      at:     new Date().toISOString(),
      status, // 'success' | 'error'
      ...extra,
    });
  } catch (err) {
    log(`Status write (${pullType}) failed: ${err.message}`);
  }
}

// ─── Login ─────────────────────────────────────────────────────────────────

async function login(page) {
  log('Logging into Choice Advantage...');
  try {
    // 'load' (not 'domcontentloaded') so we wait for window.onload and any
    // initial-paint scripts. CA does JS-based redirects after DOMContentLoaded
    // (Login.init → Welcome.init → user_authenticated.jsp), so returning early
    // and immediately calling page.evaluate dies with "Execution context was
    // destroyed". Outage on 2026-04-27 — see scraper/page-helpers.js header.
    await page.goto(CONFIG.CA_LOGIN_URL, { waitUntil: 'load', timeout: 30000 });
  } catch (err) {
    throw new ScraperError(ERROR_CODES.CA_UNREACHABLE, `Login page unreachable: ${err.message}`);
  }
  // Belt-and-suspenders: if there's a chained JS redirect still in flight
  // after 'load', settlePage waits for networkidle too. Both timeouts are
  // soft — we proceed anyway, since safeEval below will retry if the page
  // is still navigating when we touch the DOM.
  await settlePage(page);
  log(`Login page URL: ${page.url()}`);

  // Detect whether we're actually at the login form via DOM — CA's login
  // URL and authenticated URLs both contain "Welcome", so URL-based
  // detection was returning early without authenticating.
  const hasLoginForm = await safeEval(page, () => {
    return !!document.querySelector('input[name="j_username"]');
  });
  if (!hasLoginForm) {
    log('Already logged in (no login form present)');
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
    // Login form fields. CA has used `j_username` / `j_password` historically,
    // but the same selector-fragility that bit us on the CSV checkbox
    // (#CSVcheckbox renamed silently) would take the entire scraper offline
    // if these names ever change — and every downstream pull (CSV, dashboard,
    // OOO) depends on this auth step. Try a list of fallbacks; first match wins.
    async function fillFirst(selectors, value, fieldName) {
      for (const sel of selectors) {
        let count = 0;
        try { count = await page.locator(sel).count(); } catch { continue; }
        if (count === 0) continue;
        try {
          await page.fill(sel, value, { timeout: 5000 });
          log(`Filled ${fieldName} (selector: ${sel})`);
          return sel;
        } catch (e) {
          log(`Fill failed for ${fieldName} on ${sel}: ${e.message}`);
        }
      }
      throw new ScraperError(
        ERROR_CODES.LOGIN_FAILED,
        `Could not fill ${fieldName} field on login form (tried ${selectors.length} selectors). CA login layout may have changed.`
      );
    }
    await fillFirst([
      'input[name="j_username"]',
      'input[name="username"]',
      'input[name="user"]',
      'input[id="username"]',
      'input[id="userId"]',
      'input[type="text"][autocomplete="username"]',
      'label:has-text("Username") >> input',
      'label:has-text("User") >> input[type="text"]',
    ], CONFIG.CA_USERNAME, 'username');
    await fillFirst([
      'input[name="j_password"]',
      'input[name="password"]',
      'input[type="password"]',
      'input[id="password"]',
      'input[type="password"][autocomplete="current-password"]',
      'label:has-text("Password") >> input',
    ], CONFIG.CA_PASSWORD, 'password');

    // Find and click the login button. Same fallback pattern.
    async function clickLoginButton() {
      const candidates = [
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
      for (const sel of candidates) {
        let count = 0;
        try { count = await page.locator(sel).count(); } catch { continue; }
        if (count === 0) continue;
        try {
          await page.click(sel, { timeout: 5000 });
          log(`Clicked login button (selector: ${sel})`);
          return sel;
        } catch (e) {
          // Try force, then JS, before moving on.
          try { await page.click(sel, { timeout: 3000, force: true }); log(`Clicked login button via force (selector: ${sel})`); return sel; } catch {}
          try {
            // Locator.evaluate() on the first match — also susceptible to
            // execution-context-destroyed if the page navigates mid-call.
            // Wrap so a transient race here doesn't kill the entire login.
            let ok = false;
            for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
              try {
                ok = await page.locator(sel).first().evaluate((el) => { if (el && typeof el.click === 'function') { el.click(); return true; } return false; });
              } catch (jsErr) {
                if (!isExecutionContextDestroyed(jsErr)) throw jsErr;
                await settlePage(page, { loadTimeout: 5000, idleTimeout: 2000 });
              }
            }
            if (ok) { log(`Clicked login button via JS (selector: ${sel})`); return sel; }
          } catch {}
          log(`Click failed on login selector ${sel}: ${e.message}`);
        }
      }
      // Last-ditch: submit the form directly.
      try {
        const submitted = await safeEval(page, () => {
          const pw = document.querySelector('input[type="password"]');
          const form = pw ? pw.closest('form') : (document.forms[0] || null);
          if (form && typeof form.submit === 'function') { form.submit(); return true; }
          return false;
        });
        if (submitted) { log('Submitted login form directly via JS'); return 'form.submit()'; }
      } catch {}
      throw new ScraperError(
        ERROR_CODES.LOGIN_FAILED,
        'Could not click login button (tried ' + candidates.length + ' selectors + form.submit()). CA login layout changed.'
      );
    }
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }).catch(() => {}),
      clickLoginButton(),
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
  // Always re-login right before — sessions die between scheduled windows.
  try {
    await relogin();
  } catch (loginErr) {
    log(`${pullType} pre-scrape login FAILED: ${loginErr.message}`);
    await writeScrapeStatus(pullType, 'error', {
      error: `login failed: ${loginErr.message}`,
      date: todayISO(),
    });
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
      error: null,
    });
    return true;
  } catch (err) {
    const msg = err.message || '';
    // Belt-and-suspenders: if CA killed the session *during* the scrape itself
    // (rare but observed), retry once with another fresh login.
    if (msg.toLowerCase().includes('session expired')) {
      log(`${pullType} scrape lost session mid-run — re-logging and retrying once...`);
      try {
        await relogin();
        const snapshot = await runCSVScrape(page, supabase, scrapeConfig, pullType, log);
        await writeScrapeStatus(pullType, 'success', {
          date: snapshot?.date || todayISO(),
          totalRooms: snapshot?.totalRooms ?? null,
          error: null,
        });
        return true;
      } catch (retryErr) {
        log(`${pullType} scrape retry FAILED: ${retryErr.message}`);
        await writeScrapeStatus(pullType, 'error', {
          error: `retry failed: ${retryErr.message}`,
          date: todayISO(),
        });
        return false;
      }
    }
    log(`${pullType} CSV pull error: ${msg}`);
    await writeScrapeStatus(pullType, 'error', {
      error: msg,
      date: todayISO(),
    });
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

  const result = await runDashboardPullFresh(page, relogin);
  // Mark the timestamp whether success or failure — a failed pull is logged
  // to scraper_status and we don't want to retry every 5 min tick on a down CA.
  lastDashboardPullAt = now;
  return result;
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

  try {
    await pullOOOWorkOrders(page, supabase, config, log);
  } catch (err) {
    const code = err instanceof ScraperError ? err.code : ERROR_CODES.UNKNOWN;
    // Same narrow retry as dashboard: only re-login on session_expired.
    if (code === ERROR_CODES.SESSION_EXPIRED) {
      log(`OOO pull lost session — re-logging and retrying once...`);
      try {
        await relogin();
        await pullOOOWorkOrders(page, supabase, config, log);
      } catch (retryErr) {
        log(`OOO pull retry FAILED: [${retryErr.code || 'unknown'}] ${retryErr.message}`);
      }
    } else {
      log(`OOO pull error [${code}]: ${err.message}`);
    }
  }

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

  // Persistent context keeps cookies/session across runs
  const context = await browser.newContext({
    storageState: fs.existsSync(CONFIG.SESSION_FILE) ? CONFIG.SESSION_FILE : undefined,
  });

  const page = await context.newPage();

  await login(page);
  await context.storageState({ path: CONFIG.SESSION_FILE });

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

  // Fresh login helper. Called right before every scheduled CSV scrape to
  // guarantee the CA session cookie is valid — sessions die between the
  // morning/evening windows so we can't rely on startup login alone.
  async function relogin() {
    await login(page);
    await context.storageState({ path: CONFIG.SESSION_FILE });
  }

  async function tick() {
    try {
      // Heartbeat first so the app knows the scraper is alive even if the
      // scheduled pull didn't run this tick.
      await writeHeartbeat();
      await maybeRunCSVPull(page, relogin);
      await maybeRunDashboardPull(page, relogin);
      await maybeRunOOOPull(page, relogin);
      // Refresh session cookie so we stay logged in
      await context.storageState({ path: CONFIG.SESSION_FILE });
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
}

// ─── Entry point ───────────────────────────────────────────────────────────

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
