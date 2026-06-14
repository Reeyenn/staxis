// ─── Recipe signing — HMAC-SHA256 over canonical JSON ────────────────────
//
// Plan v2 F-AI-2 (Chain A close). Every `pms_knowledge_files.knowledge` row
// carries a signature in its `signature` BYTEA column. We sign at write
// time in the CUA worker (mapping-driver); recipe-runner verifies before
// each replay. A tampered row (anyone with brief service-role access) is
// refused — defence-in-depth against the case where a poisoned recipe
// stays on the PMS domain (so safeGoto can't catch it) and silently fills
// `$password` into a same-origin share/email form.
//
// Why HMAC, not asymmetric: the only signer (CUA worker) and the only
// verifier (CUA worker on a future pull job) share the same trust
// boundary (Fly secrets). Symmetric is enough and cheaper.
//
// Why canonical JSON: `JSON.stringify` doesn't guarantee key order, which
// would silently invalidate every signature on the next save. We sort
// keys recursively and use no whitespace.
//
// Why a key-id alongside the signature: when the key rotates, the
// verifier tries the active key first, then the previous key for a grace
// window. Without an id we can't tell which key produced an old row.

import { createHmac } from 'node:crypto';
import { env } from './env.js';
import type { Recipe, WriteActionRecipe } from './types.js';

/**
 * Short identifier for the active signing key. Derived from the first 8
 * hex chars of SHA-256(key) so we don't store the literal key id anywhere
 * but can still distinguish a current vs previous key without knowing
 * either value. Computed lazily.
 */
let cachedKeyId: string | null = null;
function activeKeyId(): string {
  if (cachedKeyId) return cachedKeyId;
  const key = env.RECIPE_SIGNING_KEY;
  if (!key) {
    // Caller is responsible for gating on env existence; if we got this
    // far without it, surface a clear error rather than fingerprint the
    // empty string.
    throw new Error('RECIPE_SIGNING_KEY is not set');
  }
  // 8 hex chars = 32 bits — enough to distinguish active vs previous
  // generations without leaking key length / structure.
  cachedKeyId = createHmac('sha256', '__staxis_recipe_key_id__')
    .update(key)
    .digest('hex')
    .slice(0, 8);
  return cachedKeyId;
}

/**
 * Canonical JSON of an arbitrary value. Recursively sorts object keys;
 * arrays preserve order (their order is data-bearing in recipes — step
 * order is meaningful); primitives serialize as JSON.stringify would.
 *
 * The output is a deterministic string given the same input value, so
 * HMACing it yields a deterministic signature.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const inner = keys.map((k) => {
    const v = (value as Record<string, unknown>)[k];
    return `${JSON.stringify(k)}:${canonicalJson(v)}`;
  });
  return `{${inner.join(',')}}`;
}

export interface RecipeSignature {
  signature: Buffer;
  signedWithKeyId: string;
  signedAt: string; // ISO timestamp
}

/**
 * Compute the signature for a recipe using the active signing key.
 * Throws when `RECIPE_SIGNING_KEY` is missing — the caller MUST check
 * env first (see `isRecipeSigningConfigured`).
 */
export function signRecipe(recipe: Recipe | WriteActionRecipe): RecipeSignature {
  const key = env.RECIPE_SIGNING_KEY;
  if (!key) throw new Error('RECIPE_SIGNING_KEY is not set');
  const payload = canonicalJson(recipe);
  const signature = createHmac('sha256', key).update(payload).digest();
  return {
    signature,
    signedWithKeyId: activeKeyId(),
    signedAt: new Date().toISOString(),
  };
}

export type VerifyResult =
  | { ok: true; keyGeneration: 'active' | 'previous' }
  | { ok: false; reason: 'no_signature' | 'no_key_configured' | 'mismatch' };

/**
 * Verify a stored signature against the canonical JSON of the recipe.
 * Returns { ok: true, keyGeneration: 'active'|'previous' } on success.
 *
 * Tries the active key first; on mismatch, tries the previous key
 * (`RECIPE_SIGNING_KEY_PREVIOUS`) if set — this is the grace window for
 * a key rotation. After the grace window the previous-key env should be
 * unset so the verifier strictly requires the active key.
 *
 * Returns { ok: false, reason: 'no_signature' } ONLY when the row has no
 * stored `signature` BYTEA. A present signature with a NULL
 * `signed_with_key_id` is still verifiable: the key-id is operator-facing
 * metadata (which generation signed the row) and is NEVER an input to the
 * HMAC math below, so refusing on its absence wrongly rejected a validly
 * signed row — under enforce mode that silently halted polling. Callers
 * decide whether to refuse (enforce mode) or warn-and-proceed (warn
 * mode) based on the `RECIPE_SIGNING_ENFORCE` env.
 *
 * `storedKeyId` is retained in the signature for call-site compatibility
 * (loadActive / recipe-runner / write-job-handler pass it positionally)
 * and as a debugging breadcrumb in their log lines; it is intentionally
 * not consulted here.
 */
export function verifyRecipe(
  recipe: Recipe,
  storedSignature: Buffer | null,
  storedKeyId: string | null,
): VerifyResult {
  // `no_signature` means the signature column itself is NULL — nothing to
  // verify. A missing key-id does NOT count (see docstring): it isn't part
  // of the HMAC, so a present signature with a null key-id verifies below.
  if (!storedSignature) {
    return { ok: false, reason: 'no_signature' };
  }

  const active = env.RECIPE_SIGNING_KEY;
  const previous = env.RECIPE_SIGNING_KEY_PREVIOUS;
  if (!active && !previous) {
    return { ok: false, reason: 'no_key_configured' };
  }

  const payload = canonicalJson(recipe);

  if (active) {
    const expected = createHmac('sha256', active).update(payload).digest();
    if (timingSafeEqualBuf(expected, storedSignature)) {
      return { ok: true, keyGeneration: 'active' };
    }
  }
  if (previous) {
    const expected = createHmac('sha256', previous).update(payload).digest();
    if (timingSafeEqualBuf(expected, storedSignature)) {
      return { ok: true, keyGeneration: 'previous' };
    }
  }
  return { ok: false, reason: 'mismatch' };
}

/**
 * `crypto.timingSafeEqual` requires equal-length buffers and throws
 * otherwise; we want a constant-time check that simply returns false on
 * length mismatch.
 */
function timingSafeEqualBuf(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  // Inline constant-time compare; Buffer XOR works since both are equal length now.
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Has the operator configured signing? Used by the rollout: when no key
 * is set the worker logs a warning at boot and skips signing. The plan
 * is to set the key in the Fly secrets, deploy, run the backfill, then
 * flip `RECIPE_SIGNING_ENFORCE=enforce`. Each step is independent.
 */
export function isRecipeSigningConfigured(): boolean {
  return !!env.RECIPE_SIGNING_KEY;
}

/**
 * Returns 'enforce' or 'warn'. Defaults to 'warn' during the rollout —
 * a missing/invalid signature is logged but the replay continues. Once
 * 100% of rows are signed and the doctor's check is green, flip the env
 * to 'enforce' and the verifier refuses.
 */
export function recipeSigningMode(): 'enforce' | 'warn' {
  return env.RECIPE_SIGNING_ENFORCE === 'enforce' ? 'enforce' : 'warn';
}
