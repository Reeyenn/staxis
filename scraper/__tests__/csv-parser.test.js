/**
 * Tests for scraper/csv-scraper.js — pure functions only (parseCSV,
 * buildSnapshot, classifyStayover). The Playwright-driven downloadCSVFromCA
 * is integration-tested out of band; these tests guard the parsing layer
 * that turns CA's CSV bytes into our domain objects.
 *
 * Run: node --test scraper/__tests__/csv-parser.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseCSV, classifyStayover, CLEANING_TIMES, buildSnapshot, computeTargetDate } = require('../csv-scraper');

// CA's Housekeeping Check-off List CSV has 14 columns:
//   Room, Type, People, Adults, Children, Status, Condition,
//   Stay/C/O, Service, Housekeeper, Special Requests,
//   Arrival, Departure, Last Clean
const HEADER = '"Room","Type","People","Adults","Children","Status","Condition","Stay/C/O","Service","Housekeeper","Special Requests","Arrival","Departure","Last Clean"';

const SAMPLE_CSV = [
  HEADER,
  // 101: stayover, day 2 (even → full clean)
  '"101","SNQQ","2","2","0","OCC","Dirty","Stay","Full","","","04/26/2026","04/28/2026","04/25/2026"',
  // 102: checkout
  '"102","SNK","1","1","0","OCC","Dirty","C/O","Full","","","04/27/2026","04/28/2026","04/26/2026"',
  // 103: vacant clean
  '"103","SNQQ","0","0","0","VAC","Clean","","","","","","",""',
  // 104: stayover with arrival 2 days ago (day 3 → odd → light)
  '"104","HSNK","3","2","1","OCC","Dirty","Stay","None","","","04/25/2026","04/28/2026","04/24/2026"',
  // 105: out-of-order
  '"105","SNQQ","0","0","0","OOO","","","","","","","",""',
].join('\n');

describe('parseCSV', () => {
  test('parses a well-formed 14-column CSV into room objects', () => {
    const { rooms } = parseCSV(SAMPLE_CSV);
    assert.equal(rooms.length, 5);
    const r101 = rooms.find(r => r.number === '101');
    assert.ok(r101, 'expected to find room 101');
    assert.equal(r101.status, 'OCC');
    assert.equal(r101.stayType, 'Stay');
    assert.equal(r101.arrival, '04/26/2026');
  });

  test('preserves room number as string (some hotels use 100A, 12B, etc.)', () => {
    const { rooms } = parseCSV(SAMPLE_CSV);
    assert.equal(typeof rooms[0].number, 'string');
  });

  test('handles VAC rooms with empty Arrival/Departure', () => {
    const { rooms } = parseCSV(SAMPLE_CSV);
    const vac = rooms.find(r => r.number === '103');
    assert.equal(vac.status, 'VAC');
    // parseCSV converts empty strings to null for arrival/departure.
    assert.equal(vac.arrival, null);
  });

  test('handles OOO rooms', () => {
    const { rooms } = parseCSV(SAMPLE_CSV);
    const ooo = rooms.find(r => r.number === '105');
    assert.equal(ooo.status, 'OOO');
  });

  test('ignores rows whose first column is not a room number', () => {
    const csvWithGarbage = SAMPLE_CSV + '\n"Total","","","","","","","","","","","","",""';
    const { rooms, anomalies } = parseCSV(csvWithGarbage);
    assert.equal(rooms.length, 5);
    // "Total" footer row is a known summary pattern — not counted as
    // malformed (would otherwise cause every CA report to flag corruption).
    assert.equal(anomalies.roomNumberMalformed, 0);
  });

  test('parses CRLF line endings (Windows-exported CSV)', () => {
    const crlf = SAMPLE_CSV.replace(/\n/g, '\r\n');
    const { rooms } = parseCSV(crlf);
    assert.equal(rooms.length, 5);
  });

  test('returns anomalies object alongside parsed rooms', () => {
    const result = parseCSV(SAMPLE_CSV);
    assert.ok(result.anomalies, 'expected anomalies object');
    assert.equal(typeof result.anomalies.nanAdults, 'number');
    assert.equal(typeof result.anomalies.unknownStayType, 'number');
    // Clean sample → all zeros.
    assert.equal(result.anomalies.nanAdults, 0);
    assert.equal(result.anomalies.unknownStayType, 0);
    assert.equal(result.anomalies.bothDatesNull, 0);
  });
});

describe('classifyStayover', () => {
  // classifyStayover takes (arrivalStr, dateISO) and returns
  // { day, minutes, unknown? }. arrivalStr is in M/D/YYYY format from CA's CSV.
  const today = '2026-04-27';

  test('returns 0 minutes for arrival day (guest just arriving)', () => {
    const result = classifyStayover('04/27/2026', today);
    assert.equal(result.day, 0);
    assert.equal(result.minutes, 0);
  });

  test('odd day of stay → 15min light touch', () => {
    // Arrival 2026-04-25 (2 days ago) → day = 2... actually need to check
    // what the function's "day" means. Day 0 is arrival; day 1 is the
    // first morning after arrival. So 2026-04-25 arrival on 2026-04-27
    // means day = 2 (even) which is the 20-min full clean.
    // For odd-day light clean we want arrival 1 day ago (day 1).
    const result = classifyStayover('04/26/2026', today);
    assert.equal(result.day, 1);
    assert.equal(result.minutes, CLEANING_TIMES.stayoverDay1);
  });

  test('even day of stay → 20min full clean', () => {
    const result = classifyStayover('04/25/2026', today);
    assert.equal(result.day, 2);
    assert.equal(result.minutes, CLEANING_TIMES.stayoverDay2);
  });

  test('missing arrival date falls back to light clean and flags unknown', () => {
    const result = classifyStayover('', today);
    assert.equal(result.day, null);
    assert.equal(result.unknown, true);
    assert.equal(result.minutes, CLEANING_TIMES.stayoverDay1);
  });
});

describe('buildSnapshot', () => {
  const today = '2026-04-27';

  test('builds a non-degenerate snapshot from sample CSV', () => {
    const { rooms } = parseCSV(SAMPLE_CSV);
    const snap = buildSnapshot(rooms, 'morning', today);
    assert.equal(snap.date, today);
    assert.ok(snap.totalRooms >= 5, `expected totalRooms >= 5, got ${snap.totalRooms}`);
    assert.ok(snap.checkouts >= 1, `expected checkouts >= 1`);
    assert.ok(typeof snap.recommendedHKs === 'number');
    assert.ok(snap.totalCleaningMinutes > 0);
  });

  test('snapshot includes the OOO room in oooRoomNumbers', () => {
    const { rooms } = parseCSV(SAMPLE_CSV);
    const snap = buildSnapshot(rooms, 'morning', today);
    assert.ok(Array.isArray(snap.oooRoomNumbers));
    assert.ok(snap.oooRoomNumbers.includes('105'));
  });
});

// Regression coverage for the 2026-05-17 reintroduction of the 7pm pull
// cutover. The earlier removal (2026-04-30) collapsed every pull onto
// today's row, which made ml-run-inference predict against an empty
// plan_snapshots row and ate 3 days of demand_predictions. This suite
// pins the contract so anyone tempted to revert the split sees a red
// test that points at the ML pipeline that depends on it.
describe('computeTargetDate', () => {
  test('morning pulls write to today (local)', () => {
    const todayChicago = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
    assert.equal(computeTargetDate('morning', 'America/Chicago'), todayChicago);
  });

  test('evening pulls write to tomorrow (local)', () => {
    const todayChicago = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
    // Compute tomorrow the same way the function does so DST quirks
    // can't desync the expected value from the production code.
    const anchor = new Date(`${todayChicago}T12:00:00Z`);
    anchor.setUTCDate(anchor.getUTCDate() + 1);
    const tomorrowChicago = anchor.toISOString().slice(0, 10);
    assert.equal(computeTargetDate('evening', 'America/Chicago'), tomorrowChicago);
  });

  test('evening pulls land on day N+1 regardless of timezone', () => {
    for (const tz of ['America/New_York', 'America/Los_Angeles', 'Pacific/Honolulu', 'Europe/London']) {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
      const anchor = new Date(`${today}T12:00:00Z`);
      anchor.setUTCDate(anchor.getUTCDate() + 1);
      assert.equal(
        computeTargetDate('evening', tz),
        anchor.toISOString().slice(0, 10),
        `tz=${tz}: expected tomorrow's date`,
      );
    }
  });

  test('unknown pullType falls back to today (fail-safe)', () => {
    const todayChicago = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
    // Anything that isn't the literal 'evening' should NOT advance the date.
    // Worst case is we keep refining today's row, which never poisons
    // tomorrow's plan.
    assert.equal(computeTargetDate('garbage', 'America/Chicago'), todayChicago);
    assert.equal(computeTargetDate(undefined, 'America/Chicago'), todayChicago);
    assert.equal(computeTargetDate(null, 'America/Chicago'), todayChicago);
  });

  test('tomorrow advances exactly one day, even across DST transitions', () => {
    // We can't time-travel the system clock from a node:test, but the
    // production code uses a UTC anchor at noon specifically so that a
    // ±1h DST shift can't undershoot or overshoot the next civil day.
    // Sanity-check the helper output is exactly +1 day.
    const morning = computeTargetDate('morning', 'America/Chicago');
    const evening = computeTargetDate('evening', 'America/Chicago');
    const a = new Date(`${morning}T12:00:00Z`).getTime();
    const b = new Date(`${evening}T12:00:00Z`).getTime();
    assert.equal(b - a, 86400000, `expected exactly 24h delta, got ${(b - a) / 3600000}h`);
  });
});
