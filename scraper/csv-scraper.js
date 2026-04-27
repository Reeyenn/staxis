/**
 * HotelOps AI — CSV Report Scraper
 *
 * Navigates to Choice Advantage → Run → Reports → Housekeeping Check-off List,
 * explicitly sets all filters to capture the FULL property snapshot,
 * checks the CSV export box, downloads the file, parses it, and writes
 * a row to plan_snapshots keyed by (property_id, date).
 *
 * Called from the main scraper loop at 7pm CT (evening plan) and 6am CT (morning confirm).
 */

const path = require('path');
const fs = require('fs');

// ─── Config ──────────────────────────────────────────────────────────────────

const CA_REPORTS_URL = 'https://www.choiceadvantage.com/choicehotels/ReportViewStart.init';
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

// Cleaning time constants.
//
// Stayover cleaning uses a 2-day cycle based on days-since-arrival, computed
// from the CSV's Arrival column. The PMS's "Service = Full/None" flag is
// IGNORED — it reflects Choice's brand cycle, not Comfort's actual practice.
//
//   Checkout                              → 30 min (stayType = C/O always wins)
//   Stayover — odd day of stay (1,3,5…)   → 15 min (light touch, no bed change)
//   Stayover — even day of stay (2,4,6…)  → 20 min (full clean, bed change)
//   Stayover — arrival day (daysSince=0)  →  0 min (TBD — guest checking in today)
//   Vacant Dirty                          → 30 min (turnover)
const CLEANING_TIMES = {
  checkout:     30,
  stayoverDay1: 15,  // odd-numbered day of stay
  stayoverDay2: 20,  // even-numbered day of stay
  vacantDirty:  30,
};
const SHIFT_MINUTES = 480; // 8-hour shift

// ─── Date helpers for stayover cycle math ────────────────────────────────────

/** Parse CSV date "M/D/YY" or "M/D/YYYY" → Date (noon UTC to avoid DST edges). */
function parseCSVDate(str) {
  if (!str) return null;
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let [, mm, dd, yy] = m;
  if (yy.length === 2) yy = '20' + yy;
  return new Date(`${yy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}T12:00:00Z`);
}

/** Whole days from `from` Date → `to` Date (can be negative). */
function daysBetween(from, to) {
  if (!from || !to) return null;
  return Math.round((to - from) / 86400000);
}

/**
 * Classify a stayover room based on its day-of-stay.
 * Returns { day, minutes } where day is 0/1/2/etc. and minutes is the time
 * that should be booked for its cleaning on `dateISO`.
 *
 * Day 0 = arrival day (guest just checking in, no service needed today).
 * Day 1 / 3 / 5 … = light touch (15 min).
 * Day 2 / 4 / 6 … = full clean with bed change (20 min).
 */
function classifyStayover(arrivalStr, dateISO) {
  const arrival = parseCSVDate(arrivalStr);
  const target  = new Date(dateISO + 'T12:00:00Z');
  const day     = daysBetween(arrival, target);

  if (day === null) {
    // Missing arrival date — safest fallback is the lighter rate so we don't
    // over-estimate workload. Log via the returned `unknown` flag.
    return { day: null, minutes: CLEANING_TIMES.stayoverDay1, unknown: true };
  }
  if (day <= 0)               return { day, minutes: 0 };                           // arrival day, TBD
  if (day % 2 === 1)          return { day, minutes: CLEANING_TIMES.stayoverDay1 }; // 15 min light
  return                              { day, minutes: CLEANING_TIMES.stayoverDay2 }; // 20 min full
}

// ─── CSV Parser ──────────────────────────────────────────────────────────────

/**
 * Parse the Housekeeping Check-off List CSV text into structured room objects.
 * CSV columns (14): Room, Type, People, Adults, Children, Status, Condition,
 *                    Stay/C/O, Service, Housekeeper, Special Requests,
 *                    Arrival, Departure, Last Clean
 */
