// ─── GET /api/agent/conversations ──────────────────────────────────────────
// Lists the current user's PROPERTY chat sessions, newest first. Portfolio
// titles/history require their own fresh scope receipt and are deliberately
// excluded from this ordinary hotel-chat endpoint.

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { listConversations } from '@/lib/agent/memory';
import { listAuthoritativePropertyAccess } from '@/lib/authorization/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;

  const { data: account, error: accountError } = await supabaseAdmin
    .from('accounts')
    .select('id, active')
    .eq('data_user_id', auth.userId)
    .maybeSingle();
  if (accountError || !account || account.active !== true) {
    return err('account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  try {
    const authority = await listAuthoritativePropertyAccess(account.id as string);
    if (!authority) {
      return err('authorization is temporarily unavailable', {
        requestId,
        status: 503,
        code: ApiErrorCode.UpstreamFailure,
        headers: { 'Retry-After': '5' },
      });
    }
    const conversations = await listConversations(
      account.id as string,
      30,
      'property',
      authority.all ? null : authority.propertyIds,
    );
    return ok({ conversations }, { requestId });
  } catch (e) {
    log.error('[agent/conversations] failed to list', { requestId, e });
    return err('failed to list conversations', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
      details: e instanceof Error ? e.message : String(e),
    });
  }
}
