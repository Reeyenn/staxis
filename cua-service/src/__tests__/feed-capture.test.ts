import './ws-polyfill.js';
import './_bootstrap-env.js';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import {
  captureFeedProvenanceScreenshot,
  captureLiveFeedProvenance,
  feedScreenshotPath,
  feedColumnBoxesPath,
  liveFeedScreenshotPath,
  liveFeedBoxesPath,
  liveFeedSamplePath,
  buildFeedSample,
  uploadLiveFeedSample,
  upsertFeedValues,
  type FeedCaptureRow,
  type ColumnGeometry,
} from '../feed-capture.js';

// A fake Page — every real page interaction is routed through injected deps,
// so the object is never actually touched.
const PAGE = {} as Page;

const GEO: ColumnGeometry = {
  viewport: { w: 1280, h: 800 },
  columns: [
    { index: 3, header: 'Guest Name', x: 100, y: 50, w: 180, h: 600 },
    { index: 8, header: 'Room #', x: 300, y: 50, w: 80, h: 600 },
  ],
};

interface Rec {
  uploads: Array<{ key: string; bytes: number }>;
  rows: FeedCaptureRow[];
  cleared: number;
  boxes: Array<{ key: string; columns: number }>;
}

function makeDeps(opts: {
  png: Buffer | null;
  uploadThrows?: boolean;
  insertThrows?: boolean;
  geometry?: ColumnGeometry | null;
  uploadBoxesThrows?: boolean;
}): { deps: Parameters<typeof captureFeedProvenanceScreenshot>[1]; rec: Rec } {
  const rec: Rec = { uploads: [], rows: [], cleared: 0, boxes: [] };
  return {
    rec,
    deps: {
      capture: async () => opts.png,
      clearMarks: async () => { rec.cleared++; },
      upload: async (key, png) => {
        if (opts.uploadThrows) throw new Error('upload boom');
        rec.uploads.push({ key, bytes: png.length });
      },
      insertRow: async (row) => {
        if (opts.insertThrows) throw new Error('insert boom');
        rec.rows.push(row);
      },
      captureGeometry: async () => opts.geometry ?? null,
      uploadBoxes: async (key, geometry) => {
        if (opts.uploadBoxesThrows) throw new Error('boxes boom');
        rec.boxes.push({ key, columns: geometry.columns.length });
      },
    },
  };
}

const FULL_ARGS = {
  page: PAGE,
  jobId: 'job-1',
  propertyId: 'prop-1',
  pmsFamily: 'choice_advantage',
  feedKey: 'getRoomStatus',
};

test('happy path — masked capture uploads to the durable feeds/ key and records one row', async () => {
  const { deps, rec } = makeDeps({ png: Buffer.from('PNGBYTES') });
  await captureFeedProvenanceScreenshot(FULL_ARGS, deps);
  assert.equal(rec.cleared, 1, 'clears Set-of-Mark badges before capture');
  assert.equal(rec.uploads.length, 1);
  assert.equal(rec.uploads[0]!.key, 'job-1/feeds/getRoomStatus.png');
  assert.equal(rec.uploads[0]!.bytes, 8);
  assert.equal(rec.rows.length, 1);
  assert.deepEqual(rec.rows[0], {
    job_id: 'job-1',
    property_id: 'prop-1',
    pms_family: 'choice_advantage',
    feed_key: 'getRoomStatus',
    screenshot_path: 'job-1/feeds/getRoomStatus.png',
  });
});

test('withhold — a null (un-maskable) capture uploads nothing and records nothing', async () => {
  const { deps, rec } = makeDeps({ png: null });
  await captureFeedProvenanceScreenshot(FULL_ARGS, deps);
  assert.equal(rec.uploads.length, 0);
  assert.equal(rec.rows.length, 0);
});

