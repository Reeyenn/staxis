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
import { runWithConcurrency } from '@/lib/parallel';
import { listMlShardUrls, resolveMlShardUrl } from '@/lib/ml-routing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const unauth = requireCronSecret(req);
  if (unauth) return unauth;

  const shardUrls = listMlShardUrls();
  const mlServiceSecret = process.env.ML_SERVICE_SECRET;
  if (shardUrls.length === 0 || !mlServiceSecret) {
    log.warn('ml-train-inventory: ML service not configured', { requestId });
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

  // Skip ai_off properties before fan-out so they don't take a parallel slot.
  type PropertyRow = { id: string; name: string; inventory_ai_mode?: string };
  const eligible: PropertyRow[] = [];
  const skipped: Array<{ property_id: string; status: string }> = [];
  for (const property of (properties ?? []) as PropertyRow[]) {
    if (property.inventory_ai_mode === 'off') {
      skipped.push({ property_id: property.id, status: 'skipped_ai_off' });
    } else {
      eligible.push(property);
    }
  }

  // Parallel fan-out (concurrency 3 — inventory training is the heaviest
  // stage; one call iterates every inventory.id in the property).
  const outcomes = await runWithConcurrency(eligible, async (property) => {
    const t0 = Date.now();
    const mlServiceUrl = resolveMlShardUrl(property.id)!;
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
    return json;
  }, 3);

  const results = [
    ...skipped,
    ...outcomes.map((o) => {
      if (o.ok) return { property_id: o.input.id, status: 'ok', detail: o.value };
      log.error('ml-train-inventory: ML service call failed', {
        requestId, property_id: o.input.id, err: o.error as Error,
      });
      return { property_id: o.input.id, status: 'error', detail: errToString(o.error) };
    }),
  ];

  return NextResponse.json({
    ok: true,
    requestId,
    properties_processed: results.length,
    results,
  });
}
