/**
 * HotelOps AI — Choice Advantage Scraper
 *
 * Logs into Choice Advantage, scrapes the Housekeeping Center every 15 minutes,
 * and writes live room data to Firebase Firestore.
 *
 * Property: Comfort Suites Beaumont TX (TXA32)
 * PMS: choiceADVANTAGE (SkyTouch Technology)
 */

require('dotenv').config();
const { chromium } = require('playwright');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const path = require('path');
const fs = require('fs');
const { runNightlyScheduler } = require('./scheduler');

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  // Choice Advantage
  CA_LOGIN_URL: 'https://www.choiceadvantage.com/choicehotels/Welcome.init',
  CA_HK_URL:    'https://www.choiceadvantage.com/choicehotels/HousekeepingCenter_start.init',
  CA_USERNAME:  process.env.CA_USERNAME,
  CA_PASSWORD:  process.env.CA_PASSWORD,

  // Firebase
  FIREBASE_PROJECT_ID:   process.env.FIREBASE_PROJECT_ID,
  FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL,
  FIREBASE_PRIVATE_KEY:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),

  // HotelOps
  USER_ID:     process.env.HOTELOPS_USER_ID,
  PROPERTY_ID: process.env.HOTELOPS_PROPERTY_ID,

  // Scraper
  INTERVAL_MINUTES:        parseInt(process.env.SCRAPE_INTERVAL_MINUTES || '15'),
  OPERATIONAL_HOURS_START: parseInt(process.env.OPERATIONAL_HOURS_START || '6'),
  OPERATIONAL_HOURS_END:   parseInt(process.env.OPERATIONAL_HOURS_END || '22'),

  // Timezone — Railway runs UTC; set to hotel's local timezone so operational
  // hours and date bucketing are correct. Beaumont TX is America/Chicago.
  TIMEZONE: process.env.TIMEZONE || 'America/Chicago',

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
  // Use the hotel's local timezone so date bucketing is correct.
  // 'en-CA' formats as YYYY-MM-DD; Intl handles DST automatically.
  return new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.TIMEZONE }).format(new Date());
}

function localHour() {
  // Returns the current hour (0–23) in the hotel's local timezone.
  // Railway runs UTC, so using new Date().getHours() would be wrong.
  return parseInt(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: CONFIG.TIMEZONE }).format(new Date()),
    10
  );
}

