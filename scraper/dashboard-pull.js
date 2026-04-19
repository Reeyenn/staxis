/**
 * HotelOps AI — Dashboard Number Pull
 *
 * Pulls three operational numbers from Choice Advantage's View pages and
 * writes them to scraperStatus/dashboard for display on the Schedule tab:
 *   • View → In House    → Room Count (currently occupied rooms)
 *   • View → Arrivals    → Room Count (arrivals still pending check-in)
 *   • View → Departures  → Room Count (departures still pending check-out)
 *
 * Called from scraper.js every 15 minutes between 5am and 11pm local time.
 *
 * ─── Reliability contract (do not weaken without thought) ─────────────────
 *
 * Maria makes real staffing decisions off these numbers. A silently wrong
 * number is worse than no number — she'll trust a stale 25 and schedule a
 * housekeeper she doesn't need, or miss one she does. So the contract here is:
 *
 *   1. ATOMIC. We pull all three pages into memory, validate them, and only
 *      then write to scraperStatus/dashboard. A partial pull (In House
 *      succeeds, Arrivals fails) NEVER overwrites the last good snapshot.
 *
 *   2. LAST-GOOD PRESERVATION. On any failure, the success fields on the
 *      dashboard doc are left alone. The UI keeps showing the last successful
 *      numbers but can tell they're stale via pulledAt. Only the error fields
 *      (errorCode, errorMessage, erroredAt) get touched.
 *
 *   3. TYPED ERRORS. Every failure maps to one of a fixed set of error codes
 *      — login_failed, selector_miss, timeout, parse_error, session_expired,
 *      validation_failed, ca_unreachable. The health-check cron uses these
 *      codes to produce actionable SMS alerts ("CA password changed", not
 *      "something broke").
 *
 *   4. VALIDATION. Values are validated before writing. Integer, 0–500 range,
 *      all three present. A plausible-but-wrong parse (e.g. the page silently
 *      returned "—" which parseInt turned into NaN) gets caught here instead
 *      of being written as null.
 *
 *   5. DIAGNOSTICS ON FAIL. When something breaks we capture page URL, title,
 *      first 10 labels, and login-form presence. That's written alongside the
 *      error so future-you can debug a failure that happened months ago
 *      without having to reproduce it.
 *
 * On selectors: the three View pages use inconsistent element IDs (#roomCount
 * on Arrivals/Departures, #roomCountValue on In House). The surrounding HTML
 * structure IS consistent though:
 *
 *   <ul class="CHI_Row_Left">
 *     <li><label>Guest Count:</label></li>
 *     <li><p class="CHI_Data">N</p></li>
 *     <li><label>Room Count:</label></li>
 *     <li><p class="CHI_Data">N</p></li>
 *   </ul>
 *
 * So we target by label text and walk to the next <li>'s .CHI_Data.
 */

const { FieldValue } = require('firebase-admin/firestore');

const VIEW_PAGES = [
  { key: 'inHouse',    url: 'https://www.choiceadvantage.com/choicehotels/ViewInHouseList.init' },
  { key: 'arrivals',   url: 'https://www.choiceadvantage.com/choicehotels/ViewArrivalsList.init' },
  { key: 'departures', url: 'https://www.choiceadvantage.com/choicehotels/ViewDeparturesList.init' },
];

// Fixed vocabulary of error codes. The health-check cron reads these and
// turns them into specific SMS alerts, so adding a new code means adding a
// human-readable message in src/app/api/cron/scraper-health/route.ts too.
const ERROR_CODES = Object.freeze({
  LOGIN_FAILED:       'login_failed',        // credentials rejected (password change / account lock)
  SESSION_EXPIRED:    'session_expired',     // mid-pull CA dropped our session
  SELECTOR_MISS:      'selector_miss',       // expected DOM structure changed
  TIMEOUT:            'timeout',             // network / page took too long
  PARSE_ERROR:        'parse_error',         // found the element, couldn't parse a number
  VALIDATION_FAILED:  'validation_failed',   // number parsed but out of plausible range
  CA_UNREACHABLE:     'ca_unreachable',      // navigation threw (DNS / 5xx / connection refused)
  UNKNOWN:            'unknown',             // catch-all — shouldn't happen
});

/**
 * Typed error so callers (and the health-check cron) can react to specific
 * failure modes instead of string-matching on error messages.
 */
class ScraperError extends Error {
  constructor(code, message, { page, diagnostics } = {}) {
    super(message);
    this.name = 'ScraperError';
    this.code = code;
    this.page = page || null;
    this.diagnostics = diagnostics || null;
  }
}

