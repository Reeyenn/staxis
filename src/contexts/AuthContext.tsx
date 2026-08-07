'use client';

// ─── Auth model ────────────────────────────────────────────────────────────
// Supabase Auth owns passwords. Each account is ONE auth.users row, identified
// by a synthetic email: `${username}@staxis.local`. The `accounts` table adds
// role + displayName metadata keyed by `data_user_id` which equals the
// auth.users.id. Per-property authority is hydrated only from the server's
// canonical authorization snapshot below; the browser account projection is
// intentionally not an access source.
//
// Login flow (100% client-side — no /api/auth/login round-trip):
//   1. User types username + password
//   2. signInWithPassword({ email: `${username}@staxis.local`, password })
//   3. onAuthStateChange fires → fetch accounts row where data_user_id = uid
//   4. Populate AppUser from accounts row
//
// Why synthetic email: Supabase Auth requires an email-format identifier. We
// don't collect real emails (hotel staff rarely have them, and we're
// username-first by product design). The .local TLD makes the address
// un-routable so Supabase's deliverability checks can't send mail to it.
// ───────────────────────────────────────────────────────────────────────────

import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { clearSupabaseBrowserSessionCookies, supabase } from '@/lib/supabase';
import {
  AUTH_OPERATION_TIMEOUT_MS,
  AUTH_SESSION_OPERATION_TIMEOUT_MS,
  fetchWithAuth,
  markAuthenticatedSessionStarted,
} from '@/lib/api-fetch';
import {
  AmbiguousSessionOperationError,
  settleSessionOperation,
} from '@/lib/auth/session-operation';
import { withPromiseDeadline } from '@/lib/fetch-deadline';
import { migrateLegacySessionIfPresent } from '@/lib/auth-storage-migration';
import { subscribeToSessionAuthorizationInvalidations } from '@/lib/auth/session-authorization-invalidation';
import { RESUME_GUARD_KEY } from '@/lib/onboarding/state';
import { isValidRole, type AppRole } from '@/lib/roles';

export interface AppUser {
  uid: string;               // auth.users.id  AND  accounts.data_user_id (same value)
  accountId: string;         // accounts.id
  username: string;          // lowercase username (no @staxis.local suffix)
  displayName: string;
  role: AppRole;
  propertyAccess: string[];  // ["*"] = all properties (admin-only convention), or specific property UUIDs
  staffId: string | null;    // accounts.staff_id — link to the staff roster row this login represents (null = manager-only login or unlinked)
  isDemo: boolean;           // accounts.skip_2fa — shared demo/investor login; unlocks the Manager⇄Staff view-preview switch on /staff
}

export type AuthSignInResult =
  | { error: null; session: Session; user: AppUser; requiresFreshSignin: false }
  | { error: string; session: null; user: null; requiresFreshSignin: boolean };

interface AuthContextType {
  user: AppUser | null;
  loading: boolean;
  /** True after the server has returned a definitive authorization snapshot
   * for this auth user. A transient read failure leaves the previous verdict
   * intact; a new user starts unchecked. */
  authorizationChecked: boolean;
  /** Fresh server verdict for the Staxis-wide platform-admin role. This is
   * deliberately separate from `user.role`, whose browser-loaded value may be
   * stale while a long-lived tab is open. */
  platformAdmin: boolean;
  /** Current per-hotel standing from the same fresh server projection used by
   * hotel APIs. This drives discovery only; every destination reauthorizes. */
  propertyStandings: SessionPropertyStanding[];
  /** Opaque server-derived fingerprint for the full current authorization
   * provenance. Consumers use it only to invalidate stale projections. */
  authorizationFingerprint: string | null;
  sessionError: string | null;
  sessionErrorKind: 'transient' | 'ended' | null;
  retrySession: () => void;
  /** Returns the exact session created by this password attempt on success. */
  signIn: (email: string, password: string) => Promise<AuthSignInResult>;
  /** True only while this exact refresh-token session still owns the browser. */
  isAuthSessionCurrent: (session: Session) => boolean;
  /** Locally discard only this exact session; a newer session is untouched. */
  discardAuthSession: (session: Session) => boolean;
  /**
   * Clear every local trace of an ambiguous sign-in before a fresh password
   * attempt. This never calls the remote/global logout endpoint.
   */
  resetForFreshSignIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  authorizationChecked: false,
  platformAdmin: false,
  propertyStandings: [],
  authorizationFingerprint: null,
  sessionError: null,
  sessionErrorKind: null,
  retrySession: () => {},
  signIn: async () => ({
    error: 'Sign-in is unavailable.',
    session: null,
    user: null,
    requiresFreshSignin: false,
  }),
  isAuthSessionCurrent: () => false,
  discardAuthSession: () => false,
  resetForFreshSignIn: async () => {},
  signOut: async () => {},
});

/** Realtime authorization-version changes revalidate continuously open tabs.
 * Focus/visibility and this interval remain recovery paths for a disconnected
 * Realtime channel; server routes independently reject stale privilege. */
export const AUTHORIZATION_REVALIDATE_INTERVAL_MS = 60_000;
const AUTHORIZATION_REVALIDATE_TIMEOUT_MS = 6_000;

interface SessionAuthorizationSnapshot {
  active: boolean;
  role: AppRole | null;
  propertyAccess: string[];
  platformAdmin: boolean;
  propertyStandings: SessionPropertyStanding[];
  authorizationFingerprint: string | null;
  verifiedAt: string;
}

