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
 *   - Approvals — the shared-knowledge promotion queue (0353). Counts items
 *     waiting for a decision PLUS live ones whose 75 days ran out. It rides
 *     this strip because the strip is on every admin tab: a queue you have to
 *     remember to open is a queue nobody works.
 *   - MRR placeholder (pilot mode → null until billing flips on)
 *
 * Cheap counts only — no row data. Polled every ~15s by the header so
 * the chips refresh without the user clicking Refresh.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { defineRoute, adminGate } from '@/lib/api-route';
import { countNeedingAttention, isMissingRelationError } from '@/lib/promotion-queue';
import { PMS_ROBOT_ENABLED } from '@/lib/pms/robot-status';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export const GET = defineRoute({
  resolve: (req) => adminGate(req),
  handler: async (ctx) => {

  const now = Date.now();
  const dayAgoIso = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  // Core admin metrics stay live independently of the retired robot.
  const [
    propsRes,
    errorsRes,
    promotionsRes,
  ] = await Promise.all([
    supabaseAdmin
      .from('properties')
      .select('id, onboarding_completed_at'),
    supabaseAdmin
      .from('error_logs')
      .select('ts', { count: 'exact', head: true })
      .gte('ts', dayAgoIso),
    // Not in the fail-loud loop below: migration 0353 is applied by hand, so
    // between deploy and apply this table legitimately does not exist. A
    // missing promotion queue must not blank the whole admin header.
    supabaseAdmin
      .from('knowledge_promotions')
      .select('status, expires_at')
      .in('status', ['pending', 'approved']),
  ]);

  // None of these queries should fail in steady state, but if one does we
  // surface the error rather than silently zero the count.
  for (const r of [propsRes, errorsRes]) {
    if (r.error) {
      return ctx.err(`Stats query failed: ${r.error.message}`, { status: 500 });
    }
  }

  // null (not 0) when the queue can't be read, so the header shows "—" rather
  // than claiming there is nothing waiting.
  let promotionsPending: number | null = null;
  if (!promotionsRes.error) {
    promotionsPending = countNeedingAttention(
      (promotionsRes.data ?? []) as Array<{ status: 'pending' | 'approved'; expires_at: string | null }>,
      new Date(now),
    );
  } else if (!isMissingRelationError(promotionsRes.error)) {
    return ctx.err(`Stats query failed: ${promotionsRes.error.message}`, { status: 500 });
  }

  let aliveIds = new Set<string>();
  let activeJobs = 0;
  if (PMS_ROBOT_ENABLED) {
    const [aliveSessionsRes, mapperJobsRes] = await Promise.all([
      supabaseAdmin
        .from('property_sessions')
        .select('property_id')
        .eq('status', 'alive'),
      supabaseAdmin
        .from('workflow_jobs')
        .select('id', { count: 'exact', head: true })
        .like('kind', 'mapper.%')
        .in('status', ['queued', 'running']),
    ]);
    for (const r of [aliveSessionsRes, mapperJobsRes]) {
      if (r.error) {
        return ctx.err(`Stats query failed: ${r.error.message}`, { status: 500 });
      }
    }
    aliveIds = new Set(
      ((aliveSessionsRes.data ?? []) as { property_id: string }[]).map((s) => s.property_id),
    );
    activeJobs = mapperJobsRes.count ?? 0;
  }
  const props = (propsRes.data ?? []) as { id: string; onboarding_completed_at: string | null }[];
  const liveHotels = props.filter((p) => p.onboarding_completed_at !== null || aliveIds.has(p.id)).length;

  return ctx.ok({
    liveHotels,
    onboarding: props.length - liveHotels,
    errorsToday: errorsRes.count ?? 0,
    activeJobs,
    promotionsPending,
    // Pilot mode: no billing yet. When billing flips on this becomes a $/mo
    // sum from active subscriptions in Stripe (or computed from properties).
    mrrCents: null,
    pilotMode: true,
  });
  },
});
