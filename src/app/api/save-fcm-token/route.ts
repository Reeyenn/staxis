import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';

/**
 * POST /api/save-fcm-token — stamp the staff member's `last_paired_at`.
 *
 * Naming history: this route was the FCM web-push token saver during the
 * Firebase era. FCM was retired on 2026-04-22 (housekeepers receive Twilio
 * SMS now). The route name stuck because the housekeeper / laundry mobile
 * pages still POST to it from previous-generation client bundles, and we
 * want a single endpoint for "the staff member just opened their link".
 *
 * What it does now:
 *   - Verifies the (pid, staffId) capability tuple — staffId must belong
 *     to a staff row whose property_id matches pid.
 *   - Sets staff.last_paired_at = now() so the manager's roster view can
 *     spot housekeepers who never opened their device.
 *
 * Authentication: this is an UNAUTHENTICATED route. The mobile flows are
 * accessed via a magic-link URL (uid + pid + staffId in query string). The
 * presence of the staffId tied to a real staff row is the capability check;
 * no JWT required. We use the service-role client to bypass RLS because the
 * caller has no Supabase session.
 *
 * The original route returned 410 Gone after the FCM removal. That broke
 * the manager's "last paired" signal silently — the frontend's .catch
 * swallowed the 410 and the timestamp never updated. Replaced with a real
 * implementation 2026-04-27.
 */
export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err('invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (typeof body !== 'object' || body === null) {
    return err('body must be an object', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const { pid, staffId } = body as { uid?: unknown; pid?: unknown; staffId?: unknown };

  if (typeof pid !== 'string' || pid.length < 8) {
    return err('pid required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (typeof staffId !== 'string' || staffId.length < 8) {
    return err('staffId required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  // Verify the staff row exists AND belongs to the claimed property. This
  // is the capability check — without it, anyone with a guess at a staff
  // UUID could touch any property.
  const { data: staffRow, error: lookupErr } = await supabaseAdmin
    .from('staff')
    .select('id, property_id')
    .eq('id', staffId)
    .maybeSingle();
  if (lookupErr) {
    log.error('[save-fcm-token] staff lookup failed', { err: lookupErr, requestId });
    return err('internal error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  if (!staffRow) {
    return err('staff not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  if (staffRow.property_id !== pid) {
    // pid in URL doesn't match the staff's actual property — almost
    // certainly a stale magic link. Don't leak whether the staff exists.
    return err('staff not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  const { error: updateErr } = await supabaseAdmin
    .from('staff')
    .update({ last_paired_at: new Date().toISOString() })
    .eq('id', staffId);
  if (updateErr) {
    log.error('[save-fcm-token] update failed', { err: updateErr, requestId });
    return err('internal error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  return ok({ paired: true }, { requestId });
}
