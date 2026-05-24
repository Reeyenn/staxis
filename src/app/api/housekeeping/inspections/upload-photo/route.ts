/**
 * POST /api/housekeeping/inspections/upload-photo
 *
 * Body: multipart/form-data with
 *   file        — image (jpeg / png / webp), <= 5 MB
 *   inspection  — inspection id
 *   item        — checklist item id (used in the storage path)
 *
 * Returns { url } — the signed-or-public URL the client should embed
 * in failed_items[].photoUrl when submitting complete.
 *
 * Photos go to the private `inspection-photos` bucket created by
 * migration 0212. We return a signed URL valid for 7 days so the
 * Inspections tab can render the image without exposing the bucket
 * publicly. The bucket is service-role only at the storage policy
 * level; signing happens here.
 */

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getInspectionById } from '@/lib/db/inspections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BYTES = 5 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireSession(req, { requestId });
  if (!auth.ok) return auth.response;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return err('Invalid multipart body', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  const file = form.get('file');
  const inspectionId = form.get('inspection');
  const itemId = form.get('item');

  if (!(file instanceof File)) {
    return err('file is required', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  if (typeof inspectionId !== 'string' || !inspectionId) {
    return err('inspection id is required', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  if (typeof itemId !== 'string' || !itemId) {
    return err('item id is required', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  if (file.size > MAX_BYTES) {
    return err('file too large (max 5 MB)', {
      requestId, status: 413, code: ApiErrorCode.ValidationFailed,
    });
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return err('file must be image/jpeg, image/png, or image/webp', {
      requestId, status: 415, code: ApiErrorCode.ValidationFailed,
    });
  }

  try {
    const inspection = await getInspectionById(inspectionId);
    if (!inspection) {
      return err('Inspection not found', {
        requestId, status: 404, code: ApiErrorCode.NotFound,
      });
    }

    const hasAccess = await userHasPropertyAccess(auth.userId, inspection.propertyId);
    if (!hasAccess) {
      return err('forbidden — no access to this property', {
        requestId, status: 403, code: ApiErrorCode.Forbidden,
      });
    }

    const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
    const safeItem = itemId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    const path = `${inspection.propertyId}/${inspection.id}/${safeItem}-${Date.now()}.${ext}`;

    const bytes = new Uint8Array(await file.arrayBuffer());
    const { error: uploadErr } = await supabaseAdmin.storage
      .from('inspection-photos')
      .upload(path, bytes, {
        contentType: file.type,
        upsert: false,
      });
    if (uploadErr) {
      log.error('[inspections/upload-photo] storage upload failed', {
        requestId, path, msg: uploadErr.message,
      });
      return err('Photo upload failed', {
        requestId, status: 502, code: ApiErrorCode.UpstreamFailure,
      });
    }

    const { data: signed, error: signErr } = await supabaseAdmin.storage
      .from('inspection-photos')
      .createSignedUrl(path, 60 * 60 * 24 * 7);  // 7 days

    if (signErr || !signed?.signedUrl) {
      log.error('[inspections/upload-photo] sign url failed', {
        requestId, path, msg: signErr?.message,
      });
      return err('Photo URL signing failed', {
        requestId, status: 502, code: ApiErrorCode.UpstreamFailure,
      });
    }

    return ok({ url: signed.signedUrl, path }, { requestId, status: 201 });
  } catch (e: unknown) {
    log.error('[inspections/upload-photo] failed', {
      requestId, msg: errToString(e),
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