test('no-op when jobId / propertyId / pmsFamily is missing (dev/test run)', async () => {
  for (const missing of [
    { ...FULL_ARGS, jobId: null },
    { ...FULL_ARGS, propertyId: null },
    { ...FULL_ARGS, pmsFamily: null },
  ]) {
    const { deps, rec } = makeDeps({ png: Buffer.from('x') });
    await captureFeedProvenanceScreenshot(missing, deps);
    assert.equal(rec.cleared, 0, 'never even captures without a durable target');
    assert.equal(rec.uploads.length, 0);
    assert.equal(rec.rows.length, 0);
  }
});

test('upload failure never throws and never records a row pointing at a missing object', async () => {
  const { deps, rec } = makeDeps({ png: Buffer.from('x'), uploadThrows: true });
  await assert.doesNotReject(() => captureFeedProvenanceScreenshot(FULL_ARGS, deps));
  assert.equal(rec.rows.length, 0, 'no row when the upload failed');
});

test('row-insert failure never throws (best-effort)', async () => {
  const { deps, rec } = makeDeps({ png: Buffer.from('x'), insertThrows: true });
  await assert.doesNotReject(() => captureFeedProvenanceScreenshot(FULL_ARGS, deps));
  assert.equal(rec.uploads.length, 1, 'the upload still happened');
});

test('feedScreenshotPath sanitizes the feed key into the feeds/ prefix', () => {
  assert.equal(feedScreenshotPath('job-1', 'getArrivals'), 'job-1/feeds/getArrivals.png');
  assert.equal(feedScreenshotPath('job-1', 'weird/key with spaces'), 'job-1/feeds/weird_key_with_spaces.png');
});

// ── feature/cua-click-to-map — column geometry alongside the screenshot ──

test('with a rowSelector + geometry, uploads the sibling .boxes.json', async () => {
  const { deps, rec } = makeDeps({ png: Buffer.from('PNG'), geometry: GEO });
  await captureFeedProvenanceScreenshot({ ...FULL_ARGS, rowSelector: 'tbody tr' }, deps);
  assert.equal(rec.uploads.length, 1, 'screenshot still uploaded');
  assert.equal(rec.boxes.length, 1);
  assert.equal(rec.boxes[0]!.key, feedColumnBoxesPath('job-1', 'getRoomStatus'));
  assert.equal(rec.boxes[0]!.columns, 2);
});

test('no rowSelector → no geometry capture (non-table feed)', async () => {
  const { deps, rec } = makeDeps({ png: Buffer.from('PNG'), geometry: GEO });
  await captureFeedProvenanceScreenshot(FULL_ARGS, deps);
  assert.equal(rec.uploads.length, 1);
  assert.equal(rec.boxes.length, 0, 'geometry only captured when a rowSelector is passed');
});

test('a geometry/boxes failure never breaks the screenshot+row', async () => {
  const { deps, rec } = makeDeps({ png: Buffer.from('PNG'), geometry: GEO, uploadBoxesThrows: true });
  await assert.doesNotReject(() => captureFeedProvenanceScreenshot({ ...FULL_ARGS, rowSelector: 'tbody tr' }, deps));
  assert.equal(rec.uploads.length, 1, 'screenshot still uploaded');
  assert.equal(rec.rows.length, 1, 'row still recorded despite geometry failure');
  assert.equal(rec.boxes.length, 0);
});

test('rowSelector present but geometry null (headerless/odd table) → no boxes, no throw', async () => {
  const { deps, rec } = makeDeps({ png: Buffer.from('PNG'), geometry: null });
  await captureFeedProvenanceScreenshot({ ...FULL_ARGS, rowSelector: 'tbody tr' }, deps);
  assert.equal(rec.uploads.length, 1);
  assert.equal(rec.boxes.length, 0);
});

// ── fix/cua-freeform-capture-live — poll-time refresh to the stable live keys ──

