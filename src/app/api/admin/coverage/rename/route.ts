/**
 * POST /api/admin/coverage/rename
 *   body: { pmsFamily: string, displayName: string }
 *   → { ok, data: { displayName } }
 *
 * feature/cua-coverage-mgmt — give a LEARNED PMS coverage a friendly name in
 * the admin studio. Writes pms_knowledge_files.display_name on the family's
 * ACTIVE row ONLY.
 *
 * ⚠️ Touches display_name and NOTHING else. The worker HMAC-verifies the
 * `knowledge` jsonb against `signature`; display_name lives outside that
 * envelope (plain metadata, migration 0287), so renaming never invalidates a
 * live recipe. NEVER write the knowledge/signature columns here.
 *
 * Resolves COALESCE(display_name, registry label) is the reader's job
 * (/api/admin/pms-coverage); this route just stores the override.
 *
 * Auth: requireAdmin. supabaseAdmin (service-role; pms_knowledge_files is
 * deny-all-browser RLS).
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { validateString } from '@/lib/api-validate';
import { isPMSType } from '@/lib/pms/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body { pmsFamily?: unknown; displayName?: unknown }

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

  const nameCheck = validateString(body.displayName, { max: 80, min: 1, label: 'displayName' });
  if (nameCheck.error || !nameCheck.value) {
    return err(nameCheck.error ?? 'displayName is required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const displayName = nameCheck.value.trim();
  if (!displayName) {
    return err('displayName cannot be blank', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  // display_name ONLY — never knowledge/signature (it lives OUTSIDE the HMAC
  // envelope, so writing it never invalidates a signed recipe).
  // Prefer the ACTIVE row; if the family has no active map yet (it's a PARKED
  // DRAFT — e.g. Choice Advantage before it's made live), rename the latest
  // non-deleted DRAFT instead, so a draft-only coverage can still be renamed.
  // (The list reader resolves display_name from active-OR-latest-draft to match.)
  const { data: activeUpdated, error } = await supabaseAdmin
    .from('pms_knowledge_files')
    .update({ display_name: displayName })
    .eq('pms_family', pmsFamily)
    .eq('status', 'active')
    .is('deleted_at', null)
    .select('id');
  if (error) {
    return err('could not rename coverage', { requestId, status: 500, code: ApiErrorCode.UpstreamFailure });
  }

  let renamedCount = activeUpdated?.length ?? 0;
  if (renamedCount === 0) {
    // No active map — fall back to the latest parked draft for this family.
    const { data: latestDraft } = await supabaseAdmin
      .from('pms_knowledge_files')
      .select('id')
      .eq('pms_family', pmsFamily)
      .eq('status', 'draft')
      .is('deleted_at', null)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();
    const draftId = (latestDraft as { id?: string } | null)?.id;
    if (draftId) {
      const { data: draftUpdated, error: draftErr } = await supabaseAdmin
        .from('pms_knowledge_files')
        .update({ display_name: displayName })
        .eq('id', draftId)
        .select('id');
      if (draftErr) {
        return err('could not rename coverage', { requestId, status: 500, code: ApiErrorCode.UpstreamFailure });
      }
      renamedCount = draftUpdated?.length ?? 0;
    }
  }

  if (renamedCount === 0) {
    return err(`no coverage for ${pmsFamily} yet — learn or map it first, then rename`, {
      requestId, status: 404, code: ApiErrorCode.NotFound,
    });
  }

  return ok({ displayName }, { requestId });
}
