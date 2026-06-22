/**
 * Tests for feature/cua-report-handling — learn-time DOWNLOAD + NEW-WINDOW
 * report handling.
 *
 * Pins the three load-bearing invariants the feature must hold:
 *
 *  (a) Loop-detector suppression fires ONLY on delivery turns. R4 SKIPS
 *      recording a turn's (action, page) tuple into the detector when a
 *      delivery event fired — treating the click as progress. We model the
 *      exact skip the mapper applies (record iff !deliveryFiredThisTurn)
 *      against the REAL ActionLoopDetector and assert: a Submit-spam streak
 *      that fires a download every turn NEVER trips, while the identical
 *      streak with no delivery DOES trip on the 4th identical tuple. The
 *      detector's own constants (window=8, maxRepeats=3) are untouched.
 *
 *  (b) A downloaded CSV parses to headers + rows via parseDownloadedFile,
 *      and an Excel/PDF blob abstains with { ok:false, reason }.
 *
 *  (c) The inline-feed click path is BYTE-IDENTICAL when the flag is OFF:
 *      executeVisionAction on a left_click leaves `delivery` undefined and
 *      produces the same result object whether or not a download listener
 *      could have fired.
 */

import './_bootstrap-env.js';

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { Page, Download } from 'playwright';
import { ActionLoopDetector } from '../loop-detector.js';
import { parseDownloadedFile } from '../extractors/download-parser.js';
import { executeVisionAction, type VisionAction } from '../browser-tool-vision.js';
import type { PMSCredentials } from '../types.js';

// ─── (a) Loop-detector suppression — ONLY on delivery turns ────────────────

/** Faithful model of the mapper's R4 gate: record the tuple iff NO delivery
 *  fired this turn; on a delivery turn, skip recording entirely. Returns the
 *  detector's verdict for the turn (always {stuck:false} on a skipped turn,
 *  since nothing was recorded). */
function turn(
  d: ActionLoopDetector,
  fp: string,
  page: string,
  deliveryFiredThisTurn: boolean,
): { stuck: boolean } {
  if (deliveryFiredThisTurn) return { stuck: false };
  return d.record(fp, page);
}

describe('R4 loop-detector suppression — only on delivery turns', () => {
  test('Submit-spam that downloads EVERY turn never trips (treated as progress)', () => {
    const d = new ActionLoopDetector(); // real defaults: window=8, maxRepeats=3
    let tripped = false;
    for (let i = 0; i < 12; i++) {
      // Same click on the same page each turn — but a download fires, so the
      // tuple is never recorded and the detector can't accumulate a streak.
      if (turn(d, 'left_click:640,500', 'report-page', /*delivery*/ true).stuck) tripped = true;
    }
    assert.equal(tripped, false, 'a delivery every turn must never trip the detector');
  });

  test('identical streak with NO delivery DOES trip on the 4th tuple (control)', () => {
    const d = new ActionLoopDetector();
    assert.equal(turn(d, 'left_click:640,500', 'report-page', false).stuck, false);
    assert.equal(turn(d, 'left_click:640,500', 'report-page', false).stuck, false);
    assert.equal(turn(d, 'left_click:640,500', 'report-page', false).stuck, false);
    assert.equal(
      turn(d, 'left_click:640,500', 'report-page', false).stuck,
      true,
      'no delivery → byte-identical to today: the 4th identical tuple trips',
    );
  });

  test('suppression is per-turn: a delivery turn does not pardon later non-delivery spam', () => {
    const d = new ActionLoopDetector();
    // 2 real (recorded) clicks, then a delivery turn (skipped), then 2 more
    // real clicks → 4 recorded identical tuples total → trips on the 4th.
    assert.equal(turn(d, 'left_click:1,1', 'p', false).stuck, false); // recorded #1
    assert.equal(turn(d, 'left_click:1,1', 'p', false).stuck, false); // recorded #2
    assert.equal(turn(d, 'left_click:1,1', 'p', true).stuck, false);  // SKIPPED (delivery)
    assert.equal(turn(d, 'left_click:1,1', 'p', false).stuck, false); // recorded #3
    assert.equal(turn(d, 'left_click:1,1', 'p', false).stuck, true);  // recorded #4 → trip
  });
});

// ─── (b) Downloaded-file parsing ───────────────────────────────────────────

/** Minimal Playwright Download fake backed by an in-memory buffer. */
function fakeDownload(opts: { filename: string; body: Buffer | string }): Download {
  const buf = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body, 'utf8');
  return {
    suggestedFilename: () => opts.filename,
    createReadStream: async () => Readable.from([buf]) as unknown as NodeJS.ReadableStream,
  } as unknown as Download;
}

