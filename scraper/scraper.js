/**
 * HotelOps AI — CSV Schedule Runner
 *
 * Runs on Railway. Stays alive and runs two things off the same tick loop:
 *
 *   1. CSV pulls (hourly, 5am–11pm) — the arrivals/departures CSV from
 *      Choice Advantage. Before 7pm the pull writes to today's snapshot
 *      (pullType='morning'); 7pm and later it writes to tomorrow's snapshot
 *      (pullType='evening') so the next-day plan starts filling in as the
 *      PMS churns through check-ins. csv-scraper merges new pulls on top of
 *      the existing snapshot, so each hourly pull refines the same doc.
 *
 *   2. Dashboard number pulls (every 15 min, 5am–11pm) — grabs in-house,
 *      arrivals, and departures counts from Choice Advantage's View pages
 *      and writes them to scraperStatus/dashboard for the Schedule tab.
 *      See dashboard-pull.js.
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
 */

require('dotenv').config();
const { chromium } = require('playwright');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const path = require('path');
const fs = require('fs');
const { runCSVScrape } = require('./csv-scraper');
const { pullDashboardNumbers, ScraperError, ERROR_CODES } = require('./dashboard-pull');
const { pullOOOWorkOrders } = require('./ooo-pull');
const { runVercelWatchdog } = require('./vercel-watchdog');

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  // Choice Advantage
  CA_LOGIN_URL: 'https://www.choiceadvantage.com/choicehotels/Welcome.init',
  CA_USERNAME:  process.env.CA_USERNAME,
  CA_PASSWORD:  process.env.CA_PASSWORD,

  // Firebase
  FIREBASE_PROJECT_ID:   process.env.FIREBASE_PROJECT_ID,
  FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL,
  FIREBASE_PRIVATE_KEY:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),

  // HotelOps
  USER_ID:     process.env.HOTELOPS_USER_ID,
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

// ─── Firebase init ─────────────────────────────────────────────────────────

initializeApp({
  credential: cert({
    projectId:   CONFIG.FIREBASE_PROJECT_ID,
    clientEmail: CONFIG.FIREBASE_CLIENT_EMAIL,
    privateKey:  CONFIG.FIREBASE_PRIVATE_KEY,
  }),
});

const db = getFirestore();

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
// Scraper writes to Firestore so the app can warn users when the scraper is
// down or a scrape has failed. Paths:
//   scraperStatus/heartbeat  — bumped every tick (proves the loop is alive)
//   scraperStatus/morning    — last morning scrape result (success or error)
//   scraperStatus/evening    — last evening scrape result (success or error)
// All writes are best-effort (try/catch) — status reporting must never crash
// the main loop.

async function writeHeartbeat() {
  try {
    await db.collection('scraperStatus').doc('heartbeat').set({
      at: new Date(),
      localHour: localHour(),
      today: todayISO(),
      // Version string so future-me can tell "is this an old scraper deploy
      // still running somehow?" at a glance without digging into Railway.
      scraperVersion: 'atomic-v1',
      timezone: CONFIG.TIMEZONE,
      tickMinutes: CONFIG.TICK_MINUTES,
    }, { merge: true });
  } catch (err) {
    log(`Heartbeat write failed: ${err.message}`);
  }
}

