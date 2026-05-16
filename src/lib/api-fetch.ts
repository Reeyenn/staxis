'use client';

/**
 * Browser-side helper: fetch wrapper that automatically adds the user's
 * Supabase access token as `Authorization: Bearer …`, and recovers from
 * session-validation failures so callers never have to.
 *
 * Three things it does that a raw fetch doesn't:
 *
 *   1. **Token preflight.** Before sending, it checks `session.expires_at`
 *      against the wall clock. If the token is within 60s of expiry (or
 *      already past), it calls `supabase.auth.refreshSession()` first and
 *      sends the fresh one. This eliminates the race where the SDK thinks
 *      the token is valid for 30 more seconds but the server's clock has
 *      already rolled past expiry — surfaces as "invalid session token" on
 *      the user's screen with no way to recover.
 *
 *   2. **401 auto-recovery.** When the server returns 401 with a structured
 *      `{ code }` body (see SessionFailureCode in src/lib/api-auth.ts):
 *        - `token_expired` / `missing_token` → refresh + retry once. If the
 *          retry still 401s, fall through to the hard-signout path.
 *        - `auth_unavailable` → transient Supabase outage. Return the
 *          response as-is; the user keeps their session, the caller can
 *          surface a "try again" message.
 *        - any other code → the session is irrecoverable. Sign out and
 *          route to `/signin?reason=session-ended`. Throws SessionEndedError
 *          so callers can short-circuit silently without rendering the raw
 *          error string.
 *
 *   3. **Header preservation.** Callers can still pass an explicit
 *      Authorization header (the /signin check-trust call does this), in
 *      which case we don't touch it.
 *
 * History: this file used to be a 15-line wrapper that just attached the
 * token. When server validation failed for any reason (expired token,
 * Supabase outage, env-var drift), the UI rendered a red "invalid session
 * token" pill and the user was stuck — no refresh, no signout, no path
 * forward. The fix lives here because EVERY authenticated request flows
 * through this function; centralizing recovery is one change instead of
 * patching ~40 call sites.
 */

import { supabase } from '@/lib/supabase';

/** Sentinel error thrown when we've signed the user out and started a
 *  redirect to /signin. Callers should catch this and bail silently — the
 *  page is about to navigate, no point setting error state or doing
 *  anything else.
 */
export class SessionEndedError extends Error {
  constructor() {
    super('SESSION_ENDED');
    this.name = 'SessionEndedError';
  }
}

// 60-second cushion. Refresh proactively if the token expires within this
// window. Picks up the same skew-tolerance Supabase recommends, without
// hammering the auth endpoint on every request (only triggers near expiry).
const REFRESH_BUFFER_SEC = 60;

// One in-flight refresh shared across concurrent fetchWithAuth calls. The
// chat panel + property loader + voice mint can all fire in the same tick;
// without this they each call refreshSession independently and Supabase
// returns 429 / mints multiple tokens in parallel.
let inFlightRefresh: Promise<string | null> | null = null;

async function refreshAndGetToken(): Promise<string | null> {
  if (!inFlightRefresh) {
    inFlightRefresh = (async () => {
      try {
        const { data, error } = await supabase.auth.refreshSession();
        if (error || !data.session?.access_token) return null;
        return data.session.access_token;
      } catch {
        return null;
      } finally {
        // Clear AFTER the promise resolves so simultaneous callers see the
        // same result; new callers after this point will mint a fresh one.
        setTimeout(() => { inFlightRefresh = null; }, 0);
      }
    })();
  }
  return inFlightRefresh;
}

/** Return a usable access token, refreshing it first if it's expired or
 *  close to expiring. Returns null when there's no session at all (signed
 *  out) — caller proceeds without an Authorization header.
 */
async function getFreshAccessToken(): Promise<string | null> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return null;

    const nowSec = Math.floor(Date.now() / 1000);
    const expiresAt = typeof session.expires_at === 'number' ? session.expires_at : 0;
    const needsRefresh = expiresAt > 0 && expiresAt - nowSec < REFRESH_BUFFER_SEC;
    if (!needsRefresh) return session.access_token;

    const fresh = await refreshAndGetToken();
    return fresh ?? session.access_token;  // fall back to the stale one; server will tell us
  } catch {
    return null;
  }
}

/** Read the structured `code` field from a 401 response without consuming
 *  the original body (so callers that want to read it can). Returns null if
 *  the body isn't JSON or doesn't have a code.
 */
async function readFailureCode(res: Response): Promise<string | null> {
  try {
    const clone = res.clone();
    const body = await clone.json();
    if (body && typeof body === 'object' && typeof body.code === 'string') {
      return body.code;
    }
    return null;
  } catch {
    return null;
  }
}

/** Force-signout + redirect to /signin. Fire-and-forget the signOut call
 *  so we don't block on it; the redirect tears the page down anyway. The
 *  throw is what stops the caller's continuation from executing (and from
 *  rendering "invalid session token" right before the redirect lands).
 */
function endSessionAndRedirect(reason: 'session-ended' | 'config-error'): never {
  if (typeof window !== 'undefined') {
    // If we're already on /signin (or /signin/verify, /signin/reset, etc.)
    // don't redirect to ourselves — let the in-page error handler take over.
    const here = window.location.pathname;
    if (!here.startsWith('/signin')) {
      // Don't await — page is being torn down.
      void supabase.auth.signOut();
      window.location.assign(`/signin?reason=${reason}`);
    }
  }
  throw new SessionEndedError();
}

function isAuthenticatedRetryable(code: string | null): boolean {
  return code === 'token_expired' || code === 'missing_token';
}

function isTransient(code: string | null): boolean {
  return code === 'auth_unavailable';
}

export async function fetchWithAuth(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const callerHeaders = new Headers(init?.headers ?? {});
  const callerSetAuth = callerHeaders.has('authorization') || callerHeaders.has('Authorization');

  async function send(token: string | null): Promise<Response> {
    const headers = new Headers(callerHeaders);
    if (!callerSetAuth && token) headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  }

  const token = callerSetAuth ? null : await getFreshAccessToken();
  const res = await send(token);

  // Happy path — no 401, nothing to recover from.
  if (res.status !== 401) return res;

  // Caller passed their own Authorization header. They've opted out of
  // recovery; let them handle the 401 themselves.
  if (callerSetAuth) return res;

  const code = await readFailureCode(res);

  // Transient Supabase outage. Don't sign the user out. Let the caller
  // surface a "try again" message.
  if (isTransient(code)) return res;

  // Project mismatch is a config bug, not a normal expiry. The user can't
  // fix it; signing them out won't help. Surface a distinct reason on the
  // signin page so the message is honest.
  if (code === 'project_mismatch') endSessionAndRedirect('config-error');

  // Recoverable: refresh the token and retry exactly once. If that retry
  // also 401s, we're out of moves — sign out cleanly.
  if (isAuthenticatedRetryable(code)) {
    const fresh = await refreshAndGetToken();
    if (fresh) {
      const retryRes = await send(fresh);
      if (retryRes.status !== 401) return retryRes;
    }
    endSessionAndRedirect('session-ended');
  }

  // Anything else (token_malformed, user_not_found, unknown, or no code at
  // all): the session is unrecoverable. Sign out, route to /signin.
  endSessionAndRedirect('session-ended');
}
