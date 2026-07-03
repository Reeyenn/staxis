/**
 * Pins the 2026-07 round-2 write-back audit fixes so they can't regress.
 *
 *   C. Signing v2 binds the provenance/routing metadata (action_key,
 *      pms_family, verified_against) ALONGSIDE the recipe body, so a
 *      service-role attacker flipping verified_against or transplanting a
 *      recipe onto another action row breaks verification. The WRITE path
 *      requires v2; the READ path keeps the v1 fallback.
 *   D. The idempotency short-circuit runs BEFORE the precondition, so a retry
 *      of an already-applied write returns idempotent success — not
 *      precondition_failed — even when the precondition is the inverse of the
 *      target ("only mark clean if currently dirty").
 *   B. rehostFeedUrl (the wrong-hotel guard's input) swaps a family-shared
 *      recipe URL onto the per-property tenant origin, and is a no-op for a
 *      single-host PMS — the contract the handler relies on.
 *
 * C + B are pure-function pins (no browser, no DB). D drives the built-in mock
 * PMS headlessly (no real hotel, no Claude).
 */

import './ws-polyfill.js';
import './_bootstrap-env.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { chromium } from 'playwright';

import {
  signRecipe,
  signWriteRecipe,
  verifyRecipe,
  canonicalJson,
} from '../recipe-signing.js';
import { rehostFeedUrl } from '../session-driver.js';
import { executeWriteRecipe } from '../write-runner.js';
import { startMockPms, MOCK_STATUSES } from '../mock-pms/server.js';
import type { Recipe, WriteActionRecipe } from '../types.js';

// A minimal WriteActionRecipe body — the exact shape a write row stores.
const WRITE_RECIPE: WriteActionRecipe = {
  key: 'set_room_status',
  requiredParams: ['room_number', 'target_status'],
  paramEnums: { target_status: ['vacant_clean', 'vacant_dirty'] },
  pageUrl: 'https://pms.example.com/housekeeping',
  rowLocator: { rowSelector: '#hk tbody tr', matchCell: 'td.room', matchParam: 'room_number' },
  steps: [{ kind: 'save', selector: 'button.save', scope: 'row' }],
  verifyInPage: { selector: 'td.current', scope: 'row', equals: '$payload.target_status' },
  verifiedAgainst: 'practice_room',
};

const META = { actionKey: 'room_status', pmsFamily: 'choice_advantage', verifiedAgainst: 'practice_room' };

// ─── ITEM C — v2 metadata-bound signing ─────────────────────────────────────

describe('recipe-signing v2 — metadata binding (ITEM C)', () => {
  test('v2 sign → verify round-trip succeeds and reports version 2', () => {
    const sig = signWriteRecipe(WRITE_RECIPE as unknown as Recipe, META);
    const r = verifyRecipe(WRITE_RECIPE as unknown as Recipe, sig.signature, sig.signedWithKeyId, META);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.version, 2);
      assert.equal(r.keyGeneration, 'active');
    }
  });

  test('flipping verified_against (mock→practice_room) breaks a v2 signature', () => {
    // The core attack: an unrehearsed recipe signed with verified_against='mock',
    // then a service-role UPDATE flips the COLUMN to 'practice_room'. In v1 the
    // body-only HMAC still verified; v2 folds the column into the payload so the
    // tampered meta no longer matches.
    const signedMeta = { ...META, verifiedAgainst: 'mock' };
    const sig = signWriteRecipe(WRITE_RECIPE as unknown as Recipe, signedMeta);
    const tamperedMeta = { ...META, verifiedAgainst: 'practice_room' };
    const r = verifyRecipe(WRITE_RECIPE as unknown as Recipe, sig.signature, sig.signedWithKeyId, tamperedMeta);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'mismatch');
  });

  test('transplanting a v2 recipe onto a different action_key breaks verification', () => {
    const sig = signWriteRecipe(WRITE_RECIPE as unknown as Recipe, META);
    const otherAction = { ...META, actionKey: 'mark_out_of_order' };
    const r = verifyRecipe(WRITE_RECIPE as unknown as Recipe, sig.signature, sig.signedWithKeyId, otherAction);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'mismatch');
  });

  test('transplanting a v2 recipe onto a different pms_family breaks verification', () => {
    const sig = signWriteRecipe(WRITE_RECIPE as unknown as Recipe, META);
    const otherFamily = { ...META, pmsFamily: 'opera_cloud' };
    const r = verifyRecipe(WRITE_RECIPE as unknown as Recipe, sig.signature, sig.signedWithKeyId, otherFamily);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'mismatch');
  });

  test('a v2 signature verified WITHOUT bound meta fails closed (meta_required)', () => {
    // A v2 row can never be verified as v1 — the metadata is part of the payload,
    // so a caller that forgets to pass it must fail closed, not silently succeed.
    const sig = signWriteRecipe(WRITE_RECIPE as unknown as Recipe, META);
    const r = verifyRecipe(WRITE_RECIPE as unknown as Recipe, sig.signature, sig.signedWithKeyId);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'meta_required');
  });

  test('mutating the recipe body still breaks a v2 signature', () => {
    const sig = signWriteRecipe(WRITE_RECIPE as unknown as Recipe, META);
    const tampered: WriteActionRecipe = {
      ...WRITE_RECIPE,
      steps: [{ kind: 'save', selector: 'button.exfiltrate', scope: 'row' }],
    };
    const r = verifyRecipe(tampered as unknown as Recipe, sig.signature, sig.signedWithKeyId, META);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'mismatch');
  });

  test('v2 survives the jsonb JSON round-trip (stored === signed shape)', () => {
    const sig = signWriteRecipe(WRITE_RECIPE as unknown as Recipe, META);
    const readBack = JSON.parse(JSON.stringify(WRITE_RECIPE)) as WriteActionRecipe;
    const r = verifyRecipe(readBack as unknown as Recipe, sig.signature, sig.signedWithKeyId, META);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.version, 2);
  });
});

