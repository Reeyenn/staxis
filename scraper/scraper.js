/**
 * HotelOps AI — CSV Schedule Runner
 *
 * Runs on Railway. Stays alive and, once per day, pulls the arrivals/
 * departures CSV from Choice Advantage at 6am (today's shift confirmation)
 * and 7pm (tomorrow's shift plan). Writes to planSnapshots/{date} and
 * merges the stayover-cycle fields into individual room docs.
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

// ─── Login ─────────────────────────────────────────────────────────────────

async function login(page) {
  log('Logging into Choice Advantage...');
  await page.goto(CONFIG.CA_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  log(`Login page URL: ${page.url()}`);

  const url = page.url();
  if (url.includes('Login.do') || url.includes('Welcome')) {
    log('Already logged in (session active)');
    return;
  }

  try {
    await page.waitForSelector('input[name="j_username"]', { timeout: 10000 });
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
  } catch (err) {
    log(`Login error: ${err.message}`);
    throw err;
  }
}

// ─── CSV pull scheduler ────────────────────────────────────────────────────
// Each daily trigger fires exactly once per calendar day even though the
// runner ticks every few minutes.
let lastEveningCSVDate = null;
let lastMorningCSVDate = null;

/**
 * Run a scheduled CSV scrape. Always re-logs in *right before* the scrape so
 * the session cookie is guaranteed fresh — CA expires sessions after a few
 * hours of idle, and the runner goes idle between scheduled windows. A single
 * login at startup isn't good enough.
 *
 * If the re-login itself fails or the scrape still fails, we return false so
 * the caller leaves `lastMorningCSVDate` unset and the next tick retries.
 */
async function runCSVScrapeFresh(page, pullType, relogin) {
  // Always re-login right before — sessions die between scheduled windows.
  try {
    await relogin();
  } catch (loginErr) {
    log(`${pullType} pre-scrape login FAILED: ${loginErr.message}`);
    return false;
  }

  const scrapeConfig = {
    USER_ID:     CONFIG.USER_ID,
    PROPERTY_ID: CONFIG.PROPERTY_ID,
    TIMEZONE:    CONFIG.TIMEZONE,
  };

  try {
    await runCSVScrape(page, db, scrapeConfig, pullType, log);
    return true;
  } catch (err) {
    const msg = err.message || '';
    // Belt-and-suspenders: if CA killed the session *during* the scrape itself
    // (rare but observed), retry once with another fresh login.
    if (msg.toLowerCase().includes('session expired')) {
      log(`${pullType} scrape lost session mid-run — re-logging and retrying once...`);
      try {
        await relogin();
        await runCSVScrape(page, db, scrapeConfig, pullType, log);
        return true;
      } catch (retryErr) {
        log(`${pullType} scrape retry FAILED: ${retryErr.message}`);
        return false;
      }
    }
    log(`${pullType} CSV pull error: ${msg}`);
    return false;
  }
}

async function maybeRunCSVPull(page, relogin) {
  const hour  = localHour();
  const today = todayISO();

  // ── Morning CSV pull: target 6am, catch up any time 6am–6:59pm ───────────
  // If a Railway redeploy wiped in-process state after 6am, we self-heal on
  // the first tick by seeing "we're past 6am and haven't run today yet."
  // IMPORTANT: only mark `lastMorningCSVDate` after the scrape *succeeds* so
  // transient errors (session expiry, CA outages) don't lock us out for the day.
  if (hour >= 6 && hour < 19 && lastMorningCSVDate !== today) {
    const ok = await runCSVScrapeFresh(page, 'morning', relogin);
    if (ok) lastMorningCSVDate = today;
  }

  // ── Evening CSV pull: target 7pm, catch up any time 7pm–midnight ─────────
  if (hour >= 19 && lastEveningCSVDate !== today) {
    const ok = await runCSVScrapeFresh(page, 'evening', relogin);
    if (ok) lastEveningCSVDate = today;
  }
}

// ─── Main loop ─────────────────────────────────────────────────────────────

async function run() {
  log('=== HotelOps AI CSV Runner starting ===');
  log(`Property: ${CONFIG.PROPERTY_ID} | User: ${CONFIG.USER_ID}`);
  log(`Timezone: ${CONFIG.TIMEZONE} | Local hour: ${localHour()} | Today: ${todayISO()}`);
  log(`Tick every ${CONFIG.TICK_MINUTES} min — triggers CSV pulls at 6am and 7pm local time`);

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
      await maybeRunCSVPull(page, relogin);
      // Refresh session cookie so we stay logged in
      await context.storageState({ path: CONFIG.SESSION_FILE });
    } catch (err) {
      log(`ERROR during tick: ${err.message}`);
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
