import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ─── Why this file is hardened ─────────────────────────────────────────────
// The previous Firebase Admin version silently console.warn'd when env vars
// were missing and then admin.firestore() would throw an obscure "default
// Firebase app does not exist" from some unrelated API route. We also
// learned on 2026-04-21 that a stale/revoked service account key lets
// initializeApp() succeed lazily and only blows up on the *first DB call*
// — which looks like any other 500.
//
// Supabase Admin (service_role) behaves similarly: the client constructs
// fine with any string as a key, and the first query is where an invalid
// key surfaces. So: missing env vars throw loudly at module load with the
// exact var names, and `verifySupabaseAdmin()` does a cheap preflight
// read that surfaces auth failures with a specific, actionable error.
// ───────────────────────────────────────────────────────────────────────────

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const missing: string[] = [];
if (!url) missing.push('NEXT_PUBLIC_SUPABASE_URL');
if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
if (missing.length) {
  throw new Error(
    `Supabase Admin SDK missing required env vars: ${missing.join(', ')}. ` +
    `Fix: Vercel Project Settings → Environment Variables (and Railway for the scraper), then redeploy.`
  );
}

// Singleton across Next.js hot reloads + serverless warm containers.
// `__supabaseAdmin` lives on globalThis so HMR doesn't create duplicates.
const globalForSupabase = globalThis as unknown as { __supabaseAdmin?: SupabaseClient };

export const supabaseAdmin: SupabaseClient =
  globalForSupabase.__supabaseAdmin ??
  createClient(url!, serviceRoleKey!, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { 'x-staxis-service': 'admin-api' },
    },
  });

if (process.env.NODE_ENV !== 'production') {
  globalForSupabase.__supabaseAdmin = supabaseAdmin;
}

// Preflight: does a cheap authenticated read against scraper_status to
// verify the service_role key is still valid. Call from any route that
// absolutely needs admin access (e.g. /api/cron/scraper-health) before
// doing real work.
//
// Memoized per warm container so only the first request per cold-start
// pays the ~50–200ms round-trip. A failure clears the cache so the next
// request retries (lets a fresh redeploy's env vars take effect without
// waiting for container cycling).
let authPreflight: Promise<void> | null = null;
export async function verifySupabaseAdmin(): Promise<void> {
  if (!authPreflight) {
    authPreflight = (async () => {
      try {
        const { error } = await supabaseAdmin
          .from('scraper_status')
          .select('key')
          .eq('key', 'heartbeat')
          .limit(1);
        if (error) throw error;
      } catch (err) {
        authPreflight = null; // allow retry on next request
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Supabase Admin auth failed on Vercel: ${msg}. ` +
          `SUPABASE_SERVICE_ROLE_KEY is likely stale or revoked. ` +
          `Fix: Supabase Dashboard → Project Settings → API → ` +
          `Reset service_role key, then update BOTH Vercel ` +
          `(SUPABASE_SERVICE_ROLE_KEY) AND Railway (SUPABASE_SERVICE_ROLE_KEY).`
        );
      }
    })();
  }
  return authPreflight;
}

// Legacy alias — old code imported `admin` as default; keep it working.
export default supabaseAdmin;
