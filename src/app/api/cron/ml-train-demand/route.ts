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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const unauth = requireCronSecret(req);
  if (unauth) return unauth;

  const mlServiceUrl = process.env.ML_SERVICE_URL;
  const mlServiceSecret = process.env.ML_SERVICE_SECRET;
  if (!mlServiceUrl || !mlServiceSecret) {
    log.warn('ml-train-demand: ML_SERVICE_URL or ML_SERVICE_SECRET missing — skipping (this is fine until Railway ML service is deployed)', { requestId });
    return NextResponse.json({
      ok: true,
      skipped: 'ML service not configured yet',
      requestId,
    });
  }

  // Pull all properties (currently 1; scales when Reeyen sells property #2).
  const { data: properties, error } = await supabaseAdmin
    .from('properties')
    .select('id, name');
  if (error) {
    log.error('ml-train-demand: properties read failed', { requestId, err: error as unknown as Error });
    return NextResponse.json({ ok: false, error: errToString(error) }, { status: 500 });
  }

  const results: Array<{ property_id: string; status: string; detail?: unknown }> = [];
  for (const property of properties ?? []) {
    const t0 = Date.now();
    try {
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
      results.push({ property_id: property.id, status: (json as { status?: string }).status ?? 'unknown', detail: json });
    } catch (err) {
      log.error('ml-train-demand: ML service call failed', {
        requestId,
        property_id: property.id,
        err: err as Error,
      });
      results.push({ property_id: property.id, status: 'error', detail: errToString(err) });
    }
  }

  return NextResponse.json({
    ok: true,
    requestId,
    properties_processed: results.length,
    results,
  });
}
