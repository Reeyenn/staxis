/**
 * HotelOps AI — CSV Report Scraper
 *
 * Navigates to Choice Advantage → Run → Reports → Housekeeping Check-off List,
 * explicitly sets all filters to capture the FULL property snapshot,
 * checks the CSV export box, downloads the file, parses it, and writes
 * a planSnapshot/{YYYY-MM-DD} document to Firestore.
 *
 * Called from the main scraper loop at 7pm CT (evening plan) and 6am CT (morning confirm).
 */

const { Timestamp } = require('firebase-admin/firestore');
const path = require('path');
const fs = require('fs');

// ─── Config ──────────────────────────────────────────────────────────────────

const CA_REPORTS_URL = 'https://www.choiceadvantage.com/choicehotels/ReportViewStart.init';
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

// Cleaning time constants (same as scheduler.js)
const CLEANING_TIMES = { checkout: 30, stayover: 20 };
const SHIFT_MINUTES = 480; // 8-hour shift

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
 * Build a planSnapshot document from parsed room data.
 */
function buildSnapshot(rooms, pullType, dateISO, timezone) {
  const checkoutRooms = rooms.filter(r => r.stayType === 'C/O' || (r.status === 'VAC' && r.condition === 'Dirty' && !r.stayType));
  const stayoverRooms = rooms.filter(r => r.status === 'OCC' && r.stayType === 'Stay');
  const fullServiceRooms = stayoverRooms.filter(r => r.service === 'Full');
  const noneServiceRooms = stayoverRooms.filter(r => r.service === 'None');
  const vacantClean = rooms.filter(r => r.status === 'VAC' && r.condition === 'Clean');
  const vacantDirty = rooms.filter(r => r.status === 'VAC' && r.condition === 'Dirty');
  const oooRooms = rooms.filter(r => r.status === 'OOO');

  // Arrivals: OCC rooms with blank stayType (just checked in, no Stay/C/O yet)
  const arrivalRooms = rooms.filter(r => r.status === 'OCC' && !r.stayType);

  // Calculate cleaning workload
  // Checkouts: full turnover clean
  // Full-service stayovers: full clean
  // None-service stayovers: light touch (but still need some attention)
  const checkoutMinutes = checkoutRooms.length * CLEANING_TIMES.checkout;
  const stayoverMinutes = fullServiceRooms.length * CLEANING_TIMES.stayover;
  // Vacant dirty rooms also need turnover
  const vacantDirtyMinutes = vacantDirty.length * CLEANING_TIMES.checkout;
  const totalCleaningMinutes = checkoutMinutes + stayoverMinutes + vacantDirtyMinutes;
  const recommendedHKs = Math.max(1, Math.ceil(totalCleaningMinutes / SHIFT_MINUTES));

  return {
    date: dateISO,
    pulledAt: Timestamp.now(),
    pullType,                              // "evening" or "morning"
    totalRooms: rooms.length,

    // Counts
    checkouts: checkoutRooms.length,
    stayovers: stayoverRooms.length,
    fullServiceStayovers: fullServiceRooms.length,
    noneServiceStayovers: noneServiceRooms.length,
    arrivals: arrivalRooms.length,
    vacantClean: vacantClean.length,
    vacantDirty: vacantDirty.length,
    ooo: oooRooms.length,

    // Workload
    totalCleaningMinutes,
    recommendedHKs,

    // Room lists (just room numbers for quick reference)
    checkoutRoomNumbers: checkoutRooms.map(r => r.number),
    stayoverFullRoomNumbers: fullServiceRooms.map(r => r.number),
    stayoverNoneRoomNumbers: noneServiceRooms.map(r => r.number),
    arrivalRoomNumbers: arrivalRooms.map(r => r.number),
    vacantCleanRoomNumbers: vacantClean.map(r => r.number),
    oooRoomNumbers: oooRooms.map(r => r.number),

    // Full room data array (for detailed view)
    rooms: rooms.map(r => ({
      number: r.number,
      roomType: r.roomType,
      status: r.status,
      condition: r.condition,
      stayType: r.stayType,
      service: r.service,
      adults: r.adults,
      children: r.children,
      housekeeper: r.housekeeper,
      arrival: r.arrival,
      departure: r.departure,
      lastClean: r.lastClean,
    })),
  };
}

