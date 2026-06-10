/**
 * POST /api/admin/live-mapper/delete   body: { id }
 *
 * Admin-only. PERMANENTLY removes a map row. Hard safety rule: the LIVE
 * (active) map can NEVER be deleted here — a 409 sends the admin to deprecate
 * it first. That makes it impossible for a single misclick to leave a PMS
 * family with no map and no history. Drafts, deprecated (retired), and
 * quarantined maps are deletable.
 *
 * The UI fires this only after an explicit confirm dialog that names the brand
 * + version; this route is the server-side backstop.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: { id?: unknown; expectedVersion?: unknown; expectedStatus?: unknown };
  try {
    body = await req.json();
  } catch {
    return err('Invalid JSON', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const idCheck = validateUuid(body.id, 'map id');
  if (idCheck.error || !idCheck.value) {
    return err(idCheck.error ?? 'map id is required', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  const id = idCheck.value;

  if (typeof body.expectedVersion !== 'number' || !Number.isInteger(body.expectedVersion)) {
    return err('expectedVersion is required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (typeof body.expectedStatus !== 'string') {
    return err('expectedStatus is required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const expectedVersion = body.expectedVersion;
  const expectedStatus = body.expectedStatus;

  const { data: target, error: readErr } = await supabaseAdmin
    .from('pms_knowledge_files')
    .select('id, pms_family, version, status')
    .eq('id', id)
    .maybeSingle();

  if (readErr) {
    return err(`Could not read map: ${readErr.message}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
  if (!target) {
    return err('Map not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }
  // Stale-UI / wrong-id guard: the row must still be exactly what the admin saw.
  if (target.version !== expectedVersion || target.status !== expectedStatus) {
    return err('This map changed since you opened it. Refresh and try again.', {
      requestId, status: 409, code: ApiErrorCode.ValidationFailed,
    });
  }
  if (target.status === 'active') {
    return err('The live map can’t be deleted. Take it offline first, then delete it.', {
      requestId, status: 409, code: ApiErrorCode.ValidationFailed,
    });
  }

  // Guard the delete on the EXACT status the admin confirmed (expectedStatus is
  // non-active — enforced by the pre-check above), so the freshness check is
  // atomic with the write: if the row changed at all (e.g. a concurrent promote
  // flipped it to active) this matches 0 rows and returns 409 instead.
  const { data: deleted, error: delErr } = await supabaseAdmin
    .from('pms_knowledge_files')
    .delete()
    .eq('id', id)
    .eq('status', expectedStatus)
    .select('id, pms_family, version, status')
    .maybeSingle();

  if (delErr) {
    return err(`Could not delete the map: ${delErr.message}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
  if (!deleted) {
    // Either it was promoted to active between read and delete, or already gone.
    return err('The map changed before it could be deleted. Please refresh and retry.', {
      requestId, status: 409, code: ApiErrorCode.ValidationFailed,
    });
  }

  log.info('live-mapper: deleted map', {
    requestId, id, family: deleted.pms_family, version: deleted.version,
    prevStatus: target.status, by: auth.email ?? auth.userId,
  });

  return ok({ deleted: { id: deleted.id, pmsFamily: deleted.pms_family, version: deleted.version } }, { requestId });
}
