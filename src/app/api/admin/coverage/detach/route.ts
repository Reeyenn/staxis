/**
 * POST /api/admin/coverage/detach
 *   body: { pmsFamily: string, propertyId?: string }
 *   → { ok, data: { detachedCount: number } }
 *
 * feature/cua-coverage-mgmt — DETACH hotels from a PMS family without losing
 * the learned coverage.
 *   - With `propertyId`: detach ONLY that hotel (the per-hotel detach buttons
 *     on Live Hotels + the PMS coverage modal's hotel list). Scoped with an
 *     `eq(pms_type, family)` guard so it only acts if the hotel is actually on
 *     this family (idempotent, never cross-detaches).
 *   - Without it: detach EVERY hotel on the family ("free the hotels").
 *
 * For every property detached:
 *   - property_sessions.status = 'stopped'   (the supervisor's existing
 *     terminal state — it prunes that driver, stops polling; other families /
 *     hotels are unaffected),
 *   - properties.pms_type = NULL              ("no system detected").
 *
 * NEVER touches pms_knowledge_files — the coverage (the learned recipe) is
 * preserved, so re-matching a hotel later is free (no re-learn). This is the
 * key difference from /delete: detach is reversible via /assign.
 *
 * Idempotent: a family/hotel with nothing to detach returns detachedCount=0, 200.
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Body { pmsFamily?: unknown; propertyId?: unknown }

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

  const wantsSingle = body.propertyId !== undefined && body.propertyId !== null;
  if (wantsSingle && (typeof body.propertyId !== 'string' || !UUID_RE.test(body.propertyId))) {
    return err('propertyId must be a UUID', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  // ─── Per-hotel detach ───────────────────────────────────────────────────
  if (wantsSingle) {
    const propertyId = body.propertyId as string;

    // Stop that hotel's session for this family.
    const { error: sessErr } = await supabaseAdmin
      .from('property_sessions')
      .update({ status: 'stopped', updated_at: new Date().toISOString() })
      .eq('property_id', propertyId)
      .eq('pms_family', pmsFamily);
    if (sessErr) {
      return err('could not stop the session', { requestId, status: 500, code: ApiErrorCode.UpstreamFailure });
    }

    // Clear pms_type, but ONLY if the hotel is actually on this family.
    const { data: cleared, error: clearErr } = await supabaseAdmin
      .from('properties')
      .update({ pms_type: null })
      .eq('id', propertyId)
      .eq('pms_type', pmsFamily)
      .select('id');
    if (clearErr) {
      return err('could not detach the hotel', { requestId, status: 500, code: ApiErrorCode.UpstreamFailure });
    }
    return ok({ detachedCount: (cleared ?? []).length }, { requestId });
  }

  // ─── Detach EVERY hotel on the family ───────────────────────────────────
  // by pms_type (the assignment of record). property_sessions rows may lag, so
  // source the hotel list from properties and stop their sessions too.
  const { data: propRows, error: propErr } = await supabaseAdmin
    .from('properties')
    .select('id')
    .eq('pms_type', pmsFamily);
  if (propErr) {
    return err('could not load hotels on this coverage', { requestId, status: 500, code: ApiErrorCode.UpstreamFailure });
  }
  const propertyIds = (propRows ?? []).map((p) => (p as { id: string }).id);

  // Stop every session on the family (covers any session whose property may
  // have already been re-pointed but still has a live driver).
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
