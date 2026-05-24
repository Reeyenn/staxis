/**
 * POST /api/admin/mapper/assist
 *
 * Plan v8 Phase B chunk 2. Admin submits a response to a pending
 * mapping_help_requests row. cua-service is subscribed via Supabase
 * realtime; flipping status='pending' → 'answered' resumes the mapper
 * (mapper.ts maybeAskAdminBeforeUnavailable helper).
 *
 * Request body:
 *   {
 *     requestId: uuid,           // mapping_help_requests.id
 *     actionType: 'guidance' | 'unavailable' | 'takeover' | 'abort',
 *     responseText?: string,     // required for 'guidance' + 'unavailable'
 *     responseCoordinate?: {     // optional — when admin clicked on the screenshot
 *       x: number, y: number, dpr?: number, hashOfRegion?: string,
 *     },
 *   }
 *
 * Auth: requireAdmin. Captures admin_user_id from the bearer token's sub
 * claim so the row records who answered (audit trail).
 *
 * Idempotency: UPDATE WHERE status='pending' AND ... — racing answers
 * lose silently (second click no-ops because status already 'answered').
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_ACTIONS = new Set(['guidance', 'unavailable', 'takeover', 'abort']);

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const admin = await requireAdmin(req);
  if (!admin.ok) {
    return err('Unauthorized', { requestId, status: 401, code: 'unauthorized' });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err('Invalid JSON', { requestId, status: 400, code: 'bad_request' });
  }
  const b = body as {
    requestId?: unknown;
    actionType?: unknown;
    responseText?: unknown;
    responseCoordinate?: unknown;
  };
  if (typeof b.requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(b.requestId)) {
    return err('requestId must be a uuid', { requestId, status: 400, code: 'bad_request' });
  }
  if (typeof b.actionType !== 'string' || !VALID_ACTIONS.has(b.actionType)) {
    return err(`actionType must be one of: ${[...VALID_ACTIONS].join(', ')}`, {
      requestId, status: 400, code: 'bad_request',
    });
  }
  if ((b.actionType === 'guidance' || b.actionType === 'unavailable') &&
      (typeof b.responseText !== 'string' || b.responseText.trim().length === 0)) {
    return err('responseText is required for guidance / unavailable', {
      requestId, status: 400, code: 'bad_request',
    });
  }

  const { data, error } = await supabaseAdmin
    .from('mapping_help_requests')
    .update({
      status: 'answered',
      action_type: b.actionType,
      response_text: typeof b.responseText === 'string' ? b.responseText : null,
      response_coordinate: b.responseCoordinate ?? null,
      admin_user_id: admin.accountId,
      answered_at: new Date().toISOString(),
    })
    .eq('id', b.requestId)
    .eq('status', 'pending')  // idempotent — second click no-ops
    .select('id')
    .maybeSingle();

  if (error) {
    return err(`UPDATE failed: ${error.message}`, { requestId, status: 500, code: 'db_error' });
  }
  if (!data) {
    // Either row doesn't exist OR it was already answered (or expired/aborted).
    // Both are non-error cases for the admin — return success with a flag.
    return ok({ accepted: false, reason: 'request_not_pending' }, { requestId });
  }
  return ok({ accepted: true, requestId: data.id }, { requestId });
}
