import { NextRequest } from 'next/server';
import { err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

// ─── Deprecated ────────────────────────────────────────────────────────────
// Firebase's custom-token flow required a server-side route to: (1) look up
// the account by username, (2) bcrypt-verify the password, (3) mint a
// Firebase custom token. All three steps are now handled client-side by
// supabase.auth.signInWithPassword() in AuthContext.signIn().
//
// This route stays only to return a clear 410 Gone if any cached client
// bundles still try to POST here during a rolling deploy. Once everyone's
// on the new bundle, this file can be deleted.
// ───────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  return err(
    'Endpoint deprecated. This server-side login route was retired as part of the Supabase Auth migration. ' +
      'The client now uses supabase.auth.signInWithPassword() directly. ' +
      'If you are seeing this error, refresh the page to load the latest client bundle.',
    { requestId, status: 410, code: ApiErrorCode.Forbidden },
  );
}
