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
import { triggerMlTraining } from '@/lib/ml-invoke';

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

  // Phase M3.5 (2026-05-14): inline fetch migrated to triggerMlTraining
  // helper. Helper handles env-var check (returns status='not_configured'
  // when missing — we map that to HTTP 503 to preserve the prior contract).
  const result = await triggerMlTraining(body.propertyId, 'inventory-rate', {
    requestId, itemId: body.itemId as string | undefined, timeoutMs: 55_000,
  });
  if (result.status === 'not_configured') {
    log.warn('ml-inventory-retrain: ML service not configured', { requestId });
    return NextResponse.json({
      ok: false,
      error: 'ml_service_not_configured',
      requestId,
    }, { status: 503 });
  }
  log.info('ml-inventory-retrain: result', {
    requestId,
    property_id: body.propertyId,
    item_id: body.itemId ?? null,
    mlStatus: result.http,
  });
  if (!result.ok) {
    log.error('ml-inventory-retrain: ML service call failed', {
      requestId, err: errToString(result.error ?? `HTTP ${result.http}`),
    });
    return NextResponse.json({
      ok: false,
      error: result.error ?? `HTTP ${result.http}`,
      requestId,
    }, { status: 502 });
  }
  return NextResponse.json({ ok: true, requestId, result: result.detail ?? {} }, { status: 200 });
}
