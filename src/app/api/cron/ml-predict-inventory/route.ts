/**
 * GET /api/cron/ml-predict-inventory
 *
 * Daily cron (06:00 CT, +30min after the housekeeping demand inference) that
 * generates inventory_rate predictions for tomorrow for every active property.
 * One prediction row per (property × item) with an active model.
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
    log.warn('ml-predict-inventory: ML_SERVICE_URL or ML_SERVICE_SECRET missing', { requestId });
    return NextResponse.json({
      ok: true,
      skipped: 'ML service not configured yet',
      requestId,
    });
  }

  // Pull `timezone` so each property's "tomorrow" is computed against its
  // own local clock (a Florida hotel must not predict a Texas-timed date).
  const { data: properties, error } = await supabaseAdmin
    .from('properties')
    .select('id, name, timezone, inventory_ai_mode');
  if (error) {
    return NextResponse.json({ ok: false, error: errToString(error), requestId }, { status: 500 });
  }

  const results: Array<{ property_id: string; status: string; detail?: unknown }> = [];
  for (const property of properties ?? []) {
    if ((property as { inventory_ai_mode?: string }).inventory_ai_mode === 'off') {
      results.push({ property_id: property.id, status: 'skipped_ai_off' });
      continue;
    }
    const propertyTz = (property.timezone as string | null) ?? 'America/Chicago';
    try {
      const res = await fetch(`${mlServiceUrl.replace(/\/$/, '')}/predict/inventory-rate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${mlServiceSecret}`,
          'Content-Type': 'application/json',
          'x-request-id': requestId,
        },
        body: JSON.stringify({ property_id: property.id, property_timezone: propertyTz }),
        signal: AbortSignal.timeout(75_000),
      });
      const json = await res.json().catch(() => ({ error: 'non_json_response', http: res.status }));
      log.info('ml-predict-inventory: result', {
        requestId,
        property_id: property.id,
        predicted: (json as { predicted?: number }).predicted ?? null,
      });
      results.push({ property_id: property.id, status: 'ok', detail: json });
    } catch (e) {
      log.error('ml-predict-inventory: ML service call failed', {
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
