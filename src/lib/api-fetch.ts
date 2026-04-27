'use client';

/**
 * Browser-side helper: fetch wrapper that automatically adds the user's
 * Supabase access token as `Authorization: Bearer …`.
 *
 * Use for any /api/* call that goes through `requireSession` on the
 * server side. If there's no session (logged out), the call goes
 * through anonymously and the server will respond 401 — caller decides
 * how to handle that.
 *
 * Why this exists: every /api fetch in the UI used to be a raw
 * `fetch(url, { headers: { 'Content-Type': 'application/json' } })`
 * with no auth header. After we added requireSession() to the SMS-firing
 * routes, those raw fetches started 401-ing. This helper centralizes
 * the token attachment so the routes stay protected and the UI keeps
 * working without each call site re-implementing getSession().
 */

import { supabase } from '@/lib/supabase';

export async function fetchWithAuth(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers ?? {});
  // Don't clobber an explicit caller-supplied Authorization.
  if (!headers.has('authorization') && !headers.has('Authorization')) {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token) {
        headers.set('Authorization', `Bearer ${session.access_token}`);
      }
    } catch {
      // No session — proceed without. Server will 401 if it needs auth.
    }
  }
  return fetch(input, { ...init, headers });
}
