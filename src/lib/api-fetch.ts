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
 *        - `auth_unavailable` → transient Supabase outage. Return the
 *          response as-is; the user keeps their session, the caller can
 *          surface a "try again" message.
 *        - everything else → refresh the token and retry. The user is only
 *          signed out when the session is DEFINITIVELY dead:
 *            · Supabase's auth API explicitly rejected the refresh token
 *              (invalid / revoked / already used), or
 *            · a freshly-refreshed token still 401s — after a short-delay
 *              second retry — with a server-issued identity code.
 *          A refresh that fails for transient reasons (network blip, 5xx,
 *          429, timeout) NEVER signs the user out: the 401 is returned to
 *          the caller as a retryable error and the session survives. This
 *          policy exists because the old "one failed refresh = hard
 *          signout" rule was randomly logging the owner out mid-session
 *          (2026-07-13).
 *          Hard signout routes to `/signin?reason=session-ended` and throws
 *          SessionEndedError so callers can short-circuit silently.
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

import { clearSupabaseBrowserSessionCookies, supabase } from '@/lib/supabase';
import {
  composeAbortSignals,
  raceWithAbortSignal,
  requestAbortSignals,
  RequestTimeoutError,
  timeoutAbortSignal,
  withPromiseDeadline,
} from '@/lib/fetch-deadline';

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

/** Browser auth methods must never keep a navigation waiting indefinitely. */
export const AUTH_OPERATION_TIMEOUT_MS = 8_000;

/** Supabase Auth's installed default cross-tab lock-acquire budget. */
export const AUTH_LOCK_ACQUIRE_TIMEOUT_MS = 5_000;

/**
 * End-to-end budget for SDK methods that can install a browser session.
 *
 * The auth transport's 8s deadline does not begin until GoTrue acquires its
 * cross-tab lock, which may legitimately take up to 5s. Leave another 4s for
 * response parsing, cookie persistence and synchronous auth listeners. A
 * shorter outer deadline can incorrectly declare a valid password/OTP failed
 * while the SDK is still installing the session in the background.
 */
export const AUTH_SESSION_OPERATION_TIMEOUT_MS = (
  AUTH_LOCK_ACQUIRE_TIMEOUT_MS
  + AUTH_OPERATION_TIMEOUT_MS
  + 4_000
);

/** End-to-end budget for ordinary authenticated GET/HEAD navigation reads. */
export const NAVIGATION_FETCH_TIMEOUT_MS = 10_000;

/** Explicit budget for interactive writes whose UI otherwise stays busy.
 * Mutations do not auto-retry: a lost response is an ambiguous outcome and
 * callers must reconcile or reuse their idempotency key before trying again.
 */
export const INTERACTIVE_ACTION_TIMEOUT_MS = 30_000;

// Mutable only through the test hook below; production always uses the bound.
let authOperationTimeoutMs = AUTH_OPERATION_TIMEOUT_MS;

/** Outcome of a refresh attempt. `terminal: true` means Supabase's auth API
 *  DEFINITIVELY rejected the session (refresh token invalid / revoked /
 *  already used / session gone) — the only refresh failure that justifies
 *  signing the user out. Everything else (network error, 5xx, 429, timeout,
 *  odd empty response) is transient: keep the session, let the caller retry.
 */
type RefreshOutcome = { token: string | null; terminal: boolean };

function isTerminalRefreshError(error: { status?: number; code?: string; message?: string }): boolean {
  // supabase-js v2 surfaces structured codes on AuthApiError for definitive
  // rejections; older paths only carry status+message. Recognize both.
  const code = String(error.code ?? '');
  if (/refresh_token_not_found|refresh_token_already_used|session_not_found|invalid_grant|flow_state_not_found/i.test(code)) {
    return true;
  }
  const msg = String(error.message ?? '');
  if (/invalid refresh token|refresh token not found|already used|revoked|session.*(missing|not found|expired)/i.test(msg)) {
    return true;
  }
  // 4xx from the auth endpoint = the server understood us and said no.
  // 5xx / 429 / no status (network) = transient.
  const status = typeof error.status === 'number' ? error.status : 0;
  return status === 400 || status === 401 || status === 403 || status === 404;
}