describe('recipe-signing v1 — READ fallback unchanged (ITEM C)', () => {
  test('a v1 signature (body only) still verifies and reports version 1', () => {
    // Knowledge-file (read) recipes are v1; the READ path must keep verifying
    // them. version:1 is the discriminator the WRITE path uses to REJECT them.
    const sig = signRecipe(WRITE_RECIPE as unknown as Recipe);
    const r = verifyRecipe(WRITE_RECIPE as unknown as Recipe, sig.signature, sig.signedWithKeyId);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.version, 1);
  });

  test('a v1 signature verifies EVEN when bound meta is passed (meta ignored for v1)', () => {
    // Passing meta must not change v1 behavior — the marker (not the meta arg)
    // selects the path, so a legacy v1 row keeps verifying.
    const sig = signRecipe(WRITE_RECIPE as unknown as Recipe);
    const r = verifyRecipe(WRITE_RECIPE as unknown as Recipe, sig.signature, sig.signedWithKeyId, META);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.version, 1);
  });

  test('a v1 signature is NOT accepted as v2 — write path rejects it on version', () => {
    // The handler requires verify.version === 2. A v1 signature reports version 1
    // even on success, so the write path refuses it (write_recipe_v1_signature_rejected).
    const sig = signRecipe(WRITE_RECIPE as unknown as Recipe);
    const r = verifyRecipe(WRITE_RECIPE as unknown as Recipe, sig.signature, sig.signedWithKeyId, META);
    assert.equal(r.ok, true);
    if (r.ok) assert.notEqual(r.version, 2);
  });

  test('v2 key rotation: a previous-key v2 signature still verifies during grace', () => {
    const previousKey = process.env.RECIPE_SIGNING_KEY_PREVIOUS!;
    // Re-derive the exact v2 payload the module signs, then HMAC with the OLD key.
    const payload = canonicalJson({
      recipe: WRITE_RECIPE,
      meta: { actionKey: META.actionKey, pmsFamily: META.pmsFamily, verifiedAgainst: META.verifiedAgainst },
      v: 2,
    });
    const oldHmac = createHmac('sha256', previousKey).update(payload).digest();
    const oldSig = Buffer.concat([Buffer.from('v2:', 'ascii'), oldHmac]);
    const r = verifyRecipe(WRITE_RECIPE as unknown as Recipe, oldSig, 'irrelevant', META);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.version, 2);
      assert.equal(r.keyGeneration, 'previous');
    }
  });
});

// ─── ITEM B — per-property rehost contract (wrong-hotel guard input) ─────────

