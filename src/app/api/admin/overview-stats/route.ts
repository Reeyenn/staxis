/**
 * GET /api/admin/overview-stats
 *
 * Powers the sticky header at the top of /admin. One round-trip aggregate
 * of the numbers Reeyen wants visible at all times:
 *   - Live hotels (subscription_status='active')
 *   - Onboarding (signed up but not yet synced)
 *   - Errors today (last 24h from error_logs)
 *   - Active jobs (running onboarding_jobs + running pull_jobs)
 *   - MRR placeholder (pilot mode → null until billing flips on)
 *
 * Cheap counts only — no row data. Polled every ~15s by the header so
 * the chips refresh without the user clicking Refresh.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const RUNNING_JOB_STATES = ['queued', 'running', 'mapping', 'extracting'];

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const now = Date.now();
  const dayAgoIso = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  // Run all the count queries in parallel — each is a head-only count, so the
  // whole aggregate is one HTTP round-trip from the dashboard's perspective.
  const [
    activeRes,
    onboardingRes,
    errorsRes,
    runningOnboardingRes,
    runningPullRes,
  ] = await Promise.all([
    supabaseAdmin
      .from('properties')
      .select('id', { count: 'exact', head: true })
      .eq('subscription_status', 'active'),
    supabaseAdmin
      .from('properties')
      .select('id', { count: 'exact', head: true })
      .is('last_synced_at', null),
    supabaseAdmin
      .from('error_logs')
      .select('ts', { count: 'exact', head: true })
      .gte('ts', dayAgoIso),
    supabaseAdmin
      .from('onboarding_jobs')
      .select('id', { count: 'exact', head: true })
      .in('status', RUNNING_JOB_STATES),
    supabaseAdmin
      .from('pull_jobs')
      .select('id', { count: 'exact', head: true })
      .in('status', ['queued', 'running']),
  ]);

  // None of these queries should fail in steady state, but if one does we
  // surface the error rather than silently zero the count.
  for (const r of [activeRes, onboardingRes, errorsRes, runningOnboardingRes, runningPullRes]) {
    if (r.error) {
      log.error('overview-stats query failed', { err: r.error, requestId });
      return err('Stats query failed', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }
  }

  return ok({
    liveHotels: activeRes.count ?? 0,
    onboarding: onboardingRes.count ?? 0,
    errorsToday: errorsRes.count ?? 0,
    activeJobs: (runningOnboardingRes.count ?? 0) + (runningPullRes.count ?? 0),
    // Pilot mode: no billing yet. When billing flips on this becomes a $/mo
    // sum from active subscriptions in Stripe (or computed from properties).
    mrrCents: null,
    pilotMode: true,
  }, { requestId });
}
