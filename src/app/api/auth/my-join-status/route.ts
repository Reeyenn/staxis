// GET /api/auth/my-join-status — the signed-in caller's own join-request
// state, for the "waiting for approval" screen shown when an account has
// no property access yet. Session-scoped: only ever returns the caller's
// own rows (join_requests is service-role only, migration 0315).

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { requireSession } from '@/lib/api-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return err('Unauthorized', { requestId, status: 401, code: ApiErrorCode.Unauthorized });

  const { data: account, error: accErr } = await supabaseAdmin
    .from('accounts')
    .select('id')
    .eq('data_user_id', session.userId)
    .maybeSingle();
  if (accErr || !account) return ok({ request: null }, { requestId });

  const { data, error: qErr } = await supabaseAdmin
    .from('join_requests')
    .select('status, created_at, decided_at, property_id, properties(name)')
    .eq('account_id', account.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (qErr) {
    log.error('[my-join-status] query failed', { requestId, msg: errToString(qErr) });
    return err('Failed to load status', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  if (!data) return ok({ request: null }, { requestId });

  const propName = (data as { properties?: { name?: string } | { name?: string }[] }).properties;
  const hotelName = Array.isArray(propName) ? propName[0]?.name ?? null : propName?.name ?? null;
  return ok({
    request: {
      status: data.status,
      createdAt: data.created_at,
      decidedAt: data.decided_at,
      hotelName,
    },
  }, { requestId });
}
