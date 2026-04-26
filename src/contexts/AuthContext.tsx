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

export interface AppUser {
  uid: string;               // auth.users.id  AND  accounts.data_user_id (same value)
  accountId: string;         // accounts.id
  username: string;          // lowercase username (no @staxis.local suffix)
  displayName: string;
  role: 'admin' | 'owner' | 'staff';
  propertyAccess: string[];  // ["*"] = all properties (admin-only convention), or specific property UUIDs
}

interface AuthContextType {
  user: AppUser | null;
  loading: boolean;
  /** Returns an error string on failure, or null on success */
  signIn: (username: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  signIn: async () => null,
  signOut: async () => {},
});

// Username → synthetic email. Lowercase + trim for consistency with schema.
export function usernameToEmail(username: string): string {
  return `${username.toLowerCase().trim()}@staxis.local`;
}

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
  // Bumped on every signIn/signOut so async user-loaders from a stale auth
  // event can detect they've been superseded and skip their setUser. Without
  // this, a slow listener fetch resolving after a fresh signOut can re-
  // populate the user and leave the UI logged-in despite an explicit logout.
  const authVersionRef = useRef(0);

  useEffect(() => {
    let active = true;
    let resolved = false;

    // Hydrate from the session Supabase restored from localStorage on page
    // load. This fires BEFORE the first onAuthStateChange event, so we get
    // an accurate initial user without a flash of logged-out state.
    (async () => {
      const myVersion = authVersionRef.current;
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!active || myVersion !== authVersionRef.current) return;
        if (session?.user) {
          const appUser = await loadAppUser(session.user.id);
          if (!active || myVersion !== authVersionRef.current) return;
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
        if (active && myVersion === authVersionRef.current) setUser(null);
      } finally {
        if (active) {
          resolved = true;
          setLoading(false);
        }
      }
    })();

    // Subscribe to subsequent auth state changes (sign-in, sign-out, token
    // refresh). SIGNED_IN is what fires after our signInWithPassword call.
    const { data: listener } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!active) return;
      const myVersion = authVersionRef.current;
      try {
        if (event === 'SIGNED_OUT' || !session?.user) {
          setUser(null);
          return;
        }
        // SIGNED_IN, TOKEN_REFRESHED, USER_UPDATED all benefit from a refresh
        // of the AppUser in case role/propertyAccess changed.
        const appUser = await loadAppUser(session.user.id);
        // Drop this result if signOut happened while we were loading — the
        // listener fetch would otherwise repopulate `user` after explicit
        // logout, leaving the UI silently authenticated.
        if (!active || myVersion !== authVersionRef.current) return;
        if (appUser) {
          setUser(appUser);
        } else {
          await supabase.auth.signOut();
          setUser(null);
        }
      } catch (err) {
        console.error('AuthContext: onAuthStateChange error', err);
        if (active && myVersion === authVersionRef.current) setUser(null);
      }
    });

    // Safety timeout: if getSession() never resolves (broken localStorage,
    // network hang), drop loading=false so the rest of the app can render.
    // We do NOT clear `user` here — getSession may still resolve a moment
    // later with a real session, and clobbering `user` to null first causes
    // a flash of the sign-in form when the user is actually authenticated.
    // The render path can show a "still hydrating" spinner instead.
    const timeout = setTimeout(() => {
      if (!resolved && active) {
        console.warn('AuthContext: session hydration did not resolve within 4s — forcing loading=false');
        setLoading(false);
      }
    }, 4000);

    return () => {
      active = false;
      listener.subscription.unsubscribe();
      clearTimeout(timeout);
    };
  }, []);

  const signIn = async (username: string, password: string): Promise<string | null> => {
    try {
      authVersionRef.current += 1;
      const email = usernameToEmail(username);
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });

      if (error) {
        // Supabase returns "Invalid login credentials" for both bad username
        // and bad password — surface that as a generic message to avoid
        // leaking whether a username exists.
        if (error.message.toLowerCase().includes('invalid')) {
          return 'Invalid username or password';
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
    // Bump version FIRST so any in-flight loadAppUser from the listener will
    // see it's stale by the time it tries to setUser. State change next so
    // the UI hides protected views even if the network call below fails.
    authVersionRef.current += 1;
    setUser(null);
    try {
      sessionStorage.removeItem('hotelops-session-selected');
      // Wipe every hotelops-* key so the previous user's hotel selection,
      // language preference, and any other client-cached scoping data don't
      // leak to the next person who logs in on the same browser.
      localStorage.removeItem('hotelops-account');
      localStorage.removeItem('hotelops-active-property');
      localStorage.removeItem('hotelops-lang');
    } catch {
      // ignore — private browsing / no storage
    }
    try {
      await supabase.auth.signOut();
    } catch (err) {
      // Network failure on the upstream signOut — fall back to a local-only
      // sign-out so the session token in this browser is still cleared.
      console.error('AuthContext: supabase.auth.signOut threw', err);
      try { await supabase.auth.signOut({ scope: 'local' }); } catch { /* ignore */ }
    }
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
