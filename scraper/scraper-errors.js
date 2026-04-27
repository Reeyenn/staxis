/**
 * Shared error taxonomy for every Choice Advantage scraping path.
 *
 * Used by: scraper.js (login), dashboard-pull.js (View pages), ooo-pull.js
 * (work orders), csv-scraper.js (CSV report).
 *
 * Read by: src/app/api/cron/scraper-health/route.ts (turns codes into
 * human-readable SMS alerts) and src/app/api/admin/doctor/route.ts.
 *
 * Lifted out of dashboard-pull.js on 2026-04-27 because csv-scraper.js was
 * still throwing raw `Error()` while every other scraping path used typed
 * ScraperError, and the cron was string-matching on error messages instead
 * of reading codes. Centralizing here lets every pull throw the same shape.
 *
 * Adding a new code:
 *   1. Add it to ERROR_CODES below.
 *   2. Add an actionable SMS template in scraper-health/route.ts's
 *      `mapErrorToCondition` / `alertMessage` (otherwise the alert says
 *      'unknown error' and operator has to dig into Railway logs).
 *   3. Add a row to RUNBOOKS.md so the next person knows what symptom maps
 *      to what fix.
 */

const ERROR_CODES = Object.freeze({
  // Auth
  LOGIN_FAILED:       'login_failed',        // credentials rejected (password change / account lock / migration consent missing)
  SESSION_EXPIRED:    'session_expired',     // mid-pull CA dropped our session

  // CA structural / page-level
  SELECTOR_MISS:      'selector_miss',       // expected DOM structure changed (selector list exhausted)
  PARSE_ERROR:        'parse_error',         // found the element, couldn't parse the value
  VALIDATION_FAILED:  'validation_failed',   // value parsed but out of plausible range

  // Network / availability
  TIMEOUT:            'timeout',             // page took too long
  CA_UNREACHABLE:     'ca_unreachable',      // navigation threw (DNS / 5xx / connection refused / chained redirect race)

  // CSV-specific
  CSV_DOWNLOAD_FAILED: 'csv_download_failed', // download started but never delivered content (no event, no popup, no inline)
  CSV_BAD_CONTENT:     'csv_bad_content',     // download received but doesn't look like a CSV (login HTML, etc.)
  CSV_VALIDATION_FAILED: 'csv_validation_failed', // CSV parsed but the snapshot is degenerate (zero rooms, NaN totals)

  // Catch-all
  UNKNOWN:            'unknown',
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

module.exports = { ScraperError, ERROR_CODES };
