import './ws-polyfill.js';
import './_bootstrap-env.js';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import {
  captureFeedProvenanceScreenshot,
  feedScreenshotPath,
  type FeedCaptureRow,
} from '../feed-capture.js';

// A fake Page — every real page interaction is routed through injected deps,
// so the object is never actually touched.
const PAGE = {} as Page;

interface Rec {
  uploads: Array<{ key: string; bytes: number }>;
  rows: FeedCaptureRow[];
  cleared: number;
}

function makeDeps(opts: {
  png: Buffer | null;
  uploadThrows?: boolean;
  insertThrows?: boolean;
}): { deps: Parameters<typeof captureFeedProvenanceScreenshot>[1]; rec: Rec } {
  const rec: Rec = { uploads: [], rows: [], cleared: 0 };
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
