/**
 * scraper/__tests__/csv-anomaly-telemetry.test.js
 *
 * Run via: node --test scraper/__tests__/csv-anomaly-telemetry.test.js
 *
 * F4 reframe: the CSV parser counts per-row anomalies (junk numbers,
 * unknown stayType, malformed room numbers, both-dates-null on a
 * Stay/OCC row) but never drops rows or fails the pull on them. This
 * test pins that contract — both directions:
 *   1. Counters increment when synthetic bad rows are present.
 *   2. NO rows are silently dropped on validation alone.
 *
 * If anyone tightens this into "reject on threshold" without re-reading
 * the master plan v2 context, these tests should fail loudly so the
 * VAC/OOO/arrival-row regression Codex caught in v1 review can't slip
 * back in.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseCSV, anomaliesNonZero, emptyAnomalies } = require('../csv-scraper');

const HEADER = '"Room","Type","People","Adults","Children","Status","Condition","Stay/C/O","Service","Housekeeper","Special Requests","Arrival","Departure","Last Clean"';

function csv(...rows) {
  return [HEADER, ...rows].join('\n');
}

describe('emptyAnomalies / anomaliesNonZero helpers', () => {
  test('emptyAnomalies starts at zero across all keys', () => {
    const a = emptyAnomalies();
    assert.equal(anomaliesNonZero(a), false);
    for (const v of Object.values(a)) assert.equal(v, 0);
  });

  test('anomaliesNonZero returns true if any counter > 0', () => {
    const a = emptyAnomalies();
    a.nanAdults = 3;
    assert.equal(anomaliesNonZero(a), true);
  });

  test('anomaliesNonZero handles null/undefined gracefully', () => {
    assert.equal(anomaliesNonZero(null), false);
    assert.equal(anomaliesNonZero(undefined), false);
    assert.equal(anomaliesNonZero({}), false);
  });
});

describe('parseCSV anomaly counters', () => {
  test('counts nanAdults when adults field is non-numeric', () => {
    const data = csv(
      '"101","SNQQ","2","XYZ","0","OCC","Dirty","Stay","Full","","","04/26/2026","04/28/2026","04/25/2026"',
    );
    const { rooms, anomalies } = parseCSV(data);
    assert.equal(rooms.length, 1, 'row is kept, not dropped');
    assert.equal(anomalies.nanAdults, 1);
    assert.equal(rooms[0].adults, 0, 'falls back to 0 like before');
  });

  test('does not count nanAdults when adults field is legitimately empty', () => {
    const data = csv(
      '"103","SNQQ","0","","0","VAC","Clean","","","","","","",""',
    );
    const { anomalies } = parseCSV(data);
    assert.equal(anomalies.nanAdults, 0);
  });

  test('counts unknownStayType for values outside {Stay, C/O, blank}', () => {
    const data = csv(
      '"201","SNQQ","2","2","0","OCC","Dirty","DAY-USE","Full","","","04/26/2026","04/26/2026","04/25/2026"',
      '"202","SNQQ","2","2","0","OCC","Dirty","COMP","None","","","04/26/2026","04/26/2026","04/25/2026"',
    );
    const { rooms, anomalies } = parseCSV(data);
    assert.equal(rooms.length, 2, 'unknown stayType rows still write through');
    assert.equal(anomalies.unknownStayType, 2);
  });

  test('counts bothDatesNull only on OCC/Stay rows (not VAC/OOO)', () => {
    const data = csv(
      // OCC + Stay + both dates blank → ANOMALY
      '"101","SNQQ","2","2","0","OCC","Dirty","Stay","Full","","","","",""',
      // VAC + blank dates → legit, no anomaly
      '"102","SNQQ","0","0","0","VAC","Clean","","","","","","",""',
      // OOO + blank dates → legit, no anomaly
      '"103","SNQQ","0","0","0","OOO","","","","","","","",""',
      // Arrival (OCC + no stayType + blank dates) → legit, no anomaly
      '"104","SNQQ","1","1","0","OCC","Dirty","","Full","","","","",""',
    );
    const { rooms, anomalies } = parseCSV(data);
    assert.equal(rooms.length, 4, 'all four rows kept');
    assert.equal(anomalies.bothDatesNull, 1, 'only the Stay/OCC counts');
  });

  test('roomNumberMalformed flags non-numeric room IDs (excludes Total footers)', () => {
    const data = csv(
      '"BAD_ID","SNQQ","2","2","0","OCC","Dirty","Stay","Full","","","04/26/2026","04/27/2026","04/25/2026"',
      '"Total","","","","","","","","","","","","",""',
    );
    const { rooms, anomalies } = parseCSV(data);
    assert.equal(rooms.length, 0, 'malformed room rows are still skipped');
    assert.equal(anomalies.roomNumberMalformed, 1, 'BAD_ID counts');
    // "Total" footer rows are a known pattern, not an anomaly.
  });

  test('fieldCountShort flags rows with fewer than 14 columns', () => {
    const data = csv(
      '"101","SNQQ","2","2","0","OCC"',
    );
    const { rooms, anomalies } = parseCSV(data);
    assert.equal(rooms.length, 0);
    assert.equal(anomalies.fieldCountShort, 1);
  });

  test('clean CSV has all-zero anomaly counters', () => {
    const data = csv(
      '"101","SNQQ","2","2","0","OCC","Dirty","Stay","Full","","","04/26/2026","04/28/2026","04/25/2026"',
      '"102","SNK","1","1","0","OCC","Dirty","C/O","Full","","","04/27/2026","04/28/2026","04/26/2026"',
      '"103","SNQQ","0","0","0","VAC","Clean","","","","","","",""',
    );
    const { rooms, anomalies } = parseCSV(data);
    assert.equal(rooms.length, 3);
    assert.equal(anomaliesNonZero(anomalies), false);
  });

  test('anomalies are surfaced WITHOUT dropping rows (the core contract)', () => {
    // Two synthetic rows that collectively trigger every counter. Both must
    // still be written — the contract is "telemetry only, never drop."
    const data = csv(
      // unknown stayType + nan numbers, dates present
      '"101","SNQQ","2","NOT-A-NUM","ALSO-BAD","OCC","Dirty","UNKNOWN-TYPE","Full","","","04/26/2026","04/27/2026","04/25/2026"',
      // OCC+Stay with both dates blank → bothDatesNull
      '"102","SNQQ","2","2","0","OCC","Dirty","Stay","Full","","","","",""',
    );
    const { rooms, anomalies } = parseCSV(data);
    assert.equal(rooms.length, 2, 'rows MUST be kept despite every anomaly');
    assert.equal(anomalies.nanAdults, 1);
    assert.equal(anomalies.nanChildren, 1);
    assert.equal(anomalies.unknownStayType, 1);
    assert.equal(anomalies.bothDatesNull, 1);
  });
});
