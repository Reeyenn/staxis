// ─── GET /api/agent/picovoice-key ────────────────────────────────────────
// Hands the Picovoice access key to the authenticated client so the
// browser-side Porcupine SDK can initialize. The key isn't a NEXT_PUBLIC_*
// env var because exposing it to the build means anyone who scrapes the
// bundle gets it. By routing through a per-session endpoint we at least
// require a valid Supabase session before handing it over.
//
// Note: Picovoice access keys aren't true secrets — they're tied to
// project usage limits on Picovoice's side and they're embedded in any
// app the user installs anyway. The auth gate here is best-effort
// defense-in-depth, not a security boundary.
//
// Returns 404 if the key isn't configured (the wake-word feature is gated
// on the same condition via /api/agent/wake-word-available — clients
// should check that first).

import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/api-auth';
import { getOrMintRequestId } from '@/lib/log';
import { ok, err, ApiErrorCode } from '@/lib/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 5;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;

  const key = process.env.PICOVOICE_ACCESS_KEY;
  if (!key) {
    return err('wake word not configured', {
      requestId, status: 404, code: ApiErrorCode.NotFound,
    });
  }
  return ok({ accessKey: key }, { requestId });
}
