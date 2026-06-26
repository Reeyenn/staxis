/**
 * POST /api/inventory/ai-mode
 *
 * Sets the property-level AI Helper toggle: 'off' | 'auto' | 'always-on'.
 * Stored in `properties.inventory_ai_mode`. Read by the inventory page to
 * decide whether to use predictions for the reorder list and whether to
 * auto-fill the count input.
 *
 * Body: { propertyId: uuid, mode: 'off' | 'auto' | 'always-on' }
 *
 * Auth: requireSession + userHasPropertyAccess. Only the owner / authorized
 * staff can flip this. (Default is 'auto' on every property; this endpoint
 * is only hit when the user explicitly changes the mode in the AI Helper overlay on /inventory.)
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireOrderingAccess } from '@/lib/ordering/api-gate';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getOrMintRequestId, log } from '@/lib/log';
import { err, ApiErrorCode } from '@/lib/api-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const VALID_MODES = ['off', 'auto', 'always-on'] as const;
type AiMode = typeof VALID_MODES[number];
const isMode = (s: unknown): s is AiMode =>
  typeof s === 'string' && (VALID_MODES as readonly string[]).includes(s);

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);

  let body: { propertyId?: unknown; mode?: unknown };
  try {
    body = await req.json();
  } catch {
    return err('invalid_json', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (!isMode(body.mode)) {
    return err('invalid_mode', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  // Auth: route through the SAME management gate as the other inventory-config
  // endpoints (vendors/catalog/orders) instead of the weaker
  // requireSession + userHasPropertyAccess. Previously ANY property-scoped role
  // could flip the property-wide AI mode; now it honors the
  // manage_inventory_orders capability + per-hotel Access-tab toggle.
  // (Security audit 2026-06-26.)
  const gate = await requireOrderingAccess(
    req,
    typeof body.propertyId === 'string' ? body.propertyId : null,
  );
  if (!gate.ok) return gate.response;
  const pid = gate.pid;

  try {
    const { error } = await supabaseAdmin
      .from('properties')
      .update({ inventory_ai_mode: body.mode })
      .eq('id', pid);
    if (error) {
      log.error('inventory/ai-mode: update failed', { requestId, err: error });
      return err('internal_error', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }
    return NextResponse.json({ ok: true, requestId, data: { mode: body.mode } });
  } catch (e) {
    log.error('inventory/ai-mode: exception', { requestId, err: e });
    return err('internal_error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
