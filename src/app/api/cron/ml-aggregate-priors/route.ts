/**
 * GET /api/cron/ml-aggregate-priors
 *
 * Daily cron (07:00 CT, after housekeeping + inventory inference) that
 * triggers cross-hotel cohort prior aggregation on the ML service. Result
 * is the inventory_rate_priors table being refreshed from network data.
 *
 * Cohort priors only matter at scale (10+ hotels per cohort) but the cron
 * runs every day from day 1 — it's idempotent and cheap. The 'global'
 * cohort skips the upsert when n_hotels < 5 so industry-benchmark seeds
 * stay intact at small N.
 *
 * Auth: Bearer ${CRON_SECRET}.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { getPrimaryMlShardUrl } from '@/lib/ml-routing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const unauth = requireCronSecret(req);
  if (unauth) return unauth;

  // Cohort-prior aggregation is cross-fleet (reads from every property's
  // historical actuals to build cohort + global priors). Any shard can run
  // it because the source data is in the shared Supabase DB — there's no
  // shard-local state. We pick the primary shard deterministically so the
  // cross-fleet work hosts on the same Railway instance every day,
  // which makes capacity planning and log grouping cleaner.
  const mlServiceUrl = getPrimaryMlShardUrl();
  const mlServiceSecret = process.env.ML_SERVICE_SECRET;
  if (!mlServiceUrl || !mlServiceSecret) {
    log.warn('ml-aggregate-priors: ML service not configured', { requestId });
    return NextResponse.json({
      ok: true,
      skipped: 'ML service not configured yet',
      requestId,
    });
  }

  try {
    const res = await fetch(`${mlServiceUrl.replace(/\/$/, '')}/train/inventory-priors`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mlServiceSecret}`,
        'Content-Type': 'application/json',
        'x-request-id': requestId,
      },
      body: '{}',
      signal: AbortSignal.timeout(75_000),
    });
    const json = await res.json().catch(() => ({ error: 'non_json_response', http: res.status }));
    log.info('ml-aggregate-priors: result', { requestId, mlStatus: res.status, json });
    return NextResponse.json({ ok: true, requestId, result: json });
  } catch (e) {
    log.error('ml-aggregate-priors: ML service call failed', { requestId, err: e as Error });
    return NextResponse.json({ ok: false, error: errToString(e), requestId }, { status: 502 });
  }
}