function isOperationalHours() {
  const hour = localHour();
  return hour >= CONFIG.OPERATIONAL_HOURS_START && hour < CONFIG.OPERATIONAL_HOURS_END;
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/**
 * Map Choice Advantage service string → HotelOps RoomType
 * CA values: "Check Out", "Stay Over", "None"
 */
function mapRoomType(caService, caRoomStatus) {
  if (caService === 'Check Out') return 'checkout';
  if (caService === 'Stay Over') return 'stayover';
  // "None" means vacant — either clean or dirty
  return 'vacant';
}

/**
 * Map CA condition → HotelOps RoomStatus
 * CA values: "Clean", "Dirty"
 */
function mapRoomStatus(caCondition) {
  if (caCondition === 'Clean') return 'clean';
  return 'dirty'; // default
}

// ─── Scraper ───────────────────────────────────────────────────────────────

async function scrapeHousekeepingCenter(page) {
  log('Navigating to Housekeeping Center...');
  await page.goto(CONFIG.CA_HK_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Check if we got redirected to login
  const currentUrl = page.url();
  log(`Landed on: ${currentUrl}`);
  if (currentUrl.includes('sign_in')) {
    log('Session expired — logging in again...');
    await login(page);
    await page.goto(CONFIG.CA_HK_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  // Wait for the room table — CA uses id="updateRoomConditionHeaderTable"
  // Use 45s timeout — headless Chromium needs extra time for CA's JS to render
  try {
    await page.waitForSelector('#updateRoomConditionHeaderTable tr', { timeout: 45000 });
  } catch (e) {
    // Take a debug screenshot so we can see what's actually on screen
    await page.screenshot({ path: path.join(__dirname, 'debug.png') });
    log(`Table not found — screenshot saved to debug.png. Page URL: ${page.url()}`);
    throw e;
  }

  // Scrape all room rows. Cell layout confirmed from live DOM inspection:
  // 0=Room#, 1=empty, 2=Type(SNK/SNQQ), 3=RoomStatus, 4=Condition, 5=Service, 6=AssignedTo, 7=DnD
  const rooms = await page.evaluate(() => {
    const rows = document.querySelectorAll('#updateRoomConditionHeaderTable tr');
    const results = [];

    rows.forEach((row, idx) => {
      if (idx === 0) return; // skip header row
      const cells = row.querySelectorAll('td');
      if (cells.length < 6) return;

      const roomNum = cells[0]?.innerText?.trim();
      if (!roomNum || !roomNum.match(/^\d{3,4}$/)) return;

      const type       = cells[2]?.innerText?.trim();       // SNK, SNQQ, HSNK, etc.
      const roomStatus = cells[3]?.innerText?.trim();       // Occupied / Vacant
      // CLEAN is active when #rcInput contains a div with class "GreenFake"
      const isClean    = cells[4]?.querySelector('#rcInput .GreenFake') !== null;
      const service    = cells[5]?.innerText?.trim();       // Check Out / Stay Over / None
      const assignedTo = cells[6]?.innerText?.trim() || null;
      const isDnd      = cells[7]?.querySelector('input[type="checkbox"]:checked') !== null;

      results.push({
        number:      roomNum,
        roomType:    type,
        roomStatus,
        condition:   isClean ? 'Clean' : 'Dirty',
        service,
        assignedTo:  assignedTo || null,
        isDnd,
      });
    });

    return results;
  });

  log(`Scraped ${rooms.length} rooms`);
  return rooms;
}

async function login(page) {
  log('Logging into Choice Advantage...');
  await page.goto(CONFIG.CA_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  log(`Login page URL: ${page.url()}`);

  // If already on dashboard, we're done
  const url = page.url();
  if (url.includes('Login.do') || url.includes('Welcome')) {
    log('Already logged in (session active)');
    return;
  }

  try {
    // Debug: screenshot what Playwright actually sees on the login page
    await page.screenshot({ path: path.join(__dirname, 'login-debug.png') });
    log('Saved login-debug.png');

    // Debug: check which form elements are present
    const hasUsername = await page.locator('input[name="j_username"]').count();
    const hasPassword = await page.locator('input[name="j_password"]').count();
    const hasGreenBtn = await page.locator('a#greenButton').count();
    const hasSubmitBtn = await page.locator('input[type="submit"]').count();
    const hasLoginBtn  = await page.locator('button[type="submit"]').count();
    log(`Elements found — j_username:${hasUsername} j_password:${hasPassword} a#greenButton:${hasGreenBtn} input[submit]:${hasSubmitBtn} button[submit]:${hasLoginBtn}`);

    // Log all input names on the page so we can identify the right fields
    const inputNames = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input')).map(el => `${el.type}[name=${el.name}][id=${el.id}]`)
    );
    log(`All inputs: ${inputNames.join(', ')}`);

    // Log all clickable elements that might be the login button
    const buttons = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a, button, input[type="submit"], input[type="button"]'))
        .map(el => `${el.tagName}[id=${el.id}][class=${el.className}][text=${el.innerText?.trim()?.slice(0,30)}]`)
    );
    log(`Buttons/links: ${buttons.join(' | ')}`);

    // CA login page uses j_username / j_password field names
    await page.waitForSelector('input[name="j_username"]', { timeout: 10000 });
    await page.fill('input[name="j_username"]', CONFIG.CA_USERNAME);
    await page.fill('input[name="j_password"]', CONFIG.CA_PASSWORD);

    // Click the login button — triggers formSubmit() → form.submit()
    // Must start waitForNavigation BEFORE clicking to catch the redirect
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }),
      page.click('a#greenButton'),
    ]);
    log(`After login click — now at: ${page.url()}`);

    // j_security_check may return 200 + JS/meta-refresh to dashboard instead of a
    // straight 302. waitForNavigation only catches the first navigation (to j_security_check).
    // If we're still there, wait for the second navigation (JS redirect to dashboard).
    if (page.url().includes('j_security_check')) {
      log('On j_security_check — saving screenshot and waiting for redirect to dashboard...');
      await page.screenshot({ path: path.join(__dirname, 'jsecurity-debug.png') });
      try {
        await page.waitForURL(url => !url.toString().includes('j_security_check'), { timeout: 15000 });
        log(`Redirected away from j_security_check — now at: ${page.url()}`);
      } catch (e) {
        log('Still on j_security_check after 15s — login may have failed or credentials are wrong');
      }
    }

    // Wait for any post-login JS/cookies to fully settle
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    log(`After settle — now at: ${page.url()}`);

  } catch (err) {
    log(`Login error: ${err.message}`);
    throw err;
  }
}

// ─── Firestore writer ──────────────────────────────────────────────────────

