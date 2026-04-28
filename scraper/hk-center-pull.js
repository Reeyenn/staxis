/**
 * HK Center pull — reads live clean/dirty room state directly from
 * Choice Advantage's Housekeeping Center page.
 *
 * Different from csv-scraper / dashboard-pull:
 *   - csv-scraper exports the morning-plan CSV (arrivals / departures /
 *     stayover-day cycle). It's the planning source.
 *   - dashboard-pull grabs property-level totals (in-house / arrivals /
 *     departures counts).
 *   - hk-center-pull (this file) grabs ROOM-LEVEL real-time housekeeping
 *     state: which rooms are CLEAN, which are DIRTY, who's assigned,
 *     whether they're occupied or vacant. This is what Mario actually
 *     looks at on PMS to decide what's been cleaned today.
 *
 * Designed to be called on-demand from Vercel via the /scrape/hk-center
 * HTTP endpoint added to scraper.js. Reuses the persistent Playwright
 * page + login session so each call is fast (~5s including navigation).
 *
 * Triggered by Mario clicking "Load Rooms from CSV" (button name kept
 * for continuity even though it now pulls from a different page).
 */

'use strict';

const { ScraperError, ERROR_CODES } = require('./scraper-errors');

const HK_CENTER_URL =
  'https://www.choiceadvantage.com/choicehotels/HousekeepingCenter_start.init';

/**
 * Navigate to the Housekeeping Center and parse the rooms table.
 *
 * Returns: Array<{
 *   number: string,        // '101', '202', etc.
 *   type: string,          // CA's internal code: SNQQ, SNK, HSNK1, …
 *   roomStatus: string,    // 'Occupied' | 'Vacant' (front-desk view)
 *   condition: 'clean' | 'dirty' | null,  // housekeeping view
 *   service: string,       // 'Stay Over' | 'None' (or other)
 *   assignedTo: string,    // assigned-to initials, e.g. 'M. C.', or ''
 *   isDnd: boolean,        // Do Not Disturb checkbox
 * }>
 *
 * Side effects: navigates the shared Playwright page. Caller must hold
 * the scraper's tick mutex / HTTP serialization lock so we don't race
 * with a concurrent CSV / dashboard pull on the same page.
 */
async function pullHkCenter(page, log) {
  const t0 = Date.now();

  // domcontentloaded (not networkidle) — the totals + room rows render
  // server-side. networkidle would wait on tracker pixels we don't care
  // about and can hang past timeout for no reason.
  try {
    await page.goto(HK_CENTER_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
  } catch (err) {
    throw new ScraperError(
      ERROR_CODES.TIMEOUT,
      `HK Center navigation failed: ${err.message}`,
    );
  }

  // The page sometimes redirects back to login if the session expired.
  // Detect via URL — caller will trap SESSION_EXPIRED and re-login.
  const url = page.url();
  if (/sign_in|Login/i.test(url) && !/HousekeepingCenter/i.test(url)) {
    throw new ScraperError(
      ERROR_CODES.SESSION_EXPIRED,
      `HK Center redirected to login (URL: ${url})`,
    );
  }

  // Wait for the rooms table specifically. If CA's page structure ever
  // changes this is the canary.
  try {
    await page.waitForSelector('table tr', { timeout: 15_000 });
  } catch {
    throw new ScraperError(
      ERROR_CODES.SELECTOR_MISS,
      'HK Center table never rendered (no table tr selector matched)',
    );
  }

  // Extract via page.evaluate — runs inside the browser context, has
  // access to the actual rendered DOM + computed styles. We use the
  // background color of the condition badge as the source of truth for
  // CLEAN vs DIRTY because both labels are always rendered as text;
  // only the active one has a colored background. This was the trick
  // we discovered while pairing on the page in Chrome — see chat log
  // 2026-04-28.
  let rooms;
  try {
    rooms = await page.evaluate(() => {
      const out = [];
      const rows = document.querySelectorAll('table tr');
      for (const tr of rows) {
        const cells = tr.querySelectorAll('td');
        if (cells.length < 7) continue;
        const number = (cells[0].innerText || '').trim();
        if (!/^\d/.test(number)) continue; // skip header / non-data rows

        // Condition: find the descendant of cells[5] with a non-transparent
        // background-color — that's the highlighted CLEAN or DIRTY pill.
        let condition = null;
        const condCell = cells[5];
        if (condCell) {
          const els = condCell.querySelectorAll('*');
          for (const el of els) {
            const bg = window.getComputedStyle(el).backgroundColor;
            if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
              const txt = (el.innerText || '').trim().toUpperCase();
              if (txt === 'CLEAN' || txt === 'DIRTY') {
                condition = txt.toLowerCase();
                break;
              }
            }
          }
        }

        // DND checkbox is in cells[8]. We probe for a checked input.
        let isDnd = false;
        if (cells[8]) {
          const chk = cells[8].querySelector('input[type="checkbox"]');
          if (chk && chk.checked) isDnd = true;
        }

        out.push({
          number,
          type: (cells[2]?.innerText || '').trim(),
          roomStatus: (cells[3]?.innerText || '').trim(),
          condition,
          service: (cells[6]?.innerText || '').trim(),
          assignedTo: (cells[7]?.innerText || '').trim(),
          isDnd,
        });
      }
      return out;
    });
  } catch (err) {
    throw new ScraperError(
      ERROR_CODES.PARSE_ERROR,
      `HK Center extraction failed: ${err.message}`,
    );
  }

  if (rooms.length === 0) {
    throw new ScraperError(
      ERROR_CODES.PARSE_ERROR,
      'HK Center parsed zero rooms — CA page layout may have changed',
    );
  }

  // Sanity check: every room must have a condition. If we lose the
  // background-color heuristic (CA restyles their pill), rooms.condition
  // would be null and the caller would write garbage. Fail loudly.
  const missingCondition = rooms.filter(r => r.condition === null).length;
  if (missingCondition > 0) {
    throw new ScraperError(
      ERROR_CODES.PARSE_ERROR,
      `HK Center: ${missingCondition} of ${rooms.length} rooms had no condition badge — CA layout likely changed`,
    );
  }

  const cleanCount = rooms.filter(r => r.condition === 'clean').length;
  const dirtyCount = rooms.filter(r => r.condition === 'dirty').length;
  const tookMs = Date.now() - t0;
  log(`HK Center pull: ${rooms.length} rooms (${cleanCount} clean / ${dirtyCount} dirty) in ${tookMs}ms`);

  return rooms;
}

module.exports = { pullHkCenter };
