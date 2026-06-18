/**
 * POST /api/admin/coverage/assign
 *   body: { propertyId: string, pmsFamily: string }
 *   → { ok } | 409 { ok:false, code:'no_active_map' }
 *
 * feature/cua-coverage-mgmt — MATCH / SWITCH / PICK: put ONE hotel onto a PMS
 * family's learned coverage. Sets properties.pms_type = pmsFamily and UPSERTs
 * property_sessions(property_id, pms_family, status='starting') so the
 * supervisor boots a driver for it (it boots one driver per session row whose
 * status is in starting/alive/paused_cost_cap).
 *
 * 409 'no_active_map' guard: refuses if the family has no active
 * pms_knowledge_files row — never strand a hotel on a coverage that doesn't
 * exist (the supervisor would park it paused_no_knowledge_file).
 *
 * Idempotent: re-assigning the same hotel to the same family is a no-op upsert.
 *
 * Auth: requireAdmin. supabaseAdmin (service-role).
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import { isPMSType } from '@/lib/pms/types';
import { assignPropertyToFamily } from '../_assign';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body { propertyId?: unknown; pmsFamily?: unknown }

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);

  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: Body;
  try { body = (await req.json()) as Body; } catch { body = {}; }

  const idCheck = validateUuid(body.propertyId, 'propertyId');
  if (idCheck.error || !idCheck.value) {
    return err(idCheck.error ?? 'propertyId is required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const propertyId = idCheck.value;

  if (!isPMSType(body.pmsFamily) || body.pmsFamily === 'other') {
    return err('pmsFamily must be a known PMS family', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const pmsFamily = body.pmsFamily;

  // 409 if the family has no active coverage — don't strand the hotel.
  const hasMap = await familyHasActiveMap(pmsFamily, requestId);
  if (hasMap !== true) return hasMap; // a NextResponse (404/409/500)

  const assigned = await assignPropertyToFamily(propertyId, pmsFamily);
  if (!assigned.ok) {
    return err(assigned.error, { requestId, status: 500, code: ApiErrorCode.UpstreamFailure });
  }

  return ok({ propertyId, pmsFamily }, { requestId });
}

/**
 * `true` when the family has an active pms_knowledge_files row; otherwise a
 * ready-to-return error Response (409 no_active_map / 500 db error).
 */
async function familyHasActiveMap(pmsFamily: string, requestId: string): Promise<true | Response> {
  const { data, error } = await supabaseAdmin
    .from('pms_knowledge_files')
    .select('id')
    .eq('pms_family', pmsFamily)
    .eq('status', 'active')
    .maybeSingle();
  if (error) {
    return err('could not check coverage', { requestId, status: 500, code: ApiErrorCode.UpstreamFailure });
  }
  if (!data) {
    return err(`No learned coverage for ${pmsFamily} yet — onboard it once before assigning hotels to it.`, {
      requestId, status: 409, code: 'no_active_map',
    });
  }
  return true;
}
