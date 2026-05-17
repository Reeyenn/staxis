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

import React, { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { AppRole } from '@/lib/roles';

export interface AppUser {
  uid: string;               // auth.users.id  AND  accounts.data_user_id (same value)
  accountId: string;         // accounts.id
  username: string;          // lowercase username (no @staxis.local suffix)
  displayName: string;
  role: AppRole;
  propertyAccess: string[];  // ["*"] = all properties (admin-only convention), or specific property UUIDs
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
// Returns null if no accounts row exists (dangling auth user — treat as
// unauthenticated and sign out).
async function loadAppUser(authUid: string): Promise<AppUser | null> {
  const { data, error } = await supabase
    .from('accounts')
    .select('id, username, display_name, role, property_access, data_user_id')
    .eq('data_user_id', authUid)
    .maybeSingle();

  if (error) {
    console.error('AuthContext: failed to load accounts row', error);
    return null;
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
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    let resolved = false;

    // Hydrate from the session Supabase restored from localStorage on page
    // load. This fires BEFORE the first onAuthStateChange event, so we get
    // an accurate initial user without a flash of logged-out state.
    void (async () => {
      try {
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
      if (event === 'SIGNED_OUT' || !session?.user) {
        setUser(null);
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
                && JSON.stringify(prev.propertyAccess ?? []) === JSON.stringify(appUser.propertyAccess ?? [])
              ) {
                return prev;
              }
              return appUser;
            });
          } else {
            await supabase.auth.signOut();
            setUser(null);
          }
        } catch (err) {
          console.error('AuthContext: onAuthStateChange deferred handler error', err);
          if (active) setUser(null);
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
