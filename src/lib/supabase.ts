'use client';

// Browser-side Supabase client.
//
// Storage backend: cookies (via `@supabase/ssr`'s `createBrowserClient`),
// paired with `src/middleware.ts`, which checks only for a session-candidate
// cookie on protected full-page requests. Token refresh remains the browser
// client's job; API routes validate the token they receive. Cookies
// are Secure + SameSite=Lax in production; not httpOnly because the
// browser client must be able to read them through `document.cookie`
// (httpOnly cookies can't round-trip through the JS-side refresh path).
// The XSS protection vs the previous localStorage setup is incremental:
// cookies aren't exposed in `Application → Local Storage` dumps and don't
// leave the origin on cross-site requests.
//
// Historical note — DO NOT REVERT THE PAIRING. A previous attempt to use
// `createBrowserClient` without the corresponding cookie-aware route gate
// silently lost the access_token
// across client-side navigations: the session restored from cookies came
// back populated-user/empty-token, producing 401 "Expected 3 parts in JWT;
// got 1" on every DB query and a spurious "No properties found" screen.
// The current middleware intentionally does not refresh or rewrite auth
// cookies; see its presence-check contract. If that storage/gate pairing is
// changed, re-test direct and client navigation with expired sessions.
//
// All Supabase reads/writes from frontend code go through this client and
// are enforced by RLS (properties.owner_id = auth.uid() and
// user_owns_property() for the per-property tables).

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { clientEnv } from '@/lib/env-client';
import { supabaseBrowserFetch } from '@/lib/supabase-browser-fetch';

// Required vars validated in clientEnv at module load (src/lib/env-client.ts).
// No local guard needed — schema throws if either is missing.
const url = clientEnv.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const projectRef = new URL(url).hostname.split('.')[0];
const authCookiePrefix = `sb-${projectRef}-auth-token`;

/**
 * Remove every cookie chunk used by the browser Supabase session.
 *
 * GoTrue deliberately leaves local storage untouched when its remote
 * `/logout` request fails with a network/5xx error. That is sensible for an
 * API client, but it is surprising for an explicit Staxis sign-out: the UI
 * can look signed out while a reload restores the old account. The normal
 * path remains `auth.signOut()`; this is the bounded, browser-only fallback
 * that makes an offline/failed sign-out durable on a shared front-desk Mac.
 */
export function clearSupabaseBrowserSessionCookies(): void {
  if (typeof document === 'undefined') return;

  const cookieNames = document.cookie
    .split(';')
    .map((entry) => entry.trim().split('=', 1)[0])
    .filter((name) => name === authCookiePrefix || name.startsWith(`${authCookiePrefix}.`));

  for (const name of cookieNames) {
    document.cookie = `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`;
  }
}

// Singleton across HMR reloads — new client per render would drop the
// auth session listener and cause onAuthStateChange to miss events.
const g = globalThis as unknown as { __supabaseBrowser?: SupabaseClient };
export const supabase: SupabaseClient =
  g.__supabaseBrowser ??
  createBrowserClient(url, anonKey, {
    // Keep GoTrue's default navigator lock: cookie sessions are shared across
    // tabs, so refreshes need cross-tab serialization. The custom fetch makes
    // the operation *inside* that lock terminal instead of letting one stalled
    // token refresh wedge initialization and every later getSession()/DB read.
    global: { fetch: supabaseBrowserFetch },
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
