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

// ─── ENVELOPE round-trip (the sign/verify split-brain regression) ─────────
//
// The store path (mapping-driver.ts saveDraftKnowledgeFile) does NOT sign the
// bare recipe — it wraps it in a `knowledge` ENVELOPE (schema/description/hints
// injected) and signs THAT exact object, then persists it. loadActive later
// canonicalJson-verifies the stored envelope. If those two shapes ever diverge,
// EVERY auto-mapped recipe fails verification and (under enforce) every hotel on
// that family goes recipe-less. The round-trip test above signs and verifies the
// SAME object, so it is structurally BLIND to that divergence. These tests close
// the gap by reproducing the real envelope shape.

/**
 * Mirror of saveDraftKnowledgeFile's envelope construction (keep in sync). The
 * load-bearing detail is the injected `hints: {}` default and the `description`
 * fallback — keys the bare recipe lacks, which is exactly what the old bug
 * canonicalJson-diffed away into a permanent 'mismatch'.
 */
function buildEnvelope(recipe: Recipe, version = 1): Record<string, unknown> {
  return {
    schema: 1,
    description: recipe.description ?? `Auto-mapped by mapping-driver (v${version})`,
    login: recipe.login,
    actions: recipe.actions,
    hints: recipe.hints ?? {},
    ...(recipe.valueTranslations ? { valueTranslations: recipe.valueTranslations } : {}),
    ...(recipe.dateFormat ? { dateFormat: recipe.dateFormat } : {}),
  };
}

describe('ENVELOPE sign/verify — signed payload === stored payload', () => {
  test('signing the envelope and verifying the envelope succeeds', () => {
    const envelope = buildEnvelope(SAMPLE_RECIPE);
    const { signature, signedWithKeyId } = signRecipe(envelope as unknown as Recipe);
    const result = verifyRecipe(envelope as unknown as Recipe, signature, signedWithKeyId);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.keyGeneration, 'active');
  });

  test('REGRESSION: signing the BARE recipe but verifying the ENVELOPE → mismatch', () => {
    // The exact pre-fix bug: signRecipe(recipe) over the bare shape (no
    // `hints`, no `description`), then verifyRecipe against the envelope the
    // DB actually stored (with `hints:{}` + description injected). canonicalJson
    // key-sorts and the envelope carries keys the bare recipe lacks, so the
    // digests never match. The signed side OMITS the optional fields; the
    // verify side INCLUDES them.
    const { signature, signedWithKeyId } = signRecipe(SAMPLE_RECIPE); // bare
    const envelope = buildEnvelope(SAMPLE_RECIPE);                    // +hints +description
    const result = verifyRecipe(envelope as unknown as Recipe, signature, signedWithKeyId);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'mismatch');
  });
});

// ─── jsonb round-trip stability (present-undefined divergence class) ──────
//
// saveDraftKnowledgeFile signs AND stores JSON.parse(JSON.stringify(envelope))
// — the exact shape jsonb persists and returns. The danger it guards: jsonb
// silently DROPS a present-but-`undefined` nested field, but canonicalJson of
// the raw in-memory object emits a literal `"k":undefined` for it. So signing
// the raw object then verifying the read-back (jsonb) row would mismatch
// forever → under enforce, the whole pms_family goes recipe-less. These tests
// pin that signing the JSON-NORMALIZED shape survives the round-trip, and that
// signing the RAW shape would NOT (the bug the normalization prevents).

const ENVELOPE_WITH_UNDEFINED = {
  schema: 1 as const,
  description: 'has a present-undefined nested field',
  login: {
    startUrl: 'https://app.example.com/login',
    // A login step carrying an explicit `undefined` optional — the exact
    // shape a future builder could emit. jsonb will drop `timeoutMs`.
    steps: [{ kind: 'fill', selector: 'input', value: '$username', timeoutMs: undefined }],
    successSelectors: ['.dashboard'],
  },
  actions: SAMPLE_RECIPE.actions,
  hints: {},
};

describe('signed payload survives the jsonb JSON round-trip', () => {
  test('signing the JSON-normalized envelope verifies against the round-tripped shape', () => {
    // What saveDraftKnowledgeFile now does: normalize, sign, store the same.
    const stored = JSON.parse(JSON.stringify(ENVELOPE_WITH_UNDEFINED));
    const { signature, signedWithKeyId } = signRecipe(stored as unknown as Recipe);
    const readBack = JSON.parse(JSON.stringify(stored)); // jsonb round-trip ≈ JSON round-trip
    const result = verifyRecipe(readBack as unknown as Recipe, signature, signedWithKeyId);
    assert.equal(result.ok, true);
  });

  test('REGRESSION: signing the RAW (present-undefined) envelope but verifying the round-tripped shape → mismatch', () => {
    // The pre-normalization hazard: the raw object has `timeoutMs: undefined`,
    // canonicalJson emits "timeoutMs":undefined, but the stored/read-back row
    // dropped the key. Digests differ → mismatch. This is exactly why
    // saveDraftKnowledgeFile normalizes before signing.
    const { signature, signedWithKeyId } = signRecipe(ENVELOPE_WITH_UNDEFINED as unknown as Recipe);
    const readBack = JSON.parse(JSON.stringify(ENVELOPE_WITH_UNDEFINED));
    const result = verifyRecipe(readBack as unknown as Recipe, signature, signedWithKeyId);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'mismatch');
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

describe('verifyRecipe — no_signature means signature-absent ONLY (key-id is metadata)', () => {
  test('present signature + NULL key-id still verifies (key-id is not in the HMAC)', () => {
    // Regression for the false-positive: a validly-signed row whose
    // signed_with_key_id is NULL (legacy/edge data) must NOT be refused. The
    // key-id never feeds the HMAC, so verification proceeds and succeeds.
    const { signature } = signRecipe(SAMPLE_RECIPE);
    const result = verifyRecipe(SAMPLE_RECIPE, signature, null);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.keyGeneration, 'active');
  });

  test('NULL signature → no_signature even when a key-id is present', () => {
    const result = verifyRecipe(SAMPLE_RECIPE, null, 'e942f947');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'no_signature');
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