// Plausibility bounds — Comfort Suites Beaumont has 61 rooms total. 500 is
// the safe upper bound for a future multi-property world. Anything outside
// this range means CA returned something we can't interpret.
const MIN_COUNT = 0;
const MAX_COUNT = 500;

function isPlausibleCount(n) {
  return Number.isInteger(n) && n >= MIN_COUNT && n <= MAX_COUNT;
}

async function collectDiagnostics(page) {
  try {
    return await page.evaluate(() => ({
      url:           location.href,
      title:         document.title,
      h1:            (document.querySelector('h1')?.textContent || '').trim(),
      firstLabels:   Array.from(document.querySelectorAll('label')).slice(0, 10).map(l => l.textContent.trim()),
      hasLoginForm: !!document.querySelector('input[name="j_username"], input[name="j_password"]'),
    }));
  } catch {
    return { url: null, title: null, h1: null, firstLabels: [], hasLoginForm: false };
  }
}

async function readCounts(page) {
  return await page.evaluate(() => {
    const getCount = (labelText) => {
      const labels = Array.from(document.querySelectorAll('label'));
      const lbl = labels.find(l => l.textContent.trim() === labelText);
      if (!lbl) return null;
      const cell = lbl.closest('li');
      const next = cell ? cell.nextElementSibling : null;
      const data = next ? next.querySelector('.CHI_Data') : null;
      if (!data) return null;
      const raw = data.textContent.trim();
      const n = parseInt(raw, 10);
      return Number.isNaN(n) ? null : n;
    };
    return {
      guestCount: getCount('Guest Count:'),
      roomCount:  getCount('Room Count:'),
    };
  });
}

/**
 * Pull the three View pages into a local map. Throws a ScraperError on the
 * first failure — does NOT write anything to Firestore. The caller is
 * responsible for the Firestore write (so the atomicity guarantee lives at
 * exactly one layer).
 */
async function fetchAllViewPages(page, log) {
  const result = {};

  for (const { key, url } of VIEW_PAGES) {
    log(`Dashboard pull — ${key}...`);

    // ── Navigate ──────────────────────────────────────────────────────
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err) {
      throw new ScraperError(
        ERROR_CODES.CA_UNREACHABLE,
        `${key} navigation failed: ${err.message}`,
        { page: key }
      );
    }

    // ── Session-expiry guards (URL-based + DOM-based) ─────────────────
    // CA sometimes bounces expired sessions to a Welcome page whose URL
    // doesn't contain "Login". Detect via the login form instead.
    const cur = page.url();
    if (cur.includes('Login') || cur.includes('j_security_check')) {
      throw new ScraperError(
        ERROR_CODES.SESSION_EXPIRED,
        `Session expired (redirected to ${cur})`,
        { page: key, diagnostics: await collectDiagnostics(page) }
      );
    }
    const onLoginPage = await page.evaluate(() =>
      !!document.querySelector('input[name="j_username"], input[name="j_password"]')
    );
    if (onLoginPage) {
      throw new ScraperError(
        ERROR_CODES.SESSION_EXPIRED,
        `Session expired (login form present at ${cur})`,
        { page: key, diagnostics: await collectDiagnostics(page) }
      );
    }

    // ── Wait for Room Count specifically ──────────────────────────────
    // A generic `ul.CHI_Row_Left label` wait matches 8+ elements on the
    // page and is unreliable. Target the exact label + numeric sibling.
    try {
      await page.waitForFunction(() => {
        const labels = Array.from(document.querySelectorAll('label'));
        const rc = labels.find(l => l.textContent.trim() === 'Room Count:');
        if (!rc) return false;
        const li = rc.closest('li');
        const next = li ? li.nextElementSibling : null;
        const data = next ? next.querySelector('.CHI_Data') : null;
        return !!(data && /^\d+$/.test(data.textContent.trim()));
      }, { timeout: 15000 });
    } catch (waitErr) {
      const diag = await collectDiagnostics(page);
      if (diag.hasLoginForm) {
        throw new ScraperError(
          ERROR_CODES.SESSION_EXPIRED,
          `Session expired (login form present after wait at ${page.url()})`,
          { page: key, diagnostics: diag }
        );
      }
      // Distinguish "timed out because page slow" from "DOM changed":
      // if the page loaded but has NO "Room Count:" label at all, CA
      // restructured the page. Otherwise it's a plain timeout.
      const domChanged = !diag.firstLabels.includes('Room Count:');
      throw new ScraperError(
        domChanged ? ERROR_CODES.SELECTOR_MISS : ERROR_CODES.TIMEOUT,
        `${key} wait for Room Count failed (${waitErr.message})`,
        { page: key, diagnostics: diag }
      );
    }

    // ── Read + validate ───────────────────────────────────────────────
    const { roomCount, guestCount } = await readCounts(page);
    if (roomCount === null) {
      throw new ScraperError(
        ERROR_CODES.PARSE_ERROR,
        `${key} Room Count present but not parseable`,
        { page: key, diagnostics: await collectDiagnostics(page) }
      );
    }
    if (!isPlausibleCount(roomCount)) {
      throw new ScraperError(
        ERROR_CODES.VALIDATION_FAILED,
        `${key} Room Count ${roomCount} is out of plausible range (${MIN_COUNT}-${MAX_COUNT})`,
        { page: key, diagnostics: await collectDiagnostics(page) }
      );
    }

    result[key] = { roomCount, guestCount };
    log(`Dashboard pull ${key} — roomCount=${roomCount} guestCount=${guestCount}`);
  }

  return result;
}

