/**
 * Tests for cua-service/src/recipe-signing.ts.
 *
 * Plan v2 F-AI-2 (Chain A close). These tests pin the invariants that
 * make a tampered or wrong-key recipe fail verification:
 *
 *   - Identical recipes sign identically (canonical JSON is deterministic).
 *   - Mutating ANY nested field invalidates the signature.
 *   - Key rotation: an old-key signature verifies during grace window only.
 *   - Length-mismatched signatures don't crash the verifier.
 *
 * Pure-function tests — no DB, no network. The recipe-signing module
 * reads RECIPE_SIGNING_KEY from `env`, so the test sets env vars before
 * import. (Once recipe-signing.ts is loaded, the env module caches the
 * parsed values — flipping process.env at runtime after import is not
 * reflected. So we set the test env once at module top.)
 */

// Required env BEFORE the import — see header comment.
process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'placeholder-service-role-key-min-20-chars';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-placeholder-for-tests';
process.env.RECIPE_SIGNING_KEY = process.env.RECIPE_SIGNING_KEY ?? 'test-recipe-key-32-bytes-or-more-padding';
process.env.RECIPE_SIGNING_KEY_PREVIOUS = process.env.RECIPE_SIGNING_KEY_PREVIOUS ?? 'previous-recipe-key-32-bytes-or-more!';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  canonicalJson,
  signRecipe,
  verifyRecipe,
  isRecipeSigningConfigured,
  recipeSigningMode,
} from '../recipe-signing.js';
import type { Recipe } from '../types.js';

const SAMPLE_RECIPE: Recipe = {
  schema: 1,
  login: {
    startUrl: 'https://app.choiceadvantage.com/login',
    steps: [
      { kind: 'fill', selector: 'input[name=user]', value: '$username' },
      { kind: 'fill', selector: 'input[name=pass]', value: '$password' },
      { kind: 'click', selector: 'button[type=submit]' },
    ],
    successSelectors: ['.dashboard'],
    timeoutMs: 30_000,
  },
  actions: {
    getRoomStatus: {
      steps: [{ kind: 'goto', url: 'https://app.choiceadvantage.com/rooms' }],
      parse: {
        mode: 'table',
        hint: {
          rowSelector: 'tr.room',
          columns: { number: 'td.num', status: 'td.status' },
        },
      },
    },
  },
};

// ─── canonicalJson ───────────────────────────────────────────────────────

describe('canonicalJson — deterministic order', () => {
  test('object keys sorted alphabetically', () => {
    const a = canonicalJson({ b: 1, a: 2, c: 3 });
    const b = canonicalJson({ c: 3, a: 2, b: 1 });
    assert.equal(a, b);
    assert.equal(a, '{"a":2,"b":1,"c":3}');
  });

  test('arrays preserve order (step order is data-bearing)', () => {
    const a = canonicalJson([3, 1, 2]);
    assert.equal(a, '[3,1,2]');
  });

  test('nested objects are recursively sorted', () => {
    const a = canonicalJson({ outer: { z: 1, a: 2 }, b: 3 });
    assert.equal(a, '{"b":3,"outer":{"a":2,"z":1}}');
  });

  test('null + primitives serialize as JSON', () => {
    assert.equal(canonicalJson(null), 'null');
    assert.equal(canonicalJson(42), '42');
    assert.equal(canonicalJson('hi'), '"hi"');
    assert.equal(canonicalJson(true), 'true');
  });
});

// ─── signRecipe / verifyRecipe ───────────────────────────────────────────

describe('signRecipe → verifyRecipe round-trip', () => {
  test('signs and verifies with the active key', () => {
    const { signature, signedWithKeyId, signedAt } = signRecipe(SAMPLE_RECIPE);
    assert.ok(Buffer.isBuffer(signature));
    assert.equal(signature.length, 32); // SHA-256 → 32 bytes
    assert.ok(/^[0-9a-f]{8}$/.test(signedWithKeyId));
    assert.ok(!Number.isNaN(Date.parse(signedAt)));

    const result = verifyRecipe(SAMPLE_RECIPE, signature, signedWithKeyId);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.keyGeneration, 'active');
  });

  test('verifies the same recipe regardless of key order (canonical JSON)', () => {
    const { signature, signedWithKeyId } = signRecipe(SAMPLE_RECIPE);
    // Build the recipe with keys in a different insertion order; the
    // canonical form is the same, so the signature should still verify.
    const shuffled = {
      actions: SAMPLE_RECIPE.actions,
      login: SAMPLE_RECIPE.login,
      schema: 1 as const,
    };
    const result = verifyRecipe(shuffled, signature, signedWithKeyId);
    assert.equal(result.ok, true);
  });
});

describe('verifyRecipe — tamper detection', () => {
  test('mutating a selector breaks the signature', () => {
    const { signature, signedWithKeyId } = signRecipe(SAMPLE_RECIPE);
    const tampered: Recipe = {
      ...SAMPLE_RECIPE,
      login: {
        ...SAMPLE_RECIPE.login,
        steps: [
          // attacker swaps the selector
          { kind: 'fill', selector: 'input[name=share_email]', value: '$password' },
          ...SAMPLE_RECIPE.login.steps.slice(1),
        ],
      },
    };
    const result = verifyRecipe(tampered, signature, signedWithKeyId);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'mismatch');
  });

  test('mutating an action step URL breaks the signature', () => {
    const { signature, signedWithKeyId } = signRecipe(SAMPLE_RECIPE);
    const tampered: Recipe = {
      ...SAMPLE_RECIPE,
      actions: {
        ...SAMPLE_RECIPE.actions,
        getRoomStatus: {
          ...SAMPLE_RECIPE.actions.getRoomStatus!,
          steps: [{ kind: 'goto', url: 'https://app.choiceadvantage.com/admin/users' }],
        },
      },
    };
    const result = verifyRecipe(tampered, signature, signedWithKeyId);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'mismatch');
  });

  test('NULL signature → no_signature', () => {
    const result = verifyRecipe(SAMPLE_RECIPE, null, null);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'no_signature');
  });

  test('wrong-length signature buffer → mismatch (does not throw)', () => {
    const { signedWithKeyId } = signRecipe(SAMPLE_RECIPE);
    const result = verifyRecipe(SAMPLE_RECIPE, Buffer.from('too-short'), signedWithKeyId);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'mismatch');
  });
});

describe('verifyRecipe — key rotation grace window', () => {
  test('signature from the PREVIOUS key still verifies and reports it', () => {
    const previousKey = process.env.RECIPE_SIGNING_KEY_PREVIOUS!;
    const payload = canonicalJson(SAMPLE_RECIPE);
    const oldSig = createHmac('sha256', previousKey).update(payload).digest();

    // signedWithKeyId is a fingerprint — the verifier tries the active
    // key first, then the previous. The keyId value isn't used to pick
    // which key to try; it's just metadata for the operator.
    const result = verifyRecipe(SAMPLE_RECIPE, oldSig, 'irrelevant');
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.keyGeneration, 'previous');
  });
});

// ─── configuration helpers ───────────────────────────────────────────────

describe('configuration helpers', () => {
  test('isRecipeSigningConfigured reflects active-key presence', () => {
    assert.equal(isRecipeSigningConfigured(), true);
  });

  test('recipeSigningMode defaults to warn', () => {
    // process.env.RECIPE_SIGNING_ENFORCE wasn't set above → falls back to 'warn'.
    assert.equal(recipeSigningMode(), 'warn');
  });
});
