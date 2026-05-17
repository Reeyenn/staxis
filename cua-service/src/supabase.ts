/**
 * Service-role Supabase client for the CUA worker.
 *
 * Mirrors src/lib/supabase-admin.ts in the Next.js app: fail loudly at
 * module load if the required env vars are missing. The worker has
 * nowhere to write without these, so crash-loop is the right failure
 * mode (Fly.io will surface it, scraper-health-cron will alert).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env.js';

// env.ts already validated NEXT_PUBLIC_SUPABASE_URL (with legacy SUPABASE_URL
// fallback) and SUPABASE_SERVICE_ROLE_KEY at boot — both are guaranteed to
// be set here.

export const supabase: SupabaseClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

/** Used at startup to verify the service-role key is valid before
 *  entering the polling loop. Mirrors verifySupabaseAdmin() in the app. */
export async function verifyConnection(): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase.from('scraper_status').select('key').limit(1);
  if (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true };
}
