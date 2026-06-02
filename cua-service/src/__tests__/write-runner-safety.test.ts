/**
 * Phase 3.1 — write-runner safety behaviors against the mock PMS:
 * dry-run never mutates, bad payloads fail closed before any browser action,
 * and a write step that references credentials is refused.
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

async function withMock(fn: (mockUrl: string, page: import('playwright').Page, mock: Awaited<ReturnType<typeof startMockPms>>) => Promise<void>): Promise<void> {
  const mock = await startMockPms();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await fn(mock.url, page, mock);
  } finally {
    await browser.close();
    await mock.stop();
  }
}

test('dry-run replays everything but skips Save — no mutation', async () => {
  await withMock(async (url, page, mock) => {
    const before = mock.getStatus('204');
    const res = await executeWriteRecipe(
      page,
      mockRecipe(url),
      { room_number: '204', target_status: 'Clean' },
      { dryRun: true, allowLoopback: true },
    );
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.verifiedVia, 'dry_run');
    assert.equal(mock.getStatus('204'), before); // unchanged — Save was skipped
  });
});

test('missing required payload fails closed before touching the browser', async () => {
  await withMock(async (url, page, mock) => {
    const res = await executeWriteRecipe(
      page,
      mockRecipe(url),
      { room_number: '204' }, // no target_status
      { dryRun: false, allowLoopback: true },
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error, 'bad_payload');
    assert.equal(mock.getStatus('204'), 'Dirty');
  });
});

test('a target_status outside the allowed enum fails closed', async () => {
  await withMock(async (url, page, mock) => {
    const res = await executeWriteRecipe(
      page,
      mockRecipe(url),
      { room_number: '204', target_status: 'Haunted' },
      { dryRun: false, allowLoopback: true },
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error, 'bad_payload');
    assert.equal(mock.getStatus('204'), 'Dirty');
  });
});

test('a write step referencing $username is refused (no credential leak)', async () => {
  await withMock(async (url, page, mock) => {
    const poisoned = mockRecipe(url);
    poisoned.steps = [
      { kind: 'fill', selector: 'select[name="status"]', value: '$username', scope: 'row' },
      ...poisoned.steps,
    ];
    const res = await executeWriteRecipe(
      page,
      poisoned,
      { room_number: '204', target_status: 'Clean' },
      { dryRun: false, allowLoopback: true },
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error, 'replay_failed');
    assert.equal(mock.getStatus('204'), 'Dirty'); // never mutated
  });
});
