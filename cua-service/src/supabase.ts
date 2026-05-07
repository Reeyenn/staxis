/**
 * Service-role Supabase client for the CUA worker.
 *
 * Mirrors src/lib/supabase-admin.ts in the Next.js app: fail loudly at
 * module load if the required env vars are missing. The worker has
 * nowhere to write without these, so crash-loop is the right failure
 * mode (Fly.io will surface it, scraper-health-cron will alert).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL) {
  throw new Error(
    'Missing NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL). Set it in Fly secrets: ' +
    'fly secrets set NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co'
  );
}
if (!SERVICE_ROLE_KEY) {
  throw new Error(
    'Missing SUPABASE_SERVICE_ROLE_KEY. Set it in Fly secrets: ' +
    'fly secrets set SUPABASE_SERVICE_ROLE_KEY=eyJ...'
  );
}

export const supabase: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
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
