import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from '@/lib/env';

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
// key surfaces. The env module already throws at boot if either var is
// missing; this file only handles auth-time failures via verifySupabaseAdmin().
// ───────────────────────────────────────────────────────────────────────────

// Singleton across Next.js hot reloads + serverless warm containers.
// `__supabaseAdmin` lives on globalThis so HMR doesn't create duplicates.
const globalForSupabase = globalThis as unknown as { __supabaseAdmin?: SupabaseClient };

export const supabaseAdmin: SupabaseClient =
  globalForSupabase.__supabaseAdmin ??
  createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { 'x-staxis-service': 'admin-api' },
    },
  });

if (env.NODE_ENV !== 'production') {
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
        // Supabase's PostgrestError is a plain object, not an Error subclass
        // — String(err) on it returns literal "[object Object]" and hides the
        // real failure mode. Extract .message / .code / .hint manually so the
        // diagnostic in the thrown error is actually useful.
        let msg: string;
        if (err instanceof Error) {
          msg = err.message;
        } else if (err !== null && typeof err === 'object') {
          const e = err as Record<string, unknown>;
          const parts: string[] = [];
          if (typeof e.message === 'string') parts.push(e.message);
          if (typeof e.code    === 'string') parts.push(`code=${e.code}`);
          if (typeof e.hint    === 'string') parts.push(`hint=${e.hint}`);
          if (typeof e.status  === 'number') parts.push(`status=${e.status}`);
          msg = parts.length ? parts.join(' ') : JSON.stringify(err);
        } else {
          msg = String(err);
        }
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
