// ─── POST /api/agent/nudges/[id]/ack ───────────────────────────────────────
// Acknowledge a nudge. Marks it as acknowledged in the DB.

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
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
  // Ownership check before the update.
  const { data: nudge } = await supabaseAdmin
    .from('agent_nudges')
    .select('user_id')
    .eq('id', id)
    .maybeSingle();
  if (!nudge || nudge.user_id !== account.id) {
    return err('nudge not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  const { error: updErr } = await supabaseAdmin
    .from('agent_nudges')
    .update({ status: 'acknowledged', acknowledged_at: new Date().toISOString() })
    .eq('id', id);
  if (updErr) {
    return err('failed to acknowledge', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }

  return ok({ acknowledged: true }, { requestId });
}
