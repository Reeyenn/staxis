// ─── GET /api/agent/conversations ──────────────────────────────────────────
// Lists the current user's past chat sessions, newest first. Used by the
// chat UI's conversation history sidebar.

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { listConversations } from '@/lib/agent/memory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
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

  try {
    const conversations = await listConversations(account.id as string);
    return ok({ conversations }, { requestId });
  } catch (e) {
    log.error('[agent/conversations] failed to list', { requestId, e });
    return err('failed to list conversations', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
      details: e instanceof Error ? e.message : String(e),
    });
  }
}
