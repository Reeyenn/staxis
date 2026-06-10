/**
 * POST /api/admin/live-mapper/deprecate   body: { id }
 *
 * Admin-only. Takes the LIVE map for a PMS family offline (active → deprecated)
 * WITHOUT promoting a replacement. After this the family has NO active map, so
 * every hotel on that brand will pause `paused_no_knowledge_file` until an admin
 * makes another map live. This is the deliberate "turn the robot off for this
 * brand" control — the UI confirms it in plain English first.
 *
 * Only an `active` map can be deprecated here (rolling BACK to a prior version
 * is the promote route's job — promoting a deprecated map auto-deprecates the
 * current active). Touches only `status` + `deprecated_at`; never the
 * `knowledge`/signature columns, so the map's signature stays intact for a
 * later re-promote.
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
  if (target.status !== 'active') {
    return err('Only the live map can be taken offline.', {
      requestId, status: 409, code: ApiErrorCode.ValidationFailed,
    });
  }

  // Guard the update on status='active' too — defends against a concurrent
  // promote/deprecate flipping it between our read and write.
  const { data: updated, error: updErr } = await supabaseAdmin
    .from('pms_knowledge_files')
    .update({ status: 'deprecated', deprecated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'active')
    .select('id, pms_family, version, status')
    .maybeSingle();

  if (updErr) {
    return err(`Could not take the map offline: ${updErr.message}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
  if (!updated) {
    return err('The map changed before it could be taken offline. Please refresh and retry.', {
      requestId, status: 409, code: ApiErrorCode.ValidationFailed,
    });
  }

  log.info('live-mapper: deprecated active map (brand now has no live map)', {
    requestId, id, family: updated.pms_family, version: updated.version,
    by: auth.email ?? auth.userId,
  });

  return ok({ map: updated }, { requestId });
}
