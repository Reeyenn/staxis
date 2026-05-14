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
 */

// Excludes I/L/O for human readability (often confused with 1/0)
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
// Excludes 0/1 for the same reason
const CODE_ALPHANUM = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCharsFrom(set: string, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += set[Math.floor(Math.random() * set.length)];
  return s;
}

/**
 * Returns a code like "BEAU-K9F2" — 4-letter prefix from hotel name
 * (or random letters), dash, 4 alphanum. Caller must handle DB-unique
 * collision with retry; this is a string generator only.
 */
export function generateJoinCode(hotelName?: string | null): string {
  const prefix = hotelName
    ? hotelName.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase().padEnd(4, 'X')
    : randomCharsFrom(CODE_LETTERS, 4);
  return `${prefix}-${randomCharsFrom(CODE_ALPHANUM, 4)}`;
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
