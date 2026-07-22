/**
 * POST /api/admin/coverage/bulk-assign
 *   body: { pmsFamily: string, propertyIds?: string[] }
 *   → { ok, data: { appliedCount, failedCount, failed: string[] } } | 409 { code:'no_active_map' }
 *
 * feature/cua-coverage-mgmt — BULK match: put EVERY hotel already on a PMS
 * family back onto its (active) coverage, PLUS any explicitly-passed
 * propertyIds. Same per-hotel write as /assign (set pms_type + upsert
 * property_sessions 'starting'); used after a re-learn or to (re)start a whole
 * family's drivers at once.
 *
 * 409 'no_active_map' if the family has no active coverage (same guard as
 * /assign — never strand hotels on a non-existent map).
 *
 * Idempotent: re-running with the same set is a no-op series of upserts.
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

interface Body { pmsFamily?: unknown; propertyIds?: unknown }

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

  // Optional explicit ids — UUID-validate each; reject the whole call on a bad one.
  const explicitIds: string[] = [];
  if (body.propertyIds !== undefined) {
    if (!Array.isArray(body.propertyIds)) {
      return err('propertyIds must be an array of UUIDs', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    for (const raw of body.propertyIds) {
      const c = validateUuid(raw, 'propertyIds[]');
      if (c.error || !c.value) {
        return err(c.error ?? 'propertyIds must be UUIDs', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      }
      explicitIds.push(c.value);
    }
  }

  // 409 if the family has no active coverage.
  const { data: activeKf, error: kfErr } = await supabaseAdmin
    .from('pms_knowledge_files')
    .select('id')
    .eq('pms_family', pmsFamily)
    .eq('status', 'active')
    .is('deleted_at', null)
    .maybeSingle();
  if (kfErr) {
    return err('could not check coverage', { requestId, status: 500, code: ApiErrorCode.UpstreamFailure });
  }
  if (!activeKf) {
    return err(`No learned coverage for ${pmsFamily} yet — onboard it once before assigning hotels to it.`, {
      requestId, status: 409, code: 'no_active_map',
    });
  }

  // Everyone already on the family + the explicit ids (de-duped).
  const { data: onFamily, error: propErr } = await supabaseAdmin
    .from('properties')
    .select('id')
    .eq('pms_type', pmsFamily);
  if (propErr) {
    return err('could not load hotels on this coverage', { requestId, status: 500, code: ApiErrorCode.UpstreamFailure });
  }
  const targetIds = new Set<string>([
    ...(onFamily ?? []).map((p) => (p as { id: string }).id),
    ...explicitIds,
  ]);

  let appliedCount = 0;
  const failures: string[] = [];
  for (const id of targetIds) {
    const r = await assignPropertyToFamily(id, pmsFamily);
    if (r.ok) appliedCount += 1;
    else failures.push(id);
  }

  if (failures.length > 0 && appliedCount === 0) {
    return err('could not assign any hotels', { requestId, status: 500, code: ApiErrorCode.UpstreamFailure });
  }

  // Surface partial failures rather than reporting a clean success: a hotel
  // that failed to assign is left assigned-but-not-running, and hiding it here
  // means the admin thinks every hotel is live when some silently aren't.
  return ok({ appliedCount, failedCount: failures.length, failed: failures }, { requestId });
}