export interface SessionPropertyStanding {
  propertyId: string;
  operationalRole: AppRole;
  seesFinancials: boolean;
  hotelMutationAllowed: boolean;
  portfolioIntelligenceRead: boolean;
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseSessionPropertyStandings(value: unknown): SessionPropertyStanding[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: SessionPropertyStanding[] = [];
  let previousPropertyId = '';
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.propertyId !== 'string'
      || !UUID_RX.test(raw.propertyId)
      || raw.propertyId <= previousPropertyId
      || !isValidRole(raw.operationalRole)
      || raw.operationalRole === 'admin'
      || typeof raw.seesFinancials !== 'boolean'
      || typeof raw.hotelMutationAllowed !== 'boolean'
      || typeof raw.portfolioIntelligenceRead !== 'boolean') return null;
    parsed.push({
      propertyId: raw.propertyId,
      operationalRole: raw.operationalRole,
      seesFinancials: raw.seesFinancials,
      hotelMutationAllowed: raw.hotelMutationAllowed,
      portfolioIntelligenceRead: raw.portfolioIntelligenceRead,
    });
    previousPropertyId = raw.propertyId;
  }
  return parsed;
}

function parseSessionAuthorizationSnapshot(value: unknown): SessionAuthorizationSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const envelope = value as { ok?: unknown; data?: unknown };
  if (envelope.ok !== true || !envelope.data || typeof envelope.data !== 'object') return null;
  const data = envelope.data as Record<string, unknown>;
  if (data.role !== null && !isValidRole(data.role)) return null;
  const role = data.role as AppRole | null;
  const propertyAccess = Array.isArray(data.propertyAccess)
    && data.propertyAccess.every((entry) => typeof entry === 'string')
    ? [...data.propertyAccess] as string[]
    : null;
  const active = data.active;
  const platformAdmin = data.platformAdmin;
  const propertyStandings = parseSessionPropertyStandings(data.propertyStandings);
  const authorizationFingerprint = data.authorizationFingerprint;
  const verifiedAt = data.verifiedAt;
  if (typeof active !== 'boolean'
    || typeof platformAdmin !== 'boolean'
    || propertyStandings === null
    || propertyAccess === null
    || typeof verifiedAt !== 'string'
    || !Number.isFinite(Date.parse(verifiedAt))
    || (authorizationFingerprint !== null
      && (typeof authorizationFingerprint !== 'string'
        || authorizationFingerprint.length < 1
        || authorizationFingerprint.length > 200))
    || (active && role === null)
    || (active && authorizationFingerprint === null)
    || (!active && authorizationFingerprint !== null)
    || platformAdmin !== (active && role === 'admin')
    || (platformAdmin && propertyStandings.length > 0)
    || (!active && (propertyAccess.length > 0 || propertyStandings.length > 0))
    || (!platformAdmin && active
      && JSON.stringify(propertyStandings.map((standing) => standing.propertyId))
        !== JSON.stringify(propertyAccess))
  ) {
    return null;
  }
  return {
    active,
    role,
    propertyAccess,
    platformAdmin,
    propertyStandings,
    authorizationFingerprint,
    verifiedAt,
  };
}

function clearSignedOutBrowserState(): void {
  try {
    sessionStorage.removeItem('hotelops-session-selected');
    // The onboarding resume loop-breaker is scoped to one authenticated
    // session. Never let a failed resume suppress a later login.
    sessionStorage.removeItem(RESUME_GUARD_KEY);
  } catch {
    // ignore — private browsing / no storage
  }
  try {
    // Remove any legacy Firebase-era keys so a mixed-state browser doesn't
    // feed stale data back to AuthContext after migration.
    localStorage.removeItem('hotelops-account');
    localStorage.removeItem('staxis-auth');
    // Property selection is account-scoped. Never let the next person on a
    // shared front-desk browser probe the previous account's remembered hotel.
    localStorage.removeItem('hotelops-active-property');
    // The admin account switcher's cached roster of demo people. Names only,
    // but it belongs to the admin who fetched it, not to whoever signs in next.
    localStorage.removeItem('staxis.switch-roster.v1');
  } catch {
    // ignore — private browsing / no storage
  }
  try {
    // The cosmetic "you are switched, here is the way back" hint. It carries
    // no authority (the real return credential is httpOnly and expires on its
    // own), but leaving it behind would offer the next person at this browser
    // a button that isn't theirs. On the production domain the cookie is
    // written against `.getstaxis.com`, and a host-only delete would not match
    // it, so clear both shapes.
    const base = 'staxis_switch_hint=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Strict';
    document.cookie = base;
    const host = window.location.hostname.toLowerCase();
    if (host === 'getstaxis.com' || host.endsWith('.getstaxis.com')) {
      document.cookie = `${base}; Domain=.getstaxis.com`;
    }
  } catch {
    // ignore — no document in a non-browser context
  }
}

/**
 * End the browser session within a firm budget and always remove its durable
 * cookie representation. This is reserved for explicit user sign-out and
 * authoritative account revocation. Temporary password/OTP attempts use the
 * exact-token local discard inside AuthProvider so they cannot revoke another
 * browser's session or a newer attempt.
 */
