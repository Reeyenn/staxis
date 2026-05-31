/**
 * POST /api/front-desk/lost-and-found/photo-presign
 *
 * Signed-upload URL for a found-item photo logged from the front desk.
 * Path: <property_id>/fd/<scopeKey>/<uuid>.<ext> in the private
 * `lost-found-item-photos` bucket. Mirrors the housekeeper presign route.
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { gateFrontDeskWrite } from '@/lib/lost-and-found/api-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

const BUCKET = 'lost-found-item-photos';

interface Body {
  pid?: string;
  /** Client-generated draft UUID (the photo is taken before the item row
   *  exists). Safe chars only. */
  scopeKey?: string;
  filename?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const gate = await gateFrontDeskWrite<Body>(req, 'lost-found-photo-presign');
  if (!gate.ok) return gate.response;
  const { body, pid, requestId } = gate;

  const scopeKey = typeof body.scopeKey === 'string' ? body.scopeKey : '';
  if (!scopeKey || scopeKey.length > 100 || !/^[A-Za-z0-9_-]+$/.test(scopeKey)) {
    return err('invalid scopeKey', {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }

  const ext = (body.filename?.split('.').pop() ?? 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
  const allowedExt = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']);
  const safeExt = allowedExt.has(ext) ? ext : 'jpg';

  const photoKey = `${pid}/fd/${scopeKey}/${crypto.randomUUID()}.${safeExt}`;

  try {
    const { data, error: presignErr } = await supabaseAdmin.storage
      .from(BUCKET)
      .createSignedUploadUrl(photoKey);
    if (presignErr || !data) {
      log.error('lost-found fd photo-presign failed', {
        requestId,
        err: errToString(presignErr ?? 'no url'),
      });
      return err('Internal server error', {
        requestId,
        status: 500,
        code: ApiErrorCode.InternalError,
      });
    }
    return ok({ path: photoKey, signedUrl: data.signedUrl, token: data.token }, { requestId });
  } catch (caughtErr) {
    log.error('lost-found fd photo-presign threw', { requestId, err: errToString(caughtErr) });
    return err('Internal server error', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
}
