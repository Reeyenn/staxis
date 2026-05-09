/**
 * GET /api/admin/last-github-event
 *
 * Tiny cursor endpoint used by the System tab to detect "did anything
 * happen on GitHub since the last refetch?" without paying the cost of
 * fetching the full timeline state.
 *
 * Returns just the newest row in github_events (one DB query). The UI
 * polls this every 2s; when the latestTs changes vs the previous reply,
 * it kicks off a real /api/admin/build-status refetch.
 *
 * If the table is empty (no webhook events recorded yet), latestTs=null
 * and the UI falls back to its slow background timer.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 5;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { data } = await supabaseAdmin
    .from('github_events')
    .select('ts, event_type, branch')
    .order('ts', { ascending: false })
    .limit(1)
    .maybeSingle();

  return ok({
    latestTs: data?.ts ?? null,
    eventType: data?.event_type ?? null,
    branch: data?.branch ?? null,
  }, { requestId });
}