describe('rehostFeedUrl — write pageUrl rehost contract (ITEM B)', () => {
  const familyStartUrl = 'https://mapper-tenant.opera.com/login';

  test('a per-subdomain PMS rehosts the recipe pageUrl onto THIS hotel origin', () => {
    // The learn-time pageUrl lives on the mapper tenant; the per-hotel login URL
    // is a sibling subdomain. The rehost must swap the origin so the write drives
    // THIS hotel's PMS, not the mapper hotel's.
    const recipePageUrl = 'https://mapper-tenant.opera.com/housekeeping?tab=rooms';
    const perHotel = 'https://hotel-b.opera.com/login';
    const out = rehostFeedUrl(recipePageUrl, familyStartUrl, perHotel);
    assert.equal(out, 'https://hotel-b.opera.com/housekeeping?tab=rooms');
    assert.equal(new URL(out).origin, 'https://hotel-b.opera.com');
  });

  test('a single-host PMS (no per-hotel URL) is a no-op — verbatim pageUrl', () => {
    // Choice Advantage: tenancy is by session, no per-hotel origin to rehost to.
    const recipePageUrl = 'https://app.choiceadvantage.com/housekeeping';
    const out = rehostFeedUrl(recipePageUrl, familyStartUrl, null);
    assert.equal(out, recipePageUrl);
  });
});

// ─── ITEM D — idempotency short-circuit precedes the precondition ────────────

/** A recipe whose precondition is the INVERSE of the target: "only mark
 *  <target> if the row is currently <opposite>". After the write lands the
 *  precondition is false, so it must NOT be checked before the idempotency
 *  short-circuit on a retry. */
function inversePreconditionRecipe(mockUrl: string, currentBefore: string): WriteActionRecipe {
  return {
    key: 'set_room_status',
    requiredParams: ['room_number', 'target_status'],
    paramEnums: { target_status: MOCK_STATUSES },
    pageUrl: `${mockUrl}/housekeeping`,
    loggedInSelector: '#hk',
    rowLocator: { rowSelector: '#hk tbody tr', matchCell: 'td.room', matchParam: 'room_number' },
    // Precondition: the row is currently the OPPOSITE of the target (i.e. the
    // pre-write value). True on the first write, FALSE once the write landed.
    precondition: { selector: 'td.current', scope: 'row', equals: currentBefore },
    steps: [
      { kind: 'select', selector: 'select[name="status"]', value: '$payload.target_status', scope: 'row' },
      { kind: 'save', selector: 'button.save', scope: 'row' },
    ],
    verifyInPage: { selector: 'td.current', scope: 'row', equals: '$payload.target_status' },
    verifiedAgainst: 'mock',
  };
}

const OPTS = { dryRun: false, allowLoopback: true };

test('ITEM D: a retry of an already-applied write with an inverse precondition returns idempotent success', async () => {
  const mock = await startMockPms();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // Seed value for 204 is 'Dirty' (mock SEED). Recipe: mark 'Clean' ONLY if
    // currently 'Dirty'.
    const recipe = inversePreconditionRecipe(mock.url, 'Dirty');
    const payload = { room_number: '204', target_status: 'Clean' };

    // First write: precondition (Dirty) holds → the write lands.
    const r1 = await executeWriteRecipe(page, recipe, payload, OPTS);
    assert.equal(r1.ok, true);
    assert.equal(mock.getStatus('204'), 'Clean');

    // Retry (at-least-once redelivery): row is already 'Clean', so the
    // precondition ('still Dirty') is now FALSE. Pre-fix this returned
    // precondition_failed (a terminal failure on a max_attempts=1 write).
    // Post-fix the idempotency short-circuit runs first and reports success.
    const r2 = await executeWriteRecipe(page, recipe, payload, OPTS);
    assert.equal(r2.ok, true);
    if (r2.ok) assert.equal(r2.verifiedVia, 'idempotent');
    assert.equal(mock.getStatus('204'), 'Clean'); // no second mutation
  } finally {
    await browser.close();
    await mock.stop();
  }
});

test('ITEM D: the precondition STILL guards a genuinely-not-yet-applied write', async () => {
  // Reordering must not disable the precondition for a fresh (non-idempotent)
  // write. Set a precondition that is FALSE from the start (row is 'Dirty' but
  // the precondition demands 'Inspected'); the write must be refused, unmutated.
  const mock = await startMockPms();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const before = mock.getStatus('204'); // 'Dirty'
    const recipe = inversePreconditionRecipe(mock.url, 'Inspected'); // precondition never holds
    const res = await executeWriteRecipe(page, recipe, { room_number: '204', target_status: 'Clean' }, OPTS);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error, 'precondition_failed');
    assert.equal(mock.getStatus('204'), before); // never mutated
  } finally {
    await browser.close();
    await mock.stop();
  }
});
