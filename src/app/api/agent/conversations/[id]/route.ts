// ─── GET/DELETE /api/agent/conversations/[id] ──────────────────────────────
// Load the full conversation (messages + metadata), or delete it.

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { loadConversation, deleteConversation } from '@/lib/agent/memory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;

  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('id')
    .eq('data_user_id', auth.userId)
    .maybeSingle();
  if (!account) {
    return err('account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  const { id } = await params;
  try {
    const convo = await loadConversation(id, account.id as string);
    if (!convo) {
      return err('conversation not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    }
    return ok({ conversation: convo }, { requestId });
  } catch (e) {
    log.error('[agent/conversations/get] failed to load', { requestId, id, e });
    return err('failed to load conversation', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
      details: e instanceof Error ? e.message : String(e),
    });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;

  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('id')
    .eq('data_user_id', auth.userId)
    .maybeSingle();
  if (!account) {
    return err('account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  const { id } = await params;
  try {
    const deleted = await deleteConversation(id, account.id as string);
    if (!deleted) {
      return err('conversation not found or not yours', {
        requestId, status: 404, code: ApiErrorCode.NotFound,
      });
    }
    return ok({ deleted: true }, { requestId });
  } catch (e) {
    log.error('[agent/conversations/delete] failed', { requestId, id, e });
    return err('failed to delete conversation', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
      details: e instanceof Error ? e.message : String(e),
    });
  }
}
