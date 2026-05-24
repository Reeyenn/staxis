/**
 * POST /api/admin/heartbeat
 *
 * Plan v8 Phase B P1-2. Front-end Live Mapping tab pings every 30s while
 * open. Updates accounts.last_seen_at so cua-service/src/human-assist.ts
 * isAnyAdminOnline() correctly reports admin availability (gates whether
 * the mapper asks for help vs falls through to mark-unavailable).
 *
 * Cheap — single UPDATE WHERE id = admin.uid. Auth: requireAdmin.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const admin = await requireAdmin(req);
  if (!admin.ok) {
    return err('Unauthorized', { requestId, status: 401, code: 'unauthorized' });
  }
  const { error } = await supabaseAdmin
    .from('accounts')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', admin.accountId);
  if (error) {
    return err(`heartbeat update failed: ${error.message}`, {
      requestId, status: 500, code: 'db_error',
    });
  }
  return ok({ pinged: true, at: new Date().toISOString() }, { requestId });
}
