/**
 * POST /api/admin/coverage/delete
 *   body: { pmsFamily: string }
 *   → { ok, data: { deletedFiles: number, detachedCount: number } }
 *
 * feature/coverage-hotel-list-delete — SOFT-delete a learned PMS coverage.
 *
 * Three writes, in safe order:
 *   1. Stamp deleted_at = now() on EVERY pms_knowledge_files row of the family
 *      (all versions) where deleted_at IS NULL → the coverage disappears from
 *      the admin studio + /api/admin/pms-coverage (both filter deleted_at).
 *   2. Stop every session on the family (property_sessions.status = 'stopped').
 *   3. Clear pms_type on every hotel on the family (→ "No system detected").
 *
 * With no hotel assigned, the worker has nothing to poll for the family and
 * stops cleanly — NO cua-service change. The recipe is PRESERVED (deleted_at
 * stamped, never dropped), so a mistaken delete is restorable: clear deleted_at
 * and re-attach the hotels. deleted_at is OUTSIDE the HMAC-signed `knowledge`
 * envelope (0288), so stamping it can't invalidate a recipe signature.
 *
 * Idempotent: an already-deleted / empty family returns zeros, 200.
 *
 * Auth: requireAdmin. supabaseAdmin (service-role; all tables deny-all-browser RLS).
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { isPMSType } from '@/lib/pms/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body { pmsFamily?: unknown }

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: Body;
  try { body = (await req.json()) as Body; } catch { body = {}; }

  if (!isPMSType(body.pmsFamily) || body.pmsFamily === 'other') {
    return err('pmsFamily must be a known PMS family', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const pmsFamily = body.pmsFamily;

  // 1. Soft-delete every (still-live) knowledge file of the family.
  const { data: deletedRows, error: kfErr } = await supabaseAdmin
    .from('pms_knowledge_files')
    .update({ deleted_at: new Date().toISOString() })
    .eq('pms_family', pmsFamily)
    .is('deleted_at', null)
    .select('id');
  if (kfErr) {
    return err('could not delete the coverage', { requestId, status: 500, code: ApiErrorCode.UpstreamFailure });
  }
  const deletedFiles = (deletedRows ?? []).length;

  // 2. Stop every session on the family.
  const { error: sessErr } = await supabaseAdmin
    .from('property_sessions')
    .update({ status: 'stopped', updated_at: new Date().toISOString() })
    .eq('pms_family', pmsFamily);
  if (sessErr) {
    return err('could not stop the coverage sessions', { requestId, status: 500, code: ApiErrorCode.UpstreamFailure });
  }

  // 3. Detach every hotel on the family ("no system detected").
  const { data: cleared, error: clearErr } = await supabaseAdmin
    .from('properties')
    .update({ pms_type: null })
    .eq('pms_type', pmsFamily)
    .select('id');
  if (clearErr) {
    return err('could not detach the hotels', { requestId, status: 500, code: ApiErrorCode.UpstreamFailure });
  }

  return ok({ deletedFiles, detachedCount: (cleared ?? []).length }, { requestId });
}
