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
import { validateAssistBody, validateCoordinateBounds } from '@/lib/pms/takeover-validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  // Codebase-standard admin gate: requireAdmin already builds the correct
  // response (403 for a non-admin session, requireSession's 401 for no
  // session). Re-minting a flat 401 here masked the 403 and dropped the
  // standard envelope — return its response verbatim instead.
  const admin = await requireAdmin(req);
  if (!admin.ok) return admin.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err('Invalid JSON', { requestId, status: 400, code: 'bad_request' });
  }
  const v = validateAssistBody(body);
  if (!v.ok) {
    return err(v.reason, { requestId, status: 400, code: 'bad_request' });
  }

  // Takeover: bounds-check against the pending row's stored capture
  // viewport so the robot never receives an unclickable point.
  let coordinate: { x: number; y: number } | null = null;
  if (v.actionType === 'takeover' && v.coordinate) {
    const { data: rowData, error: rowErr } = await supabaseAdmin
      .from('mapping_help_requests')
      .select('viewport_w, viewport_h')
      .eq('id', v.requestId)
      .maybeSingle();
    if (rowErr) {
      return err(`help-request lookup failed: ${rowErr.message}`, { requestId, status: 500, code: 'db_error' });
    }
    if (!rowData) {
      return ok({ accepted: false, reason: 'request_not_pending' }, { requestId });
    }
    const w = typeof rowData.viewport_w === 'number' ? rowData.viewport_w : 1280;
    const h = typeof rowData.viewport_h === 'number' ? rowData.viewport_h : 800;
    coordinate = validateCoordinateBounds(v.coordinate, w, h);
    if (!coordinate) {
      return err(`coordinate (${Math.round(v.coordinate.x)}, ${Math.round(v.coordinate.y)}) is outside the ${w}×${h} screenshot`, {
        requestId, status: 400, code: 'bad_request',
      });
    }
  }

  let update = supabaseAdmin
    .from('mapping_help_requests')
    .update({
      status: 'answered',
      action_type: v.actionType,
      response_text: v.responseText ??
        (v.actionType === 'takeover' ? 'Supervisor clicked on the screen' : null),
      response_coordinate: coordinate,
      admin_user_id: admin.accountId,
      answered_at: new Date().toISOString(),
    })
    .eq('id', v.requestId)
    .eq('status', 'pending');  // idempotent — second click no-ops
  if (v.actionType === 'takeover' && v.screenshotPath) {
    // Commit the click only against the exact frame it was chosen on. If
    // the robot refreshed the screenshot since (worker restart), this
    // zero-matches → accepted:false → the UI refreshes to the new frame.
    update = update.eq('screenshot_storage_path', v.screenshotPath);
  }
  const { data, error } = await update.select('id').maybeSingle();

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