// One in-flight refresh shared across concurrent fetchWithAuth calls. The
// chat panel + property loader + voice mint can all fire in the same tick;
// without this they each call refreshSession independently and Supabase
// returns 429 / mints multiple tokens in parallel.
let inFlightRefresh: Promise<RefreshOutcome> | null = null;

async function refreshSessionVerdict(signal?: AbortSignal): Promise<RefreshOutcome> {
  if (!inFlightRefresh) {
    inFlightRefresh = (async (): Promise<RefreshOutcome> => {
      try {
        const { data, error } = await withPromiseDeadline(
          supabase.auth.refreshSession(),
          { timeoutMs: authOperationTimeoutMs, label: 'Session refresh' },
        );
        if (error) return { token: null, terminal: isTerminalRefreshError(error) };
        if (!data.session?.access_token) return { token: null, terminal: false };
        return { token: data.session.access_token, terminal: false };
      } catch {
        // Thrown = network-level failure. Never terminal.
        return { token: null, terminal: false };
      } finally {
        // Clear AFTER the promise resolves so simultaneous callers see the
        // same result; new callers after this point will mint a fresh one.
        setTimeout(() => { inFlightRefresh = null; }, 0);
      }
    })();
  }
  return raceWithAbortSignal(inFlightRefresh, signal);
}

async function refreshAndGetToken(signal?: AbortSignal): Promise<string | null> {
  return (await refreshSessionVerdict(signal)).token;
}

/** Return a usable access token, refreshing it first if it's expired or
 *  close to expiring. Returns null when there's no session at all (signed
 *  out) — caller proceeds without an Authorization header.
 */
async function getFreshAccessToken(signal?: AbortSignal): Promise<string | null> {
  try {
    const { data: { session } } = await withPromiseDeadline(
      supabase.auth.getSession(),
      {
        timeoutMs: authOperationTimeoutMs,
        label: 'Session check',
        signals: [signal],
      },
    );
    if (!session?.access_token) return null;

    const nowSec = Math.floor(Date.now() / 1000);
    const expiresAt = typeof session.expires_at === 'number' ? session.expires_at : 0;
    const needsRefresh = expiresAt > 0 && expiresAt - nowSec < REFRESH_BUFFER_SEC;
    if (!needsRefresh) return session.access_token;

    const fresh = await refreshAndGetToken(signal);
    return fresh ?? session.access_token;  // fall back to the stale one; server will tell us
  } catch (error) {
    // A deadline/caller abort is a terminal outcome for this request. Sending
    // an unauthenticated retry would only add another waterfall and could turn
    // a network problem into a misleading 401.
    if (error instanceof RequestTimeoutError || signal?.aborted) throw error;
    return null;
  }
}

/** Read the structured `code` field from a 401 response without consuming
 *  the original body (so callers that want to read it can). Returns null if
 *  the body isn't JSON or doesn't have a code.
 */
