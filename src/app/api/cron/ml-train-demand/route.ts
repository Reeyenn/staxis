/**
 * GET /api/cron/ml-train-demand
 *
 * Weekly cron (Sunday 03:00 CT) that triggers a Layer 1 (Demand) training
 * run on the Python ML service for every active property.
 *
 * Security:
 * - Bearer ${CRON_SECRET} (timing-safe compare via requireCronSecret).
 * - The downstream Railway ML service requires Bearer ${ML_SERVICE_SECRET}
 *   on its /train/demand endpoint. We forward via env var.
 *
 * Behavior:
 * - Reads all properties from properties table.
 * - For each, POSTs to ML_SERVICE_URL/train/demand with {property_id}.
 * - Aggregates results into a single response.
 * - Each ML service call is short-circuit-safe: if the property has too
 *   little data, the service returns {status: 'insufficient_data'} and
 *   writes a model_runs row with is_active=false. No crashes.
 *
 * Cadence:
 * - Vercel cron config in vercel.json: 0 8 * * 0 (08:00 UTC = 03:00 CDT
 *   Sunday morning). Models retrain weekly so we don't burn ML service
 *   capacity on noise — Layer 1 patterns evolve slowly.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { runWithConcurrency, applyShardFilter } from '@/lib/parallel';
import { listMlShardUrls, resolveMlShardUrl } from '@/lib/ml-routing';
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
import {
  emitPropertyMisconfiguredEvent,
  parsePropertyMisconfiguredError,
} from '@/lib/ml-misconfigured-events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Bumped from 60 (Hobby cap) to 300 (Pro cap). Fleet-scale headroom.
export const maxDuration = 300;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const unauth = requireCronSecret(req);
  if (unauth) return unauth;

  const shardUrls = listMlShardUrls();
  const mlServiceSecret = process.env.ML_SERVICE_SECRET;
  if (shardUrls.length === 0 || !mlServiceSecret) {
    log.warn('ml-train-demand: ML service not configured — skipping (this is fine until Railway ML service is deployed)', { requestId });
    return NextResponse.json({
      ok: true,
      skipped: 'ML service not configured yet',
      requestId,
    });
  }

  // Pull all properties in stable order so sharding is deterministic.
  const { data: properties, error } = await supabaseAdmin
    .from('properties')
    .select('id, name')
    .order('id');
  if (error) {
    log.error('ml-train-demand: properties read failed', { requestId, err: error as unknown as Error });
    return NextResponse.json({ ok: false, error: errToString(error) }, { status: 500 });
  }

  // Sharding for fleet scale: ?shard_offset=K&shard_count=N splits the
  // property fanout across N parallel GH Actions jobs. Defaults to no
  // sharding.
  const url = new URL(req.url);
  const sharded = applyShardFilter(properties ?? [], url.searchParams);
  log.info('ml-train-demand: start', { requestId, shardHeader: sharded.header });

  // Parallel fan-out with a small concurrency cap. Training is CPU-bound on
  // the Railway ML side (XGBoost fit), so going wide-open isn't actually
  // faster and risks OOM on the small instance. Cap at 5 — gives ~5x
  // speedup vs the old sequential loop while keeping memory bounded.
  const outcomes = await runWithConcurrency(sharded.items, async (property) => {
    const t0 = Date.now();
    // Resolve per-property so multi-shard deploys route to the right
    // Railway service. Falls back to ML_SERVICE_URL on single-shard.
    // resolveMlShardUrl can return null but the early-return above
    // guarantees at least one URL is configured here.
    const mlServiceUrl = resolveMlShardUrl(property.id)!;
    const res = await fetch(`${mlServiceUrl.replace(/\/$/, '')}/train/demand`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mlServiceSecret}`,
        'Content-Type': 'application/json',
        'x-request-id': requestId,
      },
      body: JSON.stringify({ property_id: property.id }),
      signal: AbortSignal.timeout(45_000),
    });
    const json = await res.json().catch(() => ({ status: 'non_json_response', http: res.status }));
    const elapsedMs = Date.now() - t0;
    log.info('ml-train-demand: result', {
      requestId,
      property_id: property.id,
      property_name: property.name,
      elapsedMs,
      mlStatus: (json as { status?: string }).status ?? 'unknown',
    });

    // Codex follow-up 2026-05-13 (A2): persist property_misconfigured to
    // app_events when the ML service flags a missing total_rooms /
    // timezone during training (otherwise the only signal is a Vercel
    // log line). Plus map the error response to status: 'skipped' so
    // the heartbeat-degraded logic can surface it.
    const errStr = (json as { error?: string }).error;
    if (typeof errStr === 'string' && errStr.startsWith('property_misconfigured:')) {
      const parsed = parsePropertyMisconfiguredError(errStr);
      if (parsed) {
        await emitPropertyMisconfiguredEvent({
          requestId,
          propertyId: property.id,
          layer: 'demand',
          field: parsed.field,
          value: parsed.value,
        });
      }
      return { status: 'skipped', detail: errStr };
    }
    // Codex follow-up A6 (training-cron error mapping): non-2xx + any
    // error body → status: 'error' so the heartbeat is suppressed.
    if (typeof errStr === 'string' || !res.ok) {
      return {
        status: 'error',
        detail: errStr ?? (json as { http?: number }).http ?? `HTTP ${res.status}`,
      };
    }
    return { status: (json as { status?: string }).status ?? 'unknown', detail: json };
  }, 5);

  const results = outcomes.map((o) => {
    if (o.ok) return { property_id: o.input.id, status: o.value.status, detail: o.value.detail };
    log.error('ml-train-demand: ML service call failed', {
      requestId, property_id: o.input.id, err: o.error as Error,
    });
    return { property_id: o.input.id, status: 'error', detail: errToString(o.error) };
  });

  const anyError = results.some((r) => r.status === 'error');
  if (!anyError) {
    await writeCronHeartbeat('ml-train-demand', {
      requestId,
      notes: { properties_processed: results.length },
    });
  }
  // ── Outer ok reflects inner state (May 2026 audit pass-5) ───────────
  // Previously the outer ok was always true regardless of per-property
  // failures. The jq check in ml-cron.yml inspects .results[].status so
  // it still catches inner errors, but a curl|jq pipeline reading just
  // `.ok` would be lied to. Doctor's cron_heartbeats_fresh is the
  // authoritative signal but only fires after 2× cadence. Aligning the
  // HTTP response status + body with the actual outcome makes the
  // failure visible immediately.
  return NextResponse.json(
    {
      ok: !anyError,
      requestId,
      properties_processed: results.length,
      results,
    },
    { status: anyError ? 502 : 200 },
  );
}