describe('R2 parseDownloadedFile — CSV parses, Excel/PDF abstain', () => {
  test('CSV download parses to headers + rows', async () => {
    const csv = 'Room,Guest Name,Status\r\n101,Jane Doe,Occupied\r\n102,John Roe,Vacant\r\n';
    const res = await parseDownloadedFile(fakeDownload({ filename: 'housekeeping.csv', body: csv }));
    assert.equal(res.ok, true);
    assert.equal(res.format, 'csv');
    assert.deepEqual(res.headers, ['Room', 'Guest Name', 'Status']);
    assert.equal(res.rows.length, 2);
    assert.deepEqual(res.rows[0], { Room: '101', 'Guest Name': 'Jane Doe', Status: 'Occupied' });
  });

  test('CSV with no extension still parses (text sniff)', async () => {
    const csv = 'a,b\n1,2\n';
    const res = await parseDownloadedFile(fakeDownload({ filename: 'export', body: csv }));
    assert.equal(res.ok, true);
    assert.equal(res.format, 'csv');
    assert.deepEqual(res.headers, ['a', 'b']);
  });

  test('XLSX (zip magic bytes) abstains with reason', async () => {
    // PK\x03\x04 — zip/xlsx signature.
    const xlsx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
    const res = await parseDownloadedFile(fakeDownload({ filename: 'report.xlsx', body: xlsx }));
    assert.equal(res.ok, false);
    assert.equal(res.format, 'xlsx');
    assert.match(res.reason ?? '', /not yet supported/);
    assert.equal(res.rows.length, 0);
  });

  test('PDF (%PDF magic) abstains with reason', async () => {
    const pdf = Buffer.from('%PDF-1.7\n%binary\n', 'binary');
    const res = await parseDownloadedFile(fakeDownload({ filename: 'invoice.pdf', body: pdf }));
    assert.equal(res.ok, false);
    assert.equal(res.format, 'pdf');
    assert.match(res.reason ?? '', /not yet supported/);
  });

  test('binary blob with a misleading .csv name is caught by the NUL sniff', async () => {
    const blob = Buffer.from([0x01, 0x00, 0x02, 0x00, 0x03]);
    const res = await parseDownloadedFile(fakeDownload({ filename: 'liar.csv', body: blob }));
    assert.equal(res.ok, false);
    assert.equal(res.format, 'unknown');
  });
});

// ─── (c) Inline path byte-identical when the flag is OFF ───────────────────

const CREDS: PMSCredentials = {
  loginUrl: 'https://pms.example.com/login',
  username: 'frontdesk@hotel.com',
  password: 'hunter2-real',
};

/** Page fake for the left_click path. extractRoleNameAtPoint's page.evaluate
 *  returns null (no element) so no roleName is attached; mouse.click is a
 *  no-op recorder. context().waitForEvent / waitForEvent are present so that
 *  IF the flag were on, the listeners would simply time out → no delivery. */
function fakeClickPage(clicks: Array<[number, number]>): Page {
  return {
    viewportSize: () => ({ width: 1280, height: 800 }),
    evaluate: async () => null,
    mouse: { click: async (x: number, y: number) => { clicks.push([x, y]); } },
    waitForEvent: async () => { throw new Error('no download'); },
    context: () => ({ waitForEvent: async () => { throw new Error('no popup'); } }),
  } as unknown as Page;
}

const clickAction = (x: number, y: number): VisionAction =>
  ({ action: 'left_click', coordinate: [x, y] }) as unknown as VisionAction;

describe('R1 inline path — delivery undefined + byte-identical when flag OFF', () => {
  afterEach(() => {
    delete process.env.CUA_DELIVERY_DETECT_ENABLED;
  });

  test('flag OFF: left_click result has no delivery and records the click step', async () => {
    process.env.CUA_DELIVERY_DETECT_ENABLED = 'false'; // default is now ON — set false to exercise the off path
    const clicks: Array<[number, number]> = [];
    const res = await executeVisionAction(fakeClickPage(clicks), clickAction(640, 500), CREDS, 'action');
    assert.equal(res.delivery, undefined, 'inline turn must leave delivery undefined');
    assert.equal(res.isError ?? false, false);
    assert.deepEqual(res.recordedStep, { kind: 'click_at', x: 640, y: 500 });
    assert.deepEqual(clicks, [[640, 500]], 'the click still lands at the same coordinate');
  });

  test('flag ON but no event fires: still no delivery (degrades to inline behavior)', async () => {
    process.env.CUA_DELIVERY_DETECT_ENABLED = 'true';
    const clicks: Array<[number, number]> = [];
    const res = await executeVisionAction(fakeClickPage(clicks), clickAction(640, 500), CREDS, 'action');
    assert.equal(res.delivery, undefined, 'no event → delivery stays undefined');
    assert.deepEqual(res.recordedStep, { kind: 'click_at', x: 640, y: 500 });
    assert.deepEqual(clicks, [[640, 500]]);
  });

  test('flag-OFF and flag-ON-no-event results are identical except for the (absent) delivery', async () => {
    process.env.CUA_DELIVERY_DETECT_ENABLED = 'false';
    const off = await executeVisionAction(fakeClickPage([]), clickAction(10, 20), CREDS, 'action');
    process.env.CUA_DELIVERY_DETECT_ENABLED = 'true';
    const on = await executeVisionAction(fakeClickPage([]), clickAction(10, 20), CREDS, 'action');
    assert.deepEqual(
      { output: off.output, recordedStep: off.recordedStep, isError: off.isError, delivery: off.delivery },
      { output: on.output, recordedStep: on.recordedStep, isError: on.isError, delivery: on.delivery },
      'byte-identical result shape whether the flag is off or on-with-no-event',
    );
  });
});
