/**
 * POST /api/front-desk/packages/photo-presign
 *
 * Signed-upload URL for a parcel label photo logged from the front desk.
 * Path: <property_id>/pkg/<scopeKey>/<uuid>.<ext> in the private
 * `package-label-photos` bucket. Mirrors the lost-and-found presign route; the
 * storage call lives in the store so this route never imports supabaseAdmin.
 */

import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { gatePackagesWrite } from '@/lib/packages/api-gate';
import { createLabelUploadUrl } from '@/lib/packages/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

interface Body {
  pid?: string;
  /** Client-generated draft UUID (the photo is taken before the row exists). */
  scopeKey?: string;
  filename?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const gate = await gatePackagesWrite<Body>(req, 'packages-photo-presign');
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

  try {
    const res = await createLabelUploadUrl(pid, scopeKey, safeExt);
    if (!res) {
      return err('Internal server error', {
        requestId,
        status: 500,
        code: ApiErrorCode.InternalError,
      });
    }
    return ok(res, { requestId });
  } catch (caughtErr) {
    log.error('packages photo-presign threw', { requestId, err: errToString(caughtErr) });
    return err('Internal server error', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
}
