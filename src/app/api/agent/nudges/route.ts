// ─── GET /api/agent/nudges ─────────────────────────────────────────────────
// List pending nudges for the current user. Chat surfaces poll this on a
// timer (or use Supabase Realtime — out of scope for v1).

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

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

  const { data, error: qErr } = await supabaseAdmin
    .from('agent_nudges')
    .select('id, category, severity, payload, status, created_at')
    .eq('user_id', account.id as string)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(20);
  if (qErr) {
    return err('failed to list nudges', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  return ok({ nudges: data ?? [] }, { requestId });
}
