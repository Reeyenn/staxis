/**
 * GET /api/cron/ml-train-inventory
 *
 * Weekly cron (Sunday 04:00 CT, +60min after demand) that triggers
 * inventory_rate training on the Python ML service for every active
 * property. One model per (property × item) gets trained.
 *
 * Auth: Bearer ${CRON_SECRET} via requireCronSecret.
 *
 * Schedule lives in .github/workflows/ml-cron.yml.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const unauth = requireCronSecret(req);
  if (unauth) return unauth;

  const mlServiceUrl = process.env.ML_SERVICE_URL;
  const mlServiceSecret = process.env.ML_SERVICE_SECRET;
  if (!mlServiceUrl || !mlServiceSecret) {
    log.warn('ml-train-inventory: ML_SERVICE_URL or ML_SERVICE_SECRET missing', { requestId });
    return NextResponse.json({
      ok: true,
      skipped: 'ML service not configured yet',
      requestId,
    });
  }

  const { data: properties, error } = await supabaseAdmin
    .from('properties')
    .select('id, name, inventory_ai_mode');
  if (error) {
    return NextResponse.json({ ok: false, error: errToString(error), requestId }, { status: 500 });
  }

  const results: Array<{ property_id: string; status: string; detail?: unknown }> = [];
  for (const property of properties ?? []) {
    if ((property as { inventory_ai_mode?: string }).inventory_ai_mode === 'off') {
      results.push({ property_id: property.id, status: 'skipped_ai_off' });
      continue;
    }
    const t0 = Date.now();
    try {
      const res = await fetch(`${mlServiceUrl.replace(/\/$/, '')}/train/inventory-rate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${mlServiceSecret}`,
          'Content-Type': 'application/json',
          'x-request-id': requestId,
        },
        body: JSON.stringify({ property_id: property.id }),
        signal: AbortSignal.timeout(75_000),
      });
      const json = await res.json().catch(() => ({ error: 'non_json_response', http: res.status }));
      log.info('ml-train-inventory: result', {
        requestId,
        property_id: property.id,
        elapsedMs: Date.now() - t0,
        items_trained: (json as { items_trained?: number }).items_trained ?? null,
      });
      results.push({ property_id: property.id, status: 'ok', detail: json });
    } catch (e) {
      log.error('ml-train-inventory: ML service call failed', {
        requestId,
        property_id: property.id,
        err: e as Error,
      });
      results.push({ property_id: property.id, status: 'error', detail: errToString(e) });
    }
  }

  return NextResponse.json({
    ok: true,
    requestId,
    properties_processed: results.length,
    results,
  });
}