function parseCSV(csvText) {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return [];

  const rooms = [];
  // Skip header row (line 0)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Parse CSV line respecting quoted fields
    const fields = parseCSVLine(line);
    if (fields.length < 14) continue;

    const [
      room, type, people, adults, children,
      status, condition, stayCO, service,
      housekeeper, specialRequests,
      arrival, departure, lastClean
    ] = fields.map(f => f.trim());

    // Skip if no room number
    if (!room || !room.match(/^\d{3,4}$/)) continue;

    rooms.push({
      number: room,
      roomType: type,                          // SNQQ, SNK, HSNK, etc.
      people: people || null,
      adults: parseInt(adults) || 0,
      children: parseInt(children) || 0,
      status: status,                          // OCC, VAC, OOO
      condition: condition,                    // Clean, Dirty
      stayType: stayCO || null,                // Stay, C/O, or blank
      service: service || 'None',              // Full, None
      housekeeper: housekeeper || null,
      specialRequests: specialRequests || null,
      arrival: arrival || null,
      departure: departure || null,
      lastClean: lastClean || null,
    });
  }

  return rooms;
}

/**
 * Parse a single CSV line, handling quoted fields with commas inside.
 */
function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current); // last field
  return fields;
}

// ─── Snapshot Builder ────────────────────────────────────────────────────────

/**
 * Build an in-memory snapshot from parsed room data. Shape matches
 * plan_snapshots table columns in camelCase — the writer converts to
 * snake_case when upserting.
 */
function buildSnapshot(rooms, pullType, dateISO /*, timezone */) {
  // All rooms with C/O flag (checked out today, regardless of clean/dirty)
  const checkoutRooms = rooms.filter(r => r.stayType === 'C/O');
  // Stayovers: occupied rooms staying
  const stayoverRooms = rooms.filter(r => r.status === 'OCC' && r.stayType === 'Stay');
  const vacantClean   = rooms.filter(r => r.status === 'VAC' && r.condition === 'Clean');
  const vacantDirty   = rooms.filter(r => r.status === 'VAC' && r.condition === 'Dirty');
  const oooRooms      = rooms.filter(r => r.status === 'OOO');

  // Arrivals: OCC rooms with blank stayType (just checked in, no Stay/C/O yet)
  const arrivalRooms = rooms.filter(r => r.status === 'OCC' && !r.stayType);

  // ── Classify each stayover by day-of-stay ────────────────────────────────
  // 2-day cycle based on Arrival date, ignoring the PMS's Service flag.
  //   Day 1, 3, 5, …  → light touch    (15 min)
  //   Day 2, 4, 6, …  → full w/ bed    (20 min)
  //   Day 0           → arrival day, skipped (TBD)
  //   Unknown arrival → default to 15 min, flagged for review
  const stayoverClassified = stayoverRooms.map(r => ({
    room: r,
    ...classifyStayover(r.arrival, dateISO),
  }));

  const stayoverDay1Rooms  = stayoverClassified.filter(c => c.day !== null && c.day >  0 && c.day % 2 === 1);
  const stayoverDay2Rooms  = stayoverClassified.filter(c => c.day !== null && c.day >  0 && c.day % 2 === 0);
  const stayoverArrivalDay = stayoverClassified.filter(c => c.day !== null && c.day <= 0);
  const stayoverUnknownDay = stayoverClassified.filter(c => c.unknown);

  // ── Calculate cleaning workload ──────────────────────────────────────────
  // Only count DIRTY rooms — clean ones are already done today.
  //
  // NOTE: On the 6am morning pull, most rooms show Dirty (nobody's cleaned yet).
  // That gives the accurate workload. Mid-day pulls show partially cleaned counts.

  const dirtyCheckouts    = checkoutRooms.filter(r => r.condition === 'Dirty');
  const dirtyStayoverDay1 = stayoverDay1Rooms.filter(c => c.room.condition === 'Dirty');
  const dirtyStayoverDay2 = stayoverDay2Rooms.filter(c => c.room.condition === 'Dirty');

  const checkoutMinutes     = dirtyCheckouts.length    * CLEANING_TIMES.checkout;      // 30 min
  const stayoverDay1Minutes = dirtyStayoverDay1.length * CLEANING_TIMES.stayoverDay1;  // 15 min
  const stayoverDay2Minutes = dirtyStayoverDay2.length * CLEANING_TIMES.stayoverDay2;  // 20 min
  const vacantDirtyMinutes  = vacantDirty.length       * CLEANING_TIMES.vacantDirty;   // 30 min turnover

  const totalCleaningMinutes = checkoutMinutes + stayoverDay1Minutes + stayoverDay2Minutes + vacantDirtyMinutes;
  const recommendedHKs       = Math.max(1, Math.ceil(totalCleaningMinutes / SHIFT_MINUTES));

  return {
    date: dateISO,
    pulledAt: new Date().toISOString(),
    pullType,                              // "evening" or "morning"
    totalRooms: rooms.length,

    // Counts
    checkouts:          checkoutRooms.length,
    stayovers:          stayoverRooms.length,
    stayoverDay1:       stayoverDay1Rooms.length,    // odd day  → light (15 min)
    stayoverDay2:       stayoverDay2Rooms.length,    // even day → full  (20 min)
    stayoverArrivalDay: stayoverArrivalDay.length,   // day 0 — skipped, TBD
    stayoverUnknown:    stayoverUnknownDay.length,   // no arrival date on CSV
    arrivals:           arrivalRooms.length,
    vacantClean:        vacantClean.length,
    vacantDirty:        vacantDirty.length,
    ooo:                oooRooms.length,

    // Workload breakdown
    checkoutMinutes,
    stayoverDay1Minutes,
    stayoverDay2Minutes,
    vacantDirtyMinutes,
    totalCleaningMinutes,
    recommendedHKs,

    // Room lists (just room numbers for quick reference)
    checkoutRoomNumbers:        checkoutRooms.map(r => r.number),
    stayoverDay1RoomNumbers:    stayoverDay1Rooms.map(c => c.room.number),
    stayoverDay2RoomNumbers:    stayoverDay2Rooms.map(c => c.room.number),
    stayoverArrivalRoomNumbers: stayoverArrivalDay.map(c => c.room.number),
    arrivalRoomNumbers:         arrivalRooms.map(r => r.number),
    vacantCleanRoomNumbers:     vacantClean.map(r => r.number),
    vacantDirtyRoomNumbers:     vacantDirty.map(r => r.number),
    oooRoomNumbers:             oooRooms.map(r => r.number),

    // Full room data array (for detailed view) — stored as jsonb in Postgres.
    // Stayovers carry their classified day + minutes so the UI can show them.
    rooms: rooms.map(r => {
      const base = {
        number:      r.number,
        roomType:    r.roomType,
        status:      r.status,
        condition:   r.condition,
        stayType:    r.stayType,
        service:     r.service,
        adults:      r.adults,
        children:    r.children,
        housekeeper: r.housekeeper,
        arrival:     r.arrival,
        departure:   r.departure,
        lastClean:   r.lastClean,
      };
      if (r.status === 'OCC' && r.stayType === 'Stay') {
        const cls = classifyStayover(r.arrival, dateISO);
        base.stayoverDay     = cls.day;          // 0, 1, 2, 3, …
        base.stayoverMinutes = cls.minutes;      // 0, 15, or 20
      }
      return base;
    }),
  };
}

