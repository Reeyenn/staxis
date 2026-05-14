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
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';

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

  // Phase M3 (2026-05-14): aggregate inventory + demand + supply cohort
  // priors in parallel. All three are cross-fleet, idempotent, cheap.
  // Failure of one does NOT block the others — each gets its own
  // ok/fail signal and the heartbeat only writes when ALL three agree.
  // Bind to non-null locals so TS's nullability narrowing carries into
  // the nested helper closure (the early-return above guarantees both
  // are present, but TS doesn't track narrowing through function decls).
  const baseUrl: string = mlServiceUrl;
  const secret: string = mlServiceSecret;
  async function callAggregator(endpoint: string): Promise<{ endpoint: string; ok: boolean; status: number; json: unknown }> {
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}${endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
          'x-request-id': requestId,
        },
        body: '{}',
        signal: AbortSignal.timeout(75_000),
      });
      const json = await res.json().catch(() => ({ error: 'non_json_response', http: res.status }));
      const mlStatus = (json as { status?: string; error?: string }).status ?? 'ok';
      const ok = res.ok && mlStatus !== 'error' && !(json as { error?: string }).error;
      return { endpoint, ok, status: res.status, json };
    } catch (e) {
      return { endpoint, ok: false, status: 0, json: { error: errToString(e) } };
    }
  }

  try {
    const results = await Promise.all([
      callAggregator('/train/inventory-priors'),
      callAggregator('/train/demand-priors'),
      callAggregator('/train/supply-priors'),
    ]);
    log.info('ml-aggregate-priors: results', { requestId, results });

    // ─── Silent-success guard (May 2026 audit pass-3) ────────────────────
    // The cron's job is "run all three aggregations." Heartbeat only
    // writes when ALL three agreed. If even one failed, doctor's
    // cron_heartbeats_fresh check fires after 2× cadence — operator
    // gets paged with the specific failed endpoint.
    const allSucceeded = results.every((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    if (allSucceeded) {
      await writeCronHeartbeat('ml-aggregate-priors', {
        requestId,
        notes: { aggregated: results.map((r) => r.endpoint) },
      });
    } else {
      log.error('ml-aggregate-priors: at least one aggregator failed — heartbeat NOT written', {
        requestId,
        failed: failed.map((f) => ({ endpoint: f.endpoint, status: f.status, json: f.json })),
      });
    }

    return NextResponse.json(
      { ok: allSucceeded, requestId, results },
      { status: allSucceeded ? 200 : 502 },
    );
  } catch (e) {
    log.error('ml-aggregate-priors: orchestration failed', { requestId, err: e as Error });
    return NextResponse.json({ ok: false, error: errToString(e), requestId }, { status: 502 });
  }
}