/**
 * Firestore's set() doesn't accept undefined values. Make sure our
 * diagnostics object is safe to write — turn undefineds into nulls and
 * truncate long strings.
 */
function sanitizeForFirestore(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined) {
      out[k] = null;
    } else if (typeof v === 'string') {
      out[k] = v.slice(0, 500);
    } else if (Array.isArray(v)) {
      out[k] = v.slice(0, 20).map(x => (typeof x === 'string' ? x.slice(0, 200) : x));
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Navigate the three View pages in sequence and write the numbers to
 * scraperStatus/dashboard ATOMICALLY — all three succeed or nothing is
 * written to the success fields. On failure, the error fields are updated
 * and the last good numbers stay put.
 *
 * Returns the written payload on success. On failure, writes the error to
 * the dashboard doc's error fields AND re-throws a typed ScraperError so
 * the caller (scraper.js) can decide whether to retry with re-login.
 */
async function pullDashboardNumbers(page, db, log) {
  let result;
  try {
    result = await fetchAllViewPages(page, log);
  } catch (err) {
    // Failure path — update only the error fields. Never touch the last-
    // known-good numbers. The UI will render them as stale once pulledAt
    // gets old enough, and the health-check cron will text Reeyen.
    const code = err instanceof ScraperError ? err.code : ERROR_CODES.UNKNOWN;
    const diagnostics = err instanceof ScraperError ? err.diagnostics : null;
    const failurePage = err instanceof ScraperError ? err.page : null;

    log(`Dashboard pull FAILED [${code}] ${err.message}`);

    await db.collection('scraperStatus').doc('dashboard').set({
      errorCode:       code,
      errorMessage:    String(err.message || '').slice(0, 500),
      errorPage:       failurePage,
      erroredAt:       new Date(),
      lastDiagnostics: diagnostics ? sanitizeForFirestore(diagnostics) : null,
    }, { merge: true }).catch(writeErr => {
      log(`Failed to write error state: ${writeErr.message}`);
    });

    // Separately bump a failure counter — weekly digest uses this to report
    // "672/672 pulls succeeded" without needing an append-only history table.
    await db.collection('scraperStatus').doc('dashboardCounters').set({
      lastFailureAt:  new Date(),
      lastFailureCode: code,
      totalFailures:  FieldValue.increment(1),
    }, { merge: true }).catch(() => {});

    // Re-throw so the caller can attempt re-login + retry on session_expired.
    // Retry is a concern of the outer layer, not this one.
    throw err;
  }

  // Success path — write all the success fields AND clear the error fields
  // in one atomic set({ merge: true }). Clearing error fields is important:
  // a stale errorCode from last week would otherwise mislead the health check.
  const payload = {
    inHouse:    result.inHouse.roomCount,
    arrivals:   result.arrivals.roomCount,
    departures: result.departures.roomCount,
    inHouseGuests:    result.inHouse.guestCount    ?? null,
    arrivalsGuests:   result.arrivals.guestCount   ?? null,
    departuresGuests: result.departures.guestCount ?? null,
    pulledAt: new Date(),
    // Clear error fields on success so alerts reset.
    errorCode:       null,
    errorMessage:    null,
    errorPage:       null,
    erroredAt:       null,
    lastDiagnostics: null,
    // Legacy field for any old UI code still reading `error`.
    error: null,
  };

  await db.collection('scraperStatus').doc('dashboard').set(payload, { merge: true });

  // Bump the success counter so the weekly digest can report
  // "672/672 pulls succeeded this week" without keeping a log table.
  await db.collection('scraperStatus').doc('dashboardCounters').set({
    lastSuccessAt:  new Date(),
    totalSuccesses: FieldValue.increment(1),
  }, { merge: true }).catch(() => {});

  log(`Dashboard pull OK — inHouse=${payload.inHouse} arrivals=${payload.arrivals} departures=${payload.departures}`);
  return payload;
}

module.exports = { pullDashboardNumbers, ScraperError, ERROR_CODES };
