'use client';

// ─── Auth model ────────────────────────────────────────────────────────────
// Supabase Auth owns passwords. Each account is ONE auth.users row, identified
// by a synthetic email: `${username}@staxis.local`. The `accounts` table adds
// role + displayName + property_access metadata keyed by `data_user_id` which
// equals the auth.users.id.
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
import { supabase } from '@/lib/supabase';
import { fetchWithAuth } from '@/lib/api-fetch';
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
  /** Returns an error string on failure, or null on success */
  signIn: (email: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  authorizationChecked: false,
  platformAdmin: false,
  propertyStandings: [],
  authorizationFingerprint: null,
  signIn: async () => null,
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
    // Remove any legacy Firebase-era keys so a mixed-state browser doesn't
    // feed stale data back to AuthContext after migration.
    localStorage.removeItem('hotelops-account');
  } catch {
    // ignore — private browsing / no storage
  }
}

// Fetch the accounts row for the current auth user and translate to AppUser.
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
async function loadAppUser(authUid: string): Promise<AppUser | null> {
  const fetchRow = () => supabase
    .from('accounts')
    .select('id, username, display_name, role, property_access, data_user_id, staff_id, skip_2fa')
    .eq('data_user_id', authUid)
    .maybeSingle();

  let result = await fetchRow();
  if (result.error) {
    // One short-backoff retry. Most failures here are a single transient
    // blip; retrying once makes them invisible instead of surfacing as a
    // spurious logout.
    await new Promise(resolve => setTimeout(resolve, 400));
    result = await fetchRow();
  }
  const { data, error } = result;

  if (error) {
    console.error('AuthContext: failed to load accounts row (after retry)', error);
    throw error;
  }
  if (!data) return null;

  const role = (data.role ?? 'staff') as AppUser['role'];
  // Admins conceptually have access to every property. The database stores
  // an empty array for admins (since '*' isn't a valid UUID), so we translate
  // it to ['*'] in the client model to preserve the legacy propertyAccess
  // semantics used throughout the UI.
  const propertyAccess: string[] = role === 'admin'
    ? ['*']
    : (data.property_access ?? []);

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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [authorizationChecked, setAuthorizationChecked] = useState(false);
  const [platformAdmin, setPlatformAdmin] = useState(false);
  const [propertyStandings, setPropertyStandings] = useState<SessionPropertyStanding[]>([]);
  const [authorizationFingerprint, setAuthorizationFingerprint] = useState<string | null>(null);
  const authUid = user?.uid ?? null;

  // Mirror `user` into a ref so the async token-refresh handler can read the
  // *current* user synchronously without being torn down and rebuilt on every
  // change. Used to decide whether an empty accounts-row read means a
  // genuinely orphaned auth user (no established user → sign out) or just a
  // transient blip on a live session (user already established → keep them).
  const userRef = useRef<AppUser | null>(null);
  useEffect(() => { userRef.current = user; }, [user]);

  useEffect(() => {
    let active = true;
    let resolved = false;

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
      try {
        await migrateLegacySessionIfPresent();
        const { data: { session } } = await supabase.auth.getSession();
        if (!active) return;
        if (session?.user) {
          const appUser = await loadAppUser(session.user.id);
          if (!active) return;
          if (appUser) {
            setUser(appUser);
          } else {
            // Auth session exists but no accounts row — orphaned auth user,
            // sign out to avoid a "logged in with no permissions" state.
            await supabase.auth.signOut();
            setUser(null);
          }
        } else {
          setUser(null);
        }
      } catch (err) {
        console.error('AuthContext: getSession failed', err);
        if (active) setUser(null);
      } finally {
        if (active) {
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
      // Synchronous bookkeeping is fine here; only DEFER the supabase calls.
      if (event === 'SIGNED_OUT') {
        // Covers wrapper sign-out AND terminal 401/session-expiry paths that
        // call supabase.auth.signOut() directly.
        clearSignedOutBrowserState();
        setUser(null);
        setAuthorizationChecked(false);
        setPlatformAdmin(false);
        setPropertyStandings([]);
        setAuthorizationFingerprint(null);
        return;
      }
      if (!session?.user) {
        // Missing session on a NON-signout event (TOKEN_REFRESHED mid-flight,
        // INITIAL_SESSION for a signed-out visitor). For a visitor, user is
        // already null; for a signed-in user this is a sub-second refresh
        // blip — nulling here rippled a fake "signed out" through every
        // context and remounted half the app. A genuinely dead session still
        // signs out via SIGNED_OUT or api-fetch's terminal-401 policy.
        return;
      }
      const uid = session.user.id;
      // Dispatched into the next tick so the auth lock is released before
      // we touch any supabase.* method. See deadlock warning above.
      //
      // We also race loadAppUser against a 6-second timeout. If the
      // accounts-table query hangs (RLS bug, Supabase outage, dropped
      // websocket), we don't want the user stuck on a loading spinner
      // indefinitely — the initial-hydration path already has a 4s
      // ceiling (further down), but token-refresh and SIGNED_IN events
      // hit this branch *after* hydration and previously had no bound.
      // 6s is generous (typical query is <300ms) but firm enough that
      // a real hang surfaces as a recoverable signed-out state instead
      // of a frozen UI.
      setTimeout(async () => {
        if (!active) return;
        try {
          const appUser = await Promise.race([
            loadAppUser(uid),
            new Promise<null>((_, reject) =>
              setTimeout(() => reject(new Error('loadAppUser timeout (6s)')), 6000),
            ),
          ]);
          if (!active) return;
          if (appUser) {
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
            setUser(prev => {
              if (prev
                && prev.uid === appUser.uid
                && prev.accountId === appUser.accountId
                && prev.role === appUser.role
                && prev.username === appUser.username
                && prev.displayName === appUser.displayName
                && prev.staffId === appUser.staffId
                && JSON.stringify(prev.propertyAccess ?? []) === JSON.stringify(appUser.propertyAccess ?? [])
              ) {
                return prev;
              }
              return appUser;
            });
          } else if (!userRef.current) {
            // Valid session, no accounts row, and no user was ever established
            // this session → genuinely orphaned auth user (e.g. a half-finished
            // signup). Signing out to avoid a "logged in with no permissions"
            // limbo is correct here.
            await supabase.auth.signOut();
            setUser(null);
          } else {
            // We already had a signed-in user and this token-refresh read came
            // back empty. An account doesn't vanish mid-session — treat the
            // empty result as a transient RLS / auth.uid() race during the
            // refresh and KEEP the user signed in instead of bouncing them to
            // /signin. 2026-06-03.
            console.warn('AuthContext: empty accounts row on refresh for an established user — keeping session');
          }
        } catch (err) {
          // Transient failure (network blip, the 6s timeout, a momentary
          // Supabase error) during a token refresh. The event that triggered
          // this handler was a SUCCESSFUL refresh, so the session itself is
          // still valid. Do NOT sign out and do NOT clear an established user:
          // that would turn a one-off hiccup into a hard logout (signOut() even
          // revokes the refresh token, so a reload can't recover it). This was
          // the dominant cause of "I keep getting randomly logged out." Keep
          // what we have; the next auth event or user action retries.
          console.error('AuthContext: onAuthStateChange deferred handler error — keeping current session', err);
        }
      }, 0);
    });

    // Safety timeout: if getSession() never resolves (broken localStorage,
    // network hang), force loading to false after 4s so the sign-in form is
    // still usable.
    const timeout = setTimeout(() => {
      if (!resolved && active) {
        console.warn('AuthContext: session hydration did not resolve within 4s — forcing loading=false');
        setUser(null);
        setLoading(false);
      }
    }, 4000);

    return () => {
      active = false;
      listener.subscription.unsubscribe();
      clearTimeout(timeout);
    };
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

  const signIn = async (email: string, password: string): Promise<string | null> => {
    try {
      const normalizedEmail = email.trim().toLowerCase();
      const { data, error } = await supabase.auth.signInWithPassword({ email: normalizedEmail, password });

      if (error) {
        // Supabase returns "Invalid login credentials" for both bad email
        // and bad password — surface that as a generic message to avoid
        // leaking whether an email exists.
        if (error.message.toLowerCase().includes('invalid')) {
          return 'Invalid email or password';
        }
        return error.message;
      }

      if (!data.session || !data.user) {
        return 'Login failed';
      }

      // onAuthStateChange will fire and populate `user`. We also eagerly
      // load and set here so the caller can navigate immediately after
      // signIn() resolves without waiting for the listener round-trip.
      const appUser = await loadAppUser(data.user.id);
      if (!appUser) {
        await supabase.auth.signOut();
        return 'No account record found for this user. Contact an administrator.';
      }
      setUser(appUser);
      return null; // success
    } catch (err) {
      console.error('signIn error:', err);
      return 'An error occurred. Please try again.';
    }
  };

  const signOut = async () => {
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
      const { data: { session } } = await supabase.auth.getSession();
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

    await supabase.auth.signOut();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{
      user,
      loading,
      authorizationChecked,
      platformAdmin,
      propertyStandings,
      authorizationFingerprint,
      signIn,
      signOut,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
