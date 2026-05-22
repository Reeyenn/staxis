/**
 * /api/scraper-status — property-scoped freshness probe.
 *
 * Powers <StaleDataBanner /> on /dashboard and /staff. Reads:
 *   - dashboard_by_date.pulled_at  (the per-property 15-min PMS pull)
 *   - plan_snapshots.pulled_at     (the hourly CSV plan snapshot)
 *   - scraper_status[vercel_watchdog].degraded  (alerting health)
 *
 * Auth: requireSession + userHasPropertyAccess. F6 reframe — the v1
 * plan made this public; Codex caught that operational timing across
 * tenants is leakage. Property-scoped read avoids the multi-tenant
 * "see another property's stale state" failure mode.
 *
 * Banner polls every 60s × open tabs. Rate-limited at 240/hr per
 * (user, property) — enough for 4 tabs without 429, capped against
 * runaway-loop / replay scenarios.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { validateUuid } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function ageMinutes(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 60_000);
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const { searchParams } = new URL(req.url);
  const pidV = validateUuid(searchParams.get('pid'), 'pid');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const pid = pidV.value!;

  if (!(await userHasPropertyAccess(session.userId, pid))) {
    return err('forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  // Rate-limit on (user, property) — 240/hr cap absorbs 4 open tabs polling
  // every 60s; anything beyond that is runaway. Failing open here (read-only,
  // not billing-impacting) so a Postgres blip doesn't take the banner down.
  const rlKey = `${session.userId}:${pid}`;
  const limit = await checkAndIncrementRateLimit('scraper-status', rlKey);
  if (!limit.allowed) return rateLimitedResponse(limit.current, limit.cap, limit.retryAfterSec);

  try {
    // Most-recent dashboard_by_date row for this property. Reading the
    // newest row (not "today's") so the banner stays correct across
    // midnight when the scraper hasn't written tomorrow's row yet.
    const [dashRes, planRes, watchdogRes] = await Promise.all([
      supabaseAdmin
        .from('dashboard_by_date')
        .select('pulled_at, error_code')
        .eq('property_id', pid)
        .order('pulled_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabaseAdmin
        .from('plan_snapshots')
        .select('pulled_at')
        .eq('property_id', pid)
        .order('pulled_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabaseAdmin
        .from('scraper_status')
        .select('data')
        .eq('key', 'vercel_watchdog')
        .maybeSingle(),
    ]);

    if (dashRes.error) throw dashRes.error;
    if (planRes.error) throw planRes.error;
    if (watchdogRes.error) throw watchdogRes.error;

    const dashPulledAt = (dashRes.data?.pulled_at as string | null) ?? null;
    const planPulledAt = (planRes.data?.pulled_at as string | null) ?? null;
    const watchdog = (watchdogRes.data?.data ?? {}) as {
      degraded?: boolean;
      degradedReason?: string;
    };

    return ok({
      dashboard: {
        pulled_at:   dashPulledAt,
        age_minutes: ageMinutes(dashPulledAt),
        error_code:  (dashRes.data?.error_code as string | null) ?? null,
      },
      plan: {
        pulled_at:   planPulledAt,
        age_minutes: ageMinutes(planPulledAt),
      },
      watchdog: {
        degraded:        watchdog.degraded === true,
        degraded_reason: watchdog.degraded === true ? (watchdog.degradedReason ?? null) : null,
      },
    }, {
      requestId,
      // Private cache: 30s per-client window so a stale-banner tab refresh
      // doesn't re-query Supabase 4x in 2 minutes for the same answer.
      headers: { 'Cache-Control': 'private, max-age=30' },
    });
  } catch (caughtErr) {
    console.error('[scraper-status] Error:', errToString(caughtErr));
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
