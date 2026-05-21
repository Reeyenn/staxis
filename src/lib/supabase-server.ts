/**
 * Server-side Supabase client factory.
 *
 * Wraps `@supabase/ssr`'s `createServerClient` with this app's cookie-store
 * plumbing. Use this in route handlers, server actions, and (later) any
 * server components that need to read the current user from the auth
 * cookies set by `createBrowserClient`.
 *
 * Uses the anon key — RLS still applies. For service-role access (bypasses
 * RLS) keep using `supabaseAdmin` from `@/lib/supabase-admin`.
 *
 * Paired with src/middleware.ts: the middleware also creates a server
 * client (wired to request/response cookies) and reads cookie presence at
 * the edge; this factory is for route handlers that need to call
 * `auth.getUser()` against the same cookie session.
 *
 * Server-only at runtime — `next/headers`'s `cookies()` throws when called
 * outside a Next.js request context (Server Components, Route Handlers,
 * Server Actions, middleware). Following the same convention as
 * `supabase-admin.ts`, we do NOT use the `'server-only'` import here
 * because that breaks the node:test runner's transitive imports of any
 * module that touches `api-auth.ts`. Anyone importing this from a client
 * component will get a clear `cookies()` runtime error.
 */
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { env } from '@/lib/env';

type CookieToSet = { name: string; value: string; options: CookieOptions };

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        // In a Server Component context the cookies API is read-only and
        // `cookieStore.set(...)` throws. Route Handlers and Server Actions
        // are writable. The try/catch is the @supabase/ssr docs' recommended
        // pattern: setAll is allowed to no-op silently in read-only contexts
        // because the middleware will refresh+rewrite the cookies on the
        // next request anyway.
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Server Component (read-only) — fine.
        }
      },
    },
  });
}