test('live capture uploads screenshot + geometry to the per-property live keys, NO row', async () => {
  const { deps, rec } = makeDeps({ png: Buffer.from('LIVE'), geometry: GEO });
  await captureLiveFeedProvenance({ page: PAGE, propertyId: 'prop-1', feedKey: 'getDepartures', rowSelector: 'tbody tr' }, deps);
  assert.equal(rec.uploads.length, 1);
  assert.equal(rec.uploads[0]!.key, liveFeedScreenshotPath('prop-1', 'getDepartures'));
  assert.equal(rec.boxes.length, 1);
  assert.equal(rec.boxes[0]!.key, liveFeedBoxesPath('prop-1', 'getDepartures'));
  assert.equal(rec.rows.length, 0, 'live capture never inserts a mapping_feed_captures row (job_id is a FK)');
});

test('live capture withholds when masking fails; never throws on geometry error', async () => {
  const a = makeDeps({ png: null, geometry: GEO });
  await captureLiveFeedProvenance({ page: PAGE, propertyId: 'p', feedKey: 'getArrivals', rowSelector: 'tbody tr' }, a.deps);
  assert.equal(a.rec.uploads.length, 0);
  const b = makeDeps({ png: Buffer.from('x'), geometry: GEO, uploadBoxesThrows: true });
  await assert.doesNotReject(() => captureLiveFeedProvenance({ page: PAGE, propertyId: 'p', feedKey: 'getArrivals', rowSelector: 'tbody tr' }, b.deps));
  assert.equal(b.rec.uploads.length, 1, 'screenshot still uploaded despite geometry failure');
});

test('liveFeedScreenshotPath/liveFeedBoxesPath are stable per-property keys', () => {
  assert.equal(liveFeedScreenshotPath('prop-1', 'getArrivals'), 'live/prop-1/getArrivals.png');
  assert.equal(liveFeedBoxesPath('prop-1', 'getArrivals'), 'live/prop-1/getArrivals.boxes.json');
});

// ── fix/cua-freeform-capture — the "Captured" panel live sample ──

test('liveFeedSamplePath is a stable per-property .sample.json key', () => {
  assert.equal(liveFeedSamplePath('prop-1', 'getArrivals'), 'live/prop-1/getArrivals.sample.json');
});

test('buildFeedSample flattens the first row (top-level cols then raw extras), keeps rowCount', () => {
  const rows = [
    { guest_name: 'Molina, Felix', room_number: '208', raw: { rate_plan: 'SBOOK', group: 'X' } },
    { guest_name: 'Xie, Songtao', room_number: '300', raw: { rate_plan: 'LOPQ2' } },
  ];
  const s = buildFeedSample(rows, '2026-06-25T20:00:00Z');
  assert.equal(s.rowCount, 2);
  assert.equal(s.capturedAt, '2026-06-25T20:00:00Z');
  assert.deepEqual(s.fields, [
    { name: 'guest_name', value: 'Molina, Felix' },
    { name: 'room_number', value: '208' },
    { name: 'rate_plan', value: 'SBOOK' },
    { name: 'group', value: 'X' },
  ]);
});

test('buildFeedSample renders a blank required column as empty string (so the panel can flag it)', () => {
  const s = buildFeedSample([{ guest_name: '', room_number: '208' }], 'now');
  assert.equal(s.fields[0]!.name, 'guest_name');
  assert.equal(s.fields[0]!.value, '');
});

test('buildFeedSample clamps long values + coerces non-strings; empty rows → no fields', () => {
  const long = 'x'.repeat(300);
  const s = buildFeedSample([{ note: long, n: 5, b: true, nope: null }], 'now');
  const byName = Object.fromEntries(s.fields.map((f) => [f.name, f.value]));
  assert.ok(byName.note!.length <= 141 && byName.note!.endsWith('…'));
  assert.equal(byName.n, '5');
  assert.equal(byName.b, 'true');
  assert.equal(byName.nope, '');
  assert.deepEqual(buildFeedSample([], 'now'), { capturedAt: 'now', rowCount: 0, fields: [] });
});

