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

// feature/cua-assist-board — 'takeover' is live: the admin clicks a spot on
// the help screenshot, we store responseCoordinate, and the mapper executes
// that click via executeVisionAction (recorded as a recipe step) before
// re-entering its loop. Coordinate is validated against the pending row's
// capture viewport below — keep that rule in sync with the robot-side
// validateSupervisorCoordinate (cua-service/src/mapper.ts).
const VALID_ACTIONS = new Set(['guidance', 'unavailable', 'takeover', 'abort'] as const);
type AssistAction = 'guidance' | 'unavailable' | 'takeover' | 'abort';

/**
 * Pure validation gate (unit-tested in
 * src/lib/__tests__/mapper-assist-takeover.test.ts). Everything except the
 * viewport BOUNDS check, which needs the pending row's stored capture size
 * — that's validateCoordinateBounds below, applied after the row fetch.
 */
export function validateAssistBody(body: unknown):
  | {
      ok: true;
      requestId: string;
      actionType: AssistAction;
      responseText: string | null;
      coordinate: { x: number; y: number } | null;
      screenshotPath: string | null;
    }
  | { ok: false; reason: string } {
  const b = body as {
    requestId?: unknown;
    actionType?: unknown;
    responseText?: unknown;
    responseCoordinate?: unknown;
    screenshotPath?: unknown;
  } | null;
  if (!b || typeof b !== 'object') return { ok: false, reason: 'body must be a JSON object' };
  if (typeof b.requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(b.requestId)) {
    return { ok: false, reason: 'requestId must be a uuid' };
  }
  if (typeof b.actionType !== 'string' || !VALID_ACTIONS.has(b.actionType as AssistAction)) {
    return { ok: false, reason: `actionType must be one of: ${[...VALID_ACTIONS].join(', ')}` };
  }
  const actionType = b.actionType as AssistAction;
  const responseText =
    typeof b.responseText === 'string' && b.responseText.trim().length > 0
      ? b.responseText
      : null;
  if ((actionType === 'guidance' || actionType === 'unavailable') && responseText === null) {
    return { ok: false, reason: 'responseText is required for guidance / unavailable' };
  }
  let coordinate: { x: number; y: number } | null = null;
  let screenshotPath: string | null = null;
  if (actionType === 'takeover') {
    const c = b.responseCoordinate as { x?: unknown; y?: unknown } | null | undefined;
    if (!c || typeof c !== 'object' || typeof c.x !== 'number' || typeof c.y !== 'number' ||
        !Number.isFinite(c.x) || !Number.isFinite(c.y)) {
      return { ok: false, reason: 'takeover requires responseCoordinate {x, y} (numbers)' };
    }
    coordinate = { x: c.x, y: c.y };
    // Staleness arbiter: the click was chosen against a specific screenshot.
    // The robot can refresh the row's screenshot in place (worker restart),
    // so the UPDATE below only commits while the row still points at the
    // frame the founder actually clicked.
    if (typeof b.screenshotPath !== 'string' || b.screenshotPath.trim().length === 0) {
      return { ok: false, reason: 'takeover requires screenshotPath (the screenshot the click was chosen on)' };
    }
    screenshotPath = b.screenshotPath;
  }
  return { ok: true, requestId: b.requestId, actionType, responseText, coordinate, screenshotPath };
}

/**
 * Round and bounds-check a takeover coordinate against the screenshot's
 * capture viewport. Click coords are viewport CSS pixels (the screenshot
 * was a viewport-sized, fullPage:false capture). Null = out of bounds.
 */
export function validateCoordinateBounds(
  c: { x: number; y: number },
  viewportW: number,
  viewportH: number,
): { x: number; y: number } | null {
  const x = Math.round(c.x);
  const y = Math.round(c.y);
  if (x < 0 || x >= viewportW || y < 0 || y >= viewportH) return null;
  return { x, y };
}

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