async function clearSupabaseSessionBounded(): Promise<void> {
  let remoteFailure: unknown = null;
  try {
    const { error } = await withPromiseDeadline(
      supabase.auth.signOut(),
      { timeoutMs: AUTH_OPERATION_TIMEOUT_MS, label: 'Sign out' },
    );
    remoteFailure = error;
  } catch (error) {
    remoteFailure = error;
  } finally {
    clearSupabaseBrowserSessionCookies();
  }

  if (!remoteFailure) return;
  console.warn('AuthContext: remote sign-out failed; clearing the local cookie session', remoteFailure);
  try {
    await withPromiseDeadline(
      supabase.auth.signOut({ scope: 'local' }),
      { timeoutMs: 2_000, label: 'Local sign out' },
    );
  } catch {
    // The cookie removal above is the durable invariant. A full document load
    // cannot restore this session even if GoTrue's in-memory lock is wedged.
  }
}

function isTerminalSessionHydrationError(error: unknown): boolean {
  const value = error as { code?: unknown; message?: unknown; status?: unknown } | null;
  const code = String(value?.code ?? '');
  const message = String(value?.message ?? '');
  const status = typeof value?.status === 'number' ? value.status : 0;
  return /refresh_token_not_found|refresh_token_already_used|session_not_found|invalid_grant|flow_state_not_found/i.test(code)
    || /invalid refresh token|refresh token not found|already used|revoked|session.*(missing|not found|expired)/i.test(message)
    || status === 400 || status === 401 || status === 403 || status === 404;
}

// Fetch the identity/profile row for the current auth user and translate to
// AppUser. This intentionally does not select accounts.property_access. A
// password session is not yet a trusted application session at this point, so
// the initial non-admin projection has no property authority until the
// server-backed session-authorization revalidation completes.
//
// Return-value contract — load-bearing, callers depend on the distinction:
//   • AppUser  → row found.
//   • null     → query SUCCEEDED but found no row. This is a genuinely
//                orphaned auth user (e.g. a half-finished signup) — safe to
//                sign out.
//   • THROWS   → the query itself failed (network blip, momentary Supabase /
//                RLS error, a token-refresh race). This is TRANSIENT and must
//                NOT be treated as "no account". Returning null on a failed
//                query (the old behaviour) made a one-off hiccup during the
//                hourly token refresh indistinguishable from a deleted
//                account, so it tripped the sign-out path and logged live
//                users out for real. We retry once, then throw so callers can
//                keep the still-valid session. 2026-06-03.
async function loadAppUserUncached(authUid: string): Promise<AppUser | null> {
  const fetchRow = () => supabase
    .from('accounts')
    .select('id, username, display_name, role, data_user_id, staff_id, skip_2fa')
    .eq('data_user_id', authUid)
    .maybeSingle();

  let result = await fetchRow();
  if (result.error || !result.data) {
    // Confirm both failures and an apparently missing row. A transient auth
    // / RLS race can briefly make a live account invisible immediately after
    // token refresh, while two successful empty reads are strong evidence the
    // account was genuinely removed or revoked.
    await new Promise(resolve => setTimeout(resolve, 400));
    result = await fetchRow();
  }
  const { data, error } = result;

  if (error) {
    console.error('AuthContext: failed to load accounts row (after retry)', error);
    throw error;
  }
  if (!data) return null;

  const role = data.role as AppUser['role'];
  if (!isValidRole(role)) return null;
  // Admins conceptually have access to every property. The database stores
  // an empty array for admins (since '*' isn't a valid UUID), so preserve the
  // established client convention. Non-admin authority is filled only by the
  // canonical session snapshot after trust/2FA ordering has completed.
  const propertyAccess: string[] = role === 'admin'
    ? ['*']
    : [];

  return {
    uid: data.data_user_id,
    accountId: data.id,
    username: data.username,
    displayName: data.display_name,
    role,
    propertyAccess,
    staffId: (data as { staff_id?: string | null }).staff_id ?? null,
    isDemo: Boolean((data as { skip_2fa?: boolean | null }).skip_2fa),
  };
}

// signInWithPassword emits SIGNED_IN before its Promise resolves. The listener
// and the eager sign-in path therefore request the same account in adjacent
// tasks. Join that work so one transient result cannot disagree with another
// and ordinary login never pays for two identical account reads.
const appUserLoads = new Map<string, Promise<AppUser | null>>();