// ─── Browser Automation ──────────────────────────────────────────────────────

/**
 * Navigate to CA Reports, set all filters, download the CSV, and return the raw text.
 *
 * @param {import('playwright').Page} page — authenticated CA session
 * @param {function} log — logging function
 * @returns {string} CSV file contents
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
  // It appears in the TOP 10 LIST section and in Housekeeping Reports
  log('[CSV] Looking for Housekeeping Check-off List link...');
  const hkLink = page.locator('a:has-text("Housekeeping Check-off List")').first();
  await hkLink.waitFor({ timeout: 10000 });
  await hkLink.click();
  log('[CSV] Clicked Housekeeping Check-off List');

  // Wait for the report form to load
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000); // CA forms can be slow

  // ── Set all filters explicitly (never trust defaults / sticky state) ──

  // Room Range: 101 to 422
  try {
    const roomFrom = page.locator('input[name="roomFrom"], input[name="startRoom"], #roomFrom, #startRoom').first();
    const roomTo = page.locator('input[name="roomTo"], input[name="endRoom"], #roomTo, #endRoom').first();
    if (await roomFrom.count() > 0) {
      await roomFrom.fill('101');
      log('[CSV] Set room range start: 101');
    }
    if (await roomTo.count() > 0) {
      await roomTo.fill('422');
      log('[CSV] Set room range end: 422');
    }
  } catch (e) {
    log(`[CSV] Room range fields not found (may use different names): ${e.message}`);
  }

  // Status dropdown: "Select All" (not just OCC or VAC)
  try {
    const statusSelect = page.locator('select[name="roomStatus"], select[name="status"], #roomStatus, #status').first();
    if (await statusSelect.count() > 0) {
      // Try common values for "all"
      const options = await statusSelect.locator('option').allTextContents();
      log(`[CSV] Status options: ${options.join(', ')}`);
      const allOption = options.find(o => /select all|all/i.test(o));
      if (allOption) {
        await statusSelect.selectOption({ label: allOption });
      } else {
        // Just select the first option which is usually "Select All" or blank
        await statusSelect.selectOption({ index: 0 });
      }
      log('[CSV] Set Status to Select All');
    }
  } catch (e) {
    log(`[CSV] Status select issue: ${e.message}`);
  }

  // Condition dropdown: "Select All" (not just Dirty)
  try {
    const condSelect = page.locator('select[name="condition"], select[name="roomCondition"], #condition, #roomCondition').first();
    if (await condSelect.count() > 0) {
      const options = await condSelect.locator('option').allTextContents();
      log(`[CSV] Condition options: ${options.join(', ')}`);
      const allOption = options.find(o => /select all|all/i.test(o));
      if (allOption) {
        await condSelect.selectOption({ label: allOption });
      } else {
        await condSelect.selectOption({ index: 0 });
      }
      log('[CSV] Set Condition to Select All');
    }
  } catch (e) {
    log(`[CSV] Condition select issue: ${e.message}`);
  }

  // Housekeeper dropdown: "Select All"
  try {
    const hkSelect = page.locator('select[name="housekeeper"], select[name="assignedTo"], #housekeeper, #assignedTo').first();
    if (await hkSelect.count() > 0) {
      const options = await hkSelect.locator('option').allTextContents();
      const allOption = options.find(o => /select all|all/i.test(o));
      if (allOption) {
        await hkSelect.selectOption({ label: allOption });
      } else {
        await hkSelect.selectOption({ index: 0 });
      }
      log('[CSV] Set Housekeeper to Select All');
    }
  } catch (e) {
    log(`[CSV] Housekeeper select issue: ${e.message}`);
  }

  // Sort by Room Number
  try {
    const sortSelect = page.locator('select[name="sort"], select[name="sortBy"], #sort, #sortBy').first();
    if (await sortSelect.count() > 0) {
      const options = await sortSelect.locator('option').allTextContents();
      const roomOpt = options.find(o => /room/i.test(o));
      if (roomOpt) {
        await sortSelect.selectOption({ label: roomOpt });
      }
      log('[CSV] Set Sort to Room Number');
    }
  } catch (e) {
    log(`[CSV] Sort select issue: ${e.message}`);
  }

  // Check the "Generate report as .CSV file" checkbox
  try {
    const csvCheckbox = page.locator('input[type="checkbox"][name*="csv"], input[type="checkbox"][name*="CSV"], input[type="checkbox"][id*="csv"], input[type="checkbox"][id*="CSV"]').first();
    if (await csvCheckbox.count() > 0) {
      if (!(await csvCheckbox.isChecked())) {
        await csvCheckbox.check();
      }
      log('[CSV] Checked CSV export box');
    } else {
      // Try finding by label text
      const csvLabel = page.locator('label:has-text("CSV"), label:has-text("csv")').first();
      if (await csvLabel.count() > 0) {
        await csvLabel.click();
        log('[CSV] Clicked CSV label');
      } else {
        log('[CSV] WARNING: Could not find CSV checkbox — report may come as HTML');
      }
    }
  } catch (e) {
    log(`[CSV] CSV checkbox issue: ${e.message}`);
  }

  // Screenshot for debugging before submit
  await page.screenshot({ path: path.join(__dirname, 'csv-report-form.png') });
  log('[CSV] Saved form screenshot');

  // Set up download interception BEFORE clicking Submit
  // CA opens the CSV in a new tab/window or triggers a download
  const downloadPromise = page.waitForEvent('download', { timeout: 30000 }).catch(() => null);

  // Also listen for new popup window (CA sometimes opens CSV in new tab)
  const popupPromise = page.waitForEvent('popup', { timeout: 30000 }).catch(() => null);

  // Click Submit
  const submitBtn = page.locator('input[type="submit"], button[type="submit"], input[value="Submit"], a:has-text("Submit")').first();
  await submitBtn.click();
  log('[CSV] Clicked Submit');

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
    throw new Error('Downloaded content does not look like a CSV');
  }

  return csvText;
}

// ─── Firestore Writer ────────────────────────────────────────────────────────

/**
 * Write a planSnapshot document to Firestore.
 *
 * Path: users/{userId}/properties/{propertyId}/planSnapshots/{dateISO}
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} config — { USER_ID, PROPERTY_ID, TIMEZONE }
 * @param {object} snapshot — from buildSnapshot()
 * @param {function} log
 */
