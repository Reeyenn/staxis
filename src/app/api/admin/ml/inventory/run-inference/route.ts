/**
 * POST /api/admin/ml/inventory/run-inference
 *
 * Manual trigger from the ML cockpit's Inventory tab. Forwards to the
 * Railway ml-service `/predict/inventory-rate` endpoint to refresh
 * inventory_rate_predictions for tomorrow.
 *
 * Body: { propertyId: uuid, date?: 'YYYY-MM-DD' }
 *
 * Auth: requireAdmin.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { getOrMintRequestId, log } from '@/lib/log';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getPropertyOpsConfig } from '@/lib/property-config';
import { resolveMlShardUrl } from '@/lib/ml-routing';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const isDateStr = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: { propertyId?: unknown; date?: unknown };
  try {
    body = await req.json();
  } catch {
    return err('invalid_json', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (!isUuid(body.propertyId)) {
    return err('invalid_property_id', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (body.date !== undefined && body.date !== null && !isDateStr(body.date)) {
    return err('invalid_date', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const mlServiceUrl = resolveMlShardUrl(body.propertyId);
  const mlServiceSecret = env.ML_SERVICE_SECRET;
  if (!mlServiceUrl || !mlServiceSecret) {
    return err('ml_service_not_configured', { requestId, status: 503, code: ApiErrorCode.UpstreamFailure });
  }

  // Resolve property TZ so the ML service computes "tomorrow" in the
  // property's local clock, not Texas time.
  const ops = await getPropertyOpsConfig(body.propertyId);

  try {
    const res = await fetch(`${mlServiceUrl.replace(/\/$/, '')}/predict/inventory-rate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mlServiceSecret}`,
        'Content-Type': 'application/json',
        'x-request-id': requestId,
      },
      body: JSON.stringify({
        property_id: body.propertyId,
        date: body.date ?? null,
        property_timezone: ops.timezone,
      }),
      signal: AbortSignal.timeout(55_000),
    });
    const json = await res.json().catch(() => ({ error: 'non_json_response', http: res.status }));
    return ok({ result: json }, { requestId });
  } catch (e) {
    log.error('ml-inventory-run-inference: ML service call failed', { requestId, err: e as Error });
    return err('upstream_ml_service_failed', { requestId, status: 502, code: ApiErrorCode.UpstreamFailure });
  }
}