function loadAppUser(authUid: string): Promise<AppUser | null> {
  const existing = appUserLoads.get(authUid);
  if (existing) return existing;

  const pending = loadAppUserUncached(authUid).finally(() => {
    if (appUserLoads.get(authUid) === pending) appUserLoads.delete(authUid);
  });
  appUserLoads.set(authUid, pending);
  return pending;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [authorizationChecked, setAuthorizationChecked] = useState(false);
  const [platformAdmin, setPlatformAdmin] = useState(false);
  const [propertyStandings, setPropertyStandings] = useState<SessionPropertyStanding[]>([]);
  const [authorizationFingerprint, setAuthorizationFingerprint] = useState<string | null>(null);
  const authUid = user?.uid ?? null;
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessionErrorKind, setSessionErrorKind] = useState<'transient' | 'ended' | null>(null);
  const [sessionRetryKey, setSessionRetryKey] = useState(0);

  // Mirror `user` into a ref so the async token-refresh handler can read the
  // *current* user synchronously without being torn down and rebuilt on every
  // change. It also prevents a deferred account read from re-installing an
  // older identity after a sign-out or account switch wins the race.
  const userRef = useRef<AppUser | null>(null);
  const authSessionUidRef = useRef<string | null>(null);
  const authSessionRefreshTokenRef = useRef<string | null>(null);
  const authEventGenerationRef = useRef(0);
  const signInAttemptGenerationRef = useRef(0);
  const signInInFlightRef = useRef(false);
  // Once a session-creating SDK call exceeds its full lock+transport budget,
  // its outcome is unknowable until the original Promise settles. Keep this
  // document terminal: retrying here could let late Attempt A overwrite B.
  // A full document navigation creates a fresh client/provider boundary.
  const signInRecoveryRequiredRef = useRef(false);
  const terminalSignOutReasonRef = useRef<string | null>(null);
  useEffect(() => { userRef.current = user; }, [user]);

  useEffect(() => {
    let active = true;
    let resolved = false;
    let legacyMigrationSettled = false;
    const hydrationGeneration = ++authEventGenerationRef.current;
    setLoading(true);
    setSessionError(null);
    setSessionErrorKind(null);

    // Hydrate from the session Supabase restored from cookies on page load.
    // This fires BEFORE the first onAuthStateChange event, so we get an
    // accurate initial user without a flash of logged-out state.
    //
    // Before reading the session, run the one-time legacy localStorage →
    // cookie migration shim. It's a fast no-op once localStorage is empty
    // (which is the steady state after this batch ships), but on the first
    // page load following the deploy it lifts any leftover `staxis-auth`
    // entry into the new SSR cookies so existing users stay signed in.
    void (async () => {
      let sessionReadCompleted = false;
      try {
        try {
          await migrateLegacySessionIfPresent();
        } finally {
          legacyMigrationSettled = true;
        }
        const { data: { session }, error: sessionReadError } = await supabase.auth.getSession();
        if (sessionReadError) throw sessionReadError;
        sessionReadCompleted = true;
        if (!active || resolved || authEventGenerationRef.current !== hydrationGeneration) return;
        if (session?.user) {
          authSessionUidRef.current = session.user.id;
          authSessionRefreshTokenRef.current = session.refresh_token;
          const appUser = await loadAppUser(session.user.id);
          if (!active || resolved || authEventGenerationRef.current !== hydrationGeneration) return;
          if (appUser) {
            markAuthenticatedSessionStarted();
            userRef.current = appUser;
            setUser(appUser);
            setSessionError(null);
            setSessionErrorKind(null);
          } else {
            // Auth session exists but no accounts row — orphaned auth user,
            // sign out to avoid a "logged in with no permissions" state.
            terminalSignOutReasonRef.current = 'This account is no longer available. Sign in with an active account to continue.';
            let signOutFailed = false;
            try {
              const { error: signOutError } = await supabase.auth.signOut();
              signOutFailed = Boolean(signOutError);
            } catch {
              signOutFailed = true;
            }
            if (signOutFailed) clearSupabaseBrowserSessionCookies();
            userRef.current = null;
            setUser(null);
            setSessionError('This account is no longer available. Sign in with an active account to continue.');
            setSessionErrorKind('ended');
          }
        } else {
          clearSignedOutBrowserState();
          authSessionUidRef.current = null;
          authSessionRefreshTokenRef.current = null;
          userRef.current = null;
          setUser(null);
          setSessionError(null);
          setSessionErrorKind(null);
        }
      } catch (err) {
        console.error('AuthContext: getSession failed', err);
        if (active && !resolved && authEventGenerationRef.current === hydrationGeneration) {
          // A timeout/outage is not evidence that the session ended. Surface a
          // retryable state and preserve any established user instead of
          // redirecting to Sign In or silently rendering a blank route.
          if (!sessionReadCompleted && isTerminalSessionHydrationError(err)) {
            clearSignedOutBrowserState();
            clearSupabaseBrowserSessionCookies();
            authSessionUidRef.current = null;
            authSessionRefreshTokenRef.current = null;
            userRef.current = null;
            setUser(null);
            setSessionError('Your session has ended. Sign in again to continue.');
            setSessionErrorKind('ended');
          } else {
            setSessionError('We could not confirm your session. Check your connection and try again.');
            setSessionErrorKind('transient');
          }
        }
      } finally {
        if (active && !resolved && authEventGenerationRef.current === hydrationGeneration) {
          resolved = true;
          setLoading(false);
        }
      }
    })();

    // Subscribe to subsequent auth state changes (sign-in, sign-out, token
    // refresh). SIGNED_IN is what fires after our signInWithPassword call.
    //
    // ⚠️ DEADLOCK WARNING — read before editing this callback.
    // Supabase's docs (GoTrueClient.onAuthStateChange — see
    // https://supabase.com/docs/reference/javascript/auth-onauthstatechange)
    // explicitly warn:
    //
    //   > A callback can be an async function and it runs synchronously
    //   > during the processing of the changes causing the event. You can
    //   > easily create a dead-lock by using `await` on a call to another
    //   > method of the Supabase library.
    //   > - Avoid using async functions as callbacks.
    //   > - Do not use other Supabase functions in the callback function.
    //   > - If you must, dispatch the functions once the callback has
    //   >   finished executing via setTimeout(..., 0).
    //
    // The deadlock: this callback runs WHILE the auth lock is held. If we
    // await `loadAppUser` (which calls `sb.from('accounts').select()`), the
    // PostgREST builder calls `_getAccessToken` → `auth.getSession()` →
    // tries to acquire the same lock. With a stalled token-refresh in
    // flight, every save in the app then sits at "Saving…" until the
    // 5s lock-acquire timeout fires — exactly the symptom Reeyen reported
    // on 2026-04-26.
    //
    // Fix: keep the callback synchronous (return immediately, no await on
    // any supabase.* method) and dispatch the supabase calls into the
    // next tick. The lock has already been released by then, so the
    // re-entrant call path is gone.
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      // Supabase can publish INITIAL_SESSION(null) before the one-time legacy
      // localStorage→cookie migration finishes. That event is not authoritative:
      // clearing storage here would destroy the only recoverable session when
      // setSession is still pending or transiently fails.
      if (event === 'INITIAL_SESSION' && !session?.user && !legacyMigrationSettled) return;
      const eventGeneration = ++authEventGenerationRef.current;
      // Synchronous bookkeeping is fine here; only DEFER the supabase calls.
      if (event === 'SIGNED_OUT') {
        const endedDuringHydration = !resolved && !userRef.current;
        const terminalReason = terminalSignOutReasonRef.current;
        terminalSignOutReasonRef.current = null;
        // Covers wrapper sign-out AND terminal 401/session-expiry paths that
        // call supabase.auth.signOut() directly.
        clearSignedOutBrowserState();
        authSessionUidRef.current = null;
        authSessionRefreshTokenRef.current = null;
        userRef.current = null;
        setUser(null);
        setAuthorizationChecked(false);
        setPlatformAdmin(false);
        setPropertyStandings([]);
        setAuthorizationFingerprint(null);
        setSessionError(terminalReason ?? (endedDuringHydration
          ? 'Your session has ended. Sign in again to continue.'
          : null));
        setSessionErrorKind(terminalReason || endedDuringHydration ? 'ended' : null);
        resolved = true;
        setLoading(false);
        return;
      }
      if (!session?.user) {
        // Missing session on a NON-signout event (TOKEN_REFRESHED mid-flight,
        // INITIAL_SESSION for a signed-out visitor). For a visitor, user is
        // already null; for a signed-in user this is a sub-second refresh
        // blip — nulling here rippled a fake "signed out" through every
        // context and remounted half the app. A genuinely dead session still
        // signs out via SIGNED_OUT or api-fetch's terminal-401 policy.
        if (event === 'INITIAL_SESSION' && !resolved) {
          clearSignedOutBrowserState();
          authSessionUidRef.current = null;
          authSessionRefreshTokenRef.current = null;
          userRef.current = null;
          setUser(null);
          setSessionError(null);
          setSessionErrorKind(null);
          resolved = true;
          setLoading(false);
        }
        return;
      }
      const uid = session.user.id;
      authSessionUidRef.current = uid;
      authSessionRefreshTokenRef.current = session.refresh_token;
      // A shared browser can change accounts without a full page teardown.
      // Drop Account A synchronously before any Account B query starts, and
      // invalidate every deferred load queued for the older identity.
      if (userRef.current && userRef.current.uid !== uid) {
        clearSignedOutBrowserState();
        userRef.current = null;
        setUser(null);
      }
      if (!userRef.current) setLoading(true);
      // Dispatched into the next tick so the auth lock is released before
      // we touch any supabase.* method. See deadlock warning above.
      //
      // We also race loadAppUser against a 6-second timeout. If the
      // accounts-table query hangs (RLS bug, Supabase outage, dropped
      // websocket), we don't want the user stuck on a loading spinner
      // indefinitely — the initial-hydration path already has a 10s
      // ceiling (further down), but token-refresh and SIGNED_IN events
      // hit this branch *after* hydration and previously had no bound.
      // 6s is generous (typical query is <300ms) but firm enough that
      // a real hang surfaces as a recoverable signed-out state instead
      // of a frozen UI.
      setTimeout(async () => {
        if (!active || authEventGenerationRef.current !== eventGeneration) return;
        try {
          const appUser = await Promise.race([
            loadAppUser(uid),
            new Promise<null>((_, reject) =>
              setTimeout(() => reject(new Error('loadAppUser timeout (6s)')), 6000),
            ),
          ]);
          if (!active || authEventGenerationRef.current !== eventGeneration) return;
          if (appUser) {
            markAuthenticatedSessionStarted();
            // Stable-reference setUser: if the data is identical to what's
            // already in state, keep the same object reference. Reason:
            // onAuthStateChange fires on every Supabase token refresh
            // (~hourly + on tab focus), and a fresh `setUser({...})` call
            // creates a new reference even when nothing changed. Downstream
            // contexts depending on `[user]` (PropertyContext, etc.) would
            // tear down and re-fetch on every refresh, producing the
            // 'spinner over the dashboard every time I come back to the
            // tab' UX bug. Comparing the load-bearing fields here keeps
            // the reference stable across no-op refreshes.
            userRef.current = appUser;
            setUser(prev => {
              if (prev
                && prev.uid === appUser.uid
                && prev.accountId === appUser.accountId
                && prev.role === appUser.role
                && prev.username === appUser.username
                && prev.displayName === appUser.displayName
                && prev.staffId === appUser.staffId
                && prev.isDemo === appUser.isDemo
                && JSON.stringify(prev.propertyAccess ?? []) === JSON.stringify(appUser.propertyAccess ?? [])
              ) {
                return prev;
              }
              return appUser;
            });
            setSessionError(null);
            setSessionErrorKind(null);
            resolved = true;
            setLoading(false);
          } else {
            // `loadAppUser` already confirmed the successful empty lookup.
            // This is an orphaned or revoked account, regardless of whether a
            // previous user snapshot existed. Fail closed and make the local
            // logout durable even if the remote revoke endpoint is offline.
            const unavailableMessage = 'This account is no longer available. Sign in with an active account to continue.';
            terminalSignOutReasonRef.current = unavailableMessage;
            let signOutFailed = false;
            try {
              const { error: signOutError } = await supabase.auth.signOut();
              signOutFailed = Boolean(signOutError);
            } catch {
              signOutFailed = true;
            }
            if (signOutFailed) clearSupabaseBrowserSessionCookies();
            if (!active || authEventGenerationRef.current !== eventGeneration) return;
            authSessionUidRef.current = null;
            authSessionRefreshTokenRef.current = null;
            userRef.current = null;
            setUser(null);
            setSessionError(unavailableMessage);
            setSessionErrorKind('ended');
            resolved = true;
            setLoading(false);
          }
        } catch (err) {
          if (!active || authEventGenerationRef.current !== eventGeneration) return;
          // Transient failure (network blip, the 6s timeout, a momentary
          // Supabase error) during a token refresh. The event that triggered
          // this handler was a SUCCESSFUL refresh, so the session itself is
          // still valid. Do NOT sign out and do NOT clear an established user:
          // that would turn a one-off hiccup into a hard logout (signOut() even
          // revokes the refresh token, so a reload can't recover it). This was
          // the dominant cause of "I keep getting randomly logged out." Keep
          // what we have; the next auth event or user action retries.
          console.error('AuthContext: onAuthStateChange deferred handler error — keeping current session', err);
          if (!userRef.current) {
            setSessionError('We could not load your account. Check your connection and try again.');
            setSessionErrorKind('transient');
            resolved = true;
            setLoading(false);
          }
        }
      }, 0);
    });

    // Belt-and-suspenders around auth + account hydration. The Supabase fetch
    // itself has a firm deadline, but this also covers a regression in code
    // around it. It yields a real retryable error; it never pretends the user
    // signed out merely because the network did not answer.
    const timeout = setTimeout(() => {
      if (!resolved && active) {
        console.warn('AuthContext: session hydration did not resolve within 10s');
        resolved = true;
        setSessionError('We could not confirm your session. Check your connection and try again.');
        setSessionErrorKind('transient');
        setLoading(false);
      }
    }, 10_000);

    return () => {
      active = false;
      authEventGenerationRef.current += 1;
      listener.subscription.unsubscribe();
      clearTimeout(timeout);
    };
  }, [sessionRetryKey]);

  const retrySession = React.useCallback(() => {
    if (sessionErrorKind === 'ended' && typeof window !== 'undefined') {
      clearSignedOutBrowserState();
      clearSupabaseBrowserSessionCookies();
      void supabase.auth.signOut({ scope: 'local' });
      window.location.assign('/signin?reason=session-ended');
      return;
    }
    setLoading(true);
    setSessionError(null);
    setSessionErrorKind(null);
    setSessionRetryKey((key) => key + 1);
  }, [sessionErrorKind]);

  const isAuthSessionCurrent = React.useCallback((expectedSession: Session): boolean => (
    authSessionUidRef.current === expectedSession.user.id
    && authSessionRefreshTokenRef.current === expectedSession.refresh_token
  ), []);

  const discardAuthSession = React.useCallback((expectedSession: Session): boolean => {
    // Refresh-token equality makes cleanup attempt-owned even when the same
    // account signs in again. UID-only cleanup can destroy a newer winning
    // session for that account.
    if (!isAuthSessionCurrent(expectedSession)) return false;

    signInAttemptGenerationRef.current += 1;
    authEventGenerationRef.current += 1;
    authSessionUidRef.current = null;
    authSessionRefreshTokenRef.current = null;
    terminalSignOutReasonRef.current = null;
    userRef.current = null;
    clearSignedOutBrowserState();
    // This synchronous cookie removal is the local, durable discard. Do not
    // call auth.signOut() here: that async method signs out whichever session
    // is current when it later acquires the auth lock, which may be a newer
    // attempt. Explicit user sign-out retains the bounded remote revoke below.
    clearSupabaseBrowserSessionCookies();
    setUser(null);
    setAuthorizationChecked(false);
    setPlatformAdmin(false);
    setPropertyStandings([]);
    setAuthorizationFingerprint(null);
    setLoading(false);
    setSessionError(null);
    setSessionErrorKind(null);
    return true;
  }, [isAuthSessionCurrent]);

  const resetForFreshSignIn = React.useCallback(async (): Promise<void> => {
    // This runs only on the explicit `/signin?reason=auth-retry` boundary.
    // Do not call auth.signOut() here: even `scope:'local'` first acquires the
    // shared GoTrue lock and calls the logout endpoint. If that Promise times
    // out, its late completion could erase the next password attempt. The
    // browser client stores its session entirely in these cookies; clearing
    // them synchronously is the bounded local reset, while generation bumps
    // make every hydration/account task already queued for Session A stale.
    signInAttemptGenerationRef.current += 1;
    authEventGenerationRef.current += 1;
    signInRecoveryRequiredRef.current = false;
    authSessionUidRef.current = null;
    authSessionRefreshTokenRef.current = null;
    terminalSignOutReasonRef.current = null;
    userRef.current = null;
    clearSignedOutBrowserState();
    clearSupabaseBrowserSessionCookies();
    setUser(null);
    setAuthorizationChecked(false);
    setPlatformAdmin(false);
    setPropertyStandings([]);
    setAuthorizationFingerprint(null);
    setLoading(false);
    setSessionError(null);
    setSessionErrorKind(null);
  }, []);

  // `loadAppUser` is the browser's account projection and remains useful for
  // initial rendering, but it is not enough for a privilege-bearing global
  // destination in a tab that may stay open all day. This server read runs
  // through requireSession + the service-role account lookup, so a role change
  // is observed without waiting for Supabase to emit an auth-token event.
  useEffect(() => {
    if (!authUid) {
      setAuthorizationChecked(false);
      setPlatformAdmin(false);
      setPropertyStandings([]);
      setAuthorizationFingerprint(null);
      return;
    }

    // A verdict belongs to one auth user only. Never flash the previous
    // account's admin destination while a different user is being verified.
    setAuthorizationChecked(false);
    setPlatformAdmin(false);
    setPropertyStandings([]);
    setAuthorizationFingerprint(null);

    let active = true;
    let inFlight = false;
    let rerunRequested = false;
    let requestController: AbortController | null = null;

    const revalidateAuthorization = async () => {
      if (!active) return;
      if (inFlight) {
        // Never lose a database invalidation that races the current read. The
        // first response could have been taken just before the role update.
        rerunRequested = true;
        return;
      }
      inFlight = true;
      const controller = new AbortController();
      requestController = controller;
      const timeout = window.setTimeout(
        () => controller.abort(),
        AUTHORIZATION_REVALIDATE_TIMEOUT_MS,
      );

      try {
        const response = await fetchWithAuth('/api/auth/session-authorization', {
          method: 'GET',
          cache: 'no-store',
          credentials: 'include',
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) return;
        const snapshot = parseSessionAuthorizationSnapshot(
          await response.json().catch(() => null),
        );
        if (!active || !snapshot) return;

        // This is the only branch that changes a settled verdict. Network,
        // timeout, malformed-response, 5xx and auth-service failures above are
        // transient and intentionally preserve the last confirmed state.
        setAuthorizationChecked(true);
        setPlatformAdmin(snapshot.platformAdmin);
        setPropertyStandings(snapshot.propertyStandings);
        setAuthorizationFingerprint(snapshot.authorizationFingerprint);

        if (!snapshot.active || !snapshot.role) {
          // A successful service-role lookup confirmed that the account is no
          // longer usable. Clear client authority and end the auth session;
          // unlike an empty browser RLS read, this is not a transient race.
          setUser((previous) => previous?.uid === authUid ? null : previous);
          void supabase.auth.signOut();
          return;
        }
        const verifiedRole = snapshot.role;

        setUser((previous) => {
          if (!previous || previous.uid !== authUid) return previous;
          const sameAccess = JSON.stringify(previous.propertyAccess ?? [])
            === JSON.stringify(snapshot.propertyAccess);
          if (previous.role === verifiedRole && sameAccess) return previous;
          return {
            ...previous,
            role: verifiedRole,
            propertyAccess: snapshot.propertyAccess,
          };
        });
      } catch {
        // Transient by contract. In particular, do not hide an already
        // verified Admin destination because Wi-Fi blinked during a focus
        // event; the next focus/visibility/interval trigger retries.
      } finally {
        window.clearTimeout(timeout);
        if (requestController === controller) requestController = null;
        inFlight = false;
        if (active && rerunRequested) {
          rerunRequested = false;
          void revalidateAuthorization();
        }
      }
    };

    const revalidateWhenVisible = () => {
      if (document.visibilityState === 'visible') void revalidateAuthorization();
    };

    void revalidateAuthorization();
    const unsubscribeAuthorizationInvalidations = subscribeToSessionAuthorizationInvalidations({
      client: supabase,
      authUid,
      // The payload is deliberately ignored. Realtime is notification, never
      // authorization; the service-role-backed endpoint supplies the verdict.
      onInvalidate: () => { void revalidateAuthorization(); },
    });
    window.addEventListener('focus', revalidateWhenVisible);
    document.addEventListener('visibilitychange', revalidateWhenVisible);
    const interval = window.setInterval(
      revalidateWhenVisible,
      AUTHORIZATION_REVALIDATE_INTERVAL_MS,
    );

    return () => {
      active = false;
      requestController?.abort();
      unsubscribeAuthorizationInvalidations();
      window.clearInterval(interval);
      window.removeEventListener('focus', revalidateWhenVisible);
      document.removeEventListener('visibilitychange', revalidateWhenVisible);
    };
  }, [authUid]);

  const signIn = async (email: string, password: string): Promise<AuthSignInResult> => {
    if (signInRecoveryRequiredRef.current) {
      return {
        error: 'We could not confirm the previous sign-in. Start a fresh sign-in to continue.',
        session: null,
        user: null,
        requiresFreshSignin: true,
      };
    }
    if (signInInFlightRef.current) {
      return {
        error: 'A sign-in is already in progress. Please wait.',
        session: null,
        user: null,
        requiresFreshSignin: false,
      };
    }
    signInInFlightRef.current = true;
    const attemptGeneration = ++signInAttemptGenerationRef.current;
    let establishedSession: Session | null = null;
    try {
      const normalizedEmail = email.trim().toLowerCase();
      const { data, error } = await settleSessionOperation(
        supabase.auth.signInWithPassword({ email: normalizedEmail, password }),
        {
          timeoutMs: AUTH_SESSION_OPERATION_TIMEOUT_MS,
          label: 'Sign in',
          discardLateSession: discardAuthSession,
        },
      );

      if (error) {
        // Supabase returns "Invalid login credentials" for both bad email
        // and bad password — surface that as a generic message to avoid
        // leaking whether an email exists.
        if (error.message.toLowerCase().includes('invalid')) {
          return { error: 'Invalid email or password', session: null, user: null, requiresFreshSignin: false };
        }
        return { error: error.message, session: null, user: null, requiresFreshSignin: false };
      }

      if (!data.session || !data.user) {
        return { error: 'Login failed', session: null, user: null, requiresFreshSignin: false };
      }
      establishedSession = data.session;
      if (signInAttemptGenerationRef.current !== attemptGeneration) {
        discardAuthSession(data.session);
        return {
          error: 'Another sign-in or sign-out completed first. Please try again.',
          session: null,
          user: null,
          requiresFreshSignin: false,
        };
      }
      // The SDK's SIGNED_IN callback normally stamps these first. Stamping
      // again makes ownership explicit and keeps the contract correct in test
      // environments where the auth callback is mocked independently.
      authSessionUidRef.current = data.user.id;
      authSessionRefreshTokenRef.current = data.session.refresh_token;

      // onAuthStateChange will fire and populate `user`. We also eagerly
      // load and set here so the caller can navigate immediately after
      // signIn() resolves without waiting for the listener round-trip.
      const accountLoadGeneration = authEventGenerationRef.current;
      const appUser = await withPromiseDeadline(
        loadAppUser(data.user.id),
        { timeoutMs: 10_000, label: 'Account load' },
      );
      if (
        signInAttemptGenerationRef.current !== attemptGeneration
        || authSessionUidRef.current !== data.user.id
        || authSessionRefreshTokenRef.current !== data.session.refresh_token
      ) {
        return {
          error: authEventGenerationRef.current === accountLoadGeneration
            ? 'Login state changed. Please try again.'
            : 'Another sign-in or sign-out completed first. Please try again.',
          session: null,
          user: null,
          requiresFreshSignin: false,
        };
      }
      if (!appUser) {
        discardAuthSession(data.session);
        return {
          error: 'No account record found for this user. Contact an administrator.',
          session: null,
          user: null,
          requiresFreshSignin: false,
        };
      }
      setUser(appUser);
      userRef.current = appUser;
      markAuthenticatedSessionStarted();
      setSessionError(null);
      setSessionErrorKind(null);
      setLoading(false);
      return { error: null, session: data.session, user: appUser, requiresFreshSignin: false };
    } catch (err) {
      console.error('signIn error:', err);
      if (err instanceof AmbiguousSessionOperationError) {
        // The original GoTrue operation remains alive and can still publish a
        // SIGNED_IN event before the exact-session observer discards it. Do
        // not permit another password attempt inside this provider lifetime.
        signInRecoveryRequiredRef.current = true;
        return {
          error: 'We could not confirm the sign-in result. Start a fresh sign-in to continue.',
          session: null,
          user: null,
          requiresFreshSignin: true,
        };
      }
      if (establishedSession) {
        // The SIGNED_IN listener and this eager path intentionally converge on
        // one identity. If the listener already committed the exact session,
        // an eager read timeout is not a failed login and must not tear it down.
        if (
          userRef.current?.uid === establishedSession.user.id
          && authSessionRefreshTokenRef.current === establishedSession.refresh_token
          && signInAttemptGenerationRef.current === attemptGeneration
        ) {
          return {
            error: null,
            session: establishedSession,
            user: userRef.current,
            requiresFreshSignin: false,
          };
        }
        discardAuthSession(establishedSession);
      }
      return {
        error: 'An error occurred. Please try again.',
        session: null,
        user: null,
        requiresFreshSignin: false,
      };
    } finally {
      signInInFlightRef.current = false;
    }
  };

  const signOut = async () => {
    signInAttemptGenerationRef.current += 1;
    authEventGenerationRef.current += 1;
    authSessionUidRef.current = null;
    authSessionRefreshTokenRef.current = null;
    terminalSignOutReasonRef.current = null;
    // Invalidate deferred account hydration immediately. React state is
    // cleared only after local session removal below so the app never
    // pretends a still-persisted cookie was removed.
    userRef.current = null;
    clearSignedOutBrowserState();
    setAuthorizationChecked(false);
    setPlatformAdmin(false);
    setPropertyStandings([]);
    setAuthorizationFingerprint(null);

    // F-02 — best-effort revoke of trusted-device cookie + DB row BEFORE
    // we tear the session down. Without this, a stolen cookie outlives a
    // sign-out + password rotation (the canonical recovery path for a
    // compromised credential). Hard timeout of 2s so a slow/offline
    // network can't hang the sign-out UI — the security trade is worth
    // less than the UX hit. If revoke fails (offline, 5xx, timeout), the
    // device just stays trusted until its own expires_at; that's the
    // same posture as before this commit, so we're never worse off.
    try {
      const { data: { session } } = await withPromiseDeadline(
        supabase.auth.getSession(),
        { timeoutMs: 2_000, label: 'Session check before sign out' },
      );
      const accessToken = session?.access_token;
      if (accessToken) {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), 2000);
        try {
          await fetch('/api/auth/revoke-trust', {
            method: 'POST',
            credentials: 'include',
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({ source: 'signout' }),
          });
        } catch {
          // Network error / abort. Continue with auth.signOut — sign-out
          // proceeds regardless of revoke outcome.
        } finally {
          clearTimeout(tid);
        }
      }
    } catch {
      // getSession failure (broken localStorage, etc). Continue.
    }

    await clearSupabaseSessionBounded();
    userRef.current = null;
    setUser(null);
    setSessionError(null);
    setSessionErrorKind(null);
  };

  return (
    <AuthContext.Provider value={{
      user,
      loading,
      authorizationChecked,
      platformAdmin,
      propertyStandings,
      authorizationFingerprint,
      sessionError,
      sessionErrorKind,
      retrySession,
      signIn,
      isAuthSessionCurrent,
      discardAuthSession,
      resetForFreshSignIn,
      signOut,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
