'use client';

// Browser-side Supabase client. Reads anon key (safe to expose). Persists
// session in localStorage so Maria stays logged in across refreshes, and
// auto-refreshes JWTs so long-lived tabs don't get kicked out mid-shift.
//
// All Firestore reads/writes from frontend code now go through this client
// and are enforced by RLS (properties.owner_id = auth.uid() and
// user_owns_property() for the 22 per-property tables).

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

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
  createBrowserClient(url ?? '', anonKey ?? '');

if (typeof window !== 'undefined') g.__supabaseBrowser = supabase;

// Back-compat named exports so legacy `import { auth, db } from '@/lib/firebase'`
// can be swapped for `import { auth, db } from '@/lib/supabase'` as a cheap
// drop-in. `auth` is the supabase.auth namespace; `db` is the whole client
// (used to reach into tables via .from()).
export const auth = supabase.auth;
export const db = supabase;

export default supabase;
