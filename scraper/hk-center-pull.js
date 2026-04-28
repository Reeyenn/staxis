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
 *
 * Selector + cell-index reference: salvaged from the pre-Apr-18 live
 * scraper (commit 8979cde^), which scraped this same page every 15 min
 * for months and is the proven layout. CA's HK Center renders the
 * rooms inside a table with id="updateRoomConditionHeaderTable", and
 * the active CLEAN/DIRTY pill is marked by a child <div class="GreenFake">
 * (CLEAN) or <div class="RedFake"> (DIRTY) inside #rcInput in cell 4.
 * The earlier rewrite of this file used a generic `table tr` selector
 * + computed background-color heuristic; both fail on CA's actual DOM.
 */

'use strict';

const { ScraperError, ERROR_CODES } = require('./scraper-errors');

const HK_CENTER_URL =
  'https://www.choiceadvantage.com/choicehotels/HousekeepingCenter_start.init';

// CA's HK Center table ID. Stable across the months the prior scraper
// ran. If this ever changes, every error below will surface as
// SELECTOR_MISS — point at this constant and inspect the live DOM.
const HK_CENTER_TABLE_SELECTOR = '#updateRoomConditionHeaderTable';

/**
 * Cell layout inside each data <tr> of the HK Center table:
 *   0 = Room number ('101', '202', …)
 *   1 = (empty / status icon)
 *   2 = Room type code (SNK, SNQQ, HSNK1, …) — CA-internal
 *   3 = Room status ('Occupied' | 'Vacant') — front desk view
 *   4 = Condition pill — contains <div id="rcInput"> with either a
 *       child .GreenFake (CLEAN active) or .RedFake (DIRTY active).
 *       Both labels are always rendered as text — only the styled
 *       div tells you which one is the active state.
 *   5 = Service ('Stay Over' | 'Check Out' | 'None' | …)
 *   6 = Assigned-to (initials, e.g. 'M. C.', or empty)
 *   7 = DnD checkbox cell (input[type=checkbox])
 *
 * The header row also has <td>s, but cells[0] won't be a numeric
 * room number, so the /^\d/ filter skips it.
 */
const CELL = {
  ROOM_NUMBER: 0,
  TYPE: 2,
  ROOM_STATUS: 3,
  CONDITION: 4,
  SERVICE: 5,
  ASSIGNED_TO: 6,
  DND: 7,
};

/**
 * Navigate to the Housekeeping Center and parse the rooms table.
 *
 * Returns: Array<{
 *   number: string,        // '101', '202', etc.
 *   type: string,          // CA's internal code: SNQQ, SNK, HSNK1, …
 *   roomStatus: string,    // 'Occupied' | 'Vacant' (front-desk view)
 *   condition: 'clean' | 'dirty' | null,  // housekeeping view
 *   service: string,       // 'Stay Over' | 'Check Out' | 'None' (or other)
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

  // Wait specifically for the room table — not just any table on the
  // page (CA's chrome has nav tables that always exist). 30s is generous
  // because cold-cached HK Center can take 15-20s to render its rows
  // when CA's report cluster is busy.
  try {
    await page.waitForSelector(`${HK_CENTER_TABLE_SELECTOR} tr`, { timeout: 30_000 });
  } catch {
    throw new ScraperError(
      ERROR_CODES.SELECTOR_MISS,
      `HK Center table never rendered (selector: ${HK_CENTER_TABLE_SELECTOR} tr). ` +
      `Final URL: ${page.url()}. CA page layout may have changed.`,
    );
  }

  // Extract via page.evaluate — runs inside the browser context. We
  // pass the cell-index map and table selector as args so the JS in
  // here doesn't drift from the constants above.
  let rooms;
  try {
    rooms = await page.evaluate(({ tableSelector, CELL }) => {
      const out = [];
      const rows = document.querySelectorAll(`${tableSelector} tr`);
      for (const tr of rows) {
        const cells = tr.querySelectorAll('td');
        // Need cells[CELL.DND] (=7) at minimum. < 8 means partial row.
        if (cells.length < 8) continue;
        const number = (cells[CELL.ROOM_NUMBER].innerText || '').trim();
        if (!/^\d{3,4}$/.test(number)) continue; // skip header / non-data rows

        // Condition pill: scoped querySelector inside cells[4] for the
        // active-state div. CA renders BOTH "CLEAN" and "DIRTY" labels
        // — only the active one has the .GreenFake/.RedFake class.
        // querySelector is scoped to the cell so duplicate rcInput IDs
        // across rows don't matter.
        const condCell = cells[CELL.CONDITION];
        const isClean = condCell && condCell.querySelector('#rcInput .GreenFake') !== null;
        const isDirty = condCell && condCell.querySelector('#rcInput .RedFake') !== null;
        let condition = null;
        if (isClean) condition = 'clean';
        else if (isDirty) condition = 'dirty';

        // DnD: a checkbox inside cell 7. Some rows have no checkbox at
        // all (e.g., OOO rooms) — treat absent as not-DnD.
        let isDnd = false;
        const dndCell = cells[CELL.DND];
        if (dndCell) {
          const chk = dndCell.querySelector('input[type="checkbox"]');
          if (chk && chk.checked) isDnd = true;
        }

        out.push({
          number,
          type: (cells[CELL.TYPE].innerText || '').trim(),
          roomStatus: (cells[CELL.ROOM_STATUS].innerText || '').trim(),
          condition,
          service: (cells[CELL.SERVICE].innerText || '').trim(),
          assignedTo: (cells[CELL.ASSIGNED_TO].innerText || '').trim(),
          isDnd,
        });
      }
      return out;
    }, { tableSelector: HK_CENTER_TABLE_SELECTOR, CELL });
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

  // Sanity check: every room must have a condition. If neither
  // .GreenFake nor .RedFake matched, CA likely restyled the pill —
  // fail loud rather than write garbage.
  const missingCondition = rooms.filter(r => r.condition === null).length;
  if (missingCondition > 0) {
    throw new ScraperError(
      ERROR_CODES.PARSE_ERROR,
      `HK Center: ${missingCondition} of ${rooms.length} rooms had no condition badge ` +
      `(neither #rcInput .GreenFake nor #rcInput .RedFake matched) — CA layout likely changed`,
    );
  }

  const cleanCount = rooms.filter(r => r.condition === 'clean').length;
  const dirtyCount = rooms.filter(r => r.condition === 'dirty').length;
  const tookMs = Date.now() - t0;
  log(`HK Center pull: ${rooms.length} rooms (${cleanCount} clean / ${dirtyCount} dirty) in ${tookMs}ms`);

  return rooms;
}

module.exports = { pullHkCenter };