// ─── Browser Automation ──────────────────────────────────────────────────────

/**
 * Navigate to CA Reports, set all filters, download the CSV, and return the raw text.
 */
async function downloadCSVFromCA(page, log) {
  log('[CSV] Navigating to Reports page...');
  await page.goto(CA_REPORTS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Check if we got redirected to login
  if (page.url().includes('sign_in') || page.url().includes('Welcome')) {
    throw new Error('Session expired — need to re-login before CSV pull');
  }

  log(`[CSV] On reports page: ${page.url()}`);

  // Wait for the page to fully load
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  // Dismiss any data discrepancy dialogs
  try {
    const okButton = page.locator('button:has-text("OK"), input[value="OK"]');
    if (await okButton.count() > 0) {
      await okButton.first().click();
      log('[CSV] Dismissed data discrepancy dialog');
      await page.waitForTimeout(500);
    }
  } catch (e) {
    // No dialog to dismiss — fine
  }

  // Click "Housekeeping Check-off List" link
  log('[CSV] Looking for Housekeeping Check-off List link...');
  const hkLink = page.locator('a:has-text("Housekeeping Check-off List")').first();
  await hkLink.waitFor({ timeout: 10000 });
  await hkLink.click();
  log('[CSV] Clicked Housekeeping Check-off List');

  // Wait for the report form to load
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000); // CA forms can be slow

  // ── Set all filters explicitly (never trust defaults / sticky state) ──
  // Status: Select All
  await page.selectOption('select[name="status"]', '*');
  log('[CSV] Set Status → Select All');

  // Condition: Select All (default is "Dirty" — must override)
  await page.selectOption('select[name="condition"]', '*');
  log('[CSV] Set Condition → Select All');

  // Housekeeper: Select All
  await page.selectOption('select[name="housekeeper"]', '*');
  log('[CSV] Set Housekeeper → Select All');

  // Room Range: 101 – 422
  await page.fill('input[name="roomRangeStartField"]', '101');
  await page.fill('input[name="roomRangeEndField"]', '422');
  log('[CSV] Set Room Range → 101–422');

  // Sort: Room Number
  await page.selectOption('select[name="sort"]', 'room_number');
  log('[CSV] Set Sort → Room Number');

  // CSV export checkbox.
  //
  // History — two distinct breakages from the same root cause:
  //   1) Some time before 2026-04-27, CA renamed/removed `#CSVcheckbox` and
  //      the original `csvBox.check()` started timing out at 30s.
  //   2) After we added a fallback selector list, CA STILL has an element
  //      with id="CSVcheckbox" sitting in the DOM, but it's hidden or
  //      disabled — `count() > 0` returns true (selector "matches") but
  //      `.check()` times out waiting for the element to become actionable.
  //      My old loop stopped at the first matching count and never tried
  //      the other selectors, so the fall-through never engaged.
  //
  // New strategy: try each selector AND attempt to check the box.
  // Only on full success do we move on. On failure (selector misses,
  // element not actionable, click blocked, etc.) try the next selector.
  // If every selector fails, escalate through force-click and finally a
  // JS-direct `el.checked = true` + dispatch change, then dump the page
  // HTML for diagnosis.
  const CSV_SELECTORS = [
    '#CSVcheckbox:visible',                            // legacy id, only if visible
    '#CSVcheckbox',                                    // legacy id, any
    'input[type="checkbox"][id*="CSV" i]:visible',
    'input[type="checkbox"][name*="csv" i]:visible',
    'input[type="checkbox"][value*="csv" i]:visible',
    'label:has-text("CSV") >> input[type="checkbox"]',
    'label:has-text("Export") >> input[type="checkbox"]',
    // Last-resort: any visible checkbox whose nearby text mentions CSV.
    'input[type="checkbox"]:visible',
  ];

  // Snapshot the form NOW so we have a screenshot regardless of how this
  // resolves below.
  await page.screenshot({ path: path.join(__dirname, 'csv-report-form.png') });

  // Try every selector. For each, attempt:
  //   1) standard .check()
  //   2) .check({ force: true })  (bypasses actionability checks)
  //   3) JS-direct checkbox.checked = true + change event
  // Whichever succeeds wins.
  async function tryCheck(locator) {
    try {
      if (await locator.isChecked()) return true;
    } catch { /* not a checkbox or detached — fall through */ }
    try {
      await locator.check({ timeout: 5000 });
      return true;
    } catch { /* try harder */ }
    try {
      await locator.check({ timeout: 3000, force: true });
      return true;
    } catch { /* try hardest */ }
    try {
      await locator.evaluate((el) => {
        if (el && 'checked' in el) {
          el.checked = true;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      // Verify it actually became checked
      const ok = await locator.evaluate((el) => !!(el && el.checked));
      if (ok) return true;
    } catch { /* nothing left to try */ }
    return false;
  }

  let csvSelectorUsed = null;
  for (const sel of CSV_SELECTORS) {
    let candidate;
    try {
      candidate = page.locator(sel).first();
    } catch {
      continue;  // malformed selector — skip
    }
    let count = 0;
    try { count = await candidate.count(); } catch { continue; }
    if (count === 0) continue;

    if (await tryCheck(candidate)) {
      csvSelectorUsed = sel;
      log(`[CSV] Checked CSV export box (selector: ${sel})`);
      break;
    }
    log(`[CSV] selector matched but couldn't be checked: ${sel} (trying next)`);
  }

  if (!csvSelectorUsed) {
    // All approaches failed. Dump the page HTML and a screenshot so we can
    // figure out the new layout offline.
    try {
      const html = await page.content();
      fs.writeFileSync(path.join(__dirname, 'csv-form-dump.html'), html);
      log('[CSV] saved csv-form-dump.html for selector diagnosis');
    } catch (e) {
      log(`[CSV] could not dump form HTML: ${e.message}`);
    }
    // Also pull a list of every checkbox on the page (id, name, visible)
    // and include in the error message so the upstream alert is useful.
    let inventory = [];
    try {
      inventory = await page.evaluate(() =>
        Array.from(document.querySelectorAll('input[type="checkbox"]')).map((el) => ({
          id: el.id || null,
          name: el.name || null,
          value: el.value || null,
          visible: !!(el.offsetWidth || el.offsetHeight),
          disabled: !!el.disabled,
        })).slice(0, 20)
      );
    } catch { /* ignore */ }
    throw new Error(
      `CSV export checkbox not actionable. Tried selectors: ${CSV_SELECTORS.join(' | ')}. ` +
      `Checkboxes on page: ${JSON.stringify(inventory)}. ` +
      `See csv-form-dump.html for full HTML.`
    );
  }

  // Set up download interception BEFORE clicking Submit
  // CA opens the CSV in a new tab/window or triggers a download
  const downloadPromise = page.waitForEvent('download', { timeout: 30000 }).catch(() => null);

  // Also listen for new popup window (CA sometimes opens CSV in new tab)
  const popupPromise = page.waitForEvent('popup', { timeout: 30000 }).catch(() => null);

  // Click Submit. CA used to render Submit as an <a>, then changed to a
  // styled <button>, then changed the visible text on us. Same selector-
  // fragility story as the CSV checkbox. Try a list, fall through on
  // both selector misses AND click failures, end with a JS-direct click
  // and finally an exhaustive form submit, then dump diagnostic state.
  const SUBMIT_SELECTORS = [
    'a:has-text("Submit"):visible',
    'button:has-text("Submit"):visible',
    'input[type="submit"][value*="Submit" i]:visible',
    'a:has-text("Run Report"):visible',
    'button:has-text("Run Report"):visible',
    'a:has-text("Generate"):visible',
    'button:has-text("Generate"):visible',
    'a:has-text("Export"):visible',
    'button:has-text("Export"):visible',
    'a:has-text("Submit")',           // any matching, ignore visibility
    'button:has-text("Submit")',
    'input[type="submit"]',           // generic submit input
  ];

  async function tryClick(locator) {
    try { await locator.click({ timeout: 5000 }); return true; } catch { /* try harder */ }
    try { await locator.click({ timeout: 3000, force: true }); return true; } catch { /* try hardest */ }
    try {
      await locator.evaluate((el) => { if (el && typeof el.click === 'function') el.click(); });
      return true;
    } catch { return false; }
  }

  let submitSelectorUsed = null;
  for (const sel of SUBMIT_SELECTORS) {
    let candidate;
    try { candidate = page.locator(sel).first(); } catch { continue; }
    let count = 0;
    try { count = await candidate.count(); } catch { continue; }
    if (count === 0) continue;
    if (await tryClick(candidate)) {
      submitSelectorUsed = sel;
      log(`[CSV] Clicked Submit (selector: ${sel})`);
      break;
    }
    log(`[CSV] submit selector matched but click failed: ${sel} (trying next)`);
  }

  if (!submitSelectorUsed) {
    // Last-resort: submit the form via JS directly. Find the form holding
    // the CSV checkbox and call .submit() on it.
    let formSubmitted = false;
    try {
      formSubmitted = await page.evaluate(() => {
        const cb = document.querySelector('#CSVcheckbox') || document.querySelector('input[type="checkbox"][id*="CSV" i]');
        const form = cb ? cb.closest('form') : (document.forms[0] || null);
        if (form && typeof form.submit === 'function') { form.submit(); return true; }
        return false;
      });
    } catch { /* ignore */ }
    if (formSubmitted) {
      submitSelectorUsed = 'form.submit() via JS';
      log('[CSV] Submitted form directly via JS as last resort');
    } else {
      // Dump diagnostics for the upstream alert and bail.
      try {
        const html = await page.content();
        fs.writeFileSync(path.join(__dirname, 'csv-form-dump.html'), html);
        log('[CSV] saved csv-form-dump.html for selector diagnosis');
      } catch (e) {
        log(`[CSV] could not dump form HTML: ${e.message}`);
      }
      let buttonInventory = [];
      try {
        buttonInventory = await page.evaluate(() =>
          Array.from(document.querySelectorAll('a, button, input[type="submit"]')).map((el) => ({
            tag: el.tagName.toLowerCase(),
            text: (el.textContent || el.value || '').trim().slice(0, 60),
            id: el.id || null,
            visible: !!(el.offsetWidth || el.offsetHeight),
          })).filter(b => b.text).slice(0, 30)
        );
      } catch { /* ignore */ }
      throw new Error(
        `Submit control not actionable on the report form. ` +
        `Tried: ${SUBMIT_SELECTORS.join(' | ')}. ` +
        `Buttons/links visible: ${JSON.stringify(buttonInventory)}. ` +
        `See csv-form-dump.html for full HTML.`
      );
    }
  }

  // Wait for either a download or a popup
  const [download, popup] = await Promise.all([
    downloadPromise,
    popupPromise,
  ]);

  let csvText = '';

  if (download) {
    // Direct download — save and read
    log('[CSV] Got download event');
    if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    const downloadPath = path.join(DOWNLOAD_DIR, 'report.csv');
    await download.saveAs(downloadPath);
    csvText = fs.readFileSync(downloadPath, 'utf-8');
    log(`[CSV] Downloaded ${csvText.length} bytes`);
  } else if (popup) {
    // CSV opened in new tab — grab the page content
    log('[CSV] Got popup/new tab');
    await popup.waitForLoadState('domcontentloaded', { timeout: 15000 });
    csvText = await popup.evaluate(() => document.body.innerText || document.body.textContent || '');
    await popup.close();
    log(`[CSV] Got ${csvText.length} bytes from popup`);
  } else {
    // Neither — try reading from current page (maybe it loaded inline)
    log('[CSV] No download or popup — trying to read from current page');
    await page.waitForTimeout(3000);

    // Check if a new tab was opened
    const pages = page.context().pages();
    if (pages.length > 1) {
      const lastPage = pages[pages.length - 1];
      await lastPage.waitForLoadState('domcontentloaded', { timeout: 10000 });
      csvText = await lastPage.evaluate(() => document.body.innerText || document.body.textContent || '');
      log(`[CSV] Got ${csvText.length} bytes from last tab`);
    } else {
      // Try reading response body or page content
      csvText = await page.evaluate(() => {
        const pre = document.querySelector('pre');
        if (pre) return pre.textContent;
        return document.body.innerText || '';
      });
      log(`[CSV] Got ${csvText.length} bytes from current page`);
    }
  }

  if (!csvText || csvText.length < 50) {
    await page.screenshot({ path: path.join(__dirname, 'csv-download-fail.png') });
    throw new Error('CSV download failed — no content received');
  }

  // Validate it looks like a CSV (first line should have "Room" header)
  if (!csvText.includes('"Room"') && !csvText.includes('Room,')) {
    await page.screenshot({ path: path.join(__dirname, 'csv-bad-content.png') });
    log(`[CSV] Content preview: ${csvText.substring(0, 200)}`);
    // Persist the response body so we can read it from outside Railway
    // (i.e. in Supabase scraper_status when this error bubbles up).
    try {
      fs.writeFileSync(path.join(__dirname, 'csv-bad-content.txt'), csvText);
    } catch { /* best effort */ }
    // Inline a 600-char preview into the error message so the upstream
    // scraper_status row carries enough context for us to act on without
    // logging into Railway. Strip newlines so the alert SMS doesn't
    // explode on multi-line content.
    const preview = csvText
      .replace(/\s+/g, ' ')
      .substring(0, 600);
    throw new Error(
      `Downloaded content is not CSV (got ${csvText.length} bytes). ` +
      `Preview: ${preview}`
    );
  }

  return csvText;
}

// ─── Supabase Writers ────────────────────────────────────────────────────────

/**
 * Upsert a plan_snapshots row for (property_id, date). Each hourly pull
 * overwrites the previous pull's row for the same date — the writer always
 * stores the most recent view of the plan. No merge required: every column
 * is recomputed from the CSV each pull.
 */
async function writePlanSnapshot(supabase, config, snapshot, log) {
  const row = {
    property_id:                   config.PROPERTY_ID,
    date:                          snapshot.date,
    pulled_at:                     snapshot.pulledAt,
    pull_type:                     snapshot.pullType,
    total_rooms:                   snapshot.totalRooms,
    checkouts:                     snapshot.checkouts,
    stayovers:                     snapshot.stayovers,
    stayover_day1:                 snapshot.stayoverDay1,
    stayover_day2:                 snapshot.stayoverDay2,
    stayover_arrival_day:          snapshot.stayoverArrivalDay,
    stayover_unknown:              snapshot.stayoverUnknown,
    arrivals:                      snapshot.arrivals,
    vacant_clean:                  snapshot.vacantClean,
    vacant_dirty:                  snapshot.vacantDirty,
    ooo:                           snapshot.ooo,
    checkout_minutes:              snapshot.checkoutMinutes,
    stayover_day1_minutes:         snapshot.stayoverDay1Minutes,
    stayover_day2_minutes:         snapshot.stayoverDay2Minutes,
    vacant_dirty_minutes:          snapshot.vacantDirtyMinutes,
    total_cleaning_minutes:        snapshot.totalCleaningMinutes,
    recommended_hks:               snapshot.recommendedHKs,
    checkout_room_numbers:         snapshot.checkoutRoomNumbers,
    stayover_day1_room_numbers:    snapshot.stayoverDay1RoomNumbers,
    stayover_day2_room_numbers:    snapshot.stayoverDay2RoomNumbers,
    stayover_arrival_room_numbers: snapshot.stayoverArrivalRoomNumbers,
    arrival_room_numbers:          snapshot.arrivalRoomNumbers,
    vacant_clean_room_numbers:     snapshot.vacantCleanRoomNumbers,
    vacant_dirty_room_numbers:     snapshot.vacantDirtyRoomNumbers,
    ooo_room_numbers:              snapshot.oooRoomNumbers,
    rooms:                         snapshot.rooms,
  };

  const { error } = await supabase
    .from('plan_snapshots')
    .upsert(row, { onConflict: 'property_id,date' });
  if (error) throw error;

  log(`[CSV] plan_snapshots upserted — ${snapshot.date} / ${snapshot.totalRooms} rooms, ${snapshot.checkouts} C/Os, ${snapshot.stayovers} stays (D1:${snapshot.stayoverDay1} / D2:${snapshot.stayoverDay2} / arrival:${snapshot.stayoverArrivalDay}), rec ${snapshot.recommendedHKs} HKs`);
}

/**
 * Merge stayover-cycle fields (arrival, stayover_day, stayover_minutes) into
 * EXISTING rows in the rooms table. We deliberately use UPDATE-only (no
 * INSERT) because:
 *
 *   1. The rooms.type column is NOT NULL with a CHECK constraint — inserting
 *      a bare stayover-cycle row without a proper type would fail or pollute
 *      the table with half-specified rooms.
 *   2. The canonical room-creation flow is populate-rooms-from-plan / the
 *      send-shift-confirmations route, which set every required field. This
 *      writer is a best-effort enhancement; if the target row doesn't exist
 *      yet, populate-rooms-from-plan will re-read the same stayover data
 *      directly from plan_snapshots.rooms when it creates the row.
 *
 * Runs all updates in parallel. Each row is matched by (property_id, date,
 * number) via the composite unique index. Missing rows are silently skipped
 * (update with no matching row is a no-op in Postgres).
 */
async function writeRoomStayoverDays(supabase, config, snapshot, log) {
  const propertyId = config.PROPERTY_ID;
  const date = snapshot.date;

  const updates = [];
  for (const r of snapshot.rooms) {
    if (!r.number) continue;
    const patch = { arrival: r.arrival ?? null };
    if (typeof r.stayoverDay !== 'undefined')    patch.stayover_day     = r.stayoverDay;
    if (typeof r.stayoverMinutes !== 'undefined') patch.stayover_minutes = r.stayoverMinutes;
    updates.push(
      supabase
        .from('rooms')
        .update(patch)
        .eq('property_id', propertyId)
        .eq('date', date)
        .eq('number', r.number)
    );
  }

  const results = await Promise.all(updates.map(q => q.then(r => r, err => ({ error: err }))));
  let errored = 0;
  for (const r of results) {
    if (r?.error) errored++;
  }
  log(`[CSV] Merged stayover cycle fields into rooms (${updates.length} attempted, ${errored} errored — missing rows are no-ops)`);
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Full CSV scrape cycle: download → parse → build snapshot → write to Supabase.
 *
 * @param {import('playwright').Page} page       — authenticated CA page
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {object} config   — { PROPERTY_ID, TIMEZONE }
 * @param {string} pullType — "evening" or "morning"
 * @param {function} log
 */
async function runCSVScrape(page, supabase, config, pullType, log) {
  log(`[CSV] === Starting ${pullType} CSV scrape ===`);

  const timezone = config.TIMEZONE || 'America/Chicago';

  // Determine target date:
  // Evening (7pm) pull → planning for TOMORROW
  // Morning (6am) pull → confirming for TODAY
  let targetDate;
  if (pullType === 'evening') {
    const tmr = new Date(Date.now() + 24 * 60 * 60 * 1000);
    targetDate = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(tmr);
  } else {
    targetDate = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  }

  log(`[CSV] Target date: ${targetDate} (${pullType} pull)`);

  try {
    // Step 1: Download CSV from CA
    const csvText = await downloadCSVFromCA(page, log);

    // Step 2: Parse
    const rooms = parseCSV(csvText);
    log(`[CSV] Parsed ${rooms.length} rooms from CSV`);

    if (rooms.length === 0) {
      throw new Error('Parsed 0 rooms from CSV — file may be malformed');
    }

    // Sanity guard: Comfort Suites Beaumont has 74 rooms. If we got back
    // significantly fewer, something is wrong — CA might have filtered the
    // report, the DOM might have changed, or the download is partial. Refuse
    // to overwrite the existing plan with bad data: stale-but-right beats
    // fresh-but-wrong.
    const MIN_EXPECTED_ROOMS = parseInt(process.env.MIN_EXPECTED_ROOMS || '60', 10);
    if (rooms.length < MIN_EXPECTED_ROOMS) {
      throw new Error(
        `Only ${rooms.length} rooms parsed — expected ~74 (min ${MIN_EXPECTED_ROOMS}). ` +
        `Refusing to overwrite plan_snapshots with suspiciously small dataset.`
      );
    }

    // Step 3: Build snapshot
    const snapshot = buildSnapshot(rooms, pullType, targetDate, timezone);

    // Step 4: Save raw CSV to disk (backup)
    const timestamp = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date()).replace(/[,\s]+/g, '_');

    if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(DOWNLOAD_DIR, `${targetDate}_${pullType}.csv`), csvText);
    log(`[CSV] Saved backup: ${targetDate}_${pullType}.csv`);

    // Step 5: Write to Supabase
    await writePlanSnapshot(supabase, config, snapshot, log);

    // Step 6: Merge stayover-cycle fields into individual rooms rows so the
    // live UI (housekeeping schedule tab) can read per-room cycle day.
    try {
      await writeRoomStayoverDays(supabase, config, snapshot, log);
    } catch (err) {
      // Non-fatal: snapshot is still written, UI falls back to legacy minutes.
      log(`[CSV] WARNING: room stayoverDay merge failed: ${err.message}`);
    }

    log(`[CSV] === ${pullType} CSV scrape complete ===`);
    return snapshot;
  } catch (err) {
    log(`[CSV] ERROR during ${pullType} scrape: ${err.message}`);
    // Save a debug screenshot
    try {
      await page.screenshot({ path: path.join(__dirname, `csv-error-${pullType}.png`) });
    } catch (_) {}
    throw err;
  }
}

module.exports = {
  runCSVScrape,
  parseCSV,
  buildSnapshot,
  downloadCSVFromCA,
  classifyStayover,  // exported for unit testing / UI reuse
  CLEANING_TIMES,
};
