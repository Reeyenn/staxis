// ─── Admin API: list archived conversations ──────────────────────────────
// Read-only. Used by the future archive browser UI; for now it's
// available so an operator can curl the endpoint and confirm what's
// in archived storage.
//
// Longevity L4 part A, 2026-05-13.

import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { listRecentlyArchived } from '@/lib/agent/archival';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  try {
    const conversations = await listRecentlyArchived(100);
    return ok({ conversations }, { requestId });
  } catch (e) {
    return err(`list archived failed: ${e instanceof Error ? e.message : String(e)}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
