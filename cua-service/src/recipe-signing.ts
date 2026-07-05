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
 * The row metadata a v2 write-recipe signature binds ALONGSIDE the recipe
 * body. The HMAC covers only the recipe jsonb in v1, so a service-role
 * attacker can flip the sibling COLUMNS the write-job-handler's safety gates
 * key on — `verified_against` (provenance gate), or transplant a validly
 * signed recipe onto a different `action_key`/`pms_family` row — without
 * disturbing the signature. v2 folds those three columns into the signed
 * payload so any such tamper is caught by verification.
 *
 * `status` is DELIBERATELY excluded: it legitimately transitions
 * draft→active→deprecated by an operator, and re-signing on every status
 * flip would break that workflow. status is the enable-switch, not a
 * provenance claim; the provenance/routing columns are what v2 protects.
 */
export interface WriteRecipeBoundMeta {
  actionKey: string;
  pmsFamily: string;
  verifiedAgainst: string;
}

/**
 * v2 signatures carry this ASCII marker as a prefix so the verifier can tell
 * a v2 envelope from a bare v1 HMAC WITHOUT a schema column. A v1 signature
 * is exactly 32 bytes (raw SHA-256 HMAC); a v2 signature is this 3-byte
 * marker + a 32-byte HMAC (35 bytes), so the two can never be confused.
 */
const V2_MARKER = Buffer.from('v2:', 'ascii');

/** The exact bytes an HMAC-SHA256 digest occupies (v1 signature length). */
const HMAC_LEN = 32;

/**
 * Canonical signed payload for a v2 write-recipe signature. Binds the recipe
 * body AND the provenance/routing metadata under one HMAC. Keys are fixed +
 * sorted by canonicalJson, so this is deterministic across processes.
 */
function v2Payload(recipe: Recipe | WriteActionRecipe, meta: WriteRecipeBoundMeta): string {
  return canonicalJson({
    recipe,
    meta: {
      actionKey: meta.actionKey,
      pmsFamily: meta.pmsFamily,
      verifiedAgainst: meta.verifiedAgainst,
    },
    v: 2,
  });
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

/**
 * v2 signer for WRITE recipes — binds the recipe body PLUS the row's
 * provenance/routing columns (action_key, pms_family, verified_against) so
 * DB-side tampering of those columns can't slip an under-provenanced or
 * transplanted recipe past the write-job-handler's gates. The returned
 * `signature` is the v2 envelope (marker + HMAC) ready to store as bytea.
 * Throws when `RECIPE_SIGNING_KEY` is missing (same contract as signRecipe).
 */
export function signWriteRecipe(
  recipe: Recipe | WriteActionRecipe,
  meta: WriteRecipeBoundMeta,
): RecipeSignature {
  const key = env.RECIPE_SIGNING_KEY;
  if (!key) throw new Error('RECIPE_SIGNING_KEY is not set');
  const hmac = createHmac('sha256', key).update(v2Payload(recipe, meta)).digest();
  return {
    signature: Buffer.concat([V2_MARKER, hmac]),
    signedWithKeyId: activeKeyId(),
    signedAt: new Date().toISOString(),
  };
}

export type VerifyResult =
  | { ok: true; keyGeneration: 'active' | 'previous'; version: 1 | 2 }
  | { ok: false; reason: 'no_signature' | 'no_key_configured' | 'mismatch' | 'meta_required' };

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
  boundMeta?: WriteRecipeBoundMeta,
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

  // Dispatch on the stored signature's shape. A v2 envelope is the 3-byte
  // V2_MARKER + a 32-byte HMAC; anything else is treated as a bare v1 HMAC.
  // The marker can't collide with a v1 signature (32 bytes, no marker), so
  // this is an unambiguous discriminator without a schema column.
  const isV2 =
    storedSignature.length === V2_MARKER.length + HMAC_LEN &&
    storedSignature.subarray(0, V2_MARKER.length).equals(V2_MARKER);

  if (isV2) {
    // A v2 signature binds the provenance/routing metadata, so the caller
    // MUST supply it to reconstruct the signed payload. Fail closed if it
    // wasn't passed (a v2 row cannot be verified as v1).
    if (!boundMeta) {
      return { ok: false, reason: 'meta_required' };
    }
    const storedHmac = storedSignature.subarray(V2_MARKER.length);
    const payload = v2Payload(recipe, boundMeta);
    if (active) {
      const expected = createHmac('sha256', active).update(payload).digest();
      if (timingSafeEqualBuf(expected, storedHmac)) {
        return { ok: true, keyGeneration: 'active', version: 2 };
      }
    }
    if (previous) {
      const expected = createHmac('sha256', previous).update(payload).digest();
      if (timingSafeEqualBuf(expected, storedHmac)) {
        return { ok: true, keyGeneration: 'previous', version: 2 };
      }
    }
    return { ok: false, reason: 'mismatch' };
  }

  // v1: HMAC over the recipe body only. Retained for READ recipes (knowledge
  // files) whose signatures predate v2; the WRITE path requires v2 (see
  // write-job-handler) so this fallback never re-opens the metadata-tamper gap
  // there.
  const payload = canonicalJson(recipe);

  if (active) {
    const expected = createHmac('sha256', active).update(payload).digest();
    if (timingSafeEqualBuf(expected, storedSignature)) {
      return { ok: true, keyGeneration: 'active', version: 1 };
    }
  }
  if (previous) {
    const expected = createHmac('sha256', previous).update(payload).digest();
    if (timingSafeEqualBuf(expected, storedSignature)) {
      return { ok: true, keyGeneration: 'previous', version: 1 };
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
