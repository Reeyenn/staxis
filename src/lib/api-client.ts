'use client';

import { supabase } from './supabase';

/**
 * Browser-side helper that builds Headers with the Supabase bearer token.
 * Use in every fetch() call to internal /api/* routes that require session
 * auth (which, after the Phase-4 hardening, is most of them).
 *
 * Usage:
 *   await fetch('/api/foo', {
 *     method: 'POST',
 *     headers: await authHeaders(true),
 *     body: JSON.stringify(...),
 *   });
 */
export async function authHeaders(json = false): Promise<HeadersInit> {
  const headers: Record<string, string> = {};
  if (json) headers['Content-Type'] = 'application/json';
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token) headers.authorization = `Bearer ${session.access_token}`;
  } catch {
    // ignore — caller still gets a (likely 401) response from the API
  }
  return headers;
}
