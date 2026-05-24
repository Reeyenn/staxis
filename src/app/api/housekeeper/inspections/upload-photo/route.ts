/**
 * POST /api/housekeeper/inspections/upload-photo
 *
 * Public mirror of /api/housekeeping/inspections/upload-photo for the
 * mobile InspectorView. Validates pid + staffId + can_inspect.
 *
 * Body: multipart/form-data with
 *   file        — image (jpeg / png / webp), <= 5 MB
 *   inspection  — inspection id
 *   item        — checklist item id
 *   pid         — property id
 *   staffId     — inspector staff id
 */

import { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getInspectionById, staffCanInspect } from '@/lib/db/inspections';
import { validateUuid } from '@/lib/api-validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BYTES = 5 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

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
  const pid = form.get('pid');
  const staffId = form.get('staffId');

  if (!(file instanceof File)) {
    return err('file is required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const inspV = validateUuid(inspectionId, 'inspection');
  if (inspV.error) {
    return err(inspV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (typeof itemId !== 'string' || !itemId) {
    return err('item id is required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const pidV = validateUuid(pid, 'pid');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const staffV = validateUuid(staffId, 'staffId');
  if (staffV.error) {
    return err(staffV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const inspectionIdSafe = inspV.value!;
  const pidSafe = pidV.value!;
  const staffIdSafe = staffV.value!;
  if (file.size > MAX_BYTES) {
    return err('file too large (max 5 MB)', { requestId, status: 413, code: ApiErrorCode.ValidationFailed });
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return err('file must be image/jpeg, image/png, or image/webp', {
      requestId, status: 415, code: ApiErrorCode.ValidationFailed,
    });
  }

  const canInspect = await staffCanInspect(pidSafe, staffIdSafe);
  if (!canInspect) {
    return err('forbidden — not an inspector', {
      requestId, status: 403, code: ApiErrorCode.Forbidden,
    });
  }

  try {
    const inspection = await getInspectionById(inspectionIdSafe);
    if (!inspection || inspection.propertyId !== pidSafe) {
      return err('Inspection not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    }

    const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
    const safeItem = itemId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    const path = `${pidSafe}/${inspection.id}/${safeItem}-${Date.now()}.${ext}`;

    const bytes = new Uint8Array(await file.arrayBuffer());
    const { error: uploadErr } = await supabaseAdmin.storage
      .from('inspection-photos')
      .upload(path, bytes, { contentType: file.type, upsert: false });
    if (uploadErr) {
      log.error('[housekeeper/inspections/upload-photo] upload failed', {
        requestId, path, msg: uploadErr.message,
      });
      return err('Photo upload failed', { requestId, status: 502, code: ApiErrorCode.UpstreamFailure });
    }

    const { data: signed, error: signErr } = await supabaseAdmin.storage
      .from('inspection-photos')
      .createSignedUrl(path, 60 * 60 * 24 * 7);

    if (signErr || !signed?.signedUrl) {
      log.error('[housekeeper/inspections/upload-photo] sign failed', {
        requestId, path, msg: signErr?.message,
      });
      return err('Photo URL signing failed', {
        requestId, status: 502, code: ApiErrorCode.UpstreamFailure,
      });
    }

    return ok({ url: signed.signedUrl, path }, { requestId, status: 201 });
  } catch (e: unknown) {
    log.error('[housekeeper/inspections/upload-photo] failed', {
      requestId, msg: errToString(e),
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