async function writeRoomsToFirestore(rooms) {
  const today = todayISO();
  const now = Timestamp.now();

  // Build all refs first
  const refs = rooms.map(room => ({
    room,
    ref: db
      .collection('users')
      .doc(CONFIG.USER_ID)
      .collection('properties')
      .doc(CONFIG.PROPERTY_ID)
      .collection('rooms')
      .doc(`${today}_${room.number}`),
  }));

  // Fetch all existing docs in parallel to know which are new vs existing
  const snaps = await Promise.all(refs.map(({ ref }) => ref.get()));

  // Build batch — scraper writes CA fields including status.
  // NOTE: While housekeepers aren't yet using the app to mark rooms clean,
  // CA condition is the source of truth for status. Once HKs are live on the
  // app, flip this back to preserve status on existing docs.
  const batch = db.batch();

  refs.forEach(({ room, ref }, i) => {
    const isNew = !snaps[i].exists;
    const syncData = {
      number:        room.number,
      type:          mapRoomType(room.service, room.roomStatus), // checkout|stayover|vacant
      status:        mapRoomStatus(room.condition),              // clean|dirty — from CA condition
      priority:      'standard',
      date:          today,
      propertyId:    CONFIG.PROPERTY_ID,
      isDnd:         room.isDnd || false,
      _caRoomType:   room.roomType,    // SNK, SNQQ, HSNK, etc.
      _caRoomStatus: room.roomStatus,  // Occupied / Vacant
      _caService:    room.service,     // Check Out / Stay Over / None
      _caCondition:  room.condition,   // Clean / Dirty
      _lastSyncedAt: now,
    };

    if (isNew) {
      // First sync of the day — initialize with no assignment
      batch.set(ref, { ...syncData, assignedTo: null, assignedName: null });
    } else {
      // Already exists — merge all fields including status
      batch.set(ref, syncData, { merge: true });
    }
  });

  await batch.commit();
  log(`Wrote ${rooms.length} rooms to Firestore (date: ${today})`);

  // Also update the property's lastSyncedAt
  await db
    .collection('users')
    .doc(CONFIG.USER_ID)
    .collection('properties')
    .doc(CONFIG.PROPERTY_ID)
    .update({ lastSyncedAt: Timestamp.now(), pmsConnected: true });
}

// ─── Scheduler trigger ─────────────────────────────────────────────────────
// Tracks whether the nightly scheduler has already run today so it
// fires exactly once per night even though the scraper loops every 15 min.
let lastSchedulerDate = null;

async function maybeRunScheduler() {
  const hour = localHour();
  const today = todayISO();

  // Run between 22:00–22:59 local time, once per calendar day
  if (hour === 22 && lastSchedulerDate !== today) {
    lastSchedulerDate = today;
    try {
      await runNightlyScheduler(db, {
        USER_ID:     CONFIG.USER_ID,
        PROPERTY_ID: CONFIG.PROPERTY_ID,
        TIMEZONE:    CONFIG.TIMEZONE,
        APP_URL:     process.env.APP_URL || 'https://hotelops-ai.vercel.app',
      }, log);
    } catch (err) {
      log(`Scheduler error: ${err.message}`);
    }
  }
}

// ─── Main loop ─────────────────────────────────────────────────────────────

async function run() {
  log('=== HotelOps AI Scraper starting ===');
  log(`Property: ${CONFIG.PROPERTY_ID} | User: ${CONFIG.USER_ID}`);
  log(`Timezone: ${CONFIG.TIMEZONE} | Local hour: ${localHour()} | Today: ${todayISO()}`);
  log(`Interval: every ${CONFIG.INTERVAL_MINUTES} min | Hours: ${CONFIG.OPERATIONAL_HOURS_START}:00–${CONFIG.OPERATIONAL_HOURS_END}:00 (${CONFIG.TIMEZONE})`);

  // Launch browser (headless in production, headed for debugging)
  const browser = await chromium.launch({
    headless: process.env.HEADED !== 'true',
    args: ['--no-sandbox', '--disable-setuid-sandbox'], // needed on Railway/Linux
  });

  // Persistent context keeps cookies/session across scrapes
  // NOTE: No custom userAgent — CA fingerprints the UA and serves a different
  // legacy login page to older/fake Chrome versions. Let Playwright use its
  // real Chromium UA so CA serves the modern login page (j_username / a#greenButton).
  const context = await browser.newContext({
    storageState: fs.existsSync(CONFIG.SESSION_FILE) ? CONFIG.SESSION_FILE : undefined,
  });

  const page = await context.newPage();

  // Initial login
  await login(page);

  // Save session so next run can skip login
  await context.storageState({ path: CONFIG.SESSION_FILE });

  // Run once immediately, then on interval
  async function scrapeAndWrite() {
    // Always check the nightly scheduler, even outside scraping hours
    await maybeRunScheduler();

    if (!isOperationalHours()) {
      log(`Outside operational hours (${CONFIG.OPERATIONAL_HOURS_START}:00–${CONFIG.OPERATIONAL_HOURS_END}:00) — skipping scrape`);
      return;
    }

    try {
      const rooms = await scrapeHousekeepingCenter(page);
      if (rooms.length === 0) {
        log('WARNING: 0 rooms scraped — possible page change or auth issue');
        return;
      }
      await writeRoomsToFirestore(rooms);

      // Save updated session after each successful run
      await context.storageState({ path: CONFIG.SESSION_FILE });
    } catch (err) {
      log(`ERROR during scrape: ${err.message}`);
      // Don't crash the process — just log and wait for next interval
    }
  }

  // First run
  await scrapeAndWrite();

  // Repeat every N minutes
  const intervalMs = CONFIG.INTERVAL_MINUTES * 60 * 1000;
  setInterval(scrapeAndWrite, intervalMs);

  log(`Scraper running. Next scrape in ${CONFIG.INTERVAL_MINUTES} minutes.`);
}

// ─── Entry point ───────────────────────────────────────────────────────────

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
