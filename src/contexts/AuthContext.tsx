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
import { migrateLegacySessionIfPresent } from '@/lib/auth-storage-migration';
import type { AppRole } from '@/lib/roles';

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
  /** Returns an error string on failure, or null on success */
  signIn: (email: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  signIn: async () => null,
  signOut: async () => {},
});

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
        setUser(null);
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
    try {
      sessionStorage.removeItem('hotelops-session-selected');
      // Remove any legacy Firebase-era keys so a mixed-state browser doesn't
      // feed stale data back to AuthContext after migration.
      localStorage.removeItem('hotelops-account');
    } catch {
      // ignore — private browsing / no storage
    }

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
    <AuthContext.Provider value={{ user, loading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