async function readFailureCode(res: Response, signal?: AbortSignal): Promise<string | null> {
  try {
    const clone = res.clone();
    const body = await raceWithAbortSignal(clone.json(), signal);
    if (body && typeof body === 'object' && typeof body.code === 'string') {
      return body.code;
    }
    return null;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

/** Module-scoped one-shot guard for force-signout. A dashboard page can
 *  fan out a dozen concurrent fetchWithAuth calls; if every one of them
 *  receives a 401 with an unrecoverable code, they would each call
 *  signOut() and window.location.assign() independently. The first wins
 *  the navigation but the racing signOut/assign calls cause auth-state
 *  jitter and (rarely) the wrong "reason" query param landing on the
 *  signin page. This guard pins the first reason and turns every
 *  subsequent caller into a silent throw of SessionEndedError.
 *
 *  A successful SPA sign-in resets the guard through
 *  markAuthenticatedSessionStarted(). A full document load naturally resets
 *  the module too.
 */
let sessionEndFired = false;

/**
 * Clear the terminal-session redirect latch after a genuinely new session is
 * established in this document. This must be called by AuthContext only after
 * Supabase sign-in plus the account lookup both succeed; clearing it for every
 * token read would let concurrent terminal 401s defeat the one-shot guard.
 */
export function markAuthenticatedSessionStarted(): void {
  sessionEndFired = false;
}

export function __resetSessionEndForTesting(): void {
  sessionEndFired = false;
}

/** Tests only: drop a cached in-flight refresh so each test's auth mocks
 *  take effect immediately (the production clear rides a 0ms timer that a
 *  fast test runner can outpace). */
export function __resetInFlightRefreshForTesting(): void {
  inFlightRefresh = null;
}

/** Tests only: shorten the auth bound without making production configurable. */
export function __setAuthOperationTimeoutForTesting(timeoutMs?: number): void {
  const next = timeoutMs ?? AUTH_OPERATION_TIMEOUT_MS;
  if (!Number.isFinite(next) || next <= 0) throw new RangeError('timeoutMs must be positive');
  authOperationTimeoutMs = next;
}

/** Force-signout + redirect to /signin. Clear the browser cookie first so a
 *  failed remote revoke cannot restore the old account on reload, then
 *  fire-and-forget GoTrue's local cleanup; the redirect tears the page down.
 *  The throw is what stops the caller's continuation from executing (and from
 *  rendering "invalid session token" right before the redirect lands).
 *
 *  Preserves the `redirect=<here>` query param so users land back where
 *  they started after re-OTP. Added 2026-05-22 alongside requires_2fa
 *  branch — without preserving it, anyone bounced mid-session would be
 *  dropped on /dashboard after re-OTP regardless of where they were.
 */
function endSessionAndRedirect(reason: 'session-ended' | 'config-error' | '2fa_required'): never {
  // Sign-in and verification surfaces own their in-page auth error state. Do
  // not poison the module-wide redirect latch when no redirect/sign-out will
  // actually happen: this document can subsequently complete an SPA sign-in.
  if (typeof window !== 'undefined' && window.location.pathname.startsWith('/signin')) {
    throw new SessionEndedError();
  }

  // First caller wins. Subsequent concurrent callers throw silently —
  // their continuations stop without firing duplicate signOut/assign.
  if (sessionEndFired) throw new SessionEndedError();
  sessionEndFired = true;

  if (typeof window !== 'undefined') {
    const here = window.location.pathname;
    // Don't await — page is being torn down. Cookie removal is synchronous
    // and durable even if the SDK's cleanup encounters the same outage that
    // caused the terminal auth verdict.
    clearSupabaseBrowserSessionCookies();
    void supabase.auth.signOut({ scope: 'local' });
    const params = new URLSearchParams({ reason });
    // Preserve where the user was so we can return them after re-OTP.
    // Include search + hash so deep links survive the bounce.
    const target = here + window.location.search + window.location.hash;
    if (target && target !== '/') params.set('redirect', target);
    window.location.assign(`/signin?${params.toString()}`);
  }
  throw new SessionEndedError();
}

function isTransient(code: string | null): boolean {
  return code === 'auth_unavailable';
}

/** Only these codes are authoritative session verdicts from requireSession.
 * Other routes and intermediaries may also return a JSON `code` with a 401;
 * those responses must never be mistaken for proof that the login is dead.
 */
function isIdentityFailureCode(code: string | null): boolean {
  return code === 'token_expired'
    || code === 'token_malformed'
    || code === 'user_not_found'
    || code === 'project_mismatch'
    || code === 'auth_unavailable'
    || code === 'missing_token'
    || code === 'requires_2fa'
    || code === 'unknown';
}

export interface FetchWithAuthInit extends RequestInit {
  /**
   * End-to-end request budget. GET/HEAD default to
   * NAVIGATION_FETCH_TIMEOUT_MS; mutations are unbounded unless they opt in.
   * Pass null only for a deliberately long read/stream whose caller owns an
   * AbortSignal. Auth session checks remain bounded either way.
   */
  timeoutMs?: number | null;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof input === 'object' && input !== null && typeof (input as Request).method === 'string') {
    return (input as Request).method.toUpperCase();
  }
  return 'GET';
}

function defaultTimeoutFor(input: RequestInfo | URL, init?: RequestInit): number | null {
  const method = requestMethod(input, init);
  return method === 'GET' || method === 'HEAD' ? NAVIGATION_FETCH_TIMEOUT_MS : null;
}

async function fetchWithAuthWithinDeadline(
  input: RequestInfo | URL,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  const callerHeaders = new Headers(init?.headers ?? {});
  const callerSetAuth = callerHeaders.has('authorization') || callerHeaders.has('Authorization');

  async function send(token: string | null): Promise<Response> {
    const headers = new Headers(callerHeaders);
    if (!callerSetAuth && token) headers.set('Authorization', `Bearer ${token}`);
    return raceWithAbortSignal(fetch(input, { ...init, headers, signal }), signal);
  }

  const token = callerSetAuth ? null : await getFreshAccessToken(signal);
  const res = await send(token);

  // Happy path — no 401, nothing to recover from.
  if (res.status !== 401) return res;

  // Caller passed their own Authorization header. They've opted out of
  // recovery; let them handle the 401 themselves.
  if (callerSetAuth) return res;

  const code = await readFailureCode(res, signal);

  // Transient Supabase outage. Don't sign the user out. Let the caller
  // surface a "try again" message.
  if (isTransient(code)) return res;

  // Project mismatch is a config bug, not a normal expiry. The user can't
  // fix it; signing them out won't help. Surface a distinct reason on the
  // signin page so the message is honest.
  if (code === 'project_mismatch') endSessionAndRedirect('config-error');

  // 2FA required: the server's requireSession → validateDeviceTrust says this
  // device isn't trusted. That verdict is driven by the httpOnly `staxis_device`
  // COOKIE matched against the `trusted_devices` table — NOT by any JWT claim.
  //
  // This is usually terminal — but there is a real, transient window where it
  // is NOT: the trust-establishment race. Right after an OTP verify (the
  // onboarding wizard's Step 3, or /signin/verify) the client calls
  // /api/auth/trust-device, whose response Set-Cookies `staxis_device`. Any
  // protected request already in flight when verifyOtp fired SIGNED_IN — e.g.
  // PropertyContext auto-loading /api/capabilities/overrides for a freshly-
  // created single-property owner — raced ahead of that cookie and 401'd here.
  // Before this fix that 401 force-logged the owner straight to /signin the
  // instant they finished 2FA.
  //
  // Recovery: refresh the token and retry ONCE. The fix is really the RETRY,
  // not the refresh — by the time the awaited refresh resolves, trust-device's
  // Set-Cookie has landed, and fetch re-sends the now-present `staxis_device`
  // cookie on the same-origin retry, so the server now sees a trusted device.
  // The refresh is incidental delay + token hygiene. If the retry STILL says
  // requires_2fa, the device genuinely isn't trusted (no cookie / no row) →
  // re-auth. (Note: the onboarding wizard surface is additionally protected by
  // PropertyContext skipping the overrides call mid-onboarding; this retry is
  // the load-bearing guard for other surfaces, e.g. AppLayout's WakeWord /
  // feed-status mount calls, that a mid-onboarding owner can transiently hit.)
  if (code === 'requires_2fa') {
    const outcome = await refreshSessionVerdict(signal);
    if (outcome.token) {
      const retryRes = await send(outcome.token);
      if (retryRes.status !== 401) return retryRes;

      // A 401 status alone is not a renewed trust verdict. Supabase or an
      // intermediary can fail transiently during this retry, and signing out
      // here would destroy a valid session precisely while recovery is
      // working. Read the retry envelope before choosing a terminal action.
      const retryCode = await readFailureCode(retryRes, signal);
      if (retryCode === 'project_mismatch') {
        endSessionAndRedirect('config-error');
      }
      if (retryCode === null || isTransient(retryCode) || !isIdentityFailureCode(retryCode)) {
        return retryRes;
      }

      // A structured identity failure on a freshly minted token—including a
      // second requires_2fa—gets one short final retry. The trust-device write
      // and cookie can still be landing while AuthContext's freshly verified
      // session starts protected root reads; signing out on the first retry
      // would race and destroy a session that becomes trusted milliseconds
      // later.
      await raceWithAbortSignal(new Promise((resolve) => setTimeout(resolve, 450)), signal);
      const finalRes = await send(outcome.token);
      if (finalRes.status !== 401) return finalRes;
      const finalCode = await readFailureCode(finalRes, signal);
      if (finalCode === 'requires_2fa') endSessionAndRedirect('2fa_required');
      if (finalCode === 'project_mismatch') endSessionAndRedirect('config-error');
      if (finalCode !== null && !isTransient(finalCode) && isIdentityFailureCode(finalCode)) {
        endSessionAndRedirect('session-ended');
      }
      return finalRes;
    }
    if (outcome.terminal) endSessionAndRedirect('session-ended');
    // Refresh failed transiently — we can't prove anything either way.
    // Keep the session; surface the 401 to the caller as a retryable error.
    return res;
  }

  // Every other 401: refresh and retry before ANY signout decision.
  const outcome = await refreshSessionVerdict(signal);

  // Refresh failed transiently (network blip, 5xx, 429). The old behavior
  // here — hard signout — is exactly what randomly logged the owner out
  // mid-session. Keep the session; the caller surfaces a retryable error
  // and the next request goes through the same recovery.
  if (!outcome.token && !outcome.terminal) return res;

  // Supabase definitively rejected the refresh token. Session is dead.
  if (!outcome.token) endSessionAndRedirect('session-ended');

  let retryRes = await send(outcome.token);
  if (retryRes.status !== 401) return retryRes;

  // Fresh token, still 401. Server-side JWT caches / clock skew can lag a
  // refresh by a beat — give it ONE more try after a short pause before
  // concluding anything.
  await raceWithAbortSignal(new Promise((resolve) => setTimeout(resolve, 450)), signal);
  retryRes = await send(outcome.token);
  if (retryRes.status !== 401) return retryRes;

  // Still 401 with a freshly-minted token. If the server issued a
  // structured identity verdict, the session is genuinely unrecoverable.
  // A 401 WITHOUT our envelope code (some proxy / non-requireSession layer)
  // is not a session verdict — hand it to the caller instead of signing out.
  const retryCode = await readFailureCode(retryRes, signal);
  if (retryCode === 'requires_2fa') endSessionAndRedirect('2fa_required');
  if (retryCode === 'project_mismatch') endSessionAndRedirect('config-error');
  if (retryCode !== null && !isTransient(retryCode) && isIdentityFailureCode(retryCode)) {
    endSessionAndRedirect('session-ended');
  }
  return retryRes;
}

export async function fetchWithAuth(
  input: RequestInfo | URL,
  init: FetchWithAuthInit = {},
): Promise<Response> {
  const { timeoutMs: requestedTimeoutMs, ...requestInit } = init;
  const timeoutMs = requestedTimeoutMs === undefined
    ? defaultTimeoutFor(input, requestInit)
    : requestedTimeoutMs;
  if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new RangeError('timeoutMs must be a positive finite number or null');
  }

  // AbortSignal.timeout stays attached to the fetch Response after headers
  // arrive, so a stalled JSON body is bounded as well. Request.signal and the
  // caller's init.signal are both retained rather than one replacing the other.
  const timeoutSignal = timeoutMs === null ? undefined : timeoutAbortSignal(timeoutMs);
  const signal = composeAbortSignals([
    ...requestAbortSignals(input, requestInit),
    timeoutSignal,
  ]);

  try {
    return await fetchWithAuthWithinDeadline(input, requestInit, signal);
  } catch (error) {
    if (timeoutSignal?.aborted) {
      throw new RequestTimeoutError('Request', timeoutMs as number);
    }
    throw error;
  }
}
