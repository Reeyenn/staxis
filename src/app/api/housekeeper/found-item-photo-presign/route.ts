/**
 * POST /api/housekeeper/found-item-photo-presign
 *
 * Signed-upload URL for a found-item photo taken by a housekeeper on the
 * public SMS-link page. Mirrors /api/housekeeper/photo-presign exactly, but
 * targets the `lost-found-item-photos` bucket.
 *
 * Path: <property_id>/hk/<scopeKey>/<uuid>.<ext>
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { gateHousekeeperRequest } from '@/lib/housekeeper-workflow/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

interface Body {
  pid?: string;
  staffId?: string;
  scopeKey?: string;
  filename?: string;
}

const BUCKET = 'lost-found-item-photos';

export async function POST(req: NextRequest): Promise<Response> {
  const gate = await gateHousekeeperRequest<Body>(req, 'housekeeper-found-item-photo-presign');
  if (!gate.ok) return gate.response;
  const body = gate.body;

  const scopeKey = typeof body.scopeKey === 'string' ? body.scopeKey : '';
  if (!scopeKey || scopeKey.length > 100 || !/^[A-Za-z0-9_-]+$/.test(scopeKey)) {
    return err('invalid scopeKey', {
      requestId: gate.requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
      headers: gate.headers,
    });
  }

  const ext = (body.filename?.split('.').pop() ?? 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
  const allowedExt = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']);
  const safeExt = allowedExt.has(ext) ? ext : 'jpg';

  const photoKey = `${gate.pid}/hk/${scopeKey}/${crypto.randomUUID()}.${safeExt}`;

  try {
    const { data, error: presignErr } = await supabaseAdmin.storage
      .from(BUCKET)
      .createSignedUploadUrl(photoKey);
    if (presignErr || !data) {
      log.error('found-item-photo-presign: createSignedUploadUrl failed', {
        requestId: gate.requestId,
        err: errToString(presignErr ?? 'no url'),
      });
      return err('Internal server error', {
        requestId: gate.requestId,
        status: 500,
        code: ApiErrorCode.InternalError,
        headers: gate.headers,
      });
    }
    return ok(
      { path: photoKey, signedUrl: data.signedUrl, token: data.token },
      { requestId: gate.requestId, headers: gate.headers },
    );
  } catch (caughtErr) {
    log.error('found-item-photo-presign: threw', {
      requestId: gate.requestId,
      err: errToString(caughtErr),
    });
    return err('Internal server error', {
      requestId: gate.requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
      headers: gate.headers,
    });
  }
}
