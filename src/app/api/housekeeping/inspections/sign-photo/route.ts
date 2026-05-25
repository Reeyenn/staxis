/**
 * POST /api/housekeeping/inspections/sign-photo
 *
 * Body: { inspectionId: uuid, path: string }
 *
 * Mints a fresh 7-day signed URL for a previously-uploaded inspection
 * photo. Use when an old failed_items entry's photoUrl has expired
 * (>7 days since upload) and the manager opens the inspection detail.
 *
 * Codex M5 post-merge sweep: stored signed URLs in failed_items go 404
 * after 7 days. The fix is to store the canonical storage `path` on
 * each entry and re-sign on read via this route. Older inspection rows
 * may have only the URL — they're stuck unless we backfill paths.
 */

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { validateUuid, validateString } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getInspectionById } from '@/lib/db/inspections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

interface SignBody {
  inspectionId?: unknown;
  path?: unknown;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireSession(req, { requestId });
  if (!auth.ok) return auth.response;

  let body: SignBody;
  try {
    body = (await req.json()) as SignBody;
  } catch {
    return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const idV = validateUuid(body.inspectionId, 'inspectionId');
  if (idV.error) {
    return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const pathV = validateString(body.path, { max: 300, label: 'path' });
  if (pathV.error) {
    return err(pathV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const path = pathV.value!;

  // Defense in depth: refuse anything that looks like a path-traversal
  // attempt or that doesn't start with the inspection's property id.
  if (path.includes('..') || path.startsWith('/')) {
    return err('invalid path', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  try {
    const inspection = await getInspectionById(idV.value!);
    if (!inspection) {
      return err('Inspection not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    }

    const hasAccess = await userHasPropertyAccess(auth.userId, inspection.propertyId);
    if (!hasAccess) {
      return err('forbidden — no access to this property', {
        requestId, status: 403, code: ApiErrorCode.Forbidden,
      });
    }

    // Path must live under <propertyId>/<inspectionId>/... — block any
    // attempt to sign a photo from a different inspection / property.
    const expectedPrefix = `${inspection.propertyId}/${inspection.id}/`;
    if (!path.startsWith(expectedPrefix)) {
      return err('path does not belong to this inspection', {
        requestId, status: 403, code: ApiErrorCode.Forbidden,
      });
    }

    const { data: signed, error: signErr } = await supabaseAdmin.storage
      .from('inspection-photos')
      .createSignedUrl(path, 60 * 60 * 24 * 7);

    if (signErr || !signed?.signedUrl) {
      return err('Photo URL signing failed', {
        requestId, status: 502, code: ApiErrorCode.UpstreamFailure,
      });
    }

    return ok({ url: signed.signedUrl }, { requestId });
  } catch (e: unknown) {
    log.error('[inspections/sign-photo] failed', {
      requestId, msg: errToString(e),
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
