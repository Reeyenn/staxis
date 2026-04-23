'use client';

// Browser-side Supabase client.
//
// History note: we previously used `createBrowserClient` from `@supabase/ssr`,
// which is designed for Next.js server-side rendering with middleware
// cookie-forwarding. Without the required middleware, its default cookie
// storage silently lost the access_token across page navigations — sessions
// were "live" in memory for the initial page, then got restored as a partial
// session (user populated, token empty length 0) after any client-side
// navigation, producing 401 "Expected 3 parts in JWT; got 1" on every DB
// query and a spurious "No properties found" screen.
//
// Fix: use the regular `createClient` from `@supabase/supabase-js` with
// explicit localStorage persistence. This is the standard SPA-style auth
// setup — session writes to localStorage on sign-in, any page read hydrates
// from localStorage. No middleware required.
//
// All Firestore reads/writes from frontend code now go through this client
// and are enforced by RLS (properties.owner_id = auth.uid() and
// user_owns_property() for the 22 per-property tables).

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // Fail loudly in the browser console — missing env vars at build time
  // would have silently shipped an unusable app.
  // eslint-disable-next-line no-console
  console.error(
    '[Supabase] Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. ' +
    'Fix: Vercel Project Settings → Environment Variables, then redeploy.'
  );
}

// Singleton across HMR reloads — new client per render would drop the
// auth session listener and cause onAuthStateChange to miss events.
const g = globalThis as unknown as { __supabaseBrowser?: SupabaseClient };
export const supabase: SupabaseClient =
  g.__supabaseBrowser ??
  createClient(url ?? '', anonKey ?? '', {
    auth: {
      // Persist the session across page loads via localStorage. This is the
      // default for `createClient` but we're being explicit to prevent a
      // future accidental rewrite to a different storage backend.
      persistSession: true,
      // Auto-refresh JWTs before expiry so long-lived tabs don't get kicked
      // out mid-shift. Supabase default behavior.
      autoRefreshToken: true,
      // Read PKCE / OAuth codes from the URL on return from a provider. We
      // don't currently use OAuth but leave this on so future additions work
      // without another supabase.ts edit.
      detectSessionInUrl: true,
      // Explicit storage — localStorage, scoped by a stable key name so that
      // (a) we can grep for it when debugging, (b) a future supabase-js
      // version change to the default storageKey doesn't invisibly break
      // existing sessions.
      storageKey: 'staxis-auth',
      flowType: 'pkce',
    },
  });

if (typeof window !== 'undefined') g.__supabaseBrowser = supabase;

// Named exports: `auth` is the supabase.auth namespace; `db` is the whole
// client (used to reach into tables via .from()).
export const auth = supabase.auth;
export const db = supabase;

export default supabase;
