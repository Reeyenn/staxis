/**
 * GET /api/admin/mapper/live/[jobId]/frame
 *
 * feature/cua-live-view — the Learning Board's continuous live view.
 *
 * While a mapping job runs, cua-service tees every vision screenshot the
 * mapper already takes (privacy-hardened by screenshot-privacy.ts — see
 * cua-service/src/live-frame.ts PRIVACY CONTRACT) into ONE overwritten
 * object per job: `mapping-screenshots/{jobId}/live.png`, but only while
 * an admin heartbeat is fresh. This route is the read side: the board
 * calls it on mount, on every `live_frame` broadcast, and from its slow
 * safety poll.
 *
 * Deliberately separate from the sibling `../route.ts` (4 DB queries) so
 * the per-frame refresh stays cheap: zero DB queries, two storage REST
 * calls (exact-path info() + signed URL).
 *
 * Response: { frame: null } when no live frame exists (job not running,
 * robot not uploading, or already cleaned up), else
 * { frame: { url, updatedAt } } — url is a short-lived signed URL (the
 * bucket is private; the browser can't read object keys directly), signed
 * with a cacheNonce derived from the object VERSION so the storage CDN
 * can never serve a stale frame for the overwritten key. 120s expiry is
 * deliberate: the key's content changes continuously, so a leaked URL
 * would be a moving picture — the board re-mints on every refresh anyway.
 *
 * Auth: requireAdmin (same as the sibling live route).
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const admin = await requireAdmin(req);
  if (!admin.ok) {
    return err('Unauthorized', { requestId, status: 401, code: 'unauthorized' });
  }
  const { jobId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) {
    return err('jobId must be a uuid', { requestId, status: 400, code: 'bad_request' });
  }

  const objectKey = `${jobId}/live.png`;

  // Exact-path existence + freshness lookup. info() (not list({search}))
  // on purpose: list's `search` is a substring filter and could match a
  // future help screenshot whose sanitized name ends in "live.png".
  const { data: meta, error: infoErr } = await supabaseAdmin.storage
    .from('mapping-screenshots')
    .info(objectKey);
  if (infoErr || !meta) {
    // Not-found is the NORMAL idle state (no frame uploaded yet, or the
    // job ended and cleanup removed it) — not an error for the board.
    return ok({ frame: null }, { requestId });
  }

  // `lastModified` replaces the deprecated `updatedAt` in FileObjectV2;
  // keep the fallback chain for older storage backends.
  const updatedAt = meta.lastModified ?? meta.updatedAt ?? meta.createdAt ?? null;
  // The object version changes on every overwrite — the SDK appends it as
  // a cache-busting query param INSIDE the signed payload, so each new
  // frame gets a distinct CDN cache key even within the same second.
  const cacheNonce = meta.version ?? updatedAt ?? undefined;

  const { data: signed, error: signErr } = await supabaseAdmin.storage
    .from('mapping-screenshots')
    .createSignedUrl(objectKey, 120, cacheNonce ? { cacheNonce } : undefined);
  if (signErr || !signed?.signedUrl) {
    return err(`live frame sign failed: ${signErr?.message ?? 'no url'}`, {
      requestId, status: 500, code: 'storage_error',
    });
  }

  return ok({
    frame: { url: signed.signedUrl, updatedAt },
  }, { requestId });
}
