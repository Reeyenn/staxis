'use client';

// Browser-side Supabase client.
//
// Storage backend: cookies (via `@supabase/ssr`'s `createBrowserClient`),
// paired with `src/middleware.ts` which refreshes tokens at the edge so a
// server-rendered navigation always sees an up-to-date session. Cookies
// are Secure + SameSite=Lax in production; not httpOnly because the
// browser client must be able to read them through `document.cookie`
// (httpOnly cookies can't round-trip through the JS-side refresh path).
// The XSS protection vs the previous localStorage setup is incremental:
// cookies aren't exposed in `Application → Local Storage` dumps and don't
// leave the origin on cross-site requests.
//
// Historical note — DO NOT REVERT THE PAIRING. A previous attempt to use
// `createBrowserClient` WITHOUT a middleware silently lost the access_token
// across client-side navigations: the session restored from cookies came
// back populated-user/empty-token, producing 401 "Expected 3 parts in JWT;
// got 1" on every DB query and a spurious "No properties found" screen.
// Root cause was that `@supabase/ssr` expects the middleware to forward
// updated cookies on each server-rendered request. The middleware in this
// batch (src/middleware.ts) closes that gap. If a future change removes
// the middleware, this client must move back to plain `createClient` +
// localStorage at the same time — otherwise the partial-session bug
// returns.
//
// All Supabase reads/writes from frontend code go through this client and
// are enforced by RLS (properties.owner_id = auth.uid() and
// user_owns_property() for the per-property tables).

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { clientEnv } from '@/lib/env-client';

// Required vars validated in clientEnv at module load (src/lib/env-client.ts).
// No local guard needed — schema throws if either is missing.
const url = clientEnv.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Singleton across HMR reloads — new client per render would drop the
// auth session listener and cause onAuthStateChange to miss events.
const g = globalThis as unknown as { __supabaseBrowser?: SupabaseClient };
export const supabase: SupabaseClient =
  g.__supabaseBrowser ??
  createBrowserClient(url, anonKey, {
    auth: {
      // PKCE flow for OAuth providers + future password-link flows. Matches
      // the prior setup; not changing as part of this storage migration.
      flowType: 'pkce',
      // Read PKCE / OAuth codes from the URL on return from a provider. We
      // don't currently use OAuth but leave this on so future additions work
      // without another supabase.ts edit.
      detectSessionInUrl: true,
    },
  });

if (typeof window !== 'undefined') g.__supabaseBrowser = supabase;

// Named exports: `auth` is the supabase.auth namespace; `db` is the whole
// client (used to reach into tables via .from()).
export const auth = supabase.auth;
export const db = supabase;

export default supabase;