// ─── Firebase auth preflight ───────────────────────────────────────────────
// The Admin SDK's writes are wrapped in try/catch inside tick() so a
// transient Firestore outage can't crash the loop. But that also means if
// the service account key is *revoked or rotated* on us, every write
// silently fails with "16 UNAUTHENTICATED" forever while the container stays
// up — Railway keeps reporting "service online", but nothing lands in
// Firestore and the app's dashboard goes stale. We learned this the hard
// way on 2026-04-20: scraper died at 3:47 PM, we didn't notice for 8+ hours.
//
// This preflight does a cheap authenticated read at startup so that case
// crashes the process instead. Railway's crash-loop + the scraper-health
// cron's stale-heartbeat SMS alert will surface it within minutes.
async function verifyFirebaseAuth() {
  const missing = [];
  if (!CONFIG.FIREBASE_PROJECT_ID)   missing.push('FIREBASE_PROJECT_ID');
  if (!CONFIG.FIREBASE_CLIENT_EMAIL) missing.push('FIREBASE_CLIENT_EMAIL');
  if (!CONFIG.FIREBASE_PRIVATE_KEY)  missing.push('FIREBASE_PRIVATE_KEY');
  if (missing.length) {
    log(`FATAL: Missing Firebase env vars on Railway: ${missing.join(', ')}`);
    process.exit(1);
  }
  try {
    // Known doc — reading it forces an OAuth exchange. If the key is
    // revoked, the Admin SDK fails with "16 UNAUTHENTICATED" right here.
    await db.collection('scraperStatus').doc('heartbeat').get();
    log('Firebase auth verified ✓');
  } catch (err) {
    log(`FATAL: Firebase auth failed at startup: ${err.message}`);
    log('This usually means FIREBASE_PRIVATE_KEY on Railway is stale or the service account key was revoked.');
    log('Fix: Firebase Console → Project Settings → Service Accounts → Generate new private key, then update Railway env vars.');
    process.exit(1);
  }
}

async function writeScrapeStatus(pullType, status, extra = {}) {
  try {
    await db.collection('scraperStatus').doc(pullType).set({
      at: new Date(),
      status, // 'success' | 'error'
      ...extra,
    }, { merge: true });
  } catch (err) {
    log(`Status write (${pullType}) failed: ${err.message}`);
  }
}

// ─── Login ─────────────────────────────────────────────────────────────────

