// ─── GET/DELETE /api/agent/conversations/[id] ──────────────────────────────
// Load the full conversation (messages + metadata), or delete it.

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
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

  const idV = validateUuid((await params).id, 'id');
  if (idV.error) return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const id = idV.value!;
  try {
    const convo = await loadConversation(id, account.id as string);
    if (!convo) {
      return err('conversation not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    }
    return ok({ conversation: convo }, { requestId });
  } catch (e) {
    // Log the detail server-side; don't echo the raw error to the client.
    log.error('[agent/conversations/get] failed to load', { requestId, id, e });
    return err('failed to load conversation', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
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

  const idV = validateUuid((await params).id, 'id');
  if (idV.error) return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const id = idV.value!;
  try {
    const deleted = await deleteConversation(id, account.id as string);
    if (!deleted) {
      return err('conversation not found or not yours', {
        requestId, status: 404, code: ApiErrorCode.NotFound,
      });
    }
    return ok({ deleted: true }, { requestId });
  } catch (e) {
    // Log the detail server-side; don't echo the raw error to the client.
    log.error('[agent/conversations/delete] failed', { requestId, id, e });
    return err('failed to delete conversation', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
