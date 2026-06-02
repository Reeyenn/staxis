/**
 * Phase 3.1 — the full write-back loop against the mock PMS:
 * locate row -> select status -> save -> verify by authoritative re-read.
 * Proves the pipeline with no real hotel and no Claude.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startMockPms, MOCK_STATUSES } from '../mock-pms/server.js';
import { executeWriteRecipe } from '../write-runner.js';
import type { WriteActionRecipe } from '../types.js';

function mockRecipe(mockUrl: string): WriteActionRecipe {
  return {
    key: 'set_room_status',
    requiredParams: ['room_number', 'target_status'],
    paramEnums: { target_status: MOCK_STATUSES },
    pageUrl: `${mockUrl}/housekeeping`,
    loggedInSelector: '#hk',
    rowLocator: { rowSelector: '#hk tbody tr', matchCell: 'td.room', matchParam: 'room_number' },
    steps: [
      { kind: 'select', selector: 'select[name="status"]', value: '$payload.target_status', scope: 'row' },
      { kind: 'save', selector: 'button.save', scope: 'row' },
    ],
    verifyInPage: { selector: 'td.current', scope: 'row', equals: '$payload.target_status' },
    verifiedAgainst: 'mock',
  };
}

const OPTS = { dryRun: false, allowLoopback: true };

test('executeWriteRecipe drives the mock end-to-end and verifies by re-read', async () => {
  const mock = await startMockPms();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const res = await executeWriteRecipe(
      page,
      mockRecipe(mock.url),
      { room_number: '204', target_status: 'Clean' },
      OPTS,
    );
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.verifiedVia, 'reread');
    assert.equal(mock.getStatus('204'), 'Clean'); // genuinely persisted server-side
  } finally {
    await browser.close();
    await mock.stop();
  }
});

test('a re-run is idempotent — no second mutation', async () => {
  const mock = await startMockPms();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const recipe = mockRecipe(mock.url);
    const payload = { room_number: '205', target_status: 'Inspected' };
    const r1 = await executeWriteRecipe(page, recipe, payload, OPTS);
    assert.equal(r1.ok, true);
    const r2 = await executeWriteRecipe(page, recipe, payload, OPTS);
    assert.equal(r2.ok, true);
    if (r2.ok) assert.equal(r2.verifiedVia, 'idempotent');
    assert.equal(mock.getStatus('205'), 'Inspected');
  } finally {
    await browser.close();
    await mock.stop();
  }
});

test('exact row match in the DOM: setting room "10" never touches "110"', async () => {
  const mock = await startMockPms();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const before110 = mock.getStatus('110');
    const res = await executeWriteRecipe(
      page,
      mockRecipe(mock.url),
      { room_number: '10', target_status: 'Inspected' },
      OPTS,
    );
    assert.equal(res.ok, true);
    assert.equal(mock.getStatus('10'), 'Inspected'); // the intended room changed
    assert.equal(mock.getStatus('110'), before110); // the look-alike room did NOT
  } finally {
    await browser.close();
    await mock.stop();
  }
});
