// ─── Admin API: restore an archived conversation ────────────────────────
// POST /api/admin/agent/conversations/[id]/restore
// Moves a conversation + its messages from *_archived tables back to
// the hot tables. Atomic under per-conversation advisory lock.
//
// Longevity L4 part A, 2026-05-13.

import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { restoreConversation } from '@/lib/agent/archival';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!id) {
    return err('id required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  try {
    const messageCount = await restoreConversation(id);
    if (messageCount < 0) {
      return err('conversation not in archive (may have already been restored)', {
        requestId, status: 404, code: ApiErrorCode.NotFound,
      });
    }
    return ok({ id, messageCount }, { requestId });
  } catch (e) {
    return err(`restore failed: ${e instanceof Error ? e.message : String(e)}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
