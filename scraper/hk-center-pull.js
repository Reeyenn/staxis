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
  //
  // Condition detection: layered strategy because CA has changed pill
  // class names at least once between the pre-Apr-18 live scraper
  // (.GreenFake / .RedFake) and now (today's smoke test showed those
  // classes were absent on all 74 rooms). The new strategy:
  //
  //   1. Try the historical .GreenFake / .RedFake selectors.
  //   2. Try common "active state" class patterns (Green/Red, active,
  //      selected) inside the condition cell.
  //   3. Fall back to walking children of #rcInput and finding the one
  //      with a meaningfully colored background — green-ish (R<G,B<G,
  //      G high) means CLEAN, red-ish (R high, G low, B low) means
  //      DIRTY. This survives any class-name churn as long as CA still
  //      visually distinguishes the two states with color.
  //
  // On total failure for a row, returns sample HTML so we can see
  // what CA changed — surfaces in the parse_error message.
  let result;
  try {
    result = await page.evaluate(({ tableSelector, CELL }) => {
      function detectCondition(condCell) {
        if (!condCell) return { condition: null, debug: 'no-cell' };

        // Strategy 1 (current CA, post-Apr-2026): housekeeping status is
        // now a <select> dropdown inside the cell, NOT a styled pill.
        // The cell wraps a <select id="update-housekeeping-status-dropdown-N"
        // name="housekeepingStatus_<roomNumber>"> containing options like
        // 'Clean', 'Dirty' (and possibly Inspected, OOO, etc.).
        // The currently selected option = the room's current condition.
        // We use select.value (the value attribute), falling back to the
        // selected <option>'s text content, lowercase + trim.
        const sel = condCell.querySelector(
          'select[name^="housekeepingStatus" i], select[id^="update-housekeeping-status" i]',
        );
        if (sel) {
          let raw = '';
          if (typeof sel.value === 'string' && sel.value) {
            raw = sel.value;
          } else if (sel.selectedIndex >= 0 && sel.options[sel.selectedIndex]) {
            raw = sel.options[sel.selectedIndex].text || sel.options[sel.selectedIndex].value || '';
          }
          const norm = raw.trim().toLowerCase();
          if (norm.startsWith('clean')) return { condition: 'clean', debug: `select=${raw}` };
          if (norm.startsWith('dirty')) return { condition: 'dirty', debug: `select=${raw}` };
          // Inspected / Out of Order / Pickup etc. — bucket as clean
          // (room isn't dirty, doesn't need a clean tap). The status
          // preservation logic in refresh-from-pms already protects
          // 'inspected' from being downgraded; we just need the room
          // to NOT show as 'dirty' on the housekeeper page.
          if (norm.startsWith('insp')) return { condition: 'clean', debug: `select=${raw} (inspected→clean)` };
          if (norm.startsWith('out') || norm === 'ooo') return { condition: 'clean', debug: `select=${raw} (ooo→clean)` };
          if (norm.startsWith('pickup') || norm.startsWith('refresh')) return { condition: 'clean', debug: `select=${raw} (other→clean)` };
          // Unrecognized status — surface for review rather than guess.
          return { condition: null, debug: `select-unknown=${raw}` };
        }

        // Strategy 2: legacy class names (pre-Apr-2026 CA layout).
        if (condCell.querySelector('#rcInput .GreenFake, .GreenFake')) {
          return { condition: 'clean', debug: 'GreenFake' };
        }
        if (condCell.querySelector('#rcInput .RedFake, .RedFake')) {
          return { condition: 'dirty', debug: 'RedFake' };
        }

        // Strategy 2: heuristic class names CA might use.
        const greenClassHits = condCell.querySelectorAll(
          '[class*="Green" i], [class*="green-active" i], [class*="clean-active" i]',
        );
        if (greenClassHits.length > 0) return { condition: 'clean', debug: 'class-green' };
        const redClassHits = condCell.querySelectorAll(
          '[class*="Red" i], [class*="red-active" i], [class*="dirty-active" i]',
        );
        if (redClassHits.length > 0) return { condition: 'dirty', debug: 'class-red' };

        // Strategy 3: computed background color. Walk descendants and
        // look for one with a non-transparent, non-white background.
        // Categorize as green or red based on RGB ratio.
        const candidates = condCell.querySelectorAll('*');
        for (const el of candidates) {
          const cs = window.getComputedStyle(el);
          const bg = cs.backgroundColor;
          if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') continue;
          // Parse rgb(r, g, b) or rgba(r, g, b, a). White-ish rejected.
          const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
          if (!m) continue;
          const r = parseInt(m[1], 10);
          const g = parseInt(m[2], 10);
          const b = parseInt(m[3], 10);
          // Skip white / near-white / pure black backgrounds — those
          // are the chrome around the pill, not the pill itself.
          const sum = r + g + b;
          if (sum > 720 || sum < 80) continue;
          // Green dominant: G clearly higher than R and B.
          if (g > r + 30 && g > b + 30) return { condition: 'clean', debug: `green-rgb(${r},${g},${b})` };
          // Red dominant: R clearly higher than G and B.
          if (r > g + 30 && r > b + 30) return { condition: 'dirty', debug: `red-rgb(${r},${g},${b})` };
        }

        // Strategy 4: text-content fallback. Some PMS variants render
        // only one of CLEAN/DIRTY (the active one) as text and the
        // other as a button. innerText returns visible text only.
        const txt = (condCell.innerText || '').trim().toUpperCase();
        if (txt === 'CLEAN') return { condition: 'clean', debug: 'text-only' };
        if (txt === 'DIRTY') return { condition: 'dirty', debug: 'text-only' };

        // Total miss — return sample HTML so we can see what changed.
        // Truncate to keep error messages readable.
        const html = (condCell.outerHTML || '').slice(0, 400);
        return { condition: null, debug: html };
      }

      const out = [];
      let firstMissDebug = null;
      const rows = document.querySelectorAll(`${tableSelector} tr`);
      for (const tr of rows) {
        const cells = tr.querySelectorAll('td');
        // Need cells[CELL.DND] (=7) at minimum. < 8 means partial row.
        if (cells.length < 8) continue;
        const number = (cells[CELL.ROOM_NUMBER].innerText || '').trim();
        if (!/^\d{3,4}$/.test(number)) continue; // skip header / non-data rows

        const { condition, debug } = detectCondition(cells[CELL.CONDITION]);
        if (condition === null && firstMissDebug === null) {
          // On first miss, dump the WHOLE row's HTML so we can see
          // where CA moved the current condition to. Truncate to keep
          // the error response sane.
          const cellSummary = [];
          for (let i = 0; i < cells.length; i++) {
            const txt = (cells[i].innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40);
            const cls = (cells[i].className || '').slice(0, 60);
            cellSummary.push(`[${i}]"${txt}"(class="${cls}")`);
          }
          const rowHtml = (tr.outerHTML || '').slice(0, 1200);
          firstMissDebug = `room=${number} detect=${debug} cells=${cellSummary.join('|')} row-html=${rowHtml}`;
        }

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
      return { rooms: out, firstMissDebug };
    }, { tableSelector: HK_CENTER_TABLE_SELECTOR, CELL });
  } catch (err) {
    throw new ScraperError(
      ERROR_CODES.PARSE_ERROR,
      `HK Center extraction failed: ${err.message}`,
    );
  }

  const rooms = result.rooms;
  if (rooms.length === 0) {
    throw new ScraperError(
      ERROR_CODES.PARSE_ERROR,
      'HK Center parsed zero rooms — CA page layout may have changed',
    );
  }

  // Sanity check: every room must have a condition. If detection
  // failed for any, surface the first row's outerHTML so we can see
  // what CA changed and update the detector.
  const missingCondition = rooms.filter(r => r.condition === null).length;
  if (missingCondition > 0) {
    throw new ScraperError(
      ERROR_CODES.PARSE_ERROR,
      `HK Center: ${missingCondition} of ${rooms.length} rooms had no condition badge — ` +
      `CA layout likely changed. First miss: ${result.firstMissDebug || '(none)'}`,
    );
  }

  const cleanCount = rooms.filter(r => r.condition === 'clean').length;
  const dirtyCount = rooms.filter(r => r.condition === 'dirty').length;
  const tookMs = Date.now() - t0;
  log(`HK Center pull: ${rooms.length} rooms (${cleanCount} clean / ${dirtyCount} dirty) in ${tookMs}ms`);

  return rooms;
}

module.exports = { pullHkCenter };