async function login(page) {
  log('Logging into Choice Advantage...');
  try {
    await page.goto(CONFIG.CA_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (err) {
    throw new ScraperError(ERROR_CODES.CA_UNREACHABLE, `Login page unreachable: ${err.message}`);
  }
  log(`Login page URL: ${page.url()}`);

  // Detect whether we're actually at the login form via DOM — CA's login
  // URL and authenticated URLs both contain "Welcome", so URL-based
  // detection was returning early without authenticating.
  const hasLoginForm = await page.evaluate(() => {
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
    await page.fill('input[name="j_username"]', CONFIG.CA_USERNAME);
    await page.fill('input[name="j_password"]', CONFIG.CA_PASSWORD);

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }),
      page.click('a#greenButton'),
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

    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    log(`After settle — now at: ${page.url()}`);

    // VERIFY login actually worked. If the login form is still present on the
    // page after a submit, CA rejected our credentials — password was changed
    // or the account was locked. This used to be a silent failure: the scraper
    // would loop forever hitting "session expired" because every View page
    // bounced back to the login form. Now it surfaces as a typed error the
    // health-check cron can alert on with "CA password changed".
    const stillOnLoginForm = await page.evaluate(() =>
      !!document.querySelector('input[name="j_username"]')
    );
    if (stillOnLoginForm) {
      // Grab the error message CA displays so we can distinguish "wrong
      // password" from "account locked" from "too many attempts" later.
      const caMessage = await page.evaluate(() => {
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
    USER_ID:     CONFIG.USER_ID,
    PROPERTY_ID: CONFIG.PROPERTY_ID,
    TIMEZONE:    CONFIG.TIMEZONE,
  };

  try {
    const snapshot = await runCSVScrape(page, db, scrapeConfig, pullType, log);
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
        const snapshot = await runCSVScrape(page, db, scrapeConfig, pullType, log);
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
// scraperStatus/dashboard for the Schedule tab to display live.
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
 * The inner pullDashboardNumbers already wrote the error state to Firestore
 * on the first throw, so we don't need to re-write it here — we just need to
 * decide whether a retry makes sense.
 */
async function runDashboardPullFresh(page, relogin) {
  try {
    return await pullDashboardNumbers(page, db, log);
  } catch (err) {
    const code = err instanceof ScraperError ? err.code : ERROR_CODES.UNKNOWN;

    if (code === ERROR_CODES.SESSION_EXPIRED) {
      log(`Dashboard pull lost session — re-logging and retrying once...`);
      try {
        await relogin();
      } catch (loginErr) {
        // Re-login itself failed (likely login_failed). Leave the original
        // session_expired error in Firestore — but surface the login failure
        // too, because that's the real underlying problem now.
        log(`Re-login FAILED after session expiry: ${loginErr.message}`);
        await db.collection('scraperStatus').doc('dashboard').set({
          errorCode:    loginErr instanceof ScraperError ? loginErr.code : ERROR_CODES.UNKNOWN,
          errorMessage: `Re-login failed after session expiry: ${loginErr.message}`.slice(0, 500),
          erroredAt:    new Date(),
        }, { merge: true }).catch(() => {});
        return null;
      }

      // Retry the pull — if this one fails, its error state overwrites the
      // first and we don't retry again. (Don't want infinite loops on a
      // persistently sad CA.)
      try {
        return await pullDashboardNumbers(page, db, log);
      } catch (retryErr) {
        log(`Dashboard pull retry FAILED: [${retryErr.code || 'unknown'}] ${retryErr.message}`);
        return null;
      }
    }

    // Non-retryable code paths. pullDashboardNumbers already wrote the error
    // to Firestore, so we just log and return.
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
  // to Firestore and we don't want to retry every 5 min tick on a down CA.
  lastDashboardPullAt = now;
  return result;
}

// ─── OOO Work Order Sync (15-min cadence, piggybacks on dashboard tick) ────
//
// Mirrors CA's room-level Out-of-Order list into our own workOrders
// collection so Maria sees rooms blocked by the front desk (deep clean, AC
// broken, maintenance) alongside housekeeper-submitted tickets.
//
// Isolated from the dashboard pull in its own try/catch so a CA OOO outage
// (or a Firestore write blip) can never take the dashboard numbers down.
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
    USER_ID:     CONFIG.USER_ID,
    PROPERTY_ID: CONFIG.PROPERTY_ID,
  };

  try {
    await pullOOOWorkOrders(page, db, config, log);
  } catch (err) {
    const code = err instanceof ScraperError ? err.code : ERROR_CODES.UNKNOWN;
    // Same narrow retry as dashboard: only re-login on session_expired.
    if (code === ERROR_CODES.SESSION_EXPIRED) {
      log(`OOO pull lost session — re-logging and retrying once...`);
      try {
        await relogin();
        await pullOOOWorkOrders(page, db, config, log);
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

  // Before 7pm → 'morning' (writes to today's planSnapshot).
  // 7pm and later → 'evening' (writes to tomorrow's planSnapshot so the next
  // day's plan starts filling in as the PMS churns through check-ins).
  const pullType = hour < 19 ? 'morning' : 'evening';

  const ok = await runCSVScrapeFresh(page, pullType, relogin);
  // Only bump the timestamp on success — a failed pull should retry next tick.
  if (ok) lastCSVPullAt = now;
}

// ─── Main loop ─────────────────────────────────────────────────────────────

async function run() {
  log('=== HotelOps AI CSV Runner starting ===');
  log(`Property: ${CONFIG.PROPERTY_ID} | User: ${CONFIG.USER_ID}`);
  log(`Timezone: ${CONFIG.TIMEZONE} | Local hour: ${localHour()} | Today: ${todayISO()}`);
  log(`Tick every ${CONFIG.TICK_MINUTES} min — CSV pulls hourly 5am–11pm, dashboard numbers + OOO work orders every 15 min 5am–11pm`);

  // Verify Firebase credentials BEFORE launching Playwright. If creds are
  // stale/revoked, crash loud now instead of writing garbage for hours.
  await verifyFirebaseAuth();

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
      await runCSVScrape(page, db, {
        USER_ID:     CONFIG.USER_ID,
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
      await runVercelWatchdog({ timezone: CONFIG.TIMEZONE });
    } catch (err) {
      log(`watchdog crashed (non-fatal): ${err.message}`);
    }
  }

  // First tick immediately, then on interval
  await tick();

  const tickMs = CONFIG.TICK_MINUTES * 60 * 1000;
  setInterval(tick, tickMs);

  log(`CSV runner running. Next tick in ${CONFIG.TICK_MINUTES} minutes.`);
}

// ─── Entry point ───────────────────────────────────────────────────────────

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
