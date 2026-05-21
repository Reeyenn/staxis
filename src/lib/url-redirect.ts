/**
 * Validate a `redirect` URL param for safe post-signin navigation.
 *
 * Used by /signin and /signin/verify to honor the middleware's
 * `?redirect=<original>` parameter without exposing an open-redirect
 * vector or letting the user land back on an auth page (which would
 * loop).
 *
 * Returns the validated value, or the fallback when the input fails any
 * of these checks:
 *   - empty / null / undefined
 *   - not starting with `/` (must be a same-origin absolute path)
 *   - protocol-relative `//evil.com/path` (browsers treat these as absolute)
 *   - contains `://` (full URL — never trust)
 *   - lands on an auth page (would redirect-loop)
 */

const BLOCKED_PREFIXES = ['/signin', '/signup', '/onboard', '/join', '/invite'] as const;

export function safeRedirect(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  if (!value.startsWith('/') || value.startsWith('//')) return fallback;
  if (value.includes('://')) return fallback;
  for (const prefix of BLOCKED_PREFIXES) {
    if (value === prefix || value.startsWith(`${prefix}/`) || value.startsWith(`${prefix}?`)) {
      return fallback;
    }
  }
  return value;
}
