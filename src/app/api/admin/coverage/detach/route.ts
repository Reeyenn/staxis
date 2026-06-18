/**
 * POST /api/admin/coverage/detach
 *   body: { pmsFamily: string }
 *   → { ok, data: { detachedCount: number } }
 *
 * feature/cua-coverage-mgmt — DETACH every hotel from a PMS family without
 * losing the learned coverage. For every property currently on the family:
 *   - property_sessions.status = 'stopped'   (the supervisor's existing
 *     terminal state — it prunes that driver, stops polling; other families /
 *     hotels are unaffected),
 *   - properties.pms_type = NULL              ("no system detected").
 *
 * NEVER touches pms_knowledge_files — the coverage (the learned recipe) is
 * preserved, so re-matching a hotel later is free (no re-learn). This is the
 * key difference from a delete: detach is reversible via /assign.
 *
 * Idempotent: a family with no hotels on it returns detachedCount=0, 200.
 *
 * Auth: requireAdmin. supabaseAdmin (service-role; both tables are
 * deny-all-browser RLS).
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

  // Every property currently on this family — by pms_type (the assignment of
  // record). property_sessions rows may lag, so source the hotel list from
  // properties and stop their sessions too.
  const { data: propRows, error: propErr } = await supabaseAdmin
    .from('properties')
    .select('id')
    .eq('pms_type', pmsFamily);
  if (propErr) {
    return err('could not load hotels on this coverage', { requestId, status: 500, code: ApiErrorCode.UpstreamFailure });
  }
  const propertyIds = (propRows ?? []).map((p) => (p as { id: string }).id);

  // Stop every session on the family (covers any session whose property may
  // have already been re-pointed but still has a live driver). The supervisor
  // honors 'stopped' by pruning that driver.
  const { error: sessErr } = await supabaseAdmin
    .from('property_sessions')
    .update({ status: 'stopped', updated_at: new Date().toISOString() })
    .eq('pms_family', pmsFamily);
  if (sessErr) {
    return err('could not stop the coverage sessions', { requestId, status: 500, code: ApiErrorCode.UpstreamFailure });
  }

  // Clear pms_type on every hotel on the family ("no system detected").
  if (propertyIds.length > 0) {
    const { error: clearErr } = await supabaseAdmin
      .from('properties')
      .update({ pms_type: null })
      .eq('pms_type', pmsFamily);
    if (clearErr) {
      return err('could not detach the hotels', { requestId, status: 500, code: ApiErrorCode.UpstreamFailure });
    }
  }

  return ok({ detachedCount: propertyIds.length }, { requestId });
}
