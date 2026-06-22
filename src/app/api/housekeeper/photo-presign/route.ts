/**
 * POST /api/housekeeper/photo-presign
 *
 * Returns a short-lived signed-upload URL the housekeeper's phone can
 * PUT a photo to directly. Uses Supabase Storage's createSignedUploadUrl.
 *
 * Path convention: `<property_id>/<scoped-key>/<filename>` where the
 * scoped-key is either the work_order_id (for structured issues) or a
 * client-generated UUID (for "draft" uploads that don't have a work
 * order yet).
 *
 * Photo size is capped via the bucket's allowed_mime_types and
 * file_size_limit (10 MB) — Supabase rejects oversize uploads at the
 * signed-URL layer.
 *
 * KNOWN-OPEN: orphan photos.
 *   The current flow uploads the photo via signed PUT BEFORE the
 *   structured-issue POST completes. If the user closes the modal
 *   after the PUT succeeds but before submit, the photo bytes stay in
 *   the bucket with no work-order reference pointing at them. There's
 *   no automatic cleanup for that path yet.
 *
 *   Mitigation we ship today: the path includes the property_id as the
 *   top folder so a future per-property GC sweep can list-and-prune
 *   safely. Bucket file_size_limit (10MB) bounds the bytes leaked per
 *   abandoned upload. Storage cost is negligible compared to the
 *   complexity of a fully transactional upload flow.
 *
 *   Follow-up (deferred): a nightly cron that lists
 *   `housekeeping-issue-photos/<pid>/<scopeKey>/*` and deletes any
 *   `scopeKey` not referenced by a pms_work_orders_v2.raw->>photo_path.
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
  /** A UUID the client generates. Use the work_order_id once known, or a
   *  client-side draft UUID if the user is attaching a photo before
   *  submitting the issue. */
  scopeKey?: string;
  /** Original filename — only the extension is preserved; the path uses
   *  a UUID to dodge collisions. */
  filename?: string;
}

const BUCKET = 'housekeeping-issue-photos';

export async function POST(req: NextRequest): Promise<Response> {
  const gate = await gateHousekeeperRequest<Body>(req, 'housekeeper-photo-presign');
  if (!gate.ok) return gate.response;
  const body = gate.body;
  // scopeKey is interpolated into the storage path below, so pin it to a safe
  // charset — real clients only ever send a UUID or a draft-<ts> key. This
  // rejects '..' / '/' path-traversal into another hotel's folder. (Audit
  // hardening 2026-06-18.)
  if (!body.scopeKey || !/^[A-Za-z0-9_-]{1,100}$/.test(body.scopeKey)) {
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

  const photoKey = `${gate.pid}/${body.scopeKey}/${crypto.randomUUID()}.${safeExt}`;

  try {
    const { data, error: presignErr } = await supabaseAdmin.storage
      .from(BUCKET)
      .createSignedUploadUrl(photoKey);
    if (presignErr || !data) {
      log.error('photo-presign: createSignedUploadUrl failed', {
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
      {
        path: photoKey,
        signedUrl: data.signedUrl,
        token: data.token,
      },
      { requestId: gate.requestId, headers: gate.headers },
    );
  } catch (caughtErr) {
    log.error('photo-presign: threw', {
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