async function writePlanSnapshot(db, config, snapshot, log) {
  const ref = db
    .collection('users').doc(config.USER_ID)
    .collection('properties').doc(config.PROPERTY_ID)
    .collection('planSnapshots').doc(snapshot.date);

  // Use set with merge so evening + morning pulls stack
  // (morning overwrites evening data for same date, which is correct)
  await ref.set(snapshot, { merge: true });

  log(`[CSV] planSnapshot/${snapshot.date} written — ${snapshot.totalRooms} rooms, ${snapshot.checkouts} C/Os, ${snapshot.stayovers} stays (${snapshot.fullServiceStayovers} full), rec ${snapshot.recommendedHKs} HKs`);
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Full CSV scrape cycle: download → parse → build snapshot → write to Firestore.
 *
 * @param {import('playwright').Page} page — authenticated CA page
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} config — { USER_ID, PROPERTY_ID, TIMEZONE }
 * @param {string} pullType — "evening" or "morning"
 * @param {function} log
 */
async function runCSVScrape(page, db, config, pullType, log) {
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

    // Sanity check: Comfort Suites Beaumont has 74 rooms
    if (rooms.length < 60) {
      log(`[CSV] WARNING: Only ${rooms.length} rooms parsed — expected ~74. Filters may be wrong.`);
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

    // Step 5: Write to Firestore
    await writePlanSnapshot(db, config, snapshot, log);

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

module.exports = { runCSVScrape, parseCSV, buildSnapshot, downloadCSVFromCA };