test('uploadLiveFeedSample writes the sample key for non-empty rows; no-op + never throws otherwise', async () => {
  const writes: Array<{ key: string; body: string }> = [];
  const deps = { uploadJson: async (key: string, body: string) => { writes.push({ key, body }); }, now: () => 'T' };
  await uploadLiveFeedSample('prop-1', 'getArrivals', [{ guest_name: 'A', raw: { x: '1' } }], undefined, deps);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.key, 'live/prop-1/getArrivals.sample.json');
  const parsed = JSON.parse(writes[0]!.body);
  assert.equal(parsed.rowCount, 1);
  assert.equal(parsed.fields.length, 2);

  await uploadLiveFeedSample('prop-1', 'getArrivals', [], undefined, deps);
  assert.equal(writes.length, 1, 'empty rows + no page values upload nothing');

  const boom = { uploadJson: async () => { throw new Error('boom'); }, now: () => 'T' };
  await assert.doesNotReject(() => uploadLiveFeedSample('p', 'f', [{ a: '1' }], undefined, boom));
});

test('page values ride in a separate pageValues block, NOT mixed into per-row fields', () => {
  const s = buildFeedSample(
    [{ guest_name: 'Molina, Felix', room_number: '208' }],
    'now',
    { guest_count: '23', room_count: '10' },
  );
  // per-row columns unchanged
  assert.deepEqual(s.fields, [
    { name: 'guest_name', value: 'Molina, Felix' },
    { name: 'room_number', value: '208' },
  ]);
  // feed-level totals are distinct
  assert.deepEqual(s.pageValues, [
    { name: 'guest_count', value: '23' },
    { name: 'room_count', value: '10' },
  ]);
  // no page values → no pageValues key (back-compat)
  assert.equal('pageValues' in buildFeedSample([{ a: '1' }], 'now'), false);
});

test('uploadLiveFeedSample previews an EMPTY feed that still has page totals (e.g. "Guest Count: 0")', async () => {
  const writes: Array<{ key: string; body: string }> = [];
  const deps = { uploadJson: async (key: string, body: string) => { writes.push({ key, body }); }, now: () => 'T' };
  await uploadLiveFeedSample('p', 'getArrivals', [], { guest_count: '0' }, deps);
  assert.equal(writes.length, 1, 'empty rows but page totals → still previewed');
  const parsed = JSON.parse(writes[0]!.body);
  assert.equal(parsed.rowCount, 0);
  assert.deepEqual(parsed.pageValues, [{ name: 'guest_count', value: '0' }]);
});

test('upsertFeedValues: captured → stores fresh; configured-but-empty → flags error preserving last-good; no page columns → no-op; never throws', async () => {
  const rows: Array<Record<string, unknown>> = [];
  const deps = { upsert: async (row: Record<string, unknown>) => { rows.push(row); }, now: () => 'T' };

  // captured values → fresh upsert
  await upsertFeedValues('prop-1', 'getArrivals', { guest_count: '23', room_count: '10' }, true, deps);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.property_id, 'prop-1');
  assert.equal(rows[0]!.feed_key, 'getArrivals');
  assert.deepEqual(rows[0]!.values, { guest_count: '23', room_count: '10' });
  assert.equal(rows[0]!.has_error, false);
  assert.equal(rows[0]!.last_good_at, 'T');

  // feed HAS page columns but captured nothing → error marker, NO values/last_good_at
  // in the payload (so the prior good capture is preserved on conflict).
  await upsertFeedValues('prop-1', 'getArrivals', {}, true, deps);
  assert.equal(rows.length, 2);
  assert.equal(rows[1]!.has_error, true);
  assert.equal(rows[1]!.last_error, 'no page values captured');
  assert.equal('values' in rows[1]!, false, 'error path omits values → preserved on conflict');
  assert.equal('last_good_at' in rows[1]!, false, 'error path omits last_good_at → preserved');

  // no page columns configured → nothing to track
  await upsertFeedValues('prop-1', 'getArrivals', undefined, false, deps);
  assert.equal(rows.length, 2, 'no page columns → no write');

  const boom = { upsert: async () => { throw new Error('boom'); }, now: () => 'T' };
  await assert.doesNotReject(() => upsertFeedValues('p', 'f', { a: '1' }, true, boom));
});
