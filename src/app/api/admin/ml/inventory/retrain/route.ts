/**
 * POST /api/admin/ml/inventory/retrain
 *
 * Manual trigger from the ML cockpit's Inventory tab → ManualTriggers panel.
 * Forwards to the Railway ml-service `/train/inventory-rate` endpoint.
 *
 * Body: { propertyId: uuid, itemId?: uuid }
 *   - itemId omitted → train every item in the property
 *   - itemId supplied → train just that one item
 *
 * Auth: requireAdmin (session + accounts.role='admin'). The cockpit page is
 * already owner-gated so this is belt-and-suspenders. We don't want a
 * non-admin signed-in user to be able to trigger arbitrary training jobs.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: { propertyId?: unknown; itemId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }
  if (!isUuid(body.propertyId)) {
    return NextResponse.json({ ok: false, error: 'invalid_property_id' }, { status: 400 });
  }
  if (body.itemId !== undefined && body.itemId !== null && !isUuid(body.itemId)) {
    return NextResponse.json({ ok: false, error: 'invalid_item_id' }, { status: 400 });
  }

  const mlServiceUrl = process.env.ML_SERVICE_URL;
  const mlServiceSecret = process.env.ML_SERVICE_SECRET;
  if (!mlServiceUrl || !mlServiceSecret) {
    log.warn('ml-inventory-retrain: ML_SERVICE_URL or ML_SERVICE_SECRET missing', { requestId });
    return NextResponse.json({
      ok: false,
      error: 'ml_service_not_configured',
      requestId,
    }, { status: 503 });
  }

  try {
    const res = await fetch(`${mlServiceUrl.replace(/\/$/, '')}/train/inventory-rate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mlServiceSecret}`,
        'Content-Type': 'application/json',
        'x-request-id': requestId,
      },
      body: JSON.stringify({
        property_id: body.propertyId,
        item_id: body.itemId ?? null,
      }),
      signal: AbortSignal.timeout(55_000),
    });
    const json = await res.json().catch(() => ({ error: 'non_json_response', http: res.status }));
    log.info('ml-inventory-retrain: result', {
      requestId,
      property_id: body.propertyId,
      item_id: body.itemId ?? null,
      mlStatus: res.status,
    });
    return NextResponse.json({ ok: true, requestId, result: json }, { status: 200 });
  } catch (e) {
    log.error('ml-inventory-retrain: ML service call failed', { requestId, err: e as Error });
    return NextResponse.json({ ok: false, error: errToString(e), requestId }, { status: 502 });
  }
}
