/**
 * GET /api/admin/overview-stats
 *
 * Powers the sticky header at the top of /admin. One round-trip aggregate
 * of the numbers Reeyen wants visible at all times:
 *   - Live hotels — same rule as the Onboarding surface's isLive():
 *     wizard finished (onboarding_completed_at) OR robot session alive.
 *     (Was subscription_status='active', which is always 0 in pilot mode
 *     and disagreed with the surface's own "N LIVE" pill.)
 *   - Onboarding — every other hotel. (Was last_synced_at IS NULL, a
 *     column nothing writes post-v4, so it counted everything.)
 *   - Errors today (last 24h from error_logs)
 *   - Active jobs (queued/running mapper jobs in workflow_jobs — the v4
 *     truth; onboarding_jobs/pull_jobs are empty stubs post-v4)
 *   - MRR placeholder (pilot mode → null until billing flips on)
 *
 * Cheap counts only — no row data. Polled every ~15s by the header so
 * the chips refresh without the user clicking Refresh.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const now = Date.now();
  const dayAgoIso = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  // Run all the queries in parallel — the property/session lists are id-only
  // (fleet is small, <200 rows), the rest are head-only counts.
  const [
    propsRes,
    aliveSessionsRes,
    errorsRes,
    mapperJobsRes,
  ] = await Promise.all([
    supabaseAdmin
      .from('properties')
      .select('id, onboarding_completed_at'),
    supabaseAdmin
      .from('property_sessions')
      .select('property_id')
      .eq('status', 'alive'),
    supabaseAdmin
      .from('error_logs')
      .select('ts', { count: 'exact', head: true })
      .gte('ts', dayAgoIso),
    supabaseAdmin
      .from('workflow_jobs')
      .select('id', { count: 'exact', head: true })
      .like('kind', 'mapper.%')
      .in('status', ['queued', 'running']),
  ]);

  // None of these queries should fail in steady state, but if one does we
  // surface the error rather than silently zero the count.
  for (const r of [propsRes, aliveSessionsRes, errorsRes, mapperJobsRes]) {
    if (r.error) {
      return err(`Stats query failed: ${r.error.message}`, { requestId, status: 500 });
    }
  }

  const aliveIds = new Set(
    ((aliveSessionsRes.data ?? []) as { property_id: string }[]).map((s) => s.property_id),
  );
  const props = (propsRes.data ?? []) as { id: string; onboarding_completed_at: string | null }[];
  const liveHotels = props.filter((p) => p.onboarding_completed_at !== null || aliveIds.has(p.id)).length;

  return ok({
    liveHotels,
    onboarding: props.length - liveHotels,
    errorsToday: errorsRes.count ?? 0,
    activeJobs: mapperJobsRes.count ?? 0,
    // Pilot mode: no billing yet. When billing flips on this becomes a $/mo
    // sum from active subscriptions in Stripe (or computed from properties).
    mrrCents: null,
    pilotMode: true,
  }, { requestId });
}
