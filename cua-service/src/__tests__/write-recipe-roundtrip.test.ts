/**
 * Phase 3 — write-recipe SIGNING round-trip + end-to-end rehearsal.
 *
 * The adversarial pre-test review found that although the write-replay engine
 * (write-runner.test.ts) was proven against the mock PMS, the SIGNING path for
 * a WriteActionRecipe had never been exercised end-to-end: a recipe is signed
 * over its canonical JSON, stored in a Postgres `jsonb` column, then reloaded
 * and re-verified by the worker (write-job-handler). If `jsonb` storage altered
 * the value in any way the canonical JSON differed from, the very FIRST real
 * signed recipe would fail HMAC verification and silently no-op every push.
 *
 * This test closes that gap by simulating the exact store/reload boundary
 * (JSON.parse(JSON.stringify(...)) is what a jsonb round-trip does to a plain
 * recipe object) and proving:
 *   1. a signed write recipe still verifies after the jsonb round-trip,
 *   2. tampering with the stored recipe breaks the signature (fail-closed),
 *   3. the round-tripped (i.e. loaded-from-DB-shaped) recipe actually drives
 *      the mock PMS to the target state end-to-end.
 *
 * Requires RECIPE_SIGNING_KEY in the env at process start (the test command
 * sets it). recipe-signing reads the parsed env singleton, so the key must be
 * present BEFORE import — the npm `test` script provides it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startMockPms, MOCK_STATUSES } from '../mock-pms/server.js';
import { executeWriteRecipe } from '../write-runner.js';
import { signRecipe, verifyRecipe } from '../recipe-signing.js';
import type { Recipe, WriteActionRecipe } from '../types.js';

/** The canonical room-status write recipe, shaped for the mock PMS. Matches the
 *  proven recipe in write-runner.test.ts; here we additionally sign it and push
 *  it through the jsonb boundary. */
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

/** What a Postgres `jsonb` column does to a plain object on store + reload:
 *  serialize to JSON and parse back. Key order is not preserved by jsonb, but
 *  canonicalJson sorts keys, so this is the faithful boundary to test. */
function jsonbRoundTrip<T>(o: T): T {
  return JSON.parse(JSON.stringify(o)) as T;
}

test('a signed write recipe still verifies after the jsonb store/reload round-trip', () => {
  const recipe = mockRecipe('http://127.0.0.1:1');
  const sig = signRecipe(recipe as unknown as Recipe);
  // The worker reloads `recipe` from a jsonb column — simulate that exactly.
  const stored = jsonbRoundTrip(recipe);
  const verify = verifyRecipe(stored as unknown as Recipe, sig.signature, sig.signedWithKeyId);
  assert.equal(verify.ok, true, 'signature must survive the jsonb round-trip');
  if (verify.ok) assert.equal(verify.keyGeneration, 'active');
});

test('tampering with a stored write recipe breaks the signature (fail-closed)', () => {
  const recipe = mockRecipe('http://127.0.0.1:1');
  const sig = signRecipe(recipe as unknown as Recipe);
  const tampered = jsonbRoundTrip(recipe);
  // An attacker (or a corrupt write) swaps the save selector to a different control.
  tampered.steps = [
    { kind: 'select', selector: 'select[name="status"]', value: '$payload.target_status', scope: 'row' },
    { kind: 'save', selector: 'button.delete-everything', scope: 'row' },
  ];
  const verify = verifyRecipe(tampered as unknown as Recipe, sig.signature, sig.signedWithKeyId);
  assert.equal(verify.ok, false, 'a tampered recipe must NOT verify');
  if (!verify.ok) assert.equal(verify.reason, 'mismatch');
});

test('a signed + jsonb-round-tripped write recipe drives the mock PMS end-to-end', async () => {
  const mock = await startMockPms();
  const browser = await chromium.launch({ headless: true });
  try {
    const recipe = mockRecipe(mock.url);
    const sig = signRecipe(recipe as unknown as Recipe);
    // Reload-from-DB shape, then verify BEFORE replay — exactly the worker's order.
    const stored = jsonbRoundTrip(recipe);
    assert.equal(
      verifyRecipe(stored as unknown as Recipe, sig.signature, sig.signedWithKeyId).ok,
      true,
      'must verify the reloaded recipe before driving the PMS',
    );
    const page = await browser.newPage();
    const res = await executeWriteRecipe(
      page,
      stored,
      { room_number: '204', target_status: 'Clean' },
      { dryRun: false, allowLoopback: true },
    );
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.verifiedVia, 'reread');
    assert.equal(mock.getStatus('204'), 'Clean'); // genuinely persisted server-side
  } finally {
    await browser.close();
    await mock.stop();
  }
});
