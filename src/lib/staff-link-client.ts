// Client-side helpers for the per-staff link token (security audit 2026-06-26
// #1). The public mobile pages (/housekeeper/[id], /laundry/[id],
// /engineer/[id]) read the `tok` from their own URL and must forward it on
// every API call — it's the credential the server verifies
// (src/lib/staff-link-auth.ts). staffId in the URL is no longer sufficient.
//
// These are tiny, dependency-free, and safe to call in the browser only.

/** Read the raw `tok` from the current page URL, or '' if absent. */
export function getStaffLinkTokenFromUrl(): string {
  if (typeof window === 'undefined') return '';
  try {
    return new URLSearchParams(window.location.search).get('tok') ?? '';
  } catch {
    return '';
  }
}

/**
 * Append `&tok=` (or `?tok=`) to a same-origin API path for GET requests.
 * No-op if there's no token in the URL (the server then returns 401, which is
 * the correct behaviour for a link that arrived without a token).
 */
export function withStaffLinkToken(url: string, tok = getStaffLinkTokenFromUrl()): string {
  if (!tok) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}tok=${encodeURIComponent(tok)}`;
}

/**
 * Fold the link token into a POST body object so the server can read it from
 * `body.tok`. Returns a shallow copy with `tok` set (unless already present).
 */
export function withStaffLinkTokenBody<T extends Record<string, unknown>>(
  body: T,
  tok = getStaffLinkTokenFromUrl(),
): T & { tok?: string } {
  if (!tok) return body;
  return { ...body, tok };
}
