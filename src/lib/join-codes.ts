/**
 * Shared join-code generation. Two API routes mint codes and BOTH must
 * use the same alphabet + collision-retry logic, otherwise an admin-
 * issued code can collide differently from a self-service one.
 *
 * Phase M1: extracted from src/app/api/auth/join-codes/route.ts so the
 * new admin property-create endpoint can mint an owner code without
 * duplicating the alphabet (which would have drifted exactly like the
 * MISCONFIG_STATUSES four-place duplication that prior phases had to
 * unify).
 *
 * Security review 2026-05-16 (Pattern G): replaced Math.random() with
 * crypto.randomInt for uniform sampling, and bumped the suffix from 4
 * chars (~20 bits) to 10 chars (~50 bits). Combined with the 10/hr
 * IP-keyed rate limit on /api/onboard/wizard and /api/auth/use-join-code,
 * brute-force is no longer realistic. Plain Math.random() is a CSPRNG
 * footgun: predictable sequences if an attacker ever observes a few
 * outputs (V8's internal state is reconstructible).
 */

import { randomInt } from 'node:crypto';

// Excludes I/L/O for human readability (often confused with 1/0)
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
// Excludes 0/1 for the same reason
const CODE_ALPHANUM = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * Uniform random char selection from a fixed alphabet via node:crypto
 * randomInt — eliminates modulo bias AND the V8-state-reconstruction
 * footgun that comes with Math.random(). Do NOT swap back to
 * Math.random() — Pattern G security test (`join-code-entropy.test.ts`)
 * will fail the build.
 */
function randomCharsFromCSPRNG(set: string, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += set[randomInt(set.length)];
  return s;
}

/** Suffix length is the only entropy lever (the prefix is hotel-derived
 *  and reveals nothing about the secret part). 10 chars × log2(31) ≈ 50 bits;
 *  with a 10/hr IP-keyed rate limit at the route, brute-force ETA is
 *  effectively forever. Bump only if you also raise the user-typeability
 *  bar (e.g., generating QR codes instead of human-readable strings). */
const SUFFIX_LENGTH = 10;

/**
 * Returns a code like "BEAU-K9F2HXMPYR" — 4-letter prefix from hotel name
 * (or random letters), dash, SUFFIX_LENGTH-char alphanum. Caller must
 * handle DB-unique collision with retry; this is a string generator only.
 */
export function generateJoinCode(hotelName?: string | null): string {
  const prefix = hotelName
    ? hotelName.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase().padEnd(4, 'X')
    : randomCharsFromCSPRNG(CODE_LETTERS, 4);
  return `${prefix}-${randomCharsFromCSPRNG(CODE_ALPHANUM, SUFFIX_LENGTH)}`;
}

/**
 * Phase M1 default TTL + max-uses for the owner code generated when an
 * admin creates a new property. 7 days gives the owner plenty of time
 * to receive the code and sign up; max_uses=1 enforces "exactly one
 * person becomes the owner of this hotel".
 */
export const OWNER_CODE_TTL_HOURS = 24 * 7;
export const OWNER_CODE_MAX_USES = 1;

/**
 * Default for staff codes (used by /api/auth/join-codes POST). Wider
 * window because the owner shares the code with the whole hotel team.
 */
export const STAFF_CODE_TTL_HOURS = 24 * 7;
export const STAFF_CODE_MAX_USES = 100;
