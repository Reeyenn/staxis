/**
 * GET /api/cron/ml-train-supply
 *
 * Weekly cron (Sunday 03:30 CT, 30 min after demand training). Same shape
 * as /api/cron/ml-train-demand but POSTs to /train/supply on the Python
 * ML service.
 *
 * Spaced 30 min after demand training so the Railway service isn't doing
 * two heavy loads concurrently — it's a small Railway instance.
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
    log.warn('ml-train-supply: ML service not configured — skipping', { requestId });
    return NextResponse.json({ ok: true, skipped: 'ML service not configured yet', requestId });
  }

  const { data: properties, error } = await supabaseAdmin
    .from('properties')
    .select('id, name');
  if (error) {
    log.error('ml-train-supply: properties read failed', { requestId, err: error as unknown as Error });
    return NextResponse.json({ ok: false, error: errToString(error) }, { status: 500 });
  }

  const results: Array<{ property_id: string; status: string; detail?: unknown }> = [];
  for (const property of properties ?? []) {
    try {
      const res = await fetch(`${mlServiceUrl.replace(/\/$/, '')}/train/supply`, {
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
      results.push({ property_id: property.id, status: (json as { status?: string }).status ?? 'unknown', detail: json });
    } catch (err) {
      log.error('ml-train-supply: ML service call failed', { requestId, property_id: property.id, err: err as Error });
      results.push({ property_id: property.id, status: 'error', detail: errToString(err) });
    }
  }
  return NextResponse.json({ ok: true, requestId, results });
}
