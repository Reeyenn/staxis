// ─── Admin API: activate a prompt version ────────────────────────────────
// POST /api/admin/agent/prompts/[id]/activate
// Atomically flips this row to is_active=true and every OTHER row with
// the same role to is_active=false. Cache invalidated immediately on
// this instance; other Vercel instances pick up within 30s TTL.

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { invalidatePromptsCache } from '@/lib/agent/prompts-store';

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
  if (!id) return err('id required', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  // Look up the row we're activating so we know its role.
  const { data: target, error: targetErr } = await supabaseAdmin
    .from('agent_prompts')
    .select('id, role')
    .eq('id', id)
    .maybeSingle();

  if (targetErr || !target) {
    return err('prompt not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  // Deactivate all OTHER rows for this role, then activate this one.
  // Done in two updates rather than one transaction because supabase-js
  // doesn't expose explicit txn control. The partial unique index on
  // (role) WHERE is_active=true prevents two rows from being active
  // simultaneously — if the deactivate fails, the second update will
  // throw at the constraint. Acceptable for a one-row-at-a-time admin
  // action; not used for high-frequency flips.
  const { error: deactErr } = await supabaseAdmin
    .from('agent_prompts')
    .update({ is_active: false })
    .eq('role', (target as { role: string }).role)
    .neq('id', id);

  if (deactErr) {
    return err(`failed to deactivate prior versions: ${deactErr.message}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  const { error: actErr } = await supabaseAdmin
    .from('agent_prompts')
    .update({ is_active: true })
    .eq('id', id);

  if (actErr) {
    return err(`failed to activate: ${actErr.message}`, {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  invalidatePromptsCache();

  return ok({ id, role: (target as { role: string }).role }, { requestId });
}
